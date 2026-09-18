#!/bin/bash
# SysMon Tray — modo dev: abre um GNOME Shell isolado em janela
# com a extensao ja ativada. Feche a janela para encerrar.
# Uso: ./run-dev.sh   (a partir da raiz do projeto)
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

dbus-run-session -- bash -c '
  /usr/bin/gnome-shell --devkit --wayland > "'"$LOG"'" 2>&1 &
  SHPID=$!
  for i in $(seq 1 30); do
    gdbus introspect --session --dest org.gnome.Shell --object-path /org/gnome/Shell >/dev/null 2>&1 && break
    sleep 1
  done
  sleep 3
  gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
    --method org.gnome.Shell.Extensions.EnableExtension "'"$UUID"'"
  echo "Sessao dev pronta (PID $SHPID). Feche a janela para encerrar."
  echo "Log: '"$LOG"'"
  wait $SHPID
'
