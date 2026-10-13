// ---------------------------------------------------------------------
// Простое файловое хранилище аккаунтов игроков (ник + пароль).
// Никакой внешней БД — только локальный JSON-файл на диске сервера.
// Пароли никогда не хранятся и не передаются в открытом виде: только
// scrypt-хэш с индивидуальной солью на пользователя.
// ---------------------------------------------------------------------
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Skins = require("./public/skins.js");
const Products = require("./products.js");
const Engine = require("./public/engine.js"); // сценарии рынка (SCENARIOS)

// Каталог данных можно вынести за пределы кода (DATA_DIR в /etc/birzha.env),
// чтобы аккаунты переживали обновления и переустановку.
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
// Клиент ужимает фото до 256px JPEG (обычно 20–40 КБ). Фото уходят в каждый
// ответ /api/leaderboard, поэтому большие строки здесь не нужны.
const MAX_PHOTO_LEN = 150000;

function loadUsers() {
  let raw;
  try { raw = fs.readFileSync(USERS_FILE, "utf8"); }
  catch (e) { return {}; } // файла ещё нет — первый запуск
  try {
    return JSON.parse(raw);
  } catch (e) {
    // Молча начинать с пустой базы нельзя: первая же регистрация перезаписала
    // бы файл и стёрла все аккаунты. Лучше не запуститься и сказать почему.
    throw new Error(`${USERS_FILE} повреждён (${e.message}). Восстановите его из резервной копии ` +
      `(${path.join(DATA_DIR, "backups")}) или удалите, чтобы начать с пустой базы аккаунтов.`);
  }
}
function saveUsers() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  // Через временный файл и rename: если процесс убьют посреди записи (или
  // кончится место), на диске останется прежний целый users.json, а не обрезок.
  const tmp = USERS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2), "utf8");
  fs.renameSync(tmp, USERS_FILE);
}

// usernameKey -> {username, salt, hash, gender, avatar, rating, points, pointsDebt?, entitlements, purchases, adRewards, billingId?, …, createdAt}
const users = loadUsers();
// Аватарки были эмодзи, теперь это id значков (skins.js): старые значения
// переводятся в свою замену один раз при загрузке.
for (const k in users) {
  const rec = users[k];
  if (rec && rec.avatar && rec.avatar !== "PHOTO" && !Skins.AVATAR_NAMES[rec.avatar]) rec.avatar = Skins.avatarId(rec.avatar);
}

function usernameKey(username) {
  return String(username || "").trim().toLowerCase();
}

// ---------------------------------------------------------------------
// Сессионные токены — чтобы не заставлять игрока вводить пароль заново на
// каждой перезагрузке страницы/переподключении. Токен не заменяет пароль
// (регистрация/смена пароля всё ещё требуют его), но безопаснее, чем хранить
// сам пароль в куке: его можно один клик отозвать (logout) без смены пароля.
//
// У аккаунта может быть несколько сессий (телефон, компьютер, приложение):
// раньше токен был один, и вход на втором устройстве молча выкидывал первое.
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // как Max-Age куки tm_session
const MAX_SESSIONS = 5;

// Старый формат хранил один sessionToken — переводим в список сессий.
for (const rec of Object.values(users)) {
  if (rec && rec.sessionToken) {
    rec.sessions = (Array.isArray(rec.sessions) ? rec.sessions : []).concat([{ token: rec.sessionToken, at: rec.sessionTokenCreatedAt || Date.now() }]);
  }
  if (rec) { delete rec.sessionToken; delete rec.sessionTokenCreatedAt; }
}

// Магазин: рейтинг отделён от баланса. Рейтинг (rating) — место в таблице
// лидеров, растёт только от побед; очки (points) — баланс, который тратится
// на скины и пополняется покупками и видео с наградой. У старых аккаунтов
// рейтинг равен нынешним очкам, поэтому таблица лидеров в момент обновления
// ни у кого не меняется. Миграция идемпотентна и запишется с первым saveUsers().
for (const rec of Object.values(users)) {
  if (!rec) continue;
  if (typeof rec.rating !== "number" || !Number.isFinite(rec.rating)) rec.rating = Math.max(0, Math.round(rec.points || 0));
  if (!rec.entitlements || typeof rec.entitlements !== "object" || Array.isArray(rec.entitlements)) rec.entitlements = {};
  if (!Array.isArray(rec.purchases)) rec.purchases = [];
}

function liveSessions(rec) {
  const now = Date.now();
  return (Array.isArray(rec.sessions) ? rec.sessions : []).filter((s) => s && s.token && now - s.at < SESSION_TTL_MS);
}
function hasSession(rec, token) {
  return !!token && liveSessions(rec).some((s) => s.token === token);
}

function createSession(username) {
  const key = usernameKey(username);
  const rec = users[key];
  if (!rec) return null;
  const token = crypto.randomBytes(24).toString("hex");
  rec.sessions = liveSessions(rec).concat([{ token, at: Date.now() }]).slice(-MAX_SESSIONS);
  saveUsers();
  return token;
}

function loginWithToken(token) {
  token = String(token || "");
  if (!token) return { error: "Сессия недействительна — войдите заново." };
  const rec = Object.values(users).find((r) => hasSession(r, token));
  if (!rec) return { error: "Сессия недействительна — войдите заново." };
  return { ok: true, user: publicProfile(rec) };
}

function invalidateSession(username, token) {
  const key = usernameKey(username);
  const rec = users[key];
  if (rec && Array.isArray(rec.sessions) && rec.sessions.some((s) => s.token === token)) {
    rec.sessions = rec.sessions.filter((s) => s.token !== token);
    saveUsers();
  }
  return { ok: true };
}

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

