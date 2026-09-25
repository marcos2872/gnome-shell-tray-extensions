# OpenCode Go Tray

Monitor do plano **OpenCode Go** na top bar do GNOME Shell.
Top bar mostra **só um ícone**; ao clicar abre o modal com as cotas oficiais:

```
OpenCode Go                    [● ok]
5 horas  [████░░░░] 12% usado   reseta em 2h14m
Semanal  [███░░░░░] 17% usado   reseta em 3d2h
Mensal   [█░░░░░░░]  8% usado   reseta em 12d

[Atualizar]                    [Abrir dashboard]
```

Fonte: `GET https://opencode.ai/zen/go/v1/usage` com `Authorization: Bearer <key>`.
Auth (nesta ordem): `OPENCODE_API_KEY` (env) → `opencode.db` (`credential opencode-go`, v2) → `~/.local/share/opencode/auth.json`
(`opencode-go`, fallback `opencode`). Botão dashboard abre `https://opencode.ai/go`.
Sem billing/scrape e sem tela de preferências no v1.

## Como rodar (modo dev)

```bash
sudo dnf install -y mutter-devkit
./run-dev.sh
```

## Instalar na sessão real

```bash
# a partir de apps/opencode-go-tray@local/ (o pack achata --extra-source na raiz,
# o trecho python recoloca em assets/):
gnome-extensions pack . -o .. --force \
  --extra-source=assets/opencode-logo-light.svg \
  --extra-source=assets/opencode-logo-dark.svg \
  --extra-source=assets/opencode-logo-light.png \
  --extra-source=assets/opencode-logo-dark.png -q
python3 -c "
import zipfile
zp = '../opencode-go-tray@local.shell-extension.zip'
z = zipfile.ZipFile(zp)
datas = {n: z.read(n) for n in z.namelist() if n.startswith('opencode-logo-')}
z.close()
z = zipfile.ZipFile(zp, 'a')
[z.writestr('assets/' + n, d) for n, d in datas.items()]
z.close()"
cd ..
gnome-extensions install opencode-go-tray@local.shell-extension.zip --force
glib-compile-schemas opencode-go-tray@local/schemas/
cp opencode-go-tray@local/schemas/gschemas.compiled ~/.local/share/gnome-shell/extensions/opencode-go-tray@local/schemas/
# logout/login, depois:
gnome-extensions enable opencode-go-tray@local
```

Logs: `journalctl -f -o cat /usr/bin/gnome-shell | grep gobar`

## Estrutura

```
opencode-go-tray@local/
  extension.js      # icone + poll curl async + modal 5h/weekly/monthly
  metadata.json     # uuid, shell-version 48-50
  stylesheet.css    # visual .gobar-* (hover nos botoes)
  schemas/          # GSettings (refresh 300, tray-side)
  run-dev.sh        # GNOME isolado em janela
```
