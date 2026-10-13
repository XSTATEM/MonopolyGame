"use strict";
// ---------------------------------------------------------------------
// Агрегация записей партий (runner.js) в сводку: средние, p10/p50/p90,
// доли побед с 95% доверительным интервалом (Уилсон), кривые денежной массы.
// Записи сортируются по номеру партии до агрегации, поэтому результат не
// зависит от того, в каком порядке их вернули потоки.
// ---------------------------------------------------------------------
const { HARD_FAIL } = require("./runner");

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function r3(x) { return x == null || !Number.isFinite(x) ? x : Math.round(x * 1000) / 1000; }
function describe(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { n: 0 };
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  return { n: v.length, mean: r3(mean), p10: r3(quantile(v, 0.1)), p50: r3(quantile(v, 0.5)), p90: r3(quantile(v, 0.9)), min: r3(v[0]), max: r3(v[v.length - 1]) };
}
// 95% интервал Уилсона для доли k/n.
function wilson(k, n, z) {
  z = z || 1.96;
  if (!n) return [0, 0];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [r3(Math.max(0, c - h)), r3(Math.min(1, c + h))];
}
function rate(k, n) { return { k, n, rate: n ? r3(k / n) : 0, ci95: wilson(k, n) }; }
function inc(obj, key, by) { obj[key] = (obj[key] || 0) + (by == null ? 1 : by); }
function perGame(obj, n) { return Object.fromEntries(Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, r3(v / Math.max(1, n))])); }

