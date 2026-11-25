// Логика «плеер онлайн» в админке (public/admin.html).
// Баг: подсветка активного слайда пропадала и возвращалась после F5.
// Причина: online() прибавлял (Date.now() - statAt) — возраст локального снимка статуса.
// В фоновой вкладке таймеры троттлятся, снимок стареет, и живой плеер ложно считается
// «нет связи». Здесь проверяем формулу как есть, извлекая её из admin.html.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');

// Достаём исходник online() и статус-период, собираем рабочую функцию.
function buildOnline() {
    const m = html.match(/function online\(s\)\s*\{([\s\S]*?)\n\}/);
    assert.ok(m, 'в admin.html не найдена функция online()');
    const poll = html.match(/const STATUS_POLL_MS\s*=\s*(\d+)/);
    assert.ok(poll, 'не найдена константа STATUS_POLL_MS');
    const body = m[1];
    // minimal окружение: sstat, statAt
    const factory = new Function('sstat', 'statAt', 'STATUS_POLL_MS', `return function online(s){${body}\n}`);
    return { online: factory, pollMs: Number(poll[1]) };
}

test('online(): живой плеер при свежем снимке', () => {
    const { online } = buildOnline();
    const sstat = { serverTime: 1_000_000, screens: {} };
    const fn = online(sstat, 1_000_000, 5000);
    assert.equal(fn({ lastSeen: 998_000 }), true);   // сердцебиение 2 с назад
});

test('online(): мёртвый плеер — не онлайн', () => {
    const { online } = buildOnline();
    const sstat = { serverTime: 1_000_000, screens: {} };
    const fn = online(sstat, 1_000_000, 5000);
    assert.equal(fn({ lastSeen: 900_000 }), false);  // 100 с назад
});

// САМ БАГ: вкладка была в фоне, снимок статуса устарел на 40 с,
// но плеер слал heartbeat 2 секунды назад — подсветка обязана остаться.
test('online(): подсветка не пропадает из-за протухшего снимка (фоновая вкладка)', () => {
    const { online } = buildOnline();
    const sstat = { serverTime: 1_000_000, screens: {} };
    const staleNow = 1_000_000 + 40_000;             // снимку 40 с
    const fn = online(sstat, staleNow, 5000);
    assert.equal(fn({ lastSeen: 998_000 }), true,
        'живой плеер ложно считается офлайн — пропадает подсветка активного слайда');
});

test('online(): null/undefined не ломают', () => {
    const { online } = buildOnline();
    const fn = online({ serverTime: 1, screens: {} }, 1, 5000);
    assert.equal(fn(null), false);
    assert.equal(fn(undefined), false);
});

test('есть обновление данных при возврате во вкладку', () => {
    assert.match(html, /visibilitychange/, 'нет реакции на возврат во вкладку');
    assert.match(html, /document\.hidden/, 'нет проверки document.hidden');
});
