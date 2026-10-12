# Trade Monopoly — мобильное приложение

Нативная оболочка (Android и iOS) на [Capacitor 8](https://capacitorjs.com) вокруг того же
веб-клиента, что раздаёт сервер (`server/public`). Отдельного кода игры у приложения нет:
любое изменение интерфейса в `server/public` попадает в приложение при следующей сборке.

Есть три способа поставить игру на телефон.

| Способ | Что нужно | Офлайн-партия | Онлайн |
|---|---|---|---|
| **PWA** — «Добавить на главный экран» в браузере | ничего | да (service worker `sw.js`) | да |
| **APK для Android** со страницы Releases | ничего | да | да |
| **Сборка в Android Studio / Xcode** | SDK на своём компьютере | да | да |

## APK без установки SDK

Workflow `.github/workflows/android.yml` собирает APK при каждом push с изменениями в
`server/public/**` или `mobile/**` (в любой ветке), а также вручную:
**Actions → Android APK → Run workflow**.
При ручном запуске можно указать адрес своего сервера.
Отправить изменения в отдельную ветку одной командой — `tools/push-to-github.ps1`, см. `GITHUB.md`.

Свежая сборка сразу публикуется на странице **Releases** репозитория — прямая ссылка
на `trade-monopoly.apk`, без zip и без входа в GitHub, её можно открыть прямо с телефона:

- из `master`: <https://github.com/XSTATEM/MonopolyGame/releases/download/android-latest/trade-monopoly.apk>
- из другой ветки: pre-release с тегом `android-branch-<ветка>-<хеш имени ветки>`
  (ссылка печатается в конце шага «Опубликовать APK в Releases» и видна на странице Releases).

Тот же файл лежит в разделе **Artifacts** у запуска (`trade-monopoly-android`, zip, нужен вход).
APK ставится на телефон напрямую: разрешите установку из неизвестных источников.
Ручной запуск с адресом сервера, отличным от стандартного, в Releases не публикуется.

**Свой сервер по умолчанию.** В **Settings → Secrets and variables → Actions → Variables**
задайте `TM_SERVER_URL` = `https://game.example.ru` (только `https://` и домен, без пути).
Тогда все сборки — и из push, и ручные с пустым полем адреса — ходят на ваш сервер, а сборки
из `master` по-прежнему публикуются в Releases. Без переменной — `https://birzha-multiplayer.onrender.com`.

### Чтобы обновления ставились поверх прежней версии

Android ставит новую версию поверх старой, только если обе подписаны одним ключом.
Без настройки каждая отладочная сборка подписывается новым случайным ключом: перед
обновлением приложение приходится удалять, и офлайн-партия пропадает. Чтобы этого не было,
один раз задайте постоянный ключ отладочной сборки:

1. Создайте его (нужна Java):
   `keytool -genkeypair -keystore debug.keystore -storepass android -alias androiddebugkey -keypass android -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US"`
2. В **Settings → Secrets and variables → Actions** добавьте секрет
   `ANDROID_DEBUG_KEYSTORE_BASE64` — вывод `base64 -w0 debug.keystore`.

Со следующей сборки обновления ставятся поверх. Последний раз перед этим приложение
придётся удалить вручную (у уже установленной версии другой ключ).

### Подписанный релиз для Google Play

1. Создайте ключ:
   `keytool -genkey -v -keystore release.keystore -alias trademonopoly -keyalg RSA -keysize 2048 -validity 10000`
2. В **Settings → Secrets and variables → Actions** добавьте:
   - `ANDROID_KEYSTORE_BASE64` — вывод `base64 -w0 release.keystore`
   - `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`
3. Следующий запуск workflow из `master`, по тегу или вручную дополнительно соберёт
   подписанные `app-release.apk` и `app-release.aab` (последний загружается в Play Console).
   Сборки из других веток и pull request'ов остаются отладочными. Gradle собирает релиз
   **без подписи и без секретов** (его скрипты, в том числе скрипты сторонних плагинов, ключа
   не видят), а подписывает отдельный шаг «Подписать релиз» инструментами `apksigner`
   (APK, после `zipalign`) и `jarsigner` (AAB) — код проекта в нём не запускается.

Храните `release.keystore` в надёжном месте: без него нельзя выпускать обновления
того же приложения в Google Play.

## Сборки для RuStore и Google Play

Обычная сборка (каждый push и ручной запуск по умолчанию) — **`direct`**: без покупок
через магазин приложений и без рекламы, ровно как раньше. Покупки и видео с наградой
попадают в APK, только если их включили, — набор плагинов зависит от типа сборки.

| Сборка | Как запустить | Что внутри | Где результат |
|---|---|---|---|
| `direct` | push или **Run workflow** (store: `direct`) | веб-клиент; видео Яндекса — если задан `TM_YANDEX_REWARDED_ID` | Releases (`trade-monopoly.apk`) и Artifacts `trade-monopoly-android` |
| `rustore` | **Run workflow** → store: `rustore` | RuStore Pay SDK (плагин `native/rustore-pay`); видео Яндекса — если задано | Artifacts `trade-monopoly-android-rustore` → `app-release.apk` |
| `googleplay` | **Run workflow** → store: `googleplay` | Google Play Billing (`@capgo/native-purchases@8.8.1`); AdMob (`@capacitor-community/admob@8.1.0`) — если заданы оба id | Artifacts `trade-monopoly-android-googleplay` → `app-release.aab` для Play Console |

Сборки `rustore` и `googleplay` в Releases не публикуются и общую ссылку на APK не меняют.
Оплата картой и СБП через ЮKassa работает в `direct` и на сайте и в сборке ничего не
требует — её включают настройками сервера (`MONETIZATION.md` в корне проекта). В `googleplay`
ЮKassa не показывается никогда (правила Google Play), в `rustore` — только если на
сервере включено `YOOKASSA_IN_RUSTORE`.

### Что задать в GitHub

**Settings → Secrets and variables → Actions**, вкладка **Variables** (не Secrets: все эти
id всё равно видны внутри APK, а Variables можно проверять в условиях workflow):

| Variable | Пример | Для чего |
|---|---|---|
| `TM_YANDEX_REWARDED_ID` | `demo-rewarded-yandex`, `R-M-123456-1` | видео Яндекса в `direct` и `rustore` |
| `TM_RUSTORE_CONSOLE_APP_ID` | `2063512345` | id приложения в RuStore Консоли — **обязательно** для `rustore` |
| `TM_RUSTORE_PAY_SCHEME` | `trademonopoly.rustore` | схема возврата из приложений банков (СБП, SberPay) — **обязательно** для `rustore` |
| `TM_ADMOB_APP_ID` | `ca-app-pub-1234567890123456~1234567890` | приложение AdMob (только `googleplay`) |
| `TM_ADMOB_REWARDED_ID` | `ca-app-pub-1234567890123456/1234567890` | рекламный блок AdMob «с вознаграждением» |
| `TM_SERVER_URL` | `https://game.example.ru` | адрес вашего сервера для всех сборок (см. выше). Для `rustore` и `googleplay` — обязательно свой сервер: на бесплатном Render магазина нет, сборка предупредит об этом в журнале |

- **Подпись** обязательна для `rustore` и `googleplay`: секреты `ANDROID_KEYSTORE_*`
  из раздела выше, один ключ для всех сборок. RuStore принимает обновление только с той же
  подписью, что у версии в консоли; для Google Play это ключ загрузки (Play App Signing).
- **Яндекс и AdMob никогда не попадают в одну сборку**: в `googleplay` переменная Яндекса
  пропускается, в `direct`/`rustore` — переменные AdMob (в журнале будет «Внимание: …»).
- **Variables действуют на все сборки.** Как только задан `TM_YANDEX_REWARDED_ID`, видео
  Яндекса появится и в обычном APK из push (и на странице Releases). Начните с
  `demo-rewarded-yandex` (тестовый блок Яндекса), проверьте ручным запуском, затем замените
  на id своего блока из кабинета РСЯ.
- Новых секретов для магазинов нет: ключи API RuStore, Google Play и ЮKassa живут только на
  сервере, не в приложении.

Сборка **останавливается с понятной ошибкой**, если: для `rustore`/`googleplay` нет подписи;
у id, который нужен **этой** сборке, неверный формат; для `rustore` не заданы оба значения
RuStore; для AdMob задан только один из двух id. Тогда исправьте Variables и запустите
workflow снова. Ошибка в переменной, которая этой сборке не нужна (например, кривой id AdMob
при обычной сборке `direct`), сборку не останавливает — в журнале будет «Внимание: … задан с
ошибкой». Правила проверяет и шаг «Проверить правила сборки» (`npm test` в `mobile/`).

### Как это устроено

1. Шаг «Платежи и реклама в приложении» — `scripts/enable-native.mjs`: проверяет
   переменные (общие правила — `scripts/build-flavor.mjs`), ставит только нужные плагины
   (`npm install` правит `package.json` лишь в копии на машине CI) и пишет
   `.native-build.json`. В сборке `direct` без рекламы шаг пропускается.
2. `scripts/copy-web.mjs` добавляет в `index.html` строку
   `window.TM_BUILD = {store, yandexRewarded, admobRewarded}` — по ней
   `server/public/native.js` включает `TMNative.billing` и `TMNative.ads`. В обычной сборке
   этой строки нет, и магазин в приложении работает как на сайте.
3. `scripts/patch-android.mjs` по `.native-build.json` дописывает в Android-проект:
   для RuStore — репозиторий `nexus-external.rustore.ru` (в конец списка), строки
   `rustore_console_app_id` / `rustore_pay_scheme`, meta-data `console_app_id_value` и
   `sdk_pay_scheme_value`, intent-filter со схемой в `MainActivity`; для AdMob — meta-data
   `com.google.android.gms.ads.APPLICATION_ID` и версию Google Mobile Ads `25.4.0`; для любой
   рекламы — отключение lint-проверки `YandexAdsSdkOutdatedVersion` и 4 ГБ памяти gradle.
4. Локальные плагины (Java, собираются только в CI):
   - `native/yandex-rewarded` — `YandexRewarded.load({adUnitId})` → `show()` →
     `{rewarded, amount, type}`, Yandex Mobile Ads SDK 8.5.0;
   - `native/rustore-pay` — `RuStorePay.isAvailable()`, `getProducts({productIds})`,
     `purchase({productId, appUserId})` → `{invoiceId, purchaseId, productId, sandbox}`,
     `getPurchases()`; RuStore Pay SDK (BOM `2026.08.01`).

Очки, Премиум и наборы начисляет **только сервер** после проверки у провайдера: плагины
лишь проводят оплату или показ видео и сообщают результат.

### Первая сборка каждого вида — проверить на телефоне

Java-код плагинов здесь не компилируется (нет Android SDK), поэтому первый прогон каждого
вида — ручной, с проверкой на устройстве:

- **direct + `demo-rewarded-yandex`** — в магазине игры кнопка «Смотреть видео» показывает
  тестовое видео; очки придут, если на сервере `ADS_REWARD_POINTS` больше 0.
- **rustore** — установите на телефон RuStore и войдите аккаунтом тестировщика песочницы,
  поставьте `app-release.apk` (подписан тем же ключом, что версия в консоли), купите
  `tm_points_300`; на сервере на время проверки — `RUSTORE_ALLOW_SANDBOX=on`. Обязательно
  проверьте **оплату через СБП (или SberPay) с переходом в приложение банка**: после оплаты
  телефон должен вернуться в игру, шторка RuStore — закрыться сама, а очки — прийти. Наш
  `MainActivity` (шаблон Capacitor) запускается в режиме `singleTask`, а документация RuStore Pay
  показывает `singleTop`; при шторке внутри экрана игры оба режима ведут себя одинаково, но если
  шторка после возврата из банка пропала или покупка «зависла» (очки пришли лишь при следующем
  запуске) — пришлите описание: тогда переключим `launchMode` для сборки `rustore` в
  `scripts/patch-android.mjs`.
- **googleplay** — загрузите `app-release.aab` во внутреннее тестирование Play Console,
  добавьте себя в лицензионные тестеры, установите из Play; на сервере — `GOOGLE_PLAY_ALLOW_TEST=on`.
  Для первых сборок с рекламой задайте **тестовые id Google**:
  `TM_ADMOB_APP_ID` = `ca-app-pub-3940256099942544~3347511713`,
  `TM_ADMOB_REWARDED_ID` = `ca-app-pub-3940256099942544/5224354917`. Просмотры и нажатия
  настоящих блоков во время проверки AdMob считает недействительным трафиком и может
  ограничить новый аккаунт. С тестовыми блоками колбэк SSV не приходит — на сервере на это
  время `ADMOB_SSV=off`. Потом замените id на свои и включите `ADMOB_SSV=on`. Игрокам из
  ЕЭЗ и Великобритании приложение при запуске покажет форму согласия Google (UMP), а в
  «Настройках» появится кнопка «Настройки рекламы (конфиденциальность)»; форму согласия
  настройте в AdMob → Конфиденциальность и сообщения.

Если сборка упала на компиляции плагина, в журнале шага «Собрать отладочный APK» (для
`direct`) или «Собрать релиз без подписи» (для `rustore` и `googleplay`) будет имя Java-файла
и строка — пришлите этот фрагмент.

### Магазинная сборка локально

```bash
cd mobile
export TM_STORE=rustore TM_RUSTORE_CONSOLE_APP_ID=2063512345 TM_RUSTORE_PAY_SCHEME=trademonopoly.rustore
export TM_YANDEX_REWARDED_ID=demo-rewarded-yandex      # по желанию
node scripts/enable-native.mjs   # ставит плагины, пишет .native-build.json
npm run android:init             # те же переменные нужны и здесь (copy-web.mjs)
```

Скрипт меняет `package.json` и `package-lock.json` — после проверки верните их
(`git checkout -- package.json package-lock.json`) и удалите `.native-build.json` и `android/`.
`copy-web.mjs` сверяет переменные с `.native-build.json`: запуск `npm run sync` или
`android:init` с другим `TM_STORE`, чем у установленных плагинов, останавливается с
подсказкой, а `patch-android.mjs` отказывается работать, если плагина из этого файла нет в
`package.json` и `node_modules` (остаток прошлой магазинной сборки).

## Локальная сборка

Нужны Node.js 22+, а для Android — JDK 21 и Android Studio (Android SDK 36).

```bash
cd mobile
npm install
npm run android:init     # копирует веб-клиент, создаёт android/, иконки и сплэш
npm run android:open     # открыть в Android Studio и запустить на устройстве
# или сразу собрать отладочный APK:
npm run android:apk      # → android/app/build/outputs/apk/debug/app-debug.apk
```

iOS (только на macOS с Xcode): `npm run ios:init && npm run ios:open`.

После изменений в `server/public` выполните `npm run sync`: он скопирует веб-клиент
и обновит нативные проекты.

### Адрес сервера

Офлайн-режим (хот-сит с ботами) работает без сети. Для онлайн-игры приложение
подключается к серверу из переменной `TM_SERVER_URL` во время сборки, а без неё — к
`https://birzha-multiplayer.onrender.com`. Адрес должен быть `https://host[:port]`
без пути и параметров; в готовом приложении он не меняется.

```bash
TM_SERVER_URL=https://my-server.example npm run sync
```

Сервер разрешает запросы к `/api/*` из приложения: CORS для `https://localhost` и
`capacitor://localhost` настроен в `server/server.js` (`APP_ORIGINS`).

## Что умеет оболочка (`server/public/native.js`)

- **Кнопка «Назад» на Android.** Сначала закрывает модалку, оверлей или меню
  (`handleBackNavigation` в `index.html`), а на главном экране сворачивает приложение.
- **Системные панели.** Светлые значки во время партии на тёмном столе, тёмные — в меню.
  Отступы под вырезы и панели задаются через `env(safe-area-inset-*)` / `--safe-area-inset-*`.
- **Вибрация** при броске кубиков: Haptics, в браузере — `navigator.vibrate`.
- **Экран не гаснет**, пока идёт партия (Screen Wake Lock).
- **Офлайн.** Шрифты (`server/public/fonts`, SIL OFL) и иконки лежат внутри
  приложения, внешних CDN нет.
- **Покупки и видео с наградой** (`TMNative.store`, `TMNative.billing`, `TMNative.ads`) —
  только в сборках, где их включили (см. «Сборки для RuStore и Google Play»); в браузере
  и в обычной сборке это безопасные пустышки.

## Иконки и сплэш

Исходники лежат в `resources/`, их генерирует `npm run icons`
(`scripts/make-icons.py`, нужен Python с Pillow). Скрипт же обновляет PWA-иконки
в `server/public`. Нативные размеры создаёт `@capacitor/assets` (`npm run assets`),
он вызывается внутри `android:init` / `ios:init`.

Папки `android/`, `ios/`, `www/`, `node_modules/` и файл `.native-build.json` генерируются
и в git не хранятся.
Если понадобятся ручные правки нативного проекта (например, deep links), уберите
`android/` или `ios/` из `.gitignore` и закоммитьте проект.
