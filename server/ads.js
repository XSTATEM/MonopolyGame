// ---------------------------------------------------------------------
// Видео с наградой (только Android-сборки): Рекламная сеть Яндекса в сборках
// direct и rustore, AdMob в googleplay. На сайте рекламы нет.
//
// У Яндекса нет серверной проверки награды, поэтому очки выдаются по
// одноразовому билету: POST /api/ads/start выдаёт билет перед показом,
// POST /api/ads/reward гасит его после просмотра — не раньше ADS_MIN_WATCH_SEC,
// не больше ADS_DAILY_CAP в сутки (с Премиумом вдвое больше) и с паузой
// ADS_COOLDOWN_SEC. Это «на честном слове»: платформу (а с ней и Яндекс) называет
// клиент, и скрипт может гасить билеты без показа видео — накрутку ограничивают
// только эти лимиты и ADS_MIN_ACCOUNT_AGE_HOURS. Поэтому Яндекс отдельно
// выключается ADS_YANDEX=off (по умолчанию выключен при ADMOB_SSV=on).
// AdMob при ADMOB_SSV=on награждает только по подписанному колбэку Google
// (GET /api/ads/admob-ssv), а /api/ads/reward лишь сообщает итог.
// Очки идут только на баланс: рейтинг за рекламу не меняется.
// ---------------------------------------------------------------------
"use strict";
const crypto = require("crypto");
const users = require("./users.js");
const Payments = require("./payments.js");

// ---------------------------------------------------------------------
// Настройки. ADS_REWARD_POINTS=0 (по умолчанию) — реклама выключена.
// ---------------------------------------------------------------------
const problems = [];
function readConfig() {
  const off = { enabled: false, rewardPoints: 0, dailyCap: 0, cooldownSec: 0, minWatchSec: 0, minAgeHours: 0, yandex: false, admob: false, admobSsv: false, adUnits: [] };
  const rewardPoints = Payments.envInt("ADS_REWARD_POINTS", 0, 0, 1000);
  if (rewardPoints === null) { problems.push("ADS_REWARD_POINTS — число от 0 до 1000; реклама выключена."); return off; }
  if (Payments.envStr("YANDEX_ADS_S2S_SECRET")) problems.push("YANDEX_ADS_S2S_SECRET задан, но не используется: у Яндекса нет серверного колбэка награды.");
  if (!rewardPoints) return off;
  const dailyCap = Payments.envInt("ADS_DAILY_CAP", 5, 1, 100);
  const cooldownSec = Payments.envInt("ADS_COOLDOWN_SEC", 180, 0, 86400);
  const minWatchSec = Payments.envInt("ADS_MIN_WATCH_SEC", 10, 0, 600);
  // Видео — только аккаунтам старше N часов: меньше смысла плодить аккаунты ради очков.
  const minAgeHours = Payments.envInt("ADS_MIN_ACCOUNT_AGE_HOURS", 0, 0, 720);
  if (dailyCap === null || cooldownSec === null || minWatchSec === null || minAgeHours === null) {
    problems.push("ADS_DAILY_CAP (1–100), ADS_COOLDOWN_SEC (0–86400), ADS_MIN_WATCH_SEC (0–600) и ADS_MIN_ACCOUNT_AGE_HOURS (0–720) — целые числа; реклама выключена.");
    return off;
  }
  // AdMob: неверная настройка выключает только его, Яндекс остаётся.
  let admob = true;
  const admobSsv = Payments.envFlag("ADMOB_SSV", false);
  if (admobSsv === null) { problems.push("ADMOB_SSV — ожидается on или off; AdMob выключен."); admob = false; }
  const unitsRaw = Payments.envStr("ADMOB_AD_UNITS");
  const adUnits = unitsRaw ? unitsRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
  if (adUnits.some((u) => !/^\d{1,20}$/.test(u))) {
    problems.push("ADMOB_AD_UNITS — числовые id блоков через запятую (часть после «/»); AdMob выключен.");
    admob = false;
  }
  // Яндекс без серверной проверки: включив ADMOB_SSV, владелец хочет проверенных
  // наград — тогда Яндекс по умолчанию выключен (иначе любой клиент назвался бы
  // сборкой direct и получал очки без видео в обход SSV).
  let yandex = Payments.envFlag("ADS_YANDEX", !admobSsv);
  if (yandex === null) { problems.push("ADS_YANDEX — ожидается on или off; видео Яндекса выключены."); yandex = false; }
  return { enabled: true, rewardPoints, dailyCap, cooldownSec, minWatchSec, minAgeHours, yandex, admob, admobSsv: !!admobSsv, adUnits };
}
const CFG = readConfig();

