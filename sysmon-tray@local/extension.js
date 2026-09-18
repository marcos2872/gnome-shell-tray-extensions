import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Cairo from 'cairo';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';

import { Ring } from './history.js';
import {
  readFile, formatSpeed, formatBytes, formatRamGB, formatTemp, formatDuration,
  cleanCpuModel, cleanGpuModel, readCpuDetail, readCpuModel, readRamDetail,
  parseNetDev, defaultIface, readLocalIp, readDiskUsage, parseDiskstats,
  scanHwmon, readSensorsDetail, topProcesses, topCpuPct, readPerCore,
} from './collectors.js';
import {
  hexToRgb, secTitle, detailRow, topRow, mkOptRow as mkCardOptRow,
  paintBar, paintCores,
} from './cards.js';

const MAX_POINTS = 120; // 2 min @ 1s
const COLORS = {
  cpu: '#3584e4', gpu: '#9a59b6', ram: '#e5a50a', net: '#2ec27e',
  disk: '#e479ff', sensors: '#ff6b6b', battery: '#33d17a',
};
// Ordem dos módulos no tray e nas abas
const ORDER = ['cpu', 'gpu', 'ram', 'net', 'disk', 'sensors', 'battery'];
const TAB_TITLES = {
  cpu: 'CPU', gpu: 'GPU', ram: 'RAM', net: 'NET',
  disk: 'DSK', sensors: 'TMP', battery: 'BAT',
};

// UPower states: 1 charging, 2 discharging, 3 empty, 4 full, 5 pending-charge, 6 pending-discharge
function batteryStateLabel(state) {
  switch (state) {
    case 1: return 'Carregando';
    case 2: return 'Descarregando';
    case 4: return 'Cheia';
    case 3: return 'Vazia';
    default: return '--';
  }
}

export default class SysMonTrayExtension extends Extension {
  enable() {
    this._settings = this.getSettings();
    this._hist = {
      cpu: new Ring(MAX_POINTS), gpu: new Ring(MAX_POINTS), ram: new Ring(MAX_POINTS),
      netDown: new Ring(MAX_POINTS), netUp: new Ring(MAX_POINTS),
      disk: new Ring(MAX_POINTS), temp: new Ring(MAX_POINTS), batt: new Ring(MAX_POINTS),
    };
    this._prevCpu = null;
    this._prevCores = null;
    this._prevNet = null;
    this._prevNetTime = 0;
    this._prevDisk = null;
    this._prevDiskTime = 0;
    this._prevTopMap = {};
    this._prevTopTime = 0;
    this._gpuValue = null;
    this._gpuBusy = false;
    this._netTotals = { down: 0, up: 0 };
    this._timeoutId = 0;

    this._detectGpu();
    this._cpuModel = readCpuModel();
    this._gpuModel = null;
    this._queryGpuModel();
    this._hwmon = scanHwmon();
    this._localIp = null;
    this._upower = this._connectUpower();
    this._btDevices = [];

    // --- Tray misto estilo Stats: 1 botão por módulo; clicar abre o popup
    // direto naquele módulo (as abas continuam para trocar a visualização)
    this._buttons = {};
    this._slots = {};
    this._sections = {};
    this._pages = {};
    this._tabBtns = {};
    this._openMenu = null;
    this._refreshSliders = [];
    this._refreshValueLabels = [];
    this._sideLabels = [];
    this._segLeftBtns = [];
    this._segRightBtns = [];
    this._mkAllSlots();
    this._buildPages();
    this._buildIndicators();

    this._applySide(this._traySide(), true);
    this._applyVisibility();

    this._settingsChangedIds = [
      this._settings.connect('changed::refresh', () => this._restartTimer()),
      this._settings.connect('changed::refresh', () => {
        const s = this._refreshSecs();
        for (const sl of this._refreshSliders ?? [])
          sl.value = (s - 1) / 4;
        for (const l of this._refreshValueLabels ?? [])
          l.text = `${s}s`;
      }),
      this._settings.connect('changed::show-cpu', () => this._applyVisibility()),
      this._settings.connect('changed::show-gpu', () => this._applyVisibility()),
      this._settings.connect('changed::show-ram', () => this._applyVisibility()),
      this._settings.connect('changed::show-net', () => this._applyVisibility()),
      this._settings.connect('changed::show-disk', () => this._applyVisibility()),
      this._settings.connect('changed::show-sensors', () => this._applyVisibility()),
      this._settings.connect('changed::show-battery', () => this._applyVisibility()),
    ];
    this._restartTimer();
    this._tick(); // primeira leitura imediata
  }

  disable() {
    if (this._timeoutId) {
      GLib.Source.remove(this._timeoutId);
      this._timeoutId = 0;
    }
    for (const id of this._settingsChangedIds ?? [])
      this._settings?.disconnect(id);
    this._settingsChangedIds = [];
    this._settings = null;
    for (const btn of Object.values(this._buttons ?? {}))
      btn?.destroy();
    this._buttons = {};
    this._slots = {};
    this._sections = {};
    this._pages = {};
    this._openMenu = null;
    this._refreshSliders = [];
    this._refreshValueLabels = [];
    this._sideLabels = [];
    this._segLeftBtns = [];
    this._segRightBtns = [];
    this._hist = {};
    this._prevCpu = null;
    this._prevCores = null;
    this._gpuValue = null;
    this._upower = null;
  }

  // ---------- visibilidade por módulo ----------
  _show(key) {
    try {
      return this._settings.get_boolean(`show-${key}`);
    } catch {
      return true;
    }
  }

  _applyVisibility() {
    for (const key of ORDER) {
      if (this._buttons[key])
        this._buttons[key].visible = this._show(key);
      this._applyGraphMode(key);
    }
    for (const [key, t] of Object.entries(this._trayToggles ?? {})) {
      const on = this._show(key);
      if (t.btn.get_checked() !== on)
        t.sync(on);
    }
  }

  // Toggle Gráfico: ON = gráfico na linha do meio; OFF = valor na linha do meio.
  // Letras verticais sempre visíveis. O gráfico da aba do modal é sempre visível.
  _applyGraphMode(key) {
    const on = this._graph(key);
    const s = this._slots[key];
    if (s) {
      s.val.visible = !on;
      s.mini.visible = on;
      if (s.numRow)
        s.numRow.visible = true;
      if (s.graphLabel)
        s.graphLabel.visible = false;
      if (on)
        s.mini.queue_repaint();
    }
  }

