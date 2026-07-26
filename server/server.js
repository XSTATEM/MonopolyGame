const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

// ---------------------------------------------------------------------
// Game data — ported 1:1 from app.html (companies, board, deck, tiers)
// ---------------------------------------------------------------------
const TIER_PRICE = { A: 40000, B: 20000, C: 8000 };
const COMPANIES = [
  { ticker: "AAPL", name: "Apple", sector: "Технологии", tier: "A" },
  { ticker: "MSFT", name: "Microsoft", sector: "Технологии", tier: "A" },
  { ticker: "GOOGL", name: "Google", sector: "Технологии", tier: "A" },
  { ticker: "NVDA", name: "NVIDIA", sector: "Технологии", tier: "B" },
  { ticker: "IBM", name: "IBM", sector: "Технологии", tier: "B" },
  { ticker: "AMZN", name: "Amazon", sector: "Интернет и медиа", tier: "B" },
  { ticker: "DIS", name: "Disney", sector: "Интернет и медиа", tier: "A" },
  { ticker: "YDEX", name: "Яндекс", sector: "Интернет и медиа", tier: "C" },
  { ticker: "VKCO", name: "VK", sector: "Интернет и медиа", tier: "C" },
  { ticker: "MCD", name: "McDonald's", sector: "Потребительские товары", tier: "A" },
  { ticker: "NKE", name: "Nike", sector: "Потребительские товары", tier: "B" },
  { ticker: "KO", name: "Coca-Cola", sector: "Потребительские товары", tier: "B" },
  { ticker: "WMT", name: "Walmart", sector: "Потребительские товары", tier: "B" },
  { ticker: "RKT", name: "Durex", sector: "Потребительские товары", tier: "C" },
  { ticker: "BA", name: "Boeing", sector: "Промышленность и транспорт", tier: "A" },
  { ticker: "MMM", name: "3M", sector: "Промышленность и транспорт", tier: "B" },
  { ticker: "AFLT", name: "Аэрофлот", sector: "Промышленность и транспорт", tier: "C" },
  { ticker: "SBER", name: "Сбербанк", sector: "Финансы и сырьё", tier: "B" },
  { ticker: "GAZP", name: "Газпром", sector: "Финансы и сырьё", tier: "C" },
  { ticker: "MGNT", name: "Магнит", sector: "Финансы и сырьё", tier: "C" },
  { ticker: "MTSS", name: "МТС", sector: "Финансы и сырьё", tier: "C" },
];
const BOARD = [
  ["AAPL","AMZN","MMM","MTSS","KO","YDEX","RKT","YDEX","NKE","AMZN","MMM","BA"],
  ["MGNT","GOOGL","NKE","AAPL","BA","GOOGL","AAPL","SBER","NVDA","AAPL","KO","MSFT"],
  ["MTSS","NKE","MSFT","RKT","IBM","NVDA","KO","GOOGL","WMT","IBM","MCD","DIS"],
  ["NVDA","NVDA","WMT","SBER","NKE","MGNT","AMZN","VKCO","AFLT","GAZP","MTSS","MGNT"],
  ["MGNT","GAZP","IBM","KO","AMZN","GOOGL","MSFT","IBM","AMZN","NVDA","MMM","GOOGL"],
  ["GAZP","SBER","VKCO","MTSS","BA","IBM","BA","KO","IBM","NKE","BA","AAPL"],
  ["MCD","MSFT","AMZN","RKT","MSFT","YDEX","AAPL","KO","MSFT","GOOGL","WMT","KO"],
  ["AAPL","KO","GOOGL","NKE","AFLT","MMM","YDEX","GOOGL","RKT","AMZN","NVDA","GOOGL"],
  ["MCD","MGNT","MSFT","MCD","AMZN","AAPL","IBM","MSFT","AAPL","MMM","IBM","RKT"],
  ["WMT","BA","GAZP","IBM","MGNT","NVDA","KO","RKT","SBER","VKCO","NVDA","BA"],
  ["GAZP","AFLT","MCD","GOOGL","KO","WMT","SBER","AFLT","IBM","SBER","KO","MSFT"],
  ["MCD","AAPL","MSFT","YDEX","MCD","NVDA","MMM","SBER","NVDA","GOOGL","YDEX","AAPL"],
];
function companyByTicker(t) { return COMPANIES.find((c) => c.ticker === t); }

