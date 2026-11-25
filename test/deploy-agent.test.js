// Тесты мини-агента автодеплоя: поднимаем реальный сервер на loopback-порту с фейковыми
// git/build-командами (DEPLOY_BUILD_CMD=echo ...), проверяем авторизацию и жизненный цикл.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const AGENT = path.join(__dirname, '..', 'deploy-agent.js');
const PORT = 9137;
const TOKEN = 'test-token-123';

// Готовит «проект»: bare-репозиторий (origin) + рабочий клон с веткой main.
function makeProject() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-agent-'));
    const origin = path.join(root, 'origin.git');
    const work = path.join(root, 'work');
    const sh = (cwd, cmd) => require('child_process').execFileSync('git', cmd, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    fs.mkdirSync(origin); sh(origin, ['init', '--bare', '-b', 'main']);
    fs.mkdirSync(work); sh(work, ['init', '-b', 'main']);
    fs.writeFileSync(path.join(work, 'f.txt'), 'x');
    sh(work, ['add', '.']); sh(work, ['commit', '-m', 'init']);
    sh(work, ['remote', 'add', 'origin', origin]); sh(work, ['push', '-u', 'origin', 'main']);
    return work;
}

const DIR = makeProject();

function startAgent(extraEnv = {}) {
    return spawn(process.execPath, [AGENT], {
        env: {
            ...process.env,
            DEPLOY_AGENT_BIND: '127.0.0.1',
            DEPLOY_AGENT_PORT: String(PORT),
            DEPLOY_AGENT_TOKEN: TOKEN,
            DEPLOY_PROJECT_DIR: DIR,
            DEPLOY_BUILD_CMD: 'true',                       // мгновенная «сборка»
            DEPLOY_HEALTHCHECK_URL: '',
            ...extraEnv
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
}

async function waitUp(tries = 50) {
    for (let i = 0; i < tries; i++) {
        try { const r = await fetch(`http://127.0.0.1:${PORT}/healthz`); if (r.ok) return; } catch {}
        await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('агент не поднялся');
}

const api = (p, opts = {}) => fetch(`http://127.0.0.1:${PORT}${p}`, opts);

test('агент: healthz без токена, статус с токеном, деплой по фейковой команде', async (t) => {
    const proc = startAgent();
    t.after(() => proc.kill('SIGKILL'));
    await waitUp();

    // healthz — открыт
    assert.equal((await api('/healthz')).status, 200);

    // статус без токена -> 401
    assert.equal((await api('/status')).status, 401);
    // неверный токен -> 401
    assert.equal((await api('/status', { headers: { Authorization: 'Bearer wrong' } })).status, 401);

    // корректный токен -> 200 и структура
    let r = await api('/status', { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(r.status, 200);
    let s = await r.json();
    assert.equal(s.running, false);
    assert.equal(s.branch, 'main');

    // запуск деплоя -> 202
    r = await api('/deploy', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 202);

    // ждём завершения (фейковые команды мгновенны)
    let done = null;
    for (let i = 0; i < 60; i++) {
        s = await (await api('/status', { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
        if (!s.running) { done = s; break; }
        await new Promise(x => setTimeout(x, 150));
    }
    assert.ok(done, 'деплой не завершился');
    assert.equal(done.ok_last, true, JSON.stringify(done));
    assert.equal(done.step, 'done');
    assert.match(done.log, /Деплой/);
    assert.ok(done.from && done.to, `from=${done.from} to=${done.to}`);
});

test('агент: повторный деплой во время работы -> 409', async (t) => {
    const slow = path.join(DIR, 'slow.sh');
    fs.writeFileSync(slow, '#!/bin/sh\nsleep 3\n', { mode: 0o755 });
    const proc = startAgent({ DEPLOY_BUILD_CMD: slow });
    t.after(() => proc.kill('SIGKILL'));
    await waitUp();

    const h = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
    assert.equal((await api('/deploy', { method: 'POST', headers: h, body: '{}' })).status, 202);
    await new Promise(r => setTimeout(r, 400));
    const second = await api('/deploy', { method: 'POST', headers: h, body: '{}' });
    assert.equal(second.status, 409);
});

test('агент: неверная конфигурация -> процесс завершается с ошибкой', async () => {
    const p = spawn(process.execPath, [AGENT], { env: { ...process.env, DEPLOY_AGENT_TOKEN: '', DEPLOY_PROJECT_DIR: DIR }, stdio: ['ignore', 'pipe', 'pipe'] });
    const code = await new Promise(res => p.on('close', res));
    assert.equal(code, 1);
});

test('агент: несуществующий каталог -> ошибка', async () => {
    const p = spawn(process.execPath, [AGENT], { env: { ...process.env, DEPLOY_AGENT_TOKEN: 'x', DEPLOY_PROJECT_DIR: '/nope/nowhere' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const code = await new Promise(res => p.on('close', res));
    assert.equal(code, 1);
});

test('агент: неизвестный путь с токеном -> 404', async (t) => {
    const proc = startAgent();
    t.after(() => proc.kill('SIGKILL'));
    await waitUp();
    const r = await api('/nope', { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(r.status, 404);
});
