// Клиент автодеплоя: контейнер signage обращается к мини-агенту на хосте (deploy-agent.js).
// Вся конфигурация — переменные окружения (.env); секретов в коде нет.
// Кнопка «Обновить» в админке -> POST /api/deploy -> этот клиент -> агент -> git pull + сборка.
const http = require('http');
const https = require('https');

const bool = v => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase());
const int = (v, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : dflt; };

function envOrFile(env, name, trim = false) {
    const file = env[name + '_FILE'];
    if (file) {
        let v;
        try { v = require('fs').readFileSync(file, 'utf8'); }
        catch (e) { throw new Error(`${name}_FILE: не удалось прочитать ${file} (${e.code || e.message})`); }
        return trim ? v.trim() : v.replace(/\r?\n$/, '');
    }
    const v = env[name];
    return v && trim ? String(v).trim() : v;
}

// Конфигурация деплоя. null — если деплой не включён (DEPLOY_ENABLED не true).
function loadConfig(env = process.env) {
    if (!bool(env.DEPLOY_ENABLED)) return null;
    const token = envOrFile(env, 'DEPLOY_AGENT_TOKEN', true);
    if (!token) throw new Error('DEPLOY_ENABLED=true, но DEPLOY_AGENT_TOKEN не задан (общий с мини-агентом)');
    const url = String(env.DEPLOY_AGENT_URL || 'http://127.0.0.1:9123').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error(`DEPLOY_AGENT_URL: ожидается http(s):// (получено "${url}")`);
    return {
        url: url.replace(/\/+$/, ''),
        token,
        timeout: int(env.DEPLOY_AGENT_TIMEOUT_MS, 20000)
    };
}

function request(urlStr, { method = 'GET', token, body, timeout } = {}, deps = {}) {
    const raw = deps.rawRequest || ((u, opts) => new Promise((resolve, reject) => {
        const mod = u.protocol === 'https:' ? https : http;
        const req = mod.request(u, opts, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
        });
        req.on('timeout', () => req.destroy(new Error('таймаут агента деплоя')));
        req.on('error', reject);
        if (opts.body) req.write(opts.body);
        req.end();
    }));
    const u = new URL(urlStr);
    return raw(u, {
        method, timeout, body,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }
    });
}

// Статус деплоя от агента.
async function status(cfg, deps = {}) {
    const r = await request(`${cfg.url}/status`, { token: cfg.token, timeout: cfg.timeout }, deps);
    if (r.status !== 200) throw new Error(`Агент деплоя: HTTP ${r.status}`);
    try { return JSON.parse(r.body.toString('utf8')); }
    catch { throw new Error('Агент деплоя: ответ не JSON'); }
}

// Запустить деплой. Возвращает { started, message }.
async function trigger(cfg, deps = {}) {
    const r = await request(`${cfg.url}/deploy`, { method: 'POST', token: cfg.token, body: '{}', timeout: cfg.timeout }, deps);
    let data = {};
    try { data = JSON.parse(r.body.toString('utf8')); } catch { /* пустой ответ */ }
    if (r.status === 202) return { started: true };
    if (r.status === 409) return { started: false, message: data.message || 'Деплой уже идёт' };
    throw new Error(data.message || `Агент деплоя: HTTP ${r.status}`);
}

module.exports = { loadConfig, status, trigger };
