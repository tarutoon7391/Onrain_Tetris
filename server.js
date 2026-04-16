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

  // 切断時に部屋の状態を整理する
  socket.on("disconnect", () => {
    leaveCurrentRoom(socket);
    leaveBBRoom(socket);
    leaveTypingRoom(socket);
  });
});

// Railway対応のポートで起動する
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`サーバー起動: ${PORT}`);
});
