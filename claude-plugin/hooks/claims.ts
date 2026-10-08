import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { ClaimCheck, ClaimEntry, ClaimKind, ClaimWarning } from '../types'

const logAtom = atom({ plugin: 'harness', key: 'claimLog' } as const, [])
const warningsAtom = atom({ plugin: 'harness', key: 'claimWarnings' } as const, [])

export const LOG_LIMIT = 200
export const SHOWN_WARNINGS = 3
export const COMMAND_LIMIT = 80

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])

const LEFT = '(?<![\\p{L}\\p{N}_])'
const RIGHT = '(?![\\p{L}\\p{N}_])'

const LINKS =
  '(?:\\s+(?:all|now|still|fully|are|is|were|was|todos?|todas?|agora|ainda|est[aá]|est[aã]o|ficou|ficaram|foi|foram|j[aá]|tamb[eé]m))*'
const PASSED =
  '(?:pass(?:es|ed|ing)?|green|succeed(?:s|ed)?|clean(?:ly)?|ok|passa(?:m|ndo)?|passou|passaram|verdes?|limp[oa]s?|sucesso|aprovad[oa]s?|funcion(?:a|am|ou|aram))'
const ADVERB =
  '(?:\\s+(?:now|again|too|locally|successfully|cleanly|agora|novamente|localmente|com sucesso))?'
const STOP_MARKS = '[.,;!)\\]*_✅✔]'
const JOINERS = '\\s+(?:and|but|e|mas)(?![\\p{L}\\p{N}_])'
const LATER =
  '\\s+(?:after|depois|(?:with(?:out)?|com|sem)\\s+(?:(?:no|zero|nenhum)\\s+)?(?:errors?|erros?|warnings?|failures?))(?![\\p{L}\\p{N}_])'
const END = `(?=\\s*(?:[:]|${STOP_MARKS}|[—–]|-\\s|\\(\\d|$)|${JOINERS}|${LATER})`
const END_V = `(?=\\s*(?:${STOP_MARKS}|$)|${JOINERS})`
const TAIL = `${LINKS}\\s+${PASSED}${ADVERB}${END}`

const pattern = (source: string) => new RegExp(source, 'iu')

const CLAIM_PATTERNS: readonly [ClaimKind, RegExp][] = [
  ['ci', pattern(`${LEFT}(?:(?:the |o |a )?CI|(?:the |o |a )?pipeline)${TAIL}`)],
  [
    'lint',
    pattern(
      `${LEFT}(?:lint(?:ing|er)?|type ?checks?|type-checks?|typecheck(?:ing)?|types|tsc|eslint|ruff|mypy|pyright|tipos|checagem de tipos|verifica[cç][aã]o de tipos)${TAIL}`,
    ),
  ],
  ['build', pattern(`${LEFT}(?:the |o )?builds?${TAIL}`)],
  [
    'test',
    pattern(
      `${LEFT}(?:(?:the|all|os|as|todos|todas)\\s+)*(?:\\d+\\s+)?(?:(?:unit|integration|e2e|new|unit[aá]rios?|novos?)\\s+)?(?:tests?|specs?|test suite|suite|testes?|su[ií]tes?)(?:\\s+(?:unit[aá]rios?|de integra[cç][aã]o|e2e|novos?))?${TAIL}`,
    ),
  ],
  ['verified', pattern(`${LEFT}(?:(?:all|todos os|os)\\s+)?(?<!type[- ])checks${TAIL}`)],
  [
    'verified',
    pattern(
      `${LEFT}(?:verified|confirmed)(?:\\s+(?:that|it|this|the fix|the change))*\\s+(?:works?|is working|fixed|fixes it)${END_V}`,
    ),
  ],
  [
    'verified',
    pattern(
      `${LEFT}(?:i|we)(?:'ve|\\s+have)?\\s+(?:(?:now|also|fully|successfully|already)\\s+)*verified(?:\\s+(?:it|this|everything|the fix|the change|the result))?${END_V}`,
    ),
  ],
  [
    'verified',
    pattern(
      `(?:^|${LEFT}(?:is|are|was|were|been|now|fully)\\s+)(?:(?:now|fully|all|successfully)\\s+)*verified${END_V}`,
    ),
  ],
  [
    'verified',
    pattern(
      `${LEFT}(?:verifiquei|confirmei)(?:\\s+que)?(?:\\s+(?:isso|tudo|ele|ela|a\\s+corre[cç][aã]o|o\\s+(?:fix|conserto)|a\\s+mudan[cç]a))*\\s+(?:funciona|est[aá]\\s+funcionando|corrigid[oa]|passa)${END_V}`,
    ),
  ],
  ['verified', pattern(`${LEFT}verifiquei\\s+tudo${END_V}`)],
  [
    'verified',
    pattern(
      `(?:^|${LEFT}(?:est[aá]|ficou|foi|tudo|j[aá]|totalmente|devidamente|agora)\\s+)(?:(?:j[aá]|totalmente|devidamente|agora)\\s+)*verificad[oa]s?${END_V}`,
    ),
  ],
  ['verified', pattern(`${LEFT}(?:tudo|todos|todas)\\s+(?:(?:j[aá]|e)\\s+)?(?:passou|passaram)${END_V}`)],
  ['verified', pattern(`${LEFT}(?:everything${LINKS}\\s+(?:green|pass(?:es|ed|ing)?|ok)|all green)${END_V}`)],
]

