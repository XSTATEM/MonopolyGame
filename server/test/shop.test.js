// ---------------------------------------------------------------------
// Магазин, заказы и реклама: server/payments.js, ads.js, products.js и
// магазинная часть users.js. Сервер поднимается как в smoke.js (свободный
// порт, временная папка данных):
// 1) без настроек — всё выключено и невидимо, рейтинг старых аккаунтов
//    равен их очкам, скины Премиума и наборов за очки не продаются;
// 2) PAYMENTS_MOCK=1 и реклама — заказы, Премиум, повтор нерасходуемого,
//    одна выдача на покупку, чужой заказ, вход, лимит видео, перезапуск
//    без повторного начисления, отказ mock при NODE_ENV=production;
// 3) чистые функции — проверки ЮKassa/RuStore/Google, адреса ЮKassa,
//    billingUserId, подпись AdMob, сутки по Москве, возврат с долгом и его
//    погашение; затем RuStore и Google Play в этом же процессе с подменённым
//    fetch (подписи запросов, выдача, consume/acknowledge, досылка, повторный
//    заказ, возвраты RuStore и voidedpurchases); настройки видео (ADS_YANDEX,
//    ADMOB_SSV, возраст аккаунта);
// 4) поддельная ЮKassa (http.createServer + YOOKASSA_API_URL) — платёж,
//    вебхук (только с адресов ЮKassa), повтор, подмена суммы, возвраты (в том
//    числе до выдачи и несколькими частями), опрос, YOOKASSA_ALLOW_TEST.
// Запуск: node test/shop.test.js (из папки server) или npm test.
// SMOKE_VERBOSE=1 — печатать вывод сервера сразу.
// ---------------------------------------------------------------------
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");

const SERVER = path.join(__dirname, "..", "server.js");
const VERBOSE = process.env.SMOKE_VERBOSE === "1";
const TIMEOUT_MS = 120 * 1000;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "birzha-shop-"));
const PURE = fs.mkdtempSync(path.join(os.tmpdir(), "birzha-shop-pure-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let BASE = "";
let PORT = 0;
let failures = 0;
let srv = null;
let fake = null;
const srvLog = [];

// Мимо console: журнал модулей, загруженных в этот процесс, на время их
// проверки уходит в srvLog (печатается только при сбое).
function check(cond, msg) { process.stdout.write((cond ? "PASS " : "FAIL ") + msg + "\n"); if (!cond) failures++; }
function captureConsole() {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(saved)) console[k] = (...a) => { const line = "[mod] " + a.join(" "); srvLog.push(line); if (VERBOSE) saved.log(line); };
  return () => Object.assign(console, saved);
}

// Настройки магазина из окружения того, кто запускает тест, не должны
// просочиться ни в сервер, ни в модули, загруженные в этот процесс.
const SHOP_ENV = /^(YOOKASSA_|RUSTORE_|GOOGLE_PLAY_|ADS_|ADMOB_|YANDEX_ADS_|PAYMENTS_MOCK|SHOP_)/;
function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!SHOP_ENV.test(k) && k !== "NODE_ENV" && k !== "TRUST_PROXY") env[k] = v;
  return env;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
