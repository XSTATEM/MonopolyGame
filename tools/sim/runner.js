"use strict";
// ---------------------------------------------------------------------
// Прогон одной партии ботов на реальном движке и сбор метрик (tools/sim).
//
// Драйвер шага (driverStep) выполняет ровно одно действие движка за вызов:
//  1) решение по подсмотренной инсайдом карте;
//  2) оплата назначенной цены выкупа (обязательна);
//  3) ответы профилей на адресованные им сделки;
//  4) бросок на компанию с единоличным контролёром: сначала намерение бросившего
//     (купить или отказаться), при отказе — цена от контролёра;
//  5) ход текущего игрока: профиль (крючки profiles.js) или engine.botStep.
// Если все игроки — профиль "engine", каждый шаг — просто engine.botStep (эталон).
// Обязательства движковых ботов всегда решает сам botStep; где решение зависит
// от игрока-профиля, драйвер спрашивает профиль, а за движкового бота повторяет
// формулу botStep (цена выкупа fair×(1.5..2.5), намерение — botChoosePct движка).
// ---------------------------------------------------------------------
const { makeRng } = require("./engine-loader");
const { PROFILES } = require("./profiles");
const { makeCtx, act, actionSig } = require("./helpers");

// Действия, которые профилю разрешено вызывать у движка.
const ACTION_TYPES = new Set([
  "rollDice", "buyFromRoll", "dividendFromRoll", "skipRoll", "endTurn", "sellBank", "proposeTrade", "respondTrade",
  "setForcedPrice", "payForcedPrice", "ctrlNegativeInfo", "ctrlPrCampaign", "ctrlInsiderPeek", "ctrlInsiderResolve",
  "ctrlSqueezeOut", "ctrlShort", "ctrlPublicIPO", "ctrlMergeCompanies", "takeLoan", "repayLoan",
  "buyRealEstateFromRoll", "upgradeRealEstateFromRoll", "payRealEstateRentFromRoll",
  "ctrlEspionage", "ctrlDiscredit", "ctrlInvestigate", "personalPr", "declareBankruptcy",
]);
const MAX_PHASE_ACTIONS = 8; // действий профиля за одну фазу хода (до броска / бросок / после)

// Пассивные события, видимые только по ленте движка: [ключ, тег, фрагмент текста].
// Тексты — строки addLog из engine.js; если формулировку поменяют, счётчик станет 0
// (в отчёте это будет заметно), на ход партии это не влияет.
const LOG_COUNTERS = [
  ["forcedSell", "forced-sell", null],
  ["loanMissed", "loan", "не смог внести"],
  ["loanDefault", "loan", "взыскивает"],
  ["loanAutoRepaid", "loan", "автоплатежами"],
  ["shortWon", "short", "банк выплатил"],
  ["shortLost", "short", "не сыграл"],
  ["antitrust", "control", "Антимонопольная"],
  ["overpricedForced", "control", "сильно завышена"],
  ["fullOwnership", "control", "консолидировал"],
  ["bankBuyback", "buyback", null],
  ["taxPaid", "tax", null],
  ["dividendSkipped", "dividend", "пропущены"],
  ["dividendBlocked", "dividend", "не проводится"],
  ["passiveRent", "realestate", "пассивную ренту"],
  ["reSetBonus", "realestate", "за комплект"],
  ["reTax", "realestate", "налог на недвижимость"],
  ["reTaxMissed", "realestate", "не может заплатить налог"],
  ["cleanHandsBonus", "reputation", "грязных методов"],
  ["extraTurn", "turn", "дополнительный ход"],
  ["deckReshuffle", "deck", null],
  ["cardGlobal", "news", "[Глобальная]"],
  ["cardSector", "news", "[Отраслевая"],
  ["cardCompany", "news", "[Точечная]"],
  ["cardSpecial", "news", "[Особая]"],
];

const COUNTERS_BY_TAG = new Map();
for (const [key, tag, frag] of LOG_COUNTERS) {
  if (!COUNTERS_BY_TAG.has(tag)) COUNTERS_BY_TAG.set(tag, []);
  COUNTERS_BY_TAG.get(tag).push([key, frag]);
}

const HARD_FAIL = new Set(["stall", "crash", "step-cap"]);

