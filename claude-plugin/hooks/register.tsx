import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type {
  HarnessHumanAsk,
  HarnessPlan,
  HarnessReview,
  HarnessTask,
  HarnessWorkerRow,
} from '../types'
import { cliConfig, maxWorkers, runModels, runReview, runTriage } from './cli'
import type { RunPort } from './cli'
import {
  baseName,
  bar,
  buildPlan,
  countTasks,
  describeTool,
  findTask,
  fit,
  isAllVerified,
  isRecord,
  isUnblocking,
  kindOf,
  missingRoles,
  parseSaved,
  readyTasks,
  reviewPhrase,
  roleLabel,
  shortModel,
  STATE_GLYPH,
  summarize,
} from './plan'
import type { PlanTaskInput, ReviewPhase, SavedState, TriageResult } from './plan'
import {
  createGate,
  decideReviewTurn,
  decideWorkerTurn,
  launchAgent,
  registerKinds,
  resolveLaunch,
} from './workers'
import type { Gate, LaunchPorts } from './workers'

const planAtom = atom({ plugin: 'harness', key: 'plan' } as const, null)
const workersAtom = atom({ plugin: 'harness', key: 'workers' } as const, {})
const needsYouAtom = atom({ plugin: 'harness', key: 'needsYou' } as const, [])
const staleAtom = atom({ plugin: 'harness', key: 'stale' } as const, false)
const staleNoteAtom = atom({ plugin: 'harness', key: 'staleNote' } as const, null)
const isHiddenAtom = atom({ plugin: 'harness', key: 'isHidden' } as const, false)
const advisorModelAtom = atom({ plugin: 'harness', key: 'advisorModel' } as const, '')
const reviewAtom = atom({ plugin: 'harness', key: 'review' } as const, null)
const isReviewRunningAtom = atom({ plugin: 'harness', key: 'isReviewRunning' } as const, false)

const PANE_ID = 'harness'

const TOOL_PLAN = 'mcp__harness__harness_plan'
const TOOL_RUN = 'mcp__harness__harness_run'
const TOOL_STATUS = 'mcp__harness__harness_status'

const ACTIVE_STATUS = ['pending', 'running', 'waiting', 'idle']
const RESTARTABLE: readonly HarnessTask['state'][] = ['proposed', 'failed', 'needs_you']
const MAX_TASKS = 30
const HIDE_AFTER_MS = 20000
const STALE_LIST_NOTE = 'agent list unavailable'

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    objective: { type: 'string', description: 'The goal the tasks add up to.' },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          deps: { type: 'array', items: { type: 'string' }, description: 'Titles or ids of tasks this one waits for.' },
          paths: { type: 'array', items: { type: 'string' }, description: 'Paths this task owns.' },
          checks: { type: 'array', items: { type: 'string' }, description: 'Acceptance checks to run.' },
          role: { type: 'string', description: 'Optional role hint: reader, mechanic, implementer or advisor.' },
        },
        required: ['title'],
      },
    },
  },
  required: ['objective', 'tasks'],
}

const RUN_SCHEMA = {
  type: 'object',
  properties: {
    taskId: { type: 'string', description: 'Task id or title. Omit to run every ready proposed task.' },
  },
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((one): one is string => typeof one === 'string' && one.trim().length > 0)
    : []
}

function parsePlanInput(
  input: Readonly<Record<string, unknown>>,
): { objective: string; tasks: PlanTaskInput[] } | string {
  const objective = typeof input.objective === 'string' ? input.objective.trim() : ''
  if (objective.length === 0) return 'harness_plan needs a non-empty objective.'
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) return 'harness_plan needs at least one task.'

  const tasks: PlanTaskInput[] = []
  for (const raw of input.tasks.slice(0, MAX_TASKS)) {
    if (!isRecord(raw) || typeof raw.title !== 'string' || raw.title.trim().length === 0) {
      return 'every task needs a title.'
    }
    tasks.push({
      title: raw.title.trim(),
      deps: stringList(raw.deps),
      paths: stringList(raw.paths),
      checks: stringList(raw.checks),
      role: typeof raw.role === 'string' ? raw.role : undefined,
    })
  }
  return { objective, tasks }
}


async function attempt(label: string, $: EngineInterface, work: () => Promise<unknown>): Promise<void> {
  try {
    await work()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    $.ui.log(`harness: ${label} failed: ${message.slice(0, 160)}`, { to: 'debug' })
  }
}

async function storeKey($: EngineInterface, cwd: string): Promise<string> {
  return `state:${await $.session.id()}:${cwd}`
}

const runPort =
  ($: EngineInterface): RunPort =>
  (argv, init) =>
    $.process.run(argv, init)

const launchPorts = ($: EngineInterface): LaunchPorts => ({
  spawn: args => $.agent.spawn(args),
  register: spec => $.agent.register(spec),
  run: (argv, init) => $.process.run(argv, init),
})

