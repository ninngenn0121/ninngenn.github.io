const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    maxHttpBufferSize: 1e8 // 100MBまで許容（動画・画像送信対策）
});

app.use(express.static(__dirname));

// --- MongoDB 接続設定 ---
const MONGODB_URI = process.env.MONGODB_URI;

if (MONGODB_URI) {
    mongoose.connect(MONGODB_URI)
        .then(() => console.log('✅ MongoDBへ接続成功！'))
        .catch(err => console.error('❌ MongoDB接続エラー:', err));
} else {
    console.log('⚠️ MONGODB_URIが設定されていません。環境変数を確認してください。');
}

// --- MongoDB スキーマ (データ構造) の定義 ---

// 1. ユーザー情報
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    isAdmin: { type: Boolean, default: false },
    icon: { type: String, default: '' },
    bio: { type: String, default: '' },
    status: { type: String, default: '' },
    isBanned: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
});

// 2. チャンネル・鍵部屋情報
const channelSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    genre: { type: String, default: '一般' },
    isKey: { type: Boolean, default: false },
    password: { type: String, default: '' },
    creator: { type: String, default: '' }
});

// 3. メッセージ情報
const messageSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    room: { type: String, required: true },
    user: { type: String, required: true },
    text: { type: String, default: '' },
    media: { type: String, default: null },
    mediaType: { type: String, default: null },
    time: { type: String, required: true },
    isPinned: { type: Boolean, default: false },
    reactions: { type: Object, default: {} },
    createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Channel = mongoose.model('Channel', channelSchema);
const Message = mongoose.model('Message', messageSchema);

// 初期データ（デフォルトチャンネル）の自動作成関数
async function initDefaults() {
    try {
        const defaultChannels = [
            { name: '雑談', genre: '一般' },
            { name: '質問・相談', genre: 'サポート' },
            { name: '画像・動画共有', genre: 'メディア' }
        ];
        for (const ch of defaultChannels) {
            await Channel.updateOne({ name: ch.name }, ch, { upsert: true });
        }
    } catch (err) {
        console.error('初期データ作成エラー:', err);
    }
}
initDefaults();

// 接続中ユーザーの保持 (ソケットIDの紐付け用)
const connectedUsers = {};