function seatProfiles(cfg, gameIndex) {
  const base = cfg.seatProfiles;
  const n = base.length;
  if (cfg.seatMode === "fixed") return base.slice();
  if (cfg.seatMode === "shuffle") {
    const r = makeRng(`${cfg.seed}#seats#${gameIndex}`);
    const a = base.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  // rotate: за n подряд идущих партий каждый профиль посидит на каждом месте
  return base.map((_, s) => base[(s + gameIndex) % n]);
}

function round2(x) { return Math.round(x * 100) / 100; }
function inc(obj, key, by) { obj[key] = (obj[key] || 0) + (by == null ? 1 : by); }

function runGame(env, cfg, gameIndex) {
  const { E, I } = env;
  const t0 = Date.now();
  const seed = `${cfg.seed}#${gameIndex}`;
  const rng = makeRng(seed);
  env.setRng(rng);
  const seats = seatProfiles(cfg, gameIndex);

  const room = E.freshRoom("SIM" + gameIndex);
  // Перехват ленты событий: счётчик записей (признак прогресса), записи текущего шага, трассировка.
  const tap = { count: 0, step: [], ring: [] };
  const logArr = room.log;
  logArr.push = function (e) {
    tap.count++;
    tap.step.push(e);
    tap.ring.push(e);
    if (tap.ring.length > 60) tap.ring.shift();
    if (cfg.trace) process.stdout.write(`[#${gameIndex} ${e.turnTag}] ${e.text}\n`);
    return Array.prototype.push.call(this, e);
  };

  // Настройки — через движок (те же пределы, что у хоста), неизвестные движку ключи — напрямую.
  const settingsNotes = [];
  if (cfg.settings && Object.keys(cfg.settings).length) {
    const res = E.updateRoomSettings(room, room.hostPlayerId, cfg.settings);
    if (res && res.error) throw new Error("updateRoomSettings: " + res.error);
    for (const k of Object.keys(cfg.settings)) {
      if (room.settings[k] === undefined) { room.settings[k] = cfg.settings[k]; settingsNotes.push(`${k}: записан напрямую (движок не знает ключа)`); }
      else if (JSON.stringify(room.settings[k]) !== JSON.stringify(cfg.settings[k])) settingsNotes.push(`${k}: движок привёл ${JSON.stringify(cfg.settings[k])} → ${JSON.stringify(room.settings[k])}`);
    }
  }
  const players = seats.map((prof, i) => {
    const res = E.addPlayer(room, `P${i + 1}-${prof}`.slice(0, 20), "", "", 0, "default", true);
    if (!res || !res.player) throw new Error("addPlayer: " + (res && res.error));
    return res.player;
  });
  room.maxRounds = cfg.maxRounds > 0 ? cfg.maxRounds : null;
  room.phase = "roll";
  const startCash = (room.settings && room.settings.startingCash) || players[0].cash;

  const seatOf = new Map(players.map((p, i) => [p.id, i]));
  const S = {
    E, I, room, rng, cfg, startCash,
    profOf: new Map(players.map((p, i) => [p.id, PROFILES[seats[i]]])),
    mem: new Map(),
    phase: { key: "", actions: 0, tried: new Set() },
    insiderCard: null,
    allEngine: seats.every((n) => PROFILES[n].pure),
  };

  // --- метрики партии ---
  const actionsBySeat = seats.map(() => ({}));
  const errorsBySeat = seats.map(() => ({}));
  const counters = {};
  const specialCards = {};
  const flows = {};
  let writeOff = 0;
  const lowCash = seats.map(() => ({ n: 0, low: 0 }));
  const bankrupt = seats.map(() => null); // {event, cause}
  const loansTaken = seats.map(() => 0);
  const series = []; // по событиям: [cash, stocks, re, loans, active, floorShare]
  const leaders = []; // лидер по капиталу после каждого события (seat)
  const softAnoms = {};
  const recentActions = [];
  let steps = 0, turns = 0, idle = 0, sinceTurn = 0, lastSig = "";
  let endReason = null, hardAnom = null;
  const lowCashThreshold = 0.05 * startCash;

  function snapshotSeries() {
    let cash = 0, stocks = 0, re = 0, loans = 0, active = 0, best = -Infinity, leader = null;
    for (const p of room.players) {
      if (p.bankrupt) continue;
      active++;
      cash += p.cash;
      for (const t in p.holdings) stocks += ((p.holdings[t] || 0) / 100) * room.companies[t].price;
      if (p.loan) loans += p.loan.principal;
      const nw = E.netWorth(room, p);
      if (nw > best) { best = nw; leader = seatOf.get(p.id); }
    }
    for (const ct of E.CITIES) {
      const r = room.realEstate[ct.id];
      const owner = r.ownerId != null ? room.players.find((p) => p.id === r.ownerId) : null;
      if (owner && !owner.bankrupt) re += E.realEstatePrice(room, ct.id);
    }
    let live = 0, floor = 0;
    for (const c of E.COMPANIES) {
      const cc = room.companies[c.ticker];
      if (cc.merged) continue;
      live++;
      if (cc.price <= E.TIER_PRICE[c.tier] * 0.1 * 1.0001) floor++;
    }
    series.push([Math.round(cash), Math.round(stocks), Math.round(re), Math.round(loans), active, live ? round2(floor / live) : 0]);
    return leader;
  }
  snapshotSeries();

  function soft(kind, detail) {
    if (!softAnoms[kind]) softAnoms[kind] = { count: 0, first: Object.assign({ step: steps, event: room.eventCount }, detail) };
    softAnoms[kind].count++;
  }
  // Инварианты: наличные конечны и у активных не отрицательны — после каждого шага;
  // доли не отрицательны и в сумме ≤ 100%, цены конечны — на каждом биржевом
  // событии и в конце партии (full): такое состояние не «рассасывается» само, а
  // поиск по словарям долей движка заметно дороже остального шага.
  const tickers = E.COMPANIES.map((c) => c.ticker);
  function checkInvariants(full) {
    const ps = room.players;
    for (const p of ps) {
      if (!Number.isFinite(p.cash)) soft("non-finite-cash", { player: p.name, cash: String(p.cash) });
      else if (!p.bankrupt && p.cash < -0.5) soft("negative-cash-active", { player: p.name, cash: Math.round(p.cash), lastLog: tap.step.slice(-6).map((e) => e.text) });
    }
    if (!full) return;
    for (const t of tickers) {
      let tot = 0;
      for (const p of ps) {
        const v = p.holdings[t];
        if (v === undefined) continue;
        if (v < 0) soft("negative-holding", { player: p.name, ticker: t, pct: v });
        tot += v || 0;
      }
      if (tot > 100.0001) soft("over-100pct", { ticker: t, total: tot });
      const pr = room.companies[t].price;
      if (!(pr >= 0) || pr === Infinity) soft("bad-price", { ticker: t, price: String(pr) });
    }
  }
  function stateDump(reason, extra) {
    return Object.assign({
      reason, game: gameIndex, seed, step: steps, seats,
      phase: room.phase, eventCount: room.eventCount, roundNumber: room.roundNumber, turn: room.turn,
      turnIndex: room.turnIndex, currentPlayerId: E.currentPlayerId(room), rolledThisTurn: room.rolledThisTurn,
      pendingRoll: room.pendingRoll, pendingForcedPrice: room.pendingForcedPrice, pendingTrades: room.pendingTrades,
      pendingInsider: room.pendingInsider, frozen: room.frozen,
      players: room.players.map((p) => ({ id: p.id, name: p.name, cash: Math.round(p.cash), bankrupt: p.bankrupt, holdings: p.holdings, loan: p.loan, reputation: p.reputation })),
      recentActions: recentActions.slice(),
      lastLog: tap.ring.slice(-40).map((e) => `[${e.tag}] ${e.text}`),
      replay: `node tools/sim/sim.js ${cfg.replayArgs} --games 1 --game-offset ${gameIndex} --trace`,
    }, extra || {});
  }

  // --- главный цикл ---
  while (room.phase === "roll") {
    if (steps >= cfg.maxSteps) { endReason = "step-cap"; hardAnom = stateDump("step-cap"); break; }
    if (cfg.hardCapEvents && room.eventCount >= cfg.hardCapEvents) { endReason = "hard-cap"; break; }
    const activeBefore = room.players.filter((p) => !p.bankrupt);
    const cashBefore = activeBefore.map((p) => p.cash);
    const evBefore = room.eventCount;
    tap.step = [];
    let st;
    try {
      st = driverStep(S);
    } catch (e) {
      endReason = "crash";
      hardAnom = stateDump("crash", { error: String(e && e.stack || e) });
      break;
    }
    steps++;
    const evAdvanced = room.eventCount !== evBefore;
    const res = st.result || {};
    const seat = st.actor != null && seatOf.has(st.actor) ? seatOf.get(st.actor) : null;
    let label = st.type;
    if (st.acted && !res.error) {
      // Уточнения для отчёта: отказ с оплатой/без, принятая/отклонённая сделка, успех мер.
      if (label === "dividendFromRoll") label += st.paid ? ":paid" : ":free";
      else if (label === "respondTrade") label += st.accepted ? ":accept" : ":reject";
      else if ((label === "ctrlEspionage" || label === "ctrlDiscredit" || label === "ctrlInvestigate") && "success" in res) label += res.success ? ":ok" : ":fail";
      if (seat != null) inc(actionsBySeat[seat], label);
      if (st.type === "takeLoan" && seat != null) loansTaken[seat]++;
      if (st.type === "endTurn") {
        turns++;
        for (const p of room.players) {
          if (p.bankrupt) continue;
          const s = seatOf.get(p.id);
          lowCash[s].n++;
          if (p.cash < lowCashThreshold) lowCash[s].low++;
        }
      }
    } else if (st.acted && res.error && seat != null) {
      inc(errorsBySeat[seat], st.type);
    }
    if (st.acted) {
      recentActions.push({ step: steps, type: label, actor: seat != null ? players[seat].name : null, error: res.error || undefined, via: st.via });
      if (recentActions.length > 25) recentActions.shift();
    }
    // Денежные потоки: изменение наличных у тех, кто был в игре до шага.
    let flow = 0;
    for (let i = 0; i < activeBefore.length; i++) flow += activeBefore[i].cash - cashBefore[i];
    if (flow) inc(flows, evAdvanced ? "marketEvent" : st.type, flow);
    // Банкротства этого шага.
    for (const p of activeBefore) {
      if (!p.bankrupt) continue;
      const s = seatOf.get(p.id);
      writeOff += Math.max(0, -p.cash);
      bankrupt[s] = { event: room.eventCount, cause: bankruptCause(st, evAdvanced, p, tap.step) };
    }
    // Пассивные события по ленте.
    for (const e of tap.step) {
      const list = COUNTERS_BY_TAG.get(e.tag);
      if (list) for (const [key, frag] of list) if (!frag || e.text.indexOf(frag) >= 0) inc(counters, key);
      if (e.tag === "news") {
        const m = /\[Особая\] ([^:]+):/.exec(e.text);
        if (m) inc(specialCards, m[1]);
      }
    }
    if (evAdvanced) leaders.push(snapshotSeries());
    if (cfg.invariants) checkInvariants(evAdvanced || room.phase !== "roll");
    // Прогресс: любое успешное действие пишет в ленту; ошибки и «нечего делать» — нет.
    const sig = `${tap.count}|${room.turnIndex}|${room.turn}|${room.eventCount}|${room.rolledThisTurn}|${!!room.pendingRoll}|${!!room.pendingForcedPrice}|${room.pendingTrades.length}|${!!room.pendingInsider}`;
    if (sig === lastSig) idle++; else { idle = 0; lastSig = sig; }
    if (st.type === "endTurn" && !res.error) sinceTurn = 0; else sinceTurn++;
    if (idle >= cfg.stallSteps) { endReason = "stall"; hardAnom = stateDump("stall", { note: `${idle} шагов без изменений состояния` }); break; }
    if (sinceTurn >= cfg.turnStallSteps) { endReason = "stall"; hardAnom = stateDump("stall", { note: `${sinceTurn} шагов без завершения хода` }); break; }
  }

  // --- итоги партии ---
  const active = room.players.filter((p) => !p.bankrupt);
  if (!endReason) {
    if (room.phase !== "ended") endReason = "crash";
    else if (room.players.length > 1 && active.length === 1) endReason = "last-survivor";
    else if (active.length === 0) endReason = "all-bankrupt";
    else endReason = "round-limit";
  }
  let winnerSeat = null;
  let winnerByCap = false;
  if (room.gameResult && room.gameResult.winnerId != null) winnerSeat = seatOf.get(room.gameResult.winnerId);
  else if (endReason === "hard-cap" && active.length) {
    const w = active.reduce((b, p) => (E.netWorth(room, p) > E.netWorth(room, b) ? p : b), active[0]);
    winnerSeat = seatOf.get(w.id);
    winnerByCap = true;
  }
  if (HARD_FAIL.has(endReason)) winnerSeat = null;

  const finalNw = players.map((p) => E.netWorth(room, p));
  const sorted = finalNw.slice().sort((a, b) => b - a);
  const leadChanges = leaders.reduce((n, l, i) => n + (i > 0 && l !== leaders[i - 1] ? 1 : 0), 0);
  const halfLeader = leaders.length >= 2 ? leaders[Math.ceil(leaders.length / 2) - 1] : null;

  // Рынок: отношение цены к стартовой цене тира — по тирам и секторам; доля «у пола».
  const tierAcc = {}, sectorAcc = {};
  let liveCount = 0, floorEnd = 0, merged = 0, controlledEnd = 0, fullyOwnedEnd = 0;
  for (const c of E.COMPANIES) {
    const cc = room.companies[c.ticker];
    if (cc.merged) { merged++; continue; }
    liveCount++;
    const ratio = cc.price / E.TIER_PRICE[c.tier];
    (tierAcc[c.tier] = tierAcc[c.tier] || []).push(ratio);
    (sectorAcc[c.sector] = sectorAcc[c.sector] || []).push(ratio);
    if (cc.price <= E.TIER_PRICE[c.tier] * 0.1 * 1.0001) floorEnd++;
    if (E.ownerOfControl(room, c.ticker)) controlledEnd++;
    if (cc.fullyOwned) fullyOwnedEnd++;
  }
  const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const mapAvg = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, round2(avg(v))]));

  const rec = {
    game: gameIndex, seed, seats, endReason, winnerSeat, winnerByCap,
    winnerProfile: winnerSeat != null ? seats[winnerSeat] : null,
    events: room.eventCount, turns, steps, ms: Date.now() - t0,
    players: players.map((p, i) => ({
      seat: i, profile: seats[i], nw: Math.round(finalNw[i]), cash: Math.round(p.cash), bankrupt: !!p.bankrupt,
      bankruptEvent: bankrupt[i] ? bankrupt[i].event : null, cause: bankrupt[i] ? bankrupt[i].cause : null,
      lowCash: lowCash[i].n ? round2(lowCash[i].low / lowCash[i].n) : 0,
      reputation: p.reputation, loansTaken: loansTaken[i],
      controlled: E.controlledTickers(room, p.id).filter((t) => !room.companies[t].merged).length,
      cities: E.CITIES.filter((ct) => room.realEstate[ct.id].ownerId === p.id).length,
      rank: sorted.indexOf(finalNw[i]) + 1,
    })),
    spread: sorted.length > 1 ? Math.round(sorted[0] - sorted[1]) : 0,
    ratio: sorted.length > 1 && sorted[1] > 0 ? round2(sorted[0] / sorted[1]) : null,
    gini: round2(giniOf(finalNw)),
    bankruptcies: bankrupt.filter(Boolean).length,
    firstBankruptEvent: bankrupt.filter(Boolean).reduce((m, b) => (m == null || b.event < m ? b.event : m), null),
    leadChanges,
    halfLeaderWon: halfLeader == null || winnerSeat == null ? null : halfLeader === winnerSeat,
    actionsBySeat, errorsBySeat, counters, specialCards,
    flows: Object.fromEntries(Object.entries(flows).map(([k, v]) => [k, Math.round(v)])),
    writeOff: Math.round(writeOff),
    market: {
      tier: mapAvg(tierAcc), sector: mapAvg(sectorAcc),
      floorEnd: liveCount ? round2(floorEnd / liveCount) : 0,
      floorAvg: round2(avg(series.map((s) => s[5]))),
      merged, controlledEnd, fullyOwnedEnd,
      citiesOwned: E.CITIES.filter((ct) => room.realEstate[ct.id].ownerId != null).length,
    },
    series,
    soft: softAnoms,
    hard: hardAnom,
    settingsNotes,
  };
  return rec;
}

