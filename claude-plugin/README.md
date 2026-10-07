# harness

Mod do Claude Code que mostra e comanda o trabalho que o Herdr-Jev já decide: papel, modelo e effort de cada tarefa. O mod não escolhe modelos; ele lê `herdr-jev models list --json --client claude` e `herdr-jev triage` e dispara subagentes nativos com o id exato do Claude Code (`cliModel`).

## O que aparece

- Banda acima do prompt: `harness · <pasta> · ● <tarefa rodando> · <papel/modelo> · <verificadas>/<total> ██████░░░░`, mais `N approved, harness review pending` (`running` enquanto o review roda; depois de um review que não ficou `ready`, `harness review: <status>`, `harness review: timed out` ou `harness review: failed`), `? N needs you`, `✗ <tarefa falha>` ou `all verified` (some sozinha após 20 s). Botões `Plan` e `Hide`.
- Pane `harness` (comando `/harness`): objetivo e modelo do advisor, uma linha por tarefa (estado, id, título, papel/modelo/effort, dependências, motivo), workers ativos (última ferramenta e tempo), pendências para você, o resultado do último `herdr-jev review` (status e resultado por escopo) e os botões `Run next` e `Refresh review`.
- Se o modelo da sessão não for Fable, a banda avisa em cinza: `advisor model is <x>, expected Fable`. O mod continua funcionando.

## Como carregar

```
claude --plugin-dir /caminho/para/herdr-jev/claude-plugin
```

Validar e testar:

```
claude plugin validate claude-plugin
claude plugin test claude-plugin
```

## Ferramentas

| Ferramenta | Entrada | O que faz |
| --- | --- | --- |
| `harness_plan` | `objective`, `tasks[{ title, deps?, paths?, checks?, role? }]` | Roda `herdr-jev models list --json --client claude` uma vez e `herdr-jev triage <tarefa> --json` por tarefa, atribui papel e devolve o plano com ids estáveis `hp-<8 hex>`. Recusa trocar o plano enquanto houver workers rodando. |
| `harness_run` | `taskId?` | Com `taskId`, roda a tarefa. Sem, roda toda tarefa `proposed` com dependências prontas, até `maxWorkers`. Chamar duas vezes (ou em paralelo) devolve o `agentId` existente, nunca spawna de novo. Tarefa de advisor é marcada `done`. |
| `harness_status` | nenhuma | Resumo em texto do plano, workers, pendências, último review. |

As ferramentas aparecem para o modelo como `mcp__harness__harness_plan`, `mcp__harness__harness_run` e `mcp__harness__harness_status`. `harness_plan` e `harness_run` recusam qualquer chamada que traga `agentId`: só a sessão principal planeja e dispara workers.

## Modelos

Todo modelo e effort vem de `herdr-jev models list --json --client claude`. O mod não tem nomes de modelo próprios. O spawn usa o `cliModel` exato (por exemplo `claude-sonnet-5-5`) e o tipo de agente é registrado com esse modelo e o effort do papel, mapeado para o Claude Code: `standard` vira `medium`, `high` fica `high`, `xhigh` fica `xhigh`. Se o effort de uma tarefa diferir do registrado, o tipo é registrado de novo antes do spawn, sob o mesmo lock do spawn.

Os quatro tipos (`harness:implementer`, `harness:reviewer`, `harness:reader`, `harness:mechanic`) são registrados já no `session.start`, a partir de uma chamada `models list --json --client claude` que roda sem bloquear a cadeia do evento (depois de `next(e)`, com catch próprio). Se essa chamada falhar, nada é registrado e o registro preguiçoso no spawn continua valendo; ele também continua registrando de novo quando modelo ou effort mudam. Sobre o prazo de registro: o `claude-code.d.ts` diz que `$.agent.register` define um tipo que a ferramenta Agent despacha "from the next turn on", e que o `$.agent.spawn` de um plugin responde a `agent.spawn` sem passar pela oferta; ele não afirma que o `$.agent.spawn` do próprio plugin espera o próximo turno. Por isso o mod registra no início e mantém o registro no spawn.

Se `models list` falhar, ou um papel vier sem `cliModel` (`"cliModel": null, "error": "..."`), o plano fica `stale`, o modelo aparece como `?` e o mod RECUSA spawnar aquele papel: `harness_run` devolve o motivo e a tarefa continua `proposed`. Não existe fallback para nomes fixos. Para recuperar, corrija o `herdr-jev` e chame `harness_plan` de novo.

O `triage` só decide o papel da tarefa (`trivial`, `routine`, `moderate`, `architectural`). Se ele falhar, a tarefa vira implementer e o plano fica `stale`.

## Papéis

| Papel | Modelo | Como roda | Quando |
| --- | --- | --- | --- |
| advisor | a própria sessão (Fable) | nunca é spawnado, estado `advisor` | triage `architectural` |
| implementer | papel `implementer` do models list | subagente `harness:implementer`, todas as tools menos `Agent`, `harness_run`, `harness_plan` | triage `routine` ou `moderate`; sempre ganha review |
| reviewer | papel `reviewer` do models list | subagente `harness:reviewer`, só `Read`, `Glob`, `Grep` (sem Bash), mais `disallowedTools` para Edit, Write, MultiEdit, NotebookEdit, Bash, Agent e as ferramentas do harness; termina com `REVIEW_GATE_VERDICT: APPROVE` ou `CHANGES_REQUIRED` | depois de cada implementer ou mechanic |
| reader | papel `reader` do models list | subagente `harness:reader`, só `Read`, `Glob`, `Grep`; termina `done` e conta como completo sem review | título com read, collect, inventory, research (qualquer triage); com triage `trivial`, também list, inspect, audit, map, summarize |
| reader (writes) | o mesmo modelo e effort do reader | subagente `harness:mechanic`, `Read`, `Glob`, `Grep`, `Edit`, `Write`, `Bash`, sem `Agent` nem ferramentas do harness; aparece como `reader` com a nota `writes` | título com scaffold, fixture, lint, convert, rename; triage `trivial` SEM palavra de leitura (Haiku com tools de escrita); `role: "mechanic"` manual; SEMPRE encadeia o reviewer, como o implementer |

