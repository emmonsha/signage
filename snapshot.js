// Снапшот экрана: реальный кадр с плеера BrightSign через Local DWS (Diagnostic Web Server).
// Схема: POST /api/v1/snapshot -> ответ JSON с filename -> GET /api/v1/files/<filename>?contents&stream
// (см. docs/04_SNAPSHOTS.md). Авторизация DWS — Digest (fallback Basic).
//
// Вся конфигурация — переменные окружения (.env); секреты в коде не хранятся.
// Адреса плееров (host/port/scheme) задаются в админке и лежат в data/players.json.
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const bool = v => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase());
const int = (v, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : dflt; };

// Как auth.readEnvOrFile, но по переданному объекту. Поддерживает суффикс _FILE (Docker secrets).
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

// Имя экрана -> фрагмент имени переменной: LEFT, BIG_WALL (не буквы/цифры -> _).
const screenVar = s => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '_');

// Конфигурация снапшотов из окружения.
function loadConfig(env = process.env) {
    const scheme = String(env.BRIGHTSIGN_DWS_SCHEME || 'http').trim().toLowerCase();
    if (!['http', 'https'].includes(scheme)) throw new Error('BRIGHTSIGN_DWS_SCHEME: допустимы http или https');
    return {
        scheme,
        port: int(env.BRIGHTSIGN_DWS_PORT, scheme === 'https' ? 443 : 80),
        user: envOrFile(env, 'BRIGHTSIGN_DWS_USER', true) || 'admin',
        password: envOrFile(env, 'BRIGHTSIGN_DWS_PASSWORD') || '',
        fullResolution: env.BRIGHTSIGN_SNAPSHOT_ORIGINAL === undefined ? true : bool(env.BRIGHTSIGN_SNAPSHOT_ORIGINAL),
        keep: int(env.SNAPSHOT_KEEP, 20),
        timeout: int(env.SNAPSHOT_TIMEOUT_MS, 15000)
    };
}

// Логин/пароль DWS для конкретного экрана: BRIGHTSIGN_DWS_<SCREEN>_USER/_PASSWORD,
// иначе — общие BRIGHTSIGN_DWS_USER/_PASSWORD. Пустой пароль допустим (DWS без аутентификации).
function credentialsFor(cfg, screen, env = process.env) {
    const p = 'BRIGHTSIGN_DWS_' + screenVar(screen) + '_';
    const user = envOrFile(env, p + 'USER', true);
    const pass = envOrFile(env, p + 'PASSWORD');
    return {
        user: user !== undefined && user !== '' ? user : cfg.user,
        password: pass !== undefined ? pass : cfg.password
    };
}