async function save($: EngineInterface, cwd: string): Promise<void> {
  try {
    const key = await storeKey($, cwd)
    const plan = await read($, planAtom)
    if (plan === null) {
      await $.store.delete(key)
      return
    }
    const saved: SavedState = {
      plan,
      workers: await read($, workersAtom),
      needsYou: await read($, needsYouAtom),
    }
    await $.store.set(key, saved)
  } catch {
    return
  }
}

async function load($: EngineInterface, cwd: string): Promise<SavedState | null> {
  try {
    return parseSaved(await $.store.get(await storeKey($, cwd)))
  } catch {
    return null
  }
}

async function patchTask(
  $: EngineInterface,
  id: string,
  change: (task: HarnessTask) => HarnessTask,
): Promise<void> {
  await update($, planAtom, plan =>
    plan === null
      ? plan
      : { ...plan, tasks: plan.tasks.map(task => (task.id === id ? change(task) : task)) },
  )
}

async function claimTask(
  $: EngineInterface,
  id: string,
  can: (task: HarnessTask) => boolean,
  change: (task: HarnessTask) => HarnessTask,
): Promise<boolean> {
  let claimed = false
  await update($, planAtom, plan => {
    claimed = false
    if (plan === null) return plan
    return {
      ...plan,
      tasks: plan.tasks.map(task => {
        if (task.id !== id || !can(task)) return task
        claimed = true
        return change(task)
      }),
    }
  })
  return claimed
}

async function setWorker($: EngineInterface, row: HarnessWorkerRow): Promise<void> {
  await update($, workersAtom, workers => ({ ...workers, [row.agentId]: row }))
}

async function dropWorker($: EngineInterface, agentId: string): Promise<void> {
  await update($, workersAtom, workers => {
    const { [agentId]: _gone, ...rest } = workers
    return rest
  })
}

async function addAsk($: EngineInterface, ask: HarnessHumanAsk): Promise<void> {
  await update($, needsYouAtom, asks => [...asks.filter(one => one.taskId !== ask.taskId), ask])
}

async function clearAsks($: EngineInterface, taskId: string): Promise<void> {
  await update($, needsYouAtom, asks => asks.filter(one => one.taskId !== taskId))
}

async function setReview($: EngineInterface, review: HarnessReview | null): Promise<void> {
  await update($, reviewAtom, () => review)
}

async function setStale($: EngineInterface, note: string | null): Promise<void> {
  await update($, staleAtom, () => note !== null)
  await update($, staleNoteAtom, () => note)
}

function phase(review: HarnessReview | null): ReviewPhase {
  return review === null ? null : { isOk: review.ok, status: review.status, isTimedOut: review.isTimedOut === true }
}

type RunContext = {
  cwd: string
  maxWorkers: number
  gate: Gate
  taskId?: string
}

type StartResult = { text: string; started: boolean }

async function startTask(
  $: EngineInterface,
  plan: HarnessPlan,
  task: HarnessTask,
  ctx: RunContext,
  now: number,
): Promise<StartResult> {
  const kind = kindOf(task)
  if (kind === null) return { text: `${task.id} has no worker role.`, started: false }

  const target = resolveLaunch(plan, task, kind)
  if (!target.ok) return { text: `${task.id} not started: ${target.reason}.`, started: false }

  const claimed = await claimTask(
    $,
    task.id,
    current => RESTARTABLE.includes(current.state),
    current => ({
      ...current,
      state: 'running',
      startedAt: now,
      endedAt: undefined,
      verdict: undefined,
      note: undefined,
      agentId: undefined,
      reviewAgentId: undefined,
      reviewStarting: undefined,
      lastTool: undefined,
      toolCount: 0,
    }),
  )

  if (!claimed) {
    const live = (await read($, planAtom))?.tasks.find(one => one.id === task.id)
    const agent = live?.agentId === undefined ? '' : ` as agent ${live.agentId}`
    return { text: `${task.id} already ${live?.state ?? 'claimed'}${agent}.`, started: false }
  }

  await clearAsks($, task.id)
  const fresh = (await read($, planAtom)) ?? plan
  const current = fresh.tasks.find(one => one.id === task.id) ?? task
  const outcome = await launchAgent(launchPorts($), ctx.gate, fresh, current, kind, ctx.cwd)

  if (!outcome.ok) {
    await patchTask($, task.id, current => ({
      ...current,
      state: 'failed',
      endedAt: now,
      note: `spawn refused: ${outcome.reason}`,
    }))
    $.ui.toast(`harness: could not start "${fit(task.title, 40)}"`)
    return { text: `${task.id} not started: ${outcome.reason}.`, started: false }
  }

  await patchTask($, task.id, current => ({ ...current, agentId: outcome.agentId }))
  await setWorker($, {
    taskId: task.id,
    agentId: outcome.agentId,
    role: task.role,
    writes: task.writes,
    model: task.model,
    lastTool: null,
    toolCount: 0,
    startedAt: now,
  })
  return { text: `${task.id} started as ${kind} agent ${outcome.agentId}.`, started: true }
}

