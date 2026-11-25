# Автодеплой «одной кнопкой»

Кнопка **«⬆ Обновить систему»** в админке обновляет signage до последнего коммита выбранной
ветки: сервер шлёт команду мини-агенту на хосте, тот делает `git pull` + `docker compose up -d
--build`. Источник кода — self-hosted GitLab (доступ по deploy key).

- Клиент (в контейнере): `deploy.js` + маршруты `/api/deploy` в `server.js`.
- Агент (на хосте): `deploy-agent.js`, systemd-юнит `deploy/signage-deploy-agent.service`.
- Установка агента: `scripts/install-deploy-agent.sh`.
- UI: кнопка и панель прогресса в `public/admin.html`.
- Тесты: `test/deploy.test.js`, `test/deploy-agent.test.js` (`npm test`).

## Архитектура и принятые решения

| Вопрос | Решение |
|---|---|
| Где кнопка | В админке signage |
| Прод | Внутренние ресурсы; код — на self-hosted GitLab |
| Способ | `git pull` + `docker compose up -d --build` на сервере |
| Доступ к коду | Deploy key на сервере |
| Доступ к Docker | Мини-агент на хосте (контейнер не получает docker.sock) |
| Транспорт | Агент слушает `127.0.0.1:<порт>`, авторизация по общему токену |
| Настройки | Всё в `.env` (и в файле окружения агента) |

```
Админка ──POST /api/deploy──► Сервер (контейнер)
   Сервер ──POST http://127.0.0.1:9123/deploy (Bearer-токен)──► deploy-agent (хост)
   deploy-agent ──git fetch/pull──► self-hosted GitLab (deploy key)
   deploy-agent ──docker compose up -d --build──► Docker
   deploy-agent ──/status──► Сервер ──GET /api/deploy──► Админка (лог, прогресс)
```

Почему отдельный агент: контейнеру не выдаётся `docker.sock` (это root-эквивалент на хосте).
Агент — узкая дверь: одна фиксированная команда из своего окружения, никакого ввода от клиента,
только loopback и токен.

## Сеть: контейнер и loopback

Агент слушает `127.0.0.1` на **хосте**. Контейнер в bridge-сети достучаться до хостового
loopback не может, поэтому signage запускается **в host-сети**:

```bash
docker compose -f docker-compose.yml -f docker-compose.deploy.yml up -d --build
```

`docker-compose.deploy.yml` включает `network_mode: host` (и сбрасывает маппинг портов — в host-сети
он не нужен). Требуется Compose ≥ 2.24 (для `!reset`). Если host-сеть не подходит — можно вместо
этого направить `DEPLOY_AGENT_URL` на IP хоста в bridge-сети и слушать агента на этом IP
(тогда `DEPLOY_AGENT_BIND` = IP моста, а токен и loopback-ограничение всё равно защищают).

## Установка на сервере (Linux + systemd + Docker)

```bash
# 1. Deploy key: создать на сервере ключ и добавить его в GitLab (Settings → Repository → Deploy keys, read-only)
sudo -u signage ssh-keygen -t ed25519 -N '' -f /opt/signage/.ssh/id_ed25519   # или для существующего пользователя
# 2. Установить агента (склонирует проект, создаст токен, поставит systemd-сервис)
sudo DEPLOY_GIT_URL=git@gitlab.example.com:group/signage.git \
     DEPLOY_BRANCH=main bash scripts/install-deploy-agent.sh
# 3. Прописать токен и включить деплой в .env контейнера (токен — из /etc/signage/deploy-agent.env)
#    DEPLOY_ENABLED=true
#    DEPLOY_AGENT_URL=http://127.0.0.1:9123
#    DEPLOY_AGENT_TOKEN=<токен>
# 4. Запустить в host-сети
docker compose -f docker-compose.yml -f docker-compose.deploy.yml up -d --build
```

Проверка агента:

```bash
curl -s -H "Authorization: Bearer <TOKEN>" http://127.0.0.1:9123/status
curl -s -H "Authorization: Bearer <TOKEN>" -X POST http://127.0.0.1:9123/deploy
```

## Настройки

