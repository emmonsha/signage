#!/usr/bin/env bash
# Архив плейлистов и картинок из тома в ./backups (хранится 14 последних)
set -euo pipefail
cd "$(dirname "$0")/.."
VOL="${VOLUME_NAME:-signage_storage}"
mkdir -p backups
FILE="signage-$(date +%Y%m%d-%H%M%S).tar.gz"
docker run --rm --user "$(id -u):$(id -g)" \
  -v "$VOL":/storage:ro -v "$PWD/backups":/backup busybox:stable \
  tar czf "/backup/$FILE" --exclude=data/tmp -C /storage data uploads
echo "Готово: backups/$FILE"
ls -1t backups/signage-*.tar.gz | tail -n +15 | xargs -r rm --
