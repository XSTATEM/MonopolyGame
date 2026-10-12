// ---------------------------------------------------------------------
// Юнит-тесты правил движка (public/engine.js) — без сети и без DOM.
// Запуск: node test/engine.test.js  (из папки server) или npm test.
// Каждый сценарий — отдельная функция: собирает комнату, выполняет действия
// движка и проверяет результат через node:assert. Math.random подменяется
// внутри сценария (fixRandom) и восстанавливается после него автоматически.
// Покрывают исправления правил: guard'ы лобби, конечную и ограниченную цену
// выкупа, выплату «не больше, чем есть у плательщика», порядок проверок в
// dividendFromRoll, конец партии при общем разорении, лимиты сделок, правила
// исключения голосованием и очередь ходов после выбывания посреди хода,
// срок решения контролёра о цене выкупа и минимальную длину партии для очков,
// пакет баланса А5 + Б1–Б4 (бот движка, кредит, настройки новой комнаты).
// ---------------------------------------------------------------------
const assert = require("assert/strict");
const path = require("path");
const E = require(path.join(__dirname, "..", "public", "engine.js"));

// Константы движка, которые наружу не экспортируются (см. engine.js).
const MAX_DEAL_AMOUNT = 1e9;
const MAX_POINTS_PER_GAME = 5000;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
const realRandom = Math.random;
function fixRandom(v) { Math.random = () => v; }

// --- заготовки комнат ----------------------------------------------------
function lobby(names, bots) {
  const r = E.freshRoom("T");
  names.forEach((n) => E.addPlayer(r, n, "", "", 0, "default", !!bots));
  return r;
}
// Начатая партия; ходит первый в списке. Биржевые события отодвинуты, чтобы
// случайная карта не вмешивалась в сценарий (кто захочет событие — ставит r.turn).
function game(names, bots) {
  const r = lobby(names, bots);
  const res = E.startGame(r, r.hostPlayerId);
  assert.ok(!res.error, "startGame: " + res.error);
  // startGame перемешивает порядок ходов — сценариям нужен предсказуемый.
  r.turnOrder = r.players.map((p) => p.id);
  r.turnIndex = 0;
  r.settings.eventIntervalTurns = 100;
  return r;
}
const P = (r, name) => r.players.find((p) => p.name === name);
const nameOf = (r, id) => (r.players.find((p) => p.id === id) || {}).name;
// Ход «вхолостую»: бросок без действия по клетке и завершение хода.
function playTurn(r) {
  const cur = E.currentPlayerId(r);
  let res = E.rollDice(r, cur);
  assert.ok(!res.error, `rollDice(${nameOf(r, cur)}): ${res.error}`);
  r.pendingRoll = null;
  res = E.endTurn(r, cur);
  assert.ok(!res.error, `endTurn(${nameOf(r, cur)}): ${res.error}`);
  return nameOf(r, cur);
}
// Ходящий A стоит на клетке ticker, которой B владеет на heldPct процентов.
function rollOnHeld(names, heldPct, ticker) {
  ticker = ticker || "AAPL";
  const r = game(names);
  const A = P(r, "A"), B = P(r, "B");
  B.holdings[ticker] = heldPct;
  r.rolledThisTurn = true;
  r.pendingRoll = { playerId: A.id, row: 1, col: 1, ticker, realEstateId: null };
  return { r, A, B, ticker };
}
// Ход чистый: бросать может следующий, ничего не висит от выбывшего.
function assertCleanTurn(r, expectedName) {
  assert.equal(nameOf(r, E.currentPlayerId(r)), expectedName, "ходит не тот игрок");
  assert.equal(r.rolledThisTurn, false, "rolledThisTurn остался от выбывшего");
  assert.equal(r.pendingRoll, null, "pendingRoll остался от выбывшего");
  assert.equal(r.pendingForcedPrice, null, "pendingForcedPrice остался от выбывшего");
}

// ---------------------------------------------------------------------
// Лобби и конец партии: действия, доступные только во время игры
// ---------------------------------------------------------------------
test("лобби: declareBankruptcy отклоняется — неначатая партия не «заканчивается» с очками", () => {
  const r = lobby(["A", "B"]);
  const res = E.declareBankruptcy(r, P(r, "A").id);
  assert.ok(res.error, "банкротство в лобби принято");
  assert.equal(r.phase, "lobby");
  assert.equal(P(r, "A").bankrupt, false);
  assert.equal(r.gameResult, null);
  assert.ok(!r.lastGamePointsAward, "очки начислены за неначатую партию");
  return r;
});

test("лобби: кредит не берётся и не гасится; после старта — снова доступен", () => {
  const r = lobby(["A", "B"]);
  const A = P(r, "A");
  const cash = A.cash;
  assert.ok(E.takeLoan(r, A.id, 5000).error, "кредит в лобби выдан");
  assert.equal(A.loan, null);
  assert.equal(A.cash, cash);
  A.loan = { principal: 1000, originalAmount: 1000, ratePct: 10, takenEvent: 0, missedPayments: 0 };
  assert.ok(E.repayLoan(r, A.id, 500).error, "погашение в лобби принято");
  assert.equal(A.loan.principal, 1000);
  A.loan = null;
  E.startGame(r, r.hostPlayerId);
  const amount = Math.min(5000, E.loanTerms(r, A).limit);
  assert.ok(amount > 0);
  const res = E.takeLoan(r, A.id, amount);
  assert.ok(!res.error, "кредит в партии: " + res.error);
  assert.equal(A.loan.principal, amount);
  return r;
});

test("после конца партии: банкротство и кредиты недоступны", () => {
  const r = game(["A", "B"]);
  E.declareBankruptcy(r, P(r, "B").id);
  assert.equal(r.phase, "ended");
  const A = P(r, "A");
  assert.ok(E.declareBankruptcy(r, A.id).error, "банкротство после конца принято");
  assert.equal(A.bankrupt, false);
  assert.ok(E.takeLoan(r, A.id, 1000).error, "кредит после конца выдан");
  assert.equal(A.loan, null);
  return r;
});

// ---------------------------------------------------------------------
// Цена выкупа доли у контролёра (>50%)
// ---------------------------------------------------------------------
test("цена выкупа: Infinity, NaN, ноль и отрицательные отклоняются", () => {
  fixRandom(0.99); // без конфискации антимонопольной службой
  for (const bad of [Infinity, -Infinity, "1e309", "Infinity", NaN, "abc", undefined, null, 0, 0.4, -5]) {
    const { r, B } = rollOnHeld(["A", "B"], 60);
    const res = E.setForcedPrice(r, B.id, bad);
    assert.ok(res.error, `сумма ${String(bad)} принята`);
    assert.equal(r.pendingForcedPrice, null);
  }
});

test("цена выкупа: больше 6 справедливых цен отклоняется, ровно потолок и обычная — принимаются", () => {
  fixRandom(0.99);
  const big = rollOnHeld(["A", "B"], 60);
  const cap = E.forcedPriceCap(big.r, big.r.pendingRoll.ticker, big.B.holdings[big.r.pendingRoll.ticker]);
  for (const over of [1e300, MAX_DEAL_AMOUNT, cap + 1]) {
    assert.ok(E.setForcedPrice(big.r, big.B.id, over).error, `сумма ${over} выше потолка ${cap} принята`);
    assert.equal(big.r.pendingForcedPrice, null);
  }
  assert.ok(!E.setForcedPrice(big.r, big.B.id, cap).error);
  assert.equal(big.r.pendingForcedPrice.amount, cap);
  const normal = rollOnHeld(["A", "B"], 60);
  assert.ok(!E.setForcedPrice(normal.r, normal.B.id, "7500.6").error);
  assert.equal(normal.r.pendingForcedPrice.amount, 7501);
  return [big.r, normal.r];
});

test("оплата цены выкупа: контролёр получает не больше капитала плательщика", () => {
  fixRandom(0.99);
  const { r, A, B } = rollOnHeld(["A", "B", "C"], 60);
  A.cash = 1000;
  const worth = E.netWorth(r, A);
  const before = B.cash;
  const cap = E.forcedPriceCap(r, r.pendingRoll.ticker, B.holdings[r.pendingRoll.ticker]);
  assert.ok(cap > worth, "потолок не разоряет — сценарий не проверяет ограничение выплаты");
  assert.ok(!E.setForcedPrice(r, B.id, cap).error);
  const res = E.payForcedPrice(r, A.id);
  assert.ok(!res.error, res.error);
  assert.equal(B.cash - before, worth, "контролёр получил деньги «из воздуха»");
  assert.equal(A.bankrupt, true);
  // A разорился посреди своего хода — ход чисто переходит к B, партия идёт.
  assert.equal(r.phase, "roll");
  assertCleanTurn(r, "B");
  return r;
});

test("оплата посильной цены выкупа: списывается и зачисляется ровно назначенная сумма", () => {
  fixRandom(0.99);
  const { r, A, B } = rollOnHeld(["A", "B"], 60);
  const a0 = A.cash, b0 = B.cash;
  assert.ok(!E.setForcedPrice(r, B.id, 5000).error);
  assert.ok(!E.payForcedPrice(r, A.id).error);
  assert.equal(a0 - A.cash, 5000);
  assert.equal(B.cash - b0, 5000);
  assert.equal(r.pendingRoll, null);
  assert.equal(r.pendingForcedPrice, null);
  return r;
});

test("очки за победу конечны и не выше потолка даже при огромном капитале", () => {
  const r = game(["A", "B"]);
  P(r, "A").cash = 1e15;
  r.eventCount = 50; // партия достаточной длины (MIN_TURNS_FOR_POINTS) — очки положены
  E.declareBankruptcy(r, P(r, "B").id);
  assert.equal(r.phase, "ended");
  const pts = r.gameResult.pointsEarned;
  assert.ok(Number.isFinite(pts) && pts > 0 && pts <= MAX_POINTS_PER_GAME, "pointsEarned=" + pts);
  if (r.lastGamePointsAward) assert.ok(r.lastGamePointsAward.amount <= MAX_POINTS_PER_GAME);
  return r;
});

// ---------------------------------------------------------------------
// dividendFromRoll: детерминированные проверки раньше случайного пропуска
// ---------------------------------------------------------------------
test("dividendFromRoll: повтор отказа не обходит контролёра даже при «выпавшем» пропуске", () => {
  const { r, A, B, ticker } = rollOnHeld(["A", "B"], 60);
  const a0 = A.cash, b0 = B.cash;
  fixRandom(0); // любой случайный пропуск дивидендов сработал бы
  for (let i = 0; i < 20; i++) {
    const res = E.dividendFromRoll(r, A.id);
    assert.ok(res.error, `попытка ${i}: отказ прошёл мимо контролёра ${JSON.stringify(res)}`);
  }
  // Карта «дивиденды пропущены» тоже не отменяет цену контролёра.
  r.companies[ticker].skipDividendUntil = r.eventCount + 3;
  assert.ok(E.dividendFromRoll(r, A.id).error);
  assert.ok(r.pendingRoll && r.pendingRoll.ticker === ticker, "бросок израсходован");
  assert.equal(A.cash, a0);
  assert.equal(B.cash, b0);
  return r;
});

