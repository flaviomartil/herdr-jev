export type Json = string | string[] | { [key: string]: Json }
export type RuleConfig = { [key: string]: Json }

type Line = { indent: number; text: string }

const stripComment = (raw: string): string => {
  let quote = ''
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!
    if (quote) {
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'") {
      if (i === 0 || /[\s:\-]/.test(raw[i - 1]!)) quote = c
    } else if (c === '#' && (i === 0 || /\s/.test(raw[i - 1]!))) {
      return raw.slice(0, i)
    }
  }
  return raw
}

const scalar = (value: string): string => {
  const v = value.trim()
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'")
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\(["\\nt])/g, (_m, ch: string) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch))
  }
  return v
}

export function parseRules(source: string): RuleConfig {
  const lines: Line[] = []
  for (const raw of source.split('\n')) {
    const text = stripComment(raw).replace(/\s+$/, '')
    if (text.trim().length === 0) continue
    lines.push({ indent: text.length - text.trimStart().length, text: text.trim() })
  }
  let pos = 0
  const block = (indent: number): Json => {
    if (lines[pos]?.text.startsWith('- ')) {
      const items: string[] = []
      while (pos < lines.length && lines[pos]!.indent === indent && lines[pos]!.text.startsWith('- ')) {
        items.push(scalar(lines[pos]!.text.slice(2)))
        pos++
      }
      return items
    }
    const map: { [key: string]: Json } = {}
    while (pos < lines.length && lines[pos]!.indent === indent) {
      const line = lines[pos]!.text
      const match = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(line)
      if (!match) throw new Error(`rules: cannot parse line "${line}"`)
      pos++
      const rest = match[2]
      if (rest !== undefined && rest.length > 0) {
        map[match[1]!] = rest === '[]' ? [] : scalar(rest)
      } else if (pos < lines.length && lines[pos]!.indent > indent) {
        map[match[1]!] = block(lines[pos]!.indent)
      } else {
        map[match[1]!] = []
      }
    }
    return map
  }
  if (lines.length === 0) return {}
  const root = block(lines[0]!.indent)
  if (pos < lines.length || typeof root !== 'object' || Array.isArray(root)) throw new Error('rules: bad structure')
  return root
}

const isMap = (v: Json | undefined): v is { [key: string]: Json } => typeof v === 'object' && v !== null && !Array.isArray(v)

export function mergeRules(base: RuleConfig, local: RuleConfig): RuleConfig {
  const out: { [key: string]: Json } = { ...base }
  for (const [key, value] of Object.entries(local)) {
    const prior = out[key]
    if (isMap(prior) && isMap(value)) out[key] = mergeRules(prior, value)
    else if (Array.isArray(prior) && Array.isArray(value)) out[key] = [...prior, ...value]
    else out[key] = value
  }
  return out
}

export type RuleEvent =
  | {
      type: 'tool'
      tool: string
      input: Record<string, unknown>
      cwd?: string
      home?: string
      sessionId?: string
      files?: Record<string, string>
      unreadable?: string[]
      realPaths?: Record<string, string>
      branch?: string
      isNew?: boolean
    }
  | { type: 'prompt'; sessionId?: string }

export type Verdict =
  | { decision: 'allow'; context?: string[] }
  | { decision: 'deny' | 'ask' | 'warn'; reason: string; rule: string }

export type Evaluator = { evaluate: (event: RuleEvent) => Verdict }

const list = (v: Json | undefined): string[] => (Array.isArray(v) ? v : typeof v === 'string' && v.length > 0 ? [v] : [])
const section = (config: RuleConfig, key: string): { [key: string]: Json } => {
  const v = config[key]
  return isMap(v) ? v : {}
}
const build = (pattern: string, caseless: boolean, global: boolean): RegExp => {
  const flags = (global ? 'g' : '') + (caseless || pattern.startsWith('(?i)') ? 'i' : '')
  return new RegExp(pattern.startsWith('(?i)') ? pattern.slice(4) : pattern, flags)
}
const compile = (patterns: string[], caseless = true, global = false): RegExp[] => patterns.map(p => build(p, caseless, global))

export function shellSplit(input: string): string[][] {
  const segments: string[][] = []
  let tokens: string[] = []
  let cur = ''
  let has = false
  let quote = ''
  const pushToken = () => {
    if (has) tokens.push(cur)
    cur = ''
    has = false
  }
  const pushSegment = () => {
    pushToken()
    if (tokens.length > 0) segments.push(tokens)
    tokens = []
  }
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!
    if (quote) {
      if (c === quote) quote = ''
      else if (c === '\\' && quote === '"' && i + 1 < input.length) cur += input[++i]
      else cur += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      has = true
    } else if (c === '\\' && i + 1 < input.length) {
      cur += input[++i]
      has = true
    } else if (c === ';' || c === '|' || c === '&' || c === '\n' || c === '(' || c === ')') {
      pushSegment()
    } else if (c === ' ' || c === '\t') {
      pushToken()
    } else {
      cur += c
      has = true
    }
  }
  pushSegment()
  return segments
}

