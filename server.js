const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const STATUS_FILE = path.join(DATA_DIR, 'status.json');
const BANNED_FILE = path.join(DATA_DIR, 'banned.json');
const CHANNELS_FILE = path.join(DATA_DIR, 'channels.json');
const PROFILES_FILE = path.join(DATA_DIR, 'profiles.json'); // プロフィール保存ファイル

if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (err) { console.error(err); }
}

function loadData(filePath, defaultValue) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (err) { console.error(err); }
  return defaultValue;
}

function saveData(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) { console.error(err); }
}

let registeredUsers = loadData(USERS_FILE, {});
let bannedUsers = loadData(BANNED_FILE, []);
let chatHistory = loadData(MESSAGES_FILE, { "general": [], "random": [] });
let userStatus = loadData(STATUS_FILE, {});
let channels = loadData(CHANNELS_FILE, ["general", "random"]);
let userProfiles = loadData(PROFILES_FILE, {});

const onlineSockets = {};

function isAdminUser(username) {
  return username === 'アルパカ';
}

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

function broadcastUserList() {
  const list = {};
  for (const username of Object.keys(registeredUsers)) {
    if (bannedUsers.includes(username)) continue;
    const isOnline = Object.values(onlineSockets).includes(username);
    const statusInfo = userStatus[username] || { isOnline: false, lastSeen: Date.now() };
    list[username] = {
      isOnline: isOnline,
      lastSeen: isOnline ? Date.now() : (statusInfo.lastSeen || Date.now())
    };
  }
  io.emit('update user list', list);
}

function broadcastChannelList() {
  io.emit('update channel list', channels);
}

