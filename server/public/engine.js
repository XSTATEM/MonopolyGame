// ---------------------------------------------------------------------
// Trade Monopoly — общий игровой движок (без сети/таймеров/DOM).
// Используется и сервером (server.js, через require) и офлайн-режимом
// прямо в браузере (index.html, через <script src="/engine.js">, window.GameEngine).
// Любая функция-действие мутирует переданный room и возвращает
// {ok:true, ...} или {error:"сообщение"} — сеть/UI сами решают, что делать дальше.
// ---------------------------------------------------------------------
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GameEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DEFAULT_TRADE_WINDOW_MS = 90000;
  const TIER_PRICE = { A: 40000, B: 20000, C: 8000 };
  // Волатильность по тиру: голубые фишки (A) двигаются спокойнее, малые компании (C) — резче.
  // Множитель применяется к любому изменению цены (события, сделки, спецдействия).
  const TIER_VOL = { A: 0.7, B: 1.0, C: 1.6 };
  const VOL_LABEL = { A: "Низкая", B: "Средняя", C: "Высокая" };
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

  function freshRoom(code, tradeWindowMs) {
    const companies = {};
    COMPANIES.forEach((c) => {
      companies[c.ticker] = {
        price: TIER_PRICE[c.tier], prevPrice: TIER_PRICE[c.tier],
        lastNegInfoEvent: -100, lastPrEvent: -100, lastSqueezeEvent: -100, squeezedOut: false,
      };
    });
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
      nextShortId: 1,
      turnOrder: [],
      turnIndex: 0,
      phase: "lobby", // 'lobby' | 'roll' | 'trade' | 'ended'
      hostPlayerId: null,
      chat: [],
      nextChatId: 1,
      pendingRoll: null,
      pendingTrades: [],
      dividendMultiplier: 1,
      frozen: false,
      extraTradePending: false,
      tradeWindowEndsAt: null,
      tradeTimer: null, // используется только сервером (сетевой таймер), движок его не трогает
      tradeWindowMs: tradeWindowMs || DEFAULT_TRADE_WINDOW_MS,
      insiderUsedEvent: {},
      pendingInsider: null,
      shorts: [],
      log: [],
      createdAt: Date.now(),
    };
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
  function controlledTickers(room, playerId) {
    return COMPANIES.filter((c) => (room.players.find((p) => p.id === playerId)?.holdings[c.ticker] || 0) > 50).map((c) => c.ticker);
  }
  function netWorth(room, p) {
    let v = p.cash;
    for (const t in p.holdings) v += (p.holdings[t] / 100) * room.companies[t].price;
    return v;
  }
  function applyPriceDelta(room, ticker, pct) {
    if (room.frozen) return;
    const c = room.companies[ticker];
    const tier = companyByTicker(ticker).tier;
    const vol = TIER_VOL[tier] || 1;
    const tierStart = TIER_PRICE[tier];
    const floor = tierStart * 0.1;
    c.prevPrice = c.price;
    c.price = Math.max(floor, c.price * (1 + (pct * vol) / 100));
  }
  // Фоновый рыночный шум — небольшое случайное колебание всех цен при каждом броске
  // кубиков, чтобы рынок жил и между крупными биржевыми событиями (не только раз в 3 хода).
  function ambientJitter(room) {
    if (room.frozen) return;
    COMPANIES.forEach((c) => {
      const jitter = Math.random() * 3 - 1.5; // -1.5%..+1.5% до множителя волатильности тикера
      applyPriceDelta(room, c.ticker, jitter);
    });
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
      const winner = active[0];
      // Очки — за победу начисляются пропорционально итоговому капиталу (сумме, с которой игрок выиграл).
      const won = Math.round(netWorth(room, winner));
      const pointsEarned = Math.max(1, Math.round(won / 1000));
      winner.points = (winner.points || 0) + pointsEarned;
      addLog(room, `🏆 Игра окончена! Победитель: ${winner.name} с капиталом ${fmt(won)} — начислено ${pointsEarned} очков (всего ${winner.points}).`, "win");
    }
  }

  function resolveShorts(room, resolvingForEventCount) {
    const remaining = [];
    room.shorts.forEach((sh) => {
      if (sh.placedEventCount !== resolvingForEventCount) { remaining.push(sh); return; }
      const p = room.players.find((x) => x.id === sh.playerId);
      const c = room.companies[sh.ticker];
      if (!p) return;
      if (c.price < sh.priceAtBet) {
        const payout = sh.deposit * 2;
        p.cash += payout;
        addLog(room, `📉 Шорт ${p.name} по ${sh.ticker} сыграл — банк выплатил ${fmt(payout)}.`, "short");
      } else {
        addLog(room, `📈 Шорт ${p.name} по ${sh.ticker} не сыграл — залог ${fmt(sh.deposit)} сгорел.`, "short");
      }
    });
    room.shorts = remaining;
  }

  function startTradeWindow(room) {
    room.phase = "trade";
    room.tradeWindowEndsAt = Date.now() + (room.tradeWindowMs || DEFAULT_TRADE_WINDOW_MS);
  }

  function endTradeWindow(room) {
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

  function marketEvent(room) {
    const eventBeforeThis = room.eventCount;
    room.eventCount++;
    room.dividendMultiplier = 1;
    addLog(room, `— Биржевое событие #${room.eventCount} —`, "header");

    const roll = 1 + Math.floor(Math.random() * 6);
    let volPct = 0;
    if (roll <= 2) volPct = -5; else if (roll >= 5) volPct = 5;
    COMPANIES.forEach((c) => applyPriceDelta(room, c.ticker, volPct));
    addLog(room, `Кубик волатильности: ${roll} → база ${volPct > 0 ? "+" : ""}${volPct}% всем компаниям (фактически сильнее у волатильных тикеров)`, "vol");

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

    resolveShorts(room, eventBeforeThis);
    room.turn = 1;
    startTradeWindow(room);
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
  }

  // ---------------------------------------------------------------------
  // Игроки
  // ---------------------------------------------------------------------
  function addPlayer(room, name, gender, avatar) {
    name = String(name || "").trim().slice(0, 20);
    if (!name) return { error: "Введите имя игрока." };
    gender = String(gender || "").trim().slice(0, 24);
    avatar = String(avatar || "").trim().slice(0, 8);
    let player = room.players.find((p) => p.name === name);
    if (player && player.connected) {
      return { error: "Это имя уже занято в этой комнате." };
    }
    if (player) {
      player.connected = true;
      if (gender) player.gender = gender;
      if (avatar) player.avatar = avatar;
      addLog(room, `Игрок «${name}» переподключился.`, "player");
    } else {
      player = { id: room.nextPlayerId++, name, gender, avatar, points: 0, cash: 150000, holdings: {}, bankrupt: false, connected: true };
      room.players.push(player);
      room.turnOrder.push(player.id);
      addLog(room, `Игрок «${name}» присоединился со стартовым капиталом ${fmt(150000)}.`, "player");
    }
    if (room.phase === "lobby" && (!room.hostPlayerId || !room.players.some((x) => x.id === room.hostPlayerId && x.connected))) {
      room.hostPlayerId = player.id;
    }
    return { ok: true, player };
  }

  function setConnected(room, playerId, connected) {
    const p = room.players.find((x) => x.id === playerId);
    if (!p) return;
    p.connected = connected;
    if (!connected) {
      addLog(room, `Игрок «${p.name}» отключился.`, "player");
      if (room.phase === "lobby" && room.hostPlayerId === playerId) {
        const next = room.players.find((x) => x.connected && x.id !== playerId);
        room.hostPlayerId = next ? next.id : null;
        if (next) addLog(room, `«${next.name}» теперь хост комнаты.`, "player");
      }
    }
  }

  function startGame(room, playerId) {
    if (!room) return { error: "Комната не найдена." };
    if (room.phase !== "lobby") return { error: "Игра уже началась." };
    if (room.hostPlayerId !== playerId) return { error: "Начать игру может только хост комнаты." };
    if (room.players.length < 2) return { error: "Нужно минимум 2 игрока." };
    room.phase = "roll";
    addLog(room, "🚀 Хост начал игру.", "header");
    return { ok: true };
  }

  function sendChatMessage(room, playerId, text) {
    if (!room) return { error: "Комната не найдена." };
    const p = room.players.find((x) => x.id === playerId);
    if (!p) return { error: "Недоступно." };
    text = String(text || "").trim().slice(0, 300);
    if (!text) return { error: "Пустое сообщение." };
    room.chat.push({ id: room.nextChatId++, playerId, name: p.name, text, ts: Date.now() });
    if (room.chat.length > 200) room.chat.shift();
    return { ok: true };
  }

  function newGameKeepPlayers(room) {
    const prev = room.players.map((p) => ({ name: p.name, gender: p.gender, avatar: p.avatar, points: p.points || 0 }));
    const fresh = freshRoom(room.code, room.tradeWindowMs);
    fresh.phase = "roll"; // реванш — сразу к игре, без комнаты ожидания
    prev.forEach((pp) => {
      const p = { id: fresh.nextPlayerId++, name: pp.name, gender: pp.gender, avatar: pp.avatar, points: pp.points, cash: 150000, holdings: {}, bankrupt: false, connected: true };
      fresh.players.push(p);
      fresh.turnOrder.push(p.id);
    });
    addLog(fresh, "🆕 Новая партия началась.", "header");
    return fresh;
  }

  // ---------------------------------------------------------------------
  // Действия хода
  // ---------------------------------------------------------------------
  function rollDice(room, playerId) {
    if (!room || room.phase !== "roll") return { error: "Сейчас фаза торгов — дождитесь её окончания." };
    if (currentPlayerId(room) !== playerId) return { error: "Сейчас не ваш ход." };
    if (room.pendingRoll) return { error: "Бросок уже сделан — выберите действие." };
    ambientJitter(room);
    const row = 1 + Math.floor(Math.random() * 12);
    const col = 1 + Math.floor(Math.random() * 12);
    const ticker = BOARD[row - 1][col - 1];
    room.pendingRoll = { playerId, row, col, ticker };
    const p = room.players.find((x) => x.id === playerId);
    addLog(room, `🎲 ${p.name}: бросок строка ${row}, столбец ${col} → ${companyByTicker(ticker).name} (${ticker}).`, "roll");
    return { ok: true };
  }

  function buyFromRoll(room, playerId, pctRaw) {
    if (!room || room.phase !== "roll" || !room.pendingRoll) return { error: "Нет активного броска." };
    if (room.pendingRoll.playerId !== playerId) return { error: "Сейчас не ваш ход." };
    const pct = pctRaw === 25 ? 25 : 10;
    const ticker = room.pendingRoll.ticker;
    const p = room.players.find((x) => x.id === playerId);
    const c = room.companies[ticker];
    const owned = totalOwnedPct(room, ticker);
    if (owned + pct > 100) return { error: "У банка недостаточно свободных акций этой компании." };
    const cost = c.price * (pct / 100);
    if (p.cash < cost) return { error: "Недостаточно наличных." };
    p.cash -= cost;
    p.holdings[ticker] = (p.holdings[ticker] || 0) + pct;
    applyPriceDelta(room, ticker, 2 * (pct / 10));
    addLog(room, `${p.name} купил ${pct}% ${ticker} по броску кубиков за ${fmt(cost)}. Новая цена: ${fmt(room.companies[ticker].price)}.`, "trade");
    afterRollAction(room);
    return { ok: true };
  }

  function dividendFromRoll(room, playerId) {
    if (!room || room.phase !== "roll" || !room.pendingRoll) return { error: "Нет активного броска." };
    if (room.pendingRoll.playerId !== playerId) return { error: "Сейчас не ваш ход." };
    const ticker = room.pendingRoll.ticker;
    const c = room.companies[ticker];
    const payer = room.players.find((x) => x.id === playerId);
    if (c.skipDividendUntil && c.skipDividendUntil >= room.eventCount) {
      addLog(room, `По ${ticker} дивиденды временно не платятся (эффект карты новостей).`, "dividend");
      afterRollAction(room);
      return { ok: true };
    }
    const owners = room.players.filter((p) => !p.bankrupt && p.id !== payer.id && (p.holdings[ticker] || 0) > 0);
    const totalPct = owners.reduce((s, p) => s + p.holdings[ticker], 0);
    const squeezeMult = c.squeezedOut ? 2 : 1;
    let amount = c.price * 0.05 * (totalPct / 100) * (room.dividendMultiplier || 1) * squeezeMult;
    if (owners.length === 0 || amount <= 0) {
      addLog(room, `${payer.name}: дивиденды по ${ticker} не начисляются (нет других владельцев).`, "dividend");
      afterRollAction(room);
      return { ok: true };
    }
    payer.cash -= amount;
    owners.forEach((o) => { o.cash += amount * (o.holdings[ticker] / totalPct); });
    addLog(room, `${payer.name} заплатил дивиденды по ${ticker}: ${fmt(amount)}${room.dividendMultiplier > 1 ? " (×2, Дивидендный сезон)" : ""}${squeezeMult > 1 ? " (×2, сквиз-аут)" : ""}, распределено между ${owners.length} владельцем(-ами).`, "dividend");
    settleDebt(room, payer);
    afterRollAction(room);
    return { ok: true };
  }

  function skipRoll(room, playerId) {
    if (!room || room.phase !== "roll" || !room.pendingRoll) return { error: "Нет активного броска." };
    if (room.pendingRoll.playerId !== playerId) return { error: "Сейчас не ваш ход." };
    const p = room.players.find((x) => x.id === playerId);
    addLog(room, `${p.name} пропустил действие.`, "turn");
    afterRollAction(room);
    return { ok: true };
  }

  function buyBank() {
    // Правило: в свободной фазе торгов доступны только продажа банку и обмен (сделки
    // между игроками) — покупка у банка закрыта, чтобы не превращать окно торгов в обычную скупку.
    return { error: "В фазе свободных торгов можно только продать акции банку или предложить обмен другому игроку." };
  }

  function sellBank(room, playerId, ticker, pctRaw) {
    if (!room || room.phase !== "trade") return { error: "Свободные торги доступны только во время биржевого события." };
    const p = room.players.find((x) => x.id === playerId);
    if (!p || p.bankrupt) return { error: "Недоступно." };
    const pct = pctRaw === 25 ? 25 : 10;
    const c = room.companies[ticker];
    if (!c) return { error: "Неизвестная компания." };
    if ((p.holdings[ticker] || 0) < pct) return { error: "Недостаточно акций этой компании." };
    const proceeds = c.price * (pct / 100);
    p.holdings[ticker] -= pct;
    p.cash += proceeds;
    applyPriceDelta(room, ticker, -2 * (pct / 10));
    addLog(room, `${p.name} продал ${pct}% ${ticker} банку за ${fmt(proceeds)}.`, "trade");
    return { ok: true };
  }

  function proposeTrade(room, playerId, toId, ticker, pctRaw, priceRaw) {
    if (!room || room.phase !== "trade") return { error: "Сделки доступны только во время фазы торгов." };
    const from = room.players.find((x) => x.id === playerId);
    const to = room.players.find((x) => x.id === toId);
    if (!from || !to || from.id === to.id || to.bankrupt) return { error: "Некорректная сделка." };
    const pct = Math.max(1, Math.min(100, Math.round(Number(pctRaw) || 0)));
    const price = Math.max(0, Math.round(Number(priceRaw) || 0));
    if ((from.holdings[ticker] || 0) < pct) return { error: "Недостаточно акций для продажи." };
    const trade = { id: room.nextTradeId++, fromId: from.id, toId: to.id, ticker, pct, price, status: "pending" };
    room.pendingTrades.push(trade);
    addLog(room, `🤝 ${from.name} предложил ${to.name} купить ${pct}% ${ticker} за ${fmt(price)}.`, "trade-offer");
    return { ok: true };
  }

  function respondTrade(room, playerId, tradeId, accept) {
    if (!room) return { error: "Комната не найдена." };
    const trade = room.pendingTrades.find((t) => t.id === tradeId && t.status === "pending");
    if (!trade) return { error: "Сделка не найдена или уже обработана." };
    if (trade.toId !== playerId) return { error: "Эта сделка предложена не вам." };
    const from = room.players.find((x) => x.id === trade.fromId);
    const to = room.players.find((x) => x.id === trade.toId);
    room.pendingTrades = room.pendingTrades.filter((t) => t !== trade);
    if (!accept) {
      addLog(room, `${to.name} отклонил предложение ${from.name} по ${trade.ticker}.`, "trade-offer");
      return { ok: true };
    }
    if ((from.holdings[trade.ticker] || 0) < trade.pct) return { error: "У продавца больше нет этих акций.", stillChanged: true };
    if (to.cash < trade.price) return { error: "Недостаточно наличных для этой сделки.", stillChanged: true };
    from.holdings[trade.ticker] -= trade.pct;
    to.holdings[trade.ticker] = (to.holdings[trade.ticker] || 0) + trade.pct;
    from.cash += trade.price;
    to.cash -= trade.price;
    addLog(room, `Сделка: ${to.name} купил ${trade.pct}% ${trade.ticker} у ${from.name} за ${fmt(trade.price)} (рыночная цена не меняется).`, "trade");
    return { ok: true };
  }

  // ---------------------------------------------------------------------
  // §7 Спецдействия контрольного пакета (>50%)
  // ---------------------------------------------------------------------
  function requireTradePhaseForControl(room) {
    if (!room) return "Комната не найдена.";
    if (room.phase !== "trade") return "Спецдействия доступны только во время фазы торгов.";
    if (room.frozen) return "Заморозка цен — спецдействия запрещены до конца события.";
    return null;
  }

  function ctrlNegativeInfo(room, playerId, ticker) {
    const err = requireTradePhaseForControl(room);
    if (err) return { error: err };
    const p = room.players.find((x) => x.id === playerId);
    if (!p || p.bankrupt) return { error: "Недоступно." };
    const mine = controlledTickers(room, p.id);
    if (mine.length === 0) return { error: "Нужен контрольный пакет (>50%) хотя бы одной компании." };
    const target = room.companies[ticker];
    if (!target) return { error: "Неизвестная компания." };
    if (mine.includes(ticker)) return { error: "Действует только против чужой компании." };
    if (room.eventCount - target.lastNegInfoEvent < 2) return { error: "Эту компанию уже атаковали недавно — раз в 2 события." };
    const cost = 10000;
    if (p.cash < cost) return { error: "Недостаточно наличных ($10 000)." };
    p.cash -= cost;
    target.lastNegInfoEvent = room.eventCount;
    applyPriceDelta(room, ticker, -15);
    addLog(room, `📉 ${p.name} вбросил негативную информацию о ${ticker} за ${fmt(cost)}: −15%.`, "control");
    return { ok: true };
  }

  function ctrlPrCampaign(room, playerId, ticker) {
    const err = requireTradePhaseForControl(room);
    if (err) return { error: err };
    const p = room.players.find((x) => x.id === playerId);
    if (!p || p.bankrupt) return { error: "Недоступно." };
    if ((p.holdings[ticker] || 0) <= 50) return { error: "Нужен контрольный пакет (>50%) этой компании." };
    const c = room.companies[ticker];
    if (room.eventCount === c.lastPrEvent) return { error: "PR-кампания по этой компании уже проведена в это событие." };
    const cost = c.price * 0.05;
    if (p.cash < cost) return { error: "Недостаточно наличных для PR-кампании (5% капитализации)." };
    p.cash -= cost;
    c.lastPrEvent = room.eventCount;
    applyPriceDelta(room, ticker, 10);
    addLog(room, `📈 ${p.name} провёл PR-кампанию/байбэк ${ticker} за ${fmt(cost)}: +10%.`, "control");
    return { ok: true };
  }

  function ctrlInsiderPeek(room, playerId) {
    const err = requireTradePhaseForControl(room);
    if (err) return { error: err };
    const p = room.players.find((x) => x.id === playerId);
    if (!p || p.bankrupt) return { error: "Недоступно." };
    if (controlledTickers(room, p.id).length === 0) return { error: "Нужен контрольный пакет (>50%) хотя бы одной компании." };
    if (room.insiderUsedEvent[p.id] === room.eventCount) return { error: "Инсайд уже использован в это событие." };
    if (room.pendingInsider) return { error: "Кто-то уже подсматривает карту — дождитесь решения." };
    if (p.cash < 5000) return { error: "Недостаточно наличных ($5 000)." };
    p.cash -= 5000;
    room.insiderUsedEvent[p.id] = room.eventCount;
    if (room.deckPos >= room.deckOrder.length) { room.deckOrder = shuffle(room.deckOrder); room.deckPos = 0; }
    const idx = room.deckOrder[room.deckPos];
    const card = room.deckData[idx];
    room.pendingInsider = { playerId: p.id };
    addLog(room, `🕵️ ${p.name} использовал Инсайд за $5 000 — подсматривает верхнюю карту колоды.`, "control");
    return { ok: true, card };
  }

  function ctrlInsiderResolve(room, playerId, action) {
    if (!room || !room.pendingInsider || room.pendingInsider.playerId !== playerId) return { error: "Нечего разрешать." };
    const p = room.players.find((x) => x.id === playerId);
    if (action === "moveToBack") {
      const idx = room.deckOrder[room.deckPos];
      room.deckOrder.splice(room.deckPos, 1);
      room.deckOrder.push(idx);
      addLog(room, `${p ? p.name : "?"} переложил подсмотренную карту в конец колоды.`, "control");
    } else {
      addLog(room, `${p ? p.name : "?"} оставил карту наверху колоды.`, "control");
    }
    room.pendingInsider = null;
    return { ok: true };
  }

  function ctrlSqueezeOut(room, playerId, ticker) {
    const err = requireTradePhaseForControl(room);
    if (err) return { error: err };
    const p = room.players.find((x) => x.id === playerId);
    if (!p || p.bankrupt) return { error: "Недоступно." };
    if ((p.holdings[ticker] || 0) <= 75) return { error: "Нужно больше 75% этой компании." };
    const c = room.companies[ticker];
    const minority = room.players.filter((x) => x.id !== p.id && !x.bankrupt && (x.holdings[ticker] || 0) > 0);
    if (minority.length === 0) return { error: "Нет миноритариев для выкупа." };
    const totalCost = minority.reduce((s, x) => s + c.price * (x.holdings[ticker] / 100), 0);
    if (p.cash < totalCost) return { error: `Недостаточно наличных для выкупа (нужно ${fmt(totalCost)}).` };
    p.cash -= totalCost;
    minority.forEach((x) => {
      const proceeds = c.price * (x.holdings[ticker] / 100);
      x.cash += proceeds;
      p.holdings[ticker] = (p.holdings[ticker] || 0) + x.holdings[ticker];
      x.holdings[ticker] = 0;
    });
    c.squeezedOut = true;
    c.lastSqueezeEvent = room.eventCount;
    addLog(room, `🧹 ${p.name} принудительно выкупил миноритариев ${ticker} за ${fmt(totalCost)} — теперь дивиденды по ней ×2.`, "control");
    return { ok: true };
  }

  function ctrlShort(room, playerId, ticker) {
    const err = requireTradePhaseForControl(room);
    if (err) return { error: err };
    const p = room.players.find((x) => x.id === playerId);
    if (!p || p.bankrupt) return { error: "Недоступно." };
    const c = room.companies[ticker];
    if (!c) return { error: "Неизвестная компания." };
    if (room.shorts.some((s) => s.playerId === p.id && s.ticker === ticker)) return { error: "У вас уже есть открытый шорт по этой компании." };
    if (p.cash < 5000) return { error: "Недостаточно наличных ($5 000 залог)." };
    p.cash -= 5000;
    room.shorts.push({ id: room.nextShortId++, playerId: p.id, ticker, deposit: 5000, priceAtBet: c.price, placedEventCount: room.eventCount });
    addLog(room, `🎲 ${p.name} открыл шорт по ${ticker} (залог $5 000), ставка на падение к следующему событию.`, "control");
    return { ok: true };
  }

  function declareBankruptcy(room, playerId) {
    if (!room) return { error: "Комната не найдена." };
    const p = room.players.find((x) => x.id === playerId);
    if (!p || p.bankrupt) return { error: "Недоступно." };
    p.holdings = {};
    p.bankrupt = true;
    addLog(room, `💀 ${p.name} объявил банкротство.`, "bankrupt");
    if (room.pendingRoll && room.pendingRoll.playerId === p.id) room.pendingRoll = null;
    room.pendingTrades = room.pendingTrades.filter((t) => t.fromId !== p.id && t.toId !== p.id);
    checkEndGame(room);
    return { ok: true };
  }

  function forceEvent(room) {
    if (!room || room.phase !== "roll") return { error: "Событие можно вызвать только вне фазы торгов." };
    room.pendingRoll = null;
    marketEvent(room);
    return { ok: true };
  }

  // ---------------------------------------------------------------------
  // Состояние для клиента
  // ---------------------------------------------------------------------
  function buildStatePayload(room, youId) {
    return {
      type: "state",
      you: youId,
      room: room.code,
      turn: room.turn,
      eventCount: room.eventCount,
      deckRemaining: room.deckOrder.length - room.deckPos,
      phase: room.phase,
      hostPlayerId: room.hostPlayerId || null,
      canStart: room.phase === "lobby" && room.hostPlayerId === youId && room.players.length >= 2,
      chat: room.phase === "lobby" ? room.chat.slice(-100) : undefined,
      frozen: !!room.frozen,
      dividendMultiplier: room.dividendMultiplier || 1,
      tradeWindowEndsAt: room.tradeWindowEndsAt,
      tradeWindowMs: room.tradeWindowMs,
      currentPlayerId: currentPlayerId(room),
      pendingRoll: room.pendingRoll,
      pendingTrades: room.pendingTrades,
      shorts: room.shorts,
      pendingInsider: room.pendingInsider,
      companies: COMPANIES.map((c) => ({
        ticker: c.ticker, name: c.name, sector: c.sector, tier: c.tier,
        volLabel: VOL_LABEL[c.tier] || "Средняя",
        price: room.companies[c.ticker].price,
        prevPrice: room.companies[c.ticker].prevPrice,
        owned: totalOwnedPct(room, c.ticker),
        controllerId: (ownerOfControl(room, c.ticker) || {}).id || null,
        squeezedOut: !!room.companies[c.ticker].squeezedOut,
        lastNegInfoEvent: room.companies[c.ticker].lastNegInfoEvent,
        lastPrEvent: room.companies[c.ticker].lastPrEvent,
      })),
      players: room.players.map((p) => ({
        id: p.id, name: p.name, gender: p.gender || "", avatar: p.avatar || "", points: p.points || 0,
        cash: p.cash, holdings: p.holdings, bankrupt: p.bankrupt, connected: p.connected,
        netWorth: netWorth(room, p),
      })),
      log: room.log.slice(-60),
    };
  }

  return {
    DEFAULT_TRADE_WINDOW_MS, TIER_PRICE, TIER_VOL, VOL_LABEL, COMPANIES, BOARD,
    companyByTicker, buildDeck, shuffle, fmt,
    freshRoom, addLog,
    totalOwnedPct, ownerOfControl, controlledTickers, netWorth, applyPriceDelta, ambientJitter, activePlayers, currentPlayerId,
    settleDebt, checkEndGame, resolveShorts, marketEvent, startTradeWindow, endTradeWindow, afterRollAction,
    addPlayer, setConnected, newGameKeepPlayers, startGame, sendChatMessage,
    rollDice, buyFromRoll, dividendFromRoll, skipRoll, buyBank, sellBank, proposeTrade, respondTrade,
    ctrlNegativeInfo, ctrlPrCampaign, ctrlInsiderPeek, ctrlInsiderResolve, ctrlSqueezeOut, ctrlShort,
    declareBankruptcy, forceEvent,
    buildStatePayload,
  };
});
