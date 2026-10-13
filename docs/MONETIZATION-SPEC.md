# Монетизация и новое главное меню — спецификация для реализации

Версия 1 от 12.10.2026. Это единственный источник правды для всех, кто реализует магазин, рекламу,
сборки APK для магазинов и новое главное меню. Если код и этот документ расходятся, правится то,
что неверно, и документ обновляется в том же изменении.

Решения владельца (12.10.2026): реклама с вознаграждением (видео → очки), платные скины и пакеты очков,
разовый «Премиум»; провайдеры — ЮKassa (карты/СБП на сайте и в приложении), Рекламная сеть Яндекса
(Android), RuStore Pay (сборка для RuStore), Google Play Billing + AdMob (международная сборка).
Аккаунты и ключи владелец получает сам. Всё выключено и невидимо, пока не настроено.

---------------------------------------------------------------------------------------------------

## 0. Принципы, решения, карта работ

### 0.1. Жёсткие правила (нарушение = ошибка ревью)

1. **Без ключей игра работает как сейчас.** Ни одной новой кнопки, экрана, запроса к провайдеру,
   нативного SDK или разрешения Android, пока соответствующая настройка не задана. Сборка APK по
   умолчанию (push в любую ветку) идёт теми же шагами, что сегодня, и даёт тот же набор плагинов.
2. **Секреты** — только в окружении сервера (`/etc/birzha.env`, файлы в `/etc/birzha/` или `DATA_DIR`)
   и в секретах GitHub. Никогда в репозитории, в ответах API, в логах (логируем только префикс хеша).
3. **Клиенту не доверяем.** Цена ЮKassa берётся из серверного каталога, выдача — только после проверки
   у провайдера (повторный запрос к API провайдера), один платёж выдаётся ровно один раз.
4. **Без pay-to-win.** За деньги и рекламу — только косметика и очки-валюта. Рейтинг (место в таблице),
   наличные в партии, акции, репутация, кредиты, броски, шпионаж и т. п. не продаются.
5. **Код** — в стиле проекта: без фреймворков и новых npm-зависимостей на сервере (только `node:*`
   и глобальный `fetch`), русские комментарии той же плотности, `escapeHtml` для любого текста
   пользователя и провайдера в HTML, тексты интерфейса на русском.
6. **Не трогать** (их правит другой поток работ): `server/public/engine.js`, селект длительности в
   `#offlineSetup` (`#offlineMaxRounds` — только чтение), `renderLobby`, `rollPopupHtml`, экран
   `#rulesScreen`, `rules.md`. Перед каждой правкой перечитывать нужный кусок файла; правки — точечные.

### 0.2. Принятые решения

| № | Решение | Почему |
|---|---|---|
| Р1 | Очки делятся на **рейтинг** (`rating`, только победы, таблица лидеров) и **баланс** (`points`, тратится на скины). Покупки, реклама и бонус Премиума пополняют **только баланс**. | Иначе деньги покупают место в рейтинге. Владелец говорил «видео → очки рейтинга» — реализуем как очки баланса, рейтинг не продаётся. **Требует подтверждения владельца** (см. §15). |
| Р2 | Миграция: `rating = points` для существующих аккаунтов. | Таблица лидеров в момент обновления не меняется ни у кого. |
| Р3 | Один и тот же id товара у всех провайдеров (`tm_points_300` и т. д.). | Проще консоли и проверка. |
| Р4 | ЮKassa — redirect-оплата, `capture:true`, без `receipt` по умолчанию. | Работает одинаково на сайте и в приложении; самозанятым чеки через ЮKassa недоступны. |
| Р5 | Google Play — `@capgo/native-purchases@8.8.1` (точная версия), подтверждение/списание покупки делает сервер. | 8.9.x вышли меньше двух недель назад; 8.8.1 (22.09.2026) уже имеет нужный API. |
| Р6 | RuStore — свой маленький Java-плагин на RuStore Pay SDK (BOM `2026.08.01`). | Официального плагина Capacitor нет, сторонний Cordova-плагин ненадёжен. |
| Р7 | Яндекс — серверной проверки награды нет (проверено по ads.yandex.com 12.10.2026): одноразовый билет + лимиты. AdMob — подписанный серверный колбэк (SSV). | Подделка клиента у Яндекса ограничена дневным лимитом. |
| Р8 | На сайте рекламы в v1 нет. | Web-формат РСЯ «Rewarded» включается через поддержку РСЯ — позже. |
| Р9 | Сборки для магазинов — только ручным запуском workflow с выбором `store`. Push всегда собирает `direct`. | Ссылка на APK в Releases и поведение push не меняются. |

### 0.3. Карта файлов и пакеты работ

Пакеты можно делать параллельно; П2 и П3 правят `index.html` и `styles.css` в **разных** местах
(П3 — только блок `#mainMenu` и его CSS, П2 — всё остальное), поэтому правки должны быть точечными.

| Пакет | Файлы | Что |
|---|---|---|
| П1 Сервер | `server/products.js` (новый), `server/payments.js` (новый), `server/ads.js` (новый), `server/users.js`, `server/server.js`, `server/public/pay-return.html` (новый), `server/test/shop.test.js` (новый), `server/test/run-all.js` | каталог, заказы, провайдеры, реклама, API, тесты |
| П2 Клиент | `server/public/shop.js` (новый), `server/public/index.html` (экран магазина, точки входа, скины, рейтинг, аккаунт), `server/public/styles.css` (магазин, темы стола), `server/public/skins.js`, `server/public/native.js`, `server/public/sw.js` | магазин, мост к нативу |
| П3 Меню | `server/public/index.html` (только `#mainMenu`, `updateAccountCornerBtn`, `renderContinueOffline`, новые функции меню), `server/public/styles.css` (блок меню) | редизайн главного меню |
| П4 Сборка | `mobile/scripts/enable-native.mjs` (новый), `mobile/scripts/copy-web.mjs`, `mobile/scripts/patch-android.mjs`, `mobile/native/yandex-rewarded/**` (новый), `mobile/native/rustore-pay/**` (новый), `.github/workflows/android.yml`, `.gitignore`, `mobile/README.md` | флейворы сборки |
| П5 Документы | `MONETIZATION.md` в корне (новый, для владельца), `GITHUB.md` и `tools/push-to-github.ps1` (отправка на GitHub), `deploy/README.md` (таблица настроек), `CHANGES-2026-10-12.md` (новый) | инструкции |

Новые серверные модули кладём **в корень `server/`**, не в подпапки: `test/check.js` проверяет синтаксис
и повторы функций только в `server/*.js`, `server/public/*.js` и `server/test/*.js`.

---------------------------------------------------------------------------------------------------

## 1. Экономика

### 1.1. Рейтинг и баланс

| Поле в `users.json` | Что это | Откуда приходит | Куда уходит |
|---|---|---|---|
| `rating` | место в таблице лидеров | победа в онлайн-партии (`addPoints`) | никуда, не тратится и не продаётся |
| `points` | баланс, «очки» | победа (та же сумма, что в рейтинг), пакеты очков, бонус Премиума, видео с наградой | покупка скинов (`buySkin`) |

- Победа добавляет одну и ту же сумму и в `rating`, и в `points`.
- Таблица лидеров сортируется по `rating`. За столом (`engine.addPlayer`) показывается `rating`.
- В интерфейсе: «Рейтинг: N» — экран рейтинга и модалка аккаунта; «Баланс: N очков» — скины, магазин,
  чип аккаунта. Ошибка «Недостаточно очков рейтинга.» становится «Недостаточно очков.».
- Текст в `#rulesScreen` («Очки рейтинга и скины») не трогаем — экран заблокирован; поправить позже.

### 1.2. Каталог

| id | Тип | Даёт | ЮKassa / RuStore | Google Play | В продаже |
|---|---|---|---|---|---|
| `tm_points_300` | расходуемый | +300 очков | 99 ₽ | $1.99 | да |
| `tm_points_700` | расходуемый | +700 очков (бонус +17%) | 199 ₽ | $3.99 | да |
| `tm_points_1600` | расходуемый | +1600 очков (бонус +34%) | 399 ₽ | $7.99 | да |
| `tm_points_4500` | расходуемый | +4500 очков (бонус +52%) | 990 ₽ | $19.99 | нет (`enabled:false`, включить, когда скинов станет больше чем на 3000 очков) |
| `tm_premium` | нерасходуемый | Премиум (см. 1.3) | 449 ₽ | $5.99 | да |
| `tm_set_wallstreet` | нерасходуемый | набор «Уолл-стрит»: тема стола + аватар-пак (только за деньги) | 149 ₽ | $2.99 | да |

База — около 3 очков за рубль. Цены RuStore и Google Play владелец задаёт в консолях; в Play-сборке
на кнопке показывается цена магазина, а не наша.

### 1.3. «Премиум» (разово, навсегда)

- Все скины, продающиеся за очки (сейчас `legend`, `vip`, `emerald`, `midnight`, `royal`) и все будущие.
- Линейка только для Премиума: темы «Золото биржи» и «Неон», аватар-пак «Быки и медведи» (и будущие
  предметы с `premium:true`).
- Корона рядом с ником: таблица лидеров, чип аккаунта, модалка аккаунта. (Лобби и стол — позже, они заблокированы.)
- Дневной лимит видео с наградой ×2.
- Разово +300 очков на баланс (входят в заказ; при возврате списываются).
- Набор «Уолл-стрит» в Премиум **не входит**.

### 1.4. Видео с наградой

- +`ADS_REWARD_POINTS` очков баланса за досмотренное видео (рекомендуется 10).
- `ADS_DAILY_CAP` в сутки (рекомендуется 5, с Премиумом вдвое больше), между видео — `ADS_COOLDOWN_SEC`
  (рекомендуется 180). Сутки — по Москве (сброс в 00:00 МСК). Только для вошедших в аккаунт.
- Только в Android-сборках: Яндекс в `direct` и `rustore`, AdMob в `googleplay`. На сайте — нет.
- Никогда не прерывает партию, нет межстраничной рекламы, только по нажатию кнопки.
- Кнопка говорит прямо, что получит игрок: «Смотреть видео · +10 очков».

---------------------------------------------------------------------------------------------------

## 2. `server/products.js` (новый файл, полностью)

Серверный модуль без сети и без `require` других модулей проекта (чтобы не было циклов с `users.js`).

```js
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
  return { avatarPacks: (u.avatarPacks || []).slice(), boardSkins: (u.boardSkins || []).slice() };
}

module.exports = { PRODUCTS, PREMIUM_BENEFITS, byId, storeId, byStoreId, rubValue, rubText, unlocksOf };
```

---------------------------------------------------------------------------------------------------

## 3. Скины: `server/public/skins.js` и `styles.css`

### 3.1. Новые записи в `skins.js`

Новые поля: `premium: true` — только с Премиумом; `set: "<productId>"` — только в наборе. У таких
скинов `cost: 0`, и за очки они **не продаются**.

```js
// AVATAR_PACKS — добавить в конец:
{ id: "bulls", name: "Быки и медведи", cost: 0, premium: true, avatars: ["bull","bear","fish","bird","paw","shield","briefcase","trend"] },
{ id: "wallstreet", name: "Уолл-стрит", cost: 0, set: "tm_set_wallstreet", avatars: ["tower","bank","candles","cash","coins","bars","piggy","receipt"] },

// BOARD_SKINS — добавить в конец:
{ id: "gold", name: "Золото биржи", cost: 0, premium: true, cls: "theme-gold", stage: ["#5c4a1e", "#2b200b", "#171006"], accent: "#f2c94c" },
{ id: "neon", name: "Неон", cost: 0, premium: true, cls: "theme-neon", stage: ["#1b2a4a", "#0c1222", "#05080f"], accent: "#39e6ff" },
{ id: "wallstreet", name: "Уолл-стрит", cost: 0, set: "tm_set_wallstreet", cls: "theme-wallstreet", stage: ["#1f3b2c", "#0f1e16", "#08110c"], accent: "#c9a45c" },
```

Обновить комментарий в шапке файла (поля `premium` и `set`).

### 3.2. Темы стола в `styles.css` (рядом с `body.theme-royal`)

```css
body.theme-gold{ --stage-c1:#5C4A1E; --stage-c2:#2B200B; --stage-c3:#171006; --stage-accent:#F2C94C; --frame:#5E4A1F; }
body.theme-neon{ --stage-c1:#1B2A4A; --stage-c2:#0C1222; --stage-c3:#05080F; --stage-accent:#39E6FF; --frame:#24335A; }
body.theme-wallstreet{ --stage-c1:#1F3B2C; --stage-c2:#0F1E16; --stage-c3:#08110C; --stage-accent:#C9A45C; --frame:#2A4A38; }
```

### 3.3. `applyBoardSkin` в `index.html`

Сейчас список классов зашит: `classList.remove("theme-emerald","theme-midnight","theme-royal")`.
Заменить на снятие всех `cls` из `Skins.BOARD_SKINS`, иначе новая тема «залипнет» после смены.

---------------------------------------------------------------------------------------------------

## 4. Аккаунты: `server/users.js`

### 4.1. Запись пользователя (новые поля)

```js
{
  // …прежние поля: username, salt, hash, gender, avatar, avatarPhoto, sessions,
  // ownedAvatarPacks, ownedBoardSkins, equippedAvatarPack, equippedBoardSkin, createdAt
  rating: 120,          // НОВОЕ: рейтинг (только победы)
  points: 450,          // СМЫСЛ МЕНЯЕТСЯ: только баланс
  entitlements: {       // НОВОЕ: нерасходуемые покупки (ключ — id товара)
    tm_premium: { at: 1760270000000, orderId: "…", provider: "yookassa" },
  },
  purchases: [          // НОВОЕ: журнал применённых заказов; он же — метка «заказ уже применён»
    { orderId: "…", productId: "tm_points_300", provider: "yookassa", at: 1760270000000,
      points: 300, test: false, refundedAt: null, debt: 0 },
  ],
  adRewards: { day: "2026-10-12", count: 2, lastAt: 1760270000000 }, // НОВОЕ: видео за сутки (МСК)
}
```

