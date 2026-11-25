// Приведение загружаемых файлов к требованиям BrightSign: 1920x1080, sRGB, без прозрачности и метаданных.
const sharp = require('sharp');

const W = 1920, H = 1080, RATIO = W / H;
const MAX_PDF_PAGES = parseInt(process.env.MAX_PDF_PAGES) || 50;
const MAX_PNG_BYTES = 8 * 1024 * 1024;       // PNG тяжелее — сохраняем как JPEG q92
const LIMIT_PIXELS = 200e6;                   // защита от "бомб" (огромных изображений)

class UserError extends Error { constructor(msg) { super(msg); this.user = true; } }

// input: путь к файлу или Buffer; mode: fit (чёрные поля) | crop (обрезать по центру) | reject (отклонить)
async function processImage(input, mode = 'fit') {
    let meta;
    try { meta = await sharp(input, { limitInputPixels: LIMIT_PIXELS }).metadata(); }
    catch { throw new UserError('Не удалось прочитать изображение (нужен PNG, JPG или PDF)'); }
    if (!['png', 'jpeg'].includes(meta.format)) throw new UserError('Поддерживаются только PNG, JPG и PDF');

    const swap = meta.orientation >= 5;       // EXIF-поворот меняет ширину и высоту местами
    const sw = swap ? meta.height : meta.width, sh = swap ? meta.width : meta.height;
    const warnings = [];

    // предупреждаем, только если картинку реально приходится увеличивать (учитывая режим вписывания)
    const scale = mode === 'crop' ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
    if (scale > 1.01)
        warnings.push(`разрешение ${sw}×${sh} ниже нужного — изображение увеличено в ${scale.toFixed(1)}×, может выглядеть мягким`);
    if (Math.abs(sw / sh / RATIO - 1) > 0.01) {
        if (mode === 'reject') throw new UserError(`Пропорции должны быть 16:9, а у файла ${sw}×${sh}`);
        warnings.push(mode === 'crop'
            ? `пропорции ${sw}×${sh} не 16:9 — края обрезаны по центру`
            : `пропорции ${sw}×${sh} не 16:9 — добавлены чёрные поля`);
    }

    const pipe = () => sharp(input, { limitInputPixels: LIMIT_PIXELS })
        .rotate()                                                   // применить EXIF-ориентацию
        .flatten({ background: '#000000' })                         // прозрачность -> чёрный
        .resize(W, H, { fit: mode === 'crop' ? 'cover' : 'contain', position: 'centre',
                        background: '#000000', kernel: 'lanczos3' })
        .toColourspace('srgb');                                     // метаданные/профили не сохраняются

    let buffer = await pipe().png({ compressionLevel: 9 }).toBuffer(), ext = '.png';
    if (buffer.length > MAX_PNG_BYTES) {
        buffer = await pipe().jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer();
        ext = '.jpg';
    }
    return { buffer, ext, warnings };
}

// Открыть PDF: каждая страница потом отдаётся как PNG-буфер (for await ... of doc)
async function openPdf(file) {
    const { pdf } = await import('pdf-to-img');                     // пакет ESM, поэтому import()
    let doc;
    try { doc = await pdf(file, { scale: 3 }); }
    catch { throw new UserError('Не удалось прочитать PDF (файл повреждён или защищён паролем)'); }
    if (doc.length > MAX_PDF_PAGES) throw new UserError(`В PDF ${doc.length} стр., максимум ${MAX_PDF_PAGES}`);
    return doc;
}

module.exports = { processImage, openPdf, UserError, MAX_PDF_PAGES };