function giniOf(xs) {
  const v = xs.map((x) => Math.max(0, x)).sort((a, b) => a - b);
  const n = v.length;
  const s = v.reduce((a, b) => a + b, 0);
  if (n < 2 || s <= 0) return 0;
  let cum = 0;
  for (let i = 0; i < n; i++) cum += (i + 1) * v[i];
  return (2 * cum) / (n * s) - (n + 1) / n;
}

// Причина банкротства — по действию шага и записям ленты перед записью о банкротстве.
function bankruptCause(st, evAdvanced, player, entries) {
  if (st.type === "declareBankruptcy") return "voluntary";
  if (evAdvanced) {
    let idx = entries.findIndex((e) => e.tag === "bankrupt" && e.text.indexOf(player.name) >= 0);
    if (idx < 0) idx = entries.length;
    for (let i = idx - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.text.indexOf(player.name) < 0 || e.tag === "forced-sell") continue;
      if (e.tag === "tax") return "tax";
      if (e.tag === "loan") return "loanDefault";
    }
    if (entries.some((e) => e.tag === "news" && e.text.indexOf("Аудит") >= 0)) return "audit";
    return "marketEvent";
  }
  if (st.type === "dividendFromRoll") return "refusePayment";
  if (st.type === "payForcedPrice") return "forcedPrice";
  if (st.type === "payRealEstateRentFromRoll") return "rent";
  return "other:" + st.type;
}

