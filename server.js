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

// タイピングバトルで使用する長文テキストリスト
// text: 表示用原文, reading: タイピング用ローマ字,
// words: ルビ表示用の単語配列（{text: 表示文字列, reading: ひらがな}）
const TYPING_TEXTS = [
  {
    text: "吾輩は猫である。名前はまだない。どこで生れたかとんと見当がつかぬ。何でも薄暗いじめじめした所でニャーニャー泣いていた事だけは記憶している。",
    reading: "wagahaihanekodearu.namaehamadanai.dokodeumaretakatontokentougatsukanu.nandemousuguraijimejimeshitatokorodenyaanyaanaiteitakotodakehakiokushiteiru.",
    words: [
      {text:"吾輩",reading:"わがはい"},{text:"は",reading:"は"},
      {text:"猫",reading:"ねこ"},{text:"である",reading:"である"},{text:"。",reading:"。"},
      {text:"名前",reading:"なまえ"},{text:"は",reading:"は"},{text:"まだない",reading:"まだない"},{text:"。",reading:"。"},
      {text:"どこで",reading:"どこで"},{text:"生れた",reading:"うまれた"},{text:"かとんと",reading:"かとんと"},
      {text:"見当",reading:"けんとう"},{text:"がつかぬ",reading:"がつかぬ"},{text:"。",reading:"。"},
      {text:"何でも",reading:"なんでも"},{text:"薄暗い",reading:"うすぐらい"},
      {text:"じめじめした",reading:"じめじめした"},{text:"所で",reading:"ところで"},
      {text:"ニャーニャー",reading:"にゃあにゃあ"},{text:"泣いていた",reading:"ないていた"},
      {text:"事だけは",reading:"ことだけは"},{text:"記憶している",reading:"きおくしている"},{text:"。",reading:"。"},
    ],
  },
  {
    text: "国境の長いトンネルを抜けると雪国であった。夜の底が白くなった。信号所に汽車が止まった。向側の座席から娘が立って来て、島村の前のガラス窓を落とした。",
    reading: "kokkyounonagaitonneruwonukerutoyukigunideatta.yorunosokogashirokunatta.shingoujonikishagatomatta.mukougawanozasekikaramusumegatattekite,shimamuranomaenogarasumadowootoshita.",
    words: [
      {text:"国境",reading:"こっきょう"},{text:"の",reading:"の"},{text:"長い",reading:"ながい"},
      {text:"トンネル",reading:"とんねる"},{text:"を",reading:"を"},{text:"抜ける",reading:"ぬける"},
      {text:"と",reading:"と"},{text:"雪国",reading:"ゆきぐに"},{text:"であった",reading:"であった"},{text:"。",reading:"。"},
      {text:"夜",reading:"よる"},{text:"の",reading:"の"},{text:"底",reading:"そこ"},{text:"が",reading:"が"},
      {text:"白く",reading:"しろく"},{text:"なった",reading:"なった"},{text:"。",reading:"。"},
      {text:"信号所",reading:"しんごうじょ"},{text:"に",reading:"に"},{text:"汽車",reading:"きしゃ"},
      {text:"が",reading:"が"},{text:"止まった",reading:"とまった"},{text:"。",reading:"。"},
      {text:"向側",reading:"むこうがわ"},{text:"の",reading:"の"},{text:"座席",reading:"ざせき"},
      {text:"から",reading:"から"},{text:"娘",reading:"むすめ"},{text:"が",reading:"が"},
      {text:"立って来て",reading:"たってきて"},{text:"、",reading:"、"},
      {text:"島村",reading:"しまむら"},{text:"の",reading:"の"},{text:"前",reading:"まえ"},{text:"の",reading:"の"},
      {text:"ガラス窓",reading:"がらすまど"},{text:"を",reading:"を"},{text:"落とした",reading:"おとした"},{text:"。",reading:"。"},
    ],
  },
  {
    text: "山路を登りながら、こう考えた。智に働けば角が立つ。情に棹させば流される。意地を通せば窮屈だ。とかくに人の世は住みにくい。",
    reading: "yamajiwonoborinagara,koukangaeta.chinihatarakebakadogatatsu.jounisaosasebanagasareru.ijiwotoosebakyuukutsuda.tokakunihitonoyohasuminikui.",
    words: [
      {text:"山路",reading:"やまじ"},{text:"を",reading:"を"},{text:"登りながら",reading:"のぼりながら"},{text:"、",reading:"、"},
      {text:"こう",reading:"こう"},{text:"考えた",reading:"かんがえた"},{text:"。",reading:"。"},
      {text:"智",reading:"ち"},{text:"に",reading:"に"},{text:"働けば",reading:"はたらけば"},
      {text:"角",reading:"かど"},{text:"が",reading:"が"},{text:"立つ",reading:"たつ"},{text:"。",reading:"。"},
      {text:"情",reading:"じょう"},{text:"に",reading:"に"},{text:"棹させば",reading:"さおさせば"},
      {text:"流される",reading:"ながされる"},{text:"。",reading:"。"},
      {text:"意地",reading:"いじ"},{text:"を",reading:"を"},{text:"通せば",reading:"とおせば"},
      {text:"窮屈",reading:"きゅうくつ"},{text:"だ",reading:"だ"},{text:"。",reading:"。"},
      {text:"とかくに",reading:"とかくに"},{text:"人",reading:"ひと"},{text:"の",reading:"の"},
      {text:"世",reading:"よ"},{text:"は",reading:"は"},{text:"住みにくい",reading:"すみにくい"},{text:"。",reading:"。"},
    ],
  },
  {
    text: "メロスは激怒した。必ず、かの邪智暴虐の王を除かなければならぬと決意した。メロスには政治がわからぬ。メロスは、村の牧人である。",
    reading: "merosuhagekidoshita.kanarazu,kanojachibougyakunoouwonozokanakerebanaranutoketsuishita.merosunihaseijigawakaranu.merosuha,muranobokujindearu.",
    words: [
      {text:"メロス",reading:"めろす"},{text:"は",reading:"は"},{text:"激怒",reading:"げきど"},
      {text:"した",reading:"した"},{text:"。",reading:"。"},
      {text:"必ず",reading:"かならず"},{text:"、",reading:"、"},
      {text:"かの",reading:"かの"},{text:"邪智暴虐",reading:"じゃちぼうぎゃく"},{text:"の",reading:"の"},
      {text:"王",reading:"おう"},{text:"を",reading:"を"},
      {text:"除かなければならぬ",reading:"のぞかなければならぬ"},
      {text:"と",reading:"と"},{text:"決意した",reading:"けついした"},{text:"。",reading:"。"},
      {text:"メロス",reading:"めろす"},{text:"には",reading:"には"},
      {text:"政治",reading:"せいじ"},{text:"が",reading:"が"},{text:"わからぬ",reading:"わからぬ"},{text:"。",reading:"。"},
      {text:"メロス",reading:"めろす"},{text:"は",reading:"は"},{text:"、",reading:"、"},
      {text:"村",reading:"むら"},{text:"の",reading:"の"},{text:"牧人",reading:"ぼくじん"},
      {text:"である",reading:"である"},{text:"。",reading:"。"},
    ],
  },
  {
    text: "親譲りの無鉄砲で子供の時から損ばかりしている。小学校にいる時分学校の二階から飛び降りて一週間ほど腰を抜かした事がある。",
    reading: "oyayuzurinomuteppoudekodomonotokikarasonbakarishiteiru.shougakkouniirujibungakkounonikaikaratobioriteisshuukanhodokoshiwonukashitakotogaaru.",
    words: [
      {text:"親譲り",reading:"おやゆずり"},{text:"の",reading:"の"},{text:"無鉄砲",reading:"むてっぽう"},
      {text:"で",reading:"で"},{text:"子供",reading:"こども"},{text:"の",reading:"の"},
      {text:"時",reading:"とき"},{text:"から",reading:"から"},{text:"損ばかり",reading:"そんばかり"},
      {text:"している",reading:"している"},{text:"。",reading:"。"},
      {text:"小学校",reading:"しょうがっこう"},{text:"に",reading:"に"},{text:"いる",reading:"いる"},
      {text:"時分",reading:"じぶん"},{text:"学校",reading:"がっこう"},{text:"の",reading:"の"},
      {text:"二階",reading:"にかい"},{text:"から",reading:"から"},{text:"飛び降りて",reading:"とびおりて"},
      {text:"一週間",reading:"いっしゅうかん"},{text:"ほど",reading:"ほど"},
      {text:"腰",reading:"こし"},{text:"を",reading:"を"},{text:"抜かした",reading:"ぬかした"},
      {text:"事",reading:"こと"},{text:"が",reading:"が"},{text:"ある",reading:"ある"},{text:"。",reading:"。"},
    ],
  },
  {
    text: "花は盛りに、月は隈なきをのみ見るものかは。雨に向かひて月を恋ひ、垂れこめて春の行方知らぬも、なほ哀れに情け深し。",
    reading: "hanahasakarini,tsukihakumanakiwonomimirumonokaha.amenimukahitetsukiwokohi,tarekometeharunoyukueshiranumo,nahoawarenikokorofukashi.",
    words: [
      {text:"花",reading:"はな"},{text:"は",reading:"は"},{text:"盛り",reading:"さかり"},{text:"に",reading:"に"},{text:"、",reading:"、"},
      {text:"月",reading:"つき"},{text:"は",reading:"は"},{text:"隈なき",reading:"くまなき"},{text:"を",reading:"を"},
      {text:"のみ",reading:"のみ"},{text:"見るものかは",reading:"みるものかは"},{text:"。",reading:"。"},
      {text:"雨",reading:"あめ"},{text:"に",reading:"に"},{text:"向かひて",reading:"むかひて"},
      {text:"月",reading:"つき"},{text:"を",reading:"を"},{text:"恋ひ",reading:"こひ"},{text:"、",reading:"、"},
      {text:"垂れこめて",reading:"たれこめて"},{text:"春",reading:"はる"},{text:"の",reading:"の"},
      {text:"行方",reading:"ゆくえ"},{text:"知らぬも",reading:"しらぬも"},{text:"、",reading:"、"},
      {text:"なほ",reading:"なほ"},{text:"哀れに",reading:"あわれに"},
      {text:"情け深し",reading:"こころふかし"},{text:"。",reading:"。"},
    ],
  },
  {
    text: "祇園精舎の鐘の声、諸行無常の響きあり。娑羅双樹の花の色、盛者必衰の理をあらはす。おごれる人も久しからず、ただ春の夜の夢のごとし。",
    reading: "gionshoujanokanenokoe,shogyoumujounohibikiari.sharasoujunohananoiro,joushahissuinokotowariwoarahasu.ogoreruhitomohisashikarazu,tadaharunoyonoyumenogotoshi.",
    words: [
      {text:"祇園精舎",reading:"ぎおんしょうじゃ"},{text:"の",reading:"の"},
      {text:"鐘",reading:"かね"},{text:"の",reading:"の"},{text:"声",reading:"こえ"},{text:"、",reading:"、"},
      {text:"諸行無常",reading:"しょぎょうむじょう"},{text:"の",reading:"の"},
      {text:"響き",reading:"ひびき"},{text:"あり",reading:"あり"},{text:"。",reading:"。"},
      {text:"娑羅双樹",reading:"しゃらそうじゅ"},{text:"の",reading:"の"},
      {text:"花",reading:"はな"},{text:"の",reading:"の"},{text:"色",reading:"いろ"},{text:"、",reading:"、"},
      {text:"盛者必衰",reading:"じょうしゃひっすい"},{text:"の",reading:"の"},
      {text:"理",reading:"ことわり"},{text:"を",reading:"を"},{text:"あらはす",reading:"あらはす"},{text:"。",reading:"。"},
      {text:"おごれる",reading:"おごれる"},{text:"人",reading:"ひと"},{text:"も",reading:"も"},
      {text:"久しからず",reading:"ひさしからず"},{text:"、",reading:"、"},
      {text:"ただ",reading:"ただ"},{text:"春",reading:"はる"},{text:"の",reading:"の"},
      {text:"夜",reading:"よ"},{text:"の",reading:"の"},{text:"夢",reading:"ゆめ"},{text:"の",reading:"の"},
      {text:"ごとし",reading:"ごとし"},{text:"。",reading:"。"},
    ],
  },
  {
    text: "木曾路はすべて山の中である。あるところは岨づたいに行く崖の道であり、あるところは数十間の深さに臨む木曾川の岸であり、あるところは山の尾をめぐる谷の入り口である。",
    reading: "kisojihasubeteyamanonakadearu.arutokorohasobadutainiikugakenomichideari,arutokorohasuujikkennofukasaninozomukisogawanokishideari,arutokorohayamanoowomegurutaninoiriguchidearu.",
    words: [
      {text:"木曾路",reading:"きそじ"},{text:"は",reading:"は"},{text:"すべて",reading:"すべて"},
      {text:"山",reading:"やま"},{text:"の",reading:"の"},{text:"中",reading:"なか"},
      {text:"である",reading:"である"},{text:"。",reading:"。"},
      {text:"あるところは",reading:"あるところは"},{text:"岨づたい",reading:"そばづたい"},
      {text:"に",reading:"に"},{text:"行く",reading:"いく"},{text:"崖",reading:"がけ"},{text:"の",reading:"の"},
      {text:"道",reading:"みち"},{text:"であり",reading:"であり"},{text:"、",reading:"、"},
      {text:"あるところは",reading:"あるところは"},{text:"数十間",reading:"すうじっけん"},
      {text:"の",reading:"の"},{text:"深さ",reading:"ふかさ"},{text:"に",reading:"に"},
      {text:"臨む",reading:"のぞむ"},{text:"木曾川",reading:"きそがわ"},{text:"の",reading:"の"},
      {text:"岸",reading:"きし"},{text:"であり",reading:"であり"},{text:"、",reading:"、"},
      {text:"あるところは",reading:"あるところは"},{text:"山",reading:"やま"},{text:"の",reading:"の"},
      {text:"尾",reading:"お"},{text:"を",reading:"を"},{text:"めぐる",reading:"めぐる"},
      {text:"谷",reading:"たに"},{text:"の",reading:"の"},{text:"入り口",reading:"いりぐち"},
      {text:"である",reading:"である"},{text:"。",reading:"。"},
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
    words: entry.words || [],
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
        words: room.words,
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
