const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    maxHttpBufferSize: 1e8 // 100MBまで許容（画像・動画投稿用）
});

app.use(express.static(__dirname));

// --- MongoDB 接続設定 ---
const MONGODB_URI = process.env.MONGODB_URI;

if (MONGODB_URI) {
    mongoose.connect(MONGODB_URI)
        .then(() => console.log('✅ MongoDBへ接続成功！'))
        .catch(err => console.error('❌ MongoDB接続エラー:', err));
} else {
    console.log('⚠️ MONGODB_URIが設定されていません。');
}

// --- MongoDB スキーマ（データ構造）定義 ---

// 1. ユーザー情報
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    isAdmin: { type: Boolean, default: false },
    customPermissions: {
        canManageGenres: { type: Boolean, default: false } // ジャンル順序変更・管理カスタム権限
    },
    icon: { type: String, default: '' }, // 画像URL/Base64でのカスタムアイコン
    bio: { type: String, default: '' },
    status: { type: String, default: '' },
    isBanned: { type: Boolean, default: false },
    ipAddress: { type: String, default: '' },
    isIpBanned: { type: Boolean, default: false },
    notificationsEnabled: { type: Boolean, default: true }, // 全体通知ON/OFF
    channelNotifications: { type: Map, of: Boolean, default: {} }, // チャンネル別通知設定
    createdAt: { type: Date, default: Date.now }
});

// 2. ジャンル情報（開発者が順序変更可能）
const genreSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    order: { type: Number, default: 0 }
});

// 3. チャンネル・鍵部屋情報
const channelSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    genre: { type: String, default: '雑談' },
    isKey: { type: Boolean, default: false },
    password: { type: String, default: '' },
    creator: { type: String, required: true },
    allowedUsers: [{ type: String }] // 鍵部屋に入れる許可ユーザー
});

// 4. DMグループ情報
const dmGroupSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    members: [{ type: String }],
    creator: { type: String, required: true }
});

// 5. メッセージ情報（通常部屋・DM・DMグループ・返信・メディア・ピン留め）
const messageSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    room: { type: String, required: true }, // チャンネル名、DMのペアID（例: "dm_userA_userB"）、またはDMグループID
    user: { type: String, required: true },
    userIcon: { type: String, default: '' }, // 送信時のアイコン画像
    text: { type: String, default: '' },
    media: { type: String, default: null },
    mediaType: { type: String, default: null }, // 'image' | 'video'
    time: { type: String, required: true },
    replyTo: { type: Object, default: null }, // 返信先メッセージ情報 { id, user, text }
    isPinned: { type: Boolean, default: false },
    reactions: { type: Object, default: {} },
    createdAt: { type: Date, default: Date.now }
});

// 6. DM未読カウント＆アクティブ管理
const dmStateSchema = new mongoose.Schema({
    pairKey: { type: String, required: true }, // "userA_userB" （アルファベット順アルゴリズムで統一）
    activeUsers: [{ type: String }], // DMが「開始」されているユーザー一覧（プロフィールから開始されたユーザーのみ）
    unreadCounts: { type: Map, of: Number, default: {} } // 各ユーザーごとの未読件数
});

const User = mongoose.model('User', userSchema);
const Genre = mongoose.model('Genre', genreSchema);
const Channel = mongoose.model('Channel', channelSchema);
const DmGroup = mongoose.model('DmGroup', dmGroupSchema);
const Message = mongoose.model('Message', messageSchema);
const DmState = mongoose.model('DmState', dmStateSchema);

// 初期データ設定（「雑談」のみ作成）
async function initDefaults() {
    try {
        const genreCount = await Genre.countDocuments();
        if (genreCount === 0) {
            await Genre.create({ name: '雑談', order: 0 });
        }
        const defaultChannel = await Channel.findOne({ name: '雑談' });
        if (!defaultChannel) {
            await Channel.create({ name: '雑談', genre: '雑談', isKey: false, creator: 'システム' });
        }
    } catch (err) {
        console.error('初期データ生成エラー:', err);
    }
}
initDefaults();

