const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const engine = require("./public/engine.js");
const users = require("./users.js");
// Магазин и видео с наградой. Без настроек в окружении всё выключено:
// каталог отвечает {enabled:false}, остальные маршруты — 404.
const Payments = require("./payments.js");
const Ads = require("./ads.js");

// Настройки из окружения. На своём сервере они лежат в /etc/birzha.env
// (см. deploy/README.md); без них сервер работает как раньше — на всех
// интерфейсах, порт 8792, данные в server/data.
const PORT = Number(process.env.PORT) || 8792;
const HOST = process.env.HOST || "";
// За nginx реальный IP игрока и протокол приходят в X-Forwarded-*/X-Real-IP.
// Без TRUST_PROXY эти заголовки игнорируются: их может подделать кто угодно.
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const ROOM_TTL_MS = (Number(process.env.ROOM_TTL_HOURS) || 12) * 3600 * 1000;
const ROOMS_FILE = path.join(users.DATA_DIR, "rooms.json");
const startedAt = Date.now();

function fmt(n) { return "$" + Math.round(n).toLocaleString("ru-RU"); }

// ---------------------------------------------------------------------
// Room registry — сетевой слой поверх engine.js (правила игры живут там).
// ---------------------------------------------------------------------
const rooms = new Map(); // code -> room
const connections = new Map(); // ws -> {roomCode, playerId, name}
const roomLastActive = new Map(); // code -> время последнего события в комнате
let roomsDirty = false; // есть изменения, ещё не сброшенные в rooms.json

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
  // Любое изменение комнаты проходит через рассылку — здесь же отмечаем его
  // для сохранения на диск и для таймера удаления заброшенных комнат.
  roomsDirty = true;
  roomLastActive.set(room.code, Date.now());
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
  // Имя игрока в онлайн-комнате — это ник его аккаунта (см. handleJoin).
  // Раньше очки искались по открытому сокету и терялись, если победитель
  // в момент окончания партии был не в сети, хотя экран писал «Начислено +N».
  const p = room.players.find((x) => x.id === award.playerId);
  if (!p || p.isBot) return;
  const total = users.addPoints(p.name, award.amount);
  if (total != null) p.points = total;
  // users.json уже записан — сразу сохраняем и комнату в финальном виде. Иначе
  // при падении процесса в ближайшие 30 с поднялся бы снимок до конца партии,
  // и ту же партию можно было бы доиграть и получить очки второй раз.
  persistRooms();
}

// ---------------------------------------------------------------------
// Защита от подбора паролей: не больше AUTH_MAX_FAILS неудачных входов с
// одного IP за AUTH_WINDOW_MS. Лимит в nginx закрывает только /api/login,
// а пароль можно проверять и через вход в комнату по WebSocket — поэтому
// считаем здесь, для обоих путей.
// ---------------------------------------------------------------------
const AUTH_WINDOW_MS = 10 * 60 * 1000;
const AUTH_MAX_FAILS = 20;
const TOO_MANY_FAILS = "Слишком много неудачных попыток входа. Подождите 10 минут.";
const authFails = new Map(); // ip -> {count, resetAt}

