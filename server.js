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

// ===== テトリス用ルーム管理 =====

// ルーム情報を保持するマップ
const rooms = new Map();

// ソケットごとの所属ルーム情報を保持するマップ
const socketMeta = new Map();

// 待機中ルームIDを保持する
let waitingRoomId = null;

// ===== Block Blast用ルーム管理 =====

// Block Blastルーム情報を保持するマップ
const bbRooms = new Map();

// Block Blast用ソケットごとの所属ルーム情報を保持するマップ
const bbSocketMeta = new Map();

// Block Blast用待機中ルームIDを保持する
let bbWaitingRoomId = null;

// テトリス用ルームIDを生成する関数
function createTetrisRoomId() {
  return `room-${Math.random().toString(36).slice(2, 10)}`;
}

// Block Blast用ルームIDを生成する関数
function createBBRoomId() {
  return `bb-${Math.random().toString(36).slice(2, 10)}`;
}

// 新しいルームを作成する関数
function createRoom() {
  const roomId = createTetrisRoomId();
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

// ===== Block Blast用ルーム操作関数 =====

// 新しいBlock Blastルームを作成する関数
function createBBRoom() {
  const roomId = createBBRoomId();
  const room = {
    id: roomId,
    players: [],
    playerNames: {},
    started: false,
    resultSent: false,
  };
  bbRooms.set(roomId, room);
  bbWaitingRoomId = roomId;
  return room;
}

// 参加可能なBlock Blastルームを取得する関数
function getJoinableBBRoom() {
  if (!bbWaitingRoomId) {
    return createBBRoom();
  }
  const room = bbRooms.get(bbWaitingRoomId);
  if (!room || room.players.length >= 2) {
    return createBBRoom();
  }
  return room;
}

// Block Blastルームへプレイヤーを参加させる関数
function joinBBRoom(socket, playerName) {
  const room = getJoinableBBRoom();
  room.players.push(socket.id);
  room.playerNames[socket.id] = playerName;
  socket.join(room.id);

  const playerNumber = room.players.length;
  bbSocketMeta.set(socket.id, { roomId: room.id, playerNumber });

  if (room.players.length >= 2) {
    // 2人揃ったのでゲーム開始を通知する
    room.started = true;
    bbWaitingRoomId = null;

    room.players.forEach((socketId, index) => {
      const opponentId = room.players[1 - index];
      const myName = room.playerNames[socketId] || `プレイヤー${index + 1}`;
      const opponentName = room.playerNames[opponentId] || `プレイヤー${2 - index}`;

      io.to(socketId).emit("bbMatchStart", {
        roomId: room.id,
        playerNumber: index + 1,
        myName,
        opponentName,
      });
    });
  } else {
    // 1人目は待機状態を通知する
    io.to(socket.id).emit("bbWaiting", {
      roomId: room.id,
      playerNumber: 1,
    });
  }
}

// Block Blastルームからプレイヤーを退出させる共通処理関数
function leaveBBRoom(socket) {
  const meta = bbSocketMeta.get(socket.id);
  if (!meta) {
    return;
  }

  const room = bbRooms.get(meta.roomId);
  bbSocketMeta.delete(socket.id);

  if (!room) {
    if (bbWaitingRoomId === meta.roomId) {
      bbWaitingRoomId = null;
    }
    return;
  }

  room.players = room.players.filter((id) => id !== socket.id);
  delete room.playerNames[socket.id];

  if (room.players.length === 0) {
    bbRooms.delete(room.id);
    if (bbWaitingRoomId === room.id) {
      bbWaitingRoomId = null;
    }
    return;
  }

  // 勝敗確定済みの場合は切断通知を送らない
  if (room.resultSent) {
    return;
  }

  room.started = false;
  bbWaitingRoomId = room.id;

  // 残ったプレイヤーに相手切断を通知し待機状態へ戻す
  room.players.forEach((socketId) => {
    io.to(socketId).emit("bbOpponentLeft", { roomId: room.id });
  });

  io.to(room.players[0]).emit("bbWaiting", {
    roomId: room.id,
    playerNumber: 1,
  });
}

// ===== カードゲーム用定数 =====

// カード定義（id, 名前, マナコスト, 効果種別, 効果量, ショップ購入コスト, 絵文字）
const CARD_DEFS = {
  // ===== 初期カード（ショップ非売品）=====
  attack1:   { id: 'attack1',   name: '攻撃',     cost: 1,  effect: 'damage',  value: 3,  shopCost: 3,  emoji: '⚔️' },
  gold:      { id: 'gold',      name: 'ゴールド', cost: 1,  effect: 'gold',    value: 5,  shopCost: 3,  emoji: '🪙' },

  // ===== 攻撃カード =====
  attack2:   { id: 'attack2',   name: '強撃',     cost: 2,  effect: 'damage',  value: 7,  shopCost: 6,  emoji: '🗡️' },
  strike2:   { id: 'strike2',   name: '強撃Ⅱ',   cost: 2,  effect: 'damage',  value: 6,  shopCost: 4,  emoji: '⚔️' },
  combo:     { id: 'combo',     name: '連撃',     cost: 3,  effect: 'combo',   value: 4,  shopCost: 6,  emoji: '👊' },
  poison:    { id: 'poison',    name: '毒矢',     cost: 3,  effect: 'poison',  value: 4,  shopCost: 6,  emoji: '🏹' },
  greatsword:{ id: 'greatsword',name: '大剣',     cost: 4,  effect: 'damage',  value: 12, shopCost: 8,  emoji: '🗡️' },
  storm:     { id: 'storm',     name: '嵐',       cost: 5,  effect: 'storm',   value: 3,  shopCost: 10, emoji: '🌩️' },
  finisher:  { id: 'finisher',  name: '必殺剣',   cost: 7,  effect: 'damage',  value: 20, shopCost: 14, emoji: '💥' },
  phoenix:   { id: 'phoenix',   name: '不死鳥',   cost: 10, effect: 'phoenix', value: 15, healValue: 10, shopCost: 20, emoji: '🦅' },

  // ===== 防御・回復カード =====
  block1:    { id: 'block1',    name: '防御',     cost: 1,  effect: 'block',   value: 3,  shopCost: 2,  emoji: '🛡️' },
  defense1:  { id: 'defense1',  name: '盾',       cost: 1,  effect: 'block',   value: 5,  shopCost: 4,  emoji: '🛡️' },
  fortify:   { id: 'fortify',   name: '鉄壁',     cost: 3,  effect: 'block',   value: 8,  shopCost: 6,  emoji: '🏰' },
  reflect:   { id: 'reflect',   name: '反射',     cost: 3,  effect: 'reflect', value: 0,  shopCost: 6,  emoji: '🪞' },
  heal:      { id: 'heal',      name: '回復',     cost: 3,  effect: 'heal',    value: 8,  shopCost: 6,  emoji: '💊' },

  // ===== ドロー・ユーティリティカード =====
  draw1:     { id: 'draw1',     name: 'ドロー',   cost: 1,  effect: 'draw',    value: 2,  shopCost: 2,  emoji: '📚' },
  library:   { id: 'library',   name: '図書館',   cost: 2,  effect: 'draw',    value: 3,  shopCost: 4,  emoji: '📖' },
  copy:      { id: 'copy',      name: '複製',     cost: 3,  effect: 'copy',    value: 0,  shopCost: 6,  emoji: '♾️' },
  scry:      { id: 'scry',      name: '予知',     cost: 1,  effect: 'scry',    value: 0,  shopCost: 2,  emoji: '🔮' },

  // ===== ゴールドカード =====
  gold2:     { id: 'gold2',     name: '金塊',     cost: 2,  effect: 'gold',    value: 8,  shopCost: 4,  emoji: '💰' },
  invest:    { id: 'invest',    name: '投資',     cost: 3,  effect: 'invest',  value: 15, shopCost: 6,  emoji: '📈' },

  // ===== ⚔️ ウォリアー固有カード =====
  w_slash:     { id: 'w_slash',     name: '斬撃',       cost: 1,  effect: 'damage',    value: 4,  shopCost: 3,  emoji: '⚔️', job: 'warrior' },
  w_wall:      { id: 'w_wall',      name: '防壁',       cost: 1,  effect: 'block',     value: 5,  shopCost: 3,  emoji: '🧱', job: 'warrior' },
  w_smash:     { id: 'w_smash',     name: '強打',       cost: 2,  effect: 'damage',    value: 8,  shopCost: 6,  emoji: '🔨', job: 'warrior' },
  w_shieldbash:{ id: 'w_shieldbash',name: '盾撃',       cost: 2,  effect: 'shieldbash',value: 4,  blockValue: 4,  shopCost: 6,  emoji: '🛡️', job: 'warrior' },
  w_fortress:  { id: 'w_fortress',  name: '堅陣',       cost: 2,  effect: 'block',     value: 8,  shopCost: 6,  emoji: '🏰', job: 'warrior' },
  w_weaponup:  { id: 'w_weaponup',  name: '武器強化',   cost: 3,  effect: 'weaponup',  value: 8,  shopCost: 9,  emoji: '⬆️', job: 'warrior' },
  w_charge:    { id: 'w_charge',    name: '突進',       cost: 3,  effect: 'shieldbash',value: 10, blockValue: 3,  shopCost: 9,  emoji: '🐂', job: 'warrior' },
  w_dualwield: { id: 'w_dualwield', name: '二刀流',     cost: 3,  effect: 'combo',     value: 5,  shopCost: 9,  emoji: '⚔️', job: 'warrior' },
  w_counter:   { id: 'w_counter',   name: '反撃',       cost: 4,  effect: 'counter',   value: 8,  shopCost: 12, emoji: '🔄', job: 'warrior' },
  w_warfiend:  { id: 'w_warfiend',  name: '戦鬼',       cost: 4,  effect: 'warfiend',  value: 5,  blockValue: 3,  shopCost: 12, emoji: '👹', job: 'warrior' },
  w_earthcrush:{ id: 'w_earthcrush',name: '大地砕き',   cost: 5,  effect: 'damage',    value: 18, shopCost: 15, emoji: '💥', job: 'warrior' },
  w_rage:      { id: 'w_rage',      name: '激怒',       cost: 5,  effect: 'rage',      value: 2,  shopCost: 15, emoji: '😤', job: 'warrior' },
  w_warcry:    { id: 'w_warcry',    name: '覇気',       cost: 6,  effect: 'warcry',    value: 0,  shopCost: 18, emoji: '📯', job: 'warrior' },
  w_undying:   { id: 'w_undying',   name: '不屈',       cost: 6,  effect: 'undying',   value: 10, blockValue: 12, shopCost: 18, emoji: '💪', job: 'warrior' },
  w_ironwall:  { id: 'w_ironwall',  name: '鉄壁構え',   cost: 7,  effect: 'ironwall',  value: 20, shopCost: 21, emoji: '🗿', job: 'warrior' },
  w_allout:    { id: 'w_allout',    name: '渾身の一撃', cost: 8,  effect: 'damage',    value: 30, shopCost: 24, emoji: '💢', job: 'warrior' },
  w_godofwar:  { id: 'w_godofwar',  name: '【必殺】武神降臨', cost: 10, effect: 'godofwar', value: 10, blockValue: 20, shopCost: 30, emoji: '⚡', job: 'warrior' },

  // ===== 🔥 メイジ固有カード =====
  m_magicarrow:{ id: 'm_magicarrow',name: '魔法矢',     cost: 1,  effect: 'damage',    value: 4,  shopCost: 3,  emoji: '🏹', job: 'mage' },
  m_manafill:  { id: 'm_manafill',  name: '魔力充填',   cost: 1,  effect: 'manafill',  value: 3,  shopCost: 3,  emoji: '🔵', job: 'mage' },
  m_magicwall: { id: 'm_magicwall', name: '魔法障壁',   cost: 2,  effect: 'block',     value: 8,  shopCost: 6,  emoji: '🌀', job: 'mage' },
  m_amplify:   { id: 'm_amplify',   name: '魔力増幅',   cost: 2,  effect: 'amplify',   value: 0,  shopCost: 6,  emoji: '✨', job: 'mage' },
  m_chain:     { id: 'm_chain',     name: '連鎖魔法',   cost: 2,  effect: 'chain',     value: 3,  shopCost: 6,  emoji: '🔗', job: 'mage' },
  m_freeze:    { id: 'm_freeze',    name: '氷結',       cost: 3,  effect: 'freeze',    value: 5,  shopCost: 9,  emoji: '❄️', job: 'mage' },
  m_thunder:   { id: 'm_thunder',   name: '雷撃',       cost: 3,  effect: 'thunder',   value: 8,  drawValue: 2, shopCost: 9,  emoji: '⚡', job: 'mage' },
  m_fireball:  { id: 'm_fireball',  name: 'ファイアボール', cost: 4, effect: 'damage', value: 14, shopCost: 12, emoji: '🔥', job: 'mage' },
  m_recover:   { id: 'm_recover',   name: '魔力回収',   cost: 4,  effect: 'm_recover', value: 2,  shopCost: 12, emoji: '♻️', job: 'mage' },
  m_seal:      { id: 'm_seal',      name: '封印',       cost: 4,  effect: 'm_seal',    value: 0,  shopCost: 12, emoji: '🔒', job: 'mage' },
  m_copy:      { id: 'm_copy',      name: '魔法複製',   cost: 5,  effect: 'm_copy',    value: 0,  shopCost: 15, emoji: '📋', job: 'mage' },
  m_timewarp:  { id: 'm_timewarp',  name: '時空歪曲',   cost: 5,  effect: 'timewarp',  value: 2,  shopCost: 15, emoji: '⏳', job: 'mage' },
  m_explosion: { id: 'm_explosion', name: '魔力爆発',   cost: 6,  effect: 'explosion', value: 5,  shopCost: 18, emoji: '💣', job: 'mage' },
  m_drain:     { id: 'm_drain',     name: '吸魔',       cost: 7,  effect: 'm_drain',   value: 0,  shopCost: 21, emoji: '🌑', job: 'mage' },
  m_meteor:    { id: 'm_meteor',    name: '隕石',       cost: 8,  effect: 'damage',    value: 30, shopCost: 24, emoji: '☄️', job: 'mage' },
  m_bigmagic:  { id: 'm_bigmagic',  name: '大魔法',     cost: 8,  effect: 'bigmagic',  value: 6,  shopCost: 24, emoji: '🌟', job: 'mage' },
  m_collapse:  { id: 'm_collapse',  name: '【必殺】魔導崩壊', cost: 10, effect: 'collapse', value: 0.6, drawValue: 5, shopCost: 30, emoji: '🌌', job: 'mage' },

  // ===== ✨ プリースト固有カード =====
  p_heal:      { id: 'p_heal',      name: '癒し',       cost: 1,  effect: 'heal',      value: 5,  shopCost: 3,  emoji: '💚', job: 'priest' },
  p_holylight: { id: 'p_holylight', name: '聖光',       cost: 1,  effect: 'block',     value: 4,  shopCost: 3,  emoji: '☀️', job: 'priest' },
  p_prayer:    { id: 'p_prayer',    name: '祈り',       cost: 2,  effect: 'prayer',    value: 3,  turns: 3,     shopCost: 6,  emoji: '🙏', job: 'priest' },
  p_purify:    { id: 'p_purify',    name: '浄化',       cost: 2,  effect: 'purify',    value: 3,  shopCost: 6,  emoji: '🌸', job: 'priest' },
  p_devotion:  { id: 'p_devotion',  name: '献身',       cost: 2,  effect: 'devotion',  value: 6,  drawValue: 2, shopCost: 6,  emoji: '❤️', job: 'priest' },
  p_holyfire:  { id: 'p_holyfire',  name: '聖なる炎',   cost: 3,  effect: 'holyfire',  value: 8,  healValue: 4, shopCost: 9,  emoji: '🕯️', job: 'priest' },
  p_holyshield:{ id: 'p_holyshield',name: '聖盾',       cost: 3,  effect: 'holyshield',value: 10, healValue: 5, shopCost: 9,  emoji: '🛡️', job: 'priest' },
  p_confess:   { id: 'p_confess',   name: '懺悔',       cost: 3,  effect: 'confess',   value: 4,  shopCost: 9,  emoji: '📖', job: 'priest' },
  p_bless:     { id: 'p_bless',     name: '祝福',       cost: 4,  effect: 'bless',     value: 0,  shopCost: 12, emoji: '⭐', job: 'priest' },
  p_divineye:  { id: 'p_divineye',  name: '神の目',     cost: 4,  effect: 'divineye',  value: 2,  shopCost: 12, emoji: '👁️', job: 'priest' },
  p_holybeam:  { id: 'p_holybeam',  name: '聖なる光',   cost: 5,  effect: 'holybeam',  value: 8,  healValue: 15, shopCost: 15, emoji: '💫', job: 'priest' },
  p_judgment:  { id: 'p_judgment',  name: '天罰',       cost: 5,  effect: 'judgment',  value: 0,  shopCost: 15, emoji: '⚖️', job: 'priest' },
  p_sanctuary: { id: 'p_sanctuary', name: '聖域',       cost: 6,  effect: 'sanctuary', value: 8,  turns: 3,     shopCost: 18, emoji: '🏛️', job: 'priest' },
  p_protection:{ id: 'p_protection',name: '加護',       cost: 6,  effect: 'protection',value: 2,  shopCost: 18, emoji: '🔰', job: 'priest' },
  p_divine:    { id: 'p_divine',    name: '裁き',       cost: 7,  effect: 'divine',    value: 0.3, shopCost: 21, emoji: '✝️', job: 'priest' },
  p_resurrect: { id: 'p_resurrect', name: '復活',       cost: 8,  effect: 'heal',      value: 30, shopCost: 24, emoji: '🌅', job: 'priest' },
  p_holyjudge: { id: 'p_holyjudge', name: '【必殺】聖なる審判', cost: 10, effect: 'holyjudge', value: 20, shopCost: 30, emoji: '👼', job: 'priest' },

  // ===== 🗡️ ローグ固有カード =====
  r_dagger:    { id: 'r_dagger',    name: '短刀',       cost: 1,  effect: 'damage',    value: 4,  shopCost: 3,  emoji: '🗡️', job: 'rogue' },
  r_smoke:     { id: 'r_smoke',     name: '煙幕',       cost: 1,  effect: 'block',     value: 5,  shopCost: 3,  emoji: '💨', job: 'rogue' },
  r_shadowrun: { id: 'r_shadowrun', name: '影走り',     cost: 2,  effect: 'shadowrun', value: 2,  drawValue: 3, shopCost: 6,  emoji: '👤', job: 'rogue' },
  r_stealth:   { id: 'r_stealth',   name: '隠密',       cost: 2,  effect: 'stealth',   value: 0,  shopCost: 6,  emoji: '🌙', job: 'rogue' },
  r_poisonstar:{ id: 'r_poisonstar',name: '毒手裏剣',   cost: 2,  effect: 'poisonstar',value: 3,  poisonDmg: 2, poisonTurns: 2, shopCost: 6,  emoji: '🌟', job: 'rogue' },
  r_steal:     { id: 'r_steal',     name: 'スリ',       cost: 3,  effect: 'steal',     value: 5,  shopCost: 9,  emoji: '💸', job: 'rogue' },
  r_stab:      { id: 'r_stab',      name: '連刺し',     cost: 3,  effect: 'stab',      value: 2,  shopCost: 9,  emoji: '🔪', job: 'rogue' },
  r_distract:  { id: 'r_distract',  name: '陽動',       cost: 3,  effect: 'distract',  value: 1,  shopCost: 9,  emoji: '🎭', job: 'rogue' },
  r_mirage:    { id: 'r_mirage',    name: '残像',       cost: 4,  effect: 'mirage',    value: 4,  shopCost: 12, emoji: '🌫️', job: 'rogue' },
  r_illusion:  { id: 'r_illusion',  name: '幻影',       cost: 4,  effect: 'illusion',  value: 0,  shopCost: 12, emoji: '🪄', job: 'rogue' },
  r_backstab:  { id: 'r_backstab',  name: '背後奇襲',   cost: 5,  effect: 'backstab',  value: 15, bonusValue: 8, shopCost: 15, emoji: '🥷', job: 'rogue' },
  r_toxicsmoke:{ id: 'r_toxicsmoke',name: '毒煙幕',     cost: 5,  effect: 'toxicsmoke',value: 6,  poisonDmg: 3, poisonTurns: 3, shopCost: 15, emoji: '☁️', job: 'rogue' },
  r_doublesteal:{ id: 'r_doublesteal', name: '二重スリ',cost: 6,  effect: 'doublesteal',value: 8, drawValue: 3, shopCost: 18, emoji: '💰', job: 'rogue' },
  r_chaos:     { id: 'r_chaos',     name: '撹乱',       cost: 6,  effect: 'distract',  value: 2,  shopCost: 18, emoji: '🌪️', job: 'rogue' },
  r_shadowstrike:{ id: 'r_shadowstrike', name: '闇討ち',cost: 7,  effect: 'damage',    value: 25, shopCost: 21, emoji: '🌑', job: 'rogue' },
  r_vital:     { id: 'r_vital',     name: '急所突き',   cost: 8,  effect: 'vital',     value: 20, discardCount: 2, shopCost: 24, emoji: '💔', job: 'rogue' },
  r_dance:     { id: 'r_dance',     name: '【必殺】千影乱舞', cost: 10, effect: 'dance', value: 3, shopCost: 30, emoji: '💃', job: 'rogue' },

  // ===== 🔪 アサシン固有カード =====
  a_needle:    { id: 'a_needle',    name: '毒針',       cost: 1,  effect: 'poisoncard', value: 2,  poisonDmg: 1, poisonTurns: 3, shopCost: 3,  emoji: '🪡', job: 'assassin' },
  a_hide:      { id: 'a_hide',      name: '影隠れ',     cost: 1,  effect: 'block',     value: 5,  shopCost: 3,  emoji: '🌑', job: 'assassin' },
  a_corrosion: { id: 'a_corrosion', name: '腐食毒',     cost: 2,  effect: 'corrosion', poisonDmg: 2, poisonTurns: 2, shopCost: 6,  emoji: '🧪', job: 'assassin' },
  a_miasma:    { id: 'a_miasma',    name: '毒霧',       cost: 2,  effect: 'poisoncard', value: 0,  poisonDmg: 2, poisonTurns: 5, shopCost: 6,  emoji: '💀', job: 'assassin' },
  a_shadowbind:{ id: 'a_shadowbind',name: '影縫い',     cost: 2,  effect: 'shadowbind',value: 3,  shopCost: 6,  emoji: '🕸️', job: 'assassin' },
  a_venom:     { id: 'a_venom',     name: '猛毒',       cost: 3,  effect: 'poisoncard', value: 0,  poisonDmg: 4, poisonTurns: 4, shopCost: 9,  emoji: '☠️', job: 'assassin' },
  a_poisonblade:{ id: 'a_poisonblade', name: '毒刃',    cost: 3,  effect: 'poisoncard', value: 6,  poisonDmg: 3, poisonTurns: 3, shopCost: 9,  emoji: '🗡️', job: 'assassin' },
  a_darkpact:  { id: 'a_darkpact',  name: '闇の契約',   cost: 3,  effect: 'darkpact',  value: 8,  drawValue: 6, shopCost: 9,  emoji: '📜', job: 'assassin' },
  a_trap:      { id: 'a_trap',      name: '罠',         cost: 4,  effect: 'trap',      value: 3,  trapCount: 4, shopCost: 12, emoji: '⚙️', job: 'assassin' },
  a_powerup:   { id: 'a_powerup',   name: '毒強化',     cost: 4,  effect: 'powerup',   value: 0,  shopCost: 12, emoji: '⬆️', job: 'assassin' },
  a_poisonbomb:{ id: 'a_poisonbomb',name: '毒爆弾',     cost: 5,  effect: 'poisoncard', value: 0,  poisonDmg: 4, poisonTurns: 4, shopCost: 15, emoji: '💣', job: 'assassin' },
  a_shadowclone:{ id: 'a_shadowclone', name: '影分身',  cost: 5,  effect: 'shadowclone', value: 0, shopCost: 15, emoji: '👥', job: 'assassin' },
  a_swamp:     { id: 'a_swamp',     name: '毒沼',       cost: 6,  effect: 'poisoncard', value: 0,  poisonDmg: 6, poisonTurns: 5, shopCost: 18, emoji: '🌿', job: 'assassin' },
  a_assassinate:{ id: 'a_assassinate', name: '暗殺',    cost: 7,  effect: 'assassinate', value: 30, shopCost: 21, emoji: '🥷', job: 'assassin' },
  a_deadlyvenom:{ id: 'a_deadlyvenom', name: '絶命毒',  cost: 8,  effect: 'poisoncard', value: 0,  poisonDmg: 10, poisonTurns: 4, shopCost: 24, emoji: '💀', job: 'assassin' },
  a_ritual:    { id: 'a_ritual',    name: '暗黒の儀式', cost: 8,  effect: 'ritual',    value: 35, selfDmg: 15,  shopCost: 24, emoji: '🕯️', job: 'assassin' },
  a_spiral:    { id: 'a_spiral',    name: '【必殺】死の螺旋', cost: 10, effect: 'spiral', value: 0, poisonDmg: 15, poisonTurns: 5, shopCost: 30, emoji: '🌀', job: 'assassin' },

  // ===== 🛡️ ナイト固有カード =====
  // ブロック値の2/3を消費して攻撃するカードあり
  kn_shieldblow: { id: 'kn_shieldblow', name: '盾の一撃',     cost: 1,  effect: 'kn_shieldblow', bonus: 0,   shopCost: 3,  emoji: '🛡️', job: 'knight' },
  kn_guard:      { id: 'kn_guard',      name: '守護',         cost: 1,  effect: 'block',          value: 3,   shopCost: 3,  emoji: '🧱', job: 'knight' },
  kn_holyblow:   { id: 'kn_holyblow',   name: '聖盾突き',     cost: 2,  effect: 'kn_shieldblow',  bonus: 4,   shopCost: 6,  emoji: '✨', job: 'knight' },
  kn_ironwall:   { id: 'kn_ironwall',   name: '鉄壁',         cost: 2,  effect: 'block',          value: 7,   shopCost: 6,  emoji: '🏰', job: 'knight' },
  kn_shieldup:   { id: 'kn_shieldup',   name: '盾強化',       cost: 2,  effect: 'kn_shieldup',    mult: 1.5,  shopCost: 6,  emoji: '⬆️', job: 'knight' },
  kn_shieldheal: { id: 'kn_shieldheal', name: '盾回復',       cost: 3,  effect: 'holyshield',     value: 6,   healValue: 4, shopCost: 9,  emoji: '💚', job: 'knight' },
  kn_fortress:   { id: 'kn_fortress',   name: '要塞化',       cost: 3,  effect: 'block',          value: 10,  shopCost: 9,  emoji: '🏯', job: 'knight' },
  kn_holystrike: { id: 'kn_holystrike', name: '聖なる盾撃',   cost: 3,  effect: 'kn_shieldblow',  bonus: 8,   shopCost: 9,  emoji: '⚡', job: 'knight' },
  kn_ironcharge: { id: 'kn_ironcharge', name: '鉄壁突進',     cost: 4,  effect: 'kn_ironcharge',  shopCost: 12, emoji: '🐂', job: 'knight' },
  kn_immovable:  { id: 'kn_immovable',  name: '不動',         cost: 4,  effect: 'ironwall',       value: 14,  shopCost: 12, emoji: '🗿', job: 'knight' },
  kn_shieldstorm:{ id: 'kn_shieldstorm',name: '盾の嵐',       cost: 5,  effect: 'kn_shieldstorm', shopCost: 15, emoji: '🌪️', job: 'knight' },
  kn_holyup:     { id: 'kn_holyup',     name: '聖盾強化',     cost: 5,  effect: 'kn_shieldup',    mult: 2.0,  shopCost: 15, emoji: '🌟', job: 'knight' },
  kn_castle:     { id: 'kn_castle',     name: '城壁',         cost: 6,  effect: 'block',          value: 20,  shopCost: 18, emoji: '🏰', job: 'knight' },
  kn_shieldcrush:{ id: 'kn_shieldcrush',name: '盾砕き返し',   cost: 6,  effect: 'kn_shieldcrush', shopCost: 18, emoji: '💥', job: 'knight' },
  kn_perfectguard:{id: 'kn_perfectguard',name:'完全防御',      cost: 7,  effect: 'kn_perfectguard',shopCost: 21, emoji: '🔰', job: 'knight' },
  kn_holyshield: { id: 'kn_holyshield', name: '聖域の盾',     cost: 8,  effect: 'kn_holyshield',  value: 25,  blockPerTurn: 4, blockTurns: 3, shopCost: 24, emoji: '✝️', job: 'knight' },
  kn_godshield:  { id: 'kn_godshield',  name: '【必殺】神盾爆砕', cost: 10, effect: 'kn_godshield', bonus: 30, shopCost: 30, emoji: '☀️', job: 'knight' },

  // ===== 🎲 ギャンブラー固有カード =====
  // 各カードは50%（大穴狙いのみ20%）で成功・失敗が分かれる
  gb_cointoss:   { id: 'gb_cointoss',   name: 'コイントス',   cost: 1,  effect: 'gb_cointoss',   shopCost: 3,  emoji: '🪙', job: 'gambler' },
  gb_luckydraw:  { id: 'gb_luckydraw',  name: 'ラッキードロー',cost: 1, effect: 'gb_luckydraw',  shopCost: 3,  emoji: '🎴', job: 'gambler' },
  gb_bet:        { id: 'gb_bet',        name: '賭け',         cost: 2,  effect: 'gb_bet',        shopCost: 6,  emoji: '🎰', job: 'gambler' },
  gb_tripleup:   { id: 'gb_tripleup',   name: 'トリプルアップ',cost: 2, effect: 'gb_tripleup',   shopCost: 6,  emoji: '🃏', job: 'gambler' },
  gb_roulette:   { id: 'gb_roulette',   name: 'ルーレット',   cost: 2,  effect: 'gb_roulette',   shopCost: 6,  emoji: '🎡', job: 'gambler' },
  gb_highroller: { id: 'gb_highroller', name: 'ハイローラー', cost: 3,  effect: 'gb_highroller', shopCost: 9,  emoji: '🎲', job: 'gambler' },
  gb_goddess:    { id: 'gb_goddess',    name: '幸運の女神',   cost: 3,  effect: 'gb_goddess',    shopCost: 9,  emoji: '🌈', job: 'gambler' },
  gb_longshot:   { id: 'gb_longshot',   name: '大穴狙い',     cost: 3,  effect: 'gb_longshot',   shopCost: 9,  emoji: '🏹', job: 'gambler' },
  gb_casino:     { id: 'gb_casino',     name: 'カジノ',       cost: 4,  effect: 'gb_casino',     shopCost: 12, emoji: '🎰', job: 'gambler' },
  gb_slot:       { id: 'gb_slot',       name: 'スロット',     cost: 4,  effect: 'gb_slot',       shopCost: 12, emoji: '🎰', job: 'gambler' },
  gb_instinct:   { id: 'gb_instinct',   name: '博打師の直感', cost: 5,  effect: 'gb_instinct',   shopCost: 15, emoji: '💡', job: 'gambler' },
  gb_fate:       { id: 'gb_fate',       name: '運命の一手',   cost: 5,  effect: 'gb_fate',       shopCost: 15, emoji: '🌠', job: 'gambler' },
  gb_jackpot:    { id: 'gb_jackpot',    name: 'ジャックポット',cost: 6, effect: 'gb_jackpot',    shopCost: 18, emoji: '💎', job: 'gambler' },
  gb_combo:      { id: 'gb_combo',      name: '連続賭け',     cost: 6,  effect: 'gb_combo',      shopCost: 18, emoji: '🔗', job: 'gambler' },
  gb_mastery:    { id: 'gb_mastery',    name: '賭博師の奥義', cost: 7,  effect: 'gb_mastery',    shopCost: 21, emoji: '👁️', job: 'gambler' },
  gb_allin:      { id: 'gb_allin',      name: '全賭け',       cost: 8,  effect: 'gb_allin',      shopCost: 24, emoji: '💸', job: 'gambler' },
  gb_ultimate:   { id: 'gb_ultimate',   name: '【必殺】究極の賭け', cost: 10, effect: 'gb_ultimate', shopCost: 30, emoji: '⭐', job: 'gambler' },

  // ===== 🧪 アルケミスト固有カード =====
  // コインを消費して効果を発動。コイン入手カード3枚あり
  al_alchemy:    { id: 'al_alchemy',    name: '錬金術',       cost: 1,  effect: 'gold',          value: 10,  shopCost: 3,  emoji: '🧪', job: 'alchemist' },
  al_distill:    { id: 'al_distill',    name: '蒸留',         cost: 3,  effect: 'gold',          value: 30,  shopCost: 9,  emoji: '⚗️', job: 'alchemist' },
  al_sagestone:  { id: 'al_sagestone',  name: '賢者の錬金',   cost: 6,  effect: 'gold',          value: 60,  shopCost: 18, emoji: '💎', job: 'alchemist' },
  al_convert:    { id: 'al_convert',    name: '変換',         cost: 1,  effect: 'al_damage',     coinCost: 5,  value: 3,   shopCost: 3,  emoji: '🔄', job: 'alchemist' },
  al_refine:     { id: 'al_refine',     name: '精製爆発',     cost: 2,  effect: 'al_damage',     coinCost: 10, value: 8,   shopCost: 6,  emoji: '💣', job: 'alchemist' },
  al_catalyst:   { id: 'al_catalyst',   name: '触媒',         cost: 2,  effect: 'al_catalyst',   coinCost: 5,  shopCost: 6,  emoji: '✨', job: 'alchemist' },
  al_bomb:       { id: 'al_bomb',       name: '爆発薬',       cost: 3,  effect: 'al_damage',     coinCost: 15, value: 15,  shopCost: 9,  emoji: '💥', job: 'alchemist' },
  al_potion:     { id: 'al_potion',     name: '回復薬',       cost: 3,  effect: 'al_heal',       coinCost: 10, value: 10,  shopCost: 9,  emoji: '💊', job: 'alchemist' },
  al_armor:      { id: 'al_armor',      name: '強化薬',       cost: 3,  effect: 'al_block',      coinCost: 10, value: 15,  shopCost: 9,  emoji: '🛡️', job: 'alchemist' },
  al_synthesis:  { id: 'al_synthesis',  name: '大錬成',       cost: 4,  effect: 'al_damage',     coinCost: 20, value: 25,  shopCost: 12, emoji: '⚡', job: 'alchemist' },
  al_philstone:  { id: 'al_philstone',  name: '賢者の石',     cost: 4,  effect: 'al_combo',      coinCost: 15, value: 15,  blockValue: 10, shopCost: 12, emoji: '🌟', job: 'alchemist' },
  al_elixir:     { id: 'al_elixir',     name: '万能薬',       cost: 5,  effect: 'al_elixir',     coinCost: 20, value: 15,  blockValue: 10, healValue: 10, shopCost: 15, emoji: '🍶', job: 'alchemist' },
  al_transmute:  { id: 'al_transmute',  name: '変成',         cost: 5,  effect: 'al_damage',     coinCost: 25, value: 35,  shopCost: 15, emoji: '🔮', job: 'alchemist' },
  al_elemental:  { id: 'al_elemental',  name: '元素爆発',     cost: 6,  effect: 'al_damage',     coinCost: 30, value: 50,  shopCost: 18, emoji: '🌋', job: 'alchemist' },
  al_immortal:   { id: 'al_immortal',   name: '不死薬',       cost: 6,  effect: 'al_immortal',   coinCost: 20, healValue: 15, shopCost: 18, emoji: '🌿', job: 'alchemist' },
  al_magicraft:  { id: 'al_magicraft',  name: '魔導錬成',     cost: 7,  effect: 'al_magicraft',  coinCost: 35, shopCost: 21, emoji: '🔯', job: 'alchemist' },
  al_ultimate:   { id: 'al_ultimate',   name: '【必殺】哲学者の石', cost: 10, effect: 'al_ultimate', healValue: 20, shopCost: 30, emoji: '☄️', job: 'alchemist' },

  // ===== 👻 ネクロマンサー固有カード =====
  // 使用したカードはすべて墓地へ送られる。専用カードを使ったときのみ手札に戻せる
  nc_skeleton:   { id: 'nc_skeleton',   name: '骸骨召喚',     cost: 1,  effect: 'nc_revive',     value: 1,   shopCost: 3,  emoji: '💀', job: 'necromancer' },
  nc_claw:       { id: 'nc_claw',       name: '死霊の爪',     cost: 1,  effect: 'nc_claw',       value: 4,   bonus: 4,   threshold: 5, shopCost: 3,  emoji: '🦴', job: 'necromancer' },
  nc_graverobbery:{id:'nc_graverobbery',name: '墓荒らし',      cost: 2,  effect: 'nc_revive',     value: 2,   shopCost: 6,  emoji: '⛏️', job: 'necromancer' },
  nc_decay:      { id: 'nc_decay',      name: '腐敗',         cost: 2,  effect: 'nc_gravedmg',   mult: 1,    shopCost: 6,  emoji: '☠️', job: 'necromancer' },
  nc_lament:     { id: 'nc_lament',     name: '死者の嘆き',   cost: 2,  effect: 'nc_lament',     shopCost: 6,  emoji: '😢', job: 'necromancer' },
  nc_specterbuff:{ id: 'nc_specterbuff',name: '死霊強化',     cost: 3,  effect: 'nc_specterbuff',shopCost: 9,  emoji: '👻', job: 'necromancer' },
  nc_revive:     { id: 'nc_revive',     name: '蘇生',         cost: 3,  effect: 'nc_revive',     value: 3,   shopCost: 9,  emoji: '🌅', job: 'necromancer' },
  nc_chain:      { id: 'nc_chain',      name: '呪いの連鎖',   cost: 3,  effect: 'nc_gravedmg',   mult: 2,    shopCost: 9,  emoji: '⛓️', job: 'necromancer' },
  nc_army:       { id: 'nc_army',       name: '死者の軍勢',   cost: 4,  effect: 'nc_army',       shopCost: 12, emoji: '💪', job: 'necromancer' },
  nc_souleater:  { id: 'nc_souleater',  name: '魂喰い',       cost: 4,  effect: 'nc_souleater',  value: 20,  graveCost: 5, shopCost: 12, emoji: '🍖', job: 'necromancer' },
  nc_oath:       { id: 'nc_oath',       name: '不死の誓い',   cost: 5,  effect: 'nc_oath',       mult: 3,    healValue: 5, shopCost: 15, emoji: '📜', job: 'necromancer' },
  nc_explosion:  { id: 'nc_explosion',  name: '死霊爆発',     cost: 5,  effect: 'nc_explosion',  mult: 6,    shopCost: 15, emoji: '💣', job: 'necromancer' },
  nc_reincarnation:{id:'nc_reincarnation',name:'永遠の輪廻',   cost: 6,  effect: 'nc_reincarnation', shopCost: 18, emoji: '🔄', job: 'necromancer' },
  nc_king:       { id: 'nc_king',       name: '死者の王',     cost: 6,  effect: 'nc_king',       mult: 3,    shopCost: 18, emoji: '👑', job: 'necromancer' },
  nc_storm:      { id: 'nc_storm',      name: '魂の嵐',       cost: 7,  effect: 'nc_explosion',  mult: 8,    shopCost: 21, emoji: '🌩️', job: 'necromancer' },
  nc_release:    { id: 'nc_release',    name: '死霊解放',     cost: 8,  effect: 'nc_release',    blockMult: 3, shopCost: 24, emoji: '💫', job: 'necromancer' },
  nc_awakening:  { id: 'nc_awakening',  name: '【必殺】死者の覚醒', cost: 10, effect: 'nc_awakening', dmgMult: 15, blockMult: 5, shopCost: 30, emoji: '⚡', job: 'necromancer' },

  // ===== ⚡ モンク固有カード =====
  // 気力ゲージを消費して技を発動する
  mk_qigong:     { id: 'mk_qigong',     name: '気功',         cost: 0,  effect: 'mk_ki',         kiGain: 3,  shopCost: 3,  emoji: '🌀', job: 'monk' },
  mk_strike:     { id: 'mk_strike',     name: '連打',         cost: 0,  effect: 'mk_kidmg',      kiCost: 3,  value: 4,   shopCost: 3,  emoji: '👊', job: 'monk' },
  mk_meditate:   { id: 'mk_meditate',   name: '瞑想',         cost: 1,  effect: 'mk_meditate',   kiGain: 8,  drawValue: 2, shopCost: 3,  emoji: '🧘', job: 'monk' },
  mk_ironpunch:  { id: 'mk_ironpunch',  name: '鉄拳',         cost: 1,  effect: 'mk_kidmg',      kiCost: 5,  value: 8,   shopCost: 3,  emoji: '🥊', job: 'monk' },
  mk_airflow:    { id: 'mk_airflow',    name: '気流',         cost: 2,  effect: 'mk_ki',         kiGain: 12, shopCost: 6,  emoji: '🌬️', job: 'monk' },
  mk_palm:       { id: 'mk_palm',       name: '剛掌打',       cost: 2,  effect: 'mk_kidmg',      kiCost: 8,  value: 14,  shopCost: 6,  emoji: '🖐️', job: 'monk' },
  mk_shield:     { id: 'mk_shield',     name: '気盾',         cost: 2,  effect: 'mk_kiblock',    kiCost: 5,  value: 10,  shopCost: 6,  emoji: '🛡️', job: 'monk' },
  mk_burst:      { id: 'mk_burst',      name: '気功爆発',     cost: 3,  effect: 'mk_kidmg',      kiCost: 10, value: 20,  shopCost: 9,  emoji: '💥', job: 'monk' },
  mk_inner:      { id: 'mk_inner',      name: '内功',         cost: 3,  effect: 'mk_inner',      kiGain: 20, healValue: 5, shopCost: 9,  emoji: '💚', job: 'monk' },
  mk_storm:      { id: 'mk_storm',      name: '嵐の拳',       cost: 3,  effect: 'mk_storm',      kiCostPerHit: 3, value: 3, maxHits: 10, shopCost: 9,  emoji: '🌊', job: 'monk' },
  mk_release:    { id: 'mk_release',    name: '気力解放',     cost: 4,  effect: 'mk_release',    shopCost: 12, emoji: '⚡', job: 'monk' },
  mk_godspeed:   { id: 'mk_godspeed',   name: '神速',         cost: 4,  effect: 'mk_godspeed',   kiCost: 15, manaGain: 2, shopCost: 12, emoji: '🏃', job: 'monk' },
  mk_cannon:     { id: 'mk_cannon',     name: '気功砲',       cost: 5,  effect: 'mk_kidmg',      kiCost: 20, value: 35,  shopCost: 15, emoji: '💣', job: 'monk' },
  mk_mushin:     { id: 'mk_mushin',     name: '無我の境地',   cost: 5,  effect: 'mk_mushin',     kiGain: 30, shopCost: 15, emoji: '🌟', job: 'monk' },
  mk_dragon:     { id: 'mk_dragon',     name: '龍の拳',       cost: 6,  effect: 'mk_kidmg',      kiCost: 25, value: 50,  shopCost: 18, emoji: '🐉', job: 'monk' },
  mk_heaven:     { id: 'mk_heaven',     name: '天地気功',     cost: 8,  effect: 'mk_heaven',     shopCost: 24, emoji: '☀️', job: 'monk' },
  mk_mukyoku:    { id: 'mk_mukyoku',    name: '【必殺】無極', cost: 10, effect: 'mk_mukyoku',    shopCost: 30, emoji: '🌌', job: 'monk' },

  // ===== 🌑 カース固有カード =====
  // HPが低いほど効果が上がる。自傷しながら戦う
  cu_bloodcost:  { id: 'cu_bloodcost',  name: '血の代償',     cost: 1,  effect: 'cu_bloodcost',  selfDmg: 3,  value: 8,   shopCost: 3,  emoji: '🩸', job: 'curse' },
  cu_pain:       { id: 'cu_pain',       name: '苦痛',         cost: 1,  effect: 'cu_pain',       value: 6,   lowValue: 2, shopCost: 3,  emoji: '😖', job: 'curse' },
  cu_woundpower: { id: 'cu_woundpower', name: '傷の力',       cost: 2,  effect: 'cu_woundpower', mult: 0.5,  shopCost: 6,  emoji: '⚔️', job: 'curse' },
  cu_dyingrage:  { id: 'cu_dyingrage',  name: '瀕死の怒り',   cost: 2,  effect: 'cu_dyingrage',  value: 15,  lowValue: 4, shopCost: 6,  emoji: '😡', job: 'curse' },
  cu_selfbuff:   { id: 'cu_selfbuff',   name: '自傷強化',     cost: 2,  effect: 'cu_selfbuff',   selfDmg: 5, shopCost: 6,  emoji: '🔥', job: 'curse' },
  cu_bloodpact:  { id: 'cu_bloodpact',  name: '血の契約',     cost: 3,  effect: 'cu_bloodcost',  selfDmg: 10, value: 25, shopCost: 9,  emoji: '📜', job: 'curse' },
  cu_cursearmor: { id: 'cu_cursearmor', name: '呪いの鎧',     cost: 3,  effect: 'cu_cursearmor', selfDmg: 5,  blockValue: 20, shopCost: 9,  emoji: '🛡️', job: 'curse' },
  cu_abyss:      { id: 'cu_abyss',      name: '死の淵',       cost: 3,  effect: 'cu_abyss',      value: 30,  lowValue: 5, shopCost: 9,  emoji: '🕳️', job: 'curse' },
  cu_bind:       { id: 'cu_bind',       name: '呪縛',         cost: 4,  effect: 'cu_bloodcost',  selfDmg: 15, value: 40, shopCost: 12, emoji: '⛓️', job: 'curse' },
  cu_woundex:    { id: 'cu_woundex',    name: '傷の爆発',     cost: 4,  effect: 'cu_woundpower', mult: 1.0,  shopCost: 12, emoji: '💣', job: 'curse' },
  cu_undying:    { id: 'cu_undying',    name: '不死の呪い',   cost: 5,  effect: 'cu_undying',    shopCost: 15, emoji: '💜', job: 'curse' },
  cu_bloodstorm: { id: 'cu_bloodstorm', name: '血の嵐',       cost: 5,  effect: 'cu_bloodstorm', selfDmg: 20, value: 5, hits: 6, shopCost: 15, emoji: '🌊', job: 'curse' },
  cu_curserelease:{id:'cu_curserelease',name: '呪いの解放',   cost: 6,  effect: 'cu_curserelease',mult: 1.5, healValue: 10, shopCost: 18, emoji: '✨', job: 'curse' },
  cu_deathscythe:{ id: 'cu_deathscythe',name: '死神の鎌',     cost: 7,  effect: 'cu_deathscythe',value: 10,  shopCost: 21, emoji: '⚰️', job: 'curse' },
  cu_cursepeak:  { id: 'cu_cursepeak',  name: '呪いの極致',   cost: 7,  effect: 'cu_bloodcost',  selfDmg: 30, value: 60, shopCost: 21, emoji: '👁️', job: 'curse' },
  cu_ruination:  { id: 'cu_ruination',  name: '滅びの呪い',   cost: 8,  effect: 'cu_ruination',  mult: 3,    shopCost: 24, emoji: '💀', job: 'curse' },
  cu_demonking:  { id: 'cu_demonking',  name: '【必殺】魔王降臨', cost: 10, effect: 'cu_demonking', value: 100, shopCost: 30, emoji: '😈', job: 'curse' },

  // ===== 🤝 サモナー固有カード =====
  // トークン（使い捨てカード）を手札に追加して戦う
  sm_goblin:     { id: 'sm_goblin',     name: '小鬼召喚',     cost: 1,  effect: 'sm_summon',     tokenId: 'sm_tok_atk3',  tokenCount: 1, shopCost: 3,  emoji: '👺', job: 'summoner' },
  sm_spiritshield:{ id: 'sm_spiritshield', name: '盾の精霊',  cost: 1,  effect: 'sm_summon',     tokenId: 'sm_tok_blk5',  tokenCount: 1, shopCost: 3,  emoji: '🛡️', job: 'summoner' },
  sm_summonup:   { id: 'sm_summonup',   name: '召喚強化',     cost: 2,  effect: 'sm_summonup',   turns: 3,   shopCost: 6,  emoji: '⬆️', job: 'summoner' },
  sm_goblinlegion:{ id: 'sm_goblinlegion', name: 'ゴブリン軍団', cost: 2, effect: 'sm_summon',   tokenId: 'sm_tok_atk3',  tokenCount: 3, shopCost: 6,  emoji: '👺', job: 'summoner' },
  sm_healspirit: { id: 'sm_healspirit', name: '癒しの精霊',   cost: 2,  effect: 'sm_summon',     tokenId: 'sm_tok_heal5', tokenCount: 2, shopCost: 6,  emoji: '💚', job: 'summoner' },
  sm_ogre:       { id: 'sm_ogre',       name: 'オーガ召喚',   cost: 3,  effect: 'sm_summon',     tokenId: 'sm_tok_atk10', tokenCount: 1, shopCost: 9,  emoji: '👹', job: 'summoner' },
  sm_spiritguard:{ id: 'sm_spiritguard',name: '精霊の加護',   cost: 3,  effect: 'sm_summon',     tokenId: 'sm_tok_blk12', tokenCount: 1, shopCost: 9,  emoji: '✨', job: 'summoner' },
  sm_masssummon: { id: 'sm_masssummon', name: '大量召喚',     cost: 3,  effect: 'sm_summon',     tokenId: 'sm_tok_atk3',  tokenCount: 5, shopCost: 9,  emoji: '💪', job: 'summoner' },
  sm_dragon:     { id: 'sm_dragon',     name: 'ドラゴン召喚', cost: 4,  effect: 'sm_summon',     tokenId: 'sm_tok_atk20', tokenCount: 1, shopCost: 12, emoji: '🐉', job: 'summoner' },
  sm_sumstorm:   { id: 'sm_sumstorm',   name: '召喚の嵐',     cost: 4,  effect: 'sm_summon_now', tokenId: 'sm_tok_atk2',  tokenCount: 5, shopCost: 12, emoji: '🌪️', job: 'summoner' },
  sm_spiritking: { id: 'sm_spiritking', name: '精霊王',       cost: 5,  effect: 'sm_summon',     tokenId: 'sm_tok_combo15', tokenCount: 1, shopCost: 15, emoji: '👑', job: 'summoner' },
  sm_infinsum:   { id: 'sm_infinsum',   name: '無限召喚',     cost: 5,  effect: 'sm_infinsum',   tokenId: 'sm_tok_atk3',  tokenCount: 2, turns: 3, shopCost: 15, emoji: '♾️', job: 'summoner' },
  sm_archdemon:  { id: 'sm_archdemon',  name: '魔神召喚',     cost: 6,  effect: 'sm_summon',     tokenId: 'sm_tok_atk30', tokenCount: 1, shopCost: 18, emoji: '👿', job: 'summoner' },
  sm_sumexplosion:{ id: 'sm_sumexplosion', name: '召喚爆発',  cost: 6,  effect: 'sm_sumexplosion', value: 5,  shopCost: 18, emoji: '💥', job: 'summoner' },
  sm_legionrelease:{ id:'sm_legionrelease',name:'軍勢解放',    cost: 7,  effect: 'sm_legionrelease', shopCost: 21, emoji: '⚔️', job: 'summoner' },
  sm_godcall:    { id: 'sm_godcall',    name: '召喚神降臨',   cost: 8,  effect: 'sm_summon',     tokenId: 'sm_tok_atk50', tokenCount: 1, shopCost: 24, emoji: '🌟', job: 'summoner' },
  sm_ultimate:   { id: 'sm_ultimate',   name: '【必殺】万軍召喚', cost: 10, effect: 'sm_ultimate', tokenId: 'sm_tok_atk10_0', tokenCount: 10, shopCost: 30, emoji: '💢', job: 'summoner' },

  // ===== サモナー用トークンカード（ショップ非売品・使い捨て）=====
  sm_tok_atk3:   { id: 'sm_tok_atk3',   name: '召喚獣(弱)',   cost: 1,  effect: 'damage',  value: 3,  shopCost: 0, emoji: '👊', isToken: true },
  sm_tok_blk5:   { id: 'sm_tok_blk5',   name: '盾精霊',       cost: 1,  effect: 'block',   value: 5,  shopCost: 0, emoji: '🛡️', isToken: true },
  sm_tok_heal5:  { id: 'sm_tok_heal5',  name: '癒し精霊',     cost: 1,  effect: 'heal',    value: 5,  shopCost: 0, emoji: '💚', isToken: true },
  sm_tok_atk10:  { id: 'sm_tok_atk10',  name: '召喚獣(中)',   cost: 2,  effect: 'damage',  value: 10, shopCost: 0, emoji: '⚔️', isToken: true },
  sm_tok_blk12:  { id: 'sm_tok_blk12',  name: '護衛精霊',     cost: 2,  effect: 'block',   value: 12, shopCost: 0, emoji: '🛡️', isToken: true },
  sm_tok_atk20:  { id: 'sm_tok_atk20',  name: 'ドラゴン',     cost: 3,  effect: 'damage',  value: 20, shopCost: 0, emoji: '🐉', isToken: true },
  sm_tok_atk2:   { id: 'sm_tok_atk2',   name: '小精霊',       cost: 0,  effect: 'damage',  value: 2,  shopCost: 0, emoji: '✨', isToken: true },
  sm_tok_combo15:{ id: 'sm_tok_combo15',name: '精霊王',        cost: 3,  effect: 'shieldbash', value: 15, blockValue: 15, shopCost: 0, emoji: '⭐', isToken: true },
  sm_tok_atk30:  { id: 'sm_tok_atk30',  name: '魔神',         cost: 4,  effect: 'damage',  value: 30, shopCost: 0, emoji: '👿', isToken: true },
  sm_tok_atk50:  { id: 'sm_tok_atk50',  name: '召喚神',       cost: 5,  effect: 'damage',  value: 50, shopCost: 0, emoji: '🌟', isToken: true },
  sm_tok_atk10_0:{ id: 'sm_tok_atk10_0',name: '万軍兵士',     cost: 0,  effect: 'damage',  value: 10, shopCost: 0, emoji: '⚔️', isToken: true },
};

// 毒の1ターンあたりダメージ量
const POISON_DMG_PER_TURN = 2;
// 予知（scry）で提示するカード枚数
const SCRY_CARD_COUNT = 3;
// プレイヤーの最大HP
const CG_MAX_HP = 40;

// ショップに並ぶカードの共通プール（初期カードの attack1・gold は含めない）
const CG_SHOP_POOL = [
  'attack2', 'strike2', 'combo', 'poison', 'greatsword', 'storm', 'finisher', 'phoenix',
  'defense1', 'block1', 'fortify', 'reflect', 'heal',
  'draw1', 'library', 'copy', 'scry',
  'gold2', 'invest',
];

// ⚔️ ウォリアー固有カードのショッププール
const WARRIOR_POOL = [
  'w_slash', 'w_wall', 'w_smash', 'w_shieldbash', 'w_fortress',
  'w_weaponup', 'w_charge', 'w_dualwield', 'w_counter', 'w_warfiend',
  'w_earthcrush', 'w_rage', 'w_warcry', 'w_undying', 'w_ironwall',
  'w_allout', 'w_godofwar',
];

// 🔥 メイジ固有カードのショッププール
const MAGE_POOL = [
  'm_magicarrow', 'm_manafill', 'm_magicwall', 'm_amplify', 'm_chain',
  'm_freeze', 'm_thunder', 'm_fireball', 'm_recover', 'm_seal',
  'm_copy', 'm_timewarp', 'm_explosion', 'm_drain', 'm_meteor',
  'm_bigmagic', 'm_collapse',
];

// ✨ プリースト固有カードのショッププール
const PRIEST_POOL = [
  'p_heal', 'p_holylight', 'p_prayer', 'p_purify', 'p_devotion',
  'p_holyfire', 'p_holyshield', 'p_confess', 'p_bless', 'p_divineye',
  'p_holybeam', 'p_judgment', 'p_sanctuary', 'p_protection', 'p_divine',
  'p_resurrect', 'p_holyjudge',
];

// 🗡️ ローグ固有カードのショッププール
const ROGUE_POOL = [
  'r_dagger', 'r_smoke', 'r_shadowrun', 'r_stealth', 'r_poisonstar',
  'r_steal', 'r_stab', 'r_distract', 'r_mirage', 'r_illusion',
  'r_backstab', 'r_toxicsmoke', 'r_doublesteal', 'r_chaos', 'r_shadowstrike',
  'r_vital', 'r_dance',
];

// 🔪 アサシン固有カードのショッププール
const ASSASSIN_POOL = [
  'a_needle', 'a_hide', 'a_corrosion', 'a_miasma', 'a_shadowbind',
  'a_venom', 'a_poisonblade', 'a_darkpact', 'a_trap', 'a_powerup',
  'a_poisonbomb', 'a_shadowclone', 'a_swamp', 'a_assassinate', 'a_deadlyvenom',
  'a_ritual', 'a_spiral',
];

// 🛡️ ナイト固有カードのショッププール
const KNIGHT_POOL = [
  'kn_shieldblow', 'kn_guard', 'kn_holyblow', 'kn_ironwall', 'kn_shieldup',
  'kn_shieldheal', 'kn_fortress', 'kn_holystrike', 'kn_ironcharge', 'kn_immovable',
  'kn_shieldstorm', 'kn_holyup', 'kn_castle', 'kn_shieldcrush', 'kn_perfectguard',
  'kn_holyshield', 'kn_godshield',
];

// 🎲 ギャンブラー固有カードのショッププール
const GAMBLER_POOL = [
  'gb_cointoss', 'gb_luckydraw', 'gb_bet', 'gb_tripleup', 'gb_roulette',
  'gb_highroller', 'gb_goddess', 'gb_longshot', 'gb_casino', 'gb_slot',
  'gb_instinct', 'gb_fate', 'gb_jackpot', 'gb_combo', 'gb_mastery',
  'gb_allin', 'gb_ultimate',
];

// 🧪 アルケミスト固有カードのショッププール
const ALCHEMIST_POOL = [
  'al_alchemy', 'al_distill', 'al_sagestone', 'al_convert', 'al_refine',
  'al_catalyst', 'al_bomb', 'al_potion', 'al_armor', 'al_synthesis',
  'al_philstone', 'al_elixir', 'al_transmute', 'al_elemental', 'al_immortal',
  'al_magicraft', 'al_ultimate',
];

// 👻 ネクロマンサー固有カードのショッププール
const NECROMANCER_POOL = [
  'nc_skeleton', 'nc_claw', 'nc_graverobbery', 'nc_decay', 'nc_lament',
  'nc_specterbuff', 'nc_revive', 'nc_chain', 'nc_army', 'nc_souleater',
  'nc_oath', 'nc_explosion', 'nc_reincarnation', 'nc_king', 'nc_storm',
  'nc_release', 'nc_awakening',
];

// ⚡ モンク固有カードのショッププール
const MONK_POOL = [
  'mk_qigong', 'mk_strike', 'mk_meditate', 'mk_ironpunch', 'mk_airflow',
  'mk_palm', 'mk_shield', 'mk_burst', 'mk_inner', 'mk_storm',
  'mk_release', 'mk_godspeed', 'mk_cannon', 'mk_mushin', 'mk_dragon',
  'mk_heaven', 'mk_mukyoku',
];

// 🌑 カース固有カードのショッププール
const CURSE_POOL = [
  'cu_bloodcost', 'cu_pain', 'cu_woundpower', 'cu_dyingrage', 'cu_selfbuff',
  'cu_bloodpact', 'cu_cursearmor', 'cu_abyss', 'cu_bind', 'cu_woundex',
  'cu_undying', 'cu_bloodstorm', 'cu_curserelease', 'cu_deathscythe', 'cu_cursepeak',
  'cu_ruination', 'cu_demonking',
];

// 🤝 サモナー固有カードのショッププール
const SUMMONER_POOL = [
  'sm_goblin', 'sm_spiritshield', 'sm_summonup', 'sm_goblinlegion', 'sm_healspirit',
  'sm_ogre', 'sm_spiritguard', 'sm_masssummon', 'sm_dragon', 'sm_sumstorm',
  'sm_spiritking', 'sm_infinsum', 'sm_archdemon', 'sm_sumexplosion', 'sm_legionrelease',
  'sm_godcall', 'sm_ultimate',
];

// 職業名からプールを返すマップ
const JOB_POOLS = {
  warrior:     WARRIOR_POOL,
  mage:        MAGE_POOL,
  priest:      PRIEST_POOL,
  rogue:       ROGUE_POOL,
  assassin:    ASSASSIN_POOL,
  knight:      KNIGHT_POOL,
  gambler:     GAMBLER_POOL,
  alchemist:   ALCHEMIST_POOL,
  necromancer: NECROMANCER_POOL,
  monk:        MONK_POOL,
  curse:       CURSE_POOL,
  summoner:    SUMMONER_POOL,
};

// 初期デッキ構成（攻撃×4・ゴールド×6）
const CG_INITIAL_DECK = [
  'attack1', 'attack1', 'attack1', 'attack1',
  'gold', 'gold', 'gold', 'gold', 'gold', 'gold',
];

// ===== カードゲーム用ルーム管理 =====

// カードゲームルーム情報を保持するマップ
const cgRooms = new Map();

// カードゲーム用ソケットごとの所属ルーム情報を保持するマップ
const cgSocketMeta = new Map();

// カードゲーム用待機中ルームIDを保持する
let cgWaitingRoomId = null;

// 配列をFisher-Yatesアルゴリズムでシャッフルする関数
function cgShuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ショップに並べる3枚のカードをランダムに生成する関数（職業プール優先）
function generateCGShop(job) {
  // 職業固有プール(2枚) + 共通プール(1枚) を混ぜて提示する
  const jobPool = JOB_POOLS[job] || [];
  const jobCards = jobPool.length > 0 ? cgShuffle([...jobPool]).slice(0, 2) : [];
  const commonCards = cgShuffle([...CG_SHOP_POOL]).slice(0, 3 - jobCards.length);
  return cgShuffle([...jobCards, ...commonCards]);
}

// ゲーム初期状態を生成する関数
function initCGGameState() {
  const deck0 = cgShuffle([...CG_INITIAL_DECK]);
  const deck1 = cgShuffle([...CG_INITIAL_DECK]);
  return {
    hp: [CG_MAX_HP, CG_MAX_HP],
    block: [0, 0],
    mana: [0, 0],
    maxMana: [0, 0],
    gold: [0, 0],
    deck: [deck0, deck1],
    hand: [[], []],
    discard: [[], []],
    field: [[], []],
    activePlayer: 0,
    phase: 'play',
    shop: [],
    // カード削除回数（プレイヤーごと）
    trashCount: [0, 0],
    // 現在の削除コスト（初回5コイン、削除するたびに5コイン増加）
    trashCost: [5, 5],
    // 毒スタック（各スタックは {dmg, turns} - 毎ターン開始時にダメージを与えターンを減らす）
    poisonStacks: [[], []],
    // ターン開始時回復スタック（prayer/sanctuaryなど - 各スタックは {amount, turns}）
    healPerTurn: [[], []],
    // 次ターン開始時に加算されるゴールド（invest の効果）
    pendingGold: [0, 0],
    // 反射フラグ（受けたダメージの半分を返す）
    reflect: [false, false],
    // コピーフラグ（次に使用するカードを2回発動する）
    copyNext: [false, false],
    // 予知（scry）選択待ちカードリスト
    scryCards: [null, null],
    // 職業情報
    jobs: ['', ''],
    // ウォリアー武器強化バフ（次の攻撃カードに追加ダメージ）
    weaponUp: [0, 0],
    // メイジ魔力増幅バフ（次のカードのダメージを2倍にする）
    amplify: [false, false],
    // プリースト祝福バフ（次のカードの効果を2倍にする）
    bless: [false, false],
    // ローグ隠密バフ（次のカードのコストを0にする）
    stealth: [false, false],
    // 次のターン追加で得るマナ量（正でマナ増加・負でマナ減少）
    manaBonusNextTurn: [0, 0],
    // プリースト加護（次にN回受けるダメージを無効化）
    protection: [0, 0],
    // アサシン罠（相手がカードを使うたびにダメージ - 残りトリガー数）
    trapTriggers: [0, 0],
    // ウォリアー鉄壁構え（次のターンも継続するブロック値）
    persistBlock: [0, 0],
    // メイジ封印（封印されたカードID - 相手の手札で1枚使用不能）
    sealedCardId: [null, null],
    // このターンに使用した毒カードのリスト（アサシン影分身用）
    poisonCardsThisTurn: [[], []],
    // 累計受けたダメージ（ウォリアー激怒用）
    totalDamageTaken: [0, 0],
    // ナイト：完全防御フラグ（次に受けるダメージをすべてブロックに変換する）
    perfectGuard: [false, false],
    // ナイト：毎ターン開始時に加算されるブロック値（聖域の盾など）
    blockPerTurn: [[], []],
    // ギャンブラー：次のギャンブルカードを必ず成功させるフラグ
    gamblerSureSuccess: [false, false],
    // ギャンブラー：次のカードの効果が不発になるフラグ（トリプルアップ失敗時）
    gamblerSureMiss: [false, false],
    // ギャンブラー：次のカードの効果を3倍にするフラグ（トリプルアップ成功時）
    gamblerTriple: [false, false],
    // ギャンブラー：次のターンをスキップするフラグ（賭博師の奥義使用時）
    skipNextTurn: [false, false],
    // モンク：気力ゲージ（気力は毎ターン持続する）
    ki: [0, 0],
    // ネクロマンサー：墓地（使用したカードが送られる）
    grave: [[], []],
    // ネクロマンサー：死霊強化バフ（次に使うカードの効果倍率）
    specterBuff: [0, 0],
    // アルケミスト：不死薬フラグ（次に受けるダメージを無効化する）
    alImmortal: [false, false],
    // カース：不死の呪いフラグ（このターン致死ダメージを受けてもHP1で耐える）
    undyingGuard: [false, false],
    // カース：自傷強化フラグ（次のカードの効果を3倍にする）
    curseSelfBuff: [false, false],
    // サモナー：次のターン開始時に手札に追加するトークンのリスト
    pendingTokens: [[], []],
    // サモナー：毎ターン開始時に手札に追加する定期トークンのリスト
    recurringTokens: [[], []],
    // サモナー：召喚強化バフ（残りターン数。>0ならトークン効果2倍）
    summonBuff: [0, 0],
  };
}

// プレイヤーにカードを引かせる関数（デッキが空の場合は捨て札をシャッフルして補充する）
function cgDrawCards(state, playerIndex, count) {
  for (let i = 0; i < count; i++) {
    if (state.deck[playerIndex].length === 0) {
      if (state.discard[playerIndex].length === 0) break;
      state.deck[playerIndex] = cgShuffle(state.discard[playerIndex]);
      state.discard[playerIndex] = [];
    }
    if (state.deck[playerIndex].length > 0) {
      state.hand[playerIndex].push(state.deck[playerIndex].pop());
    }
  }
}

// ターン開始処理（マナ補充・フィールドリセット・5枚ドロー）
// ターン開始時の処理（マナをリセットし手札を補充する）
function cgStartTurn(state, playerIndex) {
  state.maxMana[playerIndex] = Math.min(state.maxMana[playerIndex] + 1, 10);
  state.mana[playerIndex] = state.maxMana[playerIndex];
  state.field[playerIndex] = [];
  // このターンの毒カード使用履歴をリセットする
  state.poisonCardsThisTurn[playerIndex] = [];

  // 鉄壁構えの持続ブロックを付与する
  if (state.persistBlock[playerIndex] > 0) {
    state.block[playerIndex] += state.persistBlock[playerIndex];
    state.persistBlock[playerIndex] = 0;
  }

  // ナイト：毎ターンブロック付与スタックを処理する
  if (state.blockPerTurn && state.blockPerTurn[playerIndex].length > 0) {
    const remaining = [];
    for (const entry of state.blockPerTurn[playerIndex]) {
      state.block[playerIndex] += entry.amount;
      if (entry.turns > 1) remaining.push({ amount: entry.amount, turns: entry.turns - 1 });
    }
    state.blockPerTurn[playerIndex] = remaining;
  }

  // サモナー：召喚強化バフのターン数を減らす
  if (state.summonBuff && state.summonBuff[playerIndex] > 0) {
    state.summonBuff[playerIndex] -= 1;
  }

  // サモナー：次のターン追加トークンを手札に加える
  if (state.pendingTokens && state.pendingTokens[playerIndex].length > 0) {
    for (const { tokenId, count } of state.pendingTokens[playerIndex]) {
      for (let i = 0; i < count; i++) {
        state.hand[playerIndex].push(tokenId);
      }
    }
    state.pendingTokens[playerIndex] = [];
  }

  // サモナー：定期トークン（sm_infinsum）を手札に加える
  if (state.recurringTokens && state.recurringTokens[playerIndex].length > 0) {
    const remaining = [];
    for (const entry of state.recurringTokens[playerIndex]) {
      for (let i = 0; i < entry.count; i++) {
        state.hand[playerIndex].push(entry.tokenId);
      }
      if (entry.turns > 1) remaining.push({ ...entry, turns: entry.turns - 1 });
    }
    state.recurringTokens[playerIndex] = remaining;
  }

  // 毒スタックのダメージを処理する（各スタックのdmgを与え、ターンを1減らす）
  const activeStacks = [];
  let totalPoisonDmg = 0;
  for (const stack of state.poisonStacks[playerIndex]) {
    totalPoisonDmg += stack.dmg;
    if (stack.turns > 1) {
      activeStacks.push({ dmg: stack.dmg, turns: stack.turns - 1 });
    }
  }
  state.poisonStacks[playerIndex] = activeStacks;
  if (totalPoisonDmg > 0) {
    const absorbed = Math.min(state.block[playerIndex], totalPoisonDmg);
    state.block[playerIndex] = Math.max(0, state.block[playerIndex] - absorbed);
    const actualPoisonDmg = totalPoisonDmg - absorbed;
    state.hp[playerIndex] = Math.max(0, state.hp[playerIndex] - actualPoisonDmg);
    state.totalDamageTaken[playerIndex] += actualPoisonDmg;
  }

  // ターン開始時の回復スタックを処理する（prayer/sanctuaryなど）
  const activeHeals = [];
  for (const stack of state.healPerTurn[playerIndex]) {
    state.hp[playerIndex] = Math.min(CG_MAX_HP, state.hp[playerIndex] + stack.amount);
    if (stack.turns > 1) {
      activeHeals.push({ amount: stack.amount, turns: stack.turns - 1 });
    }
  }
  state.healPerTurn[playerIndex] = activeHeals;

  // 前ターンに invest で積み立てたゴールドを加算する
  if (state.pendingGold[playerIndex] > 0) {
    state.gold[playerIndex] += state.pendingGold[playerIndex];
    state.pendingGold[playerIndex] = 0;
  }

  // 追加マナボーナスを処理する（マナ充填や影縫いなど）
  if (state.manaBonusNextTurn[playerIndex] !== 0) {
    state.mana[playerIndex] = Math.max(0, state.mana[playerIndex] + state.manaBonusNextTurn[playerIndex]);
    state.manaBonusNextTurn[playerIndex] = 0;
  }

  // 封印は1ターンのみ有効なのでリセットする
  state.sealedCardId[playerIndex] = null;

  cgDrawCards(state, playerIndex, 5);
}

// カードゲーム用ルームIDを生成する関数
function createCGRoomId() {
  return `cg-${Math.random().toString(36).slice(2, 10)}`;
}

// 新しいカードゲームルームを作成する関数
function createCGRoom() {
  const roomId = createCGRoomId();
  const room = {
    id: roomId,
    players: [],
    playerNames: {},
    started: false,
    resultSent: false,
    state: null,
  };
  cgRooms.set(roomId, room);
  cgWaitingRoomId = roomId;
  return room;
}

// 参加可能なカードゲームルームを取得する関数
function getJoinableCGRoom() {
  if (!cgWaitingRoomId) return createCGRoom();
  const room = cgRooms.get(cgWaitingRoomId);
  if (!room || room.players.length >= 2) return createCGRoom();
  return room;
}

// カードゲームの状態を各プレイヤーへ送信する関数（相手の手札は枚数のみ開示する）
function sendCGState(room) {
  const state = room.state;
  room.players.forEach((socketId, index) => {
    const opp = 1 - index;
    // 自分のショップフェーズのときはデッキ・捨て札の中身もカード削除UIのために送る
    const isMyShopTurn = state.phase === 'shop' && state.activePlayer === index;
    // 毒の合計ダメージ/ターンを計算して送る
    const myPoisonDmgPerTurn = state.poisonStacks[index].reduce((s, st) => s + st.dmg, 0);
    const oppPoisonDmgPerTurn = state.poisonStacks[opp].reduce((s, st) => s + st.dmg, 0);
    io.to(socketId).emit('cgStateUpdate', {
      myHp: state.hp[index],
      myBlock: state.block[index],
      myMana: state.mana[index],
      myMaxMana: state.maxMana[index],
      myGold: state.gold[index],
      myHand: state.hand[index],
      myDeckCount: state.deck[index].length,
      myDiscardCount: state.discard[index].length,
      myField: state.field[index],
      oppHp: state.hp[opp],
      oppBlock: state.block[opp],
      oppHandCount: state.hand[opp].length,
      oppDeckCount: state.deck[opp].length,
      oppDiscardCount: state.discard[opp].length,
      oppField: state.field[opp],
      activePlayer: state.activePlayer + 1,
      myPlayerNumber: index + 1,
      phase: state.phase,
      // ショップフェーズかつ自分のターンのときだけショップ情報を送る
      shop: isMyShopTurn ? state.shop : [],
      // 現在の削除コスト
      myTrashCost: state.trashCost[index],
      // 累積削除回数
      myTrashCount: state.trashCount[index],
      // カード削除モーダル用にデッキ・捨て札の中身を送る（自分のショップフェーズのみ）
      myDeckCards: isMyShopTurn ? [...state.deck[index]] : null,
      myDiscardCards: isMyShopTurn ? [...state.discard[index]] : null,
      // 職業情報
      myJob: state.jobs[index],
      oppJob: state.jobs[opp],
      // 毒ダメージ/ターン
      myPoisonDmgPerTurn,
      oppPoisonDmgPerTurn,
      // バフ状態
      myWeaponUp: state.weaponUp[index],
      myAmplify: state.amplify[index],
      myBless: state.bless[index],
      myStealth: state.stealth[index],
      myProtection: state.protection[index],
      myTrapTriggers: state.trapTriggers[index],
      // 封印されているカードID（相手から封印されている場合）
      mySealedCardId: state.sealedCardId[index],
      // モンク気力
      myKi: state.ki ? state.ki[index] : 0,
      // ネクロマンサー墓地（ショップフェーズのときのみ中身を送る）
      myGraveCount: state.grave ? state.grave[index].length : 0,
      myGraveCards: (isMyShopTurn && state.grave) ? [...state.grave[index]] : null,
      // ネクロマンサー死霊強化バフ
      mySpecterBuff: state.specterBuff ? state.specterBuff[index] : 0,
    });
  });
}

// カードゲームルームへプレイヤーを参加させる関数
function joinCGRoom(socket, playerName, job) {
  const room = getJoinableCGRoom();
  room.players.push(socket.id);
  room.playerNames[socket.id] = playerName;
  // 職業情報をルームに保存する
  if (!room.playerJobs) room.playerJobs = {};
  room.playerJobs[socket.id] = job || '';
  socket.join(room.id);

  const playerNumber = room.players.length;
  cgSocketMeta.set(socket.id, { roomId: room.id, playerNumber });

  if (room.players.length >= 2) {
    room.started = true;
    cgWaitingRoomId = null;

    // ゲーム初期状態を生成し職業を設定して先攻のターンを開始する
    room.state = initCGGameState();
    room.state.jobs[0] = room.playerJobs[room.players[0]] || '';
    room.state.jobs[1] = room.playerJobs[room.players[1]] || '';
    cgStartTurn(room.state, 0);

    room.players.forEach((socketId, index) => {
      const opponentId = room.players[1 - index];
      const myName = room.playerNames[socketId] || `プレイヤー${index + 1}`;
      const opponentName = room.playerNames[opponentId] || `プレイヤー${2 - index}`;
      io.to(socketId).emit('cgMatchStart', {
        roomId: room.id,
        playerNumber: index + 1,
        myName,
        opponentName,
        myJob: room.state.jobs[index],
        opponentJob: room.state.jobs[1 - index],
      });
    });

    sendCGState(room);
  } else {
    // 1人目は待機状態を通知する
    io.to(socket.id).emit('cgWaiting', { roomId: room.id, playerNumber: 1 });
  }
}

// カードゲームルームからプレイヤーを退出させる共通処理関数
function leaveCGRoom(socket) {
  const meta = cgSocketMeta.get(socket.id);
  if (!meta) return;

  const room = cgRooms.get(meta.roomId);
  cgSocketMeta.delete(socket.id);

  if (!room) {
    if (cgWaitingRoomId === meta.roomId) cgWaitingRoomId = null;
    return;
  }

  room.players = room.players.filter((id) => id !== socket.id);
  delete room.playerNames[socket.id];

  if (room.players.length === 0) {
    cgRooms.delete(room.id);
    if (cgWaitingRoomId === room.id) cgWaitingRoomId = null;
    return;
  }

  // 勝敗確定済みの場合は切断通知を送らない
  if (room.resultSent) return;

  room.resultSent = true;

  // 残ったプレイヤーに相手切断による勝利を通知する
  room.players.forEach((socketId) => {
    io.to(socketId).emit('cgOpponentLeft', { roomId: room.id });
    io.to(socketId).emit('cgResult', { win: true });
  });
}

// ===== タイピングバトル用ルーム管理 =====

// タイピングバトル用ルーム情報を保持するマップ
const typingRooms = new Map();

// タイピングバトル用ソケットごとの所属ルーム情報を保持するマップ
const typingSocketMeta = new Map();

// タイピングバトル用待機中ルームIDを保持する
let typingWaitingRoomId = null;

// タイピングバトルで使用する長文テキストリスト（text: 表示用, reading: タイピング用ローマ字,
//   tokens: [[表示文字列, かな読み|null], ...] ルビ表示用トークン列）
const TYPING_TEXTS = [
  {
    text: "吾輩は猫である。名前はまだない。どこで生れたかとんと見当がつかぬ。何でも薄暗いじめじめした所でニャーニャー泣いていた事だけは記憶している。",
    reading: "wagahaihanekodearu.namaehamadanai.dokodeumaretakatontokentougatsukanu.nandemousuguraijimejimeshitatokorodenyaanyaanaiteitakotodakehakiokushiteiru.",
    tokens: [
      ["吾輩","わがはい"],["は",null],["猫","ねこ"],["で",null],["ある",null],["。",null],
      ["名前","なまえ"],["は",null],["まだ",null],["ない",null],["。",null],
      ["どこで",null],["生れた","うまれた"],["か",null],["とんと",null],["見当","けんとう"],["が",null],["つかぬ",null],["。",null],
      ["何","なん"],["でも",null],["薄暗い","うすぐらい"],["じめじめした",null],["所","ところ"],["で",null],["ニャーニャー",null],["泣いていた","ないていた"],["事","こと"],["だけは",null],["記憶","きおく"],["している",null],["。",null],
    ],
  },
  {
    text: "国境の長いトンネルを抜けると雪国であった。夜の底が白くなった。信号所に汽車が止まった。向側の座席から娘が立って来て、島村の前のガラス窓を落とした。",
    reading: "kokkyounonagaitonneruwonukerutoyukigunideatta.yorunosokogashirokunatta.shingoujonikishagatomatta.mukougawanozasekikaramusumegatattekite,shimamuranomaenogarasumadowootoshita.",
    tokens: [
      ["国境","こっきょう"],["の",null],["長い","ながい"],["トンネル",null],["を",null],["抜ける","ぬける"],["と",null],["雪国","ゆきぐに"],["で",null],["あった",null],["。",null],
      ["夜","よる"],["の",null],["底","そこ"],["が",null],["白く","しろく"],["なった",null],["。",null],
      ["信号所","しんごうじょ"],["に",null],["汽車","きしゃ"],["が",null],["止まった","とまった"],["。",null],
      ["向側","むこうがわ"],["の",null],["座席","ざせき"],["から",null],["娘","むすめ"],["が",null],["立って","たって"],["来て","きて"],["、",null],["島村","しまむら"],["の",null],["前","まえ"],["の",null],["ガラス",null],["窓","まど"],["を",null],["落とした","おとした"],["。",null],
    ],
  },
  {
    text: "山路を登りながら、こう考えた。智に働けば角が立つ。情に棹させば流される。意地を通せば窮屈だ。とかくに人の世は住みにくい。",
    reading: "yamajiwonoborinagara,koukangaeta.chinihatarakebakadogatatsu.jounisaosasebanagasareru.ijiwotoosebakyuukutsuda.tokakunihitonoyohasuminikui.",
    tokens: [
      ["山路","やまじ"],["を",null],["登り","のぼり"],["ながら",null],["、",null],["こう",null],["考えた","かんがえた"],["。",null],
      ["智","ち"],["に",null],["働けば","はたらけば"],["角","かど"],["が",null],["立つ","たつ"],["。",null],
      ["情","じょう"],["に",null],["棹させば","さおさせば"],["流される","ながされる"],["。",null],
      ["意地","いじ"],["を",null],["通せば","とおせば"],["窮屈","きゅうくつ"],["だ",null],["。",null],
      ["とかくに",null],["人","ひと"],["の",null],["世","よ"],["は",null],["住みにくい","すみにくい"],["。",null],
    ],
  },
  {
    text: "メロスは激怒した。必ず、かの邪智暴虐の王を除かなければならぬと決意した。メロスには政治がわからぬ。メロスは、村の牧人である。",
    reading: "merosuhagekidoshita.kanarazu,kanojachibougyakunoouwonozokanakerebanaranutoketsuishita.merosunihaseijigawakaranu.merosuha,muranobokujindearu.",
    tokens: [
      ["メロス",null],["は",null],["激怒","げきど"],["した",null],["。",null],
      ["必ず","かならず"],["、",null],["かの",null],["邪智暴虐","じゃちぼうぎゃく"],["の",null],["王","おう"],["を",null],["除かなければ","のぞかなければ"],["ならぬ",null],["と",null],["決意","けつい"],["した",null],["。",null],
      ["メロス",null],["には",null],["政治","せいじ"],["が",null],["わからぬ",null],["。",null],
      ["メロス",null],["は",null],["、",null],["村","むら"],["の",null],["牧人","ぼくじん"],["で",null],["ある",null],["。",null],
    ],
  },
  {
    text: "親譲りの無鉄砲で子供の時から損ばかりしている。小学校にいる時分学校の二階から飛び降りて一週間ほど腰を抜かした事がある。",
    reading: "oyayuzurinomuteppoudekodomonotokikarasonbakarishiteiru.shougakkouniirujibungakkounonikaikaratobioriteisshuukanhodokoshiwonukashitakotogaaru.",
    tokens: [
      ["親譲り","おやゆずり"],["の",null],["無鉄砲","むてっぽう"],["で",null],["子供","こども"],["の",null],["時","とき"],["から",null],["損","そん"],["ばかりしている",null],["。",null],
      ["小学校","しょうがっこう"],["に",null],["いる",null],["時分","じぶん"],["学校","がっこう"],["の",null],["二階","にかい"],["から",null],["飛び降りて","とびおりて"],["一週間","いっしゅうかん"],["ほど",null],["腰","こし"],["を",null],["抜かした","ぬかした"],["事","こと"],["が",null],["ある",null],["。",null],
    ],
  },
  {
    text: "花は盛りに、月は隈なきをのみ見るものかは。雨に向かひて月を恋ひ、垂れこめて春の行方知らぬも、なほ哀れに情け深し。",
    reading: "hanahasakarini,tsukihakumanakiwonomimirumonokaha.amenimukahitetsukiwokohi,tarekometeharunoyukueshiranumo,nahoawarenikokorofukashi.",
    tokens: [
      ["花","はな"],["は",null],["盛り","さかり"],["に",null],["、",null],["月","つき"],["は",null],["隈なき","くまなき"],["を",null],["のみ",null],["見る","みる"],["もの",null],["かは",null],["。",null],
      ["雨","あめ"],["に",null],["向かひて","むかひて"],["月","つき"],["を",null],["恋ひ","こひ"],["、",null],["垂れこめて","たれこめて"],["春","はる"],["の",null],["行方","ゆくえ"],["知らぬ","しらぬ"],["も",null],["、",null],
      ["なほ",null],["哀れに","あわれに"],["情け深し","こころふかし"],["。",null],
    ],
  },
  {
    text: "祇園精舎の鐘の声、諸行無常の響きあり。娑羅双樹の花の色、盛者必衰の理をあらはす。おごれる人も久しからず、ただ春の夜の夢のごとし。",
    reading: "gionshoujanokanenokoe,shogyoumujounohibikiari.sharasoujunohananoiro,joushahissuinokotowariwoarahasu.ogoreruhitomohisashikarazu,tadaharunoyonoyumenogotoshi.",
    tokens: [
      ["祇園精舎","ぎおんしょうじゃ"],["の",null],["鐘","かね"],["の",null],["声","こえ"],["、",null],["諸行無常","しょぎょうむじょう"],["の",null],["響き","ひびき"],["あり",null],["。",null],
      ["娑羅双樹","しゃらそうじゅ"],["の",null],["花","はな"],["の",null],["色","いろ"],["、",null],["盛者必衰","じょうしゃひっすい"],["の",null],["理","ことわり"],["を",null],["あらはす",null],["。",null],
      ["おごれる",null],["人","ひと"],["も",null],["久しからず","ひさしからず"],["、",null],["ただ",null],["春","はる"],["の",null],["夜","よ"],["の",null],["夢","ゆめ"],["の",null],["ごとし",null],["。",null],
    ],
  },
  {
    text: "木曾路はすべて山の中である。あるところは岨づたいに行く崖の道であり、あるところは数十間の深さに臨む木曾川の岸であり、あるところは山の尾をめぐる谷の入り口である。",
    reading: "kisojihasubeteyamanonakadearu.arutokorohasobadutainiikugakenomichideari,arutokorohasuujikkennofukasaninozomukisogawanokishideari,arutokorohayamanoowomegurutaninoiriguchidearu.",
    tokens: [
      ["木曾路","きそじ"],["は",null],["すべて",null],["山","やま"],["の",null],["中","なか"],["で",null],["ある",null],["。",null],
      ["あるところ",null],["は",null],["岨づたい","そばづたい"],["に",null],["行く","いく"],["崖","がけ"],["の",null],["道","みち"],["で",null],["あり",null],["、",null],
      ["あるところ",null],["は",null],["数十間","すうじっけん"],["の",null],["深さ","ふかさ"],["に",null],["臨む","のぞむ"],["木曾川","きそがわ"],["の",null],["岸","きし"],["で",null],["あり",null],["、",null],
      ["あるところ",null],["は",null],["山","やま"],["の",null],["尾","お"],["を",null],["めぐる",null],["谷","たに"],["の",null],["入り口","いりぐち"],["で",null],["ある",null],["。",null],
    ],
  },
];

// ランダムなタイピングテキストを選択する関数
function getRandomTypingText() {
  const idx = Math.floor(Math.random() * TYPING_TEXTS.length);
  return TYPING_TEXTS[idx];
}

// タイピングバトル用ルームIDを生成する関数
function createTypingRoomId() {
  return `typing-${Math.random().toString(36).slice(2, 10)}`;
}

// 新しいタイピングバトルルームを作成する関数
function createTypingRoom() {
  const roomId = createTypingRoomId();
  const entry = getRandomTypingText();
  const room = {
    id: roomId,
    players: [],
    playerNames: {},
    started: false,
    resultSent: false,
    text: entry.text,
    reading: entry.reading,
    tokens: entry.tokens,
  };
  typingRooms.set(roomId, room);
  typingWaitingRoomId = roomId;
  return room;
}

// 参加可能なタイピングバトルルームを取得する関数
function getJoinableTypingRoom() {
  if (!typingWaitingRoomId) {
    return createTypingRoom();
  }
  const room = typingRooms.get(typingWaitingRoomId);
  if (!room || room.players.length >= 2) {
    return createTypingRoom();
  }
  return room;
}

// タイピングバトルルームへプレイヤーを参加させる関数
function joinTypingRoom(socket, playerName) {
  const room = getJoinableTypingRoom();
  room.players.push(socket.id);
  room.playerNames[socket.id] = playerName;
  socket.join(room.id);

  const playerNumber = room.players.length;
  typingSocketMeta.set(socket.id, { roomId: room.id, playerNumber });

  if (room.players.length >= 2) {
    // 2人揃ったのでゲーム開始を通知する
    room.started = true;
    typingWaitingRoomId = null;

    room.players.forEach((socketId, index) => {
      const opponentId = room.players[1 - index];
      const myName = room.playerNames[socketId] || `プレイヤー${index + 1}`;
      const opponentName = room.playerNames[opponentId] || `プレイヤー${2 - index}`;

      io.to(socketId).emit("typingMatchStart", {
        roomId: room.id,
        playerNumber: index + 1,
        myName,
        opponentName,
        text: room.text,
        reading: room.reading,
        tokens: room.tokens,
      });
    });
  } else {
    // 1人目は待機状態を通知する
    io.to(socket.id).emit("typingWaiting", { roomId: room.id, playerNumber: 1 });
  }
}

// タイピングバトルルームからプレイヤーを退出させる共通処理関数
function leaveTypingRoom(socket) {
  const meta = typingSocketMeta.get(socket.id);
  if (!meta) {
    return;
  }

  const room = typingRooms.get(meta.roomId);
  typingSocketMeta.delete(socket.id);

  if (!room) {
    if (typingWaitingRoomId === meta.roomId) {
      typingWaitingRoomId = null;
    }
    return;
  }

  room.players = room.players.filter((id) => id !== socket.id);
  delete room.playerNames[socket.id];

  if (room.players.length === 0) {
    typingRooms.delete(room.id);
    if (typingWaitingRoomId === room.id) {
      typingWaitingRoomId = null;
    }
    return;
  }

  // 勝敗確定済みの場合は切断通知を送らない
  if (room.resultSent) {
    return;
  }

  room.started = false;
  typingWaitingRoomId = room.id;

  // 残ったプレイヤーに相手切断を通知する
  room.players.forEach((socketId) => {
    io.to(socketId).emit("typingOpponentLeft", { roomId: room.id });
  });
}

io.on("connection", (socket) => {
  // マッチング要求を受け取りプレイヤーをルームへ参加させる
  socket.on("joinMatch", (payload) => {
    const raw = typeof payload?.playerName === "string" ? payload.playerName : "";
    const playerName = raw.trim().slice(0, 20) || "ゲスト";
    joinRoom(socket, playerName);
  });

  // クライアントから受け取った盤面データを相手へリアルタイムで転送する
  socket.on("boardUpdate", (payload) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) {
      return;
    }

    const room = rooms.get(meta.roomId);
    if (!room || room.players.length < 2) {
      return;
    }

    // 盤面データの基本バリデーション（20行×10列の配列であることを確認する）
    const board = payload?.board;
    if (!Array.isArray(board) || board.length !== 20 || !board.every((row) => Array.isArray(row) && row.length === 10)) {
      return;
    }

    room.players.forEach((socketId) => {
      if (socketId !== socket.id) {
        io.to(socketId).emit("opponentBoardUpdate", { board });
      }
    });
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

  // ===== Block Blast用イベントハンドラ =====

  // Block Blastマッチング要求を受け取りルームへ参加させる
  socket.on("bbJoinMatch", (payload) => {
    const raw = typeof payload?.playerName === "string" ? payload.playerName : "";
    const playerName = raw.trim().slice(0, 20) || "ゲスト";
    joinBBRoom(socket, playerName);
  });

  // Block Blast盤面データを相手へリアルタイムで転送する
  socket.on("bbBoardUpdate", (payload) => {
    const meta = bbSocketMeta.get(socket.id);
    if (!meta) {
      return;
    }

    const room = bbRooms.get(meta.roomId);
    if (!room || room.players.length < 2) {
      return;
    }

    // 盤面データの基本バリデーション（8行×8列の配列であることを確認する）
    const board = payload?.board;
    if (
      !Array.isArray(board) ||
      board.length !== 8 ||
      !board.every((row) => Array.isArray(row) && row.length === 8)
    ) {
      return;
    }

    room.players.forEach((socketId) => {
      if (socketId !== socket.id) {
        io.to(socketId).emit("bbOpponentBoardUpdate", { board });
      }
    });
  });

  // Block Blastダメージを相手へ転送する
  socket.on("bbDamage", (payload) => {
    const meta = bbSocketMeta.get(socket.id);
    if (!meta) {
      return;
    }

    const room = bbRooms.get(meta.roomId);
    if (!room || room.players.length < 2) {
      return;
    }

    const damage = Number(payload?.damage || 0);
    if (!Number.isFinite(damage) || damage <= 0) {
      return;
    }

    room.players.forEach((socketId) => {
      if (socketId !== socket.id) {
        io.to(socketId).emit("bbReceiveDamage", { damage });
      }
    });
  });

  // Block Blast HP更新を相手へ転送する
  socket.on("bbHPUpdate", (payload) => {
    const meta = bbSocketMeta.get(socket.id);
    if (!meta) {
      return;
    }

    const room = bbRooms.get(meta.roomId);
    if (!room || room.players.length < 2) {
      return;
    }

    const hp = Number(payload?.hp);
    if (!Number.isFinite(hp)) {
      return;
    }

    room.players.forEach((socketId) => {
      if (socketId !== socket.id) {
        io.to(socketId).emit("bbOpponentHP", { hp: Math.max(0, hp) });
      }
    });
  });

  // Block Blastゲームオーバー通知を受け取り勝敗を両プレイヤーへ通知する
  socket.on("bbGameOver", () => {
    const meta = bbSocketMeta.get(socket.id);
    if (!meta) {
      return;
    }

    const room = bbRooms.get(meta.roomId);
    if (!room || room.players.length < 2 || room.resultSent) {
      return;
    }

    // 最初にゲームオーバーになったプレイヤーが負け
    room.resultSent = true;
    io.to(socket.id).emit("bbResult", { win: false });
    room.players.forEach((socketId) => {
      if (socketId !== socket.id) {
        io.to(socketId).emit("bbResult", { win: true });
      }
    });
  });

  // Block Blastペナルティ開始を相手へ通知する
  socket.on("bbPenalty", () => {
    const meta = bbSocketMeta.get(socket.id);
    if (!meta) {
      return;
    }

    const room = bbRooms.get(meta.roomId);
    if (!room || room.players.length < 2) {
      return;
    }

    room.players.forEach((socketId) => {
      if (socketId !== socket.id) {
        io.to(socketId).emit("bbOpponentPenalty", {});
      }
    });
  });

  // Block Blastペナルティ終了を相手へ通知する
  socket.on("bbPenaltyEnd", () => {
    const meta = bbSocketMeta.get(socket.id);
    if (!meta) {
      return;
    }

    const room = bbRooms.get(meta.roomId);
    if (!room || room.players.length < 2) {
      return;
    }

    room.players.forEach((socketId) => {
      if (socketId !== socket.id) {
        io.to(socketId).emit("bbOpponentPenaltyEnd", {});
      }
    });
  });

  // Block Blastロビーへ戻る際にルームから退出させる
  socket.on("bbLeaveRoom", () => {
    leaveBBRoom(socket);
  });

  // ===== タイピングバトル用イベントハンドラ =====

  // タイピングバトルマッチング要求を受け取りルームへ参加させる
  socket.on("typingJoinMatch", (payload) => {
    const raw = typeof payload?.playerName === "string" ? payload.playerName : "";
    const playerName = raw.trim().slice(0, 20) || "ゲスト";
    joinTypingRoom(socket, playerName);
  });

  // タイピング進捗を相手へリアルタイムで転送する
  socket.on("typingProgress", (payload) => {
    const meta = typingSocketMeta.get(socket.id);
    if (!meta) {
      return;
    }

    const room = typingRooms.get(meta.roomId);
    if (!room || room.players.length < 2) {
      return;
    }

    // 進捗値のバリデーション（0以上reading長以下の整数）
    const progress = Number(payload?.progress);
    if (!Number.isInteger(progress) || progress < 0 || progress > room.reading.length) {
      return;
    }

    // 相手に進捗を送信する
    room.players.forEach((socketId) => {
      if (socketId !== socket.id) {
        io.to(socketId).emit("typingOpponentProgress", { progress });
      }
    });
  });

  // タイピング完了通知を受け取り勝敗を両プレイヤーへ通知する
  socket.on("typingComplete", () => {
    const meta = typingSocketMeta.get(socket.id);
    if (!meta) {
      return;
    }

    const room = typingRooms.get(meta.roomId);
    if (!room || room.players.length < 2 || room.resultSent) {
      return;
    }

    // 最初に完了したプレイヤーが勝ち
    room.resultSent = true;
    io.to(socket.id).emit("typingResult", { win: true });
    room.players.forEach((socketId) => {
      if (socketId !== socket.id) {
        io.to(socketId).emit("typingResult", { win: false });
      }
    });
  });

  // タイピングバトルロビーへ戻る際にルームから退出させる
  socket.on("typingLeaveRoom", () => {
    leaveTypingRoom(socket);
  });

  // ===== カードゲーム用イベントハンドラ =====

  // カードゲームマッチング要求を受け取りルームへ参加させる
  socket.on('cgJoinMatch', (payload) => {
    const raw = typeof payload?.playerName === 'string' ? payload.playerName : '';
    const playerName = raw.trim().slice(0, 20) || 'ゲスト';
    const validJobs = ['warrior', 'mage', 'priest', 'rogue', 'assassin', 'knight', 'gambler', 'alchemist', 'necromancer', 'monk', 'curse', 'summoner'];
    const job = validJobs.includes(payload?.job) ? payload.job : '';
    joinCGRoom(socket, playerName, job);
  });

  // カードを使用する処理（手札からフィールドへ移動し効果を適用する）
  socket.on('cgPlayCard', (payload) => {
    const meta = cgSocketMeta.get(socket.id);
    if (!meta) return;

    const room = cgRooms.get(meta.roomId);
    if (!room || !room.state || room.resultSent) return;

    const state = room.state;
    const playerIndex = meta.playerNumber - 1;

    // 自分のターンかつプレイフェーズであることを確認する
    if (state.activePlayer !== playerIndex || state.phase !== 'play') return;

    const handIndex = Number(payload?.handIndex);
    if (!Number.isInteger(handIndex) || handIndex < 0 || handIndex >= state.hand[playerIndex].length) return;

    const cardId = state.hand[playerIndex][handIndex];
    const card = CARD_DEFS[cardId];
    if (!card) return;

    // 封印されたカードは使用不能
    if (state.sealedCardId[playerIndex] === cardId) return;

    // アルケミスト：コイン消費カードはコインが足りない場合は使用不能
    if (card.coinCost && state.gold[playerIndex] < card.coinCost) return;

    // モンク：気力消費カードは気力が足りない場合は使用不能
    if (card.kiCost && (state.ki ? state.ki[playerIndex] : 0) < card.kiCost) return;
    if (card.kiCostPerHit && (state.ki ? state.ki[playerIndex] : 0) < card.kiCostPerHit) return;

    // ネクロマンサー：魂喰いは墓地が足りない場合は使用不能
    if (card.graveCost && (state.grave ? state.grave[playerIndex].length : 0) < card.graveCost) return;

    // ナイト：ブロック消費攻撃カードはブロックが0の場合は使用不能
    const knBlockConsumeEffects = ['kn_shieldblow', 'kn_ironcharge', 'kn_shieldstorm', 'kn_shieldcrush', 'kn_godshield'];
    if (knBlockConsumeEffects.includes(card.effect) && state.block[playerIndex] === 0) return;

    // 隠密バフが有効なら実効コストを0にする
    const effectiveCost = state.stealth[playerIndex] ? 0 : card.cost;
    if (state.mana[playerIndex] < effectiveCost) return;
    if (state.stealth[playerIndex]) {
      state.stealth[playerIndex] = false;
    }

    // カードを手札から取り出しフィールドへ移動する
    state.hand[playerIndex].splice(handIndex, 1);
    state.mana[playerIndex] -= effectiveCost;
    state.field[playerIndex].push(cardId);

    const oppIndex = 1 - playerIndex;

    // 罠が有効な場合はカードを使用するたびに3ダメージを受ける
    if (state.trapTriggers[playerIndex] > 0) {
      const trapDmg = 3;
      const trapAbs = Math.min(state.block[playerIndex], trapDmg);
      state.block[playerIndex] = Math.max(0, state.block[playerIndex] - trapAbs);
      state.hp[playerIndex] = Math.max(0, state.hp[playerIndex] - (trapDmg - trapAbs));
      state.totalDamageTaken[playerIndex] += (trapDmg - trapAbs);
      state.trapTriggers[playerIndex] -= 1;
    }

    // コピーフラグが有効な場合は効果を2回適用する（scryとその他インタラクティブ系は例外で1回のみ）
    const noRepeatEffects = ['scry', 'copy', 'timewarp', 'm_drain', 'warcry', 'shadowclone', 'm_recover'];
    const repeatCount = state.copyNext[playerIndex] && !noRepeatEffects.includes(card.effect) ? 2 : 1;
    if (card.effect !== 'copy') {
      state.copyNext[playerIndex] = false;
    }

    // amplify（魔力増幅）・bless（祝福）・gamblerTriple・curseSelfBuff の倍率を計算する
    const ampMult = state.amplify[playerIndex] ? 2 : 1;
    const blsMult = state.bless[playerIndex] ? 2 : 1;
    const gambTriple = (state.gamblerTriple && state.gamblerTriple[playerIndex]) ? 3 : 1;
    const curseBuff = (state.curseSelfBuff && state.curseSelfBuff[playerIndex]) ? 3 : 1;
    const specterMult = (state.specterBuff && state.specterBuff[playerIndex] > 0) ? (1 + state.specterBuff[playerIndex]) : 1;
    const summonMult = (card.isToken && state.summonBuff && state.summonBuff[playerIndex] > 0) ? 2 : 1;
    const effMult = ampMult * blsMult * gambTriple * curseBuff * specterMult * summonMult;
    if (state.amplify[playerIndex]) state.amplify[playerIndex] = false;
    if (state.bless[playerIndex]) state.bless[playerIndex] = false;
    if (state.gamblerTriple && state.gamblerTriple[playerIndex]) state.gamblerTriple[playerIndex] = false;
    if (state.curseSelfBuff && state.curseSelfBuff[playerIndex]) state.curseSelfBuff[playerIndex] = false;
    if (state.specterBuff && state.specterBuff[playerIndex] > 0) state.specterBuff[playerIndex] = 0;

    // 武器強化ボーナス（攻撃カードに追加ダメージ）を取得する
    const weaponBonus = (state.weaponUp[playerIndex] > 0 && (card.effect === 'damage' || card.effect === 'shieldbash' || card.effect === 'combo')) ? state.weaponUp[playerIndex] : 0;
    if (weaponBonus > 0) state.weaponUp[playerIndex] = 0;

    // ダメージを相手に与えるヘルパー関数（加護・ブロック・反射・完全防御・不死薬を考慮する）
    function applyDamageToOpp(dmg) {
      // アルケミスト不死薬：次に受けるダメージを無効化する
      if (state.alImmortal && state.alImmortal[oppIndex]) {
        state.alImmortal[oppIndex] = false;
        return;
      }
      // ナイト完全防御：受けたダメージをすべてブロックに変換する
      if (state.perfectGuard && state.perfectGuard[oppIndex]) {
        state.block[oppIndex] += dmg;
        state.perfectGuard[oppIndex] = false;
        return;
      }
      // 相手の加護が有効な場合はダメージを無効化する
      if (state.protection[oppIndex] > 0) {
        state.protection[oppIndex] -= 1;
        return;
      }
      const absorbed = Math.min(state.block[oppIndex], dmg);
      state.block[oppIndex] = Math.max(0, state.block[oppIndex] - absorbed);
      const actualDmg = dmg - absorbed;
      // カース不死の呪い：致死ダメージを受けてもHP1で耐える
      if (state.undyingGuard && state.undyingGuard[oppIndex] && state.hp[oppIndex] - actualDmg < 1) {
        state.hp[oppIndex] = 1;
        state.undyingGuard[oppIndex] = false;
      } else {
        state.hp[oppIndex] = Math.max(0, state.hp[oppIndex] - actualDmg);
      }
      // 相手の反射フラグが有効な場合はダメージの半分を攻撃側に返す
      if (state.reflect[oppIndex] && actualDmg > 0) {
        const reflectDmg = Math.floor(actualDmg / 2);
        if (reflectDmg > 0) {
          const absorbedSelf = Math.min(state.block[playerIndex], reflectDmg);
          state.block[playerIndex] = Math.max(0, state.block[playerIndex] - absorbedSelf);
          const selfDmg = reflectDmg - absorbedSelf;
          state.hp[playerIndex] = Math.max(0, state.hp[playerIndex] - selfDmg);
          state.totalDamageTaken[playerIndex] += selfDmg;
        }
        state.reflect[oppIndex] = false;
      }
    }

    // 自分自身にダメージを与えるヘルパー関数
    function applySelfDamage(dmg) {
      const absorbed = Math.min(state.block[playerIndex], dmg);
      state.block[playerIndex] = Math.max(0, state.block[playerIndex] - absorbed);
      const actual = dmg - absorbed;
      state.hp[playerIndex] = Math.max(0, state.hp[playerIndex] - actual);
      state.totalDamageTaken[playerIndex] += actual;
    }

    // 毒スタックを相手に追加するヘルパー関数
    function applyPoisonToOpp(dmg, turns) {
      if (dmg > 0 && turns > 0) {
        state.poisonStacks[oppIndex].push({ dmg, turns });
      }
    }

    // 毒カード使用履歴に記録する（影分身用）
    const isPoisonCard = card.effect === 'poisoncard' || card.effect === 'poison' || card.effect === 'toxicsmoke' || card.effect === 'poisonstar' || card.effect === 'corrosion';
    if (isPoisonCard) {
      state.poisonCardsThisTurn[playerIndex].push(cardId);
    }

    // カードの効果をrepeatCount回適用する
    // ギャンブラー不発フラグが立っている場合は効果をスキップする
    const skipEffect = state.gamblerSureMiss && state.gamblerSureMiss[playerIndex];
    if (skipEffect) state.gamblerSureMiss[playerIndex] = false;

    for (let r = 0; r < repeatCount && !skipEffect; r++) {
      const dmgMult = effMult;

      if (card.effect === 'damage') {
        applyDamageToOpp((card.value + weaponBonus) * dmgMult);
      } else if (card.effect === 'combo') {
        // card.value のダメージを2回与える（各ヒットでブロックを消費する）
        const comboDmg = (card.value + Math.floor(weaponBonus / 2)) * dmgMult;
        applyDamageToOpp(comboDmg);
        applyDamageToOpp(comboDmg);
      } else if (card.effect === 'poison') {
        // 4ダメージ＋毒スタックに追加する（毎ターン2ダメージ×3ターン）
        applyDamageToOpp(4 * dmgMult);
        applyPoisonToOpp(2, 3);
      } else if (card.effect === 'storm') {
        // 手札枚数×card.valueのダメージ
        const stormDmg = state.hand[playerIndex].length * card.value * dmgMult;
        applyDamageToOpp(stormDmg);
      } else if (card.effect === 'phoenix') {
        applyDamageToOpp(card.value * dmgMult);
        state.hp[playerIndex] = Math.min(CG_MAX_HP, state.hp[playerIndex] + card.healValue * blsMult);
      } else if (card.effect === 'block') {
        state.block[playerIndex] += card.value * blsMult;
      } else if (card.effect === 'reflect') {
        state.reflect[playerIndex] = true;
      } else if (card.effect === 'heal') {
        state.hp[playerIndex] = Math.min(CG_MAX_HP, state.hp[playerIndex] + card.value * blsMult);
      } else if (card.effect === 'draw') {
        cgDrawCards(state, playerIndex, card.value * blsMult);
      } else if (card.effect === 'copy') {
        state.copyNext[playerIndex] = true;
      } else if (card.effect === 'scry') {
        // デッキトップから最大SCRY_CARD_COUNT枚を取り出しクライアントへ送り選択を待つ
        const scryCards = [];
        for (let i = 0; i < SCRY_CARD_COUNT; i++) {
          if (state.deck[playerIndex].length === 0) {
            if (state.discard[playerIndex].length === 0) break;
            state.deck[playerIndex] = cgShuffle(state.discard[playerIndex]);
            state.discard[playerIndex] = [];
          }
          if (state.deck[playerIndex].length > 0) {
            scryCards.push(state.deck[playerIndex].pop());
          }
        }
        state.scryCards[playerIndex] = scryCards;
        // 罠ダメージ等でカード使用前に誰かのHPが0になっていた場合は最新状態を送信して終了する
        // （クライアント側でHP0を検知してcgGameOverを送信する）
        if (state.hp[oppIndex] <= 0 || state.hp[playerIndex] <= 0) {
          sendCGState(room);
          return;
        }
        io.to(socket.id).emit('cgScryChoice', { cards: scryCards });
        sendCGState(room);
        return;
      } else if (card.effect === 'gold') {
        state.gold[playerIndex] += card.value;
      } else if (card.effect === 'invest') {
        state.pendingGold[playerIndex] += card.value;

      // ===== ウォリアー固有効果 =====
      } else if (card.effect === 'shieldbash') {
        // ダメージ＋ブロックを同時に得る
        applyDamageToOpp((card.value + weaponBonus) * dmgMult);
        state.block[playerIndex] += card.blockValue * blsMult;
      } else if (card.effect === 'weaponup') {
        // 次の攻撃カードのダメージに追加ボーナスを与える
        state.weaponUp[playerIndex] += card.value;
      } else if (card.effect === 'counter') {
        // ブロック＋反射フラグ
        state.block[playerIndex] += card.value * blsMult;
        state.reflect[playerIndex] = true;
      } else if (card.effect === 'warfiend') {
        // ダメージ＋ブロックを3回繰り返す
        for (let i = 0; i < 3; i++) {
          applyDamageToOpp(card.value * dmgMult);
          state.block[playerIndex] += card.blockValue * blsMult;
        }
      } else if (card.effect === 'rage') {
        // これまで受けた累計ダメージ × card.value のダメージ
        const rageDmg = state.totalDamageTaken[playerIndex] * card.value * dmgMult;
        applyDamageToOpp(rageDmg);
      } else if (card.effect === 'warcry') {
        // 手札の全攻撃カード（effect:damage/combo/shieldbash）を即座に発動する
        const attackEffects = ['damage', 'combo', 'shieldbash'];
        const attackIndices = [];
        state.hand[playerIndex].forEach((cid, i) => {
          const c = CARD_DEFS[cid];
          if (c && attackEffects.includes(c.effect)) attackIndices.push(i);
        });
        // 後ろから削除して索引ずれを防ぐ
        attackIndices.reverse().forEach(i => {
          const cid = state.hand[playerIndex][i];
          const c = CARD_DEFS[cid];
          state.hand[playerIndex].splice(i, 1);
          state.field[playerIndex].push(cid);
          if (c.effect === 'damage') {
            applyDamageToOpp(c.value);
          } else if (c.effect === 'combo') {
            applyDamageToOpp(c.value);
            applyDamageToOpp(c.value);
          } else if (c.effect === 'shieldbash') {
            applyDamageToOpp(c.value);
            state.block[playerIndex] += c.blockValue;
          }
        });
      } else if (card.effect === 'undying') {
        // HP回復＋ブロック
        state.hp[playerIndex] = Math.min(CG_MAX_HP, state.hp[playerIndex] + card.value * blsMult);
        state.block[playerIndex] += card.blockValue * blsMult;
      } else if (card.effect === 'ironwall') {
        // 今のターン大きなブロック＋次のターンも継続
        state.block[playerIndex] += card.value * blsMult;
        state.persistBlock[playerIndex] += card.value * blsMult;
      } else if (card.effect === 'godofwar') {
        // card.valueのダメージを5回＋card.blockValueのブロック
        for (let i = 0; i < 5; i++) {
          applyDamageToOpp(card.value * dmgMult);
        }
        state.block[playerIndex] += card.blockValue * blsMult;

      // ===== メイジ固有効果 =====
      } else if (card.effect === 'manafill') {
        // 次のターン追加マナ
        state.manaBonusNextTurn[playerIndex] += card.value;
      } else if (card.effect === 'amplify') {
        // 次のカードのダメージを2倍にするフラグを立てる
        state.amplify[playerIndex] = true;
      } else if (card.effect === 'chain') {
        // 手札枚数 × card.value のダメージ
        const chainDmg = state.hand[playerIndex].length * card.value * dmgMult;
        applyDamageToOpp(chainDmg);
      } else if (card.effect === 'freeze') {
        // ダメージ＋相手の次のターンのマナを3減らす
        applyDamageToOpp(card.value * dmgMult);
        state.manaBonusNextTurn[oppIndex] -= 3;
      } else if (card.effect === 'thunder') {
        // ダメージ＋カードを引く
        applyDamageToOpp(card.value * dmgMult);
        cgDrawCards(state, playerIndex, card.drawValue * blsMult);
      } else if (card.effect === 'm_recover') {
        // 捨て札から最大card.value枚を手札に戻す
        const recoverCount = Math.min(card.value, state.discard[playerIndex].length);
        for (let i = 0; i < recoverCount; i++) {
          const cid = state.discard[playerIndex].pop();
          state.hand[playerIndex].push(cid);
        }
      } else if (card.effect === 'm_seal') {
        // 相手の手札をランダムに1枚封印する（次のターンまで使用不能）
        if (state.hand[oppIndex].length > 0) {
          const sealIdx = Math.floor(Math.random() * state.hand[oppIndex].length);
          state.sealedCardId[oppIndex] = state.hand[oppIndex][sealIdx];
        }
      } else if (card.effect === 'm_copy') {
        // 手札の一番左のカードをコピーして効果を発動する（そのカードは消費しない）
        if (state.hand[playerIndex].length > 0) {
          const copyCid = state.hand[playerIndex][0];
          const copyCard = CARD_DEFS[copyCid];
          if (copyCard && copyCard.effect === 'damage') {
            applyDamageToOpp(copyCard.value * dmgMult);
          } else if (copyCard && copyCard.effect === 'block') {
            state.block[playerIndex] += copyCard.value * blsMult;
          } else if (copyCard && copyCard.effect === 'heal') {
            state.hp[playerIndex] = Math.min(CG_MAX_HP, state.hp[playerIndex] + copyCard.value * blsMult);
          } else if (copyCard && copyCard.effect === 'draw') {
            cgDrawCards(state, playerIndex, copyCard.value * blsMult);
          } else if (copyCard && copyCard.effect === 'gold') {
            state.gold[playerIndex] += copyCard.value;
          }
        }
      } else if (card.effect === 'timewarp') {
        // 手札を全て捨てて同枚数+card.value枚引く
        const drawCount = state.hand[playerIndex].length + card.value;
        state.discard[playerIndex].push(...state.hand[playerIndex]);
        state.hand[playerIndex] = [];
        cgDrawCards(state, playerIndex, drawCount);
      } else if (card.effect === 'explosion') {
        // 使用済みカード枚数（フィールド枚数）× card.value のダメージ
        const explDmg = state.field[playerIndex].length * card.value * dmgMult;
        applyDamageToOpp(explDmg);
      } else if (card.effect === 'm_drain') {
        // 相手の手札からコスト最大のカードを奪う
        if (state.hand[oppIndex].length > 0) {
          let maxCost = -1;
          let maxIdx = 0;
          state.hand[oppIndex].forEach((cid, i) => {
            const c = CARD_DEFS[cid];
            if (c && c.cost > maxCost) { maxCost = c.cost; maxIdx = i; }
          });
          const drainedCard = state.hand[oppIndex].splice(maxIdx, 1)[0];
          state.hand[playerIndex].push(drainedCard);
        }
      } else if (card.effect === 'bigmagic') {
        // 手札枚数 × card.value のダメージ
        const bigDmg = state.hand[playerIndex].length * card.value * dmgMult;
        applyDamageToOpp(bigDmg);
      } else if (card.effect === 'collapse') {
        // 相手のHP残量の60%ダメージ＋card.drawValue枚ドロー
        const collapseDmg = Math.floor(state.hp[oppIndex] * card.value * dmgMult);
        applyDamageToOpp(collapseDmg);
        cgDrawCards(state, playerIndex, card.drawValue * blsMult);

      // ===== プリースト固有効果 =====
      } else if (card.effect === 'prayer') {
        // 毎ターン開始時card.value回復（card.turnsターン）
        state.healPerTurn[playerIndex].push({ amount: card.value * blsMult, turns: card.turns });
      } else if (card.effect === 'purify') {
        // 自分の毒スタックをクリア＋HP回復
        state.poisonStacks[playerIndex] = [];
        state.hp[playerIndex] = Math.min(CG_MAX_HP, state.hp[playerIndex] + card.value * blsMult);
      } else if (card.effect === 'devotion') {
        // HP回復＋カードを引く
        state.hp[playerIndex] = Math.min(CG_MAX_HP, state.hp[playerIndex] + card.value * blsMult);
        cgDrawCards(state, playerIndex, card.drawValue * blsMult);
      } else if (card.effect === 'holyfire') {
        // ダメージ＋自分HP回復
        applyDamageToOpp(card.value * dmgMult);
        state.hp[playerIndex] = Math.min(CG_MAX_HP, state.hp[playerIndex] + card.healValue * blsMult);
      } else if (card.effect === 'holyshield') {
        // ブロック＋HP回復
        state.block[playerIndex] += card.value * blsMult;
        state.hp[playerIndex] = Math.min(CG_MAX_HP, state.hp[playerIndex] + card.healValue * blsMult);
      } else if (card.effect === 'confess') {
        // 手札の最後のカードを捨てて card.value 枚ドロー
        if (state.hand[playerIndex].length > 0) {
          const discarded = state.hand[playerIndex].pop();
          state.discard[playerIndex].push(discarded);
        }
        cgDrawCards(state, playerIndex, card.value * blsMult);
      } else if (card.effect === 'bless') {
        // 次のカードの効果を2倍にするフラグを立てる
        state.bless[playerIndex] = true;
      } else if (card.effect === 'divineye') {
        // デッキトップ5枚を見てコストが高い順にcard.value枚を手札に加える
        const DIVINEYE_VIEW = 5;
        const viewedCards = [];
        for (let i = 0; i < DIVINEYE_VIEW; i++) {
          if (state.deck[playerIndex].length === 0) {
            if (state.discard[playerIndex].length === 0) break;
            state.deck[playerIndex] = cgShuffle(state.discard[playerIndex]);
            state.discard[playerIndex] = [];
          }
          if (state.deck[playerIndex].length > 0) {
            viewedCards.push(state.deck[playerIndex].pop());
          }
        }
        // コストが高い順にcard.value枚を手札へ、残りは捨て札へ
        viewedCards.sort((a, b) => (CARD_DEFS[b]?.cost || 0) - (CARD_DEFS[a]?.cost || 0));
        const keepCount = Math.min(card.value * blsMult, viewedCards.length);
        viewedCards.forEach((cid, i) => {
          if (i < keepCount) {
            state.hand[playerIndex].push(cid);
          } else {
            state.discard[playerIndex].push(cid);
          }
        });
      } else if (card.effect === 'holybeam') {
        // HP回復＋ブロック
        state.hp[playerIndex] = Math.min(CG_MAX_HP, state.hp[playerIndex] + card.healValue * blsMult);
        state.block[playerIndex] += card.value * blsMult;
      } else if (card.effect === 'judgment') {
        // 相手HP残量 − 自分HP残量 のダメージ（0以上）
        const jDmg = Math.max(0, Math.floor((state.hp[oppIndex] - state.hp[playerIndex]) * dmgMult));
        applyDamageToOpp(jDmg);
      } else if (card.effect === 'sanctuary') {
        // 毎ターン開始時card.value回復（card.turnsターン）
        state.healPerTurn[playerIndex].push({ amount: card.value * blsMult, turns: card.turns });
      } else if (card.effect === 'protection') {
        // 次にcard.value回受けるダメージを無効化する
        state.protection[playerIndex] += card.value;
      } else if (card.effect === 'divine') {
        // 相手HPの30%ダメージ
        const divineDmg = Math.floor(state.hp[oppIndex] * card.value * dmgMult);
        applyDamageToOpp(divineDmg);
      } else if (card.effect === 'holyjudge') {
        // 20ダメージ＋自分HP全回復＋全状態異常解除
        applyDamageToOpp(card.value * dmgMult);
        state.hp[playerIndex] = CG_MAX_HP;
        state.poisonStacks[playerIndex] = [];
        state.trapTriggers[playerIndex] = 0;
        state.sealedCardId[playerIndex] = null;

      // ===== ローグ固有効果 =====
      } else if (card.effect === 'shadowrun') {
        // card.drawValue枚ドロー＋card.valueダメージ
        cgDrawCards(state, playerIndex, card.drawValue * blsMult);
        applyDamageToOpp(card.value * dmgMult);
      } else if (card.effect === 'stealth') {
        // 次のカードのコストを0にするフラグを立てる
        state.stealth[playerIndex] = true;
      } else if (card.effect === 'poisonstar') {
        // ダメージ＋毒スタック追加
        applyDamageToOpp(card.value * dmgMult);
        applyPoisonToOpp(card.poisonDmg, card.poisonTurns);
      } else if (card.effect === 'steal') {
        // 相手からcard.value分のゴールドを奪う
        const stolen = Math.min(card.value, state.gold[oppIndex]);
        state.gold[oppIndex] -= stolen;
        state.gold[playerIndex] += stolen;
      } else if (card.effect === 'stab') {
        // card.valueダメージを5回与える
        for (let i = 0; i < 5; i++) {
          applyDamageToOpp(Math.floor(card.value * dmgMult));
        }
      } else if (card.effect === 'distract') {
        // 相手の手札からcard.value枚をランダムに捨てさせる
        for (let i = 0; i < card.value; i++) {
          if (state.hand[oppIndex].length > 0) {
            const idx = Math.floor(Math.random() * state.hand[oppIndex].length);
            const discardedCard = state.hand[oppIndex].splice(idx, 1)[0];
            state.discard[oppIndex].push(discardedCard);
          }
        }
      } else if (card.effect === 'mirage') {
        // このターン使ったカード枚数 × card.value のダメージ
        const mirageDmg = state.field[playerIndex].length * card.value * dmgMult;
        applyDamageToOpp(mirageDmg);
      } else if (card.effect === 'illusion') {
        // 手札の一番安いカードをコピーして2回発動する
        if (state.hand[playerIndex].length > 0) {
          let minCost = Infinity;
          let minIdx = 0;
          state.hand[playerIndex].forEach((cid, i) => {
            const c = CARD_DEFS[cid];
            if (c && c.cost < minCost) { minCost = c.cost; minIdx = i; }
          });
          const illusionCard = CARD_DEFS[state.hand[playerIndex][minIdx]];
          if (illusionCard) {
            for (let i = 0; i < 2; i++) {
              if (illusionCard.effect === 'damage') applyDamageToOpp(illusionCard.value * dmgMult);
              else if (illusionCard.effect === 'block') state.block[playerIndex] += illusionCard.value;
              else if (illusionCard.effect === 'heal') state.hp[playerIndex] = Math.min(CG_MAX_HP, state.hp[playerIndex] + illusionCard.value);
              else if (illusionCard.effect === 'draw') cgDrawCards(state, playerIndex, illusionCard.value);
              else if (illusionCard.effect === 'gold') state.gold[playerIndex] += illusionCard.value;
            }
          }
        }
      } else if (card.effect === 'backstab') {
        // 手札が4枚以上あればボーナスダメージを追加する
        const bsDmg = (card.value + (state.hand[playerIndex].length >= 4 ? card.bonusValue : 0)) * dmgMult;
        applyDamageToOpp(bsDmg);
      } else if (card.effect === 'toxicsmoke') {
        // ブロック＋毒スタック追加
        state.block[playerIndex] += card.value * blsMult;
        applyPoisonToOpp(card.poisonDmg, card.poisonTurns);
      } else if (card.effect === 'doublesteal') {
        // ゴールドを奪う＋カードを引く
        const dStolen = Math.min(card.value, state.gold[oppIndex]);
        state.gold[oppIndex] -= dStolen;
        state.gold[playerIndex] += dStolen;
        cgDrawCards(state, playerIndex, card.drawValue * blsMult);
      } else if (card.effect === 'vital') {
        // ダメージ＋相手の手札をcard.discardCount枚捨てさせる
        applyDamageToOpp(card.value * dmgMult);
        for (let i = 0; i < card.discardCount; i++) {
          if (state.hand[oppIndex].length > 0) {
            const idx = Math.floor(Math.random() * state.hand[oppIndex].length);
            state.discard[oppIndex].push(state.hand[oppIndex].splice(idx, 1)[0]);
          }
        }
      } else if (card.effect === 'dance') {
        // card.valueダメージ×10回＋相手の手札を全て捨てさせる
        for (let i = 0; i < 10; i++) {
          applyDamageToOpp(card.value * dmgMult);
        }
        state.discard[oppIndex].push(...state.hand[oppIndex]);
        state.hand[oppIndex] = [];

      // ===== アサシン固有効果 =====
      } else if (card.effect === 'poisoncard') {
        // 即時ダメージ（あれば）＋毒スタック追加
        if (card.value > 0) applyDamageToOpp(card.value * dmgMult);
        applyPoisonToOpp(card.poisonDmg, card.poisonTurns);
      } else if (card.effect === 'corrosion') {
        // 相手のブロックを半減＋毒スタック追加
        state.block[oppIndex] = Math.floor(state.block[oppIndex] / 2);
        applyPoisonToOpp(card.poisonDmg, card.poisonTurns);
      } else if (card.effect === 'shadowbind') {
        // 相手の次のターンのマナをcard.value減らす
        state.manaBonusNextTurn[oppIndex] -= card.value;
      } else if (card.effect === 'darkpact') {
        // 自分HPをcard.value失う代わりにcard.drawValue枚ドロー
        applySelfDamage(card.value);
        cgDrawCards(state, playerIndex, card.drawValue * blsMult);
      } else if (card.effect === 'trap') {
        // 相手がカードを使うたびにcard.value×card.trapCountの罠を仕掛ける
        state.trapTriggers[oppIndex] += card.trapCount;
      } else if (card.effect === 'powerup') {
        // 相手の現在の毒スタック全てのダメージを2倍にする
        state.poisonStacks[oppIndex] = state.poisonStacks[oppIndex].map(s => ({ dmg: s.dmg * 2, turns: s.turns }));
      } else if (card.effect === 'shadowclone') {
        // このターン使った毒カードを全て再発動する
        const poisonCardsPlayed = [...state.poisonCardsThisTurn[playerIndex]];
        poisonCardsPlayed.forEach(cid => {
          const c = CARD_DEFS[cid];
          if (!c) return;
          if (c.effect === 'poisoncard' || c.effect === 'poison') {
            if (c.value > 0) applyDamageToOpp(c.value);
            applyPoisonToOpp(c.poisonDmg, c.poisonTurns);
          } else if (c.effect === 'corrosion') {
            state.block[oppIndex] = Math.floor(state.block[oppIndex] / 2);
            applyPoisonToOpp(c.poisonDmg, c.poisonTurns);
          } else if (c.effect === 'toxicsmoke') {
            state.block[playerIndex] += c.value;
            applyPoisonToOpp(c.poisonDmg, c.poisonTurns);
          } else if (c.effect === 'poisonstar') {
            applyDamageToOpp(c.value);
            applyPoisonToOpp(c.poisonDmg, c.poisonTurns);
          }
        });
      } else if (card.effect === 'assassinate') {
        // 相手が毒状態なら大ダメージを与える
        if (state.poisonStacks[oppIndex].length > 0) {
          applyDamageToOpp(card.value * dmgMult);
        } else {
          // 毒がない場合は半分のダメージ
          applyDamageToOpp(Math.floor(card.value / 2) * dmgMult);
        }
      } else if (card.effect === 'ritual') {
        // 自分HPをcard.selfDmg失う代わりに相手に大ダメージ
        applySelfDamage(card.selfDmg);
        applyDamageToOpp(card.value * dmgMult);
      } else if (card.effect === 'spiral') {
        // 毒スタック追加＋相手の全毒スタックを2倍にする
        applyPoisonToOpp(card.poisonDmg, card.poisonTurns);
        state.poisonStacks[oppIndex] = state.poisonStacks[oppIndex].map(s => ({ dmg: s.dmg * 2, turns: s.turns }));

      // ===== ナイト固有効果 =====
      } else if (card.effect === 'kn_shieldblow') {
        // 現在のブロック値の2/3を消費してその分（+bonus）ダメージを与える
        const consumed = Math.floor(state.block[playerIndex] * 2 / 3);
        state.block[playerIndex] -= consumed;
        const knDmg = (consumed + (card.bonus || 0)) * dmgMult;
        if (knDmg > 0) applyDamageToOpp(knDmg);
      } else if (card.effect === 'kn_shieldup') {
        // 現在のブロック値をmult倍にする
        state.block[playerIndex] = Math.floor(state.block[playerIndex] * card.mult);
      } else if (card.effect === 'kn_ironcharge') {
        // 現在のブロック値の2/3を消費して消費量×1.5ダメージ
        const consumed = Math.floor(state.block[playerIndex] * 2 / 3);
        state.block[playerIndex] -= consumed;
        applyDamageToOpp(Math.floor(consumed * 1.5) * dmgMult);
      } else if (card.effect === 'kn_shieldstorm') {
        // 現在のブロック値の2/3を消費して消費量÷3ダメージ×4回
        const consumed = Math.floor(state.block[playerIndex] * 2 / 3);
        state.block[playerIndex] -= consumed;
        const hitDmg = Math.floor(consumed / 3) * dmgMult;
        for (let i = 0; i < 4; i++) applyDamageToOpp(hitDmg);
      } else if (card.effect === 'kn_shieldcrush') {
        // 現在のブロック値の2/3を消費して消費量×2ダメージ
        const consumed = Math.floor(state.block[playerIndex] * 2 / 3);
        state.block[playerIndex] -= consumed;
        applyDamageToOpp(consumed * 2 * dmgMult);
      } else if (card.effect === 'kn_perfectguard') {
        // 次に受けるダメージをすべてブロックに変換するフラグを立てる
        state.perfectGuard[playerIndex] = true;
      } else if (card.effect === 'kn_holyshield') {
        // 今すぐcard.valueブロック獲得＋毎ターンcard.blockPerTurnブロック（card.blockTurnsターン）
        state.block[playerIndex] += card.value * blsMult;
        state.blockPerTurn[playerIndex].push({ amount: card.blockPerTurn * blsMult, turns: card.blockTurns });
      } else if (card.effect === 'kn_godshield') {
        // 現在のブロック値の2/3を消費して消費量×4ダメージ＋card.bonusブロック獲得
        const consumed = Math.floor(state.block[playerIndex] * 2 / 3);
        state.block[playerIndex] -= consumed;
        applyDamageToOpp(consumed * 4 * dmgMult);
        state.block[playerIndex] += card.bonus * blsMult;

      // ===== ギャンブラー固有効果 =====
      } else if (card.effect === 'gb_cointoss') {
        // 50%:15ダメージ / 50%:自分に8ダメージ
        const success = (state.gamblerSureSuccess && state.gamblerSureSuccess[playerIndex]) || Math.random() < 0.5;
        if (state.gamblerSureSuccess && state.gamblerSureSuccess[playerIndex]) state.gamblerSureSuccess[playerIndex] = false;
        if (success) { applyDamageToOpp(15 * dmgMult); }
        else { applySelfDamage(8); }
      } else if (card.effect === 'gb_luckydraw') {
        // 50%:5枚ドロー / 50%:手札を全て捨てる
        const success = (state.gamblerSureSuccess && state.gamblerSureSuccess[playerIndex]) || Math.random() < 0.5;
        if (state.gamblerSureSuccess && state.gamblerSureSuccess[playerIndex]) state.gamblerSureSuccess[playerIndex] = false;
        if (success) { cgDrawCards(state, playerIndex, 5 * blsMult); }
        else { state.discard[playerIndex].push(...state.hand[playerIndex]); state.hand[playerIndex] = []; }
      } else if (card.effect === 'gb_bet') {
        // 50%:20ダメージ / 50%:自分に10ダメージ＋手札1枚捨て
        const success = (state.gamblerSureSuccess && state.gamblerSureSuccess[playerIndex]) || Math.random() < 0.5;
        if (state.gamblerSureSuccess && state.gamblerSureSuccess[playerIndex]) state.gamblerSureSuccess[playerIndex] = false;
        if (success) { applyDamageToOpp(20 * dmgMult); }
        else {
          applySelfDamage(10);
          if (state.hand[playerIndex].length > 0) {
            const idx = Math.floor(Math.random() * state.hand[playerIndex].length);
            state.discard[playerIndex].push(state.hand[playerIndex].splice(idx, 1)[0]);
          }
        }
      } else if (card.effect === 'gb_tripleup') {
        // 50%:次のカードの効果3倍 / 50%:次のカードが不発
        const success = (state.gamblerSureSuccess && state.gamblerSureSuccess[playerIndex]) || Math.random() < 0.5;
        if (state.gamblerSureSuccess && state.gamblerSureSuccess[playerIndex]) state.gamblerSureSuccess[playerIndex] = false;
        if (success) { state.gamblerTriple[playerIndex] = true; }
        else { state.gamblerSureMiss[playerIndex] = true; }
      } else if (card.effect === 'gb_roulette') {
        // 50%:25ダメージ or 10ブロック or HP10回復のどれか / 50%:自分に15ダメージ
        const success = (state.gamblerSureSuccess && state.gamblerSureSuccess[playerIndex]) || Math.random() < 0.5;
        if (state.gamblerSureSuccess && state.gamblerSureSuccess[playerIndex]) state.gamblerSureSuccess[playerIndex] = false;
        if (success) {
          const roll = Math.floor(Math.random() * 3);
          if (roll === 0) applyDamageToOpp(25 * dmgMult);
          else if (roll === 1) state.block[playerIndex] += 10 * blsMult;
          else state.hp[playerIndex] = Math.min(CG_MAX_HP, state.hp[playerIndex] + 10 * blsMult);
        } else { applySelfDamage(15); }
      } else if (card.effect === 'gb_highroller') {
        // 50%:35ダメージ / 50%:自分に20ダメージ＋手札2枚捨て
        const success = (state.gamblerSureSuccess && state.gamblerSureSuccess[playerIndex]) || Math.random() < 0.5;
        if (state.gamblerSureSuccess && state.gamblerSureSuccess[playerIndex]) state.gamblerSureSuccess[playerIndex] = false;
        if (success) { applyDamageToOpp(35 * dmgMult); }
        else {
          applySelfDamage(20);
          for (let i = 0; i < 2; i++) {
            if (state.hand[playerIndex].length > 0) {
              const idx = Math.floor(Math.random() * state.hand[playerIndex].length);
              state.discard[playerIndex].push(state.hand[playerIndex].splice(idx, 1)[0]);
            }
          }
        }
      } else if (card.effect === 'gb_goddess') {
        // 50%:全職業からランダムで1枚入手 / 50%:コイン全消失
        const success = (state.gamblerSureSuccess && state.gamblerSureSuccess[playerIndex]) || Math.random() < 0.5;
        if (state.gamblerSureSuccess && state.gamblerSureSuccess[playerIndex]) state.gamblerSureSuccess[playerIndex] = false;
        if (success) {
          const allJobCards = Object.keys(CARD_DEFS).filter(id => CARD_DEFS[id].job);
          const randomCard = allJobCards[Math.floor(Math.random() * allJobCards.length)];
          state.deck[playerIndex].push(randomCard);
        } else { state.gold[playerIndex] = 0; }
      } else if (card.effect === 'gb_longshot') {
        // 20%:50ダメージ / 80%:自分に15ダメージ
        const success = (state.gamblerSureSuccess && state.gamblerSureSuccess[playerIndex]) || Math.random() < 0.2;
        if (state.gamblerSureSuccess && state.gamblerSureSuccess[playerIndex]) state.gamblerSureSuccess[playerIndex] = false;
        if (success) { applyDamageToOpp(50 * dmgMult); }
        else { applySelfDamage(15); }
      } else if (card.effect === 'gb_casino') {
        // 50%:30コイン獲得 / 50%:コイン全消失
        const success = (state.gamblerSureSuccess && state.gamblerSureSuccess[playerIndex]) || Math.random() < 0.5;
        if (state.gamblerSureSuccess && state.gamblerSureSuccess[playerIndex]) state.gamblerSureSuccess[playerIndex] = false;
        if (success) { state.gold[playerIndex] += 30; }
        else { state.gold[playerIndex] = 0; }
      } else if (card.effect === 'gb_slot') {
        // 50%:ランダム大効果3つ / 50%:ランダム大デメリット3つ
        const success = (state.gamblerSureSuccess && state.gamblerSureSuccess[playerIndex]) || Math.random() < 0.5;
        if (state.gamblerSureSuccess && state.gamblerSureSuccess[playerIndex]) state.gamblerSureSuccess[playerIndex] = false;
        if (success) {
          applyDamageToOpp(20 * dmgMult);
          state.block[playerIndex] += 15 * blsMult;
          state.hp[playerIndex] = Math.min(CG_MAX_HP, state.hp[playerIndex] + 15 * blsMult);
        } else {
          applySelfDamage(20);
          state.block[playerIndex] = 0;
          if (state.hand[playerIndex].length > 0) {
            const idx = Math.floor(Math.random() * state.hand[playerIndex].length);
            state.discard[playerIndex].push(state.hand[playerIndex].splice(idx, 1)[0]);
          }
        }
      } else if (card.effect === 'gb_instinct') {
        // 50%:このターン使ったカード枚数×10ダメージ / 50%:枚数×5自分ダメージ
        const success = (state.gamblerSureSuccess && state.gamblerSureSuccess[playerIndex]) || Math.random() < 0.5;
        if (state.gamblerSureSuccess && state.gamblerSureSuccess[playerIndex]) state.gamblerSureSuccess[playerIndex] = false;
        const usedCount = state.field[playerIndex].length;
        if (success) { applyDamageToOpp(usedCount * 10 * dmgMult); }
        else { applySelfDamage(usedCount * 5); }
      } else if (card.effect === 'gb_fate') {
        // 50%:HP最大値50%回復＋20ブロック / 50%:HP残量の半分失う
        const success = (state.gamblerSureSuccess && state.gamblerSureSuccess[playerIndex]) || Math.random() < 0.5;
        if (state.gamblerSureSuccess && state.gamblerSureSuccess[playerIndex]) state.gamblerSureSuccess[playerIndex] = false;
        if (success) {
          state.hp[playerIndex] = Math.min(CG_MAX_HP, state.hp[playerIndex] + Math.floor(CG_MAX_HP * 0.5) * blsMult);
          state.block[playerIndex] += 20 * blsMult;
        } else { applySelfDamage(Math.floor(state.hp[playerIndex] / 2)); }
      } else if (card.effect === 'gb_jackpot') {
        // 10%:相手HP1 / 90%:自分HP1（大穴狙いと同様に特殊確率）
        const success = (state.gamblerSureSuccess && state.gamblerSureSuccess[playerIndex]) || Math.random() < 0.1;
        if (state.gamblerSureSuccess && state.gamblerSureSuccess[playerIndex]) state.gamblerSureSuccess[playerIndex] = false;
        if (success) { state.hp[oppIndex] = 1; state.block[oppIndex] = 0; }
        else { state.hp[playerIndex] = 1; state.block[playerIndex] = 0; state.totalDamageTaken[playerIndex] += CG_MAX_HP - 1; }
      } else if (card.effect === 'gb_combo') {
        // 50%:ランダム大効果3回連続 / 50%:ランダム大デメリット3回連続
        const success = (state.gamblerSureSuccess && state.gamblerSureSuccess[playerIndex]) || Math.random() < 0.5;
        if (state.gamblerSureSuccess && state.gamblerSureSuccess[playerIndex]) state.gamblerSureSuccess[playerIndex] = false;
        if (success) {
          for (let i = 0; i < 3; i++) {
            const r3 = Math.floor(Math.random() * 3);
            if (r3 === 0) applyDamageToOpp(25 * dmgMult);
            else if (r3 === 1) state.block[playerIndex] += 15 * blsMult;
            else state.hp[playerIndex] = Math.min(CG_MAX_HP, state.hp[playerIndex] + 15 * blsMult);
          }
        } else {
          for (let i = 0; i < 3; i++) {
            const r3 = Math.floor(Math.random() * 3);
            if (r3 === 0) applySelfDamage(15);
            else if (r3 === 1) state.block[playerIndex] = Math.max(0, state.block[playerIndex] - 10);
            else if (state.hand[playerIndex].length > 0) {
              const idx = Math.floor(Math.random() * state.hand[playerIndex].length);
              state.discard[playerIndex].push(state.hand[playerIndex].splice(idx, 1)[0]);
            }
          }
        }
      } else if (card.effect === 'gb_mastery') {
        // 次のギャンブルカードを必ず成功させる＋次のターンをスキップする
        state.gamblerSureSuccess[playerIndex] = true;
        state.skipNextTurn[playerIndex] = true;
      } else if (card.effect === 'gb_allin') {
        // 50%:コイン×4ダメージ / 50%:コイン×2自分ダメージ＋コイン全消失
        const success = (state.gamblerSureSuccess && state.gamblerSureSuccess[playerIndex]) || Math.random() < 0.5;
        if (state.gamblerSureSuccess && state.gamblerSureSuccess[playerIndex]) state.gamblerSureSuccess[playerIndex] = false;
        const coins = state.gold[playerIndex];
        if (success) { applyDamageToOpp(coins * 4 * dmgMult); }
        else {
          applySelfDamage(coins * 2);
          state.gold[playerIndex] = 0;
        }
      } else if (card.effect === 'gb_ultimate') {
        // 50%:相手HP1＋50ブロック / 50%:自分HP1＋全手札捨て
        const success = (state.gamblerSureSuccess && state.gamblerSureSuccess[playerIndex]) || Math.random() < 0.5;
        if (state.gamblerSureSuccess && state.gamblerSureSuccess[playerIndex]) state.gamblerSureSuccess[playerIndex] = false;
        if (success) { state.hp[oppIndex] = 1; state.block[oppIndex] = 0; state.block[playerIndex] += 50 * blsMult; }
        else {
          state.hp[playerIndex] = 1;
          state.totalDamageTaken[playerIndex] += CG_MAX_HP - 1;
          state.discard[playerIndex].push(...state.hand[playerIndex]);
          state.hand[playerIndex] = [];
        }

      // ===== アルケミスト固有効果 =====
      } else if (card.effect === 'al_damage') {
        // 指定コインを消費してダメージを与える
        state.gold[playerIndex] -= card.coinCost;
        applyDamageToOpp(card.value * dmgMult);
      } else if (card.effect === 'al_heal') {
        // 指定コインを消費してHP回復する
        state.gold[playerIndex] -= card.coinCost;
        state.hp[playerIndex] = Math.min(CG_MAX_HP, state.hp[playerIndex] + card.value * blsMult);
      } else if (card.effect === 'al_block') {
        // 指定コインを消費してブロックを得る
        state.gold[playerIndex] -= card.coinCost;
        state.block[playerIndex] += card.value * blsMult;
      } else if (card.effect === 'al_catalyst') {
        // 指定コインを消費して次のカードの効果2倍
        state.gold[playerIndex] -= card.coinCost;
        state.amplify[playerIndex] = true;
      } else if (card.effect === 'al_combo') {
        // 指定コインを消費してダメージ＋ブロック
        state.gold[playerIndex] -= card.coinCost;
        applyDamageToOpp(card.value * dmgMult);
        state.block[playerIndex] += card.blockValue * blsMult;
      } else if (card.effect === 'al_elixir') {
        // 指定コインを消費してダメージ＋ブロック＋HP回復
        state.gold[playerIndex] -= card.coinCost;
        applyDamageToOpp(card.value * dmgMult);
        state.block[playerIndex] += card.blockValue * blsMult;
        state.hp[playerIndex] = Math.min(CG_MAX_HP, state.hp[playerIndex] + card.healValue * blsMult);
      } else if (card.effect === 'al_immortal') {
        // 指定コインを消費して次に受けるダメージ無効化＋HP回復
        state.gold[playerIndex] -= card.coinCost;
        state.alImmortal[playerIndex] = true;
        state.hp[playerIndex] = Math.min(CG_MAX_HP, state.hp[playerIndex] + card.healValue * blsMult);
      } else if (card.effect === 'al_magicraft') {
        // 指定コインを消費して残りコイン×2ダメージ
        state.gold[playerIndex] -= card.coinCost;
        applyDamageToOpp(state.gold[playerIndex] * 2 * dmgMult);
      } else if (card.effect === 'al_ultimate') {
        // コイン全消費して消費量×3ダメージ＋HP回復
        const coinUsed = state.gold[playerIndex];
        state.gold[playerIndex] = 0;
        applyDamageToOpp(coinUsed * 3 * dmgMult);
        state.hp[playerIndex] = Math.min(CG_MAX_HP, state.hp[playerIndex] + card.healValue * blsMult);

      // ===== ネクロマンサー固有効果 =====
      } else if (card.effect === 'nc_revive') {
        // 墓地からcard.value枚を手札に戻す
        const reviveCount = Math.min(card.value * blsMult, state.grave[playerIndex].length);
        for (let i = 0; i < reviveCount; i++) {
          const cid = state.grave[playerIndex].pop();
          state.hand[playerIndex].push(cid);
        }
      } else if (card.effect === 'nc_claw') {
        // 4ダメージ（墓地card.threshold枚以上なら+card.bonus）
        const graveLen = state.grave[playerIndex].length;
        const ncClawDmg = (card.value + (graveLen >= card.threshold ? card.bonus : 0)) * dmgMult;
        applyDamageToOpp(ncClawDmg);
      } else if (card.effect === 'nc_gravedmg') {
        // 墓地枚数×card.multダメージ
        applyDamageToOpp(Math.floor(state.grave[playerIndex].length * card.mult) * dmgMult);
      } else if (card.effect === 'nc_lament') {
        // 墓地から最もコストの高いカードを手札に戻す
        if (state.grave[playerIndex].length > 0) {
          let maxCost = -1, maxIdx = 0;
          state.grave[playerIndex].forEach((cid, i) => {
            const c = CARD_DEFS[cid];
            if (c && c.cost > maxCost) { maxCost = c.cost; maxIdx = i; }
          });
          state.hand[playerIndex].push(state.grave[playerIndex].splice(maxIdx, 1)[0]);
        }
      } else if (card.effect === 'nc_specterbuff') {
        // 次に使うカードの効果を墓地枚数×0.3倍にする
        state.specterBuff[playerIndex] = state.grave[playerIndex].length * 0.3;
      } else if (card.effect === 'nc_army') {
        // 墓地を全て手札に戻す
        state.hand[playerIndex].push(...state.grave[playerIndex]);
        state.grave[playerIndex] = [];
      } else if (card.effect === 'nc_souleater') {
        // 墓地5枚消費して20ダメージ
        for (let i = 0; i < card.graveCost; i++) state.grave[playerIndex].pop();
        applyDamageToOpp(card.value * dmgMult);
      } else if (card.effect === 'nc_oath') {
        // 墓地枚数×card.multダメージ＋HP回復
        applyDamageToOpp(Math.floor(state.grave[playerIndex].length * card.mult) * dmgMult);
        state.hp[playerIndex] = Math.min(CG_MAX_HP, state.hp[playerIndex] + card.healValue * blsMult);
      } else if (card.effect === 'nc_explosion') {
        // 墓地を全て消費して消費枚数×card.multダメージ
        const graveCount = state.grave[playerIndex].length;
        state.grave[playerIndex] = [];
        applyDamageToOpp(graveCount * card.mult * dmgMult);
      } else if (card.effect === 'nc_reincarnation') {
        // このターン使ったカードを全て手札に戻す＋コスト合計分マナ獲得
        const fieldCards = [...state.field[playerIndex]];
        state.field[playerIndex] = [];
        let costSum = 0;
        for (const cid of fieldCards) {
          const c = CARD_DEFS[cid];
          if (c) costSum += c.cost;
          state.hand[playerIndex].push(cid);
        }
        state.mana[playerIndex] = Math.min(state.mana[playerIndex] + costSum, state.maxMana[playerIndex] + costSum);
      } else if (card.effect === 'nc_king') {
        // 墓地枚数×card.multダメージ＋同枚数ブロック
        const graveLen = state.grave[playerIndex].length;
        applyDamageToOpp(Math.floor(graveLen * card.mult) * dmgMult);
        state.block[playerIndex] += graveLen * blsMult;
      } else if (card.effect === 'nc_release') {
        // 墓地を全て手札に戻す＋戻した枚数×card.blockMultブロック
        const graveCount = state.grave[playerIndex].length;
        state.hand[playerIndex].push(...state.grave[playerIndex]);
        state.grave[playerIndex] = [];
        state.block[playerIndex] += graveCount * card.blockMult * blsMult;
      } else if (card.effect === 'nc_awakening') {
        // 墓地を全て手札に戻して枚数×card.dmgMultダメージ＋枚数×card.blockMultブロック
        const graveCount = state.grave[playerIndex].length;
        state.hand[playerIndex].push(...state.grave[playerIndex]);
        state.grave[playerIndex] = [];
        applyDamageToOpp(graveCount * card.dmgMult * dmgMult);
        state.block[playerIndex] += graveCount * card.blockMult * blsMult;

      // ===== モンク固有効果 =====
      } else if (card.effect === 'mk_ki') {
        // 気力を増やす
        state.ki[playerIndex] += card.kiGain;
      } else if (card.effect === 'mk_meditate') {
        // 気力増加＋ドロー
        state.ki[playerIndex] += card.kiGain;
        cgDrawCards(state, playerIndex, card.drawValue * blsMult);
      } else if (card.effect === 'mk_kidmg') {
        // 気力を消費してダメージを与える
        state.ki[playerIndex] -= card.kiCost;
        applyDamageToOpp(card.value * dmgMult);
      } else if (card.effect === 'mk_kiblock') {
        // 気力を消費してブロックを得る
        state.ki[playerIndex] -= card.kiCost;
        state.block[playerIndex] += card.value * blsMult;
      } else if (card.effect === 'mk_inner') {
        // 気力増加＋HP回復
        state.ki[playerIndex] += card.kiGain;
        state.hp[playerIndex] = Math.min(CG_MAX_HP, state.hp[playerIndex] + card.healValue * blsMult);
      } else if (card.effect === 'mk_storm') {
        // 気力3消費して3ダメージを最大10回繰り返す
        let hits = 0;
        while (state.ki[playerIndex] >= card.kiCostPerHit && hits < card.maxHits) {
          state.ki[playerIndex] -= card.kiCostPerHit;
          applyDamageToOpp(card.value * dmgMult);
          hits++;
        }
      } else if (card.effect === 'mk_release') {
        // 現在の気力÷5ダメージ＋気力を0にする
        const kiDmg = Math.floor(state.ki[playerIndex] / 5) * dmgMult;
        state.ki[playerIndex] = 0;
        applyDamageToOpp(kiDmg);
      } else if (card.effect === 'mk_godspeed') {
        // 気力を消費してマナを追加する（このターンもう2枚カードを使える）
        state.ki[playerIndex] -= card.kiCost;
        state.mana[playerIndex] += card.manaGain;
      } else if (card.effect === 'mk_mushin') {
        // 気力増加＋次のカードのコストを0にする（隠密フラグを流用）
        state.ki[playerIndex] += card.kiGain;
        state.stealth[playerIndex] = true;
      } else if (card.effect === 'mk_heaven') {
        // 気力を全消費して消費量÷2ダメージ×3回（合計最大100ダメージ）
        const kiUsed = state.ki[playerIndex];
        state.ki[playerIndex] = 0;
        const hitDmg = Math.min(Math.floor(kiUsed / 2), 33) * dmgMult;
        for (let i = 0; i < 3; i++) applyDamageToOpp(hitDmg);
      } else if (card.effect === 'mk_mukyoku') {
        // 気力を全消費して消費量×3ダメージ（上限150）＋消費量÷2ブロック
        const kiUsed = state.ki[playerIndex];
        state.ki[playerIndex] = 0;
        const mkDmg = Math.min(kiUsed * 3, 150) * dmgMult;
        applyDamageToOpp(mkDmg);
        state.block[playerIndex] += Math.floor(kiUsed / 2) * blsMult;

      // ===== カース固有効果 =====
      } else if (card.effect === 'cu_bloodcost') {
        // 自分にselfDmgダメージ＋相手にvalueダメージ
        applySelfDamage(card.selfDmg);
        applyDamageToOpp(card.value * dmgMult);
      } else if (card.effect === 'cu_pain') {
        // HP残量が半分以下ならcard.value、そうでなければcard.lowValueダメージ
        const ratio = state.hp[playerIndex] / CG_MAX_HP;
        applyDamageToOpp((ratio <= 0.5 ? card.value : card.lowValue) * dmgMult);
      } else if (card.effect === 'cu_woundpower') {
        // 失ったHP合計×card.multダメージ
        const lostHp = CG_MAX_HP - state.hp[playerIndex];
        applyDamageToOpp(Math.floor(lostHp * card.mult) * dmgMult);
      } else if (card.effect === 'cu_dyingrage') {
        // HP残量が30%以下ならcard.value、そうでなければcard.lowValueダメージ
        const ratio = state.hp[playerIndex] / CG_MAX_HP;
        applyDamageToOpp((ratio <= 0.3 ? card.value : card.lowValue) * dmgMult);
      } else if (card.effect === 'cu_selfbuff') {
        // 自分にselfDmgダメージ＋次のカードの効果3倍
        applySelfDamage(card.selfDmg);
        state.curseSelfBuff[playerIndex] = true;
      } else if (card.effect === 'cu_cursearmor') {
        // 自分にselfDmgダメージ＋ブロック獲得
        applySelfDamage(card.selfDmg);
        state.block[playerIndex] += card.blockValue * blsMult;
      } else if (card.effect === 'cu_abyss') {
        // HP残量が20%以下ならcard.value、そうでなければcard.lowValueダメージ
        const ratio = state.hp[playerIndex] / CG_MAX_HP;
        applyDamageToOpp((ratio <= 0.2 ? card.value : card.lowValue) * dmgMult);
      } else if (card.effect === 'cu_undying') {
        // このターン致死ダメージを受けてもHP1で耐えるフラグを立てる
        state.undyingGuard[playerIndex] = true;
      } else if (card.effect === 'cu_bloodstorm') {
        // 自分にselfDmgダメージ＋相手にvalueダメージ×hits回
        applySelfDamage(card.selfDmg);
        for (let i = 0; i < card.hits; i++) applyDamageToOpp(card.value * dmgMult);
      } else if (card.effect === 'cu_curserelease') {
        // 失ったHP合計×card.multダメージ＋HP回復
        const lostHp = CG_MAX_HP - state.hp[playerIndex];
        applyDamageToOpp(Math.floor(lostHp * card.mult) * dmgMult);
        state.hp[playerIndex] = Math.min(CG_MAX_HP, state.hp[playerIndex] + card.healValue * blsMult);
      } else if (card.effect === 'cu_deathscythe') {
        // 相手HP残量が10%以下なら相手HP1＋ブロック全消去、そうでなければcard.valueダメージ
        if (state.hp[oppIndex] / CG_MAX_HP <= 0.1) {
          state.hp[oppIndex] = 1;
          state.block[oppIndex] = 0;
        } else {
          applyDamageToOpp(card.value * dmgMult);
        }
      } else if (card.effect === 'cu_ruination') {
        // 現在のHP＋ブロックの半分を失って失った合計×card.multダメージ
        const hpLost = Math.floor(state.hp[playerIndex] / 2);
        const blockLost = Math.floor(state.block[playerIndex] / 2);
        state.hp[playerIndex] = Math.max(1, state.hp[playerIndex] - hpLost);
        state.block[playerIndex] = Math.max(0, state.block[playerIndex] - blockLost);
        state.totalDamageTaken[playerIndex] += hpLost;
        applyDamageToOpp((hpLost + blockLost) * card.mult * dmgMult);
      } else if (card.effect === 'cu_demonking') {
        // 自分HP1になる代わりに相手に100ダメージ
        const prevHp = state.hp[playerIndex];
        state.hp[playerIndex] = 1;
        state.totalDamageTaken[playerIndex] += prevHp - 1;
        applyDamageToOpp(card.value * dmgMult);

      // ===== サモナー固有効果 =====
      } else if (card.effect === 'sm_summon') {
        // 次のターン手札にトークンを追加する
        if (!state.pendingTokens) state.pendingTokens = [[], []];
        state.pendingTokens[playerIndex].push({ tokenId: card.tokenId, count: card.tokenCount });
      } else if (card.effect === 'sm_summon_now') {
        // 今すぐ手札にトークンを追加する
        for (let i = 0; i < card.tokenCount; i++) {
          state.hand[playerIndex].push(card.tokenId);
        }
      } else if (card.effect === 'sm_summonup') {
        // 召喚強化バフを設定する（card.turnsターン間トークン効果2倍）
        if (!state.summonBuff) state.summonBuff = [0, 0];
        state.summonBuff[playerIndex] = card.turns;
      } else if (card.effect === 'sm_infinsum') {
        // 毎ターン開始時にトークンを追加する定期召喚を登録する
        if (!state.recurringTokens) state.recurringTokens = [[], []];
        state.recurringTokens[playerIndex].push({ tokenId: card.tokenId, count: card.tokenCount, turns: card.turns });
      } else if (card.effect === 'sm_sumexplosion') {
        // 手札のトークンを全て消費して枚数×card.valueダメージ
        const tokenIndices = [];
        state.hand[playerIndex].forEach((cid, i) => {
          if (CARD_DEFS[cid] && CARD_DEFS[cid].isToken) tokenIndices.push(i);
        });
        const tokenCount = tokenIndices.length;
        tokenIndices.reverse().forEach(i => {
          state.discard[playerIndex].push(state.hand[playerIndex].splice(i, 1)[0]);
        });
        applyDamageToOpp(tokenCount * card.value * dmgMult);
      } else if (card.effect === 'sm_legionrelease') {
        // 手札のトークンを全て即発動する
        const tokenIndices = [];
        state.hand[playerIndex].forEach((cid, i) => {
          if (CARD_DEFS[cid] && CARD_DEFS[cid].isToken) tokenIndices.push(i);
        });
        tokenIndices.reverse().forEach(i => {
          const cid = state.hand[playerIndex].splice(i, 1)[0];
          const tc = CARD_DEFS[cid];
          state.field[playerIndex].push(cid);
          if (!tc) return;
          const tMult = (state.summonBuff && state.summonBuff[playerIndex] > 0) ? 2 : 1;
          if (tc.effect === 'damage') applyDamageToOpp(tc.value * tMult * dmgMult);
          else if (tc.effect === 'block') state.block[playerIndex] += tc.value * tMult * blsMult;
          else if (tc.effect === 'heal') state.hp[playerIndex] = Math.min(CG_MAX_HP, state.hp[playerIndex] + tc.value * tMult * blsMult);
          else if (tc.effect === 'shieldbash') {
            applyDamageToOpp(tc.value * tMult * dmgMult);
            state.block[playerIndex] += tc.blockValue * tMult * blsMult;
          }
        });
      } else if (card.effect === 'sm_ultimate') {
        // 今すぐ手札にトークン10枚追加して手札の全トークン（既存含む）を即発動する
        for (let i = 0; i < card.tokenCount; i++) {
          state.hand[playerIndex].push(card.tokenId);
        }
        const tokenIndices = [];
        state.hand[playerIndex].forEach((cid, i) => {
          if (CARD_DEFS[cid] && CARD_DEFS[cid].isToken) tokenIndices.push(i);
        });
        tokenIndices.reverse().forEach(i => {
          const cid = state.hand[playerIndex].splice(i, 1)[0];
          const tc = CARD_DEFS[cid];
          state.field[playerIndex].push(cid);
          if (!tc) return;
          const tMult = (state.summonBuff && state.summonBuff[playerIndex] > 0) ? 2 : 1;
          if (tc.effect === 'damage') applyDamageToOpp(tc.value * tMult * dmgMult);
          else if (tc.effect === 'block') state.block[playerIndex] += tc.value * tMult * blsMult;
          else if (tc.effect === 'heal') state.hp[playerIndex] = Math.min(CG_MAX_HP, state.hp[playerIndex] + tc.value * tMult * blsMult);
          else if (tc.effect === 'shieldbash') {
            applyDamageToOpp(tc.value * tMult * dmgMult);
            state.block[playerIndex] += tc.blockValue * tMult * blsMult;
          }
        });
      }
    }

    // HP0を含む最新状態をクライアントへ送信するだけにする（勝敗の確定はクライアントからのcgGameOver通知で行う）
    sendCGState(room);
  });

  // カードゲームのゲームオーバー通知を受け取り勝敗を両プレイヤーへ通知する（テトリスのgameOverと同じ方式）
  socket.on('cgGameOver', () => {
    const meta = cgSocketMeta.get(socket.id);
    if (!meta) return;

    const room = cgRooms.get(meta.roomId);
    if (!room || room.players.length < 2 || room.resultSent) return;

    // 最初にHP0を検知して通知してきたプレイヤーが負け
    room.resultSent = true;
    io.to(socket.id).emit('cgResult', { win: false });
    room.players.forEach((socketId) => {
      if (socketId !== socket.id) {
        io.to(socketId).emit('cgResult', { win: true });
      }
    });
  });

  // ターン終了処理（手札・フィールドを捨て札へ移動しショップフェーズへ移行する）
  socket.on('cgEndTurn', () => {
    const meta = cgSocketMeta.get(socket.id);
    if (!meta) return;

    const room = cgRooms.get(meta.roomId);
    if (!room || !room.state || room.resultSent) return;

    const state = room.state;
    const playerIndex = meta.playerNumber - 1;

    if (state.activePlayer !== playerIndex || state.phase !== 'play') return;

    // 手札とフィールドのカードをすべて捨て札に移動する
    // ネクロマンサーの場合はフィールドのカードを捨て札ではなく墓地へ送る
    if (state.jobs[playerIndex] === 'necromancer') {
      state.grave[playerIndex].push(...state.field[playerIndex]);
      state.discard[playerIndex].push(...state.hand[playerIndex]);
    } else {
      state.discard[playerIndex].push(...state.hand[playerIndex], ...state.field[playerIndex]);
    }
    state.hand[playerIndex] = [];
    state.field[playerIndex] = [];

    // ショップフェーズへ移行する
    state.phase = 'shop';
    state.shop = generateCGShop(state.jobs[playerIndex]);

    sendCGState(room);
  });

  // カードを購入する処理（ゴールドを消費してデッキにカードを加える）
  socket.on('cgBuyCard', (payload) => {
    const meta = cgSocketMeta.get(socket.id);
    if (!meta) return;

    const room = cgRooms.get(meta.roomId);
    if (!room || !room.state || room.resultSent) return;

    const state = room.state;
    const playerIndex = meta.playerNumber - 1;

    if (state.activePlayer !== playerIndex || state.phase !== 'shop') return;

    const shopIndex = Number(payload?.shopIndex);
    if (!Number.isInteger(shopIndex) || shopIndex < 0 || shopIndex >= state.shop.length) return;

    const cardId = state.shop[shopIndex];
    const card = CARD_DEFS[cardId];
    if (!card) return;

    // ゴールドが足りているか確認する
    if (state.gold[playerIndex] < card.shopCost) return;

    // カードを購入しデッキに直接追加する
    state.gold[playerIndex] -= card.shopCost;
    state.deck[playerIndex].push(cardId);
    state.shop.splice(shopIndex, 1);

    sendCGState(room);
  });

  // デッキ・手札・捨て札からカードを1枚削除する処理
  socket.on('cgTrashCard', (payload) => {
    const meta = cgSocketMeta.get(socket.id);
    if (!meta) return;

    const room = cgRooms.get(meta.roomId);
    if (!room || !room.state || room.resultSent) return;

    const state = room.state;
    const playerIndex = meta.playerNumber - 1;

    // ショップフェーズかつ自分のターンであることを確認する
    if (state.activePlayer !== playerIndex || state.phase !== 'shop') return;

    // 削除コストが足りているか確認する
    const cost = state.trashCost[playerIndex];
    if (state.gold[playerIndex] < cost) return;

    const source = payload?.source;
    const cardIndex = Number(payload?.cardIndex);
    if (!Number.isInteger(cardIndex) || cardIndex < 0) return;

    // 指定されたソースから対象カードを削除する
    let removed = false;
    if (source === 'hand') {
      if (cardIndex >= state.hand[playerIndex].length) return;
      state.hand[playerIndex].splice(cardIndex, 1);
      removed = true;
    } else if (source === 'deck') {
      if (cardIndex >= state.deck[playerIndex].length) return;
      state.deck[playerIndex].splice(cardIndex, 1);
      removed = true;
    } else if (source === 'discard') {
      if (cardIndex >= state.discard[playerIndex].length) return;
      state.discard[playerIndex].splice(cardIndex, 1);
      removed = true;
    }

    if (!removed) return;

    // ゴールドを消費し削除回数・削除コストを更新する
    state.gold[playerIndex] -= cost;
    state.trashCount[playerIndex] += 1;
    state.trashCost[playerIndex] += 5;

    sendCGState(room);
  });

  // ショップをスキップして相手のターンへ移行する処理
  socket.on('cgSkipShop', () => {
    const meta = cgSocketMeta.get(socket.id);
    if (!meta) return;

    const room = cgRooms.get(meta.roomId);
    if (!room || !room.state || room.resultSent) return;

    const state = room.state;
    const playerIndex = meta.playerNumber - 1;

    if (state.activePlayer !== playerIndex || state.phase !== 'shop') return;

    // 相手のターンを開始する
    const nextPlayer = 1 - playerIndex;
    state.activePlayer = nextPlayer;
    state.phase = 'play';
    state.shop = [];
    cgStartTurn(state, nextPlayer);

    // ギャンブラー賭博師の奥義：スキップフラグが立っている場合は自動的にターン終了する
    if (state.skipNextTurn && state.skipNextTurn[nextPlayer]) {
      state.skipNextTurn[nextPlayer] = false;
      // 手札とフィールドを捨て札へ移動してショップフェーズへ
      if (state.jobs[nextPlayer] === 'necromancer') {
        state.grave[nextPlayer].push(...state.field[nextPlayer]);
        state.discard[nextPlayer].push(...state.hand[nextPlayer]);
      } else {
        state.discard[nextPlayer].push(...state.hand[nextPlayer], ...state.field[nextPlayer]);
      }
      state.hand[nextPlayer] = [];
      state.field[nextPlayer] = [];
      // さらに相手（元のプレイヤー）のターンを開始する
      const nextNext = 1 - nextPlayer;
      state.activePlayer = nextNext;
      state.phase = 'play';
      cgStartTurn(state, nextNext);
    }

    if (state.hp[nextPlayer] <= 0 || state.hp[1 - nextPlayer] <= 0) {
      room.resultSent = true;
      const p0win = state.hp[1] <= 0;
      io.to(room.players[0]).emit('cgResult', { win: p0win });
      io.to(room.players[1]).emit('cgResult', { win: !p0win });
      return;
    }

    sendCGState(room);
  });

  // ゲームオーバー通知を受け取り勝敗を両プレイヤーへ通知する（テトリスのgameOverと同じ方式）
  socket.on('cgGameOver', () => {
    const meta = cgSocketMeta.get(socket.id);
    if (!meta) return;

    const room = cgRooms.get(meta.roomId);
    if (!room || room.players.length < 2 || room.resultSent) return;

    // 最初にゲームオーバーになったプレイヤーが負け
    room.resultSent = true;
    io.to(socket.id).emit('cgResult', { win: false });
    room.players.forEach((socketId) => {
      if (socketId !== socket.id) {
        io.to(socketId).emit('cgResult', { win: true });
      }
    });
  });

  // カードゲームロビーへ戻る際にルームから退出させる
  socket.on('cgLeaveRoom', () => {
    leaveCGRoom(socket);
  });

  // 予知（scry）選択処理（デッキトップ3枚から1枚を選んで手札に加える）
  socket.on('cgScryPick', (payload) => {
    const meta = cgSocketMeta.get(socket.id);
    if (!meta) return;

    const room = cgRooms.get(meta.roomId);
    if (!room || !room.state || room.resultSent) return;

    const state = room.state;
    const playerIndex = meta.playerNumber - 1;

    // 自分のターンのプレイフェーズ中かつ選択待ちカードが存在することを確認する
    if (state.activePlayer !== playerIndex || state.phase !== 'play') return;
    const scryCards = state.scryCards[playerIndex];
    if (!scryCards || scryCards.length === 0) return;

    const chosen = Number(payload?.chosen);
    if (!Number.isInteger(chosen) || chosen < 0 || chosen >= scryCards.length) return;

    // 選択したカードを手札に加え、残りを捨て札へ移動する
    scryCards.forEach((cardId, i) => {
      if (i === chosen) {
        state.hand[playerIndex].push(cardId);
      } else {
        state.discard[playerIndex].push(cardId);
      }
    });
    state.scryCards[playerIndex] = null;

    sendCGState(room);
  });

  // 切断時に部屋の状態を整理する
  socket.on("disconnect", () => {
    leaveCurrentRoom(socket);
    leaveBBRoom(socket);
    leaveTypingRoom(socket);
    leaveCGRoom(socket);
  });
});

// Railway対応のポートで起動する
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`サーバー起動: ${PORT}`);
});