// Фото профиля — только data URL картинки с чистым base64: иначе строка вида
// `data:image/png;base64,x" onerror="…` уходила бы в <img src> у всех, кто
// открыл рейтинг (хранимый XSS → кража токена сессии).
const PHOTO_RE = /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
function isAllowedAvatar(avatar) {
  return avatar === "" || avatar === "PHOTO" || Skins.AVATAR_PACKS.some((p) => Skins.packHasAvatar(p, avatar));
}

// ---------------------------------------------------------------------
// Владение скинами. ownedAvatarPacks/ownedBoardSkins хранят только купленное
// за очки; скины Премиума и наборов туда не дописываются, а вычисляются из
// entitlements — так возврат денег снимает их удалением одной записи.
// ---------------------------------------------------------------------
function isPremiumRec(rec) {
  return !!(rec && rec.entitlements && rec.entitlements.tm_premium);
}
// Премиум открывает линейку premium:true и все скины, продающиеся за очки
// (кроме скинов наборов: набор «Уолл-стрит» в Премиум не входит).
function inPremium(skin) {
  return skin.premium === true || (skin.cost > 0 && !skin.set);
}
// Скин доступен, если он куплен за очки, открыт набором из entitlements или
// входит в Премиум. Базовые base/default доступны всегда. Порядок — как в skins.js.
function effectiveOwned(rec, kind) {
  const isBoard = kind === "boardSkin";
  const catalog = isBoard ? Skins.BOARD_SKINS : Skins.AVATAR_PACKS;
  const baseId = isBoard ? "default" : "base";
  const bought = (isBoard ? rec.ownedBoardSkins : rec.ownedAvatarPacks) || [];
  const premium = isPremiumRec(rec);
  const fromSets = new Set();
  for (const pid of Object.keys(rec.entitlements || {})) {
    const product = Products.byId(pid);
    if (!product) continue;
    const u = Products.unlocksOf(product);
    (isBoard ? u.boardSkins : u.avatarPacks).forEach((id) => fromSets.add(id));
  }
  return catalog
    .filter((s) => s.id === baseId || bought.includes(s.id) || fromSets.has(s.id) || (premium && inPremium(s)))
    .map((s) => s.id);
}
function ownsSkin(rec, kind, id) {
  return effectiveOwned(rec, kind).includes(id);
}
// Сценарии рынка (engine.js, SCENARIOS): бесплатные — всем, платные — по
// покупке (unlocks.scenarios в entitlements). Как и скины наборов, не хранятся
// отдельно, а вычисляются: возврат снимает их удалением записи entitlements.
// Подписка «Трейдер»: срок в rec.traderUntil (мс). Продлевается покупкой
// tm_trader_30 (applyOrder), без автопродления.
const DAY_MS = 86400e3;
function traderUntilRec(rec) { return Math.max(0, Math.round(Number(rec && rec.traderUntil) || 0)); }
function traderActiveRec(rec, now) { return traderUntilRec(rec) > (now || Date.now()); }
// Сценарии, доступные для игры. permanent — только купленные навсегда, без
// подписки: по ним решается, продавать ли сценарий (ownsProduct).
function ownedScenariosRec(rec, permanent) {
  if (!permanent && traderActiveRec(rec)) return Engine.SCENARIOS.map((sc) => sc.id);
  const own = new Set();
  for (const pid of Object.keys((rec && rec.entitlements) || {})) {
    const product = Products.byId(pid);
    if (product) Products.unlocksOf(product).scenarios.forEach((id) => own.add(id));
  }
  return Engine.SCENARIOS.filter((sc) => sc.free || own.has(sc.id)).map((sc) => sc.id);
}
function ownsScenario(username, id) {
  const key = usernameKey(username);
  const rec = Object.prototype.hasOwnProperty.call(users, key) ? users[key] : null;
  return !!rec && ownedScenariosRec(rec).includes(id);
}

// Аватар и фото — проверяем и при выдаче: в users.json могли остаться
// значения, сохранённые до появления строгих проверок.
function safeAvatar(rec) {
  const photo = rec.avatarPhoto && PHOTO_RE.test(rec.avatarPhoto) ? rec.avatarPhoto : null;
  const avatar = rec.avatar && isAllowedAvatar(rec.avatar) && (rec.avatar !== "PHOTO" || photo) ? rec.avatar : "";
  return { avatar, photo };
}

function publicProfile(rec) {
  const { avatar, photo } = safeAvatar(rec);
  return {
    username: rec.username,
    gender: rec.gender || "",
    avatar,
    avatarPhoto: photo,
    rating: rec.rating || 0,
    // Баланс: тратится на скины, пополняется покупками и видео с наградой.
    points: rec.points || 0,
    premium: isPremiumRec(rec),
    entitlements: Object.keys(rec.entitlements || {}),
    ownedAvatarPacks: effectiveOwned(rec, "avatarPack"),
    ownedBoardSkins: effectiveOwned(rec, "boardSkin"),
    ownedScenarios: ownedScenariosRec(rec),
    boughtScenarios: ownedScenariosRec(rec, true),
    trader: { active: traderActiveRec(rec), until: traderUntilRec(rec) },
    analysisFreeToday: analysisFreeTodayRec(rec),
    league: leagueView(rec, Date.now()),
    leagueAward: rec.leagueAward || null,
    equippedAvatarPack: rec.equippedAvatarPack || "base",
    equippedBoardSkin: rec.equippedBoardSkin || "default",
  };
}

