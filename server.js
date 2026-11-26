const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const session = require('express-session');
const { FileStore } = require('./session-store');
const { processImage, openPdf, UserError, MAX_PDF_PAGES } = require('./processor');
const video = require('./video');
const auth = require('./auth');
const freeipa = require('./freeipa');
const snapshot = require('./snapshot');
const deploy = require('./deploy');
const screens = require('./screens');
const users = require('./users');
const accounts = require('./accounts');
const settings = require('./settings');
const { buildMatcher } = require('./netguard');

const PORT = process.env.PORT || 3000;

// Все изменяемые данные (плейлисты, картинки, настройки) лежат в STORAGE_DIR — в контейнере это том /storage.
// Определяем здесь, до авторизации: из DATA читаются настройки каталога и локальные учётки.
const STORAGE = process.env.STORAGE_DIR || __dirname;
const DATA = path.join(STORAGE, 'data');
fs.mkdirSync(DATA, { recursive: true });
const SETTINGS_FILE = path.join(DATA, 'settings.json');   // настройки каталога, заданные из панели (перекрывают .env)
const ACCOUNTS_FILE = path.join(DATA, 'accounts.json');   // локальные учётные записи (только хэши паролей)
// ---------- аутентификация админки ----------
// Три источника входа:
//   1) встроенная учётная запись администратора — ADMIN_PASSWORD_HASH (рекомендуется) или ADMIN_PASSWORD;
//   2) каталог FreeIPA по LDAP (см. freeipa.js), включается FREEIPA_ENABLED=true;
//   3) локальные учётные записи, заведённые из панели «Пользователи» (accounts.js, data/accounts.json).
// Режим AUTH_MODE (local | freeipa | both) задаёт, участвуют ли источники 1 и 2; локальные учётки
// из панели работают в любом режиме — их админ заводит осознанно. По умолчанию freeipa, если он включён, иначе local.
const PROD = process.env.NODE_ENV === 'production';
let PASSWORD_HASH, PASSWORD_PLAIN, ADMIN_NETS, ADMIN_USER;
try {
    PASSWORD_HASH = auth.readEnvOrFile('ADMIN_PASSWORD_HASH', true);
    PASSWORD_PLAIN = auth.readEnvOrFile('ADMIN_PASSWORD');
    ADMIN_NETS = buildMatcher(process.env.ADMIN_ALLOWED_NETS);
} catch (e) { console.error(e.message); process.exit(1); }

ADMIN_USER = (process.env.ADMIN_USER || 'admin').trim() || 'admin';

// Действующая конфигурация авторизации. Пересчитывается при старте и при сохранении
// настроек каталога из панели (data/settings.json). Значения из панели перекрывают .env.
let IPA = null, AUTH_MODE = 'local', LOCAL_LOGIN = false, IPA_LOGIN = false;
function applyAuthConfig({ strict = false } = {}) {
    let ipa = null;
    try { ipa = freeipa.loadConfig(settings.mergedEnv(settingsReg)); }
    catch (e) {
        // Настройки из панели могут быть неполными. Если при этом .env даёт рабочую конфигурацию —
        // работаем по .env и предупреждаем, а не роняем сервер (иначе плохой settings.json «кирпичил» бы админку).
        try { ipa = freeipa.loadConfig(process.env); console.warn(`Настройки каталога из панели не применились (${e.message}) — работаю по .env`); }
        catch { if (strict) { console.error(e.message); process.exit(1); } console.warn('FreeIPA недоступен: ' + e.message); ipa = null; }
    }
    IPA = ipa;
    // AUTH_MODE может задаваться и в .env, и в настройках панели (последние приоритетнее):
    // так админ включает вход через каталог, не редактируя файл на сервере.
    const env = settings.mergedEnv(settingsReg);
    const mode = (env.AUTH_MODE || (IPA ? 'freeipa' : 'local')).trim().toLowerCase();
    if (!['local', 'freeipa', 'both'].includes(mode)) {
        if (strict) { console.error('AUTH_MODE: допустимы local | freeipa | both'); process.exit(1); }
        console.warn(`AUTH_MODE «${mode}» недопустим — использую local`);
    }
    AUTH_MODE = ['local', 'freeipa', 'both'].includes(mode) ? mode : 'local';
    LOCAL_LOGIN = AUTH_MODE === 'local' || AUTH_MODE === 'both';
    // Каталог включён, но не настроен: на старте это ошибка, во время работы — просто выключаем вход через каталог.
    if ((AUTH_MODE === 'freeipa' || AUTH_MODE === 'both') && !IPA) {
        const msg = 'AUTH_MODE=' + AUTH_MODE + ', но FreeIPA не настроен: задайте FREEIPA_ENABLED=true и параметры FREEIPA_* (см. .env.example)';
        if (strict) { console.error(msg); process.exit(1); }
        console.warn(msg + ' — вход через каталог выключен до исправления настроек');
    }
    IPA_LOGIN = (AUTH_MODE === 'freeipa' || AUTH_MODE === 'both') && !!IPA;
}

// Кто может входить через каталог. В каталоге FreeIPA, кроме «наших», обычно есть и
// обычные сотрудники — поэтому вход ограничиваем списком допущенных (data/users.json).
// Режим: auto — список не пуст => только он; пуст => пускаем всех из каталога (как раньше).
// Значение можно зафиксировать явно: open (всегда все) или list (только список).
const ACCESS_MODE = users.parseAccessMode(process.env.FREEIPA_ACCESS_MODE);
if (ACCESS_MODE === null) {
    console.error('FREEIPA_ACCESS_MODE: допустимы auto | open | list');
    process.exit(1);
}

if (PASSWORD_HASH && !auth.isValidHash(PASSWORD_HASH)) {
    console.error('ADMIN_PASSWORD_HASH имеет неверный формат. Создайте новый: npm run hash-password');
    process.exit(1);
}

// Реестры, читаемые из DATA: настройки каталога и локальные учётки. Затем — расчёт действующей
// конфигурации авторизации (она зависит от LOCAL_LOGIN, поэтому до проверок пароля ниже).
let settingsReg = settings.load(SETTINGS_FILE);
let accountsReg = accounts.loadRegistry(ACCOUNTS_FILE);
if (!fs.existsSync(ACCOUNTS_FILE)) accounts.save(ACCOUNTS_FILE, accountsReg);   // завести файл сразу
function reloadAccounts() { accountsReg = accounts.loadRegistry(ACCOUNTS_FILE); }
function reloadSettings() { settingsReg = settings.load(SETTINGS_FILE); applyAuthConfig(); }
applyAuthConfig({ strict: true });

// Локальный пароль нужен только если он реально участвует в проверке.
if (LOCAL_LOGIN && !PASSWORD_HASH && !PASSWORD_PLAIN) {
    if (PROD) { console.error('Задайте ADMIN_PASSWORD_HASH (рекомендуется) или ADMIN_PASSWORD (см. .env.example)'); process.exit(1); }
    PASSWORD_PLAIN = 'change-me';
}
if (LOCAL_LOGIN && PROD && PASSWORD_PLAIN === 'change-me' && !PASSWORD_HASH) { console.error('Задайте настоящий пароль админки'); process.exit(1); }

const sha = s => crypto.createHash('sha256').update(String(s)).digest();
async function checkLocalPassword(input) {
    if (typeof input !== 'string') return false;                   // в JSON может прийти число/объект
    if (PASSWORD_HASH) return auth.verifyPassword(input, PASSWORD_HASH);
    return crypto.timingSafeEqual(sha(input), sha(PASSWORD_PLAIN));
}
// Первичный список экранов — только для первого запуска; дальше имена и токены живут в реестре
// data/screens.json (см. screens.js). Имена можно менять из админки, ссылки плееров — по токену.
const SEED_SCREENS = (process.env.SCREENS || 'left,right,big_wall').split(',').map(s => s.trim()).filter(s => /^[a-z0-9_-]+$/i.test(s));
const KEEP_MS = 9 * 30 * 24 * 3600 * 1000;                        // хранить 9 месяцев после окончания показа

// Секрет подписи cookie сессии. Задайте SESSION_SECRET для нескольких копий сервера за
// балансировщиком; иначе он хранится в файле на томе и переживает перезапуск контейнера
// (новый секрет при каждом старте обесценивал бы все сессии — это и выкидывало на логин).
function loadSecret() {
    if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
    const f = process.env.SESSION_SECRET_FILE || path.join(DATA, '.session-secret');
    try {
        const v = fs.readFileSync(f, 'utf8').trim();
        if (v) return v;
    } catch { /* файла ещё нет — создадим ниже */ }
    const v = crypto.randomBytes(32).toString('hex');
    try {
        fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
        fs.writeFileSync(f, v, { mode: 0o600 });
    } catch (e) { console.warn(`Не удалось сохранить SESSION_SECRET (${e.code || e.message}) — сессии не переживут рестарт`); }
    return v;
}
const SECRET = loadSecret();
const UPLOADS = path.join(STORAGE, 'uploads');
const PUBLIC = path.join(__dirname, 'public');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(UPLOADS, { recursive: true });

// ---------- реестр экранов (имена и токены ссылок плееров) ----------
// id — стабильный (для файлов), name — отображаемое (можно менять), token — секрет ссылки плеера.
const SCREENS_FILE = path.join(DATA, 'screens.json');
let registry = screens.loadRegistry(SCREENS_FILE, SEED_SCREENS);
fs.writeFileSync(SCREENS_FILE + '.tmp', JSON.stringify(registry, null, 2));
fs.renameSync(SCREENS_FILE + '.tmp', SCREENS_FILE);          // зафиксировать токены при первом запуске
let SCREENS = registry.screens.map(s => s.id);              // список id (плейлисты, файлы)
const screenById = id => screens.byId(registry, id);
const screenByToken = t => screens.byToken(registry, t);
const validScreen = v => registry.screens.some(s => s.id === String(v));
const playerUrl = token => `/player?token=${token}`;
const publicScreen = s => ({ id: s.id, name: s.name, token: s.token, url: playerUrl(s.token) });
function reloadRegistry() {
    registry = screens.loadRegistry(SCREENS_FILE, []);
    SCREENS = registry.screens.map(s => s.id);
}