function buildDeck() {
  const deck = [];
  const globals = [
    ["Мировой кризис", -15], ["Рецессия", -10], ["Паника на рынке", -10], ["Инфляционный шок", -5],
    ["Бум на рынке", 15], ["Позитивная макростатистика", 10], ["Снижение ставки ЦБ", 10], ["Оптимизм инвесторов", 5],
    ["Валютный кризис", -12], ["Дефицит поставок", -8], ["Технологический ренессанс", 12], ["Волна IPO", 8],
  ];
  globals.forEach(([t, p]) => deck.push({ type: "global", title: t, percent: p }));
  const sectorEvents = [
    ["Технологии", 20, "Технологический прорыв"], ["Технологии", -20, "Утечка данных в отрасли"],
    ["Технологии", 12, "Взрывной спрос на чипы"], ["Технологии", -15, "Антимонопольное расследование"],
    ["Интернет и медиа", 15, "Рост онлайн-аудитории"], ["Интернет и медиа", -15, "Отток рекламодателей"],
    ["Интернет и медиа", 10, "Успешный запуск сервиса"], ["Интернет и медиа", -10, "Блокировка платформы"],
    ["Потребительские товары", 12, "Ажиотажный спрос к сезону"], ["Потребительские товары", -12, "Бойкот покупателей"],
    ["Потребительские товары", 10, "Успешная рекламная кампания"], ["Потребительские товары", -18, "Отзыв продукции"],
    ["Промышленность и транспорт", 15, "Крупный госконтракт"], ["Промышленность и транспорт", -20, "Авария на производстве"],
    ["Промышленность и транспорт", 12, "Модернизация флота"], ["Промышленность и транспорт", -15, "Забастовка транспортников"],
    ["Финансы и сырьё", 15, "Скачок цен на сырьё"], ["Финансы и сырьё", -15, "Обвал цен на сырьё"],
    ["Финансы и сырьё", 10, "Снижение налогов на сектор"], ["Финансы и сырьё", -12, "Ужесточение регулирования банков"],
  ];
  sectorEvents.forEach(([s, p, t]) => deck.push({ type: "sector", title: t, sector: s, percent: p }));
  const companyEvents = [
    ["Смена CEO", -18, true], ["Рекордная квартальная прибыль", 22, false],
    ["Скандал с отчётностью", -25, true], ["Крупная сделка слияния", 18, false],
    ["Забастовка сотрудников", -12, true], ["Прорывной продукт", 20, false],
    ["Иск от регулятора", -16, true], ["Buyback объявлен менеджментом", 14, false],
    ["Утечка исходного кода", -14, false], ["Партнёрство с гигантом отрасли", 16, false],
    ["Санкции против компании", -22, true], ["Позитивный прогноз аналитиков", 12, false],
    ["Кибератака на инфраструктуру", -18, true], ["Выход на новый рынок", 15, false],
    ["Отставка совета директоров", -10, true], ["Заявление о рекордных дивидендах", 10, false],
    ["Отзыв лицензии", -20, true], ["Крупный контракт с государством", 18, false],
    ["Утечка данных клиентов", -16, true], ["Успешное IPO дочерней компании", 14, false],
    ["Расследование по коррупции", -14, true], ["Прорывная разработка запатентована", 16, false],
    ["Массовые увольнения", -10, false], ["Повышение кредитного рейтинга", 10, false],
  ];
  companyEvents.forEach(([t, p, skip]) => deck.push({ type: "company", title: t, percent: p, skipDividend: skip }));
  const specials = [
    { key: "freeze", title: "Заморозка цен", desc: "До конца этого события цены не меняются." },
    { key: "buyback", title: "Принудительный выкуп", desc: "Банк выкупает по 10% у каждого владельца одной случайной компании по текущей цене." },
    { key: "extra_trade", title: "Дополнительная фаза торгов", desc: "Сразу после этой фазы — ещё одна фаза свободных торгов без карты новостей." },
    { key: "audit", title: "Аудит", desc: "Каждый игрок с отрицательным балансом немедленно продаёт акции или объявляет банкротство." },
    { key: "double_dividend", title: "Дивидендный сезон", desc: "Все дивиденды до следующего события удваиваются." },
    { key: "tax", title: "Налоговая проверка", desc: "Каждый игрок платит банку 2% от своего текущего чистого капитала." },
    { key: "freeze", title: "Заморозка цен", desc: "До конца этого события цены не меняются." },
    { key: "buyback", title: "Принудительный выкуп", desc: "Банк выкупает по 10% у каждого владельца одной случайной компании по текущей цене." },
    { key: "extra_trade", title: "Дополнительная фаза торгов", desc: "Сразу после этой фазы — ещё одна фаза свободных торгов без карты новостей." },
    { key: "audit", title: "Аудит", desc: "Каждый игрок с отрицательным балансом немедленно продаёт акции или объявляет банкротство." },
    { key: "double_dividend", title: "Дивидендный сезон", desc: "Все дивиденды до следующего события удваиваются." },
    { key: "tax", title: "Налоговая проверка", desc: "Каждый игрок платит банку 2% от своего текущего чистого капитала." },
  ];
  specials.forEach((s) => deck.push({ type: "special", title: s.title, desc: s.desc, key: s.key }));
  return deck;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function fmt(n) { return "$" + Math.round(n).toLocaleString("ru-RU"); }

// ---------------------------------------------------------------------
// Room state
// ---------------------------------------------------------------------
const TRADE_WINDOW_MS = 90000;
const rooms = new Map(); // code -> room
const connections = new Map(); // ws -> {roomCode, playerId, name}

function freshRoom(code) {
  const companies = {};
  COMPANIES.forEach((c) => { companies[c.ticker] = { price: TIER_PRICE[c.tier], prevPrice: TIER_PRICE[c.tier] }; });
  return {
    code,
    companies,
    deckData: buildDeck(),
    deckOrder: shuffle(buildDeck().map((_, i) => i)),
    deckPos: 0,
    turn: 1,
    eventCount: 0,
    players: [],
    nextPlayerId: 1,
    nextTradeId: 1,
    turnOrder: [],
    turnIndex: 0,
    phase: "roll", // 'roll' | 'trade' | 'ended'
    pendingRoll: null,
    pendingTrades: [],
    dividendMultiplier: 1,
    frozen: false,
    extraTradePending: false,
    tradeWindowEndsAt: null,
    tradeTimer: null,
    log: [],
  };
}

function getOrCreateRoom(code) {
  if (!rooms.has(code)) rooms.set(code, freshRoom(code));
  return rooms.get(code);
}

function addLog(room, text, tag) {
  room.log.push({ text, tag: tag || "", turnTag: `Событие ${room.eventCount}`, ts: Date.now() });
  if (room.log.length > 300) room.log.shift();
}

function totalOwnedPct(room, ticker) {
  return room.players.reduce((sum, p) => sum + (p.holdings[ticker] || 0), 0);
}
function ownerOfControl(room, ticker) {
  return room.players.find((p) => !p.bankrupt && (p.holdings[ticker] || 0) > 50);
}
function netWorth(room, p) {
  let v = p.cash;
  for (const t in p.holdings) v += (p.holdings[t] / 100) * room.companies[t].price;
  return v;
}
function applyPriceDelta(room, ticker, pct) {
  if (room.frozen) return;
  const c = room.companies[ticker];
  const tierStart = TIER_PRICE[companyByTicker(ticker).tier];
  const floor = tierStart * 0.1;
  c.prevPrice = c.price;
  c.price = Math.max(floor, c.price * (1 + pct / 100));
}
function activePlayers(room) { return room.players.filter((p) => !p.bankrupt); }

function currentPlayerId(room) {
  if (room.turnOrder.length === 0) return null;
  for (let i = 0; i < room.turnOrder.length; i++) {
    const idx = (room.turnIndex + i) % room.turnOrder.length;
    const pid = room.turnOrder[idx];
    const p = room.players.find((x) => x.id === pid);
    if (p && !p.bankrupt) return pid;
  }
  return null;
}

function settleDebt(room, player) {
  if (player.cash >= 0) return;
  for (const ticker in player.holdings) {
    if (player.cash >= 0) break;
    const pct = player.holdings[ticker];
    if (pct <= 0) continue;
    const c = room.companies[ticker];
    const proceeds = c.price * (pct / 100);
    player.cash += proceeds;
    player.holdings[ticker] = 0;
    applyPriceDelta(room, ticker, -2 * (pct / 10));
    addLog(room, `${player.name}: принудительная продажа ${pct}% ${ticker} банку за ${fmt(proceeds)} для покрытия долга.`, "forced-sell");
  }
  if (player.cash < 0) {
    player.holdings = {};
    player.bankrupt = true;
    addLog(room, `💀 ${player.name} не может покрыть обязательства даже после продажи всех активов — объявлен банкротом.`, "bankrupt");
  }
}

function checkEndGame(room) {
  const active = activePlayers(room);
  if (room.players.length > 1 && active.length === 1 && room.phase !== "ended") {
    room.phase = "ended";
    if (room.tradeTimer) { clearTimeout(room.tradeTimer); room.tradeTimer = null; }
    addLog(room, `🏆 Игра окончена! Победитель: ${active[0].name}.`, "win");
  }
}

function marketEvent(room) {
  room.eventCount++;
  room.dividendMultiplier = 1;
  addLog(room, `— Биржевое событие #${room.eventCount} —`, "header");

  const roll = 1 + Math.floor(Math.random() * 6);
  let volPct = 0;
  if (roll <= 2) volPct = -5; else if (roll >= 5) volPct = 5;
  COMPANIES.forEach((c) => applyPriceDelta(room, c.ticker, volPct));
  addLog(room, `Кубик волатильности: ${roll} → ${volPct > 0 ? "+" : ""}${volPct}% всем компаниям`, "vol");

  if (room.deckPos >= room.deckOrder.length) {
    room.deckOrder = shuffle(room.deckOrder);
    room.deckPos = 0;
    addLog(room, "Колода новостей закончилась — переshuffle.", "deck");
  }
  const idx = room.deckOrder[room.deckPos++];
  const card = room.deckData[idx];
  room.frozen = false;

  if (card.type === "global") {
    COMPANIES.forEach((c) => applyPriceDelta(room, c.ticker, card.percent));
    addLog(room, `📰 [Глобальная] ${card.title}: ${card.percent > 0 ? "+" : ""}${card.percent}% всем компаниям`, "news");
  } else if (card.type === "sector") {
    COMPANIES.filter((c) => c.sector === card.sector).forEach((c) => applyPriceDelta(room, c.ticker, card.percent));
    addLog(room, `📰 [Отраслевая, ${card.sector}] ${card.title}: ${card.percent > 0 ? "+" : ""}${card.percent}%`, "news");
  } else if (card.type === "company") {
    const c = COMPANIES[Math.floor(Math.random() * COMPANIES.length)];
    applyPriceDelta(room, c.ticker, card.percent);
    if (card.skipDividend) room.companies[c.ticker].skipDividendUntil = room.eventCount + 1;
    addLog(room, `📰 [Точечная] ${c.name} (${c.ticker}) — ${card.title}: ${card.percent > 0 ? "+" : ""}${card.percent}%${card.skipDividend ? " (дивиденды пропущены на 1 ход)" : ""}`, "news");
  } else if (card.type === "special") {
    addLog(room, `🃏 [Особая] ${card.title}: ${card.desc}`, "news");
    if (card.key === "freeze") {
      room.frozen = true;
    } else if (card.key === "buyback") {
      const c = COMPANIES[Math.floor(Math.random() * COMPANIES.length)];
      room.players.forEach((p) => {
        const pct = p.holdings[c.ticker] || 0;
        if (pct >= 10) {
          const proceeds = room.companies[c.ticker].price * 0.1;
          p.holdings[c.ticker] -= 10;
          p.cash += proceeds;
          addLog(room, `🏦 Банк выкупил 10% ${c.ticker} у ${p.name} за ${fmt(proceeds)}.`, "buyback");
        }
      });
    } else if (card.key === "extra_trade") {
      room.extraTradePending = true;
    } else if (card.key === "audit") {
      activePlayers(room).forEach((p) => { if (p.cash < 0) settleDebt(room, p); });
    } else if (card.key === "double_dividend") {
      room.dividendMultiplier = 2;
    } else if (card.key === "tax") {
      activePlayers(room).forEach((p) => {
        const amt = netWorth(room, p) * 0.02;
        p.cash -= amt;
        addLog(room, `${p.name} заплатил налог: ${fmt(amt)}.`, "tax");
        settleDebt(room, p);
      });
    }
  }

  room.turn = 1;
  startTradeWindow(room);
}

function startTradeWindow(room) {
  room.phase = "trade";
  room.tradeWindowEndsAt = Date.now() + TRADE_WINDOW_MS;
  if (room.tradeTimer) clearTimeout(room.tradeTimer);
  room.tradeTimer = setTimeout(() => { endTradeWindow(room); broadcast(room); }, TRADE_WINDOW_MS);
}

function endTradeWindow(room) {
  room.tradeTimer = null;
  if (room.phase === "ended") return;
  if (room.extraTradePending) {
    room.extraTradePending = false;
    addLog(room, "🔁 Дополнительная фаза торгов начинается без новой карты.", "deck");
    startTradeWindow(room);
    return;
  }
  room.pendingTrades = [];
  room.phase = "roll";
  room.tradeWindowEndsAt = null;
  room.turnIndex = (room.turnIndex + 1) % Math.max(1, room.turnOrder.length);
  addLog(room, "Фаза торгов завершена. Ход переходит к следующему игроку.", "turn");
  checkEndGame(room);
}

function afterRollAction(room) {
  room.pendingRoll = null;
  room.turn++;
  if (room.turn > 3) {
    marketEvent(room);
  } else {
    room.turnIndex = (room.turnIndex + 1) % Math.max(1, room.turnOrder.length);
    addLog(room, `Ход завершён. Ход в раунде: ${room.turn}/3.`, "turn");
  }
  checkEndGame(room);
  broadcast(room);
}

// ---------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------
function sendTo(ws, obj) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); }
function sendError(conn, message) { sendTo(conn.ws, { type: "error", message }); }

