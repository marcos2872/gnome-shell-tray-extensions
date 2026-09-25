import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
const DASHBOARD_URL = 'https://opencode.ai/go';
const BAR_BLOCKS = 12;

const WINDOWS = [
  { key: 'rolling', label: '5 horas' },
  { key: 'weekly', label: 'Semanal' },
  { key: 'monthly', label: 'Mensal' },
];

function barText(percent) {
  const p = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  const filled = Math.round((p / 100) * BAR_BLOCKS);
  return '█'.repeat(filled) + '░'.repeat(BAR_BLOCKS - filled);
}

function barClass(percent, hasData) {
  if (!hasData)
    return 'gobar-bar gobar-bar-idle';
  if (percent >= 100)
    return 'gobar-bar gobar-bar-err';
  if (percent >= 80)
    return 'gobar-bar gobar-bar-warn';
  return 'gobar-bar gobar-bar-ok';
}

function formatReset(totalSec) {
  if (!Number.isFinite(totalSec) || totalSec < 0)
    return '—';
  const s = Math.round(totalSec);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d >= 1) {
    const rh = h % 24;
    return rh ? `${d}d${rh}h` : `${d}d`;
  }
  if (h >= 1) {
    const rm = m % 60;
    return rm ? `${h}h${rm}m` : `${h}h`;
  }
  if (m >= 1)
    return `${m}m`;
  return `${s}s`;
}

