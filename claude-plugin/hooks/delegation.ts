import type { EngineInterface, On, PluginOptions } from 'claude-code'
import {
  DEFAULT_MODELS,
  REGISTERED_PAIRS,
  agentTypeFor,
  enforceSpawn,
  isRegisteredType,
  judge,
  mergeModels,
  parseModelOverrides,
  withPasso0,
} from './judge-core'
import { publishDelegations } from './jev-state'
import type { Decision, Hints, JudgeClass, Models, Worker } from './judge-core'
import { summarizeEvents } from './panes-core'

const TOOL_WAIT = /^mcp__harness__harness_wait$/
const HARD_CAP = 20
const MAX_RUNS = 200
const MAX_QUEUE = 100
const WAIT_DEFAULT_MS = 120_000
const EXT_POLL_MS = 1000
const MODELS_FILE = '.config/jev/models.local.yml'
const CLASSES: readonly string[] = ['explore', 'search', 'summary', 'mechanical', 'feature', 'fix', 'review', 'architecture']
const WORKERS: readonly string[] = ['claude-subagent', 'codex', 'agy']

type RunState = 'queued' | 'running' | 'done' | 'failed' | 'skipped'
type Ext = { id: string; file: string | null; name: string; host?: string; paneId?: string | null }
type Run = {
  id: string
  task: string
  cwd?: string
  tab?: string
  decision: Decision
  state: RunState
  agentId?: string
  watch?: string
  ext?: Ext
  result?: string
  stub?: boolean
  note?: string
  done: Promise<void>
  finish: () => void
}
type TaskInput = { task: string; class?: string; size?: string; prefer?: string; cwd?: string; tab?: string }

const runs = new Map<string, Run>()
const byAgent = new Map<string, string>()
const ownPrompts = new Map<string, number>()
const queue: string[] = []
let counter = 0
const newSalt = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
let salt = newSalt()
let dirty = false
let flushing: Promise<void> | null = null
let modelsLoaded: Promise<Models> | null = null
let availableLoaded: Promise<Partial<Record<Worker, boolean>>> | null = null

export const delegationEnabled = (options: PluginOptions): boolean => options.delegation === true
export const panesEnabled = (options: PluginOptions): boolean => options.panes === true
const herdrJevBin = (options: PluginOptions): string =>
  typeof options.herdrJevBin === 'string' && options.herdrJevBin.trim() !== '' ? options.herdrJevBin.trim() : 'herdr-jev'

export function resetDelegation(): void {
  runs.clear()
  byAgent.clear()
  ownPrompts.clear()
  queue.length = 0
  counter = 0
  salt = newSalt()
  dirty = false
  flushing = null
  modelsLoaded = null
  availableLoaded = null
}

function maxWorkers(options: PluginOptions): number {
  const raw = options.maxWorkers
  return typeof raw === 'number' && raw > 0 ? Math.min(Math.floor(raw), HARD_CAP) : 3
}

function loadModels($: EngineInterface): Promise<Models> {
  modelsLoaded ??= (async () => {
    try {
      const home = await $.env.get('HOME')
      if (home === undefined) return DEFAULT_MODELS
      return mergeModels(DEFAULT_MODELS, parseModelOverrides(await $.fs.read(`${home}/${MODELS_FILE}`)))
    } catch {
      return DEFAULT_MODELS
    }
  })()
  return modelsLoaded
}

function loadAvailable($: EngineInterface): Promise<Partial<Record<Worker, boolean>>> {
  availableLoaded ??= (async () => {
    const found: Partial<Record<Worker, boolean>> = { 'claude-subagent': true }
    for (const bin of ['codex', 'agy'] as const) {
      try {
        const run = await $.process.run(['sh', '-c', `command -v ${bin}`], { timeoutMs: 2000 })
        found[bin] = run.exitCode === 0
      } catch {
        found[bin] = false
      }
    }
    return found
  })()
  return availableLoaded
}