// ---------------------------------------------------------------------
// Драйвер шага
// ---------------------------------------------------------------------
function player(S, id) { return S.room.players.find((p) => p.id === id); }
function isEngine(S, p) { const prof = S.profOf.get(p.id); return !prof || !!prof.pure; }
function othersHolding(S, ticker, exclId) {
  return S.room.players.filter((p) => !p.bankrupt && p.id !== exclId && (p.holdings[ticker] || 0) > 0);
}
function singleController(S, ticker, rollerId) {
  const o = othersHolding(S, ticker, rollerId);
  return o.length === 1 && o[0].holdings[ticker] > 50 ? o[0] : null;
}

function exec(S, actorId, a, via) {
  if (!a || !ACTION_TYPES.has(a.type) || typeof S.E[a.type] !== "function") {
    return { acted: true, type: a ? a.type : "?", actor: actorId, result: { error: `недопустимое действие ${a ? a.type : a}` }, via };
  }
  const room = S.room;
  // Для отчёта: заплатил ли отказавшийся (или выплату пропустили / платить некому).
  let paidBefore = null;
  if (a.type === "dividendFromRoll") { const p = player(S, actorId); paidBefore = p ? p.cash : null; }
  const result = S.E[a.type](room, actorId, ...(a.args || [])) || {};
  const out = { acted: true, type: a.type, actor: actorId, result, via };
  if (paidBefore != null) { const p = player(S, actorId); out.paid = !!p && p.cash < paidBefore - 1e-9; }
  if (a.type === "ctrlInsiderPeek" && result.ok) S.insiderCard = result.card || null;
  if (result.error) S.phase.tried.add(actionSig(a));
  return out;
}