// ---------- список допущенных к админке (для входа через каталог) ----------
// Пароли здесь не хранятся: это только перечень «кому можно», а пароль по-прежнему
// проверяется в каталоге (freeipa.js). См. users.js.
const USERS_FILE = path.join(DATA, 'users.json');
let usersReg = users.loadRegistry(USERS_FILE);
if (!fs.existsSync(USERS_FILE)) users.save(USERS_FILE, usersReg);   // завести файл сразу, чтобы админ видел, где он лежит
// Режим с учётом реестра: в auto ограничение включается само, как только список не пуст.
const accessMode = () => users.effectiveMode(ACCESS_MODE, usersReg.users.length);
function reloadUsers() { usersReg = users.loadRegistry(USERS_FILE); }

// ---------- снапшоты экранов (реальный кадр с плеера) ----------
// Адреса плееров (экран -> host/port/scheme) лежат рядом с данными: data/players.json
// Кадры хранятся в STORAGE/snapshots/<screen>/, хранится последние SNAPSHOT_KEEP штук.
let SNAP;
try { SNAP = snapshot.loadConfig(); }
catch (e) { console.error(e.message); process.exit(1); }

// ---------- автодеплой (кнопка «Обновить» -> мини-агент на хосте) ----------
let DEPLOY;
try { DEPLOY = deploy.loadConfig(); }
catch (e) { console.error(e.message); process.exit(1); }
const PLAYERS_FILE = path.join(DATA, 'players.json');
const SNAPSHOT_DIR = path.join(STORAGE, 'snapshots');
fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
function readPlayers() {
    try { return JSON.parse(fs.readFileSync(PLAYERS_FILE, 'utf8')); }
    catch { return {}; }
}
function writePlayers(o) {
    const tmp = PLAYERS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(o, null, 2));
    fs.renameSync(tmp, PLAYERS_FILE);
}
const screenSnapDir = n => path.join(SNAPSHOT_DIR, n);
// Список файлов снапшотов экрана, от новых к старым.
function listSnapshots(n) {
    try {
        return fs.readdirSync(screenSnapDir(n)).filter(f => /\.(jpe?g|png)$/i.test(f)).sort().reverse();
    } catch { return []; }
}
// Оставляет последние SNAP.keep кадров экрана, остальные удаляет.
function pruneSnapshots(n) {
    const files = listSnapshots(n);
    files.slice(SNAP.keep).forEach(f => fs.unlink(path.join(screenSnapDir(n), f), () => {}));
}

// ---------- хранилище плейлистов ----------
const jsonFile = n => path.join(DATA, `playlist_${n}.json`);
function readPlaylist(n) {
    try { return JSON.parse(fs.readFileSync(jsonFile(n), 'utf8')); }
    catch { return { playlist: [] }; }
}
function writePlaylist(n, data) {
    const tmp = jsonFile(n) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, jsonFile(n));                              // атомарная запись
}

// миграция со старых имён: playlist_1/2/3.json -> первые три экрана
['1', '2', '3'].forEach((old, i) => {
    const f = path.join(DATA, `playlist_${old}.json`);
    if (SCREENS[i] && fs.existsSync(f) && !fs.existsSync(jsonFile(SCREENS[i]))) fs.renameSync(f, jsonFile(SCREENS[i]));
});

function removeFileIfUnused(url) {
    const used = SCREENS.some(n => {
        const d = readPlaylist(n);
        return d.default_image === url || d.playlist.some(s => s.url === url);
    });
    if (used) return;
    const p = path.join(UPLOADS, path.basename(url));
    fs.unlink(p, () => {});
}

function autoClean() {
    const limit = Date.now() - KEEP_MS;
    for (const n of SCREENS) {
        const data = readPlaylist(n);
        const keep = data.playlist.filter(s => Date.parse(s.end_date) > limit);
        const dropped = data.playlist.filter(s => !keep.includes(s));
        if (dropped.length) {
            data.playlist = keep;
            writePlaylist(n, data);
            dropped.forEach(s => removeFileIfUnused(s.url));
        }
    }
}
autoClean();
setInterval(autoClean, 24 * 3600 * 1000);

// ---------- загрузка файлов ----------
// Сырые файлы падают во временную папку, затем обрабатываются (processor.js) и сохраняются в uploads/
const MAX_VIDEO_MB = parseInt(process.env.MAX_VIDEO_MB) || 2048;
const isVideoFile = f => /^video\//.test(f.mimetype || '') || video.VIDEO_EXTS.test(f.originalname || '');
const TMP = path.join(DATA, 'tmp');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const upload = multer({
    storage: multer.diskStorage({ destination: TMP, filename: (req, file, cb) => cb(null, crypto.randomUUID()) }),
    fileFilter: (req, file, cb) => cb(null, ['image/png', 'image/jpeg', 'application/pdf'].includes(file.mimetype) || isVideoFile(file)),
    limits: { fileSize: MAX_VIDEO_MB * 1024 * 1024 }          // верхняя граница (видео); для картинок и PDF ниже своя проверка
});
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
const cleanName = n => Buffer.from(String(n || ''), 'latin1').toString('utf8').replace(/[\u0000-\u001f]/g, '').slice(0, 80);
const parseFit = v => ['fit', 'crop', 'reject'].includes(v) ? v : 'fit';

// ---------- видео: очередь конвертации (по одному ролику, чтобы не перегружать процессор) ----------
const jobs = new Map();            // id слайда -> задача
const jobQueue = [];
let jobBusy = false, VIDEO_OK = false;
video.available().then(ok => {
    VIDEO_OK = ok;
    console.log(ok ? 'ffmpeg найден: загрузка видео включена' : '⚠ ffmpeg/ffprobe не найдены: загрузка видео отключена');
});

const rm = p => fs.unlink(p, () => {});
function moveFile(src, dst) {
    try { fs.renameSync(src, dst); }
    catch (e) { if (e.code !== 'EXDEV') throw e; fs.copyFileSync(src, dst); fs.unlinkSync(src); }
}
function updateSlide(screen, id, fn) {                  // чтение-изменение-запись без пауз, поэтому гонок нет
    const d = readPlaylist(screen);
    const s = d.playlist.find(x => x.id === id);
    if (!s) return null;
    fn(s); writePlaylist(screen, d);
    return s;
}
function enqueueJob(job) { jobs.set(job.id, job); jobQueue.push(job); pumpJobs(); }
async function pumpJobs() {
    if (jobBusy) return;
    const job = jobQueue.shift();
    if (!job) return;
    jobBusy = true;
    try { await runJob(job); } catch (e) { console.error('Ошибка задачи:', e); }
    jobBusy = false; jobs.delete(job.id);
    pumpJobs();
}
async function runJob(job) {
    try {
        if (!job.cancelled) {
            job.runner = video.transcode(job.args, job.info.duration, p => { job.progress = p; });
            await job.runner.promise;
            if (!job.cancelled) {
                moveFile(job.outTmp, job.outFinal);
                const s = updateSlide(job.screen, job.id, x => { x.status = 'ready'; delete x.error; });
                if (!s) rm(job.outFinal);               // слайд удалили, пока шла конвертация
            }
        }
    } catch (err) {
        if (!job.cancelled) {
            console.error(`Конвертация ${job.id} не удалась: ${err.message}`);
            updateSlide(job.screen, job.id, x => { x.status = 'failed'; x.error = String(err.message).slice(0, 200); });
        }
    } finally { rm(job.input); rm(job.outTmp); }
}
function cancelJob(id) {                                // слайд удалили: останавливаем конвертацию
    const job = jobs.get(id);
    if (!job) return;
    job.cancelled = true;
    const qi = jobQueue.indexOf(job);
    if (qi >= 0) { jobQueue.splice(qi, 1); jobs.delete(id); rm(job.input); rm(job.outTmp); }   // ещё не начиналась
    else if (job.runner) job.runner.kill();
}
// прогресс для админки подмешивается в ответ плейлиста
const withProgress = d => ({ ...d, playlist: d.playlist.map(s => {
    if (s.status !== 'processing') return s;
    const j = jobs.get(s.id);
    return { ...s, progress: j ? Math.round(j.progress) : 0, queued: !!(j && !j.runner) };
}) });
// после перезапуска сервера недоделанные конвертации потеряны (временные файлы очищены)
SCREENS.forEach(n => {
    const d = readPlaylist(n);
    let changed = false;
    d.playlist.forEach(s => {
        if (s.status === 'processing') { s.status = 'failed'; s.error = 'Конвертация прервана перезапуском сервера — загрузите файл заново'; changed = true; }
    });
    if (changed) writePlaylist(n, d);
});

// ---------- приложение ----------
const app = express();

// За обратным прокси (nginx/Caddy/Traefik): TRUST_PROXY=1 (число прокси-узлов) — тогда видны реальный IP и https
const tp = process.env.TRUST_PROXY;
if (tp) app.set('trust proxy', /^\d+$/.test(tp) ? Number(tp) : tp === 'true' ? 1 : tp);

// Проверка живости для Docker/мониторинга: хранилище должно быть доступно на запись
app.get('/healthz', (req, res) => {
    try { fs.accessSync(DATA, fs.constants.W_OK); fs.accessSync(UPLOADS, fs.constants.W_OK); res.json({ ok: true }); }
    catch { res.status(503).json({ ok: false }); }
});

