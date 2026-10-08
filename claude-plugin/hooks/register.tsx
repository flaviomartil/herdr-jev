import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, PluginOptions, Register } from 'claude-code'

import type {
  ScopeState,
  HarnessHumanAsk,
  HarnessPlan,
  HarnessReview,
  HarnessTask,
  HarnessWorkerRow,
} from '../types'
import { autoReview, autoRun, cliConfig, maxWorkers, runModels, runReview, runTriage } from './cli'
import type { RunPort } from './cli'
import {
  approvedKey,
  baseName,
  bandState,
  barParts,
  claudeEffort,
  buildPlan,
  countTasks,
  describeTool,
  duration,
  effortLabel,
  findTask,
  fit,
  isAllVerified,
  isRecord,
  isSettled,
  isUnblocking,
  kindOf,
  missingRoles,
  parseSaved,
  percent,
  readyTasks,
  reviewPhrase,
  ROW_MARK,
  shortModel,
  summarize,
} from './plan'
import { registerPrGate } from './pr-gate'
import { mergeReviewIds, reviewIdsKey } from './review-run'
import type { ReviewIds } from './review-run'
import type { Hue, PlanTaskInput, ReviewPhase, SavedState, TriageResult } from './plan'
import {
  agentReason,
  DEFAULT_AGENTS,
  DEFAULT_SKILLS,
  EMPTY_SCOPE,
  filterSkillListing,
  invokedSkill,
  keptRows,
  listOption,
  newReceipt,
  receiptText,
  runbookOption,
  runRoute,
  runSkillSelect,
  scopeHeading,
  scopeMode,
  skillReason,
  withNames,
} from './scope'
import type { Receipt, SkillReason } from './scope'
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
const isExpandedAtom = atom({ plugin: 'harness', key: 'isExpanded' } as const, false)
const foldsAtom = atom({ plugin: 'harness', key: 'folds' } as const, {})
const reviewIdsAtom = atom({ plugin: 'harness', key: 'reviewIds' } as const, {})
const scopeAtom = atom({ plugin: 'harness', key: 'scope' } as const, EMPTY_SCOPE as ScopeState)

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
      state: 'proposed',
      startedAt: undefined,
      endedAt: undefined,
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
  for (const task of readyTasks(plan)) {
    const live = (await read($, planAtom)) ?? plan
    if (live.tasks.filter(one => one.state === 'running').length >= ctx.maxWorkers) break
    lines.push((await startTask($, live, task, ctx, now)).text)
  }

  if (lines.length > 0) return lines.join('\n')
  if (slots === 0) return `Worker limit ${ctx.maxWorkers} reached; nothing started.`
  const waiting = plan.tasks.filter(task => task.state === 'proposed').length
  return `Nothing ready to start (${waiting} proposed task${waiting === 1 ? '' : 's'} waiting on dependencies).`
}

type TurnOutcome = {
  toast: string | null
  allVerified: boolean
  settled: boolean
}

const SETTLING: readonly HarnessTask['state'][] = ['done', 'approved', 'verified', 'failed', 'needs_you']

async function onWorkerTurnComplete(
  $: EngineInterface,
  gate: Gate,
  turn: { agentId: string; answer: string; reason: string },
  cwd: string,
): Promise<TurnOutcome> {
  const idle: TurnOutcome = { toast: null, allVerified: false, settled: false }
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
  return {
    toast: move.toast ?? null,
    allVerified: after !== null && isAllVerified(after),
    settled: SETTLING.includes(move.state),
  }
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

type ScopeRuntime = {
  receipt: Receipt
  pending: Promise<void> | null
  warned: Set<string>
}

function refreshScope(
  $: EngineInterface,
  options: PluginOptions,
  runtime: ScopeRuntime,
  cwd: string,
  query: string,
): Promise<void> {
  if (scopeMode(options) === 'off') return Promise.resolve()
  const work = (async () => {
    const ran = await runSkillSelect(runPort($), cwd, query, runbookOption(options))
    if (ran.ok) {
      await update($, scopeAtom, (state): ScopeState => ({
        ...state,
        status: 'ready',
        selected: ran.value.skills,
        clis: ran.value.clis,
        total: ran.value.total,
        query,
        note: null,
      }))
      return
    }
    await update($, scopeAtom, (state): ScopeState =>
      state.status === 'ready'
        ? { ...state, note: `skill-select refresh failed (${ran.reason}); kept the previous selection` }
        : { ...state, status: 'partial', query, note: `skill-select unavailable (${ran.reason}); no skill is hidden` },
    )
  })()
  runtime.pending = work.then(
    () => undefined,
    () => undefined,
  )
  return runtime.pending
}

async function ownSkills($: EngineInterface): Promise<Map<string, SkillReason> | null> {
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    const list = usage.context.breakdown?.skills?.skillFrontmatter
    if (list === undefined) return null
    const own = new Map<string, SkillReason>()
    for (const one of list) {
      if (one.source === 'projectSettings') own.set(one.name, 'project')
      else if (one.source === 'built-in') own.set(one.name, 'built-in')
    }
    return own
  } catch {
    return null
  }
}