const CONDITION = pattern(
  `${LEFT}(?:unless|until|once|if|when|after|as soon as|whether|goal|expected|means|make sure|ensure|assuming|before|so that|to make|to get|confirm|check that|verify that|earlier|previously|se|quando|depois que|esperado|at[eé]|assim que|caso|desde que|antes|para que|garanta|garantir|certifique|certificar|confirme|verifique|anteriormente|mais cedo)${RIGHT}`,
)

const NEGATION = pattern(
  `${LEFT}(?:not|no|never|none|nor|without|fail(?:s|ed|ing)?|yet|should|shall|will|would|could|might|may|must|expect(?:ed)?|hope|probably|likely|need(?:s|ed)?|cannot|can be|pending|n[aã]o|nunca|nenhum[a]?|nem|sem|falh(?:a|ou|aram|ando)|deve(?:m|ria|riam)?|poder[aá]|talvez|provavelmente|espero|precis(?:a|am|o)|falta(?:m)?|pendente)${RIGHT}|n't${RIGHT}`,
)

const REPORTED = pattern(
  `${LEFT}(?:says?|said|reports?|reported|answered|claims?|claimed|per|according to|disse|diz|relatou|informou|respondeu|afirmou|segundo)${RIGHT}`,
)

const LABELLED = pattern(
  '^(?:[-*]\\s*\\[ \\]|\\||(?:acceptance criteria|criteria|dod|definition of done|goal|todo|next|step \\d+|expected result|crit[eé]rios?(?: de aceite)?|objetivo|pr[oó]ximos? passos?)(?![\\p{L}\\p{N}_]))',
)

const MIXED = pattern(
  `(?<!${LEFT}(?:no|0|zero|without|sem|nenhum|nenhuma)\\s+)${LEFT}(?:fails?|failed|failing|failures?|errors?|falh(?:a|as|am|ou|aram)|erros?)${RIGHT}`,
)

const NEAR_WORDS = 4

const clauseBefore = (sentence: string, index: number) => {
  const start = Math.max(...[',', ';', ':', '—', '–', '('].map(mark => sentence.lastIndexOf(mark, index - 1)))
  return sentence.slice(start + 1, index)
}

const nearBefore = (clause: string) => {
  const words = clause.trim().split(/\s+/).filter(word => word.length > 0)
  const conjunction = words
    .map(word => word.toLowerCase())
    .findLastIndex(word => ['and', 'but', 'so', 'then', 'e', 'mas', 'então'].includes(word))
  return words.slice(conjunction + 1).slice(-NEAR_WORDS).join(' ')
}

