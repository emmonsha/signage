// Тесты клиента автодеплоя (deploy.js): HTTP к агенту подменяется, сеть не нужна.
const test = require('node:test');
const assert = require('node:assert/strict');
const deploy = require('../deploy');

const jsonRes = (obj, status = 200) => ({ status, body: Buffer.from(JSON.stringify(obj)) });
const cfg = env => deploy.loadConfig({ ...env });

test('loadConfig: выключенный деплой -> null', () => {
    assert.equal(deploy.loadConfig({}), null);
    assert.equal(deploy.loadConfig({ DEPLOY_ENABLED: 'false' }), null);
});

test('loadConfig: включён без токена -> понятная ошибка', () => {
    assert.throws(() => cfg({ DEPLOY_ENABLED: 'true' }), /DEPLOY_AGENT_TOKEN/);
});

test('loadConfig: неверный URL -> ошибка', () => {
    assert.throws(() => cfg({ DEPLOY_ENABLED: 'true', DEPLOY_AGENT_TOKEN: 't', DEPLOY_AGENT_URL: '127.0.0.1:9123' }), /DEPLOY_AGENT_URL/);
});

test('loadConfig: URL по умолчанию и обрезка слэша', () => {
    const c = cfg({ DEPLOY_ENABLED: 'true', DEPLOY_AGENT_TOKEN: 't', DEPLOY_AGENT_URL: 'http://127.0.0.1:9123/' });
    assert.equal(c.url, 'http://127.0.0.1:9123');
});

test('loadConfig: токен читается из _FILE (Docker secrets)', () => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const f = path.join(os.tmpdir(), 'deploy-token-test');
    fs.writeFileSync(f, 'file-token\n');
    const c = cfg({ DEPLOY_ENABLED: 'true', DEPLOY_AGENT_TOKEN_FILE: f });
    assert.equal(c.token, 'file-token');
    fs.unlinkSync(f);
});

test('status: отдаёт JSON агента и шлёт токен', async () => {
    let seen = null;
    const raw = async (u, opts) => { seen = { u: u.toString(), auth: opts.headers.Authorization }; return jsonRes({ ok: true, running: false, from: 'abc' }); };
    const c = cfg({ DEPLOY_ENABLED: 'true', DEPLOY_AGENT_TOKEN: 'tok' });
    const r = await deploy.status(c, { rawRequest: raw });
    assert.equal(r.running, false);
    assert.equal(r.from, 'abc');
    assert.equal(seen.auth, 'Bearer tok');
    assert.ok(seen.u.endsWith('/status'));
});

test('status: не-200 -> исключение', async () => {
    const raw = async () => ({ status: 401, body: Buffer.from('{}') });
    const c = cfg({ DEPLOY_ENABLED: 'true', DEPLOY_AGENT_TOKEN: 'tok' });
    await assert.rejects(() => deploy.status(c, { rawRequest: raw }), /HTTP 401/);
});

test('trigger: 202 -> started', async () => {
    const raw = async (u, opts) => { assert.equal(opts.method, 'POST'); return jsonRes({ ok: true, started: true }, 202); };
    const c = cfg({ DEPLOY_ENABLED: 'true', DEPLOY_AGENT_TOKEN: 'tok' });
    assert.deepEqual(await deploy.trigger(c, { rawRequest: raw }), { started: true });
});

test('trigger: 409 -> уже идёт (не исключение)', async () => {
    const raw = async () => jsonRes({ ok: false, message: 'Деплой уже идёт' }, 409);
    const c = cfg({ DEPLOY_ENABLED: 'true', DEPLOY_AGENT_TOKEN: 'tok' });
    const r = await deploy.trigger(c, { rawRequest: raw });
    assert.equal(r.started, false);
    assert.match(r.message, /уже идёт/);
});

test('trigger: 500 -> исключение с сообщением агента', async () => {
    const raw = async () => jsonRes({ ok: false, message: 'бум' }, 500);
    const c = cfg({ DEPLOY_ENABLED: 'true', DEPLOY_AGENT_TOKEN: 'tok' });
    await assert.rejects(() => deploy.trigger(c, { rawRequest: raw }), /бум/);
});
