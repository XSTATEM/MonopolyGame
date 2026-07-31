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
const rooms = new Map(); // code -> room
const connections = new Map(); // ws -> {roomCode, playerId, name}

function getOrCreateRoom(code) {
  if (!rooms.has(code)) rooms.set(code, engine.freshRoom(code));
  return rooms.get(code);
}
function requireRoom(conn) { return rooms.get(conn.roomCode); }

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
  if (room) { syncAccountPoints(room); broadcast(room); }
}

// Как run(), но дополнительно уведомляет ТОЛЬКО инициатора платной меры об её
// итоге (успех/провал/выполнено) отдельным сообщением — это не часть общего
// state-снапшота (он одинаков для всех), а адресная подсказка для UI, чтобы
// результат сразу показывался прямо на карточке действия, а не терялся в ленте.
function runWithResult(conn, ws, measure, result) {
  if (result && !result.error) sendTo(ws, { type: "measureResult", measure, success: result.success !== false, suspectName: result.suspectName || null });
  return run(conn, result);
}

// После голосования за кик игрок помечается kicked+disconnected в движке, но
// его собственный WS-сокет остаётся открытым, пока сервер сам его не закроет —
// иначе клиент кикнутого продолжил бы получать (и мог бы попытаться слать)
// команды в уже недоступной для него комнате. Закрываем с небольшой задержкой,
// чтобы прощальный state/error успел дойти до его вкладки.
function disconnectKickedPlayers(room) {
  for (const [ws, c] of connections) {
    if (c.roomCode !== room.code) continue;
    const p = room.players.find((x) => x.id === c.playerId);
    if (p && p.kicked && ws.readyState === ws.OPEN) {
      sendTo(ws, { type: "error", message: "Вы исключены из комнаты голосованием игроков." });
      setTimeout(() => { try { ws.close(); } catch (e) {} }, 150);
    }
  }
}
function runKick(conn, result) {
  run(conn, result);
  const room = requireRoom(conn);
  if (room) disconnectKickedPlayers(room);
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

  // Три способа подтвердить личность: свежий логин, регистрация, либо (новое)
  // токен сессии из куки — так игрока не выкидывает из аккаунта при обновлении
  // страницы/переподключении, и ему не нужно каждый раз печатать пароль заново.
  let authResult;
  const sessionToken = String(msg.sessionToken || "");
  if (sessionToken) {
    authResult = users.loginWithToken(sessionToken);
  } else {
    const authMode = msg.authMode === "register" ? "register" : "login";
    const username = String(msg.username || "").trim().slice(0, 20);
    const password = String(msg.password || "");
    if (!username) return sendTo(ws, { type: "error", message: "Введите ник." });
    if (!password) return sendTo(ws, { type: "error", message: "Введите пароль." });
    authResult = authMode === "register"
      ? users.register(username, password, msg.gender, msg.avatar)
      : users.login(username, password);
  }
  if (authResult.error) return sendTo(ws, { type: "error", message: authResult.error, sessionExpired: !!sessionToken });
  const profile = authResult.user;
  const effectiveToken = authResult.sessionToken || sessionToken;

  const room = getOrCreateRoom(code);

  const result = engine.addPlayer(room, profile.username, profile.gender, profile.avatar, profile.points, profile.equippedBoardSkin);
  if (result.error) return sendTo(ws, { type: "error", message: result.error });

  connections.set(ws, { ws, roomCode: code, playerId: result.player.id, name: profile.username, accountUsername: profile.username });
  sendTo(ws, { type: "joined", playerId: result.player.id, room: code, sessionToken: effectiveToken, username: profile.username });
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
    case "endTurn": return run(conn, engine.endTurn(room, conn.playerId));
    case "buyBank": return run(conn, engine.buyBank());
    case "sellBank": return run(conn, engine.sellBank(room, conn.playerId, msg.ticker, msg.pct));
    case "proposeTrade": return run(conn, engine.proposeTrade(room, conn.playerId, msg.to, msg.ticker, msg.pct, msg.price, msg.wantTicker, msg.wantPct));
    case "respondTrade": return run(conn, engine.respondTrade(room, conn.playerId, msg.id, msg.accept));
    case "declareBankruptcy": return run(conn, engine.declareBankruptcy(room, conn.playerId));
    case "newGame": return handleNewGame(conn);
    case "startGame": return run(conn, engine.startGame(room, conn.playerId));
    case "setMaxRounds": return run(conn, engine.setMaxRounds(room, conn.playerId, msg.maxRounds));
    case "updateRoomSettings": {
      if (!room) return;
      if (room.phase !== "lobby") return;
      const host = room.players.find(p => p.id === room.hostPlayerId);
      if (!host || host.id !== conn.playerId) return;
      if (!room.settings) room.settings = {};
      Object.assign(room.settings, msg.settings);
      broadcast(room);
      return;
    }
    case "deleteRoom": return handleDeleteRoom(conn);
    case "chat": return run(conn, engine.sendChatMessage(room, conn.playerId, msg.text));
    case "forceEvent": return run(conn, engine.forceEvent(room));
    case "ctrlNegativeInfo": return runWithResult(conn, ws, "negativeInfo", engine.ctrlNegativeInfo(room, conn.playerId, msg.ticker));
    case "ctrlPrCampaign": return runWithResult(conn, ws, "prCampaign", engine.ctrlPrCampaign(room, conn.playerId, msg.ticker));
    case "ctrlInsiderPeek": {
      const result = engine.ctrlInsiderPeek(room, conn.playerId);
      if (result.error) { sendError(conn, result.error); return; }
      sendTo(ws, { type: "insiderCard", card: result.card });
      broadcast(room);
      return;
    }
    case "ctrlInsiderResolve": return run(conn, engine.ctrlInsiderResolve(room, conn.playerId, msg.action));
    case "ctrlSqueezeOut": return runWithResult(conn, ws, "squeezeOut", engine.ctrlSqueezeOut(room, conn.playerId, msg.ticker));
    case "ctrlShort": return runWithResult(conn, ws, "short", engine.ctrlShort(room, conn.playerId, msg.ticker));
    case "ctrlPublicIPO": return runWithResult(conn, ws, "publicIPO", engine.ctrlPublicIPO(room, conn.playerId, msg.ticker));
    case "ctrlMergeCompanies": return runWithResult(conn, ws, "merge", engine.ctrlMergeCompanies(room, conn.playerId, msg.targetTicker, msg.absorbTickers));
    case "takeLoan": return run(conn, engine.takeLoan(room, conn.playerId, msg.amount));
    case "repayLoan": return run(conn, engine.repayLoan(room, conn.playerId, msg.amount));
    case "buyRealEstateFromRoll": return run(conn, engine.buyRealEstateFromRoll(room, conn.playerId));
    case "upgradeRealEstateFromRoll": return run(conn, engine.upgradeRealEstateFromRoll(room, conn.playerId));
    case "payRealEstateRentFromRoll": return run(conn, engine.payRealEstateRentFromRoll(room, conn.playerId));
    case "ctrlEspionage": return runWithResult(conn, ws, "espionage", engine.ctrlEspionage(room, conn.playerId, msg.target));
    case "ctrlDiscredit": return runWithResult(conn, ws, "discredit", engine.ctrlDiscredit(room, conn.playerId, msg.target));
    case "ctrlInvestigate": return runWithResult(conn, ws, "investigate", engine.ctrlInvestigate(room, conn.playerId));
    case "personalPr": return runWithResult(conn, ws, "personalPr", engine.personalPr(room, conn.playerId));
    case "startKickVote": return runKick(conn, engine.startKickVote(room, conn.playerId, msg.target));
    case "voteKick": return runKick(conn, engine.voteKick(room, conn.playerId, msg.target, !!msg.yes));
    case "cancelKickVote": return run(conn, engine.cancelKickVote(room, conn.playerId));
    case "reaction": return run(conn, engine.sendReaction(room, conn.playerId, msg.emoji));
  }
}