async function startReviewer(
  $: EngineInterface,
  gate: Gate,
  plan: HarnessPlan,
  task: HarnessTask,
  cwd: string,
  now: number,
): Promise<string> {
  const target = resolveLaunch(plan, task, 'reviewer')
  if (!target.ok) {
    await patchTask($, task.id, current => ({ ...current, note: `reviewer not started: ${target.reason}` }))
    $.ui.toast(`harness: reviewer for "${fit(task.title, 40)}" did not start`)
    return `${task.id} reviewer not started: ${target.reason}.`
  }

  const claimed = await claimTask(
    $,
    task.id,
    current =>
      current.state === 'review' && current.reviewAgentId === undefined && current.reviewStarting !== true,
    current => ({ ...current, reviewStarting: true }),
  )
  if (!claimed) return `${task.id} review is already starting or running.`

  const live = (await read($, planAtom)) ?? plan
  const current = live.tasks.find(one => one.id === task.id) ?? task
  const outcome = await launchAgent(launchPorts($), gate, live, current, 'reviewer', cwd, current.report)

  if (!outcome.ok) {
    await patchTask($, task.id, one => ({
      ...one,
      reviewStarting: undefined,
      note: `reviewer not started: ${outcome.reason}`,
    }))
    $.ui.toast(`harness: reviewer for "${fit(task.title, 40)}" did not start`)
    return `${task.id} reviewer not started: ${outcome.reason}.`
  }

  await patchTask($, task.id, one => ({
    ...one,
    reviewAgentId: outcome.agentId,
    reviewStarting: undefined,
    note: undefined,
  }))
  await setWorker($, {
    taskId: task.id,
    agentId: outcome.agentId,
    role: 'reviewer',
    writes: false,
    model: task.reviewModel,
    lastTool: null,
    toolCount: 0,
    startedAt: now,
  })
  return `${task.id} review started as reviewer agent ${outcome.agentId}.`
}

async function rerunReview(
  $: EngineInterface,
  plan: HarnessPlan,
  task: HarnessTask,
  ctx: RunContext,
  now: number,
): Promise<string> {
  const moved = await claimTask(
    $,
    task.id,
    current => current.state === 'needs_you' && current.reviewAgentId !== undefined,
    current => ({
      ...current,
      state: 'review',
      note: undefined,
      verdict: undefined,
      endedAt: undefined,
      reviewAgentId: undefined,
      reviewStarting: undefined,
    }),
  )
  if (!moved) return `${task.id} is no longer waiting on a review answer.`

  await clearAsks($, task.id)
  const fresh = (await read($, planAtom)) ?? plan
  const current = fresh.tasks.find(one => one.id === task.id) ?? task
  return startReviewer($, ctx.gate, fresh, current, ctx.cwd, now)
}

async function runTasks($: EngineInterface, ctx: RunContext): Promise<string> {
  const plan = await read($, planAtom)
  if (plan === null) return 'No plan yet. Call harness_plan first.'

  const now = await $.clock.now()
  const lines: string[] = []

  if (ctx.taskId !== undefined) {
    const task = findTask(plan, ctx.taskId)
    if (task === undefined) return `Unknown task ${ctx.taskId}.`

    if (task.role === 'advisor') {
      if (task.state === 'done') return `${task.id} already done.`
      await patchTask($, task.id, current => ({ ...current, state: 'done', endedAt: now }))
      return `${task.id} stays with the advisor session and is now marked done.`
    }
    if (task.state === 'running' && task.agentId !== undefined) {
      return `${task.id} already running as agent ${task.agentId}.`
    }
    if (task.state === 'review' && task.reviewAgentId !== undefined) {
      return `${task.id} already in review as agent ${task.reviewAgentId}.`
    }
    if (task.state === 'needs_you' && task.reviewAgentId !== undefined) {
      return rerunReview($, plan, task, ctx, now)
    }
    if (task.state === 'review') return startReviewer($, ctx.gate, plan, task, ctx.cwd, now)
    if (task.state === 'approved') {
      return `${task.id} is approved by the reviewer and waits for the harness review (Refresh review in the pane).`
    }
    if (task.state === 'verified' || task.state === 'done') return `${task.id} already ${task.state}.`
    if (task.state === 'running') return `${task.id} is starting.`

    const open = new Set(plan.tasks.filter(isUnblocking).map(one => one.id))
    const waiting = task.deps.filter(dep => !open.has(dep))
    if (waiting.length > 0) return `${task.id} waits for ${waiting.join(', ')}.`

    const busy = plan.tasks.filter(one => one.state === 'running').length
    if (busy >= ctx.maxWorkers) return `Worker limit ${ctx.maxWorkers} reached.`

    return (await startTask($, plan, task, ctx, now)).text
  }

  const pending = plan.tasks.filter(task => task.state === 'review' && task.reviewAgentId === undefined)
  for (const task of pending) lines.push(await startReviewer($, ctx.gate, plan, task, ctx.cwd, now))

  const busy = plan.tasks.filter(task => task.state === 'running').length
  const slots = Math.max(0, ctx.maxWorkers - busy)
  let started = 0
  for (const task of readyTasks(plan)) {
    if (started >= slots) break
    const result = await startTask($, plan, task, ctx, now)
    lines.push(result.text)
    if (result.started) started += 1
  }

  if (lines.length > 0) return lines.join('\n')
  if (slots === 0) return `Worker limit ${ctx.maxWorkers} reached; nothing started.`
  const waiting = plan.tasks.filter(task => task.state === 'proposed').length
  return `Nothing ready to start (${waiting} proposed task${waiting === 1 ? '' : 's'} waiting on dependencies).`
}

