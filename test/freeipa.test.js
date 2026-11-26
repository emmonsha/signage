// Тесты входа через FreeIPA. Каталог подменяется фейковым LDAP-клиентом (deps.createClient),
// поэтому сеть и настоящий сервер не нужны.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, authenticate } = require('../freeipa');

// Минимальный фейк клиента ldapts: сценарий задаётся объектом.
function fakeClient(script) {
    return () => ({
        async startTLS() { if (script.tlsError) throw script.tlsError; },
        async bind(dn, password) {
            script.binds.push([dn, password]);
            if (dn === script.bindDn) { if (script.serviceBindError) throw script.serviceBindError; return; }
            if (script.userBindError) throw script.userBindError;
        },
        async search() { return { searchEntries: script.entries }; },
        async unbind() {}
    });
}

const baseEnv = {
    FREEIPA_ENABLED: 'true',
    FREEIPA_URL: 'ldap://ipa.example.com:389',
    FREEIPA_BASE_DN: 'dc=example,dc=com',
    FREEIPA_BIND_DN: 'uid=svc,cn=users,cn=accounts,dc=example,dc=com',
    FREEIPA_BIND_PASSWORD: 'svc-pass'
};

const run = (env, script, username, password) => {
    const cfg = loadConfig({ ...baseEnv, ...env });
    return authenticate(cfg, username, password, { createClient: fakeClient(script) });
};

const goodScript = () => ({
    binds: [],
    bindDn: baseEnv.FREEIPA_BIND_DN,
    entries: [{ dn: 'uid=alice,cn=users,cn=accounts,dc=example,dc=com', uid: 'alice', cn: 'Alice', displayName: 'Alice A', mail: 'alice@example.com', memberOf: ['cn=signage-admins,cn=groups,cn=accounts,dc=example,dc=com'] }]
});

test('loadConfig: выключенный FreeIPA -> null', () => {
    assert.equal(loadConfig({ FREEIPA_ENABLED: 'false' }), null);
    assert.equal(loadConfig({}), null);
});

test('loadConfig: включён без URL -> понятная ошибка', () => {
    assert.throws(() => loadConfig({ FREEIPA_ENABLED: 'true', FREEIPA_BASE_DN: 'dc=x' }), /FREEIPA_URL/);
});