function warnOnce($: EngineInterface, runtime: ScopeRuntime, key: string, text: string): void {
  runtime.receipt.notes = [...runtime.receipt.notes.filter(one => one !== text), text]
  if (runtime.warned.has(key)) return
  runtime.warned.add(key)
  $.ui.log(`scope: ${text}`)
}

async function scopedListing(
  $: EngineInterface,
  options: PluginOptions,
  runtime: ScopeRuntime,
  text: string,
): Promise<string> {
  const mode = scopeMode(options)
  if (mode === 'off') return text
  if (runtime.pending !== null) await runtime.pending

  const state = await read($, scopeAtom)
  if (state.status !== 'ready') {
    warnOnce($, runtime, 'select', 'skill-select unavailable, so the skill listing passed through')
    return text
  }
  const own = await ownSkills($)
  if (own === null) {
    warnOnce($, runtime, 'own', 'could not tell project skills apart, so the skill listing passed through')
    return text
  }

  const always = listOption(options.alwaysAllowSkills, DEFAULT_SKILLS)
  const kept = new Map<string, SkillReason>()
  const hidden = new Set<string>()
  const out = filterSkillListing(text, name => {
    const reason = skillReason(name, { own, always, state })
    if (reason === null) {
      hidden.add(name)
      return mode === 'report'
    }
    kept.set(name, reason)
    return true
  })
  if (out === null) {
    warnOnce($, runtime, 'format', 'the skill listing had an unexpected format, so it passed through')
    return text
  }
  runtime.receipt.skills = kept
  runtime.receipt.hiddenSkills = hidden
  return mode === 'enforce' ? out.text : text
}

async function createPlan(
  $: EngineInterface,
  options: PluginOptions,
  gate: Gate,
  runtime: ScopeRuntime,
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

  const built = buildPlan(input.objective, input.tasks, triages, models.ok ? models.value : null, model)
  const plan = { ...built, at: await $.clock.now() }
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
  await update($, foldsAtom, () => ({}))
  await update($, advisorModelAtom, () => model)
  await setReview($, null)
  await save($, cwd)
  void refreshScope($, options, runtime, cwd, input.objective)

  const head = `${summarize(plan)}${note === null ? '' : `\nHerdr-Jev notes (plan marked stale): ${note}`}`
  if (!autoRun(options)) return head

  const started = await runTasks($, { cwd, maxWorkers: maxWorkers(options), gate })
  await save($, cwd)
  return `${head}\nAuto-run:\n${started}`
}