function buildStatePayload(room) {
  return {
    type: "state",
    room: room.code,
    turn: room.turn,
    eventCount: room.eventCount,
    deckRemaining: room.deckOrder.length - room.deckPos,
    phase: room.phase,
    frozen: !!room.frozen,
    dividendMultiplier: room.dividendMultiplier || 1,
    tradeWindowEndsAt: room.tradeWindowEndsAt,
    currentPlayerId: currentPlayerId(room),
    pendingRoll: room.pendingRoll,
    pendingTrades: room.pendingTrades,
    companies: COMPANIES.map((c) => ({
      ticker: c.ticker, name: c.name, sector: c.sector, tier: c.tier,
      price: room.companies[c.ticker].price,
      prevPrice: room.companies[c.ticker].prevPrice,
      owned: totalOwnedPct(room, c.ticker),
      controllerId: (ownerOfControl(room, c.ticker) || {}).id || null,
    })),
    players: room.players.map((p) => ({
      id: p.id, name: p.name, cash: p.cash, holdings: p.holdings, bankrupt: p.bankrupt, connected: p.connected,
      netWorth: netWorth(room, p),
    })),
    log: room.log.slice(-60),
  };
}
function broadcast(room) {
  const payload = buildStatePayload(room);
  for (const [ws, conn] of connections) {
    if (conn.roomCode === room.code && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ ...payload, you: conn.playerId }));
    }
  }
}