- `purchases` не обрезается: по нему проверяется идемпотентность применения заказа (записи короткие).
- `ownedAvatarPacks` / `ownedBoardSkins` по-прежнему хранят только то, что куплено за очки.
  Скины из Премиума и наборов **не дописываются** туда, а вычисляются (см. 4.3) — так возврат
  денег снимает их одним удалением записи из `entitlements`.

### 4.2. Миграция при загрузке (рядом с переводом старого `sessionToken`)

```js
for (const rec of Object.values(users)) {
  if (!rec) continue;
  // Рейтинг отделён от баланса: у старых аккаунтов он равен нынешним очкам,
  // поэтому таблица лидеров в момент обновления ни у кого не меняется.
  if (typeof rec.rating !== "number" || !Number.isFinite(rec.rating)) rec.rating = Math.max(0, Math.round(rec.points || 0));
  if (!rec.entitlements || typeof rec.entitlements !== "object") rec.entitlements = {};
  if (!Array.isArray(rec.purchases)) rec.purchases = [];
}
```

Сохранять сразу не нужно: миграция идемпотентна, запишется с первым же `saveUsers()`.
`register()` создаёт запись с `rating: 0, points: 0, entitlements: {}, purchases: []`.

### 4.3. Владение скинами (новые внутренние функции)

```js
// Скин доступен, если он куплен за очки, открыт набором из entitlements или
// входит в Премиум (все платные скины за очки и вся линейка premium:true).
function effectiveOwned(rec, kind) → string[]   // kind: "avatarPack" | "boardSkin"; порядок — как в каталоге skins.js
function ownsSkin(rec, kind, id) → boolean
function isPremiumRec(rec) → boolean            // !!rec.entitlements.tm_premium
```

Правило Премиума: `skin.premium === true` **или** (`skin.cost > 0` и нет `skin.set`).
Набор: для каждого id из `rec.entitlements` берётся `Products.byId(id).unlocks`.
Базовые `base` и `default` доступны всегда.

### 4.4. Изменения существующих функций

| Функция | Изменение |
|---|---|
| `publicProfile(rec)` | добавить `rating`, `premium` (bool), `entitlements` (массив id); `ownedAvatarPacks`/`ownedBoardSkins` — результат `effectiveOwned`; `points` — баланс. **Не** класть сюда `purchases`, `adRewards`. |
| `addPoints(username, amount)` | `rec.rating += a; rec.points += a`; возвращает **новый рейтинг** (его `server.js` пишет игроку за столом). |
| `getLeaderboard(limit)` | сортировка по `rating`; элементы — новая `leaderboardEntry(rec)`: `{username, avatar, avatarPhoto, rating, points: rating, premium}`. `points` здесь — устаревшее поле для старых APK со встроенным старым клиентом (они читают `p.points`). Баланс и владение в таблицу не попадают. |
| `buySkin` | отказ для `skin.premium` («Этот скин входит в Премиум.») и `skin.set` («Этот скин продаётся только в наборе.»); «уже куплен» — по `ownsSkin` (текст «Этот скин уже куплен.» не менять: клиент сравнивает строку); «Недостаточно очков.». |
| `equipSkin`, `updateProfile` (аватар) | проверка владения через `ownsSkin` / `effectiveOwned`. |

### 4.5. Новые экспортируемые функции

```js
usernameKey(name) → string                                   // уже есть, экспортировать
authAccount(username, password, token) → {ok:true, key, profile} | {error, authFailed?}
                                                             // обёртка над authenticate(); как у /api/profile/*
accountByToken(token) → {key, profile} | null                // для GET с заголовком Authorization
billingUserId(key) → string | null                           // случайные 32 байта (64 hex), создаются при первом обращении
                                                             // и хранятся в users.json (billingId); хэш ника не годится — ники публичны;
                                                             // appUserId RuStore, obfuscatedAccountId Google, user_id AdMob
hasEntitlement(key, productId) → boolean
isPremium(key) → boolean
applyOrder(order) → {ok:true, applied:boolean, profile} | {error}   // идемпотентно, см. 5.4
revokeOrder(order) → {ok:true, revoked:boolean}                     // идемпотентно, см. 5.6
claimAdReward(key, {points, cap, cooldownMs, now}) → {ok, points, today:{count, cap, nextAt}, profile} | {error, code, nextAt}
adStatus(key, {cap, cooldownMs, now}) → {count, cap, nextAt}
accountShopInfo(key) → {rating, points, premium, entitlements, ownedAvatarPacks, ownedBoardSkins, purchases}
```

Сутки по Москве: `new Date(now + 3 * 3600e3).toISOString().slice(0, 10)`.

`applyOrder(order)`:
1. `rec = users[order.user]`; нет — `{error}` (заказ остаётся «granted», сверка при старте попробует снова).
2. Есть запись в `rec.purchases` с этим `orderId` — `{ok:true, applied:false}`.
3. `product = Products.byId(order.productId)`; `rec.points += product.points || 0`.
4. Нерасходуемый — `rec.entitlements[product.id] = {at, orderId, provider}`.
5. `rec.purchases.push({orderId, productId, provider, at, points, test, refundedAt:null, debt:0})`; `saveUsers()`.

`revokeOrder(order)`:
1. Нет записи в `purchases` или уже `refundedAt` — `{ok:true, revoked:false}`.
2. `rec.points -= entry.points`; если ушло ниже нуля — `entry.debt = -rec.points; rec.pointsDebt += entry.debt; rec.points = 0`.
   Долг аккаунта `pointsDebt` гасят следующие начисления (`addPoints`, `applyOrder`, `claimAdReward` —
   общий помощник `creditPoints`): пока он не погашен, баланс равен нулю (рейтинг за победы растёт как обычно).
3. Если `rec.entitlements[productId].orderId === order.id` — удалить запись.
4. Если экипированная тема или аватар больше не доступны — вернуть `default` / `base` (аватар — `""`).
5. `entry.refundedAt = now`; `saveUsers()`.

`claimAdReward`: сбросить счётчик, если `adRewards.day` не сегодняшний; `count >= cap` →
`{error:"На сегодня видео закончились — приходите завтра.", code:"ads_cap", nextAt:<полночь МСК>}`;
`now - lastAt < cooldownMs` → `{error:"Следующее видео — через N мин.", code:"ads_cooldown", nextAt}`;
иначе `points += n` (рейтинг не трогаем), `count++`, `lastAt = now`, `saveUsers()`.

---------------------------------------------------------------------------------------------------

## 5. Заказы: `DATA_DIR/orders.json` и `server/payments.js`

### 5.1. Файл

Запись — как `saveUsers()`: временный файл `orders.json.tmp` + `rename`. Повреждённый файл при старте —
не запускаться с понятной ошибкой (как `loadUsers`). Бэкап (`deploy/backup.sh`) уже архивирует весь `DATA_DIR`.

```json
{
  "v": 1,
  "orders": {
    "6f1c2a9e-4b7d-4c1e-9a3f-2d8b5e7c1a40": {
      "id": "6f1c2a9e-4b7d-4c1e-9a3f-2d8b5e7c1a40",
      "user": "игрок1",
      "productId": "tm_points_300",
      "provider": "yookassa",
      "platform": "web",
      "status": "pending",
      "amount": { "value": "99.00", "currency": "RUB" },
      "ref": "30b1d5f4-000f-5000-8000-1a2b3c4d5e6f",
      "grantKey": null,
      "test": false,
      "confirmationUrl": "https://yoomoney.ru/checkout/payments/v2/contract?orderId=…",
      "createdAt": 1760270000000,
      "updatedAt": 1760270000000,
      "grantedAt": null,
      "refundedAt": null,
      "lastCheckAt": 0,
      "needsFinish": false,
      "note": null
    }
  },
  "grants": { "yk:30b1d5f4-000f-5000-8000-1a2b3c4d5e6f": "6f1c2a9e-4b7d-4c1e-9a3f-2d8b5e7c1a40" },
  "adTx": { "admob:1234567890abcdef": 1760270000000 },
  "meta": { "lastVoidedPollAt": 0 }
}
```

| Поле | Значения |
|---|---|
| `id` | `crypto.randomUUID()` (36 символов; подходит как Idempotence-Key ЮKassa и `orderId` RuStore). В маршрутах проверять `/^[0-9a-f-]{36}$/`. |
| `user` | `usernameKey` |
| `provider` | `yookassa` \| `rustore` \| `googleplay` \| `mock` |
| `platform` | `web` \| `direct` \| `rustore` \| `googleplay` (со слов клиента, только для статистики и выбора `return_url`) |
| `status` | `created` (ждём покупку в магазине) → `pending` (ждём оплату ЮKassa) → `granted` \| `canceled` \| `failed`; `granted` → `refunded` |
| `ref` | id платежа ЮKassa \| `invoiceId` RuStore \| `sha256(purchaseToken)` Google \| токен mock |
| `grantKey` | `yk:<paymentId>` \| `rs:<invoiceId>` \| `gp:<sha256(purchaseToken)>` \| `mock:<token или orderId>` |
| `needsFinish` | Google: не удалось `consume`/`acknowledge` после выдачи — повторить фоном |

Чистка (раз в сутки): `created`/`canceled`/`failed` старше 30 дней удаляются; `granted` и `refunded`
хранятся всегда (это учёт). `adTx` старше 7 дней удаляются.

### 5.2. Индексы в памяти

При загрузке строятся `byRef` (`provider + ":" + ref` → orderId) и список заказов пользователя.
Всё остальное — прямо из объекта `orders`.

### 5.3. Идемпотентная выдача (единственный путь выдачи)

```js
// Вызывать СИНХРОННО, после последнего await проверки у провайдера: между
// проверкой grants и записью ничего не выполняется, поэтому повтор вебхука,
// двойной клик или опрос статуса в ту же секунду не выдадут товар дважды.
function grantOrder(order, grantKey, extra) {
  const prev = store.grants[grantKey];
  if (prev) return { already: true, orderId: prev };
  store.grants[grantKey] = order.id;
  Object.assign(order, extra || {}, { status: "granted", grantKey, grantedAt: Date.now(), updatedAt: Date.now() });
  saveOrders();                        // 1) сначала фиксируем «выдано» в orders.json
  const r = users.applyOrder(order);   // 2) потом начисляем (идемпотентно по users.purchases)
  return { already: false, applied: !!(r && r.applied) };
}
```

Порядок «сначала заказ, потом аккаунт» и идемпотентный `applyOrder` дают ровно одну выдачу даже при
падении процесса между двумя записями: **сверка при старте** проходит по всем `granted` и вызывает
`users.applyOrder`, по всем `refunded` — `users.revokeOrder`. Обе функции сами пропускают уже применённое.

### 5.4. Повторная покупка нерасходуемого

`POST /api/shop/order` и `POST /api/shop/verify` (без готового `grantKey`) отказывают, если
`users.hasEntitlement(key, productId)`: `{error:"Уже куплено.", code:"already_owned"}`. Для `tm_premium`
по той же причине нельзя получить +300 очков дважды (после возврата — можно купить снова, бонус списан).

### 5.5. Сверка и фоновые задачи (`setInterval` с `unref()`)

| Задача | Период | Что делает |
|---|---|---|
| Сверка при старте | один раз | `applyOrder`/`revokeOrder` по `granted`/`refunded` |
| Опрос зависших ЮKassa | 5 мин | `pending` моложе 24 ч и `lastCheckAt` старше 5 мин → проверка платежа (5.7) |
| Досылка Google | 5 мин | `needsFinish` → повторить `consume`/`acknowledge` (у Google на это 3 дня) |
| Возвраты Google | 6 ч | `voidedpurchases` (5.9) → `revokeOrder` |
| Чистка | 24 ч | см. 5.1 |

### 5.6. Возвраты

- ЮKassa: вебхук `refund.succeeded` → `GET /refunds/{id}` → `payment_id` → заказ. Полный возврат
  (сумма = сумме заказа) → `status:"refunded"`, `refundedAt`, `saveOrders()`, `users.revokeOrder`.
  Частичный — только `note` в заказе и запись в лог, без списания; но если по платежу всего вернули
  сумму заказа (`refunded_amount` из `GET /payments/{payment_id}`) — это полный возврат. Платёж, вернувшийся
  раньше выдачи (`succeeded` с ненулевым `refunded_amount`), не выдаётся: заказ → `canceled`.
- Google: `voidedpurchases` → то же.
- RuStore: уведомлений о возврате нет, а возвращённая покупка пропадает из приложения. Выданный счёт
  перепроверяется при повторном `verify` той же покупки (не чаще раза в 10 минут) и фоновой задачей
  `pollRustoreRefunds` (каждые 6 ч; счета за 60 дней, каждый не чаще раза в сутки, до 200 за проход);
  `REFUNDED`/`REVERSED` → снять.

### 5.7. ЮKassa: проверка платежа

```js
// Источник правды — GET /v3/payments/{id}; тело вебхука лишь подсказывает, что проверить.
function ykPaymentOk(p, order) {
  return !!p && p.status === "succeeded" && p.paid === true
    && p.amount && p.amount.currency === "RUB" && p.amount.value === order.amount.value
    && p.metadata && p.metadata.orderId === order.id && p.metadata.account === order.user;
}
```

- `succeeded`, но `ykPaymentOk` ложно (сумма или заказ не совпали) → `status:"failed"`, громкая запись в лог, без выдачи.
- `canceled` → `status:"canceled"`, `note = cancellation_details.reason`.
- `pending`/`waiting_for_capture` → без изменений (`waiting_for_capture` при `capture:true` не бывает — в лог).
- `p.test === true` → `order.test = true`.

### 5.8. RuStore: проверка счёта

```js
function rustoreInvoiceOk(b, order, key) {
  const product = b && b.order ? Products.byStoreId("rustore", b.order.itemCode) : null;
  return !!product && product.id === order.productId
    && String(b.appId) === RUSTORE_APP_ID
    && String(b.invoiceStatus).toUpperCase() === "CONFIRMED"   // в примерах документации статус строчными
    && b.appUserId === users.billingUserId(key);
}
```

