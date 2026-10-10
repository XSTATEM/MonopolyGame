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

Свежая сборка сразу публикуется на странице **Releases** репозитория — прямая ссылка
на `trade-monopoly.apk`, без zip и без входа в GitHub, её можно открыть прямо с телефона:

- из `master`: <https://github.com/XSTATEM/MonopolyGame/releases/download/android-latest/trade-monopoly.apk>
- из другой ветки: pre-release с тегом `android-branch-<ветка>-<хеш имени ветки>`
  (ссылка печатается в конце шага «Опубликовать APK в Releases» и видна на странице Releases).

Тот же файл лежит в разделе **Artifacts** у запуска (`trade-monopoly-android`, zip, нужен вход).
APK ставится на телефон напрямую: разрешите установку из неизвестных источников.
Ручной запуск с адресом сервера, отличным от стандартного, в Releases не публикуется.

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
   Сборки из других веток и pull request'ов остаются отладочными: ключ подписи
   доступен только шагу подписи и не попадает в зависимости и gradle.

Храните `release.keystore` в надёжном месте: без него нельзя выпускать обновления
того же приложения в Google Play.

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

## Иконки и сплэш

Исходники лежат в `resources/`, их генерирует `npm run icons`
(`scripts/make-icons.py`, нужен Python с Pillow). Скрипт же обновляет PWA-иконки
в `server/public`. Нативные размеры создаёт `@capacitor/assets` (`npm run assets`),
он вызывается внутри `android:init` / `ios:init`.

Папки `android/`, `ios/`, `www/` и `node_modules/` генерируются и в git не хранятся.
Если понадобятся ручные правки нативного проекта (например, deep links), уберите
`android/` или `ios/` из `.gitignore` и закоммитьте проект.
