import type {
  HarnessConsult,
  HarnessHumanAsk,
  HarnessModelRole,
  HarnessPlan,
  HarnessRole,
  HarnessRoleModel,
  HarnessRoleTable,
  HarnessTask,
  HarnessTaskState,
  HarnessVerdict,
  HarnessWorkerRow,
} from '../types'

export type TriageResult = {
  complexity: string
  confidence: number | null
  needsResearch: boolean
  effort: string | null
}

export type ConsultTarget = {
  model: string
  cliModel: string
  effort: string | null
}

export const CONSULT_REPORT_LIMIT = 4000

const CONSULT_STATES: readonly HarnessConsult['state'][] = ['running', 'done', 'failed']

export type ReviewResult = {
  status: string | null
  detail: string | null
  error: string | null
  identity: { client: string; session: string; cwd: string } | null
}

export type PlanTaskInput = {
  title: string
  deps?: string[]
  paths?: string[]
  checks?: string[]
  role?: string
}

export type RoleHints = {
  title: string
  hint?: string
}

export type RoleDecision = {
  role: 'advisor' | 'implementer' | 'reader'
  writes: boolean
  review: boolean
  why: string
}

export type AgentKind = 'implementer' | 'reviewer' | 'reader' | 'mechanic'

export const MODEL_ROLES: readonly HarnessModelRole[] = [
  'advisor',
  'implementer',
  'reviewer',
  'researcher',
  'reader',
]

export const TASK_ROLES: readonly HarnessRole[] = ['advisor', 'implementer', 'reviewer', 'reader']

export const TASK_STATES: readonly HarnessTaskState[] = [
  'proposed',
  'advisor',
  'running',
  'review',
  'approved',
  'verified',
  'failed',
  'needs_you',
  'done',
]

const WRITE_WORDS = /\b(scaffold\w*|fixtures?|lint\w*|convert\w*|conversions?|renam\w*)\b/i

const READ_WORDS = /\b(read|reading|collect\w*|inventor\w*|research\w*)\b/i

const READ_HINT_WORDS =
  /\b(read|reading|collect\w*|inventor\w*|research\w*|list|listing|inspect\w*|audit\w*|map|mapping|summari[sz]\w*)\b/i

const WRITE_VERBS = new Set([
  'fix', 'add', 'implement', 'update', 'change', 'refactor', 'wire', 'remove', 'delete', 'rewrite',
  'patch', 'replace', 'build', 'migrate', 'write', 'edit', 'modify', 'create', 'make', 'move',
  'extract', 'introduce', 'enable', 'disable', 'set', 'bump', 'improve', 'handle', 'support', 'drop',
  'restructure', 'optimize', 'optimise', 'correct', 'adjust', 'tweak', 'apply', 'upgrade', 'install',
  'configure', 'resolve', 'repair',
])

function startsWithWriteVerb(title: string): boolean {
  const first = title.trim().toLowerCase().match(/^[a-z]+/)
  return first !== null && WRITE_VERBS.has(first[0])
}

function readsAs(pattern: RegExp, title: string, hint: string): boolean {
  return (!startsWithWriteVerb(title) && pattern.test(title)) || pattern.test(hint)
}

const MANUAL_ROLES = ['advisor', 'implementer', 'reader', 'mechanic'] as const

const VERDICT_LINE = /^\s*REVIEW_GATE_VERDICT:\s*(APPROVE|CHANGES_REQUIRED)\s*$/gm
const NEEDS_YOU_LINE = /^\s*NEEDS_YOU:\s*(\S.*)$/gm

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((one): one is string => typeof one === 'string' && one.length > 0)
    : []
}

export function normalizeTriage(raw: unknown): TriageResult | null {
  if (!isRecord(raw)) return null
  const complexity = text(raw.complexity)
  if (complexity === null) return null
  return {
    complexity: complexity.toLowerCase(),
    confidence: typeof raw.confidence === 'number' ? raw.confidence : null,
    needsResearch: raw.needsResearch === true,
    effort: text(raw.effort),
  }
}

function flag(value: unknown): boolean {
  return value === true
}

function normalizeRoleModel(raw: unknown): HarnessRoleModel | null {
  if (!isRecord(raw)) return null
  const model = text(raw.model)
  const cliModel = text(raw.cliModel)
  if (model === null || cliModel === null) return null
  return {
    model,
    cliModel,
    effort: text(raw.effort) ?? 'standard',
    readonly: flag(raw.readonly),
    fallbackActive: flag(raw.fallbackActive),
  }
}

