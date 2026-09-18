# SysMon Tray

Réplica GNOME do **exelban/stats**: monitor na top bar com tipografia
SF Pro Text → Inter/Cantarell (valor 12px regular, mini-label 7px light,
título popup 13px semibold, números tabulares).

Módulos: **CPU, GPU, RAM, Rede, Disco, Sensores, Bateria (+BT)**.
Top bar mostra por padrão só `CPU GPU RAM` em texto (`CPU 12%  GPU 5%  RAM 3.2G`).
O popup é separado em **abas** (CPU/GPU/RAM/NET/DSK/TMP/BAT): cada aba traz
gráfico de histórico de 2 min + grade de detalhes + top5 (CPU/RAM) +
opções **Gráfico** (mostra/oculta label+gráfico) e **Mostrar na top bar**.
Rodapé com slider de taxa (1–5s) e botão Desligar + seletor Esq/Dir.
GPU: NVIDIA → AMD → Intel.

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
gnome-extensions pack ./sysmon-tray@local -o . --force \
  --extra-source=collectors.js --extra-source=history.js \
  --extra-source=cards.js
gnome-extensions install sysmon-tray@local.shell-extension.zip --force
cp sysmon-tray@local/collectors.js sysmon-tray@local/history.js \
  sysmon-tray@local/cards.js \
  ~/.local/share/gnome-shell/extensions/sysmon-tray@local/
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
  extension.js      # N botões do tray + timer + UPower
  cards.js          # builders dos cards estilo Stats (hero/dots/bar/top)
  collectors.js     # leitores puros (CPU/RAM/Net/Disco/Sensores/top/per-core)
  history.js        # ring buffer 120pts
  metadata.json     # uuid, shell-version, settings-schema
  stylesheet.css    # tipografia Stats + tokens
  prefs.js          # Preferências (módulos + atualização + temp/rede/disco)
  schemas/          # GSettings (refresh, tray-side, show-* [só CPU/RAM/GPU default], graph-*, temp-unit, net-iface, disk-mount)
  run-dev.sh        # modo dev (este README)
```
