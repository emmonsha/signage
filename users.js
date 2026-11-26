// Реестр учётных записей FreeIPA, допущенных в админку.
// Хранится в data/users.json. ПАРОЛИ здесь не хранятся: это только список «кому можно
// входить», а пароль по-прежнему проверяется в каталоге (freeipa.js). Так админ
// управляет доступом из интерфейса, не заводя вторых учёток в проекте.
//
// Правила доступа (см. server.js):
//   • список пуст          -> ограничение выключено, пускаем всех из каталога (как раньше);
//   • в списке есть записи -> пускаем только их (режим FREEIPA_ACCESS_MODE=list);
//   • FREEIPA_ACCESS_MODE=open -- список нужен как справочник, ограничение не включается.
// Такое поведение выбрано намеренно: как только админ добавляет первую запись, вход
// «простых» пользователей каталога закрывается сам, без правки конфигурации.
const fs = require('fs');

// Логин в каталоге: буквы, цифры, точка, дефис, подчёркивание. Регистр храним в нижнем,
// чтобы «Ivanov» и «ivanov» не превращались в две разные записи.
const USER_RE = /^[a-z0-9._-]{1,64}$/;
const clean = u => String(u == null ? '' : u).trim().toLowerCase();

const clip = (s, n) => (typeof s === 'string' ? s.trim().replace(/[\u0000-\u001f]/g, '').slice(0, n) : '');

// Разбор и починка реестра: выбрасываем битые и повторяющиеся записи, приводим поля к строке.
function normalize(reg) {
    const seen = new Set();
    const users = [];
    const src = reg && Array.isArray(reg.users) ? reg.users : [];
    for (const u of src) {
        const username = clean(u && u.username);
        if (!USER_RE.test(username) || seen.has(username)) continue;
        seen.add(username);
        users.push({
            username,
            displayName: clip(u && u.displayName, 80),
            note: clip(u && u.note, 120),
            addedAt: clip(u && u.addedAt, 40),
            addedBy: clip(u && u.addedBy, 64),
        });
    }
    users.sort((a, b) => a.username.localeCompare(b.username));
    return { users };
}

function loadRegistry(file) {
    let reg = null;
    try { reg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* нет файла или битый JSON — начнём с пустого */ }
    return normalize(reg);
}

// Запись на диск атомарно (temp + rename): обрыв на середине не оставит полфайла.
function save(file, reg) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
    fs.renameSync(tmp, file);
}

const has = (reg, username) => reg.users.some(u => u.username === clean(username));
const get = (reg, username) => reg.users.find(u => u.username === clean(username)) || null;
const isValid = username => USER_RE.test(clean(username));

// Решение о допуске: в режиме open пускаем всех, в режиме list — только из реестра.
// Чистая функция без ввода-вывода: её и проверяют юнит-тесты.
const isAllowed = (reg, username, mode) => (mode === 'list' ? has(reg, username) : true);

// Разбор FREEIPA_ACCESS_MODE из .env. Возвращает нормализованное значение или null (неверное).
function parseAccessMode(raw) {
    const v = String(raw == null || raw === '' ? 'auto' : raw).trim().toLowerCase();
    return ['auto', 'open', 'list'].includes(v) ? v : null;
}

// Какой режим действует сейчас. auto: список не пуст -> list, пуст -> open
// (чтобы админ, добавив первую запись, сразу закрыл вход остальным — без правки конфигурации).
function effectiveMode(configured, count) {
    const m = parseAccessMode(configured) || 'auto';
    if (m === 'auto') return count > 0 ? 'list' : 'open';
    return m;
}

module.exports = { USER_RE, clean, clip, normalize, loadRegistry, save, has, get, isValid, isAllowed, parseAccessMode, effectiveMode };