// Шаг engine.botStep с определением, кто именно действовал.
function engineStep(S) {
  const { E, room } = S;
  const pf = room.pendingForcedPrice;
  const roll = room.pendingRoll;
  const curId = E.currentPlayerId(room);
  const ctrl = roll && roll.ticker && !pf ? singleController(S, roll.ticker, roll.playerId) : null;
  const t0 = room.pendingTrades[0];
  const tradeSnap = t0 ? { toId: t0.toId, fromId: t0.fromId, ticker: t0.ticker, held: (player(S, t0.fromId) || { holdings: {} }).holdings[t0.ticker] || 0 } : null;
  const roller = roll ? player(S, roll.playerId) : null;
  const cashBefore = roller ? roller.cash : null;
  const r = E.botStep(room);
  if (!r || !r.acted) return { acted: false, type: "idle", actor: curId, result: {}, via: "engine" };
  let actor = curId;
  const out = { acted: true, type: r.type, result: r.result || {}, via: "engine" };
  if (r.type === "payForcedPrice" && pf) actor = pf.targetId;
  else if (r.type === "setForcedPrice" && ctrl) actor = ctrl.id;
  else if (r.type === "respondTrade" && tradeSnap) {
    actor = tradeSnap.toId;
    const from = player(S, tradeSnap.fromId);
    out.accepted = !!from && (from.holdings[tradeSnap.ticker] || 0) < tradeSnap.held;
  } else if (r.type === "dividendFromRoll" && roller) {
    actor = roller.id;
    out.paid = roller.cash < cashBefore - 1e-9;
  }
  out.actor = actor;
  return out;
}

