// ---------------------------------------------------------------------
// Магазин: заказы (DATA_DIR/orders.json) и платёжные провайдеры — ЮKassa
// (сайт и APK без магазина), RuStore Pay и Google Play Billing (сборки для
// магазинов) и тестовый mock. Только node:* и глобальный fetch, без SDK.
// Подробности — docs/MONETIZATION-SPEC.md, разделы 5–7.
//
// Главные правила:
// - без настроек в окружении все провайдеры выключены: каталог отвечает
//   {enabled:false}, остальные маршруты — 404, к провайдерам ни одного запроса;
// - клиенту не доверяем: цену ЮKassa берём из products.js, а выдаём товар только
//   после повторного запроса к API провайдера (тело вебхука — лишь подсказка);
// - один платёж выдаётся ровно один раз: grants[grantKey] сначала пишется в
//   orders.json, потом начисляется в users.json (grantOrder), а сверка при
//   старте дозачисляет то, что не успело начислиться при падении процесса.
// ---------------------------------------------------------------------
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const users = require("./users.js");
const Products = require("./products.js");
// ads.js сам подключает этот модуль (общие настройки, учёт колбэков AdMob),
// поэтому здесь он берётся лениво — внутри функций, а не при загрузке.
function Ads() { return require("./ads.js"); }

// ---------------------------------------------------------------------
// Настройки из окружения (/etc/birzha.env). Неверное значение выключает
// провайдер, которому оно нужно; причина пишется в лог при старте (init).
// ---------------------------------------------------------------------
const problems = [];
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const FLAG_ON = new Set(["1", "on", "true", "yes"]);
const FLAG_OFF = new Set(["0", "off", "false", "no"]);

