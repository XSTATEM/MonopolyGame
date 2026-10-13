#!/usr/bin/env node
"use strict";
// ---------------------------------------------------------------------
// Симулятор баланса «Биржи» — тысячи партий ботов на настоящем движке
// (server/public/engine.js), с подменой констант, настройками комнаты,
// профилями стратегий, детерминированным seed и параллельным счётом.
//
//   node tools/sim/sim.js --games 2000 --players 4 --profiles engine,engine,greedy,saver \
//     --max-rounds 30 --set turnSalary=450 --override TURN_SALARY=600 --seed 42 --out results.json
//
// Подробности и примеры — tools/sim/README.md; справка — --help.
// ---------------------------------------------------------------------
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Worker } = require("worker_threads");
const { prepareEngineSource, instantiateEngine, parseLiteral, listConstants, DEFAULT_ENGINE_PATH } = require("./engine-loader");
const { runGame } = require("./runner");
const { aggregate } = require("./stats");
const { PROFILES } = require("./profiles");

const HELP = `Симулятор баланса «Биржи» (tools/sim)

  node tools/sim/sim.js [опции]

Партия
  --games N            число партий (по умолчанию 200)
  --players N          игроков за столом, 2–8 (по умолчанию = числу профилей, при одном профиле — 4)
  --profiles a,b,c     профили по местам (по умолчанию engine); короче --players — повторяются по кругу
  --seat-mode M        rotate (по умолчанию: профили ротируются по местам) | fixed | shuffle
  --max-rounds N       лимит раундов (биржевых событий), 0 = до последнего выжившего (по умолчанию 30)
  --hard-cap N         предохранитель для --max-rounds 0: стоп после N событий (по умолчанию 300)
  --seed S             seed (число или строка, по умолчанию 1); партия №i всегда считается с сидом "S#i"
  --game-offset N      номер первой партии (для повтора конкретной партии из большого прогона)

Правила
  --override NAME=v    подменить константу движка «const NAME = …;» (повторяемо); v — JSON или JS-литерал
  --set key=v          настройка комнаты (startingCash, turnSalary, eventIntervalTurns, tierForcedPaymentPct)
  --settings JSON      то же пачкой: '{"turnSalary":450}' или @файл.json
  --sweep NAME=v1|v2   прогнать один и тот же набор партий для каждого значения и сравнить;
                       NAME заглавными — константа (--override), иначе — настройка комнаты или maxRounds
  --engine PATH        другой файл движка (по умолчанию server/public/engine.js), например копия
                       до правки — для сравнения до/после на тех же --seed и --profiles

Вывод и проверки
  --out FILE           записать сводку (и аномалии) в JSON
  --per-game           добавить в JSON записи всех партий
  --workers N          потоков (по умолчанию авто: до числа ядер; 1 = в текущем процессе)
  --stall-steps N      шагов без изменения состояния до признания зависания (по умолчанию 300)
  --turn-stall N       шагов без завершения хода до признания зависания (по умолчанию 3000)
  --max-steps N        лимит шагов на партию (по умолчанию 200000)
  --no-invariants      не проверять инварианты (кэш конечен, доли ≤100% и т.п.) на каждом шаге
  --no-probe           не проверять, что --override/--set вообще меняют ход партий
  --fail-on-anomaly    код выхода 2, если были зависания/ошибки/нарушения инвариантов
  --trace              печатать ленту событий партий (только в текущем процессе)
  --quiet              без прогресса и отчёта в консоли (только --out)
  --json               напечатать сводку JSON в stdout вместо текстового отчёта
  --list-profiles      список профилей стратегий
  --list-constants     верхнеуровневые константы движка (кандидаты для --override)
`;

// ---------------------------------------------------------------------
// Разбор аргументов
// ---------------------------------------------------------------------
const FLAGS = new Set(["per-game", "no-invariants", "no-probe", "fail-on-anomaly", "trace", "quiet", "json", "list-profiles", "list-constants", "help", "h"]);
const REPEATABLE = new Set(["override", "set"]);

function parseArgv(argv) {
  const out = { _raw: [] };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (!a.startsWith("-")) throw new Error(`Неожиданный аргумент «${a}» (см. --help)`);
    a = a.replace(/^--?/, "");
    let val;
    const eq = a.indexOf("="); // --key=value (у --override=NAME=v значение — всё после первого «=»)
    if (eq > 0) { val = a.slice(eq + 1); a = a.slice(0, eq); }
    if (FLAGS.has(a)) { out[a] = true; out._raw.push("--" + a); continue; }
    if (val === undefined) {
      if (i + 1 >= argv.length) throw new Error(`--${a}: нужно значение`);
      val = argv[++i];
    }
    if (REPEATABLE.has(a)) (out[a] = out[a] || []).push(val);
    else out[a] = val;
    out._raw.push(`--${a}`, val);
  }
  return out;
}

