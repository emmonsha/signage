// Интеграционный тест: сессия админки переживает перезапуск сервера.
// Это причина бага «нажал снапшот — выкинуло на страницу входа»:
// MemoryStore терял сессии при рестарте/пересборке контейнера.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { portIn } = require('./helpers/port');

const PASSWORD = 'test-pass-123';
const SERVER = path.join(__dirname, '..', 'server.js');

const waitHealth = async (port, tries = 80) => {
    for (let i = 0; i < tries; i++) {
        try {
            const r = await fetch(`http://127.0.0.1:${port}/healthz`);
            if (r.ok) return true;
        } catch { /* сервер ещё поднимается */ }
        await new Promise(r => setTimeout(r, 100));
    }
    return false;
};

const start = (port, dir, extra = {}) => spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), STORAGE_DIR: dir, AUTH_MODE: 'local',
           ADMIN_USER: 'admin', ADMIN_PASSWORD: PASSWORD, SCREENS: 'left', NODE_ENV: 'test', ...extra },
    stdio: 'ignore'
});

const login = async (port, password = PASSWORD) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password })
    });
    assert.equal(r.status, 200);
    return r.headers.get('set-cookie').split(';')[0];
};

test('сессия админки переживает перезапуск сервера', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-sess-'));
    const port = portIn(5200, 150);
    let child = start(port, dir);
    try {
        assert.ok(await waitHealth(port), 'сервер не поднялся');
        const cookie = await login(port);
        assert.equal((await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { cookie } })).status, 200);

        // перезапуск — как пересборка контейнера при деплое (docker stop -> SIGTERM).
        // Даём дебаунсу записи сработать, как это происходит при реальной работе.
        await new Promise(r => setTimeout(r, 400));
        child.kill('SIGTERM');
        await new Promise(r => setTimeout(r, 500));
        child = start(port, dir);
        assert.ok(await waitHealth(port), 'сервер не поднялся после перезапуска');

        // тот же cookie должен по-прежнему работать
        const after = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { cookie } });
        assert.equal(after.status, 200, 'сессия потерялась при перезапуске — выкинет на логин');

        // и админ-страница отдаётся, а не логин
        const page = await fetch(`http://127.0.0.1:${port}/admin`, { headers: { cookie } });
        const html = await page.text();
        assert.match(html, /Снапшот экрана/, 'сервер отдал страницу входа вместо админки');
    } finally {
        child.kill('SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('смена пароля отзывает уже выданные сессии (важно при утечке)', async () => {
    // Сессии хранятся в файле на томе и переживают рестарт — это сделано специально,
    // чтобы деплой не выкидывал людей на страницу входа. Оборотная сторона: без привязки
    // к паролю украденная cookie работала бы вечно. Поэтому сессия помнит «отпечаток»
    // текущего пароля, и смена пароля делает старые сессии недействительными.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-sess-pw-'));
    const port = portIn(5800, 100);
    const NEW_PASSWORD = 'brand-new-pass-987';
    let child = start(port, dir);
    try {
        assert.ok(await waitHealth(port), 'сервер не поднялся');
        const cookie = await login(port);
        assert.equal((await fetch(`http://127.0.0.1:${port}/api/me`, { headers: { cookie } })).status, 200);

        // админ сменил пароль и перезапустил сервер (как scripts/reset-password.sh)
        await new Promise(r => setTimeout(r, 400));
        child.kill('SIGTERM');
        await new Promise(r => setTimeout(r, 500));
        child = start(port, dir, { ADMIN_PASSWORD: NEW_PASSWORD });
        assert.ok(await waitHealth(port), 'сервер не поднялся после смены пароля');

        // старая cookie больше не действует — и в API, и на странице админки
        const api = await fetch(`http://127.0.0.1:${port}/api/me`, { headers: { cookie } });
        assert.equal(api.status, 401, 'старая сессия пережила смену пароля — дыра при утечке cookie');
        const page = await fetch(`http://127.0.0.1:${port}/admin`, { headers: { cookie } });
        assert.match(await page.text(), /Вход|Логин|password/i, 'вместо логина отдалась админка');

        // новый пароль работает, старый — нет
        assert.equal(await login(port, NEW_PASSWORD).then(() => 200), 200);
        const old = await fetch(`http://127.0.0.1:${port}/api/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: PASSWORD })
        });
        assert.equal(old.status, 401);
    } finally {
        child.kill('SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('без cookie админка отдаёт логин (не 500)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-sess2-'));
    const port = portIn(5400, 150);
    const child = start(port, dir);
    try {
        assert.ok(await waitHealth(port), 'сервер не поднялся');
        const r = await fetch(`http://127.0.0.1:${port}/admin`);
        assert.equal(r.status, 200);
        assert.match(await r.text(), /Вход|Логин|password/i);
        // /api/status без авторизации — 401 (админка должна переспросить вход, а не падать)
        assert.equal((await fetch(`http://127.0.0.1:${port}/api/status`)).status, 401);
    } finally {
        child.kill('SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('файлы сессий и секрет лежат на томе (переживут смену контейнера)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-sess3-'));
    const port = portIn(5600, 150);
    const child = start(port, dir);
    try {
        assert.ok(await waitHealth(port), 'сервер не поднялся');
        await login(port);
        await new Promise(r => setTimeout(r, 300));   // дебаунс записи
        assert.ok(fs.existsSync(path.join(dir, 'data', 'sessions.json')), 'нет файла сессий');
        assert.ok(fs.existsSync(path.join(dir, 'data', '.session-secret')), 'нет файла секрета');
    } finally {
        child.kill('SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
