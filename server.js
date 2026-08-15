const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// データ保存用ファイルパス
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');

// 保存用フォルダがない場合は作成
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
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

// 登録ユーザーDB { username: password }
let registeredUsers = loadData(USERS_FILE, {});

// 全メッセージ履歴 { roomName: [ { id, user, text, targetRoom, time, isEdited }, ... ] }
let chatHistory = loadData(MESSAGES_FILE, {
  "general": [],
  "random": []
});

// オンラインユーザー管理 { socketId: username }
const onlineUsers = {};

// index.html の提供
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

io.on('connection', (socket) => {
  console.log('ユーザー接続:', socket.id);

  // 新規登録
  socket.on('register account', ({ username, password }) => {
    if (registeredUsers[username]) {
      return socket.emit('auth error', 'そのユーザー名は既に使用されています。');
    }
    registeredUsers[username] = password;
    saveData(USERS_FILE, registeredUsers);

    socket.emit('auth success', { username, isAdmin: (username === 'アルパカ' && password === 'kupaa0121') });
  });

  // ログイン認証
  socket.on('login account', ({ username, password }) => {
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

    const isAdmin = (username === 'アルパカ' && password === 'kupaa0121');
    socket.emit('auth success', { username, isAdmin });
  });

  // オンラインユーザー登録
  socket.on('register user', (username) => {
    onlineUsers[socket.id] = username;
    socket.join('general');
    socket.join('random');
    
    io.emit('update user list', onlineUsers);
    socket.emit('load history', chatHistory);
  });

  // 部屋参加
  socket.on('join room', (roomName) => {
    socket.join(roomName);
  });

  // メッセージ受信
  socket.on('chat message', (data) => {
    if (!data.targetRoom) return;

    const japanTime = new Date().toLocaleTimeString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      hour: '2-digit',
      minute: '2-digit'
    });

    const msgObj = {
      id: Date.now() + Math.random().toString(36).substr(2, 9),
      user: onlineUsers[socket.id] || '匿名',
      text: data.text,
      targetRoom: data.targetRoom,
      time: japanTime
    };

    if (!chatHistory[data.targetRoom]) {
      chatHistory[data.targetRoom] = [];
    }
    chatHistory[data.targetRoom].push(msgObj);
    saveData(MESSAGES_FILE, chatHistory);

    io.to(data.targetRoom).emit('chat message', msgObj);
  });

  // メッセージ編集
  socket.on('edit message', (data) => {
    const history = chatHistory[data.targetRoom];
    if (history) {
      const msg = history.find(m => m.id === data.id);
      if (msg) {
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
    const history = chatHistory[data.targetRoom];
    if (history) {
      chatHistory[data.targetRoom] = history.filter(m => m.id !== data.id);
      saveData(MESSAGES_FILE, chatHistory);

      io.to(data.targetRoom).emit('delete message', {
        id: data.id,
        targetRoom: data.targetRoom
      });
    }
  });

  // チャンネル投稿全削除
  socket.on('clear channel', (roomName) => {
    chatHistory[roomName] = [];
    saveData(MESSAGES_FILE, chatHistory);

    io.to(roomName).emit('clear channel', roomName);
  });

  // 開発者用: パスワード一覧
  socket.on('get admin user list', () => {
    socket.emit('admin user list result', registeredUsers);
  });

  // 開発者用: DM部屋監視
  socket.on('admin join room', (roomName) => {
    socket.join(roomName);
  });

  socket.on('disconnect', () => {
    delete onlineUsers[socket.id];
    io.emit('update user list', onlineUsers);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`サーバー起動中: port ${PORT}`);
});
