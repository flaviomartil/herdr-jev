import { atom, read, update } from 'claude-code'
import type { On } from 'claude-code'

import type { ClaimCheck, ClaimEntry, ClaimKind, ClaimWarning } from '../types'

const logAtom = atom({ plugin: 'harness', key: 'claimLog' } as const, [])
const warningsAtom = atom({ plugin: 'harness', key: 'claimWarnings' } as const, [])

export const LOG_LIMIT = 200
export const SHOWN_WARNINGS = 3

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])

const LEFT = '(?<![\\p{L}\\p{N}_])'
const RIGHT = '(?![\\p{L}\\p{N}_])'

const LINKS =
  '(?:\\s+(?:all|now|still|fully|are|is|were|was|todos?|todas?|agora|ainda|est[aá]|est[aã]o|ficou|ficaram|foi|foram|j[aá]|tamb[eé]m))*'
const PASSED =
  '(?:pass(?:es|ed|ing)?|green|succeed(?:s|ed)?|clean(?:ly)?|ok|passa(?:m|ndo)?|passou|passaram|verdes?|limp[oa]s?|sucesso|aprovad[oa]s?|funcion(?:a|am|ou|aram))'
const TAIL = `${LINKS}\\s+${PASSED}${RIGHT}`

const pattern = (source: string) => new RegExp(source, 'iu')

const CLAIM_PATTERNS: readonly [ClaimKind, RegExp][] = [
  [
    'ci',
    pattern(
      `${LEFT}(?:(?:the |o |a )?CI|(?:all |todos os |os )?(?<!type[- ])checks|(?:the |o |a )?pipeline)${TAIL}`,
    ),
  ],
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
  [
    'verified',
    pattern(
      `${LEFT}(?:verified|confirmed)(?:\\s+(?:that|it|this|the fix|the change))*\\s+(?:works?|is working|fixed|fixes it)${RIGHT}`,
    ),
  ],
  [
    'verified',
    pattern(`${LEFT}(?:i|we)(?:'ve|\\s+have)?\\s+(?:(?:now|also|fully|successfully|already)\\s+)*verified${RIGHT}`),
  ],
  [
    'verified',
    pattern(
      `(?:^|${LEFT}(?:is|are|was|were|been|now|fully)\\s+)(?:(?:now|fully|all|successfully)\\s+)*verified${RIGHT}(?!\\s+(?:by|with|against|via|using|from|email|account|domain|users?|badge|address|status)${RIGHT})`,
    ),
  ],
  [
    'verified',
    pattern(
      `${LEFT}(?:verifiquei|confirmei)(?:\\s+que)?(?:\\s+(?:isso|tudo|ele|ela|a\\s+corre[cç][aã]o|o\\s+(?:fix|conserto)|a\\s+mudan[cç]a))*\\s+(?:funciona|est[aá]\\s+funcionando|corrigid[oa]|passa)${RIGHT}`,
    ),
  ],
  ['verified', pattern(`${LEFT}verifiquei\\s+tudo${RIGHT}`)],
  [
    'verified',
    pattern(
      `(?:^|${LEFT}(?:est[aá]|ficou|foi|tudo|j[aá]|totalmente|devidamente|agora)\\s+)(?:(?:j[aá]|totalmente|devidamente|agora)\\s+)*verificad[oa]s?${RIGHT}`,
    ),
  ],
  [
    'verified',
    pattern(
      `(?:^|${LEFT}(?:e|mas|ent[aã]o|tudo|isso|ele|ela|todos|todas)\\s+)(?:(?:isso|tudo)\\s+)?(?:passou|passaram)${RIGHT}(?!\\s+(?:d[oae]s?|n[oa]s?|pel[oa]s?|por|para|a|um|uma|de)${RIGHT})`,
    ),
  ],
  [
    'verified',
    pattern(`${LEFT}(?:everything${LINKS}\\s+(?:green|pass(?:es|ed|ing)?|ok)|all green)${RIGHT}`),
  ],
]

