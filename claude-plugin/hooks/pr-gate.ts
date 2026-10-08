import type { On, PluginOptions } from 'claude-code'

import { runJson } from './cli'

export type PrPlatform = 'github' | 'azure'

export type PrCommand = { platform: PrPlatform; action: string }

export type GateStatus = { status: string; reason?: string }

const STATUS_TIMEOUT_MS = 5000
const ADVICE =
  'No ready independent review is recorded for this change. Run `herdr-jev review` and address findings before publishing, or tell the user the PR is unreviewed.'

const HEREDOC = /<<-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1([^\n]*)\n[\s\S]*?(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/g

const QUOTED = /\\[\s\S]|'[^']*'|"(?:[^"\\]|\\[\s\S])*"/g

const SUBSTITUTION = /\$\(([^()]*)\)|`([^`]*)`/g

const emptied = (quoted: string): string => {
  if (quoted.startsWith('\\')) return '_'
  if (quoted.startsWith("'")) return "''"
  const runs = [...quoted.matchAll(SUBSTITUTION)].map(match => ` (${match[1] ?? match[2] ?? ''})`)
  return `""${runs.join('')}`
}

export const shellWords = (command: string): string => {
  const noHeredocs = command.replace(HEREDOC, (_all, _quote: string, tag: string, rest: string) => `<<${tag}${rest}\n`)
  return noHeredocs.replace(QUOTED, emptied)
}

const START =
  '(?:^|[\\n;&|(`])[ \\t]*(?:(?:[A-Za-z_][A-Za-z0-9_]*=\\S*|command|exec|env|sudo|time|nohup|then|do|else|!|\\{|rtk(?:[ \\t]+-u)?)[ \\t]+)*(?:[^\\s;&|()`]*\\/)?'

const END = '(?=$|[\\s;&|)`])'

const GITHUB = new RegExp(
  `${START}gh[ \\t]+(?:(?:-R|--repo)(?:=|[ \\t]+)\\S+[ \\t]+)?pr[ \\t]+(create|new|edit|ready)${END}`,
  'g',
)

const AZURE = new RegExp(`${START}az[ \\t]+repos[ \\t]+pr[ \\t]+(create|update)${END}`, 'g')

const restOfCommand = (text: string): string => text.split(/[\n;&|)`]/)[0] ?? ''

const hasFlag = (flags: string, ...names: string[]): boolean =>
  names.some(name => new RegExp(`(?:^|\\s)${name.replace(/[-]/g, '\\-')}(?=\\s|=|$)`).test(flags))

const isInert = (platform: PrPlatform, action: string, flags: string): boolean => {
  if (hasFlag(flags, '--help', '-h')) return true
  if (platform === 'github' && action === 'create' && hasFlag(flags, '--dry-run')) return true
  if (platform === 'github' && action === 'new' && hasFlag(flags, '--dry-run')) return true
  if (platform === 'github' && action === 'ready' && hasFlag(flags, '--undo')) return true
  return false
}

export const prCommandOf = (command: string): PrCommand | null => {
  const words = shellWords(command)
  const sources: [PrPlatform, RegExp][] = [
    ['github', GITHUB],
    ['azure', AZURE],
  ]
  for (const [platform, pattern] of sources) {
    for (const match of words.matchAll(pattern)) {
      const action = match[1] ?? ''
      const after = words.slice((match.index ?? 0) + match[0].length)
      if (!isInert(platform, action, restOfCommand(after))) return { platform, action }
    }
  }
  return null
}

const unquote = (word: string): string => {
  if (word.startsWith("'") && word.endsWith("'") && word.length >= 2) return word.slice(1, -1).replace(/'\\''/g, "'")
  if (word.startsWith('"') && word.endsWith('"') && word.length >= 2) return word.slice(1, -1)
  return word
}

export const leadingCdOf = (command: string): string | undefined => {
  const match = /^\s*cd\s+('(?:[^']|'\\'')*'|"[^"]*"|[^\s;&|]+)\s*&&/.exec(command)
  return match?.[1] === undefined ? undefined : unquote(match[1])
}

export const resolveDir = (target: string | undefined, sessionCwd: string, home: string | undefined): string => {
  if (target === undefined || target.length === 0) return sessionCwd
  if (target === '~' || target.startsWith('~/')) return home === undefined || home.length === 0 ? sessionCwd : `${home}${target.slice(1)}`
  if (target.startsWith('/')) return target
  const parts = `${sessionCwd}/${target}`.split('/')
  const stack: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') stack.pop()
    else stack.push(part)
  }
  return `/${stack.join('/')}`
}

export const parseStatus = (value: unknown): GateStatus => {
  if (value === null) return { status: 'none' }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const status = (value as Record<string, unknown>).status
    if (typeof status === 'string' && status.trim().length > 0) return { status: status.trim().slice(0, 40) }
    if (status === null || status === undefined) return { status: 'none' }
  }
  return { status: 'unknown', reason: 'unexpected review-status output' }
}

export type RunPort = Parameters<typeof runJson>[0]

export async function readStatus(run: RunPort, sessionId: string, cwd: string): Promise<GateStatus> {
  const ran = await runJson(
    run,
    { bin: 'ai-harness', cwd },
    ['review-status', '--client', 'claude', '--session', sessionId, '--cwd', cwd],
    STATUS_TIMEOUT_MS,
  )
  if (!ran.ok) return { status: 'unknown', reason: ran.reason }
  return parseStatus(ran.value)
}

export const noticeText = (status: GateStatus): string => {
  if (status.status === 'ready') return 'Harness review status: ready.'
  if (status.status === 'unknown') {
    const why = status.reason === undefined ? '' : ` (${status.reason})`
    return `Harness review status: unknown${why}. The check failed, so the command was not held. ${ADVICE}`
  }
  return `Harness review status: ${status.status}. The PR command ran without a ready review. ${ADVICE}`
}

export const askReason = (status: GateStatus): string =>
  `Harness review status is ${status.status}. ${ADVICE} Run the PR command anyway?`

export const askEnabled = (options: PluginOptions): boolean => options.prGateAsk === true

export const shouldAsk = (enabled: boolean, status: GateStatus): boolean =>
  enabled && status.status !== 'ready' && status.status !== 'unknown'

export type Verdict = { decision: 'allow' | 'ask' | 'deny'; reason?: string }

export const askVerdict = <T extends Verdict>(status: GateStatus | undefined, verdict: T): T =>
  status === undefined || verdict.decision === 'deny' ? verdict : ({ ...verdict, decision: 'ask', reason: askReason(status) } as T)

export function registerPrGate(on: On, options: PluginOptions): void {
  const held = new Map<string, GateStatus>()

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = typeof e.command === 'string' ? e.command : ''
    if (prCommandOf(command) === null) return next(e)

    const sessionCwd = await $.session.cwd()
    const home = leadingCdOf(command)?.startsWith('~') ? await $.env.get('HOME').catch(() => undefined) : undefined
    const dir = resolveDir(leadingCdOf(command), sessionCwd, home)
    let status: GateStatus
    try {
      const sessionId = await $.session.id()
      status = await readStatus((argv, init) => $.process.run(argv, init), sessionId, dir)
    } catch (error) {
      status = { status: 'unknown', reason: error instanceof Error ? error.message.slice(0, 120) : 'status check failed' }
    }

    const id = e.tool_use_id
    if (id !== undefined && shouldAsk(askEnabled(options), status)) held.set(id, status)
    try {
      const ran = await next(e)
      if (ran.deny !== undefined) return ran
      return { ...ran, context: [...(ran.context ?? []), noticeText(status)] } as typeof ran
    } finally {
      if (id !== undefined) held.delete(id)
    }
  }).catch(($, e, next) => next(e))

  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const id = e.tool_use_id
    const status = id === undefined ? undefined : held.get(id)
    return askVerdict(status, await next(e))
  }).catch(($, e, next) => next(e))
}