function normalizeRoleTable(raw: unknown): HarnessRoleTable | null {
  if (!isRecord(raw)) return null
  const table: HarnessRoleTable = {}
  for (const role of MODEL_ROLES) {
    const entry = normalizeRoleModel(raw[role])
    if (entry !== null) table[role] = entry
  }
  return table
}

export function normalizeModels(raw: unknown): HarnessRoleTable | null {
  if (!isRecord(raw)) return null
  if (raw.client !== undefined && raw.client !== 'claude') return null
  return normalizeRoleTable(raw.roles)
}

export function normalizeConsult(raw: unknown): ConsultTarget | null {
  if (!isRecord(raw) || raw.mode !== 'delegate' || !isRecord(raw.consult)) return null
  const consult = raw.consult
  if (consult.client !== undefined && consult.client !== 'claude') return null
  const model = text(consult.model)
  const cliModel = text(consult.cliModel) ?? model
  if (model === null || cliModel === null) return null
  return { model, cliModel, effort: text(consult.effort) }
}

export function normalizeReview(raw: unknown): ReviewResult | null {
  if (!isRecord(raw)) return null
  const judges = Array.isArray(raw.judges)
    ? raw.judges.filter(isRecord).map(judge => {
        const scope = text(judge.scope) ?? 'scope'
        return `${scope} ${text(judge.status) ?? text(judge.error) ?? 'unknown'}`
      })
    : []
  const verify = isRecord(raw.verify) ? text(raw.verify.status) : null
  const parts = [...(verify === null ? [] : [`verify ${verify}`]), ...judges]
  return {
    status: text(raw.status),
    detail: parts.length === 0 ? null : parts.join(', '),
    error: text(raw.error),
    identity: reviewIdentity(raw),
  }
}

function reviewIdentity(raw: Record<string, unknown>): ReviewResult['identity'] {
  const client = text(raw.client)
  const session = text(raw.session)
  const cwd = text(raw.cwd)
  return client === null || session === null || cwd === null ? null : { client, session, cwd }
}

export function assignRole(triage: TriageResult | null, hints: RoleHints): RoleDecision {
  const hint = (hints.hint ?? '').trim().toLowerCase()
  const manual = MANUAL_ROLES.find(role => role === hint)

  if (manual === 'mechanic') {
    return { role: 'reader', writes: true, review: true, why: 'manual' }
  }

  if (manual !== undefined) {
    return { role: manual, writes: false, review: manual === 'implementer', why: 'manual' }
  }

  const words = `${hints.title} ${hint}`

  if (WRITE_WORDS.test(words)) {
    return { role: 'reader', writes: true, review: true, why: 'title or hint reads as mechanical writing' }
  }

  if (readsAs(READ_WORDS, hints.title, hint)) {
    return { role: 'reader', writes: false, review: false, why: 'title or hint reads as reading or collecting' }
  }

  const complexity = triage?.complexity ?? null

  if (complexity === 'trivial') {
    if (readsAs(READ_HINT_WORDS, hints.title, hint)) {
      return { role: 'reader', writes: false, review: false, why: 'triage trivial with a read hint' }
    }
    return { role: 'reader', writes: true, review: true, why: 'triage trivial without a read hint' }
  }

  if (complexity === 'architectural') {
    return { role: 'advisor', writes: false, review: false, why: 'triage architectural' }
  }

  return {
    role: 'implementer',
    writes: false,
    review: true,
    why: complexity === null ? 'triage unavailable' : `triage ${complexity}`,
  }
}

export function kindOf(task: Pick<HarnessTask, 'role' | 'writes'>): AgentKind | null {
  if (task.role === 'implementer') return 'implementer'
  if (task.role === 'reviewer') return 'reviewer'
  if (task.role === 'reader') return task.writes ? 'mechanic' : 'reader'
  return null
}

export function modelRoleOf(kind: AgentKind): HarnessModelRole {
  return kind === 'mechanic' ? 'reader' : kind
}

export type SpawnModel = 'fable' | 'opus' | 'sonnet' | 'haiku'

const SPAWN_MODELS: readonly SpawnModel[] = ['fable', 'opus', 'sonnet', 'haiku']

export function spawnModelOf(cliModel: string): SpawnModel | null {
  const lower = cliModel.toLowerCase()
  return SPAWN_MODELS.find(alias => lower.includes(alias)) ?? null
}

