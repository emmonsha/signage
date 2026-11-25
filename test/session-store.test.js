// Тесты файлового хранилища сессий: сессии должны переживать перезапуск сервера.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FileStore } = require('../session-store');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sess-')), 'sessions.json');

// Вызов метода хранилища в виде promise.
const call = (st, method, ...args) => new Promise((res, rej) => st[method](...args, (e, v) => e ? rej(e) : res(v)));

test('set/get: сессия сохраняется и читается', async () => {
    const st = new FileStore(tmpFile());
    await call(st, 'set', 'abc', { cookie: { maxAge: 60000 }, authorized: true });
    const got = await call(st, 'get', 'abc');
    assert.equal(got.authorized, true);
});

test('get: неизвестный sid -> null', async () => {
    const st = new FileStore(tmpFile());
    assert.equal(await call(st, 'get', 'нет'), null);
});

test('переживает перезапуск: новый экземпляр видит сессию', async () => {
    const file = tmpFile();
    const a = new FileStore(file);
    await call(a, 'set', 'sid1', { cookie: { maxAge: 600000 }, authorized: true, user: 'admin' });
    a.flush();                                    // сброс на диск
    const b = new FileStore(file);                // «перезапуск сервера»
    const got = await call(b, 'get', 'sid1');
    assert.equal(got.user, 'admin');
});

test('истёкшая сессия не читается', async () => {
    const file = tmpFile();
    const a = new FileStore(file);
    await call(a, 'set', 'old', { cookie: { expires: new Date(Date.now() - 1000).toISOString() } });
    a.flush();
    const b = new FileStore(file);
    assert.equal(await call(b, 'get', 'old'), null);
});

test('destroy: сессия удаляется', async () => {
    const st = new FileStore(tmpFile());
    await call(st, 'set', 'x', { cookie: { maxAge: 60000 }, authorized: true });
    await call(st, 'destroy', 'x');
    assert.equal(await call(st, 'get', 'x'), null);
});

test('битый файл не валит сервер — старт с пустого списка', () => {
    const file = tmpFile();
    fs.writeFileSync(file, '{это не json');
    const st = new FileStore(file);          // не должно бросить
    assert.equal(st.data.size, 0);
});

test('clear: очищает всё', async () => {
    const st = new FileStore(tmpFile());
    await call(st, 'set', 'a', { cookie: { maxAge: 60000 } });
    await call(st, 'clear');
    assert.equal(await call(st, 'length'), 0);
});

test('length и all', async () => {
    const st = new FileStore(tmpFile());
    await call(st, 'set', 'a', { cookie: { maxAge: 60000 }, authorized: true });
    await call(st, 'set', 'b', { cookie: { maxAge: 60000 }, authorized: true });
    assert.equal(await call(st, 'length'), 2);
    const all = await call(st, 'all');
    assert.deepEqual(Object.keys(all).sort(), ['a', 'b']);
});

test('touch: продлевает срок жизни', async () => {
    const st = new FileStore(tmpFile());
    await call(st, 'set', 't', { cookie: { expires: new Date(Date.now() + 1000).toISOString() } });
    await call(st, 'touch', 't', { cookie: { expires: new Date(Date.now() + 60000).toISOString() } });
    const got = await call(st, 'get', 't');
    assert.ok(got, 'сессия должна остаться после touch');
});

test('запись атомарная: .tmp не остаётся', async () => {
    const file = tmpFile();
    const st = new FileStore(file);
    await call(st, 'set', 'z', { cookie: { maxAge: 60000 } });
    st.flush();
    assert.ok(fs.existsSync(file));
    assert.ok(!fs.existsSync(file + '.tmp'));
});