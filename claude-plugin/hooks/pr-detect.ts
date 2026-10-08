export type Word = { text: string; literal: boolean }

export type Cmd = { words: Word[]; end: string; depth: number; sub: boolean }

export type PrPlatform = 'github' | 'azure'

export type PrCommand = {
  platform: PrPlatform
  action: string
  via: 'cli' | 'rest'
  repo: string | null
  targetsPr: boolean
  foreign: string | null
}

export type ReviewRun = { json: boolean }

export type Analysis = { pr: PrDetection | null; review: ReviewRun | null }

export type DirectoryPlan =
  | { kind: 'session' }
  | { kind: 'cd'; target: string }
  | { kind: 'unknown'; why: string }

export type PrDetection = {
  commands: PrCommand[]
  directory: DirectoryPlan
}

type Sink = Cmd[]

const MAX_NEST = 48

const ARITH_SCAN = 512

export function lex(src: string): Cmd[] {
  const main: Cmd[] = []
  const subs: Cmd[] = []
  let pos = 0
  let nest = 0

  const run = (stop: ')' | '`' | null, base: number, sink: Sink, sub: boolean): void => {
    let level = base
    let words: Word[] = []
    let text = ''
    let literal = true
    let inWord = false
    let skipNext = false
    let heredoc: { strip: boolean } | null = null
    let fnPending = false
    let fnBraces = 0
    const pending: { tag: string; strip: boolean }[] = []

    const endWord = (): void => {
      if (!inWord) return
      if (heredoc !== null) {
        pending.push({ tag: text, strip: heredoc.strip })
        heredoc = null
      } else if (skipNext) {
        skipNext = false
      } else {
        words.push({ text, literal })
      }
      text = ''
      literal = true
      inWord = false
    }

    const endCmd = (op: string): void => {
      endWord()
      skipNext = false
      heredoc = null
      if (words.length > 0) {
        const first = (words[0] as Word).text
        if (fnBraces > 0) {
          if (first === '{') fnBraces += 1
          else if (first === '}') fnBraces -= 1
        } else if (fnPending && first === '{') {
          fnPending = false
          fnBraces = 1
        } else if (first === 'function') {
          fnPending = true
          if (words.some(word => word.text === '{')) {
            fnPending = false
            fnBraces = 1
          }
        } else {
          fnPending = false
          sink.push({ words, end: op, depth: level, sub })
        }
      }
      words = []
    }

    const discard = (): void => {
      if (nest >= MAX_NEST) {
        pos = src.length
        return
      }
      nest += 1
      run(')', base + 1, [], false)
      nest -= 1
    }

    const arithEnd = (from: number): number => {
      let depth = 2
      const limit = Math.min(src.length, from + ARITH_SCAN)
      for (let i = from; i < limit; i += 1) {
        const ch = src[i]
        if (ch === '(') depth += 1
        else if (ch === ')') {
          depth -= 1
          if (depth === 0) return src[i - 1] === ')' ? i + 1 : -1
        }
      }
      return -1
    }

    const dropFd = (): void => {
      if (inWord && literal && /^\d+$/.test(text)) {
        text = ''
        literal = true
        inWord = false
      } else {
        endWord()
      }
    }

    const substitute = (closer: ')' | '`'): void => {
      if (nest >= MAX_NEST) {
        pos = src.length
        return
      }
      nest += 1
      run(closer, base + 1, subs, true)
      nest -= 1
      text += '$S'
      literal = false
      inWord = true
    }

    const readBodies = (): void => {
      for (const one of pending.splice(0)) {
        while (pos < src.length) {
          const nl = src.indexOf('\n', pos)
          const line = nl < 0 ? src.slice(pos) : src.slice(pos, nl)
          pos = nl < 0 ? src.length : nl + 1
          if ((one.strip ? line.replace(/^\t+/, '') : line) === one.tag) break
        }
      }
    }

    while (pos < src.length) {
      const c = src[pos] as string
      const next = src[pos + 1]

      if (c === '\\') {
        if (next === '\n') {
          pos += 2
          continue
        }
        text += next ?? ''
        literal = false
        inWord = true
        pos += 2
        continue
      }

      if (c === "'") {
        const close = src.indexOf("'", pos + 1)
        text += close < 0 ? src.slice(pos + 1) : src.slice(pos + 1, close)
        inWord = true
        pos = close < 0 ? src.length : close + 1
        continue
      }

      if (c === '"') {
        pos += 1
        inWord = true
        while (pos < src.length) {
          const d = src[pos] as string
          const n = src[pos + 1]
          if (d === '"') {
            pos += 1
            break
          }
          if (d === '\\') {
            if (n === '\n') {
              pos += 2
            } else if (n === '"' || n === '\\' || n === '$' || n === '`') {
              text += n
              literal = false
              pos += 2
            } else {
              text += '\\'
              pos += 1
            }
            continue
          }
          if (d === '$' && n === '(') {
            if (src[pos + 2] === '(') {
              const end = arithEnd(pos + 3)
              if (end >= 0) {
                text += '$A'
                literal = false
                pos = end
                continue
              }
            }
            pos += 2
            substitute(')')
            continue
          }
          if (d === '`') {
            pos += 1
            substitute('`')
            continue
          }
          if (d === '$') literal = false
          text += d
          pos += 1
        }
        continue
      }

      if (c === '$' && next === '(') {
        if (src[pos + 2] === '(') {
          const end = arithEnd(pos + 3)
          if (end >= 0) {
            text += '$A'
            literal = false
            inWord = true
            pos = end
            continue
          }
        }
        pos += 2
        substitute(')')
        continue
      }

      if (c === '`') {
        if (stop === '`') {
          endCmd('`')
          pos += 1
          return
        }
        pos += 1
        substitute('`')
        continue
      }

      if (c === '$') {
        text += '$'
        literal = false
        inWord = true
        pos += 1
        continue
      }

      if (c === '#' && !inWord) {
        const nl = src.indexOf('\n', pos)
        pos = nl < 0 ? src.length : nl
        continue
      }

      if (c === ' ' || c === '\t' || c === '\r') {
        endWord()
        pos += 1
        continue
      }

      if (c === '\n') {
        endCmd('\n')
        pos += 1
        readBodies()
        continue
      }

      if (c === ';') {
        endCmd(';')
        pos += 1
        continue
      }

      if (c === '&') {
        if (next === '&') {
          endCmd('&&')
          pos += 2
        } else if (next === '>') {
          dropFd()
          skipNext = true
          pos += src[pos + 2] === '>' ? 3 : 2
        } else {
          endCmd('&')
          pos += 1
        }
        continue
      }

      if (c === '|') {
        if (next === '|') {
          endCmd('||')
          pos += 2
        } else {
          endCmd('|')
          pos += next === '&' ? 2 : 1
        }
        continue
      }

      if (c === '(') {
        if (next === '(' && !inWord && words.length === 0) {
          const end = arithEnd(pos + 2)
          if (end >= 0) {
            pos = end
            continue
          }
        }
        if (inWord && /^[A-Za-z_][A-Za-z0-9_]*\+?=$/.test(text)) {
          text = ''
          literal = true
          inWord = false
          pos += 1
          discard()
          continue
        }
        if (fnPending && !inWord && words.length === 0) {
          fnPending = false
          pos += 1
          discard()
          continue
        }
        const closing = /^[ \t]*\)/.exec(src.slice(pos + 1, pos + 40))
        if (closing !== null && (inWord || words.length > 0)) {
          endWord()
          words = []
          fnPending = true
          pos += 1 + closing[0].length
          continue
        }
        endCmd('(')
        level += 1
        pos += 1
        continue
      }

      if (c === ')') {
        endCmd(')')
        pos += 1
        if (stop === ')' && level === base) return
        if (level > base) level -= 1
        continue
      }

      if (c === '<' || c === '>') {
        if (next === '(') {
          pos += 2
          substitute(')')
          continue
        }
        dropFd()
        if (c === '<' && next === '<' && src[pos + 2] === '<') {
          skipNext = true
          pos += 3
          continue
        }
        if (c === '<' && next === '<') {
          const strip = src[pos + 2] === '-'
          heredoc = { strip }
          pos += strip ? 3 : 2
          continue
        }
        skipNext = true
        pos += 1
        if (src[pos] === '>' || src[pos] === '&' || src[pos] === '|') pos += 1
        continue
      }

      if (c === '*' || c === '?' || c === '[') literal = false
      text += c
      inWord = true
      pos += 1
    }

    endCmd('end')
  }

  run(null, 0, main, false)
  return [...main, ...subs]
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/

