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

const users = {};

io.on('connection', (socket) => {
  console.log('ユーザー接続:', socket.id);

  socket.on('register user', (username) => {
    users[socket.id] = username;
    socket.join('general');
    socket.join('random');
    io.emit('update user list', users);
  });

  socket.on('join room', (roomName) => {
    socket.join(roomName);
  });

  // 新規メッセージ受信
  socket.on('chat message', (data) => {
    if (data.targetRoom) {
      io.to(data.targetRoom).emit('chat message', {
        id: Date.now() + Math.random().toString(36).substr(2, 9), // ユニークID
        user: users[socket.id] || '匿名',
        text: data.text,
        targetRoom: data.targetRoom,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) // 現在時刻 (例: 14:30)
      });
    }
  });

  // 🌟 メッセージ編集の受信＆全員への配信
  socket.on('edit message', (data) => {
    if (data.targetRoom) {
      io.to(data.targetRoom).emit('edit message', {
        id: data.id,
        newText: data.newText,
        targetRoom: data.targetRoom
      });
    }
  });

  socket.on('disconnect', () => {
    delete users[socket.id];
    io.emit('update user list', users);
  });
});
