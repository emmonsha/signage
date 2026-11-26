// Панель «Пользователи»: два подраздела — локальные учётные записи и доменные (FreeIPA).
// Разделение важно, чтобы админ не путал «кому нужен пароль» (локальным) и «кто приходит
// по доменной учётке» (пароль не хранится). Здесь — проверки разметки и переключателя.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');

test('в панели «Пользователи» есть две вкладки с корректными ролями', () => {
    assert.match(html, /class="tabs"\s+role="tablist"/, 'нужен список вкладок');
    assert.match(html, /id="tabLocal"[^>]*role="tab"[^>]*aria-controls="paneLocal"/);
    assert.match(html, /id="tabDomain"[^>]*role="tab"[^>]*aria-controls="paneDomain"/);
    assert.match(html, /id="paneLocal"[^>]*role="tabpanel"/);
    assert.match(html, /id="paneDomain"[^>]*role="tabpanel"/);
});

test('по умолчанию активен подраздел «Локальные», доменный скрыт', () => {
    assert.match(html, /id="tabLocal"[^>]*aria-selected="true"/);
    assert.match(html, /id="tabDomain"[^>]*aria-selected="false"/);
    assert.match(html, /id="paneDomain"[^>]*\bhidden\b/, 'доменный подраздел скрыт, пока не выбран');
    // локальный подраздел виден (без hidden)
    assert.doesNotMatch(html, /id="paneLocal"[^>]*\bhidden\b/);
});

test('доменные учётные записи не просят пароль, локальные — просят', () => {
    // форма локальной учётной записи содержит поле пароля
    assert.match(html, /<input type="password" id="acctPass"/);
    // в доменном подразделе нет поля пароля — только логин и комментарий
    const domainPane = html.slice(html.indexOf('id="paneDomain"'), html.indexOf('id="usersCatalogOff"'));
    assert.match(domainPane, /id="accessLogin"/);
    assert.doesNotMatch(domainPane, /type="password"/, 'доменной учётке пароль не задаётся — он в каталоге');
});

test('переключатель подразделов и сохранение выбора', () => {
    assert.match(html, /function switchUsersTab\(/, 'нет функции переключения');
    assert.match(html, /function applyUsersTab\(/, 'нет функции применения состояния');
    assert.match(html, /localStorage\.setItem\('signage-users-tab'/, 'выбор подраздела должен запоминаться');
    assert.match(html, /localStorage\.getItem\('signage-users-tab'/, 'выбор подраздела должен читаться');
});

test('без настроенного каталога вкладка «Доменные» скрывается, есть подсказка', () => {
    assert.match(html, /tabDomain\.hidden\s*=\s*!usersCatalog/, 'без каталога вкладку доменных прячем');
    assert.match(html, /id="usersCatalogOff"/, 'нужна подсказка, где включить каталог');
    assert.match(html, /Настройки/, 'подсказка ссылается на панель настроек');
});

test('старый раздел accessSection удалён, ссылок на него не осталось', () => {
    assert.doesNotMatch(html, /id="accessSection"/, 'старая разметка должна быть удалена');
    assert.doesNotMatch(html, /\$\('accessSection'\)/, 'ссылки на accessSection в JS тоже не нужны');
});
