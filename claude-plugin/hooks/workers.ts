import type { AgentSpawnArgs, AgentSpawnResult, EngineInterface } from 'claude-code'

import type { HarnessPlan, HarnessRoleTable, HarnessTask, HarnessTaskState, HarnessVerdict } from '../types'
import type { RunPort } from './cli'
import { claudeEffort, fit, modelRoleOf, parseNeedsYou, parseVerdict, spawnModelOf } from './plan'
import type { AgentKind } from './plan'

export type AgentSpec = Parameters<EngineInterface['agent']['register']>[0]

export type SpawnPort = (args: AgentSpawnArgs) => Promise<AgentSpawnResult>

export type RegisterPort = (spec: AgentSpec) => Promise<unknown>

export type LaunchPorts = {
  spawn: SpawnPort
  register: RegisterPort
  run: RunPort
}

export type SpawnOutcome = { ok: true; agentId: string } | { ok: false; reason: string }

export type Gate = {
  tail: Promise<void>
  registered: Map<string, string>
}

export type CompletedTurn = {
  answer: string
  reason: string
}

export type Transition = {
  state: HarnessTaskState
  note?: string
  verdict?: HarnessVerdict
  report?: string
  reviewReport?: string
  isEnded: boolean
  question?: string
  toast?: string
  startReview: boolean
}

export const REPORT_LIMIT = 1500
export const REVIEW_REPORT_LIMIT = 8000
export const DIFF_LIMIT = 20000
const STAT_LIMIT = 2000
const GIT_TIMEOUT_MS = 30000

const AGENT_KINDS: readonly AgentKind[] = ['implementer', 'reviewer', 'reader', 'mechanic']

const TOOL_PLAN = 'mcp__harness__harness_plan'
const TOOL_RUN = 'mcp__harness__harness_run'
const TOOL_STATUS = 'mcp__harness__harness_status'

const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'] as const
const MECHANIC_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'] as const

const NO_EDIT = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'Agent'] as const
const NO_HARNESS_CONTROL = ['Agent', TOOL_RUN, TOOL_PLAN] as const
const NO_HARNESS_AT_ALL = [TOOL_PLAN, TOOL_RUN, TOOL_STATUS] as const

const PROMPTS: Readonly<Record<AgentKind, string>> = {
  implementer:
    'You are the harness implementer. Implement only the task you are given, inside its owned paths. Run the acceptance checks you are given and fix what fails. Finish with a short report listing the files you changed and the check results. If you are blocked on a human decision, end with one line: NEEDS_YOU: <question>. Never spawn other agents.',
  reviewer:
    'You are the harness reviewer. Review the delivered change independently and strictly read-only: inspect the diff of the owned paths and judge the result against the acceptance checks. You have no shell and no edit tools; never try to change anything. End your answer with exactly one final line, either REVIEW_GATE_VERDICT: APPROVE or REVIEW_GATE_VERDICT: CHANGES_REQUIRED.',
  reader:
    'You are the harness reader. Read the files and data you are pointed at and report what you find, concisely and with paths. Never edit or create anything. If you need a human decision, end with one line: NEEDS_YOU: <question>.',
  mechanic:
    'You are the harness mechanic. Do the mechanical edit you are given (scaffold, fixture, lint fix, conversion, rename) inside its owned paths and nothing else. Run the acceptance checks you are given. Finish with a short report listing the files you changed. If you are blocked on a human decision, end with one line: NEEDS_YOU: <question>. Never spawn other agents.',
}

const DESCRIPTIONS: Readonly<Record<AgentKind, string>> = {
  implementer: 'Harness implementer: implements one bounded task. Spawned by the harness mod only.',
  reviewer: 'Harness reviewer: independent read-only review ending in a verdict line.',
  reader: 'Harness reader: bulk reading and collection, read-only.',
  mechanic: 'Harness mechanic: mechanical edits on a small model. Spawned by the harness mod only.',
}

const SCOPE_LINES: Readonly<Record<AgentKind, string>> = {
  implementer:
    'Implement only this task and nothing else. Run the acceptance checks, then report the files you changed. If you are blocked on a human decision, end with one line: NEEDS_YOU: <question>.',
  reviewer:
    'Review the delivered change independently and read-only. Inspect the diff of the owned paths and judge it against the acceptance checks. Do not edit anything. End your answer with exactly one final line, either REVIEW_GATE_VERDICT: APPROVE or REVIEW_GATE_VERDICT: CHANGES_REQUIRED.',
  reader:
    'Read and report only. Never edit or create files. If you need a human decision, end with one line: NEEDS_YOU: <question>.',
  mechanic:
    'Make only this mechanical change inside the owned paths, run the acceptance checks, then report the files you changed. If you are blocked on a human decision, end with one line: NEEDS_YOU: <question>.',
}

