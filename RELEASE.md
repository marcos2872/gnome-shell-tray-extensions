# Releases — um app, uma tag, uma release

Guia genérico para publicar a release de **qualquer app deste repo**, cada um com
sua descrição, sua versão e seus artefatos — independentes entre si.

> Neste arquivo, `<app>` é o nome curto do app (ex: `sysmon-tray`),
> `<ver>` é a versão (ex: `v1.2.0`) e `<artefato>` é o arquivo entregável
> (ex: `.zip`, `.tar.gz`, binário). Os valores concretos de cada app deste
> repo estão no **Apêndice A**.

## 1. Conceito

- **1 app = 1 linha de versão = 1 release GitHub.** Apps diferentes nunca
  compartilham tag nem versão.
- A release é identificada por uma **tag git anotada** no formato:

```
<app>-<ver>            ex: sysmon-tray-v1.0.0
```

- O `gh release create <tag>` transforma a tag em Release publicada, com
  título, descrição e arquivos anexados.

## 2. Versionamento (semver por app)

Formato `vMAJOR.MINOR.PATCH`, evoluído **separado por app**:

| Bump | Quando usar |
|---|---|
| `major` (`v1.x → v2.0.0`) | Quebra compatibilidade (API, formato, migração manual) |
| `minor` (`v1.2 → v1.3.0`) | Funcionalidade nova compatível |
| `patch` (`v1.2.3 → v1.2.4`) | Correção de bug, ajuste visual, docs |

Regras:

- Nunca reutilize uma tag. Errou a release? Sobe o patch e corta outra.
- `v0.x.y` = ainda instável; `v1.0.0` = primeiro contrato estável.
- Para testar sem "gastar" versão estável: `gh release create --prerelease`
  (ex: `<app>-v2.0.0-rc.1`).

## 3. Pré-requisitos

```bash
git status --short        # árvore precisa estar limpa no fim do passo 4
gh auth status            # precisa estar logado
```

## 4. Passo a passo (igual para qualquer app)

### 4.1 Deixar tudo commitado e pusheado

```bash
git status --short
git add -A && git commit -m "chore(<app>): prepare <ver> release"
git push
```

### 4.2 Gerar e validar o artefato

Gere o entregável do app **a partir do commit já pusheado** e valide que ele
funciona (instala, abre, smoke test do Apêndice A se houver). Só siga com o
artefato validado em mãos:

```bash
ls -la <artefato>   # ex: /tmp/<app>.zip
```

### 4.3 Criar a tag anotada e subir

```bash
git tag -a <app>-<ver> -m "<Nome bonito> <ver>"
git push origin <app>-<ver>
git tag --list "<app>-v*"   # confere
```

### 4.4 Criar a Release com artefatos

```bash
gh release create <app>-<ver> \
  --title "<Nome bonito> <ver>" \
  --notes "<descrição curta + destaques + requisitos>" \
  <artefato> [outros-arquivos...]
```

Flags úteis:

| Flag | Efeito |
|---|---|
| `--prerelease` | Marca como pré-release (não é "latest") |
| `--draft` | Cria como rascunho para revisar antes de publicar |
| `--latest=false` | Não marca como latest (para backports/patches antigos) |
| `--notes-file CHANGELOG.md` | Usa um arquivo como corpo em vez de `--notes` |

Conferir e editar depois:

```bash
gh release view <app>-<ver>
gh release edit <app>-<ver> --notes "novo texto"
gh release upload <app>-<ver> <arquivo-extra> --clobber
```

### 4.5 Template de corpo da release (`--notes`)

```markdown
<1-2 frases: o que é o app + o que mudou nesta versão.>

Destaques:
- ...
- ...

Requisitos: ...
Instalação: ...
```

## 5. Se algo der errado

| Problema | Correção |
|---|---|
| Tag errada **antes** da release | `git tag -d <tag> && git push origin :<tag>`, refazer do 4.3 |
| Release com artefato errado | `gh release delete <tag> --yes`, apagar a tag, refazer do 4.3 |
| Precisa trocar só o arquivo | `gh release upload <tag> <artefato> --clobber` |
| Precisa corrigir só o texto | `gh release edit <tag> --notes "..."` |
| Push da tag recusado | Alguém já usou a tag: escolha outra versão, nunca force |

## 6. Checklist rápido

- [ ] Tudo commitado e pusheado **antes** da tag
- [ ] Artefato gerado do commit pusheado e validado (smoke test)
- [ ] Tag no formato `<app>-vX.Y.Z`, anotada (`-a`)
- [ ] `gh release view` mostra título, notes e artefatos corretos
- [ ] Instalação a partir do artefato da release funciona

---

## Apêndice A — apps deste repo

| App | Pasta | Prefixo da tag | Descrição para `--notes` |
|---|---|---|---|
| SysMon Tray | `sysmon-tray@local/` | `sysmon-tray-` | Réplica GNOME do exelban/stats: CPU, GPU, RAM, rede, disco, sensores e bateria na top bar com tipografia Stats. Tray em texto por padrão, popup em abas com gráfico de 2 min, detalhes, top processos e toggles por módulo. Requer GNOME 48–50. |
| OpenCode Go Tray | `opencode-go-tray@local/` | `opencode-go-tray-` | Cotas do plano OpenCode Go na top bar (5-hour, Weekly e Monthly via API oficial). Ícone único que abre o modal com as cotas ao clicar. Requer GNOME 48–50 e `OPENCODE_API_KEY` (env) ou `auth.json`. |

### A.1 Particularidades de pack (artefato = `.zip` instalável)

```bash
cd /home/marcos/Projetos/Pessoal/apps
# SysMon Tray (tem .js extras):
gnome-extensions pack ./sysmon-tray@local -o /tmp --force \
  --extra-source=collectors.js --extra-source=history.js
# OpenCode Go Tray (logos vão na raiz do zip; extension.js tem fallback assets/ -> raiz):
gnome-extensions pack ./opencode-go-tray@local -o /tmp --force \
  --extra-source=assets/opencode-logo-dark.svg \
  --extra-source=assets/opencode-logo-light.svg
# => /tmp/<app>@local.shell-extension.zip
```

### A.2 Smoke test GNOME (passo 4.2 para estes apps)

```bash
gnome-extensions install /tmp/<app>@local.shell-extension.zip --force
# SysMon Tray: copiar também os .js extras + schemas compilados:
# cp sysmon-tray@local/{collectors.js,history.js} \
#     ~/.local/share/gnome-shell/extensions/sysmon-tray@local/
# cp <app>@local/schemas/gschemas.compiled \
#     ~/.local/share/gnome-shell/extensions/<app>@local/schemas/
gnome-extensions disable <app>@local; sleep 1
gnome-extensions enable <app>@local; sleep 3
journalctl --since "1 minute ago" -o cat /usr/bin/gnome-shell \
  | grep -iE "JS ERROR" | head
# esperado: Estado: ACTIVE e zero erros
```

### A.3 Exemplo completo (SysMon Tray v1.0.0)

```bash
git add -A && git commit -m "chore(sysmon-tray): prepare v1.0.0 release" && git push
git tag -a sysmon-tray-v1.0.0 -m "SysMon Tray v1.0.0" && git push origin sysmon-tray-v1.0.0
gh release create sysmon-tray-v1.0.0 \
  --title "SysMon Tray v1.0.0" \
  --notes "Réplica GNOME do exelban/stats: 7 módulos, popup em abas, tipografia Stats. Requer GNOME 48–50." \
  /tmp/sysmon-tray@local.shell-extension.zip
```
