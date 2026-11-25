// Белый список сетей для админки: ADMIN_ALLOWED_NETS="192.168.0.0/16,10.0.0.0/8,127.0.0.1"
const net = require('net');

// Возвращает функцию ip => boolean, либо null, если список пуст (ограничение выключено)
function buildMatcher(spec) {
    const items = String(spec || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!items.length) return null;
    const list = new net.BlockList();
    for (const it of items) {
        const [addr, prefix] = it.split('/');
        const fam = net.isIPv4(addr) ? 'ipv4' : net.isIPv6(addr) ? 'ipv6' : null;
        if (!fam) throw new Error(`ADMIN_ALLOWED_NETS: неверный адрес "${it}"`);
        if (prefix === undefined) { list.addAddress(addr, fam); continue; }
        const p = Number(prefix);
        if (!Number.isInteger(p) || p < 0 || p > (fam === 'ipv4' ? 32 : 128))
            throw new Error(`ADMIN_ALLOWED_NETS: неверная маска в "${it}"`);
        list.addSubnet(addr, p, fam);
    }
    return ip => {
        ip = String(ip || '').replace(/^::ffff:/i, '');           // IPv4, пришедший через IPv6-сокет
        const fam = net.isIPv4(ip) ? 'ipv4' : net.isIPv6(ip) ? 'ipv6' : null;
        return fam ? list.check(ip, fam) : false;
    };
}

module.exports = { buildMatcher };