// Ограничение по сетям (ADMIN_ALLOWED_NETS): открыто только то, что нужно плеерам.
// Всё остальное (админка, загрузка, удаление, статус) — только из разрешённых сетей.
const PLAYER_PATHS = [/^\/player\/?$/, /^\/api\/playlist\/[^/]+$/, /^\/uploads\//, /^\/api\/heartbeat$/, /^\/healthz$/];
const blockedSeen = new Set();
app.use((req, res, next) => {
    if (!ADMIN_NETS || PLAYER_PATHS.some(r => r.test(req.path)) || ADMIN_NETS(req.ip)) return next();
    if (!blockedSeen.has(req.ip)) { blockedSeen.add(req.ip); console.warn(`403: ${req.ip} вне ADMIN_ALLOWED_NETS (${req.method} ${req.path})`); }
    res.status(403).send('Доступ запрещён: админка доступна только из разрешённых сетей');
});
app.use(express.json());
// Сессии — в файле на томе STORAGE_DIR: переживают перезапуск и пересборку контейнера.
// Раньше был MemoryStore: любой деплой/рестарт выкидывал всех из админки на страницу входа.
const SESSION_FILE = process.env.SESSION_FILE || path.join(DATA, 'sessions.json');
const sessionStore = new FileStore(SESSION_FILE);
// docker stop/перезапуск шлёт SIGTERM: успеваем записать сессии на диск, чтобы
// никто не вылетел на страницу входа после штатного обновления контейнера.
for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => { try { sessionStore.dirty = true; sessionStore.flush(); } catch {} process.exit(0); });
}
app.use(session({
    store: sessionStore,
    secret: SECRET, resave: false, saveUninitialized: false,
    // COOKIE_SECURE=true — только если админка открыта по https (через прокси с TRUST_PROXY)
    cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true', maxAge: 12 * 3600 * 1000 }
}));
app.use('/uploads', express.static(UPLOADS, { maxAge: '7d', immutable: true }));

const checkAuth = (req, res, next) => {
    if (sessionValid(req)) {
        // Транспортный пароль — вход только чтобы задать свой. Всё остальное закрыто,
        // пока mustChange не снят сменой пароля (см. /api/me/password).
        if (req.session.mustChange && !PATH_ALLOWED_WHILE_CHANGE.has(req.path)) {
            return res.status(403).json({ success: false, code: 'password-change-required', message: 'Сначала смените пароль, выданный администратором' });
        }
        return next();
    }
    // Сессия была, но перестала быть действительной (сменился пароль или админ убрал доступ) —
    // затираем её сразу, а не оставляем висеть в файле сессий.
    if (req.session && req.session.authorized) req.session.destroy(() => {});
    return res.status(401).json({ success: false, message: 'Нужна авторизация' });
};

// «Отпечаток» локальной учётной записи админки: меняется вместе с паролем. Сессия, выданная
// при старом пароле, перестаёт действовать сразу. Без этого смена пароля (например, при утечке)
// не выбросила бы уже вошедшего злоумышленника: сессии живут в файле на томе и переживают
// перезапуск — это было сделано специально, чтобы деплой не выкидывал людей на страницу входа.
const sessionCred = () => crypto.createHash('sha256')
    .update('signage-session-cred:' + (PASSWORD_HASH || PASSWORD_PLAIN || '')).digest('hex').slice(0, 24);
// Отпечаток для конкретной сессии. Локальная учётная запись из панели привязана к своему хэшу
// пароля: смена (или удаление) учётки сразу отзывает её сессии. Остальные — к отпечатку админки.
function credFor(user) {
    const u = user || {};
    if (u.via === 'account') {
        const rec = accounts.get(accountsReg, u.username);
        const base = 'signage-account-cred:' + (rec ? rec.passwordHash : 'removed') + ':' + (rec && rec.mustChange ? 'temp' : 'own');
        return crypto.createHash('sha256').update(base).digest('hex').slice(0, 24);
    }
    return sessionCred();
}

// Действительна ли сессия прямо сейчас. Кроме факта входа проверяем две вещи:
//   1) не сменился ли пароль админки (отпечаток сессии не совпадает с текущим);
//   2) для входа через каталог — не убран ли человек из списка допущенных.
// Второе важно, потому что убрать доступ из админки можно в любой момент, а сессия
// у него уже открыта: без проверки он продолжил бы работать до истечения cookie.
// Работает и с объектом сессии запроса, и с записью из хранилища (панель «Пользователи»).
function sessionValidFor(s) {
    if (!s || !s.authorized) return false;
    const u = s.user || {};
    if (s.cred !== credFor(u)) return false;
    if (u.via === 'freeipa' && !users.isAllowed(usersReg, u.username, accessMode())) return false;
    // Локальную учётную запись убрали из панели — её сессия сразу перестаёт действовать.
    if (u.via === 'account' && !accounts.has(accountsReg, u.username)) return false;
    return true;
}
const sessionValid = req => sessionValidFor(req.session);

// Простое ограничение попыток входа: отдельно по IP и по паре IP+логин (защита от перебора паролей).
const fails = new Map();
const FAIL_LIMIT = 5, FAIL_WINDOW = 15 * 60 * 1000;
const failKey = (req, user) => `${req.ip}|${String(user || '').toLowerCase()}`;
function throttled(key) {
    const rec = fails.get(key) || { n: 0, until: 0 };
    return Date.now() < rec.until ? rec : null;
}
function bumpFail(key) {
    const rec = fails.get(key) || { n: 0, until: 0 };
    rec.n++;
    if (rec.n >= FAIL_LIMIT) { rec.n = 0; rec.until = Date.now() + FAIL_WINDOW; }
    fails.set(key, rec);
}

// Проверка пароля локальной учётной записи из панели (accounts.js). Пароль здесь никогда
// не равен встроенному ADMIN_USER — он проверяется отдельно, в checkCredentials.
async function checkAccountPassword(username, password) {
    const rec = accounts.get(accountsReg, username);
    if (!rec || typeof password !== 'string' || !password) return null;
    try { return (await auth.verifyPassword(password, rec.passwordHash)) ? rec : null; }
    catch (e) { console.error('Ошибка проверки пароля учётной записи:', e.message); return null; }
}

// Пока учётная запись работает на транспортном пароле (его задал админ), сессия
// ограничена сменой пароля: до неё ни экраны, ни остальные панели недоступны.
// Так переданный по телефону/в мессенджере пароль не остаётся рабочим навсегда.
const PATH_ALLOWED_WHILE_CHANGE = new Set(['/api/me', '/api/me/password', '/api/logout']);

// Проверяет логин/пароль по выбранному источнику. Возвращает { ok, user?, reason? }.
// Порядок: локальные учётки из панели (они заведены осознанно и пароль у них свой), затем каталог,
// затем встроенная аварийная учётка ADMIN_USER. Сетевые/серверные ошибки FreeIPA не «пускают»
// и не «валидят» вход — они лишь логируются.
async function checkCredentials(username, password) {
    const login = typeof username === 'string' && username.trim() ? username.trim() : ADMIN_USER;
    const low = login.toLowerCase();

    // 1) Локальная учётная запись из панели (accounts.json). Работает в любом AUTH_MODE.
    const acc = await checkAccountPassword(login, password);
    if (acc) return { ok: true, user: { username: acc.username, displayName: acc.displayName || acc.username }, via: 'account', mustChange: !!acc.mustChange };

    let accessDenied = false;                                     // в каталоге пустили, но нет в списке допущенных
    if (IPA_LOGIN) {
        try {
            const r = await freeipa.authenticate(IPA, login, password);
            if (r.ok) {
                // Пароль верный — но пускаем только «своих»: в каталоге, кроме наших,
                // есть и обычные сотрудники (см. FREEIPA_ACCESS_MODE / data/users.json).
                if (users.isAllowed(usersReg, r.user.username, accessMode())) return { ok: true, user: r.user, via: 'freeipa' };
                console.warn(`LDAP: «${r.user.username}» в каталоге есть, но не в списке допущенных (${accessMode()})`);
                accessDenied = true;                              // в режиме both ниже ещё проверится аварийная локальная учётка
            } else if (r.reason === 'bad-password' || r.reason === 'not-found' || r.reason === 'not-in-group' || r.reason === 'ambiguous') {
                console.warn(`LDAP: отказ для «${login}» (${r.reason})`);
            } else {
                console.warn(`LDAP: не проверялся для «${login}» (${r.reason})`);
            }
        } catch (e) {
            console.error('LDAP недоступен:', e.code || e.message);
        }
        // В режиме only-freeipa аварийного локального входа нет.
        if (!LOCAL_LOGIN) {
            return accessDenied
                ? { ok: false, reason: 'Нет доступа: учётная запись не в списке допущенных' }
                : { ok: false, reason: 'Неверный логин или пароль' };
        }
    }
    // 2) Встроенная учётная запись ADMIN_USER (аварийный вход) — только если это её логин.
    if (LOCAL_LOGIN && low === ADMIN_USER.toLowerCase()) {
        let ok = false;
        try { ok = await checkLocalPassword(password); } catch (e) { console.error('Ошибка проверки пароля:', e.message); }
        if (ok) return { ok: true, user: { username: ADMIN_USER, displayName: ADMIN_USER }, via: 'local' };
    }
    return { ok: false, reason: accessDenied ? 'Нет доступа: учётная запись не в списке допущенных' : 'Неверный логин или пароль' };
}

