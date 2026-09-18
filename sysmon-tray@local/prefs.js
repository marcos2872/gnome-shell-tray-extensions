import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const MODULES = [
  ['show-cpu', 'CPU', 'Carga, load, frequência e top processos'],
  ['show-gpu', 'GPU', 'Uso, memória e temperatura'],
  ['show-ram', 'RAM', 'Usada/total, swap e top memória'],
  ['show-net', 'Rede', 'Download/upload, totais e IP'],
  ['show-disk', 'Disco', 'Espaço e leitura/escrita'],
  ['show-sensors', 'Sensores', 'Temperaturas, fan, tensão, potência'],
  ['show-battery', 'Bateria', 'Nível, saúde, tempo + Bluetooth'],
];

export default class SysMonTrayPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();
    const page = new Adw.PreferencesPage({ title: 'Geral' });

    const modGroup = new Adw.PreferencesGroup({ title: 'Módulos (estilo Stats)' });
    page.add(modGroup);
    for (const [key, title, subtitle] of MODULES) {
      const row = new Adw.SwitchRow({ title, subtitle, active: settings.get_boolean(key) });
      row.connect('notify::active', () => settings.set_boolean(key, row.active));
      settings.connect(`changed::${key}`, () => {
        if (row.active !== settings.get_boolean(key))
          row.active = settings.get_boolean(key);
      });
      modGroup.add(row);
    }

    const updGroup = new Adw.PreferencesGroup({ title: 'Atualização' });
    page.add(updGroup);

    const adj = new Gtk.Adjustment({
      lower: 1, upper: 5, step_increment: 1,
      value: settings.get_int('refresh'),
    });
    const row = new Adw.SpinRow({
      title: 'Taxa de atualização',
      subtitle: 'Intervalo de coleta em segundos (1 a 5)',
      adjustment: adj,
    });
    adj.connect('value-changed', () => {
      settings.set_int('refresh', Math.round(adj.value));
    });
    settings.connect('changed::refresh', () => {
      const v = settings.get_int('refresh');
      if (Math.round(adj.value) !== v)
        adj.value = v;
    });
    updGroup.add(row);

    const tempRow = new Adw.ComboRow({
      title: 'Temperatura',
      subtitle: 'Unidade dos sensores',
      model: new Gtk.StringList({ strings: ['Celsius (°C)', 'Fahrenheit (°F)'] }),
      selected: settings.get_string('temp-unit') === 'f' ? 1 : 0,
    });
    tempRow.connect('notify::selected', () => {
      settings.set_string('temp-unit', tempRow.selected === 1 ? 'f' : 'c');
    });
    updGroup.add(tempRow);

    const netRow = new Adw.EntryRow({ title: 'Interface de rede (auto)' });
    netRow.text = settings.get_string('net-iface');
    netRow.connect('notify::text', () => {
      settings.set_string('net-iface', netRow.text.trim() || 'auto');
    });
    updGroup.add(netRow);

    const diskRow = new Adw.EntryRow({ title: 'Ponto de montagem do disco' });
    diskRow.text = settings.get_string('disk-mount');
    diskRow.connect('notify::text', () => {
      settings.set_string('disk-mount', diskRow.text.trim() || '/');
    });
    updGroup.add(diskRow);

    window.add(page);
  }
}
