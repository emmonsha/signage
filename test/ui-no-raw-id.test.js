// Защита от «старых артефактов» в текстах админки: пользователю показываем имя экрана
// (screenName), а не внутренний id (left / right / screen-2 / sklad-2).
// Такой баг был в подтверждении «применить ко всем слайдам»: в диалоге всплывало
// «экрана left» вместо «экрана «Левый за охраной»».
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');

// Достаём вызовы, аргументы которых видит пользователь.
// Учитываем вложенные скобки и шаблонные строки верхнего уровня.
function callsOf(name) {
    const out = [];
    let from = 0;
    for (;;) {
        const at = html.indexOf(name + '(', from);
        if (at < 0) break;
        let i = at + name.length + 1, depth = 0, quote = null;
        for (; i < html.length; i++) {
            const c = html[i], prev = html[i - 1];
            if (quote) { if (c === quote && prev !== '\\') quote = null; continue; }
            if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
            if (c === '(') depth++;
            else if (c === ')') {
                if (depth === 0) { out.push(html.slice(at, i + 1)); break; }
                depth--;
            }
        }
        from = i + 1;
    }
    return out;
}

const UI_CALLS = ['confirm', 'toast', 'alert'];

test('в текстах для пользователя нет внутреннего id экрана', () => {
    const bad = [];
    for (const name of UI_CALLS) {
        for (const call of callsOf(name)) {
            // screenName(i) — правильный способ; сырые ${i} или ' + i + ' — баг
            const bare = call
                .replace(/screenName\([^)]*\)/g, 'NAME')   // разрешённое использование
                .replace(/esc\([^)]*\)/g, 'ESC');
            // `${i}` или конкатенация с сырым i: '...' + i , i + '...'
            if (/\$\{\s*i\s*\}/.test(bare) ||
                /\+\s*i\s*(\}|,|\)|\+|$)/m.test(bare) ||
                /(^|[^\w.])i\s*\+/.test(bare)) {
                bad.push(call.replace(/\s+/g, ' ').slice(0, 160));
            }
        }
    }
    assert.deepEqual(bad, [], 'в текстах всплывает внутренний id вместо имени экрана');
});

test('подтверждение «применить ко всем слайдам» показывает имя экрана', () => {
    const call = callsOf('confirm').find(c => c.includes('слайдов'));
    assert.ok(call, 'не найдено подтверждение для смены длительности');
    assert.match(call, /screenName\(/, 'должно использоваться имя экрана');
    assert.doesNotMatch(call, /'экрана '\s*\+\s*i/, 'не должно быть сырого id');
});

test('имена экранов в карточках берутся из screenName', () => {
    // заголовок карточки
    assert.match(html, /id="name-\$\{i\}"[^>]*>\$\{esc\(screenName\(i\)\)\}/);
    // aria-label кнопок переименования и удаления
    assert.match(html, /aria-label="Переименовать экран \$\{esc\(screenName\(i\)\)\}"/);
    assert.match(html, /aria-label="Удалить экран \$\{esc\(screenName\(i\)\)\}"/);
});
