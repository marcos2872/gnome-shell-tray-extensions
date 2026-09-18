import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Cairo from 'cairo';

export function hexToRgb(hex) {
    const h = hex.replace('#', '');
    return [
        parseInt(h.slice(0, 2), 16) / 255,
        parseInt(h.slice(2, 4), 16) / 255,
        parseInt(h.slice(4, 6), 16) / 255,
    ];
}

// Título de seção estilo Stats: "USAGE HISTORY", "DETAILS", ...
export function secTitle(text) {
    return new St.Label({ text, style_class: 'sysmon-sec-title', x_expand: true });
}

// Linha de detalhe com dot colorido: [● key ... val]
export function detailRow(dotColor, key, valText) {
    const row = new St.BoxLayout({ style_class: 'sysmon-detail-row', x_expand: true });
    const dot = new St.Widget({
        style_class: 'sysmon-dot',
        y_align: Clutter.ActorAlign.CENTER,
    });
    try {
        dot.set_style(`background-color: ${dotColor};`);
    } catch {
        // mantém o fundo do tema
    }
    const kl = new St.Label({ text: key, style_class: 'sysmon-detail-key', x_expand: true });
    const vl = new St.Label({ text: valText, style_class: 'sysmon-detail-val' });
    row.add_child(dot);
    row.add_child(kl);
    row.add_child(vl);
    return row;
}

// Linha de top processos
export function topRow(name, valText) {
    const row = new St.BoxLayout({ style_class: 'sysmon-top-row', x_expand: true });
    const n = new St.Label({
        text: name, style_class: 'sysmon-top-name',
        x_expand: true, clip_to_allocation: true,
    });
    const v = new St.Label({ text: valText, style_class: 'sysmon-top-val' });
    row.add_child(n);
    row.add_child(v);
    return row;
}

// Linha de opção com toggle ON/OFF (usada nas abas)
export function mkOptRow(label, initial, onChange) {
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
    return { row, btn, sync };
}

// Barra fina de pressão/uso (pintada em Cairo; largura adapta ao card)
export function paintBar(area, pct, hex) {
    const cr = area.get_context();
    const [w, h] = area.get_surface_size();
    if (w <= 0 || h <= 0)
        return;
    const [r, g, b] = hexToRgb(hex);
    const v = Math.max(0, Math.min(100, pct ?? 0)) / 100;
    cr.setOperator(Cairo.Operator.OVER);
    cr.setSourceRGBA(0.5, 0.5, 0.5, 0.25);
    cr.arc(h / 2, h / 2, h / 2 - 0.5, Math.PI / 2, (Math.PI * 3) / 2);
    cr.arc(w - h / 2, h / 2, h / 2 - 0.5, -Math.PI / 2, Math.PI / 2);
    cr.closePath();
    cr.fill();
    if (v > 0.01) {
        const fw = Math.max(h, w * v);
        cr.setSourceRGBA(r, g, b, 0.9);
        cr.arc(h / 2, h / 2, h / 2 - 0.5, Math.PI / 2, (Math.PI * 3) / 2);
        cr.arc(fw - h / 2, h / 2, h / 2 - 0.5, -Math.PI / 2, Math.PI / 2);
        cr.closePath();
        cr.fill();
    }
    cr.$dispose();
}

// Barrinhas por núcleo de CPU (uma DrawingArea para todos os núcleos)
export function paintCores(area, arr, hex) {
    const cr = area.get_context();
    const [w, h] = area.get_surface_size();
    if (w <= 0 || h <= 0)
        return;
    const [r, g, b] = hexToRgb(hex);
    cr.setOperator(Cairo.Operator.OVER);
    const n = Math.max(1, arr.length);
    const rowH = h / n;
    const barH = Math.min(10, Math.max(4, rowH - 5));
    const labelW = 44;
    cr.setFontSize(10);
    arr.forEach((pct, i) => {
        const y = i * rowH + (rowH - barH) / 2;
        const v = pct == null ? 0 : Math.max(0, Math.min(100, pct)) / 100;
        // trilha
        cr.setSourceRGBA(0.5, 0.5, 0.5, 0.22);
        cr.rectangle(labelW, y, w - labelW - 40, barH);
        cr.fill();
        // preenchimento
        if (v > 0.01) {
            cr.setSourceRGBA(r, g, b, 0.9);
            cr.rectangle(labelW, y, Math.max(barH, (w - labelW - 40) * v), barH);
            cr.fill();
        }
        // rótulo + valor (cinza legível nos dois temas)
        cr.setSourceRGBA(0.6, 0.6, 0.6, 0.9);
        cr.moveTo(0, y + barH - 1);
        cr.showText(`CPU${i}`);
        cr.moveTo(w - 36, y + barH - 1);
        cr.showText(pct == null ? '--' : `${Math.round(pct)}%`);
    });
    cr.$dispose();
}
