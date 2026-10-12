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
// срок решения контролёра о цене выкупа и минимальную длину партии для очков.
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
