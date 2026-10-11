#!/usr/bin/env bash
# Обновление кода «Биржи» на сервере без потери аккаунтов и идущих партий.
#
#   sudo bash deploy/update.sh
#
# Берёт каталог server/ рядом со скриптом, ставит зависимости в отдельный
# каталог, подменяет им рабочий и перезапускает службу. Перед остановкой
# сервер сохраняет партии на диск, после запуска — восстанавливает, игроки
# переподключаются сами. Если новая версия не ответила на /healthz,
# возвращается прежняя.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/birzha}"
ENV_FILE=/etc/birzha.env

log(){ printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die(){ printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Запустите от root: sudo bash $0"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "$SCRIPT_DIR/.." && pwd)/server"
[ -f "$SRC/server.js" ] || die "Не найден $SRC/server.js"
[ -f /etc/systemd/system/birzha.service ] || die "Служба birzha не установлена — сначала запустите deploy/install.sh"
command -v npm >/dev/null 2>&1 || die "Не найден npm — сначала запустите deploy/install.sh"

PORT="$(sed -n 's/^PORT=//p' "$ENV_FILE" 2>/dev/null | tail -n1)"
PORT="${PORT:-8792}"

health(){
  local i
  for i in $(seq 1 20); do
    curl -fsS --max-time 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

log "Копирую код из $SRC"
rm -rf "$APP_DIR/app.new"
mkdir -p "$APP_DIR/app.new"
tar -C "$SRC" --exclude=./node_modules --exclude=./data --exclude=./.claude --exclude='*.log' -cf - . | tar -C "$APP_DIR/app.new" -xf -

log "Зависимости (npm ci)"
(cd "$APP_DIR/app.new" && npm ci --omit=dev --no-audit --no-fund)
chown -R root:root "$APP_DIR/app.new"
chmod -R u=rwX,go=rX "$APP_DIR/app.new"

log "Переключаю версию"
rm -rf "$APP_DIR/app.prev"
if [ -d "$APP_DIR/app" ]; then mv "$APP_DIR/app" "$APP_DIR/app.prev"; fi
mv "$APP_DIR/app.new" "$APP_DIR/app"
systemctl restart birzha

if health; then
  log "Сервер отвечает: http://127.0.0.1:$PORT/healthz"
  exit 0
fi

warn "Новая версия не отвечает. Последние строки журнала:"
journalctl -u birzha -n 40 --no-pager || true
if [ -d "$APP_DIR/app.prev" ]; then
  rm -rf "$APP_DIR/app.failed"
  mv "$APP_DIR/app" "$APP_DIR/app.failed"
  mv "$APP_DIR/app.prev" "$APP_DIR/app"
  systemctl restart birzha
  if health; then warn "Вернул прежнюю версию. Неудачная сохранена в $APP_DIR/app.failed"; fi
fi
exit 1
