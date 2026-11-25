#!/usr/bin/env node
// Мини-агент автодеплоя для brightsign-signage.
// Запускается на ХОСТЕ (не в контейнере) как systemd-сервис. Принимает запрос от контейнера
// signage по loopback (127.0.0.1) с токеном и выполняет: git pull + сборку/перезапуск compose.
//
// Почему отдельный агент: контейнер signage работает без доступа к Docker-демону и не должен
// его получать (docker.sock = root на хосте). Агент — узкая дверь: одна фиксированная команда
// из своего окружения, без произвольного ввода от клиента.
//
// Всё настраивается переменными окружения (systemd EnvironmentFile), секретов в коде нет.
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs');

const env = process.env;
const CFG = {
    bind: env.DEPLOY_AGENT_BIND || '127.0.0.1',
    port: parseInt(env.DEPLOY_AGENT_PORT, 10) || 9123,
    token: env.DEPLOY_AGENT_TOKEN || '',
    projectDir: env.DEPLOY_PROJECT_DIR || '',
    branch: env.DEPLOY_BRANCH || 'main',
    remote: env.DEPLOY_GIT_REMOTE || 'origin',
    gitMode: (env.DEPLOY_GIT_MODE || 'ff').toLowerCase(),          // ff | reset
    buildCmd: env.DEPLOY_BUILD_CMD || 'docker compose up -d --build',
    timeoutMs: parseInt(env.DEPLOY_TIMEOUT_MS, 10) || 900000,
    healthCheck: env.DEPLOY_HEALTHCHECK_URL || ''
};

if (!CFG.token) { console.error('DEPLOY_AGENT_TOKEN не задан'); process.exit(1); }
if (!CFG.projectDir || !fs.existsSync(CFG.projectDir)) { console.error(`DEPLOY_PROJECT_DIR не существует: ${CFG.projectDir}`); process.exit(1); }
if (!['ff', 'reset'].includes(CFG.gitMode)) { console.error('DEPLOY_GIT_MODE: допустимы ff | reset'); process.exit(1); }

const MAX_LOG = 64 * 1024;
const state = { running: false, startedAt: null, finishedAt: null, ok: null, step: '', log: '', from: null, to: null, error: null };

// Сравнение токена без утечки времени.
function tokenOk(req) {
    const h = String(req.headers.authorization || '');
    const got = h.startsWith('Bearer ') ? h.slice(7) : String(req.headers['x-deploy-token'] || '');
    const a = Buffer.from(got), b = Buffer.from(CFG.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function append(s) {
    state.log += s;
    if (state.log.length > MAX_LOG) state.log = state.log.slice(-MAX_LOG);
}

// Запуск процесса с таймаутом; вывод пишется в state.log.
function run(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { cwd: opts.cwd || CFG.projectDir, env: process.env });
        let killed = false;
        const timer = setTimeout(() => { killed = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 10000); }, opts.timeout || CFG.timeoutMs);
        const onData = d => append(d.toString());
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('error', e => { clearTimeout(timer); reject(e); });
        child.on('close', code => {
            clearTimeout(timer);
            if (killed) return reject(new Error(`таймаут команды: ${cmd} ${args.join(' ')}`));
            if (code !== 0) return reject(new Error(`команда завершилась с кодом ${code}: ${cmd} ${args.join(' ')}`));
            resolve();
        });
    });
}

// Короткий хэш текущего коммита (или null).
function headCommit() {
    try {
        return require('child_process').execFileSync('git', ['-C', CFG.projectDir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    } catch { return null; }
}

async function deploy() {
    if (state.running) throw new Error('деплой уже идёт');
    state.running = true; state.startedAt = Date.now(); state.finishedAt = null;
    state.ok = null; state.log = ''; state.error = null; state.step = 'git';
    state.from = headCommit();
    try {
        append(`== Деплой ${new Date().toISOString()} ==\nкаталог: ${CFG.projectDir}\nветка: ${CFG.branch}\n`);
        await run('git', ['-C', CFG.projectDir, 'fetch', '--prune', CFG.remote]);
        if (CFG.gitMode === 'reset') {
            await run('git', ['-C', CFG.projectDir, 'reset', '--hard', `${CFG.remote}/${CFG.branch}`]);
        } else {
            await run('git', ['-C', CFG.projectDir, 'checkout', CFG.branch]);
            await run('git', ['-C', CFG.projectDir, 'pull', '--ff-only', CFG.remote, CFG.branch]);
        }
        state.to = headCommit();
        state.step = 'build';
        append(`\n== Сборка: ${CFG.buildCmd} ==\n`);
        const [cmd, ...args] = CFG.buildCmd.split(/\s+/);
        await run(cmd, args);
        if (CFG.healthCheck) {
            state.step = 'health';
            append(`\n== Проверка ${CFG.healthCheck} ==\n`);
            const r = await fetch(CFG.healthCheck).catch(e => ({ ok: false, status: e.message }));
            append(`healthz: ${r.ok ? 'ok' : 'FAIL ' + r.status}\n`);
            if (!r.ok) throw new Error('healthcheck не прошёл');
        }
        state.ok = true; state.step = 'done';
        append(`\n== Готово. ${state.from} -> ${state.to} ==\n`);
    } catch (e) {
        state.ok = false; state.error = e.message; state.step = 'error';
        append(`\n== ОШИБКА: ${e.message} ==\n`);
    } finally {
        state.running = false; state.finishedAt = Date.now();
    }
}

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz') return json(res, 200, { ok: true, running: state.running });
    if (!tokenOk(req)) return json(res, 401, { ok: false, message: 'Неверный токен' });

    if (req.method === 'GET' && url.pathname === '/status') {
        return json(res, 200, {
            ok: true, running: state.running, step: state.step, ok_last: state.ok, error: state.error,
            from: state.from, to: state.to, startedAt: state.startedAt, finishedAt: state.finishedAt,
            branch: CFG.branch, projectDir: CFG.projectDir, log: state.log
        });
    }
    if (req.method === 'POST' && url.pathname === '/deploy') {
        if (state.running) return json(res, 409, { ok: false, message: 'Деплой уже идёт', step: state.step });
        deploy();                                        // фоном, не блокируем ответ
        return json(res, 202, { ok: true, started: true });
    }
    json(res, 404, { ok: false, message: 'Не найдено' });
});

server.listen(CFG.port, CFG.bind, () => {
    console.log(`deploy-agent: http://${CFG.bind}:${CFG.port} · каталог ${CFG.projectDir} · ветка ${CFG.branch}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
