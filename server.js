const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  maxHttpBufferSize: 1e8 // 100MBまで許容（画像・動画）
});

app.use(express.static(__dirname));

// アカウントデータベース
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
      manageCategories: true
    }
  }
};

let bannedUsers = [];
let bannedIPs = [];
let userIPs = {};
let profiles = {};

// ジャンル（カテゴリ）＆チャンネル管理
let categories = ['基本', '雑談', 'ゲーム'];
let channels = [
  { name: 'general', category: '基本' },
  { name: 'random', category: '雑談' }
];

let pinnedChannels = [];
let chatHistory = {
  'general': [],
  'random': []
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
    pinned: pinnedChannels
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

  // アカウント認証
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

  // 全体＆チャンネル個別通知設定
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

  // プロフィール機能
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

  // ルーム移動
  socket.on('join room', (roomName) => {
    socket.rooms.forEach(r => { if (r !== socket.id) socket.leave(r); });
    socket.join(roomName);
  });

  // メッセージ送信（返信、DM、画像/動画対応）
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
      replyTo: replyTo || null, // 返信先オブジェクト
      isEdited: false,
      isPinned: false
    };

    chatHistory[targetRoom].push(newMsg);
    
    // 通常の部屋への配信
    io.to(targetRoom).emit('chat message', newMsg);
    
    // 管理者監視パネルへのリアルタイム同期配信
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

  // ジャンル＆チャンネル作成
  socket.on('create category', (catName) => {
    if (!hasPermission(socket.username, 'createChannel') && !hasPermission(socket.username, 'manageCategories')) {
      return socket.emit('channel error', 'ジャンル作成権限がありません。');
    }
    if (!catName || categories.includes(catName)) return socket.emit('channel error', '無効か既存のジャンル名です。');
    categories.push(catName);
    io.emit('update channel structure', getSortedChannelsData());
  });

  socket.on('create channel', (data) => {
    const { name, category, isDMGroup } = typeof data === 'string' ? { name: data, category: '基本' } : data;
    if (!hasPermission(socket.username, 'createChannel') && !isDMGroup) {
      return socket.emit('channel error', 'チャンネル作成権限がありません。');
    }
    if (channels.some(c => c.name === name)) return socket.emit('channel error', 'そのチャンネル名は既に存在します。');
    channels.push({ name, category: category || (isDMGroup ? 'DMグループ' : '基本') });
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

  // 管理者専用（パスワード閲覧、全DM監視、割り込み参加、BAN、IP BAN）
  socket.on('join admin spy', () => {
    if (socket.username === 'アルパカ') socket.join('admin_spy_room');
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
