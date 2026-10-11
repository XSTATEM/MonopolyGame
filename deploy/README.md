# Развёртывание «Биржи» на своём сервере

Игра — один процесс Node.js (`server/server.js`): он раздаёт веб-клиент, API аккаунтов
и WebSocket онлайн-партий. Внешняя база не нужна: аккаунты лежат в `users.json`,
идущие партии сервер держит в памяти и сохраняет в `rooms.json` (каждые 30 секунд
и при остановке), так что перезапуск или обновление не обрывают игру — клиенты
переподключаются сами.

Схема на сервере:

```
Интернет ──443/80──▶ nginx (TLS, gzip, лимит попыток входа) ──▶ 127.0.0.1:8792 Node.js (systemd: birzha)
                                                                     │
                                                    /var/lib/birzha: users.json, rooms.json, backups/
```

## Что понадобится

- VPS с **Ubuntu 22.04 / 24.04** или **Debian 12**, 1 vCPU и 512 МБ памяти хватает
  на десятки одновременных партий. Доступ по SSH под `root` или пользователем с `sudo`.
- **Домен** (или поддомен), A-запись которого указывает на IP сервера. Без домена
  игра заработает по `http://IP`, но браузер не даст установить её как приложение (PWA),
  а мобильное приложение требует HTTPS.
- Открытые порты 22, 80, 443 у хостинга (скрипт сам настроит `ufw` на сервере).

## Установка за одну команду (с Windows)

В PowerShell из корня проекта:

```powershell
.\deploy\deploy.ps1 -Server 203.0.113.10 -Install -Domain game.example.ru -Email you@example.ru
```

Скрипт упакует `server\` и `deploy\`, скопирует их на сервер по `scp` и запустит
`deploy/install.sh`. Если входите не под root — добавьте `-User имя` (понадобится пароль sudo),
нестандартный порт SSH — `-SshPort 2222`. Перенести локальные аккаунты с вашего компьютера:
`-ImportData`.

## Установка вручную (с любой ОС)

```bash
# на своём компьютере
scp -r server deploy root@203.0.113.10:/root/birzha/
# на сервере
ssh root@203.0.113.10
sudo bash /root/birzha/deploy/install.sh --domain game.example.ru --email you@example.ru
```

Без домена: `sudo bash deploy/install.sh --no-tls`. Все параметры: `bash deploy/install.sh --help`.

Что делает `install.sh` (его можно запускать повторно):

1. ставит nginx, certbot, ufw и Node.js 22 LTS (официальная сборка с nodejs.org,
   с проверкой контрольной суммы);
2. создаёт системного пользователя `birzha` без shell и каталог данных `/var/lib/birzha`;
3. пишет настройки в `/etc/birzha.env`, ставит службу `birzha` (systemd, с изоляцией:
   процесс может писать только в каталог данных) и ежедневный бэкап `birzha-backup.timer`;
4. выкладывает код в `/opt/birzha/app` и запускает сервер (через `update.sh`);
5. настраивает nginx: проксирование WebSocket, gzip, заголовки безопасности,
   не больше 10 попыток входа в минуту с одного IP;
6. получает сертификат Let's Encrypt и включает редирект на HTTPS
   (продление — автоматически, таймером certbot);
7. включает брандмауэр: открыты только SSH, 80 и 443.

## Обновление

С Windows: `.\deploy\deploy.ps1 -Server game.example.ru`

Вручную: загрузите свежие `server/` и `deploy/` и выполните `sudo bash deploy/update.sh`.

`update.sh` ставит зависимости в отдельный каталог, подменяет им рабочий и перезапускает
службу. Если новая версия не ответила на `/healthz` за 20 секунд, возвращается прежняя
(неудачная остаётся в `/opt/birzha/app.failed` для разбора).

## Повседневные команды

| Задача | Команда |
|---|---|
| Состояние службы | `systemctl status birzha` |
| Журнал в реальном времени | `journalctl -u birzha -f` |
| Перезапуск (партии сохранятся) | `sudo systemctl restart birzha` |
| Проверка | `curl -fsS http://127.0.0.1:8792/healthz` |
| Бэкап вручную | `sudo -u birzha /usr/local/bin/birzha-backup` |
| Список бэкапов | `ls -lh /var/lib/birzha/backups` |
| Журнал nginx | `tail -f /var/log/nginx/birzha.error.log` |