app.post('/api/login', async (req, res) => {
    const username = typeof req.body.username === 'string' ? req.body.username : '';
    const keys = [req.ip, failKey(req, username)];                 // блокируем и по IP, и по IP+логину
    if (keys.some(throttled)) return res.status(429).json({ success: false, message: 'Слишком много попыток, подождите' });
    const r = await checkCredentials(username, req.body.password);
    if (!r.ok) {
        keys.forEach(bumpFail);
        return res.status(401).json({ success: false, message: r.reason || 'Неверный логин или пароль' });
    }
    keys.forEach(k => fails.delete(k));
    // Новый идентификатор сессии после входа (защита от фиксации сессии): если злоумышленник
    // заранее навязал жертве свой sid, после входа он станет недействителен.
    req.session.regenerate(err => {
        if (err) { console.error('Не удалось пересоздать сессию:', err.message); return res.status(500).json({ success: false, message: 'Ошибка входа' }); }
        req.session.authorized = true;
        r.user.via = r.via;                                       // источник входа: freeipa | account | local
        req.session.user = r.user;                                // для отображения в админке/логах
        // Транспортный пароль: сессия действует, но панель закрыта до смены пароля.
        req.session.mustChange = !!r.mustChange;
        // Отпечаток считаем ПОСЛЕ простановки via: для учётной записи из панели он привязан
        // к её хэшу пароля, для остальных — к отпечатку админки.
        req.session.cred = credFor(req.session.user);
        // Метаданные для панели «Пользователи»: видно, кто и откуда сейчас работает.
        req.session.meta = { loginAt: Date.now(), ip: req.ip, ua: String(req.get('user-agent') || '').slice(0, 200) };
        console.log(`Вход разрешён: ${r.user.username} (${r.via}) с ${req.ip}${r.mustChange ? ' [транспортный пароль]' : ''}`);
        res.json({ success: true, user: { username: r.user.username, displayName: r.user.displayName }, mustChange: !!r.mustChange });
    });
});
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ success: true })));

// Подтверждение опасного действия паролем текущего пользователя (удаление экрана и т.п.).
// Проверяет пароль того же источника, через который пользователь вошёл: каталог FreeIPA
// или локальная учётка. Сетевые сбои каталога не считаются подтверждением.
async function confirmPassword(req, password) {
    const u = req.session.user || {};
    const login = typeof u.username === 'string' && u.username ? u.username : ADMIN_USER;
    if (typeof password !== 'string' || !password) return false;
    // Локальная учётная запись из панели: подтверждение её же паролем.
    if (u.via === 'account' || accounts.has(accountsReg, login)) {
        if (await checkAccountPassword(login, password)) return true;
        // Если каталог/аварийный вход тоже доступны, не выходим сразу — пусть проверятся и они.
        if (!IPA_LOGIN && !(LOCAL_LOGIN && login.toLowerCase() === ADMIN_USER.toLowerCase())) return false;
    }
    if (IPA_LOGIN) {
        try {
            const r = await freeipa.authenticate(IPA, login, password);
            if (r.ok) return true;
        } catch (e) { console.error('LDAP при подтверждении:', e.code || e.message); }
        if (!LOCAL_LOGIN) return false;
    }
    if (LOCAL_LOGIN && login.toLowerCase() === ADMIN_USER.toLowerCase()) {
        try { return await checkLocalPassword(password); } catch (e) { console.error('Ошибка подтверждения пароля:', e.message); }
    }
    return false;
}

// Публичная подсказка для страницы входа: нужен ли ввод логина и какой источник активен.
app.get('/api/auth', (req, res) => res.json({ mode: AUTH_MODE, username: IPA_LOGIN || AUTH_MODE === 'both' }));

// Текущий пользователь сессии — для значка пользователя и кнопки выхода в админке.
// 401 без авторизации: клиент понимает, что пора показать страницу входа.
app.get('/api/me', (req, res) => {
    if (!sessionValid(req)) return res.status(401).json({ success: false });
    const u = req.session.user || {};
    res.json({ success: true, username: u.username || ADMIN_USER, displayName: u.displayName || u.username || ADMIN_USER, via: u.via || null, mustChange: !!req.session.mustChange });
});

// Смена собственного пароля вошедшим пользователем. Работает и для транспортного пароля
// (тогда снимается mustChange), и для обычной смены по желанию.
// Тело: { currentPassword, newPassword }. После смены все прочие сессии отзываются:
// отпечаток сессии привязан к хэшу пароля, так что старые cookie перестают действовать.
app.post('/api/me/password', checkAuth, async (req, res) => {
    const b = req.body || {};
    const me = req.session.user || {};
    const forced = !!req.session.mustChange;              // сессия ещё на транспортном пароле
    if (me.via !== 'account') {
        return res.status(400).json({ success: false, message: 'Смена пароля здесь доступна только локальным учётным записям; пароль доменной учётки меняется в каталоге' });
    }
    const username = accounts.clean(me.username);
    const rec = accounts.get(accountsReg, username);
    if (!rec) return res.status(400).json({ success: false, message: 'Учётная запись не найдена' });
    if (!forced) {
        // Обычная смена: требуем текущий пароль.
        if (!(await checkAccountPassword(username, b.currentPassword))) return res.status(403).json({ success: false, message: 'Неверный текущий пароль' });
    }
    const pwProblem = accounts.passwordProblem(b.newPassword);
    if (pwProblem) return res.status(400).json({ success: false, message: pwProblem });
    if (await checkAccountPassword(username, b.newPassword)) return res.status(400).json({ success: false, message: 'Новый пароль совпадает с текущим — выберите другой' });

    let passwordHash;
    try { passwordHash = await auth.hashPassword(b.newPassword); }
    catch (e) { console.error('Ошибка хэширования пароля:', e.message); return res.status(500).json({ success: false, message: 'Внутренняя ошибка' }); }

    accountsReg = accounts.upsert(accountsReg, { ...rec, passwordHash, mustChange: false });
    accounts.save(ACCOUNTS_FILE, accountsReg);
    reloadAccounts();
    // После смены пароля своя сессия должна остаться действительной: ставим новый отпечаток.
    req.session.mustChange = false;
    req.session.cred = credFor(req.session.user);
    console.log(`Пароль сменён пользователем: «${username}» (${req.ip}); прочие сессии отозваны`);
    res.json({ success: true });
});

// ---------- доступ: список допущенных учётных записей каталога ----------
// Управление доступом через каталог имеет смысл, только когда вход по каталогу включён.
// В local-режиме эти API отвечают 400 — чтобы админка не показывала вингетку, которой нет смысла.
const catalogLogin = () => IPA_LOGIN;
const accessInfo = () => ({
    mode: accessMode(),                       // действующий режим: open | list
    configured: ACCESS_MODE,                  // как задано в .env: auto | open | list
    catalog: !!IPA_LOGIN,                     // включён ли вход через каталог
    count: usersReg.users.length,
    envGroup: IPA ? (IPA.requireGroup || null) : null
});

app.get('/api/users', checkAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, ...accessInfo(), users: usersReg.users });
});

// Активные сессии — для панели «Пользователи»: видно, кто сейчас работает.
// Наружу отдаём не сам id сессии (это фактически пароль от неё), а его хэш: по нему
// можно завершить сессию, но угнать её нельзя.
const sidHash = sid => crypto.createHash('sha256').update('signage-sid:' + sid).digest('hex').slice(0, 16);

function listSessions(cb) {
    sessionStore.all((err, all) => {
        if (err) return cb(err);
        const out = [];
        for (const [sid, s] of Object.entries(all || {})) {
            if (!s || !s.authorized) continue;
            // Недействительную сессию (сменился пароль / человека убрали из списка) не показываем,
            // а сразу удаляем: иначе список засоряется мёртвыми записями от старых версий или
            // от прежних входов, а такая сессия всё равно не даёт доступа.
            if (!sessionValidFor(s)) { try { sessionStore.destroy(sid, () => {}); } catch { /* уже удалена */ } continue; }
            const u = s.user || {};
            const exp = s.cookie && s.cookie.expires ? Date.parse(s.cookie.expires) : null;
            out.push({
                id: sidHash(sid),
                username: u.username || ADMIN_USER,
                displayName: u.displayName || u.username || ADMIN_USER,
                via: u.via || 'local',
                loginAt: (s.meta && s.meta.loginAt) || null,
                ip: (s.meta && s.meta.ip) || null,
                ua: (s.meta && s.meta.ua) || null,
                expires: exp
            });
        }
        out.sort((a, b) => (b.loginAt || 0) - (a.loginAt || 0));
        cb(null, out, Date.now());
    });
}

app.get('/api/users/sessions', checkAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    listSessions((err, sessions) => {
        if (err) return res.status(500).json({ success: false, message: 'Не удалось прочитать сессии' });
        const me = sidHash(req.sessionID);
        res.json({ success: true, sessions: sessions.map(s => ({ ...s, current: s.id === me })) });
    });
});

// Завершить чужую сессию (например, потерян ноутбук или вход с чужого адреса).
// Подтверждение паролем — как у других опасных действий; себя так завершить нельзя.
app.post('/api/users/sessions/revoke', checkAuth, async (req, res) => {
    const id = String((req.body || {}).id || '').trim();
    if (!id) return res.status(400).json({ success: false, message: 'Не указана сессия' });
    if (id === sidHash(req.sessionID)) return res.status(400).json({ success: false, message: 'Это ваша текущая сессия — используйте «Выйти»' });
    const key = `sess-revoke|${req.ip}`;
    if (throttled(key)) return res.status(429).json({ success: false, message: 'Слишком много попыток, подождите' });
    if (!(await confirmPassword(req, (req.body || {}).password))) {
        bumpFail(key);
        console.warn(`Отказ завершения сессии: неверный пароль (${req.ip})`);
        return res.status(403).json({ success: false, message: 'Неверный пароль' });
    }
    fails.delete(key);
    const found = await new Promise(ok => sessionStore.all((e, all) => ok(e ? null : Object.keys(all || {}).find(s => sidHash(s) === id))));
    if (!found) return res.status(404).json({ success: false, message: 'Сессия не найдена (возможно, уже завершена)' });
    await new Promise(ok => sessionStore.destroy(found, ok));
    console.log(`Сессия завершена вручную (${req.session.user ? req.session.user.username : '?'} с ${req.ip}): ${id}`);
    res.json({ success: true });
});