// Строка таблицы лидеров: без баланса и покупок. points — устаревшее поле для
// старых APK со встроенным прежним клиентом (они читают p.points), равно рейтингу.
function leaderboardEntry(rec) {
  const { avatar, photo } = safeAvatar(rec);
  const rating = rec.rating || 0;
  return { username: rec.username, avatar, avatarPhoto: photo, rating, points: rating, premium: isPremiumRec(rec) };
}

// Фото профиля для показа за игровым столом. В состояние комнаты (оно уходит
// всем игрокам на каждый ход) кладётся только короткая ссылка /api/avatar/…,
// а сама картинка отдаётся отдельно и кешируется браузером.
function getPhoto(username) {
  const rec = users[usernameKey(username)];
  if (!rec || !rec.avatarPhoto || !PHOTO_RE.test(rec.avatarPhoto)) return null;
  const m = /^data:(image\/[a-z]+);base64,(.*)$/.exec(rec.avatarPhoto);
  if (!m) return null;
  return { mime: m[1] === "image/jpg" ? "image/jpeg" : m[1], buf: Buffer.from(m[2], "base64") };
}
function photoUrl(profile) {
  if (!profile || profile.avatar !== "PHOTO" || !profile.avatarPhoto) return null;
  // Версия в адресе меняется вместе с фото — обновлённое фото не застрянет в кеше.
  const v = crypto.createHash("sha1").update(profile.avatarPhoto).digest("hex").slice(0, 10);
  return `/api/avatar/${encodeURIComponent(profile.username)}?v=${v}`;
}

function register(username, password, gender, avatar) {
  username = String(username || "").trim().slice(0, 20);
  password = String(password || "");
  if (username.length < 2) return { error: "Ник должен быть не короче 2 символов." };
  if (!/^[a-zA-Zа-яА-ЯёЁ0-9_\- ]+$/.test(username)) return { error: "Ник может содержать только буквы, цифры, пробел, «-» и «_»." };
  if (password.length < 4) return { error: "Пароль должен быть не короче 4 символов." };
  const key = usernameKey(username);
  if (users[key]) return { error: "Этот ник уже занят. Попробуйте войти или выберите другой." };
  const { salt, hash } = hashPassword(password);
  const rec = {
    username, salt, hash,
    gender: String(gender || "").trim().slice(0, 24),
    // При регистрации доступен только бесплатный пак: платные покупаются за очки.
    avatar: (() => { const a = Skins.avatarId(String(avatar || "").trim().slice(0, 16)); return Skins.packHasAvatar(Skins.avatarPackById("base"), a) ? a : ""; })(),
    avatarPhoto: null,
    rating: 0,
    points: 0,
    entitlements: {},
    purchases: [],
    ownedAvatarPacks: ["base"],
    ownedBoardSkins: ["default"],
    equippedAvatarPack: "base",
    equippedBoardSkin: "default",
    createdAt: Date.now(),
  };
  users[key] = rec;
  saveUsers();
  const sessionToken = createSession(username);
  return { ok: true, user: publicProfile(rec), sessionToken };
}

function login(username, password) {
  const key = usernameKey(username);
  const rec = users[key];
  if (!rec) return { error: "Аккаунт с таким ником не найден. Проверьте ник или зарегистрируйтесь.", authFailed: true };
  const { hash } = hashPassword(String(password || ""), rec.salt);
  if (hash !== rec.hash) return { error: "Неверный пароль.", authFailed: true };
  const sessionToken = createSession(username);
  return { ok: true, user: publicProfile(rec), sessionToken };
}

// Общий помощник: проверяет пароль (или токен сессии из куки, если пароля
// под рукой нет — например, вкладка была просто перезагружена) и возвращает
// запись пользователя или {error}. authFailed — неудача именно проверки
// пароля/аккаунта: только такие server.js считает в лимит подбора паролей,
// а не «Недостаточно очков» и прочие ошибки самого действия.
function authenticate(username, password, token) {
  const key = usernameKey(username);
  const rec = users[key];
  if (!rec) return { error: "Аккаунт не найден.", authFailed: true };
  if (!password && hasSession(rec, token)) return { ok: true, rec };
  const { hash } = hashPassword(String(password || ""), rec.salt);
  if (hash !== rec.hash) return { error: "Неверный пароль.", authFailed: true };
  return { ok: true, rec };
}

// Зачислить очки на баланс. Сначала гасится долг после возврата платежа
// (pointsDebt, см. revokeOrder): иначе очки, купленные, потраченные на скины и
// возвращённые деньгами, остались бы бесплатными. Пока долг не погашен, баланс
// равен нулю. Возвращает, сколько дошло до баланса.
function creditPoints(rec, n) {
  n = Math.max(0, Math.round(n || 0));
  const debt = Math.max(0, Math.round(rec.pointsDebt || 0));
  const pay = Math.min(debt, n);
  if (debt - pay > 0) rec.pointsDebt = debt - pay; else delete rec.pointsDebt;
  rec.points = (rec.points || 0) + (n - pay);
  return n - pay;
}

// Победа в онлайн-партии: одна и та же сумма идёт и в рейтинг, и на баланс
// (баланс — за вычетом долга после возврата платежа, рейтинг — целиком).
// Возвращает новый рейтинг — его server.js показывает игроку за столом.
function addPoints(username, amount) {
  const key = usernameKey(username);
  const rec = users[key];
  if (!rec) return null;
  // Страховка: нечисловые или бесконечные суммы не должны попасть в users.json.
  if (!Number.isFinite(amount) || amount <= 0) return rec.rating || 0;
  const a = Math.round(amount);
  rec.rating = (rec.rating || 0) + a;
  creditPoints(rec, a);
  saveUsers();
  return rec.rating;
}

