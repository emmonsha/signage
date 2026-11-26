// Панели админки на живом HTTP (local-режим, без каталога):
//   • «Пользователи» — создание и удаление локальных учётных записей;
//   • сессии удалённой учётной записи сразу отзываются;
//   • «Настройки» — сохранение подключения к каталогу и защита от неверных значений.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { portIn } = require('./helpers/port');

const ROOT = path.join(__dirname, '..');
const ADMIN_PW = 'admin-passphrase';

function start(port, dir, extra = {}) {
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
        cwd: ROOT,
        env: {
            ...process.env, PORT: String(port), STORAGE_DIR: dir, NODE_ENV: 'test',
            AUTH_MODE: 'local', ADMIN_PASSWORD: ADMIN_PW, ADMIN_USER: 'admin', SCREENS: 'left',
            ...extra
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.log = '';
    child.stdout.on('data', d => { child.log += d; });
    child.stderr.on('data', d => { child.log += d; });
    return child;
}

async function mustStart(child, port) {
    for (let i = 0; i < 300; i++) {
        try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return; } catch { /* поднимается */ }
        await new Promise(r => setTimeout(r, 100));
    }
    assert.fail(`сервер не поднялся на ${port}: ${child.log.trim().split('\n').slice(-5).join(' | ')}`);
}