// Флаг: 1/on/true/yes и 0/off/false/no; пусто — def; иное — null (ошибка настройки).
function envFlag(name, def) {
  const raw = String(process.env[name] == null ? "" : process.env[name]).trim().toLowerCase();
  if (!raw) return def;
  if (FLAG_ON.has(raw)) return true;
  if (FLAG_OFF.has(raw)) return false;
  return null;
}
function envStr(name) { return String(process.env[name] == null ? "" : process.env[name]).trim(); }
// Целое в пределах [min, max]: пусто — def, иное — null (ошибка настройки).
function envInt(name, def, min, max) {
  const raw = envStr(name);
  if (!raw) return def;
  if (!/^-?\d{1,9}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

function readMock() {
  const flag = envFlag("PAYMENTS_MOCK", false);
  if (flag === null) { problems.push("PAYMENTS_MOCK: ожидается 1 или 0 — тестовая оплата выключена."); return { on: false }; }
  if (!flag) return { on: false };
  if (process.env.NODE_ENV === "production") {
    // Тестовая оплата выдаёт товары бесплатно любому вошедшему игроку.
    if (envFlag("PAYMENTS_MOCK_FORCE", false) === true) return { on: true, forced: true };
    return { on: false, refused: true };
  }
  return { on: true };
}

function readYookassa(mockOn) {
  const shopId = envStr("YOOKASSA_SHOP_ID");
  const secretKey = envStr("YOOKASSA_SECRET_KEY");
  const ret = envStr("YOOKASSA_RETURN_URL");
  if (!shopId && !secretKey && !ret) return null;
  const off = (why) => { problems.push("ЮKassa выключена: " + why); return null; };
  if (!shopId || !secretKey || !ret) return off("нужны все три — YOOKASSA_SHOP_ID, YOOKASSA_SECRET_KEY, YOOKASSA_RETURN_URL.");
  if (/[\s:]/.test(shopId)) return off("YOOKASSA_SHOP_ID с пробелом или двоеточием.");
  if (/\s/.test(secretKey)) return off("YOOKASSA_SECRET_KEY с пробелами.");
  let u = null;
  try { u = new URL(ret); } catch (e) {}
  if (!u) return off("YOOKASSA_RETURN_URL — не адрес.");
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return off("YOOKASSA_RETURN_URL должен начинаться с https:// (http:// — только для localhost).");
  if (u.pathname !== "/" || u.search || u.hash) problems.push("YOOKASSA_RETURN_URL: путь отброшен, используется " + u.origin + ".");
  const receipts = envFlag("YOOKASSA_RECEIPTS", false);
  if (receipts === null) return off("YOOKASSA_RECEIPTS — ожидается on или off.");
  const vatCode = envInt("YOOKASSA_VAT_CODE", 1, 1, 12);
  if (vatCode === null) return off("YOOKASSA_VAT_CODE — число от 1 до 12.");
  const taxSystem = envInt("YOOKASSA_TAX_SYSTEM", 0, 1, 6);
  if (taxSystem === null) return off("YOOKASSA_TAX_SYSTEM — число от 1 до 6.");
  const paymentSubject = envStr("YOOKASSA_PAYMENT_SUBJECT") || "service";
  if (!["service", "intellectual_activity", "another"].includes(paymentSubject)) return off("YOOKASSA_PAYMENT_SUBJECT — service, intellectual_activity или another.");
  const inRustore = envFlag("YOOKASSA_IN_RUSTORE", false);
  if (inRustore === null) return off("YOOKASSA_IN_RUSTORE — ожидается on или off.");
  const ipCheck = envFlag("YOOKASSA_WEBHOOK_IP_CHECK", TRUST_PROXY);
  if (ipCheck === null) return off("YOOKASSA_WEBHOOK_IP_CHECK — ожидается on или off.");
  if (ipCheck && !TRUST_PROXY) problems.push("YOOKASSA_WEBHOOK_IP_CHECK=on без TRUST_PROXY=1: за nginx адрес ЮKassa не виден, вебхуки будут отклоняться.");
  // Без проверки адреса любой может слать выдуманные уведомления: товар они не
  // выдадут (всё перепроверяется в API ЮKassa), но каждое — запрос с ключом магазина.
  if (!ipCheck) problems.push("ЮKassa: вебхуки принимаются с любого адреса (YOOKASSA_WEBHOOK_IP_CHECK=off). За nginx задайте TRUST_PROXY=1 — проверка адресов ЮKassa включится сама.");
  // Платежи тестового магазина (test:true) выдаются только с этим флагом: иначе
  // ключи тестового магазина на боевом сервере раздавали бы товары за тестовые карты.
  const allowTest = envFlag("YOOKASSA_ALLOW_TEST", false);
  if (allowTest === null) return off("YOOKASSA_ALLOW_TEST — ожидается on или off.");
  let apiUrl = "https://api.yookassa.ru/v3";
  const custom = envStr("YOOKASSA_API_URL");
  if (custom) {
    // Подмена адреса API — только для тестов: иначе утёкшая настройка увела бы
    // ключ магазина на чужой сервер.
    if (mockOn) apiUrl = custom.replace(/\/+$/, "");
    else problems.push("YOOKASSA_API_URL учитывается только при PAYMENTS_MOCK=1 — игнорирую.");
  }
  return { shopId, secretKey, origin: u.origin, receipts, vatCode, taxSystem, paymentSubject, inRustore, ipCheck, allowTest, apiUrl };
}

// Ключ RuStore — base64 (PKCS#8 DER) одной строкой, как выдала консоль. Заголовки
// PEM и переводы строк (если ключ вставили «как файл») просто отбрасываем.
function parseRustoreKey(text) {
  const b64 = String(text || "").replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return crypto.createPrivateKey({ key: Buffer.from(b64, "base64"), format: "der", type: "pkcs8" });
}
function readRustore() {
  const keyId = envStr("RUSTORE_KEY_ID");
  const keyRaw = envStr("RUSTORE_PRIVATE_KEY");
  const keyFile = envStr("RUSTORE_PRIVATE_KEY_FILE");
  const appId = envStr("RUSTORE_APP_ID");
  if (!keyId && !keyRaw && !keyFile && !appId) return null;
  const off = (why) => { problems.push("RuStore выключен: " + why); return null; };
  if (!keyId || !(keyRaw || keyFile) || !appId) return off("нужны RUSTORE_KEY_ID, RUSTORE_PRIVATE_KEY (или RUSTORE_PRIVATE_KEY_FILE) и RUSTORE_APP_ID.");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(keyId)) return off("RUSTORE_KEY_ID — неверный формат.");
  if (!/^\d{1,20}$/.test(appId)) return off("RUSTORE_APP_ID — должен быть числом.");
  let text = keyRaw;
  if (!text) {
    try { text = fs.readFileSync(keyFile, "utf8"); }
    catch (e) { return off("не читается RUSTORE_PRIVATE_KEY_FILE (" + (e.code || "ошибка") + ")."); }
  }
  let privateKey;
  try { privateKey = parseRustoreKey(text); }
  catch (e) { return off("приватный ключ не разбирается — нужен base64 из RuStore Консоли (PKCS#8)."); }
  const allowSandbox = envFlag("RUSTORE_ALLOW_SANDBOX", false);
  if (allowSandbox === null) return off("RUSTORE_ALLOW_SANDBOX — ожидается on или off.");
  return { keyId, privateKey, appId, allowSandbox };
}

function readGoogle() {
  const pkg = envStr("GOOGLE_PLAY_PACKAGE");
  const file = envStr("GOOGLE_PLAY_SERVICE_ACCOUNT");
  if (!pkg && !file) return null;
  const off = (why) => { problems.push("Google Play выключен: " + why); return null; };
  if (!pkg || !file) return off("нужны GOOGLE_PLAY_PACKAGE и GOOGLE_PLAY_SERVICE_ACCOUNT (путь к JSON-ключу).");
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(pkg)) return off("GOOGLE_PLAY_PACKAGE — неверное имя пакета.");
  let json = null;
  try { json = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { return off("не читается JSON сервисного аккаунта (" + (e.code || "неверный JSON") + ")."); }
  if (!json || typeof json.client_email !== "string" || typeof json.private_key !== "string") return off("в JSON нет client_email или private_key.");
  let privateKey;
  try { privateKey = crypto.createPrivateKey(json.private_key); }
  catch (e) { return off("private_key в JSON не разбирается."); }
  const allowTest = envFlag("GOOGLE_PLAY_ALLOW_TEST", false);
  if (allowTest === null) return off("GOOGLE_PLAY_ALLOW_TEST — ожидается on или off.");
  return { pkg, clientEmail: json.client_email, privateKey, allowTest };
}

// Подвал магазина: только заданные поля, ссылки — только https.
function readLegal() {
  const legal = {};
  const seller = envStr("SHOP_SELLER");
  if (seller) legal.seller = seller.slice(0, 300);
  for (const [field, name] of [["offerUrl", "SHOP_OFFER_URL"], ["privacyUrl", "SHOP_PRIVACY_URL"]]) {
    const v = envStr(name);
    if (!v) continue;
    let u = null;
    try { u = new URL(v); } catch (e) {}
    if (u && u.protocol === "https:") legal[field] = u.href;
    else problems.push(name + ": нужна ссылка https:// — в магазине не показываю.");
  }
  return legal;
}

const MOCK = readMock();
const CFG = {
  mock: MOCK.on,
  yookassa: readYookassa(MOCK.on),
  rustore: readRustore(),
  googleplay: readGoogle(),
  legal: readLegal(),
};

// ---------------------------------------------------------------------
// Платформы и провайдеры (раздел 6.3 спецификации). ЮKassa никогда не
// показывается в сборке для Google Play (правила Google Play), а в сборке
// для RuStore — только при YOOKASSA_IN_RUSTORE=on.
// ---------------------------------------------------------------------
const PLATFORMS = ["web", "direct", "rustore", "googleplay"];
function normPlatform(p) { return PLATFORMS.includes(p) ? p : "web"; }
function shopEnabled() { return !!(CFG.yookassa || CFG.rustore || CFG.googleplay || CFG.mock); }
function providersFor(platform) {
  platform = normPlatform(platform);
  const list = [];
  if (platform === "rustore" && CFG.rustore) list.push("rustore");
  if (platform === "googleplay" && CFG.googleplay) list.push("googleplay");
  if (CFG.yookassa && platform !== "googleplay" && (platform !== "rustore" || CFG.yookassa.inRustore)) list.push("yookassa");
  if (CFG.mock) list.push("mock");
  return list;
}

// ---------------------------------------------------------------------
// Ошибки API: {error: текст для игрока, code}. httpStatus снимает
// handleApiPostAsync в server.js (400 — ошибка действия, 404 — выключено или
// не найдено, 429 — лимит).
// ---------------------------------------------------------------------
const ERRORS = {
  shop_disabled: [404, "Магазин отключён на этом сервере."],
  provider_disabled: [400, "Этот способ оплаты недоступен."],
  unknown_product: [400, "Товар не найден."],
  already_owned: [400, "Уже куплено."],
  email_required: [400, "Укажите email — на него придёт чек."],
  provider_error: [400, "Платёжная система не ответила — попробуйте ещё раз через минуту."],
  not_found: [404, "Заказ не найден."],
  invalid_purchase: [400, "Магазин не подтвердил покупку."],
  other_account: [400, "Покупка привязана к другому аккаунту."],
  rate_limited: [429, "Слишком много запросов — подождите немного."],
  too_many_open: [429, "Слишком много незавершённых заказов — завершите оплату или попробуйте через час."],
  auth_required: [400, "Нужен вход в аккаунт."],
  session: [400, "Сессия недействительна — войдите заново."],
  ads_disabled: [404, "Видео с наградой недоступны."],
  ads_cap: [400, "На сегодня видео закончились — приходите завтра."],
  ads_ticket: [400, "Просмотр не засчитан — попробуйте ещё раз."],
};
function fail(code, httpStatus) {
  const [status, error] = ERRORS[code] || [400, "Ошибка запроса."];
  const r = { error, code, httpStatus: httpStatus || status };
  if (code === "session") r.sessionExpired = true;
  return r;
}

// Помощники server.js (sendJson, readJsonBody) приходят в init — без дублей.
const H = { sendJson: null, readJsonBody: null };
function reply(res, status, obj) { H.sendJson(res, status, obj, { "Cache-Control": "no-store" }); }
function replyFail(res, code) {
  const r = fail(code);
  const status = r.httpStatus;
  delete r.httpStatus;
  reply(res, status, r);
}

// Вход для GET: Authorization: Bearer <токен сессии>. Токен в адресе — никогда.
function bearerAccount(req) {
  const h = String(req.headers.authorization || "").trim();
  if (!h) return { fail: "auth_required" };
  const m = /^Bearer\s+([A-Za-z0-9]{1,200})$/i.exec(h);
  const acc = m ? users.accountByToken(m[1]) : null;
  return acc ? { acc, token: m[1] } : { fail: "session" };
}

function own(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined; }
function sha256(s) { return crypto.createHash("sha256").update(String(s)).digest("hex"); }
function short(id) { return String(id || "").slice(0, 8); }
const UUID_RE = /^[0-9a-f-]{36}$/;

// ---------------------------------------------------------------------
// Хранилище заказов: DATA_DIR/orders.json. Пишется как users.json — через
// временный файл и rename. Повреждённый файл — не запускаемся: в нём учёт
// оплаченных покупок, начинать с пустого нельзя.
// ---------------------------------------------------------------------
const ORDERS_FILE = path.join(users.DATA_DIR, "orders.json");
function emptyStore() { return { v: 1, orders: {}, grants: {}, adTx: {}, meta: { lastVoidedPollAt: 0 } }; }
function loadOrders() {
  let raw;
  try { raw = fs.readFileSync(ORDERS_FILE, "utf8"); }
  catch (e) { return emptyStore(); } // файла ещё нет — заказов не было
  let data;
  try { data = JSON.parse(raw); }
  catch (e) {
    throw new Error(`${ORDERS_FILE} повреждён (${e.message}). Восстановите его из резервной копии ` +
      `(${path.join(users.DATA_DIR, "backups")}): в нём учёт оплаченных покупок, удалять его нельзя.`);
  }
  const s = emptyStore();
  if (data && typeof data === "object") {
    for (const k of ["orders", "grants", "adTx"]) if (data[k] && typeof data[k] === "object" && !Array.isArray(data[k])) s[k] = data[k];
    if (data.meta && typeof data.meta === "object") Object.assign(s.meta, data.meta);
  }
  return s;
}
const store = loadOrders();
// Файл переписывается целиком и синхронно — поэтому без отступов, а число
// незавершённых заказов ограничено (см. createOrder и cleanupOrders).
function saveOrders() {
  fs.mkdirSync(users.DATA_DIR, { recursive: true });
  const tmp = ORDERS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store), "utf8");
  fs.renameSync(tmp, ORDERS_FILE);
}

