# Claude Harness mod: plano de implementação

Status: plano. Nada implementado, instalado ou configurado.
Complementa `claude-harness-mod.md` (produto e referências). Este documento fixa os papéis por modelo, a arquitetura do mod e as fases de entrega.

## 1. Papéis fixos (decisão do dono, 2026-10-07)

| Papel | Modelo | Effort | Como roda | Quando |
| --- | --- | --- | --- | --- |
| Advisor | Fable 5.1 (`claude-fable-5-1`) | high | é a própria sessão coordenadora, não spawna | decompõe objetivo em tarefas, escolhe rota, arbitra retornos |
| Implementer | Sonnet 5.5 (`claude-sonnet-5-5`) | high | subagente nativo `harness:implementer` | todo código de produção e testes |
| Reviewer | Opus 5.5 (`claude-opus-5-5`) | xhigh | subagente nativo `harness:reviewer`, read-only | toda entrega com diff; independente do implementer |
| Reader | Haiku 4.5 (`claude-haiku-4-5-20251001`) | standard | dois tipos nativos com o mesmo modelo: `harness:reader` (tools Read/Glob/Grep, sem Bash, termina `done` sem review) e `harness:mechanic` (tools Read/Glob/Grep/Edit/Write/Bash, sempre revisado pelo Opus, exibido como reader com nota `writes`) | reader: leitura em massa, coleta, inventário, pesquisa e triage trivial; mechanic: scaffolds, conversões, lint, fixtures, renomeações |

Fonte canônica: `~/.local/share/ai-harness/generated/claude/delegation.json`, profile `claude-fable-5` já tem advisor fable-5, executor sonnet high, reviewer opus xhigh. Gap: não existe papel para Haiku. Correção no harness (não no mod): adicionar `reader` em `RoleKind` (`herdr-jev/src/types/index.ts`) e `reader: { model: "claude-haiku-4-5", effort: "standard" }` no profile em `harness.yml` e regenerar `delegation.json`.

Regra de ouro: os `executionStages` do profile mandam. Os `stages` advisory do Jev (hoje sugerem codex/kimi via cross-harness) viram apenas "alternativa considerada" exibida no pane. Codex, Kimi e Antigravity entram só na fase 4 e só por rota já autorizada.

## 2. Como o Jev escolhe o papel por tarefa

Cada tarefa limitada passa por `herdr-jev triage "<resumo>" --json` (350 ms). Mapeamento determinístico depois do triage:

| Sinal do triage | Papel |
| --- | --- |
| `complexity=trivial` ou tarefa de leitura/coleta/scaffold | reader (Haiku) |
| `complexity=routine` ou `moderate` com código | implementer (Sonnet) |
| `complexity=architectural` | advisor (Fable) especifica primeiro; depois quebra em routine para Sonnet |
| `needsResearch=true` | reader (Haiku) coleta antes; advisor decide |
| qualquer tarefa que gere diff | reviewer (Opus) obrigatório após o implementer |

Override manual: o usuário pode fixar papel por tarefa no pane; o override fica registrado como motivo ("manual").

## 3. Arquitetura do mod

Local: `herdr-jev/claude-plugin/` (marketplace do próprio repo). Durante desenvolvimento: `~/.claude/dev-mods/<session>/harness/` com hot reload.

Arquivos:

```
claude-plugin/
  .claude-plugin/plugin.json     name "harness", types ./types/index.d.ts
  hooks/hooks.json               modules ["./register.tsx"]
  hooks/register.tsx             hooks e UI
  hooks/plan.ts                  chama CLIs e normaliza o plano
  hooks/workers.ts               spawn e acompanhamento de subagentes
  types/index.d.ts               contrato de $.state
  tests/*.test.ts                claude plugin test
```

Hooks e nouns usados (API de mods `claude-code`):