export async function registerJudgeAgents($: EngineInterface, options: PluginOptions): Promise<string[]> {
  if (!delegationEnabled(options)) return []
  const models = await loadModels($)
  const names: string[] = []
  for (const pair of REGISTERED_PAIRS) {
    const name = agentTypeFor(pair.tier, pair.effort).split(':')[1] as string
    await $.agent.register({
      name,
      description: `Harness ${pair.tier} worker at ${pair.effort} effort, chosen by the delegation judge.`,
      prompt: 'Do exactly the task you are given. Report what you did and which skills you used.',
      model: pair.tier,
      effort: pair.effort,
    })
    names.push(name)
  }
  return names
}

export async function registerDelegationTools($: EngineInterface, options: PluginOptions): Promise<void> {
  if (!delegationEnabled(options)) return
  await $.tool.register({
    name: 'harness_wait',
    description: 'Wait for runs started by harness_delegate. Takes runIds, mode all or first, timeoutMs. Returns state and result per run.',
    inputSchema: {
      type: 'object',
      properties: {
        runIds: { type: 'array', items: { type: 'string' } },
        mode: { type: 'string', enum: ['all', 'first'] },
        timeoutMs: { type: 'number' },
      },
      required: ['runIds'],
    },
  })
}

function parseTasks(raw: unknown): TaskInput[] {
  if (!Array.isArray(raw)) return []
  const out: TaskInput[] = []
  for (const item of raw) {
    if (typeof item === 'string' && item.trim() !== '') out.push({ task: item })
    else if (typeof item === 'object' && item !== null && typeof (item as TaskInput).task === 'string') out.push(item as TaskInput)
  }
  return out
}

function newRun(task: TaskInput, decision: Decision): Run {
  counter += 1
  let finish: () => void = () => undefined
  const done = new Promise<void>(resolve => {
    finish = resolve
  })
  const run: Run = { id: `run-${counter}`, task: task.task, cwd: task.cwd, tab: typeof task.tab === 'string' && task.tab !== '' ? task.tab : undefined, decision, state: 'queued', done, finish }
  runs.set(run.id, run)
  evict()
  return run
}

function releaseOwn(prompt: string): void {
  const left = (ownPrompts.get(prompt) ?? 0) - 1
  if (left > 0) ownPrompts.set(prompt, left)
  else ownPrompts.delete(prompt)
}

function evict(): void {
  for (const [id, run] of runs) {
    if (runs.size <= MAX_RUNS) return
    if (run.state === 'queued' || run.state === 'running') continue
    runs.delete(id)
    if (run.agentId !== undefined) byAgent.delete(run.agentId)
  }
}

function settle(run: Run, state: 'done' | 'failed' | 'skipped', result: string, extra: Partial<Run> = {}): void {
  Object.assign(run, extra, { state, result })
  run.finish()
}

async function startClaude($: EngineInterface, run: Run, options: PluginOptions): Promise<void> {
  run.state = 'running'
  void publish($)
  const prompt = withPasso0(run.task)
  ownPrompts.set(prompt, (ownPrompts.get(prompt) ?? 0) + 1)
  try {
    const spawned = await $.agent.spawn({
      subagentType: run.decision.agentType,
      model: run.decision.tier,
      prompt,
      description: run.task.replace(/\s+/g, ' ').slice(0, 60),
      ...(run.cwd === undefined ? {} : { cwd: run.cwd }),
    })
    if (spawned.deny !== undefined) return settle(run, 'failed', `spawn refused: ${spawned.deny}`)
    if (spawned.agentId === undefined) return settle(run, 'failed', 'spawn returned no agent id')
    run.agentId = spawned.agentId
    byAgent.set(spawned.agentId, run.id)
    await watchClaude($, run, options)
  } catch (error) {
    settle(run, 'failed', `spawn failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200))
  } finally {
    releaseOwn(prompt)
    void publish($)
  }
}

async function startExternal($: EngineInterface, run: Run, options: PluginOptions): Promise<void> {
  run.state = 'running'
  void publish($)
  const id = `x${Date.now().toString(36)}-${run.id.replace(/\D/g, '')}`
  const name = `${run.decision.class}-${run.id.replace(/\D/g, '')}`
  const cwd = run.cwd
  const argv = [
    herdrJevBin(options), 'panes', 'start', '--run', id, '--name', name, '--cli', run.decision.worker,
    '--model', run.decision.model, '--effort', run.decision.effort, '--stdin-prompt',
    '--session', await $.session.id(), '--max', String(maxWorkers(options)),
    ...(options.failover === true ? ['--failover'] : []),
    ...(panesEnabled(options) ? [] : ['--host', 'background']),
    ...(run.tab === undefined ? [] : ['--tab', run.tab]),
  ]
  try {
    const out = await $.process.run(argv, { stdin: withPasso0(run.task), timeoutMs: 30_000, ...(cwd === undefined ? {} : { cwd }) })
    const body = JSON.parse(out.stdout.trim().split('\n').pop() ?? '') as { status?: string; eventsFile?: string; host?: string; paneId?: string | null; reason?: string; error?: string }
    if (out.exitCode !== 0 || body.status === 'failed' || body.status === undefined) {
      return settle(run, 'failed', `worker-run not started: ${body.reason ?? body.error ?? (out.stderr.slice(0, 160) || 'unknown error')}`)
    }
    run.ext = { id, file: body.eventsFile ?? null, name, host: body.host, paneId: body.paneId }
    run.note = body.status === 'queued' ? `queued behind ${maxWorkers(options)} visible workers` : `${body.host ?? 'background'} pane ${body.paneId ?? ''}`.trim()
  } catch (error) {
    settle(run, 'failed', `worker-run failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200))
  } finally {
    void publish($)
  }
}

