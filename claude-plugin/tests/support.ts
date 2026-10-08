import { mock } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { HarnessHumanAsk, HarnessPlan, HarnessWorkerRow } from '../types'

export type SpecSeen = {
  name: string
  model?: string
  effort?: string | number
  tools?: readonly string[]
  disallowedTools?: readonly string[]
}

export type Spawned = {
  subagentType?: string
  prompt: string
  description?: string
  model?: string
  cwd?: string
}

export type Seen = {
  spawns: Spawned[]
  runs: string[][]
  toasts: string[]
  logs: string[]
  opened: string[]
  closed: string[]
  skillSelect: Record<string, unknown>
  failSelect: boolean
  routeSkill: string | null
  skills: { name: string; source: string }[]
  failUsage: boolean
  surfaces: string[]
  alive: { id: string; status: string }[]
  registered: string[]
  specs: SpecSeen[]
  failCli: boolean
  sessionId: string
  failModels: boolean
  failList: boolean
  denySpawn: string[]
  throwSpawn: string | null
  models: ModelsFixture
  reviewExit: number
  reviewBody: Record<string, unknown>
  reviewGate: Promise<void> | null
  failRegister: boolean
  descriptions: Map<string, string>
  gitDiff: string
  gitStat: string
  failGit: boolean
  state: Map<string, unknown>
  saved: Map<string, unknown>
  clock: MockClock
  turnIds: string[]
}

export const CWD = '/work/demo'
export const SESSION_MODEL = 'claude-fable-5-1'

export type ModelsFixture = {
  client: string
  roles: Record<string, Record<string, unknown>>
}

export function modelsFixture(): ModelsFixture {
  return {
    client: 'claude',
    roles: {
      advisor: { model: 'fable-5', cliModel: 'claude-fable-5-1', effort: 'high', readonly: false, fallbackActive: false },
      implementer: { model: 'sonnet-5', cliModel: 'claude-sonnet-5-5', effort: 'high', readonly: false, fallbackActive: false },
      reviewer: { model: 'opus-5', cliModel: 'claude-opus-5-5', effort: 'xhigh', readonly: true, fallbackActive: false },
      researcher: { model: 'sonnet-5', cliModel: 'claude-sonnet-5-5', effort: 'standard', readonly: true, fallbackActive: false },
      reader: {
        model: 'claude-haiku-4-5-20251001',
        cliModel: 'claude-haiku-4-5-20251001',
        effort: 'standard',
        readonly: true,
        fallbackActive: false,
      },
    },
  }
}

export function complexityFor(task: string): string {
  if (/architect|design/i.test(task)) return 'architectural'
  if (/typo/i.test(task)) return 'trivial'
  return 'routine'
}

export function triageJson(task: string): string {
  return JSON.stringify({
    task,
    complexity: complexityFor(task),
    confidence: 0.82,
    needsResearch: false,
    effort: 'high',
    recommendedPipeline: 'triad',
    latencyMs: 300,
  })
}

export function readyReport(): Record<string, unknown> {
  return {
    session: 's',
    client: 'claude',
    cwd: '/work/demo',
    base: null,
    scopes: [{ name: 'auto', fileCount: 2 }],
    verify: { status: 'ready' },
    judges: [{ scope: 'auto', status: 'ready' }],
    status: 'ready',
  }
}

export function pendingReport(): Record<string, unknown> {
  return {
    session: 's',
    client: 'claude',
    cwd: '/work/demo',
    base: null,
    scopes: [{ name: 'auto', fileCount: 2 }],
    verify: { status: 'ready' },
    judges: [{ scope: 'auto', status: 'pending_judge' }],
    status: 'pending_judge',
  }
}