// Заголовки прокси принимаем, только если соединение пришло от него самого —
// с локального или внутреннего адреса (nginx на этой машине, Docker, балансировщик
// хостинга). Если порт по ошибке открыт наружу при TRUST_PROXY=1, клиент не
// подставит себе X-Real-IP и не обойдёт лимиты и проверку адресов ЮKassa.
function isLocalPeer(addr) {
  let a = String(addr || "").toLowerCase();
  if (a.startsWith("::ffff:")) a = a.slice(7);
  if (a === "::1" || /^127\./.test(a) || /^10\./.test(a) || /^192\.168\./.test(a)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(a) || /^169\.254\./.test(a) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a)) return true;
  return /^f[cd][0-9a-f]{2}:/.test(a) || /^fe[89ab][0-9a-f]:/.test(a);
}
function clientIp(req) {
  if (TRUST_PROXY && isLocalPeer(req.socket && req.socket.remoteAddress)) {
    const real = String(req.headers["x-real-ip"] || "").trim();
    if (real) return real;
    // nginx дописывает адрес клиента В КОНЕЦ X-Forwarded-For; начало списка
    // присылает сам клиент и может его подделать.
    const xff = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return (req.socket && req.socket.remoteAddress) || "";
}
function authBlocked(ip) {
  const rec = authFails.get(ip);
  if (!rec) return false;
  if (Date.now() > rec.resetAt) { authFails.delete(ip); return false; }
  return rec.count >= AUTH_MAX_FAILS;
}
function noteAuthFail(ip) {
  const now = Date.now();
  const rec = authFails.get(ip);
  if (!rec || now > rec.resetAt) authFails.set(ip, { count: 1, resetAt: now + AUTH_WINDOW_MS });
  else rec.count++;
}

// Счётчик событий с одного IP за окно — для регистраций и новых комнат.
function ipLimiter(windowMs, max) {
  const hits = new Map(); // ip -> {count, resetAt}
  return {
    blocked(ip) {
      const rec = hits.get(ip);
      if (!rec) return false;
      if (Date.now() > rec.resetAt) { hits.delete(ip); return false; }
      return rec.count >= max;
    },
    note(ip) {
      const now = Date.now();
      const rec = hits.get(ip);
      if (!rec || now > rec.resetAt) hits.set(ip, { count: 1, resetAt: now + windowMs });
      else rec.count++;
    },
    sweep(now) { for (const [ip, rec] of hits) if (now > rec.resetAt) hits.delete(ip); },
  };
}
// Регистрации: лимит nginx закрывает только /api/register, а аккаунт создаёт
// и вход в комнату по WebSocket. Каждая регистрация — scrypt и полная
// перезапись users.json, поэтому поток регистраций тормозил бы все партии и
// раздувал файл. Считаем созданные аккаунты (неудачная попытка дешёвая).
const regLimit = ipLimiter(60 * 60 * 1000, 10);
const TOO_MANY_REGS = "Слишком много регистраций с вашего адреса — попробуйте через час.";
// Новые комнаты: иначе один скрипт с десятком сокетов занимал все MAX_ROOMS.
const roomLimit = ipLimiter(10 * 60 * 1000, 20);
// Магазин и реклама: заказы, проверка покупок, билеты на видео. Каждый такой
// запрос может уйти к провайдеру — ограничиваем поток с одного IP.
const shopLimit = ipLimiter(10 * 60 * 1000, 120);
// Вебхук ЮKassa — без входа, и каждое уведомление проверяется запросом к API
// ЮKassa с ключом магазина. Настоящих уведомлений единицы — поток выдуманных режем.
const hookLimit = ipLimiter(10 * 60 * 1000, 300);

// Вход в комнату теперь требует аккаунт: ник — это логин, доступ к нему
// закрыт паролем (scrypt-хэш в users.js), чтобы прогресс/очки нельзя было
// присвоить или потерять, просто зная чужой ник.
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 500;
// Код комнаты показывается в списке комнат и в интерфейсе — без управляющих
// символов и разметки.
const ROOM_CODE_RE = /^[^\u0000-\u001f\u007f<>"'&\\`]{1,20}$/;

function handleJoin(ws, msg) {
  const code = String(msg.room || "MAIN").trim().toUpperCase().slice(0, 20) || "MAIN";
  if (!ROOM_CODE_RE.test(code)) return sendTo(ws, { type: "error", message: "Код комнаты не должен содержать кавычек, угловых скобок и служебных символов." });
  if (!rooms.has(code) && rooms.size >= MAX_ROOMS) return sendTo(ws, { type: "error", message: "На сервере слишком много комнат. Войдите в существующую или попробуйте позже." });
  if (!rooms.has(code) && roomLimit.blocked(ws.clientIp)) return sendTo(ws, { type: "error", message: "Слишком много новых комнат с вашего адреса — войдите в существующую или подождите несколько минут." });

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
    if (authBlocked(ws.clientIp)) return sendTo(ws, { type: "error", message: TOO_MANY_FAILS });
    if (authMode === "register" && regLimit.blocked(ws.clientIp)) return sendTo(ws, { type: "error", message: TOO_MANY_REGS });
    authResult = authMode === "register"
      ? users.register(username, password, msg.gender, msg.avatar)
      : users.login(username, password);
    if (authResult.authFailed) noteAuthFail(ws.clientIp);
    if (authMode === "register" && !authResult.error) regLimit.note(ws.clientIp);
  }
  if (authResult.error) return sendTo(ws, { type: "error", message: authResult.error, sessionExpired: !!sessionToken });
  const profile = authResult.user;
  const effectiveToken = authResult.sessionToken || sessionToken;

  // Этот же сокет уже сидел в другой комнате (повторный join без
  // переподключения): там игрок иначе навсегда остался бы «в сети».
  const prevConn = connections.get(ws);
  if (prevConn && prevConn.roomCode !== code) {
    connections.delete(ws);
    const prevRoom = rooms.get(prevConn.roomCode);
    if (prevRoom) {
      // Из комнаты ожидания игрок ушёл сам — убираем его сразу, а опустевшую
      // комнату удаляем: прыжками по кодам иначе можно было держать сотни
      // комнат с «призраками» и упереться в MAX_ROOMS.
      if (prevRoom.phase === "lobby") engine.leaveLobby(prevRoom, prevConn.playerId);
      else markOffline(prevRoom, prevConn.playerId);
      if (!dropIfEmpty(prevRoom)) broadcast(prevRoom);
    }
  }

  const isNewRoom = !rooms.has(code);
  const room = getOrCreateRoom(code);
  if (isNewRoom) roomLimit.note(ws.clientIp);
  // Закрытая комната: её нет в /api/rooms, войти можно только по коду. Признак
  // задаёт тот, кто комнату создаёт; повторный join с private его не меняет.
  if (isNewRoom && msg.private === true) room.isPrivate = true;

  // Тот же аккаунт уже сидит в этой комнате через другой сокет. Чаще всего это
  // «полуоткрытое» соединение после смены сети на телефоне (Wi-Fi → LTE):
  // клиент уже переподключился, а сервер ещё не заметил обрыв и без этого
  // минуту отвечал бы «имя уже занято». Сессию забирает новый сокет; старому
  // (если он на самом деле жив — вторая вкладка) сообщаем, чтобы он не
  // переподключался и не отбирал её обратно.
  for (const [otherWs, c] of connections) {
    if (c.roomCode !== code || c.accountUsername !== profile.username) continue;
    connections.delete(otherWs);
    const p = room.players.find((x) => x.id === c.playerId);
    if (p) p.connected = false; // без setConnected: хост и лог не меняются
    if (otherWs !== ws) {
      sendTo(otherWs, { type: "replaced" });
      try { otherWs.close(4001, "replaced"); } catch (e) {}
    }
  }

  // За столом показывается рейтинг (только победы), а не баланс очков.
  const result = engine.addPlayer(room, profile.username, profile.gender, profile.avatar, profile.rating, profile.equippedBoardSkin);
  if (result.error) { dropIfEmpty(room); return sendTo(ws, { type: "error", message: result.error }); }
  // Фото профиля — ссылкой на /api/avatar, а не самой картинкой (см. users.photoUrl).
  result.player.avatarPhoto = users.photoUrl(profile);

  connections.set(ws, { ws, roomCode: code, playerId: result.player.id, name: profile.username, accountUsername: profile.username });
  sendTo(ws, { type: "joined", playerId: result.player.id, room: code, sessionToken: effectiveToken, username: profile.username });
  broadcast(room);
}

// Тикеры приходят от клиента как есть. Ключ вроде "__proto__" или
// "constructor" находил «компанию» в прототипе объекта room.companies, и
// движок успевал испортить комнату до исключения: наличные игрока → NaN,
// капитал всех игроков → null. Пропускаем только настоящие тикеры.
function tickersValid(room, msg) {
  const isTicker = (t) => typeof t === "string" && Object.prototype.hasOwnProperty.call(room.companies, t);
  if (msg.ticker !== undefined && !isTicker(msg.ticker)) return false;
  if (msg.wantTicker != null && msg.wantTicker !== "" && !isTicker(msg.wantTicker)) return false;
  if (msg.targetTicker !== undefined && !isTicker(msg.targetTicker)) return false;
  if (msg.absorbTickers !== undefined && !(Array.isArray(msg.absorbTickers) && msg.absorbTickers.every(isTicker))) return false;
  return true;
}

function handleMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "join") return handleJoin(ws, msg);
  const conn = connections.get(ws);
  if (!conn) return sendTo(ws, { type: "error", message: "Сначала присоединитесь к комнате." });
  const room = requireRoom(conn);
  if (!room) return sendTo(ws, { type: "error", message: "Комната больше не существует — войдите заново." });
  if (!tickersValid(room, msg)) return sendError(conn, "Неизвестная компания.");

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
      // Платный сценарий может выбрать только хост, который его купил. Без
      // настроенного магазина купить нельзя — тогда все сценарии открыты.
      const sid = msg.settings && typeof msg.settings === "object" && msg.settings.scenario ? String(msg.settings.scenario) : "";
      const sc = sid ? engine.scenarioById(sid) : null;
      if (sc && !sc.free && Payments.shopEnabled() && !users.ownsScenario(conn.accountUsername, sid)) {
        return sendError(conn, `Сценарий «${sc.title}» не куплен — его можно купить в магазине.`);
      }
      return run(conn, engine.updateRoomSettings(room, conn.playerId, msg.settings));
    }
    case "requestAnalysis": {
      // Разбор партии (engine.analyzeGame) — только своему игроку и после
      // конца партии. С магазином: подписка «Трейдер» или один бесплатный в
      // сутки; повторное открытие той же партии лимит не тратит.
      if (room.phase !== "ended") return sendError(conn, "Разбор доступен после конца партии.");
      if (Payments.shopEnabled()) {
        if (!conn.accountUsername) return sendTo(conn.ws, { type: "analysis", error: "Войдите в аккаунт, чтобы открыть разбор.", code: "session" });
        if (!room.analysisOpened || typeof room.analysisOpened !== "object") room.analysisOpened = {};
        if (!room.analysisOpened[conn.playerId]) {
          const claim = users.claimAnalysisKey(users.usernameKey(conn.accountUsername), `${room.code}:${room.createdAt || 0}`);
          if (claim.error) return sendTo(conn.ws, { type: "analysis", error: claim.error, code: claim.code });
          room.analysisOpened[conn.playerId] = true;
          roomsDirty = true;
        }
      }
      return sendTo(conn.ws, { type: "analysis", analysis: engine.analyzeGame(room, conn.playerId) });
    }
    case "deleteRoom": return handleDeleteRoom(conn);
    case "chat": return run(conn, engine.sendChatMessage(room, conn.playerId, msg.text));
    case "forceEvent": {
      // Отладочная кнопка: внеочередное событие даёт лидеру нечестное
      // преимущество, поэтому на сервере она работает только при TM_DEBUG=1.
      if (process.env.TM_DEBUG !== "1") return sendError(conn, "Внеочередное событие отключено на этом сервере.");
      return run(conn, engine.forceEvent(room));
    }
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
    case "leaveLobby": return handleLeaveLobby(ws, conn);
  }
}

