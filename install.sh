#!/usr/bin/env bash
# ============================================================================
#  Установщик / настройщик signage
# ============================================================================
#  Один скрипт для двух случаев:
#    1) установка с нуля  — клонирует репозиторий, создаёт .env, задаёт пароль,
#       собирает образ и поднимает контейнер;
#    2) настройка уже установленного — если рядом есть готовый проект
#       (docker-compose.yml + .env), просто дополняет конфиг и перезапускает.
#
#  Запуск:
#    # из папки проекта (в т.ч. из ZIP):
#    ./install.sh
#
#    # одной строкой с сервера (без клонирования руками):
#    SIGNAGE_REPO=https://github.com/USER/signage.git \
#      curl -fsSL https://raw.githubusercontent.com/USER/signage/main/install.sh | bash
#
#  Полезные переменные окружения:
#    SIGNAGE_DIR=/opt/signage        каталог установки (по умолчанию ~/signage)
#    SIGNAGE_REPO=<git-url>          репозиторий (нужен в режиме curl; иначе берётся origin)
#    SIGNAGE_BRANCH=main             ветка
#    SIGNAGE_PORT=3000               порт админки на хосте
#    ADMIN_PASSWORD=...              задать пароль админки без вопросов
#    ADMIN_USER=admin                логин локального администратора
#    AUTH_MODE=local|freeipa|both    источник входа
#    ADMIN_ALLOWED_NETS=192.168.0.0/16   ограничить админку своей сетью
#    SIGNAGE_YES=1                   не задавать вопросов (для автоматизации)
#    SIGNAGE_NO_UP=1                 собрать, но не запускать
#    SIGNAGE_BUILD_CMD / SIGNAGE_UP_CMD   переопределить команды сборки/запуска
#
#  Скрипт идемпотентен: повторный запуск не затирает .env, пароль и данные тома.
# ============================================================================
set -euo pipefail

