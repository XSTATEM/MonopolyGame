#!/usr/bin/env bash
# Установка «Биржи» на чистый сервер Ubuntu 22.04/24.04 или Debian 12.
#
#   sudo bash deploy/install.sh --domain game.example.ru --email you@example.ru
#   sudo bash deploy/install.sh --no-tls          # без домена: http://IP-сервера
#
# Параметры:
#   --domain NAME    домен, A-запись которого уже указывает на этот сервер
#   --email ADDR     почта для Let's Encrypt (уведомления об истечении сертификата)
#   --no-tls         не получать HTTPS-сертификат
#   --port N         внутренний порт Node.js (по умолчанию 8792, наружу не открывается)
#   --node-major N   мажорная версия Node.js (по умолчанию 22 LTS)
#   --no-firewall    не настраивать ufw
#   --import-data    перенести server/data/users.json из загруженной копии (аккаунты)
#
# Скрипт можно запускать повторно: он доустановит недостающее и обновит код.
# Получая сертификат, вы соглашаетесь с условиями Let's Encrypt (--agree-tos).
set -euo pipefail

DOMAIN=""
EMAIL=""
PORT=8792
PORT_SET=0
NODE_MAJOR=22
TLS=1
FIREWALL=1
IMPORT_DATA=0
APP_DIR=/opt/birzha
DATA_DIR=/var/lib/birzha
APP_USER=birzha
ENV_FILE=/etc/birzha.env

usage(){ sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
log(){ printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die(){ printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; PORT_SET=1; shift 2 ;;
    --node-major) NODE_MAJOR="${2:-}"; shift 2 ;;
    --no-tls) TLS=0; shift ;;
    --no-firewall) FIREWALL=0; shift ;;
    --import-data) IMPORT_DATA=1; shift ;;
    -h|--help) usage 0 ;;
    *) warn "Неизвестный параметр: $1"; usage 1 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "Запустите от root: sudo bash $0 ..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
