const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  maxHttpBufferSize: 1e8 // 100MB（画像・動画対応）
});

app.use(express.static(__dirname));

// ユーザーDB
const users = {
  'アルパカ': { password: 'kupaa0121', role: 'admin', lastSeen: null, notify: true, channelNotify: {} }
};

// カスタム権限（ロール）
let roles = {
  'admin': {
    name: '開発者/管理者',
    permissions: {
      ban: true,
      ipBan: true,
      deleteMessage: true,
      editMessage: true,
      createChannel: true,
      deleteChannel: true,
      clearChannel: true,
      pinMessage: true,
      pinChannel: true,
      manageCategories: true,
      reorderCategories: true
    }
  }
};

let bannedUsers = [];
let bannedIPs = [];
let userIPs = {};
let profiles = {};

// アクティブなDMリスト
let activeDMs = []; // ['user1-DM-user2', ...]

// ジャンル（初期は「雑談」のみ）＆チャンネル管理
let categories = ['雑談'];
let channels = [
  { name: 'general', category: '雑談' }
];

let pinnedChannels = [];
let chatHistory = {
  'general': []
};

function getClientIp(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  return forwarded ? forwarded.split(',')[0].trim() : socket.handshake.address;
}

function hasPermission(username, permKey) {
  if (username === 'アルパカ') return true;
  const u = users[username];
  if (!u || !u.role) return false;
  const r = roles[u.role];
  return r && r.permissions && !!r.permissions[permKey];
}

function getUserList() {
  const userList = {};
  for (const [uname, udata] of Object.entries(users)) {
    userList[uname] = {
      isOnline: false,
      role: udata.role || null,
      roleName: roles[udata.role] ? roles[udata.role].name : '一般ユーザー',
      lastSeen: udata.lastSeen || null,
      notify: udata.notify !== false,
      channelNotify: udata.channelNotify || {}
    };
  }

  for (const [socketId, socket] of io.sockets.sockets) {
    if (socket.username) {
      if (!userList[socket.username]) userList[socket.username] = {};
      userList[socket.username].isOnline = true;
    }
  }
  return userList;
}

function getSortedChannelsData() {
  return {
    categories: categories,
    channels: channels,
    pinned: pinnedChannels,
    activeDMs: activeDMs
  };
}

function getFormattedTime() {
  return new Date().toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
}