function getLeaderboard(limit) {
  return Object.values(users)
    .filter(Boolean)
    .map(leaderboardEntry)
    .sort((a, b) => b.rating - a.rating)
    .slice(0, limit || 50);
}

function updateProfile(username, password, gender, avatar, token) {
  const auth = authenticate(username, password, token);
  if (auth.error) return auth;
  const rec = auth.rec;
  if (gender != null) rec.gender = String(gender || "").trim().slice(0, 24);
  if (avatar != null) {
    // Клиенты прежних версий присылают эмодзи — переводим в id значка.
    avatar = Skins.avatarId(String(avatar || "").trim().slice(0, 16));
    // "PHOTO" — зарезервированное значение: показывать avatarPhoto вместо значка.
    if (avatar === "") {
      return { error: "Такого аватара нет." };
    } else if (avatar !== "PHOTO") {
      const owned = effectiveOwned(rec, "avatarPack");
      const allowed = Skins.AVATAR_PACKS.filter((p) => owned.includes(p.id)).some((p) => Skins.packHasAvatar(p, avatar));
      if (!allowed) return { error: "Этот аватар вам ещё недоступен." };
    } else if (!rec.avatarPhoto) {
      return { error: "Сначала загрузите фото." };
    }
    rec.avatar = avatar;
  }
  saveUsers();
  return { ok: true, user: publicProfile(rec) };
}

// Смена пароля — только с текущим паролем: одного токена мало, иначе укравший
// сессию (забытый вход на чужом компьютере) сменил бы пароль и забрал аккаунт.
// Остальные сессии при этом отзываются: устройство, с которого меняют пароль,
// остаётся в аккаунте, а все прочие входы перестают работать.
function changePassword(username, password, newPassword, token) {
  const rec = users[usernameKey(username)];
  if (!rec) return { error: "Аккаунт не найден.", authFailed: true };
  if (!password || hashPassword(String(password), rec.salt).hash !== rec.hash) {
    return { error: "Текущий пароль указан неверно.", authFailed: true };
  }
  newPassword = String(newPassword || "");
  if (newPassword.length < 4) return { error: "Новый пароль должен быть не короче 4 символов." };
  const { salt, hash } = hashPassword(newPassword);
  rec.salt = salt; rec.hash = hash;
  rec.sessions = liveSessions(rec).filter((s) => !!token && s.token === token);
  if (rec.sessions.length) { saveUsers(); return { ok: true, sessionToken: token }; }
  // Вошли без токена (только по паролю) — выдаём новую сессию этому устройству.
  return { ok: true, sessionToken: createSession(rec.username) };
}

function setPhoto(username, password, photoDataUrl, token) {
  const auth = authenticate(username, password, token);
  if (auth.error) return auth;
  photoDataUrl = String(photoDataUrl || "");
  if (!PHOTO_RE.test(photoDataUrl)) return { error: "Неверный формат изображения." };
  if (photoDataUrl.length > MAX_PHOTO_LEN) return { error: "Фото слишком большое — уменьшите размер." };
  const rec = auth.rec;
  rec.avatarPhoto = photoDataUrl;
  rec.avatar = "PHOTO";
  saveUsers();
  return { ok: true, user: publicProfile(rec) };
}

function buySkin(username, password, skinId, kind, token) {
  const auth = authenticate(username, password, token);
  if (auth.error) return auth;
  const rec = auth.rec;
  const catalog = kind === "boardSkin" ? Skins.BOARD_SKINS : kind === "avatarPack" ? Skins.AVATAR_PACKS : null;
  if (!catalog) return { error: "Неизвестный тип скина." };
  const skin = catalog.find((s) => s.id === skinId);
  if (!skin) return { error: "Скин не найден." };
  const ownedKey = kind === "boardSkin" ? "ownedBoardSkins" : "ownedAvatarPacks";
  if (!rec[ownedKey]) rec[ownedKey] = kind === "boardSkin" ? ["default"] : ["base"];
  // «Уже куплен» — и для открытого Премиумом или набором: очки не списываем.
  // Текст не менять — клиент сравнивает строку.
  if (ownsSkin(rec, kind, skinId)) return { error: "Этот скин уже куплен." };
  // Скины Премиума и наборов за очки не продаются (у них cost: 0).
  if (skin.premium) return { error: "Этот скин входит в Премиум." };
  if (skin.set) return { error: "Этот скин продаётся только в наборе." };
  if ((rec.points || 0) < skin.cost) return { error: "Недостаточно очков." };
  rec.points -= skin.cost;
  rec[ownedKey].push(skinId);
  saveUsers();
  return { ok: true, user: publicProfile(rec) };
}

function equipSkin(username, password, skinId, kind, token) {
  const auth = authenticate(username, password, token);
  if (auth.error) return auth;
  const rec = auth.rec;
  if (kind !== "boardSkin" && kind !== "avatarPack") return { error: "Неизвестный тип скина." };
  if (!ownsSkin(rec, kind, skinId)) return { error: "Этот скин ещё не куплен." };
  if (kind === "boardSkin") rec.equippedBoardSkin = skinId; else rec.equippedAvatarPack = skinId;
  saveUsers();
  return { ok: true, user: publicProfile(rec) };
}

