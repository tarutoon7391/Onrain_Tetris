const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

// ExpressアプリとHTTPサーバーを作成する
const app = express();
const server = http.createServer(app);

// Socket.ioサーバーをHTTPサーバーへ紐づける
const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

// 静的ファイルを配信する
app.use(express.static(path.join(__dirname, "public")));

// Railwayのヘルスチェック用に簡単な応答を返す
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// ルーム情報を保持するマップ
const rooms = new Map();

// ソケットごとの所属ルーム情報を保持するマップ
const socketMeta = new Map();

// 待機中ルームIDを保持する
let waitingRoomId = null;

// ルームIDを生成する関数
function createRoomId() {
  return `room-${Math.random().toString(36).slice(2, 10)}`;
}

// 新しいルームを作成する関数
function createRoom() {
  const roomId = createRoomId();
  const room = {
    id: roomId,
    players: [],
    playerNames: {},
    started: false,
    resultSent: false,
  };
  rooms.set(roomId, room);
  waitingRoomId = roomId;
  return room;
}

// 参加可能なルームを取得する関数
function getJoinableRoom() {
  if (!waitingRoomId) {
    return createRoom();
  }

  const room = rooms.get(waitingRoomId);
  if (!room || room.players.length >= 2) {
    return createRoom();
  }

  return room;
}

// ルーム内のプレイヤー番号を振り直す関数
function reindexRoomPlayers(room) {
  room.players.forEach((socketId, index) => {
    const meta = socketMeta.get(socketId);
    if (!meta) {
      return;
    }
    meta.playerNumber = index + 1;
    socketMeta.set(socketId, meta);
  });
}

// プレイヤーへ待機状態を通知する関数
function emitWaitingState(room) {
  room.players.forEach((socketId, index) => {
    io.to(socketId).emit("waiting", {
      roomId: room.id,
      playerNumber: index + 1,
    });
  });
}

// ルーム内2人へ対戦開始を通知する関数（プレイヤー名を双方へ共有する）
function emitMatchStart(room) {
  room.started = true;
  waitingRoomId = null;

  room.players.forEach((socketId, index) => {
    const opponentId = room.players[1 - index];
    const myName = room.playerNames[socketId] || `プレイヤー${index + 1}`;
    const opponentName = room.playerNames[opponentId] || `プレイヤー${2 - index}`;

    io.to(socketId).emit("matchStart", {
      roomId: room.id,
      playerNumber: index + 1,
      myName,
      opponentName,
    });
  });
}

// ルームへプレイヤーを参加させる関数
function joinRoom(socket, playerName) {
  const room = getJoinableRoom();
  room.players.push(socket.id);
  room.playerNames[socket.id] = playerName;
  socket.join(room.id);

  const playerNumber = room.players.length;
  socketMeta.set(socket.id, {
    roomId: room.id,
    playerNumber,
  });

  if (room.players.length >= 2) {
    emitMatchStart(room);
  } else {
    emitWaitingState(room);
  }
}

// ルームからプレイヤーを退出させる共通処理関数
function leaveCurrentRoom(socket) {
  const meta = socketMeta.get(socket.id);
  if (!meta) {
    return;
  }

  const room = rooms.get(meta.roomId);
  socketMeta.delete(socket.id);

  if (!room) {
    if (waitingRoomId === meta.roomId) {
      waitingRoomId = null;
    }
    return;
  }

  room.players = room.players.filter((id) => id !== socket.id);
  delete room.playerNames[socket.id];

  if (room.players.length === 0) {
    rooms.delete(room.id);
    if (waitingRoomId === room.id) {
      waitingRoomId = null;
    }
    return;
  }

  // 勝敗確定済みの場合は相手へ切断通知を送らない
  if (room.resultSent) {
    return;
  }

  room.started = false;
  reindexRoomPlayers(room);
  waitingRoomId = room.id;

  room.players.forEach((socketId) => {
    io.to(socketId).emit("opponentLeft", {
      roomId: room.id,
    });
  });

  emitWaitingState(room);
}

io.on("connection", (socket) => {
  // マッチング要求を受け取りプレイヤーをルームへ参加させる
  socket.on("joinMatch", (payload) => {
    const raw = typeof payload?.playerName === "string" ? payload.playerName : "";
    const playerName = raw.trim().slice(0, 20) || "ゲスト";
    joinRoom(socket, playerName);
  });

  // クライアントから受け取ったおじゃまラインを相手へ転送する
  socket.on("garbageLines", (payload) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) {
      return;
    }

    const room = rooms.get(meta.roomId);
    if (!room || room.players.length < 2) {
      return;
    }

    const count = Number(payload?.count || 0);
    if (!Number.isFinite(count) || count <= 0) {
      return;
    }

    room.players.forEach((socketId) => {
      if (socketId !== socket.id) {
        io.to(socketId).emit("receiveGarbage", {
          count,
          from: meta.playerNumber,
        });
      }
    });
  });

  // ゲームオーバー通知を受け取り勝敗を両プレイヤーへ通知する
  socket.on("gameOver", () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) {
      return;
    }

    const room = rooms.get(meta.roomId);
    if (!room || room.players.length < 2 || room.resultSent) {
      return;
    }

    // 最初にゲームオーバーになったプレイヤーが負け
    room.resultSent = true;
    io.to(socket.id).emit("result", { win: false });
    room.players.forEach((socketId) => {
      if (socketId !== socket.id) {
        io.to(socketId).emit("result", { win: true });
      }
    });
  });

  // プレイヤーがロビーへ戻る際にルームから退出させる
  socket.on("leaveRoom", () => {
    leaveCurrentRoom(socket);
  });

  // 切断時に部屋の状態を整理する
  socket.on("disconnect", () => {
    leaveCurrentRoom(socket);
  });
});

// Railway対応のポートで起動する
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`サーバー起動: ${PORT}`);
});