test("dividendFromRoll: после назначенной цены отказаться нельзя — только оплатить", () => {
  fixRandom(0.99);
  const { r, A, B, ticker } = rollOnHeld(["A", "B"], 60);
  assert.ok(!E.setForcedPrice(r, B.id, 5000).error);
  fixRandom(0);
  assert.ok(E.dividendFromRoll(r, A.id).error, "отказ после назначенной цены принят");
  // Доля контролёра упала до 50% и ниже (конфискация) — назначенная цена остаётся.
  B.holdings[ticker] = 40;
  assert.ok(E.dividendFromRoll(r, A.id).error, "отказ после конфискации принят");
  assert.ok(r.pendingForcedPrice && r.pendingRoll);
  assert.ok(!E.payForcedPrice(r, A.id).error);
  return r;
});

test("dividendFromRoll без контролёра: выплата держателям или случайный пропуск", () => {
  fixRandom(0.99); // пропуска нет — платится тирная доля капитализации
  const paid = rollOnHeld(["A", "B"], 30);
  const a0 = paid.A.cash, b0 = paid.B.cash;
  assert.ok(!E.dividendFromRoll(paid.r, paid.A.id).error);
  const amount = a0 - paid.A.cash;
  assert.ok(amount > 0, "отказ ничего не стоил");
  assert.ok(Math.abs(paid.B.cash - b0 - amount) < 1e-6, "держатель получил не всю выплату");
  assert.equal(paid.r.pendingRoll, null);
  fixRandom(0); // пропуск выпал — платить не нужно, бросок закрыт
  const skipped = rollOnHeld(["A", "B"], 30);
  const s0 = skipped.A.cash;
  assert.ok(!E.dividendFromRoll(skipped.r, skipped.A.id).error);
  assert.equal(skipped.A.cash, s0);
  assert.equal(skipped.r.pendingRoll, null);
  return [paid.r, skipped.r];
});

// ---------------------------------------------------------------------
// Все разорились разом
// ---------------------------------------------------------------------
test("все разорились одновременно — партия заканчивается, победитель самый богатый, без очков", () => {
  const r = game(["A", "B", "C"]);
  const cash = { A: -3000, B: -500, C: -9000 };
  for (const p of r.players) { p.holdings = {}; p.cash = cash[p.name]; E.settleDebt(r, p); }
  assert.ok(r.players.every((p) => p.bankrupt));
  assert.equal(E.currentPlayerId(r), null);
  E.checkEndGame(r);
  assert.equal(r.phase, "ended");
  assert.ok(r.gameResult, "нет итогов партии");
  assert.equal(r.gameResult.winnerName, "B");
  assert.equal(r.gameResult.pointsEarned, 0);
  assert.ok(!r.lastGamePointsAward);
  return r;
});

test("все разорились на взыскании кредитов в биржевом событии — партия не зависает", () => {
  const r = game(["A", "B"]);
  for (const p of r.players) {
    p.cash = 0;
    p.loan = { principal: 1e8, originalAmount: 1e8, ratePct: 10, takenEvent: 0, missedPayments: 2 };
  }
  r.rolledThisTurn = true;
  r.turn = r.settings.eventIntervalTurns; // этот endTurn вызывает событие
  const res = E.endTurn(r, P(r, "A").id);
  assert.ok(!res.error, res.error);
  assert.ok(r.players.every((p) => p.bankrupt), "кто-то пережил взыскание");
  assert.equal(r.phase, "ended");
  assert.ok(r.gameResult);
  assert.equal(r.gameResult.pointsEarned, 0);
  return r;
});

// ---------------------------------------------------------------------
// Сделки между игроками
// ---------------------------------------------------------------------
function tradeRoom() {
  const r = game(["A", "B", "C"]);
  P(r, "A").holdings = { AAPL: 50, MSFT: 50 };
  P(r, "B").holdings = { GOOGL: 50 };
  return r;
}

test("сделки: бесконечная и сверхбольшая цена отклоняются, потолок — допустим", () => {
  const r = tradeRoom();
  const A = P(r, "A"), B = P(r, "B");
  for (const bad of [Infinity, "1e309", "Infinity", MAX_DEAL_AMOUNT * 2]) {
    const res = E.proposeTrade(r, A.id, B.id, "AAPL", 5, bad);
    assert.ok(res.error, `цена ${String(bad)} принята`);
  }
  assert.equal(r.pendingTrades.length, 0);
  assert.ok(!E.proposeTrade(r, A.id, B.id, "AAPL", 5, MAX_DEAL_AMOUNT).error);
  assert.equal(r.pendingTrades[0].price, MAX_DEAL_AMOUNT);
  return r;
});

test("сделки: точный дубль не создаётся, отличающийся по цене — создаётся", () => {
  const r = tradeRoom();
  const A = P(r, "A"), B = P(r, "B");
  assert.ok(!E.proposeTrade(r, A.id, B.id, "AAPL", 5, 1000, "GOOGL", 3).error);
  const dup = E.proposeTrade(r, A.id, B.id, "AAPL", 5, 1000, "GOOGL", 3);
  assert.ok(dup.error && /уже ждёт/.test(dup.error), JSON.stringify(dup));
  assert.equal(r.pendingTrades.length, 1);
  assert.ok(!E.proposeTrade(r, A.id, B.id, "AAPL", 5, 1001, "GOOGL", 3).error);
  assert.equal(r.pendingTrades.length, 2);
  return r;
});

test("сделки: не больше 5 открытых предложений от игрока и 30 в комнате", () => {
  const r = tradeRoom();
  const A = P(r, "A"), B = P(r, "B"), C = P(r, "C");
  for (let i = 1; i <= 5; i++) assert.ok(!E.proposeTrade(r, A.id, B.id, "AAPL", 1, i).error, "предложение " + i);
  const sixth = E.proposeTrade(r, A.id, C.id, "MSFT", 1, 1);
  assert.ok(sixth.error && /Слишком много/.test(sixth.error), JSON.stringify(sixth));
  assert.equal(r.pendingTrades.length, 5);
  // Общий потолок комнаты: 30 чужих открытых предложений — новое не принимается.
  const r2 = tradeRoom();
  const A2 = P(r2, "A"), B2 = P(r2, "B"), C2 = P(r2, "C");
  for (let i = 0; i < 30; i++) {
    r2.pendingTrades.push({ id: r2.nextTradeId++, fromId: C2.id, toId: B2.id, ticker: "AAPL", pct: 1, price: i, wantTicker: null, wantPct: 0, status: "pending" });
  }
  assert.ok(E.proposeTrade(r2, A2.id, B2.id, "AAPL", 1, 1).error, "31-е предложение в комнате принято");
  return [r, r2];
});

test("сделки: разорившийся участник — предложения снимаются, принять «подарок» нельзя", () => {
  const r = tradeRoom();
  const A = P(r, "A"), B = P(r, "B");
  assert.ok(!E.proposeTrade(r, A.id, B.id, "AAPL", 5, 0).error);
  B.holdings = {}; B.cash = -1;
  E.settleDebt(r, B);
  assert.equal(B.bankrupt, true);
  assert.equal(r.pendingTrades.length, 0, "предложение банкроту осталось висеть");
  // Защита в respondTrade, если предложение всё же уцелело.
  r.pendingTrades.push({ id: r.nextTradeId++, fromId: A.id, toId: B.id, ticker: "AAPL", pct: 5, price: 0, wantTicker: null, wantPct: 0, status: "pending" });
  const tid = r.pendingTrades[0].id;
  const res = E.respondTrade(r, B.id, tid, true);
  assert.ok(res.error, "банкрот принял сделку");
  assert.ok(!B.holdings.AAPL, "доли ушли банкроту");
  assert.equal(A.holdings.AAPL, 50);
  assert.equal(r.pendingTrades.length, 0);
  assert.ok(E.proposeTrade(r, A.id, B.id, "AAPL", 5, 0).error, "предложение банкроту принято");
  return r;
});

// ---------------------------------------------------------------------
// Исключение голосованием
// ---------------------------------------------------------------------
const longOffline = (p) => { p.connected = false; p.offlineSince = Date.now() - E.OFFLINE_KICK_GRACE_MS - 1000; };

test("исключение: соперника в сети в партии на двоих одним голосом не исключить", () => {
  const r = game(["A", "B"]);
  const res = E.startKickVote(r, P(r, "A").id, P(r, "B").id);
  assert.ok(res.error, "исключён одним кликом");
  assert.ok(!P(r, "B").kicked);
  assert.equal(r.kickVote, null);
  assert.equal(r.phase, "roll");
  return r;
});

test("исключение: только что отключившийся — после паузы, одним голосом и без очков", () => {
  const r = game(["A", "B"]);
  const A = P(r, "A"), B = P(r, "B");
  E.setConnected(r, B.id, false); // обновляет страницу
  assert.ok(E.startKickVote(r, A.id, B.id).error, "исключён во время паузы на переподключение");
  assert.ok(!B.kicked);
  longOffline(B);
  const res = E.startKickVote(r, A.id, B.id);
  assert.ok(!res.error, res.error);
  assert.ok(B.kicked && B.bankrupt);
  assert.equal(r.phase, "ended");
  assert.equal(r.gameResult.winnerId, A.id);
  assert.equal(r.gameResult.pointsEarned, 0, "очки за победу исключением");
  assert.ok(!r.lastGamePointsAward);
  return r;
});

test("исключение: против игрока в сети нужно два голоса «за»", () => {
  const r = game(["A", "B", "C", "D"]);
  const [A, B, C] = ["A", "B", "C"].map((n) => P(r, n));
  assert.ok(!E.startKickVote(r, A.id, B.id).error);
  assert.ok(!B.kicked, "хватило одного голоса");
  const kv = E.buildStatePayload(r, A.id).kickVote;
  assert.equal(kv.needed, 2);
  assert.equal(kv.totalEligible, 3);
  assert.ok(!E.voteKick(r, C.id, B.id, true).error);
  assert.ok(B.kicked, "двух голосов не хватило");
  assert.equal(r.phase, "roll", "партия втроём должна продолжаться");
  return r;
});

test("исключение: короткий обрыв цели во время голосования не снижает порог", () => {
  const r = game(["A", "B", "C", "D"]);
  const [A, C, D] = ["A", "C", "D"].map((n) => P(r, n));
  assert.ok(!E.startKickVote(r, A.id, D.id).error);
  E.setConnected(r, D.id, false); // обновил страницу посреди голосования
  E.voteKick(r, C.id, D.id, false);
  assert.ok(!D.kicked, "исключён одним голосом за секунду обрыва");
  return r;
});

test("исключение: бота — одним голосом, боты сами не голосуют", () => {
  const r = E.freshRoom("O");
  E.addPlayer(r, "Me", "", "", 0, "default", false);
  E.addPlayer(r, "Bot1", "", "", 0, "default", true);
  E.addPlayer(r, "Bot2", "", "", 0, "default", true);
  assert.ok(!E.startGame(r, r.hostPlayerId).error);
  const me = P(r, "Me"), b1 = P(r, "Bot1"), b2 = P(r, "Bot2");
  assert.ok(!E.startKickVote(r, me.id, b1.id).error);
  assert.ok(b1.kicked, "бот не исключён одним голосом");
  assert.equal(r.phase, "roll");
  // Бот за столом не считается голосующим: против человека в сети — те же
  // два голоса из числа людей.
  const r2 = lobby(["A", "B", "C"]);
  E.addPlayer(r2, "Bot", "", "", 0, "default", true);
  assert.ok(!E.startGame(r2, r2.hostPlayerId).error);
  assert.ok(!E.startKickVote(r2, P(r2, "A").id, P(r2, "B").id).error);
  const kv = E.buildStatePayload(r2, P(r2, "A").id).kickVote;
  assert.equal(kv.totalEligible, 2, "бот посчитан голосующим");
  assert.equal(kv.needed, 2);
  assert.ok(!P(r2, "B").kicked);
  // Последний бот исключён — победа без очков.
  E.startKickVote(r, me.id, b2.id);
  assert.ok(b2.kicked);
  assert.equal(r.phase, "ended");
  assert.equal(r.gameResult.pointsEarned, 0);
  return [r, r2];
});