function intArg(v, name, min, max, def) {
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${name}: ожидается целое ${min}…${max}, получено «${v}»`);
  return n;
}

function splitKV(s, what) {
  const eq = String(s).indexOf("=");
  if (eq <= 0) throw new Error(`${what}: ожидается NAME=значение, получено «${s}»`);
  return [s.slice(0, eq).trim(), s.slice(eq + 1)];
}

function buildConfig(args) {
  const profiles = String(args.profiles || "engine").split(",").map((s) => s.trim()).filter(Boolean);
  for (const p of profiles) if (!PROFILES[p]) throw new Error(`Неизвестный профиль «${p}». Доступны: ${Object.keys(PROFILES).join(", ")}`);
  const players = intArg(args.players, "players", 2, 8, profiles.length > 1 ? profiles.length : 4);
  if (profiles.length > players) throw new Error(`--profiles: ${profiles.length} профилей, а игроков ${players}`);
  const seatProfiles = Array.from({ length: players }, (_, i) => profiles[i % profiles.length]);
  const seatMode = args["seat-mode"] || "rotate";
  if (!["rotate", "fixed", "shuffle"].includes(seatMode)) throw new Error("--seat-mode: rotate | fixed | shuffle");

  let settings = {};
  if (args.settings) {
    const raw = String(args.settings).startsWith("@") ? fs.readFileSync(String(args.settings).slice(1), "utf8") : args.settings;
    settings = parseLiteral(raw, "--settings");
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("--settings: ожидается объект");
  }
  for (const s of args.set || []) {
    const [k, v] = splitKV(s, "--set");
    settings[k] = parseLiteral(v, `--set ${k}`);
  }
  const overrides = (args.override || []).map((s) => {
    const [name, v] = splitKV(s, "--override");
    return { name, value: parseLiteral(v, `--override ${name}`) };
  });

  // Аргументы для команды повтора партии из дампа аномалии.
  const skip = new Set(["--games", "--game-offset", "--out", "--workers", "--sweep", "--per-game", "--quiet", "--json", "--trace", "--fail-on-anomaly"]);
  const replay = [];
  for (let i = 0; i < args._raw.length; i++) {
    const a = args._raw[i];
    if (FLAGS.has(a.replace(/^--?/, ""))) { if (!skip.has(a)) replay.push(a); continue; }
    const v = args._raw[++i];
    if (!skip.has(a)) replay.push(a, /[\s"'{}|&;<>]/.test(v) ? `'${v}'` : v);
  }

  return {
    games: intArg(args.games, "games", 1, 10000000, 200),
    gameOffset: intArg(args["game-offset"], "game-offset", 0, 1e12, 0),
    seatProfiles,
    seatMode,
    maxRounds: intArg(args["max-rounds"], "max-rounds", 0, 100000, 30),
    hardCapEvents: intArg(args["hard-cap"], "hard-cap", 1, 1000000, 300),
    seed: String(args.seed != null ? args.seed : "1"),
    settings,
    overrides,
    enginePath: args.engine ? path.resolve(args.engine) : DEFAULT_ENGINE_PATH,
    stallSteps: intArg(args["stall-steps"], "stall-steps", 10, 1e7, 300),
    turnStallSteps: intArg(args["turn-stall"], "turn-stall", 50, 1e8, 3000),
    maxSteps: intArg(args["max-steps"], "max-steps", 100, 1e9, 200000),
    invariants: !args["no-invariants"],
    trace: !!args.trace,
    workers: args.workers === undefined ? "auto" : intArg(args.workers, "workers", 1, 256, 1),
    replayArgs: replay.join(" "),
  };
}

// cfg без лишнего для runGame (уходит в потоки через structured clone).
function runnerCfg(cfg) {
  const { seatProfiles, seatMode, maxRounds, hardCapEvents, seed, settings, stallSteps, turnStallSteps, maxSteps, invariants, trace, replayArgs } = cfg;
  return { seatProfiles, seatMode, maxRounds, hardCapEvents: maxRounds > 0 ? 0 : hardCapEvents, seed, settings, stallSteps, turnStallSteps, maxSteps, invariants, trace, replayArgs };
}

// ---------------------------------------------------------------------
// Прогон пачки партий: в текущем процессе или пулом worker_threads
// ---------------------------------------------------------------------
function decideWorkers(cfg, games) {
  if (cfg.trace) return 1;
  const cpus = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  if (cfg.workers !== "auto") return Math.max(1, Math.min(cfg.workers, games));
  if (games < 48) return 1;
  return Math.max(1, Math.min(cpus, Math.ceil(games / 24)));
}

function makeProgress(total, quiet, label) {
  const tty = process.stderr.isTTY && !quiet;
  const t0 = Date.now();
  let last = 0;
  return {
    tick(done) {
      if (!tty) return;
      const now = Date.now();
      if (now - last < 200 && done < total) return;
      last = now;
      const rate = done / Math.max(0.001, (now - t0) / 1000);
      process.stderr.write(`\r  ${label}${done}/${total} партий · ${rate.toFixed(0)}/с   `);
    },
    end() { if (tty) process.stderr.write("\r" + " ".repeat(70) + "\r"); },
  };
}

function runBatch(cfg, prepared, opts) {
  opts = opts || {};
  const games = opts.games != null ? opts.games : cfg.games;
  const offset = opts.offset != null ? opts.offset : cfg.gameOffset;
  const rc = runnerCfg(cfg);
  const W = opts.workers != null ? opts.workers : decideWorkers(cfg, games);
  const progress = makeProgress(games, opts.quiet, opts.label || "");
  if (W <= 1) {
    const env = instantiateEngine(prepared);
    const records = [];
    for (let i = 0; i < games; i++) {
      records.push(runGame(env, rc, offset + i));
      progress.tick(i + 1);
    }
    progress.end();
    return Promise.resolve({ records, workers: 1 });
  }
  return new Promise((resolve, reject) => {
    const batch = Math.max(1, Math.min(64, Math.ceil(games / (W * 6))));
    const records = [];
    let next = 0, exited = 0, failed = false;
    const workers = [];
    const fail = (err) => {
      if (failed) return;
      failed = true;
      workers.forEach((w) => w.terminate());
      progress.end();
      reject(err);
    };
    const feed = (w) => {
      if (next < games) {
        const chunk = [];
        for (let k = 0; k < batch && next < games; k++, next++) chunk.push(offset + next);
        w.postMessage({ type: "run", games: chunk });
      } else {
        w.postMessage({ type: "exit" });
      }
    };
    for (let k = 0; k < W; k++) {
      const w = new Worker(path.join(__dirname, "worker.js"), { workerData: { prepared: { file: prepared.file, src: prepared.src }, cfg: rc } });
      workers.push(w);
      w.on("message", (m) => {
        if (m.type === "fatal") return fail(new Error("Ошибка в потоке симулятора:\n" + m.error));
        if (m.records) { for (const r of m.records) records.push(r); progress.tick(records.length); }
        feed(w);
      });
      w.on("error", fail);
      w.on("exit", (code) => {
        exited++;
        if (failed) return;
        if (code !== 0) return fail(new Error(`Поток завершился с кодом ${code}`));
        if (exited === W) {
          progress.end();
          if (records.length !== games) return fail(new Error(`Посчитано ${records.length} партий из ${games}`));
          resolve({ records, workers: W });
        }
      });
    }
  });
}

// Проверка, что каждая подмена вообще влияет на игру — «без одного»: те же
// контрольные партии со всеми подменами и без этой одной. Совпали итоги всех
// партий — подмена в этой комбинации мёртвая: константу не читает движок, её
// перекрывает room.settings (или --set), или значение совпадает с текущим.
async function probeChanges(cfg) {
  const K = 16;
  const fp = async (c) => {
    const cc = Object.assign({}, c, { trace: false });
    const { records } = await runBatch(cc, prepareEngineSource(cc), { games: K, offset: 0, workers: 1, quiet: true });
    return JSON.stringify(records.map((r) => [r.events, r.players.map((p) => [p.cash, p.nw])]));
  };
  const full = await fp(cfg);
  const warnings = [];
  for (let i = 0; i < cfg.overrides.length; i++) {
    const o = cfg.overrides[i];
    if (full === await fp(Object.assign({}, cfg, { overrides: cfg.overrides.filter((_, j) => j !== i) }))) {
      warnings.push(`--override ${o.name}=${JSON.stringify(o.value)} не изменил ни одной из ${K} контрольных партий — движок не читает эту константу, её перекрывает room.settings/--set, или значение совпадает с текущим.`);
    }
  }
  for (const k of Object.keys(cfg.settings)) {
    const rest = Object.assign({}, cfg.settings);
    delete rest[k];
    if (full === await fp(Object.assign({}, cfg, { settings: rest }))) {
      warnings.push(`--set ${k}=${JSON.stringify(cfg.settings[k])} не изменил ни одной из ${K} контрольных партий — значение совпадает с текущим умолчанием или ключ не используется движком.`);
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------
// Текстовый отчёт
// ---------------------------------------------------------------------
const END_RU = { "round-limit": "лимит раундов", "last-survivor": "последний выживший", "all-bankrupt": "все банкроты", "hard-cap": "предохранитель по раундам", stall: "ЗАВИСАНИЕ", crash: "ОШИБКА", "step-cap": "лимит шагов" };
const ACTION_RU = {
  rollDice: "бросок кубиков", endTurn: "завершение хода", buyFromRoll: "покупка акций по броску",
  "dividendFromRoll:paid": "отказ от покупки — с оплатой", "dividendFromRoll:free": "отказ — без оплаты (пропуск/некому)",
  skipRoll: "пропуск действия", setForcedPrice: "назначение цены выкупа", payForcedPrice: "оплата назначенной цены",
  buyRealEstateFromRoll: "покупка недвижимости", upgradeRealEstateFromRoll: "улучшение недвижимости", payRealEstateRentFromRoll: "оплата ренты",
  sellBank: "продажа акций банку", proposeTrade: "предложение сделки", "respondTrade:accept": "сделка принята", "respondTrade:reject": "сделка отклонена",
  takeLoan: "кредит взят", repayLoan: "погашение кредита", ctrlPrCampaign: "PR-кампания", ctrlNegativeInfo: "негативная информация",
  ctrlInsiderPeek: "инсайд", ctrlInsiderResolve: "решение по инсайду", ctrlSqueezeOut: "сквиз-аут", ctrlShort: "шорт",
  ctrlPublicIPO: "народное IPO", ctrlMergeCompanies: "слияние компаний", "ctrlEspionage:ok": "шпионаж — успех", "ctrlEspionage:fail": "шпионаж — пойман",
  "ctrlDiscredit:ok": "дискредитация — успех", "ctrlDiscredit:fail": "дискредитация — провал", "ctrlInvestigate:ok": "расследование — раскрыто",
  "ctrlInvestigate:fail": "расследование — впустую", personalPr: "личный PR", declareBankruptcy: "объявление банкротства",
};
const PASSIVE_RU = {
  forcedSell: "принудительные продажи активов", loanMissed: "просрочки по кредиту", loanDefault: "взыскания кредита банком",
  loanAutoRepaid: "кредиты закрыты автоплатежами", shortWon: "шорт сыграл", shortLost: "шорт сгорел", antitrust: "конфискации антимонопольщиков",
  overpricedForced: "завышенные цены выкупа", fullOwnership: "полные поглощения (100%)", bankBuyback: "выкуп банком 10%",
  taxPaid: "уплаты налога (карта)", dividendSkipped: "пропуски выплаты (тир)", dividendBlocked: "выплата заблокирована картой",
  scenarioNews: "сценарные новости", passiveRent: "начисления пассивной ренты", reSetBonus: "бонусы за комплект городов", reTax: "уплаты налога на недвижимость",
  reTaxMissed: "неуплаты налога на недвижимость", cleanHandsBonus: "бонусы «чистых рук»", extraTurn: "дополнительные ходы",
  deckReshuffle: "перетасовки колоды", cardGlobal: "карты: глобальные", cardSector: "карты: отраслевые", cardCompany: "карты: точечные", cardSpecial: "карты: особые",
};
const CAUSE_RU = { refusePayment: "плата за отказ от покупки", forcedPrice: "назначенная цена выкупа", rent: "рента", tax: "налоговая проверка", loanDefault: "взыскание кредита", audit: "аудит", marketEvent: "биржевое событие", voluntary: "добровольно" };
const FLOW_RU = {
  rollDice: "зарплата за бросок", marketEvent: "биржевые события (рента, бонусы, налоги, кредиты, шорты, выкуп)",
  buyFromRoll: "покупка акций", buyRealEstateFromRoll: "покупка недвижимости", upgradeRealEstateFromRoll: "улучшения недвижимости",
  takeLoan: "выдача кредитов", repayLoan: "погашение кредитов", sellBank: "продажа акций банку", ctrlSqueezeOut: "сквиз-аут",
  payForcedPrice: "назначенная цена (± недобор и продажи активов банку)", payRealEstateRentFromRoll: "рента (± продажи активов банку для оплаты)",
  dividendFromRoll: "плата за отказ (держателям; + — продажи активов банку для оплаты)", ctrlPrCampaign: "PR-кампании", ctrlNegativeInfo: "негативная информация",
  ctrlInsiderPeek: "инсайд", ctrlShort: "залоги шортов", ctrlEspionage: "шпионаж", ctrlDiscredit: "дискредитация", ctrlInvestigate: "расследования",
  personalPr: "личный PR", ctrlPublicIPO: "народное IPO", setForcedPrice: "назначение цены", respondTrade: "сделки (наличные)",
};

function money(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  const s = Math.round(Math.abs(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return (n < 0 ? "−$" : "$") + s;
}
function pct(x, digits) { return x == null || !Number.isFinite(x) ? "—" : (x * 100).toFixed(digits == null ? 1 : digits) + "%"; }
function num(x, d) { return x == null || !Number.isFinite(x) ? "—" : Number(x).toFixed(d == null ? 1 : d).replace(/\.0+$/, ""); }
function dist(d, f) { f = f || ((x) => num(x)); return d && d.n ? `ср ${f(d.mean)} · p10 ${f(d.p10)} · p50 ${f(d.p50)} · p90 ${f(d.p90)}` : "—"; }
function ci(r) { return `${pct(r.rate)} [${pct(r.ci95[0])}–${pct(r.ci95[1])}]`; }
function pad(s, n) { s = String(s); return s.length >= n ? s : s + " ".repeat(n - s.length); }
function lpad(s, n) { s = String(s); return s.length >= n ? s : " ".repeat(n - s.length) + s; }

function printReport(sum, meta, log) {
  log = log || console.log;
  const c = meta.config;
  log(`\n═══ Симуляция «Биржи» ═══`);
  log(`Партий: ${sum.games} × ${sum.players} игрока · профили по местам: ${c.seatProfiles.join(", ")} (места: ${c.seatMode})`);
  log(`Лимит: ${c.maxRounds ? c.maxRounds + " раундов" : "до последнего выжившего (предохранитель " + c.hardCapEvents + " событий)"} · seed ${c.seed}${c.gameOffset ? " · с партии " + c.gameOffset : ""}`);
  log(`Движок: ${path.relative(process.cwd(), meta.engine.file) || meta.engine.file} (sha1 ${meta.engine.sha1})`);
  if (meta.engine.overrides.length) log(`Подмены: ${meta.engine.overrides.map((o) => `${o.name}: ${o.from} → ${o.to}`).join("; ")}`);
  if (Object.keys(c.settings).length) log(`Настройки комнаты: ${JSON.stringify(c.settings)}`);
  if (meta.settingsNotes && meta.settingsNotes.length) log(`  ⚠ ${meta.settingsNotes.join("; ")}`);
  (meta.probeWarnings || []).forEach((w) => log(`  ⚠ ${w}`));
  log(`Время: ${(meta.durationMs / 1000).toFixed(1)} с · ${num(meta.gamesPerSec, 0)} партий/с · потоков: ${meta.workers}`);

  log(`\n— Как заканчиваются партии —`);
  log("  " + Object.entries(sum.endReasons).map(([k, v]) => `${END_RU[k] || k}: ${pct(v.share)} (${v.count})`).join(" · "));
  log(`  Раундов (событий): ${dist(sum.events)}`);
  log(`  Ходов: ${dist(sum.turns, (x) => num(x, 0))} · шагов движка: ${dist(sum.steps, (x) => num(x, 0))}`);

  log(`\n— Победы по профилям (справедливая доля ${pct(sum.fairShare)}) —`);
  log("  " + pad("профиль", 12) + lpad("мест", 7) + lpad("побед", 7) + "  " + pad("доля побед [95% ДИ]", 24) + pad("ср. место", 10) + pad("банкрот", 9) + pad("безденежье", 11) + "итоговый капитал p10 / p50 / p90");
  for (const [name, p] of Object.entries(sum.profiles)) {
    const nw = p.finalNetWorth;
    log("  " + pad(name, 12) + lpad(p.appearances, 7) + lpad(p.win.k, 7) + "  " + pad(ci(p.win), 24) + pad(num(p.avgRank, 2), 10) + pad(pct(p.bankruptRate.rate), 9) + pad(pct(p.lowCashShare.mean), 11)
      + `${money(nw.p10)} / ${money(nw.p50)} / ${money(nw.p90)}`);
  }
  log("  По местам (порядок хода): " + sum.seats.map((s) => `#${s.seat} ${ci(s)}`).join(" · "));

  log(`\n— Разрыв и неравенство —`);
  log(`  Отрыв победителя от 2-го: ${dist(sum.winnerSpread, money)}`);
  log(`  Победитель / 2-й: ${dist(sum.winnerRatio, (x) => num(x, 2) + "×")}`);
  log(`  Джини итогового капитала: ${dist(sum.gini, (x) => num(x, 2))}`);

  log(`\n— Банкротства —`);
  const bk = sum.bankruptcies;
  log(`  На партию: ${dist(bk.perGame, (x) => num(x, 2))} · партий хотя бы с одним: ${ci(bk.gamesWithAny)}`);
  log(`  Первое банкротство (номер события): ${dist(bk.firstEvent)}`);
  if (Object.keys(bk.causes).length) log("  Причины: " + Object.entries(bk.causes).map(([k, v]) => `${CAUSE_RU[k] || k} ${pct(v.share)} (${v.count})`).join(" · "));
  log(`  Доля ходов с наличными < 5% старта: ${dist(sum.lowCashShare, (x) => pct(x))}`);

  log(`\n— Лидерство —`);
  log(`  Смен лидера по капиталу за партию: ${dist(sum.leadChanges)}`);
  log(`  Лидер на середине партии выиграл: ${ci(sum.snowball)} (снежный ком; ${pct(sum.fairShare)} — если бы середина ничего не значила)`);

  log(`\n— Действия (в среднем за партию, все игроки) —`);
  const acts = Object.entries(sum.actionsPerGame);
  for (let i = 0; i < acts.length; i += 2) {
    const cell = ([k, v]) => pad(`${ACTION_RU[k] || k}: ${num(v, 2)}`, 46);
    log("  " + cell(acts[i]) + (acts[i + 1] ? cell(acts[i + 1]) : ""));
  }
  const errs = Object.entries(sum.errorsPerGame);
  if (errs.length) log("  Отклонено движком (на партию): " + errs.map(([k, v]) => `${k} ${num(v, 2)}`).join(" · "));

  log(`\n— Пассивные события (на партию) —`);
  const pas = Object.entries(sum.passivePerGame);
  for (let i = 0; i < pas.length; i += 2) {
    const cell = ([k, v]) => pad(`${PASSIVE_RU[k] || k}: ${num(v, 2)}`, 46);
    log("  " + cell(pas[i]) + (pas[i + 1] ? cell(pas[i + 1]) : ""));
  }
  if (Object.keys(sum.specialCardsPerGame).length) log("  Особые карты: " + Object.entries(sum.specialCardsPerGame).map(([k, v]) => `${k} ${num(v, 2)}`).join(" · "));

  log(`\n— Рынок (цена в конце / стартовая цена тира) —`);
  log("  По тирам: " + Object.entries(sum.market.priceRatioByTier).map(([k, d]) => `${k} ×${num(d.mean, 2)} (p10 ×${num(d.p10, 2)}, p90 ×${num(d.p90, 2)})`).join(" · "));
  log("  По секторам: " + Object.entries(sum.market.priceRatioBySector).map(([k, d]) => `${k} ×${num(d.mean, 2)}`).join(" · "));
  log(`  Компаний у ценового пола: в конце ${pct(sum.market.floorShareEnd.mean)}, в среднем по партии ${pct(sum.market.floorShareAvg.mean)}`);
  log(`  Под контролем (>50%) в конце: ${dist(sum.market.controlledCompaniesEnd)} · 100%: ${num(sum.market.fullyOwnedEnd.mean, 2)} · слито: ${num(sum.market.mergedCompanies.mean, 2)} · городов куплено: ${num(sum.market.citiesOwnedEnd.mean, 1)} из 16`);

  log(`\n— Денежная масса у активных игроков (средняя по партиям) —`);
  log("  " + pad("событие", 9) + lpad("партий", 8) + lpad("наличные", 12) + lpad("акции", 12) + lpad("недвиж.", 12) + lpad("кредиты", 11) + lpad("итого", 12) + lpad("игроков", 9) + lpad("у пола", 8));
  const curve = sum.moneyCurve;
  const marks = new Set([0]);
  const lastEv = curve.length - 1;
  const stepMarks = lastEv > 40 ? 10 : 5;
  for (let k = stepMarks; k < lastEv; k += stepMarks) marks.add(k);
  if (lastEv > 0) marks.add(lastEv);
  for (const k of [...marks].sort((a, b) => a - b)) {
    const r = curve[k];
    if (!r) continue;
    log("  " + pad(r.event, 9) + lpad(r.games, 8) + lpad(money(r.cash), 12) + lpad(money(r.stocks), 12) + lpad(money(r.re), 12) + lpad(money(r.loans), 11) + lpad(money(r.total), 12) + lpad(num(r.active, 2), 9) + lpad(pct(r.floorShare, 0), 8));
  }
  log(`\n— Потоки наличных за партию (+ в игру / − из игры) —`);
  log("  " + Object.entries(sum.cashFlowsPerGame).filter(([, v]) => Math.abs(v) >= 1).map(([k, v]) => `${FLOW_RU[k] || k}: ${v > 0 ? "+" : ""}${money(v)}`).join("\n  "));
  if (sum.writeOffPerGame) log(`  долги банкротов, оставшиеся у получателей: +${money(sum.writeOffPerGame)}`);

  log(`\n— Аномалии —`);
  const an = sum.anomalies;
  if (!an.hardCount && !Object.keys(an.softKinds).length) log("  нет: ни зависаний, ни ошибок, ни нарушений инвариантов");
  if (an.hardCount) {
    log(`  ✖ Зависаний/ошибок: ${an.hardCount}. Первые:`);
    an.hard.slice(0, 3).forEach((h) => {
      log(`    партия ${h.game} (${h.reason}${h.note ? ": " + h.note : ""}) · событие ${h.eventCount}, шаг ${h.step}${h.error ? "\n      " + h.error.split("\n").slice(0, 3).join("\n      ") : ""}`);
      log(`      повтор: ${h.replay}`);
    });
  }
  for (const [k, n] of Object.entries(an.softKinds)) {
    const ex = an.softExamples.find((e) => e.kind === k);
    log(`  ⚠ ${k}: ${n} раз(а)` + (ex ? ` — например, партия ${ex.game}, событие ${ex.event}: ${JSON.stringify(Object.fromEntries(Object.entries(ex).filter(([kk]) => !["kind", "game", "seed", "count", "event", "step"].includes(kk))))}` : ""));
  }
}

