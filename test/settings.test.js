// Настройки каталога FreeIPA из панели (settings.js): перекрытие .env, разбор ввода,
// безопасная выдача наружу (пароль сервисной учётки — только признаком «задан»).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const settings = require('../settings');
const freeipa = require('../freeipa');

const envDefault = {
    FREEIPA_ENABLED: 'true',
    FREEIPA_HOST: 'ipa.env.example',
    FREEIPA_BASE_DN: 'dc=env,dc=example',
    FREEIPA_BIND_DN: 'uid=svc,cn=users,cn=accounts,dc=env,dc=example',
    FREEIPA_BIND_PASSWORD: 'env-secret',
};

test('toEnv: пустые значения не попадают (означают «взять из .env»)', () => {
    const env = settings.toEnv({ freeipa: { host: 'ipa.panel.example', port: '', baseDn: '', startTLS: false } });
    assert.equal(env.FREEIPA_HOST, 'ipa.panel.example');
    assert.equal(env.FREEIPA_STARTTLS, 'false');
    assert.ok(!('FREEIPA_PORT' in env));
    assert.ok(!('FREEIPA_BASE_DN' in env));
});

test('mergedEnv: настройки из панели перекрывают .env, остальное остаётся', () => {
    const merged = settings.mergedEnv({ freeipa: { host: 'ipa.panel.example' } }, envDefault);
    assert.equal(merged.FREEIPA_HOST, 'ipa.panel.example');
    assert.equal(merged.FREEIPA_BASE_DN, 'dc=env,dc=example');       // не тронуто
    // и это действительно рабочая конфигурация для freeipa.loadConfig
    const cfg = freeipa.loadConfig(merged);
    assert.equal(cfg.url, 'ldaps://ipa.panel.example:636');
});

test('настройки из панели собирают URL по частям (нестандартный порт)', () => {
    const merged = settings.mergedEnv({ freeipa: { enabled: true, host: 'ipa.example', scheme: 'ldaps', port: '1636', baseDn: 'dc=x,dc=y' } }, {});
    assert.equal(freeipa.loadConfig(merged).url, 'ldaps://ipa.example:1636');
});

test('parseInput: секреты не проходят как обычные поля, пустые — отбрасываются', () => {
    const out = settings.parseInput({ host: 'h', port: '', bindPassword: 'секрет', baseDn: 'dc=x' });
    assert.equal(out.host, 'h');
    assert.equal(out.baseDn, 'dc=x');
    assert.ok(!('port' in out));
    assert.ok(!('bindPassword' in out), 'пароль обрабатывается отдельно от parseInput');
});

test('toPublic: пароль из .env виден как «задан», сам пароль не отдаётся', () => {
    const pub = settings.toPublic({ freeipa: {} }, envDefault);
    assert.equal(pub.bindPasswordSet, true);
    assert.equal(pub.bindPasswordFromEnv, true);
    assert.ok(!('bindPassword' in pub));
    assert.equal(pub.overrides, 0);
});

test('toPublic: пароль из панели виден как «задан», перекрытия посчитаны', () => {
    const pub = settings.toPublic({ freeipa: { host: 'h', bindPassword: 'panel-secret' } }, {});
    assert.equal(pub.bindPasswordSet, true);
    assert.equal(pub.bindPasswordFromEnv, false);
    assert.equal(pub.host, 'h');
    assert.equal(pub.overrides, 2);
});

test('toEnv/mode: AUTH_MODE тоже задаётся из панели', () => {
    const env = settings.toEnv({ freeipa: { mode: 'both', enabled: true } });
    assert.equal(env.AUTH_MODE, 'both');
    assert.equal(env.FREEIPA_ENABLED, 'true');
    const pub = settings.toPublic({ freeipa: { mode: 'freeipa' } }, {});
    assert.equal(pub.mode, 'freeipa');
    // недопустимый режим не выдаём как действующий
    assert.equal(settings.toPublic({ freeipa: { mode: 'какой-то' } }, {}).mode, '');
});

test('load/save: файл настроек 0600, битый JSON -> пустые настройки', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-'));
    const file = path.join(dir, 'settings.json');
    assert.deepEqual(settings.load(file).freeipa, {});
    settings.save(file, { freeipa: { host: 'h', bindPassword: 'секрет' } });
    assert.equal(settings.load(file).freeipa.host, 'h');
    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'в файле пароль сервисной учётки — права 0600');
    }
    fs.writeFileSync(file, 'не json');
    assert.deepEqual(settings.load(file).freeipa, {});
    fs.rmSync(dir, { recursive: true, force: true });
});
