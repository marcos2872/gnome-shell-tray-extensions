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
  scanHwmon, readSensorsDetail, topProcesses, topCpuPct,
} from './collectors.js';

const MAX_POINTS = 120; // 2 min @ 1s
const COLORS = {
  cpu: '#3584e4', gpu: '#9a59b6', ram: '#e5a50a', net: '#2ec27e',
  disk: '#e479ff', sensors: '#ff6b6b', battery: '#33d17a',
};

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

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

    // --- Tray: slot = label fixa + (valor OU mini-gráfico, via toggle Gráfico) ---
    this._indicator = new PanelMenu.Button(0.5, this.metadata.name, false);
    const trayBox = new St.BoxLayout({
      style_class: 'sysmon-tray-box',
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._slots = {};
    const mkSlot = (key, miniLabel, initText, color) => {
      const slot = new St.BoxLayout({ vertical: true, style_class: 'sysmon-slot', y_align: Clutter.ActorAlign.CENTER });
      // Modo número: label colada no início + valor colado no fim (space-between)
      const numRow = new St.BoxLayout({ style_class: 'sysmon-num-row', y_align: Clutter.ActorAlign.CENTER, x_expand: true });
      const labH = new St.Label({ text: miniLabel, style_class: 'sysmon-num-label', x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.CENTER });
      const val = new St.Label({ text: initText, style_class: 'sysmon-slot-value', x_align: Clutter.ActorAlign.END, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
      numRow.add_child(labH);
      numRow.add_child(val);
      // Modo gráfico: label acima do sparkline
      const labV = new St.Label({ text: miniLabel, style_class: 'sysmon-slot-label', x_align: Clutter.ActorAlign.CENTER });
      const mini = new St.DrawingArea({ style_class: 'sysmon-mini', width: 54, height: 14, x_expand: true });
      slot.add_child(numRow);
      slot.add_child(labV);
      slot.add_child(mini);
      trayBox.add_child(slot);
      const histKey = { cpu: 'cpu', gpu: 'gpu', ram: 'ram', net: 'netDown', disk: 'disk', sensors: 'temp', battery: 'batt' }[key];
      mini.connect('repaint', () => this._paintMini(mini, this._hist[histKey]?.array ?? [], color));
      this._slots[key] = { slot, val, mini, numRow, graphLabel: labV };
    };
    mkSlot('cpu', 'CPU', '--%', COLORS.cpu);
    mkSlot('gpu', 'GPU', '--%', COLORS.gpu);
    mkSlot('ram', 'MEM', '--', COLORS.ram);
    mkSlot('net', 'NET', '↓-- ↑--', COLORS.net);
    mkSlot('disk', 'DSK', '--%', COLORS.disk);
    mkSlot('sensors', 'TMP', '--°', COLORS.sensors);
    mkSlot('battery', 'BAT', '--%', COLORS.battery);
    this._indicator.add_child(trayBox);

    this._buildMenu();

    Main.panel.addToStatusArea(this.uuid, this._indicator);
    this._applySide(this._traySide(), true);
    this._applyVisibility();

    this._settingsChangedIds = [
      this._settings.connect('changed::refresh', () => this._restartTimer()),
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
    this._indicator?.destroy();
    this._indicator = null;
    this._slots = {};
    this._hist = {};
    this._prevCpu = null;
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
    for (const [key, s] of Object.entries(this._slots ?? {})) {
      s.slot.visible = this._show(key);
      this._applyGraphMode(key);
    }
    for (const [key, t] of Object.entries(this._trayToggles ?? {})) {
      const on = this._show(key);
      if (t.btn.get_checked() !== on)
        t.sync(on);
    }
  }

  // Toggle Gráfico: ON = label acima do mini-gráfico; OFF = label + valor lado a lado.
  // O gráfico da aba do modal é sempre visível.
  _applyGraphMode(key) {
    const on = this._graph(key);
    const s = this._slots[key];
    if (s) {
      s.numRow.visible = !on;
      s.graphLabel.visible = on;
      s.mini.visible = on;
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
        this._ramValueLabel.text = `${formatRamGB(ram.usedKb)} (${Math.round(ram.pct)}%)`;
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
        this._hist.netDown.push(Math.min(100, (down / 10_000_000) * 100));
        this._hist.netUp.push(Math.min(100, (up / 10_000_000) * 100));
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
      this._updateDiskDetails(du, mount, rBps, wBps);
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
    if (this._leftBtn)
      this._leftBtn.set_checked(side === 'left');
    if (this._rightBtn)
      this._rightBtn.set_checked(side === 'right');
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
    if (this._sideLabel)
      this._sideLabel.text = side === 'left' ? 'Esquerda' : 'Direita';
    this._syncSegButtons(side);
    if (!this._indicator)
      return;
    // Ancoragem do popup: na esquerda centraliza sob o ícone (0.5);
    // na direita mantém o padrão (0.0), que encosta na borda da tela.
    // (O 1º arg do PanelMenu.Button é o alinhamento da seta; 0.0 na
    // esquerda faz o modal nascer deslocado para a direita do ícone.)
    const menu = this._indicator.menu;
    if (menu && '_arrowAlignment' in menu)
      menu._arrowAlignment = side === 'left' ? 0.5 : 0.0;
    const target = side === 'left' ? Main.panel._leftBox : Main.panel._rightBox;
    if (!target || this._indicator.get_parent() === target)
      return;
    this._indicator.get_parent()?.remove_child(this._indicator);
    if (side === 'left')
      target.add_child(this._indicator);
    else
      target.insert_child_at_index(this._indicator, 0);
  }

  // ---------- Popup em abas (1 por módulo) ----------
  _graph(key) {
    try {
      return this._settings.get_boolean(`graph-${key}`);
    } catch {
      return true;
    }
  }

  _selectTab(key) {
    this._activeTab = key;
    for (const [k, btn] of Object.entries(this._tabBtns ?? {}))
      btn.set_checked(k === key);
    for (const [k, page] of Object.entries(this._pages ?? {}))
      page.visible = k === key;
    this._sections?.[key]?.graph?.queue_repaint();
  }

  _buildMenu() {
    const menu = this._indicator.menu;
    menu.box.add_style_class_name('sysmon-popup');

    // Barra de abas
    const tabItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
    const tabBar = new St.BoxLayout({ style_class: 'sysmon-tabbar', x_expand: true });
    tabItem.add_child(tabBar);
    menu.addMenuItem(tabItem);

    const scroll = new St.ScrollView({ x_expand: true, y_expand: true, style_class: 'sysmon-scroll' });
    const pagesBox = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'sysmon-sections' });
    scroll.child = pagesBox;
    const section = new PopupMenu.PopupBaseMenuItem({ reactive: false });
    section.add_child(scroll);
    menu.addMenuItem(section);
    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    this._sections = {};
    this._tabBtns = {};
    this._pages = {};
    this._trayToggles = {};
    this._activeTab = 'cpu';

    const TABS = [
      ['cpu', 'CPU'], ['gpu', 'GPU'], ['ram', 'RAM'], ['net', 'NET'],
      ['disk', 'DSK'], ['sensors', 'TMP'], ['battery', 'BAT'],
    ];
    for (const [key, title] of TABS) {
      const btn = new St.Button({
        label: title, style_class: 'sysmon-tab-btn',
        toggle_mode: true, can_focus: true,
      });
      btn.connect('clicked', () => this._selectTab(key));
      tabBar.add_child(btn);
      this._tabBtns[key] = btn;
      const page = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'sysmon-page' });
      page.visible = false;
      pagesBox.add_child(page);
      this._pages[key] = page;
    }

    const mkOptRow = (page, label, initial, onChange) => {
      const row = new St.BoxLayout({ style_class: 'sysmon-opt-row', x_expand: true });
      const lab = new St.Label({ text: label, style_class: 'sysmon-opt-label', x_expand: true });
      const btn = new St.Button({
        style_class: 'sysmon-opt-btn', toggle_mode: true, can_focus: true,
        y_align: Clutter.ActorAlign.CENTER,
      });
      const sync = on => {
        btn.set_checked(on);
        btn.label = on ? 'ON' : 'OFF';
      };
      sync(initial);
      btn.connect('clicked', () => {
        const on = btn.get_checked();
        sync(on);
        onChange(on);
      });
      row.add_child(lab);
      row.add_child(btn);
      page.add_child(row);
      return { btn, sync };
    };

    const mkSection = (key, title, color, { top = false, dualNet = false } = {}) => {
      const page = this._pages[key];
      const box = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'sysmon-section' });
      const header = new St.BoxLayout({ style_class: 'sysmon-row-header', x_expand: true });
      const nameLabel = new St.Label({ text: title, style_class: 'sysmon-row-name', x_expand: true, clip_to_allocation: true });
      const valueLabel = new St.Label({ text: '--', style_class: 'sysmon-row-value' });
      header.add_child(nameLabel);
      header.add_child(valueLabel);
      const graph = new St.DrawingArea({ style_class: 'sysmon-graph', x_expand: true, height: 64 });
      // O gráfico do modal é sempre visível; o toggle controla só o top bar.
      const grid = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'sysmon-detail-grid' });
      box.add_child(header);
      box.add_child(graph);
      box.add_child(grid);
      let topBox = null;
      if (top) {
        topBox = new St.BoxLayout({ vertical: true, x_expand: true });
        box.add_child(topBox);
      }
      page.add_child(box);
      // Opções da aba: gráfico (label+gráfico) e top bar
      page.add_child(new PopupMenu.PopupSeparatorMenuItem());
      const graphOpt = mkOptRow(page, 'Gráfico na top bar', this._graph(key), on => {
        try {
          this._settings.set_boolean(`graph-${key}`, on);
        } catch (e) {
          logError(e, '[sysmon-tray] graph opt');
        }
        this._applyGraphMode(key);
        if (this._activeTab === key)
          this._sections[key]?.graph?.queue_repaint();
      });
      const trayOpt = mkOptRow(page, 'Mostrar na top bar', this._show(key), on => {
        try {
          this._settings.set_boolean(`show-${key}`, on);
        } catch (e) {
          logError(e, '[sysmon-tray] show opt');
        }
        this._applyVisibility();
      });
      this._trayToggles[key] = trayOpt;
      const sec = { box, nameLabel, valueLabel, graph, grid, topBox, color, dualNet };
      if (dualNet)
        graph.connect('repaint', () => this._paintNetGraph(graph));
      else
        graph.connect('repaint', () => this._paintGraph(graph, this._hist[{ cpu: 'cpu', gpu: 'gpu', ram: 'ram', disk: 'disk', sensors: 'temp', battery: 'batt', net: 'netDown' }[key]]?.array ?? [], color));
      this._sections[key] = sec;
      return sec;
    };

    const cpu = mkSection('cpu', this._cpuModel || 'CPU', COLORS.cpu, { top: true });
    this._cpuNameLabel = cpu.nameLabel;
    this._cpuValueLabel = cpu.valueLabel;
    this._cpuTopBox = cpu.topBox;

    const gpu = mkSection('gpu', this._gpuModel || 'GPU', COLORS.gpu);
    this._gpuNameLabel = gpu.nameLabel;
    this._gpuValueLabel = gpu.valueLabel;

    const ram = mkSection('ram', 'RAM', COLORS.ram, { top: true });
    this._ramNameLabel = ram.nameLabel;
    this._ramValueLabel = ram.valueLabel;
    this._ramTopBox = ram.topBox;

    const net = mkSection('net', 'Rede', COLORS.net, { dualNet: true });
    this._netNameLabel = net.nameLabel;
    this._netValueLabel = net.valueLabel;

    const disk = mkSection('disk', 'Disco', COLORS.disk);
    this._diskNameLabel = disk.nameLabel;
    this._diskValueLabel = disk.valueLabel;

    const sens = mkSection('sensors', 'Sensores', COLORS.sensors);
    this._sensNameLabel = sens.nameLabel;
    this._sensValueLabel = sens.valueLabel;

    const batt = mkSection('battery', 'Bateria', COLORS.battery);
    this._battNameLabel = batt.nameLabel;
    this._battValueLabel = batt.valueLabel;

    this._selectTab('cpu');

    // Footer: slider 1s..5s
    const footer = new PopupMenu.PopupBaseMenuItem({ reactive: false });
    const fbox = new St.BoxLayout({ style_class: 'sysmon-footer', x_expand: true });
    const rlabel = new St.Label({ text: 'Atualizar', style_class: 'sysmon-refresh-label' });
    const secs = this._refreshSecs();
    const slider = new Slider.Slider((secs - 1) / 4);
    slider.x_expand = true;
    this._refreshValueLabel = new St.Label({ text: `${secs}s`, style_class: 'sysmon-refresh-value' });
    slider.connect('notify::value', () => {
      const s = Math.round(1 + slider.value * 4);
      this._refreshValueLabel.text = `${s}s`;
      if (s !== this._refreshSecs())
        this._settings.set_int('refresh', s);
    });
    fbox.add_child(rlabel);
    fbox.add_child(slider);
    fbox.add_child(this._refreshValueLabel);
    footer.add_child(fbox);
    menu.addMenuItem(footer);

    // Desligar + posição
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
    this._sideLabel = new St.Label({ text: 'Direita', style_class: 'sysmon-side-label', y_align: Clutter.ActorAlign.CENTER });
    const segBox = new St.BoxLayout({ style_class: 'sysmon-segbox', y_align: Clutter.ActorAlign.CENTER });
    this._leftBtn = new St.Button({ label: '◀', style_class: 'sysmon-seg-btn', toggle_mode: true, can_focus: true, y_align: Clutter.ActorAlign.CENTER });
    this._rightBtn = new St.Button({ label: '▶', style_class: 'sysmon-seg-btn', toggle_mode: true, can_focus: true, y_align: Clutter.ActorAlign.CENTER });
    this._leftBtn.connect('clicked', () => this._applySide('left'));
    this._rightBtn.connect('clicked', () => this._applySide('right'));
    this._syncSegButtons(this._traySide());
    segBox.add_child(this._leftBtn);
    segBox.add_child(this._rightBtn);
    offBox.add_child(offBtn);
    offBox.add_child(this._sideLabel);
    offBox.add_child(segBox);
    offItem.add_child(offBox);
    menu.addMenuItem(offItem);

    menu.connect('open-state-changed', (m, open) => {
      if (open)
        this._sections?.[this._activeTab]?.graph?.queue_repaint();
    });
  }

  _setDetails(secKey, rows) {
    const sec = this._sections?.[secKey];
    if (!sec)
      return;
    sec.grid.destroy_all_children();
    for (const [k, v] of rows) {
      const row = new St.BoxLayout({ style_class: 'sysmon-detail-row', x_expand: true });
      const kl = new St.Label({ text: k, style_class: 'sysmon-detail-key', x_expand: true });
      const vl = new St.Label({ text: v, style_class: 'sysmon-detail-val' });
      row.add_child(kl);
      row.add_child(vl);
      sec.grid.add_child(row);
    }
  }

  _updateCpuDetails(cpu) {
    const freq = cpu.freqGHz ? `${cpu.freqGHz.toFixed(1)} GHz` : '--';
    const load = cpu.load1 != null ? `${cpu.load1.toFixed(2)}` : '--';
    this._setDetails('cpu', [
      ['Usuário', `${Math.round(cpu.userPct)}%`],
      ['Sistema', `${Math.round(cpu.sysPct)}%`],
      ['Ocioso', `${Math.round(cpu.idlePct)}%`],
      ['Load 1m', load],
      ['Frequência', freq],
    ]);
  }

  _updateRamDetails(ram) {
    this._setDetails('ram', [
      ['Usada', formatRamGB(ram.usedKb)],
      ['Total', formatRamGB(ram.totalKb)],
      ['Swap', `${formatRamGB(ram.swapUsedKb)}/${formatRamGB(ram.swapTotalKb)}`],
      ['Pressão', ram.pressure],
    ]);
  }

  _updateGpuDetails() {
    const rows = [['Uso', this._gpuValue != null ? `${Math.round(this._gpuValue)}%` : '--']];
    if (this._gpuMem)
      rows.push(['Memória', `${(this._gpuMem.usedMiB / 1024).toFixed(1)}/${(this._gpuMem.totalMiB / 1024).toFixed(1)} GB`]);
    if (this._gpuTemp != null)
      rows.push(['Temp', formatTemp(this._gpuTemp, this._tempUnit())]);
    else {
      const s = readSensorsDetail(this._hwmon);
      if (s.gpuC != null)
        rows.push(['Temp', formatTemp(s.gpuC, this._tempUnit())]);
    }
    this._setDetails('gpu', rows);
  }

  _updateNetDetails(iface, down, up) {
    this._setDetails('net', [
      ['Download', `${formatSpeed(down)}/s`],
      ['Upload', `${formatSpeed(up)}/s`],
      ['Total ↓', formatBytes(this._netTotals.down)],
      ['Total ↑', formatBytes(this._netTotals.up)],
      ['IP local', this._localIp ?? '--'],
    ]);
  }

  _updateDiskDetails(du, mount, rBps, wBps) {
    this._setDetails('disk', [
      [mount, `${formatBytes(du.usedB)}/${formatBytes(du.totalB)}`],
      ['Leitura', rBps != null ? `${formatSpeed(rBps)}/s` : '--'],
      ['Escrita', wBps != null ? `${formatSpeed(wBps)}/s` : '--'],
    ]);
  }

  _updateSensorsDetails(sens, unit) {
    this._setDetails('sensors', [
      ['CPU', formatTemp(sens.cpuC, unit)],
      ['GPU', formatTemp(sens.gpuC, unit)],
      ['SSD', formatTemp(sens.ssdC, unit)],
      ['Ventoinha', sens.fanRpm != null ? `${Math.round(sens.fanRpm)} RPM` : '--'],
      ['Tensão', sens.voltV != null ? `${sens.voltV.toFixed(2)}V` : '--'],
      ['Potência', sens.powerW != null ? `${sens.powerW.toFixed(1)}W` : '--'],
    ]);
  }

  _updateBatteryDetails(batt = null) {
    const b = batt ?? this._lastBatt;
    if (batt)
      this._lastBatt = batt;
    if (!b) {
      this._setDetails('battery', [['Bateria', 'N/A (desktop?)']]);
      return;
    }
    const rows = [
      ['Nível', `${Math.round(b.pct)}%`],
      ['Estado', batteryStateLabel(b.state)],
      ['Tempo', b.timeSec > 60 ? formatDuration(b.timeSec) : '--'],
      ['Saúde', b.capacity != null ? `${Math.round(b.capacity)}%` : '--'],
    ];
    for (const d of this._btDevices ?? [])
      rows.push([`◈ ${d.name}`, `${d.pct}%`]);
    this._setDetails('battery', rows);
  }

  _updateTopList(box, items) {
    if (!box)
      return;
    box.destroy_all_children();
    for (const it of items) {
      const row = new St.BoxLayout({ style_class: 'sysmon-top-row', x_expand: true });
      const n = new St.Label({ text: it.name, style_class: 'sysmon-top-name', x_expand: true, clip_to_allocation: true });
      const v = new St.Label({ text: it.val, style_class: 'sysmon-top-val' });
      row.add_child(n);
      row.add_child(v);
      box.add_child(row);
    }
  }

  _paintMini(area, hist, hex) {
    const cr = area.get_context();
    const [w, h] = area.get_surface_size();
    if (w <= 0 || h <= 0)
      return;
    const [r, g, b] = hexToRgb(hex);
    cr.setOperator(Cairo.Operator.OVER);
    if (!hist || hist.length < 2) {
      cr.setSourceRGBA(r, g, b, 0.35);
      cr.rectangle(0, h - 3, w, 2);
      cr.fill();
      cr.$dispose();
      return;
    }
    const n = hist.length;
    const x = i => (i / (n - 1)) * w;
    const y = v => h - 1 - (Math.max(0, Math.min(100, v)) / 100) * (h - 2);
    cr.moveTo(x(0), y(hist[0]));
    for (let i = 1; i < n; i++)
      cr.lineTo(x(i), y(hist[i]));
    cr.setSourceRGBA(r, g, b, 0.95);
    cr.setLineWidth(1.2);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    cr.stroke();
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