// --- Socket.io イベントハンドラ ---
io.on('connection', (socket) => {

    // 1. ログイン処理
    socket.on('login', async ({ username, password }) => {
        try {
            // アルパカ（管理者）アカウントの自動生成またはログイン対応
            if (username === 'アルパカ' && password === 'kupaa0121') {
                let adminUser = await User.findOne({ username: 'アルパカ' });
                if (!adminUser) {
                    adminUser = await User.create({
                        username: 'アルパカ',
                        password: 'kupaa0121',
                        isAdmin: true,
                        bio: 'システム管理者です。',
                        status: '👑 管理者'
                    });
                }
            }

            const user = await User.findOne({ username });
            if (!user) {
                return socket.emit('login_result', { success: false, message: 'ユーザーが存在しません。新規登録してください。' });
            }
            if (user.password !== password) {
                return socket.emit('login_result', { success: false, message: 'パスワードが違います。' });
            }
            if (user.isBanned) {
                return socket.emit('login_result', { success: false, message: 'このアカウントはアクセス禁止（BAN）されています。' });
            }

            connectedUsers[socket.id] = username;
            socket.emit('login_result', { success: true, user });

            // チャンネル一覧と全ユーザー情報を送信
            const channels = await Channel.find();
            socket.emit('update_channels', channels);

            const allUsers = await User.find({}, '-password'); // パスワードを除外して取得
            io.emit('update_user_list', allUsers);

        } catch (err) {
            socket.emit('login_result', { success: false, message: 'ログイン処理でエラーが発生しました。' });
        }
    });

    // 2. 新規会員登録
    socket.on('register', async ({ username, password }) => {
        try {
            const existingUser = await User.findOne({ username });
            if (existingUser) {
                return socket.emit('register_result', { success: false, message: 'その名前は既に使用されています。' });
            }
            const newUser = await User.create({ username, password });
            connectedUsers[socket.id] = username;

            socket.emit('register_result', { success: true, user: newUser });

            const channels = await Channel.find();
            socket.emit('update_channels', channels);

            const allUsers = await User.find({}, '-password');
            io.emit('update_user_list', allUsers);
        } catch (err) {
            socket.emit('register_result', { success: false, message: '登録処理でエラーが発生しました。' });
        }
    });

    // 3. 部屋への参加と履歴ロード
    socket.on('join_room', async ({ room, password }) => {
        try {
            const channel = await Channel.findOne({ name: room });
            if (channel && channel.isKey && channel.password !== password) {
                const currentUser = connectedUsers[socket.id];
                const user = await User.findOne({ username: currentUser });
                if (!user || !user.isAdmin) {
                    return socket.emit('join_error', 'パスワードが正しくありません。');
                }
            }

            socket.join(room);
            // 該当部屋の直近メッセージ履歴を取得（最大200件）
            const history = await Message.find({ room }).sort({ createdAt: 1 }).limit(200);
            socket.emit('load_history', history);
        } catch (err) {
            console.error('部屋参加エラー:', err);
        }
    });

    // 4. メッセージ送信
    socket.on('chat_message', async (data) => {
        try {
            const newMsg = await Message.create({
                id: data.id || Date.now().toString(),
                room: data.room,
                user: data.user,
                text: data.text || '',
                media: data.media || null,
                mediaType: data.mediaType || null,
                time: data.time || new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }),
                isPinned: false,
                reactions: {}
            });

            io.to(data.room).emit('chat_message', newMsg);
        } catch (err) {
            console.error('メッセージ送信エラー:', err);
        }
    });

    // 5. メッセージ削除
    socket.on('delete_message', async ({ room, msgId }) => {
        try {
            await Message.deleteOne({ id: msgId });
            io.to(room).emit('message_deleted', msgId);
        } catch (err) {
            console.error('メッセージ削除エラー:', err);
        }
    });

    // 6. メッセージ編集
    socket.on('edit_message', async ({ room, msgId, newText }) => {
        try {
            const msg = await Message.findOneAndUpdate(
                { id: msgId },
                { text: newText },
                { new: true }
            );
            if (msg) {
                io.to(room).emit('message_edited', { msgId, newText });
            }
        } catch (err) {
            console.error('メッセージ編集エラー:', err);
        }
    });

    // 7. リアクション追加・更新
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
        } catch (err) {
            console.error('リアクションエラー:', err);
        }
    });

    // 8. メッセージピン留めトグル
    socket.on('toggle_pin', async ({ room, msgId }) => {
        try {
            const msg = await Message.findOne({ id: msgId });
            if (msg) {
                msg.isPinned = !msg.isPinned;
                await msg.save();
                io.to(room).emit('pin_toggled', { msgId, isPinned: msg.isPinned });
            }
        } catch (err) {
            console.error('ピン留めエラー:', err);
        }
    });

    // 9. 新規チャンネル作成
    socket.on('create_channel', async (data) => {
        try {
            const existing = await Channel.findOne({ name: data.name });
            if (existing) {
                return socket.emit('channel_error', '同名の部屋がすでに存在します。');
            }
            await Channel.create(data);
            const channels = await Channel.find();
            io.emit('update_channels', channels);
        } catch (err) {
            socket.emit('channel_error', '部屋の作成に失敗しました。');
        }
    });

    // 10. プロフィール更新
    socket.on('update_profile', async ({ username, bio, status, icon }) => {
        try {
            const updatedUser = await User.findOneAndUpdate(
                { username },
                { bio, status, icon },
                { new: true }
            );
            const allUsers = await User.find({}, '-password');
            io.emit('update_user_list', allUsers);
            socket.emit('profile_updated', updatedUser);
        } catch (err) {
            console.error('プロフィール更新エラー:', err);
        }
    });

    // --- 管理者専用機能 ---

    // BAN（強制アクセス拒否）切り替え
    socket.on('admin_toggle_ban', async (targetUsername) => {
        try {
            const currentUsername = connectedUsers[socket.id];
            const admin = await User.findOne({ username: currentUsername });
            if (!admin || !admin.isAdmin) return;

            const target = await User.findOne({ username: targetUsername });
            if (target) {
                target.isBanned = !target.isBanned;
                await target.save();
                const allUsers = await User.find({}, '-password');
                io.emit('update_user_list', allUsers);
            }
        } catch (err) {
            console.error('BANエラー:', err);
        }
    });

    // パスワード強制変更（管理者機能）
    socket.on('admin_reset_password', async ({ targetUsername, newPassword }) => {
        try {
            const currentUsername = connectedUsers[socket.id];
            const admin = await User.findOne({ username: currentUsername });
            if (!admin || !admin.isAdmin) return;

            await User.findOneAndUpdate({ username: targetUsername }, { password: newPassword });
            socket.emit('admin_notice', `${targetUsername} のパスワードを更新しました。`);
        } catch (err) {
            console.error('パスワード変更エラー:', err);
        }
    });

    // 切断処理
    socket.on('disconnect', () => {
        delete connectedUsers[socket.id];
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 サーバーがポート ${PORT} で起動しました`);
});
