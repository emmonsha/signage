# Вход через FreeIPA (LDAP)

Документ описывает, как включить аутентификацию админки signage через каталог
FreeIPA. Вся конфигурация — через `.env`, секреты в репозитории не хранятся.

- Реализация: `freeipa.js` (клиент — библиотека `ldapts`).
- Интеграция: `server.js`, роут `POST /api/login` (и подсказка `GET /api/auth`).
- Тесты: `test/freeipa.test.js` (запуск `npm test`, сеть не нужна).

## Как это работает

1. Сервер подключается к каталогу и выполняет **bind сервисной учёткой**
   (`FREEIPA_BIND_DN` / `FREEIPA_BIND_PASSWORD`).
2. Ищет пользователя по фильтру (по умолчанию `(uid={username})`) в `FREEIPA_USER_BASE_DN`.
3. Делает **повторный bind найденным DN с введённым паролем** — это и есть проверка пароля.
   Успешный bind = верные учётные данные. Пароль нигде не сохраняется.
4. Необязательно: проверяет членство в группе (`FREEIPA_REQUIRE_GROUP`, полный DN).

Безопасность учтена:

- **Пустой пароль не отправляется.** LDAP трактует bind с пустым паролем как анонимный и часто
  отвечает «успех» — это классическая дыра «вход без пароля». Отклоняется сразу.
- **Логин экранируется** по RFC 4515 (`Filter.escape`), поэтому `*`, `(`, `)`, `\` не позволяют
  подменить фильтр (LDAP-инъекция).
- **Несколько совпадений → отказ** (`ambiguous`): не пускаем, если логин неоднозначен.
- **Ошибка каталога не «пускает»**: недоступность LDAP не считается успешным входом.
- **Ограничение попыток**: 5 неудач по паре IP+логин и по IP → блок на 15 минут.
- Поддержаны `ldaps://` (TLS сразу) и `ldap://` + StartTLS.

## Режимы (AUTH_MODE)

| Режим | Поведение |
|---|---|
| `local` | только локальный пароль админки (`ADMIN_PASSWORD_HASH` / `ADMIN_PASSWORD`). По умолчанию, если FreeIPA выключен. |
| `freeipa` | только каталог; локальный пароль не используется. |
| `both` | FreeIPA, а при его недоступности/отказе — аварийный вход локальной учёткой `ADMIN_USER`. |

Если `AUTH_MODE` не задан: `freeipa`, когда `FREEIPA_ENABLED=true`, иначе `local`.
В режиме `both` логин `ADMIN_USER` (по умолчанию `admin`) сначала проверяется в каталоге, затем локально —
то есть не мешает одноимённому пользователю FreeIPA.

## Настройка FreeIPA

Сервисная учётка для поиска (по умолчанию FreeIPA запрещает анонимный поиск):

```bash
# на сервере FreeIPA: отдельный пользователь с правом чтения каталога
ipa user-add signage-bind --first=Signage --last=Bind --shell=/sbin/nologin
ipa passwd signage-bind
```

Убедитесь, что админка видит каталог:

```bash
# с хоста, где работает контейнер (порт 389/636 открыт на сервере FreeIPA)
ldapsearch -x -H ldaps://ipa.example.com:636 -D 'uid=signage-bind,cn=users,cn=accounts,dc=example,dc=com' \
  -W -b 'cn=users,cn=accounts,dc=example,dc=com' '(uid=alice)' dn
```

## Настройка `.env`

```dotenv
AUTH_MODE=both                       # freeipa | both | local
ADMIN_USER=admin                     # аварийная локальная учётка (режим both)
ADMIN_PASSWORD_HASH=<scrypt-хэш>     # npm run hash-password

FREEIPA_ENABLED=true
FREEIPA_URL=ldaps://ipa.example.com:636
FREEIPA_BASE_DN=dc=example,dc=com
FREEIPA_USER_BASE_DN=cn=users,cn=accounts,dc=example,dc=com
FREEIPA_BIND_DN=uid=signage-bind,cn=users,cn=accounts,dc=example,dc=com
FREEIPA_BIND_PASSWORD=<пароль сервисной учётки>
FREEIPA_USER_FILTER=(uid={username})
FREEIPA_STARTTLS=false               # для ldap:// поставьте true
# FREEIPA_REQUIRE_GROUP=cn=signage-admins,cn=groups,cn=accounts,dc=example,dc=com
```

Применить: `docker compose up -d`. В логе появится строка `Аутентификация: both (FreeIPA: …)`.

### Сертификат (ldaps / StartTLS)

- Публичный/корпоративный CA — ничего делать не нужно.
- Самоподписанный CA — положите файл в контейнер и укажите `FREEIPA_TLS_CA_FILE=/path/ca.crt`
  (через `_FILE`-переменную или смонтированный том).
- Быстрая проверка в тестовом контуре (не для прода): `FREEIPA_TLS_REJECT_UNAUTHORIZED=false`
  (сервер напишет предупреждение в лог).

### Секреты через Docker secrets

Любая переменная поддерживает суффикс `_FILE` (файл имеет приоритет над переменной), например
`FREEIPA_BIND_PASSWORD_FILE=/run/secrets/freeipa_bind_password`.

## Проверка

```bash
npm test                                  # юнит-тесты freeipa.js (16 шт., без сети)
docker compose up -d && docker compose logs -f signage

curl -s localhost:3000/api/auth           # {"mode":"both","username":true}
curl -s -X POST localhost:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"<пароль FreeIPA>"}'   # {"success":true,...}
```

## Известные ограничения

- Пароль проверяется bind-ом; сервер не читает и не хранит хэши паролей пользователей.
- Нет кэширования результатов — каждый вход идёт в каталог (это ожидаемо для редких входов).
- Kerberos/SSO (GSSAPI) не реализованы: вход по логину и паролю каталога.
- Роли/права внутри админки не различаются — успешный вход даёт полный доступ (как и раньше).
- Требуется `ldapts@^8` (добавлена в зависимости и в образ).
