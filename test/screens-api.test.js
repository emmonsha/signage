// Интеграционный тест API экранов: поднимаем настоящий server.js на свободном порту
// с временным STORAGE_DIR и проверяем защиту удаления паролем. Сеть наружу не нужна.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hashPassword } = require('../auth');

const PASSWORD = 'TestPass-123456';

async function waitHealth(port, tries = 100) {
    for (let i = 0; i < tries; i++) {
        try {
            const r = await fetch(`http://127.0.0.1:${port}/healthz`);
            if (r.ok) return true;
        } catch {}
        await new Promise(r => setTimeout(r, 100));
    }
    return false;
}

test('удаление экрана требует верный пароль', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-api-'));
    const port = 3900 + Math.floor(Math.random() * 90);
    const hash = await hashPassword(PASSWORD);
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env: { ...process.env, PORT: String(port), STORAGE_DIR: dir, ADMIN_PASSWORD_HASH: hash,
               AUTH_MODE: 'local', ADMIN_USER: 'admin', SCREENS: 'left,right', NODE_ENV: 'test' },
        stdio: 'ignore'
    });
    try {
        assert.ok(await waitHealth(port), 'сервер не поднялся');

        const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: PASSWORD })
        });
        assert.equal(login.status, 200);
        const cookie = login.headers.get('set-cookie').split(';')[0];
        const post = (url, body) => fetch(`http://127.0.0.1:${port}${url}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body)
        });
        const listIds = async () => (await (await fetch(`http://127.0.0.1:${port}/api/screens`, { headers: { cookie } })).json()).screens.map(s => s.id);

        // создаём временный экран
        const made = await (await post('/api/screens', { name: 'Temp' })).json();
        assert.equal(made.success, true);
        const id = made.screen.id;
        assert.ok((await listIds()).includes(id));

        // без пароля — отказ, экран жив
        const noPw = await post(`/api/screens/${id}/delete`, {});
        assert.equal(noPw.status, 403);
        assert.ok((await listIds()).includes(id));

        // неверный пароль — отказ, экран жив
        const bad = await post(`/api/screens/${id}/delete`, { password: 'nope' });
        assert.equal(bad.status, 403);
        assert.ok((await listIds()).includes(id));

        // без авторизации — 401
        const anon = await fetch(`http://127.0.0.1:${port}/api/screens/${id}/delete`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD })
        });
        assert.equal(anon.status, 401);

        // верный пароль — экран удалён
        const ok = await post(`/api/screens/${id}/delete`, { password: PASSWORD });
        assert.equal(ok.status, 200);
        assert.equal((await ok.json()).success, true);
        assert.ok(!(await listIds()).includes(id));
    } finally {
        child.kill('SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('плейлист доступен только по токену', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-api-'));
    const port = 4000 + Math.floor(Math.random() * 90);
    const hash = await hashPassword(PASSWORD);
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env: { ...process.env, PORT: String(port), STORAGE_DIR: dir, ADMIN_PASSWORD_HASH: hash,
               AUTH_MODE: 'local', ADMIN_USER: 'admin', SCREENS: 'left', NODE_ENV: 'test' },
        stdio: 'ignore'
    });
    try {
        assert.ok(await waitHealth(port), 'сервер не поднялся');
        const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: PASSWORD })
        });
        const cookie = login.headers.get('set-cookie').split(';')[0];

        // старый способ по имени — 404
        assert.equal((await fetch(`http://127.0.0.1:${port}/api/playlist/left`)).status, 404);

        // по токену — 200
        const scr = (await (await fetch(`http://127.0.0.1:${port}/api/screens`, { headers: { cookie } })).json()).screens[0];
        assert.match(scr.token, /^[0-9a-f]{32}$/);
        assert.equal((await fetch(`http://127.0.0.1:${port}/api/playlist/${scr.token}`)).status, 200);

        // список экранов без входа — 401 (имена наружу не выдаются)
        assert.equal((await fetch(`http://127.0.0.1:${port}/api/screens`)).status, 401);
    } finally {
        child.kill('SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('старый формат heartbeat (screen) отклоняется с подсказкой', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-api-'));
    const port = 4100 + Math.floor(Math.random() * 90);
    const hash = await hashPassword(PASSWORD);
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env: { ...process.env, PORT: String(port), STORAGE_DIR: dir, ADMIN_PASSWORD_HASH: hash,
               AUTH_MODE: 'local', ADMIN_USER: 'admin', SCREENS: 'left', NODE_ENV: 'test' },
        stdio: 'ignore'
    });
    try {
        assert.ok(await waitHealth(port), 'сервер не поднялся');
        // старый формат: имя вместо токена -> 400 + hint
        const old = await fetch(`http://127.0.0.1:${port}/api/heartbeat`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ screen: 'left', kind: 'slide', slideId: 'x' })
        });
        assert.equal(old.status, 400);
        const body = await old.json();
        assert.equal(body.ok, false);
        assert.match(body.hint, /token/);

        // новый формат: по токену экрана -> 200 и статус
        const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: PASSWORD })
        });
        const cookie = login.headers.get('set-cookie').split(';')[0];
        const scr = (await (await fetch(`http://127.0.0.1:${port}/api/screens`, { headers: { cookie } })).json()).screens[0];
        const ok = await fetch(`http://127.0.0.1:${port}/api/heartbeat`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: scr.token, kind: 'slide', slideId: 'y', duration: 5000 })
        });
        assert.equal(ok.status, 200);
        const st = await (await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { cookie } })).json();
        assert.equal(st.screens.left.kind, 'slide');
    } finally {
        child.kill('SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
