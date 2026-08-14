const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// オンラインユーザー管理 { socketId: username }
const users = {};

io.on('connection', (socket) => {
  console.log('ユーザー接続:', socket.id);

  // ユーザー登録（ログイン時）
  socket.on('register user', (username) => {
    users[socket.id] = username;

    // デフォルトで基本のチャンネルに参加させておく
    socket.join('general');
    socket.join('random');

    // 全員にオンラインユーザーリストを更新して通知
    io.emit('update user list', users);
  });

  // 部屋（チャンネルやDM）に参加する処理
  socket.on('join room', (roomName) => {
    socket.join(roomName);
    console.log(`${users[socket.id] || socket.id} が ${roomName} に参加しました`);
  });

  // メッセージ受信＆送信
  socket.on('chat message', (data) => {
    // 送信先の部屋（data.targetRoom）にいる全員に送信
    if (data.targetRoom) {
      io.to(data.targetRoom).emit('chat message', {
        user: users[socket.id] || '匿名',
        text: data.text,
        targetRoom: data.targetRoom
      });
    }
  });

  // 切断時
  socket.on('disconnect', () => {
    delete users[socket.id];
    io.emit('update user list', users);
    console.log('ユーザー切断:', socket.id);
  });
});

// Renderの環境変数PORT対応（念のため設定）
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`サーバー起動中: port ${PORT}`);
});