// ---------------------------------------------------------------------
// Магазин и реклама (payments.js, ads.js). Деньги и видео пополняют только
// баланс (points) — рейтинг за них не меняется. Заказы применяются к аккаунту
// идемпотентно: журнал purchases — он же метка «этот заказ уже применён».
// ---------------------------------------------------------------------

// Вход для платёжных маршрутов (POST): как у /api/profile/* — пароль или токен.
function authAccount(username, password, token) {
  const auth = authenticate(username, password, token);
  if (auth.error) return auth;
  return { ok: true, key: usernameKey(username), profile: publicProfile(auth.rec) };
}
// Вход для GET-маршрутов по заголовку Authorization: Bearer <токен сессии>.
function accountByToken(token) {
  token = String(token || "");
  if (!token) return null;
  for (const [key, rec] of Object.entries(users)) {
    if (rec && hasSession(rec, token)) return { key, profile: publicProfile(rec) };
  }
  return null;
}
// Непрозрачный id игрока для магазинов и рекламы (appUserId RuStore,
// obfuscatedAccountId Google, user_id AdMob): случайные 32 байта, создаются при
// первом обращении и хранятся в users.json (billingId). Хэш ника не годится:
// ники публичны (таблица лидеров), и id перебором превращался бы обратно в ник.
// Менять id нельзя — к нему привязаны покупки в магазинах. Нет аккаунта — null.
const BILLING_ID_RE = /^[0-9a-f]{64}$/;
function billingUserId(key) {
  const rec = Object.prototype.hasOwnProperty.call(users, key) ? users[key] : null;
  if (!rec) return null;
  if (typeof rec.billingId !== "string" || !BILLING_ID_RE.test(rec.billingId)) {
    rec.billingId = crypto.randomBytes(32).toString("hex");
    saveUsers();
  }
  return rec.billingId;
}
// Когда создан аккаунт (0 — неизвестно: старые аккаунты без createdAt).
function accountCreatedAt(key) {
  const rec = Object.prototype.hasOwnProperty.call(users, key) ? users[key] : null;
  return rec && Number.isFinite(rec.createdAt) ? rec.createdAt : 0;
}
function hasEntitlement(key, productId) {
  const rec = users[key];
  return !!(rec && rec.entitlements && rec.entitlements[productId]);
}
// Покупать незачем: товар уже есть или все его сценарии открыты другой
// покупкой (отдельный сценарий после набора «Все сценарии» и наоборот).
function ownsProduct(key, product) {
  if (hasEntitlement(key, product.id)) return true;
  const ids = Products.unlocksOf(product).scenarios;
  if (!ids.length) return false;
  const rec = users[key];
  if (!rec) return false;
  const own = ownedScenariosRec(rec, true);
  return ids.every((id) => own.includes(id));
}
function traderActive(username) {
  const key = usernameKey(username);
  return Object.prototype.hasOwnProperty.call(users, key) && traderActiveRec(users[key]);
}
// Разбор партии: с подпиской — без ограничений, без неё — один в сутки (по
// Москве). Повторное открытие разбора той же партии (gameKey) лимит не тратит.
const GAME_KEY_RE = /^[A-Za-z0-9:._-]{1,80}$/;
function claimAnalysisKey(key, gameKey) {
  const rec = Object.prototype.hasOwnProperty.call(users, key) ? users[key] : null;
  if (!rec) return { error: "Аккаунт не найден.", code: "session" };
  if (traderActiveRec(rec)) return { ok: true, trader: true };
  gameKey = String(gameKey || "");
  if (!GAME_KEY_RE.test(gameKey)) return { error: "Неизвестная партия.", code: "bad_game" };
  const day = mskDay(Date.now());
  const a = rec.analysis && typeof rec.analysis === "object" ? rec.analysis : {};
  if (a.day === day && a.game === gameKey) return { ok: true, again: true };
  if (a.day === day) return { error: "Бесплатный разбор на сегодня уже был. Без ограничений — с подпиской «Трейдер».", code: "analysis_limit" };
  rec.analysis = { day, game: gameKey };
  saveUsers();
  return { ok: true, profile: publicProfile(rec) };
}
// POST /api/analysis/claim — офлайн-партия: сам разбор считает клиент.
function claimAnalysis(username, password, token, gameKey) {
  const auth = authenticate(username, password, token);
  if (auth.error) return auth;
  return claimAnalysisKey(usernameKey(username), gameKey);
}
function analysisFreeTodayRec(rec) { return !(rec.analysis && rec.analysis.day === mskDay(Date.now())); }
function isPremium(key) {
  return isPremiumRec(users[key]);
}

// Начислить оплаченный заказ. Повторный вызов с тем же заказом ничего не
// делает (applied:false) — так сверка при старте безопасно повторяет выдачу.
function applyOrder(order) {
  const rec = order && users[order.user];
  if (!rec) return { error: "Аккаунт заказа не найден." };
  if (!Array.isArray(rec.purchases)) rec.purchases = [];
  if (rec.purchases.some((p) => p.orderId === order.id)) return { ok: true, applied: false, profile: publicProfile(rec) };
  const product = Products.byId(order.productId);
  if (!product) return { error: "Товар заказа не найден." };
  const at = order.grantedAt || Date.now();
  const points = Math.max(0, Math.round(product.points || 0));
  creditPoints(rec, points); // долг после прежнего возврата гасится первым
  // Подписка «Трейдер»: срок продлевается от более позднего — конца текущей
  // подписки или момента оплаты.
  const traderDays = Products.traderDaysOf(product);
  if (traderDays) rec.traderUntil = Math.max(at, traderUntilRec(rec)) + traderDays * DAY_MS;
  if (product.kind === "non-consumable") {
    if (!rec.entitlements || typeof rec.entitlements !== "object") rec.entitlements = {};
    // Уже есть по другому заказу (две оплаты наперегонки) — запись не трогаем:
    // при возврате одного из заказов товар останется за вторым (см. revokeOrder).
    if (!rec.entitlements[product.id]) rec.entitlements[product.id] = { at, orderId: order.id, provider: order.provider };
  }
  rec.purchases.push({ orderId: order.id, productId: product.id, provider: order.provider, at, points, test: !!order.test, refundedAt: null, debt: 0 });
  saveUsers();
  return { ok: true, applied: true, profile: publicProfile(rec) };
}