  // ---------- GPU genérico ----------
  _detectGpu() {
    this._gpuBackend = 'none';
    this._gpuSysfsPath = null;
    this._gpuIntelCur = null;
    this._gpuIntelMax = null;

    if (GLib.find_program_in_path('nvidia-smi')) {
      this._gpuBackend = 'nvidia';
      return;
    }
    for (let i = 0; i < 4; i++) {
      const p = `/sys/class/drm/card${i}/device/gpu_busy_percent`;
      if (readFile(p) !== null) {
        this._gpuBackend = 'amd';
        this._gpuSysfsPath = p;
        return;
      }
    }
    const curCandidates = [
      '/sys/class/drm/card0/gt_cur_freq_mhz',
      '/sys/class/drm/card1/gt_cur_freq_mhz',
      '/sys/class/drm/card0/gt/gt0/cur_freq_mhz',
      '/sys/class/drm/card1/gt/gt0/cur_freq_mhz',
    ];
    const maxCandidates = [
      '/sys/class/drm/card0/gt_max_freq_mhz',
      '/sys/class/drm/card1/gt_max_freq_mhz',
      '/sys/class/drm/card0/gt/gt0/rps_max_freq_mhz',
      '/sys/class/drm/card1/gt/gt0/rps_max_freq_mhz',
      '/sys/class/drm/card0/gt/gt0/max_freq_mhz',
      '/sys/class/drm/card1/gt/gt0/max_freq_mhz',
    ];
    const cur = curCandidates.find(p => readFile(p) !== null);
    const max = maxCandidates.find(p => readFile(p) !== null);
    if (cur && max) {
      this._gpuBackend = 'intel';
      this._gpuIntelCur = cur;
      this._gpuIntelMax = max;
    }
  }

  _queryGpuModel() {
    if (this._gpuBackend === 'nvidia') {
      try {
        const proc = Gio.Subprocess.new(
          ['nvidia-smi', '--query-gpu=name', '--format=csv,noheader'],
          Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
        );
        proc.communicate_utf8_async(null, null, (p, res) => {
          try {
            const [, out] = p.communicate_utf8_finish(res);
            const name = cleanGpuModel((out ?? '').split('\n')[0]);
            if (name) {
              this._gpuModel = name;
              if (this._gpuNameLabel)
                this._gpuNameLabel.text = name;
            }
          } catch (e) {
            logError(e, '[sysmon-tray] nvidia-smi name');
          }
        });
      } catch (e) {
        logError(e, '[sysmon-tray] nvidia name spawn');
      }
    } else if (this._gpuBackend === 'amd') {
      this._gpuModel = 'AMD GPU';
    } else if (this._gpuBackend === 'intel') {
      this._gpuModel = 'Intel GPU';
    }
  }

  _pollGpu() {
    if (this._gpuBackend === 'nvidia') {
      if (this._gpuBusy)
        return;
      this._gpuBusy = true;
      try {
        const proc = Gio.Subprocess.new(
          ['nvidia-smi', '--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits'],
          Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
        );
        proc.communicate_utf8_async(null, null, (p, res) => {
          try {
            const [, out] = p.communicate_utf8_finish(res);
            const f = (out ?? '').split(',').map(s => parseFloat(s.trim()));
            if (!Number.isNaN(f[0]))
              this._gpuValue = Math.max(0, Math.min(100, f[0]));
            if (!Number.isNaN(f[1]) && !Number.isNaN(f[2]))
              this._gpuMem = { usedMiB: f[1], totalMiB: f[2] };
            if (!Number.isNaN(f[3]))
              this._gpuTemp = f[3];
          } catch (e) {
            logError(e, '[sysmon-tray] nvidia-smi');
          } finally {
            this._gpuBusy = false;
            this._afterGpuRead();
          }
        });
      } catch (e) {
        logError(e, '[sysmon-tray] nvidia spawn');
        this._gpuBusy = false;
      }
      return;
    }
    if (this._gpuBackend === 'amd' && this._gpuSysfsPath) {
      const v = parseInt((readFile(this._gpuSysfsPath) ?? '').trim(), 10);
      if (!Number.isNaN(v))
        this._gpuValue = Math.max(0, Math.min(100, v));
    } else if (this._gpuBackend === 'intel') {
      const cur = parseFloat((readFile(this._gpuIntelCur) ?? '').trim());
      const max = parseFloat((readFile(this._gpuIntelMax) ?? '').trim());
      if (cur > 0 && max > 0)
        this._gpuValue = Math.max(0, Math.min(100, Math.round((cur / max) * 100)));
    }
    this._afterGpuRead();
  }

  _afterGpuRead() {
    if (this._gpuValue === null || this._gpuValue === undefined)
      return;
    this._hist.gpu.push(this._gpuValue);
    this._setSlot('gpu', `${Math.round(this._gpuValue)}%`);
    this._slots.gpu?.mini.queue_repaint();
    if (this._gpuValueLabel)
      this._gpuValueLabel.text = `${Math.round(this._gpuValue)}%`;
    this._sections?.gpu?.graph?.queue_repaint();
    this._updateGpuDetails();
  }

  // ---------- UPower ----------
  _connectUpower() {
    try {
      const proxy = Gio.DBusProxy.new_for_bus_sync(
        Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
        'org.freedesktop.UPower', '/org/freedesktop/UPower/devices/DisplayDevice',
        'org.freedesktop.UPower.Device', null
      );
      return proxy;
    } catch {
      return null;
    }
  }

  _readBattery() {
    if (!this._upower)
      return null;
    try {
      const pct = this._upower.get_cached_property('Percentage')?.unpack() ?? null;
      const state = this._upower.get_cached_property('State')?.unpack() ?? 0;
      const tte = this._upower.get_cached_property('TimeToEmpty')?.unpack() ?? 0;
      const ttf = this._upower.get_cached_property('TimeToFull')?.unpack() ?? 0;
      const capacity = this._upower.get_cached_property('Capacity')?.unpack() ?? null;
      if (pct === null)
        return null;
      const timeSec = state === 1 ? ttf : tte;
      return { pct, state, timeSec, capacity };
    } catch {
      return null;
    }
  }