const withoutQuoted = (answer: string) =>
  answer
    .replace(/```[\s\S]*?```/g, '\n')
    .replace(/^[ \t]*>.*$/gm, '\n')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/"[^"\n]*"/g, ' ')
    .replace(/“[^”\n]*”/g, ' ')
    .replace(/«[^»\n]*»/g, ' ')
    .replace(/(?<![\p{L}\p{N}])'[^'\n]+'(?![\p{L}\p{N}])/gu, ' ')

const sentencesOf = (answer: string) =>
  withoutQuoted(answer)
    .split(/(?<=[.!?])\s+|\n+/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length > 0 && !sentence.endsWith('?') && !LABELLED.test(sentence))

export type Claim = { kind: ClaimKind; quote: string }

export function detectClaims(answer: string): Claim[] {
  const claims = new Map<ClaimKind, Claim>()
  for (const sentence of sentencesOf(answer)) {
    for (const [kind, regex] of CLAIM_PATTERNS) {
      if (claims.has(kind)) continue
      const match = regex.exec(sentence)
      if (match === null) continue
      if (REPORTED.test(sentence.slice(0, match.index))) continue
      if (MIXED.test(sentence.slice(match.index + match[0].length))) continue
      const clause = clauseBefore(sentence, match.index)
      if (CONDITION.test(`${clause} ${match[0]}`)) continue
      if (NEGATION.test(`${nearBefore(clause)} ${match[0]}`)) continue
      claims.set(kind, { kind, quote: match[0].replace(/\s+/g, ' ').trim() })
    }
  }
  return [...claims.values()]
}

const SEPARATOR = /(\|\||&&|\|&|\||;|\n)/

const stripQuoted = (command: string) =>
  command.replace(/'[^']*'|"[^"]*"/g, '""').replace(/(^|\s)#.*$/gm, '$1')

const PREFIX =
  /^(?:[({!]+\s*|exec\s+|docker\s+exec\s+(?:-\S+\s+)*\S+\s+|(?:if|then|do|while|until)\s+|rtk(?:\s+-u)?(?:\s+(?:test|err|proxy|summary))?\s+|(?:sudo|time|nice)\s+|command\s+(?!-[vV])|timeout\s+(?:-\S+\s+)*\S+\s+|env\s+(?:-\S+\s+)*|\w+=\S*\s+|docker(?:\s+compose|-compose)\s+(?:exec|run)\s+(?:-\S+\s+)*\S+\s+)/

type Segment = { program: string; args: string[]; text: string }

function segmentOf(raw: string): Segment {
  let text = raw.trim().replace(/[)}\s]+$/, '')
  for (let round = 0; round < 32; round += 1) {
    const next = text.replace(PREFIX, '')
    if (next === text) break
    text = next
  }
  const tokens = text.split(/\s+/).filter(token => token.length > 0)
  const program = (tokens[0] ?? '').replace(/^.*\//, '')
  return { program, args: tokens.slice(1), text }
}

const HEREDOC = /<<-?[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|([\w-]+))/

function dropHeredocs(command: string): string {
  let text = command
  for (let round = 0; round < 16; round += 1) {
    const match = HEREDOC.exec(text)
    if (match === null) break
    const tag = match[1] ?? match[2] ?? match[3] ?? ''
    const lineEnd = text.indexOf('\n', match.index)
    if (lineEnd < 0) {
      text = text.slice(0, match.index)
      break
    }
    const lines = text.slice(lineEnd + 1).split('\n')
    const close = lines.findIndex(line => line.trim() === tag)
    const rest = close < 0 ? '' : lines.slice(close + 1).join('\n')
    text = `${text.slice(0, match.index)}${text.slice(match.index + match[0].length, lineEnd)}\n${rest}`
  }
  return text
}

function segmentsOf(command: string): Segment[] {
  return stripQuoted(dropHeredocs(command))
    .split(SEPARATOR)
    .filter((_, index) => index % 2 === 0)
    .map(segmentOf)
    .filter(segment => segment.program.length > 0)
}

const NON_RUNNERS = new Set([
  'grep', 'rg', 'ag', 'echo', 'printf', 'cat', 'less', 'head', 'tail', 'which', 'type', 'man', 'ls', 'command',
  'find', 'sed', 'awk', 'hash', 'whereis', 'stat', 'file', 'wc', 'diff', 'cut', 'sort', 'tr', 'pwd', 'cd',
  'pip', 'pip3', 'pipx', 'test', '[', '[[',
])

const INSTALLS =
  /^(?:(?:pip3?|pipx|uv\s+pip|uv\s+tool|python3?\s+-m\s+pip)\s+install\b|uv\s+(?:add|remove|sync)\b|poetry\s+(?:add|install|remove)\b|cargo\s+(?:install|add)\b|go\s+(?:install|get)\b|(?:brew|gem|apt|apt-get|dnf|yum|apk)\s+(?:install|add)\b|composer\s+(?:install|require|update|remove)\b)/

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])