test("исключение отключившегося ходящего игрока передаёт ход чисто", () => {
  const r = game(["A", "B", "C"]);
  const A = P(r, "A"), B = P(r, "B");
  assert.ok(!E.rollDice(r, A.id).error);
  longOffline(A);
  assert.ok(!E.startKickVote(r, B.id, A.id).error);
  assert.ok(A.kicked);
  assertCleanTurn(r, "B");
  assert.ok(!E.rollDice(r, B.id).error, "B не может бросить кубики");
  return r;
});

// ---------------------------------------------------------------------
// Очередь ходов после выбывания
// ---------------------------------------------------------------------
test("очередь: банкрот не в свой ход — без двойных ходов у соседа", () => {
  const r = game(["A", "B", "C"]);
  assert.ok(!E.declareBankruptcy(r, P(r, "B").id).error);
  const seq = [];
  for (let i = 0; i < 6; i++) seq.push(playTurn(r));
  assert.equal(seq.join(""), "ACACAC");
  return r;
});

test("очередь: банкротство посреди своего хода — следующий бросает с чистого листа", () => {
  const r = game(["A", "B", "C"]);
  const A = P(r, "A");
  assert.ok(!E.rollDice(r, A.id).error);
  assert.ok(!E.declareBankruptcy(r, A.id).error);
  assertCleanTurn(r, "B");
  const seq = [];
  for (let i = 0; i < 4; i++) seq.push(playTurn(r));
  assert.equal(seq.join(""), "BCBC");
  return r;
});

test("очередь: разорение на ренте посреди хода — ход к следующему, потом по кругу", () => {
  const r = game(["A", "B", "C"]);
  const A = P(r, "A"), C = P(r, "C");
  const city = Object.keys(r.realEstate)[0];
  r.realEstate[city].ownerId = C.id;
  r.rolledThisTurn = true;
  r.pendingRoll = { playerId: A.id, row: 1, col: 1, ticker: null, realEstateId: city };
  A.cash = -1e9;
  assert.ok(!E.payRealEstateRentFromRoll(r, A.id).error);
  assert.equal(A.bankrupt, true);
  assertCleanTurn(r, "B");
  assert.equal(playTurn(r), "B");
  assert.equal(nameOf(r, E.currentPlayerId(r)), "C");
  return r;
});

// ---------------------------------------------------------------------
// Обучение (public/tutorial.js): учебная комната, заданные броски
// (room.scriptedRolls) и room.tutorial — повтор сценария тренера по шагам.
// ---------------------------------------------------------------------
const Tut = require(path.join(__dirname, "..", "public", "tutorial.js"));
// Боты ходят, пока ход не вернётся к человеку (их броски тоже из сценария).
function botsUntil(r, id) {
  for (let n = 0; E.currentPlayerId(r) !== id && n < 100; n++) {
    const s = E.botStep(r);
    assert.ok(s.acted, "бот встал: " + JSON.stringify(s));
    assert.ok(!(s.result && s.result.error), `${s.type}: ${s.result && s.result.error}`);
  }
  assert.equal(E.currentPlayerId(r), id, "ход не вернулся к человеку");
}
test("обучение: клетки сценария, плата за отказ без пропуска, событие после хода Омеги", () => {
  const rooms = [];
  // Случайны только доли, которые покупают боты, и кубик волатильности.
  for (let trial = 0; trial < 25; trial++) {
    const { room: r, meId, botIds } = Tut.buildRoom(E, "Инвестор");
    const me = r.players.find((p) => p.id === meId);
    const bot = (i) => r.players.find((p) => p.id === botIds[i]);
    assert.equal(r.tutorial, true);
    assert.equal(E.currentPlayerId(r), meId);
    assert.equal(Math.round(E.netWorth(r, me)), 100000, "стартовый пакет куплен из наличных");
    const nv0 = r.companies.NVDA.price;
    // Ход 1: Apple, всё у банка.
    assert.ok(!E.rollDice(r, meId).error);
    assert.deepEqual([r.pendingRoll.row, r.pendingRoll.col, r.pendingRoll.ticker], [7, 6, "AAPL"]);
    assert.ok(!E.buyFromRoll(r, meId, 10).error);
    assert.ok(!E.endTurn(r, meId).error);
    botsUntil(r, meId);
    // Ход 2: Coca-Cola, 45% у двух ботов — плата за отказ списывается всегда и делится по долям.
    assert.ok(!E.rollDice(r, meId).error);
    assert.deepEqual([r.pendingRoll.row, r.pendingRoll.col, r.pendingRoll.ticker], [9, 5, "KO"]);
    const meta = E.buildStatePayload(r, meId).pendingRollMeta;
    assert.equal(meta.refuseSkipChance, 0, "в обучении подсказки о пропуске выплаты нет");
    assert.equal(meta.controllerId, null);
    const cash0 = me.cash, a0 = bot(0).cash, o0 = bot(1).cash;
    assert.ok(!E.dividendFromRoll(r, meId).error);
    const fee = cash0 - me.cash;
    assert.ok(fee > 1000, "плата за отказ не списана: " + fee);
    assert.ok(Math.abs((bot(0).cash - a0) - 2 * (bot(1).cash - o0)) < 1, "плата делится 30:15");
    assert.ok(!E.endTurn(r, meId).error);
    botsUntil(r, meId);
    // Ход 3: Лас-Вегас, свободен.
    assert.ok(!E.rollDice(r, meId).error);
    assert.deepEqual([r.pendingRoll.row, r.pendingRoll.col, r.pendingRoll.realEstateId], [10, 4, "vegas"]);
    assert.ok(!E.buyRealEstateFromRoll(r, meId).error);
    assert.equal(r.eventCount, 0);
    assert.ok(!E.endTurn(r, meId).error);
    botsUntil(r, meId);
    // Событие — ровно после третьего хода Омеги; ход у человека, бросок ещё не сделан.
    assert.equal(r.eventCount, 1);
    assert.equal(r.rolledThisTurn, false);
    assert.ok(r.log.some((e) => e.tag === "news" && e.text.includes(Tut.SCRIPT.newsTitle)), "карта новостей из сценария");
    // +20% отрасли и кубик волатильности (±5%, у тира B сильнее): медиана около +19%,
    // в 2000 прогонах — не меньше +5%. Тренер говорит «подорожала» при росте больше 2%.
    const nvPct = (r.companies.NVDA.price / nv0 - 1) * 100;
    assert.ok(nvPct > 2, "NVIDIA выросла только на " + nvPct.toFixed(1) + "%");
    // «Влияние»: контроль NVIDIA и деньги на каждую меру.
    const st = E.buildStatePayload(r, meId);
    assert.equal(st.tutorial, true);
    assert.equal(st.companies.find((c) => c.ticker === "NVDA").controllerId, meId);
    ["espionage", "negativeInfo", "insiderPeek", "shortDeposit"].forEach((k) => {
      assert.ok(st.myMeasureCosts[k] > 0 && st.myMeasureCosts[k] < me.cash, `мера ${k}: ${st.myMeasureCosts[k]}`);
    });
    // Очереди исчерпаны, а наружу (в состояние для клиента) они не уходят вовсе.
    Object.values(r.scriptedRolls).forEach((q) => assert.equal(q.length, 0));
    assert.ok(!JSON.stringify(st).includes("scriptedRolls"));
    rooms.push(r);
  }
  return rooms;
});
test("обучение: боты без шпионажа и шортов (room.tutorial)", () => {
  const { room: r, meId, botIds } = Tut.buildRoom(E, "Инвестор");
  assert.ok(!E.rollDice(r, meId).error);
  assert.ok(!E.skipRoll(r, meId).error); // Apple ничья — пропустить можно
  assert.ok(!E.endTurn(r, meId).error);
  assert.equal(E.currentPlayerId(r), botIds[0]);
  fixRandom(0); // без флага при таком кубике бот полез бы в спецдействия до броска
  const s = E.botStep(r);
  assert.equal(s.type, "rollDice");
  assert.deepEqual([r.pendingRoll.row, r.pendingRoll.col], Tut.SCRIPT.botRolls[0][0]);
  return r;
});
test("обучение: битая очередь бросков — обычный случайный бросок", () => {
  const r = game(["A", "B"]);
  const A = P(r, "A");
  r.scriptedRolls = { [A.id]: [["x", 99]] };
  assert.ok(!E.rollDice(r, A.id).error);
  assert.ok(r.pendingRoll.row >= 1 && r.pendingRoll.row <= 12 && r.pendingRoll.col >= 1 && r.pendingRoll.col <= 12);
  assert.equal(r.scriptedRolls[A.id].length, 0, "запись израсходована");
  assert.equal(E.buildStatePayload(r, A.id).tutorial, false);
  return r;
});
test("обучение: ник совпал с ботом — игрок становится «Инвестором»", () => {
  const { room: r, meId } = Tut.buildRoom(E, "Бот Альфа");
  assert.equal(r.players.length, 3);
  assert.equal(r.players.find((p) => p.id === meId).name, "Инвестор");
  return r;
});

// ---------------------------------------------------------------------
// Срок решения контролёра (CONTROLLER_DECISION_MS): молчание контролёра
// не блокирует ход бросающего навсегда
// ---------------------------------------------------------------------
const expireControllerWait = (r) => { r.pendingRoll.controllerWaitSince = Date.now() - E.CONTROLLER_DECISION_MS - 1; };
function cellOf(ticker) {
  for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) if (E.BOARD[i][j] === ticker) return [i + 1, j + 1];
  throw new Error("нет клетки " + ticker);
}