// Добавить учётную запись в список допущенных. Тело: { username, note? }.
// Если каталог настроен — сначала проверяем, что такой пользователь в нём есть:
// так админ видит опечатку сразу, а не «пользователь добавлен, но войти не может».
app.post('/api/users', checkAuth, async (req, res) => {
    if (!catalogLogin()) return res.status(400).json({ success: false, message: 'Вход через каталог не настроен (AUTH_MODE=local)' });
    const username = users.clean((req.body || {}).username);
    if (!users.isValid(username)) {
        return res.status(400).json({ success: false, message: 'Недопустимый логин: буквы, цифры, точка, дефис, подчёркивание (до 64 символов)' });
    }
    if (users.has(usersReg, username)) return res.status(409).json({ success: false, message: `«${username}» уже в списке допущенных` });

    let displayName = '';
    try {
        const r = await freeipa.findUser(IPA, username);
        if (!r.ok) {
            const msg = r.reason === 'not-found' ? `В каталоге нет пользователя «${username}»`
                : r.reason === 'ambiguous' ? `В каталоге несколько записей с логином «${username}»`
                : `Логин не проверен (${r.reason})`;
            return res.status(400).json({ success: false, message: msg });
        }
        displayName = r.user.displayName || '';
    } catch (e) {
        console.error('LDAP при добавлении:', e.code || e.message);
        return res.status(503).json({ success: false, message: 'Каталог недоступен — не могу проверить логин. Повторите позже.' });
    }

    const rec = {
        username,
        displayName,
        note: users.clip((req.body || {}).note, 120),
        addedAt: new Date().toISOString(),
        addedBy: (req.session.user && req.session.user.username) || ADMIN_USER
    };
    usersReg.users.push(rec);
    usersReg = users.normalize(usersReg);
    users.save(USERS_FILE, usersReg);
    reloadUsers();
    console.log(`Доступ через каталог: добавлен «${username}» (${rec.addedBy}); режим доступа — ${accessMode()}`);
    res.json({ success: true, ...accessInfo(), user: rec });
});

// Убрать учётную запись из списка. Тело: { password } — действие опасное:
// подтверждаем паролем текущего пользователя, как удаление экрана.
app.post('/api/users/delete', checkAuth, async (req, res) => {
    if (!catalogLogin()) return res.status(400).json({ success: false, message: 'Вход через каталог не настроен (AUTH_MODE=local)' });
    const username = users.clean((req.body || {}).username);
    const rec = users.get(usersReg, username);
    if (!rec) return res.status(404).json({ success: false, message: 'Запись не найдена' });
    const key = `user-del|${req.ip}`;
    if (throttled(key)) return res.status(429).json({ success: false, message: 'Слишком много попыток, подождите' });
    if (!(await confirmPassword(req, (req.body || {}).password))) {
        bumpFail(key);
        console.warn(`Отказ удаления «${username}» из доступа: неверный пароль (${req.ip})`);
        return res.status(403).json({ success: false, message: 'Неверный пароль' });
    }
    fails.delete(key);
    usersReg.users = usersReg.users.filter(u => u.username !== username);
    users.save(USERS_FILE, usersReg);
    reloadUsers();
    console.log(`Доступ через каталог: убран «${username}»; режим доступа — ${accessMode()}`);
    res.json({ success: true, ...accessInfo() });
});

// ---------- локальные учётные записи админки (создание/удаление из панели) ----------
// Это вход по учётной записи, заведённой прямо в интерфейсе (логин + пароль). Пароль хранится
// только хэшем (scrypt). Все такие учётки — равноправные администраторы. Встроенную ADMIN_USER
// из .env создать/удалить отсюда нельзя: это аварийный вход, он всегда остаётся — чтобы не
// остаться без входа, если настройки каталога окажутся нерабочими.
const publicAccount = a => ({ username: a.username, displayName: a.displayName || '', note: a.note || '', createdAt: a.createdAt || null, createdBy: a.createdBy || null, mustChange: !!a.mustChange });
const builtinAccount = () => ({ username: ADMIN_USER, displayName: (AUTH_MODE === 'local' || AUTH_MODE === 'both') ? `${ADMIN_USER} (встроенная)` : ADMIN_USER, builtin: true });

app.get('/api/accounts', checkAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
        success: true,
        builtin: builtinAccount(),
        accounts: accountsReg.accounts.map(publicAccount)
    });
});

// Создать локальную учётную запись или сменить ей пароль администратором.
// Тело: { username, displayName?, note?, password? }.
//   • без password — пароль генерирует сервер и возвращает один раз в ответе;
//   • с password — используется указанный (админ придумал свой);
// В обоих случаях он ТРАНСПОРТНЫЙ: владелец обязан сменить его при первом входе.
app.post('/api/accounts', checkAuth, async (req, res) => {
    const b = req.body || {};
    const username = accounts.clean(b.username);
    if (!accounts.isValid(username)) {
        return res.status(400).json({ success: false, message: 'Недопустимый логин: буквы, цифры, точка, дефис, подчёркивание (до 64 символов)' });
    }
    if (username === ADMIN_USER.toLowerCase()) {
        return res.status(400).json({ success: false, message: `«${ADMIN_USER}» — встроенная учётная запись, её пароль задаётся в .env (ADMIN_PASSWORD_HASH)` });
    }

    // Пароль: переданный администратором либо сгенерированный. Длина сгенерированного
    // заведомо достаточна; пользовательский проверяем тем же правилом.
    const generated = (typeof b.password !== 'string' || b.password === '');
    const password = generated ? accounts.genTempPassword() : b.password;
    if (!generated) {
        const pwProblem = accounts.passwordProblem(password);
        if (pwProblem) return res.status(400).json({ success: false, message: pwProblem });
    }

    const existed = accounts.has(accountsReg, username);
    let passwordHash;
    try { passwordHash = await auth.hashPassword(password); }
    catch (e) { console.error('Ошибка хэширования пароля:', e.message); return res.status(500).json({ success: false, message: 'Внутренняя ошибка' }); }

    const prev = accounts.get(accountsReg, username);
    const rec = {
        username,
        displayName: accounts.clip(b.displayName, 80) || (prev && prev.displayName) || '',
        passwordHash,
        mustChange: true,                                  // пароль транспортный — сменить при первом входе
        note: accounts.clip(b.note, 120) || (prev && prev.note) || '',
        createdAt: (prev && prev.createdAt) || new Date().toISOString(),
        createdBy: (prev && prev.createdBy) || ((req.session.user && req.session.user.username) || ADMIN_USER),
    };
    accountsReg = accounts.upsert(accountsReg, rec);
    accounts.save(ACCOUNTS_FILE, accountsReg);
    reloadAccounts();
    console.log(`Локальная учётная запись: ${existed ? 'сброс пароля' : 'создана'} «${username}» (${rec.createdBy}); пароль ${generated ? 'сгенерирован' : 'задан админом'}, смена при первом входе`);
    // Открытый пароль отдаём ОДИН раз — сохранить его больше негде (в файле только хэш).
    res.json({ success: true, account: publicAccount(accounts.get(accountsReg, username) || rec), created: !existed, generated, password });
});

// Сброс пароля учётной записи: выдаём новый транспортный пароль (генерируем), старый сразу
// перестаёт действовать, все сессии этой учётки отзываются. Подтверждаем паролем админа.
app.post('/api/accounts/reset', checkAuth, async (req, res) => {
    const b = req.body || {};
    const username = accounts.clean(b.username);
    const rec = accounts.get(accountsReg, username);
    if (!rec) return res.status(404).json({ success: false, message: 'Учётная запись не найдена' });
    const key = `acc-reset|${req.ip}`;
    if (throttled(key)) return res.status(429).json({ success: false, message: 'Слишком много попыток, подождите' });
    if (!(await confirmPassword(req, b.password))) {
        bumpFail(key);
        console.warn(`Отказ сброса пароля «${username}»: неверный пароль (${req.ip})`);
        return res.status(403).json({ success: false, message: 'Неверный пароль' });
    }
    fails.delete(key);
    // Пароль генерируем один раз и сразу хэшируем: в ответ уйдёт тот же текст, что лёг в хэш.
    const newPassword = accounts.genTempPassword();
    let passwordHash;
    try { passwordHash = await auth.hashPassword(newPassword); }
    catch (e) { console.error('Ошибка хэширования пароля:', e.message); return res.status(500).json({ success: false, message: 'Внутренняя ошибка' }); }
    accountsReg = accounts.setTempPassword(accountsReg, username, passwordHash);
    accounts.save(ACCOUNTS_FILE, accountsReg);
    reloadAccounts();
    console.log(`Сброс пароля учётной записи «${username}» (${req.ip}); выдан транспортный пароль, все её сессии отозваны`);
    res.json({ success: true, account: publicAccount(accounts.get(accountsReg, username)), password: newPassword });
});

// Удалить локальную учётную запись. Тело: { username, password } — опасное действие,
// подтверждаем паролем текущего администратора. Сессии удалённого отзываются сразу (credFor).
app.post('/api/accounts/delete', checkAuth, async (req, res) => {
    const b = req.body || {};
    const username = accounts.clean(b.username);
    const rec = accounts.get(accountsReg, username);
    if (!rec) return res.status(404).json({ success: false, message: 'Учётная запись не найдена' });
    const me = req.session.user || {};
    if (me.via === 'account' && accounts.clean(me.username) === username) {
        return res.status(400).json({ success: false, message: 'Это ваша учётная запись — удалить её из своей же сессии нельзя' });
    }
    const key = `acc-del|${req.ip}`;
    if (throttled(key)) return res.status(429).json({ success: false, message: 'Слишком много попыток, подождите' });
    if (!(await confirmPassword(req, b.password))) {
        bumpFail(key);
        console.warn(`Отказ удаления учётной записи «${username}»: неверный пароль (${req.ip})`);
        return res.status(403).json({ success: false, message: 'Неверный пароль' });
    }
    fails.delete(key);
    accountsReg = accounts.remove(accountsReg, username);
    accounts.save(ACCOUNTS_FILE, accountsReg);
    reloadAccounts();
    console.log(`Локальная учётная запись удалена: «${username}»`);
    res.json({ success: true });
});

