import type { HookBudget, TurnStepChunk, TurnStepResult, TurnUsage } from 'claude-code'

export const HOOK_BUDGET_MS: HookBudget['ms'] = 10_000

export const ENGINE = {
  stepBudgetMs: 7_000,
  budgetMarginMs: 2_500,
  streamPollMs: 150,
  progressTool: 'codex_progress',
  handbackTool: 'SubagentHandback',
  bouncePrefix: '[handback-send-enforce]',
  reminderPrefix: '<system-reminder>',
  leaseStaleSeconds: 60,
} as const

export const PROGRESS_TOOL = 'mcp__harness__codex_progress'
export const AGENT_NAME = 'codex'
export const AGENT_TYPE = 'harness:codex'

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,63}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MODEL_PREFIX = 'codex-model:'
const NOTE_LIMIT = 100
const STAT_LIMIT = 2_000
const STDERR_LIMIT = 1_500
const GIT_TIMEOUT_MS = 120_000
const GIT_ENV_UNSET = ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY'] as const
const FILTER_KEY = /^filter\.(.+)\.(smudge|process|required)$/
const FOLLOW_UP_TEXT = 'harness:codex follow-ups are not supported yet. Spawn a new harness:codex agent for the next task.'
const DELIVERED_TEXT = 'Report delivered.'
const BASE_IDENTITY = {
  GIT_AUTHOR_NAME: 'codex-base',
  GIT_AUTHOR_EMAIL: 'codex-base@localhost',
  GIT_COMMITTER_NAME: 'codex-base',
  GIT_COMMITTER_EMAIL: 'codex-base@localhost',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
} as const

export const REFUSAL_PREFIX = 'harness:codex did not run:'

export const AGENT_DESCRIPTION =
  'Delegates one task to the Codex CLI in a throwaway copy of the session repository exported from HEAD (uncommitted work is absent from the copy). Use only when the user or the plan asks for Codex or a second opinion from another provider. Codex can change files in that copy only; the result is a patch file that is never applied. Reads are not restricted: Codex can read anything the user can. To choose the Codex model, make the first line of the prompt `codex-model: <id>`. Every genuine answer ends with a line `— answered by codex, <model>`. An answer WITHOUT that line did not come from Codex: the harness mod function hooks are not active; do not present it as Codex work.'

export const AGENT_PROMPT = [
  'If you are reading this, you are NOT Codex: the harness mod function hooks did not load, so this agent fell back to a Claude model.',
  'Do not attempt the task and do not use any tools. Reply with exactly this, and nothing else:',
  'The harness mod function hooks are not active, so Codex did not run this task. Enable function hooks (CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1) and restart Claude Code.',
].join('\n\n')

export const RUNNER = String.raw`run=$1; work=$2; repo=$3; max=$4; lease=$5; filt=$6; shift 6
trap 'true' TERM HUP INT
cd "$work" || exit 1
unset OLDPWD GIT_INDEX_FILE GIT_DIR GIT_WORK_TREE GIT_PREFIX GIT_COMMON_DIR GIT_OBJECT_DIRECTORY
for n in $(env | awk -F= -v p="$repo" '{ i = index($0, "="); v = substr($0, i + 1); if (v == p || index(v, p "/") == 1) print substr($0, 1, i - 1) }'); do
  case $n in
    ''|*[!A-Za-z0-9_]*) ;;
    *) unset "$n" ;;
  esac
done
PWD=$work; export PWD
TMPDIR=$run/tmp; export TMPDIR
[ -e "$lease" ] || : > "$lease"
exec 2>"$run/err"
( timeout --foreground -k 10 "$max" "$@" <"$run/prompt" | node -e "$filt" >"$run/events" ) &
pp=$!
ticks=0
limit=$((max + 10))
while kill -s 0 "$pp" 2>/dev/null; do
  ticks=$((ticks + 1))
  if [ "$ticks" -gt "$limit" ] || [ -z "$(find "$lease" -newermt '60 seconds ago' 2>/dev/null)" ]; then
    kill -s TERM -- "-$$"
    sleep 5
    kill -s KILL -- "-$$"
  fi
  sleep 1
done
kill -s KILL -- "-$$"
`