type TurnOutcome = {
  toast: string | null
  allVerified: boolean
}

async function onWorkerTurnComplete(
  $: EngineInterface,
  gate: Gate,
  turn: { agentId: string; answer: string; reason: string },
  cwd: string,
): Promise<TurnOutcome> {
  const idle: TurnOutcome = { toast: null, allVerified: false }
  const plan = await read($, planAtom)
  if (plan === null) return idle

  const task = plan.tasks.find(one => one.agentId === turn.agentId || one.reviewAgentId === turn.agentId)
  if (task === undefined) return idle

  const now = await $.clock.now()
  const isReview = task.reviewAgentId === turn.agentId && task.state === 'review'
  const isWork = task.agentId === turn.agentId && task.state === 'running'
  if (!isReview && !isWork) return idle

  const move = isReview ? decideReviewTurn(task, turn) : decideWorkerTurn(task, turn)
  const moved = await claimTask(
    $,
    task.id,
    current => current.state === (isReview ? 'review' : 'running'),
    current => ({
      ...current,
      state: move.state,
      note: move.note,
      verdict: move.verdict ?? current.verdict,
      report: move.report ?? current.report,
      reviewReport: isReview ? move.reviewReport : current.reviewReport,
      endedAt: move.isEnded ? now : undefined,
      reviewStarting: undefined,
    }),
  )
  if (!moved) return idle

  await dropWorker($, turn.agentId)

  if (move.question !== undefined) {
    await addAsk($, { id: `${task.id}:ask`, taskId: task.id, question: move.question, at: now })
  }

  if (move.startReview) {
    const fresh = await read($, planAtom)
    const current = fresh?.tasks.find(one => one.id === task.id) ?? task
    await startReviewer($, gate, fresh ?? plan, current, cwd, now)
  }

  const after = await read($, planAtom)
  return { toast: move.toast ?? null, allVerified: after !== null && isAllVerified(after) }
}

async function noteToolCall($: EngineInterface, agentId: string, summary: string): Promise<void> {
  const row = (await read($, workersAtom))[agentId]
  if (row === undefined) return

  await update($, workersAtom, workers => {
    const live = workers[agentId]
    return live === undefined
      ? workers
      : { ...workers, [agentId]: { ...live, lastTool: summary, toolCount: live.toolCount + 1 } }
  })
  await patchTask($, row.taskId, task =>
    task.agentId === agentId || task.reviewAgentId === agentId
      ? { ...task, lastTool: summary, toolCount: task.toolCount + 1 }
      : task,
  )
}

async function reconcile($: EngineInterface, cwd: string): Promise<void> {
  const live = await read($, planAtom)
  const saved = live === null ? await load($, cwd) : null
  const plan = live ?? saved?.plan ?? null
  if (plan === null) return

  const asks = saved?.needsYou ?? (await read($, needsYouAtom))
  const workers = saved?.workers ?? (await read($, workersAtom))

  let listed: { id: string; status: string }[] = []
  let listFailed = false
  try {
    listed = (await $.agent.list()).map(one => ({ id: one.id, status: one.status }))
  } catch {
    listFailed = true
  }

  if (listFailed) {
    await update($, planAtom, () => plan)
    await update($, workersAtom, () => workers)
    await update($, needsYouAtom, () => asks)
    await setStale($, `${STALE_LIST_NOTE}: worker states were kept as saved and are not verified`)
    return
  }

  const status = new Map(listed.map(one => [one.id, one.status]))
  const active = (id: string | undefined): boolean => {
    const found = id === undefined ? undefined : status.get(id)
    return found !== undefined && ACTIVE_STATUS.includes(found)
  }
  const completed = (id: string | undefined): boolean => id !== undefined && status.get(id) === 'completed'
  const now = await $.clock.now()
  const added: HarnessHumanAsk[] = []

  const tasks: HarnessTask[] = plan.tasks.map(task => {
    if (task.state === 'running' && !active(task.agentId)) {
      if (completed(task.agentId)) {
        const note = 'worker finished while the mod was not listening; check its result'
        added.push({ id: `${task.id}:ask`, taskId: task.id, question: `${task.title}: ${note}`, at: now })
        return { ...task, state: 'needs_you', note }
      }
      return {
        ...task,
        state: 'proposed',
        agentId: undefined,
        startedAt: undefined,
        lastTool: undefined,
        toolCount: 0,
      }
    }
    if (task.state === 'review' && !active(task.reviewAgentId)) {
      if (completed(task.reviewAgentId)) {
        const note = 'reviewer finished while the mod was not listening; check its verdict'
        added.push({ id: `${task.id}:ask`, taskId: task.id, question: `${task.title}: ${note}`, at: now })
        return { ...task, state: 'needs_you', note, reviewStarting: undefined }
      }
      return { ...task, reviewAgentId: undefined, reviewStarting: undefined }
    }
    return task
  })

  const restored: HarnessPlan = { ...plan, tasks }
  const kept = Object.fromEntries(Object.entries(workers).filter(([id]) => active(id)))

  await update($, planAtom, () => restored)
  await update($, workersAtom, () => kept)
  await update($, needsYouAtom, () => [...asks, ...added])
  if (isAllVerified(restored)) await update($, isHiddenAtom, () => true)
  const staleNote = await read($, staleNoteAtom)
  if (typeof staleNote === 'string' && staleNote.startsWith(STALE_LIST_NOTE)) await setStale($, null)
}