- Токен: `POST https://public-api.rustore.ru/public/auth/` с `{keyId, timestamp, signature}`;
  `timestamp = new Date().toISOString().replace("Z", "+00:00")`, `signature = base64(SHA512withRSA(keyId + timestamp))`
  ключом PKCS#8 DER из `RUSTORE_PRIVATE_KEY` (base64). Кэш `jwe` на `ttl − 60` с.
- Счёт: `GET https://public-api.rustore.ru/public/v2/invoices/{invoiceId}`, заголовок `Public-Token: <jwe>`.
  `code:"NOT_FOUND"` и `RUSTORE_ALLOW_SANDBOX` включён → `GET …/public/sandbox/v2/invoices/{invoiceId}`;
  такой заказ получает `test:true`.
- `appUserId` не совпал → `{error:"Покупка привязана к другому аккаунту.", code:"other_account"}`.
- Статус `PROCESSING`/`CREATED`/`EXECUTED`/`PAID` → ответ `{status:"pending"}`.
- `CANCELLED`/`REJECTED`/`EXPIRED` → `status:"canceled"`. `REFUNDED`/`REVERSED` → см. 5.6.
- Сумма `order.amountCurrent` (копейки) с нашей ценой **не** сравнивается (цену задаёт консоль) —
  расхождение только пишется в лог.

### 5.9. Google Play: проверка покупки

