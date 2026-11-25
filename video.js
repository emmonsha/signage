// Видео для BrightSign: проверка (ffprobe) и конвертация (ffmpeg) в MP4 — H.264 High@4.2, yuv420p, 1920x1080, AAC.
const { execFile, spawn } = require('child_process');
const os = require('os');
const { UserError } = require('./processor');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const W = 1920, H = 1080, RATIO = W / H;
const MAX_FPS = Number(process.env.VIDEO_MAX_FPS) || 60;                // потолок частоты кадров
const MAX_SECONDS = Number(process.env.MAX_VIDEO_SECONDS) || 900;       // максимальная длина ролика
const CRF = String(process.env.VIDEO_CRF || 20);                        // качество x264 (меньше = лучше и тяжелее)
const PRESET = process.env.VIDEO_PRESET || 'medium';
const VIDEO_EXTS = /\.(mp4|m4v|mov|mkv|webm|avi|mpg|mpeg|wmv|flv|ts|mts|m2ts)$/i;

const run = (cmd, args, timeout = 30000) => new Promise((ok, fail) =>
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, out) => err ? fail(err) : ok(out)));

// ffmpeg и ffprobe доступны?
async function available() {
    try { await run(FFMPEG, ['-version'], 10000); await run(FFPROBE, ['-version'], 10000); return true; }
    catch { return false; }
}

const frac = s => { const [a, b] = String(s || '0/1').split('/').map(Number); return b ? a / b : 0; };

async function probeVideo(file) {
    let json;
    try { json = JSON.parse(await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file])); }
    catch { throw new UserError('Не удалось прочитать видео (формат не поддерживается или файл повреждён)'); }

    const v = (json.streams || []).find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
    if (!v) throw new UserError('В файле нет видеодорожки');

    // поворот из метаданных (съёмка телефоном): ширина и высота меняются местами
    const rotRaw = (v.side_data_list || []).map(d => d.rotation).find(r => r !== undefined) ?? (v.tags && v.tags.rotate) ?? 0;
    const rotated = Math.abs(Number(rotRaw)) % 180 === 90;
    const duration = Number(json.format && json.format.duration) || Number(v.duration) || 0;
    if (!(duration >= 0.5)) throw new UserError('Слишком короткий ролик (или это не видео)');
    if (duration > MAX_SECONDS) throw new UserError(`Ролик длиннее ${MAX_SECONDS >= 120 ? Math.round(MAX_SECONDS / 60) + ' мин' : MAX_SECONDS + ' с'} (ограничение сервера)`);

    return {
        width: rotated ? v.height : v.width, height: rotated ? v.width : v.height,
        fps: frac(v.avg_frame_rate) || frac(v.r_frame_rate) || 30,
        duration,
        hasAudio: (json.streams || []).some(s => s.codec_type === 'audio'),
        interlaced: ['tt', 'bb', 'tb', 'bt'].includes(v.field_order),
        hdr: ['smpte2084', 'arib-std-b67'].includes(v.color_transfer),
    };
}

// Решаем, что делать, и собираем предупреждения для пользователя. mode: fit | crop | reject
function planVideo(info, mode = 'fit') {
    const { width: w, height: h } = info, warnings = [];
    const scale = mode === 'crop' ? Math.max(W / w, H / h) : Math.min(W / w, H / h);
    if (scale > 1.01) warnings.push(`разрешение ${w}×${h} ниже нужного — видео увеличено в ${scale.toFixed(1)}×, может выглядеть мягким`);
    if (Math.abs(w / h / RATIO - 1) > 0.01) {
        if (mode === 'reject') throw new UserError(`Пропорции должны быть 16:9, а у видео ${w}×${h}`);
        warnings.push(mode === 'crop' ? `пропорции ${w}×${h} не 16:9 — края обрезаны по центру`
                                      : `пропорции ${w}×${h} не 16:9 — добавлены чёрные поля`);
    }
    let fps = Math.round(info.fps * 1000) / 1000;
    if (fps > MAX_FPS) { warnings.push(`частота ${Math.round(info.fps)} кадр/с снижена до ${MAX_FPS}`); fps = MAX_FPS; }
    if (info.interlaced) warnings.push('чересстрочное видео: применён деинтерлейсинг');
    if (info.hdr) warnings.push('HDR-видео: цвета при конвертации в SDR могут выглядеть блёклыми');
    return { fps, warnings };
}

function buildArgs(info, { mode, fps, sound }, input, output) {
    const vf = [];
    if (info.interlaced) vf.push('yadif=mode=0:deint=1');
    vf.push(`fps=${fps}`);                                          // постоянная частота кадров (у телефонных роликов она плавает)
    const fitScale = `scale=${W}:${H}:flags=lanczos:out_color_matrix=bt709`;
    vf.push(mode === 'crop'
        ? `${fitScale}:force_original_aspect_ratio=increase,crop=${W}:${H}`
        : `${fitScale}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`);
    vf.push('setsar=1', 'format=yuv420p');
    const audio = sound && info.hasAudio;
    return ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-i', input,
        '-map', '0:v:0', ...(audio ? ['-map', '0:a:0'] : []),
        '-vf', vf.join(','),
        '-c:v', 'libx264', '-preset', PRESET, '-profile:v', 'high', '-level:v', '4.2', '-crf', CRF,
        '-maxrate', '16M', '-bufsize', '32M', '-g', String(Math.round(fps * 2)), '-pix_fmt', 'yuv420p',
        '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
        ...(audio ? ['-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000'] : ['-an']),
        ...(process.env.VIDEO_THREADS ? ['-threads', String(parseInt(process.env.VIDEO_THREADS) || 0)] : []),
        '-movflags', '+faststart',                                  // moov в начале файла: старт без ожидания и перемотка
        '-f', 'mp4', '-progress', 'pipe:1', '-nostats', output];
}

// Запуск ffmpeg: { promise, kill }. onProgress получает 0..99
function transcode(args, durationSec, onProgress) {
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    try { os.setPriority(child.pid, 10); } catch { /* не критично */ }   // пониже приоритет, чтобы админка не тормозила

    let errTail = '', buf = '';
    child.stderr.on('data', d => { errTail = (errTail + d).slice(-2000); });
    child.stdout.on('data', d => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const m = /^out_time_(?:us|ms)=(\d+)/.exec(buf.slice(0, i).trim());   // оба поля у ffmpeg в микросекундах
            buf = buf.slice(i + 1);
            if (m) onProgress(Math.min(99, Number(m[1]) / 1e6 / durationSec * 100));
        }
    });
    const promise = new Promise((ok, fail) => {
        child.on('error', e => fail(new Error(e.code === 'ENOENT' ? 'ffmpeg не найден' : e.message)));
        child.on('close', code => {
            if (code === 0) return ok();
            // в хвосте stderr самая полезная строка обычно не последняя: берём первую с «error/unknown/invalid…»
            const lines = errTail.trim().split('\n').filter(Boolean);
            const best = lines.find(l => /error|unknown|invalid|unsupported|no such|cannot|fail/i.test(l)) || lines.pop();
            fail(new Error(best ? best.replace(/^\[[^\]]*\]\s*/, '') : `ffmpeg завершился с кодом ${code}`));
        });
    });
    return { promise, kill: () => child.kill('SIGKILL') };
}

module.exports = { available, probeVideo, planVideo, buildArgs, transcode, VIDEO_EXTS, MAX_SECONDS };
