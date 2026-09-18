import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export function readFile(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok)
            return null;
        return new TextDecoder().decode(bytes);
    } catch {
        return null;
    }
}

// ---------- formatters (estilo Stats) ----------
export function formatSpeed(bps) {
    if (bps == null || Number.isNaN(bps))
        return '--';
    if (bps < 1000)
        return `${Math.round(bps)}B/s`;
    if (bps < 1_000_000) {
        const kb = bps / 1000;
        return kb >= 100 ? `${kb.toFixed(0)}K` : `${kb.toFixed(1).replace(/\.0$/, '')}K`;
    }
    const mb = bps / 1_000_000;
    return mb >= 100 ? `${mb.toFixed(0)}M` : `${mb.toFixed(1).replace(/\.0$/, '')}M`;
}

export function formatBytes(b) {
    if (b == null || Number.isNaN(b))
        return '--';
    const gb = b / 1_000_000_000;
    if (gb >= 100)
        return `${gb.toFixed(0)}GB`;
    if (gb >= 10)
        return `${gb.toFixed(1)}GB`;
    return `${gb.toFixed(2).replace(/0$/, '')}GB`;
}

export function formatRamGB(kb) {
    const gb = kb / 1024 / 1024;
    const num = gb >= 10 ? gb.toFixed(1) : gb.toFixed(2).replace(/0$/, '');
    return `${num}GB`;
}

export function formatTemp(c, unit = 'c') {
    if (c == null || Number.isNaN(c))
        return '--';
    if (unit === 'f')
        return `${Math.round((c * 9) / 5 + 32)}°F`;
    return `${Math.round(c)}°C`;
}

export function formatDuration(sec) {
    if (sec == null || sec <= 0 || !Number.isFinite(sec))
        return '--';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (h > 0)
        return `${h}:${String(m).padStart(2, '0')}`;
    return `${m}min`;
}

export function cleanCpuModel(raw) {
    return (raw ?? '')
        .replace(/\(R\)|\(TM\)/g, '')
        .replace(/\s+@.*$/, '')
        .replace(/\s+/g, ' ')
        .trim();
}

