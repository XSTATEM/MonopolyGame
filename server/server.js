const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const engine = require("./public/engine.js");
const users = require("./users.js");

function fmt(n) { return "$" + Math.round(n).toLocaleString("ru-RU"); }

// ---------------------------------------------------------------------
// Room registry — сетевой слой поверх engine.js (правила игры живут там).
// ---------------------------------------------------------------------
const TRADE_WINDOW_MS = Number(process.env.TRADE_WINDOW_MS) || engine.DEFAULT_TRADE_WINDOW_MS; // окно свободных торгов по умолчанию для новых комнат
const ALLOWED_TRADE_WINDOWS = [30000, 90000, 180000];
const rooms = new Map(); // code -> room
const connections = new Map(); // ws -> {roomCode, playerId, name}

function getOrCreateRoom(code, tradeWindowMs) {
  if (!rooms.has(code)) rooms.set(code, engine.freshRoom(code, tradeWindowMs || TRADE_WINDOW_MS));
  return rooms.get(code);
}
function requireRoom(conn) { return rooms.get(conn.roomCode); }

// ---------------------------------------------------------------------
// Таймер фазы торгов — чисто сетевая обвязка вокруг engine (движок сам
// таймеров не заводит, чтобы одинаково работать и офлайн в браузере).
// ---------------------------------------------------------------------
function syncTradeTimer(room) {
  if (room.phase === "trade" && room.tradeWindowEndsAt) {
    const ms = Math.max(0, room.tradeWindowEndsAt - Date.now());
    if (room.tradeTimer) clearTimeout(room.tradeTimer);
    room.tradeTimer = setTimeout(() => {
      engine.endTradeWindow(room);
      syncTradeTimer(room);
      broadcast(room);
    }, ms);
  } else if (room.tradeTimer) {
    clearTimeout(room.tradeTimer);
    room.tradeTimer = null;
  }
}

// ---------------------------------------------------------------------
// WS helpers
// ---------------------------------------------------------------------
function sendTo(ws, obj) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); }
function sendError(conn, message) { sendTo(conn.ws, { type: "error", message }); }

function broadcast(room) {
  for (const [ws, conn] of connections) {
    if (conn.roomCode === room.code && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(engine.buildStatePayload(room, conn.playerId)));
    }
  }
}

// Универсальный раннер: вызывает engine-функцию, при ошибке шлёт sendError,
// иначе (или если stillChanged) рассылает новое состояние всем в комнате.
function run(conn, result) {
  if (result && result.error) {
    sendError(conn, result.error);
    if (!result.stillChanged) return;
  }
  const room = requireRoom(conn);
  if (room) { syncTradeTimer(room); syncAccountPoints(room); broadcast(room); }
}

// Победа в игре начисляет очки на persistent-аккаунт игрока (engine.js лишь
// один раз выставляет room.lastGamePointsAward — здесь мы это подхватываем
// и дописываем в users.json, а в комнате освежаем отображаемую сумму).
function syncAccountPoints(room) {
  const award = room.lastGamePointsAward;
  if (!award) return;
  room.lastGamePointsAward = null;
  for (const [, c] of connections) {
    if (c.roomCode === room.code && c.playerId === award.playerId && c.accountUsername) {
      const total = users.addPoints(c.accountUsername, award.amount);
      const p = room.players.find((x) => x.id === award.playerId);
      if (p && total != null) p.points = total;
      break;
    }
  }
}

// Вход в комнату теперь требует аккаунт: ник — это логин, доступ к нему
// закрыт паролем (scrypt-хэш в users.js), чтобы прогресс/очки нельзя было
// присвоить или потерять, просто зная чужой ник.
function handleJoin(ws, msg) {
  const code = String(msg.room || "MAIN").trim().toUpperCase().slice(0, 20) || "MAIN";
  const authMode = msg.authMode === "register" ? "register" : "login";
  const username = String(msg.username || "").trim().slice(0, 20);
  const password = String(msg.password || "");
  if (!username) return sendTo(ws, { type: "error", message: "Введите ник." });
  if (!password) return sendTo(ws, { type: "error", message: "Введите пароль." });

  const authResult = authMode === "register"
    ? users.register(username, password, msg.gender, msg.avatar)
    : users.login(username, password);
  if (authResult.error) return sendTo(ws, { type: "error", message: authResult.error });
  const profile = authResult.user;

  const isNew = !rooms.has(code);
  const twm = ALLOWED_TRADE_WINDOWS.includes(Number(msg.tradeWindowMs)) ? Number(msg.tradeWindowMs) : undefined;
  const room = isNew ? getOrCreateRoom(code, twm) : getOrCreateRoom(code);

  const result = engine.addPlayer(room, profile.username, profile.gender, profile.avatar, profile.points, profile.equippedBoardSkin);
  if (result.error) return sendTo(ws, { type: "error", message: result.error });

  connections.set(ws, { ws, roomCode: code, playerId: result.player.id, name: profile.username, accountUsername: profile.username });
  sendTo(ws, { type: "joined", playerId: result.player.id, room: code });
  syncTradeTimer(room);
  broadcast(room);
}

function handleMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  if (msg.type === "join") return handleJoin(ws, msg);
  const conn = connections.get(ws);
  if (!conn) return sendTo(ws, { type: "error", message: "Сначала присоединитесь к комнате." });
  const room = requireRoom(conn);

  switch (msg.type) {
    case "roll": return run(conn, engine.rollDice(room, conn.playerId));
    case "buyFromRoll": return run(conn, engine.buyFromRoll(room, conn.playerId, msg.pct));
    case "dividendFromRoll": return run(conn, engine.dividendFromRoll(room, conn.playerId));
    case "setForcedPrice": return run(conn, engine.setForcedPrice(room, conn.playerId, msg.amount));
    case "payForcedPrice": return run(conn, engine.payForcedPrice(room, conn.playerId));
    case "skipRoll": return run(conn, engine.skipRoll(room, conn.playerId));
    case "readyEndTrade": return run(conn, engine.readyEndTradeWindow(room, conn.playerId));
    case "buyBank": return run(conn, engine.buyBank());
    case "sellBank": return run(conn, engine.sellBank(room, conn.playerId, msg.ticker, msg.pct));
    case "proposeTrade": return run(conn, engine.proposeTrade(room, conn.playerId, msg.to, msg.ticker, msg.pct, msg.price));
    case "respondTrade": return run(conn, engine.respondTrade(room, conn.playerId, msg.id, msg.accept));
    case "declareBankruptcy": return run(conn, engine.declareBankruptcy(room, conn.playerId));
    case "newGame": return handleNewGame(conn);
    case "startGame": return run(conn, engine.startGame(room, conn.playerId));
    case "chat": return run(conn, engine.sendChatMessage(room, conn.playerId, msg.text));
    case "forceEvent": return run(conn, engine.forceEvent(room));
    case "ctrlNegativeInfo": return run(conn, engine.ctrlNegativeInfo(room, conn.playerId, msg.ticker));
    case "ctrlPrCampaign": return run(conn, engine.ctrlPrCampaign(room, conn.playerId, msg.ticker));
    case "ctrlInsiderPeek": {
      const result = engine.ctrlInsiderPeek(room, conn.playerId);
      if (result.error) { sendError(conn, result.error); return; }
      sendTo(ws, { type: "insiderCard", card: result.card });
      syncTradeTimer(room);
      broadcast(room);
      return;
    }
    case "ctrlInsiderResolve": return run(conn, engine.ctrlInsiderResolve(room, conn.playerId, msg.action));
    case "ctrlSqueezeOut": return run(conn, engine.ctrlSqueezeOut(room, conn.playerId, msg.ticker));
    case "ctrlShort": return run(conn, engine.ctrlShort(room, conn.playerId, msg.ticker));
    case "takeLoan": return run(conn, engine.takeLoan(room, conn.playerId, msg.amount));
    case "repayLoan": return run(conn, engine.repayLoan(room, conn.playerId, msg.amount));
    case "buyRealEstateFromRoll": return run(conn, engine.buyRealEstateFromRoll(room, conn.playerId));
    case "upgradeRealEstateFromRoll": return run(conn, engine.upgradeRealEstateFromRoll(room, conn.playerId));
    case "payRealEstateRentFromRoll": return run(conn, engine.payRealEstateRentFromRoll(room, conn.playerId));
    case "ctrlEspionage": return run(conn, engine.ctrlEspionage(room, conn.playerId, msg.target));
    case "ctrlDiscredit": return run(conn, engine.ctrlDiscredit(room, conn.playerId, msg.target));
    case "ctrlInvestigate": return run(conn, engine.ctrlInvestigate(room, conn.playerId));
  }
}

