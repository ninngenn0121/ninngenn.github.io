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