const finished = (r: Run): boolean => r.state !== 'queued' && r.state !== 'running'

async function refreshExternal($: EngineInterface, run: Run): Promise<void> {
  if (run.ext?.file == null || finished(run)) return
  let text: string
  try {
    text = await $.fs.read(run.ext.file)
  } catch {
    return
  }
  const sum = summarizeEvents(text)
  if (sum.state === 'running') return
  if (sum.state === 'done') settle(run, 'done', sum.tail)
  else settle(run, 'failed', `${sum.outcome}${sum.exitCode === null ? '' : ` (exit ${sum.exitCode})`}: ${sum.tail}`.slice(0, 4000))
  void publish($)
}

async function pumpPanes($: EngineInterface, options: PluginOptions): Promise<void> {
  try {
    await $.process.run([herdrJevBin(options), 'panes', 'pump', '--max', String(maxWorkers(options))], { timeoutMs: 20_000 })
  } catch {
    return
  }
}

async function paneCli($: EngineInterface, options: PluginOptions, args: string[], init: { stdin?: string; cwd?: string } = {}): Promise<string> {
  const out = await $.process.run([herdrJevBin(options), 'panes', ...args], { timeoutMs: 20_000, ...init })
  return out.stdout.trim()
}

async function watchClaude($: EngineInterface, run: Run, options: PluginOptions): Promise<void> {
  if (!panesEnabled(options) || options.watchClaudeAgents !== true) return
  try {
    const id = `c${Date.now().toString(36)}-${run.id.replace(/\D/g, '')}`
    const name = `${run.decision.class}-${run.id.replace(/\D/g, '')}`
    await paneCli($, options, ['event', '--run', id, '--type', 'start'])
    await paneCli($, options, ['event', '--run', id, '--type', 'out', '--line', `${run.decision.agentType} ${run.decision.model}: ${run.task.replace(/\s+/g, ' ').slice(0, 200)}`])
    run.watch = id
    await paneCli($, options, ['watch-open', '--run', id, '--name', name], run.cwd === undefined ? {} : { cwd: run.cwd })
  } catch {
    return
  }
}

async function watchClaudeEnd($: EngineInterface, run: Run, options: PluginOptions, ok: boolean, text: string): Promise<void> {
  if (run.watch === undefined) return
  try {
    await paneCli($, options, ['event', '--run', run.watch, '--type', 'exit', '--outcome', ok ? 'done' : 'failed', '--line', text.slice(0, 1500)])
  } catch {
    return
  }
}

export async function abortPanes($: EngineInterface, options: PluginOptions, backgroundOnly: boolean): Promise<void> {
  if (!delegationEnabled(options)) return
  if (!backgroundOnly && ![...runs.values()].some(r => r.ext !== undefined && !finished(r))) return
  try {
    await paneCli($, options, ['abort', '--session', await $.session.id(), ...(backgroundOnly ? ['--background-only'] : [])])
  } catch {
    return
  }
}