export const SCRIPTS = {
  start: String.raw`umask 077
nohup setsid sh "$@" >/dev/null 2>&1 </dev/null &
p=$!
st=$(sed 's/.*) //' "/proc/$p/stat" 2>/dev/null | cut -d' ' -f20)
if [ -z "$st" ]; then
  kill -s KILL -- "-$p" 2>/dev/null
  exit 1
fi
echo "$p"
echo "$st"`,
  write: 'umask 077; mkdir -p "$1" && cat > "$2"',
  mkdir: 'umask 077; mkdir -p "$1"',
  tail: String.raw`touch -- "$4" 2>/dev/null
s=$(ps -o stat= -p "$3" 2>/dev/null | tr -d ' ')
alive=1
case $s in
  ''|Z*) ;;
  *) alive=0 ;;
esac
tail -n +"$2" "$1" 2>/dev/null
[ $alive = 0 ] || printf '\n{"type":"harness.exited"}\n'`,
  kill: String.raw`case $1 in
  ''|*[!0-9]*|0|1) echo gone; exit 0 ;;
esac
live() { ps -e -o pgid=,stat= 2>/dev/null | awk -v g="$1" '$1 == g && $2 !~ /^Z/ { f = 1 } END { exit !f }'; }
live "$1" || { echo gone; exit 0; }
if [ -e "/proc/$1" ]; then
  pg=$(ps -o pgid= -p "$1" 2>/dev/null | tr -d ' ')
  st=$(sed 's/.*) //' "/proc/$1/stat" 2>/dev/null | cut -d' ' -f20)
  [ -n "$3" ] && [ "$pg" = "$1" ] && [ "$st" = "$3" ] || { echo gone; exit 0; }
else
  [ -n "$4" ] || { echo gone; exit 0; }
  root=$(cd "$4" 2>/dev/null && pwd -P) || { echo gone; exit 0; }
  own=1
  for m in $(ps -e -o pid=,pgid= 2>/dev/null | awk -v g="$1" '$2 == g { print $1 }'); do
    c=$(readlink "/proc/$m/cwd" 2>/dev/null)
    case $c in
      "$root"|"$root"/*) own=0 ;;
    esac
  done
  [ "$own" = 0 ] || { echo gone; exit 0; }
fi
polls=$2
[ -n "$polls" ] || polls=20
kill -s TERM -- "-$1" 2>/dev/null
i=0
while [ "$i" -lt "$polls" ]; do
  live "$1" || { echo gone; exit 0; }
  sleep 0.25
  i=$((i + 1))
done
kill -s KILL -- "-$1" 2>/dev/null
i=0
while [ "$i" -lt 20 ]; do
  live "$1" || { echo gone; exit 0; }
  sleep 0.25
  i=$((i + 1))
done
echo alive`,
  stderr: 'tail -c 4000 "$1" 2>/dev/null',
  remove: 'rm -rf -- "$1"',
  copy: 'rm -rf -- "$2" && cp -a -- "$1" "$2"',
  rollout: 'base=${CODEX_HOME:-$HOME/.codex}; f=$(find "$base/sessions" -name "rollout-*-$1.jsonl" -print -quit 2>/dev/null); [ -n "$f" ] && grep -m1 turn_context "$f"',
} as const

export const FILTER = String.raw`
const rl = require('readline').createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let e
  try { e = JSON.parse(line) } catch { return }
  const it = e && e.item
  if (it && typeof it.aggregated_output === 'string' && it.aggregated_output.length > 200) it.aggregated_output = it.aggregated_output.slice(0, 200)
  if (it && Array.isArray(it.changes) && it.changes.length > 20) it.changes = it.changes.slice(0, 20)
  const out = JSON.stringify(e)
  process.stdout.write((out.length > 100000 ? JSON.stringify({ type: 'harness.dropped' }) : out) + '\n')
})
`

export type CodexEvent =
  | { k: 'thread'; id: string }
  | { k: 'model'; model: string }
  | { k: 'text'; t: string }
  | { k: 'thinking'; t: string }
  | { k: 'note'; t: string }
  | { k: 'usage'; i: number; o: number; cr: number; cw: number }
  | { k: 'error'; t: string }
  | { k: 'failed' }
  | { k: 'end' }
  | { k: 'exited' }

export type Piece = { kind: 'text' | 'thinking'; text: string }

export type Usage = { i: number; o: number; cr: number; cw: number }

export type Workspace = {
  root: string
  dir: string
  work: string
  tmp: string
  pristine: string
  repo: string
  head: string
  base: string
  patch: string
}

export type Run = {
  id: number
  pid: string
  start: string
  events: string
  errors: string
  lease: string
  read: number
  steps: number
  ended: boolean
  failed: boolean
  aborted: boolean
  pending: string | null
  report: string
  problems: string[]
  thread: string
  model: string
  requested: string | null
  usage: Usage
  ws: Workspace
  note: string | null
}

export type AgentState = {
  prompt: string
  cwd: string | null
  runs: number
  deliveries: number
  run: Run | null
  delivered: string | null
  lastReport: string
  trusted?: string
  used: boolean
}

export type ParsedPrompt = { prompt: string; model?: string; rejected?: string }

export type StateEnv = {
  stateDir?: string
  pluginId?: string
  pluginStateDir?: string
  home?: string
  testGuard?: string
  aiHarnessTestGuard?: string
  generatedDir?: string
}

export type RunInit = { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number }

export type RunResult = { exitCode: number; stdout: string; stderr: string }

export type Ports = {
  run: (argv: readonly string[], init?: RunInit) => Promise<RunResult>
  now: () => Promise<number>
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
  cwd: () => Promise<string>
  env: () => Promise<StateEnv>
  readText: (path: string) => Promise<string>
  exists: (path: string) => Promise<boolean>
  userTexts: (agentId: string) => Promise<string[] | null>
  agentType: (agentId: string) => Promise<string | undefined>
  loadState: (agentId: string) => Promise<AgentState | null>
  saveState: (agentId: string, state: AgentState | null) => Promise<void>
  sessionAgents: () => Promise<string[]>
  notify: (text: string) => void
}

export type External = {
  progressTool: string
  agentRegistered: boolean
  maxMinutes: number
  tail: Promise<void>
  others: Set<string>
  settled: Map<string, string>
}

export function createExternal(maxMinutes = 30): External {
  return { progressTool: PROGRESS_TOOL, agentRegistered: false, maxMinutes, tail: Promise.resolve(), others: new Set(), settled: new Map() }
}

export function maxMinutesOf(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n >= 1 && n <= 720 ? Math.floor(n) : 30
}

