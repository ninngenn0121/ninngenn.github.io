const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Render等のデータ永続化パス設定
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const STATUS_FILE = path.join(DATA_DIR, 'status.json');
const BANNED_FILE = path.join(DATA_DIR, 'banned.json');
const CHANNELS_FILE = path.join(DATA_DIR, 'channels.json'); // ★追加: チャンネル一覧ファイル

if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    console.error('データディレクトリ作成エラー:', err);
  }
}

function loadData(filePath, defaultValue) {
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error(`ファイル読み込みエラー (${filePath}):`, err);
  }
  return defaultValue;
}

function saveData(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error(`ファイル保存エラー (${filePath}):`, err);
  }
}

// データ初期化
let registeredUsers = loadData(USERS_FILE, {});
let bannedUsers = loadData(BANNED_FILE, []);
let chatHistory = loadData(MESSAGES_FILE, {
  "general": [],
  "random": []
});
let userStatus = loadData(STATUS_FILE, {});
// ★追加: チャンネルリストのロード（初期値は general と random）
let channels = loadData(CHANNELS_FILE, ["general", "random"]);

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

// ★追加: チャンネル一覧を全ユーザーに放送
function broadcastChannelList() {
  io.emit('update channel list', channels);
}

io.on('connection', (socket) => {
  console.log('ユーザー接続:', socket.id);

  // 新規登録
  socket.on('register account', ({ username, password }) => {
    if (bannedUsers.includes(username)) {
      return socket.emit('auth error', 'このアカウントはアカウント停止（BAN）されています。');
    }
    if (registeredUsers[username]) {
      return socket.emit('auth error', 'そのユーザー名は既に使用されています。');
    }
    registeredUsers[username] = password;
    saveData(USERS_FILE, registeredUsers);

    userStatus[username] = { isOnline: true, lastSeen: Date.now() };
    saveData(STATUS_FILE, userStatus);

    socket.emit('auth success', { username, isAdmin: isAdminUser(username) });
  });

  // ログイン認証
  socket.on('login account', ({ username, password }) => {
    if (bannedUsers.includes(username)) {
      return socket.emit('auth error', 'このアカウントはアカウント停止（BAN）されています。');
    }

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

  // オンラインユーザー登録
  socket.on('register user', (username) => {
    if (bannedUsers.includes(username)) {
      socket.emit('banned notification', 'アカウントが停止（BAN）されました。');
      return socket.disconnect();
    }

    onlineSockets[socket.id] = username;
    
    userStatus[username] = { isOnline: true, lastSeen: Date.now() };
    saveData(STATUS_FILE, userStatus);

    // ★全公開チャンネルに自動参加させる
    channels.forEach(ch => socket.join(ch));

    // DMルームへ自動参加
    for (const roomName of Object.keys(chatHistory)) {
      if (roomName.includes('_DM_')) {
        const members = roomName.split('_DM_');
        if (members.includes(username)) {
          socket.join(roomName);
        }
      }
    }
    
    broadcastUserList();
    socket.emit('update channel list', channels); // チャンネルリストを送信
    
    const userHistory = {};
    for (const [room, msgs] of Object.entries(chatHistory)) {
      if (!room.includes('_DM_') || room.split('_DM_').includes(username)) {
        userHistory[room] = msgs;
      }
    }
    socket.emit('load history', userHistory);
  });

  // ★追加: 新規チャンネル作成
  socket.on('create channel', (channelName) => {
    const sender = onlineSockets[socket.id];
    if (!sender || bannedUsers.includes(sender)) return;

    // バリデーション（空文字列、既存重複、予約語の排除）
    const trimmed = channelName.trim().toLowerCase();
    if (!trimmed || trimmed.includes('_DM_')) {
      return socket.emit('channel error', '無効なチャンネル名です。');
    }
    if (channels.includes(trimmed)) {
      return socket.emit('channel error', 'そのチャンネル名は既に存在します。');
    }

    channels.push(trimmed);
    if (!chatHistory[trimmed]) {
      chatHistory[trimmed] = [];
    }
    
    saveData(CHANNELS_FILE, channels);
    saveData(MESSAGES_FILE, chatHistory);

    // オンライン中の全ソケットをこの新チャンネルに参加させる
    for (const sId of Object.keys(onlineSockets)) {
      const sock = io.sockets.sockets.get(sId);
      if (sock) sock.join(trimmed);
    }

    broadcastChannelList();
  });

  // ★追加: チャンネル削除（管理者専用）
  socket.on('delete channel', (channelName) => {
    const sender = onlineSockets[socket.id];
    if (!isAdminUser(sender)) return;

    // デフォルトチャンネルは削除不可にする保護
    if (channelName === 'general' || channelName === 'random') {
      return socket.emit('auth error', 'デフォルトチャンネルは削除できません。');
    }

    channels = channels.filter(ch => ch !== channelName);
    delete chatHistory[channelName];

    saveData(CHANNELS_FILE, channels);
    saveData(MESSAGES_FILE, chatHistory);

    broadcastChannelList();
    io.emit('channel deleted', channelName);
  });

  // 部屋参加
  socket.on('join room', (roomName) => {
    socket.join(roomName);
  });

  // メッセージ送信処理
  socket.on('chat message', (data) => {
    const sender = onlineSockets[socket.id];
    if (!sender || bannedUsers.includes(sender)) return;
    if (!data.targetRoom) return;

    const japanTime = new Date().toLocaleTimeString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      hour: '2-digit',
      minute: '2-digit'
    });

    const msgObj = {
      id: Date.now() + Math.random().toString(36).substr(2, 9),
      user: sender,
      text: data.text,
      targetRoom: data.targetRoom,
      time: japanTime
    };

    if (!chatHistory[data.targetRoom]) {
      chatHistory[data.targetRoom] = [];
    }
    chatHistory[data.targetRoom].push(msgObj);
    saveData(MESSAGES_FILE, chatHistory);

    if (data.targetRoom.includes('_DM_')) {
      const members = data.targetRoom.split('_DM_');
      for (const [sId, uName] of Object.entries(onlineSockets)) {
        if (members.includes(uName)) {
          const targetSocket = io.sockets.sockets.get(sId);
          if (targetSocket) {
            targetSocket.join(data.targetRoom);
          }
        }
      }
    }

    io.to(data.targetRoom).emit('chat message', msgObj);
  });

  // メッセージ編集
  socket.on('edit message', (data) => {
    const sender = onlineSockets[socket.id];
    const history = chatHistory[data.targetRoom];
    if (history) {
      const msg = history.find(m => m.id === data.id);
      if (msg && msg.user === sender) {
        msg.text = data.newText;
        msg.isEdited = true;
        saveData(MESSAGES_FILE, chatHistory);

        io.to(data.targetRoom).emit('edit message', {
          id: data.id,
          newText: data.newText,
          targetRoom: data.targetRoom
        });
      }
    }
  });

  // メッセージ削除
  socket.on('delete message', (data) => {
    const sender = onlineSockets[socket.id];
    const history = chatHistory[data.targetRoom];
    if (history) {
      const msg = history.find(m => m.id === data.id);
      if (msg && (msg.user === sender || isAdminUser(sender))) {
        chatHistory[data.targetRoom] = history.filter(m => m.id !== data.id);
        saveData(MESSAGES_FILE, chatHistory);

        io.to(data.targetRoom).emit('delete message', {
          id: data.id,
          targetRoom: data.targetRoom
        });
      }
    }
  });

  // チャンネル内投稿全削除
  socket.on('clear channel', (roomName) => {
    const sender = onlineSockets[socket.id];
    if (!isAdminUser(sender)) return;

    chatHistory[roomName] = [];
    saveData(MESSAGES_FILE, chatHistory);

    io.to(roomName).emit('clear channel', roomName);
  });

  // 管理者API
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
      if (roomName.includes('_DM_')) {
        const members = roomName.split('_DM_');
        dmRooms.push({
          roomName: roomName,
          members: members,
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

  // BAN処理
  socket.on('admin ban user', (targetUsername) => {
    const sender = onlineSockets[socket.id];
    if (!isAdminUser(sender)) return;

    if (targetUsername === 'アルパカ') return socket.emit('auth error', '開発者をBANすることはできません。');

    if (!bannedUsers.includes(targetUsername)) {
      bannedUsers.push(targetUsername);
      saveData(BANNED_FILE, bannedUsers);
    }

    for (const [sId, uName] of Object.entries(onlineSockets)) {
      if (uName === targetUsername) {
        const targetSocket = io.sockets.sockets.get(sId);
        if (targetSocket) {
          targetSocket.emit('banned notification', 'アカウントが管理者によってBAN（停止）されました。');
          targetSocket.disconnect();
        }
        delete onlineSockets[sId];
      }
    }

    broadcastUserList();
    socket.emit('admin ban success', { username: targetUsername, isBanned: true });
  });

  // BAN解除
  socket.on('admin unban user', (targetUsername) => {
    const sender = onlineSockets[socket.id];
    if (!isAdminUser(sender)) return;

    bannedUsers = bannedUsers.filter(u => u !== targetUsername);
    saveData(BANNED_FILE, bannedUsers);

    broadcastUserList();
    socket.emit('admin ban success', { username: targetUsername, isBanned: false });
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