  _queryBtDevices() {
    // enumera dispositivos UPower com bateria (teclado/mouse/fone) — async, barato
    try {
      const conn = Gio.bus_get_sync(Gio.BusType.SYSTEM, null);
      conn.call(
        'org.freedesktop.UPower', '/org/freedesktop/UPower', 'org.freedesktop.UPower',
        'EnumerateDevices', null, null, Gio.DBusCallFlags.NONE, -1, null,
        (c, res) => {
          try {
            const [paths] = c.call_finish(res).deep_unpack();
            const found = [];
            for (const p of paths.slice(0, 12)) {
              try {
                const px = Gio.DBusProxy.new_for_bus_sync(
                  Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
                  'org.freedesktop.UPower', p, 'org.freedesktop.UPower.Device', null
                );
                const type = px.get_cached_property('Type')?.unpack() ?? 0;
                const pct = px.get_cached_property('Percentage')?.unpack() ?? 0;
                const model = px.get_cached_property('Model')?.unpack() ?? '';
                // Type 2=Battery periférico; aceita qualquer device com % e modelo e não é DisplayDevice
                if (p.includes('DisplayDevice') || !pct || !model)
                  continue;
                if (type === 2 || type === 5 || type === 6)
                  found.push({ name: String(model).slice(0, 24), pct: Math.round(pct) });
              } catch {
                // ignora device individual
              }
            }
            this._btDevices = found.slice(0, 4);
            this._updateBatteryDetails();
          } catch (e) {
            logError(e, '[sysmon-tray] upower enumerate');
          }
        }
      );
    } catch (e) {
      logError(e, '[sysmon-tray] upower bus');
    }
  }

  // ---------- Timer ----------
  _refreshSecs() {
    try {
      const v = this._settings.get_int('refresh');
      return Math.max(1, Math.min(5, v));
    } catch {
      return 2;
    }
  }

  _tempUnit() {
    try {
      return this._settings.get_string('temp-unit') === 'f' ? 'f' : 'c';
    } catch {
      return 'c';
    }
  }

  _netIfaceSetting() {
    try {
      return this._settings.get_string('net-iface') || 'auto';
    } catch {
      return 'auto';
    }
  }

  _diskMount() {
    try {
      return this._settings.get_string('disk-mount') || '/';
    } catch {
      return '/';
    }
  }

  _restartTimer() {
    if (this._timeoutId) {
      GLib.Source.remove(this._timeoutId);
      this._timeoutId = 0;
    }
    this._timeoutId = GLib.timeout_add_seconds(
      GLib.PRIORITY_DEFAULT,
      this._refreshSecs(),
      () => {
        this._tick();
        return GLib.SOURCE_CONTINUE;
      }
    );
  }

  _setSlot(key, text) {
    if (this._slots[key])
      this._slots[key].val.text = text;
  }

  _tick() {
    const now = GLib.get_monotonic_time() / 1_000_000;
    const dt = this._refreshSecs();
    const unit = this._tempUnit();

    // CPU
    const { result: cpu, prevNext } = readCpuDetail(this._prevCpu);
    this._prevCpu = prevNext;
    if (cpu) {
      this._hist.cpu.push(cpu.pct);
      this._setSlot('cpu', `${Math.round(cpu.pct)}%`);
      this._slots.cpu?.mini.queue_repaint();
      if (this._cpuValueLabel)
        this._cpuValueLabel.text = `${Math.round(cpu.pct)}%`;
      this._sections?.cpu?.graph?.queue_repaint();
      this._updateCpuDetails(cpu);
      // Barrinhas por núcleo
      const { result: percore, prevNext: pcNext } = readPerCore(this._prevCores);
      this._prevCores = pcNext;
      if (percore)
        this._updateCpuCores(percore);
      // top CPU (precisa de 2 amostras)
      const list = topProcesses(8, 'cpu');
      const withPct = topCpuPct(list, this._prevTopMap, Math.max(1, now - this._prevTopTime || dt), 1);
      const nextMap = {};
      for (const p of list)
        nextMap[p.pid] = p.cpuTicks;
      this._prevTopMap = nextMap;
      this._prevTopTime = now;
      this._updateTopList(this._cpuTopBox, withPct.slice(0, 5).map(p => ({ name: p.comm, val: `${Math.round(p.pct)}%` })));
    }

    // RAM
    const ram = readRamDetail();
    if (ram) {
      this._hist.ram.push(ram.pct);
      this._setSlot('ram', formatRamGB(ram.usedKb));
      this._slots.ram?.mini.queue_repaint();
      if (this._ramNameLabel)
        this._ramNameLabel.text = `RAM ${formatRamGB(ram.totalKb)}`;
      if (this._ramValueLabel)
        this._ramValueLabel.text = `${Math.round(ram.pct)}%`;
      this._sections?.ram?.graph?.queue_repaint();
      this._updateRamDetails(ram);
      this._updateTopList(this._ramTopBox, topProcesses(5, 'mem').map(p => ({ name: p.comm, val: formatRamGB(p.memKb) })));
    }

    // GPU
    this._pollGpu();

    // Rede
    const netMap = parseNetDev(readFile('/proc/net/dev'));
    let iface = this._netIfaceSetting();
    if (iface === 'auto' || !netMap[iface])
      iface = defaultIface(netMap);
    if (iface && netMap[iface]) {
      const cur = netMap[iface];
      if (this._prevNet?.[iface] && this._prevNetTime) {
        const dtNet = Math.max(1, now - this._prevNetTime);
        const down = Math.max(0, (cur.rx - this._prevNet[iface].rx) / dtNet);
        const up = Math.max(0, (cur.tx - this._prevNet[iface].tx) / dtNet);
        this._netTotals.down += Math.max(0, cur.rx - this._prevNet[iface].rx);
        this._netTotals.up += Math.max(0, cur.tx - this._prevNet[iface].tx);
        // Escala log para KB/s aparecerem: 1.5K/s ~45%, 100K/s ~71%, 10M/s =100%
        const netPct = bps => Math.max(0, Math.min(100, (Math.log10(1 + bps) / Math.log10(1 + 10_000_000)) * 100));
        this._hist.netDown.push(netPct(down));
        this._hist.netUp.push(netPct(up));
        this._setSlot('net', `↓${formatSpeed(down)} ↑${formatSpeed(up)}`);
        this._slots.net?.mini.queue_repaint();
        if (this._netValueLabel)
          this._netValueLabel.text = `↓${formatSpeed(down)} ↑${formatSpeed(up)}`;
        if (this._netNameLabel)
          this._netNameLabel.text = iface;
        this._sections?.net?.graph?.queue_repaint();
        if (!this._localIp || Math.random() < 0.05)
          this._localIp = readLocalIp();
        this._updateNetDetails(iface, down, up);
      }
      this._prevNet = netMap;
      this._prevNetTime = now;
    }

    // Disco
    const mount = this._diskMount();
    const du = readDiskUsage(mount);
    const ds = parseDiskstats(readFile('/proc/diskstats'));
    if (du) {
      this._hist.disk.push(du.pct);
      this._setSlot('disk', `${Math.round(du.pct)}%`);
      this._slots.disk?.mini.queue_repaint();
      if (this._diskValueLabel)
        this._diskValueLabel.text = `${formatBytes(du.usedB)} (${Math.round(du.pct)}%)`;
      if (this._diskNameLabel)
        this._diskNameLabel.text = `${mount} ${formatBytes(du.totalB)}`;
      this._sections?.disk?.graph?.queue_repaint();
      let rBps = null, wBps = null;
      if (ds && this._prevDisk && this._prevDiskTime) {
        const dtD = Math.max(1, now - this._prevDiskTime);
        rBps = Math.max(0, (ds.rBytes - this._prevDisk.rBytes) / dtD);
        wBps = Math.max(0, (ds.wBytes - this._prevDisk.wBytes) / dtD);
      }
      if (ds) {
        this._prevDisk = ds;
        this._prevDiskTime = now;
      }
      let homeDu = null;
      if (mount === '/') {
        try {
          const hd = readDiskUsage('/home');
          if (hd && hd.totalB !== du.totalB)
            homeDu = hd;
        } catch {
          // sem /home separado
        }
      }
      this._updateDiskDetails(du, mount, rBps, wBps, homeDu);
    }

    // Sensores
    const sens = readSensorsDetail(this._hwmon);
    const mainTemp = sens.cpuC ?? sens.gpuC ?? sens.ssdC;
    if (mainTemp != null) {
      this._hist.temp.push(Math.max(0, Math.min(100, mainTemp)));
      this._setSlot('sensors', formatTemp(mainTemp, unit));
      this._slots.sensors?.mini.queue_repaint();
      if (this._sensValueLabel)
        this._sensValueLabel.text = formatTemp(mainTemp, unit);
      this._sections?.sensors?.graph?.queue_repaint();
    }
    this._updateSensorsDetails(sens, unit);

    // Bateria
    const batt = this._readBattery();
    if (batt) {
      this._hist.batt.push(batt.pct);
      const t = batt.timeSec > 60 ? ` (${formatDuration(batt.timeSec)})` : '';
      this._setSlot('battery', `${Math.round(batt.pct)}%`);
      this._slots.battery?.mini.queue_repaint();
      if (this._battValueLabel)
        this._battValueLabel.text = `${Math.round(batt.pct)}%${t}`;
      this._sections?.battery?.graph?.queue_repaint();
      this._updateBatteryDetails(batt);
      if (!this._btQueried) {
        this._btQueried = true;
        this._queryBtDevices();
      }
    } else {
      this._setSlot('battery', '--%');
    }
  }