async function registerAtStart(
  $: EngineInterface,
  options: PluginOptions,
  gate: Gate,
  cwd: string,
): Promise<void> {
  const models = await runModels(runPort($), cliConfig(options, cwd))
  if (!models.ok) {
    $.ui.log(`harness: agent types not registered at start: ${models.reason}`, { to: 'debug' })
    return
  }
  await registerKinds(launchPorts($), gate, models.value)
}

async function createPlan(
  $: EngineInterface,
  options: PluginOptions,
  input: { objective: string; tasks: PlanTaskInput[] },
): Promise<string> {
  const cwd = await $.session.cwd()
  const model = await $.session.model()
  const config = cliConfig(options, cwd)
  const failures: string[] = []

  const models = await runModels(runPort($), config)
  if (!models.ok) failures.push(models.reason)

  const triages: (TriageResult | null)[] = await Promise.all(
    input.tasks.map(async task => {
      const triage = await runTriage(runPort($), config, task.title)
      if (triage.ok) return triage.value
      failures.push(triage.reason)
      return null
    }),
  )

  const plan = buildPlan(input.objective, input.tasks, triages, models.ok ? models.value : null, model)
  const missing = missingRoles(plan)
  if (models.ok && missing.length > 0) {
    failures.push(`herdr-jev models list has no model for ${missing.join(', ')}; those roles are not spawned`)
  }

  const note = failures.length === 0 ? null : [...new Set(failures)].join('; ')

  await update($, planAtom, () => plan)
  await update($, workersAtom, () => ({}))
  await update($, needsYouAtom, () => [])
  await setStale($, note)
  await update($, isHiddenAtom, () => false)
  await update($, advisorModelAtom, () => model)
  await setReview($, null)
  await save($, cwd)

  return `${summarize(plan)}${note === null ? '' : `\nHerdr-Jev notes (plan marked stale): ${note}`}`
}

async function statusText($: EngineInterface): Promise<string> {
  const plan = await read($, planAtom)
  if (plan === null) return 'No harness plan. Call harness_plan with an objective and tasks.'

  const workers = Object.values(await read($, workersAtom))
  const asks = await read($, needsYouAtom)
  const review = await read($, reviewAtom)
  const isRunning = await read($, isReviewRunningAtom)
  const stale = await read($, staleAtom)
  const note = await read($, staleNoteAtom)
  const counts = countTasks(plan)
  const lines = [summarize(plan)]

  if (workers.length > 0) {
    lines.push('Workers:')
    for (const row of workers) {
      lines.push(`- ${row.role}${row.writes ? ' (writes)' : ''} ${row.agentId} on ${row.taskId}: ${row.lastTool ?? 'starting'} (${row.toolCount} tool calls)`)
    }
  }
  for (const ask of asks) lines.push(`Needs you: ${ask.question}`)
  if (counts.approved > 0) {
    lines.push(`${counts.approved} approved, ${reviewPhrase(isRunning, phase(review))}.`)
  } else if (isRunning) {
    lines.push('Harness review running.')
  }
  if (review !== null) {
    lines.push(
      review.ok
        ? `Last herdr-jev review: ${review.status ?? 'unknown'}${review.detail === null ? '' : ` (${review.detail})`}`
        : `Last herdr-jev review ${review.isTimedOut === true ? 'timed out' : 'failed'}: ${review.reason ?? 'unknown'}`,
    )
  }
  if (stale) lines.push(`Plan data is stale${note === null ? '' : `: ${note}`}.`)
  if (!/fable/i.test(plan.advisorModel)) {
    lines.push(`Advisor model is ${plan.advisorModel.length > 0 ? plan.advisorModel : 'unknown'}, expected Fable.`)
  }
  return lines.join('\n')
}