test("контролёр молчит: до срока бросок не закрыть, после — плата по тарифу контролёру", () => {
  const { r, A, B, ticker } = rollOnHeld(["A", "B"], 60);
  A.cash = 1e7; // вдвоём плата по кривой (×11.3) больше стартового капитала — сценарий не о банкротстве
  fixRandom(0); // случайный пропуск выплаты на оплату по тарифу не влияет
  const meta0 = E.buildStatePayload(r, A.id).pendingRollMeta;
  assert.ok(Number.isFinite(r.pendingRoll.controllerWaitSince), "первый снимок не поставил метку ожидания");
  assert.ok(meta0.controllerWaitLeftMs > 0 && meta0.controllerWaitLeftMs <= E.CONTROLLER_DECISION_MS, "остаток " + meta0.controllerWaitLeftMs);
  assert.ok(E.dividendFromRoll(r, A.id).error, "оплата по тарифу до срока");
  assert.ok(E.skipRoll(r, A.id).error);
  assert.ok(E.endTurn(r, A.id).error);
  expireControllerWait(r);
  const meta = E.buildStatePayload(r, A.id).pendingRollMeta;
  assert.equal(meta.controllerWaitLeftMs, 0);
  assert.ok(meta.controllerFee > 0, "сумма по тарифу не посчитана");
  // Карта «выплата не проводится» тоже не превращает молчание контролёра в бесплатный отказ.
  r.companies[ticker].skipDividendUntil = r.eventCount + 3;
  const a0 = A.cash, b0 = B.cash;
  const res = E.dividendFromRoll(r, A.id);
  assert.ok(!res.error, res.error);
  assert.ok(Math.abs(a0 - A.cash - meta.controllerFee) < 1e-6, "списано не по тарифу");
  assert.ok(Math.abs(B.cash - b0 - meta.controllerFee) < 1e-6, "контролёр получил не всю плату");
  assert.equal(r.pendingRoll, null);
  assert.ok(r.log.some((e) => /по тарифу/.test(e.text)), "нет записи в ленте");
  assert.ok(!E.endTurn(r, A.id).error, "ход не завершается после оплаты по тарифу");
  return r;
});

test("контролёр: срок идёт с броска, без контролёра срока нет, назначенная цена его отменяет", () => {
  const r = game(["A", "B"]);
  const A = P(r, "A"), B = P(r, "B");
  B.holdings.AAPL = 60;
  r.scriptedRolls = { [A.id]: [cellOf("AAPL")] };
  const t0 = Date.now();
  assert.ok(!E.rollDice(r, A.id).error);
  assert.equal(r.pendingRoll.ticker, "AAPL");
  assert.ok(r.pendingRoll.controllerWaitSince >= t0, "срок не начался с броска");
  // Метка — обычное число: переживает сохранение комнаты (rooms.json, офлайн).
  const copy = JSON.parse(JSON.stringify(r));
  assert.equal(copy.pendingRoll.controllerWaitSince, r.pendingRoll.controllerWaitSince);
  expireControllerWait(copy);
  assert.equal(E.buildStatePayload(copy, A.id).pendingRollMeta.controllerWaitLeftMs, 0);
  // Цена назначена (пусть и после срока) — оплатить можно только её.
  fixRandom(0.99);
  assert.ok(!E.setForcedPrice(copy, B.id, 5000).error);
  assert.equal(E.buildStatePayload(copy, A.id).pendingRollMeta.controllerWaitLeftMs, null);
  assert.ok(E.dividendFromRoll(copy, A.id).error, "отказ по тарифу после назначенной цены");
  assert.ok(!E.payForcedPrice(copy, A.id).error);
  // Миноритарии без контролёра — срока нет, обычная плата за отказ.
  const minor = rollOnHeld(["A", "B"], 30);
  const m = E.buildStatePayload(minor.r, minor.A.id).pendingRollMeta;
  assert.equal(m.controllerWaitLeftMs, null);
  assert.equal(m.controllerFee, 0);
  assert.equal(minor.r.pendingRoll.controllerWaitSince, undefined);
  return [r, copy, minor.r];
});

test("контролёр-человек молчит, бросающий — бот: после срока бот платит по тарифу", () => {
  const r = E.freshRoom("T");
  E.addPlayer(r, "A", "", "", 0, "default", true);
  E.addPlayer(r, "B", "", "", 0, "default", false);
  assert.ok(!E.startGame(r, r.hostPlayerId).error);
  r.turnOrder = r.players.map((p) => p.id); // ходит бот A (startGame перемешивает)
  r.turnIndex = 0;
  r.settings.eventIntervalTurns = 100;
  const A = P(r, "A"), B = P(r, "B");
  B.holdings.AAPL = 100; // свободных акций нет — бот не может просто купить
  r.rolledThisTurn = true;
  r.pendingRoll = { playerId: A.id, row: 1, col: 1, ticker: "AAPL", realEstateId: null };
  fixRandom(0.99); // без спецдействий бота до броска
  assert.equal(E.botStep(r).acted, false, "бот не ждёт контролёра");
  assert.ok(r.pendingRoll, "бросок закрыт до срока");
  expireControllerWait(r);
  const b0 = B.cash;
  const s = E.botStep(r);
  assert.equal(s.type, "dividendFromRoll");
  assert.ok(!s.result.error, s.result.error);
  assert.ok(B.cash > b0, "контролёр ничего не получил");
  assert.equal(r.pendingRoll, null);
  return r;
});

// ---------------------------------------------------------------------
// Рейтинг: очки только за партию не короче MIN_TURNS_FOR_POINTS ходов
// ---------------------------------------------------------------------
test("рейтинг: банкротство соперника в короткой партии — победа без очков", () => {
  const r = game(["A", "B"]);
  E.declareBankruptcy(r, P(r, "B").id);
  assert.equal(r.phase, "ended");
  assert.equal(r.gameResult.winnerName, "A");
  assert.equal(r.gameResult.pointsEarned, 0);
  assert.equal(r.gameResult.noPointsReason, "short");
  assert.equal(r.gameResult.minTurnsForPoints, E.MIN_TURNS_FOR_POINTS);
  assert.ok(!r.lastGamePointsAward, "очки ушли бы в аккаунт");
  assert.equal(P(r, "A").points || 0, 0);
  assert.ok(r.log.some((e) => /слишком короткая/.test(e.text)), "нет записи в ленте");
  return r;
});

test("рейтинг: цикл «Новая партия» + банкротство очков не чеканит", () => {
  let r = game(["A", "B"]);
  const rooms = [];
  for (let i = 0; i < 5; i++) {
    E.declareBankruptcy(r, P(r, i % 2 ? "A" : "B").id);
    assert.equal(r.phase, "ended");
    assert.equal(r.gameResult.pointsEarned, 0, `партия ${i}`);
    assert.ok(!r.lastGamePointsAward);
    rooms.push(r);
    r = E.newGameKeepPlayers(r);
  }
  assert.ok(r.players.every((p) => !p.points), "очки накопились");
  return rooms;
});

test("рейтинг: порог в ходах — 39 мало, 40 достаточно (событие раз в 4 хода)", () => {
  const short = game(["A", "B"]);
  short.settings.eventIntervalTurns = 4;
  short.eventCount = 9; short.turn = 4; // 9 событий × 4 + 3 хода
  assert.equal(E.turnsPlayed(short), E.MIN_TURNS_FOR_POINTS - 1);
  E.declareBankruptcy(short, P(short, "B").id);
  assert.equal(short.gameResult.pointsEarned, 0);
  assert.equal(short.gameResult.noPointsReason, "short");
  const ok = game(["A", "B"]);
  ok.settings.eventIntervalTurns = 4;
  ok.eventCount = 10; ok.turn = 1;
  assert.equal(E.turnsPlayed(ok), E.MIN_TURNS_FOR_POINTS);
  E.declareBankruptcy(ok, P(ok, "B").id);
  assert.ok(ok.gameResult.pointsEarned > 0);
  assert.equal(ok.gameResult.noPointsReason, null);
  assert.deepEqual(ok.lastGamePointsAward, { playerId: P(ok, "A").id, amount: ok.gameResult.pointsEarned });
  // Интервал событий в 1 ход не удешевляет порог: 10 событий = 10 ходов — мало.
  const fast = game(["A", "B"]);
  fast.settings.eventIntervalTurns = 1;
  fast.eventCount = 10;
  E.declareBankruptcy(fast, P(fast, "B").id);
  assert.equal(fast.gameResult.pointsEarned, 0);
  return [short, ok, fast];
});

test("рейтинг: лимит в 1 раунд в обход меню — без очков; быстрый режим (15 раундов) — с очками", () => {
  const r = lobby(["A", "B"]);
  assert.ok(!E.setMaxRounds(r, r.hostPlayerId, 1).error);
  assert.ok(!E.startGame(r, r.hostPlayerId).error);
  fixRandom(0.5);
  for (let i = 0; i < 10 && r.phase === "roll"; i++) playTurn(r);
  assert.equal(r.phase, "ended");
  assert.equal(r.gameResult.pointsEarned, 0);
  assert.equal(r.gameResult.noPointsReason, "short");
  // Последний ход перед концом 15-раундовой партии.
  const q = lobby(["A", "B"]);
  assert.ok(!E.setMaxRounds(q, q.hostPlayerId, 15).error);
  assert.ok(!E.startGame(q, q.hostPlayerId).error);
  q.eventCount = 14; q.roundNumber = 15; q.turn = 4;
  playTurn(q);
  assert.equal(q.phase, "ended");
  assert.equal(E.turnsPlayed(q), 60);
  assert.ok(q.gameResult.pointsEarned > 0, "быстрый режим лобби остался без очков");
  return [r, q];
});

test("рейтинг: причина «разорились все» не путается с исключением", () => {
  const r = game(["A", "B"]);
  r.eventCount = 50;
  for (const p of r.players) { p.holdings = {}; p.cash = -1000; E.settleDebt(r, p); }
  E.checkEndGame(r);
  assert.equal(r.phase, "ended");
  assert.equal(r.gameResult.pointsEarned, 0);
  assert.equal(r.gameResult.noPointsReason, "allBankrupt");
  return r;
});

// ---------------------------------------------------------------------
// Эксплойты из BALANCE-REPORT.md (группа А)
// ---------------------------------------------------------------------
test("продажа банку: цена падает до расчёта — «купил и тут же продал» не приносит прибыли", () => {
  fixRandom(0.5);
  const r = game(["A", "B"]);
  const A = P(r, "A");
  const c = r.companies.AAPL;
  A.holdings.AAPL = 20;
  const priceBefore = c.price;
  const cash0 = A.cash;
  assert.ok(!E.sellBank(r, A.id, "AAPL", 20).error);
  assert.ok(c.price < priceBefore, "цена не упала");
  assert.ok(Math.abs((A.cash - cash0) - c.price * 0.2) < 1e-6, "выручка посчитана не по новой цене");
  return r;
});

test("шорт: без контрольного пакета недоступен, с пакетом — можно", () => {
  fixRandom(0.5);
  const r = game(["A", "B"]);
  const A = P(r, "A");
  assert.ok(E.ctrlShort(r, A.id, "AAPL").error, "шорт без контроля принят");
  A.holdings.MSFT = 60;
  const res = E.ctrlShort(r, A.id, "AAPL");
  assert.ok(!res.error, res.error);
  return r;
});

test("плата за отказ: в настройках лобби не ниже 1% (при 0% партия зависала)", () => {
  const r = lobby(["A", "B"]);
  assert.ok(!E.updateRoomSettings(r, r.hostPlayerId, { tierForcedPaymentPct: [0, 0, 0] }).error);
  assert.deepEqual(r.settings.tierForcedPaymentPct, [1, 1, 1]);
});

test("порядок ходов: при старте перемешивается и пишется в ленту, в реванше начинает следующий", () => {
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const r = lobby(["A", "B", "C", "D"]);
    E.startGame(r, r.hostPlayerId);
    seen.add(nameOf(r, E.currentPlayerId(r)));
    assert.ok(r.log.some((e) => /Порядок ходов:/.test(e.text)), "порядок не записан в ленту");
  }
  assert.ok(seen.size > 1, "первым всегда ходит один и тот же игрок");
  const r = game(["A", "B", "C"]);
  const order = r.turnOrder.map((id) => nameOf(r, id));
  r.phase = "ended";
  const fresh = E.newGameKeepPlayers(r);
  assert.deepEqual(fresh.turnOrder.map((id) => nameOf(fresh, id)), order.slice(1).concat(order[0]));
  return fresh;
});

