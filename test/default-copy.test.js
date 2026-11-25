// Заглушка: галочка «на всех экранах». Баг: поставленная ПОСЛЕ загрузки картинки
// галочка ничего не делала (она читалась только в момент upload).
// Теперь есть POST /api/default/copy — копирует уже загруженную заглушку на все экраны.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PASSWORD = 'test-pass-123';
const SERVER = path.join(__dirname, '..', 'server.js');

const waitHealth = async (port, tries = 80) => {
    for (let i = 0; i < tries; i++) {
        try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return true; } catch {}
        await new Promise(r => setTimeout(r, 100));
    }
    return false;
};

const start = (port, dir) => spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), STORAGE_DIR: dir, AUTH_MODE: 'local',
           ADMIN_USER: 'admin', ADMIN_PASSWORD: PASSWORD, SCREENS: 'left,right,big_wall', NODE_ENV: 'test' },
    stdio: 'ignore'
});

const login = async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: PASSWORD })
    });
    return r.headers.get('set-cookie').split(';')[0];
};

// минимальный PNG 1×1
const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');

test('галочка «на всех экранах» после загрузки: заглушка копируется на все экраны', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-def-'));
    const port = 4700 + Math.floor(Math.random() * 200);
    const child = start(port, dir);
    try {
        assert.ok(await waitHealth(port), 'сервер не поднялся');
        const cookie = await login(port);

        // 1) загружаем заглушку только на left (галочка не отмечена)
        const fd = new FormData();
        fd.append('screen', 'left');
        fd.append('fit', 'fit');
        fd.append('image', new Blob([PNG], { type: 'image/png' }), 'a.png');
        const up = await fetch(`http://127.0.0.1:${port}/api/default`, { method: 'POST', headers: { cookie }, body: fd });
        assert.equal(up.status, 200, 'заглушка не загрузилась');

        const pl = async (scr) => {
            const token = (await (await fetch(`http://127.0.0.1:${port}/api/screens`, { headers: { cookie } })).json())
                .screens.find(s => s.id === scr).token;
            return (await (await fetch(`http://127.0.0.1:${port}/api/playlist/${token}`)).json());
        };

        assert.ok((await pl('left')).default_image, 'на left должна быть заглушка');
        assert.ok(!(await pl('right')).default_image, 'на right пока не должно быть заглушки');

        // 2) теперь «ставим галочку» -> применяем ко всем
        const cp = await fetch(`http://127.0.0.1:${port}/api/default/copy`, {
            method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ screen: 'left' })
        });
        assert.equal(cp.status, 200);
        const res = await cp.json();
        assert.equal(res.success, true);
        assert.deepEqual(res.screens.sort(), ['big_wall', 'left', 'right']);

        // 3) заглушка теперь у всех и это один и тот же файл
        const left = (await pl('left')).default_image;
        assert.equal((await pl('right')).default_image, left, 'right не получил заглушку');
        assert.equal((await pl('big_wall')).default_image, left, 'big_wall не получил заглушку');
    } finally {
        child.kill('SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('copy: без заглушки на экране -> 400 с понятным текстом', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-def2-'));
    const port = 4900 + Math.floor(Math.random() * 90);
    const child = start(port, dir);
    try {
        assert.ok(await waitHealth(port), 'сервер не поднялся');
        const cookie = await login(port);
        const r = await fetch(`http://127.0.0.1:${port}/api/default/copy`, {
            method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ screen: 'left' })
        });
        assert.equal(r.status, 400);
        assert.match((await r.json()).message, /нет заглушки/i);
    } finally {
        child.kill('SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('copy: без авторизации -> 401', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-def3-'));
    const port = 5000 + Math.floor(Math.random() * 90);
    const child = start(port, dir);
    try {
        assert.ok(await waitHealth(port), 'сервер не поднялся');
        const r = await fetch(`http://127.0.0.1:${port}/api/default/copy`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ screen: 'left' })
        });
        assert.equal(r.status, 401);
    } finally {
        child.kill('SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