// «Покинуть комнату» в лобби: игрок уходит из комнаты сразу, а не через
// LOBBY_LEAVE_GRACE_MS после закрытия сокета (см. scheduleLobbyLeave).
function handleLeaveLobby(ws, conn) {
  const room = requireRoom(conn);
  if (!room) return;
  connections.delete(ws); // закрытие сокета после этого уже ничего не меняет
  const result = engine.leaveLobby(room, conn.playerId);
  // Партия уже идёт — просто «не в сети», как при обычном закрытии вкладки.
  if (result.error) markOffline(room, conn.playerId);
  if (!dropIfEmpty(room)) broadcast(room);
}

// Комната ожидания, из которой ушёл последний игрок, никому не нужна —
// удаляем сразу, не дожидаясь прохода sweepRooms. Возвращает true, если удалили
// (тогда рассылать её состояние уже некому).
function dropIfEmpty(room) {
  if (room.players.length || rooms.get(room.code) !== room) return false;
  rooms.delete(room.code);
  roomLastActive.delete(room.code);
  roomsDirty = true;
  return true;
}

// Игрок отключился посреди партии. Через OFFLINE_KICK_GRACE_MS его можно
// исключить одним голосом, а если это хост — новую партию может начать любой
// (engine.kickVotesNeeded / hostAway). Само время состояние комнаты не меняет,
// поэтому по истечении паузы рассылаем его заново: карточка игрока и меню
// партии у остальных показывают это без нового хода.
function scheduleGraceBroadcast(room, playerId) {
  const t = setTimeout(() => {
    if (rooms.get(room.code) !== room) return;
    const p = room.players.find((x) => x.id === playerId);
    if (!p || p.connected || p.kicked) return;
    // Голосование против него уже идёт — теперь хватает одного голоса «за»
    // (голос инициатора уже есть): итог подводим сразу, а не по чьему-то
    // следующему нажатию (баннер показывал бы 1/1 без исключения).
    if (room.kickVote && room.kickVote.targetId === playerId) {
      engine.resolveKickVote(room);
      syncAccountPoints(room);
      roomsDirty = true;
    }
    for (const c of connections.values()) if (c.roomCode === room.code) return broadcast(room);
  }, engine.OFFLINE_KICK_GRACE_MS + 250);
  if (t.unref) t.unref();
}
function markOffline(room, playerId) {
  engine.setConnected(room, playerId, false);
  scheduleGraceBroadcast(room, playerId);
}

// Лобби: игрок, закрывший вкладку без «Покинуть комнату», убирается из
// комнаты, если не вернулся за LOBBY_LEAVE_GRACE_MS, — иначе висел бы
// «призраком»: с ним хост мог начать партию, и та вставала на его ходу.
// Пауза нужна, чтобы обновление страницы или смена сети (Wi-Fi → LTE) не
// стоили места в комнате.
const LOBBY_LEAVE_GRACE_MS = 20000;
function scheduleLobbyLeave(room, playerId, delayMs) {
  if (room.phase !== "lobby") return;
  const t = setTimeout(() => {
    if (rooms.get(room.code) !== room || room.phase !== "lobby") return;
    const p = room.players.find((x) => x.id === playerId);
    if (!p || p.connected) return;
    if (engine.leaveLobby(room, playerId).ok && !dropIfEmpty(room)) broadcast(room);
  }, delayMs || LOBBY_LEAVE_GRACE_MS);
  if (t.unref) t.unref();
}

function handleNewGame(conn) {
  const room = requireRoom(conn);
  if (!room) return;
  // Сбросить идущую партию может только хост; после конца партии реванш
  // доступен любому. Иначе любой игрок мог перезапустить чужую игру. Хост
  // пропал надолго (не в сети дольше минуты, исключён) — сбросить может любой,
  // кто ещё в игре: роль хоста посреди партии больше не переходит.
  if (room.phase !== "ended" && room.hostPlayerId !== conn.playerId) {
    const p = room.players.find((x) => x.id === conn.playerId);
    if (!engine.hostAway(room) || !p || p.bankrupt) {
      return sendError(conn, "Начать новую партию до её окончания может только хост комнаты (или любой игрок, если хост не в сети дольше минуты).");
    }
  }
  const fresh = engine.newGameKeepPlayers(room);
  if (room.isPrivate) fresh.isPrivate = true; // реванш остаётся закрытым
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
    roomLastActive.delete(room.code);
    roomsDirty = true;
  }
}