function printSweep(variants, sweep, log) {
  log = log || console.log;
  log(`\n═══ Сравнение по ${sweep.name} (${sweep.kind === "override" ? "константа движка" : sweep.kind === "maxRounds" ? "лимит раундов" : "настройка комнаты"}) ═══`);
  const profNames = Object.keys(variants[0].summary.profiles);
  const head = pad("значение", 22) + lpad("раундов", 9) + lpad("выжил1", 8) + lpad("банкр/п", 9) + lpad("1-й банкр", 10) + lpad("безден.", 9) + lpad("Джини", 7) + lpad("снеж.ком", 10) + lpad("смен лид", 9) + "  победы: " + profNames.join(" / ");
  log("  " + head);
  for (const v of variants) {
    const s = v.summary;
    const surv = s.endReasons["last-survivor"] ? s.endReasons["last-survivor"].share : 0;
    log("  " + pad(v.label, 22) + lpad(num(s.events.mean, 1), 9) + lpad(pct(surv, 0), 8) + lpad(num(s.bankruptcies.perGame.mean, 2), 9) + lpad(num(s.bankruptcies.firstEvent.mean, 1), 10)
      + lpad(pct(s.lowCashShare.mean, 0), 9) + lpad(num(s.gini.mean, 2), 7) + lpad(pct(s.snowball.rate, 0), 10) + lpad(num(s.leadChanges.mean, 1), 9)
      + "  " + profNames.map((n) => (s.profiles[n] ? pct(s.profiles[n].win.rate, 0) : "—")).join(" / ")
      + (s.anomalies.hardCount ? `  ✖ аномалий ${s.anomalies.hardCount}` : ""));
  }
}