const PM_NON_RUN = new Set([
  'install', 'i', 'add', 'ci', 'remove', 'rm', 'uninstall', 'update', 'upgrade', 'publish', 'pack', 'link', 'unlink',
  'view', 'info', 'why', 'ls', 'list', 'outdated', 'audit', 'init', 'create',
])

const SCRIPT_KINDS: readonly [RegExp, ClaimCheck][] = [
  [/^(?:test|tests|smoke|e2e|spec|test:[\w:.-]+)$/, 'test'],
  [/^(?:typecheck|type-check|tsc|lint|check|(?:lint|typecheck|check):[\w:.-]+)$/, 'lint'],
  [/^build(?::[\w:.-]+)?$/, 'build'],
]

function scriptKind(args: readonly string[]): ClaimCheck | null {
  for (const arg of args) {
    if (arg.startsWith('-')) continue
    if (PM_NON_RUN.has(arg)) return null
    const found = SCRIPT_KINDS.find(([regex]) => regex.test(arg))
    if (found !== undefined) return found[1]
  }
  return null
}

const TEST_RUNNERS =
  /\b(?:pytest|jest|vitest|mocha|phpunit|rspec|playwright test|go test|cargo (?:test|nextest)|deno test|dotnet test|php artisan test|node --test|python3? -m (?:unittest|pytest)|claude plugin test|composer (?:run(?:-script)? )?test|make (?:test|check)|just test|mvn(?: \S+)* test|gradlew?(?: \S+)* test|ai-harness review-verify|herdr-jev (?:review|prove))\b|(?:^|[\s/])pest\b/

const LINT_RUNNERS =
  /\b(?:eslint|ruff(?! format)|tsc|mypy|pyright|biome|clippy|go vet|cargo check|phpstan|psalm|flake8|golangci-lint|astro check|php -l|claude plugin validate|prettier --check)(?![\w-])/

const BUILD_RUNNERS =
  /\b(?:cargo build|go build|make build|gradlew?(?: \S+)* build|mvn(?: \S+)* (?:package|install)|docker(?: compose)? build|vite build|next build|astro build)\b/

const CI_READS =
  /\b(?:gh pr checks|gh run (?:view|watch|list)|gh pr view|az pipelines|az repos pr show|az devops)\b|check-runs|statusCheckRollup/

const CHECK_ORDER: readonly ClaimCheck[] = ['test', 'lint', 'build', 'ci', 'push']

function checksOf(segment: Segment): ClaimCheck[] {
  const { program, args, text } = segment
  if (NON_RUNNERS.has(program)) return []
  if (program === 'git') {
    const sub = gitCommand(args)
    return sub !== null && sub.name === 'push' && !sub.flags.some(flag => flag === '--dry-run' || /^-[a-z]*n[a-z]*$/.test(flag))
      ? ['push']
      : []
  }
  if (INSTALLS.test(text) || /\s--(?:version|help)(?:\s|$)/.test(text)) return []
  const found = new Set<ClaimCheck>()
  if (PACKAGE_MANAGERS.has(program)) {
    if (args.some(arg => PM_NON_RUN.has(arg))) return []
    const kind = scriptKind(args)
    if (kind !== null) found.add(kind)
  }
  if (TEST_RUNNERS.test(text)) found.add('test')
  if (LINT_RUNNERS.test(text)) found.add('lint')
  if (BUILD_RUNNERS.test(text)) found.add('build')
  if (CI_READS.test(text)) found.add('ci')
  return CHECK_ORDER.filter(check => found.has(check))
}

