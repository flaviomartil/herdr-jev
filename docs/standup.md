# Standup Orientado a Arquivo

O comando `herdr-jev standup` envia as instruções do dia para agentes livres (estados `idle` ou `done`) a partir de um arquivo Markdown configurável.

## Formato do Arquivo

O arquivo de standup utiliza Markdown com front matter opcional delimitado por linhas `---`:

```markdown
---
states: idle,done
max: 12
---
Bom dia time! Hoje é {{date}}. Priorize os testes e mantenha o harness limpo.

## herdr-jev
Revise as PRs abertas na branch {{branch}} e execute os testes do standup.

## InvoiceCon
Verifique a fila de validação e o status dos jobs no ambiente homologado.
```

### Chaves de Front Matter

- `states` (opcional, padrão `idle,done`): lista separada por vírgulas dos estados de agente elegíveis para receber o standup.
- `max` (opcional, padrão `12`, limitado a `100`): limite máximo de agentes que receberão instruções no ciclo.

Agentes em `working` ou `blocked` nunca recebem o standup, mesmo que apareçam em `states`.

### Seções e Escopo

- **Texto Global**: o conteúdo antes do primeiro cabeçalho `## ` é aplicado a todos os agentes elegíveis.
- **Seções por Projeto (`## <nome>`)**: aplicam-se apenas a agentes cujo nome do projeto ou label do workspace corresponda a `<name>`, de forma insensível a maiúsculas/minúsculas (*case-insensitive*).
- **Composição da Mensagem**: a mensagem final de cada agente é a união do texto global com a seção correspondente, separados por uma linha em branco (`\n\n`). Agentes sem texto aplicável não recebem nada.
- **Limite de Mensagem**: cada mensagem é limitada ao teto de 8 KB (8192 bytes).

### Variáveis Disponíveis

- `{{date}}`: data atual formatada como DD/MM/AAAA (ex: `01/10/2026`).
- `{{project}}`: nome do projeto ou label do workspace do agente.
- `{{branch}}`: branch Git ativa no diretório de trabalho do agente.
- `{{agent}}`: identificador ou nome do agente no Herdr.

## Comportamento do `--auto`

O modo `--auto` foi desenhado para execuções automatizadas e agendadas por daemons ou cron jobs, sem necessidade de painel chamador ativo (`HERDR_PANE_ID` pode não estar definido):

1. **Arquivo ausente ou em branco**: exibe `{"skipped":"no_file"}` e encerra com código `0`.
2. **Execução já realizada hoje**: verifica a existência de `<stateDir>/standup/YYYY-MM-DD.auto.json`. Se o arquivo existir e `--force` não for especificado, exibe `{"skipped":"already_ran_today"}` e encerra com código `0`.
3. **Disparo seguro**: constrói a lista de agentes livres (respeitando o filtro `--pane`, se fornecido), ignorando painéis bloqueados, em execução (`working`), sem agente, duplicados ou de plugins (`Jev Lantern`, `Jev Office`, `Jev Radar`). Em seguida, envia as mensagens sequencialmente pelo caminho seguro de peer. Se não houver nenhum alvo, encerra sem gravar estado.
4. **Persistência de estado**: registra o resultado da execução em `<stateDir>/standup/YYYY-MM-DD.auto.json`. Envios manuais com `--yes` gravam `<stateDir>/standup/YYYY-MM-DD.manual-<timestamp>.json` e não afetam a trava diária do `--auto`.

### Diretórios de Configuração e Estado

- **Arquivo padrão**: `<configDir>/standup.md`, onde `configDir` respeita `HERDR_PLUGIN_CONFIG_DIR`, com fallback para `~/.config/herdr/plugins/config/herdr-jev`.
- **Diretório de estado**: `<stateDir>/standup`, onde `stateDir` respeita `HERDR_JEV_STATE_DIR`, depois `HERDR_PLUGIN_STATE_DIR`, com fallback para `~/.local/state/herdr-jev`.

### Opções de Linha de Comando

- `--file <path>`: caminho alternativo para o arquivo de standup.
- `--auto`: execução autônoma com travas de arquivo ausente e idempotência diária.
- `--dry-run`: calcula e exibe apenas o plano sem enviar mensagens, incluindo o array `skipped`.
- `--yes`: confirma e executa o envio imediato em modo interativo.
- `--force`: ignora a trava de execução diária e força novo envio.
- `--json`: imprime os resultados estruturados em formato JSON, incluindo o array `skipped` para agentes em estado elegível não planejados (`no_text`, `caller`, `no_agent`, `plugin_pane`, `beyond_max`, `filtered`). Sem essa opção, imprime uma linha descritiva por alvo planejado, executado ou ignorado.
- `--pane <id>`: restringe o standup aos painéis indicados (repetível). Agentes nesses painéis ainda devem cumprir as regras de estado elegível.

Sem `--yes` e sem `--auto`, o comando opera em modo de planejamento equivalente ao `--dry-run`. Fora do `--auto`, um arquivo ausente encerra com o erro `Standup file not found: <path>`.

## Agendamento com o Plugin herdr-routines

Para agendar o standup diário automaticamente nos dias úteis às 09:00, adicione o seguinte trecho à configuração do plugin `herdr-routines`:

```toml
[[routine]]
name = "jev-standup"
type = "shell"
cron = "0 9 * * mon-fri"
catch_up = true
command = "herdr-jev standup --auto"
```