const url = (port, p) => `http://127.0.0.1:${port}${p}`;
async function login(port, username, password) {
    const r = await fetch(url(port, '/api/login'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    });
    return { status: r.status, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
const authed = (port, p, cookie, opts = {}) => fetch(url(port, p), { ...opts, headers: { ...(opts.headers || {}), cookie } });
const postJson = (port, p, cookie, body) => authed(port, p, cookie, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});

test('учётные записи: генерация пароля, обязательная смена при первом входе, запрет встроенного логина', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-acct-'));
    const port = portIn(7400, 60);
    const child = start(port, dir);
    try {
        await mustStart(child, port);
        const admin = await login(port, 'admin', ADMIN_PW);
        assert.equal(admin.status, 200);

        // сначала есть только встроенная учётная запись
        let list = await (await authed(port, '/api/accounts', admin.cookie)).json();
        assert.equal(list.builtin.username, 'admin');
        assert.deepEqual(list.accounts, []);

        // создаём локальную учётную запись — пароль генерирует сервер и отдаёт один раз
        const created = await postJson(port, '/api/accounts', admin.cookie, { username: 'Olga', displayName: 'Ольга', note: 'бухгалтер' });
        assert.equal(created.status, 200);
        const cd = await created.json();
        assert.equal(cd.created, true);
        assert.equal(cd.generated, true);
        assert.equal(cd.account.username, 'olga');           // логин нормализуется
        assert.ok(typeof cd.password === 'string' && cd.password.length >= 10, 'транспортный пароль выдан');

        // новый администратор входит выданным паролем, но сессия помечена как «сменить пароль»
        const olga = await login(port, 'olga', cd.password);
        assert.equal(olga.status, 200);
        let me = await (await authed(port, '/api/me', olga.cookie)).json();
        assert.equal(me.mustChange, true);
        // остальные разделы закрыты до смены пароля
        const blocked = await authed(port, '/api/screens', olga.cookie);
        assert.equal(blocked.status, 403);
        assert.equal((await blocked.json()).code, 'password-change-required');

        // смена — без текущего пароля (он всё равно транспортный)
        assert.equal((await postJson(port, '/api/me/password', olga.cookie, { newPassword: 'коротко' })).status, 400);
        assert.equal((await postJson(port, '/api/me/password', olga.cookie, { newPassword: 'olga-passphrase' })).status, 200);
        // теперь панель открыта
        assert.equal((await authed(port, '/api/screens', olga.cookie)).status, 200);
        // старый (транспортный) пароль больше не работает, новый — работает
        assert.equal((await login(port, 'olga', cd.password)).status, 401);
        const re = await login(port, 'olga', 'olga-passphrase');
        assert.equal(re.status, 200);
        assert.equal((await (await authed(port, '/api/me', re.cookie)).json()).mustChange, false);

        // список показывает запись, но не её пароль; флаг смены снят
        list = await (await authed(port, '/api/accounts', admin.cookie)).json();
        assert.equal(list.accounts.length, 1);
        assert.ok(!('passwordHash' in list.accounts[0]), 'хэш пароля наружу не отдаём');
        assert.equal(list.accounts[0].mustChange, false);

        // встроенную учётную запись завести нельзя
        assert.equal((await postJson(port, '/api/accounts', admin.cookie, { username: 'admin', password: 'another-passphrase' })).status, 400);
        // короткий пароль (явно заданный админом) — отказ
        assert.equal((await postJson(port, '/api/accounts', admin.cookie, { username: 'petr', password: 'коротко' })).status, 400);
        // чужой пароль не пускает
        assert.equal((await login(port, 'olga', 'неверный-пароль-123')).status, 401);
    } finally {
        child.kill('SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('сброс пароля администратором: новый транспортный пароль, старый и сессии отозваны', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-acct-reset-'));
    const port = portIn(7700, 40);
    const child = start(port, dir);
    try {
        await mustStart(child, port);
        const admin = await login(port, 'admin', ADMIN_PW);
        await postJson(port, '/api/accounts', admin.cookie, { username: 'olga', password: 'olga-passphrase' });
        // владелец входит и задаёт свой пароль
        const first = await login(port, 'olga', 'olga-passphrase');
        await postJson(port, '/api/me/password', first.cookie, { newPassword: 'olga-passphrase2' });
        const own = await login(port, 'olga', 'olga-passphrase2');
        assert.equal((await authed(port, '/api/me', own.cookie)).status, 200);

        // сброс без верного пароля админа — отказ
        assert.equal((await postJson(port, '/api/accounts/reset', admin.cookie, { username: 'olga', password: 'неверный' })).status, 403);
        // сброс с верным паролем — выдаётся новый транспортный пароль
        const reset = await postJson(port, '/api/accounts/reset', admin.cookie, { username: 'olga', password: ADMIN_PW });
        assert.equal(reset.status, 200);
        const rd = await reset.json();
        assert.ok(typeof rd.password === 'string' && rd.password.length >= 10, 'выдан новый пароль');

        // старая сессия владельца отозвана, старый пароль не работает
        assert.equal((await authed(port, '/api/me', own.cookie)).status, 401);
        assert.equal((await login(port, 'olga', 'olga-passphrase2')).status, 401);
        // новый пароль работает и снова требует смены
        const back = await login(port, 'olga', rd.password);
        assert.equal(back.status, 200);
        assert.equal((await (await authed(port, '/api/me', back.cookie)).json()).mustChange, true);
    } finally {
        child.kill('SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('удаление учётной записи завершает её сессии и запрещает вход', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-acct-del-'));
    const port = portIn(7500, 60);
    const child = start(port, dir);
    try {
        await mustStart(child, port);
        const admin = await login(port, 'admin', ADMIN_PW);
        await postJson(port, '/api/accounts', admin.cookie, { username: 'olga', password: 'olga-passphrase' });
        const olga = await login(port, 'olga', 'olga-passphrase');
        assert.equal((await authed(port, '/api/me', olga.cookie)).status, 200);
        const sessBefore = await (await authed(port, '/api/users/sessions', admin.cookie)).json();
        assert.equal(sessBefore.sessions.some(s => s.username === 'olga'), true, 'сессия olga видна администратору');

        // удаляем — подтверждаем паролем администратора
        assert.equal((await postJson(port, '/api/accounts/delete', admin.cookie, { username: 'olga', password: 'неверный' })).status, 403);
        assert.equal((await postJson(port, '/api/accounts/delete', admin.cookie, { username: 'olga', password: ADMIN_PW })).status, 200);

        // вход закрыт, старая сессия отозвана
        assert.equal((await login(port, 'olga', 'olga-passphrase')).status, 401);
        assert.equal((await authed(port, '/api/me', olga.cookie)).status, 401);
    } finally {
        child.kill('SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('себя удалить нельзя: своя учётная запись защищена', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-acct-self-'));
    const port = portIn(7600, 60);
    const child = start(port, dir);
    try {
        await mustStart(child, port);
        const admin = await login(port, 'admin', ADMIN_PW);
        const made = await (await postJson(port, '/api/accounts', admin.cookie, { username: 'olga', password: 'olga-passphrase' })).json();
        const olga = await login(port, 'olga', made.password || 'olga-passphrase');
        // сначала задаём свой пароль (транспортный этого требует)
        assert.equal((await postJson(port, '/api/me/password', olga.cookie, { newPassword: 'olga-own-passphrase' })).status, 200);
        const r = await postJson(port, '/api/accounts/delete', olga.cookie, { username: 'olga', password: 'olga-own-passphrase' });
        assert.equal(r.status, 400, 'удалить себя из своей же сессии нельзя');
    } finally {
        child.kill('SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('смена режима входа из панели включает каталог без правки .env', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-set-mode-'));
    const port = portIn(7800, 60);
    const child = spawn(process.execPath, [path.join(__dirname, 'helpers', 'fake-ipa-server.js')], {
        cwd: ROOT,
        env: {
            ...process.env, PORT: String(port), STORAGE_DIR: dir, NODE_ENV: 'test',
            AUTH_MODE: 'local', ADMIN_PASSWORD: ADMIN_PW, ADMIN_USER: 'admin', SCREENS: 'left',
            FREEIPA_ENABLED: 'false', FREEIPA_FAKE_USERS: JSON.stringify({ alice: 'good-alice' })
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.log = '';
    child.stdout.on('data', d => { child.log += d; });
    child.stderr.on('data', d => { child.log += d; });
    try {
        await mustStart(child, port);
        const admin = await login(port, 'admin', ADMIN_PW);

        // каталог выключен (режим local)
        let d = await (await authed(port, '/api/settings/freeipa', admin.cookie)).json();
        assert.equal(d.mode, 'local');
        assert.equal(d.active, false);

        // включаем вход через каталог из панели (как это сделал бы админ)
        const saved = await postJson(port, '/api/settings/freeipa', admin.cookie, {
            mode: 'both', enabled: true, host: 'ipa.example', baseDn: 'dc=example,dc=com'
        });
        assert.equal(saved.status, 200);
        d = await saved.json();
        assert.equal(d.mode, 'both');
        assert.equal(d.active, true, 'вход через каталог включился без правки .env');

        // вход через каталог теперь работает (fake-каталог пускает alice)
        assert.equal((await login(port, 'alice', 'good-alice')).status, 200);

        // и обратно: вернули local — каталог выключился
        await postJson(port, '/api/settings/freeipa', admin.cookie, { mode: 'local' });
        d = await (await authed(port, '/api/settings/freeipa', admin.cookie)).json();
        assert.equal(d.active, false);
    } finally {
        child.kill('SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('настройки каталога: сохранение, секрет не отдаётся, мусор отклоняется', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-set-'));
    const port = portIn(7700, 60);
    const child = start(port, dir);
    try {
        await mustStart(child, port);
        const admin = await login(port, 'admin', ADMIN_PW);

        let d = await (await authed(port, '/api/settings/freeipa', admin.cookie)).json();
        assert.equal(d.enabled, false);
        assert.equal(d.bindPasswordSet, false);

        // сохраняем подключение к каталогу
        const saved = await postJson(port, '/api/settings/freeipa', admin.cookie, {
            enabled: true, host: 'ipa.example', scheme: 'ldaps', port: '1636',
            baseDn: 'dc=example,dc=com', bindDn: 'uid=svc,cn=users,cn=accounts,dc=example,dc=com', bindPassword: 'svc-secret'
        });
        assert.equal(saved.status, 200);
        d = await saved.json();
        assert.equal(d.host, 'ipa.example');
        assert.equal(d.port, '1636');
        assert.equal(d.bindPasswordSet, true);
        assert.equal(d.bindPasswordFromEnv, false);
        assert.ok(!('bindPassword' in d), 'пароль наружу не отдаём');

        // сохраняется на диск и переживает повторное чтение
        const again = await (await authed(port, '/api/settings/freeipa', admin.cookie)).json();
        assert.equal(again.host, 'ipa.example');
        assert.equal(again.bindPasswordSet, true);

        // неверный хост (со схемой) — понятная ошибка, а не «кирпич»
        const bad = await postJson(port, '/api/settings/freeipa', admin.cookie, { host: 'ldaps://ipa.example' });
        assert.equal(bad.status, 400);

        // сброс к .env
        assert.equal((await postJson(port, '/api/settings/freeipa/reset', admin.cookie, {})).status, 200);
        const reset = await (await authed(port, '/api/settings/freeipa', admin.cookie)).json();
        assert.equal(reset.host, '');
        assert.equal(reset.bindPasswordSet, false);
    } finally {
        child.kill('SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