const baseName = (path: string): string => path.split('/').pop() ?? path

const WRAPPERS: Record<string, Set<string>> = {
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U', '--user', '--group', '--host', '--prompt', '--chdir', '--chroot']),
  doas: new Set(['-u', '-C']),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '-n', '-p', '-P', '-u']),
  time: new Set(['-f', '-o', '--format', '--output']),
  command: new Set(),
  builtin: new Set(),
  nohup: new Set(),
  exec: new Set(['-a']),
  setsid: new Set(),
  stdbuf: new Set(['-i', '-o', '-e']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  xargs: new Set(['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-a', '--max-args', '--max-procs', '--replace', '--delimiter']),
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])

function stripLead(tokens: string[]): string[] {
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      i++
      continue
    }
    const name = baseName(token)
    const flags = WRAPPERS[name]
    if (flags === undefined) break
    i++
    while (i < tokens.length && tokens[i]!.startsWith('-')) {
      if (tokens[i] === '--') {
        i++
        break
      }
      i += flags.has(tokens[i]!) ? 2 : 1
    }
    if (name === 'timeout') i++
  }
  return tokens.slice(i)
}

export function expandSegments(segments: string[][], depth = 0): string[][] {
  const out: string[][] = []
  for (const segment of segments) {
    out.push(segment)
    const t = stripLead(segment)
    if (t.length === 0 || depth >= 3) continue
    const name = baseName(t[0]!)
    if (name === 'eval') {
      out.push(...expandSegments(shellSplit(t.slice(1).join(' ')), depth + 1))
    } else if (SHELLS.has(name)) {
      const k = t.findIndex((a, idx) => idx > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(a))
      if (k > 0 && t[k + 1] !== undefined) out.push(...expandSegments(shellSplit(t[k + 1]!), depth + 1))
    }
  }
  return out
}

const GIT_ARG_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env'])

export function gitCall(segment: string[]): { sub: string; args: string[] } | null {
  const t = stripLead(segment)
  if (t.length === 0 || baseName(t[0]!) !== 'git') return null
  let i = 1
  while (i < t.length && t[i]!.startsWith('-')) i += GIT_ARG_OPTIONS.has(t[i]!) ? 2 : 1
  if (i >= t.length) return null
  return { sub: t[i]!, args: t.slice(i + 1) }
}

export function commitFiles(command: string): string[] {
  const out: string[] = []
  for (const seg of expandSegments(shellSplit(command))) {
    const call = gitCall(seg)
    if (call?.sub !== 'commit') continue
    for (let i = 0; i < call.args.length; i++) {
      const a = call.args[i]!
      if ((a === '-F' || a === '--file') && call.args[i + 1] !== undefined) out.push(call.args[++i]!)
      else if (a.startsWith('--file=')) out.push(a.slice(7))
      else if (/^-F.+/.test(a)) out.push(a.slice(2))
    }
  }
  return out.filter(f => f !== '-')
}

function isRmRf(seg: string[]): boolean {
  const t = stripLead(seg)
  if (t.length === 0 || baseName(t[0]!) !== 'rm') return false
  let r = false
  let f = false
  for (const a of t.slice(1)) {
    if (a === '--recursive') r = true
    else if (a === '--force') f = true
    else if (/^-[A-Za-z]+$/.test(a)) {
      if (/[rR]/.test(a)) r = true
      if (a.includes('f')) f = true
    }
  }
  return r && f
}

