// Защита от двух регрессий, найденных при приёмке 2026-11-26:
//   1) на странице входа не было поля логина при входе через FreeIPA
//      (в login.html был битый CSS: осиротевший ` ========== -->` + второй <style> — из-за
//      этого блок :root отбрасывался браузером и форма теряла оформление);
//   2) в админке не было значка пользователя с выпадающей кнопкой выхода.
// Тесты без сети: поднимаем настоящий server.js на свободном порту с временным STORAGE_DIR.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PASSWORD = 'TestPass-123456';
const ROOT = path.join(__dirname, '..');

async function waitHealth(port, tries = 100) {
    for (let i = 0; i < tries; i++) {
        try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return true; } catch {}
        await new Promise(r => setTimeout(r, 100));
    }
    return false;
}

function start(port, dir, extra = {}) {
    return spawn(process.execPath, [path.join(ROOT, 'server.js')], {
        env: {
            ...process.env, PORT: String(port), STORAGE_DIR: dir, NODE_ENV: 'test',
            ADMIN_USER: 'admin', ADMIN_PASSWORD: PASSWORD, SCREENS: 'left', ...extra
        },
        stdio: 'ignore'
    });
}

// ---- статические проверки файлов (hа env-независимы, дешёвые) ----

test('login.html: один <style>, нет осиротевшего фрагмента комментария', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'login.html'), 'utf8');
    assert.equal((html.match(/<style>/g) || []).length, 1, 'второй <style> отбрасывает :root у браузера');
    assert.equal((html.match(/<\/style>/g) || []).length, 1, 'незакрытый/лишний </style>');
    assert.doesNotMatch(html, /^\s*=+\s*-->\s*$/m, 'битый фрагмент комментария ломает разбор CSS');
    assert.match(html, /__AUTH_MODE__/, 'режим входа подставляет сервер');
    assert.match(html, /__AUTH_HINT__/, 'подсказку подставляет сервер');
    assert.match(html, /__AUTH_USER__/, 'логин подставляет сервер');
    // Поле логина показываем всегда (нет правила, скрывающего #user).
    assert.doesNotMatch(html, /#user\s*\{[^}]*display:\s*none/, 'поле логина не должно скрываться');
});

test('admin.html: значок пользователя и выпадающее меню выхода присутствуют', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8');
    assert.match(html, /id="userBox"/, 'нет контейнера значка пользователя');
    assert.match(html, /id="userMenu"[^>]*role="menu"/, 'нет выпадающего меню');
    assert.match(html, /id="userMenu"[\s\S]{0,400}onclick="logout\(\)"/, 'в меню нет выхода');
    assert.match(html, /aria-haspopup="menu"/, 'кнопка должна объявлять меню');
});

// ---- поведение сервера ----

test('поле логина показывается всегда: при FreeIPA пустое, в local предзаполнено', async () => {
    // both/freeipa: поле есть, но логин вводит пользователь -> пустое
    const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-authui-'));
    const port1 = 4200 + Math.floor(Math.random() * 90);
    const child1 = start(port1, dir1, {
        AUTH_MODE: 'both', FREEIPA_ENABLED: 'true', FREEIPA_URL: 'ldaps://ipa.invalid:636',
        FREEIPA_BASE_DN: 'dc=example,dc=com',
        FREEIPA_BIND_DN: 'uid=b,cn=users,cn=accounts,dc=example,dc=com', FREEIPA_BIND_PASSWORD: 'x'
    });
    try {
        assert.ok(await waitHealth(port1), 'сервер не поднялся');
        const html = await (await fetch(`http://127.0.0.1:${port1}/admin`)).text();
        assert.match(html, /data-auth-mode="both"/, 'режим должен попасть в разметку');
        assert.match(html, /id="user"[^>]*value=""/, 'при FreeIPA поле логина показываем пустым');
        const a = await (await fetch(`http://127.0.0.1:${port1}/api/auth`)).json();
        assert.equal(a.username, true);
    } finally {
        child1.kill('SIGKILL');
        fs.rmSync(dir1, { recursive: true, force: true });
    }

    // local: учётка одна — поле показано и предзаполнено ADMIN_USER
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-authui2-'));
    const port2 = 4300 + Math.floor(Math.random() * 90);
    const child2 = start(port2, dir2, { AUTH_MODE: 'local', FREEIPA_ENABLED: 'false', ADMIN_USER: 'admin' });
    try {
        assert.ok(await waitHealth(port2), 'сервер не поднялся');
        const r = await fetch(`http://127.0.0.1:${port2}/login`);
        assert.equal(r.status, 200, '/login должен отдавать форму входа, а не Cannot GET');
        const html = await r.text();
        assert.match(html, /data-auth-mode="local"/);
        assert.match(html, /id="user"[^>]*value="admin"/, 'в local поле логина видно и предзаполнено');
    } finally {
        child2.kill('SIGKILL');
        fs.rmSync(dir2, { recursive: true, force: true });
    }
});

test('/api/me: 401 без входа и данные пользователя после входа', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-authui3-'));
    const port = 4400 + Math.floor(Math.random() * 90);
    const child = start(port, dir, { AUTH_MODE: 'local' });
    try {
        assert.ok(await waitHealth(port), 'сервер не поднялся');
        assert.equal((await fetch(`http://127.0.0.1:${port}/api/me`)).status, 401, 'без сессии должен быть 401');

        const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: PASSWORD })
        });
        assert.equal(login.status, 200);
        const cookie = login.headers.get('set-cookie').split(';')[0];
        const me = await (await fetch(`http://127.0.0.1:${port}/api/me`, { headers: { cookie } })).json();
        assert.equal(me.success, true);
        assert.equal(me.username, 'admin');
        assert.equal(me.via, 'local', 'должен быть указан источник входа для подписи в меню');

        const admin = await (await fetch(`http://127.0.0.1:${port}/admin`, { headers: { cookie } })).text();
        assert.match(admin, /id="userBox"/, 'после входа отдаётся админка со значком пользователя');
    } finally {
        child.kill('SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