- OAuth: JWT RS256 из `GOOGLE_PLAY_SERVICE_ACCOUNT` (`client_email`, `private_key`),
  `scope=https://www.googleapis.com/auth/androidpublisher`, `aud=https://oauth2.googleapis.com/token`,
  `exp = iat + 3600` → `POST https://oauth2.googleapis.com/token` (form: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`, `assertion`).
  Кэш `access_token` на `expires_in − 300` с.
- Покупка: `GET https://androidpublisher.googleapis.com/androidpublisher/v3/applications/{pkg}/purchases/products/{storeProductId}/tokens/{token}`.

```js
function googlePurchaseOk(p, key, allowTest) {
  return !!p && p.purchaseState === 0
    && p.obfuscatedExternalAccountId === users.billingUserId(key)
    && (p.purchaseType !== 0 || allowTest);
}
```

- `purchaseState === 2` → `{status:"pending"}` (оплата наличными и т. п.), заказ ждёт.
- `purchaseState === 1` → `status:"canceled"`.
- `consumptionState === 1`, а `grantKey` в нашей базе нет → отказ `invalid_purchase` (потреблено не нами).
- После `grantOrder`: расходуемый → `POST …/tokens/{token}:consume`; нерасходуемый и
  `acknowledgementState === 0` → `POST …/tokens/{token}:acknowledge` (тело `{}`). Ошибка → `needsFinish:true`.
- Возвраты: `GET …/applications/{pkg}/purchases/voidedpurchases?startTime=<ms>` (с `meta.lastVoidedPollAt − 1 ч`,
  не раньше чем 30 дней назад) → `gp:<sha256(purchaseToken)>` → заказ → 5.6.
- Токен покупки проверять `/^[A-Za-z0-9._-]{10,4096}$/`; в лог — только первые 8 символов его sha256.

### 5.10. Тестовый провайдер `mock`

Включается `PAYMENTS_MOCK=1`; при `NODE_ENV=production` игнорируется с ошибкой в логе. Заказ `mock`
выдаётся сразу при создании (`grantKey = "mock:" + orderId`), `verify` с `provider:"mock"` выдаёт по
`grantKey = "mock:" + purchaseToken` (для проверки идемпотентности). Все такие заказы `test:true`.
Каталог отдаёт `mock:true`, магазин показывает плашку «Тестовый режим оплаты: деньги не списываются».

---------------------------------------------------------------------------------------------------

## 6. Настройки сервера (окружение)

Флаги принимают `1`/`on`/`true`/`yes` и `0`/`off`/`false`/`no` (функция `envFlag(name, default)`).
Неверное значение — провайдер выключается, в лог пишется причина; сервер не падает.

### 6.1. Переменные

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `YOOKASSA_SHOP_ID` | — | shopId магазина ЮKassa (ЛК → Интеграция → Ключи API). Для теста — shopId тестового магазина. |
| `YOOKASSA_SECRET_KEY` | — | секретный ключ ЮKassa. **Секрет.** |
| `YOOKASSA_RETURN_URL` | — | https-адрес сайта без пути, напр. `https://birzha.example.ru`. Возврат после оплаты: сайт → `/?order=<id>`, приложение → `/pay-return.html?order=<id>`. `http://` допускается только для `localhost`/`127.0.0.1`. |
| `YOOKASSA_RECEIPTS` | `off` | `on` — передавать чек 54-ФЗ (`receipt`) для ИП/ООО с «Чеками от ЮKassa»; клиент спросит email. Самозанятым — `off` (ЮKassa чеки для НПД не формирует). |
| `YOOKASSA_VAT_CODE` | `1` | `vat_code` позиции чека: 1 — без НДС, 4 — 20%, 7 — 5%, 8 — 7%, 11 — 22%. |
| `YOOKASSA_TAX_SYSTEM` | — | `tax_system_code` чека (1–6), если у магазина несколько систем налогообложения. |
| `YOOKASSA_PAYMENT_SUBJECT` | `service` | `payment_subject`: `service` \| `intellectual_activity` \| `another` (согласовать с бухгалтером). |
| `YOOKASSA_IN_RUSTORE` | `off` | `on` — показывать ЮKassa и в RuStore-сборке (сначала проверить правила RuStore). |
| `YOOKASSA_WEBHOOK_IP_CHECK` | `on` при `TRUST_PROXY=1`, иначе `off` | проверять, что вебхук пришёл с адресов ЮKassa (выключено — предупреждение при старте; поток с одного адреса ограничен всегда). |
| `YOOKASSA_ALLOW_TEST` | `off` | `on` — выдавать платежи тестового магазина (`test:true`); без флага такой заказ → `failed` с подсказкой в журнале. |
| `RUSTORE_KEY_ID` | — | keyId ключа API RuStore (Консоль → API RuStore). |
| `RUSTORE_PRIVATE_KEY` | — | приватный ключ API RuStore: base64 одной строкой, как выдала консоль. **Секрет.** |
| `RUSTORE_PRIVATE_KEY_FILE` | — | вместо предыдущей: путь к файлу с тем же base64. |
| `RUSTORE_APP_ID` | — | id приложения в RuStore Консоли (число). |
| `RUSTORE_ALLOW_SANDBOX` | `off` | `on` — принимать тестовые платежи песочницы (только на время проверки!). |
| `GOOGLE_PLAY_PACKAGE` | — | `com.xstatem.trademonopoly` |
| `GOOGLE_PLAY_SERVICE_ACCOUNT` | — | путь к JSON-ключу сервисного аккаунта, напр. `/etc/birzha/google-play.json` (права 640, владелец root:birzha). **Секрет.** |
| `GOOGLE_PLAY_ALLOW_TEST` | `off` | `on` — засчитывать покупки лицензионных тестеров (`purchaseType=0`). |
| `ADS_REWARD_POINTS` | `0` | очков за видео; `0` — реклама выключена. Рекомендуется `10`. |
| `ADS_DAILY_CAP` | `5` | видео в сутки (МСК); с Премиумом ×2. |
| `ADS_COOLDOWN_SEC` | `180` | пауза между засчитанными видео. |
| `ADS_MIN_WATCH_SEC` | `10` | для Яндекса и AdMob без SSV: билет нельзя погасить раньше. |
| `ADS_MIN_ACCOUNT_AGE_HOURS` | `0` | видео — только аккаунтам старше N часов (`ads_new_account`). |
| `ADS_YANDEX` | `on`; при `ADMOB_SSV=on` — `off` | видео Яндекса (без серверной проверки: платформу называет клиент). |
| `ADMOB_SSV` | `off` | `on` — очки за AdMob только по подписанному колбэку Google (`/api/ads/admob-ssv`). |
| `ADMOB_AD_UNITS` | — | числовые id рекламных блоков AdMob через запятую (часть после «/»); если задано, колбэки других блоков отклоняются. |
| `YANDEX_ADS_S2S_SECRET` | — | зарезервировано. У Яндекса на 12.10.2026 нет серверного колбэка награды; если переменная задана, сервер пишет предупреждение и её не использует. |
| `PAYMENTS_MOCK` | — | `1` — тестовый провайдер `mock` (только разработка и тесты; при `NODE_ENV=production` не включается). |
| `YOOKASSA_API_URL` | `https://api.yookassa.ru/v3` | только для тестов: учитывается лишь при `PAYMENTS_MOCK=1`. |
| `SHOP_SELLER` | — | строка продавца для подвала магазина: «ИП Иванов И. И., ИНН …, support@…» (нужна ЮKassa и RuStore). |
| `SHOP_OFFER_URL` | — | ссылка на публичную оферту. |
| `SHOP_PRIVACY_URL` | — | ссылка на политику конфиденциальности (нужна RuStore из-за рекламного SDK). |

### 6.2. Когда провайдер считается включённым

| Провайдер | Условие |
|---|---|
| `yookassa` | `YOOKASSA_SHOP_ID`, `YOOKASSA_SECRET_KEY`, корректный `YOOKASSA_RETURN_URL` |
| `rustore` | `RUSTORE_KEY_ID`, ключ (`RUSTORE_PRIVATE_KEY` или читаемый `RUSTORE_PRIVATE_KEY_FILE`, ключ разбирается `crypto.createPrivateKey`), `RUSTORE_APP_ID` |
| `googleplay` | `GOOGLE_PLAY_PACKAGE` и читаемый JSON с `client_email` и `private_key` |
| `mock` | `PAYMENTS_MOCK=1` и `NODE_ENV !== "production"` |
| реклама | `ADS_REWARD_POINTS > 0` |

При старте одна строка в лог без секретов, напр.
`Магазин: ЮKassa — вкл, RuStore — выкл, Google Play — выкл, тестовая оплата — выкл, реклама — +10 очков, 5 в сутки.`

### 6.3. Какой провайдер на какой платформе

| platform | yookassa | rustore | googleplay | mock | реклама |
|---|---|---|---|---|---|
| `web` | да | — | — | да | — |
| `direct` | да | — | — | да | `yandex` |
| `rustore` | только при `YOOKASSA_IN_RUSTORE=on` | да | — | да | `yandex` |
| `googleplay` | **никогда** (правила Google Play) | — | да | да | `admob` |

Неизвестная `platform` считается `web`. Порядок в списке: магазин платформы, затем `yookassa`, затем `mock`.

### 6.4. Где хранить

- `/etc/birzha.env` (`EnvironmentFile` в systemd) — все переменные; ключ RuStore — одной строкой base64.
- JSON Google — файлом в `/etc/birzha/` (systemd-юнит читает `/etc`, пишет только в `DATA_DIR`).
- **Render (бесплатный план)**: диск временный — `users.json` и `orders.json` пропадают при каждом деплое.
  Платежи там не включать; только свой сервер (`deploy/`) или Render с постоянным диском.

---------------------------------------------------------------------------------------------------

## 7. HTTP API

### 7.1. Общие правила

- **Вход (POST).** Как у `/api/profile/*`: в теле `{username, password, token}`; клиент шлёт через
  `accountApiPost` (`password:""` при наличии токена). Сервер: `users.authAccount(...)`, ошибки входа
  считаются в лимит подбора (`AUTH`).
- **Вход (GET).** Заголовок `Authorization: Bearer <токен сессии>` → `users.accountByToken`.
  Нет заголовка → 400 `{error:"Нужен вход в аккаунт.", code:"auth_required"}`; токен не принят →
  400 `{error:"Сессия недействительна — войдите заново.", code:"session", sessionExpired:true}`.
  В `applyCors` добавить `Authorization` в `Access-Control-Allow-Headers`. Токен в адресе — никогда.
- **Ответы** — JSON, `Cache-Control: no-store`. Ошибка: `{error:"<текст для игрока>", code:"<код>"}`.
  HTTP: 400 — ошибки действия, 404 — функция выключена или объект не найден, 429 — лимиты.
  5xx отдаём только вебхукам (чтобы провайдер повторил): клиентский `apiPost` заменяет текст любой 5xx.
- **Асинхронный обработчик** в `server.js` (рядом с `handleApiPost`):

```js
// Как handleApiPost, но fn может вернуть промис: платёжным маршрутам нужны
// запросы к провайдерам. Исключение внутри fn — это ошибка сервера (500 и лог),
// а не «ошибка действия»: ожидаемые отказы fn возвращает как {error, code}.
function handleApiPostAsync(req, res, fn, opts) {
  const ip = clientIp(req);
  const guarded = !!(opts && opts.auth);
  if (guarded && authBlocked(ip)) return sendJson(res, 429, { error: TOO_MANY_FAILS });
  if (opts && opts.limiter) {
    if (opts.limiter.blocked(ip)) return sendJson(res, 429, { error: "Слишком много запросов — подождите немного.", code: "rate_limited" });
    opts.limiter.note(ip);
  }
  readJsonBody(req, 64 * 1024)
    .then((body) => Promise.resolve(fn(body || {}, ip)).then((result) => {
      result = result || {};
      if (guarded && result.authFailed) noteAuthFail(ip);
      delete result.authFailed;
      const status = result.httpStatus || (result.error ? 400 : 200);
      delete result.httpStatus;
      sendJson(res, status, result, { "Cache-Control": "no-store" });
    }, (e) => {
      console.error("shop:", e && e.message);
      sendJson(res, 500, { error: "Внутренняя ошибка сервера." });
    }))
    .catch((e) => sendJson(res, 400, { error: e.message || "Ошибка запроса." }));
}
```

- **Лимиты.** В `server.js`: `shopLimit = ipLimiter(10 * 60 * 1000, 120)` на `POST /api/shop/order`,
  `/api/shop/verify`, `/api/ads/start`, `/api/ads/reward` (и `shopLimit.sweep` в `sweepRooms`).
  В `payments.js`: не больше 20 заказов на аккаунт в час (`rate_limited`, 429); `GET /api/shop/order/:id`
  обращается к ЮKassa не чаще раза в 3 с на заказ.
- **Маршруты** добавляются в `server.js` перед раздачей статики; модули: `Payments = require("./payments.js")`,
  `Ads = require("./ads.js")`. Маршрут выключенной функции отвечает 404 `{error, code}`.

### 7.2. Коды ошибок

| code | HTTP | Текст |
|---|---|---|
| `shop_disabled` | 404 | Магазин отключён на этом сервере. |
| `provider_disabled` | 400 | Этот способ оплаты недоступен. |
| `unknown_product` | 400 | Товар не найден. |
| `already_owned` | 400 | Уже куплено. |
| `email_required` | 400 | Укажите email — на него придёт чек. |
| `provider_error` | 400 | Платёжная система не ответила — попробуйте ещё раз через минуту. |
| `not_found` | 404 | Заказ не найден. |
| `invalid_purchase` | 400 | Магазин не подтвердил покупку. |
| `other_account` | 400 | Покупка привязана к другому аккаунту. |
| `rate_limited` | 429 | Слишком много запросов — подождите немного. |
| `auth_required` / `session` | 400 | см. 7.1 |
| `ads_disabled` | 404 | Видео с наградой недоступны. |
| `ads_cap` | 400 | На сегодня видео закончились — приходите завтра. |
| `ads_cooldown` | 400 | Следующее видео — через N мин. |
| `ads_ticket` | 400 | Просмотр не засчитан — попробуйте ещё раз. |

### 7.3. `GET /api/shop/catalog?platform=<web|direct|rustore|googleplay>`

Без входа. Магазин и реклама выключены → `200 {"enabled": false}`. Иначе:

```json
{
  "enabled": true,
  "platform": "web",
  "providers": ["yookassa"],
  "mock": false,
  "receipts": false,
  "products": [
    {
      "id": "tm_points_300",
      "kind": "consumable",
      "title": "300 очков",
      "subtitle": "Хватит на аватар-пак «Легенда» или тему стола",
      "points": 300,
      "premium": false,
      "unlocks": { "avatarPacks": [], "boardSkins": [] },
      "price": { "value": "99.00", "currency": "RUB", "text": "99 ₽" },
      "storeIds": { "rustore": "tm_points_300", "googleplay": "tm_points_300" }
    }
  ],
  "premiumBenefits": ["Все скины за очки — сейчас и в будущем", "…"],
  "ads": { "enabled": false, "providers": [], "rewardPoints": 0, "dailyCap": 0, "premiumDailyCap": 0, "cooldownSec": 0 },
  "legal": { "seller": "ИП …", "offerUrl": "https://…", "privacyUrl": "https://…" }
}
```

- `enabled` = есть хоть один провайдер **или** реклама для этой платформы.
- `products` — только `enabled:true`; при пустом `providers` (одна реклама) — пустой массив.
- `price` — только если среди провайдеров есть `yookassa`, `rustore` или `mock` (ориентир в рублях);
  на `googleplay` — `null` (цену берём из магазина).
- `legal` — только заданные поля.

### 7.4. `POST /api/shop/order`

Создаёт заказ. Для ЮKassa сразу создаёт платёж.

```json
{ "username": "Игрок1", "password": "", "token": "…",
  "productId": "tm_points_300", "provider": "yookassa", "platform": "web", "email": "player@example.ru" }
```

Проверки по порядку: провайдер включён и разрешён для `platform` (6.3) → товар есть и `enabled` →
нерасходуемый ещё не куплен → лимит 20 в час → при `YOOKASSA_RECEIPTS=on` email
(`/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/`, не длиннее 254; на сервере **не сохраняется**).

ЮKassa — `POST {YOOKASSA_API_URL}/payments`, Basic `shopId:secretKey`, `Idempotence-Key: <orderId>`:

```json
{
  "amount": { "value": "99.00", "currency": "RUB" },
  "capture": true,
  "confirmation": { "type": "redirect", "return_url": "https://birzha.example.ru/?order=<orderId>" },
  "description": "Trade Monopoly: 300 очков",
  "metadata": { "orderId": "<orderId>", "account": "<usernameKey>", "product": "tm_points_300" }
}
```

При `YOOKASSA_RECEIPTS=on` добавляется (`tax_system_code` — только если задан):

```json
"receipt": {
  "customer": { "email": "player@example.ru" },
  "tax_system_code": 2,
  "items": [{ "description": "Игровая валюта «Биржа»: 300 очков", "quantity": 1,
              "amount": { "value": "99.00", "currency": "RUB" }, "vat_code": 1,
              "payment_mode": "full_payment", "payment_subject": "service" }]
}
```

Таймаут запроса 35 с. Сетевая ошибка или 5xx → один повтор с тем же ключом; снова неудача →
`status:"failed"`, ответ `provider_error`. Ответ ЮKassa: `id` → `ref`, `confirmation.confirmation_url` → `confirmationUrl`,
`status:"pending"`.

Ответы:

```json
{ "ok": true, "orderId": "…", "provider": "yookassa", "status": "pending",
  "confirmationUrl": "https://yoomoney.ru/checkout/payments/v2/contract?orderId=…",
  "amount": { "value": "99.00", "currency": "RUB" } }
```
```json
{ "ok": true, "orderId": "…", "provider": "rustore", "status": "created", "confirmationUrl": null,
  "storeProductId": "tm_points_300", "billingUserId": "9f86d081…(64 hex)" }
```
```json
{ "ok": true, "orderId": "…", "provider": "mock", "status": "granted", "confirmationUrl": null, "user": { "…": "publicProfile" } }
```

### 7.5. `GET /api/shop/order/:id`

Вход по `Authorization: Bearer`. Чужой или несуществующий заказ — одинаково `404 not_found`.
Если `provider:"yookassa"`, `status:"pending"` и с прошлой проверки прошло ≥3 с — сначала проверка (5.7).

```json
{ "ok": true, "orderId": "…", "productId": "tm_points_300", "provider": "yookassa",
  "status": "granted", "test": false, "grantedAt": 1760270000000, "user": { "…": "publicProfile" } }
```

`user` — только при `status:"granted"` (клиент обновляет `accountUser`).

### 7.6. `POST /api/shop/yookassa/webhook`

Без входа и без `handleApiPost`. Адрес для ЛК ЮKassa: `https://<сайт>/api/shop/yookassa/webhook`
(события `payment.succeeded`, `payment.canceled`, `refund.succeeded`). ЮKassa выключена → 404.

1. Тело — не больше 64 КБ, JSON `{type:"notification", event, object}`; иначе 400.
2. IP-проверка (если включена) по списку `185.71.76.0/27, 185.71.77.0/27, 77.75.153.0/25, 77.75.156.11/32,
   77.75.156.35/32, 77.75.154.128/25, 2a02:5180::/32` (`net.BlockList`, адрес из `clientIp(req)`, префикс
   `::ffff:` срезать) → чужой адрес: 403 и запись в лог.
3. Из тела берём **только** `event` и `object.id`. `payment.*` → `GET /payments/{id}` → 5.7.
   `refund.succeeded` → `GET /refunds/{id}` → 5.6. Платёж не наш (нет заказа по `metadata.orderId`) → 200 и лог.
4. Ответ 200 `ok` — только после сохранения результата. Ошибка запроса к ЮKassa → 500 (ЮKassa повторит в течение 24 ч).

### 7.7. `POST /api/shop/verify`

Для магазинных покупок (RuStore, Google Play) и `mock`.

```json
{ "username": "Игрок1", "password": "", "token": "…",
  "provider": "rustore", "productId": "tm_points_300",
  "purchaseToken": "<invoiceId RuStore | purchaseToken Google>", "orderId": "<если есть>", "sandbox": false }
```

1. Провайдер включён для этой платформы покупки; `productId` известен.
2. `grantKey` уже в `grants`: заказ этого пользователя → `{ok, status:"granted", alreadyGranted:true, orderId, user}`;
   чужой → `other_account`.
3. Нерасходуемый уже есть на аккаунте (куплен другим способом) → `already_owned` и запись в лог.
   Такую покупку Google сам вернёт через 3 дня без подтверждения; в RuStore деньги возвращает владелец вручную.
4. Проверка у провайдера (5.8 / 5.9). `orderId` передан и принадлежит пользователю → используем этот заказ,
   иначе (досылка при старте приложения) создаём заказ с `status:"created"` и кладём его в `orders`
   **до** вызова `grantOrder`. `purchaseToken` для `mock` — `/^[A-Za-z0-9._-]{1,128}$/`, для RuStore —
   `/^[A-Za-z0-9_-]{1,128}$/`, для Google — см. 5.9.
5. `grantOrder` → для Google `consume`/`acknowledge`.

Ответы: `{ok:true, status:"granted", orderId, alreadyGranted:false, user}` | `{ok:true, status:"pending", orderId}` |
ошибка с `code`.

### 7.8. `GET /api/shop/entitlements`

Вход по `Authorization: Bearer`. Работает и при выключенном магазине (тогда `ads.enabled:false`).

```json
{ "ok": true, "rating": 120, "points": 450, "premium": true,
  "entitlements": { "tm_premium": { "at": 1760270000000, "provider": "yookassa" } },
  "ownedAvatarPacks": ["base", "legend", "vip", "bulls"], "ownedBoardSkins": ["default", "emerald", "midnight", "royal", "gold", "neon"],
  "purchases": [ { "orderId": "…", "productId": "tm_premium", "provider": "yookassa", "at": 1760270000000, "points": 300, "test": false, "refundedAt": null } ],
  "ads": { "enabled": true, "today": 2, "cap": 10, "nextAt": 1760270180000 } }
```

`purchases` — последние 20, новые первыми.

### 7.9. Реклама: `server/ads.js`

Дневной лимит аккаунта: `cap = ADS_DAILY_CAP * (users.isPremium(key) ? 2 : 1)`; пауза — `ADS_COOLDOWN_SEC * 1000`.
Обе величины передаются в `users.claimAdReward` / `users.adStatus`.

Билеты — в памяти: `Map nonce → {user, provider, adUnit, issuedAt, ssv, status:"issued"|"rewarded"}`,
не больше одного активного билета на аккаунт (новый `start` удаляет прежний), срок 15 мин, чистка в `sweepRooms`.
Перезапуск сервера билеты теряет — игрок просто смотрит следующее видео.

**`POST /api/ads/start`** — `{username, password, token, provider:"yandex"|"admob", adUnit, platform}`.
Проверки: реклама включена; `provider` разрешён для `platform` (6.3); `adUnit` — строка ≤100 символов
`/^[A-Za-z0-9~\/._-]+$/`; заранее проверяются лимит и пауза (чтобы не показывать видео впустую).

```json
{ "ok": true, "nonce": "3f9a…(32 hex)", "userId": "<billingUserId>", "ssv": false,
  "rewardPoints": 10, "minWatchSec": 10, "expiresAt": 1760270900000, "today": { "count": 2, "cap": 5 } }
```

`ssv:true` — только для `admob` при `ADMOB_SSV=on`.

**`POST /api/ads/reward`** — `{username, password, token, provider, adUnit, nonce}`.
- Билет есть, этого аккаунта, тот же `provider`, не просрочен; иначе `ads_ticket`.
- `ssv:false`: прошло ≥`ADS_MIN_WATCH_SEC` с выдачи билета (иначе `ads_ticket`) → билет удаляется →
  `users.claimAdReward` → `{ok:true, status:"granted", points:10, today:{count, cap, nextAt}, user}`.
- `ssv:true`: награду выдаёт колбэк Google. Билет уже `rewarded` → `{ok:true, status:"granted", …}`
  (данные из колбэка), иначе `{ok:true, status:"pending"}`; клиент повторяет до 15 с.

**`GET /api/ads/admob-ssv?<параметры Google>`** — только при `ADMOB_SSV=on`, без входа.
URL для блока AdMob: `https://<сайт>/api/ads/admob-ssv`.
1. Строка запроса — сырая, `req.url.slice(req.url.indexOf("?") + 1)`, без декодирования; подписано всё до `&signature=`.
2. Ключи: `https://www.gstatic.com/admob/reward/verifier-keys.json` (`{keys:[{keyId, pem}]}`), кэш 12 ч,
   неизвестный `key_id` → перечитать (не чаще раза в минуту). Проверка:
   `crypto.verify("sha256", Buffer.from(message), {key, dsaEncoding:"der"}, Buffer.from(signature, "base64url"))`.
3. Подпись неверна → 400. Ключи не получить → 500 (Google повторит).
4. Подпись верна: `ADMOB_AD_UNITS` задан и `ad_unit` не из списка → 200 без выдачи, лог.
   `transaction_id` уже в `adTx` → 200. Билет `custom_data` не найден, чужой (`user_id` ≠ `billingUserId`
   владельца билета) или не `admob` → 200 без выдачи, лог.
   Иначе `adTx[admob:<transaction_id>] = now`, `saveOrders()`, `users.claimAdReward` (лимит/пауза
   отказали — 200 без выдачи), билет → `rewarded`. Ответ 200 `ok`.
5. Функции разбора и проверки подписи — чистые и экспортируются для тестов (`parseAdmobSsv`, `verifyWithKey`).

---------------------------------------------------------------------------------------------------

## 8. Клиент: магазин

### 8.1. Вспомогательные функции в `index.html` (рядом с `apiPost`)

- Вынести разбор ответа из `apiPost` в `normalizeApiResponse(res)` и сделать `apiGet(path, headers)`
  с тем же поведением (`_status`, `_json`, тексты ошибок).
- `accountApiGet(path)` — `apiGet` с `Authorization: Bearer <accountSessionToken>`; при `sessionExpired`
  вызывает `handleAccountSessionExpired()` (как `accountApiPost`).

### 8.2. `server/public/shop.js` (новый файл)

Подключение — `<script src="/shop.js"></script>` сразу после `tutorial.js`; добавить `"/shop.js"` в `SHELL`
в `sw.js` и поменять `VERSION`. Модуль — IIFE в стиле `tutorial.js`: привязывает свои кнопки при загрузке,
а глобальные `accountUser`, `accountSessionToken`, `showOnly`, `apiGet`, `accountApiPost`, `accountApiGet`,
`showToast`, `escapeHtml`, `pointsLabel`, `ico` читает только внутри функций (они объявлены позже, во встроенном скрипте).

```js
window.Shop = {
  init(),              // после restoreSession: каталог, ?order= в адресе, незавершённый заказ, досылка покупок магазина
  enabled(),           // каталог включён
  productAvailable(id),// товар в каталоге этой платформы
  adsAvailable(),      // catalog.ads.enabled && TMNative.ads.isAvailable() && провайдер разрешён
  open(focusId),       // showOnly("shopScreen") + render (+ прокрутка к товару)
  render(),            // перерисовать, если экран открыт
  onAccountChanged(),  // вход, выход, обновление accountUser
  onMenuShown(),       // показ главного меню: обновить пункт «Магазин»; повторить каталог, если прошлый запрос упал (не чаще раза в 60 с)
};
```

Ключи `localStorage` (каждое обращение — в `try/catch`): `tm_pending_order` = `{id, at}`,
`tm_receipt_email` — последний email для чека (удобство на этом устройстве).

### 8.3. Разметка `#shopScreen` (после `#skinsScreen`)

```html
<div class="center-screen" id="shopScreen" style="display:none;">
  <div class="join-box shop-box" style="width:480px;">
    <h1><svg class="ico ico-lg" aria-hidden="true"><use href="#i-bag"/></svg> Магазин</h1>
    <div class="shop-note warn" id="shopMockBanner" hidden>Тестовый режим оплаты: деньги не списываются.</div>
    <div id="shopGate">
      <p>Войдите в аккаунт: покупки привязываются к нему и доступны на всех устройствах.</p>
      <button style="width:100%;" id="shopGateLoginBtn">Войти в аккаунт</button>
    </div>
    <div id="shopContent" hidden>
      <div class="row-inline shop-balance">Баланс: <span class="chip" id="shopBalance"></span>
        <span class="chip shop-premium-chip" id="shopPremiumBadge" hidden><svg class="ico ico-sm" aria-hidden="true"><use href="#i-crown"/></svg> Премиум</span></div>
      <div class="shop-providers" id="shopProviders" role="radiogroup" aria-label="Способ оплаты" hidden></div>
      <section class="shop-premium theme-dark" id="shopPremium" aria-labelledby="shopPremiumTitle" hidden>…</section>
      <section id="shopFree" aria-labelledby="shopFreeTitle" hidden>
        <h2 id="shopFreeTitle">Бесплатные очки</h2>
        <button type="button" id="btnRewardedAd"><svg class="ico ico-sm" aria-hidden="true"><use href="#i-play"/></svg> <span id="btnRewardedAdLabel">Смотреть видео · +10 очков</span></button>
        <div class="muted" id="shopAdStatus">Сегодня: 0 из 5</div>
      </section>
      <section id="shopPointsSection" aria-labelledby="shopPointsTitle" hidden><h2 id="shopPointsTitle">Очки</h2><div class="shop-grid" id="shopPoints"></div></section>
      <section id="shopSetsSection" aria-labelledby="shopSetsTitle" hidden><h2 id="shopSetsTitle">Наборы</h2><div class="shop-grid" id="shopSets"></div></section>
      <div class="shop-email" id="shopEmailRow" hidden>
        <label for="shopEmail">Email для чека</label>
        <input id="shopEmail" type="email" autocomplete="email" inputmode="email" maxlength="254" placeholder="you@example.ru">
      </div>
      <div class="err" id="shopErr" role="alert"></div>
      <div class="muted" id="shopStatus" role="status" aria-live="polite"></div>
      <details class="tips" id="shopHistory"><summary>История покупок</summary><div id="shopHistoryList"></div></details>
      <p class="shop-legal muted" id="shopLegal"></p>
    </div>
    <button class="secondary" style="width:100%;margin-top:16px;" id="btnBackFromShop"><svg class="ico ico-sm" aria-hidden="true"><use href="#i-arrow-left"/></svg> Назад в меню</button>
  </div>
</div>
```

- Иконка: в спрайт добавить `<symbol id="i-bag" viewBox="0 0 24 24"><path d="M5 8h14l-1 12H6zM9 8V6a3 3 0 0 1 6 0v2"/></symbol>`.
- Карточка товара (`.shop-card`, как `.skin-card`): название, подзаголовок, кнопка покупки с `data-product`.
  Кнопка: ЮKassa/mock — «Купить за 99 ₽»; магазин — «Купить · <цена магазина>» (из `TMNative.billing.getProducts`),
  цены нет — «Купить». Нерасходуемый уже есть — неактивная «Куплено».
- Блок Премиума: тёмная карточка (`.theme-dark`), список `premiumBenefits`, кнопка; если Премиум есть —
  «Премиум активен» и без кнопки.
- Несколько провайдеров (RuStore + ЮKassa) — переключатель «Способ оплаты: RuStore | Карта или СБП»
  (`#shopProviders`, кнопки `role="radio"`); по умолчанию — первый провайдер каталога.
- Подвал: «Очки — внутриигровая валюта для косметики: на них покупаются скины. Рейтинг за деньги и
  рекламу не меняется.» + `legal.seller` + ссылки «Оферта», «Политика конфиденциальности»
  (`target="_blank" rel="noopener"`, только `https:`-адреса). Весь текст — через `escapeHtml`.
- Пока идёт покупка или просмотр, все кнопки магазина неактивны (`shopBusy`, как `skinsBusy`).
- Экран добавить: в список `showOnly`, в карту `backBtn` в `handleBackNavigation`
  (`shopScreen:"btnBackFromShop"`), в `refreshAccountGates` (`Shop.render()`).

### 8.4. Точки входа

| Где | Что | Когда видно |
|---|---|---|
| Главное меню | `#btnGoShop` (§12) | `Shop.enabled()` |
| Экран «Скины» | ссылка «Пополнить» рядом с балансом; у Премиум-скинов кнопка «Премиум» (`i-lock`) → `Shop.open("tm_premium")`; у скинов набора «В наборе» → `Shop.open("tm_set_wallstreet")` | соответствующий товар есть в каталоге |
| Модалка аккаунта | строка «Рейтинг: R · Баланс: N очков», значок Премиума, кнопка «Магазин» | кнопка — при `Shop.enabled()` |

На экране «Скины» скины с `premium`/`set` показываются **только** если их товар есть в каталоге или
скин уже доступен игроку. Без настроек экран выглядит как сегодня.

### 8.5. Сценарии покупки

**A. Сайт (`TMNative.store === "web"`), ЮKassa**
1. «Купить» → при `receipts:true` нужен email (`#shopEmailRow`, проверка, подстановка из `tm_receipt_email`).
2. `accountApiPost("/api/shop/order", {productId, provider:"yookassa", platform:"web", email})`.
3. `tm_pending_order = {id, at}` → `location.assign(confirmationUrl)`.
4. Возврат на `/?order=<id>`: `Shop.init()` читает параметр (UUID), сразу `history.replaceState(history.state, "", location.pathname)`,
   ждёт `restoreSession()`, открывает магазин и опрашивает `GET /api/shop/order/<id>`: каждые 2 с первую минуту,
   потом каждые 5 с до 10 минут, пока экран открыт.
   - `granted` → `accountUser = data.user`, `updateAccountCornerBtn()`, тост `kind:"good"` «Покупка зачислена» / «+300 очков»,
     `tm_pending_order` удалить.
   - `canceled` → «Оплата не завершена — деньги не списаны.»; `failed` → «Платёж не прошёл проверку. Напишите в поддержку, указав номер заказа <первые 8 символов>.»
   - время вышло → «Платёж ещё обрабатывается — покупка появится автоматически.»
   - Не вошли в аккаунт → гейт и «Войдите в аккаунт, с которого оплачивали: покупка уже на нём.»
5. Ушли со страницы оплаты без возврата: при следующем запуске `tm_pending_order` моложе 24 ч → одна проверка → тост при `granted`.

**B. APK без магазина (`direct`), ЮKassa**
1. То же создание заказа с `platform:"direct"` (сервер подставит `return_url` на `/pay-return.html`).
2. `tm_pending_order`, `TMNative.openExternal(confirmationUrl)`, статус «Завершите оплату в браузере и
   вернитесь в приложение» и кнопка «Я оплатил — проверить».
3. `TMNative.onResume(...)` → опрос как в A.4.

**C. RuStore и Google Play (`TMNative.billing.isAvailable()`)**
1. `order = accountApiPost("/api/shop/order", {productId, provider, platform})` → `orderId`, `storeProductId`, `billingUserId`.
2. `r = await TMNative.billing.purchase(storeProductId, {orderId, userId: billingUserId})`.
   Отмена (`err.code === "cancelled"`) — тихо разблокировать кнопки.
3. `accountApiPost("/api/shop/verify", {provider, productId, purchaseToken:r.purchaseToken, orderId, sandbox:r.sandbox})`.
   `pending` → повтор через 3 с, до 10 раз; дальше «Платёж обрабатывается — покупка появится сама».
4. При запуске после входа: `TMNative.billing.pending()` → `verify` для каждой покупки без `orderId`;
   что-то выдано → тост «Покупка восстановлена». Ошибки `other_account` и `already_owned` — молча.

**D. `mock`**: ответ заказа уже `granted` → как успех в A.4.

### 8.6. Видео с наградой

Секция `#shopFree` видна, если `Shop.adsAvailable()` и игрок вошёл. Подпись под кнопкой — из
`/api/shop/entitlements` (`ads.today`/`ads.cap`, при паузе — «Следующее видео — через N мин.»).

1. `start = accountApiPost("/api/ads/start", {provider: TMNative.ads.provider, adUnit: TMNative.ads.adUnit, platform: TMNative.store})`.
2. `r = await TMNative.ads.showRewarded({nonce:start.nonce, userId:start.userId})`.
3. `!r.rewarded` → «Видео не досмотрено — очки не начислены.»
4. `accountApiPost("/api/ads/reward", {provider, adUnit, nonce})`; `pending` → повтор каждые 1,5 с до 15 с,
   потом «Награда придёт в течение минуты». `granted` → тост «+10 очков», обновить `accountUser`.

### 8.7. Прочие экраны

- **Рейтинг** (`loadRating`): брать `p.rating ?? p.points`, фильтр `> 0`; у `p.premium` —
  `ico("crown","ico-sm")` и `<span class="sr-only">Премиум</span>`.
- **Скины**: подпись гейта «…покупать и применять скины за очки.»; см. 8.4.
- **Профиль**: `profileWhoPoints` — баланс (как сейчас).
- `pay-return.html` — статическая страница без скриптов (светлая тема, `/styles.css`):
  заголовок «Оплата», текст «Спасибо! Если оплата прошла, покупка зачислится на ваш аккаунт в течение
  минуты. Вернитесь в приложение Trade Monopoly — оно само проверит платёж.» и ссылка «Открыть веб-версию» (`/`).
  В `SHELL` не добавлять.

### 8.8. CSS магазина (`styles.css`, новый блок «Магазин»)

`.shop-grid` — как `.skins-grid`; `.shop-card` — как `.skin-card`; `.shop-premium` — `background` из
`--stage-c1..3` (как герой меню), радиус `var(--r-xl)`; `.shop-note.warn` — `var(--warn-bg)`;
`.shop-legal` — 12px. Добавить утилиту:

```css
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;}
```

---------------------------------------------------------------------------------------------------

## 9. Мост к нативу: `server/public/native.js`

Сохраняется стиль файла (ES5: `var`, `function`), все методы — безопасные пустышки в браузере.

### 9.1. Сборка и платформа

```js
// Что включено в эту сборку, пишет mobile/scripts/copy-web.mjs (window.TM_BUILD).
// В обычном браузере и в сборке по умолчанию объекта нет.
var BUILD = (isNative && window.TM_BUILD && typeof window.TM_BUILD === "object") ? window.TM_BUILD : {};
var STORES = { direct: 1, rustore: 1, googleplay: 1 };
var store = isNative ? (STORES[BUILD.store] ? BUILD.store : "direct") : "web";
function pluginAvailable(name){
  return !!(isNative && typeof cap.isPluginAvailable === "function" && cap.isPluginAvailable(name) && plugins[name]);
}
```

### 9.2. Интерфейс

```js
TMNative.store            // "web" | "direct" | "rustore" | "googleplay"
TMNative.openExternal(url) // только https://; Browser-плагин, если есть, иначе location.href
                           // (Capacitor сам отдаёт системе переход на чужой хост — проверить на первой сборке);
                           // в браузере — location.assign(url)
TMNative.onResume(cb)      // App.addListener("appStateChange", s => s.isActive && cb()); в браузере — visibilitychange
TMNative.billing = {
  provider,                // "rustore" | "googleplay" | null
  isAvailable(),           // boolean: плагин магазина есть в сборке и подходит к TMNative.store
  getProducts(ids),        // Promise<{ [id]: { priceText } }>; ошибка → {}
  purchase(storeProductId, { orderId, userId }),
                           // Promise<{ provider, productId, purchaseToken, sandbox }>; отмена → Error с code "cancelled"
  pending(),               // Promise<[{ productId, purchaseToken, sandbox }]>; ошибка → []
};
TMNative.ads = {
  provider,                // "yandex" | "admob" | null
  adUnit,                  // id блока из TM_BUILD
  isAvailable(),
  showRewarded({ nonce, userId }), // Promise<{ rewarded: boolean }>
};
```

### 9.3. Реализация по провайдерам

- **RuStore** (`plugins.RuStorePay`, `store === "rustore"`):
  `purchase({productId, orderId, appUserId:userId})` → `{invoiceId, purchaseId, productId, sandbox}` →
  `purchaseToken = String(invoiceId)`; `getProducts({productIds})` → `products[].{productId, amountLabel}`;
  `getPurchases()` → `purchases[]` со статусом `CONFIRMED`. Отмена — reject с `code:"cancelled"`.
- **Google Play** (`plugins.NativePurchases`, `store === "googleplay"`):
  `purchaseProduct({productIdentifier, productType:"inapp", appAccountToken:userId, isConsumable:false, autoAcknowledgePurchases:false})`
  → `Transaction.purchaseToken`; `getProducts({productIdentifiers:ids, productType:"inapp"})` → `products[].{identifier, priceString}`;
  `getPurchases({productType:"inapp"})` → `purchases[].{productIdentifier, purchaseToken}`. `restorePurchases()` **не вызывать**
  (может сам подтвердить покупку). Отмену распознавать по `/cancel/i` в сообщении ошибки.
- **Яндекс** (`plugins.YandexRewarded`, `store` = `direct`|`rustore`, `BUILD.yandexRewarded` подходит под
  `/^(demo-rewarded-yandex|R-M-\d+-\d+)$/`): `load({adUnitId})` → `show()` → `{rewarded, amount, type}`.
- **AdMob** (`plugins.AdMob`, `store === "googleplay"`, `BUILD.admobRewarded` подходит под `/^ca-app-pub-\d{16}\/\d{10}$/`):
  один раз `initialize({})`, затем `requestConsentInfo()` → при `status === "REQUIRED"` и `isConsentFormAvailable` —
  `showConsentForm()`; если в ответе есть `canRequestAds === false` — рекламу не показывать.
  Показ: подписки `onRewardedVideoAdReward` (`earned = true`) и `onRewardedVideoAdDismissed`;
  `prepareRewardVideoAd({adId: adUnit, ssv: {userId, customData: nonce}})` → `showRewardVideoAd()` → ждать
  закрытия (не дольше 120 с) → снять подписки → `{rewarded: earned}`.

---------------------------------------------------------------------------------------------------

## 10. Сборки Android для магазинов

### 10.1. Переменные сборки

| Где задаётся | Имя | Пример | Смысл |
|---|---|---|---|
| Ввод ручного запуска | `store` | `direct` \| `rustore` \| `googleplay` | тип сборки; push всегда `direct` |
| Variables репозитория | `TM_YANDEX_REWARDED_ID` | `R-M-123456-1`, `demo-rewarded-yandex` | блок Яндекса (сборки `direct` и `rustore`) |
| Variables | `TM_ADMOB_APP_ID` | `ca-app-pub-1234567890123456~1234567890` | приложение AdMob (только `googleplay`) |
| Variables | `TM_ADMOB_REWARDED_ID` | `ca-app-pub-1234567890123456/1234567890` | блок AdMob |
| Variables | `TM_RUSTORE_CONSOLE_APP_ID` | `2063512345` | id приложения в RuStore Консоли (обязателен для `rustore`) |
| Variables | `TM_RUSTORE_PAY_SCHEME` | `trademonopoly.rustore` | схема deeplink для возврата из банковских приложений (обязательна для `rustore`) |
| Secrets (как сейчас) | `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | — | подпись; для `rustore` и `googleplay` **обязательна** |

Это Variables, а не Secrets: все id всё равно попадают в APK, а `vars` можно проверять в `if:`.
Отдельных секретов для магазинов нет: одна подпись для всех сборок (RuStore требует ту же подпись,
что у загруженной в консоль сборки; для Google Play это ключ загрузки при Play App Signing).

Проверка значений (одинаковая в `enable-native.mjs` и `copy-web.mjs`):

| Значение | Регулярное выражение |
|---|---|
| store | `^(direct\|rustore\|googleplay)$` |
| Яндекс | `^(demo-rewarded-yandex\|R-M-\d+-\d+)$` |
| AdMob app | `^ca-app-pub-\d{16}~\d{10}$` |
| AdMob unit | `^ca-app-pub-\d{16}/\d{10}$` |
| RuStore app id | `^\d{1,20}$` |
| RuStore scheme | `^[a-z][a-z0-9+.-]{2,40}$` |

### 10.2. `mobile/scripts/enable-native.mjs` (новый)

Запускается после `npm ci`, до `npm run android:init`, только если `TM_STORE != direct` или задан Яндекс.

| store | Ставит (`npm install --no-audit --no-fund …` правит только копию `package.json` в CI) | Обязательно |
|---|---|---|
| `direct` | `--install-links ./native/yandex-rewarded` — если задан `TM_YANDEX_REWARDED_ID` | — |
| `rustore` | `--install-links ./native/rustore-pay`; Яндекс — как выше | `TM_RUSTORE_CONSOLE_APP_ID`, `TM_RUSTORE_PAY_SCHEME` |
| `googleplay` | `--save-exact @capgo/native-purchases@8.8.1`; при `TM_ADMOB_APP_ID` — `--save-exact @capacitor-community/admob@8.1.0` | при AdMob — оба id AdMob |

- Яндекс в `googleplay` и AdMob в `direct`/`rustore` — игнорировать с предупреждением (никогда оба SDK в одной сборке).
- `npm install --no-save` не подходит: `cap sync` берёт плагины только из `dependencies` `package.json`.
- Пишет `mobile/.native-build.json` = `{store, plugins:[…], rustore:{appId, scheme}?, admob:{appId}?}` —
  его читает `patch-android.mjs`. Файл добавить в `.gitignore`.
- Любая ошибка проверки — `process.exit(1)` с понятным текстом.

### 10.3. `mobile/scripts/copy-web.mjs`

Если `TM_STORE` задан и не `direct`, или задан `TM_YANDEX_REWARDED_ID`/`TM_ADMOB_REWARDED_ID`, — рядом с
`TM_SERVER_URL` вставить (та же функция-замена и экранирование `<`):

```html
<script>window.TM_BUILD={"store":"rustore","yandexRewarded":"R-M-123456-1","admobRewarded":""};</script>
```

Значения — только прошедшие проверку 10.1. В сборке по умолчанию тега нет.

### 10.4. `mobile/scripts/patch-android.mjs`

Сейчас выключает `allowBackup`. Без `.native-build.json` — ровно это и всё. С ним дополнительно:

| Условие | Правка |
|---|---|
| есть `rustore-pay` | `android/build.gradle`, `allprojects.repositories`: `maven { url "https://nexus-external.rustore.ru/repository/maven-rustore-exposed" }` (иначе модуль `app` не найдёт зависимости SDK); `app/src/main/res/values/strings.xml`: `<string name="rustore_console_app_id">…</string>`, `<string name="rustore_pay_scheme">…</string>`; в `<application>` манифеста: `<meta-data android:name="console_app_id_value" android:value="@string/rustore_console_app_id"/>` и `<meta-data android:name="sdk_pay_scheme_value" android:value="@string/rustore_pay_scheme"/>` (числовой литерал в `android:value` Android прочитал бы как int); в `<activity>` MainActivity: `<intent-filter><action android:name="android.intent.action.VIEW"/><category android:name="android.intent.category.DEFAULT"/><category android:name="android.intent.category.BROWSABLE"/><data android:scheme="…"/></intent-filter>` |
| есть AdMob | в `<application>`: `<meta-data android:name="com.google.android.gms.ads.APPLICATION_ID" android:value="ca-app-pub-…~…"/>` (без него приложение падает при запуске — нет id → `exit 1`); в `android/variables.gradle`, внутрь блока `ext { }`: `playServicesAdsVersion = '25.4.0'` (у плагина по умолчанию плавающая `25.4.+`) |
| есть любой рекламный плагин | в `app/build.gradle`: `android { lint { disable.add('YandexAdsSdkOutdatedVersion') } }` (иначе `lintVitalRelease` валит релиз, как только выйдет новая версия SDK Яндекса); `android/gradle.properties`: `org.gradle.jvmargs=-Xmx4g` |

Каждая вставка проверяется (`includes`) и при неудаче — `exit 1`, как сейчас для `allowBackup`.

### 10.5. Локальные плагины

**`mobile/native/yandex-rewarded/`** — JS-имя `YandexRewarded`, методы `load({adUnitId})`, `show()` → `{rewarded, amount, type}`.
Полный код — приложение A.

**`mobile/native/rustore-pay/`** — JS-имя `RuStorePay`, пакет `com.xstatem.trademonopoly.rustorepay`.

```json
{ "name": "tm-rustore-pay", "version": "1.0.0", "private": true,
  "description": "Локальный Capacitor-плагин RuStore Pay SDK (ставится в CI только для store=rustore)",
  "capacitor": { "android": { "src": "android" } } }
```

`android/build.gradle`: как у Яндекса (приложение A), но `namespace = "com.xstatem.trademonopoly.rustorepay"`,
блок `repositories { google(); mavenCentral(); maven { url "https://nexus-external.rustore.ru/repository/maven-rustore-exposed" } }`
и зависимости `implementation platform('ru.rustore.sdk:bom:2026.08.01')`, `implementation 'ru.rustore.sdk:pay'`.

Контракт `RuStorePayPlugin.java` (`@CapacitorPlugin(name = "RuStorePay")`, Java API SDK 11.x):

| Метод | SDK | Ответ |
|---|---|---|
| `isAvailable()` | `RuStorePayClient.Companion.getInstance().getPurchaseInteractor().getPurchaseAvailability()` → `PurchaseAvailabilityResult.Available` / `.Unavailable` | `{available, reason?}` |
| `getProducts({productIds})` | `getProductInteractor().getProducts(List<ProductId>)` | `{products:[{productId, title, amountLabel}]}` |
| `purchase({productId, orderId, appUserId})` | `new ProductPurchaseParams(new ProductId(id), null /*quantity*/, orderId, null /*payload*/, appUserId, null /*email*/)`; `purchase(params, PreferredPurchaseType.ONE_STEP, SdkTheme.LIGHT, null)` | `{invoiceId, purchaseId, orderId, productId, sandbox}`; `RuStorePaymentException.ProductPurchaseCancelled` → `call.reject("cancelled", "cancelled")` |
| `getPurchases()` | `getPurchases(null, ProductPurchaseStatus.CONFIRMED, null)` | `{purchases:[{invoiceId, purchaseId, productId, sandbox}]}` |
| deeplink | в `load()`: `proceedIntent(getActivity().getIntent(), SdkTheme.LIGHT)`; override `handleOnNewIntent(Intent)` → `proceedIntent(intent, SdkTheme.LIGHT)` | — |

Порядок аргументов конструкторов и точные имена полей результата (`getInvoiceId()`, `getSandbox()` и т. п.)
сверить с Java-примерами `https://www.rustore.ru/help/sdk/pay/kotlin-java/11-1-0` — здесь нет Android SDK,
код компилируется только в CI. Все колбэки `Task` (`addOnSuccessListener`/`addOnFailureListener`) — с выходом
на главный поток через `getActivity().runOnUiThread` перед `call.resolve`, если SDK этого не гарантирует.
MainActivity не правим: плагины с `@CapacitorPlugin` регистрируются сами.

### 10.6. `.github/workflows/android.yml`

1. `workflow_dispatch.inputs.store`: `type: choice`, `options: [direct, rustore, googleplay]`, `default: direct`,
   описание «Сборка: direct — APK для сайта/Releases, rustore — для RuStore, googleplay — для Google Play».
2. `env` задачи `build`:
   ```yaml
   TM_STORE: ${{ github.event.inputs.store || 'direct' }}
   TM_YANDEX_REWARDED_ID: ${{ vars.TM_YANDEX_REWARDED_ID }}
   TM_ADMOB_APP_ID: ${{ vars.TM_ADMOB_APP_ID }}
   TM_ADMOB_REWARDED_ID: ${{ vars.TM_ADMOB_REWARDED_ID }}
   TM_RUSTORE_CONSOLE_APP_ID: ${{ vars.TM_RUSTORE_CONSOLE_APP_ID }}
   TM_RUSTORE_PAY_SCHEME: ${{ vars.TM_RUSTORE_PAY_SCHEME }}
   ```
3. `concurrency.group`: `android-build-${{ github.ref }}-${{ github.event.inputs.store || 'direct' }}`.
4. После «Установить зависимости»:
   ```yaml
   - name: Проверить подпись для сборки в магазин
     if: ${{ env.TM_STORE != 'direct' && env.HAS_KEYSTORE != 'true' }}
     run: |
       echo "Для сборки $TM_STORE нужна подпись: задайте секреты ANDROID_KEYSTORE_* (см. mobile/README.md)."
       exit 1
   - name: Платежи и реклама в приложении (только если настроены)
     if: ${{ env.TM_STORE != 'direct' || env.TM_YANDEX_REWARDED_ID != '' }}
     run: node scripts/enable-native.mjs
   ```
5. Шаг подписанного релиза не меняется (он уже срабатывает на ручной запуск и собирает `assembleRelease bundleRelease`).
6. Имя артефакта: `trade-monopoly-android${{ env.TM_STORE != 'direct' && format('-{0}', env.TM_STORE) || '' }}` —
   у `direct` прежнее имя, его скачивает `release`.
7. Задача `release`: к условию добавить
   `&& (github.event_name != 'workflow_dispatch' || github.event.inputs.store == '' || github.event.inputs.store == 'direct')` —
   магазинные сборки только в артефактах (для Google Play нужен `.aab` из `bundleRelease`).
8. Шапку файла дополнить двумя строками о ручном запуске для магазинов.

Без Variables и без ручного выбора `store` новые шаги пропускаются — сборка идёт как сегодня.
Первый запуск с рекламой — ручной, с `TM_YANDEX_REWARDED_ID=demo-rewarded-yandex`.

---------------------------------------------------------------------------------------------------

## 11. Сервер: подключение в `server.js`

```js
// Магазин и реклама (payments.js, ads.js). Без настроек в окружении
// маршруты отвечают «выключено», а каталог — {enabled:false}.
if (reqPath === "/api/shop/catalog" && req.method === "GET") return Payments.handleCatalog(req, res);
if (reqPath === "/api/shop/order" && req.method === "POST") return handleApiPostAsync(req, res, (b) => Payments.createOrder(b), { auth: true, limiter: shopLimit });
if (reqPath.startsWith("/api/shop/order/") && req.method === "GET") return Payments.handleOrderStatus(req, res, reqPath.slice("/api/shop/order/".length));
if (reqPath === "/api/shop/yookassa/webhook" && req.method === "POST") return Payments.handleYookassaWebhook(req, res, clientIp(req));
if (reqPath === "/api/shop/verify" && req.method === "POST") return handleApiPostAsync(req, res, (b) => Payments.verify(b), { auth: true, limiter: shopLimit });
if (reqPath === "/api/shop/entitlements" && req.method === "GET") return Payments.handleEntitlements(req, res);
if (reqPath === "/api/ads/start" && req.method === "POST") return handleApiPostAsync(req, res, (b) => Ads.start(b), { auth: true, limiter: shopLimit });
if (reqPath === "/api/ads/reward" && req.method === "POST") return handleApiPostAsync(req, res, (b) => Ads.reward(b), { auth: true, limiter: shopLimit });
if (reqPath === "/api/ads/admob-ssv" && req.method === "GET") return Ads.handleAdmobSsv(req, res);
```

- Чтобы не дублировать помощники, `server.js` при старте передаёт их в модули:
  `Payments.init({ sendJson, readJsonBody })`, `Ads.init({ sendJson })` (вебхук ЮKassa читает тело тем же
  `readJsonBody(req, 64 * 1024)`; подписи AdMob нужна только сырая строка запроса из `req.url`).
  `init` же запускает сверку заказов (5.5) и фоновые таймеры.
- `handleJoin`: `engine.addPlayer(room, profile.username, profile.gender, profile.avatar, profile.rating, profile.equippedBoardSkin)`.
- `syncAccountPoints`: без изменений (`users.addPoints` теперь возвращает рейтинг).
- `shutdown`: ничего нового — `orders.json` пишется сразу при каждом изменении.
- Таймеры `payments.js`/`ads.js` — с `unref()`, чтобы не держать процесс в тестах.

---------------------------------------------------------------------------------------------------

## 12. Новое главное меню

### 12.1. Что не так сейчас

Три равнозначные большие кнопки без главного действия; партия против ботов — 4–6 нажатий и ввод имени;
вход по коду комнаты спрятан за входом и раскрывающимся блоком; кнопка аккаунта висит в углу экрана
(на компьютере — далеко от колонки меню, на коротких телефонах контент уезжает под неё) и показывает
только ник; шапка с логотипом занимает около 140 px; светлое меню никак не намекает на тёмный игровой стол;
нет места для магазина и прогресса.

### 12.2. Разметка (заменяет содержимое `#mainMenu`)

Порядок в DOM — это порядок на телефоне. Все прежние id сохраняются вместе с их обработчиками.

```html
<div class="center-screen menu-screen" id="mainMenu">
  <div class="menu-shell">
    <header class="menu-top">
      <div class="brand brand-compact">
        <div class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
        <h1 class="brand-title">Trade Monopoly</h1>
      </div>
      <button type="button" class="account-chip" id="btnAccountMenu" aria-label="Войти в аккаунт">
        <span class="acc-dot" id="accountChipAvatar" aria-hidden="true"><svg class="ico ico-sm"><use href="#i-user"/></svg></span>
        <span class="acc-name" id="accountCornerLabel">Войти</span>
        <span class="acc-points" id="accountChipPoints" hidden><svg class="ico ico-sm" aria-hidden="true"><use href="#i-coins"/></svg><span></span></span>
        <svg class="ico ico-sm acc-crown" id="accountChipPremium" aria-hidden="true" hidden><use href="#i-crown"/></svg>
      </button>
    </header>

    <!-- #btnContinueOffline — прежняя разметка без изменений -->
    <!-- #tutorialOffer — прежняя разметка без изменений -->

    <section class="menu-hero theme-dark" aria-labelledby="menuPlayTitle">
      <div class="menu-ticker" id="menuTicker" aria-hidden="true"><div class="menu-ticker-track"></div></div>
      <h2 class="menu-hero-title" id="menuPlayTitle">Играть</h2>
      <p class="menu-hero-sub">Биржевая настольная игра: акции, недвижимость и интриги.</p>
      <button type="button" class="menu-quick" id="btnQuickPlay">
        <span class="menu-quick-icon"><svg class="ico" aria-hidden="true"><use href="#i-play"/></svg></span>
        <span class="menu-quick-text"><b>Играть с ботами</b><span id="quickPlaySub">Вы и 2 бота</span></span>
        <svg class="ico" aria-hidden="true"><use href="#i-chev-right"/></svg>
      </button>
      <div class="menu-modes">
        <button type="button" class="menu-mode online" id="btnGoOnline">
          <span class="menu-mode-icon"><svg class="ico" aria-hidden="true"><use href="#i-globe"/></svg></span>
          <b>Онлайн</b><span class="menu-mode-sub">С друзьями · рейтинг</span>
        </button>
        <button type="button" class="menu-mode offline" id="btnGoOffline">
          <span class="menu-mode-icon"><svg class="ico" aria-hidden="true"><use href="#i-device"/></svg></span>
          <b>На одном устройстве</b><span class="menu-mode-sub">До 6 игроков и боты</span>
        </button>
      </div>
      <button type="button" class="menu-code-toggle" id="btnShowRoomCode" aria-expanded="false" aria-controls="menuRoomCodeRow">Есть код комнаты?</button>
      <form class="menu-code-row" id="menuRoomCodeRow" hidden>
        <label class="sr-only" for="menuRoomCode">Код комнаты</label>
        <input id="menuRoomCode" maxlength="20" placeholder="Код комнаты" autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="go">
        <button type="submit" id="btnJoinByCode">Войти</button>
        <div class="err" id="menuRoomCodeErr" role="alert"></div>
      </form>
    </section>

    <button type="button" class="menu-row shop" id="btnGoShop" hidden>
      <span class="menu-row-icon"><svg class="ico" aria-hidden="true"><use href="#i-bag"/></svg></span>
      <span class="menu-row-text"><b>Магазин</b><span id="shopEntrySub">Скины, очки и Премиум</span></span>
      <span class="chip" id="shopEntryBalance" hidden></span>
    </button>
    <button type="button" class="menu-row tutorial" id="btnGoTutorial">
      <span class="menu-row-icon"><svg class="ico" aria-hidden="true"><use href="#i-help"/></svg></span>
      <span class="menu-row-text"><b>Обучение</b><span id="tutorialCardSub">Мини-партия с подсказками · 3 минуты</span></span>
      <svg class="ico" aria-hidden="true"><use href="#i-chev-right"/></svg>
    </button>
    <!-- .menu-grid (Рейтинг, Скины, Настройки, Правила) и .menu-links — прежняя разметка -->
  </div>
</div>
```

- Прежний `<button class="account-corner-btn show" id="btnAccountMenu">` в начале `<body>` **удалить**
  (кнопка переезжает в шапку меню). `showOnly` продолжает переключать класс `show` — для `.account-chip`
  он ни на что не влияет; правила `.account-corner-btn*` из CSS убрать, стиль `.acc-dot` перенести в `.account-chip .acc-dot`.
- Подзаголовок `.brand-sub` убрать (он есть в `<meta name="description">` и в `.menu-hero-sub`).

### 12.3. Сохраняемые и новые id

| Сохраняются (на них завязан код) | Новые |
|---|---|
| `mainMenu`, `btnAccountMenu`, `accountCornerLabel`, `btnContinueOffline`, `continueOfflineInfo`, `tutorialOffer`, `btnTutorialOfferStart`, `btnTutorialOfferClose`, `btnGoOnline`, `btnGoOffline`, `btnGoTutorial`, `tutorialCardSub`, `btnGoRating`, `btnGoSkins`, `btnGoSettings`, `btnGoRules`, ссылки `a[data-side-page]` | `accountChipAvatar`, `accountChipPoints`, `accountChipPremium`, `menuPlayTitle`, `menuTicker`, `btnQuickPlay`, `quickPlaySub`, `btnShowRoomCode`, `menuRoomCodeRow`, `menuRoomCode`, `btnJoinByCode`, `menuRoomCodeErr`, `btnGoShop`, `shopEntrySub`, `shopEntryBalance` |

### 12.4. Состояния

| Состояние | Как выглядит |
|---|---|
| Первый визит (нет сохранения, обучение не пройдено) | `#tutorialOffer` (решает `tutorial.js`), «Играть с ботами» — главная янтарная кнопка |
| Гость | чип: `i-user` + «Войти», `aria-label="Войти в аккаунт"`; «Играть с ботами» берёт имя из `tm_username` или «Игрок»; «Магазин» (если включён) ведёт на гейт входа |
| Вошёл | чип: аватар (эмодзи или фото 28 px), ник (до 14 символов с многоточием), `i-coins` + баланс; `aria-label="Аккаунт {ник}: {pointsLabel(points)}"`; `#shopEntryBalance` = баланс |
| Премиум | в чипе корона цвета `var(--amber)`, в `aria-label` «, Премиум»; `#shopEntrySub` = «Премиум активен · скины и очки» |
| Есть сохранённая партия | `#btnContinueOffline` получает класс `is-primary` (янтарный фон `var(--amber)`, текст `var(--on-amber)`), `#btnQuickPlay` — `is-secondary` (фон `var(--surface-2)`, текст `var(--text)`); переключает `renderContinueOffline()` |
| Магазин выключен | `#btnGoShop` с `hidden`; остальное меню выглядит законченным |

### 12.5. Поведение (функции во встроенном скрипте, раздел «Главное меню»)

**Играть с ботами** (раньше «Быстрая игра») (`btnQuickPlay`):
```js
function quickPlay(){
  let raw = accountUser && accountUser.username ? accountUser.username : "";
  if(!raw){ try { raw = localStorage.getItem("tm_username") || ""; } catch(e){} }
  raw = String(raw).trim();
  const name = /^[a-zA-Zа-яА-ЯёЁ0-9_\- ]{1,20}$/.test(raw) ? raw : "Игрок";
  const avatar = accountUser && accountUser.avatar && accountUser.avatar !== "PHOTO" ? accountUser.avatar : "";
  offlinePlayerNames = [{ name, gender: (accountUser && accountUser.gender) || "", avatar }];
  addOfflineBot(); addOfflineBot();     // «Бот 1», «Бот 2» — как кнопка «+ Бот»
  renderOfflinePlayersBox();
  document.getElementById("btnStartOffline").click(); // те же проверки, настройки формы и вопрос о замене сохранения
  // Форма офлайн-партии не прошла проверку (например, раньше в ней ввели неверную
  // плату за отказ) — показываем её вместе с текстом ошибки, а не молчим.
  if(mode !== "offline" && document.getElementById("offlineErr").textContent) showOnly("offlineSetup");
}
```
`#quickPlaySub` = «Вы и 2 бота · » + текст выбранного пункта `#offlineMaxRounds` (`sel.options[sel.selectedIndex].textContent.trim()`;
нет пункта — просто «Вы и 2 бота»). Обновлять в `renderContinueOffline()`. Сам селект **не трогать**.

**Код комнаты**: `btnShowRoomCode` переключает `hidden` у `#menuRoomCodeRow` и `aria-expanded`, при открытии —
фокус в поле. `submit` формы (`preventDefault`): `code = value.trim().toUpperCase()`; пусто → «Введите код комнаты.»;
не проходит `/^[^\u0000-\u001f\u007f<>"'&\\`]{1,20}$/` (как `ROOM_CODE_RE` сервера) → «Код не должен содержать
кавычек, угловых скобок и служебных символов.». Не вошли → `pendingMenuJoin = {code, at: Date.now()}`,
`openAccountModal("login")`, подсказка «Войдите — и мы сразу подключим вас к комнате.». Вошли → `joinRoomFromMenu(code)`:
`showOnly("onlineScreen"); renderOnlineGate(); doJoin(code);`. В `onAccountAuthed` перед `closeAccountModal()`:
если `pendingMenuJoin` моложе 5 минут — снять его и вызвать `joinRoomFromMenu(code)`.

**Чип аккаунта**: всё рисует `updateAccountCornerBtn()` (аватар — через `escapeHtml(avatarPhotoSrc(...))`,
как в модалке; баланс — `pointsLabel` в `aria-label` и число в чипе).

**Магазин**: `btnGoShop` → `Shop.open()`; видимость и подписи обновляет `Shop.onMenuShown()` из `showOnly("mainMenu")`.

**Тикер** (`renderMenuTicker()` один раз при загрузке): 10 случайных тикеров из `GameEngine.COMPANIES`, у каждого
случайное изменение ±0,1–4,9% («SBER ▲ 2,4%», цвета `var(--up)`/`var(--down)`), лента продублирована для бесшовной
прокрутки. Чисто декоративный (`aria-hidden`, без фокусируемых элементов).

### 12.6. Вид

- Мобильный (до 1023 px): одна колонка, `.menu-shell{max-width:440px;width:100%}`, отступы 16 px и safe-area как сейчас.
  Шапка: знак 40 px + «Trade Monopoly» 20 px/800 слева, чип справа (min-height 44 px).
- Герой: `.theme-dark` (тёмные токены внутри), фон
  `radial-gradient(120% 140% at 10% 0%, var(--stage-c1), var(--stage-c2) 55%, var(--stage-c3))` — следует за
  экипированной темой стола; рамка `1px solid var(--line-strong)`, радиус `var(--r-2xl)`, тень `var(--shadow-1)`.
- «Играть с ботами»: `background:var(--primary)` (в тёмной теме #E0B168), `color:var(--on-primary)`, высота 64 px,
  радиус `var(--r-xl)`. Карточки режимов: сетка 2 колонки (1 колонка уже 360 px), `background:var(--surface-2)`,
  значки в плитках 40 px: онлайн `var(--accent)`, устройство `var(--clay)`.
- Остальное меню — светлое, как сейчас: `.menu-row` (высота ≥ 64 px, белая полупрозрачная карточка как `.menu-card.tutorial`),
  `.menu-grid`, `.menu-links`.
- Компьютер (≥1024×600): `.menu-shell{max-width:920px;display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,.9fr);column-gap:20px;align-content:start}`;
  `.menu-top{grid-column:1 / -1}`; `.menu-hero{grid-column:1;grid-row:2 / span 6;align-self:start}`;
  все прочие дети — `grid-column:2`. Скрытые (`hidden`) места не занимают.
- Движение: при первом показе меню за сессию дети `.menu-shell` появляются (opacity 0→1, translateY 8px→0, 220 мс,
  задержка 30 мс шаг, не больше 8 элементов; класс `menu-enter`, снимается через 700 мс). Тикер — `animation` 40 с
  linear infinite; на `document.hidden` — `animation-play-state:paused`; при `body.reduce-motion` и
  `prefers-reduced-motion` — явно `animation:none` (глобальное правило оставило бы одну итерацию).
  Наведение на компьютере: `translateY(-1px)` + тень. Нажатие — существующее `scale(.98)`.

### 12.7. Доступность

- Бренд остаётся `h1`, у героя видимый `h2` и `aria-labelledby`.
- Поле кода — с подписью `.sr-only`, `autocapitalize="characters"`, `enterkeyhint="go"`, `maxlength="20"`.
- Всё скрытое — атрибутом `hidden` (глобальное `[hidden]{display:none !important}` уже есть).
- Цели ≥44 px, фокус `var(--focus)`, Премиум — значок и текст в `aria-label` (не только цвет).
- `tutorial.js` после закрытия предложения ставит фокус на `#btnGoTutorial` — кнопка всегда видна.