export function classifyCommand(command: string): ClaimCheck[] {
  const found = new Set<ClaimCheck>()
  for (const segment of segmentsOf(command)) for (const check of checksOf(segment)) found.add(check)
  return CHECK_ORDER.filter(check => found.has(check))
}

function gitCommand(args: readonly string[]): { name: string; rest: string[]; flags: string[]; dir?: string } | null {
  let index = 0
  let dir: string | undefined
  while (index < args.length) {
    const arg = args[index] ?? ''
    if (arg === '-C') dir = args[index + 1]
    if (['-C', '-c', '--git-dir', '--work-tree'].includes(arg)) {
      index += 2
      continue
    }
    if (arg.startsWith('-')) {
      index += 1
      continue
    }
    const rest = args.slice(index + 1)
    return { name: arg, rest, flags: rest.filter(one => one.startsWith('-')), ...(dir === undefined ? {} : { dir }) }
  }
  return null
}

const OFF_TREE = /^(?:\/tmp|\/var\/tmp|\/dev)(?:\/|$)/
const isOffTree = (path: string) => OFF_TREE.test(path)

const REDIRECT = /(?<![=\-<>])(?:\d+|&)?>>?\s*(&?)([^\s;&|<>()]*)/g
const IN_PLACE = /^-[a-zA-Z]*i[\w.~-]*$|^--in-place(?:=.*)?$/

function gitMutates(args: readonly string[], cwd: string | undefined): boolean {
  const git = gitCommand(args)
  if (git === null) return false
  const { name, rest, flags, dir } = git
  if (dir !== undefined && cwd !== undefined && !isInside(dir, cwd)) return false
  const has = (...names: string[]) => flags.some(flag => names.includes(flag))
  switch (name) {
    case 'checkout':
      return !has('-b', '-B', '--orphan')
    case 'switch':
      return !has('-c', '-C', '--create', '--force-create')
    case 'restore':
      return !has('--staged') || has('--worktree', '-W')
    case 'reset':
      return has('--hard', '--merge', '--keep')
    case 'merge':
    case 'rebase':
    case 'cherry-pick':
    case 'revert':
    case 'pull':
    case 'am':
    case 'mv':
      return true
    case 'apply':
      return !has('--check', '--stat', '--numstat', '--summary')
    case 'rm':
      return !has('--cached')
    case 'clean':
      return !(has('--dry-run') || flags.some(flag => /^-[a-z]*n[a-z]*$/.test(flag)))
    case 'stash': {
      const verb = rest.find(one => !one.startsWith('-'))
      return verb === undefined || ['push', 'save', 'pop', 'apply'].includes(verb)
    }
    default:
      return false
  }
}

function segmentMutates(segment: Segment, cwd: string | undefined): boolean {
  const { program, args, text } = segment
  if (program === 'test' || program === '[' || program === '[[') return false
  for (const match of text.matchAll(REDIRECT)) {
    const target = match[2] ?? ''
    if (match[1] === '&' || target === '' || isOffTree(target)) continue
    return true
  }
  const paths = args.filter(arg => !arg.startsWith('-') && !/^[<>&\d]/.test(arg))
  switch (program) {
    case 'xargs': {
      const start = args.findIndex(arg => !arg.startsWith('-'))
      return start >= 0 && segmentMutates(segmentOf(args.slice(start).join(' ')), cwd)
    }
    case 'git':
      return gitMutates(args, cwd)
    case 'patch':
      return true
    case 'tee':
    case 'rm':
    case 'rmdir':
    case 'unlink':
    case 'touch':
    case 'truncate':
      return paths.some(path => !isOffTree(path))
    case 'cp':
    case 'mv':
    case 'install':
    case 'ln':
    case 'rsync': {
      const target = paths[paths.length - 1]
      return target !== undefined && paths.length > 1 && !isOffTree(target)
    }
    case 'dd':
      return args.some(arg => arg.startsWith('of=') && !isOffTree(arg.slice(3)))
    case 'sed':
    case 'perl':
      return args.some(arg => IN_PLACE.test(arg))
    default:
      break
  }
  return (
    /--(?:fix|write)(?![\w-])/.test(text) ||
    /\bgofmt\s+-w\b/.test(text) ||
    (/\bcargo\s+fmt\b/.test(text) && !/--check/.test(text)) ||
    (/\bruff\s+format\b/.test(text) && !/--(?:check|diff)/.test(text))
  )
}