export function agentSpec(kind: AgentKind, spawnModel: string, effort: string | undefined): AgentSpec {
  const common = {
    name: kind,
    description: DESCRIPTIONS[kind],
    prompt: PROMPTS[kind],
    model: spawnModel,
    ...(effort === undefined ? {} : { effort }),
  }
  if (kind === 'reviewer') {
    return { ...common, tools: READ_ONLY_TOOLS, disallowedTools: [...NO_EDIT, ...NO_HARNESS_AT_ALL] }
  }
  if (kind === 'reader') {
    return { ...common, tools: READ_ONLY_TOOLS, disallowedTools: [...NO_EDIT, ...NO_HARNESS_AT_ALL] }
  }
  if (kind === 'mechanic') {
    return { ...common, tools: MECHANIC_TOOLS, disallowedTools: NO_HARNESS_CONTROL }
  }
  return { ...common, disallowedTools: NO_HARNESS_CONTROL }
}

export function createGate(): Gate {
  return { tail: Promise.resolve(), registered: new Map() }
}

async function exclusive<T>(gate: Gate, work: () => Promise<T>): Promise<T> {
  const run = gate.tail.then(work)
  gate.tail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function registrationKey(spawnModel: string, effort: string | undefined): string {
  return `${spawnModel}|${effort ?? ''}`
}

export async function registerKinds(
  ports: Pick<LaunchPorts, 'register'>,
  gate: Gate,
  roles: HarnessRoleTable,
): Promise<string[]> {
  const registered: string[] = []
  for (const kind of AGENT_KINDS) {
    const entry = roles[modelRoleOf(kind)]
    if (entry === undefined) continue
    const spawnModel = spawnModelOf(entry.cliModel)
    if (spawnModel === null) continue
    const effort = claudeEffort(entry.effort)
    const key = registrationKey(spawnModel, effort)
    await exclusive(gate, async () => {
      if (gate.registered.get(kind) === key) return
      try {
        await ports.register(agentSpec(kind, spawnModel, effort))
        gate.registered.set(kind, key)
        registered.push(kind)
      } catch {
        return
      }
    })
  }
  return registered
}

async function gitText(run: RunPort, cwd: string, argv: readonly string[]): Promise<string | null> {
  try {
    const ran = await run(argv, { cwd, timeoutMs: GIT_TIMEOUT_MS })
    return ran.exitCode === 0 ? ran.stdout : null
  } catch {
    return null
  }
}

export async function collectDiff(run: RunPort, cwd: string, paths: readonly string[]): Promise<string> {
  const scope = paths.length === 0 ? 'the whole repository' : paths.join(', ')
  const stat = await gitText(run, cwd, ['git', 'diff', '--stat', '--', ...paths])
  const diff = await gitText(run, cwd, ['git', 'diff', '--', ...paths])

  const lines = [`Diff of ${scope}, produced by the harness with git diff (this block is the change under review):`, '<<<DIFF']
  if (diff === null) {
    lines.push('git diff failed; inspect the owned paths with Read, Glob and Grep instead.')
  } else if (diff.trim().length === 0) {
    lines.push('git diff is empty: there are no unstaged changes in these paths. Inspect the owned files with Read, Glob and Grep.')
  } else {
    if (stat !== null && stat.trim().length > 0) lines.push(fit(stat.trimEnd(), STAT_LIMIT), '')
    if (diff.length > DIFF_LIMIT) {
      lines.push(
        diff.slice(0, DIFF_LIMIT),
        `[diff truncated: first ${DIFF_LIMIT} of ${diff.length} characters; read the owned paths for the rest]`,
      )
    } else {
      lines.push(diff.trimEnd())
    }
  }
  lines.push('DIFF>>>')
  return lines.join('\n')
}

export type LaunchTarget =
  | { ok: true; cliModel: string; spawnModel: string; effort: string | undefined }
  | { ok: false; reason: string }

export function resolveLaunch(plan: HarnessPlan, task: HarnessTask, kind: AgentKind): LaunchTarget {
  const roleKey = modelRoleOf(kind)
  const entry = plan.roles[roleKey]
  if (entry === undefined) {
    return {
      ok: false,
      reason: `herdr-jev models list has no ${roleKey} model, so the ${kind} is not started; fix it and call harness_plan again`,
    }
  }
  const spawnModel = spawnModelOf(entry.cliModel)
  if (spawnModel === null) {
    return { ok: false, reason: `model ${entry.cliModel} has no Claude Code alias` }
  }
  const effort = kind === 'reviewer' ? entry.effort : (task.effort ?? entry.effort)
  return { ok: true, cliModel: entry.cliModel, spawnModel, effort: claudeEffort(effort) }
}

export type PromptExtras = {
  report?: string
  diff?: string
}

export function buildPrompt(plan: HarnessPlan, task: HarnessTask, kind: AgentKind, extras: PromptExtras = {}): string {
  const { report, diff } = extras
  const paths = task.paths.length === 0 ? '- none declared' : task.paths.map(path => `- ${path}`).join('\n')
  const checks = task.checks.length === 0 ? '- none declared' : task.checks.map(check => `- ${check}`).join('\n')
  const lines = [
    `Objective: ${plan.objective}`,
    `Task ${task.id}: ${task.title}`,
    '',
    'Owned paths:',
    paths,
    '',
    'Acceptance checks:',
    checks,
  ]
  if (kind === 'reviewer' && report !== undefined && report.length > 0) {
    lines.push('', 'Implementer report:', fit(report, REPORT_LIMIT))
  }
  if (kind === 'reviewer' && diff !== undefined && diff.length > 0) {
    lines.push('', diff)
  }
  if ((kind === 'implementer' || kind === 'mechanic') && task.reviewReport !== undefined && task.reviewReport.length > 0) {
    lines.push(
      '',
      'Previous review findings (the reviewer asked for changes; address every point before anything else):',
      fit(task.reviewReport, REVIEW_REPORT_LIMIT),
    )
  }
  lines.push('', SCOPE_LINES[kind])
  return lines.join('\n')
}

export async function launchAgent(
  ports: LaunchPorts,
  gate: Gate,
  plan: HarnessPlan,
  task: HarnessTask,
  kind: AgentKind,
  cwd: string,
  report?: string,
): Promise<SpawnOutcome> {
  const target = resolveLaunch(plan, task, kind)
  if (!target.ok) return target

  const diff = kind === 'reviewer' ? await collectDiff(ports.run, cwd, task.paths) : undefined

  return exclusive(gate, async (): Promise<SpawnOutcome> => {
    const key = registrationKey(target.spawnModel, target.effort)
    if (gate.registered.get(kind) !== key) {
      try {
        await ports.register(agentSpec(kind, target.spawnModel, target.effort))
        gate.registered.set(kind, key)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, reason: `agent type ${kind} not registered: ${message.slice(0, 160)}` }
      }
    }

    try {
      const spawned = await ports.spawn({
        subagentType: `harness:${kind}`,
        prompt: buildPrompt(plan, task, kind, { report, diff }),
        description: fit(`${kind}: ${task.title}`, 60),
        cwd,
        model: target.spawnModel,
      })
      if (spawned.deny !== undefined) return { ok: false, reason: spawned.deny }
      if (spawned.agentId === undefined) return { ok: false, reason: 'spawn returned no agent id' }
      return { ok: true, agentId: spawned.agentId }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, reason: message.slice(0, 160) }
    }
  })
}