// ---------- настройки каталога FreeIPA (из панели, только админ) ----------
// Показываем действующие значения; секрет сервисной учётки — только признаком. Сами настройки
// перекрывают .env; сброс возвращает «как в .env». После сохранения конфигурация пересчитывается.
function settingsPublic() {
    const pub = settings.toPublic(settingsReg, process.env);
    pub.mode = pub.mode || AUTH_MODE;         // заданный режим (из панели или .env)
    pub.activeMode = AUTH_MODE;               // что действует сейчас
    pub.active = !!IPA_LOGIN;                 // получилось ли включить вход через каталог прямо сейчас
    pub.urlEffective = IPA ? IPA.url : '';
    pub.error = '';
    return pub;
}

app.get('/api/settings/freeipa', checkAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, ...settingsPublic() });
});

app.post('/api/settings/freeipa', checkAuth, async (req, res) => {
    const b = req.body || {};
    const patch = settings.parseInput(b);
    const next = { ...settingsReg, freeipa: { ...(settingsReg.freeipa || {}), ...patch } };
    // Пароль сервисной учётки: пустая строка = «не менять». `bindPasswordClear: true` — удалить.
    if (typeof b.bindPassword === 'string' && b.bindPassword !== '') next.freeipa.bindPassword = b.bindPassword;
    if (b.bindPasswordClear === true) delete next.freeipa.bindPassword;
    // Пустые значения не храним: они означают «взять из .env».
    for (const k of Object.keys(next.freeipa)) if (next.freeipa[k] === '' || next.freeipa[k] === null) delete next.freeipa[k];

    // Проверяем конфигурацию только если каталог действительно нужен (режим freeipa/both или включён):
    // иначе сохранили бы «кирпич». В режиме local пустые поля каталога — это норма.
    const merged = settings.mergedEnv(next);
    const mode = String(merged.AUTH_MODE || '').trim().toLowerCase() || (merged.FREEIPA_ENABLED ? 'freeipa' : 'local');
    if (['freeipa', 'both'].includes(mode) || settings.asBool(merged.FREEIPA_ENABLED)) {
        try { freeipa.loadConfig(merged); }
        catch (e) { return res.status(400).json({ success: false, message: e.message }); }
    }

    settingsReg = next;
    settings.save(SETTINGS_FILE, settingsReg);
    applyAuthConfig();
    console.log(`Настройки каталога сохранены (${(req.session.user && req.session.user.username) || ADMIN_USER}); вход через каталог — ${IPA_LOGIN ? 'включён' : 'выключен'}`);
    const pub = settingsPublic();
    if (pub.enabled && !pub.active) pub.error = 'Настройки сохранены, но вход через каталог не включится: проверьте AUTH_MODE и обязательные поля.';
    res.json({ success: true, ...pub });
});

// Сброс настроек панели: снова действует только .env.
app.post('/api/settings/freeipa/reset', checkAuth, (req, res) => {
    settingsReg = { freeipa: {} };
    settings.save(SETTINGS_FILE, settingsReg);
    applyAuthConfig();
    console.log(`Настройки каталога сброшены к .env (${(req.session.user && req.session.user.username) || ADMIN_USER})`);
    res.json({ success: true, ...settingsPublic() });
});

// Страница входа. Логин/подсказка отрисовываются по режиму AUTH_MODE прямо в HTML,
// а не только через /api/auth: иначе медленный/неудачный запрос оставлял форму без поля логина.
function renderLogin() {
    const file = path.join(PUBLIC, 'login.html');
    const hint = AUTH_MODE === 'freeipa' ? 'Вход по учётной записи FreeIPA'
        : AUTH_MODE === 'both' ? 'FreeIPA или локальный администратор'
        : accountsReg.accounts.length ? 'Вход по учётной записи' : '';
    // Поле логина показываем всегда. В local-режиме учётка одна — подставляем ADMIN_USER,
    // в freeipa/both логин вводит пользователь (поле пустое).
    const user = LOCAL_LOGIN && AUTH_MODE === 'local' ? ADMIN_USER : '';
    try {
        return fs.readFileSync(file, 'utf8')
            .replace('__AUTH_MODE__', AUTH_MODE)
            .replace('__AUTH_HINT__', hint)
            .replace('__AUTH_USER__', user);
    } catch {
        return fs.readFileSync(file);   // на всякий случай отдаём файл как есть
    }
}

app.get('/admin', (req, res) => {
    if (sessionValid(req)) return res.sendFile(path.join(PUBLIC, 'admin.html'));
    res.type('html').send(renderLogin());
});

// Явная страница входа (устаревшие ссылки вида /login и превью в UX-аудите).
app.get('/login', (req, res) => {
    if (sessionValid(req)) return res.redirect('/admin');
    res.type('html').send(renderLogin());
});

// Страница-плеер для медиаплееров: http://IP:3000/player?token=<токен экрана>
app.get('/player', (req, res) => res.sendFile(path.join(PUBLIC, 'player.html')));

// Список экранов с именами и токенами ссылок (только для админки).
app.get('/api/screens', checkAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ screens: registry.screens.map(publicScreen) });
});

// Создать новый экран. Тело: { name }.
app.post('/api/screens', checkAuth, (req, res) => {
    const name = screens.cleanName((req.body || {}).name, '');
    if (!name) return res.status(400).json({ success: false, message: 'Укажите имя экрана' });
    const taken = new Set(registry.screens.map(s => s.id));
    const id = screens.uniqueId(screens.makeId(name), taken);
    const s = { id, name, token: screens.newToken() };
    registry.screens.push(s);
    screens.save(SCREENS_FILE, registry);
    reloadRegistry();
    fs.mkdirSync(screenSnapDir(id), { recursive: true });
    console.log(`Экран создан: ${s.name} (${s.id})`);
    res.json({ success: true, screen: publicScreen(s) });
});

// Переименовать экран. Тело: { name }. id не меняется (файлы и ссылки остаются валидными).
app.post('/api/screens/:id', checkAuth, (req, res) => {
    const s = screenById(req.params.id);
    if (!s) return res.status(404).json({ success: false, message: 'Экран не найден' });
    const name = screens.cleanName((req.body || {}).name, '');
    if (!name) return res.status(400).json({ success: false, message: 'Укажите имя экрана' });
    s.name = name;
    screens.save(SCREENS_FILE, registry);
    res.json({ success: true, screen: publicScreen(s) });
});

// Перегенерировать токен ссылки (старая ссылка перестаёт работать).
app.post('/api/screens/:id/token', checkAuth, (req, res) => {
    const s = screenById(req.params.id);
    if (!s) return res.status(404).json({ success: false, message: 'Экран не найден' });
    s.token = screens.newToken();
    screens.save(SCREENS_FILE, registry);
    console.log(`Ссылка экрана «${s.name}» перевыпущена`);
    res.json({ success: true, screen: publicScreen(s) });
});

// Удалить экран: плейлист и снапшоты убираются, ссылка перестаёт работать.
// Требует подтверждения паролем текущего пользователя (защита от случайного удаления).
app.post('/api/screens/:id/delete', checkAuth, async (req, res) => {
    const s = screenById(req.params.id);
    if (!s) return res.status(404).json({ success: false, message: 'Экран не найден' });
    const password = (req.body || {}).password;
    const key = `del|${req.ip}`;
    if (throttled(key)) return res.status(429).json({ success: false, message: 'Слишком много попыток, подождите' });
    if (!(await confirmPassword(req, password))) {
        bumpFail(key);
        console.warn(`Отказ удаления экрана «${s.name}»: неверный пароль (${req.ip})`);
        return res.status(403).json({ success: false, message: 'Неверный пароль' });
    }
    fails.delete(key);
    const urls = [];
    const d = readPlaylist(s.id);
    if (d.default_image) urls.push(d.default_image);
    (d.playlist || []).forEach(x => urls.push(x.url));
    registry.screens = registry.screens.filter(x => x.id !== s.id);
    screens.save(SCREENS_FILE, registry);
    reloadRegistry();
    try { fs.unlinkSync(jsonFile(s.id)); } catch {}
    fs.rmSync(screenSnapDir(s.id), { recursive: true, force: true });
    urls.forEach(removeFileIfUnused);
    console.log(`Экран удалён: ${s.name} (${s.id})`);
    res.json({ success: true });
});

// Плейлист плеера — по токену экрана (без пароля, чтобы читали плееры).
app.get('/api/playlist/:token', (req, res) => {
    const s = screenByToken(req.params.token);
    if (!s) return res.status(404).json({ playlist: [] });
    res.set('Cache-Control', 'no-store');
    res.json(withProgress(readPlaylist(s.id)));
});