test("ничья по капиталу при лимите раундов: побеждает тот, у кого больше наличных", () => {
  const r = game(["A", "B"]);
  const A = P(r, "A"), B = P(r, "B");
  A.cash = 100000; B.cash = 100000;
  B.holdings = {}; A.holdings = {};
  // Равный капитал, но у B больше наличных: часть капитала A — в акциях.
  A.cash = 90000; A.holdings.AAPL = 10;
  const tenPct = r.companies.AAPL.price * 0.1;
  B.cash = 90000 + tenPct;
  assert.ok(Math.abs(E.netWorth(r, A) - E.netWorth(r, B)) < 0.5);
  r.maxRounds = 1; r.roundNumber = 2;
  E.checkEndGame(r);
  assert.equal(r.phase, "ended");
  assert.equal(r.gameResult.winnerName, "B");
  return r;
});

// ---------------------------------------------------------------------
// Пакет баланса А5 + Б1–Б4 (BALANCE-REPORT.md, раздел 0): бот движка,
// кредит, настройки новой комнаты, плата по тарифу после срока контролёра
// ---------------------------------------------------------------------
// Ходящий бот A стоит на клетке ticker (все игроки — боты).
function botRollOn(names, ticker) {
  const r = game(names, true);
  const A = P(r, "A");
  r.rolledThisTurn = true;
  r.pendingRoll = { playerId: A.id, row: 1, col: 1, ticker: ticker || "AAPL", realEstateId: null };
  return { r, A, B: P(r, "B") };
}
// Цена покупки по броску с комиссией банка — та же формула, что rollBuyCost в движке.
const rollCost = (r, p, ticker, pct) => r.companies[ticker].price * (pct / 100) * (1 + E.bankFeePct(p.reputation));

test("бот А5: на 5% денег хватает — покупает 5% (или остаток), а не платит за отказ", () => {
  fixRandom(0.99); // без спецдействий и случайного пропуска выплаты
  const { r, A, B } = botRollOn(["A", "B"]);
  B.holdings.AAPL = 30;
  A.cash = 10000; // меньше резерва $15 000 — botChoosePct сам ничего бы не купил
  const cost = rollCost(r, A, "AAPL", 5);
  const b0 = B.cash;
  const s = E.botStep(r);
  assert.equal(s.type, "buyFromRoll");
  assert.ok(!s.result.error, s.result.error);
  assert.equal(A.holdings.AAPL, 5);
  assert.ok(Math.abs(10000 - A.cash - cost) < 1e-6, "списано не по цене 5%");
  assert.equal(B.cash, b0, "держатель получил плату за отказ");
  assert.equal(r.pendingRoll, null);
  // Свободно 3% (остальное у бота-контролёра) — бот берёт остаток, контролёр цену не назначает.
  const rest = botRollOn(["A", "B"]);
  rest.B.holdings.AAPL = 97;
  rest.A.cash = 10000;
  const s2 = E.botStep(rest.r);
  assert.equal(s2.type, "buyFromRoll");
  assert.equal(rest.A.holdings.AAPL, 3);
  assert.equal(rest.r.pendingForcedPrice, null);
  return [r, rest.r];
});

test("бот А5: на 5% денег не хватает — платит за отказ (dividendFromRoll)", () => {
  fixRandom(0.99);
  // Стол на 4: вдвоём плата по кривой (×11.3) выше цены самих 5% — на неё
  // тоже не хватило бы, и сценарий превратился бы в банкротство.
  const { r, A, B } = botRollOn(["A", "B", "C", "D"]);
  B.holdings.AAPL = 5;
  A.cash = 1500;
  assert.ok(A.cash < rollCost(r, A, "AAPL", 5));
  // тир A: 60% капитализации × эффективная доля держателя (кривая платы)
  const fee = r.companies.AAPL.price * 0.6 * E.holdersFeeFactor(r, 5);
  assert.ok(fee < A.cash, `плата ${fee} не по карману — сценарий не воспроизведён`);
  const b0 = B.cash;
  const s = E.botStep(r);
  assert.equal(s.type, "dividendFromRoll");
  assert.ok(!s.result.error, s.result.error);
  assert.ok(!A.holdings.AAPL, "бот купил без денег");
  assert.ok(Math.abs(B.cash - b0 - fee) < 1e-6, "держатель не получил плату за отказ");
  assert.equal(r.pendingRoll, null);
  return r;
});

test("бот А5: отказ бесплатен (карта новостей, держатель выбыл) — запасной покупки нет", () => {
  fixRandom(0.99);
  // Карта «выплата не проводится»: отказ ничего не стоит — тратить деньги незачем.
  const card = botRollOn(["A", "B"]);
  card.B.holdings.AAPL = 30;
  card.A.cash = 10000;
  card.r.companies.AAPL.skipDividendUntil = card.r.eventCount + 2;
  const b0 = card.B.cash;
  let s = E.botStep(card.r);
  assert.equal(s.type, "dividendFromRoll");
  assert.ok(!card.A.holdings.AAPL, "купил, хотя отказ бесплатен");
  assert.equal(card.A.cash, 10000);
  assert.equal(card.B.cash, b0);
  // Единственный держатель выбыл — платить некому, покупки тоже нет.
  const gone = botRollOn(["A", "B", "C"]);
  gone.B.holdings.AAPL = 30;
  gone.B.bankrupt = true;
  gone.A.cash = 10000;
  s = E.botStep(gone.r);
  assert.equal(s.type, "dividendFromRoll");
  assert.ok(!gone.A.holdings.AAPL);
  assert.equal(gone.A.cash, 10000);
  // Карта не освобождает от единоличного контролёра — с ним бот по-прежнему берёт 5%.
  const ctrl = botRollOn(["A", "B"]);
  ctrl.B.holdings.AAPL = 60;
  ctrl.A.cash = 10000;
  ctrl.r.companies.AAPL.skipDividendUntil = ctrl.r.eventCount + 2;
  s = E.botStep(ctrl.r);
  assert.equal(s.type, "buyFromRoll");
  assert.equal(ctrl.A.holdings.AAPL, 5);
  return [card.r, gone.r, ctrl.r];
});

test("бот А5: сделку на 1 цент дороже рынка отклоняет, по рынку — принимает", () => {
  const r = game(["A", "B"]);
  const A = P(r, "A"), B = P(r, "B");
  B.isBot = true;
  A.holdings.AAPL = 25;
  // 25% по $39 999.96 = $9 999.99 — предложение за $10 000 дороже рынка на цент.
  r.companies.AAPL.price = 39999.96;
  assert.ok(!E.proposeTrade(r, A.id, B.id, "AAPL", 25, 10000).error);
  let s = E.botStep(r);
  assert.equal(s.type, "respondTrade");
  assert.ok(!s.result.error, s.result.error);
  assert.equal(A.holdings.AAPL, 25, "бот купил дороже рынка");
  assert.ok(!B.holdings.AAPL);
  r.companies.AAPL.price = 40000; // 25% = ровно $10 000
  const a0 = A.cash;
  assert.ok(!E.proposeTrade(r, A.id, B.id, "AAPL", 25, 10000).error);
  s = E.botStep(r);
  assert.equal(s.type, "respondTrade");
  assert.ok(!s.result.error, s.result.error);
  assert.equal(B.holdings.AAPL, 25, "бот отказался от сделки по рынку");
  assert.equal(A.cash, a0 + 10000);
  return r;
});

test("кредит Б2: ставка 6 / 3.5 / 1% за событие при репутации 0 / 50 / 100", () => {
  const r = game(["A", "B"]);
  const A = P(r, "A");
  for (const [rep, rate] of [[0, 6], [20, 5], [50, 3.5], [90, 1.5], [100, 1]]) {
    A.reputation = rep;
    assert.equal(E.loanTerms(r, A).ratePct, rate, "репутация " + rep);
  }
  return r;
});

test("кредит Б2: бонус за полное погашение — кредит не моложе 2 событий и не символический", () => {
  const r = game(["A", "B"]);
  const A = P(r, "A");
  const take = (amount) => assert.ok(!E.takeLoan(r, A.id, amount).error, "takeLoan " + amount);
  const repayAll = () => assert.ok(!E.repayLoan(r, A.id, A.loan.principal).error);
  // Капитал при выдаче ≈ $100 000 — «настоящий» кредит от $10 000.
  r.eventCount = 10;
  take(20000);
  r.eventCount = 11;
  let rep0 = A.reputation;
  repayAll();
  assert.equal(A.loan, null);
  assert.equal(A.reputation, rep0, "бонус за кредит, проживший одно событие");
  take(20000);
  r.eventCount = 13;
  rep0 = A.reputation;
  repayAll();
  assert.equal(A.reputation, rep0 + 3, "нет бонуса за кредит, проживший два события");
  take(5000); // меньше 10% капитала
  r.eventCount = 15;
  rep0 = A.reputation;
  repayAll();
  assert.equal(A.reputation, rep0, "бонус за символический кредит");
  return r;
});

test("кредит: бонус за частичное погашение не фармится (возраст, размер, раз в событие на игрока)", () => {
  const r = game(["A", "B"]);
  const A = P(r, "A");
  const take = (amount) => assert.ok(!E.takeLoan(r, A.id, amount).error, "takeLoan " + amount);
  const repay = (amount) => assert.ok(!E.repayLoan(r, A.id, amount).error, "repayLoan " + amount);
  r.eventCount = 10;
  const rep0 = A.reputation;
  // Цикл из отчёта: взять — погасить 10% — погасить остаток; раньше +1 за круг.
  for (let i = 0; i < 50; i++) { take(20000); repay(2000); repay(A.loan.principal); }
  assert.equal(A.reputation, rep0, "цикл «взять — 10% — остаток» поднял репутацию");
  // Кредит прожил событие: первый ощутимый платёж — +1, второй в том же событии — нет.
  take(20000);
  r.eventCount = 11;
  repay(2000);
  assert.equal(A.reputation, rep0 + 1, "нет бонуса за честный частичный платёж");
  repay(2000);
  assert.equal(A.reputation, rep0 + 1, "второй бонус в том же событии");
  // Отметка — на игроке: новый кредит (даже «состаренный») её не сбрасывает.
  repay(A.loan.principal);
  take(20000);
  A.loan.takenEvent = 9;
  repay(2000);
  assert.equal(A.reputation, rep0 + 1, "новый кредит сбросил отметку бонуса");
  // В следующем событии — снова можно, но платёж меньше 10% кредита бонуса не даёт.
  r.eventCount = 12;
  repay(1000);
  assert.equal(A.reputation, rep0 + 1, "бонус за платёж меньше 10% кредита");
  repay(2000);
  assert.equal(A.reputation, rep0 + 2);
  repay(A.loan.principal);
  // Мелкие кредиты: меньше $1000 и меньше 10% капитала при выдаче — без бонуса
  // (раньше кредит $1000 с платежами по $100 за ход давал репутацию почти даром).
  for (const amount of [900, 5000]) {
    take(amount);
    r.eventCount++;
    const before = A.reputation;
    repay(Math.ceil(amount * 0.2));
    assert.equal(A.reputation, before, "бонус за символический кредит " + amount);
    repay(A.loan.principal);
  }
  return r;
});

