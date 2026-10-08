# harness

Mod do Claude Code que mostra e comanda o trabalho que o Herdr-Jev já decide: papel, modelo e effort de cada tarefa. O mod não escolhe modelos; ele lê `herdr-jev models list --json --client claude` e `herdr-jev triage` e dispara subagentes nativos com o id exato do Claude Code (`cliModel`).

## O que aparece

- Banda acima do prompt: uma linha só, sem borda, no formato do task-line. Da esquerda: botão `▸`/`▾`, glifo do estado (`●` claude rodando ou em review, `?` aviso precisa de você, `!` erro falha, `◆` aviso aprovada esperando o review do harness, `✓` sucesso tudo verificado com o título `Done`, `○` inactive planejado), título da tarefa atual (`wrap="truncate-end"`), barra que enche o espaço restante, `liquidadas/total`, percentual em negrito (sucesso, aviso, erro ou cor padrão conforme o estado), nota em negrito na cor do estado (`needs you`, `failed` ou `failed: <tarefa>` quando outra roda, `review`, `review pending|running|<status>`), tempo do worker atual, `approved N` em cinza e, à direita, os botões simples `Plan` (abre o pane), a contagem de pendências em aviso e `×` (esconde até o próximo plano). A barra usa fatias de `Box` com `overflow="hidden"` e `━` repetido (receita do frank-claude-cockpit), por isso preenche qualquer largura em terminal e desktop. No desktop uma sobreposição `position="absolute"` com um `Button plain` de NBSP faz a linha inteira alternar o cartão. `all verified` some sozinha após 20 s.
  - Expandida (`▾`): um cartão `round` com `borderDimColor`, `paddingX={2}`, `paddingY={1}` e `rowGap={1}` acima da linha, com uma linha por tarefa aberta (no máximo 4): `● <título> (papel · modelo · effort)`, a ferramenta atual em cinza no meio e o tempo (`12s`, `1m 48s`) alinhado à direita por `Box flexGrow`. O ponto segue o estado. Depois, `+N more · N done`. Começa recolhida.
- Pane `harness` (comando `/harness`), no estilo do painel Sessions do frank-claude-cockpit:
  - Cabeçalho: glifo do estado, objetivo em negrito, `planned <idade>` em cinza e, à direita, `Run ready`, `↻ review` e `✕` (fecha o pane). Embaixo, a barra do plano enchendo a largura e o percentual.
  - Caixa `round` em aviso `── Needs you ──` (só aparece quando há perguntas, como no human-in-the-loop): `☐ N task(s) for you` em negrito e, por pergunta, `☐ #n <tarefa> <idade>` em negrito, a pergunta na linha seguinte e `Done when: <checks>` em cinza.
  - Seções `Needs you N` (falhas e perguntas), `Working N`, `Approved N` (esperando o review do harness), `Queued N` e `Done N` (recolhida; o título abre). Cada linha: `▸`/`▾`, `◐` (rodando ou review) ou `●` na cor do estado, id curto, título (clique abre) e o tempo à direita; abaixo, `papel · modelo · effort` em cinza. Aberta (a tarefa rodando abre sozinha), mostra um bloco chave/valor com chaves cinzas alinhadas (`worker`, `tool`, `deps`, `reason`, `review`, `note`) e, para `failed` e `needs_you`, o botão `Rerun`.
  - Uma linha de aviso para advisor diferente de Fable e dados desatualizados, `N approved, harness review ...`, o último `herdr-jev review` e o rodapé cinza `pasta · advisor <modelo> · review <status|not run> · auto-run on|off · auto-review on|off`.
  - Seção `Scope · enforce · 12 of 74 skills · 9 of 41 agents`, recolhida; aberta lista o que ficou visível e o motivo.
  - Sem plano: `No plan yet. Ask the advisor for one.` e os botões.
- Se o modelo da sessão não for Fable, o pane avisa; o mod continua funcionando.

## Scope

Reduz o que o modelo enxerga (listagem de skills e agentes) sem apagar nada e sem bloquear nada. Porta do mecanismo do harness-scope (MIT, shimo4228): `prompt.attachment` do tipo `skill_listing`, `agent.offer` e o recibo por `$.ui.log`. Em vez de arquivos de perfil estáticos, a lista permitida vem do AI Harness e do Jev. Não foram portados os denies de `tool.call` e `tool.describe` nem o filtro de arquivos de instrução: CLIs, regras obrigatórias e skills chamadas de propósito continuam. Uma skill escondida da listagem ainda roda se for chamada.

