// Реестр допущенных учётных записей каталога (users.js) и его влияние на вход через FreeIPA.
// Задача: в каталоге, кроме «наших», есть обычные сотрудники — вход ограничиваем списком,
// который админ ведёт из админки. Пароли в списке не хранятся: только перечень «кому можно».
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const users = require('../users');

test('clean: логин приводится к нижнему регистру и обрезается', () => {
    assert.equal(users.clean('  Ivanov  '), 'ivanov');
    assert.equal(users.clean(null), '');
    assert.equal(users.clean(42), '42');
});

test('isValid: допустимые логины каталога проходят, мусор — нет', () => {
    for (const ok of ['ivanov', 'i.petrov', 'a_b-c', 'user123']) assert.equal(users.isValid(ok), true, ok);
    for (const bad of ['', ' ', 'иван', 'a b', 'a@b', 'x'.repeat(65), '../etc', 'a)(uid=*']) {
        assert.equal(users.isValid(bad), false, bad);
    }
});

test('normalize: выбрасывает битые и повторяющиеся записи, сортирует', () => {
    const reg = users.normalize({ users: [
        { username: 'bob' },
        { username: 'ALICE', displayName: 'Alice' },
        { username: 'alice' },                       // дубль с учётом регистра — отбрасываем
        { username: 'плохой' },                      // недопустимый логин
        { username: '  carol  ' },
        null,
        { username: '' }
    ] });
    assert.deepEqual(reg.users.map(u => u.username), ['alice', 'bob', 'carol']);
    assert.equal(reg.users[0].displayName, 'Alice');
});

test('normalize: допустима пустая структура и мусор вместо неё', () => {
    assert.deepEqual(users.normalize(null).users, []);
    assert.deepEqual(users.normalize({ users: 'нет' }).users, []);
});

test('clip: комментарий не теряет регистр и ограничен по длине', () => {
    assert.equal(users.clip('  Инженер, 3 этаж  ', 120), 'Инженер, 3 этаж');
    assert.equal(users.clip('x'.repeat(200), 10).length, 10);
});

test('loadRegistry/save: запись и чтение из файла, битый файл -> пустой список', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'users-'));
    const file = path.join(dir, 'users.json');
    // файла нет
    assert.deepEqual(users.loadRegistry(file).users, []);
    // записали и прочитали
    users.save(file, { users: [{ username: 'alice', note: 'тест' }] });
    assert.deepEqual(users.loadRegistry(file).users.map(u => u.username), ['alice']);
    // битый JSON не валит сервер
    fs.writeFileSync(file, '{ это не json');
    assert.deepEqual(users.loadRegistry(file).users, []);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('isAllowed: open — пускаем всех, list — только из списка', () => {
    const reg = users.normalize({ users: [{ username: 'alice' }] });
    assert.equal(users.isAllowed(reg, 'alice', 'list'), true);
    assert.equal(users.isAllowed(reg, 'bob', 'list'), false);
    // регистр логина не важен
    assert.equal(users.isAllowed(reg, 'ALICE', 'list'), true);
    // в open список — только справочник
    assert.equal(users.isAllowed(reg, 'bob', 'open'), true);
});

test('parseAccessMode: по умолчанию auto, неверное значение -> null', () => {
    assert.equal(users.parseAccessMode(undefined), 'auto');
    assert.equal(users.parseAccessMode(''), 'auto');
    assert.equal(users.parseAccessMode(' LIST '), 'list');
    assert.equal(users.parseAccessMode('open'), 'open');
    assert.equal(users.parseAccessMode('нет'), null);
});

test('effectiveMode: auto закрывает вход, как только появляется первая запись', () => {
    // пустой список в auto -> пускаем всех (совместимость с прежним поведением)
    assert.equal(users.effectiveMode('auto', 0), 'open');
    // добавили первого -> ограничение включается само, без правки .env
    assert.equal(users.effectiveMode('auto', 1), 'list');
    // явные режимы не зависят от размера списка
    assert.equal(users.effectiveMode('open', 5), 'open');
    assert.equal(users.effectiveMode('list', 0), 'list');
});
