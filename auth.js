// Хэширование паролей (встроенный crypto.scrypt, без внешних зависимостей) и чтение секретов из env или файла.
const crypto = require('crypto');
const fs = require('fs');

// Параметры по рекомендации OWASP для scrypt (N=2^15, r=8, p=3). Они записываются в сам хэш,
// поэтому позже их можно усилить: старые хэши продолжат проверяться по своим параметрам.
const N = 32768, R = 8, P = 3, KEYLEN = 64, SALT_BYTES = 16;

const scrypt = (pw, salt, n, r, p, len) => new Promise((ok, fail) =>
    crypto.scrypt(pw, salt, len, { N: n, r, p, maxmem: 256 * 1024 * 1024 }, (e, k) => e ? fail(e) : ok(k)));

// Формат: scrypt:N:r:p:соль:хэш (base64url). Нет символа "$", поэтому безопасно для .env и docker compose.
async function hashPassword(pw) {
    const salt = crypto.randomBytes(SALT_BYTES);
    const key = await scrypt(pw, salt, N, R, P, KEYLEN);
    return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join(':');
}

function parseHash(stored) {
    const [alg, n, r, p, s, h] = String(stored).trim().split(':');
    if (alg !== 'scrypt' || !h) return null;
    const out = { n: +n, r: +r, p: +p, salt: Buffer.from(s, 'base64url'), hash: Buffer.from(h, 'base64url') };
    return [out.n, out.r, out.p].every(Number.isInteger) && out.n > 1 && out.salt.length && out.hash.length ? out : null;
}
const isValidHash = stored => !!parseHash(stored);

async function verifyPassword(pw, stored) {
    const h = parseHash(stored);
    if (!h) return false;
    const key = await scrypt(pw, h.salt, h.n, h.r, h.p, h.hash.length);
    return key.length === h.hash.length && crypto.timingSafeEqual(key, h.hash);
}

// NAME_FILE (путь к файлу, например /run/secrets/...) имеет приоритет над NAME
function readEnvOrFile(name, trim = false) {
    const file = process.env[name + '_FILE'];
    if (file) {
        let v;
        try { v = fs.readFileSync(file, 'utf8'); }
        catch (e) { throw new Error(`${name}_FILE: не удалось прочитать ${file} (${e.code || e.message})`); }
        return trim ? v.trim() : v.replace(/\r?\n$/, '');
    }
    const v = process.env[name];
    return v && trim ? v.trim() : v;
}

module.exports = { hashPassword, verifyPassword, isValidHash, readEnvOrFile };
