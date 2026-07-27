// ---------------------------------------------------------------------
// Простое файловое хранилище аккаунтов игроков (ник + пароль).
// Никакой внешней БД — только локальный JSON-файл на диске сервера.
// Пароли никогда не хранятся и не передаются в открытом виде: только
// scrypt-хэш с индивидуальной солью на пользователя.
// ---------------------------------------------------------------------
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");

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

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function publicProfile(rec) {
  return { username: rec.username, gender: rec.gender || "", avatar: rec.avatar || "", points: rec.points || 0 };
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
    points: 0,
    createdAt: Date.now(),
  };
  users[key] = rec;
  saveUsers();
  return { ok: true, user: publicProfile(rec) };
}

function login(username, password) {
  const key = usernameKey(username);
  const rec = users[key];
  if (!rec) return { error: "Аккаунт с таким ником не найден. Проверьте ник или зарегистрируйтесь." };
  const { hash } = hashPassword(String(password || ""), rec.salt);
  if (hash !== rec.hash) return { error: "Неверный пароль." };
  return { ok: true, user: publicProfile(rec) };
}

function addPoints(username, amount) {
  const key = usernameKey(username);
  const rec = users[key];
  if (!rec) return null;
  rec.points = (rec.points || 0) + amount;
  saveUsers();
  return rec.points;
}

module.exports = { register, login, addPoints, publicProfile };
