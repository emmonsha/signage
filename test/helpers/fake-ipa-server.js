// Обёртка для тестов: поднимает НАСТОЯЩИЙ server.js, но с подменённым модулем freeipa.js.
// Так проверяем вход через каталог и список допущенных на живом HTTP без сети и LDAP-сервера.
// Сценарий каталога задаётся через переменные окружения:
//   FREEIPA_FAKE_USERS   — JSON вида {"alice":"пароль","bob":"пароль"}
//   FREEIPA_FAKE_DISPLAY — JSON вида {"alice":"Алиса"} (отображаемые имена, необязательно)
const path = require('path');

const root = path.join(__dirname, '..', '..');
const freeipaPath = require.resolve(path.join(root, 'freeipa.js'));

const passwords = JSON.parse(process.env.FREEIPA_FAKE_USERS || '{}');
const display = JSON.parse(process.env.FREEIPA_FAKE_DISPLAY || '{}');
const norm = u => String(u == null ? '' : u).trim().toLowerCase();
const nameOf = n => (typeof n === 'string' ? n : '');

const fake = {
    loadConfig: () => ({
        url: 'ldap://ipa.test:389',
        baseDn: 'dc=test',
        userBaseDn: 'cn=users,cn=accounts,dc=test',
        bindDn: 'uid=svc,cn=users,cn=accounts,dc=test',
        bindPassword: 'svc',
        userFilter: '(uid={username})',
        startTLS: false,
        timeout: 5000,
        attrs: ['uid'],
        requireGroup: null,
    }),
    // Проверка пароля: верный пароль => вход (дальше server.js сам решает по списку допущенных).
    authenticate: async (cfg, username, password) => {
        const login = norm(username);
        if (!Object.prototype.hasOwnProperty.call(passwords, login)) return { ok: false, reason: 'not-found' };
        if (passwords[login] !== password) return { ok: false, reason: 'bad-password' };
        return { ok: true, user: { username: login, displayName: nameOf(display[login]) || login } };
    },
    // Поиск без пароля — для проверки логина при добавлении в список.
    findUser: async (cfg, username) => {
        const login = norm(username);
        if (!Object.prototype.hasOwnProperty.call(passwords, login)) return { ok: false, reason: 'not-found' };
        return { ok: true, user: { username: login, displayName: nameOf(display[login]) || login } };
    },
    bool: v => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase()),
};

require.cache[freeipaPath] = { id: freeipaPath, filename: freeipaPath, loaded: true, exports: fake };
require(path.join(root, 'server.js'));
