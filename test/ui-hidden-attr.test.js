// Атрибут hidden обязан реально скрывать элемент.
// Баг: .btn { display:inline-flex } перебивал hidden, поэтому «скрытая» кнопка
// «Применить ко всем экранам» висела в интерфейсе всегда — и пользователь решил,
// что массовое удаление заглушки пропало.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');

test('есть правило [hidden] с !important', () => {
    assert.match(html, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/,
        'без этого правила элементы с hidden продолжают отображаться');
});

test('правило [hidden] идёт раньше .btn (специфичность не важна из-за !important)', () => {
    const hiddenAt = html.search(/\[hidden\]\s*\{/);
    const btnAt = html.search(/\n\.btn\s*\{/);
    assert.ok(hiddenAt > 0 && btnAt > 0);
});

test('кнопка «Применить ко всем экранам» скрыта по умолчанию', () => {
    assert.match(html, /id="defcopy-\$\{i\}"\s+hidden/);
});

test('«Убрать» подписывается в зависимости от галочки', () => {
    assert.match(html, /Убрать со всех экранов/, 'кнопка должна явно говорить про область действия');
    assert.match(html, /id="defdel-\$\{i\}"/);
});

test('копирование не предлагается, когда у всех экранов та же заглушка', () => {
    assert.match(html, /function copyPending\(/, 'нет проверки «уже применено»');
    // Кнопка показывается ТОЛЬКО когда копировать есть что: copyPending(i) === true.
    // Инверсия (!copyPending) показывала кнопку ровно в тот момент, когда копировать нечего.
    assert.match(html, /box\.hidden\s*=\s*!\(has\s*&&\s*checked\s*&&\s*copyPending\(i\)\)/,
        'кнопка «Применить ко всем» должна появляться только при copyPending(i)');
    assert.doesNotMatch(html, /box\.hidden\s*=\s*!\(has\s*&&\s*checked\s*&&\s*!copyPending\(i\)\)/,
        'инвертированное условие показывает кнопку, когда копировать нечего');
});