// Хочет ли движковый бот купить по броску (та же проверка, что в botStep, шаг 2).
function engineWantsBuy(S, roller, ticker) {
  const { E, I, room } = S;
  const free = 100 - E.totalOwnedPct(room, ticker);
  if (free < 1) return false;
  const price = room.companies[ticker].price;
  if (typeof I.botChoosePct === "function") return I.botChoosePct(roller.cash, price, free) >= 1;
  const spendable = Math.max(0, (roller.cash - 15000) * 0.35);
  return Math.min(25, free, Math.floor(spendable / (price / 100))) >= 1;
}
function engineBuyPct(S, roller, ticker) {
  const { E, I, room } = S;
  const free = 100 - E.totalOwnedPct(room, ticker);
  const price = room.companies[ticker].price;
  if (typeof I.botChoosePct === "function") return I.botChoosePct(roller.cash, price, free);
  const spendable = Math.max(0, (roller.cash - 15000) * 0.35);
  const pct = Math.min(25, free, Math.floor(spendable / (price / 100)));
  return pct < 1 ? 0 : Math.max(1, Math.min(pct, 5 + Math.floor(S.rng() * 15)));
}
// Цена выкупа от движкового контролёра — формула botStep: справедливая × (1.5..2.5).
function engineForcedPrice(S, controller, ticker) {
  const ctx = makeCtx(S, controller);
  return Math.round(ctx.fairForcedPrice(ticker, controller) * (1.5 + S.rng()));
}
function engineAcceptTrade(S, to, trade) {
  const { room } = S;
  const got = room.companies[trade.ticker].price * (trade.pct / 100);
  const paid = trade.price + (trade.wantTicker ? room.companies[trade.wantTicker].price * (trade.wantPct / 100) : 0);
  const canPay = (trade.price === 0 || to.cash >= trade.price) && (!trade.wantTicker || (to.holdings[trade.wantTicker] || 0) >= trade.wantPct);
  return canPay && got >= paid * 0.9;
}