function handleJoin(ws, msg) {
  const code = String(msg.room || "MAIN").trim().toUpperCase().slice(0, 20) || "MAIN";
  const name = String(msg.name || "").trim().slice(0, 20);
  if (!name) return sendTo(ws, { type: "error", message: "Введите имя игрока." });
  const room = getOrCreateRoom(code);

  let player = room.players.find((p) => p.name === name);
  if (player && player.connected) {
    return sendTo(ws, { type: "error", message: "Это имя уже занято в этой комнате." });
  }
  if (player) {
    player.connected = true;
    addLog(room, `Игрок «${name}» переподключился.`, "player");
  } else {
    player = { id: room.nextPlayerId++, name, cash: 150000, holdings: {}, bankrupt: false, connected: true };
    room.players.push(player);
    room.turnOrder.push(player.id);
    addLog(room, `Игрок «${name}» присоединился со стартовым капиталом ${fmt(150000)}.`, "player");
  }

  connections.set(ws, { ws, roomCode: code, playerId: player.id, name });
  sendTo(ws, { type: "joined", playerId: player.id, room: code });
  broadcast(room);
}

function requireRoom(conn) { return rooms.get(conn.roomCode); }

function handleRoll(conn) {
  const room = requireRoom(conn);
  if (!room || room.phase !== "roll") return sendError(conn, "Сейчас фаза торгов — дождитесь её окончания.");
  if (currentPlayerId(room) !== conn.playerId) return sendError(conn, "Сейчас не ваш ход.");
  if (room.pendingRoll) return sendError(conn, "Бросок уже сделан — выберите действие.");
  const row = 1 + Math.floor(Math.random() * 12);
  const col = 1 + Math.floor(Math.random() * 12);
  const ticker = BOARD[row - 1][col - 1];
  room.pendingRoll = { playerId: conn.playerId, row, col, ticker };
  const p = room.players.find((x) => x.id === conn.playerId);
  addLog(room, `🎲 ${p.name}: бросок строка ${row}, столбец ${col} → ${companyByTicker(ticker).name} (${ticker}).`, "roll");
  broadcast(room);
}