export default class OpenCodeGoTrayExtension extends Extension {
  enable() {
    this._settings = this.getSettings();
    this._timeoutId = 0;
    this._fetchBusy = false;
    this._lastUpdated = null;
    this._cached = null;
    this._rows = {};

    // --- Tray: só um ícone estático (logo em assets/, claro/escuro por tema) ---
    this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);
    this._icon = new St.Icon({
      gicon: Gio.FileIcon.new(Gio.File.new_for_path(this._logoPath())),
      icon_size: 16,
      style_class: 'gobar-icon',
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._indicator.add_child(this._icon);
    try {
      this._themeChangedId = St.Settings.get().connect('notify::color-scheme', () => {
        if (this._icon)
          this._icon.gicon = Gio.FileIcon.new(Gio.File.new_for_path(this._logoPath()));
      });
    } catch {
      this._themeChangedId = 0;
    }

    this._buildMenu();

    Main.panel.addToStatusArea(this.uuid, this._indicator);
    this._applySide(this._traySide(), true);

    this._settingsChangedId = this._settings.connect('changed::refresh', () => {
      this._restartTimer();
    });
    this._menuOpenId = this._indicator.menu.connect('open-state-changed', (m, open) => {
      if (open)
        this._refreshIfStale();
    });
    this._restartTimer();
    this._tick(true);
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
    if (this._themeChangedId) {
      try {
        St.Settings.get().disconnect(this._themeChangedId);
      } catch { /* ignora */ }
      this._themeChangedId = 0;
    }
    this._menuOpenId = 0;
    this._settings = null;
    this._indicator?.destroy();
    this._indicator = null;
    this._rows = {};
    this._cached = null;
    this._fetchBusy = false;
  }

  // ---------- Auth: env + opencode.db (v2) + auth.json legado (nunca loga a key) ----------
  _dbCandidates() {
    const out = [];
    const override = GLib.getenv('OPENCODE_DB');
    if (override && override.trim())
      out.push(override.trim());
    const xdg = GLib.getenv('XDG_DATA_HOME');
    if (xdg && xdg.trim())
      out.push(`${xdg.trim()}/opencode/opencode.db`);
    out.push(`${GLib.get_home_dir()}/.local/share/opencode/opencode.db`);
    return out;
  }

  _readKeyFromDb() {
    for (const dbPath of this._dbCandidates()) {
      try {
        if (!GLib.file_test(dbPath, GLib.FileTest.EXISTS))
          continue;
        const proc = Gio.Subprocess.new(
          ['sqlite3', dbPath, "SELECT value FROM credential WHERE integration_id='opencode-go' ORDER BY active DESC LIMIT 1;"],
          Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
        );
        const [ok, stdout] = proc.communicate_utf8(null, null);
        if (!ok || !stdout || !stdout.trim())
          continue;
        const row = JSON.parse(stdout.trim());
        if (typeof row?.key === 'string' && row.key.trim())
          return row.key.trim();
      } catch (e) {
        logError(e, '[gobar] read opencode.db');
      }
    }
    return null;
  }

  _resolveApiKey() {
    const env = GLib.getenv('OPENCODE_API_KEY');
    if (env && env.trim())
      return { key: env.trim(), source: 'env' };
    const dbKey = this._readKeyFromDb();
    if (dbKey)
      return { key: dbKey, source: 'opencode.db' };
    try {
      const path = `${GLib.get_home_dir()}/.local/share/opencode/auth.json`;
      const [ok, bytes] = GLib.file_get_contents(path);
      if (!ok)
        return { key: null, source: 'missing' };
      const data = JSON.parse(new TextDecoder().decode(bytes));
      if (typeof data?.['opencode-go']?.key === 'string' && data['opencode-go'].key)
        return { key: data['opencode-go'].key, source: 'auth.json' };
      if (typeof data?.opencode?.key === 'string' && data.opencode.key)
        return { key: data.opencode.key, source: 'auth.json-legacy' };
      return { key: null, source: 'missing' };
    } catch {
      return { key: null, source: 'missing' };
    }
  }

  // ---------- Timer ----------
  _refreshSecs() {
    try {
      const v = this._settings.get_int('refresh');
      return Math.max(60, Math.min(900, v));
    } catch {
      return 300;
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

  _refreshIfStale() {
    if (!this._lastUpdated)
      return;
    const ageSec = (Date.now() - this._lastUpdated.getTime()) / 1000;
    if (ageSec >= this._refreshSecs())
      this._tick();
  }

  _tick(force = false) {
    if (this._fetchBusy && !force)
      return;
    const { key, source } = this._resolveApiKey();
    if (!key) {
      this._showError(
        'Sem API key. Rode: opencode auth login -p opencode-go, ou exporte OPENCODE_API_KEY.',
        'sem key',
        source
      );
      return;
    }
    this._fetchUsage(key, source);
  }

  // ---------- Rede via curl assíncrono (não bloqueia o Shell) ----------
  _fetchUsage(apiKey, source) {
    if (this._fetchBusy)
      return;
    this._fetchBusy = true;
    this._setStatus('○ …', 'gobar-status');
    let proc;
    try {
      proc = Gio.Subprocess.new(
        ['curl', '-s', '--max-time', '15',
          USAGE_URL,
          '-H', `Authorization: Bearer ${apiKey}`,
          '-H', 'Accept: application/json',
          '-w', '\n__HTTP__%{http_code}'],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
      );
    } catch (e) {
      this._fetchBusy = false;
      logError(e, '[gobar] spawn curl');
      this._showError('Falha ao iniciar consulta (curl).', 'erro', source);
      return;
    }
    proc.communicate_utf8_async(null, null, (p, res) => {
      try {
        const [, out] = p.communicate_utf8_finish(res);
        this._handleResponse(out ?? '', source);
      } catch (e) {
        logError(e, '[gobar] curl');
        this._showError('Sem conexão. Mostrando último cache.', 'offline', source, true);
      } finally {
        this._fetchBusy = false;
      }
    });
  }

  _handleResponse(out, source) {
    const marker = '\n__HTTP__';
    const idx = out.lastIndexOf(marker);
    const body = idx >= 0 ? out.slice(0, idx) : out;
    const http = idx >= 0 ? parseInt(out.slice(idx + marker.length).trim(), 10) : 0;

    if (http === 401) {
      this._showError('API key inválida (401). Regenere a key em opencode.ai/auth e refaça: opencode auth login -p opencode-go.', 'não autorizado', source);
      return;
    }
    if (http === 403) {
      this._showError('Assinatura Go não encontrada (403). Verifique o plano no dashboard.', 'sem plano', source);
      return;
    }
    if (!http || http < 200 || http >= 300) {
      this._showError(`Falha na API (HTTP ${http || '—'}). Mostrando último cache.`, 'offline', source, true);
      return;
    }
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      this._showError('Resposta inválida da API. Mostrando último cache.', 'erro', source, true);
      return;
    }
    const usage = data?.usage;
    if (!usage || typeof usage !== 'object') {
      this._showError('Resposta sem campo “usage”. Mostrando último cache.', 'erro', source, true);
      return;
    }
    this._cached = usage;
    this._lastUpdated = new Date();
    this._renderUsage(usage, source);
  }

  // ---------- Render ----------
  _renderUsage(usage, source) {
    let worst = 0;
    let limited = false;
    for (const { key } of WINDOWS) {
      const w = usage[key] ?? {};
      const percent = Number(w.percent);
      const ok = Number.isFinite(percent);
      const status = String(w.status ?? 'ok');
      const resetSec = this._resetSec(w.resetsAt);
      if (ok)
        worst = Math.max(worst, percent);
      if (status === 'rate-limited' || percent >= 100)
        limited = true;

      const row = this._rows[key];
      if (!row)
        continue;
      row.bar.text = ok ? barText(percent) : '░░░░░░░░░░░░';
      row.bar.style_class = barClass(percent, ok);
      row.value.text = ok ? `${Math.round(percent)}% usado` : '—';
      row.reset.text = status === 'rate-limited'
        ? 'limite atingido'
        : `reseta em ${formatReset(resetSec)}`;
    }
    if (limited)
      this._setStatus('● limite', 'gobar-status gobar-status-err');
    else if (worst >= 80)
      this._setStatus('● atenção', 'gobar-status gobar-status-warn');
    else
      this._setStatus('● ok', 'gobar-status gobar-status-ok');
    this._setError('');
    this._updateTooltip(source);
  }

  _showError(msg, pill, source, keepCache = false) {
    if (keepCache && this._cached) {
      this._renderUsage(this._cached, source);
      this._setError(msg);
      this._setStatus(`● ${pill}`, 'gobar-status gobar-status-warn');
      return;
    }
    this._setStatus(`● ${pill}`, 'gobar-status gobar-status-err');
    this._setError(msg);
    for (const { key } of WINDOWS) {
      const row = this._rows[key];
      if (!row)
        continue;
      row.bar.text = '░░░░░░░░░░░░';
      row.bar.style_class = 'gobar-bar gobar-bar-idle';
      row.value.text = '—';
      row.reset.text = '—';
    }
    this._updateTooltip(source);
  }

  _resetSec(resetsAt) {
    if (!resetsAt)
      return NaN;
    const t = Date.parse(resetsAt);
    if (!Number.isFinite(t))
      return NaN;
    return Math.max(0, (t - Date.now()) / 1000);
  }

  _setStatus(text, styleClass) {
    if (this._statusLabel) {
      this._statusLabel.text = text;
      this._statusLabel.style_class = styleClass;
    }
  }

  _setError(text) {
    if (this._errorLabel) {
      this._errorLabel.text = text;
      this._errorLabel.visible = !!text;
    }
  }

  _updateTooltip(source) {
    if (!this._indicator)
      return;
    const src = source === 'env' ? 'env'
      : source === 'opencode.db' ? 'opencode.db'
      : source === 'auth.json' ? 'auth.json'
      : source === 'auth.json-legacy' ? 'auth.json'
      : 'sem key';
    const parts = WINDOWS.map(({ key, label }) => {
      const w = this._cached?.[key];
      const p = Number(w?.percent);
      return Number.isFinite(p) ? `${label} ${Math.round(p)}%` : `${label} —`;
    });
    this._indicator.tooltip_text = `OpenCode Go (${src}): ${parts.join(' · ')}`;
  }

  // ---------- Logo claro/escuro conforme o tema (assets/) ----------
  _logoFile(variant) {
    const candidates = [
      `${this.path}/assets/opencode-logo-${variant}.svg`,
      `${this.path}/opencode-logo-${variant}.svg`,
    ];
    for (const p of candidates) {
      try {
        if (GLib.file_test(p, GLib.FileTest.EXISTS))
          return p;
      } catch { /* tenta o próximo */ }
    }
    return candidates[0];
  }

  _logoPath() {
    let light = true; // barra do GNOME costuma ser escura
    try {
      const preferLight = St.ColorScheme?.PREFER_LIGHT ?? 2;
      if (St.Settings.get().color_scheme === preferLight)
        light = false;
    } catch { /* mantém fallback claro */ }
    return this._logoFile(light ? 'light' : 'dark');
  }

  // ---------- Lado do ícone ----------
  _traySide() {
    try {
      return this._settings.get_string('tray-side') === 'left' ? 'left' : 'right';
    } catch {
      return 'right';
    }
  }

  _applySide(side, force = false) {
    if (!force && this._side === side)
      return;
    this._side = side;
    try {
      this._settings.set_string('tray-side', side);
    } catch (e) {
      logError(e, '[gobar] tray-side');
    }
    if (!this._indicator)
      return;
    const target = side === 'left' ? Main.panel._leftBox : Main.panel._rightBox;
    if (!target || this._indicator.get_parent() === target)
      return;
    this._indicator.get_parent()?.remove_child(this._indicator);
    if (side === 'left')
      target.add_child(this._indicator);
    else
      target.insert_child_at_index(this._indicator, 0);
  }

  // ---------- Popup (modal das cotas) ----------
  _buildMenu() {
    const menu = this._indicator.menu;
    menu.box.add_style_class_name('gobar-popup');

    const section = new PopupMenu.PopupBaseMenuItem({ reactive: false });
    const vbox = new St.BoxLayout({ vertical: true, x_expand: true });

    const header = new St.BoxLayout({ style_class: 'gobar-header', x_expand: true });
    const title = new St.Label({
      text: 'OpenCode Go', style_class: 'gobar-title', x_expand: true,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._statusLabel = new St.Label({
      text: '○ …', style_class: 'gobar-status',
      y_align: Clutter.ActorAlign.CENTER,
    });
    header.add_child(title);
    header.add_child(this._statusLabel);
    vbox.add_child(header);

    for (const { key, label } of WINDOWS) {
      const block = new St.BoxLayout({ vertical: true, style_class: 'gobar-block', x_expand: true });
      const top = new St.BoxLayout({ style_class: 'gobar-row', x_expand: true });
      const name = new St.Label({
        text: label, style_class: 'gobar-name', x_expand: true,
        clip_to_allocation: true,
      });
      const value = new St.Label({ text: '—', style_class: 'gobar-value' });
      top.add_child(name);
      top.add_child(value);
      const barRow = new St.BoxLayout({ style_class: 'gobar-bar-row', x_expand: true });
      const bar = new St.Label({
        text: '░░░░░░░░░░░░', style_class: 'gobar-bar gobar-bar-idle', x_expand: true,
        clip_to_allocation: true,
      });
      const reset = new St.Label({ text: '—', style_class: 'gobar-reset' });
      barRow.add_child(bar);
      barRow.add_child(reset);
      block.add_child(top);
      block.add_child(barRow);
      vbox.add_child(block);
      this._rows[key] = { value, bar, reset };
    }

    this._errorLabel = new St.Label({ text: '', style_class: 'gobar-error' });
    this._errorLabel.visible = false;
    vbox.add_child(this._errorLabel);

    section.add_child(vbox);
    menu.addMenuItem(section);
    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    const footer = new PopupMenu.PopupBaseMenuItem({ reactive: false });
    const fbox = new St.BoxLayout({ style_class: 'gobar-footer', x_expand: true });
    const refreshBtn = new St.Button({
      label: 'Atualizar', style_class: 'gobar-btn',
      can_focus: true, y_align: Clutter.ActorAlign.CENTER,
    });
    refreshBtn.connect('clicked', () => this._tick(true));
    const spacer = new St.Label({ text: '', x_expand: true });
    const dashBtn = new St.Button({
      label: 'Abrir dashboard', style_class: 'gobar-btn',
      can_focus: true, y_align: Clutter.ActorAlign.CENTER,
    });
    dashBtn.connect('clicked', () => {
      try {
        Gio.AppInfo.launch_default_for_uri(DASHBOARD_URL, null);
      } catch (e) {
        logError(e, '[gobar] open dashboard');
      }
      this._indicator.menu.close();
    });
    fbox.add_child(refreshBtn);
    fbox.add_child(spacer);
    fbox.add_child(dashBtn);
    footer.add_child(fbox);
    menu.addMenuItem(footer);
  }
}