// ---------------------------------------------------------------------
// Сохранение партий на диск. Комнаты живут в памяти; чтобы перезапуск или
// обновление сервера не обрывали игру, они сбрасываются в rooms.json (раз в
// 30 с, если что-то менялось, и при остановке) и поднимаются при старте —
// клиенты переподключаются сами (сессия по токену, см. handleJoin).
// Запись через временный файл и rename: оборванная запись не портит файл.
// ---------------------------------------------------------------------
function persistRooms() {
  try {
    const list = [...rooms.values()].filter((r) => r.players.length > 0);
    fs.mkdirSync(users.DATA_DIR, { recursive: true });
    const tmp = ROOMS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, savedAt: Date.now(), rooms: list }), "utf8");
    fs.renameSync(tmp, ROOMS_FILE);
    roomsDirty = false;
  } catch (e) {
    console.error("Не удалось сохранить комнаты:", e.message);
  }
}

function restoreRooms() {
  let saved;
  try { saved = JSON.parse(fs.readFileSync(ROOMS_FILE, "utf8")); } catch (e) { return; }
  if (!saved || saved.v !== 1 || !Array.isArray(saved.rooms)) return;
  const now = Date.now();
  for (const room of saved.rooms) {
    if (!room || typeof room.code !== "string" || !Array.isArray(room.players) || !room.companies) continue;
    // Сокеты перезапуск не пережили: люди «не в сети», пока не переподключатся.
    // Пауза перед исключением одним голосом отсчитывается заново — иначе
    // первый вернувшийся мог бы сразу исключить всех, кто ещё переподключается.
    room.players.forEach((p) => { if (!p.isBot) { p.connected = false; p.offlineSince = now; } });
    // Срок решения контролёра о цене выкупа (engine CONTROLLER_DECISION_MS)
    // по той же причине начинается заново: метка из rooms.json пережила
    // перезапуск, но контролёр ещё переподключается — иначе после простоя
    // бросающий сразу оплатил бы по тарифу, не дав ему назначить цену.
    if (room.pendingRoll && room.pendingRoll.controllerWaitSince) room.pendingRoll.controllerWaitSince = now;
    rooms.set(room.code, room);
    roomLastActive.set(room.code, now);
    // В лобби не вернувшиеся после перезапуска уходят из комнаты (с запасом
    // времени на автопереподключение клиентов), а не висят «призраками».
    room.players.forEach((p) => {
      if (p.isBot) return;
      scheduleLobbyLeave(room, p.id, 3 * LOBBY_LEAVE_GRACE_MS);
      if (room.phase === "roll") scheduleGraceBroadcast(room, p.id);
    });
  }
  if (rooms.size) console.log(`Восстановлено комнат: ${rooms.size}`);
}

// Комнаты, в которых никого нет дольше ROOM_TTL_HOURS, удаляются — иначе
// реестр (и rooms.json) рос бы бесконечно из брошенных партий. Пустая комната
// ожидания или законченная партия никому не нужна — её убираем уже через
// EMPTY_ROOM_GRACE_MS (запас на перезагрузку страницы), иначе список комнат
// часами показывал бы мёртвые комнаты. Идущую партию ждём весь ROOM_TTL_HOURS.
const EMPTY_ROOM_GRACE_MS = 5 * 60 * 1000;
function sweepRooms() {
  const now = Date.now();
  const live = new Set();
  for (const c of connections.values()) live.add(c.roomCode);
  for (const [code, room] of rooms) {
    if (live.has(code)) continue;
    const last = roomLastActive.get(code);
    if (last == null) { roomLastActive.set(code, now); continue; }
    const ttl = room.phase === "roll" ? ROOM_TTL_MS : EMPTY_ROOM_GRACE_MS;
    if (room.players.length === 0 || now - last > ttl) {
      rooms.delete(code);
      roomLastActive.delete(code);
      roomsDirty = true;
    }
  }
  for (const [ip, rec] of authFails) if (now > rec.resetAt) authFails.delete(ip);
  regLimit.sweep(now);
  roomLimit.sweep(now);
  shopLimit.sweep(now);
  hookLimit.sweep(now);
  Ads.sweep(now);
}

