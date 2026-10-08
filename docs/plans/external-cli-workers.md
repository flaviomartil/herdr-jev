# CLIs externas como workers: conselho de revisão e implementação

Status: plano. Nada implementado, instalado ou configurado.
Detalha a Fase 4 de `claude-harness-mod-implementation.md` e substitui a regra "um por vez" daquela fase.
Bases: [agent-council](https://github.com/apolenkov/agent-council) e [claude-code-effort-cycle](https://github.com/Anerco/claude-code-effort-cycle), ambos MIT.

## 1. Decisões do dono (2026-10-07)

| Tema | Decisão |
| --- | --- |
| Escopo | CLIs externas revisam e também implementam |
| Gatilho | o triage decide: conselho só em tarefa `moderate` ou `architectural` com diff |
| Gate | consultivo: `ready` continua vindo só do `review-judge` |
| Membros da v1 | Codex, Kimi e Antigravity (`agy`) |

Grok e OpenCodeReview estão instalados e ficam para depois da v1.

## 2. O problema

Hoje `herdr-jev` só recomenda CLIs externas (stages advisory) e o spawn depende de aba ou split no Herdr. Nenhuma tarefa dispara outra CLI sozinha. O caminho do agent-council resolve isso sem peer persistente: processo one-shot por argv, em paralelo, com timeout e cancelamento.

## 3. Onde vive

No CLI, não no mod. Assim Claude, Codex e Kimi usam o mesmo caminho e o mod só exibe.

```
src/council/
  members.ts     adapters: argv por CLI e por modo (review, implement)
  run.ts         spawn paralelo, timeout, cancelamento, single flight
  parse.ts       saída de cada CLI para Finding[]
  synth.ts       agrupamento e pontuação com Jev
  worktree.ts    snapshot isolado por worker
```

Comandos novos:

- `herdr-jev review --council [--members codex,kimi,agy]`: roda o conselho junto do review atual e anexa a síntese ao relatório.
- `herdr-jev work --client <cli> --task <id>`: implementação one-shot em worktree isolado.

Reusar o que já existe em `src/harness/review.ts` (escopos, snapshot, `MAX_CONCURRENT_JUDGES`), `src/delegation/cross-harness.ts` (`resolveDelegatedClient`) e `src/herdr/reservation.ts`. Confirmar os pontos de extensão na Fase 4a antes de criar módulo paralelo.

## 4. Adapters

Binários confirmados em `~/.local/bin`: `codex`, `kimi`, `agy`. Flags abaixo vêm do `--help` de cada CLI e do agent-council; nenhuma foi validada em execução real.

| CLI | Revisão (somente leitura) | Implementação (em worktree) | Effort |
| --- | --- | --- | --- |
| codex | `codex exec review --uncommitted --ephemeral` | `codex exec` com o brief | por config, flag a validar |
| kimi | `kimi -p <prompt> --output-format text` (`--plan` não combina com `-p`; sem modo somente leitura) | `kimi --auto -p <prompt>` | não expõe |
| agy | `agy --print <prompt> --mode plan --sandbox --output-format json --json-schema <schema> --print-timeout <t>` | `agy --print <prompt> --mode accept-edits` | `--effort low..max` |

Regras dos adapters:

- Argv sempre em array, nunca string de shell.
- O prompt vai em arquivo e o argv aponta para ele: um diff de 200 KB não cabe em um argumento (limite de 128 KB no Linux).
- Saída pedida em uma linha JSON por achado: `path`, `line`, `severity`, `title`, `detail`. Texto livre vira um achado único. `agy` usa `--json-schema` para forçar o formato.
- Um membro só conta como instalado quando `<bin> --version` devolve a assinatura esperada.

Verificado em 2026-10-07 com um prompt mínimo: `codex exec --ephemeral`, `kimi -p` e `agy --print --mode plan` respondem em modo headless. `kimi --plan -p` falha com "Cannot combine --prompt with --plan", então o Kimi depende do worktree descartável para revisar com segurança.

A validar na 4a: qual modo de `agy` garante somente leitura sem depender só de `--sandbox`, e o formato de saída de cada CLI com um diff real.

## 5. Isolamento

Todo worker externo roda em um worktree temporário, nunca na árvore do usuário.

- Revisão: worktree no commit base com o diff da tarefa aplicado como patch. Arquivos não rastreados com nome de segredo (`.env*`, `*.pem`, `*.key`, `secret`, `credential`) não entram no patch. Como o worktree não tem os não rastreados, o filtro vale também para as CLIs que leem a árvore sozinhas, o que o agent-council não cobre.
- Implementação: um worktree e um branch `harness/<taskId>-<cli>` por worker, um único escritor por worktree. O resultado é o diff desse branch. Nada é mesclado sem passar pelo gate.
- O worktree é removido ao fim, com sucesso ou falha. Antes de criar: `git worktree list` e caminho único.

## 6. Fluxo

1. Tarefa passa pelo triage. `trivial` e `routine`: fluxo atual, sem CLI externa.
2. `moderate` ou `architectural`: o plano pode atribuir a implementação a uma CLI externa quando o profile declarar essa rota. O worker roda em worktree e devolve o diff.
3. Entrega com diff: `herdr-jev review` roda como hoje. Em paralelo, o conselho roda com os membros disponíveis, excluindo quem implementou.
4. Síntese vai para o advisor e para o pane. O status do gate não muda por causa dela.
5. Advisor decide: aceitar, devolver ao implementer com os achados, ou descartar o worktree.

Condições para o conselho disparar, copiadas do agent-council:

- pelo menos dois membros executáveis; com menos, não roda e diz o motivo;
- hash do diff diferente do último revisado;
- cooldown vencido (padrão 10 min);
- nenhuma rodada em andamento (single flight por claim atômico);
- nenhum worker da mesma tarefa ainda rodando.

Timeout padrão por membro: 8 min. Membro que estoura ou falha fica marcado como falho e não bloqueia os outros.

## 7. Síntese

Jev em duas rodadas, como no agent-council:

1. Por achado: Noul "é defeito real, não ruído ou estilo?" e Choice "é o mesmo problema de um achado anterior?" (`new` ou `#k`).
2. Por grupo levantado por mais de um membro: Noul "os achados se contradizem?".

Saída: concordâncias, divergências, achados únicos e notas. Achado com Noul abaixo de 0,3 vai para notas.

Ponto de partida de calibração, herdado do autor e não da API: até 9 perguntas e 14.000 caracteres por request, até 20 achados pontuados. Recalibrar com dados nossos.

Sem Jev (quota ou erro): lista os achados crus com nota explicando. Nunca inventa agrupamento.

## 8. Effort por worker

Do effort-cycle vêm duas técnicas:

- No mod, o hook `turn.step` vê cada request de modelo e pode trocar o effort por agente. Usar para aplicar o `effort` do triage ao subagente nativo quando ele diferir do definido no agente.
- Linhas da lista de tarefas: escrever `~/.claude/subagent-rows/sessions/<session>/harness.json` no formato `{"order": N, "agents": {"<agentId>": "<texto>"}}` para mostrar papel e tarefa em cada linha. Só aparece se houver um `subagentStatusLine` que leia a pasta; é opcional.

Para CLIs externas o effort do triage vira flag do adapter (seção 4).

O plugin effort-cycle pode ser instalado à parte para o controle por teclado; ele não faz rede nem telemetria e encadeia a banda `AbovePrompt`. Testar convivência com a banda do mod antes de recomendar.

## 9. O que muda nas regras atuais

- `explicit-delegation-profiles` manda despachar só executor e reviewer configurados. Para a rota externa ser autorizada, os membros entram no profile em `harness.yml` (papel `council` e, quando aplicável, executor externo) e `delegation.json` é regenerado. Sem isso o spawn automático viola a regra.
- Preflight de quota do Herdr-Jev continua obrigatório antes de cada spawn. Não adotar os arquivos de limite do agent-council.
- "Sonnet nunca revisa o próprio diff" generaliza: nenhum membro revisa diff que ele mesmo produziu.

## 10. Roteamento por dificuldade e effort

Pedido do dono (2026-10-07): a delegação deve escolher CLI, modelo e effort pela dificuldade da tarefa, a partir de qualquer sessão. Exemplo: uma sessão em Opus 5.5 delega implementação para Sonnet e consulta Fable como advisor.

Por que hoje não acontece:

- `planExecution` (`src/pipelines/planner.ts`) só preenche `executionStages` quando `resolveHarnessDelegation` acha um profile cujo advisor é exatamente o modelo da sessão. `delegation.json` tem profiles para `fable-5` e `claude-sonnet-5`; uma sessão em Opus cai em `direct, no_profile`.
- O `effort` e a `complexity` do triage não escolhem o modelo dos `executionStages`: modelo e effort vêm fixos do profile.
- Os `stages` cross-harness são só recomendação e `HERDR_JEV_CROSS_HARNESS` vem desligado por padrão.

Mudança proposta: o profile deixa de ser chaveado pelo modelo da sessão e passa a ser uma matriz por dificuldade, declarada em `harness.yml`.

| Complexidade | Advisor | Implementer (ordem de preferência) | Reviewer | Conselho |
| --- | --- | --- | --- | --- |
| trivial | sessão | reader Haiku, sem delegação externa | nenhum | não |
| routine | sessão | Sonnet high | Opus xhigh | não |
| moderate | sessão | Sonnet high, Codex, agy | Opus xhigh | sim |
| architectural | Fable consultado como subagente quando a sessão não é Fable | Sonnet high, Codex, agy, depois de o advisor quebrar em tarefas routine | Opus xhigh | sim |

Regras:

- Cada célula é uma lista ordenada de `(cliente, modelo, effort)`. O primeiro candidato com quota e rota verificada vence; sem candidato, execução direta, sem substituição silenciosa.
- O `effort` do triage sobe o effort do candidato escolhido até o teto que o modelo aceita. Nunca rebaixa `xhigh` em silêncio.
- A sessão coordenadora continua dona da decomposição e do julgamento final. "Advisor Fable" numa sessão Opus é uma consulta somente leitura, não troca de coordenador.
- Independência: quem implementa não revisa; se a sessão é Opus e o reviewer é Opus, a revisão roda em execução separada e somente leitura.
- A matriz acima é ponto de partida. Os valores finais são decisão do dono em `harness.yml`.

Menor passo que já destrava o caso do exemplo: um profile `claude-opus-5` (executor Sonnet high, reviewer Opus xhigh) e um papel `consult` opcional apontando para Fable. Isso não depende das fases 4a a 4e.

## 10a. Terceira via: subagente nativo com o modelo trocado

Base: [pi-agent-for-claude](https://github.com/FazalAAli/pi-agent-for-claude) (MIT), lido em `hooks/register.ts`.

O Claude Code inicia um subagente de verdade (id, transcript, linha em `$.agent.list()`); o mod troca só a requisição de modelo desse loop por uma execução destacada do CLI externo. O worker externo passa a aparecer na lista de tarefas e no pane do mod como qualquer subagente, com streaming, follow-up e uso de tokens, e funciona fora do Herdr.

Mecanismo a copiar:

- `agent.spawn`: guarda o prompt do spawn por `agentId` quando o tipo é o nosso.
- `turn.step`: para esses `agentId`, não chama `next(e)`; inicia o CLI destacado (`nohup`), com a saída filtrada para um arquivo JSONL de eventos pequenos, e lê o arquivo em polling, emitindo chunks de texto e thinking.
- Orçamento por hook: o engine dá 10 s por chamada e, estourando, conclui o passo com o modelo real. Cada passo transmite por até 7 s e termina numa tool no-op registrada pelo mod (`tool.register`), cujo resultado faz o engine abrir o próximo passo sobre a mesma execução.
- Entrega: texto simples, ou `SubagentHandback` quando a sessão exige; o passo seguinte à entrega encerra com texto visível.
- Abort: sinal do passo mata o processo destacado; `pump` nunca lança, porque um throw devolveria o passo ao modelo Claude por baixo.
- Agente de fallback: a definição do agente usa Haiku e instrui a responder só "o mod não está ativo", para o caso de os function hooks estarem desligados.
- Assinatura: a resposta termina com `— answered by <cli>, <provedor/modelo>` lido dos eventos do CLI.

Adaptação para nós:

| CLI | Modo de eventos | Sessão para follow-up |
| --- | --- | --- |
| codex | `codex exec --json` (JSONL) com `-C <worktree>` e `-s workspace-write` | `codex exec resume` |
| agy | `agy --print --output-format stream-json` | `--conversation <id>` |
| kimi | `kimi -p --output-format stream-json` | `-S <id>` |

O formato dos eventos de cada CLI ainda precisa ser capturado e mapeado; só o do Pi é conhecido pelo código de referência.

Diferenças obrigatórias em relação à referência:

- O CLI externo roda fora das permissões do Claude Code. Na referência ele roda no cwd da sessão; aqui roda sempre no worktree da seção 5.
- A referência depende de comportamento não documentado: o orçamento de 10 s, transcripts em `~/.claude/projects/**/agent-<id>.jsonl`, texto exato de mensagens do engine. Isolar isso num módulo e cobrir com teste que falhe alto quando o engine mudar.
- Sem modo teammate (tmux, `ps`) na primeira versão.
- Arquivos de eventos no diretório de estado do herdr-jev, não em `/tmp`.

Uso por papel: o conselho de revisão (4a, 4b) continua em one-shot por argv; a implementação por CLI externa (4c, 4d) passa a usar esta via. O caminho por pane do Herdr continua existindo para quem trabalha dentro do Herdr.

## 10b. Ideias de claude-mods

Base: [diegocamara89/claude-mods](https://github.com/diegocamara89/claude-mods) (MIT, sem uso externo comprovado).

- `revisor-com-prova`: anexa ao resultado de um revisor, como `context` visível só para o modelo, a regra "achado só vale com prova; reproduza antes de corrigir; aprovado sem achados é válido". Adotar na síntese do conselho (seção 7) e no retorno de `harness:reviewer`: o texto entregue ao advisor carrega essa regra.
- `sonnet-por-padrao`: em `agent.spawn`, define o modelo de subagente criado sem modelo explícito, e envolve scripts de Workflow para o mesmo efeito. O mod já fixa modelo nos próprios agentes; o que vale copiar é aplicar a rota da seção 10 a subagentes genéricos que herdariam o modelo da sessão.
- `painel-vivo`: mostra quota de 5 h e semanal e a saída ao vivo de Codex e agy no pane. Referência de UI para a Fase 3 do mod.
- `lixeira` e `varredura-push` ficam fora do escopo: o harness já tem regras para ação destrutiva e para segredo.

## 11. Fases

| Fase | Entrega | DoD |
| --- | --- | --- |
| 4.0 | profile `claude-opus-5` e papel `consult`; depois a matriz por dificuldade em `harness.yml` | `delegation-plan` para sessão Opus devolve `delegate`; `herdr-jev plan` escolhe candidato por complexidade e respeita quota |
| 4a | adapters de revisão para codex, kimi e agy; `run.ts`; `parse.ts`; worktree de revisão | cada adapter validado em execução real com um diff conhecido; cancelamento mata os filhos; `bun test` verde |
| 4b | `synth.ts`, `review --council`, gatilho por triage, membros no profile | tarefa `moderate` dispara o conselho sozinha; `routine` não dispara; status do gate inalterado com e sem conselho |
| 4c.0 | protótipo da terceira via só para Codex: tipo de agente `harness:codex`, troca de `turn.step`, worktree, assinatura | uma tarefa pequena implementada pelo Codex aparece como subagente, transmite ao vivo e termina com a assinatura; com hooks desligados o agente recusa em vez de responder como Claude |
| 4c | `work --client codex` em worktree | tarefa de exemplo implementada pelo Codex, revisada por Opus e conselho sem o Codex, worktree removido |
| 4d | implementação por kimi e agy | idem 4c para cada um |
| 4e | effort por worker e linhas da lista de tarefas | effort do triage visível e aplicado em subagente nativo e em `agy` |

O mod só exibe o conselho no pane depois da 4b. Atividade de arquivo de worker externo fica "indisponível" enquanto o adapter não expuser eventos.

## 12. Riscos

| Risco | Mitigação |
| --- | --- |
| CLI "somente leitura" que escreve | worktree descartável em toda revisão; validar na 4a |
| Custo e quota com três CLIs por entrega | gatilho por triage, cooldown, hash do diff, preflight de quota |
| Adapter quebra quando a CLI muda | checagem de assinatura em `--version`; falha de parse vira membro falho, não achado falso |
| Dois workers externos na mesma tarefa | um escritor por worktree; reserva por `taskId` |
| Achado falso tratado como verdade | síntese consultiva; texto enviado ao advisor pede verificação contra o código |

## 13. Atribuição

Código adaptado do agent-council, do effort-cycle, do pi-agent-for-claude e do claude-mods mantém o aviso MIT de origem no arquivo ou em `NOTICE`. Os tipos do Claude Code que esses repositórios trazem não são MIT e não devem ser copiados.