Skills mantidas, na ordem do motivo:

1. `project` e `built-in`: skills cuja origem é `projectSettings` ou `built-in` em `$.session.usage({ breakdown: 'summary' })`.
2. `invoked`: qualquer skill que você chamou com `/nome` na sessão (observado em `prompt.submit`).
3. `always`: `alwaysAllowSkills` (padrão `writing-clearly-and-concisely, harness-router, herdr-jev, ai-harness-context, plugin-authoring, vault, promote, code-review, simplify`), também com prefixo de plugin (`plug:vault`).
4. `skill-select`: `selected[].name` e `cliSelected[].name` de `ai-harness skill-select --client claude --query <consulta> [--runbook <id>]`. Roda no `session.start` (depois do `next(e)`, sem bloquear) com a consulta `<pasta> session` e de novo a cada `harness_plan` com o objetivo.
5. `route-turn`: `decision.skill` de `herdr-jev route-turn <texto> --json` a cada prompt (limite de 2 s, falha ignorada, nunca bloqueia).

Agentes mantidos: os embutidos (`general-purpose`, `Explore`, `Plan`, `claude-code-guide`, `statusline-setup`, `PlanChecker`), `harness:*`, os agentes do projeto (`source` `projectSettings`) e `alwaysAllowAgents` (padrão: os 16 nomes do ROUTER do AI Harness). O resto (`llmtrim-*`, `GrokForge`, `pr-review-toolkit:*`, agentes depreciados) recebe `{ isOffered: false }`.

`scopeMode`: `enforce` (padrão) esconde; `report` não esconde nada mas calcula o recibo (`would hide`); `off` desliga tudo. `runbook` (vazio por padrão) vai em `--runbook`.

Falhas: se o `skill-select` falha, o escopo fica `partial` e nenhuma skill é escondida; formato de listagem desconhecido ou skills do projeto ilegíveis deixam o texto passar sem mudança, com uma linha cinza em `$.ui.log` uma vez só. O escopo zera em `/clear` e `resume` (`classic.SessionStart`). `/harness scope` mostra o recibo (itens mantidos por motivo, escondidos, notas) só na tela; o pane tem a seção `Scope` recolhida.

Limite conhecido: o runbook não é detectado sozinho. O `ai-harness skill-select` roda sem `--runbook` (aceita) e só usa `runbook` quando configurado, então as CLIs que dependem de runbook só aparecem com ele.

## Claims

Aviso determinístico, sem modelo, para resposta que declara verificação que nada no turno sustenta. Adaptado do anti-cheat do pourya7/claude-code-mods (MIT), sem a banda de jogo, sem sprites e sem o prompt de desafio. Só avisa: não nega chamada de ferramenta, não segura nem encerra turno e nunca envia prompt. Na dúvida, não avisa.