// ---------------------------------------------------------------------
// HTTP + WS server
// ---------------------------------------------------------------------
const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};
// Файлы, которые браузер должен перепроверять при каждом заходе: HTML и
// service worker — иначе обновление клиента дойдёт до игроков не сразу.
const NO_CACHE = new Set(["/index.html", "/sw.js", "/manifest.json"]);

// Нативное приложение (Capacitor, папка mobile/) открывает страницу со своего
// локального адреса и ходит в API этого сервера кросс-доменно. Разрешаем
// только эти источники; WebSocket CORS не подчиняется.
const APP_ORIGINS = new Set(["https://localhost", "http://localhost", "capacitor://localhost", "ionic://localhost"]);
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin || !APP_ORIGINS.has(origin)) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  // Authorization — GET-маршруты магазина (токен сессии в заголовке, не в адресе).
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

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
// За HTTPS (напрямую или через nginx) кука получает флаг Secure — иначе
// браузер мог бы отправить токен сессии по открытому http.
function isHttps(req) {
  if (req.socket && req.socket.encrypted) return true;
  return TRUST_PROXY && isLocalPeer(req.socket && req.socket.remoteAddress)
    && String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
}
// При успешном логине/регистрации сервер, помимо токена в теле ответа,
// проставляет и обычную куку — так браузер сам пришлёт её при следующем
// заходе, даже если клиентский JS почему-то не сохранит токен сам.
function sessionCookieHeader(token, secure) {
  return { "Set-Cookie": `tm_session=${encodeURIComponent(token)}; Max-Age=2592000; Path=/; SameSite=Lax${secure ? "; Secure" : ""}` };
}
// opts.auth — запрос проверяет пароль: неудачи считаются в лимит подбора.
// Считаются только неудачи самой проверки (authFailed из users.js) — иначе
// два десятка нажатий «Купить» без очков блокировали вход всему IP (NAT
// мобильного оператора, общий Wi-Fi).
function handleApiPost(req, res, fn, opts) {
  const ip = clientIp(req);
  const guarded = !!(opts && opts.auth);
  if (guarded && authBlocked(ip)) return sendJson(res, 429, { error: TOO_MANY_FAILS });
  readJsonBody(req, 800000)
    .then((body) => {
      const result = fn(body || {}) || {};
      if (guarded && result.authFailed) noteAuthFail(ip);
      delete result.authFailed; // служебный флаг, клиенту не нужен
      const headers = result.sessionToken ? sessionCookieHeader(result.sessionToken, isHttps(req)) : null;
      sendJson(res, result.error ? 400 : 200, result, headers);
    })
    .catch((e) => sendJson(res, 400, { error: e.message || "Ошибка запроса." }));
}
const AUTH = { auth: true };

// Как handleApiPost, но fn может вернуть промис: платёжным маршрутам нужны
// запросы к провайдерам. Исключение внутри fn — это ошибка сервера (500 и лог),
// а не «ошибка действия»: ожидаемые отказы fn возвращает как {error, code}
// (httpStatus — код ответа, если не 400). opts.limiter — лимит запросов с IP.
function handleApiPostAsync(req, res, fn, opts) {
  const ip = clientIp(req);
  const guarded = !!(opts && opts.auth);
  if (guarded && authBlocked(ip)) return sendJson(res, 429, { error: TOO_MANY_FAILS });
  if (opts && opts.limiter) {
    if (opts.limiter.blocked(ip)) return sendJson(res, 429, { error: "Слишком много запросов — подождите немного.", code: "rate_limited" });
    opts.limiter.note(ip);
  }
  readJsonBody(req, 64 * 1024)
    .then((body) => Promise.resolve().then(() => fn(body || {}, ip)).then((result) => {
      result = result || {};
      if (guarded && result.authFailed) noteAuthFail(ip);
      delete result.authFailed;
      const status = result.httpStatus || (result.error ? 400 : 200);
      delete result.httpStatus;
      sendJson(res, status, result, { "Cache-Control": "no-store" });
    }, (e) => {
      console.error("shop:", e && e.message);
      sendJson(res, 500, { error: "Внутренняя ошибка сервера." });
    }))
    .catch((e) => sendJson(res, 400, { error: e.message || "Ошибка запроса." }));
}

