// Тесты реестра экранов (имена + токены ссылок плееров). Без сети и без сервера.
const test = require('node:test');
const assert = require('node:assert/strict');
const screens = require('../screens');

test('newToken: 32 hex-символа, каждый раз новый', () => {
    const a = screens.newToken(), b = screens.newToken();
    assert.match(a, /^[0-9a-f]{32}$/);
    assert.notEqual(a, b);
});

test('tokenEqual: совпадение, различия и не-строки', () => {
    assert.equal(screens.tokenEqual('abc', 'abc'), true);
    assert.equal(screens.tokenEqual('abc', 'abd'), false);
    assert.equal(screens.tokenEqual('abc', 'abcd'), false);
    assert.equal(screens.tokenEqual(null, 'abc'), false);
    assert.equal(screens.tokenEqual(undefined, undefined), false);
});

test('makeId: латиница/цифры', () => {
    assert.equal(screens.makeId('Left Screen'), 'left-screen');
    assert.equal(screens.makeId('big_wall'), 'big_wall');
    assert.equal(screens.makeId(''), 'screen');
    assert.match(screens.makeId('a'.repeat(100)), /^a{40}$/);
});

// Кириллица транслитерируется: иначе все русские имена давали один id «screen»,
// а «Склад №2» — вообще «2» (начинать id с цифры нельзя).
test('makeId: кириллица транслитерируется в осмысленный id', () => {
    assert.equal(screens.makeId('Витрина'), 'vitrina');
    assert.equal(screens.makeId('Левый за охраной'), 'levyy-za-ohranoy');
    assert.equal(screens.makeId('Экран у входа'), 'ekran-u-vhoda');
    assert.equal(screens.makeId('Щит'), 'schit');
    assert.equal(screens.makeId('Ёлка'), 'elka');
});

test('makeId: id не начинается с цифры', () => {
    assert.equal(screens.makeId('2 склад'), 'screen-2-sklad');
    assert.match(screens.makeId('№2'), /^screen-/);
});

test('makeId: разные русские имена дают разные id', () => {
    const ids = ['Витрина', 'Склад', 'Офис', 'Стенд'].map(screens.makeId);
    assert.equal(new Set(ids).size, 4, `совпали: ${ids.join(', ')}`);
    ids.forEach(id => assert.match(id, /^[a-z0-9_-]+$/, `плохой id: ${id}`));
});

test('makeId: № и пунктуация не ломают id', () => {
    assert.equal(screens.makeId('Склад №2'), 'sklad-2');
    assert.equal(screens.makeId('Склад №2 (новый)'), 'sklad-2-novyy');
    assert.equal(screens.makeId('!!!'), 'screen');
});

test('uniqueId: добавляет суффикс при конфликте', () => {
    const taken = new Set(['left', 'left-2']);
    assert.equal(screens.uniqueId('left', taken), 'left-3');
    assert.equal(screens.uniqueId('right', taken), 'right');
});

test('cleanName: обрезка, управляющие символы, запасное значение', () => {
    assert.equal(screens.cleanName('  Витрина  ', 'x'), 'Витрина');
    assert.equal(screens.cleanName('a\u0000b', 'x'), 'ab');
    assert.equal(screens.cleanName('', 'fallback'), 'fallback');
    assert.equal(screens.cleanName(null, 'fallback'), 'fallback');
    assert.equal(screens.cleanName('n'.repeat(200), 'x').length, screens.MAX_NAME);
});

test('normalize: чинит битые записи и дополняет токены', () => {
    const reg = screens.normalize({ screens: [
        { id: 'left', name: 'Левый' },                       // нет токена -> сгенерируется
        { id: 'bad id!', name: 'x' },                        // неверный id -> выброшен
        { id: 'left', name: 'дубль' },                       // дубль id -> выброшен
        { name: 'без id' },                                  // нет id -> выброшен
    ] });
    assert.equal(reg.screens.length, 1);
    assert.equal(reg.screens[0].id, 'left');
    assert.equal(reg.screens[0].name, 'Левый');
    assert.match(reg.screens[0].token, /^[0-9a-f]{32}$/);
});

test('normalize: seed-экраны добавляются, если их нет в реестре', () => {
    const reg = screens.normalize({ screens: [{ id: 'left', name: 'Левый', token: 'a'.repeat(32) }] }, ['left', 'right']);
    const ids = reg.screens.map(s => s.id);
    assert.deepEqual(ids, ['left', 'right']);
    assert.match(reg.screens[1].token, /^[0-9a-f]{32}$/);
});

test('normalize: пустой вход -> только seed', () => {
    const reg = screens.normalize(null, ['left', 'right', 'big_wall']);
    assert.deepEqual(reg.screens.map(s => s.id), ['left', 'right', 'big_wall']);
    reg.screens.forEach(s => { assert.equal(s.name, s.id); assert.match(s.token, /^[0-9a-f]{32}$/); });
});

test('byId / byToken: поиск экрана', () => {
    const reg = screens.normalize({ screens: [{ id: 'left', name: 'Л', token: 'a'.repeat(32) }] });
    assert.equal(screens.byId(reg, 'left').name, 'Л');
    assert.equal(screens.byId(reg, 'нет'), null);
    assert.equal(screens.byToken(reg, 'a'.repeat(32)).id, 'left');
    assert.equal(screens.byToken(reg, 'b'.repeat(32)), null);
    assert.equal(screens.byToken(reg, ''), null);
});

test('loadRegistry/save: файл, сохранение и повторная загрузка', () => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scr-'));
    const file = path.join(dir, 'screens.json');
    try {
        const first = screens.loadRegistry(file, ['left', 'right']);      // файла нет -> из seed
        assert.deepEqual(first.screens.map(s => s.id), ['left', 'right']);
        first.screens[0].name = 'Переименован';
        screens.save(file, first);
        const again = screens.loadRegistry(file, []);                     // токены и имена сохранились
        assert.equal(again.screens[0].name, 'Переименован');
        assert.equal(again.screens[0].token, first.screens[0].token);
        assert.equal(again.screens.length, 2);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