export function wire(on: On, extra: { model?: string; session?: string; store?: Record<string, unknown> } = {}): Seen {
  const clock = mock.clock(on, { now: 1_000_000 })
  const seen: Seen = { spawns: [], runs: [], toasts: [], logs: [], opened: [], closed: [], skillSelect: { selected: [{ name: 'tdd' }], cliSelected: [{ name: 'git-insight-mcp' }], totalEligible: 74 }, failSelect: false, routeSkill: null, skills: [], failUsage: false, surfaces: ['terminal'], alive: [], registered: [], specs: [], failCli: false, sessionId: extra.session ?? 'sess-1', failModels: false, failList: false, denySpawn: [], throwSpawn: null, models: modelsFixture(), reviewExit: 0, reviewBody: readyReport(), reviewGate: null, failRegister: false, descriptions: new Map(), gitDiff: '', gitStat: '', failGit: false, state: new Map(), saved: new Map(Object.entries(extra.store ?? {})), clock, turnIds: [] }

  on('store.get', (_$, e) => ({ value: seen.saved.get(e.key) }))
  on('store.set', (_$, e) => {
    seen.saved.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    seen.saved.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...seen.saved.keys()] }))
  on('state.set', async (_$, e, next) => {
    seen.state.set(`${e.plugin}.${e.key}`, e.value)
    return next(e)
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('prompt.attachment', (_$, e) => ({ text: e.text }))
  on('agent.offer', () => ({ isOffered: true }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('classic.SessionStart', () => ({}))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }) as never)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }) as never)
  on('turn.start', (_$, e) => {
    seen.turnIds.push(e.turnId)
    return { turnId: e.turnId }
  })
  on('tool.call', () => ({ result: 'ok' }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.model', () => ({ value: extra.model ?? SESSION_MODEL }))
  on('session.usage', () => {
    if (seen.failUsage) throw new Error('usage down')
    return {
      value: {
        startedAt: 0,
        context: { breakdown: { skills: { skillFrontmatter: seen.skills.map(one => ({ ...one, tokens: 10 })) } } },
        rateLimits: [],
      },
    } as never
  })
  on('session.surfaces', () => ({ value: seen.surfaces as never }))
  on('session.id', () => ({ value: seen.sessionId }))
  on('tool.register', (_$, e) => {
    seen.descriptions.set(e.name, e.description)
    seen.registered.push(`tool:${e.name}`)
    return { value: { tool: e.name } }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('agent.register', (_$, e) => {
    if (seen.failRegister) throw new Error('register down')
    seen.registered.push(`agent:${e.name}`)
    seen.specs.push({
      name: e.name,
      model: e.model,
      effort: e.effort,
      tools: e.tools,
      disallowedTools: e.disallowedTools,
    })
    return { value: { agent: `harness:${e.name}` } }
  })
  on('agent.list', () => {
    if (seen.failList) throw new Error('list down')
    return {
    value: seen.alive.map(one => ({
      id: one.id,
      description: '',
      type: 'harness:implementer',
      status: one.status as 'running',
    })),
    }
  })
  on('agent.spawn', (_$, e) => {
    const raw = e as unknown as Record<string, unknown>
    const kind = raw.subagentType ?? raw.subagent_type
    if (typeof kind === 'string' && seen.denySpawn.includes(kind)) return { deny: `refused ${kind}` }
    if (seen.throwSpawn !== null) throw new Error(seen.throwSpawn)
    seen.spawns.push({
      subagentType: typeof kind === 'string' ? kind : undefined,
      prompt: e.prompt,
      description: e.description,
      model: e.model,
      cwd: e.cwd,
    })
    const agentId = `agent-${seen.spawns.length}`
    seen.alive.push({ id: agentId, status: 'running' })
    const answer = { model: e.model ?? 'sonnet', agentId, result: { agentId, resolvedModel: e.model ?? 'sonnet' } }
    return answer
  })
  on('process.run', async (_$, e) => {
    seen.runs.push([...e.argv])
    const sub = e.argv[1]
    const done = (exitCode: number, stdout: string, stderr = '') => ({
      value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (e.argv[0] === 'ai-harness' && sub === 'skill-select') {
      if (seen.failSelect) return done(2, '', 'select down')
      return done(0, JSON.stringify(seen.skillSelect))
    }
    if (sub === 'route-turn') {
      return done(0, JSON.stringify({ decision: { tier: 'deep', skill: seen.routeSkill } }))
    }
    if (e.argv[0] === 'git') {
      if (seen.failGit) throw new Error('git down')
      return done(0, e.argv.includes('--stat') ? seen.gitStat : seen.gitDiff)
    }
    if (sub === 'review') {
      if (seen.reviewGate !== null) await seen.reviewGate
      return done(seen.reviewExit, JSON.stringify(seen.reviewBody))
    }
    if (seen.failCli) return done(2, '', 'boom')
    if (sub === 'models') {
      if (seen.failModels) return done(1, '', 'models down')
      return done(0, JSON.stringify(seen.models))
    }
    if (sub === 'triage') return done(0, triageJson(e.argv[2] ?? ''))
    return done(0, 'not json')
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    seen.opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', (_$, e) => {
    seen.closed.push(e.id)
    return { value: undefined }
  })
  on('ui.log', (_$, e) => {
    seen.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  return seen
}

export async function settle(): Promise<void> {
  for (let index = 0; index < 200; index += 1) await Promise.resolve()
}

export const PLAN_TOOL = 'mcp__harness__harness_plan'
export const RUN_TOOL = 'mcp__harness__harness_run'
export const STATUS_TOOL = 'mcp__harness__harness_status'

export type PlanArgs = {
  objective: string
  tasks: { title: string; deps?: string[]; paths?: string[]; checks?: string[]; role?: string }[]
}

export async function makePlan($: Engine, args: PlanArgs): Promise<string> {
  const out = await $.tool.call({ tool: PLAN_TOOL, ...args })
  return String(out.result)
}

export async function runTask($: Engine, taskId?: string): Promise<string> {
  const out = await $.tool.call(taskId === undefined ? { tool: RUN_TOOL } : { tool: RUN_TOOL, taskId })
  return String(out.result)
}

export function planState(seen: Seen): HarnessPlan | null {
  return (seen.state.get('harness.plan') as HarnessPlan | null | undefined) ?? null
}

export function workersState(seen: Seen): Record<string, HarnessWorkerRow> {
  return (seen.state.get('harness.workers') as Record<string, HarnessWorkerRow> | undefined) ?? {}
}

export function asksState(seen: Seen): HarnessHumanAsk[] {
  return (seen.state.get('harness.needsYou') as HarnessHumanAsk[] | undefined) ?? []
}

export async function finish(
  $: Engine,
  agentId: string,
  answer: string,
  reason: 'answer' | 'aborted' | 'error' = 'answer',
): Promise<void> {
  await $.turn.complete({ answer, durationMs: 10, isAborted: reason === 'aborted', turnId: `turn-${agentId}`, agentId, reason })
}

export const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 6,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 6 },
  view: {},
}

export const PANE_PROPS = {
  title: 'Harness',
  isFocused: false,
  bodyColumns: 100,
  placement: 'inline' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}