const server = http.createServer((req, res) => {
  let reqPath;
  // Некорректная %-последовательность в адресе раньше роняла весь процесс
  // (URIError) вместе со всеми комнатами.
  try { reqPath = decodeURIComponent(req.url.split("?")[0]); }
  catch (e) { res.writeHead(400); return res.end("Bad request"); }
  // %00 в пути: fs.readFile бросает исключение синхронно, и оно роняло процесс.
  if (reqPath.includes("\0")) { res.writeHead(400); return res.end("Bad request"); }

  // Проверка живости для systemd/update.sh/Docker и внешнего мониторинга.
  if (reqPath === "/healthz") {
    return sendJson(res, 200, {
      ok: true,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      rooms: rooms.size,
      connections: connections.size,
    }, { "Cache-Control": "no-store" });
  }

  if (reqPath.startsWith("/api/")) {
    applyCors(req, res);
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  }

  if (reqPath === "/api/rooms") {
    // Закрытые комнаты не показываем; закончившуюся партию — только пока за
    // столом кто-то есть (там может начаться реванш).
    const list = [...rooms.values()]
      .filter((r) => r.players.length > 0 && !r.isPrivate)
      .filter((r) => r.phase !== "ended" || r.players.some((p) => p.connected))
      .map((r) => {
        const host = r.players.find((p) => p.id === r.hostPlayerId);
        return {
          code: r.code,
          hostName: host ? host.name : "",
          totalPlayers: r.players.length,
          connectedCount: r.players.filter((p) => p.connected).length,
          activeCount: r.players.filter((p) => !p.bankrupt).length,
          phase: r.phase,
          eventCount: r.eventCount,
          roundNumber: r.roundNumber || 1,
          maxRounds: r.maxRounds || null,
          createdAt: r.createdAt,
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify(list));
  }

  if (reqPath === "/api/leaderboard" && req.method === "GET") {
    return sendJson(res, 200, users.getLeaderboard(50));
  }

  if (reqPath.startsWith("/api/avatar/") && req.method === "GET") {
    const photo = users.getPhoto(reqPath.slice("/api/avatar/".length));
    if (!photo) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("Not found"); }
    // Адрес содержит версию фото (?v=…), поэтому кешировать можно надолго.
    res.writeHead(200, { "Content-Type": photo.mime, "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff" });
    return res.end(photo.buf);
  }

  if (reqPath === "/api/login" && req.method === "POST") {
    return handleApiPost(req, res, (b) => users.login(b.username, b.password), AUTH);
  }
  if (reqPath === "/api/register" && req.method === "POST") {
    const ip = clientIp(req);
    if (regLimit.blocked(ip)) return sendJson(res, 429, { error: TOO_MANY_REGS });
    return handleApiPost(req, res, (b) => {
      const result = users.register(b.username, b.password, b.gender, b.avatar);
      if (!result.error) regLimit.note(ip);
      return result;
    });
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
    return handleApiPost(req, res, (b) => users.updateProfile(b.username, b.password, b.gender, b.avatar, b.token), AUTH);
  }
  if (reqPath === "/api/profile/password" && req.method === "POST") {
    return handleApiPost(req, res, (b) => users.changePassword(b.username, b.password, b.newPassword, b.token), AUTH);
  }
  if (reqPath === "/api/profile/photo" && req.method === "POST") {
    return handleApiPost(req, res, (b) => users.setPhoto(b.username, b.password, b.photoDataUrl, b.token), AUTH);
  }
  // Разбор офлайн-партии: сам разбор считает клиент, сервер ведёт лимит.
  if (reqPath === "/api/analysis/claim" && req.method === "POST") {
    return handleApiPost(req, res, (b) => Payments.shopEnabled() ? users.claimAnalysis(b.username, b.password, b.token, b.game) : { ok: true, open: true }, AUTH);
  }
  if (reqPath === "/api/skins/buy" && req.method === "POST") {
    return handleApiPost(req, res, (b) => users.buySkin(b.username, b.password, b.skinId, b.kind, b.token), AUTH);
  }
  if (reqPath === "/api/skins/equip" && req.method === "POST") {
    return handleApiPost(req, res, (b) => users.equipSkin(b.username, b.password, b.skinId, b.kind, b.token), AUTH);
  }

  // Магазин и реклама (payments.js, ads.js). Без настроек в окружении
  // маршруты отвечают «выключено», а каталог — {enabled:false}.
  const SHOP = { auth: true, limiter: shopLimit };
  if (reqPath === "/api/shop/catalog" && req.method === "GET") return Payments.handleCatalog(req, res);
  if (reqPath === "/api/shop/order" && req.method === "POST") return handleApiPostAsync(req, res, (b) => Payments.createOrder(b), SHOP);
  if (reqPath.startsWith("/api/shop/order/") && req.method === "GET") return Payments.handleOrderStatus(req, res, reqPath.slice("/api/shop/order/".length));
  if (reqPath === "/api/shop/yookassa/webhook" && req.method === "POST") {
    const ip = clientIp(req);
    if (hookLimit.blocked(ip)) return sendJson(res, 429, { error: "Слишком много запросов." }, { "Cache-Control": "no-store" });
    hookLimit.note(ip);
    return Payments.handleYookassaWebhook(req, res, ip);
  }
  if (reqPath === "/api/shop/verify" && req.method === "POST") return handleApiPostAsync(req, res, (b) => Payments.verify(b), SHOP);
  if (reqPath === "/api/shop/entitlements" && req.method === "GET") return Payments.handleEntitlements(req, res);
  if (reqPath === "/api/ads/start" && req.method === "POST") return handleApiPostAsync(req, res, (b) => Ads.start(b), SHOP);
  if (reqPath === "/api/ads/reward" && req.method === "POST") return handleApiPostAsync(req, res, (b) => Ads.reward(b), SHOP);
  if (reqPath === "/api/ads/admob-ssv" && req.method === "GET") return Ads.handleAdmobSsv(req, res);

  if (reqPath === "/" || reqPath === "") reqPath = "/index.html";
  const filePath = path.join(PUBLIC_DIR, reqPath);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Отсутствующий файл с расширением (.js, .png…) — честный 404, а не
      // index.html с кодом 200: иначе service worker кеширует страницу вместо файла.
      if (path.extname(reqPath)) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("Not found"); }
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (err2, data2) => {
        if (err2) { res.writeHead(404); return res.end("Not found"); }
        res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-cache" });
        res.end(data2);
      });
      return;
    }
    const ext = path.extname(filePath);
    const headers = { "Content-Type": MIME[ext] || "application/octet-stream" };
    if (NO_CACHE.has(reqPath)) headers["Cache-Control"] = "no-cache";
    else if (reqPath.startsWith("/fonts/")) headers["Cache-Control"] = "public, max-age=31536000, immutable";
    res.writeHead(200, headers);
    res.end(data);
  });
});