function startServer(extraEnv) {
  const p = spawn(process.execPath, [SERVER], {
    env: Object.assign(cleanEnv(), { PORT: String(PORT), HOST: "127.0.0.1", DATA_DIR: DATA }, extraEnv || {}),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const sink = (tag) => (d) => {
    for (const line of String(d).split(/\r?\n/)) {
      if (!line) continue;
      srvLog.push(tag + line);
      if (VERBOSE) console.log(tag + line);
    }
  };
  p.stdout.on("data", sink("[srv] "));
  p.stderr.on("data", sink("[srv-err] "));
  p.exited = new Promise((r) => p.on("exit", r));
  return p;
}
async function stopServer() {
  if (!srv || srv.exitCode !== null || srv.signalCode !== null) return;
  srv.kill();
  await Promise.race([srv.exited, sleep(5000)]);
}
async function restart(extraEnv) {
  await stopServer();
  srvLog.push("----- перезапуск -----");
  srv = startServer(extraEnv);
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(BASE + "/healthz"); if (r.ok) return; } catch (e) {}
    if (srv.exitCode !== null) throw new Error("сервер завершился при запуске");
    await sleep(100);
  }
  throw new Error("сервер не отвечает на /healthz");
}
async function req(method, p, body, headers) {
  const r = await fetch(BASE + p, {
    method,
    headers: Object.assign(body ? { "Content-Type": "application/json" } : {}, headers || {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { status: r.status, body: json || {}, headers: r.headers };
}
const post = (p, body, headers) => req("POST", p, body, headers);
const get = (p, headers) => req("GET", p, null, headers);
const bearer = (token) => ({ Authorization: "Bearer " + token });
function acc(username, token) { return { username, password: "", token }; }

// --- 3) чистые функции (в этом процессе, своя папка данных) -----------------
function pureChecks() {
  for (const k of Object.keys(process.env)) if (SHOP_ENV.test(k)) delete process.env[k];
  delete process.env.NODE_ENV;
  process.env.DATA_DIR = PURE;
  const users = require("../users.js");
  const Products = require("../products.js");
  const P = require("../payments.js");
  const A = require("../ads.js");

  check(Products.PRODUCTS.every((p) => /^[a-z0-9][a-z0-9_]*$/.test(p.id)), "id товаров — строчная латиница, цифры и «_»");

  // Лига недели: неделя по Москве, билеты, очки по месту, итоги недели.
  users.register("liga1", "pass1234"); users.register("liga2", "pass1234");
  const MON = Date.UTC(2026, 9, 11, 21, 0); // понедельник 12.10 00:00 по Москве
  check(users.leagueWeekOf(MON).key === "2026-10-12" && users.leagueWeekOf(MON - 1).key === "2026-10-05", "неделя лиги — с понедельника по Москве");
  const lg1 = users.recordLeagueGame("liga1", 1, false, MON + 3600e3);
  check(lg1.counted && lg1.points === 10 && lg1.tickets.free === 2, "победа: 10 очков лиги, билет потрачен");
  const lg2 = users.recordLeagueGame("liga1", 2, true, MON + 7200e3);
  check(lg2.points === 3 && lg2.total === 13, "2 место в партии с ботами — половина");
  users.recordLeagueGame("liga1", 3, false, MON + 7300e3);
  const lg4 = users.recordLeagueGame("liga1", 1, false, MON + 7400e3);
  check(lg4.counted === false && lg4.code === "no_tickets", "4-я партия за день без билета в лигу не идёт");
  const lg5 = users.recordLeagueGame("liga1", 1, false, MON + 86400e3 + 3600e3);
  check(lg5.counted && lg5.tickets.free === 2 && lg5.total === 27, "на следующий день — снова 3 бесплатных билета");
  users.recordLeagueGame("liga2", 1, false, MON + 3600e3);
  const ltb = users.leagueTable(MON + 2 * 86400e3, users.usernameKey("liga2"));
  check(ltb.top.length === 2 && ltb.top[0].username === "liga1" && ltb.top[0].points === 27 && ltb.me.place === 2 && ltb.me.points === 10, "таблица недели и своё место");
  check(users.buyLeagueTicket("liga2", "pass1234").code === "no_points", "билет без очков не продаётся");
  check(users.settleLeague(MON + 7 * 86400e3 + 1000) === true && users.settleLeague(MON + 7 * 86400e3 + 2000) === false, "итоги недели подводятся один раз");
  const champ = users.login("liga1", "pass1234").user, second = users.login("liga2", "pass1234").user;
  check(champ.points === 500 && champ.leagueAward.place === 1 && second.points === 300 && second.leagueAward.prize === 300, "призы недели: 500 и 300 очков");
  const ltb2 = users.leagueTable(MON + 7 * 86400e3 + 3000, null);
  check(ltb2.week === "2026-10-19" && ltb2.top.length === 0 && ltb2.hall[0].week === "2026-10-12" && ltb2.hall[0].top[0].username === "liga1", "новая неделя с нуля, призёры — в зале славы");
  check(ltb2.top.length === 0 && users.leagueTable(MON + 8 * 86400e3, null).hall[0].top.length === 2, "зал славы хранит призёров");
  const tk = users.buyLeagueTicket("liga2", "pass1234");
  check(tk.ok && tk.user.points === 270 && tk.user.league.tickets.extra === 1, "билет лиги за 30 очков");
  check(Products.byId("tm_points_300").rub === 99 && Products.rubValue(Products.byId("tm_points_300")) === "99.00", "цена tm_points_300 = 99.00");
  check(JSON.stringify(P.catalogFor("web")) === '{"enabled":false}', "без настроек каталог выключен (в процессе)");

  const order = { id: "6f1c2a9e-4b7d-4c1e-9a3f-2d8b5e7c1a40", user: "игрок1", amount: { value: "99.00", currency: "RUB" } };
  const pay = { id: "30b1d5f4-000f-5000-8000-1a2b3c4d5e6f", status: "succeeded", paid: true, amount: { value: "99.00", currency: "RUB" },
    metadata: { orderId: order.id, account: "игрок1", product: "tm_points_300" } };
  check(P.ykPaymentOk(pay, order) === true, "ykPaymentOk: оплаченный платёж заказа");
  check(!P.ykPaymentOk(Object.assign({}, pay, { amount: { value: "1.00", currency: "RUB" } }), order), "ykPaymentOk: другая сумма — нет");
  check(!P.ykPaymentOk(Object.assign({}, pay, { status: "pending", paid: false }), order), "ykPaymentOk: не оплачен — нет");
  check(!P.ykPaymentOk(Object.assign({}, pay, { metadata: { orderId: order.id, account: "другой" } }), order), "ykPaymentOk: другой аккаунт — нет");
  check(!P.ykPaymentOk(Object.assign({}, pay, { amount: { value: "99.00", currency: "USD" } }), order), "ykPaymentOk: другая валюта — нет");
  check(!P.ykPaymentOk(Object.assign({}, pay, { refunded_amount: { value: "99.00", currency: "RUB" } }), order), "ykPaymentOk: деньги уже вернули (refunded_amount) — нет");
  check(P.ykPaymentOk(Object.assign({}, pay, { refunded_amount: { value: "0.00", currency: "RUB" } }), order) === true, "ykPaymentOk: refunded_amount 0.00 — да");

  // billingUserId — случайный id аккаунта в users.json, а не хэш публичного ника.
  check(users.billingUserId("игрок1") === null, "billingUserId: нет аккаунта — null");
  users.register("Игрок1", "pass1234");
  users.register("Игрок2", "pass1234");
  const uid = users.billingUserId("игрок1");
  check(/^[0-9a-f]{64}$/.test(uid) && uid !== users.billingUserId("игрок2"), "billingUserId — 64 hex, у каждого свой");
  const tagHash = crypto.createHash("sha256").update("tm-billing:игрок1").digest("hex");
  const stored = JSON.parse(fs.readFileSync(path.join(PURE, "users.json"), "utf8"))["игрок1"].billingId;
  check(uid === users.billingUserId("игрок1") && stored === uid && uid !== tagHash, "billingUserId постоянный, хранится в users.json и не выводится из ника");
  const inv = { appId: 2063512345, invoiceStatus: "confirmed", appUserId: uid, order: { itemCode: "tm_points_300", amountCurrent: 9900 } };
  const rsOrder = { productId: "tm_points_300" };
  check(P.rustoreInvoiceOk(inv, rsOrder, "игрок1", "2063512345") === true, "rustoreInvoiceOk: подтверждённый счёт (статус строчными)");
  check(!P.rustoreInvoiceOk(Object.assign({}, inv, { invoiceStatus: "PAID" }), rsOrder, "игрок1", "2063512345"), "rustoreInvoiceOk: PAID — нет");
  check(!P.rustoreInvoiceOk(inv, rsOrder, "игрок2", "2063512345"), "rustoreInvoiceOk: чужой appUserId — нет");
  check(!P.rustoreInvoiceOk(inv, { productId: "tm_premium" }, "игрок1", "2063512345"), "rustoreInvoiceOk: другой товар — нет");
  check(!P.rustoreInvoiceOk(inv, rsOrder, "игрок1", "1"), "rustoreInvoiceOk: другое приложение — нет");

  const gp = { purchaseState: 0, obfuscatedExternalAccountId: uid, acknowledgementState: 0, consumptionState: 0 };
  check(P.googlePurchaseOk(gp, "игрок1", false) === true, "googlePurchaseOk: оплаченная покупка");
  check(!P.googlePurchaseOk(Object.assign({}, gp, { purchaseType: 0 }), "игрок1", false), "googlePurchaseOk: тестовая без GOOGLE_PLAY_ALLOW_TEST — нет");
  check(P.googlePurchaseOk(Object.assign({}, gp, { purchaseType: 0 }), "игрок1", true), "googlePurchaseOk: тестовая с GOOGLE_PLAY_ALLOW_TEST — да");
  check(!P.googlePurchaseOk(Object.assign({}, gp, { purchaseState: 2 }), "игрок1", false), "googlePurchaseOk: ожидает оплаты — нет");
  check(!P.googlePurchaseOk(gp, "игрок2", false), "googlePurchaseOk: чужой аккаунт — нет");
  check(!P.googlePurchaseOk(gp, "нет-такого", false), "googlePurchaseOk: аккаунта нет — нет");
  const gpItem = Object.assign({}, gp, { productId: "tm_points_300" });
  check(P.googlePurchaseOk(gpItem, "игрок1", false, "tm_points_300") === true, "googlePurchaseOk: товар в ответе Google совпал");
  check(!P.googlePurchaseOk(gpItem, "игрок1", false, "tm_points_1600"), "googlePurchaseOk: Google ответил о другом товаре — нет");
  check(!P.googlePurchaseOk(Object.assign({}, gpItem, { quantity: 3 }), "игрок1", false, "tm_points_300"), "googlePurchaseOk: несколько штук разом — нет");

  check(P.ykIpAllowed("185.71.76.5") && P.ykIpAllowed("::ffff:77.75.156.11") && P.ykIpAllowed("2a02:5180::1") && P.ykIpAllowed("77.75.154.200"), "IP ЮKassa: 185.71.76.5, ::ffff:77.75.156.11, 2a02:5180::1, 77.75.154.200 — да");
  check(!P.ykIpAllowed("8.8.8.8") && !P.ykIpAllowed("77.75.156.12") && !P.ykIpAllowed("") && !P.ykIpAllowed("garbage"), "IP ЮKassa: 8.8.8.8, соседний адрес, пусто — нет");

  // AdMob SSV на своём ключе P-256: подписано всё до «&signature=».
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = publicKey.export({ type: "spki", format: "pem" });
  const msg = "ad_network=5450213213286189855&ad_unit=1234567890&custom_data=0123456789abcdef0123456789abcdef&reward_amount=10&reward_item=coins&timestamp=1760270000000&transaction_id=123456789&user_id=" + uid;
  const sig = crypto.sign("sha256", Buffer.from(msg), { key: privateKey, dsaEncoding: "der" }).toString("base64url");
  const parsed = A.parseAdmobSsv(msg + "&signature=" + sig + "&key_id=3335741209");
  check(parsed && parsed.message === msg && parsed.keyId === "3335741209" && parsed.params.transaction_id === "123456789" && parsed.params.user_id === uid, "parseAdmobSsv разбирает колбэк");
  check(parsed && A.verifyWithKey(parsed.message, parsed.signature, pem) === true, "verifyWithKey: верная подпись проходит");
  const forged = A.parseAdmobSsv(msg.replace("reward_amount=10", "reward_amount=1000") + "&signature=" + sig + "&key_id=3335741209");
  check(forged && A.verifyWithKey(forged.message, forged.signature, pem) === false, "verifyWithKey: изменённый reward_amount — подпись не сходится");
  check(A.parseAdmobSsv("ad_unit=1&user_id=2") === null, "parseAdmobSsv: без подписи — null");

  // Сутки по Москве, лимит, пауза, Премиум, возврат с долгом.
  const reg = users.register("Pure", "pass1234");
  check(reg.ok && reg.user.rating === 0 && reg.user.points === 0 && reg.user.premium === false, "register: rating 0, points 0, без Премиума");
  const t0 = Date.parse("2026-10-12T20:59:00Z"); // 23:59 МСК
  const opts = (now) => ({ points: 10, cap: 1, cooldownMs: 0, now });
  check(users.claimAdReward("pure", opts(t0)).ok, "видео 1 до полуночи МСК");
  const capped = users.claimAdReward("pure", opts(t0 + 30e3));
  check(capped.code === "ads_cap" && capped.nextAt === Date.parse("2026-10-12T21:00:00Z"), "лимит; nextAt — полночь по Москве: " + JSON.stringify(capped));
  check(users.claimAdReward("pure", opts(t0 + 120e3)).ok, "после 00:00 МСК счётчик сброшен");
  const cool = users.claimAdReward("pure", { points: 10, cap: 5, cooldownMs: 180e3, now: t0 + 150e3 });
  // Последнее видео — в t0+120 с, пауза 180 с: осталось 150 с → «через 3 мин.» (с округлением вверх).
  check(cool.code === "ads_cooldown" && /через 3 мин\.$/.test(cool.error) && cool.nextAt === t0 + 300e3, "пауза между видео: " + cool.error);

  const premiumOrder = { id: crypto.randomUUID(), user: "pure", productId: "tm_premium", provider: "mock", test: true, grantedAt: Date.now() };
  const ap = users.applyOrder(premiumOrder);
  check(ap.ok && ap.applied && ap.profile.premium && ap.profile.points === 320, "applyOrder: Премиум +300 к 20 очкам за видео");
  check(users.applyOrder(premiumOrder).applied === false, "applyOrder повторно — без второго начисления");
  check(ap.profile.ownedBoardSkins.includes("gold") && ap.profile.ownedAvatarPacks.includes("bulls") && !ap.profile.ownedBoardSkins.includes("wallstreet"), "Премиум открывает gold и bulls, но не набор «Уолл-стрит»");
  check(users.equipSkin("Pure", "pass1234", "gold", "boardSkin").ok, "тему «Золото биржи» можно надеть");
  check(users.updateProfile("Pure", "pass1234", null, "\u{1F402}").ok, "аватар из пака «Быки и медведи» доступен (старое эмодзи быка → значок bull)");
  check(users.buySkin("Pure", "pass1234", "royal", "boardSkin").error === "Этот скин уже куплен.", "скин за очки уже входит в Премиум — очки не списываются");
  const spent = users.buySkin("Pure", "pass1234", "wallstreet", "boardSkin");
  check(spent.error === "Этот скин продаётся только в наборе.", "скин набора за очки не продаётся");
  // Потратили часть бонуса и вернули деньги: недостача уходит в debt, баланс не ниже нуля.
  users.addPoints("Pure", 1); // рейтинг 1, баланс 321
  check(users.buySkin("Pure", "pass1234", "legend", "avatarPack").error === "Этот скин уже куплен.", "пак «Легенда» в Премиуме");
  const rv = users.revokeOrder(premiumOrder);
  const after = users.accountShopInfo("pure");
  check(rv.revoked && !after.premium && after.points === 21 && !after.ownedBoardSkins.includes("gold"), "revokeOrder: Премиум снят, бонус списан: " + JSON.stringify({ points: after.points, premium: after.premium }));
  const prof = users.loginWithToken(reg.sessionToken).user;
  check(prof.equippedBoardSkin === "default" && prof.avatar === "", "после возврата тема и аватар вернулись к стандартным");
  check(users.revokeOrder(premiumOrder).revoked === false, "revokeOrder повторно — ничего");
  check(after.purchases.length === 1 && after.purchases[0].refundedAt, "в истории покупка с отметкой возврата");

  // Купили очки, потратили на скин, вернули деньги: недостача — долг аккаунта,
  // его гасят следующие начисления (победы, покупки, видео), а не баланс.
  const pts700 = { id: crypto.randomUUID(), user: "pure", productId: "tm_points_700", provider: "mock", test: true, grantedAt: Date.now() };
  users.applyOrder(pts700); // 21 + 700 = 721
  check(users.buySkin("Pure", "pass1234", "vip", "avatarPack").ok, "пак VIP за 600 очков из купленных");
  users.revokeOrder(pts700);
  let info = users.accountShopInfo("pure");
  check(info.points === 0 && info.pointsDebt === 579, "возврат потраченных очков: баланс 0, долг 579: " + JSON.stringify({ points: info.points, debt: info.pointsDebt }));
  const rating0 = info.rating;
  users.addPoints("Pure", 100);
  info = users.accountShopInfo("pure");
  check(info.points === 0 && info.pointsDebt === 479 && info.rating === rating0 + 100, "победа: рейтинг +100, на баланс ничего — гасит долг");
  check(users.buySkin("Pure", "pass1234", "legend", "avatarPack").error === "Недостаточно очков.", "пока долг не погашен, скины за очки не купить");
  users.applyOrder({ id: crypto.randomUUID(), user: "pure", productId: "tm_points_300", provider: "mock", test: true, grantedAt: Date.now() });
  check(users.accountShopInfo("pure").pointsDebt === 179 && users.accountShopInfo("pure").points === 0, "покупка очков тоже сначала гасит долг");
  users.addPoints("Pure", 500);
  info = users.accountShopInfo("pure");
  check(info.points === 321 && info.pointsDebt === 0, "долг погашен, остаток — на баланс: " + info.points);
  return { users, token: reg.sessionToken };
}

// --- RuStore и Google Play: модуль с настройками и подменённым fetch --------
// Настоящих запросов к магазинам нет: fetch отвечает как их API и заодно
// проверяет подписи сервера (RuStore — SHA512withRSA, Google — JWT RS256).
async function storeChecks(users, token) {
  const rs = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const gk = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  fs.writeFileSync(path.join(PURE, "gp.json"), JSON.stringify({ client_email: "svc@test.iam.gserviceaccount.com", private_key: gk.privateKey.export({ type: "pkcs8", format: "pem" }) }));
  Object.assign(process.env, {
    RUSTORE_KEY_ID: "1275328", RUSTORE_APP_ID: "2063512345",
    RUSTORE_PRIVATE_KEY: rs.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    GOOGLE_PLAY_PACKAGE: "com.xstatem.trademonopoly", GOOGLE_PLAY_SERVICE_ACCOUNT: path.join(PURE, "gp.json"), GOOGLE_PLAY_ALLOW_TEST: "on",
  });
  delete require.cache[require.resolve("../payments.js")];
  delete require.cache[require.resolve("../ads.js")];
  const P = require("../payments.js");
  const uid = users.billingUserId("pure");
  const me = { username: "Pure", password: "", token };

  const catR = P.catalogFor("rustore");
  const catG = P.catalogFor("googleplay");
  check(JSON.stringify(catR.providers) === '["rustore"]' && catR.products[0].price.value === "99.00", "каталог rustore: RuStore, ориентир в рублях");
  check(JSON.stringify(catG.providers) === '["googleplay"]' && catG.products[0].price === null, "каталог googleplay: Google Play, цена из магазина");
  check(JSON.stringify(P.catalogFor("web")) === '{"enabled":false}', "на сайте магазинных провайдеров нет");

  const invoices = {
    1001: { invoiceStatus: "confirmed", itemCode: "tm_points_300" },
    1002: { invoiceStatus: "paid", itemCode: "tm_points_300" },
    1004: { invoiceStatus: "CONFIRMED", itemCode: "tm_points_300", appUserId: "чужой" },
    1005: { invoiceStatus: "CONFIRMED", itemCode: "tm_points_700" },
  };
  const purchases = {
    "gp-token-consumable-0001": { purchaseState: 0, consumptionState: 0, acknowledgementState: 0, purchaseType: 0 },
    "gp-token-premium-000001": { purchaseState: 0, consumptionState: 0, acknowledgementState: 0 },
    "gp-token-pending-000001": { purchaseState: 2, consumptionState: 0, acknowledgementState: 0 },
    "gp-token-consumed-00001": { purchaseState: 0, consumptionState: 1, acknowledgementState: 1 },
    "gp-token-other-acc-0001": { purchaseState: 0, consumptionState: 0, acknowledgementState: 0, obfuscatedExternalAccountId: "чужой" },
    "gp-token-consumefail-01": { purchaseState: 0, consumptionState: 0, acknowledgementState: 0 },
  };
  const calls = [];
  let consumeBroken = false;
  const realFetch = globalThis.fetch;
  const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
  globalThis.fetch = async (url, opts) => {
    url = String(url);
    opts = opts || {};
    calls.push({ url, method: opts.method || "GET", headers: opts.headers || {}, body: opts.body });
    if (url === "https://public-api.rustore.ru/public/auth/") {
      const b = JSON.parse(opts.body);
      const okSig = crypto.verify("sha512", Buffer.from(b.keyId + b.timestamp), rs.publicKey, Buffer.from(b.signature, "base64"));
      if (!okSig || b.keyId !== "1275328" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}\+00:00$/.test(b.timestamp)) return json(400, { code: "ERROR", message: "Signature encode error" });
      return json(200, { code: "OK", message: null, body: { jwe: "jwe-1", ttl: 900 } });
    }
    let m = /^https:\/\/public-api\.rustore\.ru\/public\/v2\/invoices\/(\d+)$/.exec(url);
    if (m) {
      if (opts.headers["Public-Token"] !== "jwe-1") return json(401, { code: "ERROR", message: "Jwe token is expired" });
      const inv = invoices[m[1]];
      if (!inv) return json(200, { code: "NOT_FOUND", message: "not found", body: null });
      return json(200, { code: "OK", body: { invoiceId: Number(m[1]), invoiceStatus: inv.invoiceStatus, appId: 2063512345, appUserId: inv.appUserId || uid,
        order: { itemCode: inv.itemCode, amountCurrent: 9900, currency: "RUB" } } });
    }
    if (url === "https://oauth2.googleapis.com/token") {
      const assertion = new URLSearchParams(opts.body).get("assertion") || "";
      const [h, c, s] = assertion.split(".");
      const claims = JSON.parse(Buffer.from(c, "base64url").toString());
      const okSig = crypto.verify("RSA-SHA256", Buffer.from(h + "." + c), gk.publicKey, Buffer.from(s, "base64url"));
      if (!okSig || claims.scope !== "https://www.googleapis.com/auth/androidpublisher" || claims.aud !== "https://oauth2.googleapis.com/token") return json(400, { error: "invalid_grant" });
      return json(200, { access_token: "at-1", expires_in: 3600, token_type: "Bearer" });
    }
    const base = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.xstatem.trademonopoly";
    if (url.startsWith(base) && opts.headers.Authorization !== "Bearer at-1") return json(401, { error: { code: 401 } });
    if (url.startsWith(base + "/purchases/voidedpurchases?")) return json(200, { voidedPurchases: [{ purchaseToken: "gp-token-premium-000001", voidedReason: 1 }] });
    m = /\/purchases\/products\/([a-z0-9_]+)\/tokens\/([A-Za-z0-9._-]+?)(:consume|:acknowledge)?$/.exec(url);
    if (url.startsWith(base) && m) {
      const p = purchases[m[2]];
      if (!p) return json(404, { error: { code: 404 } });
      if (m[3] === ":consume") { if (consumeBroken) return json(503, {}); p.consumptionState = 1; return new Response("", { status: 200 }); }
      if (m[3] === ":acknowledge") { p.acknowledgementState = 1; return new Response("", { status: 200 }); }
      return json(200, Object.assign({ kind: "androidpublisher#productPurchase", productId: m[1], obfuscatedExternalAccountId: uid }, p));
    }
    return json(599, { error: "неожиданный запрос " + url });
  };
  try {
    const points = () => users.accountShopInfo("pure").points;
    const p0 = points();
    // RuStore: заказ → покупка в приложении → verify.
    const ro = await P.createOrder(Object.assign({}, me, { productId: "tm_points_300", provider: "rustore", platform: "rustore" }));
    check(ro.ok && ro.status === "created" && ro.storeProductId === "tm_points_300" && ro.billingUserId === uid, "RuStore: заказ создан, id товара и appUserId для SDK");
    const roAgain = await P.createOrder(Object.assign({}, me, { productId: "tm_points_300", provider: "rustore", platform: "rustore" }));
    check(roAgain.ok && roAgain.orderId === ro.orderId, "RuStore: повторное «Купить» того же товара — тот же заказ, без нового");
    const rv1 = await P.verify(Object.assign({}, me, { provider: "rustore", productId: "tm_points_300", purchaseToken: "1001", orderId: ro.orderId }));
    check(rv1.ok && rv1.status === "granted" && rv1.orderId === ro.orderId && points() === p0 + 300, "RuStore: подтверждённый счёт (статус строчными) → +300 по тому же заказу");
    const rv2 = await P.verify(Object.assign({}, me, { provider: "rustore", productId: "tm_points_300", purchaseToken: "1001" }));
    check(rv2.alreadyGranted === true && points() === p0 + 300, "RuStore: повтор счёта — без выдачи");
    check((await P.verify(Object.assign({}, me, { provider: "rustore", productId: "tm_points_300", purchaseToken: "1002" }))).status === "pending", "RuStore: PAID → pending");
    check((await P.verify(Object.assign({}, me, { provider: "rustore", productId: "tm_points_300", purchaseToken: "1003" }))).code === "invalid_purchase", "RuStore: счёт не найден → invalid_purchase");
    check((await P.verify(Object.assign({}, me, { provider: "rustore", productId: "tm_points_300", purchaseToken: "1004" }))).code === "other_account", "RuStore: чужой appUserId → other_account");
    check((await P.verify(Object.assign({}, me, { provider: "rustore", productId: "tm_points_300", purchaseToken: "1005" }))).code === "invalid_purchase", "RuStore: другой товар в счёте → invalid_purchase");
    check(calls.filter((c) => c.url.endsWith("/public/auth/")).length === 1, "RuStore: токен API получен один раз и закеширован");

    // Возврат RuStore: уведомлений нет, а покупка пропадает из приложения —
    // выданный счёт перепроверяет фоновая задача (не чаще раза в сутки на счёт).
    const pRs = points();
    invoices[1001].invoiceStatus = "REFUNDED";
    const invCalls = () => calls.filter((c) => c.url.endsWith("/v2/invoices/1001")).length;
    const ic0 = invCalls();
    await P.pollRustoreRefunds(Date.now());
    check(invCalls() === ic0 && points() === pRs, "RuStore: счёт проверен меньше суток назад — фоновая задача его не трогает");
    await P.pollRustoreRefunds(Date.now() + 25 * 3600e3);
    const rsOrders = JSON.parse(fs.readFileSync(path.join(PURE, "orders.json"), "utf8")).orders;
    check(invCalls() === ic0 + 1 && points() === pRs - 300 && rsOrders[ro.orderId].status === "refunded", "RuStore: CONFIRMED → REFUNDED — заказ снят, −300");
    const rvRef = await P.verify(Object.assign({}, me, { provider: "rustore", productId: "tm_points_300", purchaseToken: "1001" }));
    check(rvRef.code === "invalid_purchase" && points() === pRs - 300, "RuStore: возвращённый счёт повторно не выдаётся");
    check((await P.verify(Object.assign({}, me, { provider: "googleplay", productId: "tm_points_300", purchaseToken: "short" }))).code === "invalid_purchase", "Google: короткий токен → invalid_purchase");

    // Google Play: проверка, выдача, consume/acknowledge.
    const p1 = points();
    const gv1 = await P.verify(Object.assign({}, me, { provider: "googleplay", productId: "tm_points_700", purchaseToken: "gp-token-consumable-0001" }));
    check(gv1.ok && gv1.status === "granted" && points() === p1 + 700, "Google: оплаченная покупка тестера → +700");
    check(calls.some((c) => c.method === "POST" && c.url.endsWith("/tokens/gp-token-consumable-0001:consume")), "Google: расходуемый товар потреблён (consume)");
    check((await P.verify(Object.assign({}, me, { provider: "googleplay", productId: "tm_points_700", purchaseToken: "gp-token-consumable-0001" }))).alreadyGranted === true, "Google: повтор — без выдачи");
    const gv2 = await P.verify(Object.assign({}, me, { provider: "googleplay", productId: "tm_premium", purchaseToken: "gp-token-premium-000001" }));
    const ack = calls.find((c) => c.method === "POST" && c.url.endsWith("/tokens/gp-token-premium-000001:acknowledge"));
    check(gv2.ok && users.isPremium("pure") && ack && ack.body === "{}", "Google: Премиум выдан и подтверждён (acknowledge {})");
    check((await P.verify(Object.assign({}, me, { provider: "googleplay", productId: "tm_points_300", purchaseToken: "gp-token-pending-000001" }))).status === "pending", "Google: purchaseState 2 → pending");
    check((await P.verify(Object.assign({}, me, { provider: "googleplay", productId: "tm_points_300", purchaseToken: "gp-token-consumed-00001" }))).code === "invalid_purchase", "Google: потреблено не нами → invalid_purchase");
    check((await P.verify(Object.assign({}, me, { provider: "googleplay", productId: "tm_points_300", purchaseToken: "gp-token-other-acc-0001" }))).code === "other_account", "Google: чужой obfuscatedAccountId → other_account");

    consumeBroken = true;
    const gv3 = await P.verify(Object.assign({}, me, { provider: "googleplay", productId: "tm_points_300", purchaseToken: "gp-token-consumefail-01" }));
    const orders = () => JSON.parse(fs.readFileSync(path.join(PURE, "orders.json"), "utf8")).orders;
    check(gv3.status === "granted" && orders()[gv3.orderId].needsFinish === true, "Google: consume не прошёл — выдано, needsFinish");
    consumeBroken = false;
    await P.finishGoogle();
    check(orders()[gv3.orderId].needsFinish === false && !orders()[gv3.orderId].finishToken, "Google: фоновая досылка consume");

    const p2 = points();
    await P.pollGoogleVoided();
    check(!users.isPremium("pure") && points() === p2 - 300 && orders()[gv2.orderId].status === "refunded", "Google: возврат из voidedpurchases снимает Премиум и бонус");
    check(calls.filter((c) => c.url === "https://oauth2.googleapis.com/token").length === 1, "Google: access_token получен один раз и закеширован");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- Видео: какие провайдеры включены при разных настройках (ads.js) --------
// Яндекс засчитывается «на честном слове» (платформу называет клиент), поэтому
// при ADMOB_SSV=on он по умолчанию выключен — иначе SSV обходился бы через direct.
function adsConfigChecks() {
  const ADS_ENV = /^(ADS_|ADMOB_)/;
  const load = (env) => {
    for (const k of Object.keys(process.env)) if (ADS_ENV.test(k)) delete process.env[k];
    Object.assign(process.env, env);
    delete require.cache[require.resolve("../ads.js")];
    return require("../ads.js");
  };
  const yandexStart = (A) => A.start({ username: "Pure", password: "pass1234", provider: "yandex", adUnit: "demo-rewarded-yandex", platform: "direct" });
  try {
    let A = load({ ADS_REWARD_POINTS: "10", ADMOB_SSV: "on" });
    check(!A.catalogInfo("direct").enabled && !A.catalogInfo("rustore").enabled && JSON.stringify(A.catalogInfo("googleplay").providers) === '["admob"]',
      "ADMOB_SSV=on: видео Яндекса по умолчанию выключены, AdMob есть");
    check(yandexStart(A).code === "ads_disabled", "ADMOB_SSV=on: билет Яндекса (platform direct) не выдаётся — SSV не обойти");
    A = load({ ADS_REWARD_POINTS: "10", ADMOB_SSV: "on", ADS_YANDEX: "on" });
    check(JSON.stringify(A.catalogInfo("direct").providers) === '["yandex"]', "ADS_YANDEX=on включает Яндекс явно");
    A = load({ ADS_REWARD_POINTS: "10", ADS_YANDEX: "off" });
    check(!A.catalogInfo("direct").enabled && !A.catalogInfo("rustore").enabled, "ADS_YANDEX=off выключает Яндекс");
    A = load({ ADS_REWARD_POINTS: "10", ADS_MIN_ACCOUNT_AGE_HOURS: "24" });
    const young = yandexStart(A);
    check(young.code === "ads_new_account" && /через 24 ч/.test(young.error || ""), "ADS_MIN_ACCOUNT_AGE_HOURS: новому аккаунту видео позже: " + young.error);
  } finally {
    for (const k of Object.keys(process.env)) if (ADS_ENV.test(k)) delete process.env[k];
    delete require.cache[require.resolve("../ads.js")];
  }
}

// --- поддельная ЮKassa -------------------------------------------------------
function startFakeYookassa() {
  const state = { payments: new Map(), refunds: new Map(), byIdem: new Map(), requests: [], failCreates: 0 };
  const server = http.createServer((rq, rs) => {
    let raw = "";
    rq.on("data", (c) => { raw += c; });
    rq.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      state.requests.push({ method: rq.method, url: rq.url, headers: rq.headers, body });
      const send = (code, obj) => { rs.writeHead(code, { "Content-Type": "application/json" }); rs.end(JSON.stringify(obj)); };
      if (rq.method === "POST" && rq.url === "/payments") {
        if (state.failCreates > 0) { state.failCreates--; return send(500, { type: "error", code: "internal_server_error" }); }
        const idem = rq.headers["idempotence-key"];
        if (idem && state.byIdem.has(idem)) return send(200, state.payments.get(state.byIdem.get(idem)));
        const id = crypto.randomUUID();
        const p = { id, status: "pending", paid: false, test: true, amount: body.amount, description: body.description, metadata: body.metadata,
          confirmation: { type: "redirect", confirmation_url: "https://yoomoney.ru/checkout/payments/v2/contract?orderId=" + id } };
        state.payments.set(id, p);
        if (idem) state.byIdem.set(idem, id);
        return send(200, p);
      }
      let m = /^\/payments\/([^/]+)$/.exec(rq.url);
      if (rq.method === "GET" && m) return state.payments.has(m[1]) ? send(200, state.payments.get(m[1])) : send(404, { type: "error", code: "not_found" });
      m = /^\/refunds\/([^/]+)$/.exec(rq.url);
      if (rq.method === "GET" && m) return state.refunds.has(m[1]) ? send(200, state.refunds.get(m[1])) : send(404, { type: "error", code: "not_found" });
      send(404, { type: "error", code: "not_found" });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, state, port: server.address().port })));
}

async function main() {
  console.log("--- 3) чистые функции ---");
  const restoreConsole = captureConsole();
  try {
    const pure = pureChecks();
    process.stdout.write("--- 3б) RuStore и Google Play (подменённый fetch) ---\n");
    await storeChecks(pure.users, pure.token);
    process.stdout.write("--- 3в) видео: Яндекс, AdMob SSV, возраст аккаунта ---\n");
    adsConfigChecks();
  } finally { restoreConsole(); }

  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  console.log(`--- 1) без настроек: порт ${PORT}, данные ${DATA} ---`);

  // Старый аккаунт (до разделения рейтинга и баланса): очки 500, куплен «Легенда».
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync("pass1234", salt, 64).toString("hex");
  fs.writeFileSync(path.join(DATA, "users.json"), JSON.stringify({
    old: { username: "Old", salt, hash, gender: "", avatar: "\u{1F409}", avatarPhoto: null, points: 500,
      ownedAvatarPacks: ["base", "legend"], ownedBoardSkins: ["default"], equippedAvatarPack: "legend", equippedBoardSkin: "default", createdAt: Date.now() },
  }), "utf8");
  await restart();

  const cat0 = await get("/api/shop/catalog?platform=web");
  check(cat0.status === 200 && JSON.stringify(cat0.body) === '{"enabled":false}', "каталог без настроек: {enabled:false}");
  check(JSON.stringify((await get("/api/shop/catalog?platform=direct")).body) === '{"enabled":false}', "каталог direct без настроек: {enabled:false}");
  const ord0 = await post("/api/shop/order", { username: "Old", password: "pass1234", productId: "tm_points_300", provider: "mock", platform: "web" });
  check(ord0.status === 404 && ord0.body.code === "shop_disabled", "POST /api/shop/order → 404 shop_disabled");
  check((await post("/api/shop/verify", { username: "Old", password: "pass1234", provider: "mock", productId: "tm_points_300", purchaseToken: "x1" })).status === 404, "POST /api/shop/verify → 404");
  const ads0 = await post("/api/ads/start", { username: "Old", password: "pass1234", provider: "yandex", adUnit: "demo-rewarded-yandex", platform: "direct" });
  check(ads0.status === 404 && ads0.body.code === "ads_disabled", "POST /api/ads/start → 404 ads_disabled");
  check((await post("/api/ads/reward", { username: "Old", password: "pass1234", provider: "yandex", nonce: "0".repeat(32) })).status === 404, "POST /api/ads/reward → 404");
  check((await get("/api/ads/admob-ssv?ad_unit=1&signature=x&key_id=1")).status === 404, "GET /api/ads/admob-ssv → 404");
  const an0 = await post("/api/analysis/claim", { username: "Old", password: "pass1234", game: "off-1" });
  check(an0.status === 200 && an0.body.open === true, "без магазина разбор партии открыт всегда");
  check((await post("/api/shop/yookassa/webhook", { type: "notification", event: "payment.succeeded", object: { id: "x" } })).status === 404, "вебхук ЮKassa → 404");
  check((await get("/api/shop/order/" + crypto.randomUUID())).status === 404, "GET /api/shop/order/:id → 404");

  const l0 = await post("/api/login", { username: "Old", password: "pass1234" });
  const oldTok = l0.body.sessionToken;
  check(l0.status === 200 && l0.body.user.rating === 500 && l0.body.user.points === 500, "миграция: rating = points = 500");
  check(l0.body.user.premium === false && JSON.stringify(l0.body.user.ownedAvatarPacks) === '["base","legend"]' && l0.body.user.avatar === "flame", "старые покупки и аватар на месте");
  const buy = await post("/api/skins/buy", Object.assign(acc("Old", oldTok), { skinId: "emerald", kind: "boardSkin" }));
  check(buy.status === 200 && buy.body.user.points === 300 && buy.body.user.rating === 500, "скин за 200 очков: баланс 300, рейтинг 500");
  const buyGold = await post("/api/skins/buy", Object.assign(acc("Old", oldTok), { skinId: "gold", kind: "boardSkin" }));
  check(buyGold.status === 400 && buyGold.body.error === "Этот скин входит в Премиум.", "gold за очки не продаётся: " + buyGold.body.error);
  const buyWs = await post("/api/skins/buy", Object.assign(acc("Old", oldTok), { skinId: "wallstreet", kind: "boardSkin" }));
  check(buyWs.status === 400 && buyWs.body.error === "Этот скин продаётся только в наборе.", "wallstreet за очки не продаётся: " + buyWs.body.error);
  const buyBulls = await post("/api/skins/buy", Object.assign(acc("Old", oldTok), { skinId: "bulls", kind: "avatarPack" }));
  check(buyBulls.status === 400 && buyBulls.body.error === "Этот скин входит в Премиум.", "bulls за очки не продаётся");
  const poor = await post("/api/skins/buy", Object.assign(acc("Old", oldTok), { skinId: "vip", kind: "avatarPack" }));
  check(poor.status === 400 && poor.body.error === "Недостаточно очков.", "не хватает очков: " + poor.body.error);
  check((await post("/api/skins/equip", Object.assign(acc("Old", oldTok), { skinId: "gold", kind: "boardSkin" }))).body.error === "Этот скин ещё не куплен.", "надеть gold без Премиума нельзя");

  const r2 = await post("/api/register", { username: "Bob", password: "pass1234" });
  const bobTok = r2.body.sessionToken;
  check(r2.status === 200 && r2.body.user.rating === 0, "новый аккаунт: рейтинг 0");
  const lb = await get("/api/leaderboard");
  check(Array.isArray(lb.body) && lb.body[0].username === "Old" && lb.body[0].rating === 500 && lb.body[0].points === 500 && lb.body[0].premium === false,
    "рейтинг: сортировка по rating, points = rating: " + JSON.stringify(lb.body[0]));
  check(lb.body.every((e) => !("ownedAvatarPacks" in e) && !("purchases" in e)), "в таблице лидеров нет владения и покупок");

  const ent0 = await get("/api/shop/entitlements", bearer(oldTok));
  check(ent0.status === 200 && ent0.body.rating === 500 && ent0.body.points === 300 && ent0.body.ads && ent0.body.ads.enabled === false, "entitlements работает и без магазина");
  const noAuth = await get("/api/shop/entitlements");
  check(noAuth.status === 400 && noAuth.body.code === "auth_required", "entitlements без заголовка → auth_required");
  const badAuth = await get("/api/shop/entitlements", bearer("deadbeef"));
  check(badAuth.status === 400 && badAuth.body.code === "session" && badAuth.body.sessionExpired === true, "entitlements с чужим токеном → session");
  const pre = await fetch(BASE + "/api/shop/entitlements", { method: "OPTIONS", headers: { Origin: "https://localhost", "Access-Control-Request-Headers": "authorization" } });
  check(pre.status === 204 && /Authorization/.test(pre.headers.get("access-control-allow-headers") || ""), "CORS разрешает заголовок Authorization");
  check(!fs.existsSync(path.join(DATA, "orders.json")), "без настроек orders.json не создаётся");

  // --- 2) PAYMENTS_MOCK=1 ------------------------------------------------------
  console.log("--- 2) тестовая оплата и реклама ---");
  const MOCK_ENV = { PAYMENTS_MOCK: "1", ADS_REWARD_POINTS: "10", ADS_MIN_WATCH_SEC: "0", ADS_COOLDOWN_SEC: "0", ADS_DAILY_CAP: "2" };
  await restart(MOCK_ENV);
  check(srvLog.some((l) => /Магазин: ЮKassa — выкл, RuStore — выкл, Google Play — выкл, тестовая оплата — вкл, реклама — \+10 очков, 2 в сутки/.test(l)), "строка о магазине в логе при старте");
  const cat = (await get("/api/shop/catalog?platform=web")).body;
  check(cat.enabled === true && cat.mock === true && JSON.stringify(cat.providers) === '["mock"]' && cat.receipts === false, "каталог: enabled, mock");
  const p300 = cat.products && cat.products.find((p) => p.id === "tm_points_300");
  check(p300 && p300.price && p300.price.value === "99.00" && p300.price.text === "99 ₽" && p300.storeIds.rustore === "tm_points_300", "цена tm_points_300 в каталоге");
  check(cat.products.length === 10 && !cat.products.some((p) => p.id === "tm_points_4500"), "выключенный tm_points_4500 не в каталоге");
  const trCat = cat.products.find((p) => p.id === "tm_trader_30");
  check(trCat && trCat.kind === "consumable" && trCat.traderDays === 30 && trCat.price.text === "199 ₽" && Array.isArray(cat.traderBenefits) && cat.traderBenefits.length >= 3, "каталог: подписка «Трейдер»");
  const scnAll = cat.products.find((p) => p.id === "tm_scn_all");
  check(scnAll && scnAll.price.text === "349 ₽" && JSON.stringify(scnAll.unlocks.scenarios) === '["crisis2008","rumarket","commodity"]', "каталог: набор «Все сценарии»");
  check(cat.ads && cat.ads.enabled === false, "на сайте рекламы нет");
  check(Array.isArray(cat.premiumBenefits) && cat.premiumBenefits.length === 5 && JSON.stringify(cat.legal) === "{}", "преимущества Премиума; legal пуст без SHOP_*");
  const catD = (await get("/api/shop/catalog?platform=direct")).body;
  check(catD.ads.enabled && JSON.stringify(catD.ads.providers) === '["yandex"]' && catD.ads.premiumDailyCap === 4, "direct: реклама Яндекса, Премиум ×2");
  const catG = (await get("/api/shop/catalog?platform=googleplay")).body;
  check(JSON.stringify(catG.ads.providers) === '["admob"]' && catG.products[0].price === null, "googleplay: AdMob, цена из магазина (null)");
  check((await get("/api/shop/catalog?platform=xxx")).body.platform === "web", "неизвестная платформа = web");

  const o1 = await post("/api/shop/order", Object.assign(acc("Old", oldTok), { productId: "tm_points_300", provider: "mock", platform: "web" }));
  check(o1.status === 200 && o1.body.status === "granted" && o1.body.user.points === 600 && o1.body.user.rating === 500, "mock: +300 очков на баланс, рейтинг тот же");
  const yk = await post("/api/shop/order", Object.assign(acc("Old", oldTok), { productId: "tm_points_300", provider: "yookassa", platform: "web" }));
  check(yk.status === 400 && yk.body.code === "provider_disabled", "выключенная ЮKassa → provider_disabled");
  check((await post("/api/shop/order", Object.assign(acc("Old", oldTok), { productId: "tm_points_4500", provider: "mock" }))).body.code === "unknown_product", "выключенный товар → unknown_product");
  check((await post("/api/shop/order", Object.assign(acc("Old", oldTok), { productId: "nope", provider: "mock" }))).body.code === "unknown_product", "неизвестный товар → unknown_product");
  const unauth = await post("/api/shop/order", { username: "Old", password: "", token: "bad", productId: "tm_points_300", provider: "mock" });
  check(unauth.status === 400 && unauth.body.error === "Неверный пароль." && !unauth.body.orderId, "заказ с чужим токеном отклонён");
  check((await post("/api/shop/order", { productId: "tm_points_300", provider: "mock" })).status === 400, "заказ без аккаунта отклонён");

  const prem = await post("/api/shop/order", Object.assign(acc("Old", oldTok), { productId: "tm_premium", provider: "mock", platform: "web" }));
  const pu = prem.body.user || {};
  check(prem.status === 200 && pu.premium === true && pu.points === 900 && pu.rating === 500, "Премиум: premium, +300 очков");
  check(["emerald", "midnight", "royal", "gold", "neon"].every((s) => (pu.ownedBoardSkins || []).includes(s)) && !(pu.ownedBoardSkins || []).includes("wallstreet"), "Премиум: все темы, кроме набора");
  check(["legend", "vip", "bulls"].every((s) => (pu.ownedAvatarPacks || []).includes(s)) && !(pu.ownedAvatarPacks || []).includes("wallstreet"), "Премиум: все аватар-паки, кроме набора");
  const prem2 = await post("/api/shop/order", Object.assign(acc("Old", oldTok), { productId: "tm_premium", provider: "mock", platform: "web" }));
  check(prem2.status === 400 && prem2.body.code === "already_owned", "повтор Премиума → already_owned");
  const royal = await post("/api/skins/buy", Object.assign(acc("Old", oldTok), { skinId: "royal", kind: "boardSkin" }));
  check(royal.body.error === "Этот скин уже куплен.", "скин из Премиума за очки не покупается повторно");
  check((await post("/api/skins/equip", Object.assign(acc("Old", oldTok), { skinId: "gold", kind: "boardSkin" }))).status === 200, "тему Премиума можно надеть");
  const lbP = (await get("/api/leaderboard")).body;
  check(lbP[0].username === "Old" && lbP[0].premium === true && lbP[0].rating === 500, "в таблице лидеров — корона, рейтинг не вырос от покупок");

  const v1 = await post("/api/shop/verify", Object.assign(acc("Old", oldTok), { provider: "mock", productId: "tm_points_700", purchaseToken: "tok-1" }));
  check(v1.status === 200 && v1.body.status === "granted" && v1.body.alreadyGranted === false && v1.body.user.points === 1600, "verify mock: +700");
  const v2 = await post("/api/shop/verify", Object.assign(acc("Old", oldTok), { provider: "mock", productId: "tm_points_700", purchaseToken: "tok-1" }));
  check(v2.status === 200 && v2.body.alreadyGranted === true && v2.body.orderId === v1.body.orderId && v2.body.user.points === 1600, "verify с тем же токеном — без второй выдачи");
  const vBob = await post("/api/shop/verify", Object.assign(acc("Bob", bobTok), { provider: "mock", productId: "tm_points_700", purchaseToken: "tok-1" }));
  check(vBob.status === 400 && vBob.body.code === "other_account", "чужая покупка → other_account");
  check((await post("/api/shop/verify", Object.assign(acc("Old", oldTok), { provider: "mock", productId: "tm_points_700", purchaseToken: "bad token!" }))).body.code === "invalid_purchase", "кривой purchaseToken → invalid_purchase");
  check((await post("/api/shop/verify", Object.assign(acc("Old", oldTok), { provider: "rustore", productId: "tm_points_700", purchaseToken: "1" }))).body.code === "provider_disabled", "verify выключенного RuStore → provider_disabled");

  const st1 = await get("/api/shop/order/" + o1.body.orderId, bearer(oldTok));
  check(st1.status === 200 && st1.body.status === "granted" && st1.body.productId === "tm_points_300" && st1.body.test === true && st1.body.user && st1.body.user.points === 1600, "статус своего заказа");
  const stBob = await get("/api/shop/order/" + o1.body.orderId, bearer(bobTok));
  check(stBob.status === 404 && stBob.body.code === "not_found", "чужой заказ → 404");
  const stNo = await get("/api/shop/order/" + o1.body.orderId);
  check(stNo.status === 400 && stNo.body.code === "auth_required", "без токена → auth_required");
  check((await get("/api/shop/order/not-a-uuid%2F..", bearer(oldTok))).status === 404, "кривой id заказа → 404");

  const set = await post("/api/shop/order", Object.assign(acc("Bob", bobTok), { productId: "tm_set_wallstreet", provider: "mock", platform: "direct" }));
  check(set.status === 200 && set.body.user.ownedBoardSkins.includes("wallstreet") && set.body.user.ownedAvatarPacks.includes("wallstreet") && !set.body.user.premium && !set.body.user.ownedBoardSkins.includes("gold"), "набор «Уолл-стрит» открывает только свои скины");

  // Сценарии: бесплатный открыт всем, платный — после покупки; набор открывает
  // все, и купить отдельный сценарий поверх набора уже нельзя.
  check(JSON.stringify(set.body.user.ownedScenarios) === '["dotcom"]', "без покупок открыт только бесплатный сценарий");
  const sc1 = await post("/api/shop/order", Object.assign(acc("Bob", bobTok), { productId: "tm_scn_crisis2008", provider: "mock", platform: "web" }));
  check(sc1.status === 200 && JSON.stringify(sc1.body.user.ownedScenarios) === '["dotcom","crisis2008"]', "сценарий «Кризис 2008» открыт");
  const scAll = await post("/api/shop/order", Object.assign(acc("Bob", bobTok), { productId: "tm_scn_all", provider: "mock", platform: "web" }));
  check(scAll.status === 200 && JSON.stringify(scAll.body.user.ownedScenarios) === '["dotcom","crisis2008","rumarket","commodity"]', "набор открывает все сценарии");
  const scAgain = await post("/api/shop/order", Object.assign(acc("Bob", bobTok), { productId: "tm_scn_rumarket", provider: "mock", platform: "web" }));
  check(scAgain.status === 400 && scAgain.body.code === "already_owned", "сценарий из набора повторно не продаётся");

  // Подписка «Трейдер»: 30 дней, повторная покупка продлевает; пока активна —
  // все сценарии, но навсегда сценарий можно купить и при подписке.
  const DAY = 86400e3;
  const tr1 = await post("/api/shop/order", Object.assign(acc("Old", oldTok), { productId: "tm_trader_30", provider: "mock", platform: "web" }));
  const t1 = tr1.body.user && tr1.body.user.trader;
  check(tr1.status === 200 && t1 && t1.active && Math.abs(t1.until - Date.now() - 30 * DAY) < 60e3, "«Трейдер»: активен на 30 дней");
  check(JSON.stringify(tr1.body.user.ownedScenarios) === '["dotcom","crisis2008","rumarket","commodity"]' && JSON.stringify(tr1.body.user.boughtScenarios) === '["dotcom"]', "«Трейдер»: все сценарии, купленных навсегда нет");
  const tr2 = await post("/api/shop/order", Object.assign(acc("Old", oldTok), { productId: "tm_trader_30", provider: "mock", platform: "web" }));
  check(tr2.status === 200 && Math.abs(tr2.body.user.trader.until - t1.until - 30 * DAY) < 5e3, "повторная покупка продлевает ещё на 30 дней");
  const scTr = await post("/api/shop/order", Object.assign(acc("Old", oldTok), { productId: "tm_scn_commodity", provider: "mock", platform: "web" }));
  check(scTr.status === 200 && JSON.stringify(scTr.body.user.boughtScenarios) === '["dotcom","commodity"]', "при подписке сценарий покупается навсегда");

  // Разбор офлайн-партии: без подписки — один в сутки, та же партия повторно
  // бесплатно; с подпиской — без лимита.
  const an1 = await post("/api/analysis/claim", Object.assign(acc("Bob", bobTok), { game: "off-1" }));
  check(an1.status === 200 && an1.body.ok && an1.body.profile.analysisFreeToday === false, "первый разбор за сутки");
  check((await post("/api/analysis/claim", Object.assign(acc("Bob", bobTok), { game: "off-1" }))).body.again === true, "та же партия — повторно без лимита");
  const an2 = await post("/api/analysis/claim", Object.assign(acc("Bob", bobTok), { game: "off-2" }));
  check(an2.status === 400 && an2.body.code === "analysis_limit", "второй разбор за сутки — только с подпиской");
  const anOld = await Promise.all(["off-1", "off-2", "off-3"].map((g) => post("/api/analysis/claim", Object.assign(acc("Old", oldTok), { game: g }))));
  check(anOld.every((x) => x.status === 200 && x.body.trader === true), "с подпиской разбор без лимита");
  check((await post("/api/analysis/claim", Object.assign(acc("Bob", bobTok), { game: "../x" }))).body.code === "bad_game", "кривой id партии отклонён");
  check((await post("/api/analysis/claim", { username: "Bob", password: "", token: "bad", game: "off-9" })).status === 400, "разбор без входа отклонён");

  // Видео: у Bob лимит 2 (без Премиума), у Old — 4.
  const adStart = () => post("/api/ads/start", Object.assign(acc("Bob", bobTok), { provider: "yandex", adUnit: "demo-rewarded-yandex", platform: "direct" }));
  const s1 = await adStart();
  check(s1.status === 200 && /^[0-9a-f]{32}$/.test(s1.body.nonce) && s1.body.ssv === false && s1.body.rewardPoints === 10 && s1.body.today.cap === 2, "ads/start: билет");
  const rw1 = await post("/api/ads/reward", Object.assign(acc("Bob", bobTok), { provider: "yandex", adUnit: "demo-rewarded-yandex", nonce: s1.body.nonce }));
  check(rw1.status === 200 && rw1.body.status === "granted" && rw1.body.points === 10 && rw1.body.user.points === 10 && rw1.body.user.rating === 0, "видео 1: +10 на баланс, рейтинг 0");
  const rwAgain = await post("/api/ads/reward", Object.assign(acc("Bob", bobTok), { provider: "yandex", nonce: s1.body.nonce }));
  check(rwAgain.status === 400 && rwAgain.body.code === "ads_ticket", "билет гасится один раз");
  const s2 = await adStart();
  const rw2 = await post("/api/ads/reward", Object.assign(acc("Bob", bobTok), { provider: "yandex", nonce: s2.body.nonce }));
  check(rw2.body.status === "granted" && rw2.body.user.points === 20 && rw2.body.today.count === 2, "видео 2: всего +20");
  const s3 = await adStart();
  check(s3.status === 400 && s3.body.code === "ads_cap", "третье видео → ads_cap");
  const sWeb = await post("/api/ads/start", Object.assign(acc("Bob", bobTok), { provider: "yandex", adUnit: "demo-rewarded-yandex", platform: "web" }));
  check(sWeb.status === 400 && sWeb.body.code === "ads_disabled", "на сайте видео недоступно");
  const sAdmob = await post("/api/ads/start", Object.assign(acc("Old", oldTok), { provider: "admob", adUnit: "ca-app-pub-1234567890123456/1234567890", platform: "direct" }));
  check(sAdmob.status === 400 && sAdmob.body.code === "ads_disabled", "AdMob в сборке direct недоступен");
  const sOld = await post("/api/ads/start", Object.assign(acc("Old", oldTok), { provider: "yandex", adUnit: "demo-rewarded-yandex", platform: "rustore" }));
  check(sOld.status === 200 && sOld.body.today.cap === 4, "с Премиумом лимит видео ×2");
  check((await post("/api/ads/reward", Object.assign(acc("Bob", bobTok), { provider: "yandex", nonce: sOld.body.nonce }))).body.code === "ads_ticket", "чужой билет не гасится");
  check((await get("/api/ads/admob-ssv?x=1")).status === 404, "admob-ssv без ADMOB_SSV → 404");

  const entOld = await get("/api/shop/entitlements", bearer(oldTok));
  const eo = entOld.body;
  check(eo.premium === true && eo.entitlements.tm_premium && eo.entitlements.tm_premium.provider === "mock" && !("orderId" in eo.entitlements.tm_premium), "entitlements: Премиум");
  check(eo.purchases.length === 6 && eo.purchases[0].productId === "tm_scn_commodity" && eo.purchases[5].productId === "tm_points_300" && eo.purchases.every((p) => p.test === true), "история покупок: новые первыми");
  check(eo.ads.enabled === true && eo.ads.cap === 4 && eo.ads.today === 0, "entitlements: видео сегодня 0 из 4");

  // Перезапуск: заказы на месте, начисления не повторяются (сверка идемпотентна).
  await restart(MOCK_ENV);
  const after = (await get("/api/shop/entitlements", bearer(oldTok))).body;
  check(after.points === 1600 && after.rating === 500 && after.premium === true, "после перезапуска баланс тот же: " + after.points);
  const bobAfter = (await get("/api/shop/entitlements", bearer(bobTok))).body;
  check(bobAfter.points === 20 && bobAfter.ads.today === 2, "после перезапуска у Bob 20 очков и 2 видео");
  check((await get("/api/shop/order/" + v1.body.orderId, bearer(oldTok))).body.status === "granted", "заказ после перезапуска на месте");
  const v3 = await post("/api/shop/verify", Object.assign(acc("Old", oldTok), { provider: "mock", productId: "tm_points_700", purchaseToken: "tok-1" }));
  check(v3.body.alreadyGranted === true && v3.body.user.points === 1600, "повтор verify после перезапуска — без выдачи");
  const ordersFile = JSON.parse(fs.readFileSync(path.join(DATA, "orders.json"), "utf8"));
  check(ordersFile.v === 1 && Object.keys(ordersFile.grants).length === 9 && !fs.existsSync(path.join(DATA, "orders.json.tmp")), "orders.json: 9 выдач (сценарии и «Трейдер»), без обрывков записи");

  await restart(Object.assign({}, MOCK_ENV, { NODE_ENV: "production" }));
  const catProd = (await get("/api/shop/catalog?platform=direct")).body;
  check(catProd.enabled === true && catProd.providers.length === 0 && catProd.ads.enabled === true, "при NODE_ENV=production mock не включается (реклама остаётся)");
  check(srvLog.some((l) => /PAYMENTS_MOCK=1 игнорируется/.test(l)), "отказ mock записан в лог");

  // --- 4) поддельная ЮKassa ----------------------------------------------------
  console.log("--- 4) поддельная ЮKassa ---");
  fake = await startFakeYookassa();
  // Поддельная ЮKassa, как тестовый магазин, помечает платежи test:true — их
  // засчитывает только YOOKASSA_ALLOW_TEST=on (отказ без него — в конце раздела).
  const YK_ENV = { PAYMENTS_MOCK: "1", TRUST_PROXY: "1", YOOKASSA_SHOP_ID: "123456", YOOKASSA_SECRET_KEY: "test_secret_key",
    YOOKASSA_RETURN_URL: `http://localhost:${PORT}`, YOOKASSA_API_URL: `http://127.0.0.1:${fake.port}`, YOOKASSA_ALLOW_TEST: "on" };
  await restart(YK_ENV);
  check(srvLog.some((l) => /Магазин: ЮKassa — вкл \(тестовые платежи засчитываются\)/.test(l)), "в строке о магазине видно, что тестовые платежи ЮKassa засчитываются");
  const YK_IP = { "X-Real-IP": "185.71.76.5" };
  const r3 = await post("/api/register", { username: "Carol", password: "pass1234" });
  const carolTok = r3.body.sessionToken;
  check(JSON.stringify((await get("/api/shop/catalog?platform=web")).body.providers) === '["yookassa","mock"]', "web: ЮKassa и mock");
  check(JSON.stringify((await get("/api/shop/catalog?platform=rustore")).body.providers) === '["mock"]', "rustore: без ЮKassa (YOOKASSA_IN_RUSTORE=off)");
  check(JSON.stringify((await get("/api/shop/catalog?platform=googleplay")).body.providers) === '["mock"]', "googleplay: ЮKassa никогда");

  const ykOrder = async (productId, platform) => post("/api/shop/order", Object.assign(acc("Carol", carolTok), { productId, provider: "yookassa", platform: platform || "web" }));
  const y1 = await ykOrder("tm_points_300");
  check(y1.status === 200 && y1.body.status === "pending" && /^https:\/\/yoomoney\.ru\//.test(y1.body.confirmationUrl) && y1.body.amount.value === "99.00", "ЮKassa: заказ ждёт оплаты, есть ссылка");
  const req1 = fake.state.requests.find((q) => q.method === "POST");
  check(req1 && req1.headers.authorization === "Basic " + Buffer.from("123456:test_secret_key").toString("base64") && req1.headers["idempotence-key"] === y1.body.orderId, "ЮKassa: Basic shopId:secret и Idempotence-Key = id заказа");
  check(req1 && req1.body.capture === true && req1.body.amount.value === "99.00" && req1.body.amount.currency === "RUB" && !req1.body.receipt, "ЮKassa: сумма из каталога, capture:true, без чека");
  check(req1 && req1.body.confirmation.return_url === `http://localhost:${PORT}/?order=${y1.body.orderId}` && req1.body.metadata.account === "carol" && req1.body.metadata.orderId === y1.body.orderId, "ЮKassa: return_url сайта и metadata");
  const yDirect = await ykOrder("tm_points_700", "direct");
  const reqD = fake.state.requests.filter((q) => q.method === "POST").pop();
  check(yDirect.status === 200 && reqD.body.confirmation.return_url === `http://localhost:${PORT}/pay-return.html?order=${yDirect.body.orderId}`, "приложение: возврат на /pay-return.html");
  const pay1 = [...fake.state.payments.values()].find((p) => p.metadata.orderId === y1.body.orderId);
  check((await get("/api/shop/order/" + y1.body.orderId, bearer(carolTok))).body.status === "pending", "пока не оплачено — pending");

  const hook = (event, id, headers) => post("/api/shop/yookassa/webhook", { type: "notification", event, object: { id, status: "succeeded", paid: true, amount: { value: "99999.00", currency: "RUB" } } }, headers);
  const foreign = await hook("payment.succeeded", pay1.id, { "X-Real-IP": "8.8.8.8" });
  check(foreign.status === 403, "вебхук не с адреса ЮKassa → 403");
  const early = await hook("payment.succeeded", pay1.id, YK_IP);
  const carolEarly = (await get("/api/shop/entitlements", bearer(carolTok))).body;
  check(early.status === 200 && carolEarly.points === 0, "вебхук о неоплаченном платеже ничего не выдаёт (тело не доверяется)");
  Object.assign(pay1, { status: "succeeded", paid: true });
  const h1 = await hook("payment.succeeded", pay1.id, YK_IP);
  const carol1 = (await get("/api/shop/entitlements", bearer(carolTok))).body;
  check(h1.status === 200 && carol1.points === 300 && carol1.rating === 0, "вебхук: платёж проверен у ЮKassa, +300");
  const h2 = await hook("payment.succeeded", pay1.id, YK_IP);
  check(h2.status === 200 && (await get("/api/shop/entitlements", bearer(carolTok))).body.points === 300, "повтор вебхука — без второй выдачи");
  const st = await get("/api/shop/order/" + y1.body.orderId, bearer(carolTok));
  check(st.body.status === "granted" && st.body.test === true && st.body.user.points === 300, "статус заказа: granted");
  check((await hook("payment.succeeded", crypto.randomUUID(), YK_IP)).status === 200, "вебхук о чужом платеже → 200 без выдачи");
  check((await post("/api/shop/yookassa/webhook", { hello: 1 }, YK_IP)).status === 400, "кривое уведомление → 400");

  // Подмена суммы на стороне платежа: оплачен, но не наш — не выдаём.
  const y2 = await ykOrder("tm_points_1600");
  const pay2 = [...fake.state.payments.values()].find((p) => p.metadata.orderId === y2.body.orderId);
  Object.assign(pay2, { status: "succeeded", paid: true, amount: { value: "1.00", currency: "RUB" } });
  await hook("payment.succeeded", pay2.id, YK_IP);
  check((await get("/api/shop/order/" + y2.body.orderId, bearer(carolTok))).body.status === "failed" && (await get("/api/shop/entitlements", bearer(carolTok))).body.points === 300, "сумма не совпала — failed, без выдачи");

  // Опрос статуса сам находит оплату, если вебхук потерялся.
  const payD = [...fake.state.payments.values()].find((p) => p.metadata.orderId === yDirect.body.orderId);
  Object.assign(payD, { status: "succeeded", paid: true });
  await sleep(3100); // не чаще раза в 3 с на заказ
  const stD = await get("/api/shop/order/" + yDirect.body.orderId, bearer(carolTok));
  check(stD.body.status === "granted" && stD.body.user.points === 1000, "GET статуса проверяет платёж в ЮKassa: +700");

  // Отмена.
  const y3 = await ykOrder("tm_set_wallstreet");
  const pay3 = [...fake.state.payments.values()].find((p) => p.metadata.orderId === y3.body.orderId);
  Object.assign(pay3, { status: "canceled", cancellation_details: { party: "yoo_money", reason: "expired_on_confirmation" } });
  await hook("payment.canceled", pay3.id, YK_IP);
  check((await get("/api/shop/order/" + y3.body.orderId, bearer(carolTok))).body.status === "canceled", "отменённый платёж → canceled");

  // Возврат: полный — покупка снимается.
  fake.state.refunds.set("rf-1", { id: "rf-1", status: "succeeded", amount: { value: "99.00", currency: "RUB" }, payment_id: pay1.id });
  const hr = await post("/api/shop/yookassa/webhook", { type: "notification", event: "refund.succeeded", object: { id: "rf-1" } }, YK_IP);
  const carolR = (await get("/api/shop/entitlements", bearer(carolTok))).body;
  check(hr.status === 200 && carolR.points === 700 && carolR.purchases.find((p) => p.orderId === y1.body.orderId).refundedAt, "полный возврат: −300 очков");
  await post("/api/shop/yookassa/webhook", { type: "notification", event: "refund.succeeded", object: { id: "rf-1" } }, YK_IP);
  check((await get("/api/shop/entitlements", bearer(carolTok))).body.points === 700, "повтор вебхука о возврате — без второго списания");
  check((await get("/api/shop/order/" + y1.body.orderId, bearer(carolTok))).body.status === "refunded", "заказ → refunded");

  const carolPoints = async () => (await get("/api/shop/entitlements", bearer(carolTok))).body.points;
  const payOf = (orderId) => [...fake.state.payments.values()].find((p) => p.metadata.orderId === orderId);
  // Деньги вернули раньше, чем узнали об оплате: платёж succeeded, но с refunded_amount.
  const yR = await ykOrder("tm_points_300");
  Object.assign(payOf(yR.body.orderId), { status: "succeeded", paid: true, refunded_amount: { value: "99.00", currency: "RUB" } });
  await hook("payment.succeeded", payOf(yR.body.orderId).id, YK_IP);
  check((await get("/api/shop/order/" + yR.body.orderId, bearer(carolTok))).body.status === "canceled" && await carolPoints() === 700,
    "платёж вернули до выдачи (refunded_amount) — заказ отменён, очки не начислены");

  // Два частичных возврата на всю сумму — покупка снимается.
  const yP = await ykOrder("tm_points_300");
  const payP = payOf(yP.body.orderId);
  Object.assign(payP, { status: "succeeded", paid: true });
  await hook("payment.succeeded", payP.id, YK_IP);
  check(await carolPoints() === 1000, "оплата ещё одного пакета: +300");
  const refundHook = (id) => post("/api/shop/yookassa/webhook", { type: "notification", event: "refund.succeeded", object: { id } }, YK_IP);
  fake.state.refunds.set("rf-2", { id: "rf-2", status: "succeeded", amount: { value: "50.00", currency: "RUB" }, payment_id: payP.id });
  payP.refunded_amount = { value: "50.00", currency: "RUB" };
  await refundHook("rf-2");
  check(await carolPoints() === 1000 && (await get("/api/shop/order/" + yP.body.orderId, bearer(carolTok))).body.status === "granted", "частичный возврат 50 из 99 ₽ — покупка остаётся");
  fake.state.refunds.set("rf-3", { id: "rf-3", status: "succeeded", amount: { value: "49.00", currency: "RUB" }, payment_id: payP.id });
  payP.refunded_amount = { value: "99.00", currency: "RUB" };
  await refundHook("rf-3");
  check(await carolPoints() === 700 && (await get("/api/shop/order/" + yP.body.orderId, bearer(carolTok))).body.status === "refunded", "второй частичный возврат на остаток — всего 99 ₽, покупка снята (−300)");

  // Тестовый платёж без YOOKASSA_ALLOW_TEST — не засчитывается (ключи тестового магазина на боевом сервере).
  await restart(Object.assign({}, YK_ENV, { YOOKASSA_ALLOW_TEST: "" }));
  const yT = await ykOrder("tm_points_300");
  Object.assign(payOf(yT.body.orderId), { status: "succeeded", paid: true });
  await hook("payment.succeeded", payOf(yT.body.orderId).id, YK_IP);
  check((await get("/api/shop/order/" + yT.body.orderId, bearer(carolTok))).body.status === "failed" && await carolPoints() === 700
    && srvLog.some((l) => /не засчитан.*YOOKASSA_ALLOW_TEST=on/.test(l)), "тестовый платёж ЮKassa без YOOKASSA_ALLOW_TEST — не выдан, причина в журнале");

  // ЮKassa не отвечает: один повтор с тем же ключом, затем provider_error.
  fake.state.failCreates = 2;
  const yFail = await ykOrder("tm_points_300");
  check(yFail.status === 400 && yFail.body.code === "provider_error", "ЮKassa недоступна → provider_error");
  fake.state.failCreates = 1;
  const yRetry = await ykOrder("tm_points_300");
  check(yRetry.status === 200 && yRetry.body.status === "pending", "одна ошибка 5xx — повтор с тем же ключом проходит");
  // ЮKassa недоступна при вебхуке → 500 (повторит сама).
  fake.state.payments.clear();
  fake.server.close();
  fake.server.closeAllConnections();
  const h500 = await hook("payment.succeeded", pay1.id, YK_IP);
  check(h500.status === 500, "ЮKassa недоступна при вебхуке → 500");
}

const watchdog = setTimeout(() => {
  console.log(`FAIL тест магазина не уложился в ${TIMEOUT_MS / 1000} с`);
  failures++;
  finish(2);
}, TIMEOUT_MS);

let finishing = false;
async function finish(code) {
  if (finishing) return;
  finishing = true;
  clearTimeout(watchdog);
  await stopServer();
  if (fake) { try { fake.server.close(); } catch (e) {} }
  for (const dir of [DATA, PURE]) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (e) { console.log("не удалось удалить " + dir + ": " + e.message); }
  }
  if ((code || failures) && !VERBOSE && srvLog.length) console.log("\n--- вывод сервера ---\n" + srvLog.slice(-80).join("\n"));
  console.log(failures ? `\n${failures} FAILURE(S)` : code ? "\nABORTED" : "\nALL PASS");
  process.exit(code || (failures ? 1 : 0));
}
process.on("exit", () => { if (srv && srv.exitCode === null && srv.signalCode === null) { try { srv.kill(); } catch (e) {} } });

main().then(() => finish(0), (e) => { console.log("FAIL " + (e && e.stack || e)); failures++; finish(2); });