function handleBuyFromRoll(conn, msg) {
  const room = requireRoom(conn);
  if (!room || room.phase !== "roll" || !room.pendingRoll) return sendError(conn, "Нет активного броска.");
  if (room.pendingRoll.playerId !== conn.playerId) return sendError(conn, "Сейчас не ваш ход.");
  const pct = msg.pct === 25 ? 25 : 10;
  const ticker = room.pendingRoll.ticker;
  const p = room.players.find((x) => x.id === conn.playerId);
  const c = room.companies[ticker];
  const owned = totalOwnedPct(room, ticker);
  if (owned + pct > 100) return sendError(conn, "У банка недостаточно свободных акций этой компании.");
  const cost = c.price * (pct / 100);
  if (p.cash < cost) return sendError(conn, "Недостаточно наличных.");
  p.cash -= cost;
  p.holdings[ticker] = (p.holdings[ticker] || 0) + pct;
  applyPriceDelta(room, ticker, 2 * (pct / 10));
  addLog(room, `${p.name} купил ${pct}% ${ticker} по броску кубиков за ${fmt(cost)}. Новая цена: ${fmt(room.companies[ticker].price)}.`, "trade");
  afterRollAction(room);
}

function handleDividendFromRoll(conn) {
  const room = requireRoom(conn);
  if (!room || room.phase !== "roll" || !room.pendingRoll) return sendError(conn, "Нет активного броска.");
  if (room.pendingRoll.playerId !== conn.playerId) return sendError(conn, "Сейчас не ваш ход.");
  const ticker = room.pendingRoll.ticker;
  const c = room.companies[ticker];
  const payer = room.players.find((x) => x.id === conn.playerId);
  if (c.skipDividendUntil && c.skipDividendUntil >= room.eventCount) {
    addLog(room, `По ${ticker} дивиденды временно не платятся (эффект карты новостей).`, "dividend");
    return afterRollAction(room);
  }
  const owners = room.players.filter((p) => !p.bankrupt && p.id !== payer.id && (p.holdings[ticker] || 0) > 0);
  const totalPct = owners.reduce((s, p) => s + p.holdings[ticker], 0);
  let amount = c.price * 0.05 * (totalPct / 100) * (room.dividendMultiplier || 1);
  if (owners.length === 0 || amount <= 0) {
    addLog(room, `${payer.name}: дивиденды по ${ticker} не начисляются (нет других владельцев).`, "dividend");
    return afterRollAction(room);
  }
  payer.cash -= amount;
  owners.forEach((o) => { o.cash += amount * (o.holdings[ticker] / totalPct); });
  addLog(room, `${payer.name} заплатил дивиденды по ${ticker}: ${fmt(amount)}${room.dividendMultiplier > 1 ? " (×2, Дивидендный сезон)" : ""}, распределено между ${owners.length} владельцем(-ами).`, "dividend");
  settleDebt(room, payer);
  afterRollAction(room);
}

