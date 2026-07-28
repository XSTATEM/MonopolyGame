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

const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const MAX_PHOTO_LEN = 400000; // ~300KB исходника после base64 — клиент обязан ужать фото перед отправкой

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch (e) {
    return {};
  }
}
function saveUsers() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), "utf8");
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
function createSession(username) {
  const key = usernameKey(username);
  const rec = users[key];
  if (!rec) return null;
  rec.sessionToken = crypto.randomBytes(24).toString("hex");
  rec.sessionTokenCreatedAt = Date.now();
  saveUsers();
  return rec.sessionToken;
}

function loginWithToken(token) {
  token = String(token || "");
  if (!token) return { error: "Сессия недействительна — войдите заново." };
  const rec = Object.values(users).find((r) => r.sessionToken && r.sessionToken === token);
  if (!rec) return { error: "Сессия недействительна — войдите заново." };
  return { ok: true, user: publicProfile(rec) };
}

function invalidateSession(username, token) {
  const key = usernameKey(username);
  const rec = users[key];
  if (rec && rec.sessionToken === token) { rec.sessionToken = null; saveUsers(); }
  return { ok: true };
}

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function publicProfile(rec) {
  return {
    username: rec.username,
    gender: rec.gender || "",
    avatar: rec.avatar || "",
    avatarPhoto: rec.avatarPhoto || null,
    points: rec.points || 0,
    ownedAvatarPacks: rec.ownedAvatarPacks || ["base"],
    ownedBoardSkins: rec.ownedBoardSkins || ["default"],
    equippedAvatarPack: rec.equippedAvatarPack || "base",
    equippedBoardSkin: rec.equippedBoardSkin || "default",
  };
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
    avatar: String(avatar || "").trim().slice(0, 8),
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
  if (!rec) return { error: "Аккаунт с таким ником не найден. Проверьте ник или зарегистрируйтесь." };
  const { hash } = hashPassword(String(password || ""), rec.salt);
  if (hash !== rec.hash) return { error: "Неверный пароль." };
  const sessionToken = createSession(username);
  return { ok: true, user: publicProfile(rec), sessionToken };
}

// Общий помощник: проверяет пароль (или токен сессии из куки, если пароля
// под рукой нет — например, вкладка была просто перезагружена) и возвращает
// запись пользователя или {error}.
function authenticate(username, password, token) {
  const key = usernameKey(username);
  const rec = users[key];
  if (!rec) return { error: "Аккаунт не найден." };
  if (!password && token && rec.sessionToken && rec.sessionToken === token) return { ok: true, rec };
  const { hash } = hashPassword(String(password || ""), rec.salt);
  if (hash !== rec.hash) return { error: "Неверный пароль." };
  return { ok: true, rec };
}

function addPoints(username, amount) {
  const key = usernameKey(username);
  const rec = users[key];
  if (!rec) return null;
  rec.points = (rec.points || 0) + amount;
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

function changePassword(username, password, newPassword, token) {
  const auth = authenticate(username, password, token);
  if (auth.error) return auth;
  newPassword = String(newPassword || "");
  if (newPassword.length < 4) return { error: "Новый пароль должен быть не короче 4 символов." };
  const rec = auth.rec;
  const { salt, hash } = hashPassword(newPassword);
  rec.salt = salt; rec.hash = hash;
  saveUsers();
  return { ok: true };
}

function setPhoto(username, password, photoDataUrl, token) {
  const auth = authenticate(username, password, token);
  if (auth.error) return auth;
  photoDataUrl = String(photoDataUrl || "");
  if (!/^data:image\/(png|jpeg|jpg|webp);base64,/.test(photoDataUrl)) return { error: "Неверный формат изображения." };
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
  register, login, addPoints, publicProfile, getLeaderboard,
  updateProfile, changePassword, setPhoto, buySkin, equipSkin,
  createSession, loginWithToken, invalidateSession,
};