export function isMutatingCommand(command: string, isReadOnly = false, cwd?: string): boolean {
  if (isReadOnly) return false
  return segmentsOf(command).some(segment => segmentMutates(segment, cwd))
}

type EntryInput =
  | { type: 'edit'; path: string; agentId?: string }
  | { type: 'run'; checks: ClaimCheck[]; command: string; isOk: boolean; isInterrupted: boolean; agentId?: string }

export function appendEntry(log: readonly ClaimEntry[], entry: EntryInput): ClaimEntry[] {
  const seq = (log[log.length - 1]?.seq ?? 0) + 1
  return [...log, { ...entry, seq } as ClaimEntry].slice(-LOG_LIMIT)
}

const EVIDENCE: Record<ClaimKind, { checks: ClaimCheck[]; noun: string }> = {
  test: { checks: ['test'], noun: 'test' },
  lint: { checks: ['lint'], noun: 'lint or typecheck' },
  build: { checks: ['build'], noun: 'build' },
  ci: { checks: ['ci'], noun: 'CI check' },
  verified: { checks: ['test', 'lint', 'build', 'ci'], noun: 'check' },
}

const lastSeq = (log: readonly ClaimEntry[], isMarker: (entry: ClaimEntry) => boolean) =>
  [...log].reverse().find(isMarker)?.seq

const isPush = (entry: ClaimEntry) => entry.type === 'run' && entry.checks.includes('push') && entry.isOk