function handleSkipRoll(conn) {
  const room = requireRoom(conn);
  if (!room || room.phase !== "roll" || !room.pendingRoll) return sendError(conn, "Нет активного броска.");
  if (room.pendingRoll.playerId !== conn.playerId) return sendError(conn, "Сейчас не ваш ход.");
  const p = room.players.find((x) => x.id === conn.playerId);
  addLog(room, `${p.name} пропустил действие.`, "turn");
  afterRollAction(room);
}

function handleBuyBank(conn, msg) {
  const room = requireRoom(conn);
  if (!room || room.phase !== "trade") return sendError(conn, "Свободные торги доступны только во время биржевого события.");
  const p = room.players.find((x) => x.id === conn.playerId);
  if (!p || p.bankrupt) return;
  const pct = msg.pct === 25 ? 25 : 10;
  const c = room.companies[msg.ticker];
  if (!c) return;
  const owned = totalOwnedPct(room, msg.ticker);
  if (owned + pct > 100) return sendError(conn, "У банка недостаточно свободных акций.");
  const cost = c.price * (pct / 100);
  if (p.cash < cost) return sendError(conn, "Недостаточно наличных.");
  p.cash -= cost;
  p.holdings[msg.ticker] = (p.holdings[msg.ticker] || 0) + pct;
  applyPriceDelta(room, msg.ticker, 2 * (pct / 10));
  addLog(room, `${p.name} купил ${pct}% ${msg.ticker} у банка за ${fmt(cost)}.`, "trade");
  broadcast(room);
}

