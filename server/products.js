// ---------------------------------------------------------------------
// Каталог платных товаров магазина. Цены в рублях живут только здесь:
// клиент присылает лишь id товара, а сумму платежа ЮKassa сервер берёт
// отсюда. Цены RuStore и Google Play задаются в их консолях — с теми же id
// (строчная латиница, цифры и «_»: такие id принимают оба магазина).
// ---------------------------------------------------------------------
"use strict";

// kind: "consumable" — можно покупать снова (очки); "non-consumable" —
// покупается один раз и навсегда остаётся на аккаунте.
// points — сколько очков баланса начислить; premium — товар включает Премиум;
// unlocks — скины из skins.js, которые открывает покупка.
const PRODUCTS = [
  { id: "tm_points_300", kind: "consumable", enabled: true, rub: 99, points: 300,
    title: "300 очков", subtitle: "Хватит на аватар-пак «Легенда» или тему стола" },
  { id: "tm_points_700", kind: "consumable", enabled: true, rub: 199, points: 700,
    title: "700 очков", subtitle: "Бонус +17%" },
  { id: "tm_points_1600", kind: "consumable", enabled: true, rub: 399, points: 1600,
    title: "1600 очков", subtitle: "Бонус +34%" },
  // Включить, когда скинов в каталоге станет больше чем на 3000 очков.
  { id: "tm_points_4500", kind: "consumable", enabled: false, rub: 990, points: 4500,
    title: "4500 очков", subtitle: "Бонус +52%" },
  { id: "tm_premium", kind: "non-consumable", enabled: true, rub: 449, points: 300, premium: true,
    title: "Премиум", subtitle: "Все скины, эксклюзивные темы, корона в рейтинге, вдвое больше видео с наградой и +300 очков" },
  { id: "tm_set_wallstreet", kind: "non-consumable", enabled: true, rub: 149, points: 0,
    unlocks: { avatarPacks: ["wallstreet"], boardSkins: ["wallstreet"] },
    title: "Набор «Уолл-стрит»", subtitle: "Тема стола и 8 аватаров — только в этом наборе" },
  // Сценарии рынка (engine.js, SCENARIOS). «Пузырь доткомов» бесплатный.
  { id: "tm_scn_crisis2008", kind: "non-consumable", enabled: true, rub: 149, points: 0,
    unlocks: { scenarios: ["crisis2008"] },
    title: "Сценарий «Кризис 2008»", subtitle: "Банкротство инвестбанка и паника на рынках — переживите обвал" },
  { id: "tm_scn_rumarket", kind: "non-consumable", enabled: true, rub: 149, points: 0,
    unlocks: { scenarios: ["rumarket"] },
    title: "Сценарий «Российский рынок»", subtitle: "Ставка ЦБ, дивиденды, девальвация и удары по отдельным компаниям" },
  { id: "tm_scn_commodity", kind: "non-consumable", enabled: true, rub: 149, points: 0,
    unlocks: { scenarios: ["commodity"] },
    title: "Сценарий «Сырьевой суперцикл»", subtitle: "Нефть по $150 и коллапс сырья — поймайте разворот" },
  { id: "tm_scn_all", kind: "non-consumable", enabled: true, rub: 349, points: 0,
    unlocks: { scenarios: ["crisis2008", "rumarket", "commodity"] },
    title: "Все сценарии", subtitle: "Три платных сценария дешевле, чем по отдельности" },
];

// Что входит в Премиум — для витрины магазина (порядок = порядок в списке).
const PREMIUM_BENEFITS = [
  "Все скины за очки — сейчас и в будущем",
  "Темы «Золото биржи» и «Неон», аватары «Быки и медведи»",
  "Корона рядом с ником в рейтинге",
  "Вдвое больше видео с наградой в день",
  "+300 очков сразу",
];

function byId(id) { return PRODUCTS.find((p) => p.id === id) || null; }
// id товара у провайдера. Сейчас везде совпадает с нашим; поле store
// ({rustore, googleplay}) у товара — на случай, если в консоли id придётся сменить.
function storeId(product, provider) { return (product.store && product.store[provider]) || product.id; }
function byStoreId(provider, sid) { return PRODUCTS.find((p) => storeId(p, provider) === sid) || null; }
// Сумма для ЮKassa: строка с двумя знаками после точки, как в API ("99.00").
function rubValue(product) { return product.rub.toFixed(2); }
function rubText(product) { return product.rub + " ₽"; }
function unlocksOf(product) {
  const u = product.unlocks || {};
  return { avatarPacks: (u.avatarPacks || []).slice(), boardSkins: (u.boardSkins || []).slice(), scenarios: (u.scenarios || []).slice() };
}

module.exports = { PRODUCTS, PREMIUM_BENEFITS, byId, storeId, byStoreId, rubValue, rubText, unlocksOf };