// ---------- HTTP (низкий уровень, инъектируется в тестах) ----------
function rawRequest(urlStr, { method = 'GET', headers = {}, body, timeout } = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(urlStr);
        const mod = u.protocol === 'https:' ? https : http;
        const req = mod.request(u, { method, headers, timeout }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('timeout', () => req.destroy(new Error('таймаут запроса к DWS')));
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

const md5 = s => crypto.createHash('md5').update(s).digest('hex');

// Разбор заголовка WWW-Authenticate: Digest realm="x", nonce="y", qop="auth", ...
function parseChallenge(header) {
    const params = {};
    const re = /([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g;
    let m;
    while ((m = re.exec(header))) params[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
    return params;
}

// Заголовок Authorization для Basic или Digest (RFC 2617, qop=auth, MD5).
function buildAuthHeader(www, creds, method, uri) {
    if (/^Basic\b/i.test(www)) return 'Basic ' + Buffer.from(`${creds.user}:${creds.password}`).toString('base64');
    if (!/^Digest\b/i.test(www)) return null;
    const c = parseChallenge(www);
    if (!c.realm || !c.nonce) return null;
    const qop = (c.qop || '').split(',').map(s => s.trim()).find(q => q === 'auth');
    const nc = '00000001';
    const cnonce = crypto.randomBytes(8).toString('hex');
    const ha1 = md5(`${creds.user}:${c.realm}:${creds.password}`);
    const ha2 = md5(`${method}:${uri}`);
    const response = qop ? md5(`${ha1}:${c.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${c.nonce}:${ha2}`);
    let h = `Digest username="${creds.user}", realm="${c.realm}", nonce="${c.nonce}", uri="${uri}", response="${response}"`;
    if (c.algorithm) h += `, algorithm=${c.algorithm}`;
    if (c.opaque) h += `, opaque="${c.opaque}"`;
    if (qop) h += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
    return h;
}

// Запрос с авторизацией: пробуем без неё, при 401 повторяем с Authorization.
async function authRequest(url, opts, creds, raw) {
    opts = { ...opts, headers: { ...(opts.headers || {}) } };
    let res = await raw(url, opts);
    if (res.status === 401 && creds && creds.user) {
        const www = res.headers && (res.headers['www-authenticate'] || res.headers['WWW-Authenticate']);
        if (www) {
            const u = new URL(url);
            const hdr = buildAuthHeader(String(www), creds, opts.method || 'GET', u.pathname + u.search);
            if (hdr) res = await raw(url, { ...opts, headers: { ...opts.headers, Authorization: hdr } });
        }
    }
    return res;
}

// Снимает кадр с плеера. player: {host, port, scheme}. Возвращает {buffer, filename, width, height, timestamp, deviceName}.
async function capture(cfg, player, creds, deps = {}) {
    const raw = deps.rawRequest || rawRequest;
    const scheme = player.scheme || cfg.scheme;
    const port = player.port || cfg.port;
    if (!player.host) throw new Error('Не задан адрес плеера (host)');
    const base = `${scheme}://${player.host}:${port}`;

    const body = JSON.stringify({ shouldCaptureFullResolution: cfg.fullResolution });
    const snap = await authRequest(`${base}/api/v1/snapshot`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body, timeout: cfg.timeout }, creds, raw);
    if (snap.status !== 200) throw new Error(`DWS /snapshot: HTTP ${snap.status}`);

    let data;
    try { data = JSON.parse(snap.body.toString('utf8')); }
    catch { throw new Error('DWS /snapshot: ответ не JSON'); }
    const filename = data.filename || data.remoteSnapshotFilename;
    if (!filename) throw new Error('DWS /snapshot: в ответе нет filename');

    const path = String(filename).replace(/^\/+/, '');
    const file = await authRequest(`${base}/api/v1/files/${path}?contents&stream`, { method: 'GET', timeout: cfg.timeout }, creds, raw);
    if (file.status !== 200 || !file.body.length) throw new Error(`DWS файл снапшота: HTTP ${file.status}`);

    return { buffer: file.body, filename: path, width: data.width, height: data.height, timestamp: data.timestamp, deviceName: data.deviceName };
}

// Проверяет адрес плеера из админки: host (IP/имя) и необязательные порт/схема.
function parseAddress(input) {
    let s = String(input || '').trim();
    if (!s) throw new Error('Пустой адрес');
    let scheme, port;
    const m = s.match(/^(https?):\/\//i);
    if (m) { scheme = m[1].toLowerCase(); s = s.slice(m[0].length); }
    s = s.replace(/\/.*$/, '');                          // отбрасываем путь
    const hostPort = s.split(':');
    let host = hostPort[0];
    if (hostPort[1]) port = parseInt(hostPort[1], 10);
    if (!host || !/^[a-z0-9._-]+$/i.test(host)) throw new Error(`Неверный адрес плеера: "${input}"`);
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('Неверный порт DWS');
    return { host, ...(port ? { port } : {}), ...(scheme ? { scheme } : {}) };
}

module.exports = { loadConfig, credentialsFor, capture, parseAddress, buildAuthHeader, parseChallenge, rawRequest, bool };