function providersFor(platform) {
  if (!CFG.enabled) return [];
  platform = Payments.normPlatform(platform);
  if (platform === "direct" || platform === "rustore") return CFG.yandex ? ["yandex"] : [];
  if (platform === "googleplay" && CFG.admob) return ["admob"];
  return [];
}
function capFor(key) { return CFG.dailyCap * (users.isPremium(key) ? 2 : 1); }
function cooldownMs() { return CFG.cooldownSec * 1000; }

// Раздел ads каталога (/api/shop/catalog).
function catalogInfo(platform) {
  const providers = providersFor(platform);
  if (!providers.length) return { enabled: false, providers: [], rewardPoints: 0, dailyCap: 0, premiumDailyCap: 0, cooldownSec: 0 };
  return { enabled: true, providers, rewardPoints: CFG.rewardPoints, dailyCap: CFG.dailyCap, premiumDailyCap: CFG.dailyCap * 2, cooldownSec: CFG.cooldownSec };
}
// Раздел ads ответа /api/shop/entitlements.
function statusFor(key) {
  if (!CFG.enabled) return { enabled: false };
  const st = users.adStatus(key, { cap: capFor(key), cooldownMs: cooldownMs(), now: Date.now() });
  return { enabled: true, today: st.count, cap: st.cap, nextAt: st.nextAt };
}
function summary() {
  if (!CFG.enabled) return "реклама — выкл";
  return `реклама — +${CFG.rewardPoints} очков, ${CFG.dailyCap} в сутки` +
    `, Яндекс — ${CFG.yandex ? "вкл (без серверной проверки)" : "выкл"}` +
    `${CFG.admob ? (CFG.admobSsv ? ", AdMob SSV" : ", AdMob без SSV") : ""}` +
    `${CFG.minAgeHours ? `, аккаунтам старше ${CFG.minAgeHours} ч` : ""}`;
}

// ---------------------------------------------------------------------
// Билеты — в памяти: nonce → {user, provider, adUnit, issuedAt, ssv, status, result}.
// Не больше одного на аккаунт, срок 15 минут. Перезапуск сервера их теряет —
// игрок просто смотрит следующее видео.
// ---------------------------------------------------------------------
const TICKET_TTL_MS = 15 * 60 * 1000;
const NONCE_RE = /^[0-9a-f]{32}$/;
const tickets = new Map();
const ticketByUser = new Map();
function dropTicket(nonce) {
  const t = tickets.get(nonce);
  if (!t) return;
  tickets.delete(nonce);
  if (ticketByUser.get(t.user) === nonce) ticketByUser.delete(t.user);
}
function sweep(now) {
  for (const [nonce, t] of tickets) if (now - t.issuedAt > TICKET_TTL_MS) dropTicket(nonce);
}

