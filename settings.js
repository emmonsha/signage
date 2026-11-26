// Настройки каталога FreeIPA, заданные из админки. Файл — data/settings.json.
//
// Идея: то, что раньше можно было задать только в .env, админ может поменять в панели.
// Значения отсюда перекрывают переменные окружения (но не затирают их: сброс настроек
// возвращает поведение «как в .env»). Пароль сервисной учётной записи хранится в файле
// (права 0600) и НИКОГДА не отдаётся наружу — только признак «задан/не задан».
const fs = require('fs');

// Какие поля настройки принимаем. Ключ: имя в файле настроек -> переменная окружения.
// Секретов, кроме пароля сервисной учётки, здесь нет.
const FIELDS = {
    mode: 'AUTH_MODE',
    enabled: 'FREEIPA_ENABLED',
    url: 'FREEIPA_URL',
    scheme: 'FREEIPA_SCHEME',
    host: 'FREEIPA_HOST',
    port: 'FREEIPA_PORT',
    baseDn: 'FREEIPA_BASE_DN',
    userBaseDn: 'FREEIPA_USER_BASE_DN',
    bindDn: 'FREEIPA_BIND_DN',
    bindPassword: 'FREEIPA_BIND_PASSWORD',
    userFilter: 'FREEIPA_USER_FILTER',
    startTLS: 'FREEIPA_STARTTLS',
    timeoutMs: 'FREEIPA_TIMEOUT_MS',
    requireGroup: 'FREEIPA_REQUIRE_GROUP',
    tlsRejectUnauthorized: 'FREEIPA_TLS_REJECT_UNAUTHORIZED',
};
const SECRET_FIELDS = new Set(['bindPassword']);

const asBool = v => ['1', 'true', 'yes', 'on'].includes(String(v == null ? '' : v).trim().toLowerCase());
const str = v => (typeof v === 'string' ? v.trim() : v == null || v === '' ? '' : String(v).trim());

// Приводим сохранённые настройки к строковым значениям env. Пустые значения выбрасываем:
// «не задано» = «взять из .env», а не «задать пусто».
function toEnv(settings) {
    const src = settings && typeof settings === 'object' && settings.freeipa && typeof settings.freeipa === 'object'
        ? settings.freeipa : {};
    const env = {};
    for (const [key, envName] of Object.entries(FIELDS)) {
        const raw = src[key];
        if (raw === undefined || raw === null || raw === '') continue;
        env[envName] = typeof raw === 'boolean' ? (raw ? 'true' : 'false') : String(raw).trim();
    }
    return env;
}

// Итоговое окружение для freeipa.loadConfig: настройки из панели перекрывают process.env.
function mergedEnv(settings, base = process.env) {
    return { ...base, ...toEnv(settings) };
}

function load(file) {
    let obj = null;
    try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* нет файла или битый JSON */ }
    if (!obj || typeof obj !== 'object') return { freeipa: {} };
    return { freeipa: obj.freeipa && typeof obj.freeipa === 'object' ? obj.freeipa : {} };
}

function save(file, settings) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* необязательно */ }
}

// Разбор ввода из админки в настройки. Сохраняем только непустые поля.
// Пароль: пустая строка/отсутствие = «не менять» (см. saveFromInput).
function parseInput(input) {
    const out = {};
    if (!input || typeof input !== 'object') return out;
    for (const key of Object.keys(FIELDS)) {
        if (!(key in input)) continue;
        if (SECRET_FIELDS.has(key)) continue;                  // секреты обрабатываем отдельно
        const v = input[key];
        if (v === undefined || v === null || v === '') continue;
        out[key] = typeof v === 'boolean' ? v : str(v);
    }
    return out;
}

// Что показываем админу: текущие значения (секреты — только признаком).
// `source.enabled` и т.п. не раскрываем: показываем, что действует сейчас.
function toPublic(settings, env = {}) {
    const eff = mergedEnv(settings, env);
    const hasEnvSecret = !!(env.FREEIPA_BIND_PASSWORD || env.FREEIPA_BIND_PASSWORD_FILE);
    const stored = settings && settings.freeipa ? settings.freeipa : {};
    const mode = eff.AUTH_MODE || '';
    return {
        mode: ['local', 'freeipa', 'both'].includes(mode) ? mode : '',
        enabled: asBool(eff.FREEIPA_ENABLED),
        url: eff.FREEIPA_URL || '',
        scheme: eff.FREEIPA_SCHEME || '',
        host: eff.FREEIPA_HOST || '',
        port: eff.FREEIPA_PORT || '',
        baseDn: eff.FREEIPA_BASE_DN || '',
        userBaseDn: eff.FREEIPA_USER_BASE_DN || '',
        bindDn: eff.FREEIPA_BIND_DN || '',
        userFilter: eff.FREEIPA_USER_FILTER || '',
        startTLS: asBool(eff.FREEIPA_STARTTLS),
        timeoutMs: eff.FREEIPA_TIMEOUT_MS || '',
        requireGroup: eff.FREEIPA_REQUIRE_GROUP || '',
        tlsRejectUnauthorized: eff.FREEIPA_TLS_REJECT_UNAUTHORIZED === undefined ? true : asBool(eff.FREEIPA_TLS_REJECT_UNAUTHORIZED),
        // Наличие пароля: задан в панели, или пришёл из окружения/файла. Сам пароль не отдаём.
        bindPasswordSet: !!(stored.bindPassword || hasEnvSecret),
        bindPasswordFromEnv: hasEnvSecret,
        overrides: Object.keys(toEnv(settings)).length,
    };
}

module.exports = { FIELDS, SECRET_FIELDS, asBool, toEnv, mergedEnv, load, save, parseInput, toPublic };