async function hideWhenVerified($: EngineInterface): Promise<void> {
  const plan = await read($, planAtom)
  if (plan !== null && isAllVerified(plan)) await update($, isHiddenAtom, () => true)
}

function scheduleHide($: EngineInterface): void {
  $.clock.after(HIDE_AFTER_MS, () => {
    void attempt('auto hide', $, () => hideWhenVerified($))
  })
}

async function refreshReview($: EngineInterface, options: PluginOptions, cwd: string): Promise<string> {
  let claimed = false
  await update($, isReviewRunningAtom, running => {
    claimed = !running
    return true
  })
  if (!claimed) return 'harness review is already running.'

  try {
    const before = await read($, planAtom)
    const approved = (before?.tasks ?? []).filter(task => task.state === 'approved').map(task => task.id)
    const ran = await runReview(runPort($), cliConfig(options, cwd))
    const at = await $.clock.now()

    if (!ran.ok) {
      await setReview($, { ok: false, status: null, detail: null, reason: ran.reason, isTimedOut: ran.timedOut === true, at })
      return ran.timedOut === true ? `harness review timed out: ${ran.reason}.` : `harness review failed: ${ran.reason}.`
    }

    const { status, detail, error } = ran.value
    await setReview($, { ok: true, status, detail, reason: error, at })
    if (status !== 'ready') return `harness review ${status ?? 'unknown'}; approved tasks stay approved.`

    let verified = 0
    for (const id of approved) {
      const moved = await claimTask(
        $,
        id,
        task => task.state === 'approved',
        task => ({ ...task, state: 'verified', endedAt: at }),
      )
      if (moved) verified += 1
    }
    await save($, cwd)
    const after = await read($, planAtom)
    if (after !== null && isAllVerified(after)) scheduleHide($)
    return `harness review ready; ${verified} task${verified === 1 ? '' : 's'} verified.`
  } finally {
    await update($, isReviewRunningAtom, () => false)
  }
}

