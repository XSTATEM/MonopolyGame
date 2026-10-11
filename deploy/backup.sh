#!/usr/bin/env bash
# Резервная копия данных «Биржи» (аккаунты, очки, сохранённые партии).
# Запускается таймером birzha-backup.timer раз в сутки; можно и вручную:
#   sudo -u birzha /usr/local/bin/birzha-backup
set -euo pipefail

DATA_DIR="${DATA_DIR:-/var/lib/birzha}"
KEEP_DAYS="${KEEP_DAYS:-14}"
BACKUP_DIR="$DATA_DIR/backups"

mkdir -p "$BACKUP_DIR"
ts="$(date +%Y%m%d-%H%M%S)"
# users.json и rooms.json сервер пишет атомарно (через временный файл и
# rename), поэтому копия всегда цельная, даже если сделана посреди партии.
tar -czf "$BACKUP_DIR/birzha-$ts.tar.gz" -C "$DATA_DIR" --exclude=./backups .
find "$BACKUP_DIR" -name 'birzha-*.tar.gz' -mtime +"$KEEP_DAYS" -delete
echo "Резервная копия: $BACKUP_DIR/birzha-$ts.tar.gz"