- `turn.complete` da sessão principal (`reason: answer`) extrai afirmações da resposta, uma por tipo: `test` (`tests pass`, `testes passaram`), `lint` (`typecheck clean`, `typecheck limpo`), `build`, `ci` (`CI is green`, `CI verde`) e `verified` (`verified`, `verificado`, `all checks pass`, `todos passaram`). A palavra de sucesso precisa fechar a oração (pontuação, fim do texto, travessão, `(` com número, `after|depois`, `with no errors|without any errors|sem falhas` ou `and|but|e|mas`; advérbios como `successfully` e `com sucesso` são aceitos): `the build passes arguments` não é afirmação. Negação, condição, instrução (`confirm`, `before`, `check that`), plano (`when`, `after`, `quando`, `depois que`), esperado (`expected`, `esperado`), relato de terceiros (`says`, `answered`, `reported`, `disse`, `informou`) e relato misto (a mesma frase, antes ou depois da afirmação, tem um verbo de falha `fails|failed|falhou` ou um número maior que zero antes de `errors|failures|erros|falhas`, sem `no|none|nothing|not|zero|0|sem|nenhum|nada|não` até duas palavras antes; `all tests pass and the error is fixed` e `typecheck is clean, no type errors` continuam sendo afirmação; uma falha que a própria frase diz corrigida, antes da afirmação (`fixed|resolved|gone|corrigi|resolvi`), não cancela a afirmação, a menos que a frase também diga `still|ainda|remain|restam`), critério de aceite, checklist `- [ ]`, linha de tabela, pergunta, bloco de código, código em linha, texto entre aspas e citação (`>`) não são afirmação.
- `tool.call` (Edit, Write, NotebookEdit e Bash) alimenta o log da sessão. Uma edição vale como edição só se o arquivo estiver dentro da raiz da sessão (`$.session.root()`, que um `cd` no shell não move), não passar por `.claude/worktrees/` abaixo dela e não terminar em `.md`; numa sessão aberta dentro de um worktree, o próprio worktree é a pasta da sessão e os irmãos e o checkout principal ficam de fora. Os prefixos `(`, `{`, `if`, `while`, `exec`, `command`, `time`, `corepack`, `nice [-n N]`, `sudo [-u user]`, `timeout [-s SIG] [-k N] N`, `env [-u NAME] VAR=valor`, `VAR=$(...)`, `rtk [-u] [test|err|proxy|summary]`, `docker compose [-f arquivo] exec|run [flags] serviço`, `docker-compose` e `docker exec [flags] contêiner` são removidos antes de classificar, `bash|sh|zsh -c|-lc "..."` no começo de um comando é classificado pelo texto de dentro, strings entre aspas que apontam para `/tmp`, `/var/tmp`, `/dev` ou `$VAR` contam como alvo fora da árvore, o corpo de heredoc é ignorado e `<<<` e `<<` aritmético não são heredoc. Bash que escreve na árvore (redirecionamento, `sed -i[sufixo]`, `tee`, `mv`, `rm`, `git checkout <ref>`, `git restore`, `git reset --hard`, `--fix`, `--write`) também invalida a evidência; criar branch, `git -C <pasta fora da sessão>`, `git add`, `git commit`, `git stash list`, `git merge-base`, alvos em `/tmp` e `/dev` e qualquer chamada que o engine marque como `isReadOnly` não. Bash de teste, typecheck/lint, build ou leitura de status de CI depois da última edição é evidência do tipo certo (`pnpm --filter x test`, `bun --cwd x test`, `claude plugin test`, `herdr-jev review`, `az pipelines`, entre outros); `verified` aceita qualquer um. CI vale depois do último `git push` que não seja `--dry-run`. Execução com erro ou interrompida não é evidência; se um comando composto falha com mais de um tipo de check, nenhum tipo é culpado nem creditado. Sem nenhuma edição na sessão, nada é avisado; uma afirmação de CI também fica quieta quando não houve edição nem push.
- Subagentes: o engine atribui as chamadas pelo `agentId`. A edição de um subagente invalida a evidência só quando o arquivo está na pasta da sessão; o Bash de um subagente nunca conta como edição; a execução bem-sucedida de um subagente conta como evidência e uma falha dele nunca é apontada; a resposta de um subagente nunca é checada.
- A banda acima do prompt ganha uma linha por aviso (até 3, depois `+N more unverified`), na cor `warning`: `unverified: "all tests pass" · no test ran after the last edit`. O hook chama `next(e)` e acrescenta as linhas ao que veio, então a banda do plano e a de outros mods continuam. O mesmo texto vai ao transcript por `$.ui.log` no `turn.complete`, para ficar junto da resposta. O início do próximo turno (`turn.start`, ignorado se trouxer `agentId`) limpa o aviso, seja qual for a origem do turno; `/clear` (`session.end` com `reason: clear`) zera o aviso e o log; a próxima resposta recalcula. O `TurnStartInput` não traz `agentId`, então o mod assume que `turn.start` é só do loop principal.
- Estado em `harness.claimLog` (últimas 200 entradas, comando guardado com até 80 caracteres) e `harness.claimWarnings`. Falha ao gravar vai para o log de debug. Sem opção de configuração.

Limites conhecidos (falsos negativos aceitos pela regra de não avisar na dúvida):