export async function detachPanes($: EngineInterface, options: PluginOptions): Promise<void> {
  if (!delegationEnabled(options)) return
  try {
    await paneCli($, options, ['detach', '--session', await $.session.id()])
  } catch {
    return
  }
}

export async function paneCommand($: EngineInterface, options: PluginOptions, verb: string, argv: string[], yes: boolean): Promise<string> {
  if (!panesEnabled(options)) return 'Panes are off. Enable the panes option of the harness mod.'
  const cwd = await $.session.cwd()
  const flags = ['--cwd', cwd, ...(yes ? ['--yes'] : [])]
  const sub = verb === 'layout' ? ['layout', ...argv] : [verb, ...argv]
  try {
    const raw = await paneCli($, options, [...sub, ...flags])
    const body = JSON.parse(raw.split('\n').pop() ?? '') as { message?: string; needsConfirm?: boolean; error?: string }
    if (body.needsConfirm === true) return `${body.message ?? 'confirm needed'}. Run: /harness ${verb} ${argv.join(' ')} --yes`
    return body.message ?? body.error ?? raw
  } catch (error) {
    return `harness ${verb} failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200)
  }
}

async function pump($: EngineInterface, options: PluginOptions): Promise<void> {
  const limit = maxWorkers(options)
  const active = () => [...runs.values()].filter(r => r.state === 'running').length
  while (queue.length > 0 && active() < limit) {
    const run = runs.get(queue.shift() as string)
    if (run !== undefined && run.state === 'queued') await startClaude($, run, options)
  }
}

function view(run: Run) {
  return {
    runId: run.id,
    state: run.state,
    class: run.decision.class,
    worker: run.decision.worker,
    model: run.decision.model,
    effort: run.decision.effort,
    reason: run.decision.reason,
    ...(run.stub === true ? { stub: true } : {}),
    ...(run.ext === undefined ? {} : { pane: run.ext.name, host: run.ext.host, extRunId: run.ext.id }),
    ...(run.note === undefined || run.ext === undefined ? {} : { note: run.note }),
    ...(run.result === undefined ? {} : { result: run.result }),
  }
}

function snapshot() {
  return [...runs.values()].slice(-50).map(run => ({
    id: `${salt}-${run.id}`,
    worker: run.decision.worker,
    model: run.decision.model,
    effort: run.decision.effort,
    class: run.decision.class,
    state: run.state,
    task: run.task.slice(0, 80),
  }))
}
function publish($: EngineInterface): Promise<void> {
  dirty = true
  flushing ??= (async () => {
    await Promise.resolve()
    try {
      while (dirty) {
        dirty = false
        await publishDelegations($, snapshot()).catch(() => undefined)
      }
    } finally {
      flushing = null
    }
  })()
  return flushing
}

export async function delegateBatch($: EngineInterface, input: Record<string, unknown>, options: PluginOptions): Promise<string> {
  if (!delegationEnabled(options)) return 'harness_delegate batch: delegation is off (userConfig delegation).'
  const tasks = parseTasks(input.tasks)
  if (tasks.length > 0 && queue.length + tasks.length > MAX_QUEUE) return `harness_delegate batch: queue is full (${MAX_QUEUE}); wait for runs to finish.`
  if (tasks.length === 0) return 'harness_delegate batch: tasks must be a non-empty array of { task }.'
  if (tasks.length > HARD_CAP) return `harness_delegate batch: at most ${HARD_CAP} tasks per call.`
  const [models, available] = await Promise.all([loadModels($), loadAvailable($)])
  const created: Run[] = []
  for (const task of tasks) {
    const hints: Hints = {
      available,
      ...(CLASSES.includes(task.class ?? '') ? { class: task.class as JudgeClass } : {}),
      ...(task.size === 'small' || task.size === 'large' ? { size: task.size } : {}),
      ...(WORKERS.includes(task.prefer ?? '') ? { prefer: task.prefer as Worker } : {}),
    }
    const run = newRun(task, judge(task.task, hints, models))
    created.push(run)
    if (run.decision.worker === 'claude-subagent') queue.push(run.id)
    else await startExternal($, run, options)
  }
  void publish($)
  await pump($, options)
  return JSON.stringify({ runs: created.map(view) })
}

export async function noteTurnComplete($: EngineInterface, e: { agentId?: string; answer: string; reason: string }, options: PluginOptions): Promise<void> {
  if (e.agentId === undefined) {
    if (e.reason === 'aborted') await abortPanes($, options, false)
    return
  }
  const id = byAgent.get(e.agentId)
  const run = id === undefined ? undefined : runs.get(id)
  if (run === undefined || run.state !== 'running') return
  byAgent.delete(e.agentId)
  if (e.reason === 'answer') settle(run, 'done', e.answer)
  else settle(run, 'failed', `worker turn ended: ${e.reason}`)
  await publish($)
  await watchClaudeEnd($, run, options, e.reason === 'answer', e.reason === 'answer' ? e.answer : e.reason)
  await pump($, options).catch(() => undefined)
}

async function waitRuns($: EngineInterface, input: Record<string, unknown>, options: PluginOptions): Promise<string> {
  const ids = Array.isArray(input.runIds) ? input.runIds.filter((x): x is string => typeof x === 'string') : []
  if (ids.length === 0) return 'harness_wait: runIds must be a non-empty array.'
  const lost = ids.filter(id => !runs.has(id)).map(id => ({ runId: id, state: 'lost', result: 'run perdido (reload ou expirado)' }))
  const picked = ids.map(id => runs.get(id)).filter((r): r is Run => r !== undefined)
  const timeout = typeof input.timeoutMs === 'number' && input.timeoutMs > 0 ? input.timeoutMs : WAIT_DEFAULT_MS
  const pending = picked.map(r => r.done)
  const joined = input.mode === 'first' ? Promise.race(pending) : Promise.all(pending).then(() => undefined)
  if (picked.some(r => r.ext !== undefined && !finished(r))) {
    const settled = () => (input.mode === 'first' ? picked.some(finished) : picked.every(finished))
    for (let waited = 0; waited < timeout; waited += EXT_POLL_MS) {
      await Promise.all(picked.map(r => refreshExternal($, r)))
      if (settled()) break
      if (waited % (EXT_POLL_MS * 5) === 0) await pumpPanes($, options)
      await Promise.race([joined, $.clock.sleep(EXT_POLL_MS)])
    }
  } else if (pending.length > 0) await Promise.race([joined, $.clock.sleep(timeout)])
  return JSON.stringify({
    results: [...picked.map(view), ...lost],
    pending: picked.filter(r => r.state === 'queued' || r.state === 'running').map(r => r.id),
  })
}

export function registerDelegationHooks(on: On, options: PluginOptions): void {
  on('tool.call', { tool: TOOL_WAIT }, async ($, e, next) => {
    if (e.agentId !== undefined) return { result: 'harness_wait: main session only.' }
    if (!delegationEnabled(options)) return { result: 'harness_wait: delegation is off (userConfig delegation).' }
    return { result: await waitRuns($, e as unknown as Record<string, unknown>, options) }
  }).catch(($, e, next) => (next.called ? next(e) : { result: 'harness_wait failed, see the debug log.' }))
}

type SpawnE = { subagentType?: string; model?: string; prompt: string; description?: string }

export async function spawnWithTier<E extends SpawnE, R>(
  $: EngineInterface,
  e: E,
  next: (input: E) => Promise<R>,
  options: PluginOptions,
): Promise<R> {
  if (!delegationEnabled(options)) return next(e)
  if (ownPrompts.has(e.prompt)) return next(e)
  const models = await loadModels($)
  const fix = enforceSpawn(e, models)
  if (!fix.changed) return next(e)
  if (fix.subagentType !== e.subagentType && (!isRegisteredType(fix.subagentType) || fix.model === undefined)) {
    return { deny: `harness delegation: ${fix.notes.join('; ') || 'tier rule'} has no registered type. Use harness_delegate.` } as unknown as R
  }
  return next({ ...e, prompt: fix.prompt, subagentType: fix.subagentType, model: fix.model })
}