export function claudeEffort(effort: string | null | undefined): string | undefined {
  if (effort === null || effort === undefined) return undefined
  if (effort === 'standard') return 'medium'
  return ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort) ? effort : undefined
}

export function hash8(input: string): string {
  let acc = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    acc ^= input.charCodeAt(index)
    acc = Math.imul(acc, 0x01000193) >>> 0
  }
  return acc.toString(16).padStart(8, '0')
}

export function taskId(objective: string, title: string, attempt = 0): string {
  const seed = attempt === 0 ? `${objective}\n${title}` : `${objective}\n${title}\n#${attempt}`
  return `hp-${hash8(seed)}`
}

function describeReason(
  decision: RoleDecision,
  triage: TriageResult | null,
  entry: HarnessRoleModel | null,
  role: string,
  hasList: boolean,
): string {
  const score = triage === null ? null : triage.confidence
  const confidence = score === null ? 'no confidence' : `confidence ${score.toFixed(2)}`
  const cause = decision.why === 'manual' ? 'manual override' : decision.why
  const label = decision.writes ? `${decision.role} (writes)` : decision.role
  let origin: string
  if (decision.role === 'advisor') origin = 'model is the session model'
  else if (entry !== null) {
    origin = `model ${entry.model} (${entry.cliModel}) from herdr-jev models list${entry.fallbackActive ? ', fallback active' : ''}`
  } else if (!hasList) origin = 'herdr-jev models list unavailable, model unknown'
  else origin = `herdr-jev models list has no ${role} model`
  return `${label} because ${cause} (${confidence}); ${origin}.`
}

export function buildPlan(
  objective: string,
  tasks: readonly PlanTaskInput[],
  triages: readonly (TriageResult | null)[],
  roles: HarnessRoleTable | null,
  sessionModel: string,
): HarnessPlan {
  const ids: string[] = []
  const used = new Set<string>()

  tasks.forEach(task => {
    let attempt = 0
    let id = taskId(objective, task.title, attempt)
    while (used.has(id)) {
      attempt += 1
      id = taskId(objective, task.title, attempt)
    }
    used.add(id)
    ids.push(id)
  })

  const byTitle = new Map<string, string>()
  tasks.forEach((task, index) => {
    const id = ids[index]
    const key = task.title.trim().toLowerCase()
    if (id !== undefined && !byTitle.has(key)) byTitle.set(key, id)
  })

  const table: HarnessRoleTable = roles ?? {}

  const built: HarnessTask[] = tasks.map((task, index) => {
    const id = ids[index] ?? taskId(objective, task.title, index + 1)
    const triage = triages[index] ?? null
    const decision = assignRole(triage, { title: task.title, hint: task.role })
    const roleKey: HarnessModelRole = decision.role
    const entry = table[roleKey] ?? null

    const model =
      decision.role === 'advisor' ? (sessionModel.length > 0 ? sessionModel : null) : (entry?.model ?? null)
    const effort = entry?.effort ?? null
    const reviewer = decision.review ? (table.reviewer ?? null) : null

    const deps = (task.deps ?? [])
      .map(dep => {
        const clean = dep.trim()
        if (ids.includes(clean)) return clean
        return byTitle.get(clean.toLowerCase())
      })
      .filter((dep): dep is string => dep !== undefined && dep !== id)

    return {
      id,
      title: task.title,
      role: decision.role,
      writes: decision.writes,
      model,
      effort,
      reason: describeReason(decision, triage, entry, roleKey, roles !== null),
      deps: [...new Set(deps)],
      paths: task.paths ?? [],
      checks: task.checks ?? [],
      state: decision.role === 'advisor' ? 'advisor' : 'proposed',
      review: decision.review,
      reviewModel: reviewer?.model ?? null,
      toolCount: 0,
    }
  })

  return { objective, advisorModel: sessionModel, roles: table, tasks: built }
}

export function missingRoles(plan: HarnessPlan): string[] {
  const missing = new Set<string>()
  for (const task of plan.tasks) {
    const kind = kindOf(task)
    if (kind !== null && plan.roles[modelRoleOf(kind)] === undefined) missing.add(modelRoleOf(kind))
    if (task.review && plan.roles.reviewer === undefined) missing.add('reviewer')
  }
  return [...missing]
}

export function findTask(plan: HarnessPlan, ref: string): HarnessTask | undefined {
  const clean = ref.trim()
  const lower = clean.toLowerCase()
  return (
    plan.tasks.find(task => task.id === clean) ??
    plan.tasks.find(task => task.title.trim().toLowerCase() === lower)
  )
}