app.post('/api/upload', checkAuth, upload.single('image'), async (req, res) => {
    const created = [];
    let keepRaw = false;                                 // для видео исходник нужен до конца конвертации
    try {
        const { screen, duration, start_date, end_date } = req.body;
        if (!req.file) throw new UserError('Нужен файл: PNG, JPG, PDF или видео');
        const isVideo = isVideoFile(req.file);
        const s = Date.parse(start_date), e = Date.parse(end_date), d = parseInt(duration);
        if (!validScreen(screen) || isNaN(s) || isNaN(e) || e <= s || (!isVideo && !(d >= 1000))) throw new UserError('Неверные параметры');

        const mode = parseFit(req.body.fit), title = cleanName(req.file.originalname);
        const isPdf = req.file.mimetype === 'application/pdf';

        if (isVideo) {                                   // длительность слайда = длина ролика; конвертация идёт в фоне
            if (!VIDEO_OK) throw new UserError('Видео не поддерживается: на сервере не найден ffmpeg');
            const info = await video.probeVideo(req.file.path);
            const plan = video.planVideo(info, mode);    // при mode=reject и других пропорциях бросит ошибку
            const sound = req.body.sound === 'true' && info.hasAudio;
            const id = crypto.randomUUID(), outName = id + '.mp4';
            const outTmp = path.join(TMP, outName), outFinal = path.join(UPLOADS, outName);
            const data = readPlaylist(screen);
            data.playlist.push({
                id, type: 'video', status: 'processing', url: `/uploads/${outName}`,
                duration: Math.ceil(info.duration * 1000), sound,
                start_date: new Date(s).toISOString(), end_date: new Date(e).toISOString(), title
            });
            writePlaylist(screen, data);
            enqueueJob({ id, screen, input: req.file.path, outTmp, outFinal, info, progress: 0,
                         args: video.buildArgs(info, { mode, fps: plan.fps, sound }, req.file.path, outTmp) });
            keepRaw = true;
            return res.json({ success: true, added: 1, queued: true, warnings: plan.warnings });
        }
        if (req.file.size > MAX_IMAGE_BYTES) throw new UserError('Файл слишком большой (максимум 40 МБ для картинок и PDF)');
        const warnings = new Set(), slides = [];

        const add = async (input, page, pages) => {
            const r = await processImage(input, mode);
            r.warnings.forEach(w => warnings.add(w));
            const name = crypto.randomUUID() + r.ext;
            fs.writeFileSync(path.join(UPLOADS, name), r.buffer);
            created.push(name);
            slides.push({
                id: crypto.randomUUID(), url: `/uploads/${name}`, duration: d,
                start_date: new Date(s).toISOString(), end_date: new Date(e).toISOString(),
                title, ...(isPdf ? { page, pages } : {})
            });
        };

        if (isPdf) {                                   // каждая страница PDF -> отдельный слайд
            const doc = await openPdf(req.file.path);
            let k = 0;
            for await (const png of doc) await add(png, ++k, doc.length);
        } else {
            await add(req.file.path);
        }

        const data = readPlaylist(screen);             // в плейлист пишем только если обработались ВСЕ страницы
        data.playlist.push(...slides);
        writePlaylist(screen, data);
        res.json({ success: true, added: slides.length, warnings: [...warnings] });
    } catch (err) {
        created.forEach(n => fs.unlink(path.join(UPLOADS, n), () => {}));
        if (!err.user) console.error(err);
        res.status(err.user ? 400 : 500).json({ success: false, message: err.user ? err.message : 'Не удалось обработать файл' });
    } finally {
        if (req.file && !keepRaw) fs.unlink(req.file.path, () => {});
    }
});

// Изменить время показа и/или даты одного слайда
app.post('/api/update', checkAuth, (req, res) => {
    const { screen, id, duration, start_date, end_date } = req.body;
    if (!validScreen(screen)) return res.status(400).json({ success: false, message: 'Неверный экран' });
    const data = readPlaylist(screen);
    const s = data.playlist.find(x => x.id === id);
    if (!s) return res.status(404).json({ success: false, message: 'Слайд не найден' });
    const d = (duration === undefined || s.type === 'video') ? s.duration : parseInt(duration);   // у видео время = длина ролика
    const st = start_date === undefined ? Date.parse(s.start_date) : Date.parse(start_date);
    const en = end_date === undefined ? Date.parse(s.end_date) : Date.parse(end_date);
    if (!(d >= 1000) || isNaN(st) || isNaN(en) || en <= st)
        return res.status(400).json({ success: false, message: 'Неверные время или даты' });
    s.duration = d; s.start_date = new Date(st).toISOString(); s.end_date = new Date(en).toISOString();
    writePlaylist(screen, data);
    res.json({ success: true });
});

// Изменить порядок показа: ids — id активных (или любых) слайдов экрана в новом порядке.
// Остальные слайды остаются на своих местах.
app.post('/api/reorder', checkAuth, (req, res) => {
    const { screen, ids } = req.body;
    if (!validScreen(screen) || !Array.isArray(ids)) return res.status(400).json({ success: false, message: 'Неверные параметры' });
    const set = new Set(ids);
    if (set.size !== ids.length) return res.status(400).json({ success: false, message: 'Повторяющиеся id' });
    const data = readPlaylist(screen);
    const slots = [];
    data.playlist.forEach((s, k) => { if (set.has(s.id)) slots.push(k); });
    if (slots.length !== ids.length) return res.status(409).json({ success: false, message: 'Список изменился, обновите страницу' });
    const byId = new Map(data.playlist.map(s => [s.id, s]));
    ids.forEach((id, n) => { data.playlist[slots[n]] = byId.get(id); });
    writePlaylist(screen, data);
    res.json({ success: true });
});

// Одно время показа для всех слайдов экрана (screen = имя или "all")
app.post('/api/duration-all', checkAuth, (req, res) => {
    const t = targets(req.body.screen), d = parseInt(req.body.duration);
    if (!t || !(d >= 1000)) return res.status(400).json({ success: false, message: 'Неверные параметры' });
    t.forEach(n => { const data = readPlaylist(n); data.playlist.forEach(s => { if (s.type !== 'video') s.duration = d; }); writePlaylist(n, data); });
    res.json({ success: true });
});

app.post('/api/delete', checkAuth, (req, res) => {
    const { screen, id } = req.body;
    if (!validScreen(screen)) return res.status(400).json({ success: false });
    const data = readPlaylist(screen);
    const slide = data.playlist.find(s => s.id === id);
    if (!slide) return res.status(404).json({ success: false });
    data.playlist = data.playlist.filter(s => s.id !== id);
    writePlaylist(screen, data);
    cancelJob(id);
    removeFileIfUnused(slide.url);
    res.json({ success: true });
});

// ---------- состояние плееров (в памяти, плеер шлёт "пульс" каждые 10 сек и при смене слайда) ----------
const playerState = {};
let legacyHeartbeatWarned = false;   // однократное предупреждение в лог
const legacySeen = {};               // screen-id -> { at, ip } — плеер шлёт heartbeat старого формата
app.post('/api/heartbeat', (req, res) => {
    const b = req.body || {};
    const s = screenByToken(b.token);
    if (!s) {
        // Старый формат ссылки (/player?screen=<имя>) шлёт имя вместо токена.
        // Такая ссылка всегда отдаёт 400 — плеер молчит, и лампочка в админке остаётся серой.
        if (b.screen && !b.token) {
            const name = String(b.screen).slice(0, 32);
            const known = registry.screens.some(x => x.id === name);
            if (known) {
                // Помним факт: админка покажет в карточке «плеер на устаревшей ссылке».
                const prev = legacySeen[name];
                legacySeen[name] = { at: Date.now(), ip: req.ip, count: prev ? prev.count + 1 : 1 };
            }
            if (!legacyHeartbeatWarned) {
                legacyHeartbeatWarned = true;
                console.warn(`Плеер шлёт heartbeat СТАРОГО формата (screen=${String(b.screen).slice(0, 32)}). ` +
                    'Ссылка перевыпущена на формат /player?token=<...>: обновите адрес в системе публикации (поле «Ссылка плеера» в админке).');
            }
            return res.status(400).json({ ok: false, hint: 'Устаревшая ссылка: откройте /player?token=<токен> из админки' });
        }
        return res.status(400).json({ ok: false });
    }
    const n = s.id, now = Date.now();
    const kind = ['slide', 'default', 'black'].includes(b.kind) ? b.kind : 'black';
    const slideId = typeof b.slideId === 'string' ? b.slideId.slice(0, 64) : null;
    const key = `${kind}|${slideId}|${b.startedAt}`;
    const prev = playerState[n];
    playerState[n] = {
        kind, slideId, key,
        duration: Number(b.duration) || 0,
        changedAt: prev && prev.key === key ? prev.changedAt : now,   // время сервера, а не часов плеера
        lastSeen: now,
        ip: req.ip
    };
    res.json({ ok: true });
});
app.get('/api/status', checkAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    // legacy: плеер обращался со ссылкой старого формата (/player?screen=...) — лампочка не зеленеет
    const legacy = {};
    for (const [id, v] of Object.entries(legacySeen)) {
        if (Date.now() - v.at < 10 * 60 * 1000) legacy[id] = { at: v.at, ip: v.ip };   // актуально 10 минут
        else delete legacySeen[id];
    }
    res.json({ serverTime: Date.now(), screens: playerState, legacy });
});

// ---------- снапшоты экранов (реальный кадр с плеера через Local DWS) ----------
// Адрес плеера на экран (host/port/scheme) — в data/players.json.
app.get('/api/snapshot/players', checkAuth, (req, res) => res.json(readPlayers()));

app.post('/api/snapshot/players', checkAuth, (req, res) => {
    const { screen, address } = req.body || {};
    if (!validScreen(screen)) return res.status(400).json({ success: false, message: 'Неверный экран' });
    const players = readPlayers();
    try {
        if (!address || !String(address).trim()) delete players[screen];      // пусто = убрать адрес
        else players[screen] = snapshot.parseAddress(address);
    } catch (e) { return res.status(400).json({ success: false, message: e.message }); }
    writePlayers(players);
    res.json({ success: true, players });
});