function aggregate(records, opts) {
  opts = opts || {};
  records = records.slice().sort((a, b) => a.game - b.game);
  const valid = records.filter((r) => !HARD_FAIL.has(r.endReason));
  const nValid = valid.length;
  const players = records.length ? records[0].seats.length : 0;

  const endReasons = {};
  records.forEach((r) => inc(endReasons, r.endReason));

  // --- профили и места ---
  const byProfile = {};
  const prof = (name) => (byProfile[name] = byProfile[name] || {
    appearances: 0, wins: 0, nw: [], cash: [], rank: [], bankrupt: 0, lowCash: [], loans: 0, controlled: [], cities: [], actions: {}, errors: {},
  });
  const seatWins = Array.from({ length: players }, () => 0);
  valid.forEach((r) => {
    r.players.forEach((p) => {
      const b = prof(p.profile);
      b.appearances++;
      b.nw.push(p.nw);
      if (Number.isFinite(p.cash)) b.cash.push(p.cash);
      b.rank.push(p.rank);
      if (p.bankrupt) b.bankrupt++;
      b.lowCash.push(p.lowCash);
      b.loans += p.loansTaken;
      b.controlled.push(p.controlled);
      b.cities.push(p.cities);
      Object.entries(r.actionsBySeat[p.seat] || {}).forEach(([k, v]) => inc(b.actions, k, v));
      Object.entries(r.errorsBySeat[p.seat] || {}).forEach(([k, v]) => inc(b.errors, k, v));
    });
    if (r.winnerSeat != null) {
      prof(r.seats[r.winnerSeat]).wins++;
      seatWins[r.winnerSeat]++;
    }
  });
  const profiles = {};
  Object.keys(byProfile).sort().forEach((name) => {
    const b = byProfile[name];
    profiles[name] = {
      appearances: b.appearances,
      win: rate(b.wins, b.appearances),
      finalNetWorth: describe(b.nw),
      finalCash: describe(b.cash),
      avgRank: r3(b.rank.reduce((s, x) => s + x, 0) / Math.max(1, b.rank.length)),
      bankruptRate: rate(b.bankrupt, b.appearances),
      lowCashShare: describe(b.lowCash),
      loansPerGame: r3(b.loans / Math.max(1, b.appearances)),
      controlledAtEnd: describe(b.controlled),
      citiesAtEnd: describe(b.cities),
      actionsPerGame: perGame(b.actions, b.appearances),
      errorsPerGame: perGame(b.errors, b.appearances),
    };
  });
  const seats = seatWins.map((w, i) => Object.assign({ seat: i + 1 }, rate(w, nValid)));

  // --- банкротства ---
  const causes = {};
  const firstBk = [];
  let gamesWithBk = 0, totalBk = 0;
  valid.forEach((r) => {
    totalBk += r.bankruptcies;
    if (r.bankruptcies) { gamesWithBk++; firstBk.push(r.firstBankruptEvent); }
    r.players.forEach((p) => { if (p.cause) inc(causes, p.cause); });
  });

  // --- действия, пассивные события, деньги ---
  const actions = {}, errors = {}, counters = {}, specialCards = {}, flows = {};
  valid.forEach((r) => {
    r.actionsBySeat.forEach((a) => Object.entries(a).forEach(([k, v]) => inc(actions, k, v)));
    r.errorsBySeat.forEach((a) => Object.entries(a).forEach(([k, v]) => inc(errors, k, v)));
    Object.entries(r.counters).forEach(([k, v]) => inc(counters, k, v));
    Object.entries(r.specialCards).forEach(([k, v]) => inc(specialCards, k, v));
    Object.entries(r.flows).forEach(([k, v]) => inc(flows, k, v));
  });

  // --- рынок ---
  const tierVals = {}, sectorVals = {};
  valid.forEach((r) => {
    Object.entries(r.market.tier).forEach(([k, v]) => (tierVals[k] = tierVals[k] || []).push(v));
    Object.entries(r.market.sector).forEach(([k, v]) => (sectorVals[k] = sectorVals[k] || []).push(v));
  });
  const mapDescribe = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, describe(o[k])]));

  // --- денежная масса по событиям (средние по партиям, дожившим до события) ---
  const maxLen = valid.reduce((m, r) => Math.max(m, r.series.length), 0);
  const curve = [];
  for (let k = 0; k < maxLen; k++) {
    const rows = valid.filter((r) => r.series.length > k).map((r) => r.series[k]);
    if (!rows.length) break;
    const m = (i) => Math.round(rows.reduce((s, x) => s + x[i], 0) / rows.length);
    const cash = m(0), stocks = m(1), re = m(2), loans = m(3);
    curve.push({ event: k, games: rows.length, cash, stocks, re, loans, total: cash + stocks + re - loans,
      active: r3(rows.reduce((s, x) => s + x[4], 0) / rows.length), floorShare: r3(rows.reduce((s, x) => s + x[5], 0) / rows.length) });
  }

  // --- снежный ком ---
  const half = valid.filter((r) => r.halfLeaderWon != null);
  const halfWon = half.filter((r) => r.halfLeaderWon).length;

  // --- аномалии ---
  const softKinds = {};
  const softExamples = [];
  records.forEach((r) => Object.entries(r.soft || {}).forEach(([k, v]) => {
    inc(softKinds, k, v.count);
    if (softExamples.filter((e) => e.kind === k).length < (opts.maxExamples || 3)) softExamples.push(Object.assign({ kind: k, game: r.game, seed: r.seed, count: v.count }, v.first));
  }));
  const hard = records.filter((r) => r.hard).map((r) => r.hard);

  return {
    games: records.length,
    validGames: nValid,
    players,
    endReasons: Object.fromEntries(Object.entries(endReasons).map(([k, v]) => [k, { count: v, share: r3(v / Math.max(1, records.length)) }])),
    events: describe(valid.map((r) => r.events)),
    turns: describe(valid.map((r) => r.turns)),
    steps: describe(valid.map((r) => r.steps)),
    msPerGame: describe(records.map((r) => r.ms)),
    fairShare: players ? r3(1 / players) : 0,
    profiles,
    seats,
    winnerSpread: describe(valid.map((r) => r.spread)),
    winnerRatio: describe(valid.map((r) => r.ratio)),
    gini: describe(valid.map((r) => r.gini)),
    bankruptcies: {
      perGame: describe(valid.map((r) => r.bankruptcies)),
      gamesWithAny: rate(gamesWithBk, nValid),
      totalPlayers: totalBk,
      firstEvent: describe(firstBk),
      causes: Object.fromEntries(Object.entries(causes).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, { count: v, share: r3(v / Math.max(1, totalBk)) }])),
    },
    lowCashShare: describe(valid.flatMap((r) => r.players.map((p) => p.lowCash))),
    leadChanges: describe(valid.map((r) => r.leadChanges)),
    snowball: rate(halfWon, half.length),
    actionsPerGame: perGame(actions, nValid),
    errorsPerGame: perGame(errors, nValid),
    passivePerGame: perGame(counters, nValid),
    specialCardsPerGame: perGame(specialCards, nValid),
    cashFlowsPerGame: Object.fromEntries(Object.entries(flows).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round(v / Math.max(1, nValid))])),
    writeOffPerGame: Math.round(valid.reduce((s, r) => s + r.writeOff, 0) / Math.max(1, nValid)),
    market: {
      priceRatioByTier: mapDescribe(tierVals),
      priceRatioBySector: mapDescribe(sectorVals),
      floorShareEnd: describe(valid.map((r) => r.market.floorEnd)),
      floorShareAvg: describe(valid.map((r) => r.market.floorAvg)),
      controlledCompaniesEnd: describe(valid.map((r) => r.market.controlledEnd)),
      fullyOwnedEnd: describe(valid.map((r) => r.market.fullyOwnedEnd)),
      mergedCompanies: describe(valid.map((r) => r.market.merged)),
      citiesOwnedEnd: describe(valid.map((r) => r.market.citiesOwned)),
    },
    moneyCurve: curve,
    anomalies: {
      hardCount: hard.length,
      hard: hard.slice(0, opts.maxDumps || 20),
      softKinds,
      softExamples,
    },
  };
}

module.exports = { aggregate, describe, wilson, quantile, rate };
