#!/bin/bash
# SysMon Tray — modo dev: abre um GNOME Shell isolado em janela
# com a extensao ja ativada. Feche a janela para encerrar.
# Uso: ./run-dev.sh                  (via wrapper na raiz do projeto)
#      ./sysmon-tray@local/run-dev.sh (direto, de qualquer lugar)
set -e
UUID="sysmon-tray@local"
LOG="/tmp/sysmon-tray-dev.log"

if [ ! -x /usr/libexec/mutter-devkit ]; then
  echo "ERRO: falta o pacote 'mutter-devkit' (necessario para o modo dev em janela)."
  echo "Instale com:  sudo dnf install -y mutter-devkit"
  echo "Depois rode ./run-dev.sh novamente."
  exit 1
fi

rm -f "$LOG"

# Sincroniza fontes (inclui cards.js/collectors.js/history.js que o
# `gnome-extensions pack` não leva por padrão sem --extra-source)
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
mkdir -p "$DEST"
cp "$SRC/extension.js" "$SRC/cards.js" "$SRC/collectors.js" "$SRC/history.js" \
   "$SRC/prefs.js" "$SRC/metadata.json" "$SRC/stylesheet.css" "$DEST/"
[ -d "$SRC/schemas" ] && cp -r "$SRC/schemas" "$DEST/"
glib-compile-schemas "$DEST/schemas/" >/dev/null 2>&1 || true
echo "Sincronizado: $SRC -> $DEST"

dbus-run-session -- bash -c '
  /usr/bin/gnome-shell --devkit --wayland > "'"$LOG"'" 2>&1 &
  SHPID=$!
  trap "kill $SHPID 2>/dev/null" EXIT
  UP=0
  for i in $(seq 1 45); do
    if gdbus introspect --session --dest org.gnome.Shell --object-path /org/gnome/Shell >/dev/null 2>&1; then UP=1; break; fi
    kill -0 $SHPID 2>/dev/null || break
    sleep 1
  done
  if [ "$UP" != "1" ]; then
    echo "ERRO: o GNOME Shell dev nao subiu em 45s (procurar crash no log)."
    echo "Log: '"$LOG"'"
    exit 1
  fi
  if ! gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
    --method org.gnome.Shell.Extensions.EnableExtension "'"$UUID"'" >/dev/null 2>&1; then
    echo "ERRO: falha ao habilitar a extensao no shell dev."
    echo "Log: '"$LOG"'"
    exit 1
  fi
  echo "Sessao dev pronta (PID $SHPID). Feche a janela para encerrar."
  echo "Log: '"$LOG"'"
  wait $SHPID
'