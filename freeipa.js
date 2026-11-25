// Вход в админку через FreeIPA (LDAP): логин/пароль проверяются в каталоге.
// Вся конфигурация — через переменные окружения (.env), секреты в коде не хранятся.
// Поддерживается ldaps:// (TLS сразу) и ldap:// (+ StartTLS по FREEIPA_STARTTLS=true).
//
// Схема проверки (стандартная для FreeIPA, без внешних сервисов):
//   1. подключаемся и биндимся сервисной учёткой (FREEIPA_BIND_DN / FREEIPA_BIND_PASSWORD);
//   2. ищем пользователя по фильтру (по умолчанию uid=<логин>) в FREEIPA_USER_BASE_DN;
//   3. повторно биндимся найденным DN с введённым паролем — это и есть проверка пароля.
// Пустой пароль не отправляем: LDAP трактует его как анонимный bind, и многие серверы
// отвечают «успех» — это известная ловушка, из-за которой пускают без пароля.
const { Client, InvalidCredentialsError, Filter } = require('ldapts');

const DEFAULT_ATTRS = ['uid', 'cn', 'displayName', 'mail', 'memberOf'];

const bool = v => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase());
const int = (v, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : dflt; };

// Как auth.readEnvOrFile, но по переданному объекту (а не только по process.env).
// Поддерживает суффикс _FILE: файл имеет приоритет над переменной (Docker secrets).
function envOrFile(env, name, trim = false) {
    const file = env[name + '_FILE'];
    if (file) {
        let v;
        try { v = require('fs').readFileSync(file, 'utf8'); }
        catch (e) { throw new Error(`${name}_FILE: не удалось прочитать ${file} (${e.code || e.message})`); }
        return trim ? v.trim() : v.replace(/\r?\n$/, '');
    }
    const v = env[name];
    return v && trim ? String(v).trim() : v;
}