function handleSellBank(conn, msg) {
  const room = requireRoom(conn);
  if (!room || room.phase !== "trade") return sendError(conn, "Свободные торги доступны только во время биржевого события.");
  const p = room.players.find((x) => x.id === conn.playerId);
  if (!p || p.bankrupt) return;
  const pct = msg.pct === 25 ? 25 : 10;
  const c = room.companies[msg.ticker];
  if (!c) return;
  if ((p.holdings[msg.ticker] || 0) < pct) return sendError(conn, "Недостаточно акций этой компании.");
  const proceeds = c.price * (pct / 100);
  p.holdings[msg.ticker] -= pct;
  p.cash += proceeds;
  applyPriceDelta(room, msg.ticker, -2 * (pct / 10));
  addLog(room, `${p.name} продал ${pct}% ${msg.ticker} банку за ${fmt(proceeds)}.`, "trade");
  broadcast(room);
}

function handleProposeTrade(conn, msg) {
  const room = requireRoom(conn);
  if (!room || room.phase !== "trade") return sendError(conn, "Сделки доступны только во время фазы торгов.");
  const from = room.players.find((x) => x.id === conn.playerId);
  const to = room.players.find((x) => x.id === msg.to);
  if (!from || !to || from.id === to.id || to.bankrupt) return sendError(conn, "Некорректная сделка.");
  const pct = Math.max(1, Math.min(100, Math.round(Number(msg.pct) || 0)));
  const price = Math.max(0, Math.round(Number(msg.price) || 0));
  if ((from.holdings[msg.ticker] || 0) < pct) return sendError(conn, "Недостаточно акций для продажи.");
  const trade = { id: room.nextTradeId++, fromId: from.id, toId: to.id, ticker: msg.ticker, pct, price, status: "pending" };
  room.pendingTrades.push(trade);
  addLog(room, `🤝 ${from.name} предложил ${to.name} купить ${pct}% ${msg.ticker} за ${fmt(price)}.`, "trade-offer");
  broadcast(room);
}

