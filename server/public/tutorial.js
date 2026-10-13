// ---------------------------------------------------------------------
// Интерактивное обучение «Обучение» (window.Tutorial). Подключается из
// index.html после anim.js; в Node (тесты) отдаёт только сборку учебной
// комнаты — buildRoom() и данные сценария, без DOM.
//
// Это обычная офлайн-партия (хот-сит) против двух ботов: комната движка с
// флагом room.tutorial и заранее заданными бросками room.scriptedRolls (см.
// rollDice в engine.js), а поверх настоящего интерфейса — тренер: 13 шагов,
// около трёх минут.
// - Шаги идут за состоянием партии, а не по таймеру: render() зовёт
//   onRender(), смену вкладки, карточки, сводки события и меню партии ловит
//   MutationObserver. Тренер движется только вперёд и пропускает то, что
//   игрок уже сделал сам; купить вместо отказа или пропустить покупку можно.
// - Наложение никогда не перехватывает нажатия: затемнение и кольца —
//   pointer-events:none, нажимается только сама карточка, и стоит она так,
//   чтобы не закрывать то, что просит нажать.
// - Пока игрок читает, боты ждут: scheduleBotPump() спрашивает holdBots().
// - Учебная партия не сохраняется (saveOfflineGame) и очков не даёт;
//   пройденное отмечается в localStorage tm_tutorial_done.
// Элементы интерфейса пересобираются через innerHTML на каждом состоянии,
// поэтому ссылки на них не храним — якоря ищем заново при каждом пересчёте.
// ---------------------------------------------------------------------
(function(root, factory){
  if(typeof module === "object" && module.exports) module.exports = factory();
  else root.Tutorial = factory();
})(typeof self !== "undefined" ? self : this, function(){
  "use strict";

  // --- Сценарий ----------------------------------------------------------
  // Клетки сверены с BOARD/REAL_ESTATE_POS движка (строка и столбец — с 1,
  // как подписи по краям поля). Человек: Apple (всё у банка), Coca-Cola (45%
  // у ботов — плата за отказ), Лас-Вегас (свободный город). Боты — свободные
  // компании вне урока, сколько купить, решают сами.
  const HUMAN_ROLLS = [[7, 6], [9, 5], [10, 4]];
  const BOT_ROLLS = [[[5, 9], [1, 5], [2, 9]], [[6, 6], [4, 12], [6, 10]]];
  const BOT_NAMES = ["Бот Альфа", "Бот Омега"];
  // Событие наступает после 9-го хода — сразу после третьего хода Омеги, и
  // следующий ход снова у человека: «Влияние» он смотрит в свой ход (не в
  // свой там только заглушка).
  const EVENT_INTERVAL = 9;
  // Верхняя карта колоды — «Технологии +20%»: подорожает и NVIDIA игрока.
  const NEWS_TITLE = "Технологический прорыв";
  const SCRIPT = {
    humanRolls: HUMAN_ROLLS, botRolls: BOT_ROLLS, botNames: BOT_NAMES,
    eventInterval: EVENT_INTERVAL, newsTitle: NEWS_TITLE,
    // что должно выпасть человеку — для тестов (test/engine.test.js)
    humanCells: [{ ticker: "AAPL" }, { ticker: "KO" }, { city: "vegas" }],
    seed: [["NVDA", 55], ["KO", 30], ["KO", 15]], // человек, Альфа, Омега
  };

  // Стартовый пакет: стоимость вычитается из наличных — капитал остаётся
  // $100 000, а прибыль/убыток в «Портфеле» считается от настоящей цены.
  function seed(room, p, ticker, pct){
    const cost = room.companies[ticker].price * pct / 100;
    p.holdings[ticker] = pct;
    p.costBasis[ticker] = cost;
    p.cash -= cost;
  }
  // Учебная комната: тот же движок и та же раздача, что у обычной офлайн-
  // партии, плюс флаг tutorial, очередь бросков и подложенная карта новостей.
  // humanName — ник аккаунта или «Инвестор»: «Вы» не подходит — лента движка
  // пишет «${имя} купил…», а лента игроков показала бы «Вы [вы]».
  function buildRoom(E, humanName){
    const room = E.freshRoom("TUTORIAL");
    room.tutorial = true;
    // Хоста ещё нет (hostPlayerId null) — проверка хоста проходит, как в офлайн-настройке.
    E.updateRoomSettings(room, room.hostPlayerId, { eventIntervalTurns: EVENT_INTERVAL });
    room.maxRounds = null;
    let name = String(humanName || "").trim().slice(0, 20);
    if(!name || BOT_NAMES.indexOf(name) >= 0) name = "Инвестор";
    const me = E.addPlayer(room, name, "", "", 0, "default", false).player;
    const bots = BOT_NAMES.map((n)=> E.addPlayer(room, n, "", "🤖", 0, "default", true).player);
    room.phase = "roll";
    seed(room, me, SCRIPT.seed[0][0], SCRIPT.seed[0][1]);
    seed(room, bots[0], SCRIPT.seed[1][0], SCRIPT.seed[1][1]);
    seed(room, bots[1], SCRIPT.seed[2][0], SCRIPT.seed[2][1]);
    const card = room.deckData.findIndex((c)=> c.type === "sector" && c.title === NEWS_TITLE);
    if(card >= 0) room.deckOrder = [card].concat(room.deckOrder.filter((x)=> x !== card));
    room.scriptedRolls = {};
    room.scriptedRolls[me.id] = HUMAN_ROLLS.map((r)=> r.slice());
    bots.forEach((b, k)=>{ room.scriptedRolls[b.id] = BOT_ROLLS[k].map((r)=> r.slice()); });
    return { room, meId: me.id, botIds: bots.map((b)=> b.id) };
  }

  // В Node дальше не идём: всё ниже — тренер в браузере.
  if(typeof document === "undefined") return { buildRoom, SCRIPT };

  // --- Шаги --------------------------------------------------------------
  // count:false — промежуточные «Ходят боты…»: в счёт шагов не входят.
  const STEPS = [
    { id: "welcome", count: true },
    { id: "capital", count: true },
    { id: "board", count: true },
    { id: "roll", count: true },
    { id: "buy", count: true },
    { id: "end-turn", count: true },
    { id: "bots", count: true },
    { id: "refuse", count: true },
    { id: "bots-wait-2", count: false },
    { id: "estate", count: true },
    { id: "bots-wait-3", count: false },
    { id: "event", count: true },
    { id: "tabs", count: true },
    { id: "influence", count: true },
    { id: "finish", count: true },
  ];
  const IDX = {};
  STEPS.forEach((s, i)=>{ IDX[s.id] = i; });
  const COUNTED = STEPS.filter((s)=> s.count).length;

  const TEXT = {
    welcome: { title: "Добро пожаловать на биржу!",
      text: "Короткая партия против двух ботов — около трёх минут. Побеждает самый богатый или последний, кто не разорился." },
    capital: { title: "Ваш капитал",
      text: "Наличные плюс акции и недвижимость по текущим ценам — это капитал, по нему определяют победителя. Для старта у вас 55% NVIDIA." },
    board: { title: "Поле 12×12",
      text: "Клетка — компания, цвет — её отрасль, домик — город. Точка на клетке — цвет игрока, у которого больше 50%. На NVIDIA точка ваша." },
    roll: { title: "Бросок кубиков",
      text: "Два кубика по 12 граней: первый — строка, второй — столбец. Разыгрываете клетку на их пересечении." },
    buy: { title: "Выпала компания",
      text: "Выберите долю ползунком — сумма видна над ним. Покупка поднимает цену компании. Пояснения спрятаны под значком «?» — нажмите, если нужно." },
    "end-turn": { title: "Завершите ход",
      text: "В свой ход можно ещё продать акции, предложить сделку или применить спецдействия — во вкладках снизу. Сейчас передайте ход." },
    bots: { title: "Ходят соперники",
      text: "Метка «ход» — чей сейчас ход, рядом капитал каждого. Боты ходят сами, их бросок подсветится на поле." },
    // lead — до броска, text (+ sheet) — в листе, dock — после него, перед «Завершить ход».
    refuse: { title: "Чужая компания",
      lead: "Бросьте ещё раз — выпадет компания, у которой уже есть держатели.",
      text: "Не покупаете долю — платите держателям «плату за отказ», сумма на кнопке «Отказаться». Чем больше компании раскуплено, тем она дороже.",
      sheet: " Чьи это доли — скрыто: портфели раскрывает шпионаж.",
      dock: "Если у одного держателя больше 50%, плату за отказ назначает он сам." },
    "bots-wait-2": { title: "Ходят боты…", text: "Ходят боты…" },
    estate: { title: "Недвижимость",
      lead: "Последний бросок урока — выпадет город.",
      text: "Город покупают целиком. Соперник на вашем городе платит вам ренту. Попадёте сюда снова — улучшите город, и рента вырастет.",
      dock: "«Событие через…» вверху — сколько ходов осталось до биржевого события." },
    "bots-wait-3": { title: "Ходят боты…", text: "Ходят боты… Сейчас будет биржевое событие." },
    event: { title: "Биржевое событие",
      text: "Раз в несколько ходов кубик волатильности сдвигает цены и разыгрывается карта новостей." },
    tabs: { title: "Разделы партии",
      text: "Стол — ваш ход. Биржа — цены и графики. Портфель — акции, продажа, сделки и кредит. Влияние — спецдействия. Лента — история партии." },
    // Названия спецдействий — как на карточках вкладки «Влияние».
    influence: { title: "Контрольный пакет",
      text: "Больше 50% акций — контрольный пакет. Он открывает платные спецдействия: «PR-кампания» (+10% к цене), «Негативная информация» (−15% чужой), «Инсайд» и «Шорт». Только в ваш ход.",
      noControl: "Больше 50% акций — контрольный пакет: он открывает «PR-кампанию», «Негативную информацию», «Инсайд» и «Шорт». Сейчас у вас меньше половины NVIDIA — докупите долю.",
      notTurn: "Больше 50% акций — контрольный пакет: он открывает «PR-кампанию», «Негативную информацию», «Инсайд» и «Шорт». Они доступны в ваш ход — загляните сюда, когда он вернётся." },
    finish: { title: "Вы готовы к торгам!",
      text: "Держите запас наличных: плата за отказ и рента обязательны, при нехватке денег банк сам продаст ваши акции. Стремитесь к контролю в компаниях. Если что-то непонятно — нажмите «?» рядом." },
    // Партия кончилась раньше урока (банкротство): пройденным обучение не считаем.
    over: { title: "Учебная партия окончена",
      text: "Партия закончилась раньше урока — обучение не засчитано. Его можно пройти снова из главного меню." },
  };

  const ROLL_BTN = "#cornerAction .dock-main.roll-btn";
  const END_BTN = "#cornerAction .dock-main.end";
  const SHEET = "#contextPopup .popup-card";
  const LS_DONE = "tm_tutorial_done", LS_OFFERED = "tm_tutorial_offered";
  const CARD_W = 360;      // ширина карточки (на узком экране — во всю ширину)
  const SIDE_MIN_W = 220;  // сбоку от якоря карточка может быть поуже, но не уже
  const MIN_H = 96;        // меньше — место не годится даже с прокруткой
  const GAP = 12;          // от якоря до карточки (с запасом под «хвостик»)
  const PAD = 6;           // отверстие и кольцо — вокруг якоря с этим отступом
  const EDGE = 12;         // от краёв экрана (плюс безопасные зоны)
  const SHEET_DELAY = 750; // лист броска въезжает, кости докручиваются (anim.js)
  const DOCK_DELAY = 450;  // «Завершить ход» глотает тапы столько же (dockArmedAt)
  const FOLLOW_MS = 900;   // столько после смены шага следим за якорем каждый кадр
  // Предпочтение мест: рядом с якорем лучше, чем у края экрана.
  const SIDE_COST = { center: 0, below: 0, above: 40, right: 80, left: 120, top: 300, bottom: 340 };
  // Бонус месту, которое карточка уже заняла на этом шаге: без него при почти
  // равных оценках она перепрыгивала (справа ↔ снизу) на каждом обновлении,
  // и тап по «Далее» попадал в клетку поля под ней.
  const STICKY_BONUS = 400;

  // --- Состояние тренера -------------------------------------------------
  let active = false;
  let idx = 0;
  let meId = null;
  let entryId = "btnGoTutorial";
  let released = false;     // «Смотреть ходы» на шаге «bots»: боты пошли
  let finishPassed = false; // финал — дошли до конца урока (а не банкротство или конец партии)
  let confirmShown = false; // «Выйти из обучения?»
  let expanded = false;     // «Подробнее» в компактной карточке
  let nvdaStart = 0;
  let phaseKey = "";        // шаг + фаза хода + бросок: смена — новая инструкция
  let lastSide = "", lastSideKey = "", stickySide = ""; // где стояла карточка на этом шаге
  let lockedPlace = null;   // {key, res}: место карточки, закреплённое после того, как якорь доехал
  let stepAnnounce = false; // при следующей смене фазы объявить шаг целиком
  let revealAt = 0;         // до этого момента карточка ждёт (лист въезжает)
  let followUntil = 0;
  let pendingFocus = false;
  let miniFallback = false; // вместо карточки показана плашка (карточке не нашлось места)
  let quietSay = "";        // объявление шага, отложенное до показа карточки (см. sayInstruction)
  let focusIntent = null;   // "card" | "target" — что вернуть после пересборки панели
  let curTarget = null;     // элемент, который сейчас просят нажать
  let scrolledKeys = new Set();
  let sheetMemo = null;     // {key, ticker, held} — купил ли игрок на «Чужой компании»
  let cardKey = "";
  const heightCache = new Map();
  let dom = null;
  let raf = 0, tickTimer = null, revealTimer = null, reducedTimer = null, liveTimer = null;
  let observers = [];
  let offerSession = null;  // предложение в меню: null — в этой сессии ещё не решали

  function lsGet(k){ try { return localStorage.getItem(k); } catch(e){ return null; } }
  function lsSet(k, v){ try { localStorage.setItem(k, v); } catch(e){} }
  function isDone(){ return lsGet(LS_DONE) === "1"; }
  function isReduced(){
    return window.Anim ? Anim.reduced() : document.body.classList.contains("reduce-motion");
  }
  const byId = (id)=> document.getElementById(id);
  function shown(id){ const el = byId(id); return !!el && !!el.style.display && el.style.display !== "none"; }
  function appVisible(){ const el = byId("app"); return !!el && el.style.display === "block"; }
  function gameMenuOpen(){ const el = byId("gameMenuPanel"); return !!el && el.classList.contains("open"); }
  function visibleEl(el){ return !!el && el.isConnected && el.getClientRects().length > 0; }
  // Первый видимый из списка селекторов (или функций, возвращающих элемент).
  function pick(list){
    for(const sel of list){
      const el = typeof sel === "function" ? sel() : document.querySelector(sel);
      if(visibleEl(el)) return el;
    }
    return null;
  }
  function all(sel){ return Array.from(document.querySelectorAll(sel)).filter(visibleEl); }
  function rectOf(el){
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }
  function pad(r, p){ return { left: r.left - p, top: r.top - p, right: r.right + p, bottom: r.bottom + p }; }
  function overlap(a, b){
    const ax2 = a.right != null ? a.right : a.x + a.w, ay2 = a.bottom != null ? a.bottom : a.y + a.h;
    const ax1 = a.left != null ? a.left : a.x, ay1 = a.top != null ? a.top : a.y;
    const w = Math.min(ax2, b.right) - Math.max(ax1, b.left);
    const h = Math.min(ay2, b.bottom) - Math.max(ay1, b.top);
    return w > 0 && h > 0 ? w * h : 0;
  }

  // --- Состояние партии и самый ранний ещё не пройденный шаг ---------------
  // «Сколько бросков из сценария человек уже сделал» — надёжная отметка
  // фазы: endTurn без броска движок не принимает, так что каждый ход человека
  // тратит ровно один бросок.
  function readState(){
    const s = latest;
    const q = localRoom && localRoom.scriptedRolls ? localRoom.scriptedRolls[meId] : null;
    const used = HUMAN_ROLLS.length - (Array.isArray(q) ? q.length : 0);
    const me = s && s.players ? s.players.find((p)=> p.id === meId) : null;
    const myTurn = !!s && s.phase === "roll" && s.currentPlayerId === meId;
    return {
      s, me, used, myTurn,
      rolled: myTurn && !!s.rolledThisTurn,
      pending: !!(s && s.pendingRoll && s.pendingRoll.playerId === meId),
      ev: s ? (s.eventCount || 0) : 0,
      eventOpen: shown("marketEventOverlay"),
      over: !!s && (s.phase === "ended" || !me || me.bankrupt),
    };
  }
  function minStep(st){
    if(!st.s) return 0;
    if(st.over) return IDX.finish;
    if(st.ev >= 1) return st.eventOpen ? IDX.event : IDX.tabs;
    if(st.used <= 0) return st.pending || st.rolled ? IDX.buy : IDX.welcome;
    if(st.used === 1){
      if(!st.myTurn) return IDX.bots;
      return st.pending ? IDX.buy : st.rolled ? IDX["end-turn"] : IDX.refuse;
    }
    if(st.used === 2){
      if(!st.myTurn) return IDX["bots-wait-2"];
      return st.rolled ? IDX.refuse : IDX.estate;
    }
    return st.myTurn ? IDX.estate : IDX["bots-wait-3"];
  }
  function countedIndex(){
    let n = 0;
    for(let i = 0; i <= idx; i++) if(STEPS[i].count) n++;
    return Math.max(1, n);
  }
  function rollKey(st){
    const r = st.s && st.s.pendingRoll;
    return r ? `${r.playerId}-${r.row}-${r.col}` : "";
  }

  // --- Что показать на текущем шаге ---------------------------------------
  // card: заголовок, текст, «Сейчас: …», кнопка, якорь (отверстие и кольцо),
  // also (дополнительные кольца), pulse (кнопка, которую просят нажать),
  // target (куда поставить фокус), dim (full/soft/off), phase и delay
  // (въезд листа / закрытие листа), cover:false — карточке нельзя ложиться
  // поверх якоря, даже когда рядом с ним нет места. mini: плашка без затемнения.
  function viewFor(step, st){
    const T = TEXT[step.id];
    const card = (o)=> Object.assign({ kind: "card", title: T.title, text: T.text, doText: "", next: null, skip: true,
      anchor: null, also: [], pulse: null, target: null, dim: "full", ring: true, cover: true, phase: "", rollKey: "", delay: 0 }, o);
    const rail = ()=> pick(["#cornerRating .players-rail", "#cornerRating"]);
    switch(step.id){
      case "welcome":
        return card({ next: { label: "Начнём" } });
      case "capital":
        return card({ next: { label: "Далее" }, anchor: pick(["#cornerCapital .cap-strip", "#cornerCapital"]) });
      case "board":
        return card({ next: { label: "Далее" }, anchor: pick(["#tableBody .stage-board"]),
          also: all('#tableBody .stage-cell[data-ticker="NVDA"]') });
      case "roll": {
        const b = pick([ROLL_BTN]);
        return card({ dim: "soft", anchor: b, pulse: b, target: b, doText: "нажмите «Бросить кубики»." });
      }
      case "buy": {
        const roll = st.s && st.s.pendingRoll;
        const c = roll && roll.ticker ? st.s.companies.find((x)=> x.ticker === roll.ticker) : null;
        const title = roll ? `Строка ${roll.row}, столбец ${roll.col}${c ? " — " + c.name : ""}` : T.title;
        const free = c ? c.owned < 0.5 : false;
        const text = (c ? (free ? `Акции ${c.name} пока у банка — их можно купить. ` : `Долю ${c.name} можно купить у банка. `) : "") + T.text;
        return card({ title, text, dim: "soft", anchor: pick([SHEET]), also: all("#tableBody .stage-cell.active-cell").concat(all("#contextPopup .hint-q")),
          target: pick(["#rpBuySlider", "#contextPopup .sheet-actions button"]), doText: "выберите долю и нажмите «Купить».",
          phase: "sheet", rollKey: rollKey(st), delay: "sheet" });
      }
      case "end-turn": {
        const b = pick([END_BTN]);
        return card({ dim: "soft", anchor: b, pulse: b, target: b, doText: "нажмите «Завершить ход».", phase: "dock", delay: "dock" });
      }
      case "bots":
        if(released) return { kind: "mini", text: "Ходят боты…", spinner: true, anchor: rail() };
        return card({ anchor: rail(), next: { label: "Смотреть ходы" } });
      case "bots-wait-2":
      case "bots-wait-3":
        // Ход вернулся к человеку раньше сценария (соперников стало меньше) —
        // не «Ходят боты…», а что делать самому.
        if(st.myTurn) return { kind: "mini", text: "Ваш ход: бросьте кубики и завершите ход.", anchor: rail(), phase: "mine" };
        return { kind: "mini", text: T.text, spinner: true, anchor: rail() };
      case "refuse":
      case "estate":
        return turnView(step.id, st, card);
      case "event": {
        const log = (st.s && st.s.log) || [];
        const hit = log.some((e)=> e.tag === "news" && String(e.text).indexOf(NEWS_TITLE) >= 0);
        const nv = st.s ? st.s.companies.find((c)=> c.ticker === "NVDA") : null;
        const rose = !!nv && nvdaStart > 0 && nv.price > nvdaStart * 1.02;
        // Карту задаёт сценарий, но игрок с контролем мог отложить её инсайдом —
        // тогда о «Технологическом прорыве» не говорим. Итог — в «Сейчас: …»:
        // он виден и в компактной карточке.
        const doText = hit
          ? `выпал «${NEWS_TITLE}»: Технологии +20%${rose ? ", и ваша NVIDIA подорожала" : ""}. Нажмите «Продолжить».`
          : "посмотрите, какая карта выпала и как изменились цены, и нажмите «Продолжить».";
        return card({ anchor: pick(["#marketEventModalCard"]), dim: "off", ring: false, cover: false, doText });
      }
      case "tabs":
        // Панель хода здесь не нужна — карточка может встать прямо над вкладками.
        return card({ next: { label: "Далее" }, anchor: pick(["#stageTabbar .tab-bar"]), dockFree: true,
          dim: activeTab === "turn" ? "full" : "soft" });
      case "influence": {
        const me = st.me;
        const controls = !!me && Object.keys(me.holdings || {}).some((t)=> me.holdings[t] > 50);
        const text = !controls ? T.noControl : !st.myTurn ? T.notTurn : T.text;
        if(activeTab !== "control"){
          const b = pick(['.tab-btn[data-tab="control"]']);
          // «Далее» нет, пока вкладка закрыта: серая кнопка рядом с «откройте вкладку» выглядела сломанной.
          return card({ text, anchor: b, pulse: b, target: b, dockFree: true, doText: "откройте вкладку «Влияние».",
            phase: "closed" });
        }
        const pr = byId("prBtn");
        const anchor = pick([()=> pr && pr.closest(".control-card"), "#controlBody .control-card:not(.alert)", "#controlBody .influence-note", "#controlBody"]);
        return card({ text, anchor, dim: "soft", next: { label: "Далее" }, phase: "open",
          doText: controls && st.myTurn ? "посмотрите спецдействия (ниже — шпионаж и личный PR) и нажмите «Далее»." : "нажмите «Далее»." });
      }
      case "finish":
        if(!finishPassed) return card({ title: TEXT.over.title, text: TEXT.over.text, finish: true, over: true, skip: false });
        return card({ finish: true, skip: false });
    }
    return card({});
  }
  // «Чужая компания» и «Недвижимость»: одна карточка на весь ход — бросок,
  // лист, «Завершить ход»; отверстие едет за видимым якорем. Текст у каждой
  // фазы свой: до броска — что выпадет (lead), в листе — правило (text),
  // перед «Завершить ход» — короткое дополнение (dock).
  function turnView(id, st, card){
    const T = TEXT[id];
    if(st.pending){
      const s = st.s, roll = s.pendingRoll, key = rollKey(st);
      if(id === "refuse" && roll.ticker && (!sheetMemo || sheetMemo.key !== key)){
        sheetMemo = { key, ticker: roll.ticker, held: st.me ? (st.me.holdings[roll.ticker] || 0) : 0 };
      }
      const btn = id === "refuse"
        ? pick(['#contextPopup button[onclick*="dividendFromRoll"]'])
        : pick(['#contextPopup button[onclick*="doBuyRealEstateFromRoll"]']);
      return card({ text: T.text + (id === "refuse" ? T.sheet : ""), dim: "soft", anchor: pick([SHEET]),
        pulse: btn, target: btn || pick(["#contextPopup .sheet-actions button"]),
        doText: btn ? (id === "refuse" ? "нажмите «Отказаться»." : "нажмите «Купить».") : "выберите действие в листе снизу.",
        phase: "sheet", rollKey: key, delay: "sheet" });
    }
    if(st.rolled){
      const b = pick([END_BTN]);
      let doText;
      if(id === "refuse"){
        const me = st.me;
        const bought = !!(sheetMemo && me && (me.holdings[sheetMemo.ticker] || 0) > sheetMemo.held);
        doText = bought ? "вы купили долю — платить за отказ не нужно. Нажмите «Завершить ход»."
          : "плата ушла держателям. Нажмите «Завершить ход».";
      } else {
        doText = "нажмите «Завершить ход» — после ботов будет биржевое событие.";
      }
      // «Недвижимость»: кольцо на «Событие через…» — о нём и говорит T.dock.
      const also = id === "estate" ? all("#cornerStatus .g-sub") : [];
      return card({ text: T.dock, dim: "soft", anchor: b, pulse: b, target: b, also, doText, phase: "dock", delay: "dock" });
    }
    const b = pick([ROLL_BTN]);
    return card({ text: T.lead, dim: "soft", anchor: b, pulse: b, target: b, doText: "нажмите «Бросить кубики».", phase: "roll" });
  }
  // Пауза: открыт слой, который шагу не нужен (карточка компании, меню партии,
  // вкладка поверх стола) — затемнение и кольца прячем, карточку сворачиваем.
  function needsPause(step, v){
    if(v.kind !== "card" || step.id === "finish") return false;
    if(shown("companyModalOverlay") || gameMenuOpen()) return true;
    return activeTab !== "turn" && step.id !== "tabs" && step.id !== "influence";
  }

  // --- Переходы ------------------------------------------------------------
  function sync(){
    if(!active) return;
    // Учебную комнату заменило что-то другое — тихо выключаемся.
    if(mode !== "offline" || !localRoom || !localRoom.tutorial){ teardown(); return; }
    const m = minStep(readState());
    if(m > idx) goTo(m);
    maybeRelease();
    requestUpdate();
  }
  // passed — переход сделан «Далее» с последнего шага урока (см. enterFinish).
  function goTo(i, passed){
    idx = Math.min(i, STEPS.length - 1);
    released = false;
    expanded = false;
    scrolledKeys = new Set();
    phaseKey = "";
    lockedPlace = null;
    stepAnnounce = true;
    pendingFocus = true;
    followUntil = performance.now() + FOLLOW_MS;
    if(STEPS[idx].id === "finish") enterFinish(!!passed);
  }
  // Пройденным обучение считаем, только если игрок дошёл до конца урока.
  // Финал из-за конца партии (банкротство) — своя карточка, без отметки.
  function enterFinish(passed){
    finishPassed = passed;
    if(passed) lsSet(LS_DONE, "1");
    if(gameMenuOpen()) closeGameMenu();
    if(activeTab !== "turn") switchTab("turn");
    renderMenuEntry();
  }
  function onNext(){
    if(!active) return;
    const id = STEPS[idx].id;
    if(id === "bots"){
      released = true;
      maybeRelease();
      requestUpdate();
      return;
    }
    if(id === "influence" && activeTab !== "control") return; // «Далее» нет, пока вкладка закрыта
    const st = readState();
    goTo(Math.max(idx + 1, minStep(st)), id === "influence" && !st.over);
    maybeRelease();
    requestUpdate();
  }
  // Боты стоят, пока игрок читает. Снятие паузы — сразу толкаем цепочку ботов
  // (scheduleBotPump сам ничего не делает, если таймер уже стоит или ботам нечего делать).
  function holdBots(){
    if(!active) return false;
    if(confirmShown) return true;
    const id = STEPS[idx].id;
    if(id === "bots") return !released;
    if(id === "bots-wait-2" || id === "bots-wait-3") return false;
    // Игрок успел бросить и завершить ход — ход должен к нему вернуться.
    if(id === "tabs" || id === "influence") return !!localRoom && GameEngine.currentPlayerId(localRoom) === meId;
    return true;
  }
  function maybeRelease(){
    if(active && !holdBots() && mode === "offline") scheduleBotPump();
  }

  // --- Отрисовка тренера ---------------------------------------------------
  function requestUpdate(){ if(active && !raf) raf = requestAnimationFrame(update); }
  function update(){
    raf = 0;
    if(!active || !dom) return;
    try { draw(); } catch(e){ console.error(e); }
  }
  function draw(){
    if(!appVisible()){ dom.root.hidden = true; return; }
    dom.root.hidden = false;
    const now = performance.now();
    const reduced = isReduced();
    const st = readState();
    const step = STEPS[idx];
    // Сводке события оставляем место под карточку (styles.css, body.coach-event).
    // Класс ставим уже на «Ходят боты…» перед событием: сводка сразу
    // открывается нужной высоты, а не сжимается после переворота.
    document.body.classList.toggle("coach-event", step.id === "event" || step.id === "bots-wait-3");
    let v = viewFor(step, st);
    const paused = !confirmShown && needsPause(step, v);
    if(paused) v = { kind: "mini", text: "Обучение ждёт за столом", back: true };
    // Новая инструкция (шаг, фаза хода, бросок): объявить, придержать карточку,
    // пока въезжает лист, перенести фокус. Пауза инструкцию не меняет.
    if(!paused){
      const key = step.id + ":" + (v.phase || "") + ":" + (v.rollKey || "") + ":" + (v.kind === "mini" ? "m" : "c");
      if(key !== phaseKey){
        phaseKey = key;
        // Задержка — не только ради анимации: «Завершить ход» и кнопки листа
        // первые 450/400 мс глотают тапы (dockArmedAt, popupArmedAt в index.html),
        // поэтому и при сокращённых анимациях пульс не зовёт нажать раньше.
        const delay = v.delay === "dock" ? DOCK_DELAY : v.delay === "sheet" ? (reduced ? 400 : SHEET_DELAY) : 0;
        revealAt = now + delay;
        followUntil = Math.max(followUntil, revealAt + FOLLOW_MS);
        pendingFocus = true;
        sayInstruction(v, stepAnnounce);
        stepAnnounce = false;
        if(delay){ clearTimeout(revealTimer); revealTimer = setTimeout(requestUpdate, delay + 20); }
      }
    }
    curTarget = v.target || null;
    if(!confirmShown && now < revealAt){ hideVisuals(); follow(now, reduced); return; }
    stickySide = lastSideKey === phaseKey + (confirmShown ? ":confirm" : "") ? lastSide : "";
    const box = viewBox();
    if(confirmShown || v.kind === "card"){
      const cv = confirmShown ? Object.assign({}, v.kind === "card" ? v : { title: "", text: "" }, { kind: "card", anchor: null, also: [], pulse: null }) : v;
      fillCard(cv);
      const anchor = cv.anchor;
      if(anchor) ensureVisible(anchor);
      const A = anchor ? pad(rectOf(anchor), PAD) : null;
      const alsoRects = cv.also.map((el)=> pad(rectOf(el), 3));
      const soft = softObstacles(anchor, cv.dockFree);
      let res = placeCard(A, box, soft, alsoRects);
      // Якорь только показывают (нажимать его не просят), а рядом с ним карточка
      // не помещается целиком (поле на телефоне в ландшафте занимает всю высоту) —
      // пусть ляжет поверх якоря у верхнего или нижнего края, если так она
      // прячет меньше. Сам якорь — как дополнительное кольцо: штраф за перекрытие.
      if(A && cv.cover !== false && !cv.pulse && !cv.target && !confirmShown && (!res || res.c.h < res.c.hNat)){
        const over = placeCard(null, box, soft, alsoRects.concat([A]), true);
        if(over && (!res || over.c.hNat - over.c.h < res.c.hNat - res.c.h)) res = over;
      }
      // Когда якорь доехал (followUntil), карточка на этом шаге больше не
      // переезжает, пока прежнее место годится: иначе при почти равных
      // вариантах она прыгала через пару секунд, и тап по «Далее» уходил в поле.
      const placeKey = phaseKey + (confirmShown ? ":confirm" : "") + (A ? ":a" : ":n");
      if(lockedPlace && lockedPlace.key === placeKey && placeStillFits(lockedPlace.res, A, box)) res = lockedPlace.res;
      else if(res && now >= followUntil) lockedPlace = { key: placeKey, res };
      miniFallback = !res;
      if(res){
        applyCard(res, A);
        hideEl(dom.mini);
        quietSay = ""; // фокус уйдёт в карточку — диалог прочтёт диктор
      } else {
        // Места под карточку нет нигде — остаётся плашка с инструкцией (тоже мимо
        // якоря). Кнопку шага плашка не теряет: без «Далее» шаг-чтение был бы тупиком.
        hideEl(dom.card);
        showMini({ text: cv.doText ? "Сейчас: " + cv.doText : cv.title, avoid: A,
          next: cv.next && !cv.next.disabled ? cv.next.label : null }, box, soft);
        if(quietSay){ announce(quietSay); quietSay = ""; }
      }
      setDim(confirmShown ? "soft" : cv.dim, A && cv.dim !== "off" && !confirmShown ? [A] : []);
      setRings(confirmShown || cv.ring === false ? [] : ringsFor(A, alsoRects, cv));
    } else {
      miniFallback = false;
      hideEl(dom.card);
      showMini(v, box, softObstacles(null));
      setDim("off", []);
      setRings([]);
    }
    focusStep(v);
    follow(now, reduced);
  }
  // Первые ~900 мс после смены шага якорь ещё едет (въезд листа, прокрутка,
  // «Ваш ход») — пересчитываем каждый кадр; при сокращённых анимациях — один
  // лишний замер через 100 мс.
  function follow(now, reduced){
    if(now >= followUntil) return;
    if(reduced){
      followUntil = 0;
      clearTimeout(reducedTimer);
      reducedTimer = setTimeout(requestUpdate, 100);
      return;
    }
    requestUpdate();
  }
  function placeStillFits(res, A, box){
    const c = res.c;
    if(c.x < box.left - 1 || c.x + c.w > box.right + 1 || c.y < box.top - 1 || c.y + c.h > box.bottom + 1) return false;
    // Карточка поверх якоря (у верхнего/нижнего края) ставится так намеренно.
    if(A && c.side !== "top" && c.side !== "bottom" && overlap(c, A) > 0) return false;
    return true;
  }
  function hideVisuals(){
    hideEl(dom.card);
    hideEl(dom.mini);
    setDim("off", []);
    setRings([]);
  }
  function hideEl(el){ el.classList.remove("on"); }

  // Безопасные зоны (вырез, панель жестов) — из тех же переменных, что у стола.
  function safeInsets(){
    const cs = getComputedStyle(dom.probe);
    return { t: parseFloat(cs.paddingTop) || 0, r: parseFloat(cs.paddingRight) || 0,
      b: parseFloat(cs.paddingBottom) || 0, l: parseFloat(cs.paddingLeft) || 0 };
  }
  // Где можно ставить карточку: экран без безопасных зон и без панели вкладок.
  function viewBox(){
    const W = document.documentElement.clientWidth || window.innerWidth;
    const H = window.innerHeight;
    const sf = safeInsets();
    let bottom = H - sf.b - EDGE;
    const tb = byId("stageTabbar");
    if(visibleEl(tb)){ const r = tb.getBoundingClientRect(); if(r.top > H / 2) bottom = Math.min(bottom, r.top - 8); }
    return { left: sf.l + EDGE, top: sf.t + EDGE, right: W - sf.r - EDGE, bottom, W, H, safeTop: sf.t };
  }
  // Что карточке лучше не закрывать: уведомления, кнопка меню, панель хода,
  // нижний лист, открытая карточка компании и меню партии.
  function softObstacles(anchor, dockFree){
    const out = [];
    const add = (el)=>{
      if(!visibleEl(el)) return;
      if(anchor && (el.contains(anchor) || anchor.contains(el))) return;
      out.push(rectOf(el));
    };
    document.querySelectorAll("#toastStack .toast-item").forEach((t)=>{ if(!t._dismissed) add(t); });
    add(byId("btnGameMenu"));
    if(!dockFree) add(document.querySelector("#cornerAction > *"));
    add(document.querySelector(SHEET));
    if(shown("companyModalOverlay")) add(byId("companyModalCard"));
    if(gameMenuOpen()) add(byId("gameMenuPanel"));
    return out;
  }
  // Якорь в прокручиваемой сцене (.stage) или вкладке (.overlay-panel) и не
  // виден — один раз на шаг докручиваем его в центр. Дальше прокрутку игрока
  // не трогаем. Закреплённые (fixed) панель хода и лист не прокручиваются.
  function scrollHost(el){
    for(let n = el; n && n !== document.body; n = n.parentElement){
      if(n.classList && (n.classList.contains("stage") || n.classList.contains("overlay-panel"))) return n;
      if(getComputedStyle(n).position === "fixed") return null;
    }
    return null;
  }
  function ensureVisible(el){
    const key = phaseKey + ":" + (el.id || el.className);
    if(scrolledKeys.has(key)) return;
    scrolledKeys.add(key);
    if(!scrollHost(el)) return;
    const box = viewBox();
    let bottom = box.bottom;
    const dock = byId("cornerAction");
    if(dock && dock.firstElementChild && getComputedStyle(dock).position === "fixed") bottom = Math.min(bottom, dock.getBoundingClientRect().top - 8);
    const sheet = document.querySelector(SHEET);
    if(visibleEl(sheet) && !sheet.contains(el)) bottom = Math.min(bottom, sheet.getBoundingClientRect().top - 8);
    const top = box.safeTop + 8;
    const r = el.getBoundingClientRect();
    if(r.top >= top && r.bottom <= bottom) return;
    const opts = { block: r.bottom - r.top > bottom - top ? "start" : "center", inline: "nearest", behavior: isReduced() ? "auto" : "smooth" };
    try { el.scrollIntoView(opts); } catch(e){ el.scrollIntoView(); }
  }

  // Места-кандидаты вокруг якоря A (под, над, справа, слева) и полосы у краёв
  // экрана. Отверстие якоря закрывать нельзя; дополнительные кольца,
  // уведомления и панели — штраф; урезанная высота (прокрутка) — тоже штраф.
  // edges — без якоря только полосы у краёв (плашка паузы не встаёт посреди
  // карточки компании; карточка поверх якоря, которому не хватило места рядом).
  function layout(A, box, wFull, hAt, soft, also, sideMin, edges){
    const list = [];
    const hFull = hAt(wFull);
    const clampX = (x, w)=> Math.max(box.left, Math.min(box.right - w, x));
    const clampY = (y, h)=> Math.max(box.top, Math.min(box.bottom - h, y));
    const fullH = Math.min(hFull, box.bottom - box.top);
    if(!A && edges){
      const x = clampX((box.left + box.right - wFull) / 2, wFull);
      list.push({ side: "top", x, y: box.top, w: wFull, h: fullH, hNat: hFull });
      list.push({ side: "bottom", x, y: box.bottom - fullH, w: wFull, h: fullH, hNat: hFull });
    } else if(!A){
      list.push({ side: "center", x: clampX((box.left + box.right - wFull) / 2, wFull), y: clampY((box.top + box.bottom - fullH) / 2, fullH), w: wFull, h: fullH, hNat: hFull });
    } else {
      const cx = (A.left + A.right) / 2, cy = (A.top + A.bottom) / 2;
      let avail = box.bottom - (A.bottom + GAP);
      if(avail > 0){ const h = Math.min(hFull, avail); list.push({ side: "below", x: clampX(cx - wFull / 2, wFull), y: A.bottom + GAP, w: wFull, h, hNat: hFull }); }
      avail = A.top - GAP - box.top;
      if(avail > 0){ const h = Math.min(hFull, avail); list.push({ side: "above", x: clampX(cx - wFull / 2, wFull), y: A.top - GAP - h, w: wFull, h, hNat: hFull }); }
      [["right", box.right - (A.right + GAP)], ["left", A.left - GAP - box.left]].forEach(([side, space])=>{
        if(space < sideMin) return;
        const w = Math.min(wFull, space);
        const hN = w === wFull ? hFull : hAt(w);
        const h = Math.min(hN, box.bottom - box.top);
        list.push({ side, x: side === "right" ? A.right + GAP : A.left - GAP - w, y: clampY(cy - h / 2, h), w, h, hNat: hN });
      });
      list.push({ side: "top", x: clampX(cx - wFull / 2, wFull), y: box.top, w: wFull, h: fullH, hNat: hFull });
      list.push({ side: "bottom", x: clampX(cx - wFull / 2, wFull), y: box.bottom - fullH, w: wFull, h: fullH, hNat: hFull });
    }
    let best = null;
    list.forEach((c)=>{
      if(c.h < Math.min(c.hNat, MIN_H)) return;
      if(c.x < box.left - 1 || c.x + c.w > box.right + 1 || c.y < box.top - 1 || c.y + c.h > box.bottom + 1) return;
      if(A && overlap(c, A) > 0) return;
      let score = SIDE_COST[c.side] + (c.hNat - c.h) * 30 - (stickySide && c.side === stickySide ? STICKY_BONUS : 0);
      also.forEach((r)=>{ score += overlap(c, r) * 0.6; });
      soft.forEach((r)=>{ score += overlap(c, r) * 0.25; });
      if(!best || score < best.score){ c.score = score; best = c; }
    });
    return best;
  }
  function measureCard(w, compact){
    const k = Math.round(w) + ":" + (compact ? 1 : 0);
    if(heightCache.has(k)) return heightCache.get(k);
    dom.card.classList.toggle("compact", compact);
    dom.card.style.width = Math.round(w) + "px";
    dom.inner.style.maxHeight = "none";
    const h = dom.card.offsetHeight;
    heightCache.set(k, h);
    return h;
  }
  // Сначала полная карточка; не влезает целиком — компактная (заголовок,
  // «Сейчас» и кнопки, текст — за «Подробнее»); дальше — с прокруткой внутри.
  // Не влезают обе — та, что прячет под прокрутку меньше: иначе полная карточка
  // показала бы только заголовок, а «Сейчас: …» и кнопки ушли бы вниз.
  // edges — без якоря: только полосы у верхнего и нижнего края (см. layout).
  function placeCard(A, box, soft, also, edges){
    const wFull = Math.min(CARD_W, box.right - box.left);
    const full = layout(A, box, wFull, (w)=> measureCard(w, false), soft, also, SIDE_MIN_W, edges);
    if(full && full.h >= full.hNat) return { c: full, compact: false };
    if(!expanded && !confirmShown){
      const comp = layout(A, box, wFull, (w)=> measureCard(w, true), soft, also, SIDE_MIN_W, edges);
      if(comp && (comp.h >= comp.hNat || !full || comp.hNat - comp.h <= full.hNat - full.h)) return { c: comp, compact: true };
    }
    return full ? { c: full, compact: false } : null;
  }
  function applyCard(res, A){
    const c = res.c, card = dom.card;
    const wasHidden = !card.classList.contains("on");
    card.classList.toggle("compact", res.compact);
    card.style.width = Math.round(c.w) + "px";
    dom.inner.style.maxHeight = Math.max(40, Math.floor(c.h) - 2) + "px";
    // Из скрытого состояния — сразу на место, без проезда через экран.
    if(wasHidden) card.style.transition = "none";
    card.style.left = Math.round(c.x) + "px";
    card.style.top = Math.round(c.y) + "px";
    lastSide = c.side; lastSideKey = phaseKey + (confirmShown ? ":confirm" : "");
    const side = A && (c.side === "below" || c.side === "above" || c.side === "left" || c.side === "right") ? c.side : "";
    if(card.dataset.side !== side) card.dataset.side = side;
    if(side === "below" || side === "above"){
      dom.caret.style.left = Math.round(Math.max(18, Math.min(c.w - 18, (A.left + A.right) / 2 - c.x)) - 7) + "px";
      dom.caret.style.top = "";
    } else if(side){
      dom.caret.style.top = Math.round(Math.max(18, Math.min(c.h - 18, (A.top + A.bottom) / 2 - c.y)) - 7) + "px";
      dom.caret.style.left = "";
    }
    if(wasHidden){ void card.offsetWidth; card.style.transition = ""; }
    card.classList.add("on");
  }
  function showMini(v, box, soft){
    fillMini(v);
    const pill = dom.mini;
    pill.style.maxWidth = Math.max(160, box.right - box.left) + "px";
    // Мерим от левого края: ширина fixed-плашки зависит от места справа от неё,
    // и с прошлой позиции перенос строк (узкий экран) получился бы другим.
    pill.style.left = box.left + "px";
    const w = pill.offsetWidth, h = pill.offsetHeight;
    const A = v.avoid || (v.anchor && visibleEl(v.anchor) ? pad(rectOf(v.anchor), PAD) : null);
    const c = layout(A, box, w, ()=> h, soft, [], w, true) || { x: (box.left + box.right - w) / 2, y: box.top };
    pill.style.left = Math.round(c.x) + "px";
    pill.style.top = Math.round(c.y) + "px";
    pill.classList.add("on");
  }

  // Затемнение — SVG с маской: белый прямоугольник на весь экран и чёрные
  // скруглённые отверстия под якорем.
  function setDim(modeName, holes){
    const svg = dom.dim;
    // Из выключенного затемнения отверстие появляется сразу на месте, а не
    // вырастает из угла экрана (переход x/y/width/height в styles.css).
    const appear = !svg.classList.contains("on") && modeName !== "off";
    if(appear) svg.classList.add("coach-instant");
    svg.classList.toggle("on", modeName !== "off");
    svg.classList.toggle("soft", modeName === "soft");
    const rects = dom.holes;
    while(rects.length < holes.length){
      const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      r.setAttribute("class", "coach-hole");
      r.setAttribute("fill", "#000");
      dom.mask.appendChild(r);
      rects.push(r);
    }
    rects.forEach((r, i)=>{
      const h = holes[i];
      const g = h ? [Math.round(h.left), Math.round(h.top), Math.round(h.right - h.left), Math.round(h.bottom - h.top)] : [0, 0, 0, 0];
      const key = g.join(",");
      if(r._g === key) return;
      r._g = key;
      r.setAttribute("x", g[0]); r.setAttribute("y", g[1]);
      r.setAttribute("width", Math.max(0, g[2])); r.setAttribute("height", Math.max(0, g[3]));
      const rx = Math.min(14, Math.max(0, Math.min(g[2], g[3]) / 2));
      r.setAttribute("rx", rx); r.setAttribute("ry", rx);
    });
    if(appear){ void svg.getBoundingClientRect(); svg.classList.remove("coach-instant"); }
  }
  function ringsFor(A, alsoRects, v){
    const list = [];
    const pulseSame = !!v.pulse && v.pulse === v.anchor;
    if(A) list.push({ r: A, cls: "coach-ring" + (pulseSame ? " pulse" : "") });
    alsoRects.forEach((r)=> list.push({ r, cls: "coach-ring also" }));
    if(v.pulse && !pulseSame && visibleEl(v.pulse)) list.push({ r: pad(rectOf(v.pulse), 4), cls: "coach-ring pulse" });
    return list;
  }
  function setRings(list){
    const box = dom.rings;
    while(box.children.length < list.length){ const d = document.createElement("div"); box.appendChild(d); }
    Array.from(box.children).forEach((d, i)=>{
      const it = list[i];
      if(!it){ if(d.className !== "coach-ring off") d.className = "coach-ring off"; return; }
      // Новое кольцо — сразу на место, без проезда от прежнего якоря (из display:none
      // перехода и так нет, но кольцо могло «переехать» к другому якорю за один кадр).
      const appear = d.className === "coach-ring off" || !d.className;
      if(d.className !== it.cls) d.className = it.cls;
      const w = it.r.right - it.r.left, h = it.r.bottom - it.r.top;
      const key = [Math.round(it.r.left), Math.round(it.r.top), Math.round(w), Math.round(h)].join(",");
      if(d._g === key) return;
      d._g = key;
      if(appear) d.style.transition = "none";
      d.style.left = Math.round(it.r.left) + "px";
      d.style.top = Math.round(it.r.top) + "px";
      d.style.width = Math.round(w) + "px";
      d.style.height = Math.round(h) + "px";
      d.style.borderRadius = Math.round(Math.min(it.cls.indexOf("also") >= 0 ? 9 : 14, Math.min(w, h) / 2)) + "px";
      if(appear){ void d.offsetWidth; d.style.transition = ""; }
    });
  }

  // Содержимое карточки — только когда оно изменилось (иначе каждый кадр
  // заново собирались бы узлы и сбивалось бы чтение экранного диктора).
  function fillCard(v){
    const key = [idx, confirmShown ? 1 : 0, v.title, v.text, v.doText, v.next ? v.next.label + (v.next.disabled ? "!" : "") : "",
      v.finish ? (v.over ? 2 : 1) : 0, v.skip === false ? 0 : 1].join("\u0001");
    if(key === cardKey) return;
    cardKey = key;
    heightCache.clear();
    const n = countedIndex();
    dom.stepLabel.textContent = `Обучение · шаг ${n} из ${COUNTED}`;
    Array.from(dom.bar.children).forEach((seg, i)=> seg.classList.toggle("on", i < n));
    dom.title.textContent = v.title || "";
    dom.text.textContent = v.text || "";
    dom.doLine.textContent = "";
    if(v.doText){
      const b = document.createElement("b");
      b.textContent = "Сейчас:";
      dom.doLine.appendChild(b);
      dom.doLine.appendChild(document.createTextNode(" " + v.doText));
    }
    dom.doLine.hidden = !v.doText;
    dom.next.hidden = !v.next;
    if(v.next){
      dom.next.textContent = v.next.label;
      if(v.next.disabled) dom.next.setAttribute("aria-disabled", "true");
      else dom.next.removeAttribute("aria-disabled");
    }
    dom.skip.hidden = v.skip === false;
    dom.actions.hidden = !!v.finish;
    dom.finish.hidden = !v.finish;
    dom.note.hidden = !!v.over; // в тексте «партия окончена» это уже сказано
    dom.body.hidden = confirmShown;
    dom.confirm.hidden = !confirmShown;
    // Вопрос о выходе — та же карточка в роли alertdialog, а не диалог в диалоге.
    dom.card.setAttribute("role", confirmShown ? "alertdialog" : "dialog");
    dom.card.setAttribute("aria-labelledby", confirmShown ? "coachConfirmTitle" : "coachTitle");
    dom.card.setAttribute("aria-describedby", confirmShown ? "coachConfirmText" : "coachStep coachText coachDo");
  }
  function fillMini(v){
    const key = [v.text, v.spinner ? 1 : 0, v.back ? 1 : 0, v.next || ""].join("\u0001");
    if(dom.mini._key === key) return;
    dom.mini._key = key;
    dom.miniText.textContent = v.text || "";
    dom.miniSpin.hidden = !v.spinner;
    dom.miniBack.hidden = !v.back;
    // «Далее» / «Смотреть ходы» — только у плашки вместо карточки (см. draw).
    dom.miniNext.hidden = !v.next;
    if(v.next) dom.miniNext.textContent = v.next;
  }

  // --- Фокус и экранный диктор ----------------------------------------------
  function announce(msg){
    clearTimeout(liveTimer);
    dom.live.textContent = "";
    liveTimer = setTimeout(()=>{ if(active) dom.live.textContent = msg; }, 60);
  }
  function sayInstruction(v, wholeStep){
    let msg = "";
    if(v.kind === "mini") msg = v.text || "";
    else if(wholeStep){
      const t = v.title || "";
      msg = (STEPS[idx].count ? `Шаг ${countedIndex()} из ${COUNTED}. ` : "") + (/[.!?…]$/.test(t) ? t : t + ".") + " " + (v.text || "")
        + (v.doText ? " Сейчас: " + v.doText : "");
    } else if(v.doText) msg = "Сейчас: " + v.doText;
    if(!msg) return;
    // Шаг-чтение, и фокус придёт в карточку снаружи: диктор и так прочтёт
    // диалог (шаг, заголовок, текст — aria-describedby), второй раз через живую
    // область не повторяем. Фокус уже в карточке («Далее» с прошлого шага) —
    // диалог заново не объявят, говорим сами. Карточка не поместится и вместо
    // неё будет плашка — отложенное скажет draw().
    if(wholeStep && v.kind === "card" && !v.target && STEPS[idx].id !== "event" && !confirmShown
      && !dom.card.contains(document.activeElement)){ quietSay = msg; return; }
    quietSay = "";
    announce(msg);
  }
  function focusEl(el, intent){
    if(!el) return;
    try { el.focus({ preventScroll: true }); focusIntent = intent; } catch(e){}
  }
  // Смена шага: на шаге-чтении — фокус на кнопку карточки, на шаге-действии —
  // на то, что просят нажать (если игрок не печатает в поле). В сводке события
  // фокус остаётся в ней самой.
  function focusStep(v){
    if(!pendingFocus) return;
    if(confirmShown){ pendingFocus = false; focusEl(dom.stay, "card"); return; }
    if(v.back) return; // пауза: фокус переведём, когда игрок вернётся к столу
    if(v.kind !== "card" || STEPS[idx].id === "event"){ pendingFocus = false; return; }
    const onCard = dom.card.classList.contains("on");
    // Карточке не нашлось места — вместо неё плашка; её «Далее» и получит фокус.
    const onMini = !onCard && miniFallback && dom.mini.classList.contains("on");
    if(!onCard && !onMini) return; // карточка ещё не показана
    pendingFocus = false;
    if(v.finish && onCard){ focusEl(dom.play, "card"); return; }
    if(v.target){
      const ae = document.activeElement;
      const typing = ae && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName) && ae.type !== "range" && !ae.closest("#contextPopup");
      if(!typing) focusEl(v.target, "target");
      else if(onCard) focusEl(dom.card, "card");
      return;
    }
    if(v.next && !v.next.disabled){ focusEl(onCard ? dom.next : dom.miniNext, "card"); return; }
    if(onCard) focusEl(dom.card, "card");
  }
  // Панель хода (#cornerAction) пересобирается на каждом состоянии, и фокус
  // падает на <body>: если он был на карточке или на нужной кнопке — вернём.
  function rescueFocus(){
    if(!focusIntent || pendingFocus) return;
    const ae = document.activeElement;
    if(ae && ae !== document.body && ae.isConnected) return;
    const v = viewFor(STEPS[idx], readState());
    if(focusIntent === "target" && v.target) focusEl(v.target, "target");
    else if(dom.card.classList.contains("on")) focusEl(dom.card, "card");
  }
  function onFocusIn(e){
    if(!active || !dom) return;
    const t = e.target;
    if(dom.card.contains(t) || dom.mini.contains(t)) focusIntent = "card";
    else if(t === curTarget || (t.matches && t.matches("#cornerAction .dock-main, #contextPopup .sheet-actions button, #rpBuySlider"))) focusIntent = "target";
    else focusIntent = null;
  }

  // --- Разметка тренера (вне #app: светлые токены меню, не inert под модалкой) ---
  function ensureDom(){
    if(dom) return dom;
    const rootEl = document.createElement("div");
    rootEl.id = "coach";
    rootEl.className = "coach";
    rootEl.hidden = true;
    const seg = new Array(COUNTED).fill("<i></i>").join("");
    rootEl.innerHTML = `
      <svg class="coach-dim" aria-hidden="true" focusable="false"><defs><mask id="coachMask" maskUnits="userSpaceOnUse" x="0" y="0" width="100%" height="100%"><rect x="0" y="0" width="100%" height="100%" fill="#fff"/></mask></defs><rect class="coach-dim-fill" x="0" y="0" width="100%" height="100%" mask="url(#coachMask)"/></svg>
      <div class="coach-rings" aria-hidden="true"></div>
      <div class="coach-card" id="coachCard" role="dialog" aria-modal="false" aria-labelledby="coachTitle" aria-describedby="coachStep coachText coachDo" tabindex="-1">
        <span class="coach-caret" aria-hidden="true"></span>
        <div class="coach-inner">
          <div class="coach-body">
            <div class="coach-progress"><span class="coach-eyebrow" id="coachStep"></span><span class="coach-bar" aria-hidden="true">${seg}</span></div>
            <h2 class="coach-title" id="coachTitle"></h2>
            <p class="coach-text" id="coachText"></p>
            <button type="button" class="coach-more">Подробнее</button>
            <p class="coach-do" id="coachDo"></p>
            <div class="coach-finish" hidden>
              <button type="button" class="block coach-play">Начать настоящую партию</button>
              <div class="coach-finish-row">
                <button type="button" class="secondary coach-rules">Правила</button>
                <button type="button" class="secondary coach-menu">В меню</button>
              </div>
              <p class="coach-note">Пройти обучение ещё раз можно из главного меню.</p>
            </div>
            <div class="coach-actions">
              <button type="button" class="ghost small coach-skip" aria-label="Пропустить обучение">Пропустить</button>
              <button type="button" class="coach-next">Далее</button>
            </div>
          </div>
          <div class="coach-confirm" hidden>
            <h2 class="coach-title" id="coachConfirmTitle">Выйти из обучения?</h2>
            <p class="coach-text" id="coachConfirmText">Учебная партия не сохранится. Пройти обучение ещё раз можно из главного меню.</p>
            <div class="coach-actions">
              <button type="button" class="secondary coach-stay">Продолжить обучение</button>
              <button type="button" class="coach-leave">Выйти</button>
            </div>
          </div>
        </div>
      </div>
      <div class="coach-mini" role="group" aria-label="Обучение">
        <span class="spinner coach-mini-spin" aria-hidden="true"></span>
        <span class="coach-mini-text"></span>
        <span class="coach-mini-btns">
          <button type="button" class="small coach-mini-back" aria-label="Вернуться к столу" hidden>К столу</button>
          <button type="button" class="small coach-mini-next" hidden>Далее</button>
          <button type="button" class="ghost small coach-mini-skip" aria-label="Пропустить обучение">Пропустить</button>
        </span>
      </div>
      <div class="coach-probe" aria-hidden="true"></div>
      <div class="coach-sr" id="coachLive" aria-live="polite" aria-atomic="true"></div>`;
    const app = byId("app");
    if(app && app.parentNode) app.parentNode.insertBefore(rootEl, app.nextSibling);
    else document.body.appendChild(rootEl);
    const q = (sel)=> rootEl.querySelector(sel);
    dom = {
      root: rootEl, dim: q(".coach-dim"), mask: q("#coachMask"), holes: [], rings: q(".coach-rings"),
      card: q(".coach-card"), caret: q(".coach-caret"), inner: q(".coach-inner"), body: q(".coach-body"),
      stepLabel: q(".coach-eyebrow"), bar: q(".coach-bar"), title: q("#coachTitle"), text: q("#coachText"),
      more: q(".coach-more"), doLine: q("#coachDo"), actions: q(".coach-actions"), skip: q(".coach-skip"), next: q(".coach-next"),
      finish: q(".coach-finish"), play: q(".coach-play"), confirm: q(".coach-confirm"), stay: q(".coach-stay"),
      mini: q(".coach-mini"), miniText: q(".coach-mini-text"), miniSpin: q(".coach-mini-spin"), miniBack: q(".coach-mini-back"),
      miniNext: q(".coach-mini-next"), note: q(".coach-note"), probe: q(".coach-probe"), live: q("#coachLive"),
    };
    dom.next.addEventListener("click", onNext);
    dom.miniNext.addEventListener("click", onNext);
    dom.skip.addEventListener("click", askSkip);
    q(".coach-mini-skip").addEventListener("click", askSkip);
    dom.miniBack.addEventListener("click", backToTable);
    dom.more.addEventListener("click", ()=>{ expanded = true; heightCache.clear(); requestUpdate(); });
    dom.stay.addEventListener("click", closeConfirm);
    q(".coach-leave").addEventListener("click", ()=> exit("mainMenu"));
    dom.play.addEventListener("click", playForReal);
    q(".coach-rules").addEventListener("click", ()=>{
      exit("rulesScreen");
      // Только что из обучения — «Пройти интерактивное обучение» наверху лишняя
      // (вернёт её resetRulesReturn при следующем входе в правила). Фокус — на
      // первый раздел, а не на <body>.
      const again = byId("btnRulesTutorial");
      if(again) again.hidden = true;
      focusQuiet(document.querySelector("#rulesScreen summary"));
    });
    q(".coach-menu").addEventListener("click", ()=> exit("mainMenu"));
    return dom;
  }

  // --- Подписки на время обучения -------------------------------------------
  function onWinChange(){ heightCache.clear(); requestUpdate(); }
  function attach(){
    const mo = new MutationObserver(()=> sync());
    ["companyModalOverlay", "marketEventOverlay", "app"].forEach((id)=>{ const el = byId(id); if(el) mo.observe(el, { attributes: true, attributeFilter: ["style"] }); });
    const menu = byId("gameMenuPanel");
    if(menu) mo.observe(menu, { attributes: true, attributeFilter: ["class"] });
    document.querySelectorAll(".overlay-panel").forEach((p)=> mo.observe(p, { attributes: true, attributeFilter: ["class"] }));
    observers.push(mo);
    if(window.ResizeObserver){
      const ro = new ResizeObserver(()=>{ heightCache.clear(); requestUpdate(); });
      const pop = byId("contextPopup");
      if(pop) ro.observe(pop);
      ro.observe(dom.inner);
      observers.push(ro);
    }
    window.addEventListener("resize", onWinChange);
    window.addEventListener("orientationchange", onWinChange);
    if(window.visualViewport) window.visualViewport.addEventListener("resize", onWinChange);
    document.addEventListener("scroll", requestUpdate, true);
    // Подстраховка: перестройки, которые не дают ни события, ни render()
    // (плашка итога меры гаснет по таймеру, догрузился шрифт).
    tickTimer = setInterval(requestUpdate, 500);
  }
  function teardown(){
    active = false;
    if(raf){ cancelAnimationFrame(raf); raf = 0; }
    clearInterval(tickTimer); tickTimer = null;
    clearTimeout(revealTimer); clearTimeout(reducedTimer); clearTimeout(liveTimer);
    observers.forEach((o)=> o.disconnect());
    observers = [];
    window.removeEventListener("resize", onWinChange);
    window.removeEventListener("orientationchange", onWinChange);
    if(window.visualViewport) window.visualViewport.removeEventListener("resize", onWinChange);
    document.removeEventListener("scroll", requestUpdate, true);
    confirmShown = false;
    focusIntent = null;
    curTarget = null;
    quietSay = "";
    document.body.classList.remove("coach-event");
    if(dom){ dom.root.hidden = true; hideVisuals(); dom.live.textContent = ""; }
  }

  // --- Вход и выход -----------------------------------------------------------
  function start(fromId){
    if(active || typeof GameEngine === "undefined") return;
    lsSet(LS_OFFERED, "1");
    offerSession = false;
    renderMenuEntry();
    entryId = fromId || "btnGoTutorial";
    teardownOnline(); // висящее онлайн-подключение не должно перехватить партию
    mode = "offline";
    const built = buildRoom(GameEngine, accountUser && accountUser.username ? accountUser.username : "Инвестор");
    localRoom = built.room;
    meId = built.meId;
    nvdaStart = localRoom.companies.NVDA ? localRoom.companies.NVDA.price : 0;
    viewAs = meId;
    lastSyncedCurrentPlayerId = meId;
    lastHandoffKey = null;
    latest = null;
    lastSeenMarketEventCount = null;
    pendingInsiderCard = null;
    applyBoardSkin(accountUser ? (accountUser.equippedBoardSkin || "default") : "default");
    switchTab("turn");
    begin();
    showOnly("app");
    refreshLocal();
  }
  function begin(){
    ensureDom();
    active = true;
    idx = 0;
    released = false;
    finishPassed = false;
    confirmShown = false;
    expanded = false;
    miniFallback = false;
    quietSay = "";
    sheetMemo = null;
    cardKey = "";
    heightCache.clear();
    goTo(0);
    attach();
    requestUpdate();
  }
  // Выход в меню (или в настройку новой партии, или к правилам): учебная
  // комната просто выбрасывается — обычное сохранение она никогда не трогала.
  function exit(target){
    if(!active) return;
    teardown();
    if(botPumpTimer){ clearTimeout(botPumpTimer); botPumpTimer = null; }
    mode = null; latest = null; you = null; localRoom = null; viewAs = null; pendingInsiderCard = null;
    lastSeenMarketEventCount = null; lastSyncedCurrentPlayerId = null; lastHandoffKey = null;
    closeGameMenu();
    if(shown("companyModalOverlay")) closeCompanyModal();
    if(shown("marketEventOverlay")) closeMarketEventModal();
    switchTab("turn");
    resetRulesReturn();
    showOnly(target || "mainMenu");
    renderMenuEntry();
    if(target === "mainMenu" || !target){
      const el = byId(entryId);
      focusQuiet(visibleEl(el) ? el : byId("btnGoTutorial"));
    }
  }
  function focusQuiet(el){ if(el){ try { el.focus({ preventScroll: true }); } catch(e){} } }
  function playForReal(){
    const name = accountUser && accountUser.username ? accountUser.username : "Игрок";
    exit("offlineSetup");
    offlinePlayerNames = [
      { name, gender: "", avatar: "" },
      { name: "Бот 1", gender: "", avatar: "🤖", isBot: true },
      { name: "Бот 2", gender: "", avatar: "🤖", isBot: true },
    ];
    const err = byId("offlineErr");
    if(err) err.textContent = "";
    renderOfflinePlayersBox();
    focusQuiet(byId("btnStartOffline"));
  }
  function askSkip(){
    if(!active) return;
    // На финальной карточке пропускать уже нечего — просто в меню.
    if(STEPS[idx].id === "finish"){ exit("mainMenu"); return; }
    confirmShown = true;
    pendingFocus = true;
    cardKey = "";
    requestUpdate();
  }
  function closeConfirm(){
    if(!confirmShown) return;
    confirmShown = false;
    pendingFocus = true;
    cardKey = "";
    maybeRelease();
    requestUpdate();
  }
  function backToTable(){
    if(shown("companyModalOverlay")) closeCompanyModal();
    closeGameMenu();
    switchTab("turn");
    sync();
  }

  // --- Меню, настройки, правила ------------------------------------------------
  // Карточка «Обучение» в главном меню и разовое предложение для новичка
  // (только без сохранённой партии; показано один раз — больше не навязываем).
  function renderMenuEntry(){
    const done = isDone();
    const sub = byId("tutorialCardSub");
    if(sub) sub.textContent = done ? "Пройдено ✓ · можно повторить" : "Мини-партия с подсказками · 3 минуты";
    const offer = byId("tutorialOffer");
    if(!offer) return;
    if(offerSession === null){
      const hasSave = typeof loadOfflineSave === "function" && !!loadOfflineSave();
      offerSession = !done && lsGet(LS_OFFERED) !== "1" && !hasSave;
      if(offerSession) lsSet(LS_OFFERED, "1");
    }
    offer.hidden = !offerSession || done;
  }
  function renderSettingsEntry(){
    const done = isDone();
    const lbl = byId("settingsTutorialLabel");
    if(lbl) lbl.textContent = done ? "Пройти обучение заново" : "Пройти обучение";
    // Значок «повторить» — только для пройденного, впервые — «играть».
    const use = document.querySelector("#btnSettingsTutorial use");
    if(use) use.setAttribute("href", done ? "#i-refresh" : "#i-play");
  }
  function bind(id, fn){ const el = byId(id); if(el) el.addEventListener("click", fn); }
  bind("btnGoTutorial", ()=> start("btnGoTutorial"));
  bind("btnTutorialOfferStart", ()=> start("btnGoTutorial"));
  // Предложение выглядит как большая кнопка «Продолжить партию» — тап по тексту
  // или значку тоже начинает обучение. С клавиатуры — «Начать» (вторая кнопка
  // с тем же действием диктору не нужна); «Скрыть» обрабатывает сама.
  bind("tutorialOffer", (e)=>{ if(!e.target.closest("button")) start("btnGoTutorial"); });
  bind("btnTutorialOfferClose", ()=>{
    offerSession = false;
    renderMenuEntry();
    focusQuiet(byId("btnGoTutorial")); // кнопка исчезла — фокус не должен упасть на <body>
  });
  bind("btnRulesTutorial", ()=>{ resetRulesReturn(); start("btnGoTutorial"); });
  bind("btnSettingsTutorial", ()=> start("btnSettingsTutorial"));
  document.addEventListener("focusin", onFocusIn);
  // Игрок сам ткнул мимо карточки — фокус он увёл сознательно, возвращать не будем
  // (потеря фокуса из-за пересборки панели нажатием не сопровождается).
  document.addEventListener("pointerdown", (e)=>{
    if(active && dom && !dom.card.contains(e.target) && !dom.mini.contains(e.target)) focusIntent = null;
  }, true);

  return {
    buildRoom, SCRIPT,
    start, exit, stop: exit,
    active: ()=> active,
    holdBots,
    // Конец render(): пересчитать шаг и вернуть фокус, если панель пересобралась.
    onRender(){
      if(!active) return;
      try { sync(); rescueFocus(); } catch(e){ console.error(e); }
    },
    sync(){ try { sync(); } catch(e){ console.error(e); } },
    askSkip, closeConfirm,
    confirmOpen: ()=> active && confirmShown,
    renderMenuEntry, renderSettingsEntry, isDone,
  };
});