async function maybeAutoReview(
  $: EngineInterface,
  options: PluginOptions,
  reviewed: Set<string>,
  cwd: string,
): Promise<void> {
  if (!autoReview(options)) return
  const plan = await read($, planAtom)
  const key = plan === null ? null : approvedKey(plan)
  if (key === null || reviewed.has(key)) return
  if (await read($, isReviewRunningAtom)) return

  reviewed.add(key)
  void attempt('auto review', $, async () => {
    const text = await refreshReview($, options, cwd)
    $.ui.toast(fit(text, 100))
  })
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

    const { status, detail, error, identity } = ran.value
    await setReview($, { ok: true, status, detail, reason: error, at })
    if (identity !== null) {
      await update($, reviewIdsAtom, ids =>
        mergeReviewIds(ids as ReviewIds, identity.cwd, { client: identity.client, session: identity.session, at, status }),
      )
      await attempt('store review ids', $, async () => {
        await $.store.set(reviewIdsKey(await $.session.id()), await read($, reviewIdsAtom))
      })
    }
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

const BAR_MIN = 10
const MIN_TITLE = 8
const NBSP = ' '
const BAND_ROWS = 4
const SECTION_ROWS = 8
const MARK_WIDTH = 2
const KEY_WIDTH = 9

type Kit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

type Lead = ReturnType<Kit['Box']> | null

function hueProps(hue: Hue): { color?: string; dimColor?: boolean } {
  if (hue === 'dim') return { dimColor: true }
  if (hue === 'plain') return {}
  return { color: hue }
}

function fillBar(kit: Pick<Kit, 'Box' | 'Text'>, key: string, share: number, hue: Hue) {
  const { Box, Text } = kit
  const sized = Math.max(0, Math.min(100, Math.round(share)))
  return (
    <Box key={key} flexDirection="row" flexGrow={1} flexShrink={1} minWidth={BAR_MIN} overflow="hidden">
      {sized > 0 && (
        <Box key={`${key}-fill`} width={`${sized}%`} flexShrink={0} overflow="hidden">
          <Box width={900} flexShrink={0}>
            <Text {...hueProps(hue)}>{'━'.repeat(300)}</Text>
          </Box>
        </Box>
      )}
      <Box key={`${key}-free`} flexGrow={1} flexShrink={1} overflow="hidden">
        <Box width={900} flexShrink={0}>
          <Text dimColor>{'─'.repeat(300)}</Text>
        </Box>
      </Box>
    </Box>
  )
}

function cover(kit: Pick<Kit, 'Box' | 'Button'>, key: string, onPress: () => void) {
  const { Box, Button } = kit
  return (
    <Box position="absolute" top={0} left={0} right={0} bottom={0} overflow="hidden">
      <Box width={1200} flexShrink={0}>
        <Button key={key} plain label={NBSP.repeat(600)} hover={{ backgroundColor: '#00000000' }} onPress={onPress} />
      </Box>
    </Box>
  )
}

function modelOf(task: HarnessTask): string {
  return shortModel(task.state === 'review' ? task.reviewModel : task.model)
}

function agentMeta(task: HarnessTask): string {
  const role = task.state === 'review' ? 'reviewer' : task.role
  const effort = task.state === 'review' ? null : task.effort
  return `(${role}${task.writes && task.state !== 'review' ? '*' : ''} · ${modelOf(task)}${effort === null ? '' : ` · ${effortLabel(effort)}`})`
}

function sessionMeta(task: HarnessTask): string {
  const role = task.state === 'review' ? 'reviewer' : task.role
  const effort = task.state === 'review' ? null : task.effort
  const level = effort === null ? null : (claudeEffort(effort) ?? effort)
  return [`${role}${task.writes && task.state !== 'review' ? '*' : ''}`, modelOf(task), level]
    .filter((one): one is string => one !== null)
    .join(' · ')
}

function startOf(task: HarnessTask, workers: readonly HarnessWorkerRow[]): number | undefined {
  if (task.state === 'running') return task.startedAt
  if (task.state === 'review') return workers.find(row => row.taskId === task.id)?.startedAt
  return undefined
}

function elapsedOf(task: HarnessTask, workers: readonly HarnessWorkerRow[], now: number): string {
  const started = startOf(task, workers)
  if (started !== undefined) return duration(now - started)
  if (task.startedAt !== undefined && task.endedAt !== undefined) return duration(task.endedAt - task.startedAt)
  return ''
}

function reviewShort(isRunning: boolean, review: HarnessReview | null): string {
  if (isRunning) return 'review running'
  if (review === null) return 'review not run'
  if (!review.ok) return review.isTimedOut === true ? 'review timed out' : 'review failed'
  return `review ${review.status ?? 'unknown'}`
}

function ageText(ms: number): string {
  return ms < 5000 ? 'now' : duration(ms)
}

function agentRow(kit: Kit, task: HarnessTask, workers: readonly HarnessWorkerRow[], now: number, lead: Lead) {
  const { Box, Text } = kit
  const hue = ROW_MARK[task.state].hue
  const spent = elapsedOf(task, workers, now)
  const live = task.state === 'running' || task.state === 'review'
  const tool = live ? (task.lastTool ?? null) : null
  return (
    <Box key={`line-${task.id}`} flexDirection="row" columnGap={1}>
      <Box flexDirection="row" columnGap={1} flexShrink={1}>
        {lead}
        <Text {...hueProps(hue)}>●</Text>
        <Text wrap="truncate-end">{task.title}</Text>
        <Text dimColor wrap="truncate-end">{agentMeta(task)}</Text>
      </Box>
      <Box flexGrow={1} />
      {tool === null ? null : <Text dimColor wrap="truncate-end">{tool}</Text>}
      {tool === null ? null : <Box flexGrow={1} />}
      <Box flexShrink={0}>{spent.length > 0 && <Text dimColor>{spent}</Text>}</Box>
    </Box>
  )
}

function bandNote(word: string, failedTitle: string | null, isReviewing: boolean, review: ReviewPhase): string {
  if (word === 'failed') return failedTitle === null ? 'failed' : `failed: ${failedTitle}`
  if (word === 'needs you') return 'needs you'
  if (word === 'review') return 'review'
  if (word === 'approved') return reviewPhrase(isReviewing, review).replace(/^harness /, '')
  return ''
}

function pctHue(word: string): Hue {
  if (word === 'all verified') return 'success'
  if (word === 'needs you') return 'warning'
  if (word === 'failed') return 'error'
  return 'plain'
}

export const register: Register = (on, options) => {
  const gate = createGate()
  const reviewed = new Set<string>()
  const runtime: ScopeRuntime = { receipt: newReceipt(), pending: null, warned: new Set() }

  registerPrGate(on, options)

  on('session.start', async ($, e, next) => {
    await attempt('register command', $, () =>
      $.command.register({
        name: 'harness',
        description: 'Show the Herdr-Jev harness plan and workers in a pane; /harness review runs the harness review',
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
      () => {
        void attempt('scope select', $, () => refreshScope($, options, runtime, e.cwd, `${baseName(e.cwd)} session`))
        return attempt('register agent types', $, () => registerAtStart($, options, gate, e.cwd))
      },
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

  on('command.run', { command: 'harness' }, async ($, e) => {
    if (e.args.trim() === 'scope') {
      const text = receiptText(scopeMode(options), await read($, scopeAtom), runtime.receipt)
      let hasScreen = true
      try {
        hasScreen = (await $.session.surfaces()).length > 0
      } catch {
        hasScreen = true
      }
      if (!hasScreen) return { text }
      $.ui.log(text)
      return {}
    }
    if (e.args.trim() === 'review') {
      return { text: await refreshReview($, options, await $.session.cwd()) }
    }
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

  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear' || e.source === 'resume') {
      runtime.receipt = newReceipt()
      runtime.warned.clear()
      await attempt('scope reset', $, async () => {
        await update($, scopeAtom, () => EMPTY_SCOPE)
        void refreshScope($, options, runtime, e.cwd, `${baseName(e.cwd)} session`)
      })
    }
    return next(e)
  })

  on('prompt.attachment', async ($, e, next) => {
    const r = await next(e)
    if (e.type !== 'skill_listing' || e.origin.kind !== 'engine' || r.text === null) return r
    const text = r.text
    let scoped = text
    await attempt('scope listing', $, async () => {
      scoped = await scopedListing($, options, runtime, text)
    })
    return { ...r, text: scoped }
  })

  on('agent.offer', async ($, e, next) => {
    const mode = scopeMode(options)
    if (mode === 'off') return next(e)
    const reason = agentReason(e.agent, e.source, listOption(options.alwaysAllowAgents, DEFAULT_AGENTS))
    if (reason !== null) {
      runtime.receipt.agents.set(e.agent, reason)
      runtime.receipt.hiddenAgents.delete(e.agent)
      return next(e)
    }
    runtime.receipt.agents.delete(e.agent)
    runtime.receipt.hiddenAgents.add(e.agent)
    return mode === 'enforce' ? { isOffered: false } : next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    if (scopeMode(options) === 'off' || e.origin?.kind === 'plugin') return result
    const text = e.text
    const name = invokedSkill(text)
    if (name !== null) await attempt('scope invoked', $, () => update($, scopeAtom, state => withNames(state, 'invoked', [name])))
    void attempt('scope route-turn', $, async () => {
      const cwd = await $.session.cwd()
      const skill = await runRoute(runPort($), cliConfig(options, cwd).bin, cwd, text)
      if (skill !== null) await update($, scopeAtom, state => withNames(state, 'turn', [skill]))
    })
    return result
  })

  on('tool.call', { tool: TOOL_PLAN }, async ($, e) => {
    if (e.agentId !== undefined) return { result: 'harness_plan: only the main session may call it.' }
    const parsed = parsePlanInput(e)
    if (typeof parsed === 'string') return { result: `harness_plan: ${parsed}` }
    const busy = Object.keys(await read($, workersAtom)).length
    if (busy > 0) {
      return { result: `harness_plan: ${busy} worker${busy === 1 ? ' is' : 's are'} still running; wait for them before replacing the plan.` }
    }
    reviewed.clear()
    return { result: await createPlan($, options, gate, runtime, parsed) }
  }).catch(($, e, next) => (next.called ? next(e) : { result: 'harness_plan: failed, see the debug log.' }))

  on('tool.call', { tool: TOOL_RUN }, async ($, e) => {
    if (e.agentId !== undefined) return { result: 'harness_run: only the main session may call it.' }
    const cwd = await $.session.cwd()
    const taskId = typeof e.taskId === 'string' && e.taskId.trim().length > 0 ? e.taskId.trim() : undefined
    const text = await runTasks($, { cwd, maxWorkers: maxWorkers(options), gate, taskId })
    await save($, cwd)
    await maybeAutoReview($, options, reviewed, cwd)
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
        if (outcome.settled && autoRun(options)) {
          await runTasks($, { cwd, maxWorkers: maxWorkers(options), gate })
        }
        await save($, cwd)
        if (outcome.allVerified) scheduleHide($)
        await maybeAutoReview($, options, reviewed, cwd)
      })
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const plan = await read($, planAtom)
    const isHidden = await read($, isHiddenAtom)
    if (e.props.hasSurvey || plan === null || isHidden) return next(e)

    const asks = await read($, needsYouAtom)
    const isReviewing = await read($, isReviewRunningAtom)
    const lastReview = await read($, reviewAtom)
    const isExpanded = await read($, isExpandedAtom)
    const workers = Object.values(await read($, workersAtom))
    const now = await $.clock.now()
    const { Box, Button, Text } = $.ui.resolve(e)

    const counts = countTasks(plan)
    const state = bandState(plan, asks.length)
    const stats = `${counts.settled}/${counts.total}`
    const share = percent(counts.settled, counts.total)
    const pct = `${share}%`.padStart(4)
    const shown = state.task
    const columns = e.props.bodyColumns
    const isDesktop = e.surface === 'desktop'
    const needsCount = Math.max(asks.length, counts.needsYou)

    const failedTitle = state.failed === undefined || state.failed.id === shown?.id ? null : state.failed.title
    const note = bandNote(state.word, failedTitle, isReviewing, phase(lastReview))
    const elapsed = shown === undefined || state.word === 'all verified' ? '' : elapsedOf(shown, workers, now)
    const title = state.word === 'all verified' ? 'Done' : (shown?.title ?? '')
    const titleWidth = title.length === 0 ? 0 : Math.min(title.length, Math.max(MIN_TITLE, Math.floor(columns * 0.3)))

    const open = plan.tasks.filter(task => !isSettled(task))
    const lines = open.slice(0, BAND_ROWS)
    const hidden = [
      open.length > lines.length ? `+${open.length - lines.length} more` : null,
      counts.settled > 0 ? `${counts.settled} done` : null,
    ].filter((one): one is string => one !== null)
    const toggle = () => update($, isExpandedAtom, current => !current)

    return (
      <Box flexDirection="column" paddingX={1}>
        {isExpanded && (
          <Box flexDirection="column" rowGap={1} paddingX={2} paddingY={1} marginBottom={1} borderStyle="round" borderDimColor>
            <Box flexDirection="column">{lines.map(task => agentRow({ Box, Text, Button }, task, workers, now, null))}</Box>
            {hidden.length > 0 && <Text dimColor>{hidden.join(' · ')}</Text>}
          </Box>
        )}
        <Box flexDirection="row" alignItems="center" columnGap={2}>
          <Box key="line" flexDirection="row" alignItems="center" columnGap={1} flexGrow={1} position="relative">
            <Button key="toggle" plain label={isExpanded ? '▾' : '▸'} onPress={toggle} />
            <Text {...hueProps(state.hue)}>{state.glyph}</Text>
            {titleWidth > 0 && (
              <Box width={titleWidth} flexShrink={0}>
                <Text wrap="truncate-end">{title}</Text>
              </Box>
            )}
            {fillBar({ Box, Text }, 'bar', share, state.hue)}
            <Text>{stats}</Text>
            <Text bold {...hueProps(pctHue(state.word))}>{pct}</Text>
            {note.length > 0 && <Text bold {...hueProps(state.hue)}>{note}</Text>}
            {elapsed.length > 0 && <Text dimColor>{elapsed}</Text>}
            {counts.approved > 0 && <Text dimColor>{`approved ${counts.approved}`}</Text>}
            {isDesktop && cover({ Box, Button }, 'cover', toggle)}
          </Box>
          <Box flexDirection="row" columnGap={1} flexShrink={0}>
            <Button
              key="plan"
              plain
              dimColor
              label="Plan"
              onPress={async () => {
                await $.ui.open({ id: PANE_ID, title: 'Harness', closeOnEscape: true })
              }}
            />
            {needsCount > 0 && <Text bold color="warning">{String(needsCount)}</Text>}
            <Button key="hide" plain dimColor label="×" onPress={() => update($, isHiddenAtom, () => true)} />
          </Box>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const columns = Math.max(40, e.props.bodyColumns)
    const plan = await read($, planAtom)
    const advisor = await read($, advisorModelAtom)
    const workers = Object.values(await read($, workersAtom))
    const asks = await read($, needsYouAtom)
    const review = await read($, reviewAtom)
    const isReviewing = await read($, isReviewRunningAtom)
    const stale = await read($, staleAtom)
    const staleNote = await read($, staleNoteAtom)
    const folds = await read($, foldsAtom)
    const now = await $.clock.now()
    const cwd = await $.session.cwd()
    const isDesktop = e.surface === 'desktop'
    const isNarrow = columns < 60

    const onRun = async () => {
      await attempt('run ready', $, async () => {
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

    const onRerun = (id: string) => async () => {
      await attempt('rerun', $, async () => {
        const text = await runTasks($, { cwd, maxWorkers: maxWorkers(options), gate, taskId: id })
        await save($, cwd)
        $.ui.toast(fit(text.split('\n')[0] ?? text, 100))
      })
    }

    const runButton = <Button key="run-ready" label="Run ready" variant="primary" onPress={onRun} />
    const refreshButton = <Button key="refresh-review" label="↻ review" onPress={onRefresh} />

    if (plan === null) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text dimColor wrap="truncate">No plan yet. Ask the advisor for one.</Text>
          <Box flexDirection="row" columnGap={1}>
            {runButton}
            {refreshButton}
          </Box>
        </Box>
      )
    }

    const counts = countTasks(plan)
    const state = bandState(plan, asks.length)
    const mismatch = advisor.length > 0 && !/fable/i.test(advisor)
    const titleOf = (id: string): string => plan.tasks.find(task => task.id === id)?.title ?? id
    const share = percent(counts.settled, counts.total)
    const pct = `${share}%`.padStart(4)
    const tagWidth = isNarrow ? 0 : 9
    const titleRoom = Math.max(12, columns - MARK_WIDTH - tagWidth - 14)

    const warnings = [
      mismatch ? `advisor model is ${shortModel(advisor)}, expected Fable` : null,
      stale ? `Herdr-Jev data is stale${staleNote === null ? '' : `: ${staleNote}`}` : null,
    ].filter((one): one is string => one !== null)

    const footer = [
      baseName(cwd),
      `advisor ${advisor.length > 0 ? shortModel(advisor) : 'unknown'}`,
      reviewShort(isReviewing, review),
      `auto-run ${autoRun(options) ? 'on' : 'off'}`,
      `auto-review ${autoReview(options) ? 'on' : 'off'}`,
    ].join(' · ')

    let reviewLine: string | null = null
    if (isReviewing) reviewLine = 'Review: running'
    else if (review !== null) {
      reviewLine = review.ok
        ? `Review: ${review.status ?? 'unknown'}${review.detail === null ? '' : ` · ${review.detail}`}`
        : review.isTimedOut === true
          ? `Review timed out: ${review.reason ?? 'unknown'}`
          : `Review refresh failed: ${review.reason ?? 'unknown'}`
    }

    const kv = (task: HarnessTask, label: string, value: string, hue: Hue = 'plain') => (
      <Box key={`${task.id}-${label}`} flexDirection="row">
        <Box width={KEY_WIDTH} flexShrink={0}>
          <Text dimColor>{label}</Text>
        </Box>
        <Text {...hueProps(hue)} wrap="truncate-end">{value}</Text>
      </Box>
    )

    const sessionRow = (task: HarnessTask) => {
      const isOpen = folds[task.id] ?? task.state === 'running'
      const toggle = () => update($, foldsAtom, current => ({ ...current, [task.id]: !isOpen }))
      const hue = ROW_MARK[task.state].hue
      const mark = task.state === 'running' || task.state === 'review' ? '◐' : '●'
      const spent = elapsedOf(task, workers, now)
      const live = task.state === 'running' || task.state === 'review'
      const own = workers.filter(row => row.taskId === task.id)
      const detailRows = [
        ...own.map(row =>
          kv(
            task,
            'worker',
            `${row.agentId.slice(0, 8)} · ${row.lastTool ?? 'starting'} · ${Math.max(0, Math.round((now - row.startedAt) / 1000))}s`,
          ),
        ),
        ...(live && task.lastTool !== undefined ? [kv(task, 'tool', task.lastTool)] : []),
        ...(task.deps.length > 0 ? [kv(task, 'deps', `after ${task.deps.join(', ')}`)] : []),
        ...(task.reason.length > 0 ? [kv(task, 'reason', task.reason)] : []),
        ...(task.review || task.verdict !== undefined
          ? [kv(task, 'review', task.verdict ?? `by ${shortModel(task.reviewModel)}`, task.verdict === 'CHANGES_REQUIRED' ? 'error' : 'plain')]
          : []),
        ...(task.note === undefined
          ? []
          : [kv(task, 'note', task.note, task.state === 'failed' ? 'error' : task.state === 'needs_you' ? 'warning' : 'plain')]),
      ]
      const canRerun = task.state === 'failed' || task.state === 'needs_you'

      return (
        <Box key={`row-${task.id}`} flexDirection="column" marginBottom={isOpen ? 1 : 0}>
          <Box key={`head-${task.id}`} flexDirection="row" columnGap={1} position="relative">
            <Button key={`fold-${task.id}`} plain dimColor label={isOpen ? '▾' : '▸'} onPress={toggle} />
            <Text {...hueProps(hue)}>{mark}</Text>
            {tagWidth > 0 && (
              <Box width={tagWidth} flexShrink={0}>
                <Text dimColor>{task.id.slice(0, 7)}</Text>
              </Box>
            )}
            {isDesktop ? (
              <Text bold={isOpen} wrap="truncate-end">{task.title}</Text>
            ) : (
              <Button key={`title-${task.id}`} plain label={fit(task.title, titleRoom)} onPress={toggle} />
            )}
            <Box flexGrow={1} />
            {spent.length > 0 && <Text dimColor>{spent}</Text>}
            {isDesktop && cover({ Box, Button }, `title-${task.id}`, toggle)}
          </Box>
          <Box flexDirection="row" columnGap={2} paddingLeft={MARK_WIDTH + 2}>
            <Text dimColor wrap="truncate-end">{sessionMeta(task)}</Text>
            <Box flexGrow={1} />
            {live && task.lastTool !== undefined && !isOpen && <Text dimColor wrap="truncate-end">{task.lastTool}</Text>}
          </Box>
          {isOpen && (
            <Box flexDirection="column" rowGap={1} paddingLeft={MARK_WIDTH + 2} marginTop={1}>
              <Box flexDirection="column">{detailRows}</Box>
              {canRerun && (
                <Box flexDirection="row" columnGap={2}>
                  <Button key={`rerun-${task.id}`} plain label="Rerun" onPress={onRerun(task.id)} />
                </Box>
              )}
            </Box>
          )}
        </Box>
      )
    }

    const section = (id: string, label: string, tasks: readonly HarnessTask[]) => {
      if (tasks.length === 0) return null
      const isOpen = folds[`section:${id}`] ?? id !== 'done'
      const toggle = () => update($, foldsAtom, current => ({ ...current, [`section:${id}`]: !isOpen }))
      const shownRows = tasks.slice(0, SECTION_ROWS)
      return (
        <Box key={`section-${id}`} flexDirection="column" marginTop={1}>
          <Box key={`heading-${id}`} flexDirection="row" columnGap={1} position="relative">
            {isDesktop ? (
              <Text bold={isOpen} dimColor={!isOpen}>{label}</Text>
            ) : (
              <Button key={`section-${id}`} plain label={isOpen ? label : `${label} …`} onPress={toggle} />
            )}
            <Text dimColor>{String(tasks.length)}</Text>
            {isDesktop && cover({ Box, Button }, `section-${id}`, toggle)}
          </Box>
          {isOpen && shownRows.map(sessionRow)}
          {isOpen && tasks.length > shownRows.length && <Text dimColor>{`+${tasks.length - shownRows.length} more`}</Text>}
        </Box>
      )
    }

    const needsRows = plan.tasks.filter(task => task.state === 'needs_you' || task.state === 'failed')
    const workingRows = plan.tasks.filter(task => task.state === 'running' || task.state === 'review')
    const approvedRows = plan.tasks.filter(task => task.state === 'approved')
    const queuedRows = plan.tasks.filter(task => task.state === 'proposed' || task.state === 'advisor')
    const doneRows = plan.tasks.filter(isSettled)
    const ruleWidth = Math.max(0, columns - 4 - 13)
    const scope = await read($, scopeAtom)
    const scopeOpen = folds['section:scope'] ?? false
    const scopeRows = scopeOpen ? keptRows(runtime.receipt) : []

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="row" columnGap={2} alignItems="center">
          <Text {...hueProps(state.hue)}>{state.isWorking ? '●' : state.word === 'all verified' ? '✓' : '○'}</Text>
          <Text bold wrap="truncate-end">{plan.objective}</Text>
          {plan.at !== undefined && <Text dimColor>{`planned ${ageText(now - plan.at)}`}</Text>}
          <Box flexGrow={1} />
          {runButton}
          {refreshButton}
          <Button key="close" plain dimColor label="✕" onPress={() => $.ui.close({ id: PANE_ID })} />
        </Box>
        <Box flexDirection="row" columnGap={1} alignItems="center">
          {fillBar({ Box, Text }, 'bar', share, state.hue)}
          <Text bold {...hueProps(pctHue(state.word))}>{pct}</Text>
        </Box>

        {asks.length > 0 && (
          <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="warning" paddingX={1}>
            <Text dimColor wrap="truncate">{`── Needs you ${'─'.repeat(ruleWidth)}`}</Text>
            <Text bold color="warning">{`☐ ${asks.length} task${asks.length === 1 ? '' : 's'} for you`}</Text>
            {asks.map((ask, index) => {
              const criterion = plan.tasks.find(task => task.id === ask.taskId)?.checks.join('; ') ?? ''
              return (
                <Box key={`ask-${ask.id}`} flexDirection="column" marginTop={1}>
                  <Box flexDirection="row" columnGap={1}>
                    <Text bold color="warning" wrap="truncate">{`☐ #${index + 1} ${titleOf(ask.taskId)}`}</Text>
                    <Text dimColor>{ageText(now - ask.at)}</Text>
                  </Box>
                  <Box paddingLeft={2} flexDirection="column">
                    <Text>{ask.question}</Text>
                    {criterion.length > 0 && <Text dimColor wrap="truncate">{`Done when: ${criterion}`}</Text>}
                  </Box>
                </Box>
              )
            })}
          </Box>
        )}

        {section('needs', 'Needs you', needsRows)}
        {section('working', 'Working', workingRows)}
        {section('approved', 'Approved', approvedRows)}
        {section('queued', 'Queued', queuedRows)}
        {section('done', 'Done', doneRows)}

        {scopeMode(options) !== 'off' && (
          <Box flexDirection="column" marginTop={1}>
            <Box key="heading-scope" flexDirection="row" columnGap={1} position="relative">
              <Button
                key="section-scope"
                plain
                dimColor
                label={scopeOpen ? '▾' : '▸'}
                onPress={() => update($, foldsAtom, current => ({ ...current, 'section:scope': !scopeOpen }))}
              />
              <Text dimColor={!scopeOpen} bold={scopeOpen} wrap="truncate">{scopeHeading(scopeMode(options), runtime.receipt)}</Text>
            </Box>
            {scopeOpen && (
              <Box flexDirection="column" paddingLeft={2}>
                {scopeRows.map(row => (
                  <Box key={`scope-${row.kind}-${row.name}`} flexDirection="row">
                    <Box width={KEY_WIDTH + 8} flexShrink={0}>
                      <Text dimColor wrap="truncate-end">{row.reason}</Text>
                    </Box>
                    <Text wrap="truncate-end">{`${row.kind === 'agent' ? '◆ ' : ''}${row.name}`}</Text>
                  </Box>
                ))}
                {scopeRows.length === 0 && <Text dimColor>nothing listed yet</Text>}
                {scope.note !== null && <Text dimColor wrap="truncate">{scope.note}</Text>}
              </Box>
            )}
          </Box>
        )}

        <Box flexDirection="column" marginTop={1}>
          {warnings.length > 0 && <Text color="warning" wrap="truncate">{fit(warnings.join(' · '), columns)}</Text>}
          {counts.approved > 0 && (
            <Text color="warning" wrap="truncate">
              {fit(`${counts.approved} approved, ${reviewPhrase(isReviewing, phase(review))}`, columns)}
            </Text>
          )}
          {reviewLine !== null && <Text dimColor wrap="truncate">{fit(reviewLine, columns)}</Text>}
          <Text dimColor wrap="truncate">{fit(footer, columns)}</Text>
        </Box>
      </Box>
    )
  })
}