const shorten = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit - 3)}...` : text)

export function unverifiedClaims(claims: readonly Claim[], log: readonly ClaimEntry[]): ClaimWarning[] {
  return claims.flatMap(claim => {
    const { checks, noun } = EVIDENCE[claim.kind]
    const isCi = claim.kind === 'ci'
    const since = isCi ? lastSeq(log, isPush) : lastSeq(log, entry => entry.type === 'edit')
    if (since === undefined && (!isCi || !log.some(entry => entry.type === 'edit'))) return []
    const runs = log.filter(
      (entry): entry is Extract<ClaimEntry, { type: 'run' }> =>
        entry.type === 'run' &&
        entry.seq > (since ?? 0) &&
        entry.checks.some(check => checks.includes(check)) &&
        (entry.agentId === undefined || entry.isOk),
    )
    const last = runs[runs.length - 1]
    if (last === undefined) {
      const when = since === undefined ? 'this session' : isCi ? 'after the last push' : 'after the last edit'
      return [{ kind: claim.kind, quote: claim.quote, reason: `no ${noun} ran ${when}` }]
    }
    if (last.isInterrupted) {
      return [{ kind: claim.kind, quote: claim.quote, reason: `the last ${noun} run was interrupted (${shorten(last.command, 40)})` }]
    }
    if (!last.isOk) {
      return [{ kind: claim.kind, quote: claim.quote, reason: `the last ${noun} run failed (${shorten(last.command, 40)})` }]
    }
    return []
  })
}

export const warningLine = (warning: ClaimWarning) => `unverified: "${warning.quote}" · ${warning.reason}`

type RunResult = { interrupted?: unknown }

function debug($: EngineInterface, label: string, error: unknown): void {
  try {
    const message = error instanceof Error ? error.message : String(error)
    $.ui.log(`harness: claims ${label} failed: ${message.slice(0, 160)}`, { to: 'debug' })
  } catch {
    return
  }
}

function isInside(path: string, cwd: string): boolean {
  if (path.includes('/.claude/worktrees/')) return false
  if (!path.startsWith('/')) return true
  const root = cwd.endsWith('/') ? cwd : `${cwd}/`
  return path === cwd || path.startsWith(root)
}

function isTracked(path: string, cwd: string): boolean {
  return !/\.md$/i.test(path) && isInside(path, cwd)
}

type RecordInput = { tool: string; agentId?: string } & Record<string, unknown>

async function record(
  $: EngineInterface,
  input: RecordInput,
  ran: { isError?: boolean; isReadOnly?: boolean; result?: unknown },
): Promise<void> {
  const agentId = typeof input.agentId === 'string' ? input.agentId : undefined
  const cwd = await $.session.cwd()
  if (EDIT_TOOLS.has(input.tool)) {
    if (ran.isError === true) return
    const path = String(input.file_path ?? input.notebook_path ?? '')
    if (!isTracked(path, cwd)) return
    await update($, logAtom, entries => appendEntry(entries ?? [], { type: 'edit', path, ...(agentId === undefined ? {} : { agentId }) }))
    return
  }
  if (input.tool !== 'Bash') return
  const command = String(input.command ?? '')
  const result = typeof ran.result === 'object' && ran.result !== null ? (ran.result as RunResult) : {}
  const isInterrupted = result.interrupted === true
  const isOk = ran.isError !== true && !isInterrupted
  let checks = classifyCommand(command)
  if (!isOk && checks.length > 1) checks = []
  const isMutating = agentId === undefined && isMutatingCommand(command, ran.isReadOnly === true, cwd)
  if (checks.length === 0 && !isMutating) return
  const short = shorten(command, COMMAND_LIMIT)
  await update($, logAtom, entries => {
    let all = entries ?? []
    if (isMutating) all = appendEntry(all, { type: 'edit', path: short })
    if (checks.length > 0) {
      all = appendEntry(all, {
        type: 'run',
        checks,
        command: short,
        isOk,
        isInterrupted,
        ...(agentId === undefined ? {} : { agentId }),
      })
    }
    return all
  })
}

export function registerClaims(on: On): void {
  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit', 'Bash'] }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    try {
      await record($, e as unknown as RecordInput, ran)
    } catch (error) {
      debug($, 'record', error)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    if ((e as { agentId?: unknown }).agentId !== undefined) return started
    try {
      await update($, warningsAtom, current => ((current ?? []).length === 0 ? current : []))
    } catch (error) {
      debug($, 'clear', error)
    }
    return started
  }).catch(($, e, next) => next(e))

  on('session.end', { reason: 'clear' }, async ($, e, next) => {
    const ended = await next(e)
    try {
      await update($, warningsAtom, () => [])
      await update($, logAtom, () => [])
    } catch (error) {
      debug($, 'reset', error)
    }
    return ended
  }).catch(($, e, next) => next(e))

  on('turn.complete', { reason: 'answer' }, async ($, e, next) => {
    const completed = await next(e)
    if (e.agentId !== undefined) return completed
    try {
      const warnings = unverifiedClaims(detectClaims(e.answer), await read($, logAtom))
      await update($, warningsAtom, () => warnings)
      if (warnings.length > 0) $.ui.log(warnings.map(warningLine).join('\n'))
    } catch (error) {
      debug($, 'check', error)
    }
    return completed
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt', surface: ['terminal', 'desktop'] }, async ($, e, next) => {
    const rendered = await next(e)
    const warnings = await read($, warningsAtom)
    if (e.props.hasSurvey || warnings.length === 0) return rendered
    const { Box, Text } = $.ui.resolve(e)
    const hidden = warnings.length - SHOWN_WARNINGS
    const lines = warnings
      .slice(0, SHOWN_WARNINGS)
      .map(warning => Text({ color: 'warning', wrap: 'truncate-end', children: warningLine(warning) }))
    if (hidden > 0) lines.push(Text({ dimColor: true, children: `+${hidden} more unverified` }))
    return Box({
      key: 'claims',
      flexDirection: 'column',
      children: [rendered, Box({ flexDirection: 'column', paddingX: 1, children: lines })],
    })
  }).catch(($, e, next) => next(e))
}