function handleNewGame(conn) {
  const room = requireRoom(conn);
  if (!room) return;
  if (room.tradeTimer) { clearTimeout(room.tradeTimer); room.tradeTimer = null; }
  const fresh = engine.newGameKeepPlayers(room);
  rooms.set(room.code, fresh);
  for (const [, c] of connections) {
    if (c.roomCode === room.code) {
      const np = fresh.players.find((p) => p.name === c.name);
      if (np) c.playerId = np.id;
    }
  }
  syncTradeTimer(fresh);
  broadcast(fresh);
}

// ---------------------------------------------------------------------
// HTTP + WS server
// ---------------------------------------------------------------------
const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".ico": "image/x-icon" };

// Читает и парсит JSON-тело POST-запроса (без внешних зависимостей типа
// body-parser — сервер намеренно минималистичный, только встроенный http).
function readJsonBody(req, maxLen) {
  return new Promise((resolve, reject) => {
    let data = "";
    let len = 0;
    req.on("data", (chunk) => {
      len += chunk.length;
      if (len > (maxLen || 1000000)) { reject(new Error("Тело запроса слишком большое.")); req.destroy(); return; }
      data += chunk;
    });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error("Некорректный JSON.")); }
    });
    req.on("error", reject);
  });
}
function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}
function handleApiPost(req, res, fn) {
  readJsonBody(req, 800000)
    .then((body) => {
      const result = fn(body) || {};
      sendJson(res, result.error ? 400 : 200, result);
    })
    .catch((e) => sendJson(res, 400, { error: e.message || "Ошибка запроса." }));
}

const server = http.createServer((req, res) => {
  let reqPath = decodeURIComponent(req.url.split("?")[0]);

  if (reqPath === "/api/rooms") {
    const list = [...rooms.values()]
      .filter((r) => r.players.length > 0)
      .map((r) => ({
        code: r.code,
        totalPlayers: r.players.length,
        connectedCount: r.players.filter((p) => p.connected).length,
        activeCount: r.players.filter((p) => !p.bankrupt).length,
        phase: r.phase,
        eventCount: r.eventCount,
        tradeWindowMs: r.tradeWindowMs,
        createdAt: r.createdAt,
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify(list));
  }

  if (reqPath === "/api/leaderboard" && req.method === "GET") {
    return sendJson(res, 200, users.getLeaderboard(50));
  }

  if (reqPath === "/api/login" && req.method === "POST") {
    return handleApiPost(req, res, (b) => users.login(b.username, b.password));
  }
  if (reqPath === "/api/profile/update" && req.method === "POST") {
    return handleApiPost(req, res, (b) => users.updateProfile(b.username, b.password, b.gender, b.avatar));
  }
  if (reqPath === "/api/profile/password" && req.method === "POST") {
    return handleApiPost(req, res, (b) => users.changePassword(b.username, b.password, b.newPassword));
  }
  if (reqPath === "/api/profile/photo" && req.method === "POST") {
    return handleApiPost(req, res, (b) => users.setPhoto(b.username, b.password, b.photoDataUrl));
  }
  if (reqPath === "/api/skins/buy" && req.method === "POST") {
    return handleApiPost(req, res, (b) => users.buySkin(b.username, b.password, b.skinId, b.kind));
  }
  if (reqPath === "/api/skins/equip" && req.method === "POST") {
    return handleApiPost(req, res, (b) => users.equipSkin(b.username, b.password, b.skinId, b.kind));
  }

  if (reqPath === "/" || reqPath === "") reqPath = "/index.html";
  const filePath = path.join(PUBLIC_DIR, reqPath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (err2, data2) => {
        if (err2) { res.writeHead(404); return res.end("Not found"); }
        res.writeHead(200, { "Content-Type": MIME[".html"] });
        res.end(data2);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("message", (raw) => handleMessage(ws, raw));
  ws.on("close", () => {
    const conn = connections.get(ws);
    if (conn) {
      const room = rooms.get(conn.roomCode);
      if (room) {
        engine.setConnected(room, conn.playerId, false);
        broadcast(room);
      }
      connections.delete(ws);
    }
  });
});

const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
wss.on("close", () => clearInterval(pingInterval));

const PORT = process.env.PORT || 8792;
server.listen(PORT, () => { console.log(`Trade Monopoly сервер запущен: http://localhost:${PORT}`); });