export function isSettled(task: HarnessTask): boolean {
  return task.state === 'verified' || task.state === 'done'
}

export function isUnblocking(task: HarnessTask): boolean {
  return isSettled(task) || task.state === 'approved'
}

export function readyTasks(plan: HarnessPlan): HarnessTask[] {
  const open = new Set(plan.tasks.filter(isUnblocking).map(task => task.id))
  return plan.tasks.filter(
    task =>
      task.state === 'proposed' &&
      task.role !== 'advisor' &&
      task.consult === undefined &&
      task.deps.every(dep => open.has(dep)),
  )
}

export type PlanCounts = {
  total: number
  settled: number
  approved: number
  running: number
  failed: number
  needsYou: number
}

export function countTasks(plan: HarnessPlan): PlanCounts {
  return {
    total: plan.tasks.length,
    settled: plan.tasks.filter(isSettled).length,
    approved: plan.tasks.filter(task => task.state === 'approved').length,
    running: plan.tasks.filter(task => task.state === 'running' || task.state === 'review').length,
    failed: plan.tasks.filter(task => task.state === 'failed').length,
    needsYou: plan.tasks.filter(task => task.state === 'needs_you').length,
  }
}

export function isAllVerified(plan: HarnessPlan): boolean {
  return plan.tasks.length > 0 && plan.tasks.every(isSettled)
}

export function approvedKey(plan: HarnessPlan): string | null {
  const ready = plan.tasks.length > 0 && plan.tasks.every(task => isSettled(task) || task.state === 'approved')
  const approved = plan.tasks.filter(task => task.state === 'approved').map(task => task.id)
  return ready && approved.length > 0 ? approved.sort().join(',') : null
}

export type Hue = 'claude' | 'warning' | 'error' | 'success' | 'inactive' | 'dim' | 'plain'

export type BandState = {
  word: 'all verified' | 'failed' | 'needs you' | 'review' | 'running' | 'approved' | 'planned'
  glyph: string
  hue: Hue
  isWorking: boolean
  task: HarnessTask | undefined
  failed: HarnessTask | undefined
}

export function bandState(plan: HarnessPlan, asks: number): BandState {
  const counts = countTasks(plan)
  const first = (state: HarnessTask['state']): HarnessTask | undefined =>
    plan.tasks.find(task => task.state === state)
  const running = first('running')
  const reviewing = first('review')
  const failed = first('failed')
  const needs = first('needs_you')
  const isWorking = running !== undefined || reviewing !== undefined
  const task =
    running ?? reviewing ?? failed ?? needs ?? first('approved') ?? plan.tasks.find(one => !isSettled(one))
  const base = { isWorking, task, failed }

  if (isAllVerified(plan)) return { ...base, word: 'all verified', glyph: '✓', hue: 'success' }
  if (failed !== undefined) return { ...base, word: 'failed', glyph: '!', hue: 'error' }
  if (asks > 0 || counts.needsYou > 0) return { ...base, word: 'needs you', glyph: '?', hue: 'warning' }
  if (reviewing !== undefined) return { ...base, word: 'review', glyph: '●', hue: 'claude' }
  if (running !== undefined) return { ...base, word: 'running', glyph: '●', hue: 'claude' }
  if (counts.approved > 0) return { ...base, word: 'approved', glyph: '◆', hue: 'warning' }
  return { ...base, word: 'planned', glyph: '○', hue: 'inactive' }
}

export const ROW_MARK: Readonly<Record<HarnessTaskState, { glyph: string; hue: Hue }>> = {
  proposed: { glyph: '○', hue: 'dim' },
  advisor: { glyph: '◇', hue: 'dim' },
  running: { glyph: '●', hue: 'claude' },
  review: { glyph: '◐', hue: 'dim' },
  approved: { glyph: '◆', hue: 'warning' },
  verified: { glyph: '✓', hue: 'success' },
  failed: { glyph: '!', hue: 'error' },
  needs_you: { glyph: '?', hue: 'warning' },
  done: { glyph: '✓', hue: 'success' },
}

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function parseVerdict(answer: string): HarnessVerdict | null {
  const matches = [...answer.matchAll(VERDICT_LINE)]
  const last = matches[matches.length - 1]
  const word = last?.[1]
  return word === 'APPROVE' || word === 'CHANGES_REQUIRED' ? word : null
}