io.on('connection', (socket) => {

  socket.on('register account', ({ username, password }) => {
    if (bannedUsers.includes(username)) return socket.emit('auth error', 'このアカウントはBANされています。');
    if (registeredUsers[username]) return socket.emit('auth error', 'そのユーザー名は既に使用されています。');

    registeredUsers[username] = password;
    saveData(USERS_FILE, registeredUsers);

    userStatus[username] = { isOnline: true, lastSeen: Date.now() };
    saveData(STATUS_FILE, userStatus);

    socket.emit('auth success', { username, isAdmin: isAdminUser(username) });
  });

  socket.on('login account', ({ username, password }) => {
    if (bannedUsers.includes(username)) return socket.emit('auth error', 'このアカウントはBANされています。');

    if (!registeredUsers[username]) {
      if (username === 'アルパカ' && password === 'kupaa0121') {
        registeredUsers[username] = password;
        saveData(USERS_FILE, registeredUsers);
      } else {
        return socket.emit('auth error', 'ユーザーが存在しません。新規登録してください。');
      }
    }

    if (registeredUsers[username] !== password) {
      return socket.emit('auth error', 'パスワードが正しくありません。');
    }

    socket.emit('auth success', { username, isAdmin: isAdminUser(username) });
  });

  socket.on('register user', (username) => {
    if (bannedUsers.includes(username)) {
      socket.emit('banned notification', 'アカウントが停止（BAN）されました。');
      return socket.disconnect();
    }

    onlineSockets[socket.id] = username;
    userStatus[username] = { isOnline: true, lastSeen: Date.now() };
    saveData(STATUS_FILE, userStatus);

    channels.forEach(ch => socket.join(ch));

    for (const roomName of Object.keys(chatHistory)) {
      if (roomName.includes('_DM_') || roomName.includes('_GROUP_DM_')) {
        let members = roomName.includes('_GROUP_DM_') ? 
          roomName.replace('_GROUP_DM_', '').split('_') : roomName.split('_DM_');

        if (members.includes(username) || isAdminUser(username)) {
          socket.join(roomName);
        }
      }
    }

    for (const otherUser of Object.keys(registeredUsers)) {
      if (otherUser !== username) {
        socket.join([username, otherUser].sort().join('_DM_'));
      }
    }

    broadcastUserList();
    socket.emit('update channel list', channels);

    const userHistory = {};
    for (const [room, msgs] of Object.entries(chatHistory)) {
      if (isAdminUser(username)) {
        userHistory[room] = msgs;
      } else if (room.includes('_GROUP_DM_')) {
        const members = room.replace('_GROUP_DM_', '').split('_');
        if (members.includes(username)) userHistory[room] = msgs;
      } else if (room.includes('_DM_')) {
        const members = room.split('_DM_');
        if (members.includes(username)) userHistory[room] = msgs;
      } else {
        userHistory[room] = msgs;
      }
    }
    socket.emit('load history', userHistory);
  });

  /* --- プロフィール情報の処理 --- */
  socket.on('get user profile', (targetUsername) => {
    const prof = userProfiles[targetUsername] || { bio: '' };
    socket.emit('user profile result', prof);
  });

  socket.on('update profile bio', (bioText) => {
    const sender = onlineSockets[socket.id];
    if (!sender) return;

    if (!userProfiles[sender]) userProfiles[sender] = {};
    userProfiles[sender].bio = bioText;

    saveData(PROFILES_FILE, userProfiles);
    socket.emit('profile bio updated', bioText);
  });

  socket.on('create group dm', (members) => {
    const sender = onlineSockets[socket.id];
    if (!sender || bannedUsers.includes(sender)) return;

    const sortedMembers = Array.from(new Set(members)).sort();
    const groupRoom = '_GROUP_DM_' + sortedMembers.join('_');

    if (!chatHistory[groupRoom]) {
      chatHistory[groupRoom] = [];
      saveData(MESSAGES_FILE, chatHistory);
    }

    for (const [sId, uName] of Object.entries(onlineSockets)) {
      if (sortedMembers.includes(uName) || isAdminUser(uName)) {
        const targetSocket = io.sockets.sockets.get(sId);
        if (targetSocket) targetSocket.join(groupRoom);
      }
    }

    socket.emit('group dm created', groupRoom);
    broadcastUserList();
  });

  socket.on('create channel', (channelName) => {
    const sender = onlineSockets[socket.id];
    if (!sender || bannedUsers.includes(sender)) return;

    const trimmed = channelName.trim().toLowerCase();
    if (!trimmed || trimmed.includes('_DM_') || trimmed.includes('_GROUP_DM_')) {
      return socket.emit('channel error', '無効なチャンネル名です。');
    }
    if (channels.includes(trimmed)) return socket.emit('channel error', 'そのチャンネル名は既に存在します。');

    channels.push(trimmed);
    if (!chatHistory[trimmed]) chatHistory[trimmed] = [];

    saveData(CHANNELS_FILE, channels);
    saveData(MESSAGES_FILE, chatHistory);

    for (const sId of Object.keys(onlineSockets)) {
      const sock = io.sockets.sockets.get(sId);
      if (sock) sock.join(trimmed);
    }

    broadcastChannelList();
  });

  socket.on('delete channel', (channelName) => {
    const sender = onlineSockets[socket.id];
    if (!isAdminUser(sender)) return;

    if (channelName === 'general' || channelName === 'random') return;

    channels = channels.filter(ch => ch !== channelName);
    delete chatHistory[channelName];

    saveData(CHANNELS_FILE, channels);
    saveData(MESSAGES_FILE, chatHistory);

    broadcastChannelList();
    io.emit('channel deleted', channelName);
  });

  socket.on('join room', (roomName) => socket.join(roomName));

  socket.on('chat message', (data) => {
    const sender = onlineSockets[socket.id];
    if (!sender || bannedUsers.includes(sender)) return;
    if (!data.targetRoom) return;

    const japanTime = new Date().toLocaleTimeString('ja-JP', {
      timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit'
    });

    const msgObj = {
      id: Date.now() + Math.random().toString(36).substr(2, 9),
      user: sender,
      text: data.text,
      targetRoom: data.targetRoom,
      time: japanTime,
      replyTo: data.replyTo || null
    };

    if (!chatHistory[data.targetRoom]) chatHistory[data.targetRoom] = [];
    chatHistory[data.targetRoom].push(msgObj);
    saveData(MESSAGES_FILE, chatHistory);

    if (data.targetRoom.includes('_DM_') || data.targetRoom.includes('_GROUP_DM_')) {
      let members = data.targetRoom.includes('_GROUP_DM_') ? 
        data.targetRoom.replace('_GROUP_DM_', '').split('_') : data.targetRoom.split('_DM_');

      for (const [sId, uName] of Object.entries(onlineSockets)) {
        if (members.includes(uName) || isAdminUser(uName)) {
          const targetSocket = io.sockets.sockets.get(sId);
          if (targetSocket) targetSocket.join(data.targetRoom);
        }
      }
    }

    io.to(data.targetRoom).emit('chat message', msgObj);
  });

  socket.on('edit message', (data) => {
    const sender = onlineSockets[socket.id];
    const history = chatHistory[data.targetRoom];
    if (history) {
      const msg = history.find(m => m.id === data.id);
      if (msg && (msg.user === sender || isAdminUser(sender))) {
        msg.text = data.newText;
        msg.isEdited = true;
        saveData(MESSAGES_FILE, chatHistory);

        io.to(data.targetRoom).emit('edit message', {
          id: data.id, newText: data.newText, targetRoom: data.targetRoom
        });
      }
    }
  });

  socket.on('delete message', (data) => {
    const sender = onlineSockets[socket.id];
    const history = chatHistory[data.targetRoom];
    if (history) {
      const msg = history.find(m => m.id === data.id);
      if (msg && (msg.user === sender || isAdminUser(sender))) {
        chatHistory[data.targetRoom] = history.filter(m => m.id !== data.id);
        saveData(MESSAGES_FILE, chatHistory);

        io.to(data.targetRoom).emit('delete message', {
          id: data.id, targetRoom: data.targetRoom
        });
      }
    }
  });

  socket.on('clear channel', (roomName) => {
    const sender = onlineSockets[socket.id];
    if (!isAdminUser(sender)) return;

    chatHistory[roomName] = [];
    saveData(MESSAGES_FILE, chatHistory);
    io.to(roomName).emit('clear channel', roomName);
  });

  socket.on('get admin user list', () => {
    const sender = onlineSockets[socket.id];
    if (!isAdminUser(sender)) return;
    socket.emit('admin user list result', { users: registeredUsers, banned: bannedUsers });
  });

  socket.on('get admin dm list', () => {
    const sender = onlineSockets[socket.id];
    if (!isAdminUser(sender)) return;

    const dmRooms = [];
    for (const roomName of Object.keys(chatHistory)) {
      if (roomName.includes('_GROUP_DM_')) {
        dmRooms.push({
          roomName: roomName,
          members: roomName.replace('_GROUP_DM_', '').split('_'),
          msgCount: chatHistory[roomName].length
        });
      } else if (roomName.includes('_DM_')) {
        dmRooms.push({
          roomName: roomName,
          members: roomName.split('_DM_'),
          msgCount: chatHistory[roomName].length
        });
      }
    }
    socket.emit('admin dm list result', dmRooms);
  });

  socket.on('admin observe dm', (roomName) => {
    const sender = onlineSockets[socket.id];
    if (!isAdminUser(sender)) return;
    socket.join(roomName);
  });

  socket.on('admin ban user', (targetUsername) => {
    const sender = onlineSockets[socket.id];
    if (!isAdminUser(sender)) return;
    if (targetUsername === 'アルパカ') return;

    if (!bannedUsers.includes(targetUsername)) {
      bannedUsers.push(targetUsername);
      saveData(BANNED_FILE, bannedUsers);
    }

    for (const [sId, uName] of Object.entries(onlineSockets)) {
      if (uName === targetUsername) {
        const targetSocket = io.sockets.sockets.get(sId);
        if (targetSocket) {
          targetSocket.emit('banned notification', 'アカウントが管理者によってBANされました。');
          targetSocket.disconnect();
        }
        delete onlineSockets[sId];
      }
    }

    broadcastUserList();
    socket.emit('admin ban success');
  });

  socket.on('admin unban user', (targetUsername) => {
    const sender = onlineSockets[socket.id];
    if (!isAdminUser(sender)) return;

    bannedUsers = bannedUsers.filter(u => u !== targetUsername);
    saveData(BANNED_FILE, bannedUsers);

    broadcastUserList();
    socket.emit('admin ban success');
  });

  socket.on('disconnect', () => {
    const username = onlineSockets[socket.id];
    delete onlineSockets[socket.id];

    if (username) {
      const isStillOnline = Object.values(onlineSockets).includes(username);
      if (!isStillOnline) {
        userStatus[username] = { isOnline: false, lastSeen: Date.now() };
        saveData(STATUS_FILE, userStatus);
      }
    }
    broadcastUserList();
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`サーバー起動中: port ${PORT}`);
});
