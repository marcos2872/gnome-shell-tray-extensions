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

const MAX_POINTS = 120; // 2 min @ 1s
const COLORS = { cpu: '#3584e4', gpu: '#9a59b6', ram: '#e5a50a' };

function readFile(path) {
  try {
    const [ok, bytes] = GLib.file_get_contents(path);
    if (!ok)
      return null;
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

function formatRamGB(kb) {
  const gb = kb / 1024 / 1024;
  const num = gb >= 10 ? gb.toFixed(1) : gb.toFixed(2).replace(/0$/, '');
  return `${num}GB`;
}

function cleanCpuModel(raw) {
  return (raw ?? '')
    .replace(/\(R\)|\(TM\)/g, '')
    .replace(/\s+@.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanGpuModel(raw) {
  return (raw ?? '')
    .replace(/^NVIDIA\s+GeForce\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export default class SysMonTrayExtension extends Extension {
  enable() {
    this._settings = this.getSettings();
    this._cpuHist = [];
    this._gpuHist = [];
    this._ramHist = [];
    this._prevCpu = null;
    this._gpuValue = null;
    this._gpuBusy = false;
    this._timeoutId = 0;

    this._detectGpu();
    this._cpuModel = this._readCpuModel();
    this._gpuModel = null;
    this._queryGpuModel();

    // --- Tray: 3 labels sempre visíveis (centralizados verticalmente) ---
    this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);
    const trayBox = new St.BoxLayout({
      style_class: 'sysmon-tray-box',
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._cpuLabel = new St.Label({
      text: 'CPU --%', style_class: 'sysmon-tray-label sysmon-cpu-label',
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._gpuLabel = new St.Label({
      text: 'GPU --%', style_class: 'sysmon-tray-label sysmon-gpu-label',
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._ramLabel = new St.Label({
      text: 'RAM --', style_class: 'sysmon-tray-label sysmon-ram-label',
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });
    trayBox.add_child(this._cpuLabel);
    trayBox.add_child(this._gpuLabel);
    trayBox.add_child(this._ramLabel);
    this._indicator.add_child(trayBox);

    this._buildMenu();

    Main.panel.addToStatusArea(this.uuid, this._indicator);
    this._applySide(this._traySide(), true);

    this._settingsChangedId = this._settings.connect('changed::refresh', () => {
      this._restartTimer();
    });
    this._restartTimer();
    this._tick(); // primeira leitura imediata
  }

  disable() {
    if (this._timeoutId) {
      GLib.Source.remove(this._timeoutId);
      this._timeoutId = 0;
    }
    if (this._settingsChangedId && this._settings) {
      this._settings.disconnect(this._settingsChangedId);
      this._settingsChangedId = 0;
    }
    this._settings = null;
    this._indicator?.destroy();
    this._indicator = null;
    this._cpuHist = [];
    this._gpuHist = [];
    this._ramHist = [];
    this._prevCpu = null;
    this._gpuValue = null;
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
    // AMD: card*/device/gpu_busy_percent
    for (let i = 0; i < 4; i++) {
      const p = `/sys/class/drm/card${i}/device/gpu_busy_percent`;
      if (readFile(p) !== null) {
        this._gpuBackend = 'amd';
        this._gpuSysfsPath = p;
        return;
      }
    }
    // Intel: frequência atual / máxima
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

  _readCpuModel() {
    const txt = readFile('/proc/cpuinfo');
    if (!txt)
      return null;
    const m = txt.match(/^model name\s+:\s+(.+)$/m);
    return m ? cleanCpuModel(m[1]) : null;
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
          ['nvidia-smi', '--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'],
          Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
        );
        proc.communicate_utf8_async(null, null, (p, res) => {
          try {
            const [, out] = p.communicate_utf8_finish(res);
            const v = parseInt((out ?? '').trim(), 10);
            if (!Number.isNaN(v))
              this._gpuValue = Math.max(0, Math.min(100, v));
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
    this._push(this._gpuHist, this._gpuValue);
    this._gpuLabel.text = `GPU ${Math.round(this._gpuValue)}%`;
    if (this._gpuValueLabel)
      this._gpuValueLabel.text = `${Math.round(this._gpuValue)}%`;
    this._gpuGraph?.queue_repaint();
  }

  // ---------- Leitores CPU / RAM ----------
  _readCpu() {
    const txt = readFile('/proc/stat');
    if (!txt)
      return null;
    const line = txt.split('\n').find(l => l.startsWith('cpu '));
    if (!line)
      return null;
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = (parts[3] ?? 0) + (parts[4] ?? 0);
    const total = parts.reduce((a, b) => a + (Number.isNaN(b) ? 0 : b), 0);
    if (!this._prevCpu) {
      this._prevCpu = { idle, total };
      return null;
    }
    const dIdle = idle - this._prevCpu.idle;
    const dTotal = total - this._prevCpu.total;
    this._prevCpu = { idle, total };
    if (dTotal <= 0)
      return null;
    return Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
  }

  _readRam() {
    const txt = readFile('/proc/meminfo');
    if (!txt)
      return null;
    const get = name => {
      const m = txt.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'));
      return m ? parseInt(m[1], 10) : null;
    };
    const total = get('MemTotal');
    const avail = get('MemAvailable');
    if (!total || avail === null)
      return null;
    const used = total - avail;
    return { usedKb: used, totalKb: total, pct: (used / total) * 100 };
  }

  _push(hist, v) {
    hist.push(v);
    while (hist.length > MAX_POINTS)
      hist.shift();
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

  _tick() {
    const cpu = this._readCpu();
    if (cpu !== null) {
      this._push(this._cpuHist, cpu);
      this._cpuLabel.text = `CPU ${Math.round(cpu)}%`;
      if (this._cpuValueLabel)
        this._cpuValueLabel.text = `${Math.round(cpu)}%`;
      this._cpuGraph?.queue_repaint();
    }
    const ram = this._readRam();
    if (ram) {
      this._push(this._ramHist, ram.pct);
      this._ramLabel.text = `RAM ${formatRamGB(ram.usedKb)}`;
      if (this._ramNameLabel)
        this._ramNameLabel.text = `RAM ${formatRamGB(ram.totalKb)}`;
      if (this._ramValueLabel)
        this._ramValueLabel.text = `${formatRamGB(ram.usedKb)} (${Math.round(ram.pct)}%)`;
      this._ramGraph?.queue_repaint();
    }
    this._pollGpu();
  }

  // ---------- Lado do tray (esquerda/direita) ----------
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
    // Move o ator entre as caixas do painel (mantém o registro do statusArea)
    const target = side === 'left' ? Main.panel._leftBox : Main.panel._rightBox;
    if (!target || this._indicator.get_parent() === target)
      return;
    this._indicator.get_parent()?.remove_child(this._indicator);
    if (side === 'left')
      target.add_child(this._indicator);
    else
      target.insert_child_at_index(this._indicator, 0);
  }

  // ---------- Popup ----------
  _buildMenu() {
    const menu = this._indicator.menu;
    menu.box.add_style_class_name('sysmon-popup');

    const section = new PopupMenu.PopupBaseMenuItem({ reactive: false });
    const vbox = new St.BoxLayout({ vertical: true, x_expand: true });

    const mkBlock = (name, color) => {
      const header = new St.BoxLayout({ style_class: 'sysmon-row-header', x_expand: true });
      const nameLabel = new St.Label({
        text: name, style_class: 'sysmon-row-name',
        x_expand: true, clip_to_allocation: true,
      });
      const valueLabel = new St.Label({ text: '--', style_class: 'sysmon-row-value' });
      header.add_child(nameLabel);
      header.add_child(valueLabel);
      const graph = new St.DrawingArea({ style_class: 'sysmon-graph', x_expand: true, height: 64 });
      vbox.add_child(header);
      vbox.add_child(graph);
      return { nameLabel, valueLabel, graph, color };
    };

    const cpu = mkBlock(this._cpuModel || 'CPU', COLORS.cpu);
    this._cpuNameLabel = cpu.nameLabel;
    this._cpuValueLabel = cpu.valueLabel;
    this._cpuGraph = cpu.graph;
    this._cpuGraph.connect('repaint', () => this._paintGraph(this._cpuGraph, this._cpuHist, COLORS.cpu));

    const gpu = mkBlock(this._gpuModel || 'GPU', COLORS.gpu);
    this._gpuNameLabel = gpu.nameLabel;
    this._gpuValueLabel = gpu.valueLabel;
    this._gpuGraph = gpu.graph;
    this._gpuGraph.connect('repaint', () => this._paintGraph(this._gpuGraph, this._gpuHist, COLORS.gpu));

    const ram = mkBlock('RAM', COLORS.ram);
    this._ramNameLabel = ram.nameLabel;
    this._ramValueLabel = ram.valueLabel;
    this._ramGraph = ram.graph;
    this._ramGraph.connect('repaint', () => this._paintGraph(this._ramGraph, this._ramHist, COLORS.ram));

    section.add_child(vbox);
    menu.addMenuItem(section);
    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

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
      if (s !== this._refreshSecs()) {
        this._settings.set_int('refresh', s);
        // _restartTimer via changed::refresh
      }
    });
    fbox.add_child(rlabel);
    fbox.add_child(slider);
    fbox.add_child(this._refreshValueLabel);
    footer.add_child(fbox);
    menu.addMenuItem(footer);

    // Desligar + posição Esq/Dir na mesma fileira e altura
    const offItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
    const offBox = new St.BoxLayout({ style_class: 'sysmon-offrow', x_expand: true });
    const offBtn = new St.Button({
      label: 'Desligar',
      style_class: 'sysmon-off-button destructive-action',
      x_expand: true,
      can_focus: true,
      y_align: Clutter.ActorAlign.CENTER,
    });
    offBtn.connect('clicked', () => {
      const em = Main.extensionManager;
      if (em?.disableExtension)
        em.disableExtension(this.uuid);
      else if (em?.disable)
        em.disable(this.uuid);
    });
    this._sideLabel = new St.Label({
      text: 'Direita',
      style_class: 'sysmon-side-label',
      y_align: Clutter.ActorAlign.CENTER,
    });
    const segBox = new St.BoxLayout({
      style_class: 'sysmon-segbox',
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._leftBtn = new St.Button({
      label: '◀',
      style_class: 'sysmon-seg-btn',
      toggle_mode: true,
      can_focus: true,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._rightBtn = new St.Button({
      label: '▶',
      style_class: 'sysmon-seg-btn',
      toggle_mode: true,
      can_focus: true,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._leftBtn.connect('clicked', () => this._applySide('left'));
    this._rightBtn.connect('clicked', () => this._applySide('right'));
    segBox.add_child(this._leftBtn);
    segBox.add_child(this._rightBtn);
    this._syncSegButtons(this._traySide());
    offBox.add_child(offBtn);
    offBox.add_child(this._sideLabel);
    offBox.add_child(segBox);
    offItem.add_child(offBox);
    menu.addMenuItem(offItem);

    // Repinta gráficos ao abrir (garante largura correta)
    menu.connect('open-state-changed', (m, open) => {
      if (open) {
        this._cpuGraph?.queue_repaint();
        this._gpuGraph?.queue_repaint();
        this._ramGraph?.queue_repaint();
      }
    });
  }

  _paintGraph(area, hist, hex) {
    const cr = area.get_context();
    const [w, h] = area.get_surface_size();
    if (w <= 0 || h <= 0)
      return;

    const [r, g, b] = hexToRgb(hex);

    // fundo já vem do CSS; limpa e desenha grade sutil
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

    // área preenchida (estilo Apple)
    cr.moveTo(x(0), y(hist[0]));
    for (let i = 1; i < n; i++)
      cr.lineTo(x(i), y(hist[i]));
    cr.lineTo(x(n - 1), h);
    cr.lineTo(x(0), h);
    cr.closePath();
    cr.setSourceRGBA(r, g, b, 0.18);
    cr.fill();

    // linha principal
    cr.moveTo(x(0), y(hist[0]));
    for (let i = 1; i < n; i++)
      cr.lineTo(x(i), y(hist[i]));
    cr.setSourceRGBA(r, g, b, 0.95);
    cr.setLineWidth(1.6);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.stroke();

    // ponto atual
    cr.arc(x(n - 1) - 2, y(hist[n - 1]), 2.6, 0, Math.PI * 2);
    cr.setSourceRGBA(r, g, b, 1.0);
    cr.fill();

    cr.$dispose();
  }
}
