# apps

Repositório de **extensões para o GNOME Shell** — indicadores minimalistas na top bar,
cada um em sua própria pasta (`<uuid>/`), com modo dev isolado via `mutter-devkit`.

Requisito geral: GNOME 48–50.

## Extensões

### 1. SysMon Tray (`sysmon-tray@local/`)

Monitor minimalista de **CPU, GPU e RAM** na top bar.
Mostra sempre os 3 valores (`CPU 12%  GPU 5%  RAM 3.2G`); o popup traz gráfico
de histórico de 2 min para cada um, slider de taxa (1–5s), controle de posição
(Esquerda/Direita) e botão Desligar. GPU com detecção automática:
NVIDIA (`nvidia-smi`) → AMD (`gpu_busy_percent`) → Intel (frequência).

Detalhes em [`sysmon-tray@local/README.md`](sysmon-tray@local/README.md).

### 2. OpenCode Go Tray (`opencode-go-tray@local/`)

Monitor das cotas do plano **OpenCode Go** na top bar.
Mostra **só um ícone** (logo em `assets/`, claro/escuro conforme o tema);
ao clicar abre o modal com as 3 janelas oficiais via
`GET https://opencode.ai/zen/go/v1/usage`:

```
OpenCode Go                    [● ok]
5-hour   [████░░░░] 12% usado   reseta em 2h14m
Weekly   [███░░░░░] 17% usado   reseta em 3d2h
Monthly  [█░░░░░░░]  8% usado   reseta em 12d

[Atualizar]                    [Abrir dashboard]
```

Auth: `OPENCODE_API_KEY` (env) → `~/.local/share/opencode/auth.json`.
Sem tela de preferências no v1.

Detalhes em [`opencode-go-tray@local/README.md`](opencode-go-tray@local/README.md).

## Estrutura

```
apps/
  README.md                  # este arquivo
  sysmon-tray@local/         # extensão 1 (+ schemas/, run-dev.sh, README próprio)
  opencode-go-tray@local/    # extensão 2 (+ assets/, schemas/, run-dev.sh, README próprio)
  *.shell-extension.zip      # pacotes gerados (ignorados pelo git)
```

Cada extensão segue o mesmo ciclo: editar → `gnome-extensions pack` →
`gnome-extensions install --force` → `./run-dev.sh` (Shell isolado em janela,
sem afetar a sessão) → logout/login para ativar na sessão real.
O Shell só detecta extensões novas no login:

```bash
gnome-extensions enable <uuid>
```

Logs da sessão real:

```bash
journalctl -f -o cat /usr/bin/gnome-shell | grep -Ei 'sysmon|gobar'
```