  // ---------- Lado do tray ----------
  _traySide() {
    try {
      return this._settings.get_string('tray-side') === 'left' ? 'left' : 'right';
    } catch {
      return 'right';
    }
  }

  _syncSegButtons(side) {
    for (const b of this._segLeftBtns ?? [])
      b.set_checked(side === 'left');
    for (const b of this._segRightBtns ?? [])
      b.set_checked(side === 'right');
  }

  _applySide(side, force = false) {
    if (!force && this._side === side)
      return;
    this._side = side;
    try {
      this._settings.set_string('tray-side', side);
    } catch (e) {
      logError(e, '[sysmon-tray] tray-side');
    }
    for (const l of this._sideLabels ?? [])
      l.text = side === 'left' ? 'Esquerda' : 'Direita';
    this._syncSegButtons(side);
    const btns = ORDER.map(k => this._buttons?.[k]).filter(Boolean);
    if (!btns.length)
      return;
    const target = side === 'left' ? Main.panel._leftBox : Main.panel._rightBox;
    if (!target)
      return;
    // Ancoragem do popup por botão: na esquerda centraliza sob o ícone (0.5);
    // na direita mantém o padrão (0.0), que encosta na borda da tela.
    // (O 1º arg do PanelMenu.Button é o alinhamento da seta; 0.0 na
    // esquerda faz o modal nascer deslocado para a direita do ícone.)
    for (const btn of btns) {
      const menu = btn.menu;
      if (menu && '_arrowAlignment' in menu)
        menu._arrowAlignment = side === 'left' ? 0.5 : 0.0;
      btn.get_parent()?.remove_child(btn);
    }
    btns.forEach((btn, i) => {
      if (side === 'left')
        target.add_child(btn);
      else
        target.insert_child_at_index(btn, i);
    });
  }

  // ---------- Slots do tray (1 por módulo) ----------
  // Layout vertical compacto:
  //   C   G   R
  //   P 100% ...  (valor ou gráfico na linha do meio)
  //   U   U   M
  _mkAllSlots() {
    const defs = [
      ['cpu', ['C', 'P', 'U'], '--%', COLORS.cpu],
      ['gpu', ['G', 'P', 'U'], '--%', COLORS.gpu],
      ['ram', ['R', 'A', 'M'], '--', COLORS.ram],
      ['net', ['N', 'E', 'T'], '↓-- ↑--', COLORS.net],
      ['disk', ['D', 'S', 'K'], '--%', COLORS.disk],
      ['sensors', ['T', 'M', 'P'], '--°', COLORS.sensors],
      ['battery', ['B', 'A', 'T'], '--%', COLORS.battery],
    ];
    for (const [key, letters, initText, color] of defs) {
      const slot = new St.BoxLayout({ vertical: false, style_class: 'sysmon-slot sysmon-slot-v', y_align: Clutter.ActorAlign.CENTER });
      // Coluna da esquerda: sigla na vertical
      const lettersBox = new St.BoxLayout({ vertical: true, style_class: 'sysmon-v-letters', y_align: Clutter.ActorAlign.CENTER });
      for (const ch of letters) {
        const l = new St.Label({ text: ch, style_class: 'sysmon-v-letter', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER });
        lettersBox.add_child(l);
      }
      // Coluna da direita: valor (modo número) ou sparkline (modo gráfico),
      // centralizado na altura para cair na linha do meio (P/A/E/...)
      const content = new St.BoxLayout({ vertical: true, style_class: 'sysmon-v-content', y_align: Clutter.ActorAlign.CENTER, x_expand: true });
      const val = new St.Label({ text: initText, style_class: 'sysmon-slot-value', x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.CENTER });
      const mini = new St.DrawingArea({ style_class: 'sysmon-mini', width: 54, height: 22, x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.CENTER });
      content.add_child(val);
      content.add_child(mini);
      slot.add_child(lettersBox);
      slot.add_child(content);
      const histKey = { cpu: 'cpu', gpu: 'gpu', ram: 'ram', net: 'netDown', disk: 'disk', sensors: 'temp', battery: 'batt' }[key];
      if (key === 'net')
        mini.connect('repaint', () => this._paintNetMini(mini));
      else
        mini.connect('repaint', () => this._paintMini(mini, this._hist[histKey]?.array ?? [], color));
      // numRow/graphLabel mantidos como null p/ compat com _applyGraphMode
      this._slots[key] = { slot, val, mini, numRow: null, graphLabel: null };
    }
  }