const isProtectedRef = (ref: string, protectedBranches: string[]): boolean => {
  const target = ref.replace(/^\+/, '').split(':').pop()!.replace(/^refs\/heads\//, '')
  return protectedBranches.includes(target)
}

type PushInfo = { force: boolean; positional: string[] }

function pushInfo(seg: string[]): PushInfo | null {
  const call = gitCall(seg)
  if (call?.sub !== 'push') return null
  const positional: string[] = []
  let force = false
  for (const a of call.args) {
    if (a === '-f' || a === '--force' || a.startsWith('--force-with-lease') || a === '--force-if-includes') force = true
    else if (/^-[A-Za-z]*f[A-Za-z]*$/.test(a)) force = true
    else if (!a.startsWith('-')) positional.push(a)
  }
  return { force, positional }
}

export function pushNeedsBranch(command: string): boolean {
  return expandSegments(shellSplit(command)).some(seg => {
    const info = pushInfo(seg)
    return info !== null && !info.force && info.positional.length <= 1
  })
}

function pushReason(seg: string[], protectedBranches: string[], branch: string | undefined): string | null {
  const info = pushInfo(seg)
  if (info === null) return null
  const { force, positional } = info
  if (force) return 'git push with force'
  if (positional.slice(1).some(r => r.startsWith('+'))) return 'git push with force refspec'
  if (positional.slice(1).some(r => isProtectedRef(r, protectedBranches))) return 'git push to a protected branch'
  if (positional.length <= 1 && branch !== undefined && protectedBranches.includes(branch)) return 'git push from a protected branch'
  return null
}

const expand = (path: string, home: string | undefined): string =>
  path === '~' || path.startsWith('~/') ? `${home ?? ''}${path.slice(1)}` : path

function absolute(path: string, cwd: string | undefined, home: string | undefined): string {
  const p = expand(path, home)
  const joined = p.startsWith('/') ? p : `${cwd ?? ''}/${p}`
  const stack: string[] = []
  for (const part of joined.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') stack.pop()
    else stack.push(part)
  }
  return `/${stack.join('/')}`
}

const under = (path: string, root: string): boolean => root.length > 1 && (path === root || path.startsWith(`${root.replace(/\/$/, '')}/`))

export function writtenText(tool: string, input: Record<string, unknown>): string {
  const parts: string[] = []
  const take = (v: unknown) => {
    if (typeof v === 'string') parts.push(v)
  }
  if (tool === 'Write') take(input.content)
  else if (tool === 'Edit') take(input.new_string)
  else if (tool === 'NotebookEdit') take(input.new_source)
  else if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    for (const edit of input.edits) if (edit && typeof edit === 'object') take((edit as Record<string, unknown>).new_string)
  } else if (tool === 'apply_patch') take(input.patch ?? input.command ?? input.input)
  return parts.join('\n')
}

export function writtenPaths(tool: string, input: Record<string, unknown>): string[] {
  if (tool === 'apply_patch') {
    const text = writtenText(tool, input)
    return [...text.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm)].map(m => m[1]!.trim())
  }
  const path = tool === 'NotebookEdit' ? input.notebook_path : input.file_path
  return typeof path === 'string' ? [path] : []
}

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch'])
const SHELL_TOOLS = new Set(['Bash', 'shell', 'local_shell'])

export function failureVerdict(event: RuleEvent): Verdict {
  const blocked: Verdict = { decision: 'deny', rule: 'evaluator-error', reason: 'Rule check failed on a file write or commit; blocked.' }
  if (event.type !== 'tool') return { decision: 'allow' }
  if (FILE_TOOLS.has(event.tool)) return blocked
  if (SHELL_TOOLS.has(event.tool)) {
    try {
      const raw = event.input?.command
      const text = Array.isArray(raw) ? raw.join(' ') : String(raw ?? '')
      if (/\bgit\b[\s\S]*\bcommit\b/.test(text)) return blocked
    } catch {
      return { decision: 'allow' }
    }
  }
  return { decision: 'allow' }
}

