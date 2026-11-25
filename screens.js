// Реестр экранов: id (стабильный, для файлов), name (отображаемое — можно менять), token (секрет для ссылки плеера).
// Хранится в data/screens.json. Токен — единственный «ключ» к плейлисту экрана, поэтому
// ссылка вида /player?token=... не угадывается и не выдаёт имена экранов.
const fs = require('fs');
const crypto = require('crypto');

const ID_RE = /^[a-z0-9_-]+$/i;
const MAX_NAME = 60;

const newToken = () => crypto.randomBytes(16).toString('hex');

// Сравнение токенов без утечки по времени.
function tokenEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; }
}

// Приводит имя к пригодному id: латиница/цифры/дефис, с запасным вариантом.
// Особые случаи:
//  - кириллица и прочие не-латинские буквы транслитерируются (иначе все русские имена
//    давали бы один и тот же id «screen», а «Склад №2» — вообще «2»);
//  - id не может начинаться с цифры/дефиса — к такому добавляем префикс «screen-».
const TRANSLIT = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ѐ: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
    й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u',
    ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
    і: 'i', ї: 'i', є: 'e', ґ: 'g', ў: 'u',
    // украинские/беларусские варианты покрыты выше; прочие не-латинские буквы выпадут в дефис
};

function translit(s) {
    return String(s || '').toLowerCase().replace(/[\u0400-\u04ff]/g, ch => (ch in TRANSLIT ? TRANSLIT[ch] : '-'));
}

function makeId(name) {
    let base = translit(name)
        .replace(/[^a-z0-9_-]+/g, '-')     // всё прочее (пробелы, №, эмодзи) -> дефис
        .replace(/-+/g, '-')
        .replace(/^[-_]+|[-_]+$/g, '')
        .slice(0, 40);
    // id не должен начинаться с цифры — так удобнее и не ломает селекторы/имена файлов
    if (/^\d/.test(base)) base = 'screen-' + base;
    return ID_RE.test(base) && base ? base : 'screen';
}

// Уникальный id среди уже занятых: name, name-2, name-3, …
function uniqueId(base, taken) {
    if (!taken.has(base)) return base;
    for (let i = 2; i < 1000; i++) {
        const cand = `${base}-${i}`;
        if (!taken.has(cand)) return cand;
    }
    return base + '-' + newToken().slice(0, 6);
}

function cleanName(name, fallback) {
    const n = typeof name === 'string' ? name.trim().replace(/[\u0000-\u001f]/g, '').slice(0, MAX_NAME) : '';
    return n || fallback;
}

// Разбор и починка реестра: выбрасываем битые записи, дополняем недостающие поля.
function normalize(reg, seedIds) {
    const seen = new Set();
    const screens = [];
    const src = reg && Array.isArray(reg.screens) ? reg.screens : [];
    for (const s of src) {
        if (!s || typeof s.id !== 'string' || !ID_RE.test(s.id) || seen.has(s.id)) continue;
        seen.add(s.id);
        screens.push({
            id: s.id,
            name: cleanName(s.name, s.id),
            token: typeof s.token === 'string' && s.token.length >= 8 ? s.token : newToken(),
        });
    }
    // экраны из .env (SCREENS), которых ещё нет в реестре, — на случай обновления
    for (const id of seedIds || []) {
        if (ID_RE.test(id) && !seen.has(id)) { seen.add(id); screens.push({ id, name: id, token: newToken() }); }
    }
    return { screens };
}

// Загрузить реестр из файла; если файла нет — создать из seed-списка (первый запуск).
function loadRegistry(file, seedIds) {
    let reg = null;
    try { reg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    return normalize(reg, seedIds);
}

function save(file, reg) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
    fs.renameSync(tmp, file);
}

const byId = (reg, id) => (reg.screens.find(s => s.id === String(id)) || null);
const byToken = (reg, token) => (typeof token === 'string' && token ? (reg.screens.find(s => tokenEqual(s.token, token)) || null) : null);

module.exports = { ID_RE, MAX_NAME, newToken, tokenEqual, makeId, uniqueId, cleanName, normalize, loadRegistry, save, byId, byToken };