[ -f "$SRC_DIR/server/server.js" ] || die "Не найден $SRC_DIR/server/server.js — запускайте скрипт из загруженной копии проекта."
command -v apt-get >/dev/null 2>&1 || die "Нужен Debian/Ubuntu (apt-get)."
[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || die "--port: число от 1024 до 65535"
[[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] || die "--node-major должен быть числом"
if [ -n "$DOMAIN" ] && ! [[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then die "Некорректный домен: $DOMAIN"; fi
if [ "$TLS" -eq 1 ] && [ -z "$DOMAIN" ]; then
  warn "Домен не указан — HTTPS не настраивается. Игра откроется по http://IP, но установка как приложения (PWA) и мобильное приложение требуют HTTPS."
  TLS=0
fi
if [ "$TLS" -eq 1 ] && [ -z "$EMAIL" ]; then die "Для сертификата Let's Encrypt укажите --email (или --no-tls)."; fi

# Файлы, скопированные с Windows, могли приехать с CRLF — bash и systemd их не поймут.
find "$SCRIPT_DIR" -maxdepth 1 -type f \( -name '*.sh' -o -name '*.conf' -o -name '*.service' -o -name '*.timer' \) -exec sed -i 's/\r$//' {} +

export DEBIAN_FRONTEND=noninteractive

log "Системные пакеты"
apt-get update -y
apt-get install -y --no-install-recommends ca-certificates curl xz-utils nginx
if [ "$TLS" -eq 1 ]; then apt-get install -y --no-install-recommends certbot python3-certbot-nginx; fi
if [ "$FIREWALL" -eq 1 ]; then apt-get install -y --no-install-recommends ufw; fi

log "Node.js $NODE_MAJOR"
install_node(){
  local arch base tmp file
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) die "Неподдерживаемая архитектура: $(uname -m)" ;;
  esac
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  tmp="$(mktemp -d)"
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  file="$(grep -oE "node-v[0-9.]+-linux-${arch}\.tar\.xz" "$tmp/SHASUMS256.txt" | head -n1)"
  [ -n "$file" ] || die "Не найдена сборка Node.js $NODE_MAJOR для linux-$arch"
  curl -fsSL "$base/$file" -o "$tmp/$file"
  (cd "$tmp" && grep " ${file}\$" SHASUMS256.txt | sha256sum -c - >/dev/null) || die "Контрольная сумма Node.js не совпала"
  rm -rf /usr/local/lib/nodejs
  mkdir -p /usr/local/lib/nodejs
  tar -xJf "$tmp/$file" -C /usr/local/lib/nodejs --strip-components=1
  ln -sf /usr/local/lib/nodejs/bin/node /usr/local/bin/node
  ln -sf /usr/local/lib/nodejs/bin/npm /usr/local/bin/npm
  ln -sf /usr/local/lib/nodejs/bin/npx /usr/local/bin/npx
  rm -rf "$tmp"
}
current_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$current_major" -lt "$NODE_MAJOR" ]; then install_node; fi
hash -r
NODE_BIN="$(command -v node)"
echo "Node.js $("$NODE_BIN" -v) — $NODE_BIN"

log "Пользователь и каталоги"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --no-create-home --shell /usr/sbin/nologin "$APP_USER"
install -d -m 755 "$APP_DIR"
install -d -m 750 -o "$APP_USER" -g "$APP_USER" "$DATA_DIR" "$DATA_DIR/backups"
if [ "$IMPORT_DATA" -eq 1 ]; then
  if [ ! -f "$SRC_DIR/server/data/users.json" ]; then
    warn "--import-data: в загруженной копии нет server/data/users.json — переносить нечего."
  elif [ -f "$DATA_DIR/users.json" ]; then
    warn "--import-data: $DATA_DIR/users.json уже есть — не перезаписываю."
  else
    install -m 640 -o "$APP_USER" -g "$APP_USER" "$SRC_DIR/server/data/users.json" "$DATA_DIR/users.json"
    echo "Аккаунты перенесены в $DATA_DIR/users.json"
  fi
fi

log "Настройки ($ENV_FILE)"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<EOF
# Настройки сервера «Биржи». После правки: sudo systemctl restart birzha
NODE_ENV=production
# Node.js слушает только localhost — снаружи к нему ходят через nginx.
HOST=127.0.0.1
PORT=$PORT
DATA_DIR=$DATA_DIR
# Сервер стоит за nginx: доверять X-Forwarded-For/-Proto (IP игроков, кука с флагом Secure).
TRUST_PROXY=1
# Через сколько часов удалять комнату, в которой никого нет.
ROOM_TTL_HOURS=12
EOF
elif [ "$PORT_SET" -eq 1 ]; then
  sed -i "s/^PORT=.*/PORT=$PORT/" "$ENV_FILE"
fi
# Магазин и реклама: только закомментированные заготовки — без ключей всё выключено.
# Дописываются один раз, в том числе в файл от прежней установки.
if ! grep -q 'YOOKASSA_SHOP_ID' "$ENV_FILE"; then
  cat >> "$ENV_FILE" <<'EOF'

# --- Магазин и реклама (необязательно; см. deploy/README.md и MONETIZATION.md) ---
# Пока строки закомментированы, магазина и рекламы нет. Секреты храните только здесь,
# файлы ключей — в /etc/birzha/ (права 640, владелец root:birzha).
# ЮKassa — карты и СБП на сайте и в APK:
#YOOKASSA_SHOP_ID=
#YOOKASSA_SECRET_KEY=
#YOOKASSA_RETURN_URL=https://game.example.ru
#YOOKASSA_RECEIPTS=off
#YOOKASSA_VAT_CODE=1
#YOOKASSA_TAX_SYSTEM=
#YOOKASSA_PAYMENT_SUBJECT=service
#YOOKASSA_IN_RUSTORE=off
# RuStore Pay — сборка для RuStore:
#RUSTORE_KEY_ID=
#RUSTORE_PRIVATE_KEY=
#RUSTORE_PRIVATE_KEY_FILE=/etc/birzha/rustore.key
#RUSTORE_APP_ID=
#RUSTORE_ALLOW_SANDBOX=off
# Google Play — международная сборка:
#GOOGLE_PLAY_PACKAGE=com.xstatem.trademonopoly
#GOOGLE_PLAY_SERVICE_ACCOUNT=/etc/birzha/google-play.json
#GOOGLE_PLAY_ALLOW_TEST=off
# Видео с наградой (0 — выключено):
#ADS_REWARD_POINTS=10
#ADS_DAILY_CAP=5
#ADS_COOLDOWN_SEC=180
#ADS_MIN_WATCH_SEC=10
#ADMOB_SSV=off
#ADMOB_AD_UNITS=
# Подвал магазина (продавец, оферта, политика конфиденциальности):
#SHOP_SELLER=ИП Иванов И. И., ИНН 000000000000, support@example.ru
#SHOP_OFFER_URL=https://game.example.ru/offer.html
#SHOP_PRIVACY_URL=https://game.example.ru/privacy.html
EOF
fi
chown root:"$APP_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"
# Каталог для файлов ключей магазинов (RuStore, Google Play): служба его только читает.
install -d -m 750 -o root -g "$APP_USER" /etc/birzha
PORT="$(sed -n 's/^PORT=//p' "$ENV_FILE" | tail -n1)"
PORT="${PORT:-8792}"

log "Службы systemd"
sed -e "s#__NODE_BIN__#$NODE_BIN#g" -e "s#__APP_DIR__#$APP_DIR#g" -e "s#__DATA_DIR__#$DATA_DIR#g" \
  "$SCRIPT_DIR/birzha.service" > /etc/systemd/system/birzha.service
install -m 755 "$SCRIPT_DIR/backup.sh" /usr/local/bin/birzha-backup
install -m 644 "$SCRIPT_DIR/birzha-backup.service" "$SCRIPT_DIR/birzha-backup.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable birzha.service >/dev/null 2>&1
systemctl enable --now birzha-backup.timer >/dev/null 2>&1

log "Код игры"
bash "$SCRIPT_DIR/update.sh"

log "nginx"
SERVER_NAME="${DOMAIN:-_}"
sed -e "s#__SERVER_NAME__#$SERVER_NAME#g" -e "s#__PORT__#$PORT#g" "$SCRIPT_DIR/nginx-birzha.conf" > /etc/nginx/sites-available/birzha
if [ -z "$DOMAIN" ]; then
  # Без домена сайт отвечает на любой адрес, в том числе на голый IP.
  sed -i -e 's/listen 80;/listen 80 default_server;/' -e 's/listen \[::\]:80;/listen [::]:80 default_server;/' /etc/nginx/sites-available/birzha
fi
ln -sf /etc/nginx/sites-available/birzha /etc/nginx/sites-enabled/birzha
# Стандартная заглушка nginx перехватывала бы запросы по IP.
if [ "$(readlink -f /etc/nginx/sites-enabled/default 2>/dev/null)" = "/etc/nginx/sites-available/default" ]; then
  rm -f /etc/nginx/sites-enabled/default
fi
nginx -t
systemctl enable nginx >/dev/null 2>&1
systemctl reload nginx || systemctl restart nginx

if [ "$TLS" -eq 1 ]; then
  log "HTTPS-сертификат Let's Encrypt для $DOMAIN"
  # Повторный запуск переписывает конфиг nginx заново — certbot возвращает в
  # него уже выпущенный сертификат (--keep-until-expiring), а не выпускает новый.
  if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect --keep-until-expiring; then
    systemctl reload nginx
  else
    warn "Не удалось получить сертификат. Проверьте, что A-запись $DOMAIN указывает на IP этого сервера и порт 80 открыт, затем запустите скрипт ещё раз."
  fi
fi

if [ "$FIREWALL" -eq 1 ]; then
  log "Брандмауэр (ufw)"
  ssh_ports="$(sshd -T 2>/dev/null | awk '$1=="port"{print $2}' || true)"
  [ -n "$ssh_ports" ] || ssh_ports=22
  for p in $ssh_ports; do ufw allow "$p/tcp" >/dev/null; done
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
  ufw status | sed 's/^/   /'
fi

if [ "$TLS" -eq 1 ]; then URL="https://$DOMAIN"; elif [ -n "$DOMAIN" ]; then URL="http://$DOMAIN"; else URL="http://$(hostname -I | awk '{print $1}') (или внешний IP сервера)"; fi

log "Готово"
cat <<EOF
   Игра:            $URL
   Проверка:        curl -fsS http://127.0.0.1:$PORT/healthz
   Журнал:          journalctl -u birzha -f
   Перезапуск:      systemctl restart birzha
   Настройки:       $ENV_FILE
   Данные:          $DATA_DIR (резервные копии — $DATA_DIR/backups, ежедневно)
   Обновление:      загрузите новую копию проекта и выполните  sudo bash deploy/update.sh
EOF