test("новая комната: «до банкротства» со страховкой 150 ходов у каждого и плата за отказ [60, 45, 30] по кривой", () => {
  const r = E.freshRoom("T");
  // Длительность — в своих ходах у каждого; раунды посчитает startGame.
  assert.equal(r.maxRounds, null);
  assert.equal(r.settings.maxTurnsPerPlayer, 150);
  assert.equal(E.DEFAULT_MAX_TURNS_PER_PLAYER, 150);
  assert.deepEqual(r.settings.tierForcedPaymentPct, [60, 45, 30]);
  assert.deepEqual(E.TIER_FORCED_PAYMENT_PCT, { A: 0.6, B: 0.45, C: 0.3 });
  // Кривая платы (BALANCE-REPORT.md, раздел 00): K = 1.5, P = 1, N_EXP = 3.5, потолок стола 6.5.
  assert.equal(E.FEE_CURVE_K, 1.5);
  assert.equal(E.FEE_CURVE_P, 1);
  assert.equal(E.FEE_CURVE_N_EXP, 3.5);
  assert.equal(E.FEE_CURVE_N_MAX, 6.5);
  // Клиенту уходят те же значения; ключ maxTurnsPerPlayer есть всегда (null — старая комната).
  E.addPlayer(r, "A", "", "", 0, "default", false);
  const st = E.buildStatePayload(r, r.players[0].id);
  assert.equal(st.settings.maxTurnsPerPlayer, 150);
  assert.deepEqual(st.settings.tierForcedPaymentPct, [60, 45, 30]);
  assert.equal(st.maxRounds, null);
  delete r.settings.maxTurnsPerPlayer;
  delete r.settings.tierForcedPaymentPct;
  const legacy = E.buildStatePayload(r, r.players[0].id);
  assert.ok("maxTurnsPerPlayer" in legacy.settings);
  assert.equal(legacy.settings.maxTurnsPerPlayer, null);
  assert.deepEqual(legacy.settings.tierForcedPaymentPct, [60, 45, 30], "запасное значение без настроек");
  return r;
});

test("контролёр молчит: плата по тарифу не выше потолка цены выкупа", () => {
  fixRandom(0.99);
  // Тир C (×1.4), полное поглощение (×3), Дивидендный сезон (×2): без потолка — 8.4 справедливой цены.
  const { r, A, B, ticker } = rollOnHeld(["A", "B"], 100, "YDEX");
  A.cash = 1e7; // вдвоём плата по кривой (×11.3) больше стартового капитала — сценарий о потолке, не о банкротстве
  r.companies[ticker].fullyOwned = true;
  r.dividendMultiplier = 2;
  expireControllerWait(r);
  const cap = E.forcedPriceCap(r, ticker, 100);
  const meta = E.buildStatePayload(r, A.id).pendingRollMeta;
  assert.equal(meta.controllerFee, cap, "подсказка клиенту не равна потолку");
  const a0 = A.cash, b0 = B.cash;
  assert.ok(!E.dividendFromRoll(r, A.id).error);
  assert.ok(Math.abs(a0 - A.cash - cap) < 1e-6, "списано больше потолка");
  assert.ok(Math.abs(B.cash - b0 - cap) < 1e-6, "контролёр получил не потолок");
  assert.ok(r.log.some((e) => /потолком цены выкупа/.test(e.text)), "в ленте нет пометки о потолке");
  // Перебор тиров и множителей: списано не больше потолка и ровно столько, сколько в подсказке.
  const rooms = [r];
  for (const t of ["AAPL", "NVDA", "YDEX"]) for (const mult of [1, 2]) for (const flag of ["", "squeezedOut", "fullyOwned"]) {
    const x = rollOnHeld(["A", "B"], flag === "fullyOwned" ? 100 : 80, t);
    x.A.cash = 1e7;
    if (flag) x.r.companies[t][flag] = true;
    x.r.dividendMultiplier = mult;
    expireControllerWait(x.r);
    const fee = E.buildStatePayload(x.r, x.A.id).pendingRollMeta.controllerFee;
    const c0 = x.A.cash;
    assert.ok(!E.dividendFromRoll(x.r, x.A.id).error);
    const paid = c0 - x.A.cash;
    const label = `${t} ×${mult} ${flag || "без сквиз-аута"}`;
    assert.ok(paid > 0 && paid <= E.forcedPriceCap(x.r, t, x.B.holdings[t]) + 1e-6, `${label}: ${paid}`);
    assert.ok(Math.abs(paid - fee) < 1e-6, `${label}: подсказка ${fee}, списано ${paid}`);
    // Без множителей потолок не мешает — ровно тариф.
    if (t === "AAPL" && mult === 1 && !flag) assert.ok(Math.abs(paid - x.r.companies[t].price * 0.6 * E.holdersFeeFactor(x.r, 80)) < 1e-6, label);
    rooms.push(x.r);
  }
  return rooms;
});

test("бот: покупка по броску не прошла — бросок закрывается отказом, насос не зацикливается", () => {
  fixRandom(0.99);
  // Имитация расхождения расчётов цены: внутри buyFromRoll наличных бота на цент
  // меньше цены 5%, а botBuyPct видит настоящие — бот решает «хватает», движок
  // отвечает «недостаточно наличных».
  const poorInBuy = (p, buyCost) => {
    let value = p.cash;
    const seen = { buy: 0 };
    Object.defineProperty(p, "cash", {
      configurable: true, enumerable: true,
      get() { if (/\bbuyFromRoll\b/.test(new Error().stack)) { seen.buy++; return buyCost - 0.01; } return value; },
      set(v) { value = v; },
    });
    return seen;
  };
  const plain = (p) => { const v = p.cash; Object.defineProperty(p, "cash", { value: v, writable: true, enumerable: true, configurable: true }); };
  // Держатель-миноритарий: бот сразу платит за отказ.
  const { r, A, B } = botRollOn(["A", "B"]);
  B.holdings.AAPL = 5;
  A.cash = 16000; // botChoosePct ещё ничего не берёт, запасные 5% — по карману
  const seen = poorInBuy(A, rollCost(r, A, "AAPL", 5));
  const b0 = B.cash;
  const s = E.botStep(r);
  assert.ok(seen.buy > 0, "бот не пытался купить — сценарий не воспроизведён");
  assert.equal(s.type, "dividendFromRoll");
  assert.ok(!s.result.error, s.result.error);
  assert.ok(!A.holdings.AAPL);
  assert.ok(B.cash > b0, "держатель не получил плату за отказ");
  assert.equal(r.pendingRoll, null, "бросок остался висеть");
  assert.equal(E.botStep(r).type, "endTurn");
  plain(A);
  // Отказ тоже пока невозможен (контролёр-человек думает) — бот ждёт (acted: false),
  // а не повторяет неудачную покупку; после срока платит по тарифу.
  const w = botRollOn(["A", "B"]);
  w.B.isBot = false;
  w.B.holdings.AAPL = 60;
  w.A.cash = 16000;
  const seenW = poorInBuy(w.A, rollCost(w.r, w.A, "AAPL", 5));
  for (let i = 0; i < 5; i++) assert.equal(E.botStep(w.r).acted, false, "насос крутит неудачную покупку");
  assert.ok(seenW.buy > 0, "бот не пытался купить");
  assert.ok(w.r.pendingRoll);
  expireControllerWait(w.r);
  const s2 = E.botStep(w.r);
  assert.equal(s2.type, "dividendFromRoll");
  assert.ok(!s2.result.error, s2.result.error);
  assert.equal(w.r.pendingRoll, null);
  plain(w.A);
  return [r, w.r];
});

// ---------------------------------------------------------------------
// Кривая платы за отказ (FEE_CURVE_K / FEE_CURVE_P / FEE_CURVE_N_EXP /
// FEE_CURVE_N_MAX): при K = 0 и N_EXP = 0 нейтральна, при K > 0 плата и цена
// выкупа растут быстрее доли держателей, а подсказки клиенту совпадают со
// списанием. По умолчанию K = 1.5, P = 1, N_EXP = 3.5, N_MAX = 6.5.
// ---------------------------------------------------------------------
// Копия движка с другими значениями верхнеуровневых констант — как
// --override в tools/sim: литерал в «const NAME = …;» заменяется до исполнения.
function engineWith(consts) {
  let src = require("fs").readFileSync(path.join(__dirname, "..", "public", "engine.js"), "utf8");
  for (const [name, value] of Object.entries(consts)) {
    const re = new RegExp(`^(  )const ${name} = [^;\\n]+;`, "m");
    assert.ok(re.test(src), `в engine.js нет «const ${name} = …;»`);
    src = src.replace(re, `$1const ${name} = ${JSON.stringify(value)};`);
  }
  const m = { exports: {} };
  new Function("module", src)(m);
  return m.exports;
}
// Как rollOnHeld, но на заданной копии движка; ботом может быть только B.
function rollOnHeldWith(X, names, heldPct, ticker, botB) {
  const r = X.freshRoom("T");
  names.forEach((n) => X.addPlayer(r, n, "", "", 0, "default", !!botB && n === "B"));
  const res = X.startGame(r, r.hostPlayerId);
  assert.ok(!res.error, "startGame: " + res.error);
  r.turnOrder = r.players.map((p) => p.id);
  r.turnIndex = 0;
  r.settings.eventIntervalTurns = 100;
  const A = P(r, "A"), B = P(r, "B");
  B.holdings[ticker] = heldPct;
  r.rolledThisTurn = true;
  r.pendingRoll = { playerId: A.id, row: 1, col: 1, ticker, realEstateId: null };
  return { r, A, B };
}

test("кривая платы: K = 0 и N_EXP = 0 — нейтральна (прежняя линейная плата), подсказки выкупа — суммы движка", () => {
  const X = engineWith({ FEE_CURVE_K: 0, FEE_CURVE_N_EXP: 0 });
  const r = rollOnHeldWith(X, ["A", "B", "C"], 0, "AAPL").r;
  for (let pct = 0; pct <= 100; pct++) assert.equal(X.holdersFeeFactor(r, pct), pct / 100, `доля ${pct}%`);
  // Контролёр (70% NVDA, тир B, ставка 45%): справедливая цена и потолок в
  // pendingRollMeta — ровно те, что проверит setForcedPrice.
  const x = rollOnHeldWith(X, ["A", "B"], 70, "NVDA");
  const meta = X.buildStatePayload(x.r, x.B.id).pendingRollMeta;
  const fair = x.r.companies.NVDA.price * 0.45 * 0.7;
  assert.equal(meta.fairPrice, Math.round(fair));
  assert.equal(meta.fairPrice, Math.round(X.forcedFairPrice(x.r, "NVDA", 70)));
  assert.equal(meta.priceCap, X.forcedPriceCap(x.r, "NVDA", 70));
  assert.equal(meta.priceCap, Math.max(1, Math.round(fair * 6)));
  assert.equal(meta.feeCurve, false);
  // Миноритарии без контролёра: сумм выкупа нет, плата за отказ — линейная.
  const y = rollOnHeldWith(X, ["A", "B"], 30, "AAPL");
  const m2 = X.buildStatePayload(y.r, y.A.id).pendingRollMeta;
  assert.equal(m2.fairPrice, 0);
  assert.equal(m2.priceCap, 0);
  assert.ok(Math.abs(m2.refuseAmount - y.r.companies.AAPL.price * 0.6 * 0.3) < 1e-9, `refuseAmount ${m2.refuseAmount}`);
  return [r, x.r, y.r];
});