function callHook(S, p, name, ...args) {
  const prof = S.profOf.get(p.id);
  if (!prof || typeof prof[name] !== "function") return null;
  const v = prof[name](makeCtx(S, p), ...args);
  return v == null ? null : v;
}

function driverStep(S) {
  const { E, room } = S;
  if (S.allEngine) return engineStep(S);

  // Фаза хода — для лимита действий профиля и памяти отклонённых действий.
  const curId = E.currentPlayerId(room);
  const phaseKey = `${room.eventCount}:${room.turn}:${curId}:${room.rolledThisTurn}:${room.pendingRoll ? 1 : 0}`;
  if (S.phase.key !== phaseKey) { S.phase.key = phaseKey; S.phase.actions = 0; S.phase.tried = new Set(); }

  // 1) Подсмотренная карта инсайда — решает тот, кто подсматривал.
  if (room.pendingInsider) {
    const owner = player(S, room.pendingInsider.playerId);
    let decision = owner ? callHook(S, owner, "insider", S.insiderCard) : null;
    if (decision !== "moveToBack") decision = "keep";
    S.insiderCard = null;
    return exec(S, room.pendingInsider.playerId, act("ctrlInsiderResolve", decision), "driver");
  }
  // 2) Назначенная цена выкупа — платится всегда.
  if (room.pendingForcedPrice) return exec(S, room.pendingForcedPrice.targetId, act("payForcedPrice"), "driver");

  // 3) Сделки, адресованные профилям (раньше всего остального — иначе botStep ответил бы
  // на них по-своему). Адресованные движковым ботам решит сам botStep.
  for (const t of room.pendingTrades) {
    const to = player(S, t.toId);
    if (!to || isEngine(S, to)) continue;
    let accept = callHook(S, to, "respondTrade", t);
    if (typeof accept !== "boolean") accept = engineAcceptTrade(S, to, t);
    const from = player(S, t.fromId);
    const held = from ? from.holdings[t.ticker] || 0 : 0;
    const r = exec(S, to.id, act("respondTrade", t.id, accept), "profile");
    r.accepted = !!from && (from.holdings[t.ticker] || 0) < held;
    return r;
  }
  // 4) Бросок на компанию с единоличным контролёром.
  const roll = room.pendingRoll;
  if (roll && roll.ticker) {
    const R = player(S, roll.playerId);
    const C = singleController(S, roll.ticker, roll.playerId);
    if (R && C && !(isEngine(S, R) && isEngine(S, C))) {
      let buyAction = null;
      if (isEngine(S, R)) {
        if (engineWantsBuy(S, R, roll.ticker)) return engineStep(S); // botStep купит сам (шаг 2 его пропустит)
      } else {
        let d = phaseLimitReached(S) ? null : callHook(S, R, "stock", roll);
        if (d && S.phase.tried.has(actionSig(d))) d = null;
        if (d && d.type !== "buyFromRoll" && d.type !== "dividendFromRoll" && d.type !== "skipRoll") {
          S.phase.actions++;
          return exec(S, R.id, d, "profile"); // промежуточное действие (продажа, кредит…)
        }
        if (d == null) {
          const pct = engineWantsBuy(S, R, roll.ticker) ? engineBuyPct(S, R, roll.ticker) : 0;
          d = pct >= 1 ? act("buyFromRoll", pct) : act("dividendFromRoll");
        }
        if (d.type === "buyFromRoll") buyAction = d;
      }
      if (buyAction) {
        const r = exec(S, R.id, buyAction, "profile");
        if (!r.result.error) return r;
      }
      // Отказ: цену назначает контролёр.
      let amount = isEngine(S, C) ? null : callHook(S, C, "forcedPrice", { ticker: roll.ticker, targetId: R.id });
      if (!Number.isFinite(amount) || amount < 1) amount = engineForcedPrice(S, C, roll.ticker);
      return exec(S, C.id, act("setForcedPrice", Math.round(amount)), isEngine(S, C) ? "driver" : "profile");
    }
  }

  if (room.pendingTrades.length) return engineStep(S);

  // 5) Ход текущего игрока.
  const cur = curId != null ? player(S, curId) : null;
  if (!cur) return { acted: false, type: "idle", actor: null, result: {} };
  if (isEngine(S, cur)) return engineStep(S);
  return profileTurn(S, cur);
}

