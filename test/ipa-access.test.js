// Вход через каталог и список допущенных — на живом HTTP-сервере (server.js),
// но с подменённым модулем freeipa.js: сеть и настоящий LDAP не нужны (см. helpers/).
// Проверяем главное требование: пока список допущенных не пуст, «простой» сотрудник
// каталога (верный пароль, но не в списке) в админку не попадает.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HELPER = path.join(__dirname, 'helpers', 'fake-ipa-server.js');

// Два сотрудника каталога: alice — «наша», bob — «простой» (верный пароль, но не в списке).
const USERS = JSON.stringify({ alice: 'good-alice', bob: 'good-bob' });
const DISPLAY = JSON.stringify({ alice: 'Алиса', bob: 'Борис' });

function start(port, dir, extra = {}) {
    return spawn(process.execPath, [HELPER], {
        cwd: ROOT,
        env: {
            ...process.env, PORT: String(port), STORAGE_DIR: dir, NODE_ENV: 'test',
            AUTH_MODE: 'freeipa', FREEIPA_ENABLED: 'true', SCREENS: 'left', ADMIN_USER: 'admin',
            FREEIPA_ACCESS_MODE: 'auto', FREEIPA_FAKE_USERS: USERS, FREEIPA_FAKE_DISPLAY: DISPLAY,
            ...extra
        },
        stdio: 'ignore'
    });
}

async function waitHealth(port, tries = 100) {
    for (let i = 0; i < tries; i++) {
        try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return true; } catch { /* поднимается */ }
        await new Promise(r => setTimeout(r, 100));
    }
    return false;
}

const url = (port, p) => `http://127.0.0.1:${port}${p}`;

