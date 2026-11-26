// Локальные учётные записи админки (accounts.js): реестр, проверка логина/пароля, операции.
// Пароли в файле — только хэши scrypt; здесь проверяем разбор, починку и защиту от мусора.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const accounts = require('../accounts');
const auth = require('../auth');

test('clean/isValid: логин приводится к нижнему регистру, мусор не проходит', () => {
    assert.equal(accounts.clean('  Ivanov  '), 'ivanov');
    assert.equal(accounts.isValid('i.petrov'), true);
    assert.equal(accounts.isValid('a_b-c'), true);
    for (const bad of ['', 'иван', 'a b', 'a@b', 'x'.repeat(65)]) assert.equal(accounts.isValid(bad), false, bad);
});

test('passwordProblem: пустой и короткий пароль отклоняются, длинная фраза проходит', () => {
    assert.match(accounts.passwordProblem(''), /не задан/);
    assert.match(accounts.passwordProblem('коротко'), /минимум 10/);
    assert.equal(accounts.passwordProblem('длинная надёжная фраза'), '');
});

test('normalize: запись без хэша пароля выбрасывается, дубли и мусор — тоже', async () => {
    const h = await auth.hashPassword('secure-passphrase');
    const reg = accounts.normalize({ accounts: [
        { username: 'bob', passwordHash: h },
        { username: 'ALICE', passwordHash: h },
        { username: 'alice', passwordHash: h },          // дубль
        { username: 'carol' },                            // без пароля — войти нельзя
        { username: 'плохой', passwordHash: h },
        null,
    ] });
    assert.deepEqual(reg.accounts.map(a => a.username), ['alice', 'bob']);
    assert.deepEqual(accounts.normalize(null).accounts, []);
    assert.deepEqual(accounts.normalize({ accounts: 'нет' }).accounts, []);
});

test('upsert/remove/has/get: добавление, замена пароля и удаление', async () => {
    const h1 = await auth.hashPassword('first-passphrase');
    const h2 = await auth.hashPassword('second-passphrase');
    let reg = accounts.normalize(null);
    reg = accounts.upsert(reg, { username: 'Ivanov', passwordHash: h1, displayName: 'Иван' });
    assert.equal(accounts.has(reg, 'ivanov'), true);
    assert.equal(accounts.get(reg, 'IVANOV').displayName, 'Иван');
    // замена пароля не создаёт второй записи
    reg = accounts.upsert(reg, { username: 'ivanov', passwordHash: h2 });
    assert.equal(reg.accounts.length, 1);
    reg = accounts.remove(reg, 'ivanov');
    assert.equal(accounts.has(reg, 'ivanov'), false);
});

test('loadRegistry/save: файл с правами 0600, битый JSON -> пустой список', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-'));
    const file = path.join(dir, 'accounts.json');
    assert.deepEqual(accounts.loadRegistry(file).accounts, []);
    const h = await auth.hashPassword('some-passphrase');
    accounts.save(file, accounts.normalize({ accounts: [{ username: 'alice', passwordHash: h }] }));
    assert.deepEqual(accounts.loadRegistry(file).accounts.map(a => a.username), ['alice']);
    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'в файле хэши паролей — права 0600');
    }
    fs.writeFileSync(file, '{ не json');
    assert.deepEqual(accounts.loadRegistry(file).accounts, []);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('записанный хэш действительно проверяет пароль (и не принимает чужой)', async () => {
    const h = await auth.hashPassword('правильный-пароль');
    assert.equal(await auth.verifyPassword('правильный-пароль', h), true);
    assert.equal(await auth.verifyPassword('другой-пароль', h), false);
});

test('genTempPassword: длинный пароль без похожих символов, каждый раз новый', () => {
    const a = accounts.genTempPassword(), b = accounts.genTempPassword();
    assert.ok(a.length >= 16, 'транспортный пароль должен быть длинным: ' + a.length);
    assert.equal(a, a.trim());
    assert.doesNotMatch(a, /[^A-Za-z0-9]/, 'только буквы и цифры — легко продиктовать по телефону');
    for (const ch of '0O1lI') assert.ok(!a.includes(ch), `символа «${ch}» быть не должно (легко перепутать)`);
    assert.notEqual(a, b, 'два подряд пароля не совпадают');
    assert.equal(accounts.genTempPassword(4).length, 4, 'размер задаётся');
});

test('setTempPassword: поднимает флаг mustChange и меняет хэш', async () => {
    const h1 = await auth.hashPassword('transport-passphrase');
    const h2 = await auth.hashPassword('own-passphrase-2');
    let reg = accounts.normalize({ accounts: [{ username: 'ivanov', passwordHash: h1 }] });
    assert.equal(accounts.get(reg, 'ivanov').mustChange, false, 'старая запись не требует смены');
    reg = accounts.setTempPassword(reg, 'ivanov', h2);
    const rec = accounts.get(reg, 'ivanov');
    assert.equal(rec.mustChange, true);
    assert.equal(await auth.verifyPassword('own-passphrase-2', rec.passwordHash), true);
    // неизвестный логин — реестр не меняется
    assert.deepEqual(accounts.setTempPassword(reg, 'нет', h2).accounts.length, 1);
});