export function createEvaluator(config: RuleConfig, log: (message: string) => void = () => {}): Evaluator {
  const commit = section(config, 'commit')
  const forbidden = compile(list(commit.forbidden))
  const secrets = section(config, 'secrets')
  const secretPatterns = compile(list(secrets.patterns), false, true)
  const secretAllow = compile(list(secrets.allow))
  const workRepo = section(config, 'workRepo')
  const roots = list(workRepo.roots)
  const excludes = list(workRepo.exclude)
  const excludeSegments = list(workRepo.excludeSegments)
  const allowFiles = list(workRepo.allowFiles).map(f => f.toLowerCase())
  const docExt = compile(list(workRepo.extensions))
  const generic = section(config, 'generic')
  const genericNames = compile(list(generic.names))
  const guard = section(config, 'guard')
  const protectedBranches = list(guard.protectedBranches)
  const reminder = typeof config.skillReminder === 'string' ? config.skillReminder : ''
  const reminded = new Set<string>()
  const messages = section(config, 'messages')
  const msg = (key: string, fallback: string): string => (typeof messages[key] === 'string' ? (messages[key] as string) : fallback)

  const secretVerdict = (text: string): Verdict | null => {
    for (const re of secretPatterns) {
      for (const m of text.matchAll(re)) {
        if (secretAllow.some(a => a.test(m[0]))) continue
        return { decision: 'deny', rule: 'secret', reason: msg('secret', 'Secret-like value in file content. Use an environment variable and a placeholder.') }
      }
    }
    return null
  }

  const bashRules = (event: Extract<RuleEvent, { type: 'tool' }>, command: string): Verdict[] => {
    const out: Verdict[] = []
    const segments = expandSegments(shellSplit(command))
    const commits = segments.some(s => gitCall(s)?.sub === 'commit')
    if (commits && event.unreadable?.length) {
      out.push({ decision: 'deny', rule: 'commit-attribution', reason: `Commit message file could not be read (${event.unreadable.join(', ')}); blocked.` })
    }
    if (commits) {
      try {
        const text = [command, ...Object.values(event.files ?? {})].join('\n')
        if (forbidden.some(re => re.test(text))) {
          out.push({ decision: 'deny', rule: 'commit-attribution', reason: msg('commit', 'Commit message must not carry a co-author or a generated-with line.') })
        }
      } catch {
        out.push({ decision: 'deny', rule: 'commit-attribution', reason: 'Commit check failed; blocked.' })
      }
    }
    try {
      if (segments.some(isRmRf)) out.push({ decision: 'ask', rule: 'rm-rf', reason: msg('rmrf', 'Recursive forced delete needs confirmation.') })
      for (const seg of segments) {
        const why = pushReason(seg, protectedBranches, event.branch)
        if (why) {
          out.push({ decision: 'ask', rule: 'git-push', reason: `${why}: confirm before running.` })
          break
        }
      }
    } catch (error) {
      log(`rules evaluator error: ${error instanceof Error ? error.message : String(error)}`)
    }
    return out
  }

  const fileRules = (event: Extract<RuleEvent, { type: 'tool' }>): Verdict[] => {
    const out: Verdict[] = []
    try {
      const secret = secretVerdict(writtenText(event.tool, event.input))
      if (secret) out.push(secret)
    } catch {
      out.push({ decision: 'deny', rule: 'secret', reason: 'Secret check failed; blocked.' })
    }
    try {
    for (const path of writtenPaths(event.tool, event.input)) {
      const abs = absolute(path, event.cwd, event.home)
      const real = event.realPaths?.[path]
      const candidates = real === undefined ? [abs] : [abs, real]
      const base = abs.split('/').pop()!
      const isDoc = docExt.length > 0 ? docExt.some(re => re.test(base)) : /\.md$/i.test(base)
      if (isDoc && !allowFiles.includes(base.toLowerCase())) {
        const inWork = candidates.some(c => {
          const inRoot = roots.some(r => under(c, absolute(r, event.cwd, event.home)))
          const excluded = excludes.some(r => under(c, absolute(r, event.cwd, event.home))) || c.split('/').some(part => excludeSegments.includes(part))
          return inRoot && !excluded
        })
        if (inWork) {
          out.push({ decision: 'deny', rule: 'work-repo-doc', reason: msg('doc', 'No new or edited docs in a work repo (README.md is the exception). Put it in the notes vault.') })
        }
      }
      if (event.tool === 'Write' && event.isNew !== false && genericNames.some(re => re.test(base))) {
        out.push({ decision: 'warn', rule: 'generic-name', reason: msg('generic', 'Generic file name. Use a descriptive name that says what it does.') })
      }
    }
    } catch (error) {
      log(`rules evaluator error: ${error instanceof Error ? error.message : String(error)}`)
      out.push({ decision: 'deny', rule: 'evaluator-error', reason: 'Rule check failed on a file write; blocked.' })
    }
    return out
  }

  const rank = { deny: 3, ask: 2, warn: 1 } as const

  const evaluate = (event: RuleEvent): Verdict => {
    const found: Verdict[] = []
    try {
      if (event.type === 'prompt') {
        const id = event.sessionId ?? 'default'
        if (reminder && !reminded.has(id)) {
          reminded.add(id)
          return { decision: 'allow', context: [reminder] }
        }
        return { decision: 'allow' }
      }
      if (SHELL_TOOLS.has(event.tool)) {
        const raw = event.input.command
        const command = Array.isArray(raw) ? raw.join(' ') : typeof raw === 'string' ? raw : ''
        found.push(...bashRules(event, command))
      } else if (FILE_TOOLS.has(event.tool)) {
        found.push(...fileRules(event))
      }
    } catch (error) {
      log(`rules evaluator error: ${error instanceof Error ? error.message : String(error)}`)
      return failureVerdict(event)
    }
    let best: Verdict = { decision: 'allow' }
    for (const v of found) {
      if (v.decision === 'allow') continue
      if (best.decision === 'allow' || rank[v.decision] > rank[best.decision]) best = v
    }
    return best
  }
  return { evaluate }
}