// オンラインソケット・IP・ユーザー管理
const connectedUsers = {}; // socket.id -> username
const bannedIps = new Set();

// DMのペアキー生成（あーちゃん・いーちゃんの順番を固定するため）
function getDmPairKey(u1, u2) {
    return [u1, u2].sort().join('_');
}

io.on('connection', (socket) => {
    const clientIp = socket.handshake.address;

    // IPBANチェック
    if (bannedIps.has(clientIp)) {
        socket.emit('login_result', { success: false, message: 'このIPアドレスはアクセス禁止されています。' });
        return socket.disconnect();
    }

    // --- ログイン処理 ---
    socket.on('login', async ({ username, password }) => {
        try {
            // システム管理者「アルパカ」の初期生成
            if (username === 'アルパカ' && password === 'kupaa0121') {
                let admin = await User.findOne({ username: 'アルパカ' });
                if (!admin) {
                    await User.create({
                        username: 'アルパカ',
                        password: 'kupaa0121',
                        isAdmin: true,
                        bio: '最高管理者',
                        status: '👑 Admin'
                    });
                }
            }

            const user = await User.findOne({ username });
            if (!user) {
                return socket.emit('login_result', { success: false, message: 'ユーザーが存在しません。' });
            }
            if (user.password !== password) {
                return socket.emit('login_result', { success: false, message: 'パスワードが正しくありません。' });
            }
            if (user.isBanned) {
                return socket.emit('login_result', { success: false, message: 'アカウントがBANされています。' });
            }
            if (user.isIpBanned) {
                bannedIps.add(clientIp);
                return socket.emit('login_result', { success: false, message: 'IPアドレスがBANされています。' });
            }

            // IP保存
            user.ipAddress = clientIp;
            await user.save();

            connectedUsers[socket.id] = username;
            socket.emit('login_result', { success: true, user });

            // 初期データ一覧送信
            const genres = await Genre.find().sort({ order: 1 });
            const channels = await Channel.find();
            const dmGroups = await DmGroup.find({ members: username });
            const allUsers = await User.find({}, '-password');
            
            socket.emit('update_genres', genres);
            socket.emit('update_channels', channels);
            socket.emit('update_dm_groups', dmGroups);
            io.emit('update_user_list', allUsers);

            // 該当ユーザーのDM未読情報を送信
            const dmStates = await DmState.find({ activeUsers: username });
            const unreadInfo = {};
            dmStates.forEach(ds => {
                const partner = ds.pairKey.split('_').find(u => u !== username);
                if (partner) {
                    unreadInfo[partner] = ds.unreadCounts.get(username) || 0;
                }
            });
            socket.emit('update_dm_unreads', unreadInfo);

        } catch (err) {
            socket.emit('login_result', { success: false, message: 'ログイン処理エラー' });
        }
    });

    // --- 新規会員登録 ---
    socket.on('register', async ({ username, password }) => {
        try {
            const existing = await User.findOne({ username });
            if (existing) {
                return socket.emit('register_result', { success: false, message: 'そのユーザー名は既に使用されています。' });
            }
            const newUser = await User.create({ username, password, ipAddress: clientIp });
            connectedUsers[socket.id] = username;

            socket.emit('register_result', { success: true, user: newUser });

            const genres = await Genre.find().sort({ order: 1 });
            const channels = await Channel.find();
            const allUsers = await User.find({}, '-password');

            socket.emit('update_genres', genres);
            socket.emit('update_channels', channels);
            io.emit('update_user_list', allUsers);
        } catch (err) {
            socket.emit('register_result', { success: false, message: '新規登録エラー' });
        }
    });

    // --- プロフィールからDMを開始する（事前に勝手に開始されない制御） ---
    socket.on('start_dm', async ({ targetUsername }) => {
        const currentUser = connectedUsers[socket.id];
        if (!currentUser) return;

        const pairKey = getDmPairKey(currentUser, targetUsername);
        let dmState = await DmState.findOne({ pairKey });

        if (!dmState) {
            dmState = new DmState({ pairKey, activeUsers: [currentUser, targetUsername], unreadCounts: {} });
        } else {
            if (!dmState.activeUsers.includes(currentUser)) dmState.activeUsers.push(currentUser);
            if (!dmState.activeUsers.includes(targetUsername)) dmState.activeUsers.push(targetUsername);
        }
        await dmState.save();

        socket.emit('dm_started', { targetUsername, roomId: `dm_${pairKey}` });
    });

    // --- 部屋・DM・DMグループへの参加 ＆ 履歴取得 ---
    socket.on('join_room', async ({ room, password }) => {
        try {
            const currentUser = connectedUsers[socket.id];
            
            // 通常チャンネルの場合の鍵部屋チェック
            const channel = await Channel.findOne({ name: room });
            if (channel && channel.isKey) {
                const user = await User.findOne({ username: currentUser });
                const isCreator = channel.creator === currentUser;
                const isAllowed = channel.allowedUsers.includes(currentUser);
                const isAdmin = user && user.isAdmin;

                if (!isCreator && !isAllowed && !isAdmin) {
                    if (channel.password && channel.password !== password) {
                        return socket.emit('join_error', '鍵部屋のパスワードが間違っているかアクセス権がありません。');
                    }
                }
            }

            // DMルームの場合の未読クリア
            if (room.startsWith('dm_')) {
                const pairKey = room.replace('dm_', '');
                const dmState = await DmState.findOne({ pairKey });
                if (dmState) {
                    dmState.unreadCounts.set(currentUser, 0);
                    await dmState.save();
                    socket.emit('update_dm_unread_single', { targetUsername: pairKey.split('_').find(u => u !== currentUser), count: 0 });
                }
            }

            socket.join(room);
            const history = await Message.find({ room }).sort({ createdAt: 1 }).limit(200);
            socket.emit('load_history', history);
        } catch (err) {
            console.error('部屋参加エラー:', err);
        }
    });

    // --- メッセージ送信（返信・アイコン・画像・動画対応） ---
    socket.on('chat_message', async (data) => {
        try {
            const sender = await User.findOne({ username: data.user });
            const userIcon = sender ? sender.icon : '';

            const newMsg = await Message.create({
                id: data.id || Date.now().toString(),
                room: data.room,
                user: data.user,
                userIcon: userIcon, // 投稿に最新アイコンを紐付け
                text: data.text || '',
                media: data.media || null,
                mediaType: data.mediaType || null,
                replyTo: data.replyTo || null, // 返信機能
                time: data.time || new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }),
                isPinned: false,
                reactions: {}
            });

            io.to(data.room).emit('chat_message', newMsg);

            // DMの場合、受信者の未読件数をインクリメント
            if (data.room.startsWith('dm_')) {
                const pairKey = data.room.replace('dm_', '');
                const targetUsername = pairKey.split('_').find(u => u !== data.user);
                
                let dmState = await DmState.findOne({ pairKey });
                if (dmState) {
                    const currentUnread = dmState.unreadCounts.get(targetUsername) || 0;
                    dmState.unreadCounts.set(targetUsername, currentUnread + 1);
                    await dmState.save();

                    // 受信者のソケットを探して未読件数をリアルタイム更新
                    for (const [sId, uName] of Object.entries(connectedUsers)) {
                        if (uName === targetUsername) {
                            io.to(sId).emit('update_dm_unread_single', {
                                targetUsername: data.user,
                                count: currentUnread + 1
                            });
                        }
                    }
                }
            }

        } catch (err) {
            console.error('メッセージ送信エラー:', err);
        }
    });

    // --- メッセージ編集・削除 ---
    socket.on('edit_message', async ({ room, msgId, newText }) => {
        try {
            const msg = await Message.findOneAndUpdate({ id: msgId }, { text: newText }, { new: true });
            if (msg) io.to(room).emit('message_edited', { msgId, newText });
        } catch (err) { console.error('編集エラー:', err); }
    });

    socket.on('delete_message', async ({ room, msgId }) => {
        try {
            await Message.deleteOne({ id: msgId });
            io.to(room).emit('message_deleted', msgId);
        } catch (err) { console.error('削除エラー:', err); }
    });

    // --- ピン留め機能の完全復元 ---
    socket.on('toggle_pin', async ({ room, msgId }) => {
        try {
            const msg = await Message.findOne({ id: msgId });
            if (msg) {
                msg.isPinned = !msg.isPinned;
                await msg.save();
                io.to(room).emit('pin_toggled', { msgId, isPinned: msg.isPinned });
            }
        } catch (err) { console.error('ピン留めエラー:', err); }
    });

    // --- リアクション機能 ---
    socket.on('add_reaction', async ({ room, msgId, emoji, username }) => {
        try {
            const msg = await Message.findOne({ id: msgId });
            if (msg) {
                let rx = msg.reactions || {};
                if (!rx[emoji]) rx[emoji] = [];
                if (!rx[emoji].includes(username)) {
                    rx[emoji].push(username);
                } else {
                    rx[emoji] = rx[emoji].filter(u => u !== username);
                    if (rx[emoji].length === 0) delete rx[emoji];
                }
                msg.markModified('reactions');
                await msg.save();
                io.to(room).emit('update_reactions', { msgId, reactions: msg.reactions });
            }
        } catch (err) { console.error('リアクションエラー:', err); }
    });

    // --- チャンネル作成（鍵部屋／誰でも入れる部屋分け） ---
    socket.on('create_channel', async (data) => {
        try {
            const existing = await Channel.findOne({ name: data.name });
            if (existing) return socket.emit('channel_error', '既に存在するチャンネル名です。');

            const newChannel = await Channel.create({
                name: data.name,
                genre: data.genre || '雑談',
                isKey: !!data.isKey,
                password: data.password || '',
                creator: data.creator,
                allowedUsers: [data.creator] // 作成者は初期メンバー
            });

            const channels = await Channel.find();
            io.emit('update_channels', channels);
        } catch (err) { socket.emit('channel_error', 'チャンネル作成失敗'); }
    });

    // --- 鍵部屋のメンバー追加・追放（作成者専用） ---
    socket.on('manage_key_room_user', async ({ roomName, targetUser, action }) => {
        try {
            const currentUser = connectedUsers[socket.id];
            const channel = await Channel.findOne({ name: roomName });
            if (!channel || channel.creator !== currentUser) {
                return socket.emit('channel_error', '作成者のみが鍵部屋のメンバーを管理できます。');
            }

            if (action === 'add') {
                if (!channel.allowedUsers.includes(targetUser)) channel.allowedUsers.push(targetUser);
            } else if (action === 'remove') {
                channel.allowedUsers = channel.allowedUsers.filter(u => u !== targetUser);
            }
            await channel.save();

            const channels = await Channel.find();
            io.emit('update_channels', channels);
        } catch (err) { console.error('鍵部屋管理エラー:', err); }
    });

    // --- ジャンルの編集・削除・並び替え（カスタム権限制御） ---
    socket.on('manage_genres', async ({ action, genreName, newName, newOrderList }) => {
        try {
            const currentUser = connectedUsers[socket.id];
            const user = await User.findOne({ username: currentUser });

            // 管理者またはカスタム権限を持つユーザーのみ許可
            if (!user || (!user.isAdmin && !user.customPermissions.canManageGenres)) {
                return socket.emit('genre_error', 'ジャンルを変更する権限がありません。');
            }

            if (action === 'add') {
                await Genre.create({ name: genreName, order: Date.now() });
            } else if (action === 'rename') {
                await Genre.updateOne({ name: genreName }, { name: newName });
                await Channel.updateMany({ genre: genreName }, { genre: newName });
            } else if (action === 'delete') {
                if (genreName === '雑談') return socket.emit('genre_error', '「雑談」ジャンルは削除できません。');
                await Genre.deleteOne({ name: genreName });
                await Channel.updateMany({ genre: genreName }, { genre: '雑談' });
            } else if (action === 'reorder') {
                // newOrderList: [{ name: "ジャンル名", order: 0 }, ...]
                for (const item of newOrderList) {
                    await Genre.updateOne({ name: item.name }, { order: item.order });
                }
            }

            const genres = await Genre.find().sort({ order: 1 });
            io.emit('update_genres', genres);
        } catch (err) { console.error('ジャンル管理エラー:', err); }
    });

    // --- プロフィール＆アイコン画像の更新 ---
    socket.on('update_profile', async ({ username, bio, status, icon, notificationsEnabled, channelNotifications }) => {
        try {
            const updatedUser = await User.findOneAndUpdate(
                { username },
                { bio, status, icon, notificationsEnabled, channelNotifications },
                { new: true }
            );
            const allUsers = await User.find({}, '-password');
            io.emit('update_user_list', allUsers);
            socket.emit('profile_updated', updatedUser);
        } catch (err) { console.error('プロフィール更新エラー:', err); }
    });

    // --- 管理者専用機能（全復元＆カスタム権限付与） ---

    // 1. IPBAN
    socket.on('admin_toggle_ip_ban', async (targetUsername) => {
        try {
            const currentUser = connectedUsers[socket.id];
            const admin = await User.findOne({ username: currentUser });
            if (!admin || !admin.isAdmin) return;

            const target = await User.findOne({ username: targetUsername });
            if (target) {
                target.isIpBanned = !target.isIpBanned;
                await target.save();
                if (target.ipAddress) {
                    if (target.isIpBanned) bannedIps.add(target.ipAddress);
                    else bannedIps.delete(target.ipAddress);
                }
                const allUsers = await User.find({}, '-password');
                io.emit('update_user_list', allUsers);
            }
        } catch (err) { console.error('IPBANエラー:', err); }
    });

    // 2. カスタム権限付与（ジャンル管理権限など）
    socket.on('admin_grant_permission', async ({ targetUsername, permissionKey, value }) => {
        try {
            const currentUser = connectedUsers[socket.id];
            const admin = await User.findOne({ username: currentUser });
            if (!admin || !admin.isAdmin) return;

            const update = {};
            update[`customPermissions.${permissionKey}`] = value;
            await User.findOneAndUpdate({ username: targetUsername }, update);

            const allUsers = await User.find({}, '-password');
            io.emit('update_user_list', allUsers);
        } catch (err) { console.error('権限付与エラー:', err); }
    });

    // 3. 全ユーザーのパスワード閲覧（管理者専用）
    socket.on('admin_get_passwords', async () => {
        try {
            const currentUser = connectedUsers[socket.id];
            const admin = await User.findOne({ username: currentUser });
            if (!admin || !admin.isAdmin) return;

            const usersWithPasswords = await User.find({}, 'username password');
            socket.emit('admin_passwords_list', usersWithPasswords);
        } catch (err) { console.error('パスワード取得エラー:', err); }
    });

    // 4. 全DM履歴の閲覧（管理者専用）
    socket.on('admin_get_all_dms', async () => {
        try {
            const currentUser = connectedUsers[socket.id];
            const admin = await User.findOne({ username: currentUser });
            if (!admin || !admin.isAdmin) return;

            const dmMessages = await Message.find({ room: /^dm_/ }).sort({ createdAt: -1 });
            socket.emit('admin_all_dms_list', dmMessages);
        } catch (err) { console.error('DM閲覧エラー:', err); }
    });

    socket.on('disconnect', () => {
        delete connectedUsers[socket.id];
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 サーバーがポート ${PORT} で起動しました`);
});
