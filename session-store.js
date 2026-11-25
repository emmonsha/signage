// Постоянное хранилище сессий админки.
//
// Зачем: express-session с MemoryStore теряет сессии при каждом перезапуске сервера.
// В Docker контейнер пересоздаётся при обновлении образа/деплое — и все, кто был в админке,
// вылетают на страницу входа. Особенно заметно как «нажал снапшот — выкинуло на логин»:
// 401 от любого запроса в админке вызывает location.reload(), а сервер отдаёт login.html.
//
// Решение без новых зависимостей: сессии лежат в JSON-файле на томе STORAGE_DIR и
// перечитываются при старте. Запись атомарная (tmp + rename) и с дебаунсом, чтобы не
// дёргать диск на каждый запрос.
const fs = require('fs');
const path = require('path');
const session = require('express-session');

const DEFAULTS = { flushMs: 200, ttlMs: 12 * 3600 * 1000 };

class FileStore extends session.Store {
    constructor(file, opts = {}) {
        super();
        this.file = file;
        this.ttlMs = Number(opts.ttlMs) || DEFAULTS.ttlMs;
        this.flushMs = Number(opts.flushMs) || DEFAULTS.flushMs;
        this.data = new Map();          // sid -> { expires, sess }
        this.timer = null;
        this.dirty = false;
        this.load();
    }

    // Чтение с диска при старте. Битый файл не должен валить сервер: старые сессии
    // просто теряются (пользователи один раз войдут заново), сервис поднимается.
    load() {
        try {
            if (!fs.existsSync(this.file)) return;
            const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            const now = Date.now();
            for (const [sid, rec] of Object.entries(raw || {})) {
                if (rec && rec.expires > now && rec.sess) this.data.set(sid, rec);
            }
        } catch (e) {
            console.warn(`Сессии: не удалось прочитать ${this.file} (${e.code || e.message}) — начинаю с пустого списка`);
        }
    }

    scheduleFlush() {
        this.dirty = true;
        if (this.timer) return;
        this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.flushMs);
        if (this.timer.unref) this.timer.unref();   // не держим процесс живым ради записи
    }

    flush() {
        if (!this.dirty) return;
        this.dirty = false;
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
            const now = Date.now();
            const obj = {};
            for (const [sid, rec] of this.data) if (rec.expires > now) obj[sid] = rec;
            const tmp = `${this.file}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
            fs.renameSync(tmp, this.file);   // атомарно: файл всегда валидный
        } catch (e) {
            console.warn(`Сессии: не удалось сохранить ${this.file} (${e.code || e.message})`);
        }
    }

    expiresOf(sess) {
        const c = sess && sess.cookie;
        if (c && c.expires) return new Date(c.expires).getTime();
        if (c && c.maxAge) return Date.now() + Number(c.maxAge);
        return Date.now() + this.ttlMs;
    }

    get(sid, cb) {
        const rec = this.data.get(sid);
        if (!rec) return process.nextTick(() => cb(null, null));
        if (rec.expires <= Date.now()) {
            this.data.delete(sid);
            this.scheduleFlush();
            return process.nextTick(() => cb(null, null));
        }
        // express-session ждёт объект сессии; отдаём копию, чтобы кеш не менялся извне
        process.nextTick(() => cb(null, JSON.parse(rec.sess)));
    }

    set(sid, sess, cb) {
        this.data.set(sid, { expires: this.expiresOf(sess), sess: JSON.stringify(sess) });
        this.scheduleFlush();
        if (cb) process.nextTick(() => cb(null));
    }

    touch(sid, sess, cb) {
        const rec = this.data.get(sid);
        if (rec) {
            rec.expires = this.expiresOf(sess);
            this.scheduleFlush();
        }
        if (cb) process.nextTick(() => cb(null));
    }

    destroy(sid, cb) {
        this.data.delete(sid);
        this.scheduleFlush();
        if (cb) process.nextTick(() => cb(null));
    }

    length(cb) { process.nextTick(() => cb(null, this.data.size)); }

    clear(cb) {
        this.data.clear();
        this.scheduleFlush();
        if (cb) process.nextTick(() => cb(null));
    }

    all(cb) {
        const out = {};
        for (const [sid, rec] of this.data) {
            try { out[sid] = JSON.parse(rec.sess); } catch { /* пропускаем битую запись */ }
        }
        process.nextTick(() => cb(null, out));
    }
}

module.exports = { FileStore };