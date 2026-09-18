---
name: gnome-shell-tray
description: Use when creating, testing, debugging or publishing GNOME Shell extensions, especially PanelMenu tray indicators in the top bar. Triggers on keywords metadata.json, extension.js, prefs.js, PanelMenu, addToStatusArea, AppIndicator, Looking Glass, gnome-extensions.
---

# GNOME Shell Tray Extension

Cria extensões GNOME 45-48+ com padrão ESM. Foco em indicador de tray na top bar direita.

## 1. Estrutura obrigatória

Pasta deve ter nome == `uuid`:
```
~/.local/share/gnome-shell/extensions/<uuid>/
  extension.js    # obrigatório
  metadata.json   # obrigatório
  prefs.js        # opcional, GTK4/Adwaita, processo separado
  stylesheet.css  # opcional, só afeta Shell
  schemas/*.gschema.xml
  icons/*-symbolic.svg
```

`metadata.json` mínimo:
```json
{
  "uuid": "meutray@exemplo.com",
  "name": "Meu Tray",
  "description": "Botão na top bar",
  "shell-version": ["45","46","47","48"],
  "url": "https://github.com/voce/ext"
}
```
Nunca misture pré-45 com pós-45 no mesmo zip. Não sete `version` manual (EGO controla).

Scaffold:
```bash
gnome-extensions create --interactive
# ou:
gnome-extensions create --name="Meu Tray" --description="..." --uuid="meutray@exemplo.com" --template=indicator
```

## 2. Padrão ESM (GNOME 45+ obrigatório)

Errado (<45, obsoleto): `const Main = imports.ui.main;`
Certo:
```js
import St from 'gi://St';
import Gio from 'gi://Gio';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

export default class MeuTrayExtension extends Extension {
  enable() {}
  disable() {}
}
```

`prefs.js` roda em processo `gjs` separado. Nunca use `St/Clutter/Shell/Meta` nele. Nunca use `Gtk/Adw` em `extension.js`:
```js
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class Prefs extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const page = new Adw.PreferencesPage({title: _('General'), icon_name: 'dialog-information-symbolic'});
    window.add(page);
    // bind: this.getSettings().bind('minha-chave', widget, 'active', Gio.SettingsBindFlags.DEFAULT);
  }
}
```

## 3. Tray na top bar — receita padrão

Use `PanelMenu.Button` + `St.Icon` + `Main.panel.addToStatusArea(role, indicator, position, box)`.

```js
export default class MeuTrayExtension extends Extension {
  enable() {
    // false = cria this.menu automaticamente
    this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);

    this._icon = new St.Icon({
      icon_name: 'face-laugh-symbolic',
      style_class: 'system-status-icon', // obrigatório p/ tamanho/cor do tema
      // custom: gicon: Gio.icon_new_for_string(`${this.path}/icons/meu-symbolic.svg`),
    });
    this._indicator.add_child(this._icon);

    this._indicator.menu.addAction('Abrir', () => Main.notify('Olá'));
    this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    const toggle = new PopupMenu.PopupSwitchMenuItem('Ativo', true);
    toggle.connect('toggled', (o, state) => {
      this._icon.icon_name = state ? 'face-laugh-symbolic' : 'face-tired-symbolic';
    });
    this._indicator.menu.addMenuItem(toggle);
    this._indicator.menu.addAction('Preferências', () => this.openPreferences());

    Main.panel.addToStatusArea(this.uuid, this._indicator);
  }

  disable() {
    this._indicator?.destroy();
    this._indicator = null;
  }
}
```

Checklist:
- `style_class: 'system-status-icon'` sempre.
- Ícone custom: arquivo `-symbolic.svg` monocromático para herdar tema claro/escuro.
- `disable()` deve destruir tudo: indicador, signals, timeouts (`GLib.Source.remove`), etc.
- Para menu com submenu/imagem:
  `new PopupMenu.PopupImageMenuItem('Texto','dialog-warning-symbolic')`,
  `new PopupMenu.PopupSubMenuMenuItem('Mais', true)`.

Quando NÃO usar `PanelMenu`:
- `QuickSettings.SystemIndicator`: só para integrar no menu agregado do sistema (WiFi/som/bateria). Docs: https://gjs.guide/extensions/topics/quick-settings.html
- Apps externos (Discord, Steam, Electron) via DBus `StatusNotifierItem`: não reinvente, dependa de [AppIndicator Support](https://github.com/ubuntu/gnome-shell-extension-appindicator). `Tray Icons Reloaded` / `TopIcons` estão mortos no Wayland.

## 4. Testar e debugar — workflow

```bash
# instalar local
gnome-extensions pack ./meutray@exemplo.com -o . --force
gnome-extensions install meutray@exemplo.com.shell-extension.zip --force
gnome-extensions enable meutray@exemplo.com
gnome-extensions info meutray@exemplo.com  # ver ACTIVE vs ERROR
gnome-extensions prefs meutray@exemplo.com

# logs
journalctl -f -o cat /usr/bin/gnome-shell  # extension.js
journalctl -f -o cat /usr/bin/gjs          # prefs.js
journalctl -f -o cat /usr/bin/gnome-shell | grep -i "meutray@"

# código: console.log/info/warn/error/debug + logError(e, 'ctx')
export G_MESSAGES_DEBUG="GNOME Shell"
export SHELL_DEBUG=all
```

Wayland (padrão hoje) não tem `Alt+F2 r`. Use shell aninhado isolado:
```bash
# GNOME <=48
dbus-run-session gnome-shell --nested --wayland
# GNOME 49+
dbus-run-session gnome-shell --devkit --wayland
```
Dentro da janela aninhada, abra um terminal e dê `enable`. Xorg legado: `Alt+F2` -> `r`.

Regra crítica: mudança em `extension.js` exige novo processo (fechar/reabrir nested, ou logout). `disable/enable` sozinho NÃO recarrega código.

Looking Glass: `Alt+F2` -> `lg` -> abas Evaluator (`Main.panel`, `global.stage`), Extensions (erros), Actors.

Lint:
```bash
npm i -D eslint eslint-plugin-gjs
# extends: plugin:gjs/extension
```

## 5. Publicar em extensions.gnome.org

```bash
gnome-extensions pack ./meutray@exemplo.com -o dist/ -f
gnome-extensions upload *.shell-extension.zip --user=... --accept-tos
```
Revisão exige: `uuid` tipo `id@dominio`, licença GPL compatível, sem ofuscação/binário, `enable()` cria / `disable()` limpa.

## 6. Referências

- https://gjs.guide/extensions/development/creating.html
- https://gjs.guide/extensions/overview/anatomy.html
- https://gjs.guide/extensions/development/debugging.html
- https://gjs.guide/extensions/topics/popup-menu.html
- https://gjs.guide/extensions/topics/quick-settings.html
- https://gjs.guide/extensions/review-guidelines/review-guidelines.html
- https://github.com/ubuntu/gnome-shell-extension-appindicator
- https://github.com/christopher-l/space-bar