A palavra de leitura só vale como palavra inteira (`readme` e `thread` não contam) e é ignorada quando o título começa com um verbo de escrita (`Fix the read timeout in client.ts` não vira reader: com triage `routine` vai para o implementer, com `trivial` para o mechanic). Ou seja, `Fix typo in README` (trivial) vai para o mechanic, e `Inventory adapters` vai para o reader.

Um `role` informado na tarefa (`reader`, `mechanic`, `implementer`, `advisor`) vale como override manual. Os quatro tipos de agente ficam fora da lista de agentes oferecidos ao modelo; só o mod spawna.

## Fluxo de estados

`proposed` -> `running` -> `review` -> `approved` -> `verified`.

- `approved`: o reviewer deu `APPROVE`. Ainda não é `verified`. Tarefas `approved` já liberam as dependentes, mas a banda mostra `N approved, harness review pending` (ou o status do último review).
- `verified`: só o botão `Refresh review` promove. Ele roda `herdr-jev review --json` (passa `--timeout-ms 540000`, o prazo de cada judge do `herdr-jev review`, abaixo do teto de 600 s do `$.process.run`, para o CLI devolver um status não `ready` em vez de ser morto; se o processo ainda assim estourar os 600 s, o refresh aparece como `review timed out`, separado de `review failed`); se o `status` do relatório for `ready`, toda tarefa que estava `approved` quando o refresh começou vira `verified`. Qualquer outro status (`pending_*`, erro) mantém as tarefas `approved`. O `herdr-jev review` sai com código 1 sempre que o status não é `ready`, então o mod lê o JSON do stdout mesmo assim. O relatório não tem campo `verdict`: o pane mostra o `status` e o resultado de cada escopo (`verify ready, <escopo> <status>`). Durante o review a banda e o pane mostram `review running`, e um segundo refresh não roda enquanto o primeiro não termina.
- O prompt do reviewer inclui o relatório do implementer e um bloco `<<<DIFF ... DIFF>>>` com `git diff --stat` e `git diff` dos paths da tarefa (o repositório inteiro se não houver paths), gerados pelo mod no momento do spawn, a partir do cwd, com o diff limitado a 20000 caracteres e uma nota de truncamento. Só entram mudanças ainda não staged; arquivos novos não rastreados não aparecem no diff.
- `harness_run <taskId>` numa tarefa `failed` por `CHANGES_REQUIRED` reexecuta o implementer ou mechanic com o último parecer do reviewer (guardado na tarefa como `reviewReport`, até 8000 caracteres) sob o título `Previous review findings`. Se a tarefa está `needs_you` porque o reviewer não deu veredito, o rerun refaz o REVIEW, não o implementer.
- Reader vai de `running` para `done` (sem review, conta como completo). Mechanic segue o mesmo caminho do implementer.
- `failed` (review com `CHANGES_REQUIRED`, turno abortado ou spawn recusado) e `needs_you` (worker terminou com `NEEDS_YOU: <pergunta>` ou o reviewer não deu veredito) podem ser reexecutados com `harness_run <taskId>`.
- `all verified` só aparece quando toda tarefa está `verified` ou `done`.

## Restauração

O estado é salvo em `$.store` com a chave `state:<session id>:<cwd>`, e só o plano da sessão atual é restaurado. O formato salvo é validado (estados e papéis desconhecidos rejeitam o plano inteiro).

Ao recarregar, uma tarefa `running` volta a `proposed` se o `agentId` não aparece em `$.agent.list()`; se o agente aparece como `completed`, a tarefa vira `needs_you` (idem para um reviewer). Se `$.agent.list()` falhar, nada é resetado: workers e tarefas ficam como estavam, o plano é marcado `stale` com a nota `agent list unavailable`; um reconcile seguinte que consegue listar limpa essa marca.

## Atividade dos workers

O hook `tool.call` atribui as chamadas de ferramenta de um subagente ao worker pelo `agentId`. Só ficam o nome da ferramenta e, para Read, Edit e Write, o nome-base do arquivo, e para Glob o padrão. O padrão do Grep nunca é guardado (só `Grep`). Texto de comando Bash nunca é guardado nem exibido (só `Bash`).

## Configuração (`userConfig`)

- `herdrJevBin` (padrão `herdr-jev`): executável, resolvido pelo PATH.
- `maxWorkers` (padrão `3`): máximo de tarefas `running` ao mesmo tempo. Reviewers não contam.

## Limites conhecidos

- O mod é observacional: não nega nada e não muda permissões. Workers só nascem por `harness_run`, pelo botão `Run next` ou pelo encadeamento implementer/mechanic -> reviewer em `turn.complete`. A restrição de ferramentas dos tipos de agente vem de `tools` e `disallowedTools` do `$.agent.register`.
- Spawn de reviewer usa o mesmo claim atômico do `startTask` (`reviewStarting`), então `harness_run` em paralelo, `Run next` e reload nunca criam dois reviewers para a mesma tarefa.
- `$` não pode ser passado entre arquivos do mod (regra do validador), então `cli.ts` e `workers.ts` recebem portas (`run`, `spawn`, `register`) em vez de `$`.
- O spawn de um plugin sempre roda em background; não existe campo `background` em `$.agent.spawn`, nem `effort`: o effort vai no tipo registrado.
- O review do harness é manual (`Refresh review`); nada o dispara sozinho.