// POST /api/ads/start — билет перед показом видео.
function start(b) {
  if (!CFG.enabled) return Payments.fail("ads_disabled");
  const auth = users.authAccount(b.username, b.password, b.token);
  if (auth.error) return auth;
  const key = auth.key;
  const platform = Payments.normPlatform(String(b.platform || ""));
  const provider = String(b.provider || "");
  if (!providersFor(platform).includes(provider)) return Payments.fail("ads_disabled", 400);
  const adUnit = String(b.adUnit || "");
  if (!adUnit || adUnit.length > 100 || !/^[A-Za-z0-9~\/._-]+$/.test(adUnit)) return Payments.fail("ads_ticket");
  const now = Date.now();
  if (CFG.minAgeHours) {
    const created = users.accountCreatedAt(key);
    const readyAt = created + CFG.minAgeHours * 3600e3;
    if (created && readyAt > now) {
      const h = Math.max(1, Math.ceil((readyAt - now) / 3600e3));
      return { error: `Видео с наградой откроются через ${h} ч — новому аккаунту нужно немного подождать.`, code: "ads_new_account", nextAt: readyAt };
    }
  }
  const cap = capFor(key);
  // Лимит и паузу проверяем заранее, чтобы не показывать видео впустую.
  const block = users.adRewardBlock(key, { cap, cooldownMs: cooldownMs(), now });
  if (block) return block;
  const prev = ticketByUser.get(key);
  if (prev) dropTicket(prev);
  const nonce = crypto.randomBytes(16).toString("hex");
  const ssv = provider === "admob" && CFG.admobSsv;
  tickets.set(nonce, { user: key, provider, adUnit, issuedAt: now, ssv, status: "issued", result: null });
  ticketByUser.set(key, nonce);
  const st = users.adStatus(key, { cap, cooldownMs: cooldownMs(), now });
  return { ok: true, nonce, userId: users.billingUserId(key), ssv, rewardPoints: CFG.rewardPoints,
    minWatchSec: CFG.minWatchSec, expiresAt: now + TICKET_TTL_MS, today: { count: st.count, cap } };
}

// POST /api/ads/reward — погасить билет после просмотра.
function reward(b) {
  if (!CFG.enabled) return Payments.fail("ads_disabled");
  const auth = users.authAccount(b.username, b.password, b.token);
  if (auth.error) return auth;
  const key = auth.key;
  const nonce = String(b.nonce || "");
  const t = NONCE_RE.test(nonce) ? tickets.get(nonce) : null;
  const now = Date.now();
  if (!t || t.user !== key || t.provider !== String(b.provider || "") || now - t.issuedAt > TICKET_TTL_MS) return Payments.fail("ads_ticket");
  if (t.ssv) {
    // Награду выдаёт колбэк Google; здесь — только итог (клиент повторяет до 15 с).
    if (t.status === "rewarded") {
      dropTicket(nonce);
      return { ok: true, status: "granted", points: t.result.points, today: t.result.today, user: auth.profile };
    }
    if (t.status === "failed") {
      dropTicket(nonce);
      return Object.assign({}, t.result);
    }
    return { ok: true, status: "pending" };
  }
  if (now - t.issuedAt < CFG.minWatchSec * 1000) return Payments.fail("ads_ticket");
  dropTicket(nonce);
  const claim = users.claimAdReward(key, { points: CFG.rewardPoints, cap: capFor(key), cooldownMs: cooldownMs(), now });
  if (claim.error) return claim;
  return { ok: true, status: "granted", points: claim.points, today: claim.today, user: claim.profile };
}