---------------------------------------------------------------------------------------------------

## 13. Тесты

Все существующие проверки (`npm test` в `server/`: `check`, `engine`, `smoke`) должны проходить.

- `check.js` сам проверит синтаксис новых `server/*.js` и `public/shop.js` и наличие файлов из `SHELL`.
- Новый набор `server/test/shop.test.js`, в `run-all.js`: `{ name: "shop", file: "shop.test.js", title: "магазин, заказы, реклама" }`.
  Сервер поднимается как в `smoke.js` (свободный порт, временный `DATA_DIR`).
  1. **Без настроек**: `GET /api/shop/catalog` → `{enabled:false}`; `POST /api/shop/order`, `/api/ads/start` → 404;
     `GET /api/ads/admob-ssv` → 404. Подготовленный старый `users.json` (`points:500`, `ownedAvatarPacks:["base","legend"]`)
     → после входа `rating === 500`, `points === 500`; покупка скина за очки (`emerald`, 200) уменьшает `points`, а `rating` — нет;
     `/api/leaderboard` сортирует по `rating` и содержит `points === rating`; `buySkin` для `gold` и `wallstreet` отказывает.
     Хеш пароля для подготовленной записи — как в `users.js`: `crypto.scryptSync(password, salt, 64).toString("hex")`.
  2. **`PAYMENTS_MOCK=1`, `ADS_REWARD_POINTS=10`, `ADS_MIN_WATCH_SEC=0`, `ADS_COOLDOWN_SEC=0`, `ADS_DAILY_CAP=2`**:
     каталог `enabled:true, mock:true`; заказ `tm_points_300` → баланс +300, рейтинг тот же; `tm_premium` →
     `premium:true`, +300, все платные скины и `gold`/`neon`/`bulls` доступны; повтор `tm_premium` → `already_owned`;
     `verify` mock с одним токеном дважды → одна выдача (`alreadyGranted:true` во втором ответе); `GET /api/shop/order/:id`
     чужим токеном → 404; без токена → `auth_required`; два видео → +20, третье → `ads_cap`; перезапуск сервера →
     заказы на месте, повторного начисления нет (сверка идемпотентна).
  3. **Чистые функции** (через `require` с `process.env.DATA_DIR` во временную папку): `ykPaymentOk`, `rustoreInvoiceOk`,
     `googlePurchaseOk` на подготовленных объектах; IP-список ЮKassa (`185.71.76.5`, `::ffff:77.75.156.11`,
     `2a02:5180::1` — да, `8.8.8.8` — нет); `parseAdmobSsv` + `verifyWithKey` на своём ключе P-256 (верная подпись проходит,
     изменённый `reward_amount` — нет); id товаров соответствуют `/^[a-z0-9][a-z0-9_]*$/`.
  4. По желанию — поддельная ЮKassa на `http.createServer` + `YOOKASSA_API_URL` (вместе с `PAYMENTS_MOCK=1`):
     создание платежа, вебхук `payment.succeeded` → выдача, повтор вебхука → без второй выдачи.
