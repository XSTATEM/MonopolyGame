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

  // Базовый пак аватарок бесплатный и доступен всем всегда (см. AVATAR_SET в index.html).
  const AVATAR_PACKS = [
    { id: "base", name: "Базовый", cost: 0, emojis: ["🧑","👩","👨","🧔","👩‍🦱","👨‍🦱","🧕","👳","🦸","🧙","🥷","🐱","🐶","🦊","🐼","🐸"] },
    { id: "legend", name: "Легенда", cost: 300, emojis: ["🐉","🦄","👽","🤖","👻","🧞‍♂️","🧜‍♀️","🧙‍♂️"] },
    { id: "vip", name: "VIP", cost: 600, emojis: ["👑","🎩","🕶️","🦹‍♂️","🦹‍♀️","🥷","🧛‍♂️","💎"] },
    { id: "bulls", name: "Быки и медведи", cost: 0, premium: true, emojis: ["🐂","🐻","🦈","🦅","🐺","🦁","💼","📈"] },
    { id: "wallstreet", name: "Уолл-стрит", cost: 0, set: "tm_set_wallstreet", emojis: ["🗽","🏦","💹","💵","🪙","📊","💰","🧾"] },
  ];

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

  return { AVATAR_PACKS, BOARD_SKINS, avatarPackById, boardSkinById };
});
