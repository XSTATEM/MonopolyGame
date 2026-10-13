// ---------------------------------------------------------------------
// Trade Monopoly — каталог скинов (аватар-паки и цветовые темы стола).
// Общий модуль без сети/DOM — используется и сервером (server.js, чтобы
// проверять цену/владение при покупке) и браузером (index.html, магазин
// и применение экипированной темы). Сами скины не имеют логики, только
// статичные данные: id, название, цена в очках (баланс), превью.
// premium: true — скин только для Премиума; set: "<id товара>" — только в
// платном наборе (server/products.js). У таких скинов cost: 0, за очки они
// не продаются: владение вычисляет сервер по покупкам (users.js, effectiveOwned).
// ---------------------------------------------------------------------
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Skins = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Аватарки — контурные значки (в клиенте символы i-av-<id> спрайта), не эмодзи.
  // Базовый пак бесплатный и доступен всем всегда.
  const AVATAR_PACKS = [
    { id: "base", name: "Базовый", cost: 0, avatars: ["rocket", "sun", "anchor", "mountain", "flower", "compass", "feather", "key", "zap", "star", "swords", "cat", "dog", "squirrel", "rabbit", "turtle"] },
    { id: "legend", name: "Легенда", cost: 300, avatars: ["flame", "sparkles", "orbit", "cpu", "ghost", "castle", "shell", "wand"] },
    { id: "vip", name: "VIP", cost: 600, avatars: ["crown", "trophy", "glasses", "mask", "drama", "skull", "moon", "gem"] },
    { id: "bulls", name: "Быки и медведи", cost: 0, premium: true, avatars: ["bull", "bear", "fish", "bird", "paw", "shield", "briefcase", "trend"] },
    { id: "wallstreet", name: "Уолл-стрит", cost: 0, set: "tm_set_wallstreet", avatars: ["tower", "bank", "candles", "cash", "coins", "bars", "piggy", "receipt"] },
  ];
  const AVATAR_NAMES = { rocket: "Ракета", sun: "Солнце", anchor: "Якорь", mountain: "Гора", flower: "Цветок", compass: "Компас", feather: "Перо", key: "Ключ", zap: "Молния", star: "Звезда", swords: "Мечи", cat: "Кот", dog: "Пёс", squirrel: "Белка", rabbit: "Кролик", turtle: "Черепаха", flame: "Пламя", sparkles: "Искры", orbit: "Орбита", cpu: "Процессор", ghost: "Призрак", castle: "Замок", shell: "Раковина", wand: "Волшебная палочка", crown: "Корона", trophy: "Кубок", glasses: "Очки", mask: "Маска", drama: "Театр", skull: "Череп", moon: "Луна", gem: "Бриллиант", bull: "Бык", bear: "Медведь", fish: "Акула", bird: "Орёл", paw: "Волк", shield: "Щит", briefcase: "Портфель", trend: "Рост", tower: "Небоскрёб", bank: "Банк", candles: "Свечи", cash: "Купюры", coins: "Монеты", bars: "Столбцы", piggy: "Копилка", receipt: "Чек" };
  // До значков аватарки были эмодзи: сохранённые профили, комнаты и клиенты
  // прежних версий присылают их — каждой своя замена из того же пака.
  const LEGACY_AVATARS = { "\u{1F9D1}": "rocket", "\u{1F469}": "sun", "\u{1F468}": "anchor", "\u{1F9D4}": "mountain", "\u{1F469}\u{200D}\u{1F9B1}": "flower", "\u{1F468}\u{200D}\u{1F9B1}": "compass", "\u{1F9D5}": "feather", "\u{1F473}": "key", "\u{1F9B8}": "zap", "\u{1F9D9}": "star", "\u{1F977}": "swords", "\u{1F431}": "cat", "\u{1F436}": "dog", "\u{1F98A}": "squirrel", "\u{1F43C}": "rabbit", "\u{1F438}": "turtle", "\u{1F409}": "flame", "\u{1F984}": "sparkles", "\u{1F47D}": "orbit", "\u{1F916}": "cpu", "\u{1F47B}": "ghost", "\u{1F9DE}\u{200D}\u{2642}\u{FE0F}": "castle", "\u{1F9DC}\u{200D}\u{2640}\u{FE0F}": "shell", "\u{1F9D9}\u{200D}\u{2642}\u{FE0F}": "wand", "\u{1F451}": "crown", "\u{1F3A9}": "trophy", "\u{1F576}\u{FE0F}": "glasses", "\u{1F9B9}\u{200D}\u{2642}\u{FE0F}": "mask", "\u{1F9B9}\u{200D}\u{2640}\u{FE0F}": "drama", "\u{1F9DB}\u{200D}\u{2642}\u{FE0F}": "moon", "\u{1F48E}": "gem", "\u{1F402}": "bull", "\u{1F43B}": "bear", "\u{1F988}": "fish", "\u{1F985}": "bird", "\u{1F43A}": "paw", "\u{1F981}": "shield", "\u{1F4BC}": "briefcase", "\u{1F4C8}": "trend", "\u{1F5FD}": "tower", "\u{1F3E6}": "bank", "\u{1F4B9}": "candles", "\u{1F4B5}": "cash", "\u{1FA99}": "coins", "\u{1F4CA}": "bars", "\u{1F4B0}": "piggy", "\u{1F9FE}": "receipt" };
  // Значение аватарки → id значка ("" — нет такой; "PHOTO" — фото профиля).
  function avatarId(v) {
    v = String(v || "");
    if (v === "PHOTO") return v;
    if (AVATAR_NAMES[v]) return v;
    return LEGACY_AVATARS[v] || LEGACY_AVATARS[v.replace(/\uFE0F/g, "")] || "";
  }
  function packHasAvatar(pack, v) { return !!pack && pack.avatars.includes(avatarId(v)); }

  // Темы стола переопределяют градиент игрового стола (.theme-* классы на <body>
  // в index.html) — три цветовые точки радиального градиента + акцент рамок/подсветки.
  const BOARD_SKINS = [
    { id: "default", name: "Тёмный дуб", cost: 0, cls: "", stage: ["#4a3323", "#241a12", "#140e09"], accent: "#8fd6ac" },
    { id: "emerald", name: "Изумруд", cost: 200, cls: "theme-emerald", stage: ["#1f4a3a", "#0e2119", "#081410"], accent: "#4fe3a8" },
    { id: "midnight", name: "Полночь", cost: 200, cls: "theme-midnight", stage: ["#2a2f5c", "#141733", "#0a0b1c"], accent: "#8fa8ff" },
    { id: "royal", name: "Королевский", cost: 400, cls: "theme-royal", stage: ["#5c2438", "#2b0f1b", "#170810"], accent: "#e3b34f" },
    { id: "gold", name: "Золото биржи", cost: 0, premium: true, cls: "theme-gold", stage: ["#5c4a1e", "#2b200b", "#171006"], accent: "#f2c94c" },
    { id: "neon", name: "Неон", cost: 0, premium: true, cls: "theme-neon", stage: ["#1b2a4a", "#0c1222", "#05080f"], accent: "#39e6ff" },
    { id: "wallstreet", name: "Уолл-стрит", cost: 0, set: "tm_set_wallstreet", cls: "theme-wallstreet", stage: ["#1f3b2c", "#0f1e16", "#08110c"], accent: "#c9a45c" },
  ];

  function avatarPackById(id) { return AVATAR_PACKS.find((p) => p.id === id); }
  function boardSkinById(id) { return BOARD_SKINS.find((s) => s.id === id); }

  return { AVATAR_PACKS, AVATAR_NAMES, LEGACY_AVATARS, avatarId, packHasAvatar, BOARD_SKINS, avatarPackById, boardSkinById };
});