// Индексы в памяти: provider:ref → заказ и заказы аккаунта (лимит в час).
const byRef = new Map();
const byUser = new Map();
function indexOrder(o) {
  if (o.ref) byRef.set(o.provider + ":" + o.ref, o.id);
  let list = byUser.get(o.user);
  if (!list) byUser.set(o.user, (list = []));
  if (!list.includes(o.id)) list.push(o.id);
}
function unindexOrder(o) {
  if (o.ref && byRef.get(o.provider + ":" + o.ref) === o.id) byRef.delete(o.provider + ":" + o.ref);
  const list = byUser.get(o.user);
  if (list) {
    const i = list.indexOf(o.id);
    if (i >= 0) list.splice(i, 1);
    if (!list.length) byUser.delete(o.user);
  }
}
for (const o of Object.values(store.orders)) if (o && o.id && o.user) indexOrder(o);

function newOrder(fields) {
  const now = Date.now();
  const order = Object.assign({
    id: crypto.randomUUID(), user: "", productId: "", provider: "", platform: "web", status: "created",
    amount: null, ref: null, grantKey: null, test: false, confirmationUrl: null,
    createdAt: now, updatedAt: now, grantedAt: null, refundedAt: null, lastCheckAt: 0, needsFinish: false, note: null,
  }, fields);
  store.orders[order.id] = order;
  indexOrder(order);
  return order;
}
function setOrder(order, fields) {
  Object.assign(order, fields, { updatedAt: Date.now() });
  if (order.ref) indexOrder(order);
}

// Идемпотентная выдача — единственный путь выдачи. Вызывать СИНХРОННО, после
// последнего await проверки у провайдера: между проверкой grants и записью
// ничего не выполняется, поэтому повтор вебхука, двойной клик или опрос статуса
// в ту же секунду не выдадут товар дважды.
function grantOrder(order, grantKey, extra) {
  const prev = own(store.grants, grantKey);
  if (prev) return { already: true, orderId: prev };
  // Заказ уже выдан по другому платежу — второй к нему не привязываем.
  if (order.status === "granted" || order.status === "refunded") return { already: true, orderId: order.id };
  const before = Object.assign({}, order);
  store.grants[grantKey] = order.id;
  const now = Date.now();
  Object.assign(order, extra || {}, { status: "granted", grantKey, grantedAt: now, updatedAt: now });
  try {
    saveOrders();                      // 1) сначала фиксируем «выдано» в orders.json
  } catch (e) {
    // Не записалось (кончилось место) — откатываем память, иначе повтор ответил
    // бы «уже выдано», хотя на аккаунт ничего не начислено.
    delete store.grants[grantKey];
    for (const k of Object.keys(order)) if (!(k in before)) delete order[k];
    Object.assign(order, before);
    throw e;
  }
  if (order.ref) indexOrder(order);
  const r = users.applyOrder(order);   // 2) потом начисляем (идемпотентно по users.purchases)
  if (r && r.error) console.error(`Магазин: заказ ${short(order.id)} выдан, но не начислен (${r.error}) — повторю при следующем запуске.`);
  else console.log(`Магазин: выдан заказ ${short(order.id)} — ${order.productId} (${order.provider}${order.test ? ", тест" : ""}).`);
  return { already: false, applied: !!(r && r.applied), profile: r && r.profile };
}

// Возврат денег: заказ → refunded, потом снимаем покупку с аккаунта.
function refundOrder(order, note) {
  if (!order || order.status !== "granted") return false;
  setOrder(order, { status: "refunded", refundedAt: Date.now(), note: note || null });
  saveOrders();
  users.revokeOrder(order);
  console.log(`Магазин: возврат по заказу ${short(order.id)} (${order.productId}, ${order.provider}) — покупка снята с аккаунта.`);
  return true;
}

// Сверка при старте: дозачислить выданное и снять возвращённое (обе функции
// users.js сами пропускают уже применённое).
function reconcile() {
  let applied = 0, revoked = 0;
  for (const o of Object.values(store.orders)) {
    if (!o || !o.id) continue;
    if (o.status === "granted") {
      const r = users.applyOrder(o);
      if (r && r.applied) applied++;
      else if (r && r.error) console.error(`Магазин: заказ ${short(o.id)} не начислен: ${r.error}`);
    } else if (o.status === "refunded") {
      const r = users.revokeOrder(o);
      if (r && r.revoked) revoked++;
    }
  }
  if (applied || revoked) console.log(`Магазин: сверка заказов — дозачислено ${applied}, снято возвратов ${revoked}.`);
}

// Колбэки AdMob (ads.js): transaction_id засчитывается один раз, хранится 7 дней.
function adTxSeen(key) { return !!own(store.adTx, key); }
function noteAdTx(key) { store.adTx[key] = Date.now(); saveOrders(); }

// ---------------------------------------------------------------------
// HTTP к провайдерам: глобальный fetch с таймаутом, ответ — {status, data}.
// ---------------------------------------------------------------------
async function httpJson(url, opts, timeoutMs) {
  const r = await fetch(url, Object.assign({}, opts, { signal: AbortSignal.timeout(timeoutMs || 15000) }));
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) {}
  return { status: r.status, data };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------
// ЮKassa (API v3): redirect-оплата, capture:true. Источник правды —
// GET /payments/{id}; вебхук лишь подсказывает, какой платёж проверить.
// ---------------------------------------------------------------------
function ykHeaders(idemKey) {
  const y = CFG.yookassa;
  const h = { Authorization: "Basic " + Buffer.from(y.shopId + ":" + y.secretKey).toString("base64"), "Content-Type": "application/json" };
  if (idemKey) h["Idempotence-Key"] = idemKey;
  return h;
}
function ykGet(kind, id) {
  return httpJson(CFG.yookassa.apiUrl + "/" + kind + "/" + encodeURIComponent(id), { headers: ykHeaders() }, 15000);
}
// Создание платежа: сетевая ошибка, 5xx или 202 («ещё обрабатывается») — один
// повтор с тем же Idempotence-Key (ЮKassa вернёт тот же платёж, а не второй).
async function ykCreatePayment(body, idemKey) {
  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await sleep(1000);
    let r;
    try {
      r = await httpJson(CFG.yookassa.apiUrl + "/payments", { method: "POST", headers: ykHeaders(idemKey), body: JSON.stringify(body) }, 35000);
    } catch (e) { lastErr = e.message || String(e); continue; }
    if (r.status === 200 && r.data && r.data.id) return r.data;
    lastErr = `HTTP ${r.status}${r.data && r.data.code ? " " + r.data.code : ""}${r.data && r.data.description ? ": " + r.data.description : ""}`;
    if (r.status < 500 && r.status !== 202) break; // 4xx — повтор не поможет
  }
  throw new Error(lastErr);
}

// Сколько по платежу уже вернули (копейки). После возврата платёж остаётся
// succeeded и paid:true — меняется только refunded_amount.
function ykRefundedCents(p) {
  return p && p.refunded_amount && p.refunded_amount.value != null ? (rubCents(p.refunded_amount.value) || 0) : 0;
}
function ykPaymentOk(p, order) {
  return !!p && p.status === "succeeded" && p.paid === true
    && !!p.amount && p.amount.currency === "RUB" && !!order.amount && p.amount.value === order.amount.value
    && !!p.metadata && p.metadata.orderId === order.id && p.metadata.account === order.user
    && ykRefundedCents(p) === 0;
}

