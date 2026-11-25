#!/usr/bin/env bash
# Установка мини-агента автодеплоя на хосте (Linux + systemd + Docker).
# Запускать от root (или через sudo) на том же сервере, где работает контейнер signage.
#
# Что делает:
#   1. создаёт пользователя signage и каталог проекта /opt/signage (git clone, если пусто);
#   2. генерирует токен агента и файл /etc/signage/deploy-agent.env (права 600);
#   3. ставит и запускает systemd-сервис signage-deploy-agent.
#
# После установки: прописать тот же токен в .env контейнера (DEPLOY_AGENT_TOKEN) и включить
# DEPLOY_ENABLED=true, затем docker compose up -d.
set -euo pipefail

PROJECT_DIR="${DEPLOY_PROJECT_DIR:-/opt/signage}"
GIT_URL="${DEPLOY_GIT_URL:-}"              # напр. git@gitlab.example.com:group/brightsign-signage.git
BRANCH="${DEPLOY_BRANCH:-main}"
PORT="${DEPLOY_AGENT_PORT:-9123}"
ENV_DIR="/etc/signage"
ENV_FILE="$ENV_DIR/deploy-agent.env"
UNIT_SRC="$(cd "$(dirname "$0")/.." && pwd)/deploy/signage-deploy-agent.service"
UNIT_DST="/etc/systemd/system/signage-deploy-agent.service"

[[ $EUID -eq 0 ]] || { echo "Запустите от root (sudo $0)"; exit 1; }
command -v node >/dev/null || { echo "Нужен Node.js (>=22) в PATH"; exit 1; }
command -v git  >/dev/null || { echo "Нужен git"; exit 1; }
command -v docker >/dev/null || { echo "Нужен docker"; exit 1; }

id signage >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin signage
usermod -aG docker signage 2>/dev/null || true

mkdir -p "$PROJECT_DIR"
if [[ -n "$GIT_URL" && ! -d "$PROJECT_DIR/.git" ]]; then
    echo "Клонирую $GIT_URL в $PROJECT_DIR"
    sudo -u signage git clone --branch "$BRANCH" "$GIT_URL" "$PROJECT_DIR"
fi
chown -R signage:signage "$PROJECT_DIR"

mkdir -p "$ENV_DIR"
if [[ ! -f "$ENV_FILE" ]]; then
    TOKEN="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    cat > "$ENV_FILE" <<EOF
DEPLOY_AGENT_BIND=127.0.0.1
DEPLOY_AGENT_PORT=$PORT
DEPLOY_AGENT_TOKEN=$TOKEN
DEPLOY_PROJECT_DIR=$PROJECT_DIR
DEPLOY_BRANCH=$BRANCH
DEPLOY_GIT_REMOTE=origin
DEPLOY_GIT_MODE=ff
DEPLOY_BUILD_CMD=docker compose up -d --build
DEPLOY_HEALTHCHECK_URL=http://127.0.0.1:3000/healthz
EOF
    chmod 600 "$ENV_FILE"; chown root:root "$ENV_FILE"
    echo "Токен агента сохранён в $ENV_FILE (права 600)."
    echo "Скопируйте его в .env контейнера: DEPLOY_AGENT_TOKEN=<значение из $ENV_FILE>"
else
    echo "Файл $ENV_FILE уже существует — не перезаписываю."
fi

cp "$UNIT_SRC" "$UNIT_DST"
systemctl daemon-reload
systemctl enable --now signage-deploy-agent
sleep 1
systemctl --no-pager --lines=5 status signage-deploy-agent || true
echo
echo "Готово. Проверка (подставьте токен):"
echo "  curl -s -H 'Authorization: Bearer <TOKEN>' http://127.0.0.1:$PORT/status"