const KEYWORDS = new Set(['if', 'then', 'elif', 'else', 'while', 'until', 'do', '!', '{', '}'])

type Wrapper = { takes: readonly string[]; positional: number }

const WRAPPERS: Record<string, Wrapper> = Object.assign(Object.create(null) as Record<string, Wrapper>, {
  command: { takes: [], positional: 0 },
  exec: { takes: ['-a'], positional: 0 },
  builtin: { takes: [], positional: 0 },
  nohup: { takes: [], positional: 0 },
  time: { takes: ['-o', '-f'], positional: 0 },
  setsid: { takes: [], positional: 0 },
  stdbuf: { takes: ['-i', '-o', '-e'], positional: 0 },
  sudo: { takes: ['-u', '-g', '-C', '-h', '-p', '-r', '-t', '-U', '-D', '-R', '-T', '--user', '--group'], positional: 0 },
  doas: { takes: ['-u', '-C'], positional: 0 },
  env: { takes: ['-u', '-C', '-S', '--unset', '--chdir'], positional: 0 },
  nice: { takes: ['-n', '--adjustment'], positional: 0 },
  ionice: { takes: ['-c', '-n', '-p', '--class', '--classdata'], positional: 0 },
  timeout: { takes: ['-s', '-k', '--signal', '--kill-after'], positional: 1 },
  xargs: {
    takes: ['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-a', '--max-args', '--max-procs', '--max-lines', '--delimiter', '--arg-file', '--replace'],
    positional: 0,
  },
  rtk: { takes: [], positional: 0 },
})