export const register: Register = (on, options) => {
  const gate = createGate()

  on('session.start', async ($, e, next) => {
    await attempt('register command', $, () =>
      $.command.register({
        name: 'harness',
        description: 'Show the Herdr-Jev harness plan and workers in a pane',
      }),
    )
    await attempt('register harness_plan', $, () =>
      $.tool.register({
        name: 'harness_plan',
        description:
          'Plan an objective as bounded tasks. Herdr-Jev assigns each task a role and the models come from herdr-jev models list (reader or mechanic for small work, implementer for code, advisor for architectural work); implementer and mechanic tasks get an independent review by the reviewer from Herdr-Jev. Returns the plan with stable task ids. Main session only.',
        inputSchema: PLAN_SCHEMA,
      }),
    )
    await attempt('register harness_run', $, () =>
      $.tool.register({
        name: 'harness_run',
        description:
          'Start harness workers as background subagents. With taskId, run that task (an advisor task is marked done instead). Without it, run every proposed task whose dependencies are done, up to the worker limit. Safe to call twice: a running task returns its existing agent id. Main session only.',
        inputSchema: RUN_SCHEMA,
      }),
    )
    await attempt('register harness_status', $, () =>
      $.tool.register({
        name: 'harness_status',
        description: 'Text summary of the harness plan, workers, open questions and last review.',
        inputSchema: { type: 'object', properties: {} },
      }),
    )

    await attempt('read session model', $, async () => {
      const model = await $.session.model()
      await update($, advisorModelAtom, () => model)
    })
    await attempt('restore plan', $, () => reconcile($, e.cwd))

    const chained = next(e)
    void chained.then(
      () => attempt('register agent types', $, () => registerAtStart($, options, gate, e.cwd)),
      () => undefined,
    )
    return chained
  })

  on('agent.offer', { agent: 'harness:implementer' }, () => ({ isOffered: false })).catch(($, e, next) =>
    next.called ? next(e) : { isOffered: false },
  )
  on('agent.offer', { agent: 'harness:reviewer' }, () => ({ isOffered: false })).catch(($, e, next) =>
    next.called ? next(e) : { isOffered: false },
  )
  on('agent.offer', { agent: 'harness:reader' }, () => ({ isOffered: false })).catch(($, e, next) =>
    next.called ? next(e) : { isOffered: false },
  )
  on('agent.offer', { agent: 'harness:mechanic' }, () => ({ isOffered: false })).catch(($, e, next) =>
    next.called ? next(e) : { isOffered: false },
  )

  on('command.run', { command: 'harness' }, async $ => {
    await update($, isHiddenAtom, () => false)
    await $.ui.open({ id: PANE_ID, title: 'Harness', closeOnEscape: true })
    const plan = await read($, planAtom)
    return {
      text:
        plan === null
          ? 'Harness pane opened. No plan yet: the advisor starts one with harness_plan.'
          : 'Harness pane opened.',
    }
  })

  on('tool.call', { tool: TOOL_PLAN }, async ($, e) => {
    if (e.agentId !== undefined) return { result: 'harness_plan: only the main session may call it.' }
    const parsed = parsePlanInput(e)
    if (typeof parsed === 'string') return { result: `harness_plan: ${parsed}` }
    const busy = Object.keys(await read($, workersAtom)).length
    if (busy > 0) {
      return { result: `harness_plan: ${busy} worker${busy === 1 ? ' is' : 's are'} still running; wait for them before replacing the plan.` }
    }
    return { result: await createPlan($, options, parsed) }
  }).catch(($, e, next) => (next.called ? next(e) : { result: 'harness_plan: failed, see the debug log.' }))

  on('tool.call', { tool: TOOL_RUN }, async ($, e) => {
    if (e.agentId !== undefined) return { result: 'harness_run: only the main session may call it.' }
    const cwd = await $.session.cwd()
    const taskId = typeof e.taskId === 'string' && e.taskId.trim().length > 0 ? e.taskId.trim() : undefined
    const text = await runTasks($, { cwd, maxWorkers: maxWorkers(options), gate, taskId })
    await save($, cwd)
    return { result: text }
  }).catch(($, e, next) => (next.called ? next(e) : { result: 'harness_run: failed, see the debug log.' }))

  on('tool.call', { tool: TOOL_STATUS }, async $ => ({ result: await statusText($) })).catch(($, e, next) =>
    next.called ? next(e) : { result: 'harness_status: failed, see the debug log.' },
  )

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const agentId = e.agentId
      await attempt('note tool call', $, () =>
        noteToolCall($, agentId, describeTool(String(e.tool), e as unknown as Record<string, unknown>)),
      )
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const agentId = e.agentId
      await attempt('turn complete', $, async () => {
        const cwd = await $.session.cwd()
        const outcome = await onWorkerTurnComplete($, gate, { agentId, answer: e.answer, reason: e.reason }, cwd)
        if (outcome.toast !== null) $.ui.toast(outcome.toast, { timeoutMs: 8000 })
        await save($, cwd)
        if (outcome.allVerified) scheduleHide($)
      })
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const plan = await read($, planAtom)
    const isHidden = await read($, isHiddenAtom)
    if (e.props.hasSurvey || plan === null || isHidden) return next(e)

    const advisor = await read($, advisorModelAtom)
    const asks = await read($, needsYouAtom)
    const isReviewing = await read($, isReviewRunningAtom)
    const cwd = await $.session.cwd()
    const { Box, Button, Text } = $.ui.resolve(e)

    const counts = countTasks(plan)
    const active = plan.tasks.find(task => task.state === 'running') ?? plan.tasks.find(task => task.state === 'review')
    const failed = plan.tasks.find(task => task.state === 'failed')
    const needs = Math.max(asks.length, counts.needsYou)
    const verified = isAllVerified(plan)
    const warn = /fable/i.test(advisor) || advisor.length === 0 ? null : `advisor model is ${shortModel(advisor)}, expected Fable`

    const head = `harness · ${fit(baseName(cwd), 16)}`
    const progress = `${counts.settled}/${counts.total} ${bar(counts.settled, counts.total)}`
    const askText = needs > 0 ? `? ${needs} needs you` : null
    const failText = failed === undefined ? null : `✗ ${fit(failed.title, 24)}`
    const warnText = warn === null ? null : fit(warn, 48)
    const lastReview = await read($, reviewAtom)
    const reviewText =
      counts.approved > 0
        ? `${counts.approved} approved, ${reviewPhrase(isReviewing, phase(lastReview))}`
        : isReviewing
          ? 'review running'
          : null

    const fixed =
      head.length +
      progress.length +
      (askText?.length ?? 0) +
      (failText?.length ?? 0) +
      (warnText?.length ?? 0) +
      (reviewText?.length ?? 0) +
      30
    const room = Math.max(10, e.props.bodyColumns - fixed)

    let running = ''
    if (!verified && active !== undefined) {
      const label = `${active.role}${active.writes ? '*' : ''}/${shortModel(active.state === 'review' ? active.reviewModel : active.model)}`
      running = `● ${fit(active.title, Math.max(6, room - label.length - 3))} · ${label}`
    }

    return (
      <Box flexDirection="row" gap={1}>
        <Text wrap="truncate">{[head, running, progress].filter(part => part.length > 0).join(' · ')}</Text>
        {reviewText !== null && <Text color="warning">{`· ${reviewText}`}</Text>}
        {askText !== null && <Text color="warning">{`· ${askText}`}</Text>}
        {failText !== null && <Text color="error">{`· ${failText}`}</Text>}
        {verified && <Text color="success">· all verified</Text>}
        {warnText !== null && <Text dimColor>{`· ${warnText}`}</Text>}
        <Button
          key="plan"
          label="Plan"
          onPress={async () => {
            await $.ui.open({ id: PANE_ID, title: 'Harness', closeOnEscape: true })
          }}
        />
        <Button key="hide" label="Hide" onPress={() => update($, isHiddenAtom, () => true)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const columns = Math.max(24, e.props.bodyColumns)
    const plan = await read($, planAtom)
    const advisor = await read($, advisorModelAtom)
    const workers = Object.values(await read($, workersAtom))
    const asks = await read($, needsYouAtom)
    const review = await read($, reviewAtom)
    const isReviewing = await read($, isReviewRunningAtom)
    const stale = await read($, staleAtom)
    const staleNote = await read($, staleNoteAtom)
    const now = await $.clock.now()
    const cwd = await $.session.cwd()

    const advisorLine = `Advisor: ${advisor.length > 0 ? advisor : 'unknown'}`
    const mismatch = advisor.length > 0 && !/fable/i.test(advisor)

    const onRun = async () => {
      await attempt('run next', $, async () => {
        const text = await runTasks($, { cwd, maxWorkers: maxWorkers(options), gate })
        await save($, cwd)
        $.ui.toast(fit(text.split('\n')[0] ?? text, 100))
      })
    }

    const onRefresh = async () => {
      await attempt('refresh review', $, async () => {
        const text = await refreshReview($, options, cwd)
        $.ui.toast(fit(text, 100))
      })
    }

    const buttons = (
      <Box flexDirection="row" gap={1}>
        <Button key="run-next" label="Run next" variant="primary" onPress={onRun} />
        <Button key="refresh-review" label="Refresh review" onPress={onRefresh} />
      </Box>
    )

    if (plan === null) {
      return (
        <Box flexDirection="column">
          <Text bold>Harness</Text>
          <Text dimColor wrap="truncate">{fit(advisorLine, columns)}</Text>
          <Text dimColor>No plan yet. The advisor starts one with harness_plan.</Text>
          {buttons}
        </Box>
      )
    }

    const counts = countTasks(plan)
    const titleRoom = Math.max(10, columns - 44)
    const titleOf = (id: string): string => fit(plan.tasks.find(task => task.id === id)?.title ?? id, 30)

    let reviewLine: string | null = null
    if (isReviewing) reviewLine = 'Review: running'
    else if (review !== null) {
      reviewLine = review.ok
        ? `Review: ${review.status ?? 'unknown'}${review.detail === null ? '' : ` · ${review.detail}`}`
        : review.isTimedOut === true
          ? `Review timed out: ${review.reason ?? 'unknown'}`
          : `Review refresh failed: ${review.reason ?? 'unknown'}`
    }

    return (
      <Box flexDirection="column">
        <Text bold wrap="truncate">{`Harness · ${fit(plan.objective, Math.max(10, columns - 10))}`}</Text>
        <Text dimColor={!mismatch} color={mismatch ? 'warning' : undefined} wrap="truncate">
          {fit(mismatch ? `${advisorLine} (expected Fable)` : advisorLine, columns)}
        </Text>
        {stale && (
          <Text dimColor wrap="truncate">
            {fit(`Herdr-Jev data is stale${staleNote === null ? '.' : `: ${staleNote}`}`, columns)}
          </Text>
        )}
        <Text bold>Tasks</Text>
        {plan.tasks.map(task => {
          const deps = task.deps.length === 0 ? 'no deps' : `after ${task.deps.map(titleOf).join(', ')}`
          return (
            <Box key={`row-${task.id}`} flexDirection="column">
              <Text wrap="truncate">
                {`${STATE_GLYPH[task.state]} ${task.id} ${fit(task.title, titleRoom)} ${roleLabel(task.role, task.model, task.effort, task.writes)}`}
              </Text>
              <Text dimColor wrap="truncate">{`  ${fit(`${task.state} · ${deps} · ${task.reason}`, Math.max(10, columns - 2))}`}</Text>
            </Box>
          )
        })}
        <Text bold>Workers</Text>
        {workers.length === 0 && <Text dimColor>No workers running.</Text>}
        {workers.map(row => (
          <Text key={`worker-${row.agentId}`} wrap="truncate">
            {fit(
              `${titleOf(row.taskId)} · ${row.role}/${shortModel(row.model)}${row.writes ? ' writes' : ''} · ${row.lastTool ?? 'starting'} · ${Math.max(0, Math.round((now - row.startedAt) / 1000))}s`,
              columns,
            )}
          </Text>
        ))}
        <Text bold>Needs you</Text>
        {asks.length === 0 && <Text dimColor>Nothing waiting on you.</Text>}
        {asks.map(ask => (
          <Text key={`ask-${ask.id}`} color="warning" wrap="truncate">
            {fit(`? ${titleOf(ask.taskId)}: ${ask.question}`, columns)}
          </Text>
        ))}
        {counts.approved > 0 && (
          <Text color="warning" wrap="truncate">
            {fit(`${counts.approved} approved, ${reviewPhrase(isReviewing, phase(review))}`, columns)}
          </Text>
        )}
        {reviewLine !== null && <Text dimColor wrap="truncate">{fit(reviewLine, columns)}</Text>}
        {buttons}
      </Box>
    )
  })
}
