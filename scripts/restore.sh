#!/usr/bin/env bash
# Восстановление из архива:  scripts/restore.sh backups/signage-XXXX.tar.gz
set -euo pipefail
cd "$(dirname "$0")/.."
FILE="${1:?Укажите архив: scripts/restore.sh backups/signage-XXXX.tar.gz}"
VOL="${VOLUME_NAME:-signage_storage}"
read -r -p "Текущие данные будут заменены данными из $FILE. Продолжить? [y/N] " a
[[ "$a" == "y" ]] || exit 1
docker compose stop signage
docker run --rm -v "$VOL":/storage -v "$(readlink -f "$FILE")":/backup.tar.gz:ro busybox:stable \
  sh -c 'rm -rf /storage/data /storage/uploads && tar xzf /backup.tar.gz -C /storage && chown -R 1000:1000 /storage'
docker compose start signage
echo "Восстановлено."
