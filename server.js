const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// 画像・動画のデータ送信（Base64）に対応するため制限を拡大 (50MB)
const io = new Server(server, {
  maxHttpBufferSize: 1e8 // 100MB
});

app.use(express.static(__dirname));

// データベース代わりのメモリ保持オブジェクト
const users = {
  'アルパカ': { password: 'kupaa0121', lastSeen: null } // 管理者アカウント
};
let bannedUsers = [];
let bannedIPs = [];      // IP BAN対象リスト
let userIPs = {};        // ユーザー名 -> IPアドレス のマップ
let profiles = {};       // プロフィール

let channels = ['general', 'random'];
let pinnedChannels = []; // ★開発者が固定したチャンネルのリスト
let chatHistory = {
  'general': [],
  'random': []
};

// IPアドレス取得ヘルパー
function getClientIp(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  return forwarded ? forwarded.split(',')[0].trim() : socket.handshake.address;
}

// ユーザー一覧取得
function getUserList() {
  const userList = {};
  for (const [uname, udata] of Object.entries(users)) {
    userList[uname] = {
      isOnline: false,
      lastSeen: udata.lastSeen || null
    };
  }

  for (const [socketId, socket] of io.sockets.sockets) {
    if (socket.username) {
      if (!userList[socket.username]) {
        userList[socket.username] = {};
      }
      userList[socket.username].isOnline = true;
    }
  }
  return userList;
}

// チャンネルリストを「固定チャンネル」＋「五十音順ソート」にして取得
function getSortedChannels() {
  const normalChannels = channels
    .filter(c => !pinnedChannels.includes(c))
    .sort((a, b) => a.localeCompare(b, 'ja'));

  const pinnedSorted = pinnedChannels
    .slice()
    .sort((a, b) => a.localeCompare(b, 'ja'));

  return {
    pinned: pinnedSorted,
    normal: normalChannels
  };
}