test("кривая платы: K > 0 — плата за отказ и цена выкупа растут быстрее доли", () => {
  fixRandom(0.99); // без случайного пропуска выплаты
  // Без поправки на стол (N_EXP = 0) — проверяется только форма кривой.
  const X = engineWith({ FEE_CURVE_K: 2, FEE_CURVE_P: 1, FEE_CURVE_N_EXP: 0 });
  const r = rollOnHeldWith(X, ["A", "B"], 0, "AAPL").r;
  // f(x) = x × (1 + 2x): 25% → 0.375, 50% → 1, 100% → 3 (втрое дороже линейной).
  const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} ≠ ${b}`);
  near(X.holdersFeeFactor(r, 25), 0.375, "25%");
  near(X.holdersFeeFactor(r, 50), 1, "50%");
  near(X.holdersFeeFactor(r, 100), 3, "100%");
  assert.equal(X.holdersFeeFactor(r, 0), 0);
  for (let pct = 2; pct <= 100; pct++) {
    assert.ok(X.holdersFeeFactor(r, pct) / pct > X.holdersFeeFactor(r, pct - 1) / (pct - 1), `надбавка не растёт на ${pct}%`);
  }
  // Миноритарий 40% AAPL: подпись «Отказаться» = списание = цена × 60% × 0.4 × 1.8.
  const m = rollOnHeldWith(X, ["A", "B"], 40, "AAPL");
  const refuse = X.buildStatePayload(m.r, m.A.id).pendingRollMeta.refuseAmount;
  near(refuse, m.r.companies.AAPL.price * 0.6 * 0.4 * 1.8, "refuseAmount");
  const a0 = m.A.cash;
  assert.ok(!X.dividendFromRoll(m.r, m.A.id).error);
  near(a0 - m.A.cash, refuse, "списано за отказ");
  // Контролёр 80% NVDA: справедливая цена, потолок и плата по тарифу — по той же кривой.
  const c = rollOnHeldWith(X, ["A", "B"], 80, "NVDA");
  const fair = c.r.companies.NVDA.price * 0.45 * 0.8 * 2.6;
  const meta = X.buildStatePayload(c.r, c.B.id).pendingRollMeta;
  assert.equal(meta.fairPrice, Math.round(fair));
  assert.equal(meta.priceCap, Math.max(1, Math.round(fair * 6)));
  near(meta.controllerFee, fair, "плата по тарифу (тир B без множителей — справедливая цена)");
  assert.ok(X.setForcedPrice(c.r, c.B.id, meta.priceCap + 1).error, "потолок не проверяется по кривой");
  assert.ok(!X.setForcedPrice(c.r, c.B.id, meta.priceCap).error, "ровно потолок отклонён");
  // Срок решения вышел — бросающий платит ровно подсказку controllerFee.
  const d = rollOnHeldWith(X, ["A", "B"], 80, "NVDA");
  d.r.pendingRoll.controllerWaitSince = Date.now() - X.CONTROLLER_DECISION_MS - 1;
  const fee = X.buildStatePayload(d.r, d.A.id).pendingRollMeta.controllerFee;
  const d0 = d.A.cash;
  assert.ok(!X.dividendFromRoll(d.r, d.A.id).error);
  near(d0 - d.A.cash, fee, "списано по тарифу");
  // Бот-контролёр назначает цену от той же справедливой цены: fair × (1.5 + 0.99).
  const b = rollOnHeldWith(X, ["A", "B"], 80, "NVDA", true);
  const bs = X.botStep(b.r);
  assert.equal(bs.type, "setForcedPrice");
  assert.ok(!bs.result.error, bs.result.error);
  assert.equal(b.r.pendingForcedPrice.amount, Math.round(b.r.companies.NVDA.price * 0.45 * 0.8 * 2.6 * 2.49));
  return [r, m.r, c.r, d.r, b.r];
});

test("кривая платы: FEE_CURVE_N_EXP — поправка на число активных игроков, FEE_CURVE_N_MAX — её потолок", () => {
  const X = engineWith({ FEE_CURVE_K: 0, FEE_CURVE_N_EXP: 1, FEE_CURVE_N_MAX: 99 });
  const two = rollOnHeldWith(X, ["A", "B"], 0, "AAPL").r;
  const four = rollOnHeldWith(X, ["A", "B", "C", "D"], 0, "AAPL").r;
  assert.ok(Math.abs(X.holdersFeeFactor(two, 30) - 0.6) < 1e-12, "вдвоём — ×2");
  assert.equal(X.holdersFeeFactor(four, 30), 0.3, "вчетвером — без поправки");
  four.players[3].bankrupt = true; // выбывшие не считаются: трое активных — ×4/3
  assert.ok(Math.abs(X.holdersFeeFactor(four, 30) - 0.4) < 1e-12, "трое активных — ×4/3");
  const eight = rollOnHeldWith(X, ["A", "B", "C", "D", "E", "F", "G", "H"], 0, "AAPL").r;
  assert.ok(Math.abs(X.holdersFeeFactor(eight, 30) - 0.15) < 1e-12, "без потолка ввосьмером — ×1/2");
  // Потолок 6: за столом на 8 поправка как на 6, на 2–6 игроков он не влияет.
  const Y = engineWith({ FEE_CURVE_K: 0, FEE_CURVE_N_EXP: 1, FEE_CURVE_N_MAX: 6 });
  const eightY = rollOnHeldWith(Y, ["A", "B", "C", "D", "E", "F", "G", "H"], 0, "AAPL").r;
  assert.ok(Math.abs(Y.holdersFeeFactor(eightY, 30) - 0.2) < 1e-12, "с потолком 6 ввосьмером — ×4/6");
  const twoY = rollOnHeldWith(Y, ["A", "B"], 0, "AAPL").r;
  assert.ok(Math.abs(Y.holdersFeeFactor(twoY, 30) - 0.6) < 1e-12, "вдвоём потолок не влияет");
  return [two, eight, eightY];
});

test("кривая платы по умолчанию: K = 1.5, P = 1 — 20/50/80% и множитель стола (4/n)^3.5, n ≤ 6.5", () => {
  const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} ≠ ${b}`);
  const r4 = game(["A", "B", "C", "D"]);
  // Вчетвером множитель стола ×1: f(x) = x × (1 + 1.5x).
  near(E.holdersFeeFactor(r4, 20), 0.26, "20%"); // в 1.3 раза дороже линейной
  near(E.holdersFeeFactor(r4, 50), 0.875, "50%"); // в 1.75 раза
  near(E.holdersFeeFactor(r4, 80), 1.76, "80%"); // в 2.2 раза
  near(E.holdersFeeFactor(r4, 100), 2.5, "100%");
  assert.equal(E.holdersFeeFactor(r4, 0), 0);
  // Плата растёт быстрее доли: надбавка к линейной увеличивается с каждым процентом.
  for (let pct = 2; pct <= 100; pct++) {
    assert.ok(E.holdersFeeFactor(r4, pct) / pct > E.holdersFeeFactor(r4, pct - 1) / (pct - 1), `надбавка не растёт на ${pct}%`);
  }
  // Множитель стола по числу активных игроков: 2 → ×11.3, 3 → ×2.74, 5 → ×0.46,
  // 6 → ×0.24, 7 и 8 — как 6.5 (×0.18).
  const names = ["A", "B", "C", "D", "E", "F", "G", "H"];
  const rooms = [r4];
  const expect = { 2: 11.3137, 3: 2.7371, 4: 1, 5: 0.4579, 6: 0.2419, 7: 0.1828, 8: 0.1828 };
  for (let n = 2; n <= 8; n++) {
    const r = game(names.slice(0, n));
    const mult = E.holdersFeeFactor(r, 50) / 0.875;
    near(mult, Math.pow(4 / Math.min(6.5, n), 3.5), `${n} игроков`);
    assert.ok(Math.abs(mult - expect[n]) < 1e-4, `${n} игроков: ×${mult}`);
    rooms.push(r);
  }
  // Выбывшие не считаются: из четверых один банкрот — множитель как за столом на 3.
  r4.players[3].bankrupt = true;
  near(E.holdersFeeFactor(r4, 50), 0.875 * Math.pow(4 / 3, 3.5), "трое активных");
  return rooms;
});