const baseName = (word: string): string => word.split('/').pop() ?? word

export function commandStart(words: readonly Word[]): number {
  let i = 0
  while (i < words.length) {
    const word = (words[i] as Word).text
    if (ASSIGNMENT.test(word) || KEYWORDS.has(word)) {
      i += 1
      continue
    }
    const base = baseName(word)
    if (!Object.hasOwn(WRAPPERS, base)) return i
    const spec = WRAPPERS[base] as Wrapper
    i += 1
    while (i < words.length) {
      const flag = (words[i] as Word).text
      if (flag === '--') {
        i += 1
        break
      }
      if (!flag.startsWith('-') || flag === '-') break
      i += 1
      if (spec.takes.includes(flag)) i += 1
    }
    for (let k = 0; k < spec.positional; k += 1) {
      if (i < words.length && !(words[i] as Word).text.startsWith('-')) i += 1
    }
    if (base === 'rtk' && words[i]?.text === 'proxy') i += 1
  }
  return -1
}


const GH_ACTIONS = new Set(['create', 'new', 'edit', 'ready'])
const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT'])
const GH_PATH = /^\/?repos\/([^/\s]+\/[^/\s]+)\/pulls(?:\/\d+)?(?:[?#].*)?$/i
const GH_HOSTED = /^https?:\/\/api\.github\.com\/repos\/([^/\s]+\/[^/\s]+)\/pulls(?:\/\d+)?(?:[?#].*)?$/i
const GH_ENTERPRISE = /^https?:\/\/[^/\s]+\/api\/v3\/repos\/([^/\s]+\/[^/\s]+)\/pulls(?:\/\d+)?(?:[?#].*)?$/i
const AZURE_PULLS = /\/git\/repositories\/([^/\s]+)\/pullrequests(?:\/\d+)?(?:[?#].*)?$/i
const PLACEHOLDER = '{owner}/{repo}'

const hasAny = (args: readonly string[], ...names: string[]): boolean => args.some(arg => names.includes(arg))

function repoFlag(args: readonly string[], long: string, short: string | null): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string
    if (arg === long || (short !== null && arg === short)) return args[i + 1] ?? ''
    if (arg.startsWith(`${long}=`)) return arg.slice(long.length + 1)
    if (short !== null && arg.startsWith(`${short}=`)) return arg.slice(short.length + 1)
  }
  return null
}

type Flags = { methodFlags: string[]; dataFlags: string[]; getFlags: string[]; valueFlags: string[]; valueShorts: string }

const CURL: Flags = {
  methodFlags: ['-X', '--request'],
  dataFlags: ['-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--data-ascii', '--json', '-F', '--form', '--form-string'],
  getFlags: ['-G', '--get'],
  valueFlags: [
    '-X', '--request', '-H', '--header', '-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--data-ascii',
    '--json', '-F', '--form', '--form-string', '-u', '--user', '-o', '--output', '-A', '--user-agent', '-e', '--referer',
    '-b', '--cookie', '-c', '--cookie-jar', '-w', '--write-out', '-T', '--upload-file', '-x', '--proxy', '-m', '--max-time',
    '--connect-timeout', '--retry', '-K', '--config', '--cacert', '--cert', '-E', '--key', '--resolve', '--oauth2-bearer',
    '--aws-sigv4', '-r', '--range', '--url-query', '-D', '--dump-header',
  ],
  valueShorts: 'XHdFuoAebcwTxmKErD',
}

const GH_API: Flags = {
  methodFlags: ['-X', '--method'],
  dataFlags: ['-f', '-F', '--field', '--raw-field', '--input'],
  getFlags: [],
  valueFlags: ['-X', '--method', '-H', '--header', '-f', '-F', '--field', '--raw-field', '--input', '-q', '--jq', '-t', '--template', '--hostname', '--cache', '-p', '--preview'],
  valueShorts: 'XHfFqtp',
}

const WGET: Flags = {
  methodFlags: ['--method'],
  dataFlags: ['--post-data', '--post-file', '--body-data', '--body-file'],
  getFlags: [],
  valueFlags: ['--method', '--post-data', '--post-file', '--body-data', '--body-file', '--header', '--user', '--password', '-O', '--output-document', '-o', '--output-file', '-U', '--user-agent', '-e', '--execute'],
  valueShorts: 'OoUe',
}

const HTTPIE: Flags = {
  methodFlags: [],
  dataFlags: [],
  getFlags: [],
  valueFlags: ['-a', '--auth', '-A', '--auth-type', '--session', '--session-read-only', '-o', '--output', '--timeout', '-p', '--print', '--verify', '--proxy', '--cert', '--cert-key', '--max-redirects', '-s', '--style', '--pretty'],
  valueShorts: 'aAopsS',
}

type Combo = { letter: string | null; attached: boolean; rest: string; hasG: boolean }

function comboOf(arg: string, flags: Flags): Combo | null {
  if (!arg.startsWith('-') || arg.startsWith('--') || arg.length < 2) return null
  for (let i = 1; i < arg.length; i += 1) {
    const ch = arg[i] as string
    if (flags.valueShorts.includes(ch)) {
      return { letter: ch, attached: i < arg.length - 1, rest: arg.slice(i + 1), hasG: arg.slice(1, i).includes('G') }
    }
    if (!/[A-Za-z]/.test(ch)) return null
  }
  return { letter: null, attached: false, rest: '', hasG: arg.includes('G') }
}

function operandsOf(args: readonly string[], flags: Flags): string[] {
  const operands: string[] = []
  let skip = false
  for (const arg of args) {
    if (skip) {
      skip = false
      continue
    }
    if (arg.startsWith('-') && arg.length > 1) {
      if (flags.valueFlags.includes(arg)) skip = true
      else {
        const combo = comboOf(arg, flags)
        if (combo !== null && combo.letter !== null && !combo.attached) skip = true
      }
      continue
    }
    operands.push(arg)
  }
  return operands
}

function writeMethodOf(args: readonly string[], spec: Flags): string | null {
  let method: string | null = null
  let data = false
  let get = false
  const shortData = spec.dataFlags.filter(flag => /^-[A-Za-z]$/.test(flag)).map(flag => flag.slice(1))
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string
    if (spec.methodFlags.includes(arg)) method = (args[i + 1] ?? '').toUpperCase()
    else if (arg.startsWith('--request=') || arg.startsWith('--method=')) method = arg.slice(arg.indexOf('=') + 1).toUpperCase()
    else if (spec.dataFlags.some(flag => arg === flag || arg.startsWith(`${flag}=`)) && arg.startsWith('--')) data = true
    else if (spec.getFlags.includes(arg)) get = true
    else {
      const combo = comboOf(arg, spec)
      if (combo === null) continue
      if (combo.hasG && spec.getFlags.includes('-G')) get = true
      if (combo.letter === 'X' && spec.methodFlags.includes('-X')) {
        method = (combo.attached ? combo.rest : (args[i + 1] ?? '')).toUpperCase()
      } else if (combo.letter !== null && shortData.includes(combo.letter)) data = true
    }
  }
  if (method !== null && method.length > 0) return method
  return data && !get ? 'POST' : null
}

const isUrlOperand = (arg: string): boolean => !/\s/.test(arg) && (/^https?:\/\//i.test(arg) || arg.startsWith('$'))

const repoFor = (raw: string): string | null => (raw === PLACEHOLDER ? null : raw)

function githubRepoOf(operand: string): { repo: string | null } | null {
  const match = GH_HOSTED.exec(operand) ?? GH_ENTERPRISE.exec(operand)
  return match === null ? null : { repo: repoFor(match[1] ?? '') }
}

function detectGhApi(args: readonly string[]): PrCommand | null {
  const method = writeMethodOf(args, GH_API)
  if (method === null || !WRITE_METHODS.has(method)) return null
  for (const operand of operandsOf(args, GH_API)) {
    const path = GH_PATH.exec(operand)
    const found = path !== null ? { repo: repoFor(path[1] ?? '') } : githubRepoOf(operand)
    if (found !== null) {
      return { platform: 'github', action: method === 'POST' ? 'create' : 'edit', via: 'rest', repo: found.repo, targetsPr: method !== 'POST', foreign: null }
    }
  }
  return null
}

function detectGh(args: readonly string[]): PrCommand | null {
  let i = 0
  while (i < args.length && (args[i] as string).startsWith('-')) {
    i += args[i] === '-R' || args[i] === '--repo' ? 2 : 1
  }
  const sub = args[i]
  const after = args.slice(i + 1)
  if (sub === 'api') return detectGhApi(after)
  if (sub !== 'pr') return null

  let j = 0
  while (j < after.length && (after[j] as string).startsWith('-')) {
    j += after[j] === '-R' || after[j] === '--repo' ? 2 : 1
  }
  const action = after[j]
  if (action === undefined || !GH_ACTIONS.has(action)) return null
  const rest = after.slice(j + 1)
  if (hasAny(rest, '--help', '-h')) return null
  if ((action === 'create' || action === 'new') && hasAny(rest, '--dry-run')) return null
  if (action === 'ready' && hasAny(rest, '--undo')) return null

  const repo = repoFlag(args, '--repo', '-R')
  const first = rest[0]
  const selector = rest.some(arg => /^#?\d+$/.test(arg) || /^https?:\/\/\S+\/pull\/\d+/.test(arg))
  const targetsPr = (action === 'edit' || action === 'ready') && ((first !== undefined && !first.startsWith('-')) || selector)
  const head = (action === 'create' || action === 'new') && rest.some(arg => arg === '--head' || arg === '-H' || arg.startsWith('--head='))
  return { platform: 'github', action, via: 'cli', repo, targetsPr, foreign: head ? 'the command names another head branch (--head)' : null }
}

function detectRest(name: string, args: readonly string[]): PrCommand | null {
  let method: string | null
  let flags: Flags
  if (name === 'curl') {
    flags = CURL
    method = writeMethodOf(args, flags)
  } else if (name === 'wget') {
    flags = WGET
    method = writeMethodOf(args, flags)
  } else {
    flags = HTTPIE
    const operands = operandsOf(args, flags)
    const given = operands.find(arg => /^(GET|POST|PUT|PATCH|DELETE|HEAD)$/i.test(arg))
    const implicit = operands.some(arg => /^[^\s=:/]+(=(?!=)|:=)/.test(arg))
    method = given !== undefined ? given.toUpperCase() : implicit ? 'POST' : null
  }
  if (method === null || !WRITE_METHODS.has(method)) return null
  for (const operand of operandsOf(args, flags)) {
    if (!isUrlOperand(operand)) continue
    const azure = AZURE_PULLS.exec(operand)
    if (azure !== null && (operand.startsWith('$') || /^https?:\/\/[^/]+\/(?:[^/]+\/)*_apis\//i.test(operand))) {
      return { platform: 'azure', action: method === 'POST' ? 'create' : 'update', via: 'rest', repo: azure[1] ?? null, targetsPr: method !== 'POST', foreign: null }
    }
    const github = githubRepoOf(operand)
    if (github !== null) {
      return { platform: 'github', action: method === 'POST' ? 'create' : 'edit', via: 'rest', repo: github.repo, targetsPr: method !== 'POST', foreign: null }
    }
  }
  return null
}

function detectAz(args: readonly string[]): PrCommand | null {
  if (args[0] !== 'repos' || args[1] !== 'pr') return null
  const action = args[2]
  if (action !== 'create' && action !== 'update') return null
  const rest = args.slice(3)
  if (hasAny(rest, '--help', '-h')) return null
  return { platform: 'azure', action, via: 'cli', repo: repoFlag(rest, '--repository', '-r'), targetsPr: action === 'update', foreign: null }
}

export function detectCommand(words: readonly Word[]): PrCommand | null {
  const start = commandStart(words)
  if (start < 0) return null
  const name = baseName((words[start] as Word).text)
  const args = words.slice(start + 1).map(word => word.text)
  let hit: PrCommand | null = null
  if (name === 'gh') hit = detectGh(args)
  else if (name === 'az') hit = detectAz(args)
  else if (name === 'curl' || name === 'wget' || name === 'http' || name === 'https' || name === 'xh') hit = detectRest(name, args)
  if (hit !== null && hit.foreign === null && words.slice(0, start).some(word => word.text.startsWith('GH_REPO='))) {
    hit = { ...hit, foreign: 'the command sets GH_REPO' }
  }
  return hit
}

export function detectReview(words: readonly Word[]): ReviewRun | null {
  const start = commandStart(words)
  if (start < 0) return null
  if (baseName((words[start] as Word).text) !== 'herdr-jev') return null
  const args = words.slice(start + 1).map(word => word.text)
  if (args[0] !== 'review' || hasAny(args, '--help', '-h')) return null
  return { json: args.includes('--json') }
}

const DIRECTORY_COMMANDS = new Set(['cd', 'pushd', 'popd', 'chdir'])

export function directoryPlan(cmds: readonly Cmd[]): DirectoryPlan {
  const changing = cmds.filter(cmd => {
    const start = commandStart(cmd.words)
    return start >= 0 && DIRECTORY_COMMANDS.has(baseName((cmd.words[start] as Word).text))
  })
  if (changing.length === 0) return { kind: 'session' }
  const first = cmds[0]
  if (
    changing.length === 1 &&
    first !== undefined &&
    changing[0] === first &&
    first.depth === 0 &&
    !first.sub &&
    first.end === '&&' &&
    first.words.length === 2 &&
    first.words[0]?.text === 'cd'
  ) {
    const target = first.words[1] as Word
    if (target.literal && target.text.length > 0 && !target.text.startsWith('-')) return { kind: 'cd', target: target.text }
  }
  return { kind: 'unknown', why: 'the command changes directory in a way the gate does not follow' }
}

export function analyze(command: string): Analysis {
  const cmds = lex(command)
  const commands: PrCommand[] = []
  let review: ReviewRun | null = null
  for (const cmd of cmds) {
    const hit = detectCommand(cmd.words)
    if (hit !== null) commands.push(hit)
    const run = detectReview(cmd.words)
    if (run !== null) review = run
  }
  return { pr: commands.length === 0 ? null : { commands, directory: directoryPlan(cmds) }, review }
}

export function detectPr(command: string): PrDetection | null {
  return analyze(command).pr
}

export function prCommandOf(command: string): PrCommand | null {
  return detectPr(command)?.commands[0] ?? null
}