export function cleanGpuModel(raw) {
    return (raw ?? '')
        .replace(/^NVIDIA\s+GeForce\s+/i, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// ---------- CPU ----------
export function parseCpuStat(txt, prev) {
    if (!txt)
        return { result: null, prevNext: prev };
    const line = txt.split('\n').find(l => l.startsWith('cpu '));
    if (!line)
        return { result: null, prevNext: prev };
    const p = line.trim().split(/\s+/).slice(1).map(Number);
    const safe = i => (Number.isNaN(p[i]) ? 0 : p[i]);
    const user = safe(0) + safe(1);
    const sys = safe(2) + safe(5) + safe(6);
    const idle = safe(3) + safe(4);
    const total = p.reduce((a, b) => a + (Number.isNaN(b) ? 0 : b), 0);
    const cur = { user, sys, idle, total };
    if (!prev || total - prev.total <= 0)
        return { result: null, prevNext: cur };
    const dTotal = total - prev.total;
    const pct = Math.max(0, Math.min(100, ((dTotal - (idle - prev.idle)) / dTotal) * 100));
    return {
        result: {
            pct,
            userPct: Math.max(0, Math.min(100, ((user - prev.user) / dTotal) * 100)),
            sysPct: Math.max(0, Math.min(100, ((sys - prev.sys) / dTotal) * 100)),
            idlePct: Math.max(0, Math.min(100, ((idle - prev.idle) / dTotal) * 100)),
        },
        prevNext: cur,
    };
}

export function readCpuDetail(prev) {
    const { result, prevNext } = parseCpuStat(readFile('/proc/stat'), prev);
    if (!result)
        return { result: null, prevNext };
    // load + freq
    let load1 = null;
    const lavg = readFile('/proc/loadavg');
    if (lavg) {
        const v = parseFloat(lavg.split(/\s+/)[0]);
        if (!Number.isNaN(v))
            load1 = v;
    }
    let freqGHz = null;
    const cpuinfo = readFile('/proc/cpuinfo');
    if (cpuinfo) {
        const m = cpuinfo.match(/^cpu MHz\s+:\s+([\d.]+)$/m);
        if (m) {
            const mhz = parseFloat(m[1]);
            if (!Number.isNaN(mhz))
                freqGHz = mhz / 1000;
        }
    }
    return { result: { ...result, load1, freqGHz }, prevNext };
}

export function readCpuModel() {
    const txt = readFile('/proc/cpuinfo');
    if (!txt)
        return null;
    const m = txt.match(/^model name\s+:\s+(.+)$/m);
    return m ? cleanCpuModel(m[1]) : null;
}

// ---------- RAM ----------
export function parseMemInfo(txt) {
    if (!txt)
        return null;
    const get = name => {
        const m = txt.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'));
        return m ? parseInt(m[1], 10) : null;
    };
    const total = get('MemTotal');
    const avail = get('MemAvailable');
    const swapTotal = get('SwapTotal') ?? 0;
    const swapFree = get('SwapFree') ?? 0;
    if (!total || avail === null)
        return null;
    const used = total - avail;
    let pressure = 'baixa';
    const ptxt = readFile('/proc/pressure/memory');
    if (ptxt) {
        const m = ptxt.match(/^some\s+avg10=([\d.]+)/m);
        if (m) {
            const v = parseFloat(m[1]);
            if (!Number.isNaN(v))
                pressure = v > 20 ? 'alta' : v > 5 ? 'média' : 'baixa';
        }
    }
    return {
        usedKb: used, totalKb: total, pct: (used / total) * 100,
        swapUsedKb: swapTotal - swapFree, swapTotalKb: swapTotal,
        pressure,
    };
}

export function readRamDetail() {
    return parseMemInfo(readFile('/proc/meminfo'));
}

// ---------- Rede (/proc/net/dev) ----------
const NET_SKIP = /^(lo|virbr|docker|veth|br-|tun|tap)/;

export function parseNetDev(txt) {
    const out = {};
    if (!txt)
        return out;
    for (const line of txt.split('\n')) {
        const m = line.match(/^\s*([^:]+):\s*(.+)$/);
        if (!m)
            continue;
        const iface = m[1].trim();
        if (NET_SKIP.test(iface))
            continue;
        const f = m[2].trim().split(/\s+/).map(Number);
        if (f.length < 16)
            continue;
        out[iface] = { rx: f[0], tx: f[8] };
    }
    return out;
}

export function defaultIface(candidates) {
    // prefere default route, senão primeira ativa não-wireless virtual
    const route = readFile('/proc/net/route');
    if (route) {
        for (const line of route.split('\n').slice(1)) {
            const f = line.trim().split(/\s+/);
            if (f.length >= 4 && f[1] === '00000000' && candidates[f[0]] !== undefined)
                return f[0];
        }
    }
    const keys = Object.keys(candidates);
    return keys.length ? keys[0] : null;
}

export function readLocalIp() {
    // rápido e síncrono via hostname; fallback null
    try {
        const proc = Gio.Subprocess.new(
            ['hostname', '-I'],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
        );
        const [, out] = proc.communicate_utf8(null, null);
        const ip = (out ?? '').trim().split(/\s+/)[0];
        return ip || null;
    } catch {
        return null;
    }
}

// ---------- Disco ----------
export function readDiskUsage(mount = '/') {
    try {
        const f = Gio.File.new_for_path(mount);
        const info = f.query_filesystem_info('filesystem::*', null);
        const total = Number(info.get_attribute_uint64('filesystem::size'));
        const free = Number(info.get_attribute_uint64('filesystem::free'));
        if (!total)
            return null;
        const used = total - free;
        return { usedB: used, totalB: total, pct: (used / total) * 100 };
    } catch {
        return null;
    }
}

export function parseDiskstats(txt, dev = null) {
    // soma sda/nvme0n1... (partições ignoradas: termina em dígito p/ sd, pN p/ nvme)
    if (!txt)
        return null;
    let rSec = 0, wSec = 0;
    for (const line of txt.split('\n')) {
        const f = line.trim().split(/\s+/);
        if (f.length < 14)
            continue;
        const name = f[2];
        if (dev && name !== dev)
            continue;
        if (!dev && (/^loop/.test(name) || /^ram/.test(name) || /^dm-/.test(name)))
            continue;
        if (!dev && (/^sd[a-z]$/.test(name) || /^nvme\d+n\d+$/.test(name) || /^mmcblk\d+$/.test(name) || /^vd[a-z]$/.test(name)))
            { rSec += Number(f[5]) || 0; wSec += Number(f[9]) || 0; }
        else if (!dev && (/^sd[a-z]\d+$/.test(name) || /^nvme\d+n\d+p\d+$/.test(name)))
            continue;
        else if (dev)
            { rSec += Number(f[5]) || 0; wSec += Number(f[9]) || 0; }
    }
    return { rBytes: rSec * 512, wBytes: wSec * 512 };
}

// ---------- Sensores (hwmon scan com cache) ----------
export function scanHwmon() {
    const cache = { cpu: null, gpu: null, ssd: null, fan: null, volt: null, power: null };
    try {
        const dir = Gio.File.new_for_path('/sys/class/hwmon');
        const en = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        const hwmons = [];
        while ((info = en.next_file(null)))
            hwmons.push(`/sys/class/hwmon/${info.get_name()}`);
        en.close(null);

        const readTemp = base => {
            for (let i = 1; i <= 8; i++) {
                const label = (readFile(`${base}/temp${i}_label`) ?? '').toLowerCase();
                const val = parseFloat(readFile(`${base}/temp${i}_input`) ?? '');
                if (Number.isNaN(val))
                    continue;
                const c = val / 1000;
                if (/package|core|tctl|tdie|cpu/.test(label) && !cache.cpu)
                    cache.cpu = { path: `${base}/temp${i}_input`, label };
                if (/gpu|edge|junction/.test(label) && !cache.gpu)
                    cache.gpu = { path: `${base}/temp${i}_input`, label };
                if (/composite|nvme|ssd/.test(label) && !cache.ssd)
                    cache.ssd = { path: `${base}/temp${i}_input`, label };
                if (!cache.cpu && i === 1)
                    cache._fallback = cache._fallback || { path: `${base}/temp${i}_input` };
            }
        };
        for (const h of hwmons) {
            readTemp(h);
            if (!cache.fan) {
                for (let i = 1; i <= 4; i++) {
                    if (readFile(`${h}/fan${i}_input`) !== null) {
                        cache.fan = { path: `${h}/fan${i}_input` };
                        break;
                    }
                }
            }
            if (!cache.volt) {
                for (let i = 1; i <= 4; i++) {
                    if (readFile(`${h}/in${i}_input`) !== null) {
                        cache.volt = { path: `${h}/in${i}_input` };
                        break;
                    }
                }
            }
            if (!cache.power) {
                for (let i = 1; i <= 4; i++) {
                    if (readFile(`${h}/power${i}_input`) !== null) {
                        cache.power = { path: `${h}/power${i}_input` };
                        break;
                    }
                }
            }
            const name = (readFile(`${h}/name`) ?? '').trim();
            if (/nvme/.test(name) && !cache.ssd) {
                const v = parseFloat(readFile(`${h}/temp1_input`) ?? '');
                if (!Number.isNaN(v))
                    cache.ssd = { path: `${h}/temp1_input`, label: name };
            }
        }
        if (!cache.cpu && cache._fallback)
            cache.cpu = cache._fallback;
        delete cache._fallback;
    } catch {
        // sem hwmon — retorna nulls
    }
    return cache;
}

export function readSensorsDetail(cache) {
    if (!cache)
        return { cpuC: null, gpuC: null, ssdC: null, fanRpm: null, voltV: null, powerW: null };
    const t = p => {
        if (!p)
            return null;
        const v = parseFloat((readFile(p) ?? '').trim());
        return Number.isNaN(v) ? null : v / 1000;
    };
    const num = p => {
        if (!p)
            return null;
        const v = parseFloat((readFile(p) ?? '').trim());
        return Number.isNaN(v) ? null : v;
    };
    const powerRaw = cache.power ? num(cache.power.path) : null;
    return {
        cpuC: t(cache.cpu?.path),
        gpuC: t(cache.gpu?.path),
        ssdC: t(cache.ssd?.path),
        fanRpm: cache.fan ? num(cache.fan.path) : null,
        voltV: cache.volt ? (num(cache.volt.path) ?? null) / 1000 : null,
        powerW: powerRaw != null ? powerRaw / 1_000_000 : null,
    };
}

// ---------- Top processos ----------
export function topProcesses(n = 5, sortBy = 'cpu') {
    const procs = [];
    try {
        const procDir = Gio.File.new_for_path('/proc');
        const en = procDir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        const clkTck = 100;
        let cpuCount = 1;
        const cpuinfo = readFile('/proc/cpuinfo');
        if (cpuinfo)
            cpuCount = (cpuinfo.match(/^processor\s+:/gm) || []).length || 1;
        while ((info = en.next_file(null))) {
            const name = info.get_name();
            if (!/^\d+$/.test(name))
                continue;
            if (procs.length > 512)
                break;
            const stat = readFile(`/proc/${name}/stat`);
            const status = readFile(`/proc/${name}/status`);
            const commM = stat ? stat.match(/^\d+\s+\((.+)\)\s+(.*)$/) : null;
            if (!commM)
                continue;
            const comm = commM[1];
            const rest = commM[2].trim().split(/\s+/);
            const utime = Number(rest[11]) || 0;
            const stime = Number(rest[12]) || 0;
            let memKb = 0;
            if (status) {
                const m = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
                if (m)
                    memKb = parseInt(m[1], 10);
            }
            procs.push({ pid: name, comm, cpuTicks: utime + stime, memKb, cpuCount });
        }
        en.close(null);
    } catch {
        return [];
    }
    if (sortBy === 'mem')
        procs.sort((a, b) => b.memKb - a.memKb);
    else
        procs.sort((a, b) => b.cpuTicks - a.cpuTicks);
    return procs.slice(0, n);
}

// cpu% aproximado do top precisa de 2 amostras; helper simples: usa ticks normalizados
export function topCpuPct(list, prevMap, dtSec, cpuCount = 1) {
    const clkTck = 100;
    return list.map(p => {
        const prev = prevMap[p.pid];
        let pct = 0;
        if (prev != null && dtSec > 0)
            pct = Math.max(0, Math.min(100 * cpuCount, ((p.cpuTicks - prev) / clkTck / dtSec) * 100));
        return { ...p, pct };
    });
}
