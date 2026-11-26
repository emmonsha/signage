// Панель «Пользователи»: активные сессии (кто сейчас работает) и их завершение.
// Живой HTTP-сервер (server.js) с подменённым каталогом — сеть и LDAP не нужны.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { portIn } = require('./helpers/port');

const ROOT = path.join(__dirname, '..');
const HELPER = path.join(__dirname, 'helpers', 'fake-ipa-server.js');
const USERS = JSON.stringify({ alice: 'good-alice', bob: 'good-bob' });
const DISPLAY = JSON.stringify({ alice: 'Алиса', bob: 'Борис' });

function start(port, dir, extra = {}) {
    const child = spawn(process.execPath, [HELPER], {
        cwd: ROOT,
        env: {
            ...process.env, PORT: String(port), STORAGE_DIR: dir, NODE_ENV: 'test',
            AUTH_MODE: 'freeipa', FREEIPA_ENABLED: 'true', SCREENS: 'left', ADMIN_USER: 'admin',
            FREEIPA_ACCESS_MODE: 'auto', FREEIPA_FAKE_USERS: USERS, FREEIPA_FAKE_DISPLAY: DISPLAY,
            ...extra
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.log = '';
    child.stdout.on('data', d => { child.log += d; });
    child.stderr.on('data', d => { child.log += d; });
    return child;
}

async function waitHealth(port, tries = 300) {
    for (let i = 0; i < tries; i++) {
        try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return true; } catch { /* поднимается */ }
        await new Promise(r => setTimeout(r, 100));
    }
    return false;
}
async function mustStart(child, port) {
    if (await waitHealth(port)) return;
    const tail = child.log.trim().split('\n').slice(-6).join(' | ') || '(нет вывода)';
    assert.fail(`сервер не поднялся на порту ${port}. Вывод: ${tail}`);
}

const url = (port, p) => `http://127.0.0.1:${port}${p}`;
async function loginCookie(port, username, password) {
    const r = await fetch(url(port, '/api/login'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    });
    return { status: r.status, body: await r.json(), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
const authed = (port, p, cookie, opts = {}) => fetch(url(port, p), { ...opts, headers: { ...(opts.headers || {}), cookie } });
const postJson = (port, p, cookie, body) => authed(port, p, cookie, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});

test('панель сессий: показывает активные входы, завершение чужой сессии работает', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-sess-users-'));
    const port = portIn(6800, 60);
    const child = start(port, dir);
    try {
        await mustStart(child, port);

        // Оба сотрудника каталога допущены (иначе второй не войдёт).
        const { cookie: alice } = await loginCookie(port, 'alice', 'good-alice');
        assert.equal((await postJson(port, '/api/users', alice, { username: 'alice' })).status, 200);
        assert.equal((await postJson(port, '/api/users', alice, { username: 'bob' })).status, 200);

        // bob входит со своего «устройства» — появляется вторая активная сессия
        const bobLogin = await loginCookie(port, 'bob', 'good-bob');
        assert.equal(bobLogin.status, 200);

        const list = await (await authed(port, '/api/users/sessions', alice)).json();
        assert.equal(list.success, true);
        const names = list.sessions.map(s => s.username).sort();
        assert.deepEqual(names, ['alice', 'bob'], 'в списке должны быть обе активные сессии');
        // наружу не отдаём настоящий id сессии — только хэш заданной длины
        for (const s of list.sessions) assert.match(s.id, /^[a-f0-9]{16}$/);
        // своя сессия помечена, чужая — нет
        const mine = list.sessions.filter(s => s.current);
        assert.equal(mine.length, 1);
        assert.equal(mine[0].username, 'alice');
        // метаданные входа заполнены
        assert.ok(list.sessions.every(s => s.loginAt && s.ip), 'должны быть время входа и IP');

        // себя завершить нельзя
        const self = await postJson(port, '/api/users/sessions/revoke', alice, { id: mine[0].id, password: 'good-alice' });
        assert.equal(self.status, 400);

        // чужую — можно, но только с верным паролем
        const bobSess = list.sessions.find(s => s.username === 'bob');
        const bad = await postJson(port, '/api/users/sessions/revoke', alice, { id: bobSess.id, password: 'неверный' });
        assert.equal(bad.status, 403);
        assert.equal((await authed(port, '/api/me', bobLogin.cookie)).status, 200, 'при неверном пароле чужая сессия жива');

        const ok = await postJson(port, '/api/users/sessions/revoke', alice, { id: bobSess.id, password: 'good-alice' });
        assert.equal(ok.status, 200);

        // сессия bob действительно погашена
        assert.equal((await authed(port, '/api/me', bobLogin.cookie)).status, 401, 'завершённая сессия должна перестать работать');

        const after = await (await authed(port, '/api/users/sessions', alice)).json();
        assert.deepEqual(after.sessions.map(s => s.username), ['alice']);
    } finally {
        child.kill('SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('убранный из списка допущенных сразу помечается как недействительный', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-sess-drop-'));
    const port = portIn(7000, 60);
    const child = start(port, dir);
    try {
        await mustStart(child, port);
        const { cookie: alice } = await loginCookie(port, 'alice', 'good-alice');
        await postJson(port, '/api/users', alice, { username: 'alice' });
        await postJson(port, '/api/users', alice, { username: 'bob' });
        const bobLogin = await loginCookie(port, 'bob', 'good-bob');
        assert.equal(bobLogin.status, 200);

        // панель видит сессию bob
        let list = await (await authed(port, '/api/users/sessions', alice)).json();
        assert.ok(list.sessions.some(s => s.username === 'bob'), 'сессия bob должна быть видна');

        // убрали bob из списка допущенных
        assert.equal((await postJson(port, '/api/users/delete', alice, { username: 'bob', password: 'good-alice' })).status, 200);

        // его сессия сразу недействительна: пропадает из панели и перестаёт работать
        list = await (await authed(port, '/api/users/sessions', alice)).json();
        assert.ok(!list.sessions.some(s => s.username === 'bob'), 'недействительная сессия не должна показываться в панели');
        assert.equal((await authed(port, '/api/me', bobLogin.cookie)).status, 401);
    } finally {
        child.kill('SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('панель не показывает мёртвые сессии (сменился пароль)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-sess-stale-'));
    const port = portIn(7100, 60);
    let child = start(port, dir);
    try {
        await mustStart(child, port);
        const before = await loginCookie(port, 'alice', 'good-alice');
        assert.equal(before.status, 200);

        // смена пароля -> все прежние сессии мертвы. В панели их быть не должно.
        await new Promise(r => setTimeout(r, 400));
        child.kill('SIGTERM');
        await new Promise(r => setTimeout(r, 500));
        child = start(port, dir, { ADMIN_PASSWORD: 'TestPass-123456', AUTH_MODE: 'local', FREEIPA_ENABLED: 'false' });
        await mustStart(child, port);
        const fresh = await loginCookie(port, 'admin', 'TestPass-123456');
        assert.equal(fresh.status, 200);
        const list = await (await authed(port, '/api/users/sessions', fresh.cookie)).json();
        // остаётся только новая сессия; мёртвая (от прежнего пароля/версии) вычищена
        assert.equal(list.sessions.length, 1);
        assert.equal(list.sessions[0].current, true);
    } finally {
        child.kill('SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('в local-режиме панель показывает сессии, но списка допущенных нет', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-sess-local-'));
    const port = portIn(7200, 60);
    const child = start(port, dir, { AUTH_MODE: 'local', FREEIPA_ENABLED: 'false', ADMIN_PASSWORD: 'TestPass-123456' });
    try {
        await mustStart(child, port);
        const { cookie } = await loginCookie(port, 'admin', 'TestPass-123456');
        const info = await (await authed(port, '/api/users', cookie)).json();
        assert.equal(info.catalog, false);
        const sess = await (await authed(port, '/api/users/sessions', cookie)).json();
        assert.equal(sess.sessions.length, 1);
        assert.equal(sess.sessions[0].username, 'admin');
        assert.equal(sess.sessions[0].current, true);
    } finally {
        child.kill('SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
