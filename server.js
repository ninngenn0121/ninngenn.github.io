const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// オンラインユーザー管理 { socketId: username }
const users = {};

io.on('connection', (socket) => {
  console.log('ユーザー接続:', socket.id);

  // ユーザー登録（ログイン時）
  socket.on('register user', (username) => {
    users[socket.id] = username;
    // デフォルトで general チャンネルに参加
    socket.join('general');
    
    // 全員にオンラインユーザーリストを更新して通知
    io.emit('update user list', users);
  });

  // チャンネルまたはDMへの参加切り替え
  socket.on('join room', (roomName) => {
    // 既存のすべての部屋から退出（自身の個別ID部屋以外）
    Array.from(socket.rooms).forEach(room => {
      if (room !== socket.id) socket.leave(room);
    });

    socket.join(roomName);
    console.log(`${users[socket.id]} が ${roomName} に参加しました`);
  });

  // メッセージ受信＆送信
  socket.on('chat message', (data) => {
    // targetRoom (例: 'general' や 'DM_ユーザーA_ユーザーB') 内のユーザーだけに送信
    io.to(data.targetRoom).emit('chat message', {
      user: users[socket.id],
      text: data.text,
      targetRoom: data.targetRoom
    });
  });

  // 切断時
  socket.on('disconnect', () => {
    delete users[socket.id];
    io.emit('update user list', users);
    console.log('ユーザー切断:', socket.id);
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`サーバー起動中: http://localhost:${PORT}`);
});