// ---------------------------------------------------------------------
// AdMob SSV (developers.google.com/admob/android/ssv). Подписана строка
// запроса до «&signature=» — сырая, как пришла (nginx её не меняет).
// ---------------------------------------------------------------------
const ADMOB_KEYS_URL = "https://www.gstatic.com/admob/reward/verifier-keys.json";
function parseAdmobSsv(query) {
  query = String(query || "");
  const i = query.indexOf("&signature=");
  if (i <= 0) return null;
  const message = query.slice(0, i);
  const tail = new URLSearchParams(query.slice(i + 1));
  const signature = tail.get("signature") || "";
  const keyId = tail.get("key_id") || "";
  if (!/^[A-Za-z0-9_\-+/]{16,1024}={0,2}$/.test(signature) || !/^\d{1,20}$/.test(keyId)) return null;
  const params = {};
  for (const [k, v] of new URLSearchParams(message)) params[k] = v;
  return { message, signature, keyId, params };
}
// Подпись — ECDSA P-256 / SHA-256 в DER, закодирована web-safe base64.
function verifyWithKey(message, signature, pem) {
  try {
    const sig = Buffer.from(String(signature).replace(/\+/g, "-").replace(/\//g, "_"), "base64url");
    return crypto.verify("sha256", Buffer.from(String(message)), { key: pem, dsaEncoding: "der" }, sig);
  } catch (e) { return false; }
}
let admobKeys = { at: 0, keys: new Map() };
let admobFetchAt = 0;
async function admobKey(keyId) {
  const now = Date.now();
  if (now - admobKeys.at < 12 * 3600e3 && admobKeys.keys.has(keyId)) return admobKeys.keys.get(keyId);
  // Неизвестный key_id — перечитываем список, но не чаще раза в минуту.
  if (now - admobFetchAt < 60e3) return admobKeys.keys.get(keyId) || null;
  admobFetchAt = now;
  try {
    const r = await fetch(ADMOB_KEYS_URL, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const data = await r.json();
    const keys = new Map();
    for (const k of (data && data.keys) || []) if (k && k.keyId != null && typeof k.pem === "string") keys.set(String(k.keyId), k.pem);
    if (!keys.size) throw new Error("пустой список ключей");
    admobKeys = { at: now, keys };
  } catch (e) {
    // Google недоступен — выручит прежний ключ, если он есть; иначе 500 (Google повторит).
    if (admobKeys.keys.has(keyId)) return admobKeys.keys.get(keyId);
    throw e;
  }
  return admobKeys.keys.get(keyId) || null;
}
// Подписанный колбэк → награда по билету custom_data. Возвращает итог для лога.
function applyAdmobCallback(p) {
  if (CFG.adUnits.length && !CFG.adUnits.includes(String(p.ad_unit || ""))) return "чужой рекламный блок " + String(p.ad_unit || "").slice(0, 24);
  const tx = String(p.transaction_id || "");
  if (!tx || tx.length > 128) return "нет transaction_id";
  const txKey = "admob:" + tx;
  if (Payments.adTxSeen(txKey)) return null; // повтор того же колбэка
  const nonce = String(p.custom_data || "");
  const t = NONCE_RE.test(nonce) ? tickets.get(nonce) : null;
  if (!t || t.provider !== "admob" || !t.ssv || t.status !== "issued" || Date.now() - t.issuedAt > TICKET_TTL_MS) return "билет не найден или уже погашен";
  if (users.billingUserId(t.user) !== String(p.user_id || "")) return "user_id не совпал с владельцем билета";
  Payments.noteAdTx(txKey);
  const claim = users.claimAdReward(t.user, { points: CFG.rewardPoints, cap: capFor(t.user), cooldownMs: cooldownMs(), now: Date.now() });
  if (claim.error) {
    t.status = "failed";
    t.result = { error: claim.error, code: claim.code, nextAt: claim.nextAt };
    return null;
  }
  t.status = "rewarded";
  t.result = { points: claim.points, today: claim.today };
  return null;
}

const H = { sendJson: null };
function reply(res, status, obj) { H.sendJson(res, status, obj, { "Cache-Control": "no-store" }); }

// GET /api/ads/admob-ssv — только при ADMOB_SSV=on, без входа.
function handleAdmobSsv(req, res) {
  if (!CFG.enabled || !CFG.admob || !CFG.admobSsv) {
    const f = Payments.fail("ads_disabled");
    return reply(res, 404, { error: f.error, code: f.code });
  }
  const url = String(req.url || "");
  const q = url.indexOf("?") >= 0 ? url.slice(url.indexOf("?") + 1) : "";
  const parsed = parseAdmobSsv(q);
  if (!parsed) return reply(res, 400, { error: "Неверный колбэк." });
  admobKey(parsed.keyId).then((pem) => {
    if (!pem || !verifyWithKey(parsed.message, parsed.signature, pem)) {
      console.warn(`Реклама: колбэк AdMob с неверной подписью (key_id ${parsed.keyId}) — отклонён.`);
      return reply(res, 400, { error: "Неверная подпись." });
    }
    const why = applyAdmobCallback(parsed.params);
    if (why) console.warn("Реклама: колбэк AdMob без награды — " + why + ".");
    reply(res, 200, { ok: true });
  }, (e) => {
    console.error("Реклама: не удалось получить ключи AdMob:", e && e.message);
    reply(res, 500, { error: "Временная ошибка." });
  });
}

function init(helpers) {
  Object.assign(H, helpers || {});
  for (const p of problems) console.warn("Реклама: " + p);
}

module.exports = {
  init, start, reward, handleAdmobSsv, sweep,
  catalogInfo, statusFor, summary,
  // чистые функции — для тестов
  parseAdmobSsv, verifyWithKey,
};
