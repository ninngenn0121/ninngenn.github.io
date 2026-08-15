const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

// Render等のホスティング環境向けにCORSおよびSocket.IOオプションを設定
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Renderのディスク永続化パス対応 (RenderでDiskをマウントする場合は `/var/data` 等を指定)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const STATUS_FILE = path.join(DATA_DIR, 'status.json');
const BANNED_FILE = path.join(DATA_DIR, 'banned.json');

// 保存用フォルダの作成
if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    console.error('データディレクトリ作成エラー:', err);
  }
}

// データの読み込み関数
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

// データの保存関数
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

// オンラインソケットの管理 { socketId: username }
const onlineSockets = {};

// 管理者判定
function isAdminUser(username) {
  return username === 'アルパカ';
}

// 静的ファイルの提供
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ユーザーリストの全通知
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

  // オンラインユーザー登録 ＆ 過去の全DMルーム自動参加
  socket.on('register user', (username) => {
    if (bannedUsers.includes(username)) {
      socket.emit('banned notification', 'アカウントが停止（BAN）されました。');
      return socket.disconnect();
    }

    onlineSockets[socket.id] = username;
    
    userStatus[username] = { isOnline: true, lastSeen: Date.now() };
    saveData(STATUS_FILE, userStatus);

    // デフォルトチャンネル
    socket.join('general');
    socket.join('random');

    // ★過去の全DMルームのうち、自分が含まれるものに自動参加させる
    for (const roomName of Object.keys(chatHistory)) {
      if (roomName.includes('_DM_')) {
        const members = roomName.split('_DM_');
        if (members.includes(username)) {
          socket.join(roomName);
        }
      }
    }
    
    broadcastUserList();
    
    // 自分に関係のあるメッセージ履歴のみ送信
    const userHistory = {};
    for (const [room, msgs] of Object.entries(chatHistory)) {
      if (!room.includes('_DM_') || room.split('_DM_').includes(username)) {
        userHistory[room] = msgs;
      }
    }
    socket.emit('load history', userHistory);
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

    // ★DMの場合、受信者（相手）がオンラインならそのソケットを該当ルームに即座参加させる
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

    // 対象のルーム全体へ配信
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

  // チャンネル削除
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

  // ★BAN解除処理（即時反映）
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

// Renderの環境変数 PORT (デフォルト 10000) で起動し、0.0.0.0 でバインド
const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`サーバー起動中: port ${PORT}`);
});