// Итог платежа → заказ. Вызывать сразу после ответа ЮKassa, без await.
// failed без ref — платёж не удалось создать (обрыв связи): если ЮKassa всё же
// его создала и он оплачен, выдаём — деньги списаны.
function applyYkPayment(order, p) {
  if (!p || typeof p !== "object" || typeof p.id !== "string") return;
  const open = order.status === "created" || order.status === "pending" || (order.status === "failed" && !order.ref);
  if (!open) return;
  if (order.ref && p.id !== order.ref) {
    console.error(`Магазин: платёж ЮKassa ${p.id} не совпадает с платежом заказа ${short(order.id)} — пропускаю.`);
    return;
  }
  if (p.test === true) order.test = true;
  if (p.status === "succeeded") {
    // Деньги вернули раньше, чем заказ выдали (вебхук об оплате не дошёл, а
    // владелец уже оформил возврат): выдавать нечего, иначе товар остался бы
    // навсегда — следующего события о возврате не будет.
    if (ykRefundedCents(p) > 0) {
      setOrder(order, { status: "canceled", ref: p.id, note: `платёж возвращён до выдачи (${String(p.refunded_amount.value).slice(0, 20)} ₽)` });
      saveOrders();
      console.warn(`Магазин: платёж ЮKassa ${p.id} по заказу ${short(order.id)} уже возвращён — товар не выдаю.`);
      return;
    }
    if (!ykPaymentOk(p, order)) {
      setOrder(order, { status: "failed", ref: p.id, note: "платёж не совпал с заказом (сумма, валюта или аккаунт)" });
      saveOrders();
      console.error(`Магазин: ВНИМАНИЕ! Платёж ЮKassa ${p.id} оплачен, но не совпал с заказом ${short(order.id)} — товар НЕ выдан, проверьте вручную.`);
      return;
    }
    if (p.test === true && !(CFG.yookassa && CFG.yookassa.allowTest)) {
      setOrder(order, { status: "failed", ref: p.id, note: "тестовый платёж ЮKassa при YOOKASSA_ALLOW_TEST=off" });
      saveOrders();
      console.warn(`Магазин: тестовый платёж ЮKassa ${p.id} (заказ ${short(order.id)}) не засчитан. На время проверки с тестовым магазином включите YOOKASSA_ALLOW_TEST=on, на боевых ключах — выключите.`);
      return;
    }
    grantOrder(order, "yk:" + p.id, { ref: p.id, test: p.test === true || !!order.test });
    return;
  }
  if (p.status === "canceled") {
    const reason = p.cancellation_details && typeof p.cancellation_details.reason === "string" ? p.cancellation_details.reason.slice(0, 60) : "canceled";
    setOrder(order, { status: "canceled", ref: p.id, note: reason });
    saveOrders();
    return;
  }
  if (p.status === "waiting_for_capture") console.warn(`Магазин: платёж ЮKassa ${p.id} ждёт подтверждения, хотя создан с capture:true — проверьте в личном кабинете.`);
}

async function ykRefreshOrder(order) {
  order.lastCheckAt = Date.now();
  const r = await ykGet("payments", order.ref);
  if (r.status !== 200 || !r.data) throw new Error("ЮKassa GET /payments: HTTP " + r.status);
  applyYkPayment(order, r.data);
}

function rubCents(v) { return Math.round(parseFloat(v) * 100); }
// Сумма ({value, currency}) покрывает весь заказ.
function ykCoversOrder(amount, order) {
  return !!amount && !!order.amount && amount.currency === order.amount.currency
    && rubCents(amount.value) >= rubCents(order.amount.value);
}
// refundedTotal — сколько всего вернули по платежу (refunded_amount из
// GET /payments): несколько частичных возвратов на всю сумму — тоже полный возврат.
function applyYkRefund(order, refund, refundedTotal) {
  if (!refund || refund.status !== "succeeded") return;
  if (order.status !== "granted") {
    if (order.status !== "refunded") console.warn(`Магазин: возврат ЮKassa ${refund.id} по невыданному заказу ${short(order.id)} — пропускаю.`);
    return;
  }
  const full = ykCoversOrder(refund.amount, order) || ykCoversOrder(refundedTotal, order);
  if (!full) {
    setOrder(order, { note: `частичный возврат ${refund.amount && refund.amount.value} ₽ (${refund.id})` });
    saveOrders();
    console.warn(`Магазин: частичный возврат по заказу ${short(order.id)} — покупку не снимаю, решите вручную.`);
    return;
  }
  refundOrder(order, "возврат ЮKassa " + refund.id);
}