### Контейнер (`.env`)

| Переменная | Назначение | По умолчанию |
|---|---|---|
| `DEPLOY_ENABLED` | включить кнопку и API деплоя | false |
| `DEPLOY_AGENT_URL` | адрес мини-агента | http://127.0.0.1:9123 |
| `DEPLOY_AGENT_TOKEN` | общий токен с агентом (есть `_FILE`) | — |

### Агент (`/etc/signage/deploy-agent.env`)

| Переменная | Назначение | По умолчанию |
|---|---|---|
| `DEPLOY_AGENT_BIND` | адрес прослушивания | 127.0.0.1 |
| `DEPLOY_AGENT_PORT` | порт | 9123 |
| `DEPLOY_AGENT_TOKEN` | токен (обязателен) | — |
| `DEPLOY_PROJECT_DIR` | каталог проекта на хосте | — |
| `DEPLOY_BRANCH` | ветка | main |
| `DEPLOY_GIT_REMOTE` | remote | origin |
| `DEPLOY_GIT_MODE` | `ff` (pull --ff-only) или `reset` (reset --hard) | ff |
| `DEPLOY_BUILD_CMD` | команда сборки | docker compose up -d --build |
| `DEPLOY_HEALTHCHECK_URL` | проверка после сборки (пусто — пропустить) | — |
| `DEPLOY_TIMEOUT_MS` | таймаут команд | 900000 |

## API

Под авторизацией админки:

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/api/deploy` | статус агента + лог (`enabled`, `running`, `ok_last`, `from`, `to`, `step`, `log`) |
| POST | `/api/deploy` | запустить деплой |

Агент (только loopback, Bearer-токен): `GET /healthz` (без токена), `GET /status`, `POST /deploy`.

## Поведение

- Пока деплой идёт, повторный запуск вернёт 409 («уже идёт»); кнопка блокируется, панель
  опрашивает статус каждые 3 с и показывает лог (`git pull`, сборка, healthcheck).
- `DEPLOY_HEALTHCHECK_URL` (по умолчанию `/healthz`) — после сборки агент проверяет, что сервис
  поднялся; при провале деплой помечается ошибкой (образ и данные не откатываются автоматически).
- При ошибке (недоступен GitLab, конфликт слияния, сбой сборки) деплой останавливается, в логе —
  причина; сервис продолжает работать на прежней версии (образ пересобирается после успешного pull).

## Безопасность

- Агент слушает только loopback и требует токен; токен сравнивается без утечки времени.
- Контейнер не получает `docker.sock`; агент выполняет одну фиксированную команду из окружения.
- Токен хранится в `.env` (права 600) и в `/etc/signage/deploy-agent.env` (root, 600); поддержан
  суффикс `_FILE` для Docker secrets.
- systemd-юнит ограничен: `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`.
- Доступ к кнопке — только у авторизованного администратора (как и ко всей админке).

## Диагностика

- `Автодеплой выключен` — `DEPLOY_ENABLED=true` не задан.
- `Агент деплоя недоступен` — контейнер не видит `127.0.0.1:9123`: проверьте, что агент запущен и
  контейнер в host-сети (`docker-compose.deploy.yml`).
- `HTTP 401` от агента — токен в `.env` не совпадает с `/etc/signage/deploy-agent.env`.
- `permission denied` при `git pull` — deploy key не добавлен в GitLab или у пользователя `signage`
  нет доступа к каталогу.
- Сборка падает — смотрите лог в панели деплоя (там полный вывод `docker compose`).

## Известные ограничения

- Хост-сеть (`network_mode: host`) — компромисс ради loopback-агента; при необходимости агент можно
  вынести на IP моста.
- Агент делает `git pull` на месте (не отдельный релизный каталог): отката «в один клик» нет —
  откат вручную (`DEPLOY_GIT_MODE=reset` + указание нужного коммита или `git checkout`).
- `DEPLOY_BUILD_CMD` — доверенная строка из окружения хоста (не из админки); менять её может только
  тот, у кого есть root на хосте.
- Одновременно обслуживается один проект/один агент; для нескольких — отдельные экземпляры агента.