// Читает .env-конфигурацию. Возвращает null, если FreeIPA выключен (FREEIPA_ENABLED не true).
// Бросает понятную ошибку, если включён, но обязательные параметры не заданы или некорректны.
function loadConfig(env = process.env) {
    if (!bool(env.FREEIPA_ENABLED)) return null;

    const url = String(env.FREEIPA_URL || '').trim();
    if (!url) throw new Error('FREEIPA_URL не задан (например ldaps://ipa.example.com:636)');
    if (!/^ldaps?:\/\//i.test(url)) throw new Error(`FREEIPA_URL: ожидается ldap:// или ldaps:// (получено "${url}")`);

    const baseDn = String(env.FREEIPA_BASE_DN || '').trim();
    if (!baseDn) throw new Error('FREEIPA_BASE_DN не задан (например dc=example,dc=com)');

    const userBaseDn = String(env.FREEIPA_USER_BASE_DN || '').trim() || `cn=users,cn=accounts,${baseDn}`;
    const bindDn = (envOrFile(env, 'FREEIPA_BIND_DN', true) || '').trim();
    const bindPassword = envOrFile(env, 'FREEIPA_BIND_PASSWORD');
    // Анонимный поиск возможен, но FreeIPA по умолчанию его запрещает: без сервисной учётки поиск вернёт 0 записей.
    if (!bindDn || !bindPassword) {
        console.warn('⚠ FREEIPA_BIND_DN/FREEIPA_BIND_PASSWORD не заданы: поиск пользователя пойдёт анонимно и, скорее всего, вернёт «пользователь не найден»');
    }

    const filterTpl = String(env.FREEIPA_USER_FILTER || '(uid={username})').trim();
    if (!filterTpl.includes('{username}')) throw new Error('FREEIPA_USER_FILTER должен содержать {username} (например (uid={username}))');

    const tlsOptions = {};
    const caFile = String(env.FREEIPA_TLS_CA_FILE || '').trim();
    if (caFile) {
        try { tlsOptions.ca = require('fs').readFileSync(caFile); }
        catch (e) { throw new Error(`FREEIPA_TLS_CA_FILE: не удалось прочитать ${caFile} (${e.code || e.message})`); }
    }
    if (env.FREEIPA_TLS_REJECT_UNAUTHORIZED !== undefined && !bool(env.FREEIPA_TLS_REJECT_UNAUTHORIZED)) {
        tlsOptions.rejectUnauthorized = false;      // только для самоподписанных сертификатов в тестовом контуре
        console.warn('⚠ FREEIPA_TLS_REJECT_UNAUTHORIZED=false: проверка сертификата сервера отключена (не для прода)');
    }

    const attrs = String(env.FREEIPA_ATTRS || '').split(',').map(s => s.trim()).filter(Boolean);
    const requireGroup = String(env.FREEIPA_REQUIRE_GROUP || '').trim();

    return {
        url,
        baseDn,
        userBaseDn,
        bindDn,
        bindPassword,
        userFilter: filterTpl,
        startTLS: bool(env.FREEIPA_STARTTLS),
        timeout: int(env.FREEIPA_TIMEOUT_MS, 5000),
        tlsOptions: Object.keys(tlsOptions).length ? tlsOptions : undefined,
        attrs: attrs.length ? attrs : DEFAULT_ATTRS,
        requireGroup
    };
}

function makeClient(cfg, deps = {}) {
    const create = deps.createClient || (opts => new Client(opts));
    return create({ url: cfg.url, timeout: cfg.timeout, connectTimeout: cfg.timeout, tlsOptions: cfg.tlsOptions });
}

// Открывает соединение, выполняет fn(client) и в любом случае закрывает его.
async function withClient(cfg, fn, deps) {
    const client = makeClient(cfg, deps);
    try { return await fn(client); }
    finally { try { await client.unbind(); } catch { /* соединение могло не открыться */ } }
}

// Атрибуты из LDAP могут прийти в разном регистре (memberOf / memberof, displayName / displayname),
// поэтому читаем их без учёта регистра.
function attr(entry, name) {
    if (entry[name] !== undefined) return entry[name];
    const lc = name.toLowerCase();
    for (const k of Object.keys(entry)) if (k.toLowerCase() === lc) return entry[k];
    return undefined;
}
const attrList = (entry, name) => [].concat(attr(entry, name) || []).map(String).filter(Boolean);
const first = (entry, name) => { const v = attrList(entry, name); return v.length ? v[0] : null; };

// Проверка учётных данных. Никогда не бросает на «неверный пароль» — только на сетевые/серверные ошибки.
async function authenticate(cfg, username, password, deps = {}) {
    const login = String(username || '').trim();
    if (!login) return { ok: false, reason: 'empty-username' };
    if (typeof password !== 'string' || password === '') return { ok: false, reason: 'empty-password' };
    if (login.length > 256 || password.length > 1024) return { ok: false, reason: 'too-long' };

    // Filter.escape экранирует спецсимволы RFC 4515 (* ( ) \ NUL) — защита от LDAP-инъекции через логин.
    const filter = cfg.userFilter.replace('{username}', Filter.escape(login));

    // 1) сервисный bind + поиск пользователя
    const entries = await withClient(cfg, async client => {
        if (cfg.startTLS) await client.startTLS(cfg.tlsOptions || {});
        if (cfg.bindDn) await client.bind(cfg.bindDn, cfg.bindPassword);
        const res = await client.search(cfg.userBaseDn, { scope: 'sub', filter, attributes: cfg.attrs, sizeLimit: 2 });
        return res.searchEntries;
    }, deps);

    if (!entries.length) return { ok: false, reason: 'not-found' };
    if (entries.length > 1) return { ok: false, reason: 'ambiguous' };
    const entry = entries[0];

    // 2) ограничение по группе (если задано)
    if (cfg.requireGroup) {
        const groups = attrList(entry, 'memberOf');
        if (!groups.some(g => g.toLowerCase() === cfg.requireGroup.toLowerCase()))
            return { ok: false, reason: 'not-in-group' };
    }

    // 3) повторный bind с паролем пользователя — собственно проверка пароля
    try {
        await withClient(cfg, async client => {
            if (cfg.startTLS) await client.startTLS(cfg.tlsOptions || {});
            await client.bind(entry.dn, password);
        }, deps);
    } catch (e) {
        if (e instanceof InvalidCredentialsError) return { ok: false, reason: 'bad-password' };
        throw e;
    }

    return {
        ok: true,
        user: {
            username: first(entry, 'uid') || login,
            dn: entry.dn,
            displayName: first(entry, 'displayName') || first(entry, 'cn') || first(entry, 'uid') || login,
            mail: first(entry, 'mail'),
            groups: attrList(entry, 'memberOf')
        }
    };
}

module.exports = { loadConfig, authenticate, bool };