// Адреса, с которых ЮKassa шлёт уведомления (yookassa.ru/developers/using-api/webhooks).
const YK_NETS = new net.BlockList();
[["185.71.76.0", 27], ["185.71.77.0", 27], ["77.75.153.0", 25], ["77.75.154.128", 25]].forEach(([a, p]) => YK_NETS.addSubnet(a, p, "ipv4"));
YK_NETS.addAddress("77.75.156.11", "ipv4");
YK_NETS.addAddress("77.75.156.35", "ipv4");
YK_NETS.addSubnet("2a02:5180::", 32, "ipv6");
function ykIpAllowed(ip) {
  ip = String(ip || "").trim();
  if (ip.toLowerCase().startsWith("::ffff:") && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
  const type = net.isIPv4(ip) ? "ipv4" : net.isIPv6(ip) ? "ipv6" : null;
  return !!type && YK_NETS.check(ip, type);
}

// ---------------------------------------------------------------------
// RuStore Pay: проверка счёта через API RuStore (токен — подпись ключом API).
// ---------------------------------------------------------------------
const RUSTORE_API = "https://public-api.rustore.ru/public";
let rsToken = null; // {jwe, exp}
async function rustoreJwe() {
  if (rsToken && Date.now() < rsToken.exp) return rsToken.jwe;
  const c = CFG.rustore;
  const timestamp = new Date().toISOString().replace("Z", "+00:00");
  const signature = crypto.sign("sha512", Buffer.from(c.keyId + timestamp), c.privateKey).toString("base64");
  const r = await httpJson(RUSTORE_API + "/auth/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keyId: c.keyId, timestamp, signature }) }, 15000);
  const b = r.data && r.data.body;
  if (r.status !== 200 || !b || !b.jwe) throw new Error(`RuStore auth: HTTP ${r.status}${r.data && r.data.message ? " " + r.data.message : ""}`);
  rsToken = { jwe: b.jwe, exp: Date.now() + Math.max(30, (Number(b.ttl) || 900) - 60) * 1000 };
  return rsToken.jwe;
}
// {body, test} | {notFound:true}; сетевые ошибки и прочие ответы — исключение.
async function rustoreInvoice(invoiceId) {
  const get = async (sandbox) => {
    const url = `${RUSTORE_API}/${sandbox ? "sandbox/" : ""}v2/invoices/${encodeURIComponent(invoiceId)}`;
    let r = await httpJson(url, { headers: { "Public-Token": await rustoreJwe() } }, 15000);
    // Токен отозван или истёк раньше срока — получаем новый и повторяем один раз.
    if (r.status === 401 || (r.data && r.data.code === "ERROR" && /token/i.test(String(r.data.message || "")))) {
      rsToken = null;
      r = await httpJson(url, { headers: { "Public-Token": await rustoreJwe() } }, 15000);
    }
    return r;
  };
  const notFound = (r) => r.status === 404 || !!(r.data && r.data.code === "NOT_FOUND");
  let r = await get(false);
  let test = false;
  if (notFound(r) && CFG.rustore.allowSandbox) { r = await get(true); test = true; }
  if (notFound(r)) return { notFound: true };
  if (r.status !== 200 || !r.data || r.data.code !== "OK" || !r.data.body) throw new Error(`RuStore invoice: HTTP ${r.status}${r.data && r.data.code ? " " + r.data.code : ""}`);
  return { body: r.data.body, test };
}
// b — body ответа /v2/invoices/{id}. appId по умолчанию — из настроек.
function rustoreInvoiceOk(b, order, key, appId) {
  const want = appId != null ? String(appId) : CFG.rustore ? CFG.rustore.appId : envStr("RUSTORE_APP_ID");
  const product = b && b.order ? Products.byStoreId("rustore", b.order.itemCode) : null;
  const uid = users.billingUserId(key);
  return !!product && product.id === order.productId
    && String(b.appId) === want
    && String(b.invoiceStatus).toUpperCase() === "CONFIRMED"   // в примерах документации статус строчными
    && !!uid && b.appUserId === uid;
}

// RuStore не присылает уведомлений о возврате, а после возврата покупка
// пропадает из списка оплаченных в приложении — сама она на проверку не придёт.
// Поэтому выданные счета перепроверяем: при повторной проверке той же покупки
// (не чаще раза в 10 минут) и фоновой задачей (pollRustoreRefunds).
const RS_RECHECK_MS = 10 * 60e3;
async function rustoreRecheck(order, now) {
  if (!order || order.provider !== "rustore" || order.status !== "granted" || !order.ref) return;
  order.lastCheckAt = now || Date.now();
  let inv;
  try { inv = await rustoreInvoice(order.ref); }
  catch (e) { console.warn(`Магазин: перепроверка счёта RuStore ${String(order.ref).slice(0, 12)}: ${e.message}`); return; }
  if (inv.notFound) return;
  const status = String(inv.body.invoiceStatus || "").toUpperCase();
  if (status === "REFUNDED" || status === "REVERSED") refundOrder(order, "RuStore: " + status);
}

// ---------------------------------------------------------------------
// Google Play: OAuth сервисного аккаунта (JWT RS256) и purchases.products.
// ---------------------------------------------------------------------
let gpToken = null; // {token, exp}
async function googleAccessToken() {
  if (gpToken && Date.now() < gpToken.exp) return gpToken.token;
  const g = CFG.googleplay;
  const iat = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = enc({ alg: "RS256", typ: "JWT" }) + "." + enc({
    iss: g.clientEmail, scope: "https://www.googleapis.com/auth/androidpublisher",
    aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600,
  });
  const sig = crypto.sign("RSA-SHA256", Buffer.from(unsigned), g.privateKey).toString("base64url");
  const r = await httpJson("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: unsigned + "." + sig }).toString(),
  }, 15000);
  if (r.status !== 200 || !r.data || !r.data.access_token) throw new Error(`Google OAuth: HTTP ${r.status}${r.data && r.data.error ? " " + r.data.error : ""}`);
  gpToken = { token: r.data.access_token, exp: Date.now() + Math.max(60, (Number(r.data.expires_in) || 3600) - 300) * 1000 };
  return gpToken.token;
}
async function gpRequest(method, rest, body) {
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(CFG.googleplay.pkg)}${rest}`;
  const send = async () => httpJson(url, {
    method,
    headers: Object.assign({ Authorization: "Bearer " + (await googleAccessToken()) }, body ? { "Content-Type": "application/json" } : {}),
    body: body ? JSON.stringify(body) : undefined,
  }, 15000);
  let r = await send();
  if (r.status === 401) { gpToken = null; r = await send(); }
  return r;
}
function gpPurchasePath(product, token) {
  return `/purchases/products/${encodeURIComponent(Products.storeId(product, "googleplay"))}/tokens/${encodeURIComponent(token)}`;
}
// storeProductId — id товара в Play Console, который заявил клиент: ответ
// Google обязан быть о нём же. Покупку нескольких штук разом (если в консоли
// включат «количество») не выдаём: начисляется ровно один товар.
function googlePurchaseOk(p, key, allowTest, storeProductId) {
  const uid = users.billingUserId(key);
  return !!p && p.purchaseState === 0
    && !!uid && p.obfuscatedExternalAccountId === uid
    && (p.purchaseType !== 0 || !!allowTest)
    && (storeProductId == null || p.productId == null || p.productId === storeProductId)
    && !(Number(p.quantity) > 1);
}
// После выдачи: расходуемый — consume (иначе его нельзя купить снова),
// нерасходуемый — acknowledge (иначе Google вернёт деньги через 3 дня).
// Не вышло — needsFinish, повторит фоновая задача (токен хранится до успеха).
async function googleFinish(order, product, purchaseToken) {
  try {
    const base = gpPurchasePath(product, purchaseToken);
    const g = await gpRequest("GET", base);
    if (g.status !== 200 || !g.data) throw new Error("HTTP " + g.status);
    let r = null;
    if (product.kind === "consumable" && g.data.consumptionState !== 1) r = await gpRequest("POST", base + ":consume");
    else if (product.kind !== "consumable" && g.data.acknowledgementState === 0) r = await gpRequest("POST", base + ":acknowledge", {});
    if (r && (r.status < 200 || r.status >= 300)) throw new Error("HTTP " + r.status);
    if (order.needsFinish || order.finishToken) { setOrder(order, { needsFinish: false, finishToken: null }); saveOrders(); }
    return true;
  } catch (e) {
    if (!order.needsFinish || order.finishToken !== purchaseToken) { setOrder(order, { needsFinish: true, finishToken: purchaseToken }); saveOrders(); }
    console.warn(`Магазин: Google ${product.kind === "consumable" ? "consume" : "acknowledge"} для заказа ${short(order.id)} не прошёл (${e.message}) — повторю.`);
    return false;
  }
}

// ---------------------------------------------------------------------
// Маршруты
// ---------------------------------------------------------------------

// GET /api/shop/catalog?platform=… — без входа.
function catalogFor(platform) {
  platform = normPlatform(platform);
  const providers = providersFor(platform);
  const ads = Ads().catalogInfo(platform);
  if (!providers.length && !ads.enabled) return { enabled: false };
  const rubPrice = platform !== "googleplay" && providers.some((p) => p === "yookassa" || p === "rustore" || p === "mock");
  const products = providers.length ? Products.PRODUCTS.filter((p) => p.enabled).map((p) => ({
    id: p.id,
    kind: p.kind,
    title: p.title,
    subtitle: p.subtitle,
    points: p.points || 0,
    premium: !!p.premium,
    traderDays: Products.traderDaysOf(p),
    unlocks: Products.unlocksOf(p),
    price: rubPrice ? { value: Products.rubValue(p), currency: "RUB", text: Products.rubText(p) } : null,
    storeIds: { rustore: Products.storeId(p, "rustore"), googleplay: Products.storeId(p, "googleplay") },
  })) : [];
  return {
    enabled: true,
    platform,
    providers,
    mock: providers.includes("mock"),
    receipts: providers.includes("yookassa") && !!CFG.yookassa.receipts,
    products,
    premiumBenefits: Products.PREMIUM_BENEFITS.slice(),
    traderBenefits: Products.TRADER_BENEFITS.slice(),
    ads,
    legal: Object.assign({}, CFG.legal),
  };
}
function handleCatalog(req, res) {
  let platform = "web";
  try { platform = new URL(req.url, "http://localhost").searchParams.get("platform") || "web"; } catch (e) {}
  reply(res, 200, catalogFor(platform));
}

const ORDERS_PER_HOUR = 20;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
// orders.json переписывается целиком на каждый заказ, поэтому незавершённых
// заказов не должно быть много (иначе поток заказов со скриптов раздул бы файл
// и тормозил запись, а с ней — все партии):
// - на аккаунт — не больше OPEN_PER_ACCOUNT незавершённых за последний час;
// - заказ магазина приложений (created) — лишь заготовка: повторное «Купить» того
//   же товара получает тот же заказ, через сутки он удаляется, а при
//   переполнении самые старые вытесняются (verify создаст заказ и без неё);
// - ожидающих оплаты ЮKassa (за каждым — платёж в ЮKassa) не больше MAX_PENDING_YK.
const OPEN_PER_ACCOUNT = 5;
const MAX_CREATED_STORE = 3000;
const MAX_PENDING_YK = 2000;
const STORE_CREATED_TTL_MS = 24 * 3600e3;
function isStoreCreated(o) { return !!o && o.status === "created" && (o.provider === "rustore" || o.provider === "googleplay"); }
function reusableStoreOrder(key, provider, platform, productId, now) {
  for (const id of byUser.get(key) || []) {
    const o = own(store.orders, id);
    if (isStoreCreated(o) && o.provider === provider && o.platform === platform && o.productId === productId && now - o.createdAt < 3600e3) return o;
  }
  return null;
}
function dropOrder(o) {
  unindexOrder(o);
  delete store.orders[o.id];
}
function trimStoreCreated() {
  const list = Object.values(store.orders).filter(isStoreCreated);
  if (list.length < MAX_CREATED_STORE) return;
  list.sort((a, b) => a.createdAt - b.createdAt);
  for (const o of list.slice(0, list.length - MAX_CREATED_STORE + 1)) dropOrder(o);
}
function pendingYookassaCount(now) {
  let n = 0;
  for (const o of Object.values(store.orders)) {
    if (o && o.provider === "yookassa" && (o.status === "created" || o.status === "pending") && now - o.createdAt < 24 * 3600e3) n++;
  }
  return n;
}
let capWarnedAt = 0;
function storeOrderReply(order, product, key) {
  return { ok: true, orderId: order.id, provider: order.provider, status: "created", confirmationUrl: null,
    storeProductId: Products.storeId(product, order.provider), billingUserId: users.billingUserId(key) };
}

// POST /api/shop/order — создать заказ (для ЮKassa — сразу и платёж).
async function createOrder(b) {
  if (!shopEnabled()) return fail("shop_disabled");
  const auth = users.authAccount(b.username, b.password, b.token);
  if (auth.error) return auth;
  const key = auth.key;
  const platform = normPlatform(String(b.platform || ""));
  const provider = String(b.provider || "");
  if (!providersFor(platform).includes(provider)) return fail("provider_disabled");
  const product = Products.byId(String(b.productId || ""));
  if (!product || !product.enabled) return fail("unknown_product");
  if (product.kind === "non-consumable" && users.ownsProduct(key, product)) return fail("already_owned");
  const now = Date.now();
  if (provider === "rustore" || provider === "googleplay") {
    const same = reusableStoreOrder(key, provider, platform, product.id, now);
    if (same) return storeOrderReply(same, product, key);
  }
  const recent = (byUser.get(key) || []).map((id) => own(store.orders, id)).filter((o) => o && o.createdAt > now - 3600e3);
  if (recent.length >= ORDERS_PER_HOUR) return fail("rate_limited");
  if (recent.filter((o) => o.status === "created" || o.status === "pending").length >= OPEN_PER_ACCOUNT) return fail("too_many_open");
  if (provider === "yookassa" && pendingYookassaCount(now) >= MAX_PENDING_YK) {
    if (now - capWarnedAt > 10 * 60e3) {
      capWarnedAt = now;
      console.warn(`Магазин: ожидают оплаты ${MAX_PENDING_YK} заказов ЮKassa за сутки — новые не принимаю (похоже на поток заказов со скриптов).`);
    }
    return fail("rate_limited");
  }
  let email = "";
  if (provider === "yookassa" && CFG.yookassa.receipts) {
    // Email нужен только для чека и на сервере не сохраняется.
    email = String(b.email || "").trim();
    if (email.length > 254 || !EMAIL_RE.test(email)) return fail("email_required");
  }
  const amount = { value: Products.rubValue(product), currency: "RUB" };

  if (provider === "mock") {
    // Тестовая оплата: заказ выдаётся сразу, деньги не списываются.
    const order = newOrder({ user: key, productId: product.id, provider, platform, amount, test: true });
    saveOrders();
    const g = grantOrder(order, "mock:" + order.id, { ref: order.id });
    return { ok: true, orderId: order.id, provider, status: "granted", confirmationUrl: null, user: g.profile || auth.profile };
  }

  if (provider === "rustore" || provider === "googleplay") {
    // Покупка пройдёт в приложении магазина; выдача — по /api/shop/verify.
    trimStoreCreated();
    const order = newOrder({ user: key, productId: product.id, provider, platform });
    saveOrders();
    return storeOrderReply(order, product, key);
  }

  // ЮKassa: сумма — из каталога, не от клиента.
  const y = CFG.yookassa;
  const order = newOrder({ user: key, productId: product.id, provider, platform, amount });
  saveOrders();
  const returnUrl = y.origin + (platform === "web" ? "/?order=" : "/pay-return.html?order=") + order.id;
  const body = {
    amount,
    capture: true,
    confirmation: { type: "redirect", return_url: returnUrl },
    description: ("Trade Monopoly: " + product.title).slice(0, 128),
    metadata: { orderId: order.id, account: key, product: product.id },
  };
  if (y.receipts) {
    body.receipt = {
      customer: { email },
      items: [{
        description: product.points && product.kind === "consumable" ? `Игровая валюта «Биржа»: ${product.points} очков` : `«Биржа»: ${product.title}`,
        quantity: 1, amount, vat_code: y.vatCode, payment_mode: "full_payment", payment_subject: y.paymentSubject,
      }],
    };
    if (y.taxSystem) body.receipt.tax_system_code = y.taxSystem;
  }
  let p;
  try { p = await ykCreatePayment(body, order.id); }
  catch (e) {
    setOrder(order, { status: "failed", note: "платёж не создан: " + String(e.message || e).slice(0, 200) });
    saveOrders();
    console.error(`Магазин: ЮKassa не создала платёж для заказа ${short(order.id)}: ${e.message}`);
    return fail("provider_error");
  }
  const url = p.confirmation && typeof p.confirmation.confirmation_url === "string" ? p.confirmation.confirmation_url : "";
  if (!/^https?:\/\//.test(url) || p.status === "canceled") {
    setOrder(order, { status: "failed", ref: p.id, note: "нет ссылки на оплату (статус " + String(p.status).slice(0, 30) + ")" });
    saveOrders();
    console.error(`Магазин: ЮKassa вернула платёж ${p.id} без ссылки на оплату (статус ${p.status}).`);
    return fail("provider_error");
  }
  setOrder(order, { status: "pending", ref: p.id, confirmationUrl: url, test: p.test === true });
  saveOrders();
  return { ok: true, orderId: order.id, provider, status: "pending", confirmationUrl: url, amount };
}

// GET /api/shop/order/:id — статус своего заказа (вход по Authorization: Bearer).
async function orderStatus(req, id) {
  if (!shopEnabled()) return fail("shop_disabled");
  const a = bearerAccount(req);
  if (a.fail) return fail(a.fail);
  const order = UUID_RE.test(id) ? own(store.orders, id) : null;
  // Чужой и несуществующий заказ неотличимы.
  if (!order || order.user !== a.acc.key) return fail("not_found");
  if (order.provider === "yookassa" && order.status === "pending" && order.ref && CFG.yookassa && Date.now() - (order.lastCheckAt || 0) >= 3000) {
    try { await ykRefreshOrder(order); }
    catch (e) { console.warn(`Магазин: не удалось проверить заказ ${short(order.id)} в ЮKassa: ${e.message}`); }
  }
  const out = { ok: true, orderId: order.id, productId: order.productId, provider: order.provider,
    status: order.status, test: !!order.test, grantedAt: order.grantedAt || null };
  if (order.status === "granted") {
    // Профиль — заново: проверка выше могла только что начислить покупку.
    const acc = users.accountByToken(a.token);
    if (acc) out.user = acc.profile;
  }
  return out;
}
function handleOrderStatus(req, res, id) {
  orderStatus(req, String(id || "")).then((r) => {
    const status = r.httpStatus || 200;
    delete r.httpStatus;
    reply(res, status, r);
  }, (e) => {
    console.error("shop:", e && e.message);
    reply(res, 500, { error: "Внутренняя ошибка сервера." });
  });
}

// POST /api/shop/yookassa/webhook — без входа: из тела берём только event и
// object.id, а всё остальное заново спрашиваем у ЮKassa. Ответ 200 — только
// после сохранения результата; ошибка запроса к ЮKassa — 500 (ЮKassa повторит
// уведомление в течение суток).
// id, о которых ЮKassa недавно ответила 404: повтор выдуманного уведомления не
// ходит в API с ключом магазина (лимит запросов с адреса — в server.js).
const ykMissing = new Map(); // id → время ответа 404
const YK_MISSING_TTL_MS = 10 * 60e3;
function ykMissingRecently(id) {
  const at = ykMissing.get(id);
  return !!at && Date.now() - at < YK_MISSING_TTL_MS;
}
function noteYkMissing(id) {
  if (ykMissing.size >= 5000) ykMissing.clear();
  ykMissing.set(id, Date.now());
}
async function processYkWebhook(body) {
  const event = body.event;
  const id = body.object.id;
  if (ykMissingRecently(id)) return;
  if (event.startsWith("payment.")) {
    const r = await ykGet("payments", id);
    if (r.status === 404) { noteYkMissing(id); console.warn(`Магазин: вебхук ЮKassa о неизвестном платеже ${id} — пропускаю.`); return; }
    if (r.status !== 200 || !r.data) throw new Error("ЮKassa GET /payments: HTTP " + r.status);
    const p = r.data;
    const orderId = p.metadata && typeof p.metadata.orderId === "string" ? p.metadata.orderId : "";
    const order = UUID_RE.test(orderId) ? own(store.orders, orderId) : null;
    if (!order || order.provider !== "yookassa") { console.warn(`Магазин: платёж ЮKassa ${p.id} не относится к заказам этого сервера — пропускаю.`); return; }
    order.lastCheckAt = Date.now();
    applyYkPayment(order, p);
    return;
  }
  if (event === "refund.succeeded") {
    const r = await ykGet("refunds", id);
    if (r.status === 404) { noteYkMissing(id); console.warn(`Магазин: вебхук ЮKassa о неизвестном возврате ${id} — пропускаю.`); return; }
    if (r.status !== 200 || !r.data) throw new Error("ЮKassa GET /refunds: HTTP " + r.status);
    const refund = r.data;
    const orderId = byRef.get("yookassa:" + refund.payment_id);
    const order = orderId ? own(store.orders, orderId) : null;
    if (!order) { console.warn(`Магазин: возврат ЮKassa ${refund.id} по чужому платежу — пропускаю.`); return; }
    let refundedTotal = null;
    if (refund.status === "succeeded" && order.status === "granted" && !ykCoversOrder(refund.amount, order)) {
      // Частичный возврат: смотрим, сколько вернули по платежу всего.
      const pr = await ykGet("payments", refund.payment_id);
      if (pr.status !== 200 || !pr.data) throw new Error("ЮKassa GET /payments: HTTP " + pr.status);
      refundedTotal = pr.data.refunded_amount || null;
    }
    applyYkRefund(order, refund, refundedTotal);
  }
}
function handleYookassaWebhook(req, res, ip) {
  if (!CFG.yookassa) return replyFail(res, "shop_disabled");
  if (CFG.yookassa.ipCheck && !ykIpAllowed(ip)) {
    console.warn(`Магазин: вебхук ЮKassa с чужого адреса ${String(ip).slice(0, 45)} — отклонён.`);
    return reply(res, 403, { error: "Forbidden" });
  }
  H.readJsonBody(req, 64 * 1024).then((body) => {
    const ok = body && body.type === "notification" && typeof body.event === "string" && body.event.length < 64
      && body.object && typeof body.object.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(body.object.id);
    if (!ok) return reply(res, 400, { error: "Некорректное уведомление." });
    return processYkWebhook(body).then(() => reply(res, 200, { ok: true }), (e) => {
      console.error("Магазин: вебхук ЮKassa не обработан (ЮKassa повторит):", e && e.message);
      reply(res, 500, { error: "Временная ошибка." });
    });
  }, (e) => reply(res, 400, { error: e.message || "Ошибка запроса." }));
}

// POST /api/shop/verify — покупки в магазинах (RuStore, Google Play) и mock.
const TOKEN_RE = {
  mock: /^[A-Za-z0-9._-]{1,128}$/,
  rustore: /^[A-Za-z0-9_-]{1,128}$/,
  googleplay: /^[A-Za-z0-9._-]{10,4096}$/,
};
function storeProviderOn(provider) {
  return provider === "mock" ? CFG.mock : provider === "rustore" ? !!CFG.rustore : provider === "googleplay" ? !!CFG.googleplay : false;
}
function alreadyGranted(orderId, key) {
  const order = own(store.orders, orderId);
  if (!order || order.user !== key) return fail("other_account");
  if (order.status === "refunded") return fail("invalid_purchase"); // деньги за покупку возвращены
  // На случай падения между записью заказа и начислением — applyOrder идемпотентен.
  const r = users.applyOrder(order);
  return { ok: true, status: "granted", alreadyGranted: true, orderId: order.id, user: r && r.profile };
}
// Заказ, созданный перед покупкой (POST /api/shop/order); без него (досылка при
// запуске приложения) заказ создаётся при выдаче.
function pickOrder(orderId, key, provider, product) {
  const o = UUID_RE.test(String(orderId || "")) ? own(store.orders, String(orderId)) : null;
  return o && o.user === key && o.provider === provider && o.productId === product.id && (o.status === "created" || o.status === "pending") ? o : null;
}

async function verify(b) {
  if (!shopEnabled()) return fail("shop_disabled");
  const auth = users.authAccount(b.username, b.password, b.token);
  if (auth.error) return auth;
  const key = auth.key;
  const provider = String(b.provider || "");
  if (!storeProviderOn(provider)) return fail("provider_disabled");
  const product = Products.byId(String(b.productId || ""));
  if (!product) return fail("unknown_product");
  const token = String(b.purchaseToken || "");
  if (!TOKEN_RE[provider].test(token)) return fail("invalid_purchase");
  const grantKey = provider === "mock" ? "mock:" + token : provider === "rustore" ? "rs:" + token : "gp:" + sha256(token);
  const tokenTag = provider === "googleplay" ? sha256(token).slice(0, 8) : token.slice(0, 12);

  const prev = own(store.grants, grantKey);
  if (prev) {
    // Выданный счёт RuStore — заодно перепроверяем, не вернули ли за него деньги.
    const po = own(store.orders, prev);
    if (provider === "rustore" && po && po.user === key && Date.now() - (po.lastCheckAt || 0) >= RS_RECHECK_MS) await rustoreRecheck(po, Date.now());
    return alreadyGranted(prev, key);
  }
  if (product.kind === "non-consumable" && users.ownsProduct(key, product)) {
    console.warn(`Магазин: ${provider}-покупка ${tokenTag} (${product.id}) — товар уже есть на аккаунте, не выдаю. RuStore: вернуть деньги вручную; Google вернёт сам через 3 дня.`);
    return fail("already_owned");
  }
  let order = pickOrder(b.orderId, key, provider, product);
  const platform = provider === "mock" ? normPlatform(String(b.platform || (order && order.platform) || "")) : provider;
  const extra = { ref: provider === "googleplay" ? sha256(token) : token, test: provider === "mock" };
  let gp = null;

  if (provider === "rustore") {
    let inv;
    try { inv = await rustoreInvoice(token); }
    catch (e) { console.error(`Магазин: RuStore не ответил по счёту ${tokenTag}: ${e.message}`); return fail("provider_error"); }
    if (inv.notFound) { console.warn(`Магазин: счёт RuStore ${tokenTag} не найден.`); return fail("invalid_purchase"); }
    const body = inv.body;
    const status = String(body.invoiceStatus || "").toUpperCase();
    if (body.appUserId && body.appUserId !== users.billingUserId(key)) return fail("other_account");
    if (["CREATED", "EXECUTED", "PAID", "PROCESSING"].includes(status)) return { ok: true, status: "pending", orderId: order ? order.id : null };
    if (["CANCELLED", "REJECTED", "EXPIRED"].includes(status)) {
      if (order) { setOrder(order, { status: "canceled", note: "RuStore: " + status }); saveOrders(); }
      return fail("invalid_purchase");
    }
    if (["REFUNDED", "REVERSED"].includes(status)) {
      const gid = own(store.grants, grantKey);
      if (gid) refundOrder(own(store.orders, gid), "RuStore: " + status);
      return fail("invalid_purchase");
    }
    if (!rustoreInvoiceOk(body, { productId: product.id }, key)) {
      console.warn(`Магазин: счёт RuStore ${tokenTag} не прошёл проверку (товар, приложение, статус ${status} или аккаунт).`);
      return fail("invalid_purchase");
    }
    const cents = body.order && Number(body.order.amountCurrent);
    if (Number.isFinite(cents) && cents !== product.rub * 100) console.log(`Магазин: счёт RuStore ${tokenTag}: сумма ${cents / 100} ₽, в каталоге ${product.rub} ₽ (цену задаёт консоль).`);
    extra.test = inv.test;
    extra.lastCheckAt = Date.now(); // счёт только что проверен — перепроверка возврата позже
  } else if (provider === "googleplay") {
    let r;
    try { r = await gpRequest("GET", gpPurchasePath(product, token)); }
    catch (e) { console.error(`Магазин: Google Play не ответил по покупке ${tokenTag}: ${e.message}`); return fail("provider_error"); }
    if (r.status === 404 || r.status === 410 || r.status === 400) { console.warn(`Магазин: покупка Google ${tokenTag} не найдена (HTTP ${r.status}).`); return fail("invalid_purchase"); }
    if (r.status !== 200 || !r.data) { console.error(`Магазин: Google Play: HTTP ${r.status} по покупке ${tokenTag}.`); return fail("provider_error"); }
    gp = r.data;
    if (gp.purchaseState === 2) return { ok: true, status: "pending", orderId: order ? order.id : null };
    if (gp.purchaseState === 1) {
      if (order) { setOrder(order, { status: "canceled", note: "Google: purchaseState=1" }); saveOrders(); }
      return fail("invalid_purchase");
    }
    if (gp.obfuscatedExternalAccountId && gp.obfuscatedExternalAccountId !== users.billingUserId(key)) return fail("other_account");
    if (!googlePurchaseOk(gp, key, CFG.googleplay.allowTest, Products.storeId(product, "googleplay"))) {
      console.warn(`Магазин: покупка Google ${tokenTag} не прошла проверку (аккаунт, товар, количество или тестовая покупка без GOOGLE_PLAY_ALLOW_TEST).`);
      return fail("invalid_purchase");
    }
    extra.test = gp.purchaseType === 0;
  }

  // Дальше — синхронно до grantOrder: пока шла проверка, ту же покупку мог
  // выдать параллельный запрос.
  const again = own(store.grants, grantKey);
  if (again) return alreadyGranted(again, key);
  if (gp && gp.consumptionState === 1) {
    console.warn(`Магазин: покупка Google ${tokenTag} уже потреблена не нами — не выдаю.`);
    return fail("invalid_purchase");
  }
  if (product.kind === "non-consumable" && users.ownsProduct(key, product)) return fail("already_owned");
  if (!order || !pickOrder(order.id, key, provider, product)) {
    order = newOrder({ user: key, productId: product.id, provider, platform, note: b.orderId ? null : "досылка покупки" });
    saveOrders();
  }
  const g = grantOrder(order, grantKey, extra);
  if (g.already) return alreadyGranted(g.orderId, key);
  if (gp) await googleFinish(order, product, token);
  return { ok: true, status: "granted", orderId: order.id, alreadyGranted: false, user: g.profile };
}

// GET /api/shop/entitlements — покупки, баланс и видео (вход по Bearer).
// Работает и при выключенном магазине.
function handleEntitlements(req, res) {
  const a = bearerAccount(req);
  if (a.fail) return replyFail(res, a.fail);
  const info = users.accountShopInfo(a.acc.key);
  if (!info) return replyFail(res, "session");
  reply(res, 200, Object.assign({ ok: true }, info, { ads: Ads().statusFor(a.acc.key) }));
}

// ---------------------------------------------------------------------
// Фоновые задачи (таймеры с unref — не держат процесс в тестах).
// ---------------------------------------------------------------------
// Незавершённые и отменённые заказы хранятся 30 дней (оплата ЮKassa может прийти
// поздно), заготовки заказов магазинов приложений — сутки.
function cleanupOrders(now) {
  let changed = false;
  for (const [id, o] of Object.entries(store.orders)) {
    const age = o ? now - (o.updatedAt || o.createdAt || 0) : Infinity;
    const stale = !o || (isStoreCreated(o) && age > STORE_CREATED_TTL_MS)
      || (["created", "pending", "canceled", "failed"].includes(o.status) && age > 30 * 86400e3);
    if (!stale) continue;
    if (o) unindexOrder(o);
    delete store.orders[id];
    changed = true;
  }
  for (const [k, at] of Object.entries(store.adTx)) {
    if (!(now - at < 7 * 86400e3)) { delete store.adTx[k]; changed = true; }
  }
  if (changed) saveOrders();
}
async function pollYookassa() {
  const now = Date.now();
  for (const o of Object.values(store.orders)) {
    if (!o || o.provider !== "yookassa" || o.status !== "pending" || !o.ref) continue;
    if (now - o.createdAt > 24 * 3600e3 || now - (o.lastCheckAt || 0) < 5 * 60e3) continue;
    try { await ykRefreshOrder(o); }
    catch (e) { console.warn(`Магазин: опрос ЮKassa по заказу ${short(o.id)}: ${e.message}`); }
  }
}
async function finishGoogle() {
  for (const o of Object.values(store.orders)) {
    if (!o || o.provider !== "googleplay" || !o.needsFinish || !o.finishToken) continue;
    const product = Products.byId(o.productId);
    if (product) await googleFinish(o, product, o.finishToken);
  }
}
// Возвраты RuStore: выданные за последние 60 дней счета — раз в сутки каждый,
// не больше 200 запросов за проход (раздел 5.6 спецификации).
const RS_REFUND_WINDOW_MS = 60 * 86400e3;
const RS_REFUND_EVERY_MS = 24 * 3600e3;
async function pollRustoreRefunds(now) {
  now = now || Date.now();
  let checked = 0;
  for (const o of Object.values(store.orders)) {
    if (!o || o.provider !== "rustore" || o.status !== "granted" || !o.ref) continue;
    if (now - (o.grantedAt || 0) > RS_REFUND_WINDOW_MS || now - (o.lastCheckAt || 0) < RS_REFUND_EVERY_MS) continue;
    if (checked >= 200) break;
    checked++;
    await rustoreRecheck(o, now);
  }
  if (checked) saveOrders(); // время проверки — чтобы после перезапуска не проверять всё заново
}
async function pollGoogleVoided() {
  const now = Date.now();
  const start = Math.max(now - 30 * 86400e3, (Number(store.meta.lastVoidedPollAt) || 0) - 3600e3);
  let page = null;
  let pages = 0;
  do {
    const qs = new URLSearchParams({ startTime: String(start), maxResults: "1000" });
    if (page) qs.set("token", page);
    const r = await gpRequest("GET", "/purchases/voidedpurchases?" + qs.toString());
    if (r.status !== 200) throw new Error("Google voidedpurchases: HTTP " + r.status);
    for (const v of (r.data && r.data.voidedPurchases) || []) {
      if (!v || typeof v.purchaseToken !== "string") continue;
      const orderId = own(store.grants, "gp:" + sha256(v.purchaseToken));
      if (orderId) refundOrder(own(store.orders, orderId), "Google: возврат/отмена покупки");
    }
    page = r.data && r.data.tokenPagination && r.data.tokenPagination.nextPageToken;
  } while (page && ++pages < 20);
  store.meta.lastVoidedPollAt = now;
  saveOrders();
}
const timers = [];
function every(ms, fn) {
  let busy = false;
  const t = setInterval(() => {
    if (busy) return; // прошлый проход ещё идёт (медленный провайдер)
    busy = true;
    Promise.resolve().then(fn).catch((e) => console.error("Магазин:", e && e.message)).then(() => { busy = false; });
  }, ms);
  if (t.unref) t.unref();
  timers.push(t);
}

function summaryLine() {
  const on = (x) => (x ? "вкл" : "выкл");
  // Тестовые платежи засчитываются — видно сразу в строке при старте (не забыть выключить).
  const test = (x) => (x ? " (тестовые платежи засчитываются)" : "");
  return `Магазин: ЮKassa — ${on(CFG.yookassa)}${test(CFG.yookassa && CFG.yookassa.allowTest)}, ` +
    `RuStore — ${on(CFG.rustore)}${test(CFG.rustore && CFG.rustore.allowSandbox)}, ` +
    `Google Play — ${on(CFG.googleplay)}${test(CFG.googleplay && CFG.googleplay.allowTest)}, ` +
    `тестовая оплата — ${on(CFG.mock)}, ${Ads().summary()}.`;
}

let started = false;
function init(helpers) {
  Object.assign(H, helpers || {});
  if (started) return;
  started = true;
  for (const p of problems) console.warn("Магазин: " + p);
  if (MOCK.refused) console.error("Магазин: PAYMENTS_MOCK=1 игнорируется при NODE_ENV=production — тестовая оплата выдаёт товары бесплатно.");
  if (MOCK.forced) console.error("Магазин: ВНИМАНИЕ! Тестовая оплата включена при NODE_ENV=production (PAYMENTS_MOCK_FORCE=1): любой вошедший получает товары бесплатно. Только для проверочного сервера!");
  console.log(summaryLine());
  reconcile();
  cleanupOrders(Date.now());
  every(3600e3, () => cleanupOrders(Date.now()));
  if (CFG.yookassa) every(5 * 60e3, pollYookassa);
  if (CFG.rustore) every(6 * 3600e3, () => pollRustoreRefunds(Date.now()));
  if (CFG.googleplay) {
    every(5 * 60e3, finishGoogle);
    every(6 * 3600e3, pollGoogleVoided);
  }
}

module.exports = {
  init, handleCatalog, createOrder, handleOrderStatus, handleYookassaWebhook, verify, handleEntitlements, shopEnabled,
  // для ads.js
  envFlag, envInt, envStr, normPlatform, fail, bearerAccount, adTxSeen, noteAdTx,
  // чистые функции и фоновые задачи — для тестов
  catalogFor, providersFor, ykPaymentOk, rustoreInvoiceOk, googlePurchaseOk, ykIpAllowed, finishGoogle, pollGoogleVoided,
  pollRustoreRefunds, cleanupOrders,
};
