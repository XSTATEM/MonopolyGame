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
  // выкупленные акции (тиры A/B/C). Запасное значение для комнат без настроек;
  // обычно ставка берётся из room.settings.tierForcedPaymentPct (по умолчанию
  // 60/45/30 — см. freshRoom и BALANCE-REPORT.md, Б4).
  const TIER_FORCED_PAYMENT_PCT = { A: 0.6, B: 0.45, C: 0.3 };
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
  // Верхняя граница цены выкупа и цены сделки: произвольная сумма по-прежнему
  // разрешена (хоть разорить соперника), но не 1e300 и не бесконечность —
  // иначе наличные становились Infinity, а в users.json уходили бесконечные очки.
  const MAX_DEAL_AMOUNT = 1e9;
  const MAX_POINTS_PER_GAME = 5000;
  // Потолок цены выкупа — 6 справедливых цен. Выше 4 (FORCED_PRICE_EXCESSIVE_MULT)
  // по-прежнему штраф репутацией и риск антимонопольной службы. Без потолка
  // контролёр назначал $1 млрд и забирал весь капитал соперника: в симуляциях
  // такой игрок выигрывал 98% партий (BALANCE-REPORT.md, А1).
  const FORCED_PRICE_CAP_MULT = 6;
  // Кривая платы за отказ от покупки и справедливой цены выкупа: ставка растёт
  // быстрее, чем выкуплена компания — чем больше её раскуплено соперниками,
  // тем жёстче плата (решение владельца, 2026-10-11). Вместо фактической доли
  // держателей x = доля / 100 (0..1) в формулу идёт «эффективная доля»
  // (holdersFeeFactor):
  //   f(x) = x × (1 + FEE_CURVE_K × x^FEE_CURVE_P) × (4 / активных игроков)^FEE_CURVE_N_EXP.
  // FEE_CURVE_K — насколько дороже линейной плата за полностью раскупленную
  // компанию: при x = 1 плата в (1 + K) раз выше, при x = 0.5 — в (1 + K × 0.5^P).
  // FEE_CURVE_P — крутизна: чем больше, тем позже (ближе к 100%) включается надбавка.
  // FEE_CURVE_N_EXP — поправка на размер стола: за малым столом соперники вместе
  // держат меньше акций, плата ниже и партия длиннее (своих ходов на игрока до
  // последнего выжившего: ~300 вдвоём против ~100 вшестером). Показатель > 0
  // поднимает плату при < 4 активных (не банкротах) игроках и снижает при > 4;
  // считается по активным, поэтому к концу партии плата для выживших растёт.
  // FEE_CURVE_N_MAX — потолок числа игроков в этой поправке: за столом на 7–8
  // (только онлайн) множитель (4/n)^N_EXP иначе так мал, что партия выходит
  // длиннее, чем сейчас (BALANCE-REPORT.md, раздел 00). При 2–6 игроках не влияет.
  // Выбрано (2026-10-12, BALANCE-REPORT.md, раздел 00): K = 1.5, P = 1,
  // N_EXP = 3.5, N_MAX = 6.5 — до последнего выжившего ≈100 своих ходов у каждого
  // при 2–8 игроках (медиана 95–106). Множитель стола: 2 игрока ×11.3, 3 — ×2.74,
  // 4 — ×1, 5 — ×0.46, 6 — ×0.24, 7 и больше — ×0.18. K = 0 и N_EXP = 0 вернут
  // прежнюю линейную плату байт в байт. Все — литералы: tools/sim подбирает
  // их через --override (выключить потолок: --override FEE_CURVE_N_MAX=99).
  const FEE_CURVE_K = 1.5;
  const FEE_CURVE_P = 1;
  const FEE_CURVE_N_EXP = 3.5;
  const FEE_CURVE_N_MAX = 6.5;

  // ---------------------------------------------------------------------
  // Испытания правил 13.10 (tools/sim, --override). По умолчанию — как было.
  // ---------------------------------------------------------------------
  // Плата держателям при ПОКУПКЕ доли на чужой компании. "refuse" — платит
  // только отказавшийся (покупка 1% снимала плату целиком); "reduce" — каждый
  // купленный процент снижает плату на FEE_REDUCE_PER_PCT, от 10% — без
  // платы; "always" — плата всегда, как рента, покупка — сверх неё
  // (ставку тогда умножает FEE_ALWAYS_MULT).
  const FEE_RULE = "refuse";
  const FEE_REDUCE_PER_PCT = 0.10;
  const FEE_ALWAYS_MULT = 1;
  // Покупка вне броска: раз в ход до DIRECT_BUY_MAX_PCT любой компании у
  // банка с наценкой DIRECT_BUY_MARKUP.
  const DIRECT_BUY = false;
  const DIRECT_BUY_MAX_PCT = 5;
  const DIRECT_BUY_MARKUP = 0.20;
  const DIRECT_BUY_PER_EVENT = false; // true — раз в биржевое событие, а не раз в ход
  // Дивиденды держателям: на каждом событии компания платит держателям эту
  // долю своей цены (пропорционально пакету). Деньги — от банка.
  const HOLDER_DIVIDEND_PCT = 0;
  // Цена мер влияния. "networth" — доля капитала игрока, как было; "company"
  // — в 2–3 раза дешевле, меры по компании — от её цены; "cooldown" —
  // бесплатно, каждая мера раз в MEASURE_COOLDOWN событий.
  const MEASURE_COST_MODE = "networth";
  const MEASURE_COOLDOWN = 3;
  const MEASURE_SCALE = 0.4;
  // Длительность партии по умолчанию — в своих ходах на игрока (решение владельца,
  // 2026-10-11: «до банкротства», ≈100 своих ходов у каждого). Это страховочный
  // лимит, а не цель: обычно партия кончается последним выжившим раньше
  // (медиана 95–106 своих ходов). Если за столько своих ходов у каждого
  // победителя нет, побеждает самый богатый. 150 — около p90–p95 естественной
  // длины при 3–8 игроках (дальше доходят 0–3.6% партий) и p85 вдвоём (15%);
  // за столом на 4 такой лимит не меняет доли побед стратегий (BALANCE-REPORT.md,
  // раздел 00). Лимит в ходах переводится в раунды при старте партии
  // (roundsForTurnsPerPlayer / applyGameLength): раунд = eventIntervalTurns ходов за столом.
  const DEFAULT_MAX_TURNS_PER_PLAYER = 150;
  const MAX_TURNS_PER_PLAYER_LIMIT = 1000;
  // Защита рейтинга от накрутки: две учётки по кругу «Новая партия» + банкротство
  // (или лимит в 1 раунд, присланный в обход меню лобби) чеканили очки за пустые
  // партии. Очки за победу — только если стол сыграл хотя бы столько ходов:
  // 40 = 10 биржевых событий при стандартном темпе (событие раз в 4 хода).
  // Порог взят из симуляций ботов после пакета А5 + Б1–Б4 (BALANCE-REPORT.md,
  // раздел 0; 2–6 игроков): на 15/30 раундов банкротств нет вовсе, на 50 —
  // единичные (не раньше 34-го события), без лимита самое раннее первое
  // банкротство — 31-е событие (p10 ≈ 78–105-е), т. е. честная партия раньше
  // порога не заканчивается, а самый короткий режим лобби (15 раундов = 60 ходов)
  // проходит с запасом. С кривой платы FEE_CURVE_* (раздел 00) самая короткая
  // партия до банкротства — 48 ходов за столом вдвоём (p1 — 86), а самый
  // короткий пресет (40 своих ходов у каждого) — от 80 ходов за столом: порог
  // по-прежнему не задевает честные партии. Считаем ходы, а не события: интервал
  // событий хост может снизить до 1 хода, и 10 событий тогда стоили бы всего 10 ходов.
  const MIN_TURNS_FOR_POINTS = 40;
  // Срок решения контролёра: бросающий попал на компанию, которой единолично
  // владеет соперник (>50%), и ждёт от него цену выкупа. Онлайн контролёр мог
  // просто не отвечать (отошёл, закрыл вкладку) — ход стоял бы вечно. Через
  // столько мс бросающий может закрыть бросок стандартной платой за отказ по
  // тарифу (refuseRollAmount, не выше forcedPriceCap — controllerDeadlineFee)
  // самому контролёру — см. dividendFromRoll. Боты
  // назначают цену сразу (botStep), в хот-сите устройство передаётся контролёру.
  const CONTROLLER_DECISION_MS = 45000;
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
    // 6% за событие при репутации 0, 3.5% при 50, 1% при 100. Было 28/17/4% —
    // кредит был ловушкой: «держать кредит» давало 0% побед (BALANCE-REPORT.md, Б2).
    const ratePct = Math.round(clamp(6 - rep * 0.05, 1, 6) * 10) / 10;
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
  // Рента к оплате при попадании на чужой объект: «Дивидендный сезон» удваивает
  // и её. Пассивная рента владельцу (processRealEstate) берёт realEstateRent.
  // Одна формула и для списания, и для сумм на кнопках клиента.
  function realEstateRentDue(room, cityId) { return realEstateRent(room, cityId) * (room.dividendMultiplier || 1); }
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
      { key: "double_dividend", title: "Дивидендный сезон", desc: "Все дивиденды и рента до следующего события удваиваются." },
      { key: "tax", title: "Налоговая проверка", desc: "Каждый игрок платит банку 2% от своего текущего чистого капитала." },
      { key: "freeze", title: "Заморозка цен", desc: "До конца этого события цены не меняются." },
      { key: "buyback", title: "Принудительный выкуп", desc: "Банк выкупает по 10% у каждого владельца одной случайной компании по текущей цене." },
      { key: "extra_turn", title: "Дополнительный ход", desc: "Игрок, при котором наступило это событие, получает ещё один ход подряд." },
      { key: "audit", title: "Аудит", desc: "Каждый игрок с отрицательным балансом немедленно продаёт акции или объявляет банкротство." },
      { key: "double_dividend", title: "Дивидендный сезон", desc: "Все дивиденды и рента до следующего события удваиваются." },
      { key: "tax", title: "Налоговая проверка", desc: "Каждый игрок платит банку 2% от своего текущего чистого капитала." },
    ];
    specials.forEach((s) => deck.push({ type: "special", title: s.title, desc: s.desc, key: s.key }));
    return deck;
  }

  // ---------------------------------------------------------------------
  // Сценарии рынка (settings.scenario). Сценарий накладывается на обычную
  // партию при старте (applyScenario): стартовые цены и долгосрочные тренды
  // (start), своя добавка к колоде новостей (deck), уклон тренда отраслей на
  // отрезке событий (bias: drift за событие к обычному блужданию) и сценарные
  // новости, которые разыгрываются на заданном событии вдобавок к карте колоды
  // (script: {event, card} или {event, warn} — слух на событие раньше).
  // Победа — как обычно: самый богатый к концу лимита (turnsPerPlayer своих
  // ходов) или последний неразорившийся. free:false — сценарий продаётся
  // (server/products.js, unlocks.scenarios); без магазина открыты все.
  // Числа подобраны так, чтобы сценарные события попадали в партию и вдвоём:
  // 40 своих ходов при 2 игроках — 20 событий.
  // ---------------------------------------------------------------------
  const SCENARIOS = [
    { id: "dotcom", title: "Пузырь доткомов", year: "2000", free: true, turnsPerPlayer: 40,
      intro: "Интернет-компании дорожают каждый день. Все знают, что пузырь лопнет, — вопрос когда.",
      goal: "Заработайте на росте и успейте выйти из интернета и технологий до краха.",
      start: { "Технологии": 1.5, "Интернет и медиа": 1.6 },
      bias: [
        { sector: "Технологии", from: 1, to: 5, drift: 0.03 }, { sector: "Интернет и медиа", from: 1, to: 5, drift: 0.04 },
        { sector: "Технологии", from: 7, to: 12, drift: -0.03 }, { sector: "Интернет и медиа", from: 7, to: 12, drift: -0.04 },
      ],
      deck: [
        { type: "sector", sector: "Интернет и медиа", title: "IPO стартапа на пике ажиотажа", percent: 14 },
        { type: "sector", sector: "Технологии", title: "Новая интернет-мания", percent: 12 },
        { type: "sector", sector: "Интернет и медиа", title: "Стартап не нашёл модель дохода", percent: -12 },
      ],
      script: [
        { event: 5, warn: "Аналитики предупреждают: оценки интернет-компаний оторвались от прибыли." },
        { event: 6, card: { type: "sector", sector: "Интернет и медиа", title: "Лопнул пузырь доткомов", percent: -35 } },
        { event: 6, card: { type: "sector", sector: "Технологии", title: "Распродажа техакций", percent: -25 } },
        { event: 9, card: { type: "global", title: "Рецессия после краха", percent: -8 } },
        { event: 12, card: { type: "sector", sector: "Потребительские товары", title: "Деньги уходят в «старую экономику»", percent: 12 } },
      ] },
    { id: "crisis2008", title: "Кризис 2008", year: "2008", free: false, turnsPerPlayer: 40,
      intro: "Банки на пике прибылей, но ипотечный рынок трещит по швам.",
      goal: "Переживите обвал — и купите дёшево на дне.",
      start: { "Финансы и сырьё": 1.3, "Промышленность и транспорт": 1.1 },
      bias: [
        { sector: "Финансы и сырьё", from: 3, to: 9, drift: -0.03 },
        { all: true, from: 10, to: 16, drift: 0.02 },
      ],
      deck: [
        { type: "sector", sector: "Финансы и сырьё", title: "Ипотечные бумаги дешевеют", percent: -10 },
        { type: "global", title: "Банки сокращают кредиты", percent: -6 },
      ],
      script: [
        { event: 4, warn: "Ипотечные облигации дешевеют, банки сокращают кредиты." },
        { event: 5, card: { type: "sector", sector: "Финансы и сырьё", title: "Банкротство инвестбанка", percent: -30 } },
        { event: 6, card: { type: "global", title: "Паника на рынках", percent: -20 } },
        { event: 9, card: { type: "global", title: "Спасательный пакет правительства", percent: 12 } },
        { event: 9, card: { type: "sector", sector: "Финансы и сырьё", title: "Банки получили помощь государства", percent: 15 } },
        { event: 12, card: { type: "global", title: "Ставка у нуля — рынок оживает", percent: 8 } },
      ] },
    { id: "rumarket", title: "Российский рынок", year: "2024", free: false, turnsPerPlayer: 40,
      intro: "Ставка ЦБ, дивиденды и курс рубля — рынок живёт новостями.",
      goal: "Ловите дивидендные истории и не попадайте под удары по отдельным компаниям.",
      start: { YDEX: 1.2, SBER: 1.1, GAZP: 0.9 },
      bias: [],
      deck: [
        { type: "company", ticker: "VKCO", title: "VK запустил новый сервис", percent: 15 },
        { type: "company", ticker: "MTSS", title: "МТС повысила дивиденды", percent: 10 },
        { type: "company", ticker: "MGNT", title: "Магнит закрывает магазины", percent: -12 },
        { type: "global", title: "Новый пакет санкций", percent: -8 },
        { type: "global", title: "Ставка ЦБ снижена", percent: 8 },
      ],
      script: [
        { event: 3, card: { type: "company", ticker: "SBER", title: "Рекордные дивиденды Сбербанка", percent: 20 } },
        { event: 4, warn: "Инфляция ускоряется — ЦБ готов поднять ставку." },
        { event: 5, card: { type: "global", title: "Ключевая ставка — 21%", percent: -10 } },
        { event: 7, card: { type: "sector", sector: "Потребительские товары", title: "Девальвация рубля: импорт дорожает", percent: -12 } },
        { event: 7, card: { type: "sector", sector: "Финансы и сырьё", title: "Девальвация рубля: экспортёры в плюсе", percent: 12 } },
        { event: 9, card: { type: "company", ticker: "AFLT", title: "Ограничения на авиаперевозки", percent: -25 } },
        { event: 11, card: { type: "company", ticker: "YDEX", title: "Редомициляция завершена", percent: 25 } },
        { event: 13, card: { type: "company", ticker: "GAZP", title: "Газпром отменил дивиденды", percent: -20 } },
      ] },
    { id: "commodity", title: "Сырьевой суперцикл", year: "2007", free: false, turnsPerPlayer: 40,
      intro: "Сырьё дорожает год за годом — кажется, что так будет всегда.",
      goal: "Поймайте суперцикл и продайте сырьё до разворота.",
      start: { "Финансы и сырьё": 0.9 },
      bias: [
        { sector: "Финансы и сырьё", from: 1, to: 9, drift: 0.035 },
        { sector: "Промышленность и транспорт", from: 3, to: 9, drift: -0.02 },
        { sector: "Финансы и сырьё", from: 11, to: 16, drift: -0.04 },
      ],
      deck: [
        { type: "sector", sector: "Финансы и сырьё", title: "Спрос на металлы растёт", percent: 12 },
        { type: "sector", sector: "Промышленность и транспорт", title: "Дорогое топливо бьёт по перевозчикам", percent: -10 },
      ],
      script: [
        { event: 4, card: { type: "sector", sector: "Финансы и сырьё", title: "Нефть по $150", percent: 20 } },
        { event: 5, card: { type: "sector", sector: "Промышленность и транспорт", title: "Топливо дорожает — перевозчики в минусе", percent: -15 } },
        { event: 7, card: { type: "company", ticker: "GAZP", title: "Новый экспортный контракт", percent: 25 } },
        { event: 10, warn: "Спрос в Китае замедляется, склады сырья переполнены." },
        { event: 11, card: { type: "sector", sector: "Финансы и сырьё", title: "Коллапс сырьевых цен", percent: -30 } },
        { event: 12, card: { type: "sector", sector: "Промышленность и транспорт", title: "Дешёвое топливо", percent: 15 } },
      ] },
  ];
  function scenarioById(id) { return SCENARIOS.find((x) => x.id === id) || null; }
  // Публичное описание для клиента (без сценарных новостей — они сюрприз).
  function scenarioInfo(sc) {
    return sc ? { id: sc.id, title: sc.title, year: sc.year, free: !!sc.free, turnsPerPlayer: sc.turnsPerPlayer, intro: sc.intro, goal: sc.goal } : null;
  }
  // Применить сценарий из настроек к комнате один раз, перед стартом партии
  // (из applyGameLength): цены и тренды, колода, длительность.
  function applyScenario(room) {
    if (!room || room.tutorial || room.scenario || !room.settings) return;
    const sc = scenarioById(room.settings.scenario);
    if (!sc) return;
    const multOf = (c) => {
      const st = sc.start || {};
      return st[c.ticker] != null ? st[c.ticker] : st[c.sector] != null ? st[c.sector] : 1;
    };
    COMPANIES.forEach((c) => {
      const comp = room.companies[c.ticker];
      if (!comp) return;
      const m = multOf(c);
      comp.price = TIER_PRICE[c.tier] * m;
      comp.prevPrice = comp.price;
      comp.trendFactor = m; // обычный возврат к тренду тянет к сценарной цене, а не к цене тира
      comp.priceHistory = [{ t: 0, p: Math.round(comp.price) }];
    });
    room.deckData = buildDeck().concat((sc.deck || []).map((c) => Object.assign({}, c)));
    room.deckOrder = shuffle(room.deckData.map((_, i) => i));
    room.deckPos = 0;
    room.settings.maxTurnsPerPlayer = sc.turnsPerPlayer;
    room.scenario = { id: sc.id };
    addLog(room, `🎬 Сценарий «${sc.title}»: ${sc.intro} Цель: ${sc.goal}`, "header");
  }
  // Сценарные новости и слухи на этом событии (вызывается из marketEvent).
  function runScenarioScript(room) {
    const sc = room.scenario && scenarioById(room.scenario.id);
    if (!sc) return;
    (sc.script || []).filter((e) => e.event === room.eventCount).forEach((e) => {
      if (e.warn) addLog(room, `📌 Слухи: ${e.warn}`, "news");
      if (e.card) applyNewsCard(room, e.card, "Сценарий");
    });
  }
  // Уклон долгосрочного тренда компании на этом событии по сценарию.
  function scenarioDrift(room, c) {
    const sc = room.scenario && scenarioById(room.scenario.id);
    if (!sc) return 0;
    const ev = room.eventCount;
    return (sc.bias || []).reduce((sum, b) =>
      sum + (ev >= b.from && ev <= b.to && (b.all || b.sector === c.sector || b.ticker === c.ticker) ? b.drift : 0), 0);
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
  // Число со словом в нужной форме: plural(53, "раунд", "раунда", "раундов") → «53 раунда».
  // Раунды из длительности в ходах бывают любыми (⌈70 × 3 / 4⌉ = 53), «раундов» не всегда верно.
  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    const word = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
    return `${n} ${word}`;
  }

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
      // Число раундов, после которого побеждает лидер по капиталу; null = до
      // банкротства всех соперников. Новая комната задаёт длительность в своих
      // ходах на игрока (settings.maxTurnsPerPlayer), раунды из неё считаются при
      // старте партии (applyGameLength), поэтому в лобби здесь null. Комнаты без
      // maxTurnsPerPlayer (rooms.json, старый клиент через setMaxRounds) живут
      // по maxRounds, как раньше.
      maxRounds: null,
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
      // Для разбора партии (analyzeGame): решения игроков, капитал после каждого
      // события и суммы платежей. Клиентам в состоянии не уходят.
      journal: [],
      nwHist: {},
      pstats: {},
      createdAt: Date.now(),
      kickVote: null, // {targetId, initiatorId, startedAt, voters:{playerId:true}}
      reactions: [], // {id, playerId, emoji, ts} — короткоживущие реакции за столом, чистятся по TTL на клиенте
      nextReactionId: 1,
      settings: { // Настройки комнаты (изменяемые хостом в лобби)
        startingCash: STARTING_CASH,
        turnSalary: TURN_SALARY,
        eventIntervalTurns: EVENT_INTERVAL_TURNS,
        // A, B, C. Было 20/15/10: партия без лимита на 4 игроков тянулась ≈200
        // событий, а лидер середины выигрывал ≈82%. С 60/45/30 и починенным ботом
        // (А5) замерено ≈150 событий и ≈60% — камбэки снова бывают
        // (BALANCE-REPORT.md, раздел 0, Б4; без А5 эту плату не вводить).
        // Это базовая ставка: на долю держателей она умножается по кривой
        // FEE_CURVE_* (holdersFeeFactor), подобранной под эти 60/45/30 (раздел 00).
        tierForcedPaymentPct: [60, 45, 30],
        // Длительность партии в своих ходах у каждого: 0 — без лимита, только до
        // банкротства; по умолчанию «до банкротства» со страховкой (см.
        // DEFAULT_MAX_TURNS_PER_PLAYER). Нет ключа — старая комната, лимит в maxRounds.
        maxTurnsPerPlayer: DEFAULT_MAX_TURNS_PER_PLAYER,
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

  // Журнал решений для разбора партии (analyzeGame): покупки, отказы, продажи,
  // сделки, города. k — вид записи, ev/r — событие и раунд. Учебная партия не пишет.
  const JOURNAL_MAX = 3000;
  function jr(room, pid, k, data) {
    if (room.tutorial) return;
    if (!Array.isArray(room.journal)) room.journal = [];
    room.journal.push(Object.assign({ p: pid, k, ev: room.eventCount || 0, r: room.roundNumber || 1 }, data));
    if (room.journal.length > JOURNAL_MAX) room.journal.shift();
  }
  // Суммы платежей игрока за партию: плата за отказ, выкуп, рента, проценты.
  function stat(room, pid, key, amount, sub) {
    if (room.tutorial || !(amount > 0)) return;
    if (!room.pstats || typeof room.pstats !== "object") room.pstats = {};
    const st = room.pstats[pid] || (room.pstats[pid] = {});
    st[key] = Math.round((st[key] || 0) + amount);
    if (sub) {
      const m = st[key + "By"] || (st[key + "By"] = {});
      m[sub] = Math.round((m[sub] || 0) + amount);
    }
  }
  // Капитал каждого игрока после события — график в разборе партии.
  function recordNetWorths(room) {
    if (room.tutorial) return;
    if (!room.nwHist || typeof room.nwHist !== "object") room.nwHist = {};
    room.players.forEach((p) => {
      const h = room.nwHist[p.id] || (room.nwHist[p.id] = []);
      if (p.bankrupt && h.length && h[h.length - 1][1] <= 0) return;
      h.push([room.eventCount || 0, Math.round(netWorth(room, p))]);
      if (h.length > 400) h.shift();
    });
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
  // «Эффективная доля» держателей (в долях: 0.4 = 40%), на которую умножается
  // ставка тира в плате за отказ (refuseRollAmount) и в справедливой цене выкупа
  // (forcedFairPrice); pct — фактическая доля держателей в процентах (0..100).
  // Кривая — FEE_CURVE_K / FEE_CURVE_P / FEE_CURVE_N_EXP / FEE_CURVE_N_MAX (см.
  // выше). При K = 0 и N_EXP = 0 возвращает ровно pct / 100 — без лишних операций
  // с плавающей точкой, чтобы суммы совпадали с правилами до кривой байт в байт.
  function holdersFeeFactor(room, pct) {
    const x = pct / 100;
    let f = x;
    if (FEE_CURVE_K && x > 0) f = x * (1 + FEE_CURVE_K * Math.pow(x, FEE_CURVE_P));
    if (FEE_CURVE_N_EXP) f *= Math.pow(4 / Math.min(FEE_CURVE_N_MAX, Math.max(1, activePlayers(room).length)), FEE_CURVE_N_EXP);
    return f;
  }
  // «Справедливая» цена выкупа доли контролёра: цена × ставка тира × эффективная
  // доля. Одна формула для потолка (forcedPriceCap), порога завышения
  // (setForcedPrice), цены бота (botStep) и подсказки клиенту
  // (pendingRollMeta.fairPrice) — плата за отказ и цена выкупа идут по одной кривой.
  function forcedFairPrice(room, ticker, heldPct) {
    return room.companies[ticker].price * getForcedPaymentPct(room, companyByTicker(ticker).tier) * holdersFeeFactor(room, heldPct);
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
  // Мера по капиталу: доля netWorth в пределах; "company" — та же формула ×MEASURE_SCALE.
  function nwMeasureCost(room, p, share, lo, hi) {
    if (MEASURE_COST_MODE === "cooldown") return 0;
    const k = MEASURE_COST_MODE === "company" ? MEASURE_SCALE : 1;
    return clamp(Math.round(netWorth(room, p) * share * k), Math.round(lo * k), Math.round(hi * k));
  }
  function espionageCost(room, p) { return nwMeasureCost(room, p, 0.05, 6000, 45000); }
  // ticker — цель (режим "company": 5% её цены); без него — для самой дорогой.
  function negativeInfoCost(room, p, ticker) {
    if (MEASURE_COST_MODE === "company") {
      const price = ticker && room.companies[ticker] ? room.companies[ticker].price : Math.max(...COMPANIES.map((c) => room.companies[c.ticker].price));
      return Math.max(1000, Math.round(price * 0.05));
    }
    return nwMeasureCost(room, p, 0.06, 8000, 55000);
  }
  function prCampaignCost(room, ticker) {
    if (MEASURE_COST_MODE === "cooldown") return 0;
    return room.companies[ticker].price * (MEASURE_COST_MODE === "company" ? 0.025 : 0.05);
  }
  function insiderPeekCost(room, p) { return nwMeasureCost(room, p, 0.03, 4000, 28000); }
  // Режим "cooldown": сколько событий ещё ждать до меры key (0 — можно).
  function measureCooldownLeft(room, p, key) {
    if (MEASURE_COST_MODE !== "cooldown") return 0;
    const last = p.measureUsed && p.measureUsed[key];
    return last == null ? 0 : Math.max(0, last + MEASURE_COOLDOWN - (room.eventCount || 0));
  }
  function measureCooldownError(room, p, key) {
    const left = measureCooldownLeft(room, p, key);
    return left ? `Мера будет доступна через ${plural(left, "событие", "события", "событий")}.` : null;
  }
  function noteMeasure(room, p, key) {
    if (MEASURE_COST_MODE !== "cooldown") return;
    (p.measureUsed || (p.measureUsed = {}))[key] = room.eventCount || 0;
  }
  function shortDepositCost(room, p) { return clamp(Math.round(netWorth(room, p) * 0.04), 4000, 32000); }
  function discreditCost(room, p, target) {
    const targetRep = target.reputation == null ? REPUTATION_START : target.reputation;
    if (MEASURE_COST_MODE === "cooldown") return 0;
    const k = MEASURE_COST_MODE === "company" ? MEASURE_SCALE : 1;
    return clamp(Math.round((netWorth(room, p) * 0.05 + targetRep * 250) * k), Math.round(6000 * k), Math.round(80000 * k));
  }
  function personalPrCostFor(room, p) {
    if (MEASURE_COST_MODE === "cooldown") return 0;
    const k = MEASURE_COST_MODE === "company" ? MEASURE_SCALE : 1;
    const uses = p.personalPrCount || 0;
    return Math.round(Math.max(5000 + 3000 * uses, netWorth(room, p) * 0.03) * k);
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
    // Поглощённая при слиянии компания вне рынка: её $0 не должен «оживать»
    // до пола тира от фонового шума, кубика волатильности или карт.
    if (!c || c.merged) return;
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
  // Поглощённая компания помечается merged: она уходит из списка компаний для
  // клиента, на её клетке бросок не останавливается, цена больше не меняется.
  function ctrlMergeCompanies(room, playerId, targetTicker, absorbTickers) {
    // Слияние задаёт цену напрямую (в обход applyPriceDelta), поэтому при
    // заморозке цен запрещено, как и другие спецдействия пакета.
    const err = requireOwnTurn(room, playerId, { blockFrozen: true });
    if (err) return { error: err };
    const p = room.players.find((x) => x.id === playerId);
    if (!p || p.bankrupt) return { error: "Недоступно." };
    if (room.lastMergeEvent === room.eventCount) return { error: "Слияние компаний доступно раз в событие." };

    const target = room.companies[targetTicker];
    if (!target) return { error: "Целевая компания не найдена." };
    if ((p.holdings[targetTicker] || 0) < 100 || !target.fullyOwned) return { error: "Целевая компания должна быть полностью под вашим контролем (100%)." };

    if (!Array.isArray(absorbTickers) || absorbTickers.length === 0) return { error: "Нужно указать хотя бы одну компанию для поглощения." };
    // Повтор тикера в списке не должен складывать его цену дважды.
    absorbTickers = [...new Set(absorbTickers)];

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
      room.companies[ticker].merged = true;
    });
    // Хвосты по исчезнувшим тикерам: шорты закрываются с возвратом залога
    // (ставить больше не на что), сделки снимаются, а бросок на такую клетку
    // считается отыгранным — ход можно завершить.
    room.shorts = room.shorts.filter((sh) => {
      if (!absorbTickers.includes(sh.ticker)) return true;
      const owner = room.players.find((x) => x.id === sh.playerId);
      if (owner) {
        owner.cash += sh.deposit;
        addLog(room, `↩️ Шорт ${owner.name} по ${sh.ticker} закрыт из-за слияния — залог ${fmt(sh.deposit)} возвращён.`, "short");
      }
      return false;
    });
    room.pendingTrades = room.pendingTrades.filter((t) => !absorbTickers.includes(t.ticker) && !absorbTickers.includes(t.wantTicker));
    if (room.pendingRoll && absorbTickers.includes(room.pendingRoll.ticker)) {
      room.pendingRoll = null;
      room.pendingForcedPrice = null;
    }

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

  // Игрок выбыл (банкротство или исключение голосованием). Подсмотренная им
  // карта инсайда больше не блокирует инсайд остальным. Если он выбыл посреди
  // собственного хода (wasCurrent — вычисляется ДО пометки bankrupt), его бросок
  // и незавершённые выплаты сгорают, а ход ровно один раз переходит к следующему
  // активному игроку с чистым rolledThisTurn — иначе тому доставался
  // «Завершить ход» вместо «Бросить кубики». Счётчик ходов раунда не трогаем.
  function onPlayerEliminated(room, playerId, wasCurrent) {
    if (room.pendingInsider && room.pendingInsider.playerId === playerId) room.pendingInsider = null;
    dropStaleKickVote(room);
    if (!wasCurrent || room.phase !== "roll") return;
    room.rolledThisTurn = false;
    room.pendingRoll = null;
    room.pendingForcedPrice = null;
    // Ставим указатель на место выбывшего: currentPlayerId пропустит его и
    // найдёт следующего активного — туда указатель и переносим.
    const idx = room.turnOrder.indexOf(playerId);
    if (idx >= 0) room.turnIndex = idx;
    const next = currentPlayerId(room);
    if (next != null) room.turnIndex = room.turnOrder.indexOf(next);
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
      // Как в declareBankruptcy: банкрот не должен принимать «подарочные» сделки —
      // доли застряли бы у выбывшего и навсегда пропали бы из оборота банка.
      room.pendingTrades = room.pendingTrades.filter((t) => t.fromId !== player.id && t.toId !== player.id);
      dropStaleKickVote(room);
      adjustReputation(room, player, -30, "банкротство");
      addLog(room, `💀 ${player.name} не может покрыть обязательства даже после продажи всех активов — объявлен банкротом.`, "bankrupt");
    }
  }

  // Сколько ходов сыграл стол (для MIN_TURNS_FOR_POINTS): полные интервалы до
  // каждого биржевого события + ходы текущего интервала (room.turn после события
  // снова 1). Интервал меняется только в лобби, поэтому счёт точен и для комнат,
  // поднятых из rooms.json, — отдельный счётчик в комнате не нужен.
  function turnsPlayed(room) {
    const roundLen = room.settings?.eventIntervalTurns || EVENT_INTERVAL_TURNS;
    return (room.eventCount || 0) * roundLen + Math.max(0, (room.turn || 1) - 1);
  }

  // Лимит партии в своих ходах на игрока → лимит в раундах (room.maxRounds):
  // раунд = interval ходов за столом, поэтому раундов = ⌈ходов × игроков / interval⌉
  // (2 игрока, 150 ходов, событие раз в 4 хода — 75 раундов). null — без лимита.
  function roundsForTurnsPerPlayer(turnsPerPlayer, players, interval) {
    const t = Number(turnsPerPlayer);
    if (!Number.isFinite(t) || t <= 0) return null;
    const n = Math.max(1, Math.round(Number(players)) || 1);
    const len = Math.max(1, Math.round(Number(interval)) || EVENT_INTERVAL_TURNS);
    return Math.max(1, Math.ceil((t * n) / len));
  }
  // Пересчёт room.maxRounds из settings.maxTurnsPerPlayer по числу активных
  // игроков — в startGame, newGameKeepPlayers и офлайн-старте (index.html).
  // Комната без maxTurnsPerPlayer (rooms.json, лимит через setMaxRounds) остаётся
  // при своём maxRounds. Учебную партию (room.tutorial) не трогаем.
  function applyGameLength(room) {
    if (!room || room.tutorial) return room ? room.maxRounds || null : null;
    applyScenario(room); // сценарий задаёт свою длительность — до расчёта раундов
    const t = room.settings ? room.settings.maxTurnsPerPlayer : undefined;
    if (t == null || !Number.isFinite(Number(t))) return room.maxRounds || null;
    room.maxRounds = roundsForTurnsPerPlayer(t, activePlayers(room).length, room.settings.eventIntervalTurns || EVENT_INTERVAL_TURNS);
    return room.maxRounds;
  }

  // Кто богаче: при равном капитале (до доллара) — у кого больше наличных.
  // Раньше ничью выигрывал тот, кто сидел раньше.
  function richer(room, a, b) {
    const d = netWorth(room, a) - netWorth(room, b);
    return d > 0.5 || (Math.abs(d) <= 0.5 && a.cash > b.cash);
  }

  // opts.noPoints — победа досталась исключением последнего соперника
  // голосованием: партия заканчивается, но очки рейтинга за неё не начисляются.
  function checkEndGame(room, opts) {
    opts = opts || {};
    if (room.phase === "ended") return;
    const active = activePlayers(room);
    let winner = null;
    let byRoundLimit = false;
    let allBankrupt = false;
    if (room.players.length > 1 && active.length === 1) {
      winner = active[0];
    } else if (room.maxRounds && room.roundNumber > room.maxRounds && active.length >= 1) {
      winner = active.reduce((best, p) => (richer(room, p, best) ? p : best), active[0]);
      byRoundLimit = true;
    } else if (room.phase === "roll" && room.players.length > 0 && active.length === 0) {
      // Все оставшиеся разорились в одном событии: без этой ветки партия
      // зависала в фазе «roll» без текущего игрока и без итогов. Побеждает
      // самый богатый из выбывших, но очки за такую партию не начисляются.
      winner = room.players.reduce((best, p) => (richer(room, p, best) ? p : best), room.players[0]);
      opts = Object.assign({}, opts, { noPoints: true });
      allBankrupt = true;
    }
    if (winner) {
      room.phase = "ended";
      if (byRoundLimit) {
        const tpp = room.settings?.maxTurnsPerPlayer;
        const roundsText = plural(room.maxRounds, "раунд", "раунда", "раундов");
        const limitText = tpp > 0 ? `${plural(tpp, "ход", "хода", "ходов")} у каждого, ${roundsText}` : roundsText;
        addLog(room, `⏱️ Лимит партии (${limitText}) достигнут — победитель определяется по капиталу.`, "header");
      }
      // Очки — за победу начисляются пропорционально итоговому капиталу (сумме, с которой игрок выиграл).
      // Потолок — страховка от абсурдных сумм (например, бесконечного капитала).
      const won = Math.round(netWorth(room, winner));
      // Слишком короткая партия (MIN_TURNS_FOR_POINTS) очков не даёт — ни
      // победой последнего выжившего, ни по лимиту раундов.
      const turns = turnsPlayed(room);
      const tooShort = turns < MIN_TURNS_FOR_POINTS;
      // Почему очков нет — для экрана итогов и ленты (раньше любой ноль
      // объяснялся исключением голосованием, даже когда разорились все).
      const noPointsReason = allBankrupt ? "allBankrupt" : opts.noPoints ? "kick" : tooShort ? "short" : null;
      const pointsEarned = noPointsReason || !Number.isFinite(won) ? 0 : Math.min(MAX_POINTS_PER_GAME, Math.max(1, Math.round(won / 1000)));
      if (pointsEarned > 0) {
        winner.points = (winner.points || 0) + pointsEarned;
        // Сетевой слой (server.js) заберёт это один раз и допишет очки в персистентный аккаунт игрока.
        room.lastGamePointsAward = { playerId: winner.id, amount: pointsEarned };
      }
      // Итоговая таблица для экрана завершения игры — не одноразовая (в отличие
      // от lastGamePointsAward), остаётся в комнате до начала новой партии.
      room.gameResult = {
        winnerId: winner.id, winnerName: winner.name, netWorth: won, pointsEarned,
        noPointsReason, turnsPlayed: turns, minTurnsForPoints: MIN_TURNS_FOR_POINTS,
        ranking: room.players
          .map((p) => {
            // Состав капитала для экрана итогов (как в netWorth): наличные +
            // акции по текущей цене + недвижимость − долг банку.
            let stocks = 0;
            for (const t in p.holdings) stocks += ((p.holdings[t] || 0) / 100) * (room.companies[t] ? room.companies[t].price : 0);
            const realEstate = CITIES.reduce((sum, ct) => sum + (room.realEstate[ct.id] && room.realEstate[ct.id].ownerId === p.id ? realEstatePrice(room, ct.id) : 0), 0);
            return {
              id: p.id, name: p.name, netWorth: Math.round(netWorth(room, p)), bankrupt: !!p.bankrupt, points: p.points || 0,
              cash: Math.round(p.cash), stocks: Math.round(stocks), realEstate: Math.round(realEstate), loan: p.loan ? Math.round(p.loan.principal) : 0,
            };
          })
          // Победитель всегда первый, за ним оставшиеся в игре, потом выбывшие;
          // внутри — по капиталу, при равном — по наличным (как richer). Иначе
          // победитель стоял вторым: при капиталах, равных после округления, или
          // ниже исключённого голосованием (наличные у того остаются).
          .sort((a, b) => (b.id === winner.id) - (a.id === winner.id) || a.bankrupt - b.bankrupt || b.netWorth - a.netWorth || b.cash - a.cash),
      };
      const noPointsText = noPointsReason === "short" ? `партия слишком короткая (сыграно ${turns} из ${MIN_TURNS_FOR_POINTS} ходов) — очки рейтинга не начисляются`
        : noPointsReason === "allBankrupt" ? "разорились все игроки — очки рейтинга не начисляются"
        : noPointsReason === "kick" ? "соперник исключён голосованием, очки рейтинга не начисляются"
        : "очки рейтинга не начисляются";
      addLog(room, `🏆 Игра окончена! Победитель: ${winner.name} с капиталом ${fmt(won)} — ${pointsEarned > 0 ? `очки рейтинга: +${pointsEarned} (всего ${winner.points})` : noPointsText}.`, "win");
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

  // Компании, которые ещё торгуются: поглощённые при слиянии (merged) из игры выходят.
  function liveCompanies(room) { return COMPANIES.filter((c) => !room.companies[c.ticker].merged); }

  // Розыгрыш карты новостей: карта колоды на событии или сценарная новость
  // (prefix «Сценарий» — в ленте «📌 Сценарий · …»). Карта точечной новости с ticker бьёт по
  // этой компании, без него — по случайной из живых.
  function applyNewsCard(room, card, prefix) {
    const pre = prefix ? prefix + " · " : "";
    if (card.type === "global") {
      COMPANIES.forEach((c) => { applyPriceDelta(room, c.ticker, card.percent); nudgeTrend(room, c.ticker, card.percent); });
      addLog(room, `${prefix ? "📌" : "📰"} ${pre}[Глобальная] ${card.title}: ${card.percent > 0 ? "+" : ""}${card.percent}% всем компаниям`, "news");
    } else if (card.type === "sector") {
      COMPANIES.filter((c) => c.sector === card.sector).forEach((c) => { applyPriceDelta(room, c.ticker, card.percent); nudgeTrend(room, c.ticker, card.percent); });
      addLog(room, `${prefix ? "📌" : "📰"} ${pre}[Отраслевая, ${card.sector}] ${card.title}: ${card.percent > 0 ? "+" : ""}${card.percent}%`, "news");
    } else if (card.type === "company") {
      const live = liveCompanies(room);
      const fixed = card.ticker ? live.find((x) => x.ticker === card.ticker) : null;
      if (card.ticker && !fixed) return; // компанию поглотили при слиянии — новость не о ком
      const c = fixed || live[Math.floor(Math.random() * live.length)];
      applyPriceDelta(room, c.ticker, card.percent);
      nudgeTrend(room, c.ticker, card.percent);
      if (card.skipDividend) room.companies[c.ticker].skipDividendUntil = room.eventCount + 1;
      addLog(room, `${prefix ? "📌" : "📰"} ${pre}[Точечная] ${c.name} (${c.ticker}) — ${card.title}: ${card.percent > 0 ? "+" : ""}${card.percent}%${card.skipDividend ? " (дивиденды пропущены на 1 ход)" : ""}`, "news");
    } else if (card.type === "special") {
      addLog(room, `🃏 ${pre}[Особая] ${card.title}: ${card.desc}`, "news");
      if (card.key === "freeze") {
        room.frozen = true;
      } else if (card.key === "buyback") {
        const live = liveCompanies(room);
        const c = live[Math.floor(Math.random() * live.length)];
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
          const amt = Math.max(0, netWorth(room, p)) * 0.02; // игроку в долгах налог не «доплачивается»
          p.cash -= amt;
          addLog(room, `${p.name} заплатил налог: ${fmt(amt)}.`, "tax");
          settleDebt(room, p);
        });
      }
    }
  }

  function marketEvent(room) {
    const eventBeforeThis = room.eventCount;
    room.eventCount++;
    room.roundNumber = (room.roundNumber || 1) + 1;
    room.dividendMultiplier = 1;
    // Страховка (endTurn уже решает это сам): событие не разыгрывает карту,
    // пока чей-то инсайд по ней не решён, — иначе блок инсайда показал бы
    // следующую карту, а «Переложить в конец» двинул бы невиданную.
    room.pendingInsider = null;
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

    // Сценарий (applyScenario): сценарные новости этого события и слухи — до
    // карты колоды, чтобы выпавшая «Заморозка цен» не отменила сценарный крах.
    runScenarioScript(room);
    applyNewsCard(room, card);

    // У каждой компании — свой фоновый долгосрочный тренд (trendFactor), который
    // блуждает независимо от разовых карт/кубика: часть компаний на дистанции
    // растут, часть падают, как на настоящем рынке. Смещение чуть выше нуля в
    // среднем (лёгкий бычий уклон рынка в целом), но аддитивно, а не умножением
    // на текущую цену — так не повторяется эффект систематического сноса к полу,
    // из-за которого раньше вводили плоскую коррекцию к единой цене тира.
    if (!room.frozen) {
      liveCompanies(room).forEach((c) => {
        const comp = room.companies[c.ticker];
        if (comp.trendFactor == null) comp.trendFactor = 1;
        const drift = -0.015 + Math.random() * 0.035 + scenarioDrift(room, c); // в среднем ~+0.25% за событие; сценарий добавляет уклон
        comp.trendFactor = clamp(comp.trendFactor + drift, 0.3, 4);
      });
    }

    // Мягкий возврат к тренду компании (а не к единой цене тира) — гасит только
    // избыточный шум отдельных бросков/карт, не отменяя ни сам тренд, ни эффект
    // крупных разовых событий/контрольных действий.
    if (!room.frozen) {
      liveCompanies(room).forEach((c) => {
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
    payHolderDividends(room);
    room.turn = 1;
    recordNetWorths(room);
  }

  // Дивиденды держателям (HOLDER_DIVIDEND_PCT): от банка, по пакетам, одной строкой в ленте.
  function payHolderDividends(room) {
    if (!(HOLDER_DIVIDEND_PCT > 0)) return;
    const parts = [];
    activePlayers(room).forEach((p) => {
      let sum = 0;
      for (const t in p.holdings) {
        const c = room.companies[t];
        if (!c || c.merged || !(p.holdings[t] > 0)) continue;
        if (c.skipDividendUntil && c.skipDividendUntil >= room.eventCount) continue;
        sum += c.price * (p.holdings[t] / 100) * HOLDER_DIVIDEND_PCT;
      }
      if (sum >= 1) { p.cash += sum; stat(room, p.id, "divIn", sum); parts.push(`${p.name} +${fmt(sum)}`); }
    });
    if (parts.length) addLog(room, `💵 Дивиденды держателям: ${parts.join(", ")}.`, "dividend");
  }

  function afterRollAction(room) {
    const roller = room.pendingRoll ? room.players.find((x) => x.id === room.pendingRoll.playerId) : null;
    room.pendingRoll = null;
    // Назначенная цена выкупа привязана к конкретному броску — если ход
    // завершился (оплачен, пропущен через альтернативный сценарий, или
    // конфискация снизила долю контролёра ниже 50% и путь оплаты сменился
    // на пропорциональный), не должна "утекать" в следующий бросок.
    room.pendingForcedPrice = null;
    // Бросавший (это всегда ходящий игрок) обанкротился на обязательной выплате
    // по броску — дивидендах, ренте или назначенной цене (settleDebt): ход сам
    // переходит к следующему, завершить его выбывший уже не сможет.
    if (roller && roller.bankrupt) onPlayerEliminated(room, roller.id, true);
    // Ход больше не завершается автоматически после одного действия по броску —
    // игрок теперь сам решает, когда закончить ход (endTurn), чтобы успеть
    // продать/обменять акции или воспользоваться спецдействиями до передачи хода.
    checkEndGame(room);
  }

  // Явное завершение хода текущим игроком. Раунд = eventIntervalTurns ходов за
  // столом (по умолчанию 4, не круг по столу); когда раунд завершён — наступает
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
    // Подсмотренная карта инсайда, судьбу которой игрок так и не решил, остаётся
    // наверху колоды (как при «Оставить»): иначе событие разыграло бы её, а
    // инсайд остался бы заблокирован для всех и показывал не ту карту.
    if (room.pendingInsider) {
      const peeker = room.players.find((x) => x.id === room.pendingInsider.playerId);
      addLog(room, `${peeker ? peeker.name : "?"} оставил карту наверху колоды.`, "control");
      room.pendingInsider = null;
    }
    // Следующего считаем от места того, кто реально завершает ход, а не от
    // room.turnIndex: тот мог указывать на выбывшего (currentPlayerId его
    // пропускает), и +1 снова попадал на того же игрока — двойной ход.
    const myIdx = room.turnOrder.indexOf(playerId);
    const nextIdx = (myIdx + 1) % Math.max(1, room.turnOrder.length);
    const roundLen = room.settings?.eventIntervalTurns || EVENT_INTERVAL_TURNS;
    room.turn++;
    if (room.turn > roundLen) {
      marketEvent(room);
      // Если игрок обанкротился на самом событии (налог, аудит, взыскание
      // кредита), дополнительный ход ему уже не нужен — очередь идёт дальше.
      if (room.extraTurnPending && p && !p.bankrupt) {
        room.extraTurnPending = false;
        room.turnIndex = myIdx;
        addLog(room, `🔁 ${p ? p.name : "?"} получил(а) дополнительный ход за это событие!`, "turn");
      } else {
        room.extraTurnPending = false;
        room.turnIndex = nextIdx;
        addLog(room, `${p ? p.name : "?"} завершил(а) ход. Ход переходит дальше.`, "turn");
      }
    } else {
      room.turnIndex = nextIdx;
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
      delete player.offlineSince;
      if (gender) player.gender = gender;
      if (avatar) player.avatar = avatar;
      if (initialPoints != null) player.points = initialPoints;
      if (equippedBoardSkin) player.equippedBoardSkin = equippedBoardSkin;
      addLog(room, `Игрок «${name}» переподключился.`, "player");
    } else {
      const startingCash = room.settings?.startingCash || STARTING_CASH;
      player = { id: room.nextPlayerId++, name, gender, avatar, points: initialPoints != null ? initialPoints : 0, equippedBoardSkin: equippedBoardSkin || "default", cash: startingCash, holdings: {}, costBasis: {}, bankrupt: false, connected: true, reputation: REPUTATION_START, loan: null, isBot: !!isBot };
      // Вошёл посреди партии: в лигу недели такая партия не идёт (server.js).
      if (room.phase === "roll") player.lateJoin = true;
      room.players.push(player);
      room.turnOrder.push(player.id);
      addLog(room, `${isBot ? "🤖 Бот" : "Игрок"} «${name}» присоединился со стартовым капиталом ${fmt(startingCash)}.`, "player");
    }
    // Хоста без сети в комнате ожидания заменяет вошедший. Посреди партии роль
    // хоста не переходит (см. setConnected), а если хост пропал надолго, новую
    // партию может начать любой игрок (hostAway, server.js handleNewGame).
    const host = room.players.find((x) => x.id === room.hostPlayerId);
    if (!host || (room.phase === "lobby" && !host.connected)) {
      room.hostPlayerId = player.id;
    }
    return { ok: true, player };
  }

  function setConnected(room, playerId, connected) {
    const p = room.players.find((x) => x.id === playerId);
    if (!p) return;
    p.connected = connected;
    if (connected) {
      delete p.offlineSince;
    } else {
      // С этого момента идёт пауза, после которой его можно исключить одним голосом.
      if (!p.offlineSince) p.offlineSince = Date.now();
      addLog(room, `Игрок «${p.name}» отключился.`, "player");
      // Только в комнате ожидания: посреди партии короткий обрыв у хоста
      // (обновил страницу) отдавал роль — а с ней и сброс партии — другому игроку.
      if (room.phase === "lobby" && room.hostPlayerId === playerId) {
        const next = room.players.find((x) => x.connected && !x.isBot && x.id !== playerId);
        room.hostPlayerId = next ? next.id : null;
        if (next) addLog(room, `«${next.name}» теперь хост комнаты.`, "player");
      }
    }
  }

  // Убирает игрока из комнаты ожидания совсем: в лобби у него ещё нет ни
  // активов, ни места в партии. Вернуться он может обычным входом (addPlayer
  // заведёт его заново). Хост, если уходит он, передаётся игроку в сети.
  function removeLobbyPlayer(room, p) {
    room.players = room.players.filter((x) => x.id !== p.id);
    room.turnOrder = room.turnOrder.filter((id) => id !== p.id);
    if (room.kickVote && (room.kickVote.targetId === p.id || room.kickVote.initiatorId === p.id)) room.kickVote = null;
    if (room.hostPlayerId === p.id || !room.players.some((x) => x.id === room.hostPlayerId)) {
      const next = room.players.find((x) => x.connected);
      room.hostPlayerId = next ? next.id : null;
      if (next) addLog(room, `«${next.name}» теперь хост комнаты.`, "player");
    }
  }

  // Игрок покинул лобби (кнопка «Покинуть комнату» или долго не в сети, см.
  // server.js) — раньше он оставался «призраком»: хост мог начать партию, и та
  // навсегда вставала на его ходу.
  function leaveLobby(room, playerId) {
    if (!room || room.phase !== "lobby") return { error: "Покинуть комнату так можно только до начала игры." };
    const p = room.players.find((x) => x.id === playerId);
    if (!p) return { error: "Недоступно." };
    addLog(room, `Игрок «${p.name}» покинул комнату.`, "player");
    removeLobbyPlayer(room, p);
    return { ok: true };
  }

  function startGame(room, playerId) {
    if (!room) return { error: "Комната не найдена." };
    if (room.phase !== "lobby") return { error: "Игра уже началась." };
    if (room.hostPlayerId !== playerId) return { error: "Начать игру может только хост комнаты." };
    // Кто не в сети к старту, в партию не попадает: его ход встал бы навсегда.
    // Боты (офлайн) всегда «в сети». Вернуться такой игрок может обычным входом.
    if (room.players.filter((p) => p.connected || p.isBot).length < 2) return { error: "Нужно минимум 2 игрока в сети." };
    room.players.filter((p) => !p.connected && !p.isBot).forEach((p) => {
      addLog(room, `Игрок «${p.name}» не в сети — в партию не попадает.`, "player");
      removeLobbyPlayer(room, p);
    });
    // Капитал выдаётся при входе в лобби, а хост мог поменять стартовый капитал
    // уже после этого — выравниваем всех по текущей настройке комнаты.
    const startingCash = room.settings?.startingCash || STARTING_CASH;
    room.players.forEach((p) => { p.cash = startingCash; });
    // Порядок ходов — случайный: раньше первым всегда ходил хост, а при 6+
    // игроках ранние места выигрывают заметно чаще (BALANCE-REPORT.md, А6).
    room.turnOrder = shuffle(room.turnOrder);
    room.turnIndex = 0;
    // Длительность в своих ходах у каждого → раунды по фактическому числу
    // игроков (тех, кто не в сети, уже убрали).
    applyGameLength(room);
    room.phase = "roll";
    addLog(room, "🚀 Хост начал игру.", "header");
    logTurnOrder(room);
    return { ok: true };
  }

  // Настройки комнаты от хоста (только в лобби). Значения приходят от клиента,
  // поэтому каждое приводим к числу в разумных пределах; неизвестные ключи
  // и нечисловые значения игнорируются.
  function updateRoomSettings(room, playerId, patch) {
    if (!room) return { error: "Комната не найдена." };
    if (room.phase !== "lobby") return { error: "Настройки можно менять только в лобби." };
    if (room.hostPlayerId !== playerId) return { error: "Изменить настройки может только хост." };
    if (!patch || typeof patch !== "object") return { error: "Некорректные настройки." };
    const num = (v, min, max) => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
    };
    const next = Object.assign({}, room.settings || {});
    const cash = num(patch.startingCash, 10000, 10000000);
    if (cash != null) next.startingCash = cash;
    const salary = num(patch.turnSalary, 0, 1000000);
    if (salary != null) next.turnSalary = salary;
    const interval = num(patch.eventIntervalTurns, 1, 10);
    if (interval != null) next.eventIntervalTurns = interval;
    if (Array.isArray(patch.tierForcedPaymentPct) && patch.tierForcedPaymentPct.length === 3) {
      // Не ниже 1%: при 0% цена выкупа выходила нулевой, движок её отклонял,
      // и бросок на чужую компанию нельзя было разрешить — партия зависала.
      const pcts = patch.tierForcedPaymentPct.map((v) => num(v, 1, 100));
      if (pcts.every((v) => v != null)) next.tierForcedPaymentPct = pcts;
    }
    // Длительность в своих ходах у каждого (0 — без лимита). Раунды из неё
    // посчитает startGame по числу игроков; прежний лимит в раундах (setMaxRounds)
    // больше не действует.
    const prevTurns = next.maxTurnsPerPlayer;
    const turns = patch.maxTurnsPerPlayer == null ? null : num(patch.maxTurnsPerPlayer, 0, MAX_TURNS_PER_PLAYER_LIMIT);
    if (turns != null) {
      next.maxTurnsPerPlayer = turns;
      room.maxRounds = null;
    }
    // Сценарий рынка: id из SCENARIOS или "" — классическая партия. Право
    // выбрать платный сценарий проверяет сервер (server.js) до вызова движка.
    let scenarioChanged = false;
    if (patch.scenario !== undefined) {
      const sid = patch.scenario ? String(patch.scenario) : "";
      if (sid && !scenarioById(sid)) return { error: "Неизвестный сценарий." };
      scenarioChanged = (next.scenario || "") !== sid;
      if (sid) next.scenario = sid; else delete next.scenario;
      // Длительность задаёт сценарий — сразу видна в лобби.
      const chosen = scenarioById(sid);
      if (chosen && scenarioChanged) { next.maxTurnsPerPlayer = chosen.turnsPerPlayer; room.maxRounds = null; }
    }
    // Сила ботов: "strong" — покупают на все свободные деньги и не упускают города.
    if (patch.botLevel !== undefined) {
      if (patch.botLevel === "strong") next.botLevel = "strong"; else delete next.botLevel;
    }
    room.settings = next;
    if (scenarioChanged && room.players.length) {
      const sc = scenarioById(next.scenario);
      addLog(room, sc ? `🎬 Хост выбрал сценарий «${sc.title}» (${plural(sc.turnsPerPlayer, "ход", "хода", "ходов")} у каждого).` : "🎬 Хост выбрал классическую партию.", "header");
    }
    if (turns != null && turns !== prevTurns && room.players.length) {
      const what = !turns ? "без лимита — до банкротства всех соперников"
        : turns === DEFAULT_MAX_TURNS_PER_PLAYER ? `до банкротства (обычно ≈100 ходов у каждого), но не дольше ${plural(turns, "хода", "ходов", "ходов")} у каждого`
        : `${plural(turns, "ход", "хода", "ходов")} у каждого, потом побеждает самый богатый`;
      addLog(room, `⚙️ Хост выбрал длительность партии: ${what}.`, "header");
    }
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
    // Старый клиент задаёт лимит в раундах — он и действует, длительность в
    // своих ходах (settings.maxTurnsPerPlayer) startGame больше не пересчитывает.
    if (room.settings) delete room.settings.maxTurnsPerPlayer;
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
  // Игрока в сети исключают не меньше чем двумя голосами — иначе в партии на
  // двоих соперника выкидывали одним кликом (и забирали очки за победу).
  // Игрока, который не в сети дольше OFFLINE_KICK_GRACE_MS (из-за него стоит
  // ход), и бота можно исключить и одним голосом инициатора. Только что
  // отключившийся (обновил страницу, сменил сеть, заблокировал экран) считается
  // игроком в сети — иначе его выкидывали одним кликом в первую же секунду.
  // Голосуют только люди в сети, ещё оставшиеся в игре: боты не голосуют
  // никогда — иначе в офлайне с ботами голосование не завершалось бы вовсе.
  const OFFLINE_KICK_GRACE_MS = 60000;
  function offlineLongEnough(p) {
    return !!p && p.connected === false && Date.now() - (p.offlineSince || 0) >= OFFLINE_KICK_GRACE_MS;
  }
  // Хост «ушёл»: его нет в комнате, он исключён или не в сети дольше той же
  // паузы — тогда начать новую партию до конца текущей может любой оставшийся
  // в игре (server.js handleNewGame).
  function hostAway(room) {
    const host = room.players.find((x) => x.id === room.hostPlayerId);
    return !host || !!host.kicked || offlineLongEnough(host);
  }
  function kickEligibleVoters(room, targetId) {
    return room.players.filter((p) => p.connected && !p.bankrupt && !p.isBot && p.id !== targetId);
  }
  function kickVotesNeeded(target, eligibleCount) {
    if (target.isBot || offlineLongEnough(target)) return 1;
    return Math.max(2, Math.floor(eligibleCount / 2) + 1); // строго больше половины, но не меньше двух
  }
  // Цель голосования выбыла сама (банкротство уже после его начала) — такое
  // голосование бессмысленно и только мешало бы начать новое.
  function dropStaleKickVote(room) {
    const kv = room.kickVote;
    if (!kv) return;
    const target = room.players.find((x) => x.id === kv.targetId);
    if (!target || target.bankrupt) room.kickVote = null;
  }
  function startKickVote(room, playerId, targetId) {
    if (!room) return { error: "Комната не найдена." };
    if (room.phase !== "roll") return { error: "Голосование за исключение доступно только во время партии." };
    dropStaleKickVote(room);
    const voter = room.players.find((x) => x.id === playerId);
    const target = room.players.find((x) => x.id === targetId);
    if (!voter || !voter.connected) return { error: "Недоступно." };
    // Банкрот — зритель: его голос всё равно не входит в подсчёт (resolveKickVote).
    if (voter.bankrupt) return { error: "Вы выбыли из игры и не участвуете в голосованиях." };
    if (targetId === playerId) return { error: "Нельзя голосовать за собственное исключение." };
    if (!target || target.bankrupt) return { error: "Этот игрок недоступен для исключения." };
    if (room.kickVote && room.kickVote.targetId === targetId) return { error: "Голосование за исключение этого игрока уже идёт." };
    // Новое голосование не перезаписывает чужое (раньше оно молча пропадало, а
    // цель могла так сорвать голосование против себя).
    if (room.kickVote) return { error: "Уже идёт другое голосование за исключение." };
    const eligibleCount = kickEligibleVoters(room, targetId).length;
    if (eligibleCount < kickVotesNeeded(target, eligibleCount)) {
      return { error: target.connected === false
        ? `«${target.name}» только что отключился — возможно, обновляет страницу. Если он не вернётся в течение минуты, исключить его можно будет одним голосом.`
        : "Игрока в сети исключают минимум двумя голосами «за» — сейчас столько голосующих нет. Если он отключится дольше чем на минуту, исключить его можно будет и одним голосом." };
    }
    room.kickVote = { targetId, initiatorId: playerId, startedAt: Date.now(), voters: { [playerId]: true } };
    addLog(room, `🗳️ ${voter.name} начал(а) голосование за исключение игрока «${target.name}».`, "kickvote");
    return resolveKickVote(room);
  }

  function voteKick(room, playerId, targetId, yes) {
    if (!room) return { error: "Комната не найдена." };
    dropStaleKickVote(room);
    const kv = room.kickVote;
    if (!kv || kv.targetId !== targetId) return { error: "Сейчас нет голосования за исключение этого игрока." };
    const voter = room.players.find((x) => x.id === playerId);
    if (!voter || !voter.connected) return { error: "Недоступно." };
    if (voter.bankrupt) return { error: "Вы выбыли из игры и не участвуете в голосованиях." };
    if (playerId === kv.targetId) return { error: "Нельзя голосовать за собственное исключение." };
    if (yes) kv.voters[playerId] = true; else delete kv.voters[playerId];
    return resolveKickVote(room);
  }

  function cancelKickVote(room, playerId) {
    if (!room) return { error: "Комната не найдена." };
    dropStaleKickVote(room);
    const kv = room.kickVote;
    if (!kv) return { error: "Сейчас нет активного голосования." };
    if (kv.initiatorId !== playerId) {
      // Инициатор вышел из сети или выбыл — отменить может любой оставшийся в
      // игре участник, кроме цели: новое голосование не начать, пока идёт это.
      const initiator = room.players.find((x) => x.id === kv.initiatorId);
      const p = room.players.find((x) => x.id === playerId);
      const initiatorGone = !initiator || !initiator.connected || initiator.bankrupt;
      if (!initiatorGone || !p || !p.connected || p.bankrupt || playerId === kv.targetId) return { error: "Отменить голосование может только тот, кто его начал." };
      room.kickVote = null;
      addLog(room, `Голосование за исключение отменено: ${p.name} (инициатор вне игры).`, "kickvote");
      return { ok: true };
    }
    room.kickVote = null;
    addLog(room, "Голосование за исключение отменено инициатором.", "kickvote");
    return { ok: true };
  }

  function resolveKickVote(room) {
    const kv = room.kickVote;
    if (!kv) return { ok: true };
    const target = room.players.find((x) => x.id === kv.targetId);
    if (!target || target.bankrupt) { room.kickVote = null; return { ok: true }; }
    const eligible = kickEligibleVoters(room, kv.targetId);
    const yesCount = eligible.filter((p) => kv.voters[p.id]).length;
    const needed = kickVotesNeeded(target, eligible.length);
    if (eligible.length > 0 && yesCount >= needed) {
      const wasCurrent = currentPlayerId(room) === target.id;
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
      onPlayerEliminated(room, target.id, wasCurrent);
      // Исключили последнего соперника — победа без очков рейтинга: иначе
      // исключение (в том числе соперника, у которого надолго пропала сеть)
      // было бы способом забрать очки, не доиграв партию.
      checkEndGame(room, { noPoints: true });
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

  function logTurnOrder(room) {
    const names = room.turnOrder.map((id) => (room.players.find((p) => p.id === id) || {}).name).filter(Boolean);
    if (names.length > 1) addLog(room, `Порядок ходов: ${names.join(" → ")}.`, "turn");
  }

  function newGameKeepPlayers(room) {
    // Исключённые голосованием в реванш не переходят. Не в сети — тоже: их ход
    // в новой партии встал бы сразу; вернувшись, они войдут обычным входом.
    const hostName = (room.players.find((p) => p.id === room.hostPlayerId) || {}).name;
    const prev = room.players.filter((p) => !p.kicked && (p.connected !== false || p.isBot)).map((p) => ({ name: p.name, gender: p.gender, avatar: p.avatar, avatarPhoto: p.avatarPhoto || null, points: p.points || 0, equippedBoardSkin: p.equippedBoardSkin || "default", isBot: !!p.isBot, connected: p.connected !== false }));
    const fresh = freshRoom(room.code);
    // Реванш — сразу к игре, без комнаты ожидания; если в сети меньше двоих —
    // в лобби, ждать соперников (одному партия не закончилась бы никогда).
    fresh.phase = prev.length >= 2 ? "roll" : "lobby";
    fresh.maxRounds = room.maxRounds || null; // лимит раундов — настройка комнаты, переживает реванш
    // и остальные настройки тоже; у старой комнаты без настроек нет и
    // длительности в ходах — её лимит остаётся в maxRounds
    if (room.settings) fresh.settings = JSON.parse(JSON.stringify(room.settings));
    else delete fresh.settings.maxTurnsPerPlayer;
    const startingCash = fresh.settings?.startingCash || STARTING_CASH;
    prev.forEach((pp) => {
      const p = { id: fresh.nextPlayerId++, name: pp.name, gender: pp.gender, avatar: pp.avatar, avatarPhoto: pp.avatarPhoto, points: pp.points, equippedBoardSkin: pp.equippedBoardSkin, cash: startingCash, holdings: {}, costBasis: {}, bankrupt: false, connected: pp.connected, reputation: REPUTATION_START, loan: null, isBot: !!pp.isBot };
      fresh.players.push(p);
      fresh.turnOrder.push(p.id);
      if (pp.name === hostName) fresh.hostPlayerId = p.id;
    });
    // Хост был не в сети и в реванш не попал — хостом становится первый человек.
    if (!fresh.hostPlayerId) fresh.hostPlayerId = (fresh.players.find((p) => !p.isBot) || fresh.players[0] || {}).id || null;
    // Порядок ходов — как в прошлой партии, но со сдвигом: начинает следующий.
    const prevOrder = room.turnOrder.map((id) => (room.players.find((p) => p.id === id) || {}).name);
    const seat = (id) => { const i = prevOrder.indexOf((fresh.players.find((p) => p.id === id) || {}).name); return i < 0 ? prevOrder.length : i; };
    fresh.turnOrder.sort((a, b) => seat(a) - seat(b));
    if (fresh.turnOrder.length > 1) fresh.turnOrder.push(fresh.turnOrder.shift());
    // Длительность в своих ходах — по числу игроков реванша (кто-то мог не
    // перейти); в лобби раунды посчитает startGame.
    if (fresh.phase === "roll") applyGameLength(fresh);
    else if (fresh.settings && fresh.settings.maxTurnsPerPlayer != null) fresh.maxRounds = null;
    addLog(fresh, "🆕 Новая партия началась.", "header");
    if (fresh.phase === "roll") logTurnOrder(fresh);
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
    // Клетки компаний, поглощённых при слиянии, пусты — на них не останавливаемся,
    // кубики перебрасываются (иначе там предлагалось купить акции за $0).
    let row, col, cell;
    // Обучение (офлайн, index.html/tutorial.js): заранее заданные броски —
    // room.scriptedRolls = {playerId: [[строка, столбец], ...]}, по одному на
    // бросок. Очередь кончилась, запись битая или клетка поглощена слиянием —
    // обычный случайный бросок. Онлайн это поле не ставится никогда.
    const queue = room.scriptedRolls && room.scriptedRolls[playerId];
    if (Array.isArray(queue) && queue.length) {
      const next = queue.shift();
      const r0 = Math.round(Number(next && next[0])), c0 = Math.round(Number(next && next[1]));
      if (r0 >= 1 && r0 <= 12 && c0 >= 1 && c0 <= 12) {
        const cell0 = BOARD[r0 - 1][c0 - 1];
        if (isRealEstateCell(cell0) || !(room.companies[cell0] && room.companies[cell0].merged)) { row = r0; col = c0; cell = cell0; }
      }
    }
    if (row == null) do {
      row = 1 + Math.floor(Math.random() * 12);
      col = 1 + Math.floor(Math.random() * 12);
      cell = BOARD[row - 1][col - 1];
    } while (!isRealEstateCell(cell) && room.companies[cell] && room.companies[cell].merged);
    const p = room.players.find((x) => x.id === playerId);
    const turnSalary = room.settings?.turnSalary ?? TURN_SALARY;
    p.cash += turnSalary;
    const salaryNote = ` (+${fmt(turnSalary)} зарплата)`;
    if (isRealEstateCell(cell)) {
      const cityId = cityIdFromCell(cell);
      room.pendingRoll = { playerId, row, col, ticker: null, realEstateId: cityId };
      addLog(room, `🎲 ${p.name}: бросок строка ${row}, столбец ${col} → недвижимость в г. ${cityById(cityId).name}.${salaryNote}`, "roll");
    } else {
      room.pendingRoll = { playerId, row, col, ticker: cell, realEstateId: null };
      // Компания под единоличным контролем соперника — с этого момента идёт срок
      // его решения о цене выкупа (ставит pendingRoll.controllerWaitSince).
      controllerWaitLeftMs(room, rollController(room, room.pendingRoll));
      addLog(room, `🎲 ${p.name}: бросок строка ${row}, столбец ${col} → ${companyByTicker(cell).name} (${cell}).${salaryNote}`, "roll");
    }
    return { ok: true };
  }

  // Стоимость покупки pct% по броску вместе с комиссией банка — одна формула для
  // buyFromRoll и botBuyPct. Раньше бот считал её другим выражением с плавающей
  // точкой: на границе он решал «хватает», движок отвечал «недостаточно наличных»,
  // и офлайн-насос ботов мог крутить одну и ту же неудачную покупку.
  function rollBuyCost(room, p, ticker, pct) {
    return room.companies[ticker].price * (pct / 100) * (1 + bankFeePct(p.reputation));
  }

  // Плата держателям при покупке на чужой компании (FEE_RULE): сумма — от той
  // же ставки, что и плата за отказ (refuseRollAmount), со скидкой за купленные %.
  // Карта «выплата не проводится» освобождает и от неё.
  function holdersFeeOnBuy(room, payer, ticker, pct) {
    const none = { amount: 0, owners: [], totalPct: 0 };
    const factor = FEE_RULE === "always" ? FEE_ALWAYS_MULT : FEE_RULE === "reduce" ? Math.max(0, 1 - pct * FEE_REDUCE_PER_PCT) : 0;
    if (!(factor > 0)) return none;
    const c = room.companies[ticker];
    if (c.skipDividendUntil && c.skipDividendUntil >= room.eventCount) return none;
    const owners = room.players.filter((o) => !o.bankrupt && o.id !== payer.id && (o.holdings[ticker] || 0) > 0);
    if (!owners.length) return none;
    const totalPct = owners.reduce((sum, o) => sum + o.holdings[ticker], 0);
    return { amount: Math.round(refuseRollAmount(room, ticker, totalPct) * factor), owners, totalPct };
  }
  function payHoldersFeeOnBuy(room, payer, ticker, fee) {
    if (!fee.amount) return;
    payer.cash -= fee.amount;
    fee.owners.forEach((o) => { const share = fee.amount * (o.holdings[ticker] / fee.totalPct); o.cash += share; stat(room, o.id, "feeIn", share); });
    stat(room, payer.id, "feeOut", fee.amount);
    addLog(room, `${payer.name} заплатил держателям ${ticker} ${fmt(fee.amount)} при покупке.`, "dividend");
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
    const owned = totalOwnedPct(room, ticker);
    if (owned + pct > 100) return { error: "У банка недостаточно свободных акций этой компании." };
    const feePct = bankFeePct(p.reputation);
    const cost = rollBuyCost(room, p, ticker, pct);
    const holdersFee = holdersFeeOnBuy(room, p, ticker, pct);
    if (p.cash < cost + holdersFee.amount) return { error: holdersFee.amount ? `Недостаточно наличных: покупка ${fmt(cost)} и плата держателям ${fmt(holdersFee.amount)}.` : "Недостаточно наличных." };
    p.cash -= cost;
    p.holdings[ticker] = (p.holdings[ticker] || 0) + pct;
    addCostBasis(p, ticker, pct, cost);
    jr(room, p.id, "buy", { t: ticker, pct, cost: Math.round(cost) });
    payHoldersFeeOnBuy(room, p, ticker, holdersFee);
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
  // нужен setForcedPrice/payForcedPrice; формула применяется, только если
  // контролёр не назначил цену за CONTROLLER_DECISION_MS (оплата по тарифу).
  // Что было у отказавшегося: цена компании, свободные % и сколько % он мог купить.
  function refuseInfo(room, p, ticker) {
    const free = Math.max(0, Math.floor(100 - totalOwnedPct(room, ticker)));
    const unit = rollBuyCost(room, p, ticker, 1);
    const afford = unit > 0 ? Math.max(0, Math.min(25, free, Math.floor(p.cash / unit))) : 0;
    return { t: ticker, px: Math.round(room.companies[ticker].price), free, afford };
  }
  function dividendFromRoll(room, playerId) {
    if (!room || room.phase !== "roll" || !room.pendingRoll) return { error: "Нет активного броска." };
    if (room.pendingRoll.playerId !== playerId) return { error: "Сейчас не ваш ход." };
    const ticker = room.pendingRoll.ticker;
    if (!ticker) return { error: "На этой клетке нет акций — там недвижимость." };
    const c = room.companies[ticker];
    const payer = room.players.find((x) => x.id === playerId);
    // Сначала детерминированные проверки, потом случайный пропуск: иначе отказ,
    // который упирался в «цену назначает контролёр», можно было слать повторно,
    // пока не выпадет пропуск дивидендов, и не платить вовсе.
    if (room.pendingForcedPrice) return { error: "Цена выкупа уже назначена — оплатите её." };
    const owners = room.players.filter((p) => !p.bankrupt && p.id !== payer.id && (p.holdings[ticker] || 0) > 0);
    const controller = owners.length === 1 && owners[0].holdings[ticker] > 50 ? owners[0] : null;
    const refuse = refuseInfo(room, payer, ticker);
    if (controller) {
      const waitLeft = controllerWaitLeftMs(room, controller);
      if (waitLeft > 0) return { error: `${controller.name} полностью контролирует ${ticker} и должен(-на) сам(а) назначить цену выкупа. Если цены не будет ещё ${Math.ceil(waitLeft / 1000)} с — можно будет оплатить по тарифу.` };
      // Срок решения контролёра вышел (CONTROLLER_DECISION_MS), цены нет — ход
      // не стоит вечно: бросающий платит стандартную плату за отказ (та же
      // формула refuseRollAmount, что ниже для миноритариев) самому контролёру.
      // Без случайного пропуска и карты «выплата не проводится»: иначе ожидание
      // стало бы для бросающего лотереей, а молчание контролёра — выгодным.
      // Сумма — не выше потолка цены выкупа (controllerDeadlineFee).
      const heldPct = controller.holdings[ticker];
      const amount = controllerDeadlineFee(room, ticker, heldPct);
      const capped = amount < refuseRollAmount(room, ticker, heldPct);
      const ratePct = getForcedPaymentPct(room, companyByTicker(ticker).tier);
      payer.cash -= amount;
      controller.cash += amount;
      jr(room, payer.id, "refuse", Object.assign(refuse, { paid: Math.round(amount) }));
      stat(room, payer.id, "feeOut", amount);
      stat(room, controller.id, "feeIn", amount);
      addLog(room, `⏱️ ${controller.name} не назначил(а) цену выкупа ${ticker} за ${Math.round(CONTROLLER_DECISION_MS / 1000)} с — ${payer.name} заплатил(а) по тарифу (ставка класса ${(ratePct * 100).toFixed(0)}%): ${fmt(amount)} контролёру${capped ? " (ограничено потолком цены выкупа)" : ""}.`, "dividend");
      settleDebt(room, payer);
      afterRollAction(room);
      return { ok: true };
    }
    if (c.skipDividendUntil && c.skipDividendUntil >= room.eventCount) {
      jr(room, payer.id, "refuse", Object.assign(refuse, { paid: 0 }));
      addLog(room, `По ${ticker} выплата временно не проводится (эффект карты новостей).`, "dividend");
      afterRollAction(room);
      return { ok: true };
    }
    const tier = companyByTicker(ticker).tier;
    // Дифференциация дивидендов: малые компании (C) чаще пропускают выплаты.
    // В обучении выплата не пропускается — шаг про плату за отказ должен показать списание.
    const skipChance = room.tutorial ? 0 : (TIER_DIVIDEND_SKIP_CHANCE[tier] || 0.12);
    if (Math.random() < skipChance) {
      jr(room, payer.id, "refuse", Object.assign(refuse, { paid: 0 }));
      addLog(room, `По ${ticker} (тир ${tier}) дивиденды пропущены в этом ходе.`, "dividend");
      afterRollAction(room);
      return { ok: true };
    }
    if (owners.length === 0) {
      jr(room, payer.id, "refuse", Object.assign(refuse, { paid: 0 }));
      addLog(room, `${payer.name}: свободные акции ${ticker} — платить некому.`, "dividend");
      afterRollAction(room);
      return { ok: true };
    }
    const totalPct = owners.reduce((s, p) => s + p.holdings[ticker], 0);
    const ratePct = getForcedPaymentPct(room, tier);
    const dividendMult = TIER_DIVIDEND_MULT[tier] || 1.0;
    const squeezeMult = c.fullyOwned ? 3 : (c.squeezedOut ? 2 : 1);
    const amount = refuseRollAmount(room, ticker, totalPct);
    payer.cash -= amount;
    owners.forEach((o) => { o.cash += amount * (o.holdings[ticker] / totalPct); stat(room, o.id, "feeIn", amount * (o.holdings[ticker] / totalPct)); });
    jr(room, payer.id, "refuse", Object.assign(refuse, { paid: Math.round(amount) }));
    stat(room, payer.id, "feeOut", amount);
    const squeezeNote = c.fullyOwned ? " (×3, полное поглощение)" : (squeezeMult > 1 ? " (×2, сквиз-аут)" : "");
    const tierNote = dividendMult !== 1.0 ? ` (×${dividendMult.toFixed(1)}, тир ${tier})` : "";
    // В ленте — ставка класса, а не «N% капитализации»: сумма = ставка × эффективная
    // доля держателей (holdersFeeFactor) и вдвоём бывает в разы больше цены компании.
    addLog(room, `${payer.name} отказался от покупки ${ticker} и заплатил по ставке класса ${(ratePct * 100).toFixed(0)}%: ${fmt(amount)}${room.dividendMultiplier > 1 ? " (×2, Дивидендный сезон)" : ""}${squeezeNote}${tierNote}, распределено между ${owners.length} держателем(-ями).`, "dividend");
    settleDebt(room, payer);
    afterRollAction(room);
    return { ok: true };
  }

  // Контролирующий (>50%, единственный держатель) сам назначает сумму выкупа для
  // игрока, отказавшегося покупать. Слишком высокая цена (относительно тирной
  // "справедливой" ставки) бьёт по репутации контролёра и с вероятностью 50%
  // приводит к частичной конфискации его пакета «антимонопольной службой США».
  function forcedPriceCap(room, ticker, heldPct) {
    const fair = forcedFairPrice(room, ticker, heldPct);
    return Math.max(1, Math.round(fair * FORCED_PRICE_CAP_MULT));
  }
  // Плата по тарифу после срока решения контролёра (dividendFromRoll) и та же
  // сумма в подсказке клиенту (pendingRollMeta.controllerFee). Множители
  // refuseRollAmount (×3 поглощение, ×2 Дивидендный сезон, ×1.4 тир C) вместе
  // дают до 8.4 справедливой цены — больше, чем контролёр смог бы назначить сам
  // (forcedPriceCap); молчание не должно стоить бросающему дороже ответа.
  function controllerDeadlineFee(room, ticker, heldPct) {
    return Math.min(refuseRollAmount(room, ticker, heldPct), forcedPriceCap(room, ticker, heldPct));
  }
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
    const n = Number(amountRaw);
    if (!Number.isFinite(n) || n < 1) return { error: "Укажите сумму выкупа — положительное число." };
    const fair = forcedFairPrice(room, ticker, heldPct);
    const cap = forcedPriceCap(room, ticker, heldPct);
    if (Math.round(n) > cap) return { error: `Цена выкупа не может быть больше ${fmt(cap)} (${FORCED_PRICE_CAP_MULT} справедливых цен).` };
    const amount = Math.min(MAX_DEAL_AMOUNT, Math.round(n));
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
    // Контролёр получает не больше, чем у плательщика есть на самом деле
    // (наличные + активы за вычетом кредита): завышенная цена может разорить
    // соперника, но не печатает деньги из воздуха.
    const collectible = Math.max(0, Math.min(pf.amount, netWorth(room, payer)));
    payer.cash -= pf.amount;
    if (owner && !owner.bankrupt) owner.cash += collectible;
    jr(room, payer.id, "forced", { t: pf.ticker, paid: Math.round(pf.amount), to: owner ? owner.name : "" });
    stat(room, payer.id, "forcedOut", pf.amount);
    if (owner && !owner.bankrupt) stat(room, owner.id, "forcedIn", collectible);
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
    if (roll.ticker) jr(room, p.id, "refuse", Object.assign(refuseInfo(room, p, roll.ticker), { paid: 0 }));
    else if (roll.realEstateId && !room.realEstate[roll.realEstateId].ownerId) {
      const price = realEstatePrice(room, roll.realEstateId) * (1 + bankFeePct(p.reputation));
      jr(room, p.id, "reSkip", { city: roll.realEstateId, cost: Math.round(price), afford: p.cash >= price });
    }
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
    jr(room, p.id, "reBuy", { city: cityId, cost: Math.round(cost) });
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
    jr(room, p.id, "reUp", { city: cityId, cost: Math.round(cost) });
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
    const rent = realEstateRentDue(room, cityId);
    payer.cash -= rent;
    if (owner && !owner.bankrupt) owner.cash += rent;
    stat(room, payer.id, "rentOut", rent, cityId);
    if (owner && !owner.bankrupt) stat(room, owner.id, "rentIn", rent, cityId);
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

  // Покупка вне броска (DIRECT_BUY): раз в ход до DIRECT_BUY_MAX_PCT любой
  // компании у банка с наценкой. Как покупка по броску, двигает цену вверх.
  function buyDirect(room, playerId, ticker, pctRaw) {
    if (!DIRECT_BUY) return { error: "Покупка вне броска выключена." };
    const err = requireOwnTurn(room, playerId);
    if (err) return { error: err };
    const p = room.players.find((x) => x.id === playerId);
    if (!p || p.bankrupt) return { error: "Недоступно." };
    const c = room.companies[ticker];
    if (!c) return { error: "Неизвестная компания." };
    if (c.merged) return { error: "Компания поглощена при слиянии — её акций больше нет." };
    const key = DIRECT_BUY_PER_EVENT ? `${room.eventCount}:${p.id}` : `${room.eventCount}:${room.turn}:${p.id}`;
    if (!room.directBuyKeys || typeof room.directBuyKeys !== "object") room.directBuyKeys = {};
    if (room.directBuyKeys[p.id] === key) return { error: DIRECT_BUY_PER_EVENT ? "Покупка вне броска — раз в событие." : "Покупка вне броска — раз в ход." };
    let pct = Math.round(Number(pctRaw));
    if (!Number.isFinite(pct) || pct <= 0) pct = DIRECT_BUY_MAX_PCT;
    pct = Math.max(1, Math.min(DIRECT_BUY_MAX_PCT, pct));
    const free = Math.floor(100 - totalOwnedPct(room, ticker));
    if (free < 1) return { error: "Свободных акций этой компании нет." };
    pct = Math.min(pct, free);
    const cost = c.price * (pct / 100) * (1 + DIRECT_BUY_MARKUP) * (1 + bankFeePct(p.reputation));
    if (p.cash < cost) return { error: "Недостаточно наличных." };
    p.cash -= cost;
    p.holdings[ticker] = (p.holdings[ticker] || 0) + pct;
    addCostBasis(p, ticker, pct, cost);
    jr(room, p.id, "buy", { t: ticker, pct, cost: Math.round(cost) });
    room.directBuyKeys[p.id] = key;
    applyPriceDelta(room, ticker, 2 * (pct / 10));
    addLog(room, `${p.name} купил ${pct}% ${ticker} у банка вне броска за ${fmt(cost)} (наценка ${Math.round(DIRECT_BUY_MARKUP * 100)}%).`, "trade", [p.id]);
    checkFullOwnership(room, ticker);
    checkEndGame(room);
    return { ok: true };
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
    // Сначала давление продажи на цену, потом расчёт: иначе «купил на броске
    // (цена выросла) — тут же продал банку по выросшей цене» давало прибыль без
    // риска (+16 п.п. побед в симуляциях, BALANCE-REPORT.md, А2).
    applyPriceDelta(room, ticker, -2 * (pct / 10));
    const proceeds = c.price * (pct / 100);
    removeCostBasisProportional(p, ticker, pct);
    p.holdings[ticker] -= pct;
    p.cash += proceeds;
    jr(room, p.id, "sell", { t: ticker, pct, got: Math.round(proceeds) });
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
    const priceNum = Number(priceRaw) || 0;
    if (!Number.isFinite(priceNum) || priceNum > MAX_DEAL_AMOUNT) return { error: "Слишком большая сумма сделки." };
    const price = Math.max(0, Math.round(priceNum));
    if ((from.holdings[ticker] || 0) < pct) return { error: "Недостаточно акций для продажи." };
    // Открытые предложения уходят всем в каждом состоянии комнаты и в rooms.json —
    // без лимита их можно было наплодить тысячами.
    const mine = room.pendingTrades.filter((t) => t.fromId === from.id);
    if (mine.length >= 5 || room.pendingTrades.length >= 30) return { error: "Слишком много открытых предложений — дождитесь ответа на прежние." };
    wantTicker = wantTicker ? String(wantTicker) : null;
    let wantPct = 0;
    if (wantTicker) {
      if (!room.companies[wantTicker]) return { error: "Неизвестная компания для встречного предложения." };
      if (room.companies[wantTicker].merged) return { error: "Компания поглощена при слиянии — её акций больше нет." };
      if (wantTicker === ticker) return { error: "Встречный тикер должен отличаться от предлагаемого." };
      wantPct = Math.max(1, Math.min(25, Math.round(Number(wantPctRaw) || 0)));
    }
    if (mine.some((t) => t.toId === to.id && t.ticker === ticker && t.pct === pct && t.price === price && t.wantTicker === wantTicker && t.wantPct === wantPct)) {
      return { error: "Такое предложение уже ждёт ответа." };
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
    if (!from || !to || from.bankrupt || to.bankrupt) return { error: "Сделка больше недоступна: один из участников выбыл.", stillChanged: true };
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
    const wantValue = trade.wantTicker && trade.wantPct > 0 ? room.companies[trade.wantTicker].price * (trade.wantPct / 100) : 0;
    jr(room, from.id, "tradeOut", { t: trade.ticker, pct: trade.pct, got: Math.round(trade.price + wantValue), to: to.name });
    jr(room, to.id, "tradeIn", { t: trade.ticker, pct: trade.pct, cost: Math.round(trade.price + wantValue), from: from.name });
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

  // Сколько процентов бот покупает на своём броске. Сверх botChoosePct: если отказ
  // стоит денег (у компании есть другие держатели) и 5% по карману, бот покупает
  // их, а не платит за отказ (раньше из-за резерва в $15 000 он платил там, где
  // покупка выгоднее; BALANCE-REPORT.md, А5). Если отказ бесплатен — держателей,
  // кроме выбывших, нет или выплату отменила карта новостей, — запасной покупки
  // нет. Карта не освобождает от единоличного контролёра: его цена выкупа и плата
  // по тарифу её не учитывают (см. dividendFromRoll). «Всё или ничего» намеренно:
  // ровно 5% (или весь остаток, если свободно меньше), без покупок по 1–4% на
  // последние деньги — такие покупки удлиняли партии без лимита.
  // Сильный бот (настройка комнаты botLevel "strong", в магазине — подписка
  // «Трейдер»): стиль greedy из симулятора — максимум доступного на бросок при
  // резерве $15 000, города без случайных пропусков. Против трёх обычных
  // ботов выигрывает ≈42% партий вместо 25% (tools/sim, профиль strong).
  const STRONG_BOT_RESERVE = 15000;
  function isStrongBot(room, bot) { return (bot && bot.botLevel || (room.settings && room.settings.botLevel)) === "strong"; }
  function botBuyPct(room, bot, ticker, cash) {
    const free = Math.floor(100 - totalOwnedPct(room, ticker));
    if (free < 1) return 0;
    const c = room.companies[ticker];
    if (isStrongBot(room, bot)) {
      const unit = rollBuyCost(room, bot, ticker, 1);
      const max = unit > 0 ? Math.min(25, free, Math.floor((cash - STRONG_BOT_RESERVE) / unit)) : 0;
      if (max >= 1) return max;
    }
    const pct = botChoosePct(cash, c.price, free);
    if (pct >= 1) return pct;
    const owners = room.players.filter((p) => p.id !== bot.id && !p.bankrupt && (p.holdings[ticker] || 0) > 0);
    if (!owners.length) return 0;
    const controlled = owners.length === 1 && owners[0].holdings[ticker] > 50;
    if (!controlled && c.skipDividendUntil && c.skipDividendUntil >= room.eventCount) return 0;
    const p5 = Math.min(5, free);
    return cash >= rollBuyCost(room, bot, ticker, p5) ? p5 : 0;
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
        const rollerWantsToBuy = free >= 1 && isBotPlayer(roller) && botBuyPct(room, roller, ticker, effectiveCash) >= 1;
        if (!rollerWantsToBuy) {
          const heldPct = controller.holdings[ticker] || 0;
          const fair = forcedFairPrice(room, ticker, heldPct);
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
      // Только сделки не в убыток себе: при «got >= paid * 0.9» человек продавал
      // боту акции на 11% дороже рынка (BALANCE-REPORT.md, А5).
      const accept = canPay && got >= paid;
      return { acted: true, type: "respondTrade", result: respondTrade(room, to.id, trade.id, accept) };
    }

    // 4) Собственный ход бота (только если сейчас действительно его очередь).
    const curId = currentPlayerId(room);
    const cur = room.players.find((p) => p.id === curId);
    if (!isBotPlayer(cur)) return { acted: false };

    // 4a) Спецдействия бота: с небольшой вероятностью использует дискредитацию,
    // сквиз-аут, шорт или расследование перед броском кубиков (если есть деньги
    // и есть смысл); шпионажа среди них нет — см. ниже.
    // В обучении (room.tutorial) боты без «грязных» спецдействий — сценарий предсказуем.
    if (!room.tutorial && !room.pendingRoll && !room.rolledThisTurn && Math.random() < 0.15) {
      const myControlled = controlledTickers(room, cur.id);
      const otherPlayers = room.players.filter(p => p.id !== cur.id && !p.bankrupt);

      // Случайного шпионажа больше нет: бот не пользуется раскрытыми данными,
      // и это была просто утечка денег — она давала людям +13…+31 п.п. побед
      // против офлайн-ботов (BALANCE-REPORT.md, А5).

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
        const strong = isStrongBot(room, cur);
        if (!re.ownerId) {
          const cost = realEstatePrice(room, cityId) * (1 + bankFeePct(cur.reputation));
          if (strong ? cur.cash - cost >= STRONG_BOT_RESERVE : cur.cash - cost >= 10000 && Math.random() < 0.85) {
            return { acted: true, type: "buyRealEstateFromRoll", result: buyRealEstateFromRoll(room, cur.id) };
          }
          return { acted: true, type: "skipRoll", result: skipRoll(room, cur.id) };
        }
        if (re.ownerId === cur.id) {
          if ((re.level || 0) < MAX_RE_LEVEL) {
            const cost = realEstateUpgradeCost(room, cityId);
            if (strong ? cur.cash - cost >= STRONG_BOT_RESERVE : cur.cash - cost >= 10000 && Math.random() < 0.6) {
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
      const pct = free >= 1 ? botBuyPct(room, cur, ticker, cur.cash) : 0;
      if (pct >= 1) {
        const buy = buyFromRoll(room, cur.id, pct);
        if (!buy.error) return { acted: true, type: "buyFromRoll", result: buy };
        // Покупка не прошла (botBuyPct и buyFromRoll считают цену одной
        // rollBuyCost, так что это страховка) — закрываем бросок отказом. Иначе
        // бросок висел бы, а насос ботов (acted: true) повторял ту же покупку вечно.
      }
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
    if (target.merged) return { error: "Компания поглощена при слиянии — её акций больше нет." };
    if (mine.includes(ticker)) return { error: "Действует только против чужой компании." };
    if (room.eventCount - target.lastNegInfoEvent < 2) return { error: "Эту компанию уже атаковали недавно — раз в 2 события." };
    const cd = measureCooldownError(room, p, "negativeInfo");
    if (cd) return { error: cd };
    const cost = negativeInfoCost(room, p, ticker);
    if (p.cash < cost) return { error: `Недостаточно наличных (нужно ${fmt(cost)}).` };
    p.cash -= cost;
    noteMeasure(room, p, "negativeInfo");
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
    const cd = measureCooldownError(room, p, "pr");
    if (cd) return { error: cd };
    const cost = prCampaignCost(room, ticker);
    if (p.cash < cost) return { error: `Недостаточно наличных для PR-кампании (${fmt(cost)}).` };
    p.cash -= cost;
    noteMeasure(room, p, "pr");
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
    const cd = measureCooldownError(room, p, "insider");
    if (cd) return { error: cd };
    const cost = insiderPeekCost(room, p);
    if (p.cash < cost) return { error: `Недостаточно наличных (нужно ${fmt(cost)}).` };
    p.cash -= cost;
    noteMeasure(room, p, "insider");
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
    if (c.merged) return { error: "Компания поглощена при слиянии — её акций больше нет." };
    // Шорт — мера контрольного пакета (правила §7, так его показывает и интерфейс).
    if (controlledTickers(room, p.id).length === 0) return { error: "Нужен контрольный пакет (>50%) хотя бы одной компании." };
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
    // Стоимость 8% от капитала инициатора; при капитале в минусе (долг больше
    // активов) раньше выходила отрицательной — и мера доплачивала деньги.
    const cost = Math.max(5000, Math.round(Math.max(0, netWorth(room, p)) * 0.08));
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
    // Только во время партии: в лобби банкротство сразу «завершало» неначатую
    // игру с очками сопернику, а кредит из лобби переживал старт партии.
    if (room.phase !== "roll") return { error: "Сейчас недоступно." };
    const p = room.players.find((x) => x.id === playerId);
    if (!p || p.bankrupt) return { error: "Недоступно." };
    const wasCurrent = currentPlayerId(room) === p.id;
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
    onPlayerEliminated(room, p.id, wasCurrent);
    checkEndGame(room);
    return { ok: true };
  }

  // ---------------------------------------------------------------------
  // Кредиты банка
  // ---------------------------------------------------------------------
  function takeLoan(room, playerId, amountRaw) {
    if (!room) return { error: "Комната не найдена." };
    if (room.phase !== "roll") return { error: "Сейчас недоступно." };
    const p = room.players.find((x) => x.id === playerId);
    if (!p || p.bankrupt) return { error: "Недоступно." };
    if (p.loan) return { error: "У вас уже есть непогашенный кредит — сначала погасите его." };
    const amount = Math.max(0, Math.round(Number(amountRaw) || 0));
    if (amount <= 0) return { error: "Некорректная сумма." };
    const terms = loanTerms(room, p);
    if (amount > terms.limit) return { error: `Банк одобряет кредит не более ${fmt(terms.limit)} при вашей репутации и капитале.` };
    p.cash += amount;
    p.loan = { principal: amount, originalAmount: amount, ratePct: terms.ratePct, takenEvent: room.eventCount, missedPayments: 0, capitalAtTake: Math.max(0, Math.round(netWorth(room, p) - amount)) };
    addLog(room, `🏦 ${p.name} взял кредит ${fmt(amount)} у банка под ${terms.ratePct}% за событие.`, "loan");
    return { ok: true };
  }

  function repayLoan(room, playerId, amountRaw) {
    if (!room) return { error: "Комната не найдена." };
    if (room.phase !== "roll") return { error: "Сейчас недоступно." };
    const p = room.players.find((x) => x.id === playerId);
    if (!p || !p.loan) return { error: "У вас нет кредита." };
    const amount = Math.max(0, Math.min(p.loan.principal, Math.round(Number(amountRaw) || 0)));
    if (amount <= 0) return { error: "Некорректная сумма." };
    if (p.cash < amount) return { error: "Недостаточно наличных." };
    p.cash -= amount;
    p.loan.principal -= amount;
    addLog(room, `${p.name} погасил ${fmt(amount)} кредита.`, "loan");
    // Кредит не символический: не меньше max($1000, 10% капитала при выдаче).
    // Общая защита обоих бонусов ниже — иначе репутацию фармили бы мелкими кредитами.
    const meaningfulLoan = p.loan.originalAmount >= Math.max(1000, (p.loan.capitalAtTake || 0) * 0.1);
    if (p.loan.principal <= 1) {
      // Бонус к репутации за полное погашение начисляется, только если кредит
      // прожил хотя бы два биржевых события (room.eventCount >= takenEvent + 2)
      // и был не символическим — иначе можно было бы «фармить» репутацию, беря и
      // тут же закрывая кредит: при ставке 1–6% за событие это стоит копейки.
      const survivedTwoEvents = room.eventCount >= p.loan.takenEvent + 2;
      p.loan = null;
      if (survivedTwoEvents && meaningfulLoan) {
        adjustReputation(room, p, 3, "кредит погашен полностью");
        addLog(room, `✅ ${p.name} полностью погасил кредит — репутация выросла.`, "loan");
      } else {
        addLog(room, `${p.name} полностью погасил кредит.`, "loan");
      }
    } else {
      // Бонус за добровольный частичный платёж — с защитами полного: иначе его
      // фармили бы циклом «взять — погасить 10% — погасить остаток», 50 циклов за
      // событие давали +50 (BALANCE-REPORT.md, раздел 0). Кредит не символический
      // и прожил хотя бы одно событие (room.eventCount > takenEvent), платёж
      // ощутимый (≥10% изначальной суммы), и не чаще раза в событие на ИГРОКА:
      // отметка хранится на игроке, а не на кредите, — новый кредит её не сбросит.
      const meaningfulPartial = meaningfulLoan && amount >= p.loan.originalAmount * 0.1;
      const loanAged = room.eventCount > p.loan.takenEvent;
      const alreadyBonused = p.lastPartialRepayBonusEvent === room.eventCount;
      if (meaningfulPartial && loanAged && !alreadyBonused) {
        p.lastPartialRepayBonusEvent = room.eventCount;
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
      stat(room, p.id, "interest", p.loan.principal * (p.loan.ratePct / 100));
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
      // −2.25%..+2.75%, в среднем +0.25% за событие. Было −2..+4% (в среднем +1%):
      // город, купленный в начале, почти гарантировал победу (BALANCE-REPORT.md, Б1).
      const drift = Math.random() * 5 - 2.25;
      re.factor = clamp((re.factor || 1) * (1 + drift / 100), 0.6, 2.2);

      // Пассивная рента для улучшенной недвижимости
      if (re.ownerId && (re.level || 0) >= 1) {
        const owner = room.players.find(p => p.id === re.ownerId);
        if (owner && !owner.bankrupt) {
          const fullRent = realEstateRent(room, ct.id);
          const passiveRentPct = 0.35 * re.level; // 35% за уровень (макс 140% при level 4)
          const passiveRent = Math.round(fullRent * passiveRentPct);
          owner.cash += passiveRent;
          stat(room, owner.id, "rentIn", passiveRent, ct.id);
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
            stat(room, owner.id, "reTax", tax);
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
    const cd = measureCooldownError(room, p, "espionage");
    if (cd) return { error: cd };
    const cost = espionageCost(room, p);
    if (p.cash < cost) return { error: `Недостаточно наличных (нужно ${fmt(cost)}).` };
    p.cash -= cost;
    noteMeasure(room, p, "espionage");
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
    const cd = measureCooldownError(room, p, "discredit");
    if (cd) return { error: cd };
    const cost = discreditCost(room, p, target);
    if (p.cash < cost) return { error: `Недостаточно наличных (нужно ${fmt(cost)}).` };
    p.cash -= cost;
    noteMeasure(room, p, "discredit");
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
    const cd = measureCooldownError(room, p, "personalPr");
    if (cd) return { error: cd };
    const cost = personalPrCostFor(room, p);
    if (p.cash < cost) return { error: `Недостаточно наличных (нужно ${fmt(cost)}).` };
    p.cash -= cost;
    noteMeasure(room, p, "personalPr");
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
    if (MEASURE_COST_MODE === "cooldown") return 0;
    const k = MEASURE_COST_MODE === "company" ? MEASURE_SCALE : 1;
    const rep = player.reputation == null ? REPUTATION_START : player.reputation;
    const base = clamp(Math.round(netWorth(room, player) * 0.04), 5000, 50000);
    return Math.round(Math.max(3000, base - rep * 40) * k);
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
    const cd = measureCooldownError(room, p, "investigate");
    if (cd) return { error: cd };
    const cost = investigationCost(room, p);
    if (p.cash < cost) return { error: `Недостаточно наличных (нужно ${fmt(cost)}).` };
    p.cash -= cost;
    noteMeasure(room, p, "investigate");
    const success = Math.random() < investigationChance(room, p);
    room.spyIncidents = room.spyIncidents.filter((i) => i.id !== incident.id);
    if (success) {
      const suspect = room.players.find((x) => x.id === incident.suspectId);
      // Строка публичная, её читают все — поэтому в третьем лице, а не «шпионил за вами».
      const kindLabel = incident.kind === "espionage" ? "шпионил(а) за" : "дискредитировал(а)";
      if (suspect) adjustReputation(room, suspect, -10, "разоблачён расследованием");
      addLog(room, `🔍 Расследование ${p.name} (${fmt(cost)}) увенчалось успехом: ${suspect ? suspect.name : "неизвестный игрок"} ${kindLabel} ${p.name}!`, "espionage");
      return { ok: true, success: true, suspectId: incident.suspectId, suspectName: suspect ? suspect.name : null };
    }
    addLog(room, `🔍 ${p.name} потратил(а) ${fmt(cost)} на расследование, но виновный остался неизвестен.`, "espionage");
    return { ok: true, success: false };
  }

  function forceEvent(room) {
    if (!room || room.phase !== "roll") return { error: "Событие можно вызвать только вне фазы торгов." };
    room.pendingRoll = null;
    const curId = currentPlayerId(room);
    marketEvent(room);
    // Ходящий обанкротился на самом событии (налог, аудит, кредит) — ход переходит дальше.
    const cur = room.players.find((x) => x.id === curId);
    if (cur && cur.bankrupt) onPlayerEliminated(room, cur.id, true);
    checkEndGame(room);
    return { ok: true };
  }

  // ---------------------------------------------------------------------
  // Состояние для клиента
  // ---------------------------------------------------------------------
  // Плата за отказ от покупки (dividendFromRoll): ставка тира × эффективная
  // доля держателей (holdersFeeFactor — кривая FEE_CURVE_*, по умолчанию просто
  // общая доля) × множители (Дивидендный сезон, сквиз-аут/поглощение, тир C).
  // Одна формула и для списания, и для подписи кнопки «Отказаться» на клиенте —
  // чтобы показанная сумма не расходилась с фактической.
  function refuseRollAmount(room, ticker, totalPct) {
    const c = room.companies[ticker];
    const tier = companyByTicker(ticker).tier;
    const squeezeMult = c.fullyOwned ? 3 : (c.squeezedOut ? 2 : 1);
    return c.price * getForcedPaymentPct(room, tier) * holdersFeeFactor(room, totalPct) * (room.dividendMultiplier || 1) * squeezeMult * (TIER_DIVIDEND_MULT[tier] || 1.0);
  }

  // Единоличный контролёр компании на клетке броска: единственный держатель
  // (кроме самого бросающего) с долей >50% — та же проверка, что в
  // dividendFromRoll, setForcedPrice и botStep.
  function rollController(room, roll) {
    if (!roll || !roll.ticker) return null;
    const owners = room.players.filter((p) => !p.bankrupt && p.id !== roll.playerId && (p.holdings[roll.ticker] || 0) > 0);
    return owners.length === 1 && owners[0].holdings[roll.ticker] > 50 ? owners[0] : null;
  }

  // Сколько мс бросающий ещё ждёт цену выкупа от контролёра (CONTROLLER_DECISION_MS):
  // 0 — срок вышел, можно оплатить по тарифу (dividendFromRoll); null — ждать
  // некого (контролёра нет или цена уже назначена). Отсчёт — с момента, когда
  // ожидание впервые замечено: бросок на контролируемую компанию (rollDice) или
  // контроль, сложившийся сделкой посреди броска (первый снимок состояния).
  // Метка — обычное число в pendingRoll: переживает rooms.json и офлайн-сохранение.
  function controllerWaitLeftMs(room, controller) {
    const roll = room.pendingRoll;
    if (!roll || !roll.ticker || !controller || room.pendingForcedPrice) return null;
    if (!Number.isFinite(roll.controllerWaitSince)) roll.controllerWaitSince = Date.now();
    return Math.max(0, roll.controllerWaitSince + CONTROLLER_DECISION_MS - Date.now());
  }

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
      const c = room.companies[roll.ticker];
      const tier = companyByTicker(roll.ticker).tier;
      return {
        kind: "stock", ticker: roll.ticker, ownersCount: owners.length, totalOwnedPct: totalPct,
        controllerId: controller ? controller.id : null, controllerName: controller ? controller.name : null,
        forcedPct: getForcedPaymentPct(room, tier),
        // Для кнопки «Отказаться»: точная сумма (как в dividendFromRoll), выплата
        // отменена картой новостей, и шанс, что её пропустят случайно.
        refuseAmount: owners.length && !controller ? refuseRollAmount(room, roll.ticker, totalPct) : 0,
        refuseSkipped: !!(c.skipDividendUntil && c.skipDividendUntil >= room.eventCount),
        // В обучении выплата не пропускается (см. dividendFromRoll) — без подсказки о шансе.
        refuseSkipChance: room.tutorial ? 0 : (TIER_DIVIDEND_SKIP_CHANCE[tier] || 0.12),
        // Срок решения контролёра: остаток на момент снимка (клиент ведёт отсчёт
        // от прихода состояния — часы клиента и сервера могут расходиться),
        // 0 — «Оплатить по тарифу» уже доступно, null — ждать некого. Сумма — та же
        // controllerDeadlineFee (с потолком цены выкупа), что спишет dividendFromRoll.
        controllerWaitLeftMs: controllerWaitLeftMs(room, controller),
        controllerWaitMs: CONTROLLER_DECISION_MS,
        controllerFee: controller ? controllerDeadlineFee(room, roll.ticker, totalPct) : 0,
        // Для листа контролёра «Назначьте цену выкупа»: справедливая цена (от неё —
        // порог завышения ×FORCED_PRICE_EXCESSIVE_MULT) и потолок — те же
        // forcedFairPrice/forcedPriceCap, что проверит setForcedPrice. Клиент не
        // пересчитывает их из forcedPct × доли: кривая FEE_CURVE_* меняет обе суммы.
        fairPrice: controller ? Math.round(forcedFairPrice(room, roll.ticker, totalPct)) : 0,
        priceCap: controller ? forcedPriceCap(room, roll.ticker, totalPct) : 0,
        // Кривая платы включена (FEE_CURVE_K > 0) — клиент поясняет правило одной
        // строкой у суммы; feeFactor — «эффективная доля» держателей (holdersFeeFactor).
        feeCurve: FEE_CURVE_K > 0,
        feeFactor: owners.length ? holdersFeeFactor(room, totalPct) : 0,
      };
    }
    if (roll.realEstateId) {
      const cityId = roll.realEstateId;
      const re = room.realEstate[cityId];
      const ct = cityById(cityId);
      return {
        kind: "realestate", cityId, cityName: ct.name, ownerId: re.ownerId, level: re.level || 0,
        maxLevel: MAX_RE_LEVEL, price: realEstatePrice(room, cityId), rent: realEstateRent(room, cityId),
        rentDue: realEstateRentDue(room, cityId), // к оплате сейчас, с учётом «Дивидендного сезона»
        upgradeCost: realEstateUpgradeCost(room, cityId),
      };
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Разбор партии: ключевые ошибки и удачные решения игрока в деньгах, график
  // капитала, расходы и доходы, пара советов. Считается по журналу (jr), истории
  // капитала (recordNetWorths) и суммам (stat) — без ИИ, одинаково в офлайне и
  // на сервере. Порог «заметной» суммы — 2% стартового капитала.
  // ---------------------------------------------------------------------
  function analyzeGame(room, playerId) {
    const me = room && room.players.find((p) => p.id === playerId);
    if (!me) return null;
    const S = (room.settings && room.settings.startingCash) || STARTING_CASH;
    const thr = Math.max(1000, Math.round(S * 0.02));
    const priceNow = (t) => { const c = room.companies[t]; return c && !c.merged ? c.price : 0; };
    const coName = (t) => (companyByTicker(t) || {}).name || t;
    const cityName = (id) => (cityById(id) || {}).name || id;
    const J = (room.journal || []).filter((e) => e.p === playerId);
    const st = (room.pstats && room.pstats[playerId]) || {};
    const round = (e) => `Раунд ${e.r}`;

    // Позиция, купленная записью i: первая продажа того же тикера позже или текущая цена.
    function exitOf(t, i) {
      for (let k = i + 1; k < J.length; k++) {
        const e = J[k];
        if ((e.k === "sell" || e.k === "tradeOut") && e.t === t && e.pct > 0) return { px: e.got / (e.pct / 100), sold: true, r: e.r, ev: e.ev };
      }
      return { px: priceNow(t), sold: false };
    }

    const mistakes = [], best = [];
    J.forEach((e, i) => {
      if (e.k === "refuse" && e.free >= 1 && e.afford >= 5) {
        const pct = Math.min(10, e.afford, e.free);
        const growth = Math.round((pct / 100) * (priceNow(e.t) - e.px));
        const cost = (e.paid || 0) + Math.max(0, growth);
        if (cost < thr) return;
        const grew = growth > 0 ? ` К концу партии эти ${pct}% подорожали на ${fmt(growth)}.` : "";
        mistakes.push({ key: "refuse:" + e.t, ev: e.ev, r: e.r, cost,
          title: e.paid > 0 ? `Отказ от ${coName(e.t)}` : `Не купили ${coName(e.t)}`,
          text: e.paid > 0 ? `${round(e)}: заплатили ${fmt(e.paid)} за отказ, хотя ${pct}% были по карману.${grew}`
            : `${round(e)}: свободные ${pct}% стоили ${fmt((pct / 100) * e.px)}.${grew}` });
      } else if (e.k === "forced" && e.paid >= thr) {
        mistakes.push({ key: "forced:" + e.t, ev: e.ev, r: e.r, cost: e.paid,
          title: `${coName(e.t)}: выкуп у контролёра`,
          text: `${round(e)}: заплатили ${fmt(e.paid)}${e.to ? ` игроку ${e.to}` : ""} за отказ от покупки. Своя доля в компании до захвата контроля защищает от таких платежей.` });
      } else if (e.k === "buy" || e.k === "tradeIn") {
        const x = exitOf(e.t, i);
        const value = Math.round((e.pct / 100) * x.px);
        const pnl = value - e.cost;
        const how = x.sold ? `продали в раунде ${x.r} за ${fmt(value)}` : `к концу партии доля стоит ${fmt(value)}`;
        const what = e.k === "tradeIn" ? `${e.pct}% ${coName(e.t)} у ${e.from || "игрока"}` : `${e.pct}% ${coName(e.t)}`;
        if (pnl <= -thr) mistakes.push({ key: "buy:" + e.t, ev: e.ev, r: e.r, cost: -pnl, title: `Покупка ${what}`, text: `${round(e)}: купили за ${fmt(e.cost)}, ${how}.` });
        else if (pnl >= thr) best.push({ key: "buy:" + e.t, ev: e.ev, r: e.r, gain: pnl, title: `Покупка ${what}`, text: `${round(e)}: купили за ${fmt(e.cost)}, ${how}.` });
      } else if (e.k === "sell" || e.k === "tradeOut") {
        const later = Math.round((e.pct / 100) * priceNow(e.t));
        const diff = later - e.got;
        const whom = e.k === "tradeOut" ? ` игроку ${e.to || ""}`.trimEnd() : "";
        if (diff >= thr) mistakes.push({ key: "sell:" + e.t, ev: e.ev, r: e.r, cost: diff, title: `Ранняя продажа ${coName(e.t)}`, text: `${round(e)}: продали ${e.pct}%${whom} за ${fmt(e.got)}, к концу партии они стоили бы ${fmt(later)}.` });
        else if (-diff >= thr) best.push({ key: "sell:" + e.t, ev: e.ev, r: e.r, gain: -diff, title: `Вовремя продали ${coName(e.t)}`, text: `${round(e)}: продали ${e.pct}%${whom} за ${fmt(e.got)} — к концу партии они стоили бы ${fmt(later)}.` });
      } else if (e.k === "reBuy") {
        const rent = (st.rentInBy && st.rentInBy[e.city]) || 0;
        const owned = room.realEstate[e.city] && room.realEstate[e.city].ownerId === playerId;
        const gain = rent + (owned ? Math.round(realEstatePrice(room, e.city)) : 0) - e.cost;
        if (gain >= thr) best.push({ key: "city:" + e.city, ev: e.ev, r: e.r, gain, title: `Город ${cityName(e.city)}`, text: `${round(e)}: купили за ${fmt(e.cost)}${rent > 0 ? `, рента принесла ${fmt(rent)}` : ""}${owned ? `, сейчас город стоит ${fmt(realEstatePrice(room, e.city))}` : ""}.` });
      } else if (e.k === "reSkip" && e.afford) {
        const paid = (st.rentOutBy && st.rentOutBy[e.city]) || 0;
        if (paid >= thr) mistakes.push({ key: "city:" + e.city, ev: e.ev, r: e.r, cost: paid, title: `Пропустили город ${cityName(e.city)}`, text: `${round(e)}: город был по карману (${fmt(e.cost)}). Потом его купил соперник, и вы заплатили ему ренты ${fmt(paid)}.` });
      }
    });
    // Доля, которую игрок держит к концу: вложено (costBasis) против стоимости
    // сейчас. Покупки по 5% по отдельности малы, а вместе решают партию.
    for (const t in me.holdings) {
      const pct = me.holdings[t] || 0;
      const basis = Math.round((me.costBasis && me.costBasis[t]) || 0);
      if (pct <= 0 || basis <= 0) continue;
      const value = Math.round((pct / 100) * priceNow(t));
      const pnl = value - basis;
      const first = J.find((e) => (e.k === "buy" || e.k === "tradeIn") && e.t === t);
      const at = first ? { ev: first.ev, r: first.r } : { ev: 0, r: 1 };
      const text = `Вложили ${fmt(basis)} в ${pct}%, к концу партии доля стоит ${fmt(value)}.`;
      if (pnl >= thr) best.push(Object.assign({ key: "buy:" + t, gain: pnl, title: `Доля в ${coName(t)}`, text }, at));
      else if (pnl <= -thr) mistakes.push(Object.assign({ key: "buy:" + t, cost: -pnl, title: `Доля в ${coName(t)}`, text }, at));
    }
    // Одна строка на компанию или город — самая дорогая.
    const top = (list, by) => {
      const seen = new Map();
      list.forEach((x) => { const was = seen.get(x.key); if (!was || x[by] > was[by]) seen.set(x.key, x); });
      return [...seen.values()].sort((a, b) => b[by] - a[by]).slice(0, 3).map((x) => ({ ev: x.ev, r: x.r, title: x.title, text: x.text, [by]: Math.round(x[by]) }));
    };

    // График: капитал после каждого события, от старта до конца партии.
    const series = (p) => {
      const h = ((room.nwHist && room.nwHist[p.id]) || []).filter((pt) => Array.isArray(pt) && pt.length === 2);
      const pts = h.length && h[0][0] === 0 ? h.slice() : [[0, S]].concat(h);
      const end = Math.round(netWorth(room, p));
      const last = pts[pts.length - 1];
      if (!p.bankrupt) { if (last[0] === room.eventCount) last[1] = end; else pts.push([room.eventCount, end]); }
      return pts;
    };
    const ranking = (room.gameResult && room.gameResult.ranking) || room.players.map((p) => ({ id: p.id, name: p.name, netWorth: Math.round(netWorth(room, p)), bankrupt: !!p.bankrupt }))
      .sort((a, b) => a.bankrupt - b.bankrupt || b.netWorth - a.netWorth);
    const place = Math.max(1, ranking.findIndex((x) => x.id === playerId) + 1);
    const rivalRow = ranking.find((x) => x.id !== playerId);
    const rival = rivalRow ? room.players.find((p) => p.id === rivalRow.id) : null;
    const mine = series(me);
    let peak = mine[0], low = mine[0];
    mine.forEach((pt) => { if (pt[1] > peak[1]) peak = pt; if (pt[1] < low[1]) low = pt; });
    const finalNW = Math.round(netWorth(room, me));

    const costs = [
      { label: "Плата за отказ", amount: st.feeOut || 0, count: J.filter((e) => e.k === "refuse" && e.paid > 0).length },
      { label: "Выкуп у контролёров", amount: st.forcedOut || 0, count: J.filter((e) => e.k === "forced").length },
      { label: "Рента за чужие города", amount: st.rentOut || 0 },
      { label: "Проценты по кредиту", amount: st.interest || 0 },
      { label: "Налог на недвижимость", amount: st.reTax || 0 },
    ].filter((x) => x.amount > 0);
    const income = [
      { label: "Плата за отказ от соперников", amount: st.feeIn || 0 },
      { label: "Выкуп ваших долей", amount: st.forcedIn || 0 },
      { label: "Рента с городов", amount: st.rentIn || 0 },
    ].filter((x) => x.amount > 0);

    // Советы — по самым заметным привычкам за партию, не больше двух.
    const tips = [];
    let stockValue = 0, topTicker = null, topValue = 0;
    for (const t in me.holdings) {
      const v = ((me.holdings[t] || 0) / 100) * priceNow(t);
      stockValue += v;
      if (v > topValue) { topValue = v; topTicker = t; }
    }
    const skippedCities = J.filter((e) => e.k === "reSkip" && e.afford).length;
    const boughtCities = J.filter((e) => e.k === "reBuy").length;
    if ((st.feeOut || 0) >= S * 0.15) tips.push(`Плата за отказ за партию — ${fmt(st.feeOut)}. Если доля по карману, купить хотя бы 5% обычно дешевле отказа.`);
    if (!me.bankrupt && finalNW > 0 && me.cash > finalNW * 0.5) tips.push(`В конце партии ${Math.round((me.cash / finalNW) * 100)}% капитала лежало наличными. Деньги не растут, акции и города — растут.`);
    if (skippedCities >= 2 && !boughtCities) tips.push(`Вы пропустили ${skippedCities} ${plural(skippedCities, "свободный город", "свободных города", "свободных городов").replace(/^\d+ /, "")} при деньгах на покупку. Город приносит ренту при каждом попадании соперника.`);
    if ((st.interest || 0) >= S * 0.05) tips.push(`Проценты по кредиту — ${fmt(st.interest)}. Гасите кредит, когда есть свободные деньги.`);
    if (!me.bankrupt && finalNW > 0 && topTicker && topValue > finalNW * 0.5) tips.push(`Больше половины капитала — в одной компании (${coName(topTicker)}). Одна плохая новость ударит по всему капиталу.`);

    return {
      v: 1,
      name: me.name,
      place, players: ranking.length,
      won: !!(room.gameResult && room.gameResult.winnerId === playerId),
      bankrupt: !!me.bankrupt,
      startNW: S, finalNW,
      peak: { ev: peak[0], v: peak[1] }, low: { ev: low[0], v: low[1] },
      events: room.eventCount || 0,
      chart: { me: mine, rival: rival ? series(rival) : [], rivalName: rival ? rival.name : "" },
      mistakes: top(mistakes, "cost"),
      best: top(best, "gain"),
      costs, income,
      tips: tips.slice(0, 2),
      scenario: (room.settings && room.settings.scenario) || "",
    };
  }

  function buildStatePayload(room, youId) {
    const me = room.players.find((x) => x.id === youId);
    return {
      type: "state",
      you: youId,
      room: room.code,
      turn: room.turn,
      roundLen: room.settings?.eventIntervalTurns || EVENT_INTERVAL_TURNS,
      settings: {
        startingCash: room.settings?.startingCash || STARTING_CASH,
        turnSalary: room.settings?.turnSalary ?? TURN_SALARY,
        eventIntervalTurns: room.settings?.eventIntervalTurns || EVENT_INTERVAL_TURNS,
        tierForcedPaymentPct: room.settings?.tierForcedPaymentPct || [60, 45, 30],
        // Длительность в своих ходах у каждого (0 — без лимита); null — старая
        // комната, лимит только в maxRounds. Ключ есть всегда: по нему клиент
        // отличает этот сервер от прежнего (у того — только maxRounds).
        maxTurnsPerPlayer: room.settings?.maxTurnsPerPlayer ?? null,
        scenario: room.settings?.scenario || "",
        botLevel: room.settings?.botLevel || "",
      },
      roundNumber: room.roundNumber || 1,
      maxRounds: room.maxRounds || null,
      // «Быстрая игра» (server.js): автостарт через quickStartIn мс, свободные
      // места займут боты. Итог лиги недели — только свой.
      quick: !!room.quick,
      quickStartIn: room.quick && room.phase === "lobby" ? Math.max(0, (room.quickStartAt || 0) - Date.now()) : null,
      leagueResult: (room.leagueResults && room.leagueResults[youId]) || null,
      eventCount: room.eventCount,
      deckRemaining: room.deckOrder.length - room.deckPos,
      phase: room.phase,
      hostPlayerId: room.hostPlayerId || null,
      // Хост пропал надолго — «Новую партию» до конца текущей может начать любой.
      hostAway: hostAway(room),
      // Опознание партии: реванш — новая партия, даже если счётчики ходов совпали (anim.js).
      gameId: room.createdAt || 0,
      // Учебная партия (офлайн, tutorial.js): клиент прячет «Новую партию» и
      // «Смотреть как». Онлайн всегда false; сами scriptedRolls наружу не отдаём.
      tutorial: !!room.tutorial,
      // Не в сети к старту в партию не попадает (см. startGame) — считаем только тех, кто в сети.
      canStart: room.phase === "lobby" && room.hostPlayerId === youId && room.players.filter((p) => p.connected || p.isBot).length >= 2,
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
      kickVote: (() => {
        // Голосование против уже выбывшего не показываем (см. dropStaleKickVote).
        const target = room.kickVote && room.players.find((p) => p.id === room.kickVote.targetId);
        if (!target || target.bankrupt) return null;
        const eligible = kickEligibleVoters(room, room.kickVote.targetId);
        const yesCount = eligible.filter((p) => room.kickVote.voters[p.id]).length;
        return {
          targetId: room.kickVote.targetId,
          targetName: target.name,
          initiatorId: room.kickVote.initiatorId,
          yesVoterIds: eligible.filter((p) => room.kickVote.voters[p.id]).map((p) => p.id),
          yesCount,
          needed: kickVotesNeeded(target, eligible.length),
          totalEligible: eligible.length,
          myVote: !!room.kickVote.voters[youId],
        };
      })(),
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
          rentDue: realEstateRentDue(room, ct.id), // к оплате при попадании, с учётом «Дивидендного сезона»
          upgradeCost: realEstateUpgradeCost(room, ct.id),
        };
      }),
      // Поглощённые при слиянии компании исчезают с биржи и из всех списков клиента.
      companies: liveCompanies(room).map((c) => ({
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
          // Ссылка /api/avatar/… на фото профиля (ставит server.js при входе), не сама картинка.
          avatarPhoto: p.avatarPhoto || null,
          equippedBoardSkin: p.equippedBoardSkin || "default", isBot: !!p.isBot,
          cash: p.cash, bankrupt: p.bankrupt, connected: p.connected, kicked: !!p.kicked,
          // Можно исключить одним голосом: бот или не в сети дольше минуты (kickVotesNeeded).
          soloKickable: !!p.isBot || offlineLongEnough(p),
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
    SCENARIOS, scenarioById, scenarioInfo, applyScenario, applyNewsCard, analyzeGame,
    REPUTATION_START, CITIES, MAX_RE_LEVEL, REAL_ESTATE_POS,
    companyByTicker, cityById, isRealEstateCell, cityIdFromCell, buildDeck, shuffle, fmt,
    realEstatePrice, realEstateRent, realEstateRentDue, realEstateUpgradeCost,
    freshRoom, addLog,
    totalOwnedPct, ownerOfControl, controlledTickers, netWorth, applyPriceDelta, ambientJitter, activePlayers, currentPlayerId,
    requireOwnTurn,
    settleDebt, checkEndGame, resolveShorts, marketEvent, afterRollAction, endTurn,
    addPlayer, setConnected, leaveLobby, newGameKeepPlayers, startGame, updateRoomSettings, setMaxRounds, deleteRoom, sendChatMessage,
    rollDice, buyFromRoll, dividendFromRoll, skipRoll, buyBank, sellBank, proposeTrade, respondTrade,
    setForcedPrice, payForcedPrice, forcedPriceCap, forcedFairPrice, holdersFeeFactor, botStep, botBuyPct, buyDirect, holdersFeeOnBuy, prCampaignCost,
    ctrlNegativeInfo, ctrlPrCampaign, ctrlInsiderPeek, ctrlInsiderResolve, ctrlSqueezeOut, ctrlShort, ctrlPublicIPO, ctrlMergeCompanies,
    declareBankruptcy, forceEvent,
    adjustReputation, bankFeePct, loanTerms, takeLoan, repayLoan, processLoans,
    buyRealEstateFromRoll, upgradeRealEstateFromRoll, payRealEstateRentFromRoll, processRealEstate,
    ctrlEspionage, ctrlDiscredit, isRevealed, ctrlInvestigate, investigationCost, investigationChance, personalPr,
    startKickVote, voteKick, cancelKickVote, resolveKickVote, sendReaction, REACTION_EMOJIS, OFFLINE_KICK_GRACE_MS, hostAway,
    CONTROLLER_DECISION_MS, MIN_TURNS_FOR_POINTS, turnsPlayed,
    DEFAULT_MAX_TURNS_PER_PLAYER, roundsForTurnsPerPlayer, applyGameLength,
    FEE_CURVE_K, FEE_CURVE_P, FEE_CURVE_N_EXP, FEE_CURVE_N_MAX,
    buildStatePayload,
  };
});