async function loginCookie(port, username, password) {
    const r = await fetch(url(port, '/api/login'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    });
    return { status: r.status, body: await r.json(), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
const authed = (port, p, cookie, opts = {}) => fetch(url(port, p), {
    ...opts, headers: { ...(opts.headers || {}), cookie }
});
const postJson = (port, p, cookie, body) => authed(port, p, cookie, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});

test('вход через каталог: список допущенных закрывает доступ «простым» сотрудникам', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-ipa-'));
    const port = 5300 + Math.floor(Math.random() * 150);
    const child = start(port, dir);
    try {
        assert.ok(await waitHealth(port), 'сервер не поднялся');

        // 1) список пуст — любой сотрудник каталога входит (прежнее поведение)
        assert.equal((await loginCookie(port, 'bob', 'good-bob')).status, 200);

        // 2) API доступа без входа недоступен
        assert.equal((await fetch(url(port, '/api/users'))).status, 401);
        assert.equal((await fetch(url(port, '/api/users'), { method: 'POST' })).status, 401);

        const { cookie } = await loginCookie(port, 'alice', 'good-alice');

        // 3) несуществующий логин — понятная ошибка, без записи в список
        const noSuch = await postJson(port, '/api/users', cookie, { username: 'no-such-user' });
        assert.equal(noSuch.status, 400);
        assert.match((await noSuch.json()).message, /нет пользователя/i);

        // 4) добавляем alice — и вход остальным закрывается сам
        const add = await postJson(port, '/api/users', cookie, { username: 'alice', note: 'админ' });
        assert.equal(add.status, 200);
        const added = await add.json();
        assert.equal(added.mode, 'list', 'как только список не пуст, режим становится list');
        assert.equal(added.user.username, 'alice');
        assert.equal(added.user.displayName, 'Алиса', 'имя подтягивается из каталога');
        const list1 = await (await authed(port, '/api/users', cookie)).json();
        assert.deepEqual(list1.users.map(u => u.username), ['alice']);

        // 5) «наша» входит, «простой» — нет, и отказ именно по списку (пароль у него верный)
        assert.equal((await loginCookie(port, 'alice', 'good-alice')).status, 200);
        const bob = await loginCookie(port, 'bob', 'good-bob');
        assert.equal(bob.status, 401);
        assert.match(bob.body.message, /не в списке/i);

        // 6) повторное добавление — 409
        assert.equal((await postJson(port, '/api/users', cookie, { username: 'ALICE' })).status, 409);

        // 7) удаление подтверждается паролем: неверный — 403 и список не меняется
        assert.equal((await postJson(port, '/api/users/delete', cookie, { username: 'alice', password: 'нет' })).status, 403);
        const list = await (await authed(port, '/api/users', cookie)).json();
        assert.deepEqual(list.users.map(u => u.username), ['alice']);

        // 8) убрали последнюю запись — режим снова open, «простой» входит
        const del = await postJson(port, '/api/users/delete', cookie, { username: 'alice', password: 'good-alice' });
        assert.equal(del.status, 200);
        const after = await del.json();
        assert.equal(after.mode, 'open');
        const list2 = await (await authed(port, '/api/users', cookie)).json();
        assert.deepEqual(list2.users, []);
        assert.equal((await loginCookie(port, 'bob', 'good-bob')).status, 200);

        // 9) файл списка лежит в томе, рядом с остальными данными
        assert.ok(fs.existsSync(path.join(dir, 'data', 'users.json')), 'users.json должен лежать в STORAGE_DIR/data');
    } finally {
        child.kill('SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('FREEIPA_ACCESS_MODE=list с пустым списком не пускает никого (явное ограничение)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-ipa-list-'));
    const port = 5500 + Math.floor(Math.random() * 100);
    const child = start(port, dir, { FREEIPA_ACCESS_MODE: 'list' });
    try {
        assert.ok(await waitHealth(port), 'сервер не поднялся');
        // список пуст, но режим задан явно — каталог не пускает
        const r = await loginCookie(port, 'bob', 'good-bob');
        assert.equal(r.status, 401);
        assert.match(r.body.message, /не в списке/i);
    } finally {
        child.kill('SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('FREEIPA_ACCESS_MODE=open: список не ограничивает (справочник)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-ipa-open-'));
    const port = 5600 + Math.floor(Math.random() * 100);
    const child = start(port, dir, { FREEIPA_ACCESS_MODE: 'open' });
    try {
        assert.ok(await waitHealth(port), 'сервер не поднялся');
        const { cookie } = await loginCookie(port, 'alice', 'good-alice');
        // добавим в справочник, но режим open — bob всё равно входит
        assert.equal((await postJson(port, '/api/users', cookie, { username: 'alice' })).status, 200);
        assert.equal((await loginCookie(port, 'bob', 'good-bob')).status, 200);
    } finally {
        child.kill('SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('в режиме local раздела «Доступ» нет: catalog=false, добавление — 400', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-ipa-local-'));
    const port = 5800 + Math.floor(Math.random() * 100);
    const child = start(port, dir, { AUTH_MODE: 'local', FREEIPA_ENABLED: 'false', ADMIN_PASSWORD: 'TestPass-123456' });
    try {
        assert.ok(await waitHealth(port), 'сервер не поднялся');
        const { cookie } = await loginCookie(port, 'admin', 'TestPass-123456');
        const info = await (await authed(port, '/api/users', cookie)).json();
        assert.equal(info.catalog, false, 'в local-режиме вход через каталог выключен');
        // админ ещё не добавил никого — вход открыт (совместимость), но добавлять нечего
        const add = await postJson(port, '/api/users', cookie, { username: 'alice' });
        assert.equal(add.status, 400);
    } finally {
        child.kill('SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('неверное значение FREEIPA_ACCESS_MODE -> сервер не стартует с понятной ошибкой', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-ipa-bad-'));
    const port = 5700 + Math.floor(Math.random() * 100);
    const child = spawn(process.execPath, [HELPER], {
        cwd: ROOT,
        env: {
            ...process.env, PORT: String(port), STORAGE_DIR: dir, NODE_ENV: 'test',
            AUTH_MODE: 'freeipa', FREEIPA_ENABLED: 'true', SCREENS: 'left',
            FREEIPA_ACCESS_MODE: 'нет', FREEIPA_FAKE_USERS: USERS
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const code = await new Promise(res => child.on('exit', c => res(c)));
    fs.rmSync(dir, { recursive: true, force: true });
    assert.notEqual(code, 0, 'сервер должен отказаться стартовать');
    assert.match(out, /FREEIPA_ACCESS_MODE/);
});