// Снять возвращённый заказ: списать начисленные очки (не ниже нуля — недостача
// пишется в debt покупки и копится в долге аккаунта pointsDebt, который гасят
// следующие начисления, см. creditPoints), убрать товар и вернуть стандартные
// скины, если экипированные стали недоступны. Повторный вызов ничего не делает.
function revokeOrder(order) {
  const rec = order && users[order.user];
  if (!rec || !Array.isArray(rec.purchases)) return { ok: true, revoked: false };
  const entry = rec.purchases.find((p) => p.orderId === order.id);
  if (!entry || entry.refundedAt) return { ok: true, revoked: false };
  rec.points = (rec.points || 0) - (entry.points || 0);
  if (rec.points < 0) {
    entry.debt = -rec.points;
    rec.pointsDebt = Math.max(0, Math.round(rec.pointsDebt || 0)) + entry.debt;
    rec.points = 0;
  }
  const refunded = Products.byId(entry.productId);
  const traderDays = Products.traderDaysOf(refunded);
  if (traderDays) rec.traderUntil = Math.max(0, traderUntilRec(rec) - traderDays * DAY_MS);
  const ent = rec.entitlements && rec.entitlements[entry.productId];
  if (ent && ent.orderId === order.id) {
    delete rec.entitlements[entry.productId];
    // Тот же товар оплачен ещё одним, не возвращённым заказом — он остаётся.
    const other = rec.purchases.filter((p) => p !== entry && p.productId === entry.productId && !p.refundedAt).pop();
    if (other) rec.entitlements[entry.productId] = { at: other.at, orderId: other.orderId, provider: other.provider };
  }
  entry.refundedAt = Date.now();
  if (!ownsSkin(rec, "boardSkin", rec.equippedBoardSkin || "default")) rec.equippedBoardSkin = "default";
  if (!ownsSkin(rec, "avatarPack", rec.equippedAvatarPack || "base")) rec.equippedAvatarPack = "base";
  if (rec.avatar && rec.avatar !== "PHOTO") {
    const owned = effectiveOwned(rec, "avatarPack");
    if (!Skins.AVATAR_PACKS.some((p) => owned.includes(p.id) && Skins.packHasAvatar(p, rec.avatar))) rec.avatar = "";
  }
  saveUsers();
  return { ok: true, revoked: true };
}