- `session.start`: `$.command.register({name:"harness"})`, `$.tool.register` de `harness_plan` e `harness_run`, `$.agent.register` dos três tipos (implementer, reviewer, reader) com `model` fixo; `agent.offer` com `isOffered:false` para reviewer e reader (só o mod spawna). Lê `$.session.model()` e aborta com aviso se não for Fable.
- `ui.render` em `AbovePrompt`: banda compacta, encadeia `next(e)` quando não há plano.
- `ui.render` em `Pane` (`$.ui.open({id:"harness"})`): tabela de tarefas e workers.
- `tool.call` (observação): atribui Read/Edit/Write/Bash ao worker pelo `agentId`; alimenta a aba de atividade.
- `agent.spawn` e `turn.complete`: transição proposed → running → done/failed por `agentId`.
- `session.compact` e `session.start` com resume: restaura plano de `$.store` por task ID do harness; nunca marca worker como running sem `$.agent.list()` confirmar.
- `$.process.run(argv)`: `herdr-jev triage|plan|review`, `ai-harness delegation-plan|model-resolve|task-submit|task-inspect`. Sempre argv, nunca shell string.
- `$.model.complete({model:"haiku"})`: classificação barata de títulos de tarefa quando o Jev estiver indisponível (fallback explícito, marcado como heurística).

Estado (`$.state`, declarado no contrato):

```ts
interface PluginState {
  harness: {
    plan: HarnessPlan | null            // tasks[] com id, titulo, role, model, effort, reason, deps, checks, state
    workers: Record<string, WorkerRow>  // agentId -> taskId, model, tool atual, inicio
    needsYou: HumanAsk[]                // perguntas pendentes ligadas a taskId
    stale: boolean                      // ultimo refresh falhou ou envelheceu
  }
}
```

IDs de tarefa são os do harness (`task-submit` devolve), nunca o título. Estado durável vive no harness/Ruflo; `$.store` é cache de exibição.

## 4. Fluxo ponta a ponta

1. Usuário descreve objetivo. Fable (sessão) aciona `harness_plan`.
2. Mod roda `herdr-jev plan "<objetivo>" --client claude --model claude-fable-5-1 --json` e `ai-harness delegation-plan --client claude --model claude-fable-5-1 --work substantive --role executor`. Resultado: tarefas limitadas com papel, modelo exato, effort, motivo, dependências e checks.
3. Fable escreve o plano nativo (plan mode) com as mesmas tarefas; o pane mostra o mesmo conteúdo. Aprovação continua nativa.
4. `harness_run <taskId>`: revalida quota/profile, spawna o tipo de agente do papel, registra `agentId`→`taskId`. Dependentes esperam; independentes correm em paralelo (até 5 implementers, limite por `RECAST_`-style config `harness.maxWorkers`).
5. Implementer termina → mod spawna `harness:reviewer` (Opus) com diff e checks; em paralelo `herdr-jev review --base <ref>` para status do harness. Só `ready` + Opus aprovando marca verified.
6. Reader (Haiku) é usado pelo advisor para coleta antes do passo 2 e por implementers para tarefa braçal via tool `harness_delegate_read`.
7. Banda: `recast · develop-typescript-javascript · Sonnet implementando 2/5 · 1 review Opus pendente · ? 1 needs you`.

## 5. Fases de entrega

Cada fase usa os próprios papéis: Fable especifica e arbitra, Haiku lê e coleta, Sonnet implementa, Opus revisa.

### Fase 0: harness (1 dia)
- Haiku: inventariar `src/types`, `src/pipelines`, `src/harness/bridge.ts`, schema de `harness.yml`; listar onde `RoleKind` é consumido.
- Sonnet: adicionar `reader` em `RoleKind`, no profile e no gerador de `delegation.json`; testes em `tests/`.
- Opus: revisar; `bun test` verde; `herdr-jev plan --client claude --model claude-fable-5-1 --json` devolve 4 papéis.
- DoD: `delegation.json` mostra reader Haiku; nada quebra em `herdr-jev route`.