// Самое большое сообщение клиента — чат или настройки комнаты, это сотни байт.
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
// Не больше MSG_MAX сообщений за MSG_WINDOW_MS с одного сокета: человеку
// хватает с запасом, а залить комнату реакциями или чатом уже не выйдет.
const MSG_WINDOW_MS = 5000;
const MSG_MAX = 60;
wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.clientIp = clientIp(req);
  ws.msgWindowStart = Date.now();
  ws.msgCount = 0;
  ws.on("pong", () => { ws.isAlive = true; });
  // Битый кадр или превышение maxPayload: ws сообщает об этом событием error
  // и сам закрывает сокет. Без обработчика событие стало бы исключением и
  // уронило бы весь процесс со всеми комнатами.
  ws.on("error", (e) => { console.warn("ws error:", e.message); });
  ws.on("message", (raw) => {
    const now = Date.now();
    if (now - ws.msgWindowStart > MSG_WINDOW_MS) { ws.msgWindowStart = now; ws.msgCount = 0; }
    if (++ws.msgCount > MSG_MAX) {
      if (ws.msgCount === MSG_MAX + 1) sendTo(ws, { type: "error", message: "Слишком много действий подряд — подождите пару секунд." });
      return;
    }
    // Ошибка в обработке одного сообщения не должна останавливать сервер
    // со всеми комнатами.
    try { handleMessage(ws, raw); }
    catch (e) { console.error("handleMessage:", e); }
  });
  ws.on("close", () => {
    const conn = connections.get(ws);
    if (conn) {
      const room = rooms.get(conn.roomCode);
      if (room) {
        markOffline(room, conn.playerId);
        scheduleLobbyLeave(room, conn.playerId);
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

const maintenanceInterval = setInterval(() => {
  sweepRooms();
  if (roomsDirty) persistRooms();
}, 30000);

// ---------------------------------------------------------------------
// Остановка (systemctl stop/restart, docker stop, Ctrl+C): сохраняем партии
// и закрываем сокеты кодом 1012 «перезапуск сервиса» — клиент сам
// переподключится, как только сервер поднимется.
// ---------------------------------------------------------------------
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: сохраняю партии и останавливаюсь…`);
  clearInterval(pingInterval);
  clearInterval(maintenanceInterval);
  persistRooms();
  for (const ws of wss.clients) { try { ws.close(1012, "restart"); } catch (e) {} }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
// Непойманная ошибка всё равно завершит процесс (systemd его перезапустит),
// но сначала сохраняем партии, чтобы игроки вернулись в ту же игру.
process.on("uncaughtException", (e) => {
  console.error("uncaughtException:", e);
  persistRooms();
  process.exit(1);
});

restoreRooms();
// Магазин: помощники HTTP передаём в модули (без дублей), там же — сверка
// заказов при старте и фоновые задачи (таймеры с unref).
Payments.init({ sendJson, readJsonBody });
Ads.init({ sendJson });
const onListen = () => { console.log(`Trade Monopoly сервер запущен: http://${HOST || "localhost"}:${PORT}`); };
if (HOST) server.listen(PORT, HOST, onListen); else server.listen(PORT, onListen);
