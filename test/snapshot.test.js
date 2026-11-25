// Тесты снапшотов: HTTP к DWS подменяется (deps.rawRequest), сеть не нужна.
const test = require('node:test');
const assert = require('node:assert/strict');
const snap = require('../snapshot');

const jsonRes = (obj, status = 200, headers = {}) => ({ status, headers, body: Buffer.from(JSON.stringify(obj)) });
const binRes = (buf, status = 200) => ({ status, headers: {}, body: Buffer.from(buf) });

// cfg по умолчанию из «окружения»
const cfg = env => snap.loadConfig({ ...env });

test('loadConfig: значения по умолчанию', () => {
    const c = cfg({});
    assert.equal(c.scheme, 'http');
    assert.equal(c.port, 80);
    assert.equal(c.user, 'admin');
    assert.equal(c.fullResolution, true);
    assert.equal(c.keep, 20);
});

test('loadConfig: https -> порт 443, ORIGINAL=false -> не полное разрешение', () => {
    const c = cfg({ BRIGHTSIGN_DWS_SCHEME: 'https', BRIGHTSIGN_SNAPSHOT_ORIGINAL: 'false' });
    assert.equal(c.port, 443);
    assert.equal(c.fullResolution, false);
});

test('loadConfig: неверная схема -> ошибка', () => {
    assert.throws(() => cfg({ BRIGHTSIGN_DWS_SCHEME: 'ftp' }), /BRIGHTSIGN_DWS_SCHEME/);
});

test('credentialsFor: общие логин/пароль', () => {
    const c = cfg({ BRIGHTSIGN_DWS_USER: 'admin', BRIGHTSIGN_DWS_PASSWORD: 'pw' });
    assert.deepEqual(snap.credentialsFor(c, 'left', {}), { user: 'admin', password: 'pw' });
});

test('credentialsFor: переопределение для экрана (big_wall -> BIG_WALL)', () => {
    const env = { BRIGHTSIGN_DWS_USER: 'admin', BRIGHTSIGN_DWS_PASSWORD: 'pw', BRIGHTSIGN_DWS_BIG_WALL_PASSWORD: 'special' };
    const c = cfg(env);
    assert.deepEqual(snap.credentialsFor(c, 'big_wall', env), { user: 'admin', password: 'special' });
});

test('credentialsFor: пустой пароль допустим (DWS без аутентификации)', () => {
    const c = cfg({});
    assert.deepEqual(snap.credentialsFor(c, 'left', {}), { user: 'admin', password: '' });
});

test('parseAddress: host, host:port, схема, отброс пути', () => {
    assert.deepEqual(snap.parseAddress('192.168.1.50'), { host: '192.168.1.50' });
    assert.deepEqual(snap.parseAddress('192.168.1.50:8080'), { host: '192.168.1.50', port: 8080 });
    assert.deepEqual(snap.parseAddress('https://player.local:443/api'), { host: 'player.local', port: 443, scheme: 'https' });
    assert.throws(() => snap.parseAddress(''), /Пустой/);
    assert.throws(() => snap.parseAddress('bad host'), /Неверный адрес/);
    assert.throws(() => snap.parseAddress('1.2.3.4:99999'), /порт/);
});

test('buildAuthHeader: Basic', () => {
    const h = snap.buildAuthHeader('Basic realm="x"', { user: 'admin', password: 'pw' }, 'GET', '/');
    assert.equal(h, 'Basic ' + Buffer.from('admin:pw').toString('base64'));
});

test('buildAuthHeader: Digest (RFC 2617, qop=auth) содержит обязательные поля', () => {
    const www = 'Digest realm="BrightSign", nonce="abc123", qop="auth", opaque="zzz"';
    const h = snap.buildAuthHeader(www, { user: 'admin', password: 'pw' }, 'POST', '/api/v1/snapshot');
    assert.match(h, /^Digest /);
    for (const k of ['username="admin"', 'realm="BrightSign"', 'nonce="abc123"', 'uri="/api/v1/snapshot"', 'qop=auth', 'nc=00000001', 'response="']) {
        assert.ok(h.includes(k), `нет поля ${k}: ${h}`);
    }
});

test('buildAuthHeader: неизвестная схема -> null', () => {
    assert.equal(snap.buildAuthHeader('Bearer xyz', { user: 'a', password: 'b' }, 'GET', '/'), null);
});