// 時間フォーマット関数 (日本時間)
function getFormattedTime() {
  const d = new Date();
  return d.toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

io.on('connection', (socket) => {
  const clientIp = getClientIp(socket);

  // 1. 新規登録
  socket.on('register account', (data) => {
    const { username, password } = data;
    if (!username || !password) return socket.emit('auth error', 'ユーザー名とパスワードを入力してください。');
    
    if (bannedIPs.includes(clientIp)) {
      return socket.emit('auth error', 'このネットワーク（IPアドレス）からのアクセスは制限されています。');
    }

    if (users[username]) return socket.emit('auth error', 'そのユーザー名は既に使用されています。');

    users[username] = { password: password, lastSeen: null };
    userIPs[username] = clientIp;
    socket.username = username;

    socket.emit('auth success', {
      username: username,
      isAdmin: (username === 'アルパカ')
    });

    io.emit('update user list', getUserList());
  });

  // 2. ログイン
  socket.on('login account', (data) => {
    const { username, password } = data;
    
    if (bannedIPs.includes(clientIp)) {
      return socket.emit('auth error', 'このネットワーク（IPアドレス）からのアクセスは制限されています。');
    }

    if (bannedUsers.includes(username)) {
      return socket.emit('auth error', 'このアカウントはBANされています。');
    }

    if (!users[username] || users[username].password !== password) {
      return socket.emit('auth error', 'ユーザー名またはパスワードが正しくありません。');
    }

    userIPs[username] = clientIp;
    socket.username = username;

    socket.emit('auth success', {
      username: username,
      isAdmin: (username === 'アルパカ')
    });

    io.emit('update user list', getUserList());
  });

  // 3. チャット初期接続
  socket.on('register user', (username) => {
    socket.username = username;
    socket.join('general');

    socket.emit('update channel list', getSortedChannels());
    socket.emit('load history', chatHistory);
    io.emit('update user list', getUserList());
  });

  // 4. ルーム移動
  socket.on('join room', (roomName) => {
    socket.rooms.forEach(r => {
      if (r !== socket.id) socket.leave(r);
    });
    socket.join(roomName);
  });

  // 5. メッセージ送信 (テキスト / メディア対応)
  socket.on('chat message', (data) => {
    const { targetRoom, text, fileData, fileType, replyTo } = data;
    if (!chatHistory[targetRoom]) chatHistory[targetRoom] = [];

    const timeStr = getFormattedTime();

    const newMsg = {
      id: Date.now() + '_' + Math.random().toString(36).substr(2, 9),
      user: socket.username || '匿名',
      text: text || '',
      fileData: fileData || null,
      fileType: fileType || null, // 'image' or 'video'
      time: timeStr,
      targetRoom: targetRoom,
      replyTo: replyTo || null,
      isEdited: false,
      isPinned: false // ★固定フラグ
    };

    chatHistory[targetRoom].push(newMsg);
    io.to(targetRoom).emit('chat message', newMsg);
  });

  // 6. メッセージ編集 (固定メッセージは投稿主であっても編集不可)
  socket.on('edit message', (data) => {
    const { id, newText, targetRoom } = data;
    const history = chatHistory[targetRoom];
    if (history) {
      const msg = history.find(m => m.id === id);
      if (msg) {
        if (msg.isPinned && socket.username !== 'アルパカ') {
          return socket.emit('chat error', '固定された投稿は削除・編集できません。');
        }
        msg.text = newText;
        msg.isEdited = true;
        io.to(targetRoom).emit('edit message', { id, newText, targetRoom });
      }
    }
  });

  // 7. メッセージ削除 (固定メッセージは投稿主であっても削除不可)
  socket.on('delete message', (data) => {
    const { id, targetRoom } = data;
    const history = chatHistory[targetRoom];
    if (history) {
      const msg = history.find(m => m.id === id);
      if (msg) {
        if (msg.isPinned && socket.username !== 'アルパカ') {
          return socket.emit('chat error', '固定された投稿は削除・編集できません。');
        }
        chatHistory[targetRoom] = history.filter(m => m.id !== id);
        io.to(targetRoom).emit('delete message', { id, targetRoom });
      }
    }
  });

  // ★ 8. メッセージ固定 / 固定解除（開発者限定）
  socket.on('toggle pin message', (data) => {
    if (socket.username !== 'アルパカ') return;
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

  // 9. チャンネル全消去
  socket.on('clear channel', (roomName) => {
    if (socket.username === 'アルパカ') {
      chatHistory[roomName] = [];
      io.to(roomName).emit('clear channel', roomName);
    }
  });

  // 10. チャンネル作成
  socket.on('create channel', (channelName) => {
    if (channels.includes(channelName)) {
      return socket.emit('channel error', 'そのチャンネル名は既に存在します。');
    }
    channels.push(channelName);
    chatHistory[channelName] = [];
    io.emit('update channel list', getSortedChannels());
  });

  // 11. チャンネル削除
  socket.on('delete channel', (channelName) => {
    if (socket.username === 'アルパカ') {
      channels = channels.filter(c => c !== channelName);
      pinnedChannels = pinnedChannels.filter(c => c !== channelName);
      delete chatHistory[channelName];
      io.emit('update channel list', getSortedChannels());
      io.emit('channel deleted', channelName);
    }
  });

  // ★ 12. チャンネル固定 / 解除（開発者限定）
  socket.on('toggle pin channel', (channelName) => {
    if (socket.username === 'アルパカ') {
      if (pinnedChannels.includes(channelName)) {
        pinnedChannels = pinnedChannels.filter(c => c !== channelName);
      } else {
        pinnedChannels.push(channelName);
      }
      io.emit('update channel list', getSortedChannels());
    }
  });

  // 13. グループDM作成
  socket.on('create group dm', (members) => {
    members.sort();
    const groupRoom = '_GROUP_DM_' + members.join('_');
    if (!chatHistory[groupRoom]) {
      chatHistory[groupRoom] = [];
    }
    socket.emit('group dm created', groupRoom);
  });

  // 14. プロフィール取得
  socket.on('get user profile', (username) => {
    const prof = profiles[username] || { bio: '' };
    socket.emit('user profile result', prof);
  });

  // 15. プロフィール更新
  socket.on('update profile bio', (bioText) => {
    if (!socket.username) return;
    if (!profiles[socket.username]) profiles[socket.username] = {};
    profiles[socket.username].bio = bioText;
    socket.emit('profile bio updated', bioText);
  });

  // 16. 管理者用：ユーザー一覧取得
  socket.on('get admin user list', () => {
    if (socket.username === 'アルパカ') {
      const userObj = {};
      for (const [u, data] of Object.entries(users)) {
        userObj[u] = data.password;
      }
      socket.emit('admin user list result', { users: userObj, banned: bannedUsers });
    }
  });

  // 17. 管理者用：DM一覧取得
  socket.on('get admin dm list', () => {
    if (socket.username === 'アルパカ') {
      const dmRooms = [];
      for (const roomName of Object.keys(chatHistory)) {
        if (roomName.includes('_DM_') || roomName.includes('_GROUP_DM_')) {
          let members = [];
          if (roomName.includes('_GROUP_DM_')) {
            members = roomName.replace('_GROUP_DM_', '').split('_');
          } else {
            members = roomName.split('_DM_');
          }
          dmRooms.push({
            roomName: roomName,
            members: members,
            msgCount: chatHistory[roomName].length
          });
        }
      }
      socket.emit('admin dm list result', dmRooms);
    }
  });

  // 18. 管理者用：アカウントBAN
  socket.on('admin ban user', (targetUser) => {
    if (socket.username === 'アルパカ') {
      if (!bannedUsers.includes(targetUser)) bannedUsers.push(targetUser);

      for (const [id, s] of io.sockets.sockets) {
        if (s.username === targetUser) {
          s.emit('banned notification', '管理者によりアカウントがBANされました。');
          s.disconnect();
        }
      }
      socket.emit('admin ban success');
    }
  });

  // 19. 管理者用：IP BAN
  socket.on('admin ip ban user', (targetUser) => {
    if (socket.username === 'アルパカ') {
      const targetIp = userIPs[targetUser];

      if (!bannedUsers.includes(targetUser)) bannedUsers.push(targetUser);
      if (targetIp && !bannedIPs.includes(targetIp)) {
        bannedIPs.push(targetIp);
      }

      for (const [id, s] of io.sockets.sockets) {
        const sIp = getClientIp(s);
        if (s.username === targetUser || (targetIp && sIp === targetIp)) {
          s.emit('banned notification', '管理者によりIP BAN（ネットワークアクセス制限）されました。');
          s.disconnect();
        }
      }
      socket.emit('admin ban success');
    }
  });

  // 20. 管理者用：BAN解除
  socket.on('admin unban user', (targetUser) => {
    if (socket.username === 'アルパカ') {
      bannedUsers = bannedUsers.filter(u => u !== targetUser);

      const targetIp = userIPs[targetUser];
      if (targetIp) {
        bannedIPs = bannedIPs.filter(ip => ip !== targetIp);
      }
      socket.emit('admin ban success');
    }
  });

  // 21. 接続切断
  socket.on('disconnect', () => {
    if (socket.username && users[socket.username]) {
      users[socket.username].lastSeen = new Date();
    }
    io.emit('update user list', getUserList());
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
