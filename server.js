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
  console.log('⚠️ MONGODB_URIが設定されていません。メモリストレージモード（再起動で初期化）で動作します。');
}

// --- Mongoose スキーマ定義 ---
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  isDev: { type: Boolean, default: false },
  roleId: { type: String, default: '' },
  bio: { type: String, default: '' },
  avatar: { type: String, default: '' },
  isBanned: { type: Boolean, default: false },
  isIpBanned: { type: Boolean, default: false },
  ip: { type: String, default: '' },
  notify: { type: Boolean, default: true },
  channelNotify: { type: Map, of: Boolean, default: {} }
});

const categorySchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  order: { type: Number, default: 0 }
});

const channelSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  category: { type: String, default: '雑談' },
  isPrivate: { type: Boolean, default: false },
  owner: { type: String, default: '' },
  members: [{ type: String }],
  isDMGroup: { type: Boolean, default: false }
});

const roleSchema = new mongoose.Schema({
  roleId: { type: String, required: true, unique: true },
  roleName: { type: String, required: true },
  permissions: { type: Object, default: {} }
});

const systemStateSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  pinnedChannels: [{ type: String }],
  activeDMs: [{ type: String }]
});

const messageSchema = new mongoose.Schema({
  id: { type: String, required: true },
  targetRoom: { type: String, required: true },
  user: { type: String, required: true },
  userAvatar: { type: String, default: '' },
  text: { type: String, default: '' },
  fileData: { type: String, default: null },
  fileType: { type: String, default: null },
  replyTo: { type: Object, default: null },
  time: { type: String, required: true },
  isEdited: { type: Boolean, default: false },
  isPinned: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Category = mongoose.model('Category', categorySchema);
const Channel = mongoose.model('Channel', channelSchema);
const Role = mongoose.model('Role', roleSchema);
const SystemState = mongoose.model('SystemState', systemStateSchema);
const Message = mongoose.model('Message', messageSchema);

// 初期データの準備
async function initDefaults() {
  try {
    if (MONGODB_URI) {
      const catCount = await Category.countDocuments();
      if (catCount === 0) {
        await Category.create({ name: '雑談', order: 0 });
      }
      const chCount = await Channel.countDocuments();
      if (chCount === 0) {
        await Channel.create({ name: 'general', category: '雑談', isPrivate: false, owner: 'システム' });
      }
      let sysState = await SystemState.findOne({ key: 'main' });
      if (!sysState) {
        await SystemState.create({ key: 'main', pinnedChannels: [], activeDMs: [] });
      }
    }
  } catch (err) {
    console.error('初期データ構築エラー:', err);
  }
}
initDefaults();

// オンライン状態管理
const onlineUsers = {}; // socket.id -> username
const socketUserMap = {}; // username -> socket.id
const bannedIps = new Set();

// 権限取得ヘルパー
async function getUserPermissions(username) {
  const user = await User.findOne({ username });
  if (!user) return {};
  if (user.isDev) return { all: true };
  if (!user.roleId) return {};

  const role = await Role.findOne({ roleId: user.roleId });
  return role ? role.permissions : {};
}

// チャンネル構造データの生成・送信
async function sendChannelStructure(targetSocket = null) {
  try {
    const categoriesDocs = await Category.find().sort({ order: 1 });
    const categories = categoriesDocs.map(c => c.name);
    const channels = await Channel.find();
    
    let sysState = await SystemState.findOne({ key: 'main' });
    const pinned = sysState ? sysState.pinnedChannels : [];
    const activeDMs = sysState ? sysState.activeDMs : [];

    const payload = {
      categories,
      channels: channels.map(c => ({
        name: c.name,
        category: c.category,
        isPrivate: c.isPrivate,
        owner: c.owner
      })),
      pinned,
      activeDMs
    };

    if (targetSocket) {
      targetSocket.emit('update channel structure', payload);
    } else {
      io.emit('update channel structure', payload);
    }
  } catch (err) {
    console.error('チャンネル構造送信エラー:', err);
  }
}

// オンラインユーザーリスト送信
async function broadcastUserList() {
  try {
    const allUsers = await User.find({}, 'username roleId');
    const rolesDocs = await Role.find();
    const rolesMap = {};
    rolesDocs.forEach(r => rolesMap[r.roleId] = r.roleName);

    const activeUsernames = new Set(Object.values(onlineUsers));
    const userStatusMap = {};

    allUsers.forEach(u => {
      userStatusMap[u.username] = {
        isOnline: activeUsernames.has(u.username),
        roleName: rolesMap[u.roleId] || '一般ユーザー'
      };
    });

    io.emit('update user list', userStatusMap);
  } catch (err) {
    console.error('ユーザーリスト配信エラー:', err);
  }
}

// 全チャット履歴取得（管理者モニタリング用）
async function getAllChatHistory() {
  const messages = await Message.find().sort({ createdAt: 1 });
  const historyMap = {};
  messages.forEach(m => {
    if (!historyMap[m.targetRoom]) historyMap[m.targetRoom] = [];
    historyMap[m.targetRoom].push(m);
  });
  return historyMap;
}

io.on('connection', (socket) => {
  const clientIp = socket.handshake.address;

  if (bannedIps.has(clientIp)) {
    socket.emit('auth error', 'このIPアドレスはアクセス禁止されています。');
    return socket.disconnect();
  }

  // --- アカウント登録 ---
  socket.on('register account', async ({ username, password }) => {
    try {
      const existing = await User.findOne({ username });
      if (existing) return socket.emit('auth error', 'そのユーザー名は既に使用されています。');

      const isDev = (username === 'アルパカ' && password === 'kupaa0121');
      const newUser = await User.create({
        username,
        password,
        isDev,
        ip: clientIp
      });

      const perms = await getUserPermissions(username);
      socket.emit('auth success', {
        username: newUser.username,
        isDev: newUser.isDev,
        permissions: perms,
        notify: newUser.notify,
        channelNotify: Object.fromEntries(newUser.channelNotify || new Map())
      });
    } catch (err) {
      socket.emit('auth error', '登録処理に失敗しました。');
    }
  });

  // --- ログイン ---
  socket.on('login account', async ({ username, password }) => {
    try {
      if (username === 'アルパカ' && password === 'kupaa0121') {
        let admin = await User.findOne({ username: 'アルパカ' });
        if (!admin) {
          admin = await User.create({ username: 'アルパカ', password: 'kupaa0121', isDev: true, bio: '最高開発者' });
        }
      }

      const user = await User.findOne({ username });
      if (!user) return socket.emit('auth error', 'ユーザーが存在しません。');
      if (user.password !== password) return socket.emit('auth error', 'パスワードが間違っています。');
      if (user.isBanned) return socket.emit('auth error', 'アカウントがBANされています。');
      if (user.isIpBanned) {
        bannedIps.add(clientIp);
        return socket.emit('auth error', 'IPアドレスがBANされています。');
      }

      user.ip = clientIp;
      await user.save();

      const perms = await getUserPermissions(username);
      socket.emit('auth success', {
        username: user.username,
        isDev: user.isDev,
        permissions: perms,
        notify: user.notify,
        channelNotify: Object.fromEntries(user.channelNotify || new Map())
      });
    } catch (err) {
      socket.emit('auth error', 'ログイン処理に失敗しました。');
    }
  });

  // --- ユーザーセッション登録 ---
  socket.on('register user', async (username) => {
    onlineUsers[socket.id] = username;
    socketUserMap[username] = socket.id;

    await sendChannelStructure(socket);
    await broadcastUserList();

    socket.join('general');
    const msgs = await Message.find({ targetRoom: 'general' }).sort({ createdAt: 1 });
    socket.emit('load room history', { room: 'general', messages: msgs });
  });

  // --- ルーム切り替え・履歴読み込み ---
  socket.on('join room', async (roomName) => {
    const username = onlineUsers[socket.id];
    if (!username) return;

    const targetCh = await Channel.findOne({ name: roomName });
    if (targetCh && targetCh.isPrivate) {
      const user = await User.findOne({ username });
      const isOwner = targetCh.owner === username;
      const isMember = targetCh.members.includes(username);
      if (!isOwner && !isMember && (!user || !user.isDev)) {
        return socket.emit('chat error', 'この部屋のアクセス権限がありません。');
      }
    }

    socket.rooms.forEach(r => { if (r !== socket.id) socket.leave(r); });
    socket.join(roomName);

    const msgs = await Message.find({ targetRoom: roomName }).sort({ createdAt: 1 });
    socket.emit('load room history', { room: roomName, messages: msgs });
  });

  // --- メッセージ送信 ---
  socket.on('chat message', async (data) => {
    const senderName = onlineUsers[socket.id] || 'アルパカ';
    const sender = await User.findOne({ username: senderName });

    const msgObj = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      targetRoom: data.targetRoom,
      user: senderName,
      userAvatar: sender ? sender.avatar : '',
      text: data.text || '',
      fileData: data.fileData || null,
      fileType: data.fileType || null,
      replyTo: data.replyTo || null,
      time: new Date().toLocaleTimeString('ja-JP', { 
        timeZone: 'Asia/Tokyo', 
        hour: '2-digit', 
        minute: '2-digit', 
        hour12: false 
      }),
      isEdited: false,
      isPinned: false
    };

    const savedMsg = await Message.create(msgObj);
    io.to(data.targetRoom).emit('chat message', savedMsg);
    io.emit('spy update message');
  });

  // --- メッセージ編集 ---
  socket.on('edit message', async (data) => {
    await Message.updateOne({ id: data.id }, { text: data.newText, isEdited: true });
    io.to(data.targetRoom).emit('edit message', { id: data.id, newText: data.newText, targetRoom: data.targetRoom });
    io.emit('spy update message');
  });

  // --- メッセージ削除 ---
  socket.on('delete message', async (data) => {
    await Message.deleteOne({ id: data.id });
    io.to(data.targetRoom).emit('delete message', { id: data.id, targetRoom: data.targetRoom });
    io.emit('spy update message');
  });

  // --- メッセージのピン留め切り替え ---
  socket.on('toggle pin message', async (data) => {
    const msg = await Message.findOne({ id: data.id });
    if (msg) {
      msg.isPinned = !msg.isPinned;
      await msg.save();
      io.to(data.targetRoom).emit('update pin message', { id: data.id, isPinned: msg.isPinned, targetRoom: data.targetRoom });
    }
  });

  // --- チャンネル全消去 ---
  socket.on('clear channel', async (roomName) => {
    await Message.deleteMany({ targetRoom: roomName });
    io.to(roomName).emit('clear channel', roomName);
    io.emit('spy update message');
  });

  // --- カテゴリ（ジャンル）作成 ---
  socket.on('create category', async (catName) => {
    const existing = await Category.findOne({ name: catName });
    if (!existing) {
      const maxOrder = await Category.find().sort({ order: -1 }).limit(1);
      const nextOrder = maxOrder.length > 0 ? maxOrder[0].order + 1 : 0;
      await Category.create({ name: catName, order: nextOrder });
      await sendChannelStructure();
    }
  });

  // --- カテゴリ並び替え ---
  socket.on('move category', async ({ catName, direction }) => {
    const cats = await Category.find().sort({ order: 1 });
    const idx = cats.findIndex(c => c.name === catName);
    if (idx === -1) return;

    if (direction === 'up' && idx > 0) {
      const temp = cats[idx].order;
      cats[idx].order = cats[idx - 1].order;
      cats[idx - 1].order = temp;
      await cats[idx].save();
      await cats[idx - 1].save();
    } else if (direction === 'down' && idx < cats.length - 1) {
      const temp = cats[idx].order;
      cats[idx].order = cats[idx + 1].order;
      cats[idx + 1].order = temp;
      await cats[idx].save();
      await cats[idx + 1].save();
    }
    await sendChannelStructure();
  });

  // --- カテゴリ名変更 / 削除 ---
  socket.on('rename category', async ({ oldName, newName }) => {
    await Category.updateOne({ name: oldName }, { name: newName });
    await Channel.updateMany({ category: oldName }, { category: newName });
    await sendChannelStructure();
  });

  socket.on('delete category', async (catName) => {
    if (catName === '雑談') return socket.emit('channel error', '「雑談」ジャンルは削除できません。');
    await Category.deleteOne({ name: catName });
    await Channel.updateMany({ category: catName }, { category: '雑談' });
    await sendChannelStructure();
  });

  // --- チャンネル作成（鍵部屋／DMグループ対応） ---
  socket.on('create channel', async (data) => {
    const currentUser = onlineUsers[socket.id];
    const existing = await Channel.findOne({ name: data.name });
    if (existing) return socket.emit('channel error', 'そのチャンネル名は既に存在します。');

    await Channel.create({
      name: data.name,
      category: data.category || '雑談',
      isPrivate: !!data.isPrivate,
      owner: currentUser,
      members: [currentUser],
      isDMGroup: !!data.isDMGroup
    });

    await sendChannelStructure();
  });

  socket.on('delete channel', async (channelName) => {
    if (channelName === 'general') return socket.emit('channel error', 'generalチャンネル限は削除できません。');
    await Channel.deleteOne({ name: channelName });
    await sendChannelStructure();
  });

  socket.on('toggle pin channel', async (channelName) => {
    let sysState = await SystemState.findOne({ key: 'main' });
    if (!sysState) sysState = await SystemState.create({ key: 'main', pinnedChannels: [], activeDMs: [] });

    if (sysState.pinnedChannels.includes(channelName)) {
      sysState.pinnedChannels = sysState.pinnedChannels.filter(c => c !== channelName);
    } else {
      sysState.pinnedChannels.push(channelName);
    }
    await sysState.save();
    await sendChannelStructure();
  });

  // --- 鍵部屋のメンバー管理 ---
  socket.on('get room members', async (channelName) => {
    const ch = await Channel.findOne({ name: channelName });
    if (ch) {
      socket.emit('room members data', { owner: ch.owner, members: ch.members });
    }
  });

  socket.on('manage room members', async ({ channelName, action, targetUser }) => {
    const ch = await Channel.findOne({ name: channelName });
    if (!ch) return;

    if (action === 'add') {
      const u = await User.findOne({ username: targetUser });
      if (!u) return socket.emit('chat error', '指定したユーザーが存在しません。');
      if (!ch.members.includes(targetUser)) ch.members.push(targetUser);
    } else if (action === 'remove') {
      ch.members = ch.members.filter(m => m !== targetUser);
    }
    await ch.save();
    io.emit('room members data', { owner: ch.owner, members: ch.members });
  });

  // --- プロフィール経由のDM開始 ---
  socket.on('start dm from profile', async (targetUser) => {
    const currentUser = onlineUsers[socket.id];
    if (!currentUser) return;

    const dmRoomName = [currentUser, targetUser].sort().join('-DM-');
    let sysState = await SystemState.findOne({ key: 'main' });
    if (!sysState) sysState = await SystemState.create({ key: 'main', pinnedChannels: [], activeDMs: [] });

    if (!sysState.activeDMs.includes(dmRoomName)) {
      sysState.activeDMs.push(dmRoomName);
      await sysState.save();
      await sendChannelStructure();
    }

    socket.emit('open dm room', dmRoomName);
  });

  // --- 通知設定トグル ---
  socket.on('toggle notify', async (enabled) => {
    const username = onlineUsers[socket.id];
    if (username) await User.updateOne({ username }, { notify: enabled });
  });

  socket.on('toggle channel notify', async (channelName) => {
    const username = onlineUsers[socket.id];
    if (!username) return;

    const user = await User.findOne({ username });
    if (user) {
      const current = user.channelNotify.get(channelName);
      const nextState = current === false ? true : false;
      user.channelNotify.set(channelName, nextState);
      await user.save();
      socket.emit('channel notify status changed', { channel: channelName, enabled: nextState });
    }
  });

  // --- プロフィール取得・更新 ---
  socket.on('get profile', async (username) => {
    const user = await User.findOne({ username });
    if (user) {
      socket.emit('profile data', { username: user.username, profile: { bio: user.bio, avatar: user.avatar } });
    }
  });

  socket.on('update profile', async (data) => {
    const username = onlineUsers[socket.id];
    if (username) {
      await User.updateOne({ username }, { bio: data.bio, avatar: data.avatar });
      socket.emit('profile data', { username, profile: { bio: data.bio, avatar: data.avatar } });
    }
  });

  // --- 管理者パネル操作 ---
  socket.on('admin create role', async (roleData) => {
    await Role.create(roleData);
  });

  socket.on('get admin user list', async () => {
    const currentUser = onlineUsers[socket.id];
    const devUser = await User.findOne({ username: currentUser });
    if (!devUser || !devUser.isDev) return;

    const usersDocs = await User.find();
    const usersMap = {};
    usersDocs.forEach(u => {
      usersMap[u.username] = {
        password: u.password,
        ip: u.ip,
        role: u.roleId
      };
    });

    const rolesDocs = await Role.find();
    const rolesMap = {};
    rolesDocs.forEach(r => rolesMap[r.roleId] = { name: r.roleName });

    const chatHistory = await getAllChatHistory();

    socket.emit('admin user list result', {
      users: usersMap,
      roles: rolesMap,
      chatHistory
    });
  });

  socket.on('admin assign role', async ({ targetUser, roleId }) => {
    await User.updateOne({ username: targetUser }, { roleId });
    socket.emit('admin role assign success');
    await broadcastUserList();
  });

  socket.on('admin ban user', async (targetUser) => {
    await User.updateOne({ username: targetUser }, { isBanned: true });
    const targetSocketId = socketUserMap[targetUser];
    if (targetSocketId) {
      io.to(targetSocketId).emit('banned notification', 'アカウントがBANされました。');
    }
  });

  socket.on('admin ip ban user', async (targetUser) => {
    const user = await User.findOne({ username: targetUser });
    if (user) {
      user.isBanned = true;
      user.isIpBanned = true;
      await user.save();
      if (user.ip) bannedIps.add(user.ip);

      const targetSocketId = socketUserMap[targetUser];
      if (targetSocketId) {
        io.to(targetSocketId).emit('banned notification', 'IPアドレスがBANされました。');
      }
    }
  });

  socket.on('disconnect', async () => {
    const username = onlineUsers[socket.id];
    delete onlineUsers[socket.id];
    if (username) delete socketUserMap[username];
    await broadcastUserList();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 サーバーがポート ${PORT} で起動しました`);
});