async function exclusive<T>(ext: External, work: () => Promise<T>): Promise<T> {
  const run = ext.tail.then(work)
  ext.tail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

export function parseModelLine(text: string): ParsedPrompt {
  const lines = text.split('\n')
  let at = 0
  while (at < lines.length && (lines[at] ?? '').trim() === '') at += 1
  const head = (lines[at] ?? '').trimStart()
  if (head.slice(0, MODEL_PREFIX.length).toLowerCase() !== MODEL_PREFIX) return { prompt: text }
  const value = head.slice(MODEL_PREFIX.length).trim()
  const prompt = lines.slice(at + 1).join('\n').trim()
  if (value.length > 64 || !MODEL_ID.test(value)) return { prompt, rejected: value.slice(0, 80) }
  return { prompt, model: value }
}

export function isCodexType(subagentType: string): boolean {
  return subagentType === AGENT_TYPE
}

export type SpawnFacts = {
  subagentType: string
  permissionMode?: string
  parentAgentId?: string
  isTeammate?: boolean
  workflow?: unknown
  fork?: boolean
}

export function spawnDenial(facts: SpawnFacts, enabled: boolean): string | null {
  if (!isCodexType(facts.subagentType)) return null
  if (!enabled) return 'harness:codex is disabled. Enable the codex option of the harness mod to use it.'
  if (facts.permissionMode === 'plan') return 'harness:codex can change files and is refused in plan mode.'
  if (facts.parentAgentId !== undefined) return 'harness:codex can only be started from the main session.'
  if (facts.isTeammate === true) return 'harness:codex cannot run as a teammate.'
  if (facts.workflow !== undefined) return 'harness:codex cannot be started by a workflow.'
  if (facts.fork === true) return 'harness:codex cannot be forked.'
  return null
}

export function agentSpec(progressTool: string) {
  return {
    name: AGENT_NAME,
    description: AGENT_DESCRIPTION,
    prompt: AGENT_PROMPT,
    model: 'haiku',
    tools: [progressTool, ENGINE.handbackTool],
  }
}

export const PROGRESS_DESCRIPTION = 'Internal to harness:codex agents: marks a Codex run still in progress. Never call it.'

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function plainError(message: string): string {
  try {
    const body = asRecord(JSON.parse(message))
    const detail = body?.detail ?? body?.message
    if (typeof detail === 'string' && detail.trim() !== '') return detail.trim()
  } catch {
    return message.trim()
  }
  return message.trim()
}

function commandNote(command: string): string {
  const bare = command
    .replace(/^(?:\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+/, '')
    .replace(/^(['"])([\s\S]*)\1$/, '$2')
    .replace(/\s+/g, ' ')
    .trim()
  return `▸ ${clip(bare, NOTE_LIMIT)}`
}

function changesNote(changes: unknown): string | undefined {
  if (!Array.isArray(changes) || changes.length === 0) return undefined
  const shown = changes.slice(0, 3).flatMap(change => {
    const one = asRecord(change)
    return typeof one?.path === 'string' ? [`${typeof one.kind === 'string' ? one.kind : 'change'} ${one.path}`] : []
  })
  if (shown.length === 0) return undefined
  const more = changes.length > shown.length ? ` +${changes.length - shown.length} more` : ''
  return `▸ ${clip(shown.join(', '), NOTE_LIMIT)}${more}`
}

export function mapCodexLine(line: string): CodexEvent[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return []
  }
  const event = asRecord(parsed)
  if (event === undefined || typeof event.type !== 'string') return []
  const found: CodexEvent[] = []
  if (typeof event.model === 'string' && event.model !== '') found.push({ k: 'model', model: event.model })

  if (event.type === 'thread.started') {
    if (typeof event.thread_id === 'string') found.push({ k: 'thread', id: event.thread_id })
    return found
  }
  if (event.type === 'turn.completed') {
    const usage = asRecord(event.usage)
    const cached = num(usage?.cached_input_tokens)
    found.push({
      k: 'usage',
      i: Math.max(0, num(usage?.input_tokens) - cached),
      o: num(usage?.output_tokens),
      cr: cached,
      cw: num(usage?.cache_write_input_tokens),
    })
    found.push({ k: 'end' })
    return found
  }
  if (event.type === 'turn.failed') {
    const message = asRecord(event.error)?.message
    if (typeof message === 'string') found.push({ k: 'error', t: plainError(message) })
    found.push({ k: 'failed' })
    found.push({ k: 'end' })
    return found
  }
  if (event.type === 'error') {
    if (typeof event.message === 'string') found.push({ k: 'error', t: plainError(event.message) })
    return found
  }
  if (event.type === 'harness.exited') {
    found.push({ k: 'exited' })
    return found
  }

  const item = asRecord(event.item)
  if (item === undefined || typeof item.type !== 'string') return found
  if (event.type === 'item.completed' && item.type === 'agent_message' && typeof item.text === 'string') {
    found.push({ k: 'text', t: item.text })
  } else if (event.type === 'item.completed' && item.type === 'reasoning' && typeof item.text === 'string') {
    found.push({ k: 'thinking', t: item.text })
  } else if (event.type === 'item.started' && item.type === 'command_execution' && typeof item.command === 'string') {
    found.push({ k: 'note', t: commandNote(item.command) })
  } else if (event.type === 'item.started' && item.type === 'file_change') {
    const note = changesNote(item.changes)
    if (note !== undefined) found.push({ k: 'note', t: note })
  }
  return found
}

function withNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`
}

function flushPending(run: Run): Piece[] {
  if (run.pending === null) return []
  const text = withNewline(run.pending)
  run.pending = null
  return [{ kind: 'text', text }]
}

export function advance(run: Run, event: CodexEvent): Piece[] {
  if (event.k === 'thread') {
    run.thread = event.id
    return []
  }
  if (event.k === 'model') {
    run.model = event.model
    return []
  }
  if (event.k === 'usage') {
    run.usage.i += event.i
    run.usage.o += event.o
    run.usage.cr += event.cr
    run.usage.cw += event.cw
    return []
  }
  if (event.k === 'error') {
    if (!run.problems.includes(event.t)) run.problems.push(event.t)
    return []
  }
  if (event.k === 'failed') {
    run.failed = true
    return []
  }
  if (event.k === 'end' || event.k === 'exited') {
    if (run.pending !== null) {
      run.report = run.pending
      run.pending = null
    }
    run.ended = true
    return []
  }
  if (event.k === 'text') {
    const flushed = flushPending(run)
    run.pending = event.t
    return flushed
  }
  if (event.k === 'thinking') {
    return [...flushPending(run), { kind: 'thinking', text: withNewline(event.t) }]
  }
  return [...flushPending(run), { kind: 'text', text: withNewline(event.t) }]
}

export function takeUsage(run: Run): TurnUsage | null {
  if (!run.model) return null
  const { i, o, cr, cw } = run.usage
  run.usage = { i: 0, o: 0, cr: 0, cw: 0 }
  return {
    model: run.model,
    input_tokens: i,
    output_tokens: o,
    cache_read_input_tokens: cr,
    cache_creation_input_tokens: cw,
  }
}

export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '')
}

export function failureText(run: Run, stderr: string): string {
  const detail = [...run.problems, stderr.trim()].filter(part => part !== '').join('\n')
  return `Codex ended with no answer.\n${detail || '(no stderr; it may have reached the run time limit)'}`
}

export function signature(run: { model: string; requested: string | null }): string {
  if (run.model) return `— answered by codex, ${run.model}`
  if (run.requested) return `— answered by codex, requested ${run.requested}, unconfirmed`
  return '— answered by codex, unknown model'
}

export function composeReport(parts: { answer: string; failure: string; notes: string; footer: string; signature: string }): string {
  const body = [parts.failure || parts.answer, parts.notes, parts.footer].filter(part => part !== '').join('\n\n')
  return parts.failure ? body : `${body}\n\n${parts.signature}`
}

export function budgetFor(remainingMs: number): number {
  if (!Number.isFinite(remainingMs)) return ENGINE.stepBudgetMs
  return Math.max(0, Math.min(ENGINE.stepBudgetMs, remainingMs - ENGINE.budgetMarginMs))
}

export function codexArgv(work: string, tmp: string, model: string | undefined): string[] {
  return [
    'codex',
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '-C',
    work,
    '-s',
    'workspace-write',
    '-c',
    'sandbox_workspace_write.exclude_slash_tmp=true',
    '-c',
    'sandbox_workspace_write.exclude_tmpdir_env_var=true',
    '-c',
    'sandbox_workspace_write.network_access=false',
    '-c',
    'sandbox_workspace_write.writable_roots=[]',
    '--add-dir',
    tmp,
    ...(model === undefined ? [] : ['-m', model]),
    '-',
  ]
}

function shortId(agentId: string): string {
  return agentId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'agent'
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/')
}

function normalizePath(path: string): string {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

function expandHome(value: string, home: string): string {
  if (value === '~') return home
  return value.startsWith('~/') ? `${home}/${value.slice(2)}` : value
}

function absoluteDir(value: string | undefined, home: string, cwd: string): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  const expanded = expandHome(trimmed, home)
  return normalizePath(isAbsolutePath(expanded) ? expanded : `${cwd}/${expanded}`)
}

export async function stateDirOf(ports: Pick<Ports, 'env' | 'readText' | 'cwd'>): Promise<string> {
  const env = await ports.env()
  const home = env.home?.trim() || '/root'
  const cwd = await ports.cwd()
  const explicit = absoluteDir(env.stateDir, home, cwd)
  if (explicit !== undefined) return explicit
  const isForeignPlugin = Boolean(env.pluginId && env.pluginId !== 'herdr-jev')
  const plugin = isForeignPlugin ? undefined : absoluteDir(env.pluginStateDir, home, cwd)
  if (plugin !== undefined) return plugin
  if (env.testGuard === '1' || env.aiHarnessTestGuard === '1') throw new Error('state_dir_required_in_tests')
  const legacy = `${env.home?.trim() || home}/.local/state/herdr-jev`
  const generated = env.generatedDir?.trim() || `${home}/.local/share/ai-harness/generated`
  try {
    const raw = await ports.readText(`${generated}/tool-env.json`)
    const entry = asRecord(asRecord(asRecord(JSON.parse(raw))?.tools)?.['herdr-jev'])
    const value = typeof entry?.stateDir === 'string' ? expandHome(entry.stateDir.trim(), home) : ''
    if (value && isAbsolutePath(value) && value !== legacy) return value
  } catch {
    return legacy
  }
  return legacy
}

export function gitArgv(args: readonly string[], options: { env?: Record<string, string>; isolated?: boolean } = {}): string[] {
  const unset = GIT_ENV_UNSET.flatMap(name => ['-u', name])
  const isolation = options.isolated ? { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } : {}
  const set = Object.entries({ ...isolation, ...(options.env ?? {}) }).map(([key, value]) => `${key}=${value}`)
  return ['sh', '-c', 'umask 077; exec "$@"', 'sh', 'env', ...unset, ...set, 'git', '-c', 'core.hooksPath=/dev/null', ...args]
}

type GitResult = { ok: boolean; out: string; err: string; code: number }

async function git(
  ports: Ports,
  args: readonly string[],
  options: { env?: Record<string, string>; isolated?: boolean } = {},
): Promise<GitResult> {
  try {
    const result = await ports.run(gitArgv(args, options), { timeoutMs: GIT_TIMEOUT_MS })
    return { ok: result.exitCode === 0, out: result.stdout.trim(), err: result.stderr.trim(), code: result.exitCode }
  } catch (error) {
    return { ok: false, out: '', err: error instanceof Error ? error.message : String(error), code: -1 }
  }
}

export function filterDrivers(names: string): string[] {
  const found = new Set<string>()
  for (const line of names.split('\n')) {
    const driver = FILTER_KEY.exec(line.trim())?.[1]
    if (driver) found.add(driver)
  }
  return [...found]
}

export function filterOverrides(drivers: readonly string[]): string[] {
  return drivers.flatMap(name => [
    '-c',
    `filter.${name}.smudge=`,
    '-c',
    `filter.${name}.process=`,
    '-c',
    `filter.${name}.required=false`,
  ])
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

async function runSh(ports: Ports, script: string, args: readonly string[], init: RunInit = {}): Promise<RunResult> {
  return ports.run(['sh', '-c', script, 'sh', ...args], init)
}

function insideRuns(ws: Pick<Workspace, 'root' | 'dir'>): boolean {
  return ws.dir.startsWith(`${ws.root}/codex-runs/`) && !ws.dir.split('/').includes('..') && ws.dir.length > ws.root.length + 12
}

async function removeDir(ports: Ports, ws: Pick<Workspace, 'root' | 'dir'>): Promise<void> {
  if (!insideRuns(ws)) return
  await runSh(ports, SCRIPTS.remove, [ws.dir]).catch(() => undefined)
}

export type Exported = { ok: true; ws: Workspace } | { ok: false; reason: string }

export async function exportTree(ports: Ports, cwd: string, agentId: string, nonce: string): Promise<Exported> {
  const top = await git(ports, ['-C', cwd, 'rev-parse', '--show-toplevel'])
  if (!top.ok || top.out === '') {
    return { ok: false, reason: `${cwd} is not inside a git repository. Codex needs one to export a copy from.` }
  }
  const head = await git(ports, ['-C', top.out, 'rev-parse', '--verify', 'HEAD'])
  if (!head.ok || head.out === '') {
    return { ok: false, reason: `${top.out} has no commit to export (git rev-parse HEAD failed).` }
  }
  let root: string
  try {
    root = await stateDirOf(ports)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  let dir = `${root}/codex-runs/${shortId(agentId)}-${nonce}`
  try {
    if (await ports.exists(dir)) dir = `${dir}-2`
  } catch {
    dir = `${dir}-2`
  }
  const ws: Workspace = {
    root,
    dir,
    work: `${dir}/work`,
    tmp: `${dir}/tmp`,
    pristine: `${dir}/pristine.git`,
    repo: top.out,
    head: head.out,
    base: '',
    patch: `${root}/codex-patches/${shortId(agentId)}-${nonce}.patch`,
  }
  const fail = async (reason: string): Promise<Exported> => {
    await removeDir(ports, ws)
    return { ok: false, reason }
  }
  try {
    const made = await runSh(ports, SCRIPTS.mkdir, [ws.work])
    const tmp = await runSh(ports, SCRIPTS.mkdir, [ws.tmp])
    if (made.exitCode !== 0 || tmp.exitCode !== 0) return await fail(`could not create ${ws.dir}`)
    const names = await git(ports, ['-C', top.out, 'config', '--name-only', '--get-regexp', '^filter\\..+\\.(smudge|process|required)$'])
    const drivers = filterDrivers(names.out)
    const index = { GIT_INDEX_FILE: `${ws.dir}/export.index` }
    const read = await git(ports, ['-C', top.out, 'read-tree', head.out], { env: index })
    if (!read.ok) return await fail(`git read-tree failed: ${clip(read.err || 'no output', 300)}`)
    const checkout = await git(
      ports,
      ['-C', top.out, '-c', 'core.autocrlf=false', ...filterOverrides(drivers), 'checkout-index', '-a', '-f', `--prefix=${ws.work}/`],
      { env: index },
    )
    if (!checkout.ok) return await fail(`git checkout-index failed: ${clip(checkout.err || 'no output', 300)}`)
    const init = await git(ports, ['init', '-q', '--template=', ws.work], { isolated: true })
    if (!init.ok) return await fail(`git init failed: ${clip(init.err || 'no output', 300)}`)
    const add = await git(ports, ['-C', ws.work, 'add', '-A', '-f'], { isolated: true })
    if (!add.ok) return await fail(`git add failed: ${clip(add.err || 'no output', 300)}`)
    const commit = await git(
      ports,
      ['-C', ws.work, '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '--no-verify', '-m', 'codex-base'],
      { isolated: true, env: BASE_IDENTITY },
    )
    if (!commit.ok) return await fail(`git commit failed: ${clip(commit.err || 'no output', 300)}`)
    const base = await git(ports, ['-C', ws.work, 'rev-parse', '--verify', 'HEAD'], { isolated: true })
    if (!base.ok || base.out === '') return await fail('could not read the exported commit')
    ws.base = base.out
    const saved = await runSh(ports, SCRIPTS.copy, [`${ws.work}/.git`, ws.pristine])
    if (saved.exitCode !== 0) return await fail('could not keep a pristine copy of the exported git directory')
    await runSh(ports, SCRIPTS.remove, [index.GIT_INDEX_FILE]).catch(() => undefined)
    return { ok: true, ws }
  } catch (error) {
    return await fail(error instanceof Error ? error.message : String(error))
  }
}

async function killGroup(ports: Ports, run: Pick<Run, 'pid' | 'start' | 'ws'>, polls = 20): Promise<boolean> {
  try {
    const result = await runSh(ports, SCRIPTS.kill, [run.pid, String(polls), run.start ?? '', run.ws.work], { timeoutMs: 30_000 })
    return result.stdout.trim().split('\n').at(-1) === 'gone'
  } catch {
    return false
  }
}

export async function settleWorkspace(ports: Ports, ext: External, ws: Workspace): Promise<string> {
  return exclusive(ext, async () => {
    const kept = (why: string) =>
      `Could not build the patch (${clip(why, 200)}). The throwaway copy was kept at ${ws.dir}; nothing was applied to ${ws.repo}.`
    const already = ext.settled.get(ws.dir)
    if (already !== undefined) return already
    if (!insideRuns(ws)) return kept('the run directory is outside the state directory')
    const restored = await runSh(ports, SCRIPTS.copy, [ws.pristine, `${ws.work}/.git`])
    if (restored.exitCode !== 0) return kept('could not restore the pristine git directory')
    const add = await git(ports, ['-C', ws.work, 'add', '-A', '-f'], { isolated: true })
    if (!add.ok) return kept(add.err || 'git add failed')
    const stat = await git(ports, ['-C', ws.work, 'diff', '--cached', '--stat', '--no-ext-diff', ws.base], { isolated: true })
    if (!stat.ok) return kept(stat.err || 'git diff failed')
    if (stat.out === '') {
      await removeDir(ports, ws)
      const none = 'Codex made no changes; the throwaway copy was removed.'
      ext.settled.set(ws.dir, none)
      return none
    }
    const made = await runSh(ports, SCRIPTS.mkdir, [ws.patch.slice(0, ws.patch.lastIndexOf('/'))])
    if (made.exitCode !== 0) return kept('could not create the patch directory')
    const patch = await git(
      ports,
      ['-C', ws.work, 'diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', `--output=${ws.patch}`, ws.base],
      { isolated: true },
    )
    if (!patch.ok) return kept(patch.err || 'git diff --binary failed')
    await removeDir(ports, ws)
    const report = [
      `Patch (mode 0600): ${ws.patch}`,
      `Check it first with: git -C ${quote(ws.repo)} apply --stat --check ${quote(ws.patch)}`,
      `Then apply it with: git -C ${quote(ws.repo)} apply ${quote(ws.patch)}`,
      `The patch was computed against HEAD ${ws.head.slice(0, 7)}; uncommitted work was not in the copy and is excluded. It may add files and symlinks, so read the --stat output before applying. Nothing was applied to ${ws.repo}.`,
      `git diff --stat:\n${clip(stat.out, STAT_LIMIT)}`,
    ].join('\n')
    ext.settled.set(ws.dir, report)
    return report
  })
}

export async function stopAndSettle(ports: Ports, ext: External, run: Run, polls = 20): Promise<string> {
  const stopped = await killGroup(ports, run, polls)
  if (!stopped) {
    return `Codex could not be stopped (process group ${run.pid}). Its copy was left untouched at ${run.ws.dir}. Stop it with: kill -s KILL -- -${run.pid}`
  }
  try {
    return await settleWorkspace(ports, ext, run.ws)
  } catch (error) {
    return `Settling the copy failed (${clip(error instanceof Error ? error.message : String(error), 200)}). It was left at ${run.ws.dir}.`
  }
}

class Stream {
  index = -1;
  kind: 'text' | 'thinking' | 'tool' | undefined;
  shown = '';

  *write(kind: 'text' | 'thinking', text: string): Generator<TurnStepChunk> {
    if (this.kind !== kind) {
      this.kind = kind
      this.index += 1
    }
    if (kind === 'text') this.shown += text
    yield { kind, index: this.index, text }
  }

  *block(text: string): Generator<TurnStepChunk> {
    this.kind = undefined
    yield* this.write('text', text)
  }

  *tool(id: string, name: string, input: unknown): Generator<TurnStepChunk> {
    this.index += 1
    this.kind = 'tool'
    yield { kind: 'tool', index: this.index, id, name }
    yield { kind: 'input', index: this.index, json: JSON.stringify(input) }
  }

  result(e: StepInput, toolUses: TurnStepResult['toolUses'], stopReason: 'end_turn' | 'tool_use', usage: TurnUsage | null): TurnStepResult {
    return { turnId: e.turnId, index: e.index, answer: this.shown, toolUses, stopReason, usage }
  }
}

export type StepInput = { turnId: string; index: number; agentId?: string }

export function handbackFacts(userTexts: readonly string[]): { handback: boolean; bounced: boolean } {
  const later = userTexts.slice(1)
  const engine = later.filter(text => {
    const head = text.trimStart()
    return head.startsWith(ENGINE.reminderPrefix) || head.startsWith(ENGINE.bouncePrefix)
  })
  return {
    handback: engine.some(text => text.includes(ENGINE.handbackTool)),
    bounced: later.at(-1)?.trimStart().startsWith(ENGINE.bouncePrefix) ?? false,
  }
}

async function inspectHandback(ports: Ports, agentId: string): Promise<{ handback: boolean; bounced: boolean }> {
  try {
    const users = await ports.userTexts(agentId)
    return users === null ? { handback: false, bounced: false } : handbackFacts(users)
  } catch {
    return { handback: false, bounced: false }
  }
}

async function readNew(ports: Ports, run: Run): Promise<string[]> {
  const { stdout } = await runSh(ports, SCRIPTS.tail, [run.events, String(run.read + 1), run.pid, run.lease])
  const lines = stdout.split('\n')
  lines.pop()
  return lines
}

async function stderrTail(ports: Ports, run: Run): Promise<string> {
  try {
    const { stdout } = await runSh(ports, SCRIPTS.stderr, [run.errors])
    return clip(stripAnsi(stdout).trim().split('\n').slice(-12).join('\n'), STDERR_LIMIT)
  } catch {
    return ''
  }
}

async function rolloutModel(ports: Ports, run: Run): Promise<void> {
  if (run.model || !UUID.test(run.thread)) return
  try {
    const { stdout } = await runSh(ports, SCRIPTS.rollout, [run.thread])
    const context = asRecord(asRecord(JSON.parse(stdout.trim().split('\n')[0] ?? ''))?.payload)
    if (typeof context?.model === 'string' && MODEL_ID.test(context.model)) run.model = context.model
  } catch {
    return
  }
}

type Launched = { ok: true; run: Run } | { ok: false; reason: string }

async function launch(ports: Ports, ext: External, agentId: string, state: AgentState, parsed: ParsedPrompt): Promise<Launched> {
  if (parsed.rejected !== undefined) {
    return {
      ok: false,
      reason: `the codex-model line "${clip(parsed.rejected, 60)}" is not an accepted model id (letters, digits and _ . : / @ + -, up to 64 characters, not starting with a symbol).`,
    }
  }
  if (parsed.prompt.trim() === '') return { ok: false, reason: 'the prompt is empty.' }
  if (ext.progressTool === '') return { ok: false, reason: 'the progress tool is not registered, so a run could not span several steps.' }
  const cwd = state.cwd ?? (await ports.cwd())
  const id = state.runs + 1
  const nonce = (await ports.now()).toString(36)
  const exported = await exclusive(ext, () => exportTree(ports, cwd, agentId, nonce))
  if (!exported.ok) return { ok: false, reason: exported.reason }
  const ws = exported.ws
  const run: Run = {
    id,
    pid: '',
    start: '',
    events: `${ws.dir}/events`,
    errors: `${ws.dir}/err`,
    lease: `${ws.dir}/lease`,
    read: 0,
    steps: 0,
    ended: false,
    failed: false,
    aborted: false,
    pending: null,
    report: '',
    problems: [],
    thread: '',
    model: '',
    requested: parsed.model ?? null,
    usage: { i: 0, o: 0, cr: 0, cw: 0 },
    ws,
    note: null,
  }
  const abandon = async (reason: string): Promise<Launched> => {
    await exclusive(ext, () => removeDir(ports, ws))
    return { ok: false, reason }
  }
  try {
    const wrote = await runSh(ports, SCRIPTS.write, [ws.dir, `${ws.dir}/prompt`], { stdin: parsed.prompt })
    const script = await runSh(ports, SCRIPTS.write, [ws.dir, `${ws.dir}/runner.sh`], { stdin: RUNNER })
    const lease = await runSh(ports, SCRIPTS.write, [ws.dir, run.lease], { stdin: '' })
    if (wrote.exitCode !== 0 || script.exitCode !== 0 || lease.exitCode !== 0) return await abandon('could not write the run files')
    const started = await runSh(ports, SCRIPTS.start, [
      `${ws.dir}/runner.sh`,
      ws.dir,
      ws.work,
      ws.repo,
      String(ext.maxMinutes * 60),
      run.lease,
      FILTER,
      ...codexArgv(ws.work, ws.tmp, parsed.model),
    ])
    const [pid = '', start = ''] = started.stdout.trim().split('\n')
    run.pid = pid.trim()
    run.start = start.trim()
  } catch (error) {
    return await abandon(`Codex could not be started: ${clip(error instanceof Error ? error.message : String(error), 200)}`)
  }
  if (!/^\d+$/.test(run.pid) || !/^\d+$/.test(run.start)) return await abandon('Codex could not be started: no process id came back.')
  return { ok: true, run }
}

async function* pump(
  ports: Ports,
  ext: External,
  run: Run,
  stream: Stream,
  signal: AbortSignal,
  remaining: () => number,
): AsyncGenerator<TurnStepChunk, void> {
  let finished = false
  let crashed = ''
  try {
    const deadline = (await ports.now()) + budgetFor(remaining())
    while (
      !run.ended &&
      !signal.aborted &&
      (await ports.now()) < deadline &&
      remaining() > ENGINE.budgetMarginMs
    ) {
      for (const line of await readNew(ports, run)) {
        run.read += 1
        for (const event of mapCodexLine(line)) {
          for (const piece of advance(run, event)) yield* stream.write(piece.kind, piece.text)
        }
      }
      if (!run.ended) await ports.sleep(ENGINE.streamPollMs, signal)
    }
    finished = true
  } catch (error) {
    if (!signal.aborted) crashed = `the Codex stream failed: ${clip(error instanceof Error ? error.message : String(error), 200)}`
    finished = !signal.aborted
  } finally {
    if (!run.ended && (!finished || signal.aborted)) {
      run.aborted = true
      run.ended = true
      run.note = await stopAndSettle(ports, ext, run, 8).catch(() => 'Codex was stopped.')
      ports.notify(`harness:codex stopped. ${run.note}`)
    }
  }
  if (crashed !== '') {
    run.problems.push(crashed)
    run.failed = true
    run.ended = true
  }
}

async function* conclude(
  ports: Ports,
  e: StepInput,
  agentId: string,
  state: AgentState,
  stream: Stream,
  report: string,
  usage: TurnUsage | null,
  forced: boolean,
): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  state.lastReport = report
  yield* stream.block(report)
  const handback = forced || (await inspectHandback(ports, agentId)).handback
  if (!handback) {
    yield { kind: 'stop', stopReason: 'end_turn', usage }
    return stream.result(e, [], 'end_turn', usage)
  }
  state.delivered = DELIVERED_TEXT
  state.deliveries += 1
  const id = `toolu_codex_${agentId.replace(/[^A-Za-z0-9_]/g, '_')}_${ENGINE.handbackTool}_${state.deliveries}`
  const input = { message: report }
  yield* stream.tool(id, ENGINE.handbackTool, input)
  yield { kind: 'stop', stopReason: 'tool_use', usage }
  return stream.result(e, [{ name: ENGINE.handbackTool, input }], 'tool_use', usage)
}

async function* refuse(e: StepInput, stream: Stream, state: AgentState | null, reason: string): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  const text = `${REFUSAL_PREFIX} ${reason}`
  if (state !== null) state.lastReport = text
  yield* stream.block(text)
  yield { kind: 'stop', stopReason: 'end_turn', usage: null }
  return stream.result(e, [], 'end_turn', null)
}

async function* drive(
  ports: Ports,
  ext: External,
  e: StepInput,
  agentId: string,
  state: AgentState,
  stream: Stream,
  signal: AbortSignal,
  remaining: () => number,
): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  if (state.delivered !== null) {
    const text = state.delivered
    state.delivered = null
    yield* stream.block(text)
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return stream.result(e, [], 'end_turn', null)
  }

  if (state.run === null) {
    if (state.used) {
      const { bounced } = await inspectHandback(ports, agentId)
      if (bounced && state.lastReport !== '') return yield* conclude(ports, e, agentId, state, stream, state.lastReport, null, true)
      return yield* refuse(e, stream, state, FOLLOW_UP_TEXT)
    }
    state.used = true
    const launched = await launch(ports, ext, agentId, state, parseModelLine(state.prompt))
    if (!launched.ok) return yield* refuse(e, stream, state, launched.reason)
    state.runs += 1
    state.run = launched.run
    await ports.saveState(agentId, state)
  }

  const run = state.run
  yield* pump(ports, ext, run, stream, signal, remaining)

  if (run.aborted) {
    state.run = null
    state.lastReport = run.note ?? ''
    state.trusted = run.note ?? ''
    if (run.note) yield* stream.block(run.note)
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return stream.result(e, [], 'end_turn', null)
  }

  if (!run.ended) {
    const input = {}
    const id = `toolu_codex_${agentId.replace(/[^A-Za-z0-9_]/g, '_')}_${run.id}_${run.steps}`
    run.steps += 1
    yield* stream.tool(id, ext.progressTool, input)
    const usage = takeUsage(run)
    yield { kind: 'stop', stopReason: 'tool_use', usage }
    return stream.result(e, [{ name: ext.progressTool, input }], 'tool_use', usage)
  }

  const answer = run.report.trim()
  const stderr = await stderrTail(ports, run)
  await rolloutModel(ports, run)
  const footer = await stopAndSettle(ports, ext, run)
  state.run = null
  const failure = answer === '' ? failureText(run, stderr) : ''
  const notes = answer !== '' && run.failed && run.problems.length > 0 ? `Codex reported an error after this answer: ${run.problems.join(' ')}` : ''
  const report = composeReport({ answer, failure, notes, footer, signature: signature(run) })
  state.trusted = failure ? footer : `${footer}\n\n${signature(run)}`
  return yield* conclude(ports, e, agentId, state, stream, report, takeUsage(run), false)
}

export async function externalRole(ports: Ports, ext: External, agentId: string): Promise<'codex' | 'other'> {
  if (ext.others.has(agentId)) return 'other'
  try {
    if ((await ports.loadState(agentId)) !== null) return 'codex'
    const type = await ports.agentType(agentId)
    if (type === AGENT_TYPE) return 'codex'
  } catch {
    return 'other'
  }
  ext.others.add(agentId)
  return 'other'
}

export async function* externalStep(
  ports: Ports,
  ext: External,
  e: StepInput,
  agentId: string,
  signal: AbortSignal,
  remaining: () => number,
): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  const stream = new Stream()
  let state: AgentState | null = null
  try {
    state = await ports.loadState(agentId)
    if (state === null) return yield* refuse(e, stream, null, 'no run state exists for this agent, so it cannot continue.')
    return yield* drive(ports, ext, e, agentId, state, stream, signal, remaining)
  } catch (error) {
    if (state?.run) {
      const run = state.run
      state.run = null
      await stopAndSettle(ports, ext, run, 8).catch(() => undefined)
    }
    return yield* refuse(e, stream, state, `the mod failed (${clip(error instanceof Error ? error.message : String(error), 300)}).`)
  } finally {
    if (state?.run?.aborted) {
      state.lastReport = state.run.note ?? ''
      state.trusted = state.run.note ?? ''
      state.run = null
    }
    if (state !== null) await ports.saveState(agentId, state).catch(() => undefined)
  }
}

export async function* externalRefusal(e: StepInput): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  return yield* refuse(e, new Stream(), null, 'its hook failed, so no Claude model was allowed to answer in its place.')
}

export async function noteSpawn(
  ports: Ports,
  subagentType: string,
  prompt: string,
  cwd: string | undefined,
  agentId: string | undefined,
): Promise<void> {
  if (!isCodexType(subagentType) || !agentId) return
  await ports.saveState(agentId, {
    prompt,
    cwd: cwd ?? null,
    runs: 0,
    deliveries: 0,
    run: null,
    delivered: null,
    lastReport: '',
    used: false,
  })
}

export async function progressCall(ports: Ports, agentId: string | undefined): Promise<{ deny: string } | { result: string }> {
  const state = agentId === undefined ? null : await ports.loadState(agentId).catch(() => null)
  if (state?.run == null) return { deny: `${ENGINE.progressTool} is internal to harness:codex agents.` }
  return { result: 'Codex is still working.' }
}

export async function cleanupAgent(ports: Ports, ext: External, agentId: string, polls = 20): Promise<void> {
  const state = await ports.loadState(agentId)
  if (state === null) return
  if (state.run !== null) {
    const text = await stopAndSettle(ports, ext, state.run, polls)
    state.run = null
    state.lastReport = text
    state.trusted = text
    ports.notify(`harness:codex stopped. ${text}`)
  }
  await ports.saveState(agentId, null)
}

export async function endAll(ports: Ports, ext: External): Promise<void> {
  const ids = await ports.sessionAgents()
  for (const id of ids) {
    await cleanupAgent(ports, ext, id, 4).catch(() => undefined)
  }
}