// ---------------------------------------------------------------------
// main
// ---------------------------------------------------------------------
async function runOne(cfg, quiet, label) {
  const prepared = prepareEngineSource(cfg);
  const t0 = Date.now();
  const { records, workers } = await runBatch(cfg, prepared, { quiet, label });
  records.sort((a, b) => a.game - b.game); // потоки возвращают пачки в произвольном порядке
  const durationMs = Date.now() - t0;
  const summary = aggregate(records);
  const settingsNotes = [...new Set(records.flatMap((r) => r.settingsNotes || []))];
  return { prepared, records, workers, durationMs, summary, settingsNotes };
}

function metaFor(cfg, run, extra) {
  return Object.assign({
    tool: "tools/sim",
    createdAt: new Date().toISOString(),
    node: process.version,
    engine: { file: run.prepared.file, sha1: run.prepared.sha1, overrides: run.prepared.applied },
    config: {
      games: cfg.games, gameOffset: cfg.gameOffset, players: cfg.seatProfiles.length, seatProfiles: cfg.seatProfiles, seatMode: cfg.seatMode,
      maxRounds: cfg.maxRounds, hardCapEvents: cfg.hardCapEvents, seed: cfg.seed, settings: cfg.settings,
    },
    profiles: Object.fromEntries([...new Set(cfg.seatProfiles)].map((p) => [p, PROFILES[p].desc])),
    durationMs: run.durationMs,
    gamesPerSec: run.records.length / Math.max(0.001, run.durationMs / 1000),
    workers: run.workers,
    settingsNotes: run.settingsNotes,
  }, extra || {});
}

