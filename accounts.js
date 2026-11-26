// Локальные учётные записи админки: логин + хэш пароля. Файл — data/accounts.json.
//
// Зачем: заводить администраторов из интерфейса, не трогая .env. У каждой учётной записи
// свой пароль; хранится ТОЛЬКО хэш scrypt (см. auth.js), открытого пароля в файле нет.
// Все заведённые здесь — равноправные администраторы (ролей в проекте нет).
//
// Встроенная учётка ADMIN_USER из .env (ADMIN_PASSWORD_HASH / ADMIN_PASSWORD) остаётся
// аварийным входом и в этот файл не попадает: её нельзя удалить из панели случайно,
// так что «выхода нет» не бывает.
const fs = require('fs');

// Логин: буквы, цифры, точка, дефис, подчёркивание. Регистр храним в нижнем,
// чтобы «Ivanov» и «ivanov» не превращались в две разные записи.
const USER_RE = /^[a-z0-9._-]{1,64}$/;
const MIN_PASSWORD_LEN = 10;

// Транспортный (временный) пароль: его задаёт администратор при создании учётной записи
// или при сбросе. Войти им можно, но до смены на собственный панель закрыта — иначе
// админский пароль, переданный по телефону или в мессенджере, остался бы рабочим навсегда.
// mustChange снимается, когда владелец сам задал новый пароль.
const TEMP_PASSWORD_BYTES = 16;   // 128 бит энтропии; алфавит без похожих символов
const TEMP_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function genTempPassword(bytes = TEMP_PASSWORD_BYTES) {
    const buf = require('crypto').randomBytes(bytes);
    let out = '';
    for (const b of buf) out += TEMP_ALPHABET[b % TEMP_ALPHABET.length];
    return out;
}

const clean = u => String(u == null ? '' : u).trim().toLowerCase();
const clip = (s, n) => (typeof s === 'string' ? s.trim().replace(/[\u0000-\u001f]/g, '').slice(0, n) : '');
const isValid = username => USER_RE.test(clean(username));

// Пароль задаём длиной, а не «сложностью»: длинная фраза надёжнее и её легче запомнить.
// Возвращает текст проблемы или '' — если всё хорошо.
function passwordProblem(pw, min = MIN_PASSWORD_LEN) {
    if (typeof pw !== 'string' || !pw) return 'Пароль не задан';
    if (pw.length < min) return `Пароль слишком короткий: минимум ${min} символов (лучше длинная фраза)`;
    return '';
}

// Разбор и починка реестра: выбрасываем битые и повторяющиеся записи, приводим поля к строке.
function normalize(reg) {
    const seen = new Set();
    const accounts = [];
    const src = reg && Array.isArray(reg.accounts) ? reg.accounts : [];
    for (const a of src) {
        const username = clean(a && a.username);
        if (!USER_RE.test(username) || seen.has(username)) continue;
        const passwordHash = typeof (a && a.passwordHash) === 'string' ? a.passwordHash.trim() : '';
        if (!passwordHash) continue;                 // запись без пароля: войти по ней нельзя — хранить незачем
        seen.add(username);
        accounts.push({
            username,
            displayName: clip(a && a.displayName, 80),
            passwordHash,
            note: clip(a && a.note, 120),
            createdAt: clip(a && a.createdAt, 40),
            createdBy: clip(a && a.createdBy, 64),
            // Старые записи без поля считаем обычными (false) — их владельцы уже сидят
            // со своими паролями, заставлять их менять пароль задним числом не нужно.
            mustChange: !!(a && a.mustChange),
        });
    }
    accounts.sort((x, y) => x.username.localeCompare(y.username));
    return { accounts };
}

function loadRegistry(file) {
    let reg = null;
    try { reg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* нет файла или битый JSON — начнём с пустого */ }
    return normalize(reg);
}

// Запись на диск атомарно (temp + rename). В файле лежат хэши паролей — права 0600.
function save(file, reg) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* необязательно (например, ФС без прав) */ }
}

const has = (reg, username) => reg.accounts.some(a => a.username === clean(username));
const get = (reg, username) => reg.accounts.find(a => a.username === clean(username)) || null;

// Добавить или заменить запись по логину (пароль уже должен быть хэширован вызывающим кодом).
function upsert(reg, rec) {
    const username = clean(rec && rec.username);
    const out = reg.accounts.filter(a => a.username !== username);
    out.push({ ...rec, username });
    return normalize({ accounts: out });
}

function remove(reg, username) {
    const u = clean(username);
    return normalize({ accounts: reg.accounts.filter(a => a.username !== u) });
}

// Выдать учётной записи новый транспортный пароль: кладём хэш и поднимаем флаг mustChange.
function setTempPassword(reg, username, passwordHash) {
    const rec = get(reg, username);
    if (!rec) return reg;
    return upsert(reg, { ...rec, passwordHash, mustChange: true });
}

module.exports = { USER_RE, MIN_PASSWORD_LEN, TEMP_ALPHABET, clean, clip, isValid, passwordProblem, genTempPassword, normalize, loadRegistry, save, has, get, upsert, remove, setTempPassword };
