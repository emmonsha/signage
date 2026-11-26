// Тесты для помощника выбора порта (helpers/port.js).
// Причина его появления: fetch в Node (undici) отказывается от «запрещённых» портов
// из списка WHATWG и падает с «bad port». Из-за этого тесты редко и загадочно падали.
const test = require('node:test');
const assert = require('node:assert/strict');
const { portIn, isBlocked, BLOCKED } = require('./helpers/port');

test('isBlocked знает порты, на которых fetch падает с «bad port»', () => {
    for (const p of [6000, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 4045]) {
        assert.equal(isBlocked(p), true, `порт ${p} должен считаться запрещённым`);
    }
    for (const p of [3000, 3900, 6664, 6670, 6800]) {
        assert.equal(isBlocked(p), false, `порт ${p} должен быть разрешён`);
    }
});

test('portIn никогда не возвращает запрещённый порт', () => {
    for (let i = 0; i < 5000; i++) {
        const p = portIn(6000, 100);
        assert.ok(p >= 6000 && p < 6100, `порт вне диапазона: ${p}`);
        assert.equal(BLOCKED.has(p), false, `portIn вернул запрещённый порт ${p}`);
    }
});

test('portIn охватывает весь допустимый диапазон и не зацикливается', () => {
    const seen = new Set();
    for (let i = 0; i < 5000; i++) seen.add(portIn(6660, 20));
    // 6660..6679 без 6665-6669, 6679 -> допустимы 6660-6664, 6670-6678
    assert.equal(seen.has(6665), false);
    assert.equal(seen.has(6669), false);
    assert.equal(seen.has(6679), false);
    assert.ok(seen.has(6660) && seen.has(6678), 'допустимые порты должны встречаться');
    assert.ok(seen.size >= 10, `мало разных портов: ${seen.size}`);
});
