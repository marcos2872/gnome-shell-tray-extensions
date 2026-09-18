# SysMon Tray

Monitor minimalista de **CPU, GPU e RAM** na top bar do GNOME Shell.
Top bar sempre mostra os 3 (`CPU 12%  GPU 5%  RAM 3.2G`); o popup traz
um gráfico de histórico de 2 min para cada um, mais slider de taxa
(1–5s) e botão Desligar. GPU com detecção automática:
NVIDIA (`nvidia-smi`) → AMD (`gpu_busy_percent`) → Intel (frequência).

## Como rodar (modo dev)

Pré-requisito (uma vez só — sem ele a janela não abre):

```bash
sudo dnf install -y mutter-devkit
```

Abre um GNOME Shell isolado em janela, sem afetar sua sessão:

```bash
./run-dev.sh
```

Feche a janela para encerrar. Logs em `/tmp/sysmon-tray-dev.log`:

```bash
tail -f /tmp/sysmon-tray-dev.log | grep -i sysmon
```

> Requer GNOME 48–50 com suporte a `gnome-shell --devkit --wayland`.

## Ciclo de desenvolvimento

Após editar qualquer arquivo, reempacote + reinstale a partir da pasta pai
(`apps/`) e reabra o dev (mudança em `extension.js` só pega em nova sessão):

```bash
cd .. # apps/
gnome-extensions pack ./sysmon-tray@local -o . --force
gnome-extensions install sysmon-tray@local.shell-extension.zip --force
cp sysmon-tray@local/schemas/gschemas.compiled ~/.local/share/gnome-shell/extensions/sysmon-tray@local/schemas/
./run-dev.sh
```

## Uso real (sessão principal)

O Shell só detecta extensões novas no login:

1. Faça logout/login.
2. `gnome-extensions enable sysmon-tray@local`
   (ou ative pelo app Extensões / Extension Manager).
3. Logs: `journalctl -f -o cat /usr/bin/gnome-shell | grep sysmon`

## Estrutura

```
sysmon-tray@local/
  extension.js      # coleta (CPU/RAM/GPU) + tray + popup + gráficos + slider
  metadata.json     # uuid, shell-version, settings-schema
  stylesheet.css    # visual Adwaita/Apple
  prefs.js          # Preferências (taxa de atualização)
  schemas/          # GSettings (refresh 1–5, padrão 2)
  run-dev.sh        # modo dev (este README)
```