function phaseLimitReached(S) { return S.phase.actions >= MAX_PHASE_ACTIONS; }

function profileTurn(S, cur) {
  const { E, room } = S;
  const roll = room.pendingRoll;
  if (roll && roll.playerId === cur.id) {
    if (roll.realEstateId) {
      const re = room.realEstate[roll.realEstateId];
      if (re.ownerId && re.ownerId !== cur.id) return exec(S, cur.id, act("payRealEstateRentFromRoll"), "driver");
      const d = phaseLimitReached(S) ? act("skipRoll") : callHook(S, cur, "realEstate", roll);
      if (d == null || S.phase.tried.has(actionSig(d))) return engineStep(S);
      S.phase.actions++;
      const r = exec(S, cur.id, d, "profile");
      if (r.result.error && (d.type === "buyRealEstateFromRoll" || d.type === "upgradeRealEstateFromRoll")) return exec(S, cur.id, act("skipRoll"), "driver");
      return r;
    }
    // Компания без единоличного контролёра (иначе — шаг 3 драйвера).
    const d = phaseLimitReached(S) ? null : callHook(S, cur, "stock", roll);
    if (d == null || S.phase.tried.has(actionSig(d))) return engineStep(S);
    S.phase.actions++;
    const r = exec(S, cur.id, d, "profile");
    if (r.result.error && d.type === "buyFromRoll") return exec(S, cur.id, act("dividendFromRoll"), "driver");
    return r;
  }
  if (!room.rolledThisTurn) {
    if (phaseLimitReached(S)) return exec(S, cur.id, act("rollDice"), "driver");
    const d = callHook(S, cur, "preRoll");
    if (d == null) return engineStep(S);
    if (d.type !== "rollDice" && S.phase.tried.has(actionSig(d))) return exec(S, cur.id, act("rollDice"), "driver");
    S.phase.actions++;
    return exec(S, cur.id, d, "profile");
  }
  // После броска.
  if (phaseLimitReached(S)) return exec(S, cur.id, act("endTurn"), "driver");
  const d = callHook(S, cur, "postRoll");
  if (d == null || (d.type !== "endTurn" && S.phase.tried.has(actionSig(d)))) return exec(S, cur.id, act("endTurn"), "driver");
  S.phase.actions++;
  return exec(S, cur.id, d, "profile");
}

module.exports = { runGame, seatProfiles, giniOf, HARD_FAIL, LOG_COUNTERS };
