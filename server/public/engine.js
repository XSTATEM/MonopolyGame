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

  const TIER_PRICE = { A: 40000, B: 20000, C: 8000 };
  // Волатильность по тиру: голубые фишки (A) двигаются спокойнее, малые компании (C) — резче.
  // Множитель применяется к любому изменению цены (события, сделки, спецдействия).
  const TIER_VOL = { A: 0.7, B: 1.0, C: 1.6 };
  const VOL_LABEL = { A: "Низкая", B: "Средняя", C: "Высокая" };
  // Доля капитализации, которую платит игрок, отказавшийся покупать уже частично
  // выкупленные акции — выше у мелких/волатильных компаний (тир C), ниже у голубых
  // фишек (тир A), по аналогии с TIER_VOL.
  const TIER_FORCED_PAYMENT_PCT = { A: 0.06, B: 0.1, C: 0.16 };
  // Множитель дивидендов по тиру: голубые фишки (A) платят чаще и стабильнее (×1.0),
  // средние компании (B) — стандартно (×1.0), малые компании (C) платят реже, но
  // крупнее (×1.4). Применяется к итоговой выплате дивидендов.
  const TIER_DIVIDEND_MULT = { A: 1.0, B: 1.0, C: 1.4 };
  // Вероятность пропуска дивидендов по тиру при каждом броске: голубые фишки (A)
  // платят стабильно (5% пропуск), средние (B) иногда пропускают (12%), малые (C)
  // часто пропускают (25%), но когда платят - платят больше (см. TIER_DIVIDEND_MULT).
  const TIER_DIVIDEND_SKIP_CHANCE = { A: 0.05, B: 0.12, C: 0.25 };
  // Небольшой пассивный доход ("зарплата") в начале каждого своего хода — компенсирует
  // урезанный стартовый капитал и возросшие принудительные выплаты (см. выше), которые
  // без этого держали активных игроков почти без наличных ~30% времени партии.
  const TURN_SALARY = 450;
  // Биржевое событие раз в фиксированное число ходов, а не раз за полный круг
  // по столу — иначе частота событий на игрока зависела от количества игроков
  // (в партии на 6 человек события были почти в 2 раза реже на ход, чем на двоих),
  // и игра с большим столом непропорционально затягивалась.
  const EVENT_INTERVAL_TURNS = 4;
  const PRICE_HISTORY_MAX = 50;
  // Стартовый капитал — снижен со 150000, чтобы банкротства наступали раньше
  // (запас прочности игрока меньше, а вынужденные выплаты по TIER_FORCED_PAYMENT_PCT
  // съедают его заметно быстрее).
  const STARTING_CASH = 100000;
  // Порог «завышенной» цены, которую назначает контролирующий (>50%) игрок:
  // во сколько раз она может превышать «справедливую» (тирную) ставку без последствий.
  const FORCED_PRICE_EXCESSIVE_MULT = 4;
  const ANTITRUST_CONFISCATE_PCT = 15;
  const COMPANIES = [
    { ticker: "AAPL", name: "Apple", sector: "Технологии", tier: "A" },
    { ticker: "MSFT", name: "Microsoft", sector: "Технологии", tier: "A" },
    { ticker: "GOOGL", name: "Google", sector: "Технологии", tier: "A" },
    { ticker: "NVDA", name: "NVIDIA", sector: "Технологии", tier: "B" },
    { ticker: "IBM", name: "IBM", sector: "Технологии", tier: "B" },
    { ticker: "INTC", name: "Intel", sector: "Технологии", tier: "B" },
    { ticker: "SONY", name: "Sony", sector: "Технологии", tier: "B" },
    { ticker: "AMZN", name: "Amazon", sector: "Интернет и медиа", tier: "B" },
    { ticker: "DIS", name: "Disney", sector: "Интернет и медиа", tier: "A" },
    { ticker: "NFLX", name: "Netflix", sector: "Интернет и медиа", tier: "A" },
    { ticker: "META", name: "Meta", sector: "Интернет и медиа", tier: "A" },
    { ticker: "YDEX", name: "Яндекс", sector: "Интернет и медиа", tier: "C" },
    { ticker: "VKCO", name: "VK", sector: "Интернет и медиа", tier: "C" },
    { ticker: "MCD", name: "McDonald's", sector: "Потребительские товары", tier: "A" },
    { ticker: "NKE", name: "Nike", sector: "Потребительские товары", tier: "B" },
    { ticker: "KO", name: "Coca-Cola", sector: "Потребительские товары", tier: "B" },
    { ticker: "WMT", name: "Walmart", sector: "Потребительские товары", tier: "B" },
    { ticker: "PEP", name: "Pepsi", sector: "Потребительские товары", tier: "B" },
    { ticker: "SBUX", name: "Starbucks", sector: "Потребительские товары", tier: "B" },
    { ticker: "RKT", name: "Durex", sector: "Потребительские товары", tier: "C" },
    { ticker: "ADS", name: "Adidas", sector: "Потребительские товары", tier: "C" },
    { ticker: "BA", name: "Boeing", sector: "Промышленность и транспорт", tier: "A" },
    { ticker: "TSLA", name: "Tesla", sector: "Промышленность и транспорт", tier: "A" },
    { ticker: "MMM", name: "3M", sector: "Промышленность и транспорт", tier: "B" },
    { ticker: "AFLT", name: "Аэрофлот", sector: "Промышленность и транспорт", tier: "C" },
    { ticker: "F", name: "Ford", sector: "Промышленность и транспорт", tier: "C" },
    { ticker: "V", name: "Visa", sector: "Финансы и сырьё", tier: "A" },
    { ticker: "SBER", name: "Сбербанк", sector: "Финансы и сырьё", tier: "B" },
    { ticker: "GAZP", name: "Газпром", sector: "Финансы и сырьё", tier: "C" },
    { ticker: "MGNT", name: "Магнит", sector: "Финансы и сырьё", tier: "C" },
    { ticker: "MTSS", name: "МТС", sector: "Финансы и сырьё", tier: "C" },
  ];
  // Клетки вида "RE:<cityId>" — недвижимость (см. CITIES ниже), вкраплена в поле
  // акций почти как в «Монополии»: 16 клеток из 144 отданы под конкретные города
  // (ровно по одной клетке на город — шанс попасть на каждый город одинаков).
  // Раньше оставшиеся 128 клеток были расставлены вручную, и шансы выпадения
  // компаний отличались в разы (например, Apple/Google получали по 10 клеток,
  // а Disney — всего 1). Теперь поле собирается программно (buildBoard ниже):
  // каждая компания получает максимально равное число клеток (128 / N компаний,
  // остаток размазывается по одной лишней клетке — так что расхождение между
  // любыми двумя компаниями не больше одной клетки), а сама раскладка на поле
  // перемешивается детерминированным генератором с фиксированным seed — поле
  // не меняется от перезапуска к перезапуску, но и не расставлено вручную.
  const RE_CITY_IDS = ["nyc", "sf", "la", "boston", "seattle", "chicago", "miami", "dc", "denver", "austin", "dallas", "atlanta", "houston", "phoenix", "vegas", "detroit"];
  const RE_CELL_POS = [
    [0, 1], [0, 6], [1, 9], [2, 3], [2, 8], [3, 0], [3, 5], [4, 10],
    [5, 2], [5, 7], [6, 4], [6, 9], [7, 1], [8, 6], [9, 3], [10, 8],
  ]; // те же 16 позиций, что и в прежнем вручную составленном поле — раскладка городов не меняется

  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function seededShuffle(arr, seed) {
    const rnd = mulberry32(seed);
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }
  function buildBoard() {
    const size = 12;
    const total = size * size; // 144
    const rePosSet = new Set(RE_CELL_POS.map(([r, c]) => r * size + c));
    const nonRECount = total - rePosSet.size; // 128
    const n = COMPANIES.length;
    const base = Math.floor(nonRECount / n);
    const extra = nonRECount - base * n; // столько компаний получат на 1 клетку больше остальных
    // Кому именно достанется лишняя клетка — тоже определяем детерминированным
    // перемешиванием (а не первым N по порядку объявления), чтобы бонусная клетка
    // не была всегда у одних и тех же тикеров/секторов.
    const extraOrder = seededShuffle(COMPANIES.map((c, i) => i), 733221);
    const extraSet = new Set(extraOrder.slice(0, extra));
    let tickerPool = [];
    COMPANIES.forEach((c, i) => {
      const count = base + (extraSet.has(i) ? 1 : 0);
      for (let k = 0; k < count; k++) tickerPool.push(c.ticker);
    });
    tickerPool = seededShuffle(tickerPool, 20260728);
    const grid = [];
    let poolIdx = 0;
    for (let r = 0; r < size; r++) {
      const row = [];
      for (let c = 0; c < size; c++) {
        const idx = r * size + c;
        if (rePosSet.has(idx)) {
          const reIdx = RE_CELL_POS.findIndex(([rr, cc]) => rr === r && cc === c);
          row.push("RE:" + RE_CITY_IDS[reIdx]);
        } else {
          row.push(tickerPool[poolIdx++]);
        }
      }
      grid.push(row);
    }
    return grid;
  }
  const BOARD = buildBoard();
  const REAL_ESTATE_POS = {};
  for (let r = 0; r < 12; r++) {
    for (let c = 0; c < 12; c++) {
      const cell = BOARD[r][c];
      if (isRealEstateCell(cell)) REAL_ESTATE_POS[cityIdFromCell(cell)] = { row: r + 1, col: c + 1 };
    }
  }
  function companyByTicker(t) { return COMPANIES.find((c) => c.ticker === t); }
  function isRealEstateCell(cell) { return typeof cell === "string" && cell.indexOf("RE:") === 0; }
  function cityIdFromCell(cell) { return cell.slice(3); }

  // Репутация инвестора: 0..100, стартовая 50. Влияет на условия кредита,
  // комиссию банка при покупке и доверие в сделках (последнее — чисто UI-сигнал).
  const REPUTATION_START = 50;
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function adjustReputation(room, player, delta, reason) {
    if (!player) return;
    if (player.reputation == null) player.reputation = REPUTATION_START;
    player.reputation = clamp(Math.round(player.reputation + delta), 0, 100);
  }
  // Комиссия банка при покупке (акции/недвижимость) — растёт при низкой репутации.
  function bankFeePct(reputation) {
    const rep = reputation == null ? REPUTATION_START : reputation;
    if (rep >= 70) return 0;
    if (rep >= 40) return 0.015;
    if (rep >= 20) return 0.035;
    return 0.06;
  }
  // Условия кредита банка — лимит и ставка зависят от репутации и текущего чистого капитала.
  function loanTerms(room, player) {
    const rep = player.reputation == null ? REPUTATION_START : player.reputation;
    const nw = Math.max(0, netWorth(room, player));
    const limit = Math.round(nw * (0.10 + (rep / 100) * 0.35));
    const ratePct = Math.round(clamp(28 - rep * 0.22, 4, 28) * 10) / 10;
    return { limit, ratePct };
  }

  // Недвижимость — теперь привязана к конкретным клеткам стола (см. BOARD/REAL_ESTATE_POS
  // выше), как в «Монополии»: один город = одна уникальная клетка = один объект.
  // Цена/рента — база города × рыночный множитель факт (дрейфует каждое биржевое
  // событие) × надбавка за уровень улучшения (0..MAX_RE_LEVEL). 16 городов — в
  // требуемом диапазоне 10-20.
  const CITIES = [
    { id: "nyc", name: "Нью-Йорк", price: 220000, rent: 9000 },
    { id: "sf", name: "Сан-Франциско", price: 200000, rent: 8200 },
    { id: "la", name: "Лос-Анджелес", price: 180000, rent: 7200 },
    { id: "boston", name: "Бостон", price: 150000, rent: 6000 },
    { id: "seattle", name: "Сиэтл", price: 140000, rent: 5600 },
    { id: "dc", name: "Вашингтон", price: 135000, rent: 5400 },
    { id: "miami", name: "Майами", price: 130000, rent: 5200 },
    { id: "chicago", name: "Чикаго", price: 120000, rent: 4800 },
    { id: "denver", name: "Денвер", price: 100000, rent: 4000 },
    { id: "austin", name: "Остин", price: 95000, rent: 3800 },
    { id: "dallas", name: "Даллас", price: 85000, rent: 3400 },
    { id: "atlanta", name: "Атланта", price: 80000, rent: 3200 },
    { id: "houston", name: "Хьюстон", price: 75000, rent: 3000 },
    { id: "phoenix", name: "Финикс", price: 70000, rent: 2800 },
    { id: "vegas", name: "Лас-Вегас", price: 65000, rent: 2600 },
    { id: "detroit", name: "Детройт", price: 40000, rent: 1800 },
  ];
  const MAX_RE_LEVEL = 4;
  // Понижающий множитель к номинальной цене города: изначальные цены (до ×220000)
  // делали недвижимость почти недоступной со стартовым капиталом 150000 — за всю
  // партию она почти не покупалась (см. симуляцию ботов). 0.7 возвращает её в
  // разумный диапазон покупки, оставляя ренту (доходность) прежней.
  const RE_PRICE_ADJUST = 0.7;
  function cityById(id) { return CITIES.find((r) => r.id === id); }
  // Текущая цена покупки/оценки объекта: база города × рыночный фактор × (1 + 0.4 за уровень).
  function realEstatePrice(room, cityId) {
    const ct = cityById(cityId);
    const re = room.realEstate[cityId];
    if (!ct || !re) return 0;
    const lvl = re.level || 0;
    return ct.price * RE_PRICE_ADJUST * (re.factor || 1) * (1 + lvl * 0.4);
  }
  // Текущая рента: база города × рыночный фактор × (1 + 0.6 за уровень).
  function realEstateRent(room, cityId) {
    const ct = cityById(cityId);
    const re = room.realEstate[cityId];
    if (!ct || !re) return 0;
    const lvl = re.level || 0;
    return ct.rent * (re.factor || 1) * (1 + lvl * 0.6);
  }
  // Стоимость следующего улучшения — снижена с 1.5x до 1.0x для повышения привлекательности.
  function realEstateUpgradeCost(room, cityId) { return realEstatePrice(room, cityId) * 1.0; }

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
      { key: "extra_turn", title: "Дополнительный ход", desc: "Игрок, при котором наступило это событие, получает ещё один ход подряд." },
      { key: "audit", title: "Аудит", desc: "Каждый игрок с отрицательным балансом немедленно продаёт акции или объявляет банкротство." },
      { key: "double_dividend", title: "Дивидендный сезон", desc: "Все дивиденды до следующего события удваиваются." },
      { key: "tax", title: "Налоговая проверка", desc: "Каждый игрок платит банку 2% от своего текущего чистого капитала." },
      { key: "freeze", title: "Заморозка цен", desc: "До конца этого события цены не меняются." },
      { key: "buyback", title: "Принудительный выкуп", desc: "Банк выкупает по 10% у каждого владельца одной случайной компании по текущей цене." },
      { key: "extra_turn", title: "Дополнительный ход", desc: "Игрок, при котором наступило это событие, получает ещё один ход подряд." },
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

  function freshRoom(code) {
    const companies = {};
    COMPANIES.forEach((c) => {
      companies[c.ticker] = {
        price: TIER_PRICE[c.tier], prevPrice: TIER_PRICE[c.tier],
        lastNegInfoEvent: -100, lastPrEvent: -100, lastSqueezeEvent: -100, squeezedOut: false, fullyOwned: false,
        trendFactor: 1,
        priceHistory: [{ t: 0, p: Math.round(TIER_PRICE[c.tier]) }],
      };
    });
    const realEstate = {};
    CITIES.forEach((ct) => { realEstate[ct.id] = { ownerId: null, level: 0, factor: 1 }; });
    return {
      code,
      companies,
      realEstate,
      reveals: [], // {spyId, targetId, expiresEvent} — раскрытые шпионажем активы
      spyCooldown: {}, // targetId -> eventCount последней попытки шпионажа против него
      discreditCooldown: {}, // targetId -> eventCount последней попытки дискредитации
      investigateCooldown: {}, // targetId -> eventCount последнего расследования
      spyIncidents: [], // {id, kind:'espionage'|'discredit', targetId, suspectId, eventCount} — нераскрытые случаи, ждущие расследования
      nextIncidentId: 1,
      lastMergeEvent: -100, // eventCount последнего слияния компаний (раз в событие)
      gameResult: null, // {winnerId, winnerName, netWorth, pointsEarned, ranking:[{id,name,netWorth,bankrupt,points}]}
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
      phase: "lobby", // 'lobby' | 'roll' | 'ended'
      hostPlayerId: null,
      chat: [],
      nextChatId: 1,
      maxRounds: null, // null = игра до банкротства всех соперников; иначе число раундов, после которого побеждает лидер по капиталу
      roundNumber: 1,
      pendingRoll: null,
      pendingForcedPrice: null, // {ticker, controllerId, targetId, amount} — контролирующий игрок назначил цену выкупа доли
      pendingTrades: [],
      dividendMultiplier: 1,
      frozen: false,
      rolledThisTurn: false, // бросил ли текущий игрок кубики в этот ход (чтобы нельзя было бросить дважды)
      extraTurnPending: false, // игрок, вызвавший биржевое событие, получает ещё один ход подряд
      insiderUsedEvent: {},
      pendingInsider: null,
      shorts: [],
      log: [],
      createdAt: Date.now(),
      kickVote: null, // {targetId, initiatorId, startedAt, voters:{playerId:true}}
      reactions: [], // {id, playerId, emoji, ts} — короткоживущие реакции за столом, чистятся по TTL на клиенте
      nextReactionId: 1,
      settings: { // Настройки комнаты (изменяемые хостом в лобби)
        startingCash: STARTING_CASH,
        turnSalary: TURN_SALARY,
        eventIntervalTurns: EVENT_INTERVAL_TURNS,
        tierForcedPaymentPct: [20, 15, 10], // A, B, C
      },
    };
  }

  // visibleTo (необязательно) — список id игроков, которым эта запись видна в ленте.
  // Если не указан — запись публична (видна всем), как раньше. Используется для сделок
  // покупки/продажи акций (tag "trade"), чтобы держать чужие сделки скрытыми и придать
  // смысл шпионажу — иначе состав чужого портфеля был бы виден прямо из ленты событий.
  function addLog(room, text, tag, visibleTo) {
    room.log.push({ text, tag: tag || "", turnTag: `Событие ${room.eventCount}`, ts: Date.now(), visibleTo: visibleTo || null });
    if (room.log.length > 300) room.log.shift();
  }

  // Учёт себестоимости позиции (сколько всего денег вложено в текущий пакет по
  // тикеру), чтобы можно было показать игроку прибыль/убыток по акции. Хранится
  // как суммарная стоимость покупки текущего пакета (не за штуку) — при частичной
  // продаже/передаче списывается пропорционально проданной/переданной доле.
  function addCostBasis(p, ticker, pct, totalCost) {
    if (!p.costBasis) p.costBasis = {};
    if (pct <= 0) return;
    p.costBasis[ticker] = (p.costBasis[ticker] || 0) + Math.max(0, totalCost);
  }
  function removeCostBasisProportional(p, ticker, pctRemoved) {
    if (!p.costBasis) p.costBasis = {};
    const heldBefore = p.holdings[ticker] || 0;
    if (heldBefore <= 0 || pctRemoved <= 0) return 0;
    const basis = p.costBasis[ticker] || 0;
    const removed = pctRemoved >= heldBefore ? basis : basis * (pctRemoved / heldBefore);
    const remainingPct = heldBefore - pctRemoved;
    p.costBasis[ticker] = remainingPct <= 0 ? 0 : Math.max(0, basis - removed);
    return removed;
  }

  function totalOwnedPct(room, ticker) {
    return room.players.reduce((sum, p) => sum + (p.holdings[ticker] || 0), 0);
  }
  function ownerOfControl(room, ticker) {
    return room.players.find((p) => !p.bankrupt && (p.holdings[ticker] || 0) > 50);
  }
  function getForcedPaymentPct(room, tier) {
    // Возвращает процент принудительной выплаты для тира (в долях, например 0.06 = 6%)
    const settingsArr = room.settings?.tierForcedPaymentPct;
    if (settingsArr && Array.isArray(settingsArr) && settingsArr.length === 3) {
      const idx = tier === 'A' ? 0 : tier === 'B' ? 1 : 2;
      return (settingsArr[idx] || 0) / 100;
    }
    return TIER_FORCED_PAYMENT_PCT[tier] || 0.05;
  }
  function controlledTickers(room, playerId) {
    return COMPANIES.filter((c) => (room.players.find((p) => p.id === playerId)?.holdings[c.ticker] || 0) > 50).map((c) => c.ticker);
  }
  function netWorth(room, p) {
    let v = p.cash;
    for (const t in p.holdings) v += (p.holdings[t] / 100) * room.companies[t].price;
    CITIES.forEach((ct) => {
      const re = room.realEstate[ct.id];
      if (re && re.ownerId === p.id) v += realEstatePrice(room, ct.id);
    });
    if (p.loan) v -= p.loan.principal;
    return v;
  }
  // Стоимость платных «мер» контроля привязана к капиталу игрока (netWorth), а не
  // к фиксированной сумме — иначе одна и та же цена в начале и в конце партии
  // ощущается совершенно по-разному (для бедного игрока дорого, для богатого —
  // копейки). Проценты и clamp-диапазоны подобраны так, чтобы в начале игры
  // (когда netWorth близок к стартовому капиталу) стоимость была близка к старым
  // фиксированным значениям, а к концу игры росла вместе с капиталом игрока.
  function espionageCost(room, p) { return clamp(Math.round(netWorth(room, p) * 0.05), 6000, 45000); }
  function negativeInfoCost(room, p) { return clamp(Math.round(netWorth(room, p) * 0.06), 8000, 55000); }
  function insiderPeekCost(room, p) { return clamp(Math.round(netWorth(room, p) * 0.03), 4000, 28000); }
  function shortDepositCost(room, p) { return clamp(Math.round(netWorth(room, p) * 0.04), 4000, 32000); }
  function discreditCost(room, p, target) {
    const targetRep = target.reputation == null ? REPUTATION_START : target.reputation;
    return clamp(Math.round(netWorth(room, p) * 0.05) + targetRep * 250, 6000, 80000);
  }
  function personalPrCostFor(room, p) {
    const uses = p.personalPrCount || 0;
    return Math.max(5000 + 3000 * uses, Math.round(netWorth(room, p) * 0.03));
  }
  // Стоимость принудительного выкупа миноритариев зависит от чужих (обычно
  // скрытых от игрока) долей, поэтому итоговую сумму считаем на сервере и
  // отдаём в payload точечно по каждой доступной для выкупа компании — так
  // сама раскладка долей миноритариев не раскрывается, а точная цена видна.
  function squeezeOutCost(room, p, ticker) {
    const c = room.companies[ticker];
    if (!c) return 0;
    const minority = room.players.filter((x) => x.id !== p.id && !x.bankrupt && (x.holdings[ticker] || 0) > 0);
    const gross = minority.reduce((s, x) => s + c.price * (x.holdings[ticker] / 100), 0);
    return gross * sectorControlDiscount(room, p, ticker);
  }
  // Скидка на выкуп/захват, если атакующий уже держит контроль (>50%) в 2+
  // других компаниях того же сектора — вознаграждает "фокус на секторе" вместо
  // распыления и даёт ещё один рычаг давления на конкурентов помимо цены акции.
  function sectorControlDiscount(room, p, ticker) {
    const target = companyByTicker(ticker);
    if (!target) return 1;
    const dominated = COMPANIES.filter((c) => c.sector === target.sector && c.ticker !== ticker && (p.holdings[c.ticker] || 0) > 50).length;
    if (dominated >= 2) return 0.85;
    if (dominated >= 1) return 0.93;
    return 1;
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
    recordPriceHistory(room, ticker, c.price);
  }
  function recordPriceHistory(room, ticker, price) {
    const c = room.companies[ticker];
    if (!c) return;
    if (!c.priceHistory) c.priceHistory = [];
    c.priceHistory.push({ t: room.eventCount || 0, p: Math.round(price) });
    if (c.priceHistory.length > PRICE_HISTORY_MAX) {
      c.priceHistory.shift();
    }
  }
  // Часть эффекта карты закрепляется в долгосрочном тренде компании (trendFactor),
  // а не только в разовом изменении цены — так у карточных событий есть длинный
  // след, а не только временный скачок, который потом гасится возвратом к тренду.
  function nudgeTrend(room, ticker, pct) {
    const c = room.companies[ticker];
    if (!c) return;
    if (c.trendFactor == null) c.trendFactor = 1;
    c.trendFactor = clamp(c.trendFactor + (pct / 100) * 0.2, 0.3, 4);
  }
  // Проверяет, не сконцентрировал ли кто-то литые 100% компании (обычной
  // скупкой, трейдом, сквиз-аутом или рейдом) — тогда включается «полное
  // поглощение» (fullyOwned), усиливающее принудительные выплаты x3 вместо x2
  // у обычного сквиз-аута. Снимается, если пакет снова разошёлся (например,
  // после банкротства держателя и распродажи его активов банком).
  function checkFullOwnership(room, ticker) {
    const c = room.companies[ticker];
    if (!c) return;
    const holder = room.players.find((p) => !p.bankrupt && (p.holdings[ticker] || 0) >= 100);
    if (holder && !c.fullyOwned) {
      c.fullyOwned = true;
      addLog(room, `👑 ${holder.name} консолидировал(а) 100% ${ticker} — полное поглощение, принудительные выплаты по ней теперь ×3.`, "control");
    } else if (!holder && c.fullyOwned) {
      c.fullyOwned = false;
    }
  }

  // Слияние компаний: если игрок владеет fullyOwned 2+ компаниями в одном секторе,
  // он может объединить их в одну мега-компанию. Цена новой компании = сумма цен
  // поглощаемых, игрок получает 100% новой компании. Старые компании исчезают с доски
  // (их клетки становятся пустыми). Доступно раз в событие.
  function ctrlMergeCompanies(room, playerId, targetTicker, absorbTickers) {
    const err = requireOwnTurn(room, playerId);
    if (err) return { error: err };
    const p = room.players.find((x) => x.id === playerId);
    if (!p || p.bankrupt) return { error: "Недоступно." };
    if (room.lastMergeEvent === room.eventCount) return { error: "Слияние компаний доступно раз в событие." };

    const target = room.companies[targetTicker];
    if (!target) return { error: "Целевая компания не найдена." };
    if ((p.holdings[targetTicker] || 0) < 100 || !target.fullyOwned) return { error: "Целевая компания должна быть полностью под вашим контролем (100%)." };

    if (!Array.isArray(absorbTickers) || absorbTickers.length === 0) return { error: "Нужно указать хотя бы одну компанию для поглощения." };

    const targetCompany = companyByTicker(targetTicker);
    const sector = targetCompany.sector;

    // Проверка что все поглощаемые компании из того же сектора, fullyOwned и принадлежат игроку
    for (const ticker of absorbTickers) {
      if (ticker === targetTicker) return { error: "Нельзя поглотить компанию саму в себя." };
      const c = room.companies[ticker];
      const comp = companyByTicker(ticker);
      if (!c || !comp) return { error: `Компания ${ticker} не найдена.` };
      if (comp.sector !== sector) return { error: `${ticker} не из сектора ${sector}.` };
      if ((p.holdings[ticker] || 0) < 100 || !c.fullyOwned) return { error: `${ticker} должна быть полностью под вашим контролем (100%).` };
    }

    // Подсчёт новой цены
    let totalPrice = target.price;
    absorbTickers.forEach(ticker => { totalPrice += room.companies[ticker].price; });

    // Слияние
    target.price = totalPrice;
    recordPriceHistory(room, targetTicker, totalPrice);
    target.trendFactor = clamp(target.trendFactor * 1.2, 0.3, 4); // Усиление тренда после слияния

    // Удаление поглощённых компаний (обнуление холдингов всех игроков по ним)
    absorbTickers.forEach(ticker => {
      room.players.forEach(pl => {
        if (pl.holdings[ticker]) {
          delete pl.holdings[ticker];
          if (pl.costBasis && pl.costBasis[ticker]) delete pl.costBasis[ticker];
        }
      });
      room.companies[ticker].price = 0;
      recordPriceHistory(room, ticker, 0);
      room.companies[ticker].fullyOwned = false;
      room.companies[ticker].squeezedOut = false;
    });

    room.lastMergeEvent = room.eventCount;
    const names = absorbTickers.map(t => companyByTicker(t).name).join(", ");
    addLog(room, `🏢 ${p.name} объединил(а) компании ${names} в ${targetCompany.name} (${targetTicker}). Новая капитализация: ${fmt(totalPrice)}.`, "control");

    return { ok: true, newPrice: totalPrice };
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

  // Единая проверка «действие доступно только ходящему игроку сейчас» — заменяет
  // старую привязку к общей фазе торгов. Ходящий игрок может в любой момент
  // своего хода продать/обменять акции или применить спецдействие (шпионаж,
  // дискредитация, расследование и т.п.), без ожидания отдельной фазы.
  // opts.blockFrozen — для действий, напрямую двигающих цену акций, которые
  // запрещены картой «Заморозка цен» (в отличие от шпионажа/дискредитации/расследования).
  function requireOwnTurn(room, playerId, opts) {
    opts = opts || {};
    if (!room) return "Комната не найдена.";
    if (room.phase !== "roll") return "Действие сейчас недоступно.";
    if (currentPlayerId(room) !== playerId) return "Действие доступно только в ваш ход.";
    if (opts.blockFrozen && room.frozen) return "Заморозка цен — действие запрещено до конца события.";
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
      // Если у другого активного игрока уже есть доля в этой же компании и хватает
      // наличных — он выкупает распродажу вместо банка (реальный покупатель поглотил
      // предложение, цена не обваливается); иначе, как раньше, покупает банк и цена падает.
      const rival = room.players
        .filter((x) => x.id !== player.id && !x.bankrupt && (x.holdings[ticker] || 0) > 0 && x.cash >= proceeds)
        .sort((a, b) => (b.holdings[ticker] || 0) - (a.holdings[ticker] || 0))[0];
      player.cash += proceeds;
      player.holdings[ticker] = 0;
      if (player.costBasis) player.costBasis[ticker] = 0;
      if (rival) {
        rival.cash -= proceeds;
        addCostBasis(rival, ticker, pct, proceeds);
        rival.holdings[ticker] = (rival.holdings[ticker] || 0) + pct;
        applyPriceDelta(room, ticker, -1 * (pct / 10)); // мягче банковского дампа, но не нулевой эффект
        addLog(room, `${player.name}: экстренно продал ${pct}% ${ticker} конкуренту ${rival.name} за ${fmt(proceeds)} для покрытия долга.`, "forced-sell");
        checkFullOwnership(room, ticker);
      } else {
        applyPriceDelta(room, ticker, -2 * (pct / 10));
        addLog(room, `${player.name}: принудительная продажа ${pct}% ${ticker} банку за ${fmt(proceeds)} для покрытия долга.`, "forced-sell");
      }
    }
    if (player.cash < 0) {
      CITIES.forEach((ct) => {
        if (player.cash >= 0) return;
        const re = room.realEstate[ct.id];
        if (!re || re.ownerId !== player.id) return;
        const proceeds = realEstatePrice(room, ct.id) * 0.85; // экстренная продажа банку — хуже обычной цены
        player.cash += proceeds;
        re.ownerId = null;
        re.level = 0;
        addLog(room, `${player.name}: принудительная продажа недвижимости в г. ${ct.name} банку за ${fmt(proceeds)} для покрытия долга.`, "forced-sell");
      });
    }
    if (player.cash < 0) {
      player.holdings = {};
      player.bankrupt = true;
      player.loan = null;
      adjustReputation(room, player, -30, "банкротство");
      addLog(room, `💀 ${player.name} не может покрыть обязательства даже после продажи всех активов — объявлен банкротом.`, "bankrupt");
    }
  }

  function checkEndGame(room) {
    if (room.phase === "ended") return;
    const active = activePlayers(room);
    let winner = null;
    let byRoundLimit = false;
    if (room.players.length > 1 && active.length === 1) {
      winner = active[0];
    } else if (room.maxRounds && room.roundNumber > room.maxRounds && active.length >= 1) {
      winner = active.reduce((best, p) => (netWorth(room, p) > netWorth(room, best) ? p : best), active[0]);
      byRoundLimit = true;
    }
    if (winner) {
      room.phase = "ended";
      if (byRoundLimit) addLog(room, `⏱️ Лимит партии (${room.maxRounds} раундов) достигнут — победитель определяется по капиталу.`, "header");
      // Очки — за победу начисляются пропорционально итоговому капиталу (сумме, с которой игрок выиграл).
      const won = Math.round(netWorth(room, winner));
      const pointsEarned = Math.max(1, Math.round(won / 1000));
      winner.points = (winner.points || 0) + pointsEarned;
      // Сетевой слой (server.js) заберёт это один раз и допишет очки в персистентный аккаунт игрока.
      room.lastGamePointsAward = { playerId: winner.id, amount: pointsEarned };
      // Итоговая таблица для экрана завершения игры — не одноразовая (в отличие
      // от lastGamePointsAward), остаётся в комнате до начала новой партии.
      room.gameResult = {
        winnerId: winner.id, winnerName: winner.name, netWorth: won, pointsEarned,
        ranking: room.players
          .map((p) => ({ id: p.id, name: p.name, netWorth: Math.round(netWorth(room, p)), bankrupt: !!p.bankrupt, points: p.points || 0 }))
          .sort((a, b) => b.netWorth - a.netWorth),
      };
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

  function marketEvent(room) {
    const eventBeforeThis = room.eventCount;
    room.eventCount++;
    room.roundNumber = (room.roundNumber || 1) + 1;
    room.dividendMultiplier = 1;
    addLog(room, `— Биржевое событие #${room.eventCount} —`, "header");

    const roll = 1 + Math.floor(Math.random() * 6);
    let volPct = 0;
    if (roll <= 2) volPct = -5; else if (roll >= 5) volPct = 5;
    COMPANIES.forEach((c) => applyPriceDelta(room, c.ticker, volPct));
    addLog(room, `Кубик волатильности: ${roll} → база ${volPct > 0 ? "+" : ""}${volPct}% всем компаниям (фактически сильнее у волатильных тикеров)`, "vol");

    processLoans(room);
    processRealEstate(room);
    processReputationRecovery(room);

    if (room.deckPos >= room.deckOrder.length) {
      room.deckOrder = shuffle(room.deckOrder);
      room.deckPos = 0;
      addLog(room, "Колода новостей закончилась — переshuffle.", "deck");
    }
    const idx = room.deckOrder[room.deckPos++];
    const card = room.deckData[idx];
    room.frozen = false;

    if (card.type === "global") {
      COMPANIES.forEach((c) => { applyPriceDelta(room, c.ticker, card.percent); nudgeTrend(room, c.ticker, card.percent); });
      addLog(room, `📰 [Глобальная] ${card.title}: ${card.percent > 0 ? "+" : ""}${card.percent}% всем компаниям`, "news");
    } else if (card.type === "sector") {
      COMPANIES.filter((c) => c.sector === card.sector).forEach((c) => { applyPriceDelta(room, c.ticker, card.percent); nudgeTrend(room, c.ticker, card.percent); });
      addLog(room, `📰 [Отраслевая, ${card.sector}] ${card.title}: ${card.percent > 0 ? "+" : ""}${card.percent}%`, "news");
    } else if (card.type === "company") {
      const c = COMPANIES[Math.floor(Math.random() * COMPANIES.length)];
      applyPriceDelta(room, c.ticker, card.percent);
      nudgeTrend(room, c.ticker, card.percent);
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
            removeCostBasisProportional(p, c.ticker, 10);
            p.holdings[c.ticker] -= 10;
            p.cash += proceeds;
            addLog(room, `🏦 Банк выкупил 10% ${c.ticker} у ${p.name} за ${fmt(proceeds)}.`, "buyback");
          }
        });
      } else if (card.key === "extra_turn") {
        room.extraTurnPending = true;
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

    // У каждой компании — свой фоновый долгосрочный тренд (trendFactor), который
    // блуждает независимо от разовых карт/кубика: часть компаний на дистанции
    // растут, часть падают, как на настоящем рынке. Смещение чуть выше нуля в
    // среднем (лёгкий бычий уклон рынка в целом), но аддитивно, а не умножением
    // на текущую цену — так не повторяется эффект систематического сноса к полу,
    // из-за которого раньше вводили плоскую коррекцию к единой цене тира.
    if (!room.frozen) {
      COMPANIES.forEach((c) => {
        const comp = room.companies[c.ticker];
        if (comp.trendFactor == null) comp.trendFactor = 1;
        const drift = -0.015 + Math.random() * 0.035; // в среднем ~+0.25% за событие
        comp.trendFactor = clamp(comp.trendFactor + drift, 0.3, 4);
      });
    }

    // Мягкий возврат к тренду компании (а не к единой цене тира) — гасит только
    // избыточный шум отдельных бросков/карт, не отменяя ни сам тренд, ни эффект
    // крупных разовых событий/контрольных действий.
    if (!room.frozen) {
      COMPANIES.forEach((c) => {
        const comp = room.companies[c.ticker];
        const target = TIER_PRICE[c.tier] * comp.trendFactor;
        const floor = TIER_PRICE[c.tier] * 0.1;
        const newPrice = Math.max(floor, comp.price + (target - comp.price) * 0.04);
        if (Math.abs(newPrice - comp.price) > 0.5) {
          comp.price = newPrice;
          recordPriceHistory(room, c.ticker, newPrice);
        } else {
          comp.price = newPrice;
        }
      });
    }

    resolveShorts(room, eventBeforeThis);
    room.turn = 1;
  }

  function afterRollAction(room) {
    room.pendingRoll = null;
    // Назначенная цена выкупа привязана к конкретному броску — если ход
    // завершился (оплачен, пропущен через альтернативный сценарий, или
    // конфискация снизила долю контролёра ниже 50% и путь оплаты сменился
    // на пропорциональный), не должна "утекать" в следующий бросок.
    room.pendingForcedPrice = null;
    // Ход больше не завершается автоматически после одного действия по броску —
    // игрок теперь сам решает, когда закончить ход (endTurn), чтобы успеть
    // продать/обменять акции или воспользоваться спецдействиями до передачи хода.
    checkEndGame(room);
  }

  // Явное завершение хода текущим игроком. Раунд = один полный круг по столу
  // (каждый игрок бросает кубики один раз); когда круг завершён — наступает
  // биржевое событие. Игрок, чей ход довёл счётчик до конца круга, получает
  // право на дополнительный ход, если сработала карта «Дополнительный ход».
  function endTurn(room, playerId) {
    if (!room) return { error: "Комната не найдена." };
    if (room.phase !== "roll") return { error: "Сейчас нельзя завершить ход." };
    if (currentPlayerId(room) !== playerId) return { error: "Сейчас не ваш ход." };
    if (room.pendingRoll) return { error: "Сначала обработайте текущий бросок." };
    if (room.pendingForcedPrice) return { error: "Дождитесь оплаты назначенной цены выкупа доли." };
    if (!room.rolledThisTurn) return { error: "Сначала бросьте кубики." };
    const p = room.players.find((x) => x.id === playerId);
    room.rolledThisTurn = false;
    const roundLen = room.settings?.eventIntervalTurns || EVENT_INTERVAL_TURNS;
    room.turn++;
    if (room.turn > roundLen) {
      marketEvent(room);
      if (room.extraTurnPending) {
        room.extraTurnPending = false;
        addLog(room, `🔁 ${p ? p.name : "?"} получил(а) дополнительный ход за это событие!`, "turn");
      } else {
        room.turnIndex = (room.turnIndex + 1) % Math.max(1, room.turnOrder.length);
        addLog(room, `${p ? p.name : "?"} завершил(а) ход. Ход переходит дальше.`, "turn");
      }
    } else {
      room.turnIndex = (room.turnIndex + 1) % Math.max(1, room.turnOrder.length);
      addLog(room, `${p ? p.name : "?"} завершил(а) ход. Ход в раунде: ${room.turn}/${roundLen}.`, "turn");
    }
    checkEndGame(room);
    return { ok: true };
  }

  // ---------------------------------------------------------------------
  // Игроки
  // ---------------------------------------------------------------------
  function addPlayer(room, name, gender, avatar, initialPoints, equippedBoardSkin, isBot) {
    name = String(name || "").trim().slice(0, 20);
    if (!name) return { error: "Введите имя игрока." };
    gender = String(gender || "").trim().slice(0, 24);
    avatar = String(avatar || "").trim().slice(0, 8);
    equippedBoardSkin = String(equippedBoardSkin || "").trim().slice(0, 24);
    let player = room.players.find((p) => p.name === name);
    if (player && player.connected) {
      return { error: "Это имя уже занято в этой комнате." };
    }
    if (player && player.kicked) {
      return { error: "Вы были исключены из этой комнаты голосованием игроков." };
    }
    if (player) {
      player.connected = true;
      if (gender) player.gender = gender;
      if (avatar) player.avatar = avatar;
      if (initialPoints != null) player.points = initialPoints;
      if (equippedBoardSkin) player.equippedBoardSkin = equippedBoardSkin;
      addLog(room, `Игрок «${name}» переподключился.`, "player");
    } else {
      const startingCash = room.settings?.startingCash || STARTING_CASH;
      player = { id: room.nextPlayerId++, name, gender, avatar, points: initialPoints != null ? initialPoints : 0, equippedBoardSkin: equippedBoardSkin || "default", cash: startingCash, holdings: {}, costBasis: {}, bankrupt: false, connected: true, reputation: REPUTATION_START, loan: null, isBot: !!isBot };
      room.players.push(player);
      room.turnOrder.push(player.id);
      addLog(room, `${isBot ? "🤖 Бот" : "Игрок"} «${name}» присоединился со стартовым капиталом ${fmt(startingCash)}.`, "player");
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

  // Лимит раундов — необязательная альтернатива классическому «до банкротства
  // всех соперников»: по достижении maxRounds игра завершается досрочно,
  // победитель — активный игрок с наибольшим капиталом. null/0 = без лимита.
  function setMaxRounds(room, playerId, maxRounds) {
    if (!room) return { error: "Комната не найдена." };
    if (room.phase !== "lobby") return { error: "Настройки можно менять только в лобби." };
    if (room.hostPlayerId !== playerId) return { error: "Изменить настройки может только хост." };
    const n = Number(maxRounds);
    room.maxRounds = Number.isFinite(n) && n > 0 ? Math.round(n) : null;
    addLog(room, room.maxRounds ? `⚙️ Хост установил лимит партии: ${room.maxRounds} раундов.` : "⚙️ Хост снял лимит длины партии (игра до банкротства всех соперников).", "header");
    return { ok: true };
  }

  function deleteRoom(room, playerId) {
    if (!room) return { error: "Комната не найдена." };
    if (room.phase !== "lobby") return { error: "Удалить комнату можно только в лобби." };
    if (room.hostPlayerId !== playerId) return { error: "Удалить комнату может только хост." };
    addLog(room, "🗑️ Хост удалил комнату — все игроки будут отключены.", "header");
    return { ok: true, deleted: true };
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

  // ---------------------------------------------------------------------
  // Голосование за кик из комнаты: любой подключённый игрок может начать
  // голосование против другого (кроме себя), остальные подключённые игроки
  // голосуют "за"/"против". Кик срабатывает, как только "за" строго больше
  // половины среди подключённых игроков, не считая самого кандидата на кик
  // (чтобы, например, вдвоём/втроём хватало большинства оставшихся, а не всей комнаты).
  function startKickVote(room, playerId, targetId) {
    if (!room) return { error: "Комната не найдена." };
    const voter = room.players.find((x) => x.id === playerId);
    const target = room.players.find((x) => x.id === targetId);
    if (!voter || !voter.connected) return { error: "Недоступно." };
    if (targetId === playerId) return { error: "Нельзя голосовать за собственное исключение." };
    if (!target || !target.connected || target.bankrupt) return { error: "Этот игрок недоступен для исключения." };
    if (room.kickVote && room.kickVote.targetId === targetId) return { error: "Голосование за исключение этого игрока уже идёт." };
    room.kickVote = { targetId, initiatorId: playerId, startedAt: Date.now(), voters: { [playerId]: true } };
    addLog(room, `🗳️ ${voter.name} начал(а) голосование за исключение игрока «${target.name}».`, "kickvote");
    return resolveKickVote(room);
  }

  function voteKick(room, playerId, targetId, yes) {
    if (!room) return { error: "Комната не найдена." };
    const kv = room.kickVote;
    if (!kv || kv.targetId !== targetId) return { error: "Сейчас нет голосования за исключение этого игрока." };
    const voter = room.players.find((x) => x.id === playerId);
    if (!voter || !voter.connected) return { error: "Недоступно." };
    if (playerId === kv.targetId) return { error: "Нельзя голосовать за собственное исключение." };
    if (yes) kv.voters[playerId] = true; else delete kv.voters[playerId];
    return resolveKickVote(room);
  }

  function cancelKickVote(room, playerId) {
    if (!room) return { error: "Комната не найдена." };
    const kv = room.kickVote;
    if (!kv) return { error: "Сейчас нет активного голосования." };
    if (kv.initiatorId !== playerId) return { error: "Отменить голосование может только тот, кто его начал." };
    room.kickVote = null;
    addLog(room, "Голосование за исключение отменено инициатором.", "kickvote");
    return { ok: true };
  }

  function resolveKickVote(room) {
    const kv = room.kickVote;
    if (!kv) return { ok: true };
    const target = room.players.find((x) => x.id === kv.targetId);
    if (!target || !target.connected || target.bankrupt) { room.kickVote = null; return { ok: true }; }
    const eligible = room.players.filter((p) => p.connected && !p.bankrupt && p.id !== kv.targetId);
    const yesCount = eligible.filter((p) => kv.voters[p.id]).length;
    const needed = Math.floor(eligible.length / 2) + 1; // строго больше половины
    if (eligible.length > 0 && yesCount >= needed) {
      // Возвращаем активы банку так же, как при банкротстве, но отдельным
      // флагом kicked помечаем, что это было принудительное исключение, а не
      // добровольное банкротство — интерфейс показывает это по-разному.
      target.holdings = {};
      target.costBasis = {};
      CITIES.forEach((ct) => {
        const re = room.realEstate[ct.id];
        if (re && re.ownerId === target.id) { re.ownerId = null; re.level = 0; }
      });
      target.loan = null;
      target.bankrupt = true;
      target.kicked = true;
      target.connected = false;
      addLog(room, `🚫 «${target.name}» исключён(а) из комнаты голосованием игроков (${yesCount}/${eligible.length}).`, "kicked");
      room.kickVote = null;
      if (room.pendingRoll && room.pendingRoll.playerId === target.id) room.pendingRoll = null;
      if (room.pendingForcedPrice && (room.pendingForcedPrice.targetId === target.id || room.pendingForcedPrice.controllerId === target.id)) room.pendingForcedPrice = null;
      room.pendingTrades = room.pendingTrades.filter((t) => t.fromId !== target.id && t.toId !== target.id);
      checkEndGame(room);
    }
    return { ok: true, kicked: !room.kickVote && target.kicked };
  }

  // ---------------------------------------------------------------------
  // Реакции за столом: короткоживущие эмодзи-реакции над своим аватаром,
  // видимые всем игрокам комнаты. Хранится небольшой хвост последних реакций
  // (TTL/анимацию по времени показа отрабатывает клиент), чтобы не раздувать
  // состояние комнаты бесконечно.
  const REACTION_EMOJIS = ["😀", "😂", "😮", "😡", "👍", "👎", "🔥", "💰", "🤝", "😢"];
  function sendReaction(room, playerId, emoji) {
    if (!room) return { error: "Комната не найдена." };
    const p = room.players.find((x) => x.id === playerId);
    if (!p || !p.connected) return { error: "Недоступно." };
    emoji = String(emoji || "");
    if (!REACTION_EMOJIS.includes(emoji)) return { error: "Недопустимая реакция." };
    room.reactions.push({ id: room.nextReactionId++, playerId, emoji, ts: Date.now() });
    if (room.reactions.length > 40) room.reactions.shift();
    return { ok: true };
  }

  function newGameKeepPlayers(room) {
    const prev = room.players.map((p) => ({ name: p.name, gender: p.gender, avatar: p.avatar, points: p.points || 0, equippedBoardSkin: p.equippedBoardSkin || "default", isBot: !!p.isBot }));
    const fresh = freshRoom(room.code);
    fresh.phase = "roll"; // реванш — сразу к игре, без комнаты ожидания
    fresh.maxRounds = room.maxRounds || null; // лимит раундов — настройка комнаты, переживает реванш
    prev.forEach((pp) => {
      const p = { id: fresh.nextPlayerId++, name: pp.name, gender: pp.gender, avatar: pp.avatar, points: pp.points, equippedBoardSkin: pp.equippedBoardSkin, cash: STARTING_CASH, holdings: {}, costBasis: {}, bankrupt: false, connected: true, reputation: REPUTATION_START, loan: null, isBot: !!pp.isBot };
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
    if (!room || room.phase !== "roll") return { error: "Сейчас недоступно." };
    if (currentPlayerId(room) !== playerId) return { error: "Сейчас не ваш ход." };
    if (room.pendingRoll) return { error: "Бросок уже сделан — выберите действие." };
    if (room.rolledThisTurn) return { error: "Вы уже бросали кубики в этот ход — завершите ход." };
    room.rolledThisTurn = true;
    ambientJitter(room);
    const row = 1 + Math.floor(Math.random() * 12);
    const col = 1 + Math.floor(Math.random() * 12);
    const cell = BOARD[row - 1][col - 1];
    const p = room.players.find((x) => x.id === playerId);
    const turnSalary = room.settings?.turnSalary || TURN_SALARY;
    p.cash += turnSalary;
    const salaryNote = ` (+${fmt(turnSalary)} зарплата)`;
    if (isRealEstateCell(cell)) {
      const cityId = cityIdFromCell(cell);
      room.pendingRoll = { playerId, row, col, ticker: null, realEstateId: cityId };
      addLog(room, `🎲 ${p.name}: бросок строка ${row}, столбец ${col} → недвижимость в г. ${cityById(cityId).name}.${salaryNote}`, "roll");
    } else {
      room.pendingRoll = { playerId, row, col, ticker: cell, realEstateId: null };
      addLog(room, `🎲 ${p.name}: бросок строка ${row}, столбец ${col} → ${companyByTicker(cell).name} (${cell}).${salaryNote}`, "roll");
    }
    return { ok: true };
  }

  function buyFromRoll(room, playerId, pctRaw) {
    if (!room || room.phase !== "roll" || !room.pendingRoll) return { error: "Нет активного броска." };
    if (room.pendingRoll.playerId !== playerId) return { error: "Сейчас не ваш ход." };
    if (!room.pendingRoll.ticker) return { error: "На этой клетке нет акций — там недвижимость." };
    let pct = Math.round(Number(pctRaw));
    if (!Number.isFinite(pct) || pct <= 0) pct = 10;
    pct = Math.max(1, Math.min(25, pct));
    const ticker = room.pendingRoll.ticker;
    const p = room.players.find((x) => x.id === playerId);
    const c = room.companies[ticker];
    const owned = totalOwnedPct(room, ticker);
    if (owned + pct > 100) return { error: "У банка недостаточно свободных акций этой компании." };
    const feePct = bankFeePct(p.reputation);
    const cost = c.price * (pct / 100) * (1 + feePct);
    if (p.cash < cost) return { error: "Недостаточно наличных." };
    p.cash -= cost;
    p.holdings[ticker] = (p.holdings[ticker] || 0) + pct;
    addCostBasis(p, ticker, pct, cost);
    applyPriceDelta(room, ticker, 2 * (pct / 10));
    addLog(room, `${p.name} купил ${pct}% ${ticker} по броску кубиков за ${fmt(cost)}${feePct > 0 ? ` (вкл. комиссию банка ${(feePct * 100).toFixed(1)}% из-за репутации)` : ""}. Новая цена: ${fmt(room.companies[ticker].price)}.`, "trade", [p.id]);
    checkFullOwnership(room, ticker);
    afterRollAction(room);
    return { ok: true };
  }

  // Игрок отказался покупать акции, уже (частично) выкупленные другими — вместо
  // "просто дивидендов" теперь это ОБЯЗАТЕЛЬНАЯ плата % от капитализации (по тиру
  // компании), распределяемая пропорционально долям держателей. Если пакет
  // полностью под контролем одного игрока (>50%, других держателей нет) —
  // формула не применяется, нужен setForcedPrice/payForcedPrice.
  function dividendFromRoll(room, playerId) {
    if (!room || room.phase !== "roll" || !room.pendingRoll) return { error: "Нет активного броска." };
    if (room.pendingRoll.playerId !== playerId) return { error: "Сейчас не ваш ход." };
    const ticker = room.pendingRoll.ticker;
    if (!ticker) return { error: "На этой клетке нет акций — там недвижимость." };
    const c = room.companies[ticker];
    const payer = room.players.find((x) => x.id === playerId);
    if (c.skipDividendUntil && c.skipDividendUntil >= room.eventCount) {
      addLog(room, `По ${ticker} выплата временно не проводится (эффект карты новостей).`, "dividend");
      afterRollAction(room);
      return { ok: true };
    }
    const tier = companyByTicker(ticker).tier;
    // Дифференциация дивидендов: малые компании (C) чаще пропускают выплаты
    const skipChance = TIER_DIVIDEND_SKIP_CHANCE[tier] || 0.12;
    if (Math.random() < skipChance) {
      addLog(room, `По ${ticker} (тир ${tier}) дивиденды пропущены в этом ходе.`, "dividend");
      afterRollAction(room);
      return { ok: true };
    }
    const owners = room.players.filter((p) => !p.bankrupt && p.id !== payer.id && (p.holdings[ticker] || 0) > 0);
    if (owners.length === 0) {
      addLog(room, `${payer.name}: свободные акции ${ticker} — платить некому.`, "dividend");
      afterRollAction(room);
      return { ok: true };
    }
    const controller = owners.length === 1 && owners[0].holdings[ticker] > 50 ? owners[0] : null;
    if (controller) return { error: `${controller.name} полностью контролирует ${ticker} и должен(-на) сам(а) назначить цену выкупа (см. кнопку «Назначить цену»).` };
    const totalPct = owners.reduce((s, p) => s + p.holdings[ticker], 0);
    const ratePct = getForcedPaymentPct(room, tier);
    const dividendMult = TIER_DIVIDEND_MULT[tier] || 1.0;
    const squeezeMult = c.fullyOwned ? 3 : (c.squeezedOut ? 2 : 1);
    const amount = c.price * ratePct * (totalPct / 100) * (room.dividendMultiplier || 1) * squeezeMult * dividendMult;
    payer.cash -= amount;
    owners.forEach((o) => { o.cash += amount * (o.holdings[ticker] / totalPct); });
    const squeezeNote = c.fullyOwned ? " (×3, полное поглощение)" : (squeezeMult > 1 ? " (×2, сквиз-аут)" : "");
    const tierNote = dividendMult !== 1.0 ? ` (×${dividendMult.toFixed(1)}, тир ${tier})` : "";
    addLog(room, `${payer.name} отказался от покупки ${ticker} и заплатил ${(ratePct * 100).toFixed(0)}% капитализации: ${fmt(amount)}${room.dividendMultiplier > 1 ? " (×2, Дивидендный сезон)" : ""}${squeezeNote}${tierNote}, распределено между ${owners.length} держателем(-ями).`, "dividend");
    settleDebt(room, payer);
    afterRollAction(room);
    return { ok: true };
  }

  // Контролирующий (>50%, единственный держатель) сам назначает сумму выкупа для
  // игрока, отказавшегося покупать. Слишком высокая цена (относительно тирной
  // "справедливой" ставки) бьёт по репутации контролёра и с вероятностью 50%
  // приводит к частичной конфискации его пакета «антимонопольной службой США».
  function setForcedPrice(room, controllerId, amountRaw) {
    if (!room || room.phase !== "roll" || !room.pendingRoll) return { error: "Нет активного броска." };
    const roll = room.pendingRoll;
    if (!roll.ticker) return { error: "На этой клетке нет акций." };
    if (roll.playerId === controllerId) return { error: "Нельзя назначать цену самому себе." };
    const ticker = roll.ticker;
    const controller = room.players.find((x) => x.id === controllerId);
    const heldPct = controller ? (controller.holdings[ticker] || 0) : 0;
    if (!controller || heldPct <= 50) return { error: "Назначить цену может только игрок, полностью контролирующий пакет (>50%)." };
    // Другие держатели, кроме самого контролёра И самого бросающего (если он уже
    // держит часть пакета — это не мешает контролю, дивиденды/выкуп всё равно не
    // платятся самому себе): раньше проверка включала и бросающего, из-за чего
    // назначить цену было невозможно, стоило ему держать хоть 1% этой же акции.
    const otherOwners = room.players.filter((p) => !p.bankrupt && p.id !== controllerId && p.id !== roll.playerId && (p.holdings[ticker] || 0) > 0);
    if (otherOwners.length > 0) return { error: "Пакет не полностью под вашим контролем — есть другие держатели." };
    const amount = Math.max(1, Math.round(Number(amountRaw) || 0));
    const c = room.companies[ticker];
    const tier = companyByTicker(ticker).tier;
    const fair = c.price * getForcedPaymentPct(room, tier) * (heldPct / 100);
    room.pendingForcedPrice = { ticker, controllerId, targetId: roll.playerId, amount };
    addLog(room, `💰 ${controller.name} назначил(а) цену выкупа доли ${ticker} для отказавшегося от покупки игрока: ${fmt(amount)}.`, "control");
    if (amount > fair * FORCED_PRICE_EXCESSIVE_MULT) {
      adjustReputation(room, controller, -12, "завышенная цена выкупа доли");
      addLog(room, `⚠️ Цена сильно завышена относительно рыночной (${fmt(fair)}) — репутация ${controller.name} снижена.`, "control");
      if (Math.random() < 0.5) {
        const seize = Math.min(heldPct, ANTITRUST_CONFISCATE_PCT);
        removeCostBasisProportional(controller, ticker, seize);
        controller.holdings[ticker] -= seize;
        applyPriceDelta(room, ticker, -1 * (seize / 10));
        addLog(room, `🏛️ Антимонопольная служба США вмешалась: конфисковано ${seize}% ${ticker} у ${controller.name}, акции возвращены в свободное обращение банку.`, "control");
      }
    }
    return { ok: true };
  }

  function payForcedPrice(room, playerId) {
    if (!room || room.phase !== "roll" || !room.pendingForcedPrice) return { error: "Нет назначенной цены." };
    const pf = room.pendingForcedPrice;
    if (pf.targetId !== playerId) return { error: "Это не ваш платёж." };
    const payer = room.players.find((x) => x.id === playerId);
    const owner = room.players.find((x) => x.id === pf.controllerId);
    payer.cash -= pf.amount;
    if (owner && !owner.bankrupt) owner.cash += pf.amount;
    addLog(room, `${payer.name} выплатил ${fmt(pf.amount)} игроку ${owner ? owner.name : "?"} за пакет ${pf.ticker} по назначенной цене.`, "control");
    room.pendingForcedPrice = null;
    settleDebt(room, payer);
    afterRollAction(room);
    return { ok: true };
  }

  function skipRoll(room, playerId) {
    if (!room || room.phase !== "roll" || !room.pendingRoll) return { error: "Нет активного броска." };
    if (room.pendingRoll.playerId !== playerId) return { error: "Сейчас не ваш ход." };
    const roll = room.pendingRoll;
    if (roll.ticker) {
      const owners = room.players.filter((p) => !p.bankrupt && p.id !== playerId && (p.holdings[roll.ticker] || 0) > 0);
      if (owners.length > 0) return { error: "Эти акции уже частично выкуплены — нужно либо купить, либо заплатить владельцам." };
    } else if (roll.realEstateId) {
      const re = room.realEstate[roll.realEstateId];
      if (re && re.ownerId && re.ownerId !== playerId) return { error: "Эта недвижимость занята — сначала заплатите ренту владельцу." };
    }
    const p = room.players.find((x) => x.id === playerId);
    addLog(room, `${p.name} пропустил действие.`, "turn");
    afterRollAction(room);
    return { ok: true };
  }

  // ---------------------------------------------------------------------
  // Недвижимость на клетках стола
  // ---------------------------------------------------------------------
  function buyRealEstateFromRoll(room, playerId) {
    if (!room || room.phase !== "roll" || !room.pendingRoll) return { error: "Нет активного броска." };
    if (room.pendingRoll.playerId !== playerId) return { error: "Сейчас не ваш ход." };
    const cityId = room.pendingRoll.realEstateId;
    if (!cityId) return { error: "На этой клетке нет недвижимости." };
    const re = room.realEstate[cityId];
    const ct = cityById(cityId);
    if (re.ownerId) return { error: "Эта недвижимость уже куплена." };
    const p = room.players.find((x) => x.id === playerId);
    const feePct = bankFeePct(p.reputation);
    const cost = realEstatePrice(room, cityId) * (1 + feePct);
    if (p.cash < cost) return { error: "Недостаточно наличных." };
    p.cash -= cost;
    re.ownerId = playerId;
    re.level = 0;
    addLog(room, `🏠 ${p.name} купил недвижимость в г. ${ct.name} за ${fmt(cost)}${feePct > 0 ? ` (вкл. комиссию банка ${(feePct * 100).toFixed(1)}%)` : ""}.`, "realestate");
    afterRollAction(room);
    return { ok: true };
  }

  function upgradeRealEstateFromRoll(room, playerId) {
    if (!room || room.phase !== "roll" || !room.pendingRoll) return { error: "Нет активного броска." };
    if (room.pendingRoll.playerId !== playerId) return { error: "Сейчас не ваш ход." };
    const cityId = room.pendingRoll.realEstateId;
    if (!cityId) return { error: "На этой клетке нет недвижимости." };
    const re = room.realEstate[cityId];
    const ct = cityById(cityId);
    const p = room.players.find((x) => x.id === playerId);
    if (re.ownerId !== playerId) return { error: "Вы не владеете этой недвижимостью." };
    if ((re.level || 0) >= MAX_RE_LEVEL) return { error: "Максимум улучшений (4/4) уже достигнут." };
    const cost = realEstateUpgradeCost(room, cityId);
    if (p.cash < cost) return { error: "Недостаточно наличных для улучшения." };
    p.cash -= cost;
    re.level = (re.level || 0) + 1;
    addLog(room, `🏗️ ${p.name} улучшил(а) недвижимость в г. ${ct.name} до уровня ${re.level}/${MAX_RE_LEVEL} за ${fmt(cost)}.`, "realestate");
    afterRollAction(room);
    return { ok: true };
  }

  function payRealEstateRentFromRoll(room, playerId) {
    if (!room || room.phase !== "roll" || !room.pendingRoll) return { error: "Нет активного броска." };
    if (room.pendingRoll.playerId !== playerId) return { error: "Сейчас не ваш ход." };
    const cityId = room.pendingRoll.realEstateId;
    if (!cityId) return { error: "На этой клетке нет недвижимости." };
    const re = room.realEstate[cityId];
    const ct = cityById(cityId);
    const payer = room.players.find((x) => x.id === playerId);
    if (!re.ownerId || re.ownerId === playerId) return { error: "Ренту платить некому." };
    const owner = room.players.find((x) => x.id === re.ownerId);
    const rent = realEstateRent(room, cityId) * (room.dividendMultiplier || 1);
    payer.cash -= rent;
    if (owner && !owner.bankrupt) owner.cash += rent;
    addLog(room, `${payer.name} заплатил ренту за недвижимость в г. ${ct.name} игроку ${owner ? owner.name : "?"}: ${fmt(rent)}.`, "realestate");
    settleDebt(room, payer);
    afterRollAction(room);
    return { ok: true };
  }

  function buyBank() {
    // Правило: напрямую у банка акции покупаются только по результату броска кубиков
    // (см. buyFromRoll) — так рынок остаётся привязан к перемещению по столу.
    return { error: "Покупка у банка возможна только по результату броска кубиков." };
  }

  function sellBank(room, playerId, ticker, pctRaw) {
    const err = requireOwnTurn(room, playerId);
    if (err) return { error: err };
    const p = room.players.find((x) => x.id === playerId);
    if (!p || p.bankrupt) return { error: "Недоступно." };
    let pct = Math.round(Number(pctRaw));
    if (!Number.isFinite(pct) || pct <= 0) pct = 10;
    pct = Math.max(1, Math.min(25, pct));
    const c = room.companies[ticker];
    if (!c) return { error: "Неизвестная компания." };
    if ((p.holdings[ticker] || 0) < pct) return { error: "Недостаточно акций этой компании." };
    const proceeds = c.price * (pct / 100);
    removeCostBasisProportional(p, ticker, pct);
    p.holdings[ticker] -= pct;
    p.cash += proceeds;
    applyPriceDelta(room, ticker, -2 * (pct / 10));
    addLog(room, `${p.name} продал ${pct}% ${ticker} банку за ${fmt(proceeds)}.`, "trade", [p.id]);
    return { ok: true };
  }

  // Предложение сделки другому игроку: from отдаёт pct% ticker; to взамен платит
  // price наличными и/или (для бартера) отдаёт wantPct% wantTicker обратно from.
  // Можно указать и цену, и встречный тикер одновременно — оба будут исполнены
  // при принятии. Только текущий ходящий игрок может предлагать сделки (чтобы
  // не было сумбура от одновременных предложений всех игроков сразу).
  function proposeTrade(room, playerId, toId, ticker, pctRaw, priceRaw, wantTicker, wantPctRaw) {
    const err = requireOwnTurn(room, playerId);
    if (err) return { error: err };
    const from = room.players.find((x) => x.id === playerId);
    const to = room.players.find((x) => x.id === toId);
    if (!from || !to || from.id === to.id || to.bankrupt) return { error: "Некорректная сделка." };
    if (!room.companies[ticker]) return { error: "Неизвестная компания." };
    const pct = Math.max(1, Math.min(25, Math.round(Number(pctRaw) || 0)));
    const price = Math.max(0, Math.round(Number(priceRaw) || 0));
    if ((from.holdings[ticker] || 0) < pct) return { error: "Недостаточно акций для продажи." };
    wantTicker = wantTicker ? String(wantTicker) : null;
    let wantPct = 0;
    if (wantTicker) {
      if (!room.companies[wantTicker]) return { error: "Неизвестная компания для встречного предложения." };
      if (wantTicker === ticker) return { error: "Встречный тикер должен отличаться от предлагаемого." };
      wantPct = Math.max(1, Math.min(25, Math.round(Number(wantPctRaw) || 0)));
    }
    const trade = { id: room.nextTradeId++, fromId: from.id, toId: to.id, ticker, pct, price, wantTicker, wantPct, status: "pending" };
    room.pendingTrades.push(trade);
    const paymentDesc = [price > 0 ? fmt(price) : "", wantTicker ? `${wantPct}% ${wantTicker}` : ""].filter(Boolean).join(" + ") || "бесплатно";
    addLog(room, `🤝 ${from.name} предложил ${to.name}: ${pct}% ${ticker} за ${paymentDesc}.`, "trade-offer");
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
    if (trade.price > 0 && to.cash < trade.price) return { error: "Недостаточно наличных для этой сделки.", stillChanged: true };
    if (trade.wantTicker && (to.holdings[trade.wantTicker] || 0) < trade.wantPct) return { error: "У вас недостаточно акций для встречного обмена.", stillChanged: true };
    // Себестоимость: у продавца списываем пропорционально проданной доле, у
    // покупателя записываем как затраты — реальная цена сделки, если была
    // указана, иначе оценка по текущей рыночной цене (для бартера без наличных).
    removeCostBasisProportional(from, trade.ticker, trade.pct);
    const mainLegCost = trade.price > 0 ? trade.price : (room.companies[trade.ticker].price * (trade.pct / 100));
    from.holdings[trade.ticker] -= trade.pct;
    to.holdings[trade.ticker] = (to.holdings[trade.ticker] || 0) + trade.pct;
    addCostBasis(to, trade.ticker, trade.pct, mainLegCost);
    if (trade.price > 0) {
      from.cash += trade.price;
      to.cash -= trade.price;
    }
    if (trade.wantTicker && trade.wantPct > 0) {
      removeCostBasisProportional(to, trade.wantTicker, trade.wantPct);
      const wantLegCost = room.companies[trade.wantTicker].price * (trade.wantPct / 100);
      to.holdings[trade.wantTicker] -= trade.wantPct;
      from.holdings[trade.wantTicker] = (from.holdings[trade.wantTicker] || 0) + trade.wantPct;
      addCostBasis(from, trade.wantTicker, trade.wantPct, wantLegCost);
    }
    const paymentDesc = [trade.price > 0 ? fmt(trade.price) : "", trade.wantTicker ? `${trade.wantPct}% ${trade.wantTicker}` : ""].filter(Boolean).join(" + ") || "бесплатно";
    addLog(room, `Сделка: ${to.name} получил ${trade.pct}% ${trade.ticker} от ${from.name} за ${paymentDesc} (рыночная цена не меняется).`, "trade", [from.id, to.id]);
    checkFullOwnership(room, trade.ticker);
    if (trade.wantTicker) checkFullOwnership(room, trade.wantTicker);
    return { ok: true };
  }

  // ---------------------------------------------------------------------
  // Боты — общая логика для офлайн-хотсита и для headless-симуляций баланса
  // (server/simulate.js). botStep выполняет РОВНО одно действие движка за вызов
  // (или ничего, если сейчас действовать некому/нечем) — вызывающая сторона сама
  // решает, крутить ли цикл дальше: до конца партии (симуляция) или с паузами
  // между шагами (UI). Приоритет действий: сначала внеочередные обязательства
  // (оплата назначенной цены, назначение цены контролёром, ответ на сделку) —
  // они не привязаны к тому, чей сейчас ход, — и только потом обычный ход бота.
  // ---------------------------------------------------------------------
  function isBotPlayer(p) { return !!(p && p.isBot); }

  // Инвестирует случайную долю свободного кэша (не больше 35% на одну покупку),
  // но не больше свободного % у банка — простая, но не самоубийственная стратегия.
  function botChoosePct(cash, price, freePct) {
    // Держим небольшой наличный резерв, а не тратим на акции до последнего —
    // иначе к моменту, когда бот попадает на свободную клетку недвижимости,
    // касса почти всегда пуста (см. симуляцию: недвижимость покупалась <1%
    // случаев из-за постоянного нуля свободного кэша). Резерв даёт реальный
    // шанс воспользоваться этой веткой.
    const reserve = 15000;
    const spendable = Math.max(0, (cash - reserve) * 0.35);
    const affordablePct = Math.floor(spendable / (price / 100));
    let pct = Math.min(25, freePct, affordablePct);
    if (pct < 1) return 0;
    pct = Math.max(1, Math.min(pct, 5 + Math.floor(Math.random() * 15)));
    return pct;
  }

  function botStep(room) {
    if (!room || room.phase !== "roll") return { acted: false };

    // 1) Назначена цена выкупа доли — цель обязана заплатить (это всегда текущий
    // ходящий игрок, т.к. цена привязана к его собственному броску).
    if (room.pendingForcedPrice) {
      const target = room.players.find((p) => p.id === room.pendingForcedPrice.targetId);
      if (isBotPlayer(target) && currentPlayerId(room) === target.id) {
        return { acted: true, type: "payForcedPrice", result: payForcedPrice(room, target.id) };
      }
    }

    // 2) Контролирующий игрок-бот с активным броском на его пакет — назначает цену
    // выкупа независимо от того, чей сейчас ход (в реальных правилах это доступно
    // сразу, а не только когда у банка кончились свободные акции). Но если у бросившего
    // ещё есть выбор просто купить свежие акции у банка (свободные %) и он (будучи
    // ботом) собирается это сделать — даём ему сначала попробовать купить (шаг 4),
    // а не отбираем выбор принудительной ценой контролёра.
    if (room.pendingRoll && room.pendingRoll.ticker && !room.pendingForcedPrice) {
      const roll = room.pendingRoll;
      const ticker = roll.ticker;
      // Строго та же проверка "единоличного контролёра", что и в dividendFromRoll/
      // setForcedPrice: единственный держатель (кроме самого бросающего) с >50% —
      // иначе (несколько миноритариев) действует dividendFromRoll, а не forced-price.
      const owners = room.players.filter((p) => !p.bankrupt && p.id !== roll.playerId && (p.holdings[ticker] || 0) > 0);
      const controller = owners.length === 1 && owners[0].holdings[ticker] > 50 ? owners[0] : null;
      if (controller && isBotPlayer(controller) && controller.id !== roll.playerId) {
        const free = 100 - totalOwnedPct(room, ticker);
        const roller = room.players.find((p) => p.id === roll.playerId);
        // Фикс бага: если контролёр УЖЕ назначил forced-price (пока бот принимал решение),
        // roller.cash не учитывает грядущий платёж — проверяем pendingForcedPrice явно.
        const pendingPayment = room.pendingForcedPrice && room.pendingForcedPrice.targetId === roller.id ? room.pendingForcedPrice.amount : 0;
        const effectiveCash = roller.cash - pendingPayment;
        const rollerWantsToBuy = free >= 1 && isBotPlayer(roller) && botChoosePct(effectiveCash, room.companies[ticker].price, free) >= 1;
        if (!rollerWantsToBuy) {
          const c = room.companies[ticker];
          const tier = companyByTicker(ticker).tier;
          const heldPct = controller.holdings[ticker] || 0;
          const fair = c.price * getForcedPaymentPct(room, tier) * (heldPct / 100);
          const amount = Math.round(fair * (1.5 + Math.random()));
          return { acted: true, type: "setForcedPrice", result: setForcedPrice(room, controller.id, amount) };
        }
      }
    }

    // 3) Входящие предложения сделок, адресованные боту — сразу принять/отклонить
    // (простое сравнение рыночной стоимости получаемого и отдаваемого).
    for (const trade of room.pendingTrades) {
      if (!isBotPlayer(room.players.find((p) => p.id === trade.toId))) continue;
      const to = room.players.find((p) => p.id === trade.toId);
      const got = room.companies[trade.ticker].price * (trade.pct / 100);
      const paid = trade.price + (trade.wantTicker ? room.companies[trade.wantTicker].price * (trade.wantPct / 100) : 0);
      const canPay = (trade.price === 0 || to.cash >= trade.price) && (!trade.wantTicker || (to.holdings[trade.wantTicker] || 0) >= trade.wantPct);
      const accept = canPay && got >= paid * 0.9;
      return { acted: true, type: "respondTrade", result: respondTrade(room, to.id, trade.id, accept) };
    }

    // 4) Собственный ход бота (только если сейчас действительно его очередь).
    const curId = currentPlayerId(room);
    const cur = room.players.find((p) => p.id === curId);
    if (!isBotPlayer(cur)) return { acted: false };

    // 4a) Спецдействия бота: с небольшой вероятностью использует шпионаж, дискредитацию,
    // сквиз-аут, шорты перед броском кубиков (если есть деньги и есть смысл).
    if (!room.pendingRoll && !room.rolledThisTurn && Math.random() < 0.15) {
      const myControlled = controlledTickers(room, cur.id);
      const otherPlayers = room.players.filter(p => p.id !== cur.id && !p.bankrupt);

      // Шпионаж: если есть противники с высокой репутацией (>60) и не в кулдауне
      if (otherPlayers.length > 0 && Math.random() < 0.3) {
        const targets = otherPlayers.filter(p => {
          const rep = p.reputation == null ? REPUTATION_START : p.reputation;
          return rep > 60 && room.spyCooldown[p.id] !== room.eventCount;
        });
        if (targets.length > 0) {
          const target = targets[Math.floor(Math.random() * targets.length)];
          const cost = espionageCost(room, cur);
          if (cur.cash >= cost * 1.5) {
            const result = ctrlEspionage(room, cur.id, target.id);
            if (result.ok) return { acted: true, type: "ctrlEspionage", result };
          }
        }
      }

      // Дискредитация: если есть противники с высокой репутацией (>70) и не в кулдауне
      if (otherPlayers.length > 0 && Math.random() < 0.25) {
        const targets = otherPlayers.filter(p => {
          const rep = p.reputation == null ? REPUTATION_START : p.reputation;
          return rep > 70 && room.discreditCooldown[p.id] !== room.eventCount;
        });
        if (targets.length > 0) {
          const target = targets[Math.floor(Math.random() * targets.length)];
          const cost = discreditCost(room, cur, target);
          if (cur.cash >= cost * 1.5) {
            const result = ctrlDiscredit(room, cur.id, target.id);
            if (result.ok) return { acted: true, type: "ctrlDiscredit", result };
          }
        }
      }

      // Сквиз-аут: если владеет >75% компании и есть деньги
      if (myControlled.length > 0 && Math.random() < 0.2) {
        const squeezeCandidates = myControlled.filter(t => (cur.holdings[t] || 0) > 75 && !room.companies[t].squeezedOut);
        if (squeezeCandidates.length > 0) {
          const ticker = squeezeCandidates[Math.floor(Math.random() * squeezeCandidates.length)];
          const cost = squeezeOutCost(room, cur, ticker);
          if (cur.cash >= cost * 1.3) {
            const result = ctrlSqueezeOut(room, cur.id, ticker);
            if (result.ok) return { acted: true, type: "ctrlSqueezeOut", result };
          }
        }
      }

      // Шорт: если есть деньги и еще нет активного шорта
      if (Math.random() < 0.15) {
        const myShorts = (room.shorts || []).filter(sh => sh.playerId === cur.id);
        if (myShorts.length === 0) {
          const cost = shortDepositCost(room, cur);
          if (cur.cash >= cost * 2) {
            const ticker = COMPANIES[Math.floor(Math.random() * COMPANIES.length)].ticker;
            const result = ctrlShort(room, cur.id, ticker);
            if (result.ok) return { acted: true, type: "ctrlShort", result };
          }
        }
      }

      // Расследование: если есть инциденты против бота
      const incidents = (room.spyIncidents || []).filter(inc => inc.targetId === cur.id);
      if (incidents.length > 0 && Math.random() < 0.4) {
        const cost = investigationCost(room, cur);
        if (cur.cash >= cost * 1.5) {
          const result = ctrlInvestigate(room, cur.id);
          if (result.ok) return { acted: true, type: "ctrlInvestigate", result };
        }
      }
    }

    if (room.pendingRoll) {
      const roll = room.pendingRoll;
      if (roll.realEstateId) {
        const cityId = roll.realEstateId;
        const re = room.realEstate[cityId];
        if (!re.ownerId) {
          const cost = realEstatePrice(room, cityId) * (1 + bankFeePct(cur.reputation));
          if (cur.cash - cost >= 10000 && Math.random() < 0.85) {
            return { acted: true, type: "buyRealEstateFromRoll", result: buyRealEstateFromRoll(room, cur.id) };
          }
          return { acted: true, type: "skipRoll", result: skipRoll(room, cur.id) };
        }
        if (re.ownerId === cur.id) {
          if ((re.level || 0) < MAX_RE_LEVEL) {
            const cost = realEstateUpgradeCost(room, cityId);
            if (cur.cash - cost >= 10000 && Math.random() < 0.6) {
              return { acted: true, type: "upgradeRealEstateFromRoll", result: upgradeRealEstateFromRoll(room, cur.id) };
            }
          }
          return { acted: true, type: "skipRoll", result: skipRoll(room, cur.id) };
        }
        return { acted: true, type: "payRealEstateRentFromRoll", result: payRealEstateRentFromRoll(room, cur.id) };
      }
      const ticker = roll.ticker;
      const free = 100 - totalOwnedPct(room, ticker);
      const c = room.companies[ticker];
      const pct = free >= 1 ? botChoosePct(cur.cash, c.price, free) : 0;
      if (pct >= 1) return { acted: true, type: "buyFromRoll", result: buyFromRoll(room, cur.id, pct) };
      const div = dividendFromRoll(room, cur.id);
      if (div.error) return { acted: false }; // ждём, пока контролирующий игрок назначит цену выкупа
      return { acted: true, type: "dividendFromRoll", result: div };
    }

    if (!room.rolledThisTurn) {
      return { acted: true, type: "rollDice", result: rollDice(room, cur.id) };
    }
    return { acted: true, type: "endTurn", result: endTurn(room, cur.id) };
  }

  // ---------------------------------------------------------------------
  // §7 Спецдействия контрольного пакета (>50%)
  // ---------------------------------------------------------------------
  function ctrlNegativeInfo(room, playerId, ticker) {
    const err = requireOwnTurn(room, playerId, { blockFrozen: true });
    if (err) return { error: err };
    const p = room.players.find((x) => x.id === playerId);
    if (!p || p.bankrupt) return { error: "Недоступно." };
    const mine = controlledTickers(room, p.id);
    if (mine.length === 0) return { error: "Нужен контрольный пакет (>50%) хотя бы одной компании." };
    const target = room.companies[ticker];
    if (!target) return { error: "Неизвестная компания." };
    if (mine.includes(ticker)) return { error: "Действует только против чужой компании." };
    if (room.eventCount - target.lastNegInfoEvent < 2) return { error: "Эту компанию уже атаковали недавно — раз в 2 события." };
    const cost = negativeInfoCost(room, p);
    if (p.cash < cost) return { error: `Недостаточно наличных (нужно ${fmt(cost)}).` };
    p.cash -= cost;
    target.lastNegInfoEvent = room.eventCount;
    applyPriceDelta(room, ticker, -15);
    addLog(room, `📉 ${p.name} вбросил негативную информацию о ${ticker} за ${fmt(cost)}: −15%.`, "control");
    return { ok: true };
  }

  function ctrlPrCampaign(room, playerId, ticker) {
    const err = requireOwnTurn(room, playerId, { blockFrozen: true });
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
    const err = requireOwnTurn(room, playerId, { blockFrozen: true });
    if (err) return { error: err };
    const p = room.players.find((x) => x.id === playerId);
    if (!p || p.bankrupt) return { error: "Недоступно." };
    if (controlledTickers(room, p.id).length === 0) return { error: "Нужен контрольный пакет (>50%) хотя бы одной компании." };
    if (room.insiderUsedEvent[p.id] === room.eventCount) return { error: "Инсайд уже использован в это событие." };
    if (room.pendingInsider) return { error: "Кто-то уже подсматривает карту — дождитесь решения." };
    const cost = insiderPeekCost(room, p);
    if (p.cash < cost) return { error: `Недостаточно наличных (нужно ${fmt(cost)}).` };
    p.cash -= cost;
    room.insiderUsedEvent[p.id] = room.eventCount;
    if (room.deckPos >= room.deckOrder.length) { room.deckOrder = shuffle(room.deckOrder); room.deckPos = 0; }
    const idx = room.deckOrder[room.deckPos];
    const card = room.deckData[idx];
    room.pendingInsider = { playerId: p.id };
    addLog(room, `🕵️ ${p.name} использовал Инсайд за ${fmt(cost)} — подсматривает верхнюю карту колоды.`, "control");
    return { ok: true, card };
  }

  function ctrlInsiderResolve(room, playerId, action) {
    if (!room || room.phase !== "roll") return { error: "Сейчас недоступно." };
    if (!room.pendingInsider || room.pendingInsider.playerId !== playerId) return { error: "Нечего разрешать." };
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
    const err = requireOwnTurn(room, playerId, { blockFrozen: true });
    if (err) return { error: err };
    const p = room.players.find((x) => x.id === playerId);
    if (!p || p.bankrupt) return { error: "Недоступно." };
    if ((p.holdings[ticker] || 0) <= 75) return { error: "Нужно больше 75% этой компании." };
    const c = room.companies[ticker];
    const minority = room.players.filter((x) => x.id !== p.id && !x.bankrupt && (x.holdings[ticker] || 0) > 0);
    if (minority.length === 0) return { error: "Нет миноритариев для выкупа." };
    const totalCost = squeezeOutCost(room, p, ticker);
    if (p.cash < totalCost) return { error: `Недостаточно наличных для выкупа (нужно ${fmt(totalCost)}).` };
    p.cash -= totalCost;
    minority.forEach((x) => {
      const proceeds = c.price * (x.holdings[ticker] / 100);
      x.cash += proceeds;
      addCostBasis(p, ticker, x.holdings[ticker], proceeds);
      p.holdings[ticker] = (p.holdings[ticker] || 0) + x.holdings[ticker];
      x.holdings[ticker] = 0;
      if (x.costBasis) x.costBasis[ticker] = 0;
    });
    c.squeezedOut = true;
    c.lastSqueezeEvent = room.eventCount;
    addLog(room, `🧹 ${p.name} принудительно выкупил миноритариев ${ticker} за ${fmt(totalCost)} — теперь дивиденды по ней ×2.`, "control");
    checkFullOwnership(room, ticker);
    return { ok: true };
  }


  function ctrlShort(room, playerId, ticker) {
    const err = requireOwnTurn(room, playerId, { blockFrozen: true });
    if (err) return { error: err };
    const p = room.players.find((x) => x.id === playerId);
    if (!p || p.bankrupt) return { error: "Недоступно." };
    const c = room.companies[ticker];
    if (!c) return { error: "Неизвестная компания." };
    if (room.shorts.some((s) => s.playerId === p.id && s.ticker === ticker)) return { error: "У вас уже есть открытый шорт по этой компании." };
    const deposit = shortDepositCost(room, p);
    if (p.cash < deposit) return { error: `Недостаточно наличных (нужен залог ${fmt(deposit)}).` };
    p.cash -= deposit;
    room.shorts.push({ id: room.nextShortId++, playerId: p.id, ticker, deposit, priceAtBet: c.price, placedEventCount: room.eventCount });
    addLog(room, `🎲 ${p.name} открыл шорт по ${ticker} (залог ${fmt(deposit)}), ставка на падение к следующему событию.`, "control");
    return { ok: true };
  }

  function ctrlPublicIPO(room, playerId, ticker) {
    // Народное IPO (вторичное размещение) — контригра против fullyOwned:
    // конфискует 25% у монополиста, возвращает их в банк (доступны для покупки),
    // снижает цену компании на 12% (разводнение капитала).
    const err = requireOwnTurn(room, playerId, { blockFrozen: true });
    if (err) return { error: err };
    const p = room.players.find((x) => x.id === playerId);
    if (!p || p.bankrupt) return { error: "Недоступно." };
    const c = room.companies[ticker];
    if (!c) return { error: "Неизвестная компания." };
    if (!c.fullyOwned) return { error: "Народное IPO доступно только для компаний с полным поглощением (100% у одного игрока)." };
    const monopolist = room.players.find((x) => !x.bankrupt && (x.holdings[ticker] || 0) >= 100);
    if (!monopolist) return { error: "Монополист не найден." };
    if (monopolist.id === p.id) return { error: "Нельзя провести народное IPO против самого себя." };
    const cost = Math.round(netWorth(room, p) * 0.08); // Стоимость 8% от капитала инициатора
    if (p.cash < cost) return { error: `Недостаточно наличных для народного IPO (нужно ${fmt(cost)}).` };

    p.cash -= cost;
    monopolist.holdings[ticker] = (monopolist.holdings[ticker] || 0) - 25;
    if (monopolist.holdings[ticker] <= 0) monopolist.holdings[ticker] = 0;

    // Пропорционально снижаем себестоимость у монополиста (потерял 25% из 100% = потерял четверть пакета)
    if (monopolist.costBasis && monopolist.costBasis[ticker]) {
      monopolist.costBasis[ticker] *= 0.75;
    }

    applyPriceDelta(room, ticker, -12); // Цена падает на 12% из-за разводнения
    c.fullyOwned = false; // Полное поглощение снято

    addLog(room, `📢 ${p.name} инициировал(а) народное IPO ${ticker} за ${fmt(cost)} — 25% отобраны у ${monopolist.name}, цена упала на 12%.`, "control");
    return { ok: true };
  }


  function declareBankruptcy(room, playerId) {
    if (!room) return { error: "Комната не найдена." };
    const p = room.players.find((x) => x.id === playerId);
    if (!p || p.bankrupt) return { error: "Недоступно." };
    p.holdings = {};
    p.costBasis = {};
    CITIES.forEach((ct) => {
      const re = room.realEstate[ct.id];
      if (re && re.ownerId === p.id) { re.ownerId = null; re.level = 0; }
    });
    p.loan = null;
    p.bankrupt = true;
    adjustReputation(room, p, -30, "банкротство");
    addLog(room, `💀 ${p.name} объявил банкротство.`, "bankrupt");
    if (room.pendingRoll && room.pendingRoll.playerId === p.id) room.pendingRoll = null;
    if (room.pendingForcedPrice && (room.pendingForcedPrice.targetId === p.id || room.pendingForcedPrice.controllerId === p.id)) room.pendingForcedPrice = null;
    room.pendingTrades = room.pendingTrades.filter((t) => t.fromId !== p.id && t.toId !== p.id);
    checkEndGame(room);
    return { ok: true };
  }

  // ---------------------------------------------------------------------
  // Кредиты банка
  // ---------------------------------------------------------------------
  function takeLoan(room, playerId, amountRaw) {
    if (!room) return { error: "Комната не найдена." };
    const p = room.players.find((x) => x.id === playerId);
    if (!p || p.bankrupt) return { error: "Недоступно." };
    if (p.loan) return { error: "У вас уже есть непогашенный кредит — сначала погасите его." };
    const amount = Math.max(0, Math.round(Number(amountRaw) || 0));
    if (amount <= 0) return { error: "Некорректная сумма." };
    const terms = loanTerms(room, p);
    if (amount > terms.limit) return { error: `Банк одобряет кредит не более ${fmt(terms.limit)} при вашей репутации и капитале.` };
    p.cash += amount;
    p.loan = { principal: amount, originalAmount: amount, ratePct: terms.ratePct, takenEvent: room.eventCount, missedPayments: 0 };
    addLog(room, `🏦 ${p.name} взял кредит ${fmt(amount)} у банка под ${terms.ratePct}% за событие.`, "loan");
    return { ok: true };
  }

  function repayLoan(room, playerId, amountRaw) {
    if (!room) return { error: "Комната не найдена." };
    const p = room.players.find((x) => x.id === playerId);
    if (!p || !p.loan) return { error: "У вас нет кредита." };
    const amount = Math.max(0, Math.min(p.loan.principal, Math.round(Number(amountRaw) || 0)));
    if (amount <= 0) return { error: "Некорректная сумма." };
    if (p.cash < amount) return { error: "Недостаточно наличных." };
    p.cash -= amount;
    p.loan.principal -= amount;
    addLog(room, `${p.name} погасил ${fmt(amount)} кредита.`, "loan");
    if (p.loan.principal <= 1) {
      // Бонус к репутации за полное погашение начисляется, только если кредит
      // пережил хотя бы один цикл начисления процентов (room.eventCount > takenEvent)
      // и был не символическим — иначе можно было бы "фармить" репутацию,
      // мгновенно беря и тут же закрывая кредит на $1 неограниченное число раз.
      const survivedACycle = room.eventCount > p.loan.takenEvent;
      const meaningfulAmount = p.loan.originalAmount >= 1000;
      p.loan = null;
      if (survivedACycle && meaningfulAmount) {
        adjustReputation(room, p, 3, "кредит погашен полностью");
        addLog(room, `✅ ${p.name} полностью погасил кредит — репутация выросла.`, "loan");
      } else {
        addLog(room, `${p.name} полностью погасил кредит.`, "loan");
      }
    } else {
      // Бонус за добровольный частичный платёж: не чаще раза в событие на кредит,
      // и только если платёж ощутимый (≥10% от изначальной суммы кредита) — иначе
      // можно было бы дробить платежи на копейки ради накрутки репутации.
      const meaningfulPartial = p.loan.originalAmount >= 1000 && amount >= p.loan.originalAmount * 0.1;
      const alreadyBonused = p.loan.lastPartialBonusEvent === room.eventCount;
      if (meaningfulPartial && !alreadyBonused) {
        p.loan.lastPartialBonusEvent = room.eventCount;
        adjustReputation(room, p, 1, "частичное погашение кредита");
        addLog(room, `💳 ${p.name} внёс(ла) существенный частичный платёж по кредиту — репутация чуть выросла.`, "loan");
      }
    }
    return { ok: true };
  }

  // Начисление процентов + автосписание минимального платежа — вызывается на
  // каждое биржевое событие. Просрочка (нет денег на минимальный платёж) бьёт по
  // репутации; после 3 просрочек подряд банк принудительно взыскивает остаток долга.
  function processLoans(room) {
    activePlayers(room).forEach((p) => {
      if (!p.loan) return;
      p.loan.principal += p.loan.principal * (p.loan.ratePct / 100);
      const minPay = p.loan.principal * 0.15;
      if (p.cash >= minPay) {
        p.cash -= minPay;
        p.loan.principal -= minPay;
        p.loan.missedPayments = 0;
        if (p.loan.principal <= 1) {
          p.loan = null;
          addLog(room, `${p.name} полностью погасил кредит автоплатежами.`, "loan");
        }
      } else {
        p.loan.missedPayments = (p.loan.missedPayments || 0) + 1;
        adjustReputation(room, p, -10, "просрочка платежа по кредиту");
        addLog(room, `⚠️ ${p.name} не смог внести минимальный платёж по кредиту (${fmt(minPay)}) — репутация снижена.`, "loan");
        if (p.loan.missedPayments >= 3) {
          addLog(room, `🏦 Банк взыскивает непогашенный долг ${p.name} принудительно.`, "loan");
          p.cash -= p.loan.principal;
          p.loan = null;
          settleDebt(room, p);
        }
      }
    });
  }

  // Восстановление репутации — вызывается раз в биржевое событие (после processLoans).
  // Два независимых механизма:
  //  1) Пассивный дрейф к базовой репутации: если репутация ниже стартовой (50) и
  //     нет активного кредита (иначе долг уже "объясняет" низкую репутацию и её
  //     восстановление идёт через погашение), она медленно подрастает сама по себе.
  //  2) Бонус за "чистую" серию: если игрок давно (≥3 события) не прибегал к
  //     шпионажу/дискредитации против других — вне зависимости от успеха попытки,
  //     сам факт таких грязных методов сбрасывает счётчик — начисляется разовый
  //     бонус за репутацию "чистых рук", не чаще раза в 3 события.
  function processReputationRecovery(room) {
    const CLEAN_STREAK_EVENTS = 3;
    activePlayers(room).forEach((p) => {
      const rep = p.reputation == null ? REPUTATION_START : p.reputation;
      if (rep < REPUTATION_START && !p.loan) {
        adjustReputation(room, p, 1, "естественное восстановление доверия");
      }
      const lastDirty = p.lastDirtyActionEvent == null ? -100 : p.lastDirtyActionEvent;
      const lastCleanBonus = p.lastCleanBonusEvent == null ? -100 : p.lastCleanBonusEvent;
      if (room.eventCount - lastDirty >= CLEAN_STREAK_EVENTS && room.eventCount - lastCleanBonus >= CLEAN_STREAK_EVENTS) {
        p.lastCleanBonusEvent = room.eventCount;
        adjustReputation(room, p, 2, "репутация «чистых рук»");
        addLog(room, `✨ ${p.name} получил(а) бонус к репутации за отсутствие грязных методов.`, "reputation");
      }
    });
  }

  // Рыночный дрейф городов — раз в биржевое событие. Также начисляется пассивная
  // рента владельцам улучшенной недвижимости (level ≥ 1): 35% от полной ренты за
  // уровень 1, +35% за каждый следующий уровень (макс 140% при level 4).
  // Налог на недвижимость: 5% от базовой ренты города за событие (только если есть деньги).
  function processRealEstate(room) {
    CITIES.forEach((ct) => {
      const re = room.realEstate[ct.id];
      const drift = Math.random() * 6 - 2; // -2%..+4%, лёгкий уклон вверх
      re.factor = clamp((re.factor || 1) * (1 + drift / 100), 0.6, 2.2);

      // Пассивная рента для улучшенной недвижимости
      if (re.ownerId && (re.level || 0) >= 1) {
        const owner = room.players.find(p => p.id === re.ownerId);
        if (owner && !owner.bankrupt) {
          const fullRent = realEstateRent(room, ct.id);
          const passiveRentPct = 0.35 * re.level; // 35% за уровень (макс 140% при level 4)
          const passiveRent = Math.round(fullRent * passiveRentPct);
          owner.cash += passiveRent;
          addLog(room, `🏠 ${owner.name} получает пассивную ренту ${fmt(passiveRent)} (${Math.round(passiveRentPct * 100)}%) от недвижимости в г. ${ct.name} (уровень ${re.level}).`, "realestate");
        }
      }

      // Налог на недвижимость: владелец платит 5% от базовой ренты города (если есть деньги)
      if (re.ownerId) {
        const owner = room.players.find(p => p.id === re.ownerId);
        if (owner && !owner.bankrupt) {
          const tax = Math.round(ct.rent * 0.05);
          if (owner.cash >= tax) {
            owner.cash -= tax;
            addLog(room, `🏛️ ${owner.name} платит налог на недвижимость ${fmt(tax)} за г. ${ct.name}.`, "realestate");
          } else {
            addLog(room, `⚠️ ${owner.name} не может заплатить налог ${fmt(tax)} на недвижимость в г. ${ct.name}.`, "realestate");
          }
        }
      }
    });

    // Бонус за комплект недвижимости: если игрок владеет 3+ городов, получает бонус
    room.players.forEach(p => {
      if (p.bankrupt) return;
      const ownedCities = CITIES.filter(ct => room.realEstate[ct.id].ownerId === p.id);
      if (ownedCities.length >= 3) {
        const bonus = 10000 * Math.floor(ownedCities.length / 3);
        p.cash += bonus;
        addLog(room, `🏆 ${p.name} получает бонус ${fmt(bonus)} за комплект недвижимости (${ownedCities.length} городов).`, "realestate");
      }
    });
  }

  // ---------------------------------------------------------------------
  // Шпионаж и дискредитация
  // ---------------------------------------------------------------------
  function isRevealed(room, viewerId, targetId) {
    if (viewerId === targetId) return true;
    return room.reveals.some((r) => r.spyId === viewerId && r.targetId === targetId && r.expiresEvent >= room.eventCount);
  }

  function ctrlEspionage(room, playerId, targetId) {
    const err = requireOwnTurn(room, playerId);
    if (err) return { error: err };
    const p = room.players.find((x) => x.id === playerId);
    const target = room.players.find((x) => x.id === targetId);
    if (!p || p.bankrupt) return { error: "Недоступно." };
    if (!target || target.bankrupt || target.id === p.id) return { error: "Некорректная цель." };
    if (room.spyCooldown[targetId] === room.eventCount) return { error: "За эту цель уже брались в это событие — попробуйте после следующего." };
    const cost = espionageCost(room, p);
    if (p.cash < cost) return { error: `Недостаточно наличных (нужно ${fmt(cost)}).` };
    p.cash -= cost;
    room.spyCooldown[targetId] = room.eventCount;
    p.lastDirtyActionEvent = room.eventCount;
    const targetRep = target.reputation == null ? REPUTATION_START : target.reputation;
    const successChance = clamp(0.75 - targetRep / 500, 0.25, 0.75);
    const success = Math.random() < successChance;
    if (success) {
      room.reveals = room.reveals.filter((r) => !(r.spyId === p.id && r.targetId === target.id));
      room.reveals.push({ spyId: p.id, targetId: target.id, expiresEvent: room.eventCount + 2 });
      // Личность шпиона не раскрывается публично — только через расследование цели (ctrlInvestigate).
      room.spyIncidents.push({ id: room.nextIncidentId++, kind: "espionage", targetId: target.id, suspectId: p.id, eventCount: room.eventCount });
      addLog(room, `🕵️ Кто-то провёл шпионаж против ${target.name} — активы раскрыты на 2 события. Личность неизвестна.`, "espionage");
    } else {
      adjustReputation(room, p, -8, "пойман на шпионаже");
      addLog(room, `🚨 ${p.name} попытался шпионить за ${target.name}, но был пойман! Репутация ${p.name} снижена.`, "espionage");
    }
    return { ok: true, success };
  }

  function ctrlDiscredit(room, playerId, targetId) {
    const err = requireOwnTurn(room, playerId);
    if (err) return { error: err };
    const p = room.players.find((x) => x.id === playerId);
    const target = room.players.find((x) => x.id === targetId);
    if (!p || p.bankrupt) return { error: "Недоступно." };
    if (!target || target.bankrupt || target.id === p.id) return { error: "Некорректная цель." };
    if (room.discreditCooldown[targetId] === room.eventCount) return { error: "Эту цель уже дискредитировали в это событие." };
    const cost = discreditCost(room, p, target);
    if (p.cash < cost) return { error: `Недостаточно наличных (нужно ${fmt(cost)}).` };
    p.cash -= cost;
    room.discreditCooldown[targetId] = room.eventCount;
    p.lastDirtyActionEvent = room.eventCount;
    const success = Math.random() < 0.55;
    if (success) {
      adjustReputation(room, target, -15, "дискредитирован анонимно");
      // Личность инициатора не раскрывается публично — только через расследование цели (ctrlInvestigate).
      room.spyIncidents.push({ id: room.nextIncidentId++, kind: "discredit", targetId: target.id, suspectId: p.id, eventCount: room.eventCount });
      addLog(room, `🗞️ Кто-то дискредитировал ${target.name} — репутация цели снижена. Личность неизвестна.`, "espionage");
    } else {
      adjustReputation(room, p, -10, "провалившаяся попытка дискредитации");
      addLog(room, `🚨 Попытка ${p.name} дискредитировать ${target.name} провалилась и вскрылась публично! Репутация ${p.name} снижена.`, "espionage");
    }
    return { ok: true, success };
  }

  // Личный PR: платное восстановление собственной репутации, доступно любому
  // игроку в свой ход (не требует контрольного пакета). Стоимость растёт с
  // каждым использованием за партию, чтобы не превращалось в дешёвый постоянный
  // канал восстановления — не чаще раза в биржевое событие.
  function personalPr(room, playerId) {
    const err = requireOwnTurn(room, playerId);
    if (err) return { error: err };
    const p = room.players.find((x) => x.id === playerId);
    if (!p || p.bankrupt) return { error: "Недоступно." };
    if (room.eventCount === p.personalPrLastEvent) return { error: "Личный PR уже использован в это событие." };
    const rep = p.reputation == null ? REPUTATION_START : p.reputation;
    if (rep >= 100) return { error: "Репутация уже максимальна." };
    const cost = personalPrCostFor(room, p);
    if (p.cash < cost) return { error: `Недостаточно наличных (нужно ${fmt(cost)}).` };
    p.cash -= cost;
    p.personalPrCount = (p.personalPrCount || 0) + 1;
    p.personalPrLastEvent = room.eventCount;
    adjustReputation(room, p, 4, "личный PR");
    addLog(room, `📣 ${p.name} провёл(а) личную PR-кампанию за ${fmt(cost)} — репутация выросла.`, "reputation");
    return { ok: true };
  }

  // Расследование: цель шпионажа/дискредитации может попытаться вычислить,
  // кто именно против неё действовал. Стоимость и шанс успеха зависят от
  // капитала и репутации самой цели (богаче и репутабельнее — доступнее
  // качественное расследование). Раскрывает самый старый нераскрытый случай.
  function investigationCost(room, player) {
    const rep = player.reputation == null ? REPUTATION_START : player.reputation;
    const base = clamp(Math.round(netWorth(room, player) * 0.04), 5000, 50000);
    return Math.max(3000, Math.round(base - rep * 40));
  }
  function investigationChance(room, player) {
    const rep = player.reputation == null ? REPUTATION_START : player.reputation;
    return clamp(0.28 + rep / 380 + netWorth(room, player) / 2500000, 0.2, 0.85);
  }
  function ctrlInvestigate(room, playerId) {
    const err = requireOwnTurn(room, playerId);
    if (err) return { error: err };
    const p = room.players.find((x) => x.id === playerId);
    if (!p || p.bankrupt) return { error: "Недоступно." };
    const incidents = room.spyIncidents.filter((i) => i.targetId === playerId).sort((a, b) => a.eventCount - b.eventCount);
    if (!incidents.length) return { error: "Нет нераскрытых случаев против вас — расследовать нечего." };
    const incident = incidents[0];
    const cost = investigationCost(room, p);
    if (p.cash < cost) return { error: `Недостаточно наличных (нужно ${fmt(cost)}).` };
    p.cash -= cost;
    const success = Math.random() < investigationChance(room, p);
    room.spyIncidents = room.spyIncidents.filter((i) => i.id !== incident.id);
    if (success) {
      const suspect = room.players.find((x) => x.id === incident.suspectId);
      const kindLabel = incident.kind === "espionage" ? "шпионил за вами" : "дискредитировал вас";
      if (suspect) adjustReputation(room, suspect, -10, "разоблачён расследованием");
      addLog(room, `🔍 Расследование ${p.name} (${fmt(cost)}) увенчалось успехом: ${suspect ? suspect.name : "неизвестный игрок"} ${kindLabel}!`, "espionage");
      return { ok: true, success: true, suspectId: incident.suspectId, suspectName: suspect ? suspect.name : null };
    }
    addLog(room, `🔍 ${p.name} потратил(а) ${fmt(cost)} на расследование, но виновный остался неизвестен.`, "espionage");
    return { ok: true, success: false };
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
  // Готовый «разбор» текущего броска для клиента — чтобы UI не парсил error-строки,
  // а сразу знал, какие кнопки показывать (купить/оплатить долю/ждать цену от
  // контролёра, либо купить/улучшить/заплатить ренту по недвижимости).
  function pendingRollMeta(room) {
    const roll = room.pendingRoll;
    if (!roll) return null;
    if (roll.ticker) {
      const owners = room.players.filter((p) => !p.bankrupt && p.id !== roll.playerId && (p.holdings[roll.ticker] || 0) > 0);
      const totalPct = owners.reduce((s, p) => s + (p.holdings[roll.ticker] || 0), 0);
      const controller = owners.length === 1 && owners[0].holdings[roll.ticker] > 50 ? owners[0] : null;
      return {
        kind: "stock", ticker: roll.ticker, ownersCount: owners.length, totalOwnedPct: totalPct,
        controllerId: controller ? controller.id : null, controllerName: controller ? controller.name : null,
        forcedPct: getForcedPaymentPct(room, companyByTicker(roll.ticker).tier),
      };
    }
    if (roll.realEstateId) {
      const cityId = roll.realEstateId;
      const re = room.realEstate[cityId];
      const ct = cityById(cityId);
      return {
        kind: "realestate", cityId, cityName: ct.name, ownerId: re.ownerId, level: re.level || 0,
        maxLevel: MAX_RE_LEVEL, price: realEstatePrice(room, cityId), rent: realEstateRent(room, cityId),
        upgradeCost: realEstateUpgradeCost(room, cityId),
      };
    }
    return null;
  }

  function buildStatePayload(room, youId) {
    const me = room.players.find((x) => x.id === youId);
    return {
      type: "state",
      you: youId,
      room: room.code,
      turn: room.turn,
      roundLen: room.settings?.eventIntervalTurns || EVENT_INTERVAL_TURNS,
      roundNumber: room.roundNumber || 1,
      maxRounds: room.maxRounds || null,
      eventCount: room.eventCount,
      deckRemaining: room.deckOrder.length - room.deckPos,
      phase: room.phase,
      hostPlayerId: room.hostPlayerId || null,
      canStart: room.phase === "lobby" && room.hostPlayerId === youId && room.players.length >= 2,
      chat: room.phase === "lobby" ? room.chat.slice(-100) : undefined,
      frozen: !!room.frozen,
      dividendMultiplier: room.dividendMultiplier || 1,
      rolledThisTurn: !!room.rolledThisTurn,
      currentPlayerId: currentPlayerId(room),
      pendingRoll: room.pendingRoll,
      pendingRollMeta: pendingRollMeta(room),
      pendingForcedPrice: room.pendingForcedPrice || null,
      pendingTrades: room.pendingTrades,
      shorts: room.shorts,
      pendingInsider: room.pendingInsider,
      gameResult: room.gameResult || null,
      kickVote: room.kickVote ? (() => {
        const target = room.players.find((p) => p.id === room.kickVote.targetId);
        const eligible = room.players.filter((p) => p.connected && !p.bankrupt && p.id !== room.kickVote.targetId);
        const yesCount = eligible.filter((p) => room.kickVote.voters[p.id]).length;
        return {
          targetId: room.kickVote.targetId,
          targetName: target ? target.name : "?",
          initiatorId: room.kickVote.initiatorId,
          yesVoterIds: eligible.filter((p) => room.kickVote.voters[p.id]).map((p) => p.id),
          yesCount,
          needed: Math.floor(eligible.length / 2) + 1,
          totalEligible: eligible.length,
          myVote: !!room.kickVote.voters[youId],
        };
      })() : null,
      reactions: room.reactions.slice(-20),
      // Случаи шпионажа/дискредитации против меня — без suspectId, чтобы не
      // подсказывать личность до успешного расследования (ctrlInvestigate).
      mySpyIncidents: me ? room.spyIncidents.filter((i) => i.targetId === youId).map((i) => ({ id: i.id, kind: i.kind, eventCount: i.eventCount })) : [],
      investigationPreview: me ? { cost: investigationCost(room, me), chancePct: Math.round(investigationChance(room, me) * 100) } : null,
      bankFeePct: me ? bankFeePct(me.reputation) : 0,
      bankTerms: me ? loanTerms(room, me) : null,
      myLoan: me && me.loan ? { principal: Math.round(me.loan.principal), ratePct: me.loan.ratePct, missedPayments: me.loan.missedPayments || 0 } : null,
      myPersonalPr: me ? { cost: personalPrCostFor(room, me), usedThisEvent: me.personalPrLastEvent === room.eventCount } : null,
      // Точные суммы всех платных «мер» контроля для текущего игрока — привязаны к
      // его капиталу (netWorth), поэтому вычисляются заново на каждый снимок
      // состояния и показываются в UI, чтобы игрок точно видел стоимость до клика.
      myMeasureCosts: me ? {
        espionage: espionageCost(room, me),
        negativeInfo: negativeInfoCost(room, me),
        insiderPeek: insiderPeekCost(room, me),
        shortDeposit: shortDepositCost(room, me),
      } : null,
      myDiscreditCosts: me ? Object.fromEntries(room.players.filter((p) => p.id !== me.id && !p.bankrupt).map((p) => [p.id, discreditCost(room, me, p)])) : {},
      mySqueezeCosts: me ? Object.fromEntries(COMPANIES.filter((c) => (me.holdings[c.ticker] || 0) > 75).map((c) => [c.ticker, squeezeOutCost(room, me, c.ticker)])) : {},
      realEstate: CITIES.map((ct) => {
        const re = room.realEstate[ct.id];
        const pos = REAL_ESTATE_POS[ct.id] || {};
        const owner = re.ownerId ? room.players.find((p) => p.id === re.ownerId) : null;
        return {
          id: ct.id, name: ct.name, row: pos.row, col: pos.col,
          ownerId: re.ownerId, ownerName: owner ? owner.name : null,
          level: re.level || 0, maxLevel: MAX_RE_LEVEL, factor: re.factor || 1,
          price: realEstatePrice(room, ct.id), rent: realEstateRent(room, ct.id),
          upgradeCost: realEstateUpgradeCost(room, ct.id),
        };
      }),
      companies: COMPANIES.map((c) => ({
        ticker: c.ticker, name: c.name, sector: c.sector, tier: c.tier,
        volLabel: VOL_LABEL[c.tier] || "Средняя",
        price: room.companies[c.ticker].price,
        prevPrice: room.companies[c.ticker].prevPrice,
        owned: totalOwnedPct(room, c.ticker),
        controllerId: (ownerOfControl(room, c.ticker) || {}).id || null,
        squeezedOut: !!room.companies[c.ticker].squeezedOut,
        fullyOwned: !!room.companies[c.ticker].fullyOwned,
        lastNegInfoEvent: room.companies[c.ticker].lastNegInfoEvent,
        lastPrEvent: room.companies[c.ticker].lastPrEvent,
        priceHistory: room.companies[c.ticker].priceHistory || [],
      })),
      players: room.players.map((p) => {
        const revealed = p.id === youId || isRevealed(room, youId, p.id);
        const reveal = !revealed ? null : room.reveals.find((r) => r.spyId === youId && r.targetId === p.id);
        // Прибыль/убыток по текущему пакету акций (только когда портфель виден —
        // свой или раскрытый шпионажем): сравниваем текущую рыночную стоимость
        // пакета с суммой, за которую он был приобретён (себестоимость).
        let holdingsPnl = {};
        if (revealed) {
          Object.keys(p.holdings || {}).forEach((ticker) => {
            const heldPct = p.holdings[ticker] || 0;
            if (heldPct <= 0) return;
            const basis = (p.costBasis && p.costBasis[ticker]) || 0;
            const currentValue = room.companies[ticker].price * (heldPct / 100);
            const pnl = currentValue - basis;
            holdingsPnl[ticker] = {
              basis: Math.round(basis),
              currentValue: Math.round(currentValue),
              pnl: Math.round(pnl),
              pnlPct: basis > 0 ? (pnl / basis) * 100 : 0,
            };
          });
        }
        return {
          id: p.id, name: p.name, gender: p.gender || "", avatar: p.avatar || "", points: p.points || 0,
          equippedBoardSkin: p.equippedBoardSkin || "default", isBot: !!p.isBot,
          cash: p.cash, bankrupt: p.bankrupt, connected: p.connected, kicked: !!p.kicked,
          netWorth: netWorth(room, p),
          reputation: p.reputation == null ? REPUTATION_START : p.reputation,
          loanPrincipal: p.loan ? Math.round(p.loan.principal) : 0,
          holdings: revealed ? p.holdings : {},
          holdingsPnl,
          properties: revealed ? CITIES.filter((ct) => room.realEstate[ct.id].ownerId === p.id).map((ct) => ({ id: ct.id, name: ct.name, level: room.realEstate[ct.id].level || 0 })) : [],
          holdingsHidden: !revealed,
          revealExpiresEvent: reveal ? reveal.expiresEvent : undefined,
        };
      }),
      log: room.log.filter((e) => !e.visibleTo || e.visibleTo.includes(youId)).slice(-60),
    };
  }

  return {
    TIER_PRICE, TIER_VOL, VOL_LABEL, TIER_FORCED_PAYMENT_PCT, TIER_DIVIDEND_MULT, TIER_DIVIDEND_SKIP_CHANCE, COMPANIES, BOARD,
    REPUTATION_START, CITIES, MAX_RE_LEVEL, REAL_ESTATE_POS,
    companyByTicker, cityById, isRealEstateCell, cityIdFromCell, buildDeck, shuffle, fmt,
    realEstatePrice, realEstateRent, realEstateUpgradeCost,
    freshRoom, addLog,
    totalOwnedPct, ownerOfControl, controlledTickers, netWorth, applyPriceDelta, ambientJitter, activePlayers, currentPlayerId,
    requireOwnTurn,
    settleDebt, checkEndGame, resolveShorts, marketEvent, afterRollAction, endTurn,
    addPlayer, setConnected, newGameKeepPlayers, startGame, setMaxRounds, deleteRoom, sendChatMessage,
    rollDice, buyFromRoll, dividendFromRoll, skipRoll, buyBank, sellBank, proposeTrade, respondTrade,
    setForcedPrice, payForcedPrice, botStep,
    ctrlNegativeInfo, ctrlPrCampaign, ctrlInsiderPeek, ctrlInsiderResolve, ctrlSqueezeOut, ctrlShort, ctrlPublicIPO, ctrlMergeCompanies,
    declareBankruptcy, forceEvent,
    adjustReputation, bankFeePct, loanTerms, takeLoan, repayLoan, processLoans,
    buyRealEstateFromRoll, upgradeRealEstateFromRoll, payRealEstateRentFromRoll, processRealEstate,
    ctrlEspionage, ctrlDiscredit, isRevealed, ctrlInvestigate, investigationCost, investigationChance, personalPr,
    startKickVote, voteKick, cancelKickVote, sendReaction, REACTION_EMOJIS,
    buildStatePayload,
  };
});
