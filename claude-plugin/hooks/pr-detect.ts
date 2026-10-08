export type Word = { text: string; literal: boolean }

export type Cmd = { words: Word[]; end: string; depth: number; sub: boolean }

export type PrPlatform = 'github' | 'azure'

export type PrCommand = {
  platform: PrPlatform
  action: string
  via: 'cli' | 'rest'
  repo: string | null
  targetsPr: boolean
}

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
      if (words.length > 0) sink.push({ words, end: op, depth: level, sub })
      words = []
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

const WRAPPERS: Record<string, Wrapper> = {
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
}

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
    const spec = WRAPPERS[base]
    if (spec === undefined) return i
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
const GH_PULLS = /(?:^|\/)repos\/([^/\s]+\/[^/\s]+)\/pulls(?:\/\d+)?(?:[?#].*)?$/i
const AZURE_PULLS = /\/git\/repositories\/([^/\s]+)\/pullrequests(?:\/\d+)?(?:[?#].*)?$/i

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

function detectGh(args: readonly string[]): PrCommand | null {
  let i = 0
  while (i < args.length && (args[i] as string).startsWith('-')) {
    i += (args[i] === '-R' || args[i] === '--repo') ? 2 : 1
  }
  const sub = args[i]
  const after = args.slice(i + 1)
  if (sub === 'api') return detectGhApi(after)
  if (sub !== 'pr') return null

  let j = 0
  while (j < after.length && (after[j] as string).startsWith('-')) {
    j += (after[j] === '-R' || after[j] === '--repo') ? 2 : 1
  }
  const action = after[j]
  if (action === undefined || !GH_ACTIONS.has(action)) return null
  const rest = after.slice(j + 1)
  if (hasAny(rest, '--help', '-h')) return null
  if ((action === 'create' || action === 'new') && hasAny(rest, '--dry-run')) return null
  if (action === 'ready' && hasAny(rest, '--undo')) return null

  const repo = repoFlag(args, '--repo', '-R')
  const first = rest[0]
  const targetsPr = (action === 'edit' || action === 'ready') && first !== undefined && !first.startsWith('-')
  return { platform: 'github', action, via: 'cli', repo, targetsPr }
}

function writeMethodOf(args: readonly string[], spec: { methodFlags: string[]; dataFlags: string[]; getFlags: string[] }): string | null {
  let method: string | null = null
  let data = false
  let get = false
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string
    if (spec.methodFlags.includes(arg)) method = (args[i + 1] ?? '').toUpperCase()
    else if (arg.startsWith('--request=') || arg.startsWith('--method=')) method = arg.slice(arg.indexOf('=') + 1).toUpperCase()
    else if (/^-X[A-Za-z]+$/.test(arg) && spec.methodFlags.includes('-X')) method = arg.slice(2).toUpperCase()
    else if (/^-[A-Za-z]+$/.test(arg) && !arg.startsWith('--') && arg.length > 2) {
      const last = arg.slice(-1)
      if (last === 'X' && spec.methodFlags.includes('-X')) method = (args[i + 1] ?? '').toUpperCase()
      if (last === 'd' || last === 'F') data = true
      if (arg.includes('G') && spec.getFlags.includes('-G')) get = true
    } else if (spec.dataFlags.some(flag => arg === flag || arg.startsWith(`${flag}=`))) data = true
    else if (spec.getFlags.includes(arg)) get = true
  }
  if (method !== null && method.length > 0) return method
  return data && !get ? 'POST' : null
}

const CURL = {
  methodFlags: ['-X', '--request'],
  dataFlags: ['-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--data-ascii', '--json', '-F', '--form', '--form-string'],
  getFlags: ['-G', '--get'],
}

const GH_API = {
  methodFlags: ['-X', '--method'],
  dataFlags: ['-f', '-F', '--field', '--raw-field', '--input'],
  getFlags: [],
}

const WGET = {
  methodFlags: ['--method'],
  dataFlags: ['--post-data', '--post-file', '--body-data', '--body-file'],
  getFlags: [],
}

function detectGhApi(args: readonly string[]): PrCommand | null {
  const method = writeMethodOf(args, GH_API)
  if (method === null || !WRITE_METHODS.has(method)) return null
  for (const arg of args) {
    const match = GH_PULLS.exec(arg)
    if (match !== null) {
      return { platform: 'github', action: method === 'POST' ? 'create' : 'edit', via: 'rest', repo: match[1] ?? null, targetsPr: method !== 'POST' }
    }
  }
  return null
}

function detectRest(name: string, args: readonly string[]): PrCommand | null {
  let method: string | null
  if (name === 'curl') method = writeMethodOf(args, CURL)
  else if (name === 'wget') method = writeMethodOf(args, WGET)
  else {
    const given = args.find(arg => /^(GET|POST|PUT|PATCH|DELETE|HEAD)$/i.test(arg))
    const implicit = args.some(arg => !arg.startsWith('-') && !/^https?:\/\//i.test(arg) && /^[^\s=:/]+(=|:=)/.test(arg))
    method = given !== undefined ? given.toUpperCase() : implicit ? 'POST' : null
  }
  if (method === null || !WRITE_METHODS.has(method)) return null
  for (const arg of args) {
    const azure = AZURE_PULLS.exec(arg)
    if (azure !== null) {
      return { platform: 'azure', action: method === 'POST' ? 'create' : 'update', via: 'rest', repo: azure[1] ?? null, targetsPr: method !== 'POST' }
    }
    const github = /^https?:\/\/(?:api\.github\.com|[^/]+\/api\/v3)\//i.test(arg) ? GH_PULLS.exec(arg) : null
    if (github !== null) {
      return { platform: 'github', action: method === 'POST' ? 'create' : 'edit', via: 'rest', repo: github[1] ?? null, targetsPr: method !== 'POST' }
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
  return { platform: 'azure', action, via: 'cli', repo: repoFlag(rest, '--repository', '-r'), targetsPr: action === 'update' }
}

export function detectCommand(words: readonly Word[]): PrCommand | null {
  const start = commandStart(words)
  if (start < 0) return null
  const name = baseName((words[start] as Word).text)
  const args = words.slice(start + 1).map(word => word.text)
  if (name === 'gh') return detectGh(args)
  if (name === 'az') return detectAz(args)
  if (name === 'curl' || name === 'wget' || name === 'http' || name === 'https' || name === 'xh') return detectRest(name, args)
  return null
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

export function detectPr(command: string): PrDetection | null {
  const cmds = lex(command)
  const commands: PrCommand[] = []
  for (const cmd of cmds) {
    const hit = detectCommand(cmd.words)
    if (hit !== null) commands.push(hit)
  }
  if (commands.length === 0) return null
  return { commands, directory: directoryPlan(cmds) }
}

export function prCommandOf(command: string): PrCommand | null {
  return detectPr(command)?.commands[0] ?? null
}
