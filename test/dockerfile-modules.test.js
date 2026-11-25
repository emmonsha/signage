// Защита от забытого модуля: все локальные require('./x') в server.js и др. должны
// копироваться в образ. Иначе контейнер падает с MODULE_NOT_FOUND (так и случилось
// с session-store.js при добавлении файлового хранилища сессий).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');

// Какие .js файлы копируются в образ? COPY может переноситься через обратный слэш.
const statements = dockerfile.replace(/\\\n/g, ' ').split('\n');
const copied = new Set();
for (const line of statements) {
    if (!/^COPY\b/.test(line.trim())) continue;
    for (const m of line.matchAll(/([\w.-]+\.js)\b/g)) copied.add(m[1]);
}

test('все локальные модули скопированы в образ', () => {
    const sources = fs.readdirSync(ROOT).filter(f => f.endsWith('.js') && !f.startsWith('.'));
    const missing = [];
    for (const file of sources) {
        const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
        for (const m of src.matchAll(/require\(['"]\.\/([\w.-]+)['"]\)/g)) {
            const dep = m[1].endsWith('.js') ? m[1] : m[1] + '.js';
            if (fs.existsSync(path.join(ROOT, dep)) && !copied.has(dep)) missing.push(`${file} -> ${dep}`);
        }
    }
    assert.deepEqual(missing, [], `не копируются в образ: ${missing.join(', ')}`);
});

test('публичные файлы копируются целиком', () => {
    assert.match(dockerfile, /COPY --chmod=0755 public \.\/public/);
});