test("кривая платы по умолчанию: подпись «Отказаться» = списание, цена выкупа и потолок — по той же кривой", () => {
  fixRandom(0.99); // без случайного пропуска выплаты
  const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} ≠ ${b}`);
  // Стол на 4, KO (тир B, ставка 45%): у B 20%, у C 30% — вместе 50%, контролёра нет.
  const x = rollOnHeld(["A", "B", "C", "D"], 20, "KO");
  const C = P(x.r, "C");
  C.holdings.KO = 30;
  const price = x.r.companies.KO.price;
  const meta = E.buildStatePayload(x.r, x.A.id).pendingRollMeta;
  assert.equal(meta.feeCurve, true);
  near(meta.feeFactor, 0.875, "эффективная доля");
  near(meta.refuseAmount, price * 0.45 * 0.875, "refuseAmount"); // 39.4% цены вместо 22.5%
  const a0 = x.A.cash, b0 = x.B.cash, c0 = C.cash;
  assert.ok(!E.dividendFromRoll(x.r, x.A.id).error);
  near(a0 - x.A.cash, meta.refuseAmount, "списано за отказ");
  near((x.B.cash - b0) + (C.cash - c0), meta.refuseAmount, "держатели получили не всю плату");
  near(x.B.cash - b0, meta.refuseAmount * 0.4, "доля B (20 из 50)");
  // В ленте — ставка класса, а не «45% капитализации» (сумма — 39.4% цены).
  const refuseLog = x.r.log.filter((e) => /отказался от покупки KO/.test(e.text)).pop();
  assert.ok(refuseLog && /по ставке класса 45%/.test(refuseLog.text) && !/капитализации/.test(refuseLog.text), refuseLog && refuseLog.text);
  // Контролёр 80% NVDA вчетвером: справедливая цена = цена × 45% × 1.76, потолок — 6 таких.
  const c = rollOnHeld(["A", "B", "C", "D"], 80, "NVDA");
  const fair = c.r.companies.NVDA.price * 0.45 * 1.76;
  const cm = E.buildStatePayload(c.r, c.B.id).pendingRollMeta;
  assert.equal(cm.fairPrice, Math.round(fair));
  assert.equal(cm.fairPrice, Math.round(E.forcedFairPrice(c.r, "NVDA", 80)));
  assert.equal(cm.priceCap, Math.max(1, Math.round(fair * 6)));
  assert.equal(cm.priceCap, E.forcedPriceCap(c.r, "NVDA", 80));
  near(cm.controllerFee, fair, "плата по тарифу (тир B без множителей — справедливая цена)");
  assert.ok(E.setForcedPrice(c.r, c.B.id, cm.priceCap + 1).error, "потолок не проверяется по кривой");
  assert.ok(!E.setForcedPrice(c.r, c.B.id, cm.priceCap).error, "ровно потолок отклонён");
  // Плата и справедливая цена — одна формула: отказ миноритариям при той же доле
  // равен справедливой цене контролёра (тир B, без множителей).
  const m = rollOnHeld(["A", "B", "C", "D"], 40, "NVDA");
  P(m.r, "C").holdings.NVDA = 40;
  near(E.buildStatePayload(m.r, m.A.id).pendingRollMeta.refuseAmount, E.forcedFairPrice(m.r, "NVDA", 80), "отказ = справедливая цена");
  return [x.r, c.r, m.r];
});

// ---------------------------------------------------------------------
// Длительность партии в своих ходах у каждого (settings.maxTurnsPerPlayer):
// раунды считаются при старте по числу игроков, старые комнаты живут по maxRounds
// ---------------------------------------------------------------------
test("длительность: maxTurnsPerPlayer → maxRounds при старте (2 / 4 / 6 игроков)", () => {
  const names = ["A", "B", "C", "D", "E", "F"];
  assert.equal(E.roundsForTurnsPerPlayer(150, 2, 4), 75);
  assert.equal(E.roundsForTurnsPerPlayer(150, 3, 4), 113); // ⌈112.5⌉
  assert.equal(E.roundsForTurnsPerPlayer(0, 4, 4), null);
  assert.equal(E.roundsForTurnsPerPlayer(-5, 4, 4), null);
  assert.equal(E.roundsForTurnsPerPlayer(NaN, 4, 4), null);
  const rooms = [];
  const expected = { 150: [75, 150, 225], 70: [35, 70, 105], 40: [20, 40, 60] };
  for (const turns of [null, 150, 70, 40]) {
    [2, 4, 6].forEach((n, i) => {
      const r = lobby(names.slice(0, n));
      if (turns != null) assert.ok(!E.updateRoomSettings(r, r.hostPlayerId, { maxTurnsPerPlayer: turns }).error);
      assert.equal(r.maxRounds, null, "в лобби раундов ещё нет");
      assert.ok(!E.startGame(r, r.hostPlayerId).error);
      // null — настройка по умолчанию: те же 150 ходов у каждого.
      assert.equal(r.maxRounds, expected[turns == null ? 150 : turns][i], `${turns} ходов, ${n} игроков`);
      assert.equal(E.buildStatePayload(r, r.players[0].id).maxRounds, r.maxRounds);
      rooms.push(r);
    });
  }
  // Событие раз в 3 хода: 150 ходов × 4 игрока / 3 = 200 раундов.
  const r3 = lobby(names.slice(0, 4));
  assert.ok(!E.updateRoomSettings(r3, r3.hostPlayerId, { eventIntervalTurns: 3 }).error);
  assert.ok(!E.startGame(r3, r3.hostPlayerId).error);
  assert.equal(r3.maxRounds, 200);
  // 0 — без лимита.
  const r0 = lobby(names.slice(0, 4));
  assert.ok(!E.updateRoomSettings(r0, r0.hostPlayerId, { maxTurnsPerPlayer: 0 }).error);
  assert.ok(!E.startGame(r0, r0.hostPlayerId).error);
  assert.equal(r0.maxRounds, null);
  // Не в сети к старту — в партию не попадает и в раундах не считается: трое → ⌈150 × 3 / 4⌉.
  const off = lobby(names.slice(0, 4));
  off.players[3].connected = false;
  assert.ok(!E.startGame(off, off.hostPlayerId).error);
  assert.equal(off.players.length, 3);
  assert.equal(off.maxRounds, 113);
  return rooms.concat([r3, r0, off]);
});

test("длительность: лимит в ходах — у каждого ровно столько своих ходов, потом побеждает самый богатый", () => {
  const r = lobby(["A", "B"]);
  assert.ok(!E.updateRoomSettings(r, r.hostPlayerId, { maxTurnsPerPlayer: 2 }).error);
  assert.ok(!E.startGame(r, r.hostPlayerId).error);
  assert.equal(r.maxRounds, 1); // 2 хода × 2 игрока / 4 хода в раунде
  const made = {};
  for (let i = 0; i < 4 && r.phase === "roll"; i++) {
    const name = playTurn(r);
    made[name] = (made[name] || 0) + 1;
  }
  assert.equal(r.phase, "ended", "партия не закончилась по лимиту");
  assert.ok(made.A === 2 && made.B === 2, JSON.stringify(made));
  // Числа в ленте — с согласованным словом: «2 хода», «1 раунд» (а не «2 ходов, 1 раундов»).
  assert.ok(r.log.some((e) => /Лимит партии \(2 хода у каждого, 1 раунд\)/.test(e.text)), "в ленте нет лимита в ходах");
  // Раунды из длительности в ходах бывают любыми: 70 ходов × 3 игрока / 4 = 53 раунда.
  const r3 = lobby(["A", "B", "C"]);
  assert.ok(!E.updateRoomSettings(r3, r3.hostPlayerId, { maxTurnsPerPlayer: 70 }).error);
  assert.ok(!E.startGame(r3, r3.hostPlayerId).error);
  assert.equal(r3.maxRounds, 53);
  r3.roundNumber = 54;
  E.checkEndGame(r3);
  assert.equal(r3.phase, "ended");
  assert.ok(r3.log.some((e) => /Лимит партии \(70 ходов у каждого, 53 раунда\)/.test(e.text)), "в ленте «53 раундов»");
  return [r, r3];
});

test("длительность: старый клиент (setMaxRounds) и комнаты из rooms.json живут по maxRounds", () => {
  const names = ["A", "B", "C", "D"];
  // Старый клиент задаёт лимит в раундах — он и действует при любом числе игроков.
  const a = lobby(names);
  assert.ok(!E.setMaxRounds(a, a.hostPlayerId, 30).error);
  assert.ok(!("maxTurnsPerPlayer" in a.settings), "длительность в ходах осталась");
  assert.equal(E.buildStatePayload(a, a.players[0].id).settings.maxTurnsPerPlayer, null);
  assert.ok(!E.startGame(a, a.hostPlayerId).error);
  assert.equal(a.maxRounds, 30);
  const b = lobby(names);
  assert.ok(!E.setMaxRounds(b, b.hostPlayerId, 0).error);
  assert.ok(!E.startGame(b, b.hostPlayerId).error);
  assert.equal(b.maxRounds, null);
  // Комната из rooms.json (до этой версии): в настройках нет ключа, лимит — 50 раундов.
  const old = lobby(names);
  delete old.settings.maxTurnsPerPlayer;
  old.maxRounds = 50;
  const restored = JSON.parse(JSON.stringify(old));
  assert.ok(!E.startGame(restored, restored.hostPlayerId).error);
  assert.equal(restored.maxRounds, 50);
  // Новый клиент в такой комнате выбирает длительность в ходах — прежний лимит снимается.
  const c = lobby(names);
  delete c.settings.maxTurnsPerPlayer;
  c.maxRounds = 30;
  assert.ok(!E.updateRoomSettings(c, c.hostPlayerId, { maxTurnsPerPlayer: 70 }).error);
  assert.equal(c.maxRounds, null);
  assert.ok(c.log.some((e) => /70 ходов у каждого/.test(e.text)), "в ленте нет новой длительности");
  assert.ok(!E.startGame(c, c.hostPlayerId).error);
  assert.equal(c.maxRounds, 70);
  // Пределы: 0…1000, нечисловое и null — без изменений; не хост и не в лобби — отказ.
  const d = lobby(names);
  assert.ok(!E.updateRoomSettings(d, d.hostPlayerId, { maxTurnsPerPlayer: 5000 }).error);
  assert.equal(d.settings.maxTurnsPerPlayer, 1000);
  assert.ok(!E.updateRoomSettings(d, d.hostPlayerId, { maxTurnsPerPlayer: -3 }).error);
  assert.equal(d.settings.maxTurnsPerPlayer, 0);
  assert.ok(!E.updateRoomSettings(d, d.hostPlayerId, { maxTurnsPerPlayer: "abc", startingCash: 50000 }).error);
  assert.equal(d.settings.maxTurnsPerPlayer, 0);
  assert.ok(!E.updateRoomSettings(d, d.hostPlayerId, { maxTurnsPerPlayer: null }).error);
  assert.equal(d.settings.maxTurnsPerPlayer, 0);
  assert.ok(E.updateRoomSettings(d, P(d, "B").id, { maxTurnsPerPlayer: 40 }).error, "не хост изменил длительность");
  assert.equal(d.settings.maxTurnsPerPlayer, 0);
  assert.ok(!E.startGame(d, d.hostPlayerId).error);
  assert.ok(E.updateRoomSettings(d, d.hostPlayerId, { maxTurnsPerPlayer: 40 }).error, "длительность изменена посреди партии");
  return [a, b, restored, c, d];
});

test("длительность: реванш пересчитывает раунды по числу игроков, обучение не затронуто", () => {
  const r = game(["A", "B", "C", "D"]);
  assert.equal(r.maxRounds, 150);
  r.settings.eventIntervalTurns = 4; // game() отодвигает события — реванш перенял бы и это
  P(r, "D").kicked = true; // исключённый в реванш не переходит — остаются трое
  const fresh = E.newGameKeepPlayers(r);
  assert.equal(fresh.phase, "roll");
  assert.equal(fresh.players.length, 3);
  assert.equal(fresh.settings.maxTurnsPerPlayer, 150);
  assert.equal(fresh.maxRounds, 113);
  // Реванш старой комнаты (лимит в раундах) сохраняет её лимит.
  const old = game(["A", "B"]);
  delete old.settings.maxTurnsPerPlayer;
  old.maxRounds = 30;
  assert.equal(E.newGameKeepPlayers(old).maxRounds, 30);
  // Реванш, где в сети остался один, — лобби: раунды посчитает startGame.
  const solo = game(["A", "B"]);
  P(solo, "B").connected = false;
  const lob = E.newGameKeepPlayers(solo);
  assert.equal(lob.phase, "lobby");
  assert.equal(lob.maxRounds, null);
  // Учебная партия (tutorial.js): без лимита, applyGameLength её не трогает.
  const T = require(path.join(__dirname, "..", "public", "tutorial.js"));
  const { room } = T.buildRoom(E, "Инвестор");
  assert.equal(room.maxRounds, null);
  assert.equal(E.applyGameLength(room), null);
  assert.equal(room.maxRounds, null);
  return [fresh, lob, room];
});

// ---------------------------------------------------------------------
// Прогон
// ---------------------------------------------------------------------
let failed = 0;
for (const t of tests) {
  try {
    let rooms = t.fn();
    // Общие инварианты для комнат, которые вернул сценарий: наличные конечны,
    // состояние для каждого игрока строится без исключений.
    rooms = rooms ? [].concat(rooms) : [];
    for (const r of rooms) {
      for (const p of r.players) {
        assert.ok(Number.isFinite(p.cash), `нечисловые наличные у ${p.name}: ${p.cash}`);
        E.buildStatePayload(r, p.id);
      }
    }
    console.log("PASS " + t.name);
  } catch (e) {
    failed++;
    console.log("FAIL " + t.name + "\n     " + String(e && e.stack || e).split("\n").slice(0, 4).join("\n     "));
  } finally {
    Math.random = realRandom;
  }
}
console.log(failed ? `\n${failed} of ${tests.length} FAILED` : `\nALL ${tests.length} PASSED`);
process.exit(failed ? 1 : 0);