export function parseNeedsYou(answer: string): string | null {
  const matches = [...answer.matchAll(NEEDS_YOU_LINE)]
  const last = matches[matches.length - 1]
  const question = last?.[1]?.trim()
  return question === undefined || question.length === 0 ? null : question
}

export function shortModel(model: string | null): string {
  if (model === null || model.length === 0) return '?'
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

export function barParts(done: number, total: number, cells = 10): { filled: string; empty: string } {
  const count = total <= 0 ? 0 : Math.min(cells, Math.round((done / total) * cells))
  return { filled: '█'.repeat(count), empty: '░'.repeat(cells - count) }
}

export function bar(done: number, total: number, cells = 10): string {
  const parts = barParts(done, total, cells)
  return parts.filled + parts.empty
}

export function percent(done: number, total: number): number {
  return total <= 0 ? 0 : Math.round((done / total) * 100)
}

export function effortLabel(effort: string | null): string {
  if (effort === null || effort.length === 0) return '-'
  return effort === 'standard' ? 'std' : effort
}

export function fit(value: string, max: number): string {
  if (max <= 0) return ''
  if (value.length <= max) return value
  return max === 1 ? '…' : `${value.slice(0, max - 1)}…`
}

export function baseName(path: string): string {
  const parts = path.split('/').filter(part => part.length > 0)
  return parts[parts.length - 1] ?? path
}

export const STATE_GLYPH: Readonly<Record<HarnessTaskState, string>> = {
  proposed: '○',
  advisor: '◇',
  running: '●',
  review: '◐',
  approved: '◆',
  verified: '✓',
  failed: '✗',
  needs_you: '?',
  done: '✓',
}

const TARGET_FIELD: Readonly<Record<string, string>> = {
  Read: 'file_path',
  Edit: 'file_path',
  Write: 'file_path',
  Glob: 'pattern',
}

export function describeTool(tool: string, input: Readonly<Record<string, unknown>>): string {
  const field = TARGET_FIELD[tool]
  if (field === undefined) return tool
  const target = text(input[field])
  return target === null ? tool : `${tool} ${fit(baseName(target.replace(/\s+/g, ' ')), 40)}`
}

export type ReviewPhase = {
  isOk: boolean
  status: string | null
  isTimedOut: boolean
} | null

export function reviewPhrase(isRunning: boolean, review: ReviewPhase): string {
  if (isRunning) return 'harness review running'
  if (review === null) return 'harness review pending'
  if (!review.isOk) return review.isTimedOut ? 'harness review: timed out' : 'harness review: failed'
  if (review.status === 'ready') return 'harness review pending'
  return `harness review: ${review.status ?? 'unknown'}`
}

export function roleLabel(role: HarnessRole, model: string | null, effort: string | null, writes: boolean): string {
  return `${role}/${shortModel(model)}${effort === null ? '' : `/${effort}`}${writes ? ' writes' : ''}`
}

export function consultLine(consult: HarnessConsult): string {
  const head = `  consult ${shortModel(consult.model)}${consult.effort === null ? '' : `/${consult.effort}`} read-only [${consult.state}]`
  if (consult.state === 'running') return `${head}${consult.agentId === undefined ? '' : ` agent ${consult.agentId}`}`
  if (consult.state === 'failed') return `${head}: ${consult.note ?? 'no recommendation'}`
  return `${head}, recommendation for you to weigh (you decide; run this task with harness_run taskId):\n${consult.report ?? ''}`
}

export function summarize(plan: HarnessPlan): string {
  const counts = countTasks(plan)
  const lines = [
    `Objective: ${plan.objective}`,
    `Advisor: ${plan.advisorModel.length > 0 ? plan.advisorModel : 'unknown'}`,
    `Tasks ${counts.settled}/${counts.total} settled, ${counts.approved} approved awaiting harness review, ${counts.running} running, ${counts.failed} failed, ${counts.needsYou} need you.`,
  ]
  for (const task of plan.tasks) {
    const label = roleLabel(task.role, task.model, task.effort, task.writes)
    const deps = task.deps.length === 0 ? '' : ` deps ${task.deps.join(',')}`
    const verdict = task.verdict === undefined ? '' : ` verdict ${task.verdict}`
    const agent = task.agentId === undefined ? '' : ` agent ${task.agentId}`
    lines.push(`${STATE_GLYPH[task.state]} ${task.id} [${task.state}] ${task.title} (${label})${deps}${verdict}${agent}`)
    if (task.consult !== undefined) lines.push(consultLine(task.consult))
  }
  return lines.join('\n')
}

export type SavedState = {
  plan: HarnessPlan
  workers: Record<string, HarnessWorkerRow>
  needsYou: HarnessHumanAsk[]
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseConsult(raw: unknown): HarnessConsult | undefined {
  if (!isRecord(raw)) return undefined
  const model = text(raw.model)
  const cliModel = text(raw.cliModel)
  const state = CONSULT_STATES.find(one => one === raw.state)
  if (model === null || cliModel === null || state === undefined) return undefined
  return {
    model,
    cliModel,
    effort: text(raw.effort),
    state,
    agentId: optionalString(raw.agentId),
    report: optionalString(raw.report),
    note: optionalString(raw.note),
  }
}

function parseTask(raw: unknown): HarnessTask | null {
  if (!isRecord(raw)) return null
  const id = text(raw.id)
  const title = text(raw.title)
  const role = TASK_ROLES.find(one => one === raw.role)
  const state = TASK_STATES.find(one => one === raw.state)
  if (id === null || title === null || role === undefined || state === undefined) return null
  const verdict = raw.verdict === 'APPROVE' || raw.verdict === 'CHANGES_REQUIRED' ? raw.verdict : undefined
  return {
    id,
    title,
    role,
    writes: flag(raw.writes),
    model: text(raw.model),
    effort: text(raw.effort),
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    deps: strings(raw.deps),
    paths: strings(raw.paths),
    checks: strings(raw.checks),
    state,
    review: flag(raw.review),
    reviewModel: text(raw.reviewModel),
    reviewStarting: flag(raw.reviewStarting) ? true : undefined,
    agentId: optionalString(raw.agentId),
    reviewAgentId: optionalString(raw.reviewAgentId),
    verdict,
    startedAt: optionalNumber(raw.startedAt),
    endedAt: optionalNumber(raw.endedAt),
    lastTool: optionalString(raw.lastTool),
    toolCount: optionalNumber(raw.toolCount) ?? 0,
    note: optionalString(raw.note),
    report: optionalString(raw.report),
    reviewReport: optionalString(raw.reviewReport),
    consult: parseConsult(raw.consult),
  }
}

function parseWorker(raw: unknown): HarnessWorkerRow | null {
  if (!isRecord(raw)) return null
  const taskId = text(raw.taskId)
  const agentId = text(raw.agentId)
  const role = TASK_ROLES.find(one => one === raw.role)
  const startedAt = optionalNumber(raw.startedAt)
  if (taskId === null || agentId === null || role === undefined || startedAt === undefined) return null
  return {
    taskId,
    agentId,
    role,
    writes: flag(raw.writes),
    model: text(raw.model),
    lastTool: text(raw.lastTool),
    toolCount: optionalNumber(raw.toolCount) ?? 0,
    startedAt,
  }
}

function parseAsk(raw: unknown): HarnessHumanAsk | null {
  if (!isRecord(raw)) return null
  const id = text(raw.id)
  const taskId = text(raw.taskId)
  const question = text(raw.question)
  const at = optionalNumber(raw.at)
  return id === null || taskId === null || question === null || at === undefined
    ? null
    : { id, taskId, question, at }
}

export function parseSaved(raw: unknown): SavedState | null {
  if (!isRecord(raw) || !isRecord(raw.plan) || !Array.isArray(raw.plan.tasks)) return null

  const tasks: HarnessTask[] = []
  for (const item of raw.plan.tasks) {
    const task = parseTask(item)
    if (task === null) return null
    tasks.push(task)
  }

  const workers: Record<string, HarnessWorkerRow> = {}
  if (isRecord(raw.workers)) {
    for (const item of Object.values(raw.workers)) {
      const row = parseWorker(item)
      if (row !== null) workers[row.agentId] = row
    }
  }

  const needsYou = Array.isArray(raw.needsYou)
    ? raw.needsYou.map(parseAsk).filter((ask): ask is HarnessHumanAsk => ask !== null)
    : []

  return {
    plan: {
      objective: typeof raw.plan.objective === 'string' ? raw.plan.objective : '',
      advisorModel: typeof raw.plan.advisorModel === 'string' ? raw.plan.advisorModel : '',
      roles: normalizeRoleTable(raw.plan.roles) ?? {},
      tasks,
      at: optionalNumber(raw.plan.at),
    },
    workers,
    needsYou,
  }
}