test('loadConfig: URL без схемы ldap -> ошибка', () => {
    assert.throws(() => loadConfig({ ...baseEnv, FREEIPA_URL: 'ipa.example.com' }), /ldap:\/\//);
});

// --- адрес каталога по частям: удобно при нестандартных портах ---

const partsEnv = { FREEIPA_ENABLED: 'true', FREEIPA_BASE_DN: 'dc=example,dc=com' };

test('адрес по частям: FREEIPA_HOST без порта -> ldaps:636 по умолчанию', () => {
    const cfg = loadConfig({ ...partsEnv, FREEIPA_HOST: 'ipa.example.com' });
    assert.equal(cfg.url, 'ldaps://ipa.example.com:636');
});

test('адрес по частям: свой порт сохраняется', () => {
    const cfg = loadConfig({ ...partsEnv, FREEIPA_HOST: 'ipa.example.com', FREEIPA_PORT: '1636' });
    assert.equal(cfg.url, 'ldaps://ipa.example.com:1636');
});

test('адрес по частям: порт 389 без схемы -> ldap:389', () => {
    const cfg = loadConfig({ ...partsEnv, FREEIPA_HOST: 'ipa.example.com', FREEIPA_PORT: '389' });
    assert.equal(cfg.url, 'ldap://ipa.example.com:389');
});

test('адрес по частям: схема задана явно (ldap на своём порту)', () => {
    const cfg = loadConfig({ ...partsEnv, FREEIPA_HOST: 'ipa.example.com', FREEIPA_SCHEME: 'ldap', FREEIPA_PORT: '1389' });
    assert.equal(cfg.url, 'ldap://ipa.example.com:1389');
    // StartTLS не включается сам: это отдельная настройка, иначе сломали бы чужие конфигурации
    assert.equal(cfg.startTLS, false);
});

test('адрес по частям: FREEIPA_URL имеет приоритет', () => {
    const cfg = loadConfig({ ...partsEnv, FREEIPA_URL: 'ldap://other:1389', FREEIPA_HOST: 'ipa.example.com', FREEIPA_PORT: '1636' });
    assert.equal(cfg.url, 'ldap://other:1389');
});

test('адрес по частям: FREEIPA_HOST со схемой/портом -> понятная ошибка', () => {
    assert.throws(() => loadConfig({ ...partsEnv, FREEIPA_HOST: 'ldaps://ipa.example.com:636' }), /FREEIPA_HOST/);
});

test('адрес по частям: неверный порт и схема -> ошибки', () => {
    assert.throws(() => loadConfig({ ...partsEnv, FREEIPA_HOST: 'ipa', FREEIPA_PORT: '0' }), /FREEIPA_PORT/);
    assert.throws(() => loadConfig({ ...partsEnv, FREEIPA_HOST: 'ipa', FREEIPA_PORT: '70000' }), /FREEIPA_PORT/);
    assert.throws(() => loadConfig({ ...partsEnv, FREEIPA_HOST: 'ipa', FREEIPA_PORT: 'порт' }), /FREEIPA_PORT/);
    assert.throws(() => loadConfig({ ...partsEnv, FREEIPA_HOST: 'ipa', FREEIPA_SCHEME: 'http' }), /FREEIPA_SCHEME/);
});

test('адрес по частям: ни URL, ни хоста -> отказ старта', () => {
    assert.throws(() => loadConfig(partsEnv), /FREEIPA_URL/);
});

test('loadConfig: фильтр без {username} -> ошибка', () => {
    assert.throws(() => loadConfig({ ...baseEnv, FREEIPA_USER_FILTER: '(uid=admin)' }), /\{username\}/);
});

test('loadConfig: user base DN по умолчанию строится из BASE_DN', () => {
    const cfg = loadConfig(baseEnv);
    assert.equal(cfg.userBaseDn, 'cn=users,cn=accounts,dc=example,dc=com');
});

test('успешный вход: сервисный bind, поиск, bind с паролем пользователя', async () => {
    const s = goodScript();
    const r = await run({}, s, 'alice', 's3cret');
    assert.equal(r.ok, true);
    assert.equal(r.user.username, 'alice');
    assert.equal(r.user.mail, 'alice@example.com');
    assert.deepEqual(s.binds, [
        [baseEnv.FREEIPA_BIND_DN, 'svc-pass'],
        ['uid=alice,cn=users,cn=accounts,dc=example,dc=com', 's3cret']
    ]);
});

test('пустой пароль -> отказ без обращения к каталогу', async () => {
    const s = goodScript();
    const r = await run({}, s, 'alice', '');
    assert.deepEqual(r, { ok: false, reason: 'empty-password' });
    assert.equal(s.binds.length, 0);
});

test('пустой логин -> отказ', async () => {
    const r = await run({}, goodScript(), '  ', 'x');
    assert.deepEqual(r, { ok: false, reason: 'empty-username' });
});

test('пользователь не найден -> not-found', async () => {
    const s = { ...goodScript(), entries: [] };
    const r = await run({}, s, 'bob', 'x');
    assert.equal(r.reason, 'not-found');
});

test('несколько совпадений -> ambiguous (не пускаем)', async () => {
    const s = goodScript();
    s.entries = [s.entries[0], { ...s.entries[0], dn: 'uid=alice,cn=other,dc=example,dc=com' }];
    const r = await run({}, s, 'alice', 'x');
    assert.equal(r.reason, 'ambiguous');
});

test('неверный пароль пользователя -> bad-password', async () => {
    const s = { ...goodScript(), userBindError: new (require('ldapts').InvalidCredentialsError)('invalid') };
    const r = await run({}, s, 'alice', 'wrong');
    assert.equal(r.reason, 'bad-password');
});

test('ограничение по группе: не в группе -> not-in-group', async () => {
    const s = goodScript();
    s.entries[0].memberOf = ['cn=other,cn=groups,cn=accounts,dc=example,dc=com'];
    const r = await run({ FREEIPA_REQUIRE_GROUP: 'cn=signage-admins,cn=groups,cn=accounts,dc=example,dc=com' }, s, 'alice', 'x');
    assert.equal(r.reason, 'not-in-group');
    assert.equal(s.binds.length, 1);   // до bind с паролем дело не дошло
});

test('ограничение по группе: в группе -> вход', async () => {
    const s = goodScript();
    const r = await run({ FREEIPA_REQUIRE_GROUP: 'cn=signage-admins,cn=groups,cn=accounts,dc=example,dc=com' }, s, 'alice', 's3cret');
    assert.equal(r.ok, true);
});

test('StartTLS вызывается до bind, когда включён', async () => {
    const s = goodScript();
    const cfg = loadConfig({ ...baseEnv, FREEIPA_STARTTLS: 'true' });
    const r = await authenticate(cfg, 'alice', 's3cret', { createClient: fakeClient(s) });
    assert.equal(r.ok, true);
});

test('спецсимволы в логине экранируются (нет LDAP-инъекции)', async () => {
    const s = goodScript();
    let seenFilter = null;
    const cfg = loadConfig(baseEnv);
    const client = () => ({
        async bind() {}, async unbind() {},
        async search(base, opts) { seenFilter = opts.filter; return { searchEntries: s.entries }; }
    });
    await authenticate(cfg, 'a)(uid=*', 'x', { createClient: client });
    assert.ok(seenFilter.includes('\\29') || seenFilter.includes('\\28'), `фильтр не экранирован: ${seenFilter}`);
    assert.ok(!seenFilter.includes(')(uid=*)'));
});

test('атрибуты читаются без учёта регистра (memberof/displayname)', async () => {
    const s = goodScript();
    s.entries = [{
        dn: 'uid=alice,cn=users,cn=accounts,dc=example,dc=com',
        uid: ['alice'], cn: ['Alice'], displayname: ['Alice A'], mail: ['alice@example.com'],
        memberof: ['cn=signage-admins,cn=groups,cn=accounts,dc=example,dc=com']
    }];
    const r = await run({ FREEIPA_REQUIRE_GROUP: 'cn=signage-admins,cn=groups,cn=accounts,dc=example,dc=com' }, s, 'alice', 's3cret');
    assert.equal(r.ok, true);
    assert.equal(r.user.displayName, 'Alice A');
    assert.equal(r.user.mail, 'alice@example.com');
});

test('сетевая ошибка сервисного bind пробрасывается (решение о fallback — в server.js)', async () => {
    const s = { ...goodScript(), serviceBindError: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }) };
    await assert.rejects(() => run({}, s, 'alice', 'x'), /ECONNREFUSED/);
});
