import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class SysMonTrayPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();
    const page = new Adw.PreferencesPage({ title: 'Geral' });
    const group = new Adw.PreferencesGroup({ title: 'Atualização' });
    page.add(group);

    const adj = new Gtk.Adjustment({
      lower: 1,
      upper: 5,
      step_increment: 1,
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
    group.add(row);
    window.add(page);
  }
}