### Восстановление из бэкапа

```bash
sudo systemctl stop birzha
sudo tar -xzf /var/lib/birzha/backups/birzha-YYYYMMDD-HHMMSS.tar.gz -C /var/lib/birzha
sudo chown -R birzha:birzha /var/lib/birzha
sudo systemctl start birzha
```

## Настройки (`/etc/birzha.env`)

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `HOST` | `127.0.0.1` | на каком адресе слушает Node.js (наружу — только через nginx) |
| `PORT` | `8792` | внутренний порт |
| `DATA_DIR` | `/var/lib/birzha` | аккаунты, сохранённые партии, бэкапы |
| `TRUST_PROXY` | `1` | доверять `X-Forwarded-*` от nginx: реальный IP игрока и флаг `Secure` у куки |
| `ROOM_TTL_HOURS` | `12` | через сколько часов без игроков удалять заброшенную комнату |
| `TM_DEBUG` | — | `1` включает отладочную кнопку внеочередного события (не для продакшна) |

После правки: `sudo systemctl restart birzha`.

## Мобильное приложение со своим сервером

Приложение (Capacitor, папка `mobile/`) ходит на адрес, зашитый при сборке.
Чтобы оно подключалось к вашему серверу:

- **GitHub Actions**: *Actions → Android APK → Run workflow*, в поле «Адрес онлайн-сервера»
  укажите `https://game.example.ru`. Чтобы это был адрес по умолчанию для всех сборок,
  поменяйте `default:` и `TM_SERVER_URL` в `.github/workflows/android.yml`.
- **Локальная сборка**: в `mobile/` выполните `TM_SERVER_URL=https://game.example.ru npm run sync`
  (или `npm run android:apk`), подробнее — `mobile/README.md`.
- Запасной адрес на случай сборки без переменной — `DEFAULT_SERVER` в `server/public/native.js`.

Адрес должен быть `https://` — Android запрещает незащищённые соединения.

## Docker вместо systemd

```bash
docker compose -f deploy/docker-compose.yml up -d --build
```

Данные — в томе `birzha-data`. Порт открыт только на `127.0.0.1:8792`: перед контейнером
поставьте nginx с конфигом `deploy/nginx-birzha.conf` (подставьте `__SERVER_NAME__` и `__PORT__`).

## Переезд с Render и выбор адреса

- Игра должна жить в корне домена или поддомена (`https://game.example.ru/`), а не в подкаталоге:
  клиент, service worker и WebSocket используют абсолютные пути от корня.
- Выберите один адрес (с `www` или без) и используйте только его: вход в аккаунт и офлайн-сохранение
  хранятся в браузере отдельно для каждого адреса.
- На новом адресе браузерные игроки один раз войдут в аккаунт заново. Сами аккаунты переедут,
  только если перенести `users.json` со старого сервера (`-ImportData` / `--import-data`);
  у бесплатного Render диск временный, и там его может уже не быть.

## Если что-то пошло не так

- **Страница не открывается** — `systemctl status birzha nginx`, затем `journalctl -u birzha -n 50`.
- **Certbot не выдал сертификат** — проверьте A-запись (`dig +short game.example.ru` должен
  вернуть IP сервера) и что порт 80 открыт у хостинга; затем запустите `install.sh` ещё раз.
- **Онлайн-партия всё время «переподключается»** — WebSocket режет промежуточный прокси.
  Если перед сервером стоит Cloudflare, включите в нём WebSockets.
- **После обновления у игроков старый интерфейс** — service worker обновляется при
  следующем открытии страницы; обычная перезагрузка вкладки помогает сразу.
