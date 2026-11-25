#!/usr/bin/env bash
# Сброс пароля админки. Запускать на сервере, из папки проекта (нужен доступ к docker):
#   scripts/reset-password.sh            # новый хэш записывается в .env
#   scripts/reset-password.sh --secret   # новый хэш записывается в secrets/admin_password_hash (вариант с Docker secrets)
# Старый пароль не нужен: хэш необратим, поэтому пароль не «восстанавливают», а задают заново.
set -euo pipefail
cd "$(dirname "$0")/.."

MODE=env
case "${1:-}" in
  "") ;;
  --secret) MODE=secret ;;
  *) echo "Использование: $0 [--secret]" >&2; exit 2 ;;
esac
command -v docker >/dev/null || { echo "docker не найден" >&2; exit 1; }

read -r -s -p "Новый пароль: " P1; echo
read -r -s -p "Повторите пароль: " P2; echo
[[ "$P1" == "$P2" ]] || { echo "Пароли не совпадают, ничего не изменено" >&2; exit 1; }

# Пароль идёт через stdin (а не аргументом команды), чтобы не светиться в списке процессов.
LINE=$(printf '%s' "$P1" | docker compose run --rm --no-deps -T signage node hash-password.js)
unset P1 P2
HASH=${LINE#ADMIN_PASSWORD_HASH=}
[[ "$HASH" == scrypt:* ]] || { echo "Не удалось получить хэш, ничего не изменено" >&2; exit 1; }

# Убираем из .env старые ADMIN_PASSWORD_HASH и ADMIN_PASSWORD (включая забытый открытый пароль).
# Пишем во временный файл рядом и переименовываем: .env либо старый, либо новый целиком.
touch .env; chmod 600 .env
TMP=$(mktemp .env.XXXXXX)
trap 'rm -f "$TMP"' EXIT
{ grep -vE '^[[:space:]]*(ADMIN_PASSWORD_HASH|ADMIN_PASSWORD)=' .env || true
  [[ $MODE == env ]] && echo "ADMIN_PASSWORD_HASH=$HASH"
  true; } > "$TMP"
chmod 600 "$TMP"; mv "$TMP" .env

if [[ $MODE == env ]]; then
  UP=(docker compose up -d --force-recreate signage)
else
  mkdir -p secrets
  rm -f secrets/admin_password_hash
  ( umask 277; printf '%s\n' "$HASH" > secrets/admin_password_hash )     # права 0400
  [[ "$(id -u)" == 1000 ]] || echo "⚠ Файл секрета должен читаться uid 1000 (пользователь node в контейнере): sudo chown 1000 secrets/admin_password_hash" >&2
  UP=(docker compose -f docker-compose.yml -f docker-compose.secrets.yml up -d --force-recreate signage)
fi

# --force-recreate обязателен: файл секрета монтируется «по inode», и после замены файла контейнер видел бы старый.
"${UP[@]}"
echo "Готово: пароль заменён, сервер перезапущен. Все прежние сессии админки сброшены."
