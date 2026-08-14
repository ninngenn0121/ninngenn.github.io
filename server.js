const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// index.html の提供
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 登録ユーザーDB (メモリ上) { username: password }
const registeredUsers = {};

// オンラインユーザー管理 { socketId: username }
const onlineUsers = {};

// 全メッセージ履歴
const chatHistory = {
  "general": [],
  "random": []
};

io.on('connection', (socket) => {
  console.log('ユーザー接続:', socket.id);

  // 新規登録
  socket.on('register account', ({ username, password }) => {
    if (registeredUsers[username]) {
      return socket.emit('auth error', 'そのユーザー名は既に使用されています。');
    }
    registeredUsers[username] = password;
    socket.emit('auth success', { username, isAdmin: (username === 'アルパカ' && password === 'kupaa0121') });
  });

  // ログイン認証
  socket.on('login account', ({ username, password }) => {
    if (!registeredUsers[username]) {
      if (username === 'アルパカ' && password === 'kupaa0121') {
        registeredUsers[username] = password;
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
      io.to(data.targetRoom).emit('delete message', {
        id: data.id,
        targetRoom: data.targetRoom
      });
    }
  });

  // チャンネル投稿全削除
  socket.on('clear channel', (roomName) => {
    chatHistory[roomName] = [];
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