### Fase 1: banda e pane (2 a 3 dias)
- Haiku: extrair de `claude-code.d.ts` as assinaturas de `AbovePrompt`, `Pane`, `agent.register`, `tool.register`, `process.run`, `state`; copiar para `docs/plans/mod-api-notes.md`.
- Sonnet: scaffold do plugin, `harness_plan`, normalização do JSON dos CLIs, banda, pane, contrato de estado, `/harness`.
- Opus: revisar; `claude plugin validate`, `tsc -p`, `claude plugin test` em terminal e desktop.
- DoD: plano real do recast renderizado, rotas indisponíveis mostradas como indisponíveis, nenhum worker lançado por render ou hook passivo.

### Fase 2: execução nativa (3 a 4 dias)
- Sonnet: `harness_run`, agentes registrados, mapa `agentId`→`taskId`, dependências, `turn.complete`, spawn do reviewer Opus, chamada a `herdr-jev review`, restore após compact/resume com reconciliação via `$.agent.list()`.
- Haiku: fixtures de planos e respostas de CLI para os testes.
- Opus: revisar duplicidade de spawn em reload, replay, timeout incerto.
- DoD: tarefa de exemplo no recast vai de proposed a verified com Sonnet + Opus; reload não duplica worker; falha de verificação fica visível.

### Fase 3: atividade e Needs you (2 dias)
- Sonnet: aba de atividade por worker (reads/edits por `tool.call`), fila `needsYou` com motivo, critério de conclusão e taskId; resposta volta ao advisor; só dependentes esperam.
- Haiku: coletar padrões de `whats-agent-doing` e `human-in-the-loop` (licença e atribuição).
- Opus: revisar que segredos nunca entram no pane e que telemetria não leva texto de tarefa.

### Fase 4: CLIs externas (opcional, só após 1 a 3 estáveis)
- Codex, Kimi, Antigravity via `herdr-jev subagent` e `peer-message`, um por vez, cada um validado com seu adapter real. Atividade de arquivo marcada "indisponível" quando o adapter não expõe eventos. Nunca inferir autoria por mudança de arquivo.

## 6. Critérios de aceite globais

- Pane e plano nativo concordam em papel, modelo, effort, deps e checks.
- Papéis: Fable nunca spawna outro Fable; Opus nunca implementa; Sonnet nunca revisa o próprio diff; Haiku nunca edita código de produção.
- Nenhum worker aparece como running antes de `agent.spawn` resolver.
- Reload, resume, compact e tool call repetido não duplicam spawn.
- `herdr-jev review` status `ready` é condição de verified; sem reviewer disponível fica "unreviewed", nunca "aprovado".
- Banda convive com outros mods (`next(e)`); sessão headless devolve texto.
- Argv sempre array; nenhum texto de tarefa em telemetria estrutural; nenhuma credencial em pane ou fila.
- `claude plugin validate`, `tsc -p`, `claude plugin test` e `bun test` do herdr-jev verdes a cada fase.

## 7. Fora de escopo

- Novo scheduler, registry de modelos, serviço de quota, provider de memória ou daemon.
- Hooks que bloqueiam o fim do turno para forçar atualização de progresso (conflita com hooks observacionais).
- Copiar storage ou orquestração dos repos de referência; só padrões de UI, com licença preservada.
- Matriz fixa "Kimi para pesquisa": fora dos quatro papéis Claude, toda escolha de CLI externa é recomendação revalidada na hora.

## 8. Riscos

| Risco | Mitigação |
| --- | --- |
| `herdr-jev plan` devolve `delegation.mode=direct, reason=model_unknown` sem `--model` | mod sempre passa `$.session.model()` |
| Stages advisory cross-harness contradizem o profile | pane mostra ambos, executa só executionStages |
| Agente nativo não aceita `model` esperado no build atual | validar na Fase 1 com `claude plugin validate`; fallback para `$.model.complete` só em classificação |
| Hot reload perde variáveis do módulo | todo estado de desenho em `$.state`, durável em `$.store` |
| Quota de Opus xhigh | reviewer cai para Opus high com aviso; nunca para Sonnet |
