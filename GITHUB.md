# GitHub: отправить изменения и получить APK

APK собирает GitHub Actions (`.github/workflows/android.yml`) — на своём компьютере Android SDK не нужен.
Изменения отправляет скрипт `tools/push-to-github.ps1`: он кладёт эту папку проекта в отдельную ветку
репозитория <https://github.com/XSTATEM/MonopolyGame>, а GitHub собирает из неё APK.

## Один раз

1. Установите [Git for Windows](https://git-scm.com/download/win) (с ним ставится Git Credential Manager).
2. Укажите автора коммитов:
   ```powershell
   git config --global user.name "Ваше имя"
   git config --global user.email "you@example.ru"
   ```
3. Аккаунт GitHub должен иметь право записи в репозиторий. При первой отправке откроется окно входа
   в GitHub (браузер) — это Git Credential Manager, пароль скрипт не видит и не хранит.

## Отправить изменения

В PowerShell, из папки проекта:

```powershell
# посмотреть, что уйдёт на GitHub, ничего не отправляя
powershell -ExecutionPolicy Bypass -File .\tools\push-to-github.ps1 -DryRun

# отправить в ветку feature/<сегодняшняя дата>
powershell -ExecutionPolicy Bypass -File .\tools\push-to-github.ps1 -Message "Магазин (выключен по умолчанию), новое главное меню, сборки для RuStore и Google Play"
```

`-ExecutionPolicy Bypass` действует только на этот запуск и настройки Windows не меняет.

Что делает скрипт:

1. Клонирует репозиторий в `%TEMP%\tm-push-XSTATEM-MonopolyGame` (при следующем запуске берёт этот
   клон и только подтягивает свежие изменения).
2. Создаёт ветку `feature/<дата>` от `master`. Если такая ветка уже есть на GitHub, новый коммит
   ляжет поверх неё.
3. Переносит файлы проекта, кроме `node_modules`, `server\data`, `mobile\www`, `mobile\android`,
   `*.log`, `.claude` и черновых папок `scratch`. Файлы, которых в проекте больше нет, удаляются и в ветке.
4. Показывает список изменений. Удаляемые файлы выделены жёлтым: если среди них чужие свежие правки с
   GitHub, ответьте «нет» и сначала перенесите их в проект.
5. После ответа «да» коммитит и отправляет ветку. Печатает ссылки на сборку, готовый APK и pull request.

Параметры:

| Параметр | Что делает |
|---|---|
| `-Branch feature/monetization` | своя ветка вместо `feature/<дата>` |
| `-Message "…"` | текст коммита |
| `-DryRun` | только показать изменения |
| `-Yes` | не спрашивать «Отправить?» |
| `-ClonePath D:\git\MonopolyGame` | использовать свой клон (без незакоммиченных изменений) |
| `-Repo владелец/репозиторий` | другой репозиторий (например, форк) |
| `-Base master` | от какой ветки отводить новую |

Скрипт никогда не делает force-push. В `master` он отправит, только если указать `-Branch master` и
ввести имя ветки для подтверждения: сборка из `master` сразу становится общей ссылкой для всех игроков.
Обычный путь — ветка → проверить APK на телефоне → pull request в `master`.

## Где APK

1. **Сборка.** Actions → **Android APK** → запуск по вашей ветке (ссылку печатает скрипт), 10–20 минут.
   Сборка запускается сама, если в коммите есть изменения в `server/public`, `mobile` или в самом
   workflow. Иначе запустите вручную: **Run workflow** → Use workflow from: ваша ветка.
2. **Файл.** Когда сборка стала зелёной: Releases → pre-release «Тестовая сборка для Android: <ветка>»
   (тег `android-branch-…`) → `trade-monopoly.apk`. Прямую ссылку тоже печатает скрипт, её можно открыть
   с телефона.
3. **Установка.** Откройте файл на телефоне и разрешите установку из неизвестных источников. Сборки веток
   отладочные: чтобы новая версия вставала поверх прежней, один раз задайте секрет
   `ANDROID_DEBUG_KEYSTORE_BASE64` (`mobile/README.md`). Иначе перед обновлением приложение придётся
   удалить, и офлайн-партия пропадёт.
4. После слияния в `master` APK публикуется под постоянной ссылкой
   <https://github.com/XSTATEM/MonopolyGame/releases/download/android-latest/trade-monopoly.apk>
   (подписанный, если заданы секреты подписи).

Тот же файл есть в Artifacts запуска (`trade-monopoly-android`, zip, нужен вход в GitHub).

## Сборки для RuStore и Google Play

Только ручным запуском: Actions → **Android APK** → **Run workflow**:

- **Use workflow from** — ваша ветка (или `master`);
- **Адрес онлайн-сервера** — адрес вашего сервера (пусто — переменная `TM_SERVER_URL`);
- **Сборка** — `rustore` или `googleplay`.

Результат — в Artifacts запуска: `trade-monopoly-android-rustore` (`app-release.apk` для RuStore
Консоли) или `trade-monopoly-android-googleplay` (`app-release.aab` для Play Console). В Releases такие
сборки не публикуются, общая ссылка не меняется.

Без подписи (секреты `ANDROID_KEYSTORE_*`) сборки для магазинов останавливаются с понятной ошибкой.
Для `rustore` дополнительно нужны переменные `TM_RUSTORE_CONSOLE_APP_ID` и `TM_RUSTORE_PAY_SCHEME`.

- Нет поля «Сборка» в форме — выбрана ветка со старым workflow: выберите ветку с этими изменениями.
- Нет кнопки **Run workflow** — GitHub показывает её только для workflow из основной ветки; сначала
  слейте изменения в `master`.
- То же из командной строки (GitHub CLI):
  `gh workflow run android.yml --repo XSTATEM/MonopolyGame --ref feature/2026-10-12 -f store=rustore`.

Что настроить в RuStore, Google Play, РСЯ и AdMob, — `MONETIZATION.md`.

## Секреты и переменные

GitHub → репозиторий → **Settings → Secrets and variables → Actions**.

**Secrets** (значения никто не видит, даже в журнале сборки):

| Имя | Что это |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | ключ подписи релиза `release.keystore` в base64 |
| `ANDROID_KEYSTORE_PASSWORD` | пароль хранилища ключей |
| `ANDROID_KEY_ALIAS` | имя ключа (например, `trademonopoly`) |
| `ANDROID_KEY_PASSWORD` | пароль ключа |
| `ANDROID_DEBUG_KEYSTORE_BASE64` | постоянный ключ отладочных сборок (чтобы обновления вставали поверх) |

Ключ создаётся один раз (нужна Java, команда `keytool`), base64 — в PowerShell:

```powershell
keytool -genkey -v -keystore release.keystore -alias trademonopoly -keyalg RSA -keysize 2048 -validity 10000
[Convert]::ToBase64String([IO.File]::ReadAllBytes("release.keystore")) | Set-Clipboard   # в буфер обмена
```

Храните `release.keystore` и пароли в надёжном месте, не в репозитории: без них не выпустить обновление
в RuStore и Google Play.

**Variables** (не секреты: эти id всё равно видны внутри APK):

| Имя | Пример | Для чего |
|---|---|---|
| `TM_SERVER_URL` | `https://game.example.ru` | адрес вашего сервера во всех сборках (без него — бесплатный Render, где магазина нет) |
| `TM_YANDEX_REWARDED_ID` | `demo-rewarded-yandex`, `R-M-123456-1` | видео Яндекса в обычной сборке и в сборке для RuStore |
| `TM_RUSTORE_CONSOLE_APP_ID` | `2063512345` | id приложения в RuStore Консоли (обязательно для `rustore`) |
| `TM_RUSTORE_PAY_SCHEME` | `trademonopoly.rustore` | схема возврата из приложений банков (обязательно для `rustore`) |
| `TM_ADMOB_APP_ID` | `ca-app-pub-…~…` | AdMob, только `googleplay` |
| `TM_ADMOB_REWARDED_ID` | `ca-app-pub-…/…` | блок AdMob с вознаграждением |

Переменные действуют на все сборки: задав `TM_YANDEX_REWARDED_ID`, вы включите видео и в обычном APK
из Releases. Ключи ЮKassa, RuStore API и Google в GitHub не нужны — они живут только на сервере.

## Если что-то пошло не так

- **«В git не указаны имя и email»** — выполните команды из раздела «Один раз».
- **Ошибка входа или «Permission denied»** — войдите в GitHub в окне Git Credential Manager под
  аккаунтом с правом записи. Либо отправляйте в свой форк: `-Repo ваш-логин/MonopolyGame`.
- **«rejected» / «fetch first»** — в ветке на GitHub появились чужие коммиты: запустите скрипт ещё раз
  (он подтянет их) или укажите другую ветку `-Branch`.
- **Сборка красная** — откройте запуск, шаг с ошибкой. Ошибки переменных магазинов объяснены прямо в
  журнале. Если упала компиляция плагина (сборки `rustore`/`googleplay` или с рекламой), пришлите
  разработчику фрагмент журнала с именем Java-файла и номером строки (`mobile/README.md`).
- **Скрипт не запускается** («выполнение сценариев отключено») — запускайте через
  `powershell -ExecutionPolicy Bypass -File …`, как в примерах.