io.on('connection', (socket) => {
  const clientIp = getClientIp(socket);

  const sendAuthSuccess = (username) => {
    socket.username = username;
    const userRole = users[username].role || null;
    const isDev = (username === 'アルパカ');

    socket.emit('auth success', {
      username: username,
      role: userRole,
      isDev: isDev,
      notify: users[username].notify !== false,
      channelNotify: users[username].channelNotify || {},
      permissions: isDev ? roles['admin'].permissions : (roles[userRole] ? roles[userRole].permissions : {})
    });

    io.emit('update user list', getUserList());
  };

  // 認証
  socket.on('register account', (data) => {
    const { username, password } = data;
    if (!username || !password) return socket.emit('auth error', 'ユーザー名とパスワードを入力してください。');
    if (bannedIPs.includes(clientIp)) return socket.emit('auth error', 'このIPは制限されています(IP BAN)。');
    if (users[username]) return socket.emit('auth error', 'そのユーザー名は既に使用されています。');

    users[username] = { password, role: null, lastSeen: null, notify: true, channelNotify: {} };
    userIPs[username] = clientIp;
    sendAuthSuccess(username);
  });

  socket.on('login account', (data) => {
    const { username, password } = data;
    if (bannedIPs.includes(clientIp)) return socket.emit('auth error', 'このIPは制限されています(IP BAN)。');
    if (bannedUsers.includes(username)) return socket.emit('auth error', 'このアカウントはBANされています。');
    if (!users[username] || users[username].password !== password) {
      return socket.emit('auth error', 'ユーザー名またはパスワードが正しくありません。');
    }

    userIPs[username] = clientIp;
    sendAuthSuccess(username);
  });

  socket.on('register user', (username) => {
    socket.username = username;
    socket.join('general');

    socket.emit('update channel structure', getSortedChannelsData());
    socket.emit('load history', chatHistory);
    io.emit('update user list', getUserList());
  });

  // 通知
  socket.on('toggle notify', (enabled) => {
    if (socket.username && users[socket.username]) {
      users[socket.username].notify = enabled;
      socket.emit('notify status changed', enabled);
    }
  });

  socket.on('toggle channel notify', (channelName) => {
    if (socket.username && users[socket.username]) {
      if (!users[socket.username].channelNotify) users[socket.username].channelNotify = {};
      const current = users[socket.username].channelNotify[channelName] !== false;
      users[socket.username].channelNotify[channelName] = !current;
      socket.emit('channel notify status changed', { channel: channelName, enabled: !current });
    }
  });

  // プロフィールからのみDM開始
  socket.on('start dm from profile', (targetUser) => {
    if (!socket.username || socket.username === targetUser) return;
    const dmRoomName = [socket.username, targetUser].sort().join('-DM-');
    if (!activeDMs.includes(dmRoomName)) {
      activeDMs.push(dmRoomName);
    }
    if (!chatHistory[dmRoomName]) {
      chatHistory[dmRoomName] = [];
    }

    // 両者の接続ソケットをDMルームに参加させる
    for (const [id, s] of io.sockets.sockets) {
      if (s.username === socket.username || s.username === targetUser) {
        s.join(dmRoomName);
      }
    }

    io.emit('update channel structure', getSortedChannelsData());
    socket.emit('open dm room', dmRoomName);
  });

  // プロフィール
  socket.on('update profile', (profileData) => {
    if (!socket.username) return;
    profiles[socket.username] = { bio: profileData.bio || '', avatar: profileData.avatar || '' };
    io.emit('profile updated', { username: socket.username, profile: profiles[socket.username] });
  });

  socket.on('get profile', (targetUser) => {
    socket.emit('profile data', {
      username: targetUser,
      profile: profiles[targetUser] || { bio: '', avatar: '' }
    });
  });

  // ルーム移動（DM対応を強化）
  socket.on('join room', (roomName) => {
    socket.rooms.forEach(r => { if (r !== socket.id) socket.leave(r); });
    socket.join(roomName);

    if (!chatHistory[roomName]) {
      chatHistory[roomName] = [];
    }
    // ルームの最新履歴を送る
    socket.emit('load room history', { room: roomName, messages: chatHistory[roomName] });
  });

  // チャットメッセージ送信（DMルーム対応）
  socket.on('chat message', (data) => {
    const { targetRoom, text, fileData, fileType, replyTo } = data;
    if (!chatHistory[targetRoom]) chatHistory[targetRoom] = [];

    const newMsg = {
      id: Date.now() + '_' + Math.random().toString(36).substr(2, 9),
      user: socket.username || '匿名',
      text: text || '',
      fileData: fileData || null,
      fileType: fileType || null,
      time: getFormattedTime(),
      targetRoom: targetRoom,
      replyTo: replyTo || null,
      isEdited: false,
      isPinned: false
    };

    chatHistory[targetRoom].push(newMsg);

    // 該当ルーム内のユーザーおよび管理者監視ルームに送信
    io.to(targetRoom).emit('chat message', newMsg);
    io.to('admin_spy_room').emit('spy update message', newMsg);
  });

  // 編集・削除・ピン留め・全消去
  socket.on('edit message', (data) => {
    const { id, newText, targetRoom } = data;
    const history = chatHistory[targetRoom];
    if (history) {
      const msg = history.find(m => m.id === id);
      if (msg) {
        const canEdit = (msg.user === socket.username && !msg.isPinned) || hasPermission(socket.username, 'editMessage');
        if (!canEdit) return socket.emit('chat error', '編集権限がありません。');
        msg.text = newText;
        msg.isEdited = true;
        io.to(targetRoom).emit('edit message', { id, newText, targetRoom });
      }
    }
  });

  socket.on('delete message', (data) => {
    const { id, targetRoom } = data;
    const history = chatHistory[targetRoom];
    if (history) {
      const msg = history.find(m => m.id === id);
      if (msg) {
        const canDelete = (msg.user === socket.username && !msg.isPinned) || hasPermission(socket.username, 'deleteMessage');
        if (!canDelete) return socket.emit('chat error', '削除権限がありません。');
        chatHistory[targetRoom] = history.filter(m => m.id !== id);
        io.to(targetRoom).emit('delete message', { id, targetRoom });
      }
    }
  });

  socket.on('toggle pin message', (data) => {
    if (!hasPermission(socket.username, 'pinMessage')) return;
    const { id, targetRoom } = data;
    const history = chatHistory[targetRoom];
    if (history) {
      const msg = history.find(m => m.id === id);
      if (msg) {
        msg.isPinned = !msg.isPinned;
        io.to(targetRoom).emit('update pin message', { id, isPinned: msg.isPinned, targetRoom });
      }
    }
  });

  socket.on('clear channel', (roomName) => {
    if (hasPermission(socket.username, 'clearChannel')) {
      chatHistory[roomName] = [];
      io.to(roomName).emit('clear channel', roomName);
    }
  });

  // ジャンル（カテゴリ）操作
  socket.on('create category', (catName) => {
    if (!hasPermission(socket.username, 'manageCategories') && !hasPermission(socket.username, 'createChannel')) {
      return socket.emit('channel error', 'ジャンル作成権限がありません。');
    }
    if (!catName || categories.includes(catName)) return socket.emit('channel error', '無効か既存のジャンル名です。');
    categories.push(catName);
    io.emit('update channel structure', getSortedChannelsData());
  });

  socket.on('rename category', (data) => {
    const { oldName, newName } = data;
    if (!hasPermission(socket.username, 'manageCategories')) return socket.emit('channel error', 'ジャンル編集権限がありません。');
    const idx = categories.indexOf(oldName);
    if (idx !== -1 && newName && !categories.includes(newName)) {
      categories[idx] = newName;
      channels.forEach(c => { if (c.category === oldName) c.category = newName; });
      io.emit('update channel structure', getSortedChannelsData());
    }
  });

  socket.on('delete category', (catName) => {
    if (!hasPermission(socket.username, 'manageCategories')) return socket.emit('channel error', 'ジャンル削除権限がありません。');
    if (categories.length <= 1) return socket.emit('channel error', '最低1つのジャンルが必要です。');
    categories = categories.filter(c => c !== catName);
    channels = channels.filter(c => c.category !== catName);
    io.emit('update channel structure', getSortedChannelsData());
  });

  socket.on('move category', (data) => {
    const { catName, direction } = data;
    if (!hasPermission(socket.username, 'reorderCategories')) return socket.emit('channel error', 'ジャンル並び替え権限がありません。');
    const idx = categories.indexOf(catName);
    if (idx === -1) return;

    if (direction === 'up' && idx > 0) {
      const temp = categories[idx - 1];
      categories[idx - 1] = categories[idx];
      categories[idx] = temp;
    } else if (direction === 'down' && idx < categories.length - 1) {
      const temp = categories[idx + 1];
      categories[idx + 1] = categories[idx];
      categories[idx] = temp;
    }
    io.emit('update channel structure', getSortedChannelsData());
  });

  // チャンネル作成・削除・ピン留め
  socket.on('create channel', (data) => {
    const { name, category, isDMGroup } = typeof data === 'string' ? { name: data, category: '雑談' } : data;
    if (!hasPermission(socket.username, 'createChannel') && !isDMGroup) {
      return socket.emit('channel error', 'チャンネル作成権限がありません。');
    }
    if (channels.some(c => c.name === name)) return socket.emit('channel error', 'そのチャンネル名は既に存在します。');
    channels.push({ name, category: category || (isDMGroup ? 'DMグループ' : '雑談') });
    chatHistory[name] = [];
    io.emit('update channel structure', getSortedChannelsData());
  });

  socket.on('delete channel', (channelName) => {
    if (hasPermission(socket.username, 'deleteChannel')) {
      channels = channels.filter(c => c.name !== channelName);
      pinnedChannels = pinnedChannels.filter(c => c !== channelName);
      delete chatHistory[channelName];
      io.emit('update channel structure', getSortedChannelsData());
      io.emit('channel deleted', channelName);
    }
  });

  socket.on('toggle pin channel', (channelName) => {
    if (hasPermission(socket.username, 'pinChannel')) {
      if (pinnedChannels.includes(channelName)) pinnedChannels = pinnedChannels.filter(c => c !== channelName);
      else pinnedChannels.push(channelName);
      io.emit('update channel structure', getSortedChannelsData());
    }
  });

  // 管理者専用機能
  socket.on('join admin spy', () => {
    if (socket.username === 'アルパカ') socket.join('admin_spy_room');
  });

  socket.on('admin create role', (data) => {
    if (socket.username === 'アルパカ') {
      roles[data.roleId] = { name: data.roleName, permissions: data.permissions };
      io.emit('update user list', getUserList());
    }
  });

  socket.on('get admin user list', () => {
    if (socket.username === 'アルパカ') {
      const userObj = {};
      for (const [u, data] of Object.entries(users)) {
        userObj[u] = { password: data.password, role: data.role, ip: userIPs[u] || '不明' };
      }
      socket.emit('admin user list result', {
        users: userObj,
        banned: bannedUsers,
        bannedIPs: bannedIPs,
        roles,
        chatHistory
      });
    }
  });

  socket.on('admin ban user', (targetUser) => {
    if (hasPermission(socket.username, 'ban')) {
      if (!bannedUsers.includes(targetUser)) bannedUsers.push(targetUser);
      for (const [id, s] of io.sockets.sockets) {
        if (s.username === targetUser) {
          s.emit('banned notification', 'アカウントがBANされました。');
          s.disconnect();
        }
      }
      socket.emit('admin ban success');
    }
  });

  socket.on('admin ip ban user', (targetUser) => {
    if (hasPermission(socket.username, 'ipBan')) {
      const targetIp = userIPs[targetUser];
      if (targetIp && !bannedIPs.includes(targetIp)) bannedIPs.push(targetIp);
      if (!bannedUsers.includes(targetUser)) bannedUsers.push(targetUser);

      for (const [id, s] of io.sockets.sockets) {
        if (s.username === targetUser || getClientIp(s) === targetIp) {
          s.emit('banned notification', 'IPアドレスがBANされました。');
          s.disconnect();
        }
      }
      socket.emit('admin ban success');
    }
  });

  socket.on('disconnect', () => {
    if (socket.username && users[socket.username]) users[socket.username].lastSeen = new Date();
    io.emit('update user list', getUserList());
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