export function decideWorkerTurn(task: HarnessTask, turn: CompletedTurn): Transition {
  const label = fit(task.title, 40)
  const report = fit(turn.answer.trim(), REPORT_LIMIT)

  if (turn.reason !== 'answer') {
    return {
      state: 'failed',
      note: `turn ended: ${turn.reason}`,
      report,
      isEnded: true,
      toast: `harness: "${label}" failed (${turn.reason})`,
      startReview: false,
    }
  }

  const question = parseNeedsYou(turn.answer)
  if (question !== null) {
    return {
      state: 'needs_you',
      note: question,
      report,
      isEnded: true,
      question,
      toast: `harness: "${label}" needs you`,
      startReview: false,
    }
  }

  if (task.review) {
    return { state: 'review', report, isEnded: false, startReview: true }
  }

  return { state: 'done', report, isEnded: true, startReview: false }
}

export function decideReviewTurn(task: HarnessTask, turn: CompletedTurn): Transition {
  const label = fit(task.title, 40)
  const verdict = turn.reason === 'answer' ? parseVerdict(turn.answer) : null

  if (verdict === 'APPROVE') {
    return { state: 'approved', verdict, isEnded: true, startReview: false }
  }

  if (verdict === 'CHANGES_REQUIRED') {
    return {
      state: 'failed',
      verdict,
      reviewReport: fit(turn.answer.trim(), REVIEW_REPORT_LIMIT),
      note: fit(turn.answer.trim().split('\n').slice(-6).join(' '), 240),
      isEnded: true,
      toast: `harness: review requires changes on "${label}"`,
      startReview: false,
    }
  }

  const why = turn.reason === 'answer' ? 'reviewer gave no verdict line' : `reviewer turn ended: ${turn.reason}`
  return {
    state: 'needs_you',
    note: why,
    isEnded: true,
    question: `${task.title}: ${why}`,
    toast: `harness: review of "${label}" needs you`,
    startReview: false,
  }
}
