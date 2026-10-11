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

const users = loadUsers(); // usernameKey -> {username, salt, hash, gender, avatar, points, createdAt}

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
  return avatar === "" || avatar === "PHOTO" || Skins.AVATAR_PACKS.some((p) => p.emojis.includes(avatar));
}

function publicProfile(rec) {
  // Проверяем и при выдаче: в users.json могли остаться значения, сохранённые
  // до появления строгих проверок.
  const photo = rec.avatarPhoto && PHOTO_RE.test(rec.avatarPhoto) ? rec.avatarPhoto : null;
  const avatar = rec.avatar && isAllowedAvatar(rec.avatar) && (rec.avatar !== "PHOTO" || photo) ? rec.avatar : "";
  return {
    username: rec.username,
    gender: rec.gender || "",
    avatar,
    avatarPhoto: photo,
    points: rec.points || 0,
    ownedAvatarPacks: rec.ownedAvatarPacks || ["base"],
    ownedBoardSkins: rec.ownedBoardSkins || ["default"],
    equippedAvatarPack: rec.equippedAvatarPack || "base",
    equippedBoardSkin: rec.equippedBoardSkin || "default",
  };
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
    avatar: (() => { const a = String(avatar || "").trim().slice(0, 8); const base = Skins.avatarPackById("base"); return base && base.emojis.includes(a) ? a : ""; })(),
    avatarPhoto: null,
    points: 0,
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

function addPoints(username, amount) {
  const key = usernameKey(username);
  const rec = users[key];
  if (!rec) return null;
  // Страховка: нечисловые или бесконечные суммы не должны попасть в users.json.
  if (!Number.isFinite(amount) || amount <= 0) return rec.points || 0;
  rec.points = (rec.points || 0) + Math.round(amount);
  saveUsers();
  return rec.points;
}

function getLeaderboard(limit) {
  return Object.values(users)
    .map(publicProfile)
    .sort((a, b) => b.points - a.points)
    .slice(0, limit || 50);
}

function updateProfile(username, password, gender, avatar, token) {
  const auth = authenticate(username, password, token);
  if (auth.error) return auth;
  const rec = auth.rec;
  if (gender != null) rec.gender = String(gender || "").trim().slice(0, 24);
  if (avatar != null) {
    avatar = String(avatar || "").trim().slice(0, 8);
    // "PHOTO" — зарезервированное значение: показывать avatarPhoto вместо эмодзи.
    if (avatar !== "PHOTO") {
      const owned = rec.ownedAvatarPacks || ["base"];
      const allowed = Skins.AVATAR_PACKS.filter((p) => owned.includes(p.id)).some((p) => p.emojis.includes(avatar));
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
  if (rec[ownedKey].includes(skinId)) return { error: "Этот скин уже куплен." };
  if ((rec.points || 0) < skin.cost) return { error: "Недостаточно очков рейтинга." };
  rec.points -= skin.cost;
  rec[ownedKey].push(skinId);
  saveUsers();
  return { ok: true, user: publicProfile(rec) };
}

function equipSkin(username, password, skinId, kind, token) {
  const auth = authenticate(username, password, token);
  if (auth.error) return auth;
  const rec = auth.rec;
  const ownedKey = kind === "boardSkin" ? "ownedBoardSkins" : kind === "avatarPack" ? "ownedAvatarPacks" : null;
  if (!ownedKey) return { error: "Неизвестный тип скина." };
  const owned = rec[ownedKey] || (kind === "boardSkin" ? ["default"] : ["base"]);
  if (!owned.includes(skinId)) return { error: "Этот скин ещё не куплен." };
  if (kind === "boardSkin") rec.equippedBoardSkin = skinId; else rec.equippedAvatarPack = skinId;
  saveUsers();
  return { ok: true, user: publicProfile(rec) };
}

module.exports = {
  DATA_DIR, getPhoto, photoUrl,
  register, login, addPoints, publicProfile, getLeaderboard,
  updateProfile, changePassword, setPhoto, buySkin, equipSkin,
  createSession, loginWithToken, invalidateSession,
};