- Нативные плагины здесь не собрать (нет Android SDK): проверка — ручной запуск workflow со `store=rustore`
  и `store=googleplay`, затем установка на телефон.

---------------------------------------------------------------------------------------------------

## 14. Документы и развёртывание

- `deploy/README.md`, раздел «Настройки»: добавить переменные из 6.1 (секреты помечены), строку про Render (6.4),
  адреса вебхуков `https://<сайт>/api/shop/yookassa/webhook` и `https://<сайт>/api/ads/admob-ssv`.
  nginx менять не нужно: `/api/` проксируется целиком, строка запроса не меняется (это важно для подписи AdMob).
  Вебхук ЮKassa требует HTTPS на 443 — его даёт certbot из `install.sh`.
- `MONETIZATION.md` в корне проекта (для владельца, по шагам, со списком «что проверить»):
  1. Юридическое: статус (самозанятый / ИП / ООО), оферта, политика конфиденциальности, `SHOP_SELLER`,
     возвраты; RuStore Pay — только ИП/ООО (с 01.02.2026); чеки.
  2. ЮKassa: тестовый магазин → ключи → `/etc/birzha.env` → URL вебхука → тестовые карты
     (успех `5555555555554444`, с 3-D Secure `5555555555554477`, отказ `4562265587712390`) → боевой магазин.
  3. RuStore: публикация, Монетизация → товары с теми же id и ценами, ключ API → env, тестировщики песочницы,
     Variables для CI, ручной запуск `store=rustore`, загрузка APK, подписанного тем же ключом.
  4. Google Play: предупреждение о выплатах (см. §15), товары, сервисный аккаунт и права, лицензионные тестеры,
     `store=googleplay`, загрузка `.aab`, декларации «Contains ads», Advertising ID, Data safety, аудитория 13+.
  5. Реклама: РСЯ (приложение из карточки RuStore, блок rewarded, сначала `demo-rewarded-yandex`), AdMob
     (приложение, блок, SSV-колбэк, сообщение согласия UMP), `ADS_*` на сервере.
  6. Как отозвать покупку RuStore вручную (остановить сервер, отметить заказ `refunded`, запустить — сверка спишет).