async function main() {
  const args = parseArgv(process.argv.slice(2));
  if (args.help || args.h) { process.stdout.write(HELP); return 0; }
  if (args["list-profiles"]) {
    for (const [k, v] of Object.entries(PROFILES)) console.log(`${pad(k, 12)} ${v.desc}`);
    return 0;
  }
  if (args["list-constants"]) {
    const src = fs.readFileSync(args.engine ? path.resolve(args.engine) : DEFAULT_ENGINE_PATH, "utf8");
    for (const c of listConstants(src)) console.log(`${pad(c.name, 30)} ${c.value.length > 100 ? c.value.slice(0, 97) + "…" : c.value}`);
    return 0;
  }
  const cfg = buildConfig(args);
  const quiet = !!args.quiet;
  const log = args.json ? () => {} : quiet ? () => {} : console.log;
  let anomalies = 0;
  let output;

  if (args.sweep) {
    const [name, valuesRaw] = splitKV(args.sweep, "--sweep");
    const values = valuesRaw.split("|").map((v) => v.trim()).filter((v) => v !== "");
    if (values.length < 1) throw new Error("--sweep: нужно хотя бы одно значение (v1|v2|…)");
    const kind = name === "maxRounds" ? "maxRounds" : /^[A-Z0-9_$]+$/.test(name) ? "override" : "setting";
    const variants = [];
    for (const raw of values) {
      const value = parseLiteral(raw, `--sweep ${name}`);
      const vc = Object.assign({}, cfg, { overrides: cfg.overrides.slice(), settings: Object.assign({}, cfg.settings) });
      if (kind === "override") vc.overrides = vc.overrides.filter((o) => o.name !== name).concat([{ name, value }]);
      else if (kind === "maxRounds") vc.maxRounds = Number(value) || 0;
      else vc.settings[name] = value;
      // Команда повтора партии из дампа должна воспроизводить именно этот вариант.
      const lit = JSON.stringify(value);
      const q = (s) => (/[\s"'{}|&;<>]/.test(s) ? `'${s}'` : s);
      vc.replayArgs = `${cfg.replayArgs} ${kind === "override" ? `--override ${q(`${name}=${lit}`)}` : kind === "maxRounds" ? `--max-rounds ${vc.maxRounds}` : `--set ${q(`${name}=${lit}`)}`}`.trim();
      const run = await runOne(vc, quiet || args.json, `${name}=${raw}: `);
      const meta = metaFor(vc, run);
      if (!quiet && !args.json) printReport(run.summary, meta, log);
      anomalies += run.summary.anomalies.hardCount + Object.keys(run.summary.anomalies.softKinds).length;
      variants.push({ label: `${raw}`, value, meta, summary: run.summary, games: args["per-game"] ? run.records : undefined });
    }
    if (!quiet && !args.json) printSweep(variants, { name, kind }, log);
    output = { sweep: { name, kind, values }, variants };
  } else {
    const probeWarnings = !args["no-probe"] && (cfg.overrides.length || Object.keys(cfg.settings).length) ? await probeChanges(cfg) : [];
    const run = await runOne(cfg, quiet || args.json);
    const meta = metaFor(cfg, run, { probeWarnings });
    if (!quiet && !args.json) printReport(run.summary, meta, log);
    anomalies += run.summary.anomalies.hardCount + Object.keys(run.summary.anomalies.softKinds).length;
    output = { meta, summary: run.summary, games: args["per-game"] ? run.records : undefined };
  }

  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify(output, null, 1));
    if (!quiet && !args.json) console.log(`\nJSON: ${path.resolve(args.out)}`);
  }
  if (args.json) process.stdout.write(JSON.stringify(output.summary || output, null, 1) + "\n");
  return args["fail-on-anomaly"] && anomalies ? 2 : 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((e) => {
    console.error("Ошибка: " + (e && e.message ? e.message : e));
    if (process.env.SIM_DEBUG) console.error(e && e.stack);
    process.exitCode = 1;
  });
}

module.exports = { parseArgv, buildConfig, runBatch, runOne, aggregate, printReport, main };