  // ---------- Popup em abas / cards estilo Stats ----------
  _graph(key) {
    try {
      return this._settings.get_boolean(`graph-${key}`);
    } catch {
      return true;
    }
  }

  // Move a página do módulo para o menu aberto e sincroniza as abas
  _showModule(key, menu) {
    this._activeTab = key;
    const target = menu ?? this._openMenu;
    const sec = this._sections[key];
    if (sec && target?._pageHolder) {
      const holder = target._pageHolder;
      // Só uma página por vez: tira a anterior antes de pôr a nova.
      // (Sem isso as páginas acumulam empilhadas e a troca não aparece.)
      if (sec.page.get_parent() !== null && sec.page.get_parent() !== holder)
        sec.page.get_parent().remove_child(sec.page);
      for (const ch of [...holder.get_children()])
        holder.remove_child(ch);
      holder.add_child(sec.page);
      for (const [k, b] of Object.entries(target._tabBtns ?? {}))
        b.set_checked(k === key);
      sec.graph?.queue_repaint();
      sec.bar?.queue_repaint();
      sec.cores?.queue_repaint();
    }
  }

  _mkCard(key, title, color, { top = false, dualNet = false, bar = false, cores = false } = {}) {
    // Card: título pequeno + hero gigante + USAGE HISTORY + DETAILS + extras
    const page = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'sysmon-page' });
    const box = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'sysmon-section' });
    const nameLabel = new St.Label({ text: title, style_class: 'sysmon-row-name', x_expand: true, clip_to_allocation: true });
    const valueLabel = new St.Label({ text: '--', style_class: 'sysmon-row-value', x_expand: true });
    box.add_child(nameLabel);
    box.add_child(valueLabel);
    box.add_child(secTitle('USAGE HISTORY'));
    const graph = new St.DrawingArea({ style_class: 'sysmon-graph', x_expand: true, height: 64 });
    box.add_child(graph);
    box.add_child(secTitle('DETAILS'));
    const grid = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'sysmon-detail-grid' });
    box.add_child(grid);
    let barArea = null;
    if (bar) {
      barArea = new St.DrawingArea({ style_class: 'sysmon-bar', x_expand: true, height: 6 });
      box.add_child(barArea);
    }
    let coresArea = null;
    if (cores) {
      coresArea = new St.DrawingArea({ style_class: 'sysmon-cores', x_expand: true, height: 64 });
      box.add_child(coresArea);
    }
    let topBox = null;
    if (top) {
      box.add_child(secTitle('TOP PROCESSES'));
      topBox = new St.BoxLayout({ vertical: true, x_expand: true });
      box.add_child(topBox);
    }
    page.add_child(box);
    // Opções da aba: gráfico do top bar e visibilidade no top bar
    page.add_child(new PopupMenu.PopupSeparatorMenuItem());
    const graphOpt = mkCardOptRow('Gráfico na top bar', this._graph(key), on => {
      try {
        this._settings.set_boolean(`graph-${key}`, on);
      } catch (e) {
        logError(e, '[sysmon-tray] graph opt');
      }
      this._applyGraphMode(key);
      if (this._activeTab === key)
        this._sections[key]?.graph?.queue_repaint();
    });
    page.add_child(graphOpt.row);
    const trayOpt = mkCardOptRow('Mostrar na top bar', this._show(key), on => {
      try {
        this._settings.set_boolean(`show-${key}`, on);
      } catch (e) {
        logError(e, '[sysmon-tray] show opt');
      }
      this._applyVisibility();
    });
    page.add_child(trayOpt.row);
    this._trayToggles[key] = trayOpt;
    const sec = {
      page, box, nameLabel, valueLabel, graph, grid,
      bar: barArea, cores: coresArea, topBox, color, dualNet,
      _barPct: 0, _coresArr: [],
    };
    if (dualNet)
      graph.connect('repaint', () => this._paintNetGraph(graph));
    else
      graph.connect('repaint', () => this._paintGraph(graph, this._hist[{ cpu: 'cpu', gpu: 'gpu', ram: 'ram', disk: 'disk', sensors: 'temp', battery: 'batt', net: 'netDown' }[key]]?.array ?? [], color));
    if (barArea)
      barArea.connect('repaint', () => paintBar(barArea, sec._barPct, color));
    if (coresArea)
      coresArea.connect('repaint', () => paintCores(coresArea, sec._coresArr, color));
    this._sections[key] = sec;
    return sec;
  }

  _buildPages() {
    this._trayToggles = {};
    this._activeTab = 'cpu';
    const cpu = this._mkCard('cpu', this._cpuModel || 'CPU', COLORS.cpu, { top: true, cores: true });
    this._cpuNameLabel = cpu.nameLabel;
    this._cpuValueLabel = cpu.valueLabel;
    this._cpuTopBox = cpu.topBox;

    const gpu = this._mkCard('gpu', this._gpuModel || 'GPU', COLORS.gpu);
    this._gpuNameLabel = gpu.nameLabel;
    this._gpuValueLabel = gpu.valueLabel;

    const ram = this._mkCard('ram', 'RAM', COLORS.ram, { top: true, bar: true });
    this._ramNameLabel = ram.nameLabel;
    this._ramValueLabel = ram.valueLabel;
    this._ramTopBox = ram.topBox;

    const net = this._mkCard('net', 'Rede', COLORS.net, { dualNet: true });
    this._netNameLabel = net.nameLabel;
    this._netValueLabel = net.valueLabel;

    const disk = this._mkCard('disk', 'Disco', COLORS.disk, { bar: true });
    this._diskNameLabel = disk.nameLabel;
    this._diskValueLabel = disk.valueLabel;

    const sens = this._mkCard('sensors', 'Sensores', COLORS.sensors);
    this._sensNameLabel = sens.nameLabel;
    this._sensValueLabel = sens.valueLabel;

    const batt = this._mkCard('battery', 'Bateria', COLORS.battery, { bar: true });
    this._battNameLabel = batt.nameLabel;
    this._battValueLabel = batt.valueLabel;
  }

  _buildFooter(menu) {
    // Slider 1s..5s
    const footer = new PopupMenu.PopupBaseMenuItem({ reactive: false });
    const fbox = new St.BoxLayout({ style_class: 'sysmon-footer', x_expand: true });
    const rlabel = new St.Label({ text: 'Atualizar', style_class: 'sysmon-refresh-label' });
    const secs = this._refreshSecs();
    const slider = new Slider.Slider((secs - 1) / 4);
    slider.x_expand = true;
    const valueLabel = new St.Label({ text: `${secs}s`, style_class: 'sysmon-refresh-value' });
    slider.connect('notify::value', () => {
      const s = Math.round(1 + slider.value * 4);
      valueLabel.text = `${s}s`;
      if (s !== this._refreshSecs())
        this._settings.set_int('refresh', s);
    });
    fbox.add_child(rlabel);
    fbox.add_child(slider);
    fbox.add_child(valueLabel);
    footer.add_child(fbox);
    menu.addMenuItem(footer);
    this._refreshSliders.push(slider);
    this._refreshValueLabels.push(valueLabel);

    // Desligar + posição Esq/Dir
    const offItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
    const offBox = new St.BoxLayout({ style_class: 'sysmon-offrow', x_expand: true });
    const offBtn = new St.Button({
      label: 'Desligar', style_class: 'sysmon-off-button destructive-action',
      x_expand: true, can_focus: true, y_align: Clutter.ActorAlign.CENTER,
    });
    offBtn.connect('clicked', () => {
      const em = Main.extensionManager;
      if (em?.disableExtension)
        em.disableExtension(this.uuid);
      else if (em?.disable)
        em.disable(this.uuid);
    });
    const sideLabel = new St.Label({
      text: this._traySide() === 'left' ? 'Esquerda' : 'Direita',
      style_class: 'sysmon-side-label', y_align: Clutter.ActorAlign.CENTER,
    });
    const segBox = new St.BoxLayout({ style_class: 'sysmon-segbox', y_align: Clutter.ActorAlign.CENTER });
    const leftBtn = new St.Button({ label: '◀', style_class: 'sysmon-seg-btn', toggle_mode: true, can_focus: true, y_align: Clutter.ActorAlign.CENTER });
    const rightBtn = new St.Button({ label: '▶', style_class: 'sysmon-seg-btn', toggle_mode: true, can_focus: true, y_align: Clutter.ActorAlign.CENTER });
    leftBtn.connect('clicked', () => this._applySide('left'));
    rightBtn.connect('clicked', () => this._applySide('right'));
    segBox.add_child(leftBtn);
    segBox.add_child(rightBtn);
    offBox.add_child(offBtn);
    offBox.add_child(sideLabel);
    offBox.add_child(segBox);
    offItem.add_child(offBox);
    menu.addMenuItem(offItem);
    this._sideLabels.push(sideLabel);
    this._segLeftBtns.push(leftBtn);
    this._segRightBtns.push(rightBtn);
    this._syncSegButtons(this._traySide());
  }

  _buildIndicators() {
    for (const key of ORDER) {
      const btn = new PanelMenu.Button(0.5, `${this.metadata.name} ${key}`, false);
      btn.add_child(this._slots[key].slot);
      const menu = btn.menu;
      menu.box.add_style_class_name('sysmon-popup');
      // Barra de abas (troca a visualização dentro do popup aberto)
      const tabItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
      const tabBar = new St.BoxLayout({ style_class: 'sysmon-tabbar', x_expand: true });
      tabItem.add_child(tabBar);
      menu.addMenuItem(tabItem);
      const tabBtns = {};
      for (const k of ORDER) {
        const b = new St.Button({
          label: TAB_TITLES[k], style_class: 'sysmon-tab-btn',
          toggle_mode: true, can_focus: true,
        });
        b.connect('clicked', () => this._showModule(k, menu));
        tabBar.add_child(b);
        tabBtns[k] = b;
      }
      // Holder recebe a página do módulo selecionado
      const holderItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
      const holder = new St.BoxLayout({ vertical: true, x_expand: true });
      holderItem.add_child(holder);
      menu.addMenuItem(holderItem);
      menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
      this._buildFooter(menu);
      menu._pageHolder = holder;
      menu._tabBtns = tabBtns;
      menu._moduleKey = key;
      menu.connect('open-state-changed', (m, open) => {
        if (open) {
          this._openMenu = menu;
          this._showModule(key, menu);
        } else if (this._openMenu === menu) {
          this._openMenu = null;
        }
      });
      Main.panel.addToStatusArea(`${this.uuid}-${key}`, btn);
      this._buttons[key] = btn;
    }
  }

  _setDetails(secKey, rows) {
    const sec = this._sections?.[secKey];
    if (!sec)
      return;
    sec.grid.destroy_all_children();
    for (const [color, k, v] of rows)
      sec.grid.add_child(detailRow(color, k, v));
  }

  _setBar(secKey, pct) {
    const sec = this._sections?.[secKey];
    if (!sec?.bar)
      return;
    sec._barPct = pct ?? 0;
    sec.bar.queue_repaint();
  }

  _updateCpuDetails(cpu) {
    const freq = cpu.freqGHz ? `${cpu.freqGHz.toFixed(1)} GHz` : '--';
    const load = v => (v != null ? v.toFixed(2) : '--');
    this._setDetails('cpu', [
      [COLORS.cpu, 'Usuário', `${Math.round(cpu.userPct)}%`],
      ['#e5a50a', 'Sistema', `${Math.round(cpu.sysPct)}%`],
      ['#33d17a', 'Ocioso', `${Math.round(cpu.idlePct)}%`],
      ['#9a59b6', 'Load 1m', load(cpu.load1)],
      ['#9a59b6', 'Load 5m', load(cpu.load5)],
      ['#9a59b6', 'Load 15m', load(cpu.load15)],
      ['#ff7800', 'Frequência', freq],
    ]);
  }

  _updateCpuCores(percore) {
    const sec = this._sections?.cpu;
    if (!sec?.cores || !percore)
      return;
    sec._coresArr = percore.slice(0, 16);
    sec.cores.set_height(Math.max(16, sec._coresArr.length * 16));
    sec.cores.queue_repaint();
  }

  _updateRamDetails(ram) {
    this._setDetails('ram', [
      [COLORS.ram, 'Usada', formatRamGB(ram.usedKb)],
      ['#737373', 'Total', formatRamGB(ram.totalKb)],
      ['#9a59b6', 'Swap', `${formatRamGB(ram.swapUsedKb)}/${formatRamGB(ram.swapTotalKb)}`],
      ['#33d17a', 'Pressão', ram.pressure],
    ]);
    this._setBar('ram', ram.pct);
  }

  _updateGpuDetails() {
    const rows = [[COLORS.gpu, 'Uso', this._gpuValue != null ? `${Math.round(this._gpuValue)}%` : '--']];
    if (this._gpuMem)
      rows.push([COLORS.cpu, 'Memória', `${(this._gpuMem.usedMiB / 1024).toFixed(1)}/${(this._gpuMem.totalMiB / 1024).toFixed(1)} GB`]);
    if (this._gpuTemp != null)
      rows.push(['#ff6b6b', 'Temp', formatTemp(this._gpuTemp, this._tempUnit())]);
    else {
      const s = readSensorsDetail(this._hwmon);
      if (s.gpuC != null)
        rows.push(['#ff6b6b', 'Temp', formatTemp(s.gpuC, this._tempUnit())]);
    }
    this._setDetails('gpu', rows);
  }

  _updateNetDetails(iface, down, up) {
    this._setDetails('net', [
      [COLORS.net, 'Download', `${formatSpeed(down)}/s`],
      ['#ff7800', 'Upload', `${formatSpeed(up)}/s`],
      [COLORS.cpu, 'Total ↓', formatBytes(this._netTotals.down)],
      [COLORS.gpu, 'Total ↑', formatBytes(this._netTotals.up)],
      ['#737373', 'Interface', iface],
      ['#737373', 'IP local', this._localIp ?? '--'],
    ]);
  }

  _updateDiskDetails(du, mount, rBps, wBps, homeDu = null) {
    const rows = [
      [COLORS.disk, mount, `${formatBytes(du.usedB)}/${formatBytes(du.totalB)}`],
      [COLORS.net, 'Leitura', rBps != null ? `${formatSpeed(rBps)}/s` : '--'],
      ['#ff7800', 'Escrita', wBps != null ? `${formatSpeed(wBps)}/s` : '--'],
    ];
    if (homeDu && homeDu.totalB !== du.totalB)
      rows.push([COLORS.gpu, '/home', `${formatBytes(homeDu.usedB)}/${formatBytes(homeDu.totalB)}`]);
    this._setDetails('disk', rows);
    this._setBar('disk', du.pct);
  }

  _updateSensorsDetails(sens, unit) {
    this._setDetails('sensors', [
      ['#ff6b6b', 'CPU', formatTemp(sens.cpuC, unit)],
      [COLORS.gpu, 'GPU', formatTemp(sens.gpuC, unit)],
      [COLORS.cpu, 'SSD', formatTemp(sens.ssdC, unit)],
      [COLORS.net, 'Ventoinha', sens.fanRpm != null ? `${Math.round(sens.fanRpm)} RPM` : '--'],
      ['#e5a50a', 'Tensão', sens.voltV != null ? `${sens.voltV.toFixed(2)}V` : '--'],
      ['#ff7800', 'Potência', sens.powerW != null ? `${sens.powerW.toFixed(1)}W` : '--'],
    ]);
  }

  _updateBatteryDetails(batt = null) {
    const b = batt ?? this._lastBatt;
    if (batt)
      this._lastBatt = batt;
    if (!b) {
      this._setDetails('battery', [['#737373', 'Bateria', 'N/A (desktop?)']]);
      return;
    }
    const rows = [
      [COLORS.battery, 'Nível', `${Math.round(b.pct)}%`],
      [COLORS.cpu, 'Estado', batteryStateLabel(b.state)],
      ['#e5a50a', 'Tempo', b.timeSec > 60 ? formatDuration(b.timeSec) : '--'],
      [COLORS.gpu, 'Saúde', b.capacity != null ? `${Math.round(b.capacity)}%` : '--'],
    ];
    for (const d of this._btDevices ?? [])
      rows.push([COLORS.cpu, `◈ ${d.name}`, `${d.pct}%`]);
    this._setDetails('battery', rows);
    this._setBar('battery', b.pct);
  }

  _updateTopList(box, items) {
    if (!box)
      return;
    box.destroy_all_children();
    for (const it of items)
      box.add_child(topRow(it.name, it.val));
  }

  _roundRect(cr, w, h, rad) {
    const r = Math.min(rad, w / 2, h / 2);
    cr.newPath();
    cr.arc(w - r, r, r, -Math.PI / 2, 0);
    cr.arc(w - r, h - r, r, 0, Math.PI / 2);
    cr.arc(r, h - r, r, Math.PI / 2, Math.PI);
    cr.arc(r, r, r, Math.PI, (Math.PI * 3) / 2);
    cr.closePath();
  }

  _paintMini(area, hist, hex) {
    const cr = area.get_context();
    const [w, h] = area.get_surface_size();
    if (w <= 0 || h <= 0)
      return;
    const [r, g, b] = hexToRgb(hex);
    cr.setOperator(Cairo.Operator.OVER);
    // Fundo tipo pílula da referência
    this._roundRect(cr, w, h, 5);
    cr.setSourceRGBA(0.5, 0.5, 0.5, 0.22);
    cr.fill();
    // Recorta o gráfico para dentro da pílula
    this._roundRect(cr, w, h, 5);
    cr.clip();
    const pad = 1.5;
    if (!hist || hist.length < 2) {
      cr.setSourceRGBA(r, g, b, 0.35);
      cr.rectangle(pad, h - 3, w - pad * 2, 2);
      cr.fill();
      cr.resetClip();
      cr.$dispose();
      return;
    }
    const iw = w - pad * 2;
    const ih = h - pad * 2;
    const n = hist.length;
    const x = i => pad + (i / (n - 1)) * iw;
    const y = v => pad + ih - (Math.max(0, Math.min(100, v)) / 100) * ih;
    // Sombreado da base até a linha, na cor da linha (como na referência)
    cr.moveTo(x(0), y(hist[0]));
    for (let i = 1; i < n; i++)
      cr.lineTo(x(i), y(hist[i]));
    cr.lineTo(x(n - 1), h - pad);
    cr.lineTo(x(0), h - pad);
    cr.closePath();
    cr.setSourceRGBA(r, g, b, 0.45);
    cr.fill();
    // Linha por cima
    cr.moveTo(x(0), y(hist[0]));
    for (let i = 1; i < n; i++)
      cr.lineTo(x(i), y(hist[i]));
    cr.setSourceRGBA(r, g, b, 0.95);
    cr.setLineWidth(1.2);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.stroke();
    cr.resetClip();
    cr.$dispose();
  }

  // Mini da rede: down com fill na base + up como 2ª linha (como na referência N/E/T)
  _paintNetMini(area) {
    const cr = area.get_context();
    const [w, h] = area.get_surface_size();
    if (w <= 0 || h <= 0)
      return;
    cr.setOperator(Cairo.Operator.OVER);
    this._roundRect(cr, w, h, 5);
    cr.setSourceRGBA(0.5, 0.5, 0.5, 0.22);
    cr.fill();
    this._roundRect(cr, w, h, 5);
    cr.clip();
    const pad = 1.5;
    const down = this._hist.netDown?.array ?? [];
    const up = this._hist.netUp?.array ?? [];
    const iw = w - pad * 2;
    const ih = h - pad * 2;
    const x = (i, n) => pad + (i / Math.max(1, n - 1)) * iw;
    const y = v => pad + ih - (Math.max(0, Math.min(100, v)) / 100) * ih;
    // Down: área preenchida (azul, como na referência)
    if (down.length >= 2) {
      const [r, g, b] = hexToRgb(COLORS.cpu);
      const n = down.length;
      cr.moveTo(x(0, n), y(down[0]));
      for (let i = 1; i < n; i++)
        cr.lineTo(x(i, n), y(down[i]));
      cr.lineTo(x(n - 1, n), h - pad);
      cr.lineTo(x(0, n), h - pad);
      cr.closePath();
      cr.setSourceRGBA(r, g, b, 0.45);
      cr.fill();
      cr.moveTo(x(0, n), y(down[0]));
      for (let i = 1; i < n; i++)
        cr.lineTo(x(i, n), y(down[i]));
      cr.setSourceRGBA(r, g, b, 0.95);
      cr.setLineWidth(1.1);
      cr.setLineJoin(Cairo.LineJoin.ROUND);
      cr.setLineCap(Cairo.LineCap.ROUND);
      cr.stroke();
    }
    // Up: só linha vermelha por cima
    if (up.length >= 2) {
      const [r, g, b] = hexToRgb('#ff5b5b');
      const n = up.length;
      cr.moveTo(x(0, n), y(up[0]));
      for (let i = 1; i < n; i++)
        cr.lineTo(x(i, n), y(up[i]));
      cr.setSourceRGBA(r, g, b, 0.95);
      cr.setLineWidth(1.1);
      cr.setLineJoin(Cairo.LineJoin.ROUND);
      cr.setLineCap(Cairo.LineCap.ROUND);
      cr.stroke();
    }
    cr.resetClip();
    cr.$dispose();
  }

  _paintNetGraph(area) {
    const cr = area.get_context();
    const [w, h] = area.get_surface_size();
    if (w <= 0 || h <= 0)
      return;
    cr.setOperator(Cairo.Operator.OVER);
    cr.setLineWidth(1);
    cr.setSourceRGBA(0.5, 0.5, 0.5, 0.18);
    for (const f of [0.25, 0.5, 0.75]) {
      cr.moveTo(0, h * f);
      cr.lineTo(w, h * f);
      cr.stroke();
    }
    const draw = (hist, hex, dashed) => {
      if (!hist || hist.length < 2)
        return;
      const [r, g, b] = hexToRgb(hex);
      const n = hist.length;
      const x = i => (i / (n - 1)) * w;
      const y = v => h - 4 - (Math.max(0, Math.min(100, v)) / 100) * (h - 8);
      if (dashed)
        cr.setDash([4, 3], 0);
      else
        cr.setDash([], 0);
      cr.moveTo(x(0), y(hist[0]));
      for (let i = 1; i < n; i++)
        cr.lineTo(x(i), y(hist[i]));
      cr.setSourceRGBA(r, g, b, 0.95);
      cr.setLineWidth(1.6);
      cr.stroke();
      cr.setDash([], 0);
    };
    draw(this._hist.netDown.array, COLORS.net, false);
    draw(this._hist.netUp.array, '#ff9f0a', true);
    cr.$dispose();
  }

  _paintGraph(area, hist, hex) {
    const cr = area.get_context();
    const [w, h] = area.get_surface_size();
    if (w <= 0 || h <= 0)
      return;

    const [r, g, b] = hexToRgb(hex);

    cr.setOperator(Cairo.Operator.OVER);
    cr.setLineWidth(1);
    cr.setSourceRGBA(0.5, 0.5, 0.5, 0.18);
    for (const f of [0.25, 0.5, 0.75]) {
      cr.moveTo(0, h * f);
      cr.lineTo(w, h * f);
      cr.stroke();
    }

    if (!hist || hist.length < 2) {
      cr.setSourceRGBA(r, g, b, 0.5);
      cr.setFontSize(11);
      cr.moveTo(10, h / 2 + 4);
      cr.showText('coletando…');
      return;
    }

    const n = hist.length;
    const x = i => (i / (n - 1)) * w;
    const y = v => h - 4 - (Math.max(0, Math.min(100, v)) / 100) * (h - 8);

    cr.moveTo(x(0), y(hist[0]));
    for (let i = 1; i < n; i++)
      cr.lineTo(x(i), y(hist[i]));
    cr.lineTo(x(n - 1), h);
    cr.lineTo(x(0), h);
    cr.closePath();
    cr.setSourceRGBA(r, g, b, 0.18);
    cr.fill();

    cr.moveTo(x(0), y(hist[0]));
    for (let i = 1; i < n; i++)
      cr.lineTo(x(i), y(hist[i]));
    cr.setSourceRGBA(r, g, b, 0.95);
    cr.setLineWidth(1.6);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.stroke();

    cr.arc(x(n - 1) - 2, y(hist[n - 1]), 2.6, 0, Math.PI * 2);
    cr.setSourceRGBA(r, g, b, 1.0);
    cr.fill();

    cr.$dispose();
  }
}