// ---------------------------------------------------------------------
// Лига недели. Неделя — с понедельника 00:00 по Москве. Очки лиги дают
// онлайн-партии, за которые положены очки рейтинга (не короче
// MIN_TURNS_FOR_POINTS, без исключения голосованием): по месту за столом, в
// партии с ботами — половина. Засчитанная партия тратит билет:
// LEAGUE_FREE_TICKETS бесплатных в сутки, сверх них — купленные за очки
// баланса (не сгорают). После недели лучшие получают очки баланса и титул
// (settleLeague), тройка призёров попадает в зал славы (DATA_DIR/league.json).
// ---------------------------------------------------------------------
const LEAGUE_FREE_TICKETS = 3;
const LEAGUE_TICKET_PRICE = 30;
const LEAGUE_PLACE_POINTS = [10, 6, 4, 2]; // 5-е место и ниже — 1
const LEAGUE_PRIZES = [500, 300, 200];      // 4–10 места — LEAGUE_PRIZE_REST
const LEAGUE_PRIZE_REST = 50;
const LEAGUE_PRIZE_PLACES = 10;
const LEAGUE_FILE = path.join(DATA_DIR, "league.json");
function leagueWeekOf(now) {
  const d = new Date(now + MSK_OFFSET_MS);
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return { key: new Date(monday).toISOString().slice(0, 10), endsAt: monday + 7 * DAY_MS - MSK_OFFSET_MS };
}
// Запись лиги на текущую неделю и день: новая неделя обнуляет очки (прошлая
// остаётся в prev до подведения итогов), новый день — бесплатные билеты.
function leagueRec(rec, now) {
  const wk = leagueWeekOf(now).key, day = mskDay(now);
  let L = rec.league && typeof rec.league === "object" ? rec.league : null;
  if (!L) L = rec.league = { week: wk, points: 0, games: 0, wins: 0, day, freeUsed: 0, extra: 0 };
  if (L.week !== wk) {
    if (L.games > 0) L.prev = { week: L.week, points: L.points, games: L.games, wins: L.wins };
    Object.assign(L, { week: wk, points: 0, games: 0, wins: 0 });
  }
  if (L.day !== day) { L.day = day; L.freeUsed = 0; }
  return L;
}
// То же без записи — для профиля и таблицы.
function leagueView(rec, now) {
  const wk = leagueWeekOf(now).key, day = mskDay(now);
  const L = rec && rec.league && typeof rec.league === "object" ? rec.league : {};
  const cur = L.week === wk;
  return {
    week: wk,
    points: cur ? L.points || 0 : 0, games: cur ? L.games || 0 : 0, wins: cur ? L.wins || 0 : 0,
    tickets: { free: Math.max(0, LEAGUE_FREE_TICKETS - (L.day === day ? L.freeUsed || 0 : 0)), extra: Math.max(0, L.extra || 0) },
  };
}
// Онлайн-партия закончилась: засчитать её игроку в лигу (server.js, settleRoomLeague).
function recordLeagueGame(username, place, withBots, now) {
  const key = usernameKey(username);
  const rec = Object.prototype.hasOwnProperty.call(users, key) ? users[key] : null;
  if (!rec) return null;
  now = now || Date.now();
  const L = leagueRec(rec, now);
  if (L.freeUsed < LEAGUE_FREE_TICKETS) L.freeUsed++;
  else if (L.extra > 0) L.extra--;
  else { saveUsers(); return { counted: false, code: "no_tickets" }; }
  const base = LEAGUE_PLACE_POINTS[place - 1] || 1;
  const points = withBots ? Math.ceil(base / 2) : base;
  L.points += points;
  L.games++;
  if (place === 1) L.wins++;
  saveUsers();
  return { counted: true, points, total: L.points, withBots: !!withBots, tickets: leagueView(rec, now).tickets };
}
// POST /api/league/ticket — билет лиги за очки баланса.
function buyLeagueTicket(username, password, token) {
  const auth = authenticate(username, password, token);
  if (auth.error) return auth;
  const rec = auth.rec;
  if ((rec.points || 0) < LEAGUE_TICKET_PRICE) return { error: `Нужно ${LEAGUE_TICKET_PRICE} очков.`, code: "no_points" };
  rec.points -= LEAGUE_TICKET_PRICE;
  const L = leagueRec(rec, Date.now());
  L.extra = (L.extra || 0) + 1;
  saveUsers();
  return { ok: true, user: publicProfile(rec) };
}
function loadLeagueFile() {
  try {
    const d = JSON.parse(fs.readFileSync(LEAGUE_FILE, "utf8"));
    if (d && Array.isArray(d.settled) && Array.isArray(d.hall)) return d;
  } catch (e) {}
  return { v: 1, settled: [], hall: [] };
}
let leagueFile = null;
function saveLeagueFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = LEAGUE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(leagueFile, null, 2), "utf8");
  fs.renameSync(tmp, LEAGUE_FILE);
}
function leagueRows(weekKey) {
  const rows = [];
  for (const rec of Object.values(users)) {
    if (!rec) continue;
    const L = rec.league;
    const e = L && L.week === weekKey && L.games > 0 ? L : L && L.prev && L.prev.week === weekKey ? L.prev : null;
    if (e) rows.push({ rec, points: e.points || 0, games: e.games || 0, wins: e.wins || 0 });
  }
  return rows.sort((a, b) => b.points - a.points || b.wins - a.wins || a.games - b.games || a.rec.username.localeCompare(b.rec.username));
}
// Итоги прошлой недели — один раз (вызывает server.js раз в 30 с и таблица).
function settleLeague(now) {
  now = now || Date.now();
  if (!leagueFile) leagueFile = loadLeagueFile();
  const prevKey = leagueWeekOf(now - 7 * DAY_MS).key;
  if (leagueFile.settled.includes(prevKey)) return false;
  const rows = leagueRows(prevKey);
  rows.slice(0, LEAGUE_PRIZE_PLACES).forEach((r, i) => {
    const prize = LEAGUE_PRIZES[i] || LEAGUE_PRIZE_REST;
    creditPoints(r.rec, prize);
    if (!Array.isArray(r.rec.leagueTitles)) r.rec.leagueTitles = [];
    r.rec.leagueTitles.push({ week: prevKey, place: i + 1 });
    r.rec.leagueAward = { week: prevKey, place: i + 1, prize };
  });
  if (rows.length) leagueFile.hall.unshift({ week: prevKey, top: rows.slice(0, 3).map((r, i) => ({ username: r.rec.username, points: r.points, place: i + 1 })) });
  leagueFile.hall = leagueFile.hall.slice(0, 12);
  leagueFile.settled = [prevKey].concat(leagueFile.settled).slice(0, 30);
  saveLeagueFile();
  if (rows.length) saveUsers();
  return true;
}
function leagueTitleCounts(rec) {
  const t = Array.isArray(rec.leagueTitles) ? rec.leagueTitles : [];
  return { champion: t.filter((x) => x.place === 1).length, podium: t.filter((x) => x.place <= 3).length };
}
// GET /api/league — таблица недели, своё место, зал славы и правила.
function leagueTable(now, viewerKey) {
  now = now || Date.now();
  settleLeague(now);
  const wk = leagueWeekOf(now);
  const rows = leagueRows(wk.key);
  const entry = (r, i) => {
    const { avatar, photo } = safeAvatar(r.rec);
    return { place: i + 1, username: r.rec.username, avatar, avatarPhoto: photo, points: r.points, games: r.games, wins: r.wins, titles: leagueTitleCounts(r.rec) };
  };
  const viewer = viewerKey && Object.prototype.hasOwnProperty.call(users, viewerKey) ? users[viewerKey] : null;
  const myIdx = viewer ? rows.findIndex((r) => r.rec === viewer) : -1;
  return {
    week: wk.key, endsAt: wk.endsAt, players: rows.length,
    top: rows.slice(0, 50).map(entry),
    me: viewer ? Object.assign(leagueView(viewer, now), { place: myIdx >= 0 ? myIdx + 1 : null }) : null,
    hall: (leagueFile ? leagueFile.hall : []).slice(0, 6),
    rules: { freeTickets: LEAGUE_FREE_TICKETS, ticketPrice: LEAGUE_TICKET_PRICE, placePoints: LEAGUE_PLACE_POINTS, prizes: LEAGUE_PRIZES, prizeRest: LEAGUE_PRIZE_REST, prizePlaces: LEAGUE_PRIZE_PLACES },
  };
}