function handleNewGame(conn) {
  const room = requireRoom(conn);
  if (!room) return;
  const fresh = engine.newGameKeepPlayers(room);
  rooms.set(room.code, fresh);
  for (const [, c] of connections) {
    if (c.roomCode === room.code) {
      const np = fresh.players.find((p) => p.name === c.name);
      if (np) c.playerId = np.id;
    }
  }
  broadcast(fresh);
}

function handleDeleteRoom(conn) {
  const room = requireRoom(conn);
  if (!room) return;
  const result = engine.deleteRoom(room, conn.playerId);
  if (result.error) return sendError(conn, result.error);
  if (result.deleted) {
    // Отключить всех игроков из этой комнаты
    for (const [ws, c] of connections) {
      if (c.roomCode === room.code) {
        sendTo(ws, { type: "roomDeleted", message: "Комната была удалена хостом." });
        setTimeout(() => { try { ws.close(); } catch (e) {} }, 150);
      }
    }
    // Удалить комнату из реестра
    rooms.delete(room.code);
  }
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
function sendJson(res, status, obj, headers) {
  res.writeHead(status, Object.assign({ "Content-Type": "application/json; charset=utf-8" }, headers || {}));
  res.end(JSON.stringify(obj));
}
// При успешном логине/регистрации сервер, помимо токена в теле ответа,
// проставляет и обычную куку — так браузер сам пришлёт её при следующем
// заходе, даже если клиентский JS почему-то не сохранит токен сам.
function sessionCookieHeader(token) {
  return { "Set-Cookie": `tm_session=${encodeURIComponent(token)}; Max-Age=2592000; Path=/; SameSite=Lax` };
}
function handleApiPost(req, res, fn) {
  readJsonBody(req, 800000)
    .then((body) => {
      const result = fn(body) || {};
      const headers = result.sessionToken ? sessionCookieHeader(result.sessionToken) : null;
      sendJson(res, result.error ? 400 : 200, result, headers);
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
  if (reqPath === "/api/register" && req.method === "POST") {
    return handleApiPost(req, res, (b) => users.register(b.username, b.password, b.gender, b.avatar));
  }
  // Проверка куки/токена сессии при загрузке страницы — без пароля, только
  // чтобы молча восстановить "вы вошли как X" (или тихо промолчать, если
  // токен истёк/невалиден — тогда клиент просто покажет экран входа).
  if (reqPath === "/api/session" && req.method === "POST") {
    return handleApiPost(req, res, (b) => users.loginWithToken(b.token));
  }
  if (reqPath === "/api/logout" && req.method === "POST") {
    return handleApiPost(req, res, (b) => users.invalidateSession(b.username, b.token));
  }
  if (reqPath === "/api/profile/update" && req.method === "POST") {
    return handleApiPost(req, res, (b) => users.updateProfile(b.username, b.password, b.gender, b.avatar, b.token));
  }
  if (reqPath === "/api/profile/password" && req.method === "POST") {
    return handleApiPost(req, res, (b) => users.changePassword(b.username, b.password, b.newPassword, b.token));
  }
  if (reqPath === "/api/profile/photo" && req.method === "POST") {
    return handleApiPost(req, res, (b) => users.setPhoto(b.username, b.password, b.photoDataUrl, b.token));
  }
  if (reqPath === "/api/skins/buy" && req.method === "POST") {
    return handleApiPost(req, res, (b) => users.buySkin(b.username, b.password, b.skinId, b.kind, b.token));
  }
  if (reqPath === "/api/skins/equip" && req.method === "POST") {
    return handleApiPost(req, res, (b) => users.equipSkin(b.username, b.password, b.skinId, b.kind, b.token));
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