// Снять кадр с плеера и сохранить. Тело: { screen }.
app.post('/api/snapshot/:screen', checkAuth, async (req, res) => {
    const screen = req.params.screen;
    if (!validScreen(screen)) return res.status(400).json({ success: false, message: 'Неверный экран' });
    const player = readPlayers()[screen];
    if (!player) return res.status(400).json({ success: false, message: 'Адрес плеера не задан (укажите IP в карточке экрана)' });
    try {
        const creds = snapshot.credentialsFor(SNAP, screen);
        const shot = await snapshot.capture(SNAP, player, creds);
        const dir = screenSnapDir(screen);
        fs.mkdirSync(dir, { recursive: true });
        const ext = /\.png$/i.test(shot.filename) ? '.png' : '.jpg';
        const name = new Date().toISOString().replace(/[:.]/g, '-') + ext;   // сортируется по времени
        fs.writeFileSync(path.join(dir, name), shot.buffer);
        pruneSnapshots(screen);
        const list = listSnapshots(screen);
        res.json({ success: true, file: name, width: shot.width, height: shot.height, deviceName: shot.deviceName, count: list.length });
    } catch (e) {
        console.error(`Снапшот ${screen}: ${e.code || e.message}`);
        const s = screenById(screen);
        res.status(502).json({ success: false, message: snapshot.describeError(e, { screen: (s && s.name) || screen }) });
    }
});

// Список сохранённых кадров экрана (от новых к старым).
app.get('/api/snapshot/:screen', checkAuth, (req, res) => {
    const screen = req.params.screen;
    if (!validScreen(screen)) return res.status(400).json({ success: false });
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, files: listSnapshots(screen), keep: SNAP.keep, player: readPlayers()[screen] || null });
});

// Последний кадр экрана картинкой (для <img> в админке).
app.get('/api/snapshot/:screen/latest', checkAuth, (req, res) => {
    const screen = req.params.screen;
    if (!validScreen(screen)) return res.status(404).end();
    const files = listSnapshots(screen);
    if (!files.length) return res.status(404).end();
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(screenSnapDir(screen), files[0]));
});

// Отдать конкретный сохранённый кадр (имя — только базовое, без путей).
app.get('/api/snapshot/:screen/file/:name', checkAuth, (req, res) => {
    const screen = req.params.screen, name = path.basename(req.params.name);
    if (!validScreen(screen) || !/\.(jpe?g|png)$/i.test(name)) return res.status(400).end();
    const p = path.join(screenSnapDir(screen), name);
    if (!fs.existsSync(p)) return res.status(404).end();
    res.set('Cache-Control', 'no-store');
    res.sendFile(p);
});

app.post('/api/snapshot/:screen/delete', checkAuth, (req, res) => {
    const screen = req.params.screen;
    if (!validScreen(screen)) return res.status(400).json({ success: false });
    const name = path.basename(String((req.body || {}).file || ''));
    if (!/\.(jpe?g|png)$/i.test(name)) return res.status(400).json({ success: false, message: 'Неверное имя файла' });
    fs.unlink(path.join(screenSnapDir(screen), name), () => {});
    res.json({ success: true, files: listSnapshots(screen) });
});

// ---------- автодеплой: кнопка «Обновить» -> мини-агент на хосте ----------
// Доступно только при DEPLOY_ENABLED=true. Сама пересборка — на хосте (deploy-agent.js).
app.get('/api/deploy', checkAuth, async (req, res) => {
    if (!DEPLOY) return res.json({ enabled: false });
    try { res.json({ enabled: true, ...(await deploy.status(DEPLOY)) }); }
    catch (e) { res.status(502).json({ enabled: true, ok: false, message: `Агент деплоя недоступен: ${e.message}` }); }
});

app.post('/api/deploy', checkAuth, async (req, res) => {
    if (!DEPLOY) return res.status(400).json({ success: false, message: 'Автодеплой выключен (DEPLOY_ENABLED=true в .env)' });
    try {
        const r = await deploy.trigger(DEPLOY);
        console.log(`Деплой запущен пользователем ${req.session.user ? req.session.user.username : '?'} с ${req.ip}`);
        res.json({ success: true, started: r.started, message: r.message });
    } catch (e) {
        console.error('Деплой:', e.message);
        res.status(502).json({ success: false, message: `Не удалось запустить деплой: ${e.message}` });
    }
});

// ---------- заглушка (default_image хранится в плейлисте экрана) ----------
// screen = 1|2|3 или "all"
const targets = s => s === 'all' ? SCREENS : (validScreen(s) ? [String(s)] : null);

app.post('/api/default', checkAuth, upload.single('image'), async (req, res) => {
    let created = null;
    try {
        if (!req.file) throw new UserError('Нужен файл PNG или JPG');
        if (req.file.mimetype === 'application/pdf' || isVideoFile(req.file)) throw new UserError('Для заглушки нужна картинка PNG или JPG, а не PDF или видео');
        const t = targets(req.body.screen);
        if (!t) throw new UserError('Неверный экран');
        const r = await processImage(req.file.path, parseFit(req.body.fit));
        const name = crypto.randomUUID() + r.ext;
        fs.writeFileSync(path.join(UPLOADS, name), r.buffer);
        created = name;
        const url = `/uploads/${name}`, old = [];
        t.forEach(n => {
            const d = readPlaylist(n);
            if (d.default_image) old.push(d.default_image);
            d.default_image = url;
            writePlaylist(n, d);
        });
        old.forEach(removeFileIfUnused);
        res.json({ success: true, warnings: r.warnings });
    } catch (err) {
        if (created) fs.unlink(path.join(UPLOADS, created), () => {});
        if (!err.user) console.error(err);
        res.status(err.user ? 400 : 500).json({ success: false, message: err.user ? err.message : 'Не удалось обработать файл' });
    } finally {
        if (req.file) fs.unlink(req.file.path, () => {});
    }
});

// Скопировать уже загруженную заглушку этого экрана на остальные (галочка «на всех экранах»).
// Нужен, когда галочку ставят ПОСЛЕ загрузки картинки: файл уже обработан и лежит в /uploads,
// повторно загружать его не нужно — просто прописываем тот же URL другим экранам.
app.post('/api/default/copy', checkAuth, (req, res) => {
    const src = String((req.body || {}).screen || '');
    if (!validScreen(src)) return res.status(400).json({ success: false, message: 'Неверный экран' });
    const url = readPlaylist(src).default_image;
    if (!url) return res.status(400).json({ success: false, message: 'На этом экране ещё нет заглушки' });
    const others = SCREENS.filter(n => n !== src);
    const old = [];
    others.forEach(n => {
        const d = readPlaylist(n);
        if (d.default_image && d.default_image !== url) old.push(d.default_image);
        d.default_image = url;
        writePlaylist(n, d);
    });
    old.forEach(removeFileIfUnused);
    res.json({ success: true, screens: [src, ...others], url });
});

app.post('/api/default/delete', checkAuth, (req, res) => {
    const t = targets(req.body.screen);
    if (!t) return res.status(400).json({ success: false });
    const old = [];
    t.forEach(n => {
        const d = readPlaylist(n);
        if (d.default_image) old.push(d.default_image);
        delete d.default_image;
        writePlaylist(n, d);
    });
    old.forEach(removeFileIfUnused);
    res.json({ success: true });
});

app.use((err, req, res, next) => {           // ошибки multer (например, слишком большой файл)
    res.status(400).json({ success: false, message: err.code === 'LIMIT_FILE_SIZE' ? `Файл слишком большой (максимум ${MAX_VIDEO_MB} МБ)` : 'Ошибка загрузки файла' });
});

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Админка: http://localhost:${PORT}/admin`);
    registry.screens.forEach(s => console.log(`Плеер ${s.name}: http://<IP>:${PORT}${playerUrl(s.token)}`));
    if (!PASSWORD_HASH && LOCAL_LOGIN) console.warn('⚠ Используется открытый ADMIN_PASSWORD. Лучше ADMIN_PASSWORD_HASH: npm run hash-password');
    console.log(`Аутентификация: ${AUTH_MODE}` + (IPA_LOGIN ? ` (FreeIPA: ${IPA.url}, база ${IPA.userBaseDn})` : ''));
    if (IPA_LOGIN) {
        const m = accessMode();
        console.log(m === 'list'
            ? `Доступ через каталог: только список допущенных (${usersReg.users.length} запис.) — панель «Пользователи»`
            : 'Доступ через каталог: без ограничения (список допущенных пуст) — добавьте учётки в панели «Пользователи», чтобы закрыть вход остальным');
    }
    const nAcc = accountsReg.accounts.length;
    console.log(nAcc ? `Локальных учётных записей: ${nAcc} (панель «Пользователи»)` : 'Локальных учётных записей нет — вход только встроенной учёткой' + (IPA_LOGIN ? ' и каталогом' : ''));
    console.log(DEPLOY ? `Автодеплой включён: агент ${DEPLOY.url}` : 'Автодеплой выключен (DEPLOY_ENABLED=true для кнопки «Обновить»)');
    console.log(ADMIN_NETS ? `Админка ограничена: ${process.env.ADMIN_ALLOWED_NETS}` : '⚠ ADMIN_ALLOWED_NETS не задан: админка доступна из любой сети');
});

server.requestTimeout = 30 * 60 * 1000;    // большие видео по медленной сети: стандартные 5 минут на запрос не хватит

// Корректная остановка по SIGTERM (docker stop / compose down), чтобы не оборвать запись плейлиста
for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
        console.log(`${sig}: останавливаюсь…`);
        for (const j of jobs.values()) if (j.runner) j.runner.kill();     // не оставляем ffmpeg сиротой (временные файлы очистятся при старте)
        server.close(() => process.exit(0));
        server.closeIdleConnections();
        setTimeout(() => process.exit(1), 8000).unref();
    });
}
