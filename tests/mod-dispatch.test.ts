import { afterEach, beforeEach, expect, test } from 'bun:test';
import { closeVerifiedModWorker, dispatchModTask, modVerifyCommand } from '../src/orchestration/mod.js';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestStateDir } from './helpers.js';
import type { TriageDecision } from '../src/types/index.js';
import { planExecution } from '../src/pipelines/planner.js';
import { resetHarnessCaches } from '../src/harness/bridge.js';
import { createFakeHarness } from './fake-harness.js';

let state: ReturnType<typeof createTestStateDir>;
let previous: string | undefined;
beforeEach(() => { state = createTestStateDir(); previous = process.env.HERDR_ENV; process.env.HERDR_ENV = '1'; });
afterEach(() => { state.cleanup(); if (previous === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = previous; });
const triage: TriageDecision = { complexity: 'moderate', confidence: 1, needsResearch: false, effort: 'high', recommendedPipeline: 'triad', latencyMs: 0, rawAnswers: {} };
const profile = { id: 'claude-fable-triad', client: 'claude', advisor: 'fable-5', route: 'moderate', executor: { client: 'codex', model: 'gpt-6.1-sol', cliModel: 'gpt-6.1-sol', effort: 'xhigh' }, reviewer: { client: 'claude', model: 'opus-5', cliModel: 'claude-opus-5-5', effort: 'xhigh' } };
const decision = { mode: 'delegate', profile };
const id = '11111111-1111-4111-a111-111111111111';

function fixture() {
  const calls: string[] = [];
  const deps = {
    context: async () => ({ client: 'claude', sourcePaneId: 'source', workspaceId: 'workspace', sourceAgentName: 'main', delegation: {} }),
    triage: async () => triage,
    detect: async () => [{ client: 'claude', installed: true, healthy: true }, { client: 'codex', installed: true, healthy: true }],
    catalog: () => ({ ok: true, value: { clients: { claude: { models: [{ id: 'opus-5', cli_id: 'claude-opus-5-5' }] }, codex: { models: [{ id: 'gpt-6.1-sol', cli_id: 'gpt-6.1-sol' }] } } } }),
    plan: (_task: string, _client: string, _triage: unknown, options: any) => ({ task: _task, client: 'claude', stages: [],
      delegation: options.delegation.availableModels.includes('gpt-6.1-sol') ? decision : { mode: 'direct', reason: 'models_unavailable' },
      executionStages: [{ ...profile.executor, role: 'implementer', extraFlags: [], description: '' }, { ...profile.reviewer, role: 'reviewer', extraFlags: [], description: '' }],
      routing: { complexity: triage.complexity, effort: triage.effort, availableClients: ['claude', 'codex'] } }),
    probe: async (stage: any) => { calls.push(`probe:${stage.client}`); return true; },
    command: (_argv: string[]) => { calls.push('record'); return { id, decision, activation: 'active' }; },
    pipeline: async (_plan: unknown, options: any) => { calls.push('dispatch'); expect(options).toMatchObject({ dispatchId: id, dispatchSession: 'session', dispatchTurn: 'turn' }); return { mode: 'delegate', run: { id } }; },
  };
  return { calls, deps, input: { task: 'Implement parser', session: 'session', turn: 'turn', model: 'claude-fable-5-1', cwd: state.stateDir } };
}

test('automatic route preflights exact stages and persists its decision before dispatch', async () => {
  const { calls, deps, input } = fixture();
  expect(await dispatchModTask(input, deps as never)).toMatchObject({ mode: 'delegate', id });
  expect(calls).toEqual(['probe:codex', 'probe:claude', 'record', 'dispatch']);
});

test('accepted consult recommendations reach the pipeline without changing the task binding', async () => {
  const { deps, input } = fixture();
  await dispatchModTask({ ...input, consultReviewed: true, consultReport: 'Check parser limits first.' }, { ...deps,
    pipeline: async (plan, options) => {
      expect(plan.task).toBe(input.task);
      expect(options.consultReport).toBe('Check parser limits first.');
      return { mode: 'delegate', run: { id } };
    },
  } as never);
  for (const change of [{ consultReviewed: false }, { consultReport: 'x'.repeat(16385) }]) {
    await expect(dispatchModTask({ ...input, consultReviewed: true, consultReport: 'Accepted', ...change }, deps as never)).rejects.toThrow('invalid_consult_report');
  }
});

test('automatic routing uses the real planner across CLIs by default and honors explicit restrictions', async () => {
  const saved = { cross: process.env.HERDR_JEV_CROSS_HARNESS, exclude: process.env.HERDR_JEV_EXCLUDE_CLIENTS };
  const harness = createFakeHarness('contract', { FAKE_PROFILE: 'routed' });
  try {
    for (const restriction of ['default', 'off', 'exclude'] as const) {
      delete process.env.HERDR_JEV_CROSS_HARNESS;
      delete process.env.HERDR_JEV_EXCLUDE_CLIENTS;
      if (restriction === 'off') process.env.HERDR_JEV_CROSS_HARNESS = 'off';
      if (restriction === 'exclude') process.env.HERDR_JEV_EXCLUDE_CLIENTS = 'codex';
      resetHarnessCaches();
      const { deps, input } = fixture();
      let planned: ReturnType<typeof planExecution> | undefined;
      const expectedClient = restriction === 'default' ? 'codex' : 'claude';
      await dispatchModTask(input, { ...deps,
        plan: (...args) => { planned = planExecution(...args); return planned; },
        command: () => ({ id, decision: planned!.delegation, activation: 'active' }),
        pipeline: async (plan) => {
          expect(plan.executionStages?.[0]?.client).toBe(expectedClient);
          return { mode: 'delegate', run: { id } };
        },
      } as never);
      expect(planned?.executionStages?.[0]?.client).toBe(expectedClient);
      expect(planned?.routing?.availableClients).toEqual(restriction === 'default' ? ['codex'] : []);
    }
  } finally {
    harness.restore();
    for (const [key, value] of [['HERDR_JEV_CROSS_HARNESS', saved.cross], ['HERDR_JEV_EXCLUDE_CLIENTS', saved.exclude]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    resetHarnessCaches();
  }
});

test('an explicit refusal to delegate never triages or launches', async () => {
  const { calls, deps, input } = fixture();
  for (const task of ['Implement parser. Do not delegate.', 'Implement parser without using agents.', 'Implement parser without using any workers.', 'Implement parser. Do not run tests.', 'Implement parser without running tests.', 'Implemente o parser. Não execute testes.', 'Implement parser without delegating.', 'Implement parser; do not spawn agents.', 'Implemente o parser. Não crie agentes.', 'Implement without spawning agents.', 'Implemente o parser. Não delegue.', 'Revisão sem delegação.', 'Review this code, read only.', 'Analise apenas leitura, não altere arquivos.', "Audit this module. Don't write files.", 'Review without modifying files.', 'Find bugs in this patch without touching files.']) {
    expect(await dispatchModTask({ ...input, task }, deps as never)).toEqual({ mode: 'direct', reason: 'user_requested_direct' });
  }
  expect(calls).toEqual([]);
});

test('explicit instructions against making changes never triage or launch', async () => {
  const { calls, deps, input } = fixture();
  for (const task of ['Implement parser. Do not make any changes.', "Implement parser. Don't apply changes.", 'Create a migration plan without making modifications.', 'Implement parser; never introduce further edits.', 'Implemente o parser. Não faça alterações.', 'Crie um plano; não aplique quaisquer modificações.']) {
    expect(await dispatchModTask({ ...input, task }, deps as never)).toEqual({ mode: 'direct', reason: 'user_requested_direct' });
  }
  expect(calls).toEqual([]);
});

test('global read-only constraints after writing verbs never triage or launch', async () => {
  const { calls, deps, input } = fixture();
  for (const task of ['Create a migration plan for splitting authentication across services. This session is read-only.', 'Implement auth; read-only.', 'Build a migration plan. The task must remain read only.', 'Crie um plano de migração. Esta sessão é somente leitura.', 'Implemente autenticação; apenas leitura.']) {
    expect(await dispatchModTask({ ...input, task }, deps as never)).toEqual({ mode: 'direct', reason: 'user_requested_direct' });
  }
  expect(calls).toEqual([]);
});

test('review and inspection requests never launch an implementer', async () => {
  const { calls, deps, input } = fixture();
  for (const task of ['How do I implement OAuth in this codebase?', 'Como implementar OAuth neste projeto?', 'Review this change for security and races.', 'Could you review this change for security issues?', 'Review this fix for regressions.', 'Check the authentication flow for vulnerabilities.', 'Verifique o fluxo de autenticação.', 'Faça uma revisão deste código.', 'Audit the authentication module.', 'Analise este código.', 'Avalie os riscos desta mudança.', 'Find bugs in this patch.']) {
    expect(await dispatchModTask({ ...input, task }, deps as never)).toEqual({ mode: 'direct', reason: 'read_only_task' });
  }
  expect(calls).toEqual([]);
});

test('agent refusals and context-dependent follow-ups remain with the advisor', async () => {
  const { calls, deps, input } = fixture();
  for (const task of ['Implement parser. Do not use agents.', "Implement parser. Don't use any subagents.", 'Implemente o parser. Não use agentes.']) {
    expect(await dispatchModTask({ ...input, task }, deps as never)).toEqual({ mode: 'direct', reason: 'user_requested_direct' });
  }
  for (const task of ['Implement the plan we agreed on.', 'Implemente o plano que combinamos.', 'executar', 'Continue with the previous plan.']) {
    expect(await dispatchModTask({ ...input, task }, deps as never)).toEqual({ mode: 'direct', reason: 'task_brief_required' });
  }
  expect(calls).toEqual([]);
});

test('explicit implementation requests with polite prefixes still reach routing', async () => {
  const { deps, input } = fixture();
  for (const task of ['Please implement an API integration.', 'Could you please implement an API integration?', 'I want you to implement an API integration.', 'I need to implement an API integration.', 'Por favor, implemente uma integração de API.', 'Quero que você implemente uma integração de API.']) {
    expect(await dispatchModTask({ ...input, task }, deps as never)).toMatchObject({ mode: 'delegate' });
  }
});

test('advice and indirect mentions of writing never authorize automatic implementation', async () => {
  const { calls, deps, input } = fixture();
  for (const task of ['Tell me what to change in the OAuth API integration.', 'Tell me where to add OAuth validation.', 'Suggest changes to implement in the API.', 'Give me a plan to implement OAuth.', 'Diga o que alterar para implementar uma integração de API.', 'The API developers implement authentication here.', 'Tell me how to investigate and fix API authentication failures.', 'Give me advice on how to diagnose and fix API authentication failures.', 'Me diga como investigue e corrija uma falha na API.']) {
    expect(await dispatchModTask({ ...input, task }, deps as never)).toEqual({ mode: 'direct', reason: 'read_only_task' });
  }
  expect(calls).toEqual([]);
});

test('an implementation mentioning audit or review still reaches routing', async () => {
  const { deps, input } = fixture();
  for (const task of ['Implement audit logging.', 'Fix the review function.', 'Adicione auditoria de acesso.', 'Implement a read-only dashboard.', 'Crie um painel somente leitura.']) {
    expect(await dispatchModTask({ ...input, task }, deps as never)).toMatchObject({ mode: 'delegate' });
  }
});

test('investigation followed by an explicit repair delegates with the full scope', async () => {
  const { deps, input } = fixture();
  for (const task of ['Investigate and fix the confidence mismatch.', 'Investigate the confidence mismatch; fix the root cause.', 'Investigate cache corruption, fix the root cause.', 'Investigate the cache. Fix the ownership bug.', 'Investigue a divergência; corrija a causa.', 'Investigue e corrija uma discrepância de confiança na integração do cliente Jev com a triagem e a CLI do Herdr. Preserve as decisões e o contrato existente; valide distribuições concentradas, escalonamento de complexidade e respostas sem probabilidades. Não publique alterações.']) {
    expect(await dispatchModTask({ ...input, task }, { ...deps,
      pipeline: async (plan) => { expect(plan.task).toBe(task); return { mode: 'delegate', run: { id } }; },
    } as never)).toMatchObject({ mode: 'delegate' });
  }
  for (const task of ['Review and fix this parser. This session is read-only.', 'Investigate and fix cache corruption, but this session is read-only.', 'Investigue e corrija a divergência, mas esta sessão é somente leitura.', 'Investigate and fix it. Do not delegate.', 'Investigue e corrija o parser. Não altere arquivos.']) {
    expect(await dispatchModTask({ ...input, task }, deps as never)).toEqual({ mode: 'direct', reason: 'user_requested_direct' });
  }
  for (const task of ['Review this fix before approval.', 'Investigate and explain this implementation.', 'Analise a correção existente.', 'Review the code and then explain this fix.', 'Review the guide explaining how to investigate and fix cache corruption.', 'Review the patch titled "Investigate and fix the confidence mismatch" for regressions.', 'Review the patch titled `Investigate and fix the confidence mismatch`.', "Review the patch titled 'Investigate and fix the confidence mismatch'.", 'Revise a alteração “Investigue e corrija a divergência”.']) {
    expect(await dispatchModTask({ ...input, task }, deps as never)).toEqual({ mode: 'direct', reason: 'read_only_task' });
  }
});

test('a restriction on one named file preserves delegation and the complete task', async () => {
  const { deps, input } = fixture();
  for (const task of ['Implement a stream adapter. Do not edit pilot.js.', 'Implemente um adapter. Não altere pilot.js.', 'Implement parser. Do not modify "protected.ts".']) {
    expect(await dispatchModTask({ ...input, task }, { ...deps,
      pipeline: async (plan) => { expect(plan.task).toBe(task); return { mode: 'delegate', run: { id } }; },
    } as never)).toMatchObject({ mode: 'delegate' });
  }
  for (const task of ['Implement parser. Do not edit pilot.js or any files.', 'Implemente parser. Não altere pilot.js nem outros arquivos.', 'Implement parser. Do not edit pilot.js. Do not delegate.']) {
    expect(await dispatchModTask({ ...input, task }, deps as never)).toEqual({ mode: 'direct', reason: 'user_requested_direct' });
  }
});

test('quoted writing verbs and descriptions of repairs remain review requests', async () => {
  const { calls, deps, input } = fixture();
  for (const task of ['"Fix the API" is the patch title; review it for regressions.', 'Review the guide explaining how teams investigate and fix API regressions.', 'Describe how to implement an API integration.', 'Descreva como implementar uma integração de API.', 'Show me how to implement an API integration.', 'Teach me how to implement an API integration.', 'Mostre como implementar uma integração de API.', 'Ensine como implementar uma integração de API.', 'Tell me how to implement an API integration.', 'Me diga como implementar uma integração de API.', 'I need guidance on how to implement an API integration.', 'Give me advice about how to implement an API integration.']) {
    expect(await dispatchModTask({ ...input, task }, deps as never)).toEqual({ mode: 'direct', reason: 'read_only_task' });
  }
  expect(calls).toEqual([]);
});

test('the mixed repair exception is limited to investigation and diagnosis', async () => {
  const { calls, deps, input } = fixture();
  for (const task of ['Review the parser and fix the regression.', 'Inspect the cache, then implement the compatibility fix.', 'Review the investigation and fix in this patch.', 'Review the guide explaining how to identify and fix API regressions.']) {
    expect(await dispatchModTask({ ...input, task }, deps as never)).toEqual({ mode: 'direct', reason: 'read_only_task' });
  }
  expect(calls).toEqual([]);
});

test('explicit repair survives introductory authorization and reproduction instructions', async () => {
  const { deps, input } = fixture();
  for (const task of ['I want you to investigate and fix the crash.', 'Investigate how to reproduce the crash and fix it.']) {
    expect(await dispatchModTask({ ...input, task }, deps as never)).toMatchObject({ mode: 'delegate' });
  }
});

test('investigating documents about repairs does not request implementation', async () => {
  const { calls, deps, input } = fixture();
  for (const task of ['Investigate the guide explaining how teams investigate and fix API regressions.', 'Investigate the documentation showing how developers diagnose and fix concurrency errors.']) {
    expect(await dispatchModTask({ ...input, task }, deps as never)).toEqual({ mode: 'direct', reason: 'read_only_task' });
  }
  expect(calls).toEqual([]);
});

test('descriptions of how others repair and multiline guides stay read-only', async () => {
  const { calls, deps, input } = fixture();
  for (const task of ['Investigate how developers diagnose and fix API regressions.', 'Investigate how developers find and fix API regressions.', 'Investigate how developers diagnose API regressions, fix them, and verify the result.', 'Investigate how teams reproduce and fix API regressions.', 'Investigate how teams understand and fix API regressions.', 'Investigate the guide\nexplaining how teams investigate and fix API regressions.']) {
    expect(await dispatchModTask({ ...input, task }, deps as never)).toEqual({ mode: 'direct', reason: 'read_only_task' });
  }
  expect(calls).toEqual([]);
});

test('ambiguous how descriptions stay direct while a separate repair instruction delegates', async () => {
  const { deps, input } = fixture();
  expect(await dispatchModTask({ ...input, task: 'Investigate how cache corruption happens and fix the root cause.' }, deps as never)).toEqual({ mode: 'direct', reason: 'read_only_task' });
  expect(await dispatchModTask({ ...input, task: 'Investigate how cache corruption happens; fix the root cause.' }, deps as never)).toMatchObject({ mode: 'delegate' });
  expect(await dispatchModTask({ ...input, task: 'Review the investigation and fix for cache corruption.' }, deps as never)).toEqual({ mode: 'direct', reason: 'read_only_task' });
  expect(await dispatchModTask({ ...input, task: 'Investigate and fix cache corruption, in read-only mode.' }, deps as never)).toEqual({ mode: 'direct', reason: 'user_requested_direct' });
});

test('an unsupported consult adapter leaves execution direct before dispatch', async () => {
  const { calls, deps, input } = fixture();
  const originalPlan = deps.plan;
  deps.plan = (...args) => ({ ...originalPlan(...args), consultStage: { client: 'codex', model: 'gpt-6.1-sol', role: 'reviewer', effort: 'xhigh', extraFlags: [], description: 'Consult' } });
  expect(await dispatchModTask(input, deps as never)).toEqual({ mode: 'direct', reason: 'consult_adapter_unavailable' });
  expect(calls).toEqual([]);
});

test('unavailable executor is removed and cannot be dispatched with the old decision', async () => {
  const { calls, deps, input } = fixture();
  deps.probe = async () => false;
  expect(await dispatchModTask(input, deps as never)).toMatchObject({ mode: 'direct', reason: 'decision_changed' });
  expect(calls).toEqual(['record']);
});

test('a failed probe with a different catalog effort preserves healthy fallback models', async () => {
  const { calls, deps, input } = fixture();
  const gemini = { client: 'antigravity', model: 'gemini-3-8-flash', cliModel: 'gemini-3.8-flash-high', effort: 'high' };
  const fallback = { ...profile, executor: { client: 'kimi', model: 'k2', cliModel: 'k2', effort: 'high' } };
  expect(await dispatchModTask(input, { ...deps,
    detect: async () => [{ client: 'claude', installed: true, healthy: true }, { client: 'antigravity', installed: true, healthy: true }, { client: 'kimi', installed: true, healthy: true }],
    catalog: () => ({ ok: true, value: { clients: { claude: { models: [{ id: 'opus-5', cli_id: 'claude-opus-5-5' }] }, antigravity: { models: [{ id: 'gemini-3-8-flash', cli_id: 'gemini-3.8-flash-medium' }] }, kimi: { models: [{ id: 'k2', cli_id: 'k2' }] } } } }),
    plan: (_task, _client, _triage, options) => {
      expect(options.delegation.availableModels).toContain('claude-opus-5-5');
      expect(options.delegation.availableModels).toContain('k2');
      const executor = options.crossHarness.allowedPeers.claude.includes('antigravity') ? gemini : fallback.executor;
      return { task: input.task, client: 'claude', stages: [], delegation: { mode: 'delegate', profile: { ...fallback, executor } },
        executionStages: [{ ...executor, role: 'implementer', extraFlags: [], description: '' }, { ...profile.reviewer, role: 'reviewer', extraFlags: [], description: '' }] };
    },
    probe: async stage => { calls.push(`probe:${stage.client}`); return stage.client !== 'antigravity'; },
    command: () => ({ id, decision: { mode: 'delegate', profile: fallback }, activation: 'active' }),
  } as never)).toMatchObject({ mode: 'delegate', id });
  expect(calls).toEqual(['probe:antigravity', 'probe:kimi', 'probe:claude', 'dispatch']);
});

test('a planner repeating an unavailable target cannot probe or launch it again', async () => {
  const { calls, deps, input } = fixture();
  const originalPlan = deps.plan;
  deps.plan = (...args) => ({ ...originalPlan(...args), delegation: decision });
  deps.probe = async () => { calls.push('probe:failed'); return false; };
  expect(await dispatchModTask(input, deps as never)).toMatchObject({ mode: 'direct', reason: 'models_unavailable' });
  expect(calls).toEqual(['probe:failed', 'record']);
});

test('shadow records the policy without probing or spawning, and child roles do not recurse', async () => {
  const { calls, deps, input } = fixture();
  expect(await dispatchModTask({ ...input, shadow: true }, deps as never)).toMatchObject({ mode: 'shadow', id });
  expect(calls).toEqual(['record']);
  deps.context = async () => ({ client: 'claude', sourcePaneId: 'source', workspaceId: 'workspace', sourceAgentName: 'jev-impl-child', delegation: {} });
  expect(await dispatchModTask(input, deps as never)).toEqual({ mode: 'direct', reason: 'child_role' });
  expect(calls).toEqual(['record']);
});

test('repositories without a test script still receive an explicit diff check', () => {
  mkdirSync(join(state.stateDir, id), { recursive: true });
  const path = modVerifyCommand(state.stateDir, id);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(['git', 'diff', '--check', 'HEAD']);
});

test('cleanup closes only a verified worker whose native name and pane still match', async () => {
  let closed = 0;
  const name = `jev-impl-${id.slice(0, 12)}`;
  const run = { stages: [{ role: 'implementer', state: 'verified', agent: name, pane: 'owned', token: id }, { role: 'reviewer', state: 'verified' }] };
  let agent = { name, pane_id: 'owned', agent_status: 'idle' };
  const herdr = { getAgent: async () => ({ ok: true, stdout: JSON.stringify({ result: { agent } }) }), closePane: async () => { closed++; return { ok: true }; } };
  await closeVerifiedModWorker(run, herdr as never);
  expect(closed).toBe(1);
  agent = { ...agent, pane_id: 'someone-else' };
  await closeVerifiedModWorker(run, herdr as never);
  run.stages[0]!.state = 'unknown';
  agent = { ...agent, pane_id: 'owned' };
  await closeVerifiedModWorker(run, herdr as never);
  expect(closed).toBe(1);
});