function handleRespondTrade(conn, msg) {
  const room = requireRoom(conn);
  if (!room) return;
  const trade = room.pendingTrades.find((t) => t.id === msg.id && t.status === "pending");
  if (!trade) return;
  if (trade.toId !== conn.playerId) return sendError(conn, "Эта сделка предложена не вам.");
  const from = room.players.find((x) => x.id === trade.fromId);
  const to = room.players.find((x) => x.id === trade.toId);
  room.pendingTrades = room.pendingTrades.filter((t) => t !== trade);
  if (!msg.accept) {
    addLog(room, `${to.name} отклонил предложение ${from.name} по ${trade.ticker}.`, "trade-offer");
    return broadcast(room);
  }
  if ((from.holdings[trade.ticker] || 0) < trade.pct) { sendError(conn, "У продавца больше нет этих акций."); return broadcast(room); }
  if (to.cash < trade.price) { sendError(conn, "Недостаточно наличных для этой сделки."); return broadcast(room); }
  from.holdings[trade.ticker] -= trade.pct;
  to.holdings[trade.ticker] = (to.holdings[trade.ticker] || 0) + trade.pct;
  from.cash += trade.price;
  to.cash -= trade.price;
  addLog(room, `Сделка: ${to.name} купил ${trade.pct}% ${trade.ticker} у ${from.name} за ${fmt(trade.price)} (рыночная цена не меняется).`, "trade");
  broadcast(room);
}

function handleDeclareBankruptcy(conn) {
  const room = requireRoom(conn);
  if (!room) return;
  const p = room.players.find((x) => x.id === conn.playerId);
  if (!p || p.bankrupt) return;
  p.holdings = {};
  p.bankrupt = true;
  addLog(room, `💀 ${p.name} объявил банкротство.`, "bankrupt");
  if (room.pendingRoll && room.pendingRoll.playerId === p.id) room.pendingRoll = null;
  room.pendingTrades = room.pendingTrades.filter((t) => t.fromId !== p.id && t.toId !== p.id);
  checkEndGame(room);
  broadcast(room);
}

function handleNewGame(conn) {
  const room = requireRoom(conn);
  if (!room) return;
  const names = room.players.map((p) => p.name);
  if (room.tradeTimer) clearTimeout(room.tradeTimer);
  const fresh = freshRoom(room.code);
  names.forEach((n) => {
    const p = { id: fresh.nextPlayerId++, name: n, cash: 150000, holdings: {}, bankrupt: false, connected: true };
    fresh.players.push(p);
    fresh.turnOrder.push(p.id);
  });
  addLog(fresh, "🆕 Новая партия началась.", "header");
  rooms.set(room.code, fresh);
  for (const [, c] of connections) {
    if (c.roomCode === room.code) {
      const np = fresh.players.find((p) => p.name === c.name);
      if (np) c.playerId = np.id;
    }
  }
  broadcast(fresh);
}

function handleForceEvent(conn) {
  const room = requireRoom(conn);
  if (!room || room.phase !== "roll") return sendError(conn, "Событие можно вызвать только вне фазы торгов.");
  room.pendingRoll = null;
  marketEvent(room);
  broadcast(room);
}

function handleMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  if (msg.type === "join") return handleJoin(ws, msg);
  const conn = connections.get(ws);
  if (!conn) return sendTo(ws, { type: "error", message: "Сначала присоединитесь к комнате." });
  switch (msg.type) {
    case "roll": return handleRoll(conn);
    case "buyFromRoll": return handleBuyFromRoll(conn, msg);
    case "dividendFromRoll": return handleDividendFromRoll(conn);
    case "skipRoll": return handleSkipRoll(conn);
    case "buyBank": return handleBuyBank(conn, msg);
    case "sellBank": return handleSellBank(conn, msg);
    case "proposeTrade": return handleProposeTrade(conn, msg);
    case "respondTrade": return handleRespondTrade(conn, msg);
    case "declareBankruptcy": return handleDeclareBankruptcy(conn);
    case "newGame": return handleNewGame(conn);
    case "forceEvent": return handleForceEvent(conn);
  }
}

// ---------------------------------------------------------------------
// HTTP + WS server
// ---------------------------------------------------------------------
const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".ico": "image/x-icon" };

const server = http.createServer((req, res) => {
  let reqPath = decodeURIComponent(req.url.split("?")[0]);
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
        const p = room.players.find((x) => x.id === conn.playerId);
        if (p) { p.connected = false; addLog(room, `Игрок «${p.name}» отключился.`, "player"); broadcast(room); }
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
server.listen(PORT, () => { console.log(`Биржа-сервер запущен: http://localhost:${PORT}`); });