- Status de saída escondido (`| tail`, `|| true`, `; echo`) conta como passou.
- Leitura de CI que sai com 0 mesmo com CI falhando (`gh run view`, `gh pr view`, `az pipelines`) conta como evidência.
- Edições feitas por scripts ou geradores de código (`python gen.py`, `node codegen.js`, `pnpm db:migrate`) não são vistas.
- Ferramentas de shell via MCP são invisíveis ao mod.
- O estado nasce vazio depois de `resume`; evidência de antes não é lembrada.
- Comandos com mais de 64 KB (sem contar corpos de heredoc) não são classificados (nem evidência nem edição) e o desembrulho de prefixos e de `xargs` para em 16 níveis.
- `sh -c "..."` depois de `docker compose run`, `watch` e `php bin/console lint:*` não são reconhecidos como evidência.
- O Bash de um subagente rodando em outro worktree conta como evidência do loop principal, porque o mod não sabe em qual árvore ele rodou.

## PR gate

Quando um Bash vai criar ou atualizar um pull request, o mod anexa ao resultado da ferramenta o status do review do harness. Só contexto para o modelo: nunca nega a chamada, nunca reescreve o comando e não toca no resultado do motor além de acrescentar uma linha. Se o resultado volta `deny` ou `isError`, nada é acrescentado.

Ordem que mantém o `ready`: commitar, revisar, abrir o PR. O harness revalida o review contra o snapshot atual do git e, confirmado em teste contra o `ai-harness` real em um diretório de estado temporário, um review `ready` vira `pending_verification` quando o conteúdo revisado é commitado ou quando aparece um arquivo novo não rastreado; revisar depois do commit continua `ready` ao trocar branch, remoto ou config. Quem lê o status também apaga a linha `ready` (a leitura reinicia a verificação), por isso o mod guarda o status do review e a hora e sabe dizer `stale`.

Qual identidade é lida. O `herdr-jev review` grava o resultado sob um `session` gerado (`jev-review-<hex>`) e usa a raiz do git como `cwd`; a própria sessão do Claude zera sua identidade a cada chamada de ferramenta que não é leitura (inclui `git commit`). Por isso o gate não consulta a sessão do Claude. O mod guarda `client`, `session`, `cwd`, status e hora de cada review, por raiz de repositório, de três origens: `/harness review`, o botão `Refresh review` e `autoReview`; e um `herdr-jev review` rodado pelo modelo em um Bash (com ou sem `--json`, também atrás de `rtk -u`, `timeout`, `env` etc.), lido do resultado da própria chamada (`Review session <id> (<client>) in <cwd>` e a última linha `Status: ...`, ou o relatório JSON). Uma execução que falhou ou cuja saída não pode ser lida não é guardada. O gate chama `ai-harness review-status --client <client> --session <session> --cwd <raiz>` com a identidade guardada para a raiz do repositório do PR.

Onde fica. Em `harness.reviewIds` (estado do Claude Code, que sobrevive a um reload do código do mod e se perde com a sessão) e, como o plano, em `$.store` sob `reviewIds:<id da sessão>`: o gate lê o estado e, se ele estiver vazio, o `$.store`. Um review rodado em outro processo ou terminal fora da sessão, ou depois de a sessão mudar de id, não é encontrado; o gate não adivinha sessões. Um `herdr-jev review && gh pr create` na mesma linha lê o status antes de o review rodar.

Status possíveis e o aviso:
- `ready`: `Review status read before the PR command for <raiz>: ready.`
- `stale`: havia um review `ready` guardado e o harness agora devolve `pending_verification`. O aviso diz a hora do último `ready`, que o checkout mudou (um commit ou um arquivo novo não rastreado conta) e a ordem commit, review, PR. Nunca diz que não há review.
- `none`: o mod não tem review guardado para o repositório. Diz só isso e como produzir um: `herdr-jev review` em um shell (achado por este check) ou `/harness review`; se o PR é de outro checkout, nomeia o checkout e manda rodar `cd <raiz> && herdr-jev review` lá, porque `/harness review` revisa a pasta da sessão.
- `pending_verification`, `pending_review`, `changes_required`: diz que não há review independente pronto e a ordem commit, review, PR.
- `unknown`: só diz que o status não pôde ser lido.