test('capture: успешный путь (POST snapshot -> GET файла), Basic 401->200', async () => {
    const calls = [];
    const raw = async (url, opts) => {
        calls.push({ url, opts });
        if (url.endsWith('/api/v1/snapshot')) {
            if (!opts.headers.Authorization) return { status: 401, headers: { 'www-authenticate': 'Basic realm="DWS"' }, body: Buffer.alloc(0) };
            return jsonRes({ filename: 'sd/remote_snapshots/img-1.jpg', width: 1920, height: 1080, deviceName: 'player1' });
        }
        if (url.includes('/api/v1/files/')) {
            if (!opts.headers.Authorization) return { status: 401, headers: { 'www-authenticate': 'Basic realm="DWS"' }, body: Buffer.alloc(0) };
            return binRes(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
        }
        throw new Error('неожиданный URL ' + url);
    };
    const shot = await snap.capture(cfg({ BRIGHTSIGN_DWS_PASSWORD: 'pw' }), { host: '1.2.3.4' }, { user: 'admin', password: 'pw' }, { rawRequest: raw });
    assert.equal(shot.width, 1920);
    assert.equal(shot.height, 1080);
    assert.equal(shot.filename, 'sd/remote_snapshots/img-1.jpg');
    assert.equal(shot.buffer.length, 4);
    // запрос файла идёт с ?contents&stream
    assert.ok(calls.some(c => c.url.includes('/api/v1/files/sd/remote_snapshots/img-1.jpg?contents&stream')));
    // тело snapshot-запроса — full resolution
    const snapCall = calls.find(c => c.url.endsWith('/api/v1/snapshot'));
    assert.deepEqual(JSON.parse(snapCall.opts.body), { shouldCaptureFullResolution: true });
});

test('capture: Digest-вызов повторяется с Authorization', async () => {
    const raw = async (url, opts) => {
        if (!(opts.headers || {}).Authorization) return { status: 401, headers: { 'www-authenticate': 'Digest realm="R", nonce="n1", qop="auth"' }, body: Buffer.alloc(0) };
        if (url.endsWith('/api/v1/snapshot')) return jsonRes({ filename: 'sd/remote_snapshots/x.jpg' });
        return binRes(Buffer.from([1, 2, 3]));
    };
    const shot = await snap.capture(cfg({ BRIGHTSIGN_DWS_PASSWORD: 'pw' }), { host: 'h' }, { user: 'admin', password: 'pw' }, { rawRequest: raw });
    assert.equal(shot.filename, 'sd/remote_snapshots/x.jpg');
});

test('capture: HTTP-ошибка snapshot -> исключение', async () => {
    const raw = async () => ({ status: 500, headers: {}, body: Buffer.from('boom') });
    await assert.rejects(() => snap.capture(cfg({ BRIGHTSIGN_DWS_PASSWORD: 'pw' }), { host: 'h' }, { user: 'admin', password: 'pw' }, { rawRequest: raw }), /HTTP 500/);
});

test('capture: нет filename в ответе -> исключение', async () => {
    const raw = async (url) => url.endsWith('/api/v1/snapshot') ? jsonRes({ ok: true }) : binRes(Buffer.from([1]));
    await assert.rejects(() => snap.capture(cfg({ BRIGHTSIGN_DWS_PASSWORD: 'pw' }), { host: 'h' }, { user: 'admin', password: 'pw' }, { rawRequest: raw }), /нет filename/);
});

test('capture: без host -> исключение', async () => {
    await assert.rejects(() => snap.capture(cfg({}), {}, { user: 'a', password: 'b' }, { rawRequest: async () => jsonRes({}) }), /адрес плеера/);
});

test('capture: https и кастомный порт попадают в URL', async () => {
    const urls = [];
    const raw = async (url) => {
        urls.push(url);
        if (url.endsWith('/api/v1/snapshot')) return jsonRes({ filename: 'sd/remote_snapshots/y.jpg' });
        return binRes(Buffer.from([9]));
    };
    await snap.capture(cfg({ BRIGHTSIGN_DWS_SCHEME: 'https' }), { host: 'p.local', port: 8443 }, { user: 'a', password: 'b' }, { rawRequest: raw });
    assert.ok(urls.every(u => u.startsWith('https://p.local:8443/')), JSON.stringify(urls));
});

// ---------- понятные сообщения об ошибках (describeError) ----------
test('describeError: HTTP 401 -> подсказка про .env и пароль DWS', () => {
    const m = snap.describeError(new Error('DWS /snapshot: HTTP 401'), { screen: 'left' });
    assert.match(m, /BRIGHTSIGN_DWS_PASSWORD/);
    assert.match(m, /левый|left/);
    assert.match(m, /HTTP 401/);
});
test('describeError: HTTP 403 -> подсказка про выключенный Local DWS', () => {
    assert.match(snap.describeError(new Error('DWS /snapshot: HTTP 403'), {}), /Local DWS/);
});
test('describeError: HTTP 404 при скачивании -> путь remote_snapshots', () => {
    assert.match(snap.describeError(new Error('DWS файл снапшота: HTTP 404'), {}), /remote_snapshots/);
});
test('describeError: ECONNREFUSED -> проверьте IP и порт', () => {
    const e = new Error('connect ECONNREFUSED 192.168.1.50:80'); e.code = 'ECONNREFUSED';
    assert.match(snap.describeError(e, { screen: 'right' }), /IP и порт/);
});
test('describeError: ENOTFOUND -> имя не разрешается', () => {
    const e = new Error('getaddrinfo ENOTFOUND player.local'); e.code = 'ENOTFOUND';
    assert.match(snap.describeError(e, {}), /не разрешается/);
});
test('describeError: таймаут -> SNAPSHOT_TIMEOUT_MS', () => {
    const e = new Error('таймаут запроса к DWS'); e.code = 'ETIMEDOUT';
    assert.match(snap.describeError(e, {}), /SNAPSHOT_TIMEOUT_MS/);
});
test('describeError: неизвестная ошибка -> общий текст с исходником', () => {
    const m = snap.describeError(new Error('что-то пошло не так'), {});
    assert.match(m, /Не удалось снять кадр/);
    assert.match(m, /что-то пошло не так/);
});
test('describeError: имя экрана (screen) попадает в текст', () => {
    assert.match(snap.describeError(new Error('HTTP 500'), { screen: 'big_wall' }), /big_wall/);
});