# --- вывод -------------------------------------------------------------------
c_info()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
c_ok()    { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
c_warn()  { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
c_err()   { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; }
die()     { c_err "$*"; exit 1; }

# --- где мы: рядом с проектом или пришли из curl? ----------------------------
SCRIPT_PATH="${BASH_SOURCE[0]:-}"
SCRIPT_DIR=""
if [[ -n "$SCRIPT_PATH" && -f "$SCRIPT_PATH" ]]; then
    SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
fi

LOCAL_MODE=0
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/docker-compose.yml" ]]; then
    LOCAL_MODE=1
    PROJECT_DIR="$SCRIPT_DIR"
fi

# --- параметры ---------------------------------------------------------------
DEFAULT_DIR="${SIGNAGE_DIR:-$HOME/signage}"
BRANCH="${SIGNAGE_BRANCH:-main}"
PORT="${SIGNAGE_PORT:-}"
REPO="${SIGNAGE_REPO:-}"
YES="${SIGNAGE_YES:-0}"
NO_UP="${SIGNAGE_NO_UP:-0}"

# --- зависимости -------------------------------------------------------------
command -v docker >/dev/null 2>&1 || die "Docker не найден. Установите Docker Engine: https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || die "Нужен плагин Docker Compose v2 ('docker compose version')."
docker info >/dev/null 2>&1 || die "Docker-демон недоступен (запустите его или добавьте пользователя в группу docker)."

# --- определить каталог проекта ---------------------------------------------
if [[ $LOCAL_MODE -eq 0 ]]; then
    PROJECT_DIR="$DEFAULT_DIR"
    c_info "Режим curl: проект будет развёрнут в $PROJECT_DIR"

    if [[ -z "$REPO" ]]; then
        # Попробуем вытащить репозиторий из origin, если каталог уже есть
        if [[ -d "$PROJECT_DIR/.git" ]]; then
            REPO="$(git -C "$PROJECT_DIR" remote get-url origin 2>/dev/null || true)"
        fi
    fi
    [[ -n "$REPO" ]] || die "Не задан репозиторий. Укажите SIGNAGE_REPO=<git-url>."

    command -v git >/dev/null 2>&1 || die "Нужен git для клонирования репозитория."

    if [[ -d "$PROJECT_DIR/.git" ]]; then
        c_info "Каталог уже есть — обновляю (git pull)"
        git -C "$PROJECT_DIR" fetch --quiet origin "$BRANCH"
        git -C "$PROJECT_DIR" checkout --quiet "$BRANCH"
        git -C "$PROJECT_DIR" pull --ff-only --quiet origin "$BRANCH"
        c_ok "Код обновлён до $(git -C "$PROJECT_DIR" rev-parse --short HEAD)"
    else
        c_info "Клонирую $REPO ($BRANCH)"
        mkdir -p "$(dirname "$PROJECT_DIR")"
        git clone --branch "$BRANCH" --depth 1 "$REPO" "$PROJECT_DIR"
        c_ok "Код получен"
    fi
else
    c_info "Локальный режим: проект в $PROJECT_DIR"
fi

cd "$PROJECT_DIR"
[[ -f docker-compose.yml ]] || die "В $PROJECT_DIR нет docker-compose.yml — это не каталог проекта."
[[ -f .env.example ]] || die "Нет .env.example — повреждён комплект проекта."

# --- .env: создать при первом запуске, иначе дополнить -----------------------
ENV_NEW=0
if [[ ! -f .env ]]; then
    cp .env.example .env
    chmod 600 .env
    ENV_NEW=1
    c_ok "Создан .env из .env.example"
else
    c_info ".env уже есть — сохраняю текущие значения"
fi

# Установить/обновить ключ в .env, не трогая остальные строки.
set_env() {
    local key="$1" val="$2"
    if grep -qE "^[[:space:]]*${key}=" .env; then
        # заменяем значение (в т.ч. пустое)
        local tmp; tmp="$(mktemp)"
        awk -v k="$key" -v v="$val" '
            BEGIN{FS=OFS="="}
            $1 ~ "^[[:space:]]*"k"[[:space:]]*$" { print k"="v; next }
            { print }
        ' .env > "$tmp" && mv "$tmp" .env
    else
        printf '%s=%s\n' "$key" "$val" >> .env
    fi
    chmod 600 .env
}

get_env() { grep -E "^[[:space:]]*$1=" .env | tail -1 | cut -d= -f2- || true; }

# --- пароль админки ----------------------------------------------------------
have_hash=0; [[ -n "$(get_env ADMIN_PASSWORD_HASH)" ]] && have_hash=1
have_plain=0; [[ -n "$(get_env ADMIN_PASSWORD)" ]] && have_plain=1

# Сгенерировать хэш. Сначала пробуем локальный node, иначе — через контейнер.
hash_password() {
    local pw="$1"
    if command -v node >/dev/null 2>&1; then
        printf '%s' "$pw" | node hash-password.js | sed 's/^ADMIN_PASSWORD_HASH=//'
    else
        # образ должен быть собран к этому моменту
        printf '%s' "$pw" | docker compose run --rm --no-deps -T signage node hash-password.js \
            | sed 's/^ADMIN_PASSWORD_HASH=//'
    fi
}

GEN_PASSWORD=""
if [[ $have_hash -eq 1 ]]; then
    c_ok "Пароль админки уже задан (ADMIN_PASSWORD_HASH) — не меняю"
elif [[ $have_plain -eq 1 ]]; then
    c_warn "Используется открытый ADMIN_PASSWORD — рекомендую перейти на хэш (./install.sh повторно с ADMIN_PASSWORD=...)"
else
    if [[ -n "${ADMIN_PASSWORD:-}" ]]; then
        GEN_PASSWORD="$ADMIN_PASSWORD"
    elif [[ -t 0 && "$YES" != "1" ]]; then
        read -r -s -p "Новый пароль админки (Enter — сгенерировать): " ADMIN_PASSWORD || true; echo
        GEN_PASSWORD="${ADMIN_PASSWORD:-}"
    fi
    if [[ -z "$GEN_PASSWORD" ]]; then
        # сгенерируем надёжный пароль
        if command -v openssl >/dev/null 2>&1; then
            GEN_PASSWORD="sig-$(openssl rand -base64 12 | tr -d '/+=' | head -c 14)"
        else
            GEN_PASSWORD="sig-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c 14)"
        fi
        c_info "Пароль админки сгенерирован автоматически"
    fi
fi

# --- порт --------------------------------------------------------------------
if [[ -n "$PORT" ]]; then set_env PORT "$PORT"; fi

# --- прочие настройки из окружения ------------------------------------------
[[ -n "${ADMIN_USER:-}" ]]         && set_env ADMIN_USER "$ADMIN_USER"
[[ -n "${AUTH_MODE:-}" ]]          && set_env AUTH_MODE "$AUTH_MODE"
[[ -n "${ADMIN_ALLOWED_NETS:-}" ]] && set_env ADMIN_ALLOWED_NETS "$ADMIN_ALLOWED_NETS"
[[ -n "${TZ:-}" ]]                 && set_env TZ "$TZ"
for k in FREEIPA_ENABLED FREEIPA_URL FREEIPA_BASE_DN FREEIPA_USER_BASE_DN \
         FREEIPA_BIND_DN FREEIPA_BIND_PASSWORD FREEIPA_REQUIRE_GROUP FREEIPA_ACCESS_MODE \
         DEPLOY_ENABLED DEPLOY_AGENT_URL DEPLOY_AGENT_TOKEN \
         SCREENS PLAYER_DWS_USER PLAYER_DWS_PASSWORD; do
    if [[ -n "${!k:-}" ]]; then set_env "$k" "${!k}"; fi
done

# --- сборка образа -----------------------------------------------------------
BUILD_CMD="${SIGNAGE_BUILD_CMD:-docker compose build}"
c_info "Сборка образа: $BUILD_CMD"
if ! $BUILD_CMD; then
    die "Сборка не удалась. Проверьте доступ к Docker Hub / apt / npm (см. README)."
fi
c_ok "Образ собран"

# --- пароль (после сборки, чтобы был доступен контейнерный node) -------------
if [[ -n "$GEN_PASSWORD" ]]; then
    HASH="$(hash_password "$GEN_PASSWORD")"
    [[ "$HASH" == scrypt:* ]] || die "Не удалось получить хэш пароля."
    set_env ADMIN_PASSWORD_HASH "$HASH"
    # убрать открытый пароль, если был
    if grep -qE '^[[:space:]]*ADMIN_PASSWORD=' .env; then
        tmp="$(mktemp)"; grep -vE '^[[:space:]]*ADMIN_PASSWORD=' .env > "$tmp" && mv "$tmp" .env
    fi
    c_ok "Пароль админки сохранён (хэш scrypt) в .env"
fi

# --- запуск ------------------------------------------------------------------
if [[ "$NO_UP" == "1" ]]; then
    c_warn "SIGNAGE_NO_UP=1 — образ собран, запуск пропущен"
else
    UP_CMD="${SIGNAGE_UP_CMD:-docker compose up -d}"
    c_info "Запуск: $UP_CMD"
    $UP_CMD
fi

# --- ожидание готовности -----------------------------------------------------
EFF_PORT="$(get_env PORT)"; EFF_PORT="${EFF_PORT:-3000}"
if [[ "$NO_UP" != "1" ]]; then
    c_info "Жду готовности (http://127.0.0.1:$EFF_PORT/healthz)…"
    ok=0
    for _ in $(seq 1 30); do
        if command -v curl >/dev/null 2>&1; then
            curl -fsS "http://127.0.0.1:$EFF_PORT/healthz" >/dev/null 2>&1 && { ok=1; break; }
        else
            docker compose ps --status running 2>/dev/null | grep -q signage && { ok=1; break; }
        fi
        sleep 1
    done
    [[ $ok -eq 1 ]] && c_ok "Сервис отвечает" || c_warn "Сервис ещё поднимается — проверьте: docker compose logs -f signage"
fi

# --- адреса ------------------------------------------------------------------
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"; IP="${IP:-<IP_СЕРВЕРА>}"
echo
c_ok "Готово."
echo "  Админка:  http://$IP:$EFF_PORT/admin"
echo "  Плееры:   http://$IP:$EFF_PORT/player?screen=left   (right, big_wall)"
echo "  Каталог:  $PROJECT_DIR"
if [[ -n "$GEN_PASSWORD" ]]; then
    echo
    c_warn "Пароль админки (сохраните сейчас — показывается один раз): $GEN_PASSWORD"
    echo "  Позже сменить:  scripts/reset-password.sh"
fi
echo
echo "  Полезное:"
echo "    docker compose logs -f signage      # логи"
echo "    git pull && docker compose up -d --build   # обновление"
echo "    scripts/backup.sh                   # бэкап данных"