- `CHANGES-2026-10-12.md` — что поменялось для игроков и для владельца.
- `mobile/README.md` — раздел «Сборки для RuStore и Google Play».

---------------------------------------------------------------------------------------------------

## 15. Вопросы и риски для владельца

1. **Видео и покупки дают очки баланса, а не рейтинг** (Р1). Если нужно именно «очки рейтинга» — это одна правка
   в `users.applyOrder`/`claimAdReward`, но тогда место в таблице можно купить.
2. **Google Play**: с 26.12.2024 Google не платит разработчикам с российским счётом, Play Billing и AdMob не работают
   для пользователей в России. Play-сборка имеет смысл только с иностранным платёжным профилем.
3. **RuStore**: оплата через RuStore Pay — только ИП/ООО; разрешает ли RuStore ЮKassa внутри приложения — проверить
   (по умолчанию выключено, `YOOKASSA_IN_RUSTORE`). Без политики конфиденциальности модерация не пропустит SDK рекламы.
4. **Реклама Яндекса без серверной проверки**: изменённый клиент может получить до `ADS_DAILY_CAP` наград в сутки на аккаунт.
   РСЯ платит только за приложения, опубликованные в магазине (APK с GitHub — через блок приложения из карточки RuStore).
5. **Чеки**: самозанятому — вручную в «Мой налог» (`YOOKASSA_RECEIPTS=off`); ИП/ООО — `on` и ставка НДС.
6. **Логотипы реальных компаний** в игре используются без лицензии; с платной версией риск претензий по товарным
   знакам растёт. Вариант: выключать «Логотипы компаний» по умолчанию в магазинных сборках.