O que é detectado, só quando o shell de fato executaria. O comando é lido por um lexer de passagem única (aspas, `\` + quebra de linha, comentários, heredocs com vários marcadores por linha, `<<<`, `$(...)`, `$((...))` e `((...))`, crases, definições de função e atribuições de array, que não executam) e cada comando simples é analisado depois de pular atribuições de ambiente e wrappers (`env`, `sudo`, `timeout`, `nice`, `ionice`, `xargs`, `rtk`, `rtk -u`, `rtk proxy`, `command`, `exec`, `nohup`, `setsid`, `stdbuf`, `if`, `while !`, `then`, `do`):

- GitHub: `gh pr create|new|edit|ready` (com `-R/--repo` antes ou depois de `pr`), `gh api` com método de escrita em `repos/<o>/<r>/pulls[/<n>]`, `curl`/`http`/`wget` de escrita em `https://api.github.com/repos/<o>/<r>/pulls[/<n>]` ou em um host Enterprise com `/api/v3/`.
- Azure DevOps: `az repos pr create|update`; `curl`/`http`/`wget` de escrita em `.../_apis/git/repositories/<repo>/pullrequests[/<id>]`, ou numa base em variável (`${API_BASE}/git/repositories/${REPO}/pullrequests`, o formato do skill de PR do InvoiceCon). O casamento vale só para o operando URL (sem espaço, começando por `http(s)://` ou por uma variável), nunca para o valor de `-d`, `-H` ou item httpie; com host literal exige `/_apis/`. Escrita é `-X/--request POST|PATCH|PUT`, `--method`, ou dados (`-d`, `-d@arquivo`, `--data*`, `--json`, `-F`, `--post-data`, itens `chave=valor` do httpie; `chave==valor` é consulta) sem `-G`. GET nunca casa; comentários em `.../pullrequests/<id>/threads` também não.
- Fora: `git push`, heredocs, texto entre aspas, comentários, `echo`, `--help`/`-h`, `--dry-run`, `gh pr ready --undo`, definição de função e `cmd=(gh pr create)`. `--web` conta como criação, de propósito.
- Bitbucket fica de fora: não existe CLI `bb` aqui.

Limites declarados, não seguidos: `bash -c '...'`, `sh -c`, `eval`, heredoc entregue a um shell, alias do `gh`, `az devops invoke`, `curl` com a URL montada em variável de comando, mutações GraphQL, a chamada de uma função de shell que contém o comando, expansão aritmética com mais de 512 caracteres.

Diretório. Só um `cd <literal> &&` simples e inicial é seguido. Qualquer outra forma (`cd a; ...`, `cd a` em linha própria, `(cd a && ...)`, `pushd`, `cd` no meio da cadeia, `cd -P`, `cd --`, espaço escapado, `FOO=1 cd`, dois `cd`, `cd a || ...`, `cd $VAR`) dá status `unknown`, nunca o diretório da sessão. O diretório vira a raiz do git (`git rev-parse --show-toplevel`) e aparece no aviso. Também dá `unknown`: `--repo/-R` ou `--repository` que não bate com um remoto do checkout; um repositório vindo de variável (`${REPO}`: "repository comes from a variable"); `GH_REPO=` no comando; `gh pr create --head` ou `-H`; `gh pr edit|ready` com número, URL ou argumento posicional, `az repos pr update --id` e PATCH por REST, que miram um PR que pode não ser a mudança revisada aqui. `{owner}/{repo}` em `gh api` é este checkout. Qualquer falha de leitura (processo, JSON inválido, objeto sem `status`, status fora de `^[a-z_]{1,40}$`) vira `unknown` e o comando roda mesmo assim. Só o `null` de topo é `none`. A causa mostrada é uma frase fixa; nada de stderr é repetido.

Atraso. A raiz do git e os remotos são lidos em paralelo, 2 s cada; o status tem 5 s. Pior caso: 7 s (2 s de git + 5 s de status), contra 15 s antes (três leituras em série de 5 s).

Custo do detector: linear no tamanho do comando (lexer de passagem única; aninhamento de `$(` limitado a 48 níveis; a busca do fim de `((` olha no máximo 512 caracteres por ocorrência); o teste lê 400 KB entre aspas, 60 mil `<<`, 20 mil `$(` e 150 mil `((` em poucos segundos no total.

`prGateAsk` (padrão `false`). Ligado, quando o status é conhecido e não é `ready` (`none`, `stale`, `pending_*`, `changes_required` perguntam; `unknown` e `ready` não), o hook `tool.check` troca um `allow` do motor por `{ decision: 'ask', reason }` (objeto limpo, sem `rule`/`hook`); um `deny` ou um `ask` do motor passam como vieram. A chamada fica marcada pelo `tool_use_id` enquanto o `tool.call` está em curso e é solta no `finally`. Coberto por teste: pergunta só para o id em curso, não para outro id nem sem id, não depois do retorno e nunca com a opção desligada. Não verificado sem uma sessão real: que o motor dispara `tool.check` dentro do `next(e)` com o mesmo `tool_use_id`; que em `dontAsk` ou headless um `ask` de hook é recusado, o que na prática vira `deny`; e o que `next(e)` devolve depois que a pessoa responde Não. Por isso fica desligado. Não existe modo `deny`.

## Créditos

Layouts e técnicas de render inspirados, com trechos adaptados, em projetos MIT: muellerei/task-line (linha e barra da banda), zycck/claude-mods plan-progress (linhas de agente, dobras, glifos), whats-agent-doing (cartão expansível e linhas de worker), human-in-the-loop (caixa `Needs you` e `☐`), Nongfsq/frank-claude-cockpit (barra proporcional, espaçador `flexGrow`, linha clicável, seções do painel Sessions), shimo4228/harness-scope (mecanismo do Scope), pourya7/claude-code-mods anti-cheat (detecção de afirmações e classificação de evidência do Claims) e pourya7/claude-code-mods `co-op` (MIT, Copyright (c) 2026 Pourya: o tratamento de aspas, heredoc e substituição de comando, o prefixo de comando e o `cd` inicial do PR gate, reescritos aqui como lexer; ver `NOTICE`).

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

Com `autoRun` ligado (padrão) o encadeamento é automático: `harness_plan` já inicia toda tarefa `proposed` pronta (mesmo caminho do `harness_run` sem `taskId`, respeitando `maxWorkers`) e devolve o resultado em `Auto-run:`. Sempre que um `turn.complete` liquida uma tarefa (`done`, `approved`, `verified`, `failed` ou `needs_you`), o mod inicia as próximas tarefas prontas; o encadeamento implementer/mechanic -> reviewer continua igual. Tarefa `failed` ou `needs_you` nunca é reiniciada sozinha. Com `autoRun` desligado nada inicia sem `harness_run` ou `Run ready`.

- `approved`: o reviewer deu `APPROVE`. Ainda não é `verified`. Tarefas `approved` já liberam as dependentes, mas a banda mostra `◆ approved` com `harness review pending` (ou o status do último review).
- `verified`: só o review do harness promove (botão `Refresh review`, ou sozinho com `autoReview`, abaixo). Ele roda `herdr-jev review --json` (passa `--timeout-ms 540000`, o prazo de cada judge do `herdr-jev review`, abaixo do teto de 600 s do `$.process.run`, para o CLI devolver um status não `ready` em vez de ser morto; se o processo ainda assim estourar os 600 s, o refresh aparece como `review timed out`, separado de `review failed`); se o `status` do relatório for `ready`, toda tarefa que estava `approved` quando o refresh começou vira `verified`. Qualquer outro status (`pending_*`, erro) mantém as tarefas `approved`. O `herdr-jev review` sai com código 1 sempre que o status não é `ready`, então o mod lê o JSON do stdout mesmo assim. O relatório não tem campo `verdict`: o pane mostra o `status` e o resultado de cada escopo (`verify ready, <escopo> <status>`). Durante o review a banda e o pane mostram `review running`, e um segundo refresh não roda enquanto o primeiro não termina.
- O prompt do reviewer inclui o relatório do implementer e um bloco `<<<DIFF ... DIFF>>>` com `git diff --stat` e `git diff` dos paths da tarefa (o repositório inteiro se não houver paths), gerados pelo mod no momento do spawn, a partir do cwd, com o diff limitado a 20000 caracteres e uma nota de truncamento. Só entram mudanças ainda não staged; arquivos novos não rastreados não aparecem no diff.
- `harness_run <taskId>` numa tarefa `failed` por `CHANGES_REQUIRED` reexecuta o implementer ou mechanic com o último parecer do reviewer (guardado na tarefa como `reviewReport`, até 8000 caracteres) sob o título `Previous review findings`. Se a tarefa está `needs_you` porque o reviewer não deu veredito, o rerun refaz o REVIEW, não o implementer.
- Reader vai de `running` para `done` (sem review, conta como completo). Mechanic segue o mesmo caminho do implementer.
- `failed` (review com `CHANGES_REQUIRED`, turno abortado ou spawn recusado) e `needs_you` (worker terminou com `NEEDS_YOU: <pergunta>` ou o reviewer não deu veredito) podem ser reexecutados com `harness_run <taskId>`.
- Com `autoReview` ligado, quando toda tarefa está `done` ou `approved`, pelo menos uma está `approved` e nenhum refresh está rodando, o mod dispara o `Refresh review` uma vez, em segundo plano, sem bloquear o turno. Ele nunca repete para o mesmo conjunto de tarefas aprovadas (mesmo que o review não termine `ready`); um novo `harness_plan` zera isso. O botão continua disponível.
- `all verified` só aparece quando toda tarefa está `verified` ou `done`.

## Restauração

O estado é salvo em `$.store` com a chave `state:<session id>:<cwd>`, e só o plano da sessão atual é restaurado. O formato salvo é validado (estados e papéis desconhecidos rejeitam o plano inteiro).

Ao recarregar, uma tarefa `running` volta a `proposed` se o `agentId` não aparece em `$.agent.list()`; se o agente aparece como `completed`, a tarefa vira `needs_you` (idem para um reviewer). Se `$.agent.list()` falhar, nada é resetado: workers e tarefas ficam como estavam, o plano é marcado `stale` com a nota `agent list unavailable`; um reconcile seguinte que consegue listar limpa essa marca.

## Atividade dos workers

O hook `tool.call` atribui as chamadas de ferramenta de um subagente ao worker pelo `agentId`. Só ficam o nome da ferramenta e, para Read, Edit e Write, o nome-base do arquivo, e para Glob o padrão. O padrão do Grep nunca é guardado (só `Grep`). Texto de comando Bash nunca é guardado nem exibido (só `Bash`).

## Configuração (`userConfig`)

- `herdrJevBin` (padrão `herdr-jev`): executável, resolvido pelo PATH.
- `maxWorkers` (padrão `3`): máximo de tarefas `running` ao mesmo tempo. Reviewers não contam.
- `autoRun` (padrão `true`): `harness_plan` e cada tarefa liquidada iniciam sozinhos as tarefas prontas.
- `scopeMode` (padrão `enforce`), `runbook` (vazio), `alwaysAllowSkills` e `alwaysAllowAgents`: ver a seção Scope.
- `autoReview` (padrão `false`): dispara o review do harness uma vez quando tudo está `done` ou `approved` e há ao menos uma `approved`.
- `prGateAsk` (padrão `false`): ver PR gate.

## Limites conhecidos

- O mod é observacional: não nega nada e não muda permissões. Workers só nascem por `harness_plan` e `turn.complete` (com `autoRun`), `harness_run`, pelo botão `Run ready` ou pelo encadeamento implementer/mechanic -> reviewer em `turn.complete`; nunca por um hook de render. A restrição de ferramentas dos tipos de agente vem de `tools` e `disallowedTools` do `$.agent.register`.
- Spawn de reviewer usa o mesmo claim atômico do `startTask` (`reviewStarting`), então `harness_run` em paralelo, `Run ready`, o encadeamento automático e reload nunca criam dois reviewers para a mesma tarefa, nem dois workers para a mesma tarefa.
- `$` não pode ser passado entre arquivos do mod (regra do validador), então `cli.ts` e `workers.ts` recebem portas (`run`, `spawn`, `register`) em vez de `$`.
- O spawn de um plugin sempre roda em background; não existe campo `background` em `$.agent.spawn`, nem `effort`: o effort vai no tipo registrado.
- O review do harness é manual (`Refresh review`) a menos que `autoReview` esteja ligado.
- Smoke test do harness mod: `claude plugin validate` e `claude plugin test` cobrem comportamento de plano, spawn, reviewer e restauração; validação local é pré-requisito para mudanças.