// Видео с наградой: дневной лимит и пауза. Сутки — по Москве (сброс в 00:00 МСК).
const MSK_OFFSET_MS = 3 * 3600e3;
function mskDay(now) { return new Date(now + MSK_OFFSET_MS).toISOString().slice(0, 10); }
function nextMskMidnight(now) { return (Math.floor((now + MSK_OFFSET_MS) / 86400e3) + 1) * 86400e3 - MSK_OFFSET_MS; }
// Счётчик за сегодня; пауза после последнего видео переживает полночь.
function adState(rec, now) {
  const a = rec.adRewards && typeof rec.adRewards === "object" ? rec.adRewards : {};
  const lastAt = Number(a.lastAt) || 0;
  const day = mskDay(now);
  return { day, count: a.day === day ? Number(a.count) || 0 : 0, lastAt };
}
// nextAt — когда можно смотреть следующее видео (0 — уже можно).
function adNextAt(st, cap, cooldownMs, now) {
  if (st.count >= cap) return nextMskMidnight(now);
  const t = st.lastAt + cooldownMs;
  return cooldownMs > 0 && t > now ? t : 0;
}
function adStatus(key, opts) {
  const now = opts.now || Date.now();
  const rec = users[key];
  if (!rec) return { count: 0, cap: opts.cap, nextAt: 0 };
  const st = adState(rec, now);
  return { count: st.count, cap: opts.cap, nextAt: adNextAt(st, opts.cap, opts.cooldownMs || 0, now) };
}
// Отказ по лимиту или паузе ({error, code, nextAt}) либо null. ads.js проверяет
// это заранее, при выдаче билета — чтобы не показывать видео впустую.
function adRewardBlock(key, opts) {
  const now = opts.now || Date.now();
  const rec = users[key];
  if (!rec) return { error: "Аккаунт не найден.", code: "auth_required" };
  const st = adState(rec, now);
  const cooldownMs = opts.cooldownMs || 0;
  if (st.count >= opts.cap) return { error: "На сегодня видео закончились — приходите завтра.", code: "ads_cap", nextAt: nextMskMidnight(now) };
  if (cooldownMs > 0 && now - st.lastAt < cooldownMs) {
    const nextAt = st.lastAt + cooldownMs;
    return { error: `Следующее видео — через ${Math.max(1, Math.ceil((nextAt - now) / 60000))} мин.`, code: "ads_cooldown", nextAt };
  }
  return null;
}
function claimAdReward(key, opts) {
  const now = opts.now || Date.now();
  const block = adRewardBlock(key, Object.assign({}, opts, { now }));
  if (block) return block;
  const rec = users[key];
  const st = adState(rec, now);
  const n = Math.max(0, Math.round(opts.points || 0));
  creditPoints(rec, n); // рейтинг не трогаем; долг после возврата гасится первым
  st.count++;
  st.lastAt = now;
  rec.adRewards = st;
  saveUsers();
  return { ok: true, points: n, today: { count: st.count, cap: opts.cap, nextAt: adNextAt(st, opts.cap, opts.cooldownMs || 0, now) }, profile: publicProfile(rec) };
}

// Всё о покупках аккаунта — для GET /api/shop/entitlements.
function accountShopInfo(key) {
  const rec = users[key];
  if (!rec) return null;
  const entitlements = {};
  for (const [id, e] of Object.entries(rec.entitlements || {})) entitlements[id] = { at: e && e.at, provider: e && e.provider };
  const purchases = (Array.isArray(rec.purchases) ? rec.purchases : []).slice(-20).reverse()
    .map((p) => ({ orderId: p.orderId, productId: p.productId, provider: p.provider, at: p.at, points: p.points, test: !!p.test, refundedAt: p.refundedAt || null }));
  return {
    rating: rec.rating || 0,
    points: rec.points || 0,
    // Долг после возврата платежа: новые очки сначала гасят его (магазин покажет).
    pointsDebt: Math.max(0, Math.round(rec.pointsDebt || 0)),
    premium: isPremiumRec(rec),
    entitlements,
    ownedAvatarPacks: effectiveOwned(rec, "avatarPack"),
    ownedBoardSkins: effectiveOwned(rec, "boardSkin"),
    purchases,
  };
}

module.exports = {
  DATA_DIR, getPhoto, photoUrl, usernameKey,
  register, login, addPoints, publicProfile, getLeaderboard,
  updateProfile, changePassword, setPhoto, buySkin, equipSkin,
  createSession, loginWithToken, invalidateSession,
  authAccount, accountByToken, billingUserId, accountCreatedAt, hasEntitlement, ownsProduct, isPremium, ownsScenario, traderActive, claimAnalysis, claimAnalysisKey,
  recordLeagueGame, buyLeagueTicket, leagueTable, settleLeague, leagueWeekOf,
  applyOrder, revokeOrder, claimAdReward, adStatus, adRewardBlock, accountShopInfo,
};