7. **Накрутка очков** (для владельца движка, не в этой работе): хост с вторым аккаунтом и стартовым капиталом
   до 10 млн получает до 5000 очков за партию. Когда очки стоят денег, награду нужно нормировать на стартовый капитал.
8. **Пароль от 4 символов и нет email**: аккаунты с покупками лучше защищать — минимум 6 символов для новых и
   необязательный email для восстановления (отдельная задача).
9. **Render free**: временный диск — платежи там не включать.

---------------------------------------------------------------------------------------------------

## Приложение A. Локальный плагин `YandexRewarded`

`mobile/native/yandex-rewarded/package.json`:
```json
{ "name": "tm-yandex-rewarded", "version": "1.0.0", "private": true,
  "description": "Локальный Capacitor-плагин: реклама с вознаграждением Яндекса (ставится в CI только при TM_YANDEX_REWARDED_ID)",
  "capacitor": { "android": { "src": "android" } } }
```

`mobile/native/yandex-rewarded/android/build.gradle`:
```groovy
apply plugin: 'com.android.library'

android {
    namespace = "com.xstatem.trademonopoly.yandexrewarded"
    compileSdk = rootProject.ext.compileSdkVersion
    defaultConfig { minSdkVersion rootProject.ext.minSdkVersion }
    compileOptions {
        sourceCompatibility JavaVersion.VERSION_21
        targetCompatibility JavaVersion.VERSION_21
    }
    // Иначе lintVitalRelease роняет релизную сборку, как только выходит новая версия SDK.
    lint { disable.add('YandexAdsSdkOutdatedVersion') }
}

dependencies {
    implementation project(':capacitor-android')
    implementation 'com.yandex.android:mobileads:8.5.0'
}
```

`mobile/native/yandex-rewarded/android/src/main/AndroidManifest.xml`:
```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application>
        <!-- SDK не стартует вместе с приложением: инициализируется перед первым запросом рекламы. -->
        <meta-data android:name="com.yandex.mobile.ads.AUTOMATIC_SDK_INITIALIZATION" android:value="false" />
    </application>
</manifest>
```

`mobile/native/yandex-rewarded/android/src/main/java/com/xstatem/trademonopoly/yandexrewarded/YandexRewardedPlugin.java`:
```java
package com.xstatem.trademonopoly.yandexrewarded;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.yandex.mobile.ads.common.AdError;
import com.yandex.mobile.ads.common.AdRequest;
import com.yandex.mobile.ads.common.AdRequestError;
import com.yandex.mobile.ads.common.ImpressionData;
import com.yandex.mobile.ads.rewarded.Reward;
import com.yandex.mobile.ads.rewarded.RewardedAd;
import com.yandex.mobile.ads.rewarded.RewardedAdEventListener;
import com.yandex.mobile.ads.rewarded.RewardedAdLoadListener;
import com.yandex.mobile.ads.rewarded.RewardedAdLoader;

// Реклама с вознаграждением Яндекса: load({adUnitId}) → show() → {rewarded, amount, type}.
// Очки здесь не начисляются: это делает сервер по одноразовому билету (POST /api/ads/reward).
@CapacitorPlugin(name = "YandexRewarded")
public class YandexRewardedPlugin extends Plugin {
    private RewardedAdLoader loader;
    private RewardedAd ad;
    private PluginCall showCall;
    private boolean earned;
    private int amount;
    private String type = "";

    @PluginMethod
    public void load(PluginCall call) {
        String unit = call.getString("adUnitId", "");
        if (unit == null || unit.isEmpty()) { call.reject("adUnitId required"); return; }
        getActivity().runOnUiThread(() -> {
            if (loader == null) loader = new RewardedAdLoader(getActivity());
            if (ad != null) { ad.setAdEventListener(null); ad = null; }
            loader.loadAd(new AdRequest.Builder(unit).build(), new RewardedAdLoadListener() {
                @Override public void onAdLoaded(RewardedAd loaded) { ad = loaded; call.resolve(); }
                @Override public void onAdFailedToLoad(AdRequestError e) {
                    call.reject(e.getDescription(), String.valueOf(e.getCode()));
                }
            });
        });
    }

    @PluginMethod
    public void show(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (ad == null) { call.reject("not-loaded"); return; }
            if (showCall != null) { call.reject("busy"); return; }
            showCall = call; earned = false; amount = 0; type = "";
            final RewardedAd current = ad;
            ad = null; // одно объявление показывается один раз
            current.setAdEventListener(new RewardedAdEventListener() {
                @Override public void onAdShown() {}
                @Override public void onAdFailedToShow(AdError e) { current.setAdEventListener(null); finish(e.getDescription()); }
                @Override public void onAdDismissed() { current.setAdEventListener(null); finish(null); }
                @Override public void onAdClicked() {}
                @Override public void onAdImpression(ImpressionData d) {}
                @Override public void onRewarded(Reward r) { earned = true; amount = r.getAmount(); type = r.getType(); }
            });
            current.show(getActivity());
        });
    }

    private void finish(String error) {
        PluginCall c = showCall;
        showCall = null;
        if (c == null) return;
        if (error != null && !earned) { c.reject(error); return; }
        JSObject res = new JSObject();
        res.put("rewarded", earned);
        res.put("amount", amount);
        res.put("type", type);
        c.resolve(res);
    }

    @Override
    protected void handleOnDestroy() {
        if (loader != null) loader.cancelLoading();
        if (ad != null) ad.setAdEventListener(null);
        ad = null;
        loader = null;
    }
}
```

API SDK 8 сверено с документацией Яндекса и с исходником `@quenary/capacitor-yandex-ads` (SDK 8.2.0); код
компилируется только в CI — первый прогон делать ручным запуском с `demo-rewarded-yandex`.

## Приложение B. Источники

- ЮKassa API v3: https://yookassa.ru/developers/api · вебхуки: https://yookassa.ru/developers/using-api/webhooks ·
  тестирование: https://yookassa.ru/developers/using-api/testing · чеки: https://yookassa.ru/developers/payment-acceptance/receipts/basics
- RuStore Pay SDK 11.1.0: https://www.rustore.ru/help/sdk/pay/kotlin-java/11-1-0 · токен API:
  https://www.rustore.ru/help/work-with-rustore-api/api-authorization-token · счёт:
  https://www.rustore.ru/help/work-with-rustore-api/api-subscription-payment/v2-purchase-invoiceid
- Google Play Developer API: https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.products ·
  выплаты в РФ: https://support.google.com/googleplay/android-developer/answer/11950272
- `@capgo/native-purchases@8.8.1` (npm, MPL-2.0), `@capacitor-community/admob@8.1.0` (npm, MIT)
- AdMob SSV: https://developers.google.com/admob/android/ssv · ключи: https://www.gstatic.com/admob/reward/verifier-keys.json
- Яндекс, реклама с вознаграждением (Android): https://ads.yandex.com/helpcenter/en/dev/android/rewarded —
  серверного колбэка награды нет (проверено 12.10.2026)