const CONDITION = pattern(
  `${LEFT}(?:unless|until|once|if|whether|make sure|ensure|assuming|se|quando|at[eé]|assim que|caso|desde que|garanta|garantir|certifique|certificar)${RIGHT}`,
)

const NEGATION = pattern(
  `${LEFT}(?:not|no|never|none|nor|without|fail(?:s|ed|ing)?|yet|should|shall|will|would|could|might|may|must|expect(?:ed)?|hope|probably|likely|need(?:s|ed)?|cannot|can be|pending|n[aã]o|nunca|nenhum[a]?|nem|sem|falh(?:a|ou|aram|ando)|deve(?:m|ria|riam)?|poder[aá]|talvez|provavelmente|espero|precis(?:a|am|o)|falta(?:m)?|pendente)${RIGHT}|n't${RIGHT}`,
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
    .filter(sentence => sentence.length > 0 && !sentence.endsWith('?'))

export type Claim = { kind: ClaimKind; quote: string }

export function detectClaims(answer: string): Claim[] {
  const claims = new Map<ClaimKind, Claim>()
  for (const sentence of sentencesOf(answer)) {
    for (const [kind, regex] of CLAIM_PATTERNS) {
      if (claims.has(kind)) continue
      const match = regex.exec(sentence)
      if (match === null) continue
      const clause = clauseBefore(sentence, match.index)
      if (CONDITION.test(`${clause} ${match[0]}`)) continue
      if (NEGATION.test(`${nearBefore(clause)} ${match[0]}`)) continue
      claims.set(kind, { kind, quote: match[0].replace(/\s+/g, ' ').trim() })
    }
  }
  return [...claims.values()]
}

const CHECK_PATTERNS: readonly [ClaimCheck, RegExp][] = [
  [
    'test',
    /\b(pytest|jest|vitest|mocha|go test|cargo test|deno test|dotnet test|php artisan test|claude plugin test|(npm|pnpm|yarn|bun)( run)? test|just test|make test|rspec|phpunit|mvn( \S+)* test|gradlew? test)\b/,
  ],
  ['lint', /\b(eslint|ruff|tsc|mypy|pyright|lint|typecheck|type-check|biome|clippy|go vet|cargo check|phpstan|psalm|flake8)\b/],
  [
    'build',
    /\b((npm|pnpm|yarn|bun)( run)? build|cargo build|go build|make build|gradle( \S+)* build|mvn( \S+)* (package|install)|docker build|vite build|next build)\b/,
  ],
  ['ci', /\b(gh pr checks|gh run (view|watch|list)|gh pr view)\b|check-runs|statusCheckRollup/],
  ['push', /\bgit( -C \S+)? push\b/],
]

const stripQuoted = (command: string) =>
  command.replace(/'[^']*'|"[^"]*"/g, '""').replace(/(^|\s)#.*$/gm, '$1')

const READS_ONLY = /^\s*(grep|rg|ag|echo|printf|cat|less|head|tail|which|type|man)\b/

const INSTALLS =
  /^\s*(sudo\s+)?((npm|pnpm|yarn|bun)\s+(install|i|add|ci|remove|rm|uninstall|update|upgrade)\b|(pip3?|pipx|uv\s+pip|uv\s+tool|python3?\s+-m\s+pip)\s+install\b|uv\s+(add|remove|sync)\b|poetry\s+(add|install|remove)\b|cargo\s+(install|add)\b|go\s+(install|get)\b|(brew|gem|apt|apt-get|dnf|yum|apk)\s+(install|add)\b)/

const SEPARATOR = /(\|\||&&|\|&|\||;|\n)/

export function classifyCommand(command: string): ClaimCheck[] {
  const found = new Set<ClaimCheck>()
  for (const [index, segment] of stripQuoted(command).split(SEPARATOR).entries()) {
    if (index % 2 === 1 || READS_ONLY.test(segment) || INSTALLS.test(segment)) continue
    for (const [check, regex] of CHECK_PATTERNS) if (regex.test(segment)) found.add(check)
  }
  return CHECK_PATTERNS.map(([check]) => check).filter(check => found.has(check))
}

const REDIRECT = /(?<![=\-<>])(?:\d+|&)?>>?\s*(&?)([^\s;&|<>()]*)/g
const WRITERS =
  /(?:^|[\s;&|(])(?:tee|mv|cp|rm|touch|truncate|ln|dd|patch)\s|\b(?:sed|perl)\b[^|;&]*\s-[a-zA-Z]*i\b|\bgit\s+(?:apply|am|checkout|switch|restore|reset|stash|merge|rebase|cherry-pick|revert|pull|clean|mv|rm)\b|--(?:fix|write)\b|\bgofmt\s+-w\b|\bcargo\s+fmt\b|\bruff\s+format\b/

export function isMutatingCommand(command: string): boolean {
  const text = stripQuoted(command)
  if (WRITERS.test(text)) return true
  for (const match of text.matchAll(REDIRECT)) {
    const target = match[2] ?? ''
    if (match[1] === '&' || target === '' || target.startsWith('/dev/')) continue
    return true
  }
  return false
}

export function appendEntry(
  log: readonly ClaimEntry[],
  entry: { type: 'edit'; path: string } | { type: 'run'; checks: ClaimCheck[]; command: string; isOk: boolean; isInterrupted: boolean },
): ClaimEntry[] {
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
    const runs = log.filter(
      (entry): entry is Extract<ClaimEntry, { type: 'run' }> =>
        entry.type === 'run' && entry.seq > (since ?? 0) && entry.checks.some(check => checks.includes(check)),
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

export function registerClaims(on: On): void {
  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit', 'Bash'] }, async ($, e, next) => {
    const ran = await next(e)
    try {
      if (ran.deny !== undefined) return ran
      const input = e as unknown as Record<string, unknown>
      if (EDIT_TOOLS.has(e.tool)) {
        if (ran.isError === true) return ran
        const path = String(input.file_path ?? input.notebook_path ?? '')
        await update($, logAtom, entries => appendEntry(entries ?? [], { type: 'edit', path }))
        return ran
      }
      if (e.tool !== 'Bash') return ran
      const command = String(input.command ?? '')
      const checks = classifyCommand(command)
      const isMutating = isMutatingCommand(command)
      if (checks.length === 0 && !isMutating) return ran
      const result = typeof ran.result === 'object' && ran.result !== null ? (ran.result as RunResult) : {}
      const isInterrupted = result.interrupted === true
      await update($, logAtom, entries => {
        let all = entries ?? []
        if (isMutating) all = appendEntry(all, { type: 'edit', path: shorten(command, 80) })
        if (checks.length > 0) {
          all = appendEntry(all, { type: 'run', checks, command, isOk: ran.isError !== true && !isInterrupted, isInterrupted })
        }
        return all
      })
    } catch {
      return ran
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('prompt.submit', { origin: { kind: /^(?:composer|bridge|sdk)$/ } }, async ($, e, next) => {
    try {
      await update($, warningsAtom, current => ((current ?? []).length === 0 ? current : []))
    } catch {
      return next(e)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', { reason: 'answer' }, async ($, e, next) => {
    const completed = await next(e)
    if (e.agentId !== undefined) return completed
    try {
      const warnings = unverifiedClaims(detectClaims(e.answer), await read($, logAtom))
      await update($, warningsAtom, () => warnings)
    } catch {
      return completed
    }
    return completed
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt', surface: ['terminal', 'desktop'] }, async ($, e, next) => {
    const rendered = await next(e)
    const warnings = await read($, warningsAtom)
    if (e.props.hasSurvey || warnings.length === 0) return rendered
    const { Box, Text } = $.ui.resolve(e)
    const hidden = warnings.length - SHOWN_WARNINGS
    const lines = warnings.slice(0, SHOWN_WARNINGS).map((warning, index) =>
      Text({ color: 'warning', wrap: 'truncate-end', children: warningLine(warning) }),
    )
    if (hidden > 0) lines.push(Text({ dimColor: true, children: `+${hidden} more unverified` }))
    return Box({ key: 'claims', flexDirection: 'column', paddingX: 1, children: [rendered, ...lines] })
  }).catch(($, e, next) => next(e))
}
