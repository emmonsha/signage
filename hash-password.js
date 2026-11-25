#!/usr/bin/env node
// Генерация хэша пароля админки:  npm run hash-password   (или: echo -n 'пароль' | node hash-password.js)
// Результат (одна строка ADMIN_PASSWORD_HASH=...) выводится в stdout, подсказки — в stderr.
const { hashPassword } = require('./auth');

function readHidden(prompt) {
    return new Promise(resolve => {
        process.stderr.write(prompt);
        const stdin = process.stdin;
        let buf = '';
        stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
        const onData = chunk => {
            for (const ch of chunk) {
                if (ch === '\r' || ch === '\n') {
                    stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData);
                    process.stderr.write('\n');
                    return resolve(buf);
                }
                if (ch === '\u0003') { process.stderr.write('\n'); process.exit(130); }   // Ctrl+C
                if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
                else if (ch >= ' ') buf += ch;
            }
        };
        stdin.on('data', onData);
    });
}

async function readStdin() {
    let s = '';
    for await (const c of process.stdin) s += c;
    return s.replace(/\r?\n$/, '');
}

(async () => {
    let pw;
    if (process.stdin.isTTY) {
        pw = await readHidden('Пароль: ');
        if (pw !== await readHidden('Повторите пароль: ')) { console.error('Пароли не совпадают'); process.exit(1); }
    } else {
        pw = await readStdin();
    }
    if (pw.length < 10) { console.error('Слишком короткий пароль: минимум 10 символов (лучше длинная фраза)'); process.exit(1); }
    console.log('ADMIN_PASSWORD_HASH=' + await hashPassword(pw));
})();
