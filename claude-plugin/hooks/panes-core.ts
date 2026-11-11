export type ExtState = 'running' | 'done' | 'failed'
export type ExtSummary = { state: ExtState; outcome: string; exitCode: number | null; tail: string }

export function summarizeEvents(text: string): ExtSummary {
  let exit: Record<string, unknown> | undefined
  let interrupted = false
  const out: string[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let ev: Record<string, unknown>
    try {
      ev = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (ev.type === 'exit') exit = ev
    else if (ev.type === 'interrupted') interrupted = true
    else if (ev.type === 'out' && typeof ev.line === 'string') out.push(ev.line)
  }
  const tail = typeof exit?.tail === 'string' ? exit.tail : out.slice(-30).join('\n')
  const code = typeof exit?.code === 'number' ? exit.code : null
  if (interrupted) return { state: 'failed', outcome: 'interrupted', exitCode: code, tail }
  if (exit === undefined) return { state: 'running', outcome: 'running', exitCode: null, tail }
  const outcome = typeof exit.outcome === 'string' ? exit.outcome : code === 0 ? 'done' : 'failed'
  return { state: outcome === 'done' ? 'done' : 'failed', outcome, exitCode: code, tail }
}

export type PaneCommand = { verb: string; argv: string[] }

const VERBS = new Set(['tab', 'focus', 'close', 'restart', 'send', 'layout'])

export function parsePaneCommand(args: string): PaneCommand | null {
  const trimmed = args.trim()
  const verb = trimmed.split(/\s+/, 1)[0] ?? ''
  if (!VERBS.has(verb)) return null
  const rest = trimmed.slice(verb.length).trim()
  if (verb === 'send') {
    const m = /^(\S+)\s+([\s\S]+)$/.exec(rest)
    return m === null ? { verb, argv: [] } : { verb, argv: [m[1] as string, m[2] as string] }
  }
  if (verb === 'tab') return { verb, argv: rest === '' ? [] : [rest] }
  const parts = rest === '' ? [] : rest.split(/\s+/)
  return { verb, argv: parts }
}
