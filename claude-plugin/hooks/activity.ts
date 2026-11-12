import { atom, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Timer } from 'claude-code'
import type { Activity } from '../types'

export const STEP_TOOL = /^mcp__harness__harness_step$/
export const STEP_BRIEF =
  '\n\nProgress: right after reading this brief call the harness_step tool with total (your plan in 3 to 8 steps) and done 0, then call it again as each step finishes, with a short note. It is silent and only feeds the Jev pane.'
export const RING = 12
export const MAX_AGENTS = 200
export const REDRAW_MS = 250
const LINE = 80
const SNIPPET = 160
const TOOL_KINDS = 24

export const activityAtom = atom({ plugin: 'harness', key: 'activity' } as const, {}, { shape: 'activity-1' })
export const jevHintAtom = atom({ plugin: 'harness', key: 'jevHint' } as const, '')
export const expandedAtom = atom({ plugin: 'harness', key: 'expandedAgents' } as const, {})

const acts = new Map<string, Activity>()
const cursors = new Map<string, number>()
let lastFlush = Number.NEGATIVE_INFINITY
let pending: Timer | null = null
let ticker: Timer | null = null
const toasted = new Set<string>()

export const liveEnabled = (options: PluginOptions): boolean => options.delegation === true || options.panes === true
export const autoOpenEnabled = (options: PluginOptions): boolean => options.autoOpenPane !== false && liveEnabled(options)

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export function resetActivity(): void {
  acts.clear()
  cursors.clear()
  toasted.clear()
  lastFlush = Number.NEGATIVE_INFINITY
  pending?.cancel()
  pending = null
  ticker?.cancel()
  ticker = null
}

function touch(id: string, now: number): Activity {
  let act = acts.get(id)
  if (act === undefined) {
    act = {
      id, startedAt: now, updatedAt: now, endedAt: null, steps: 0, toolCount: 0, tools: {}, line: '', snippet: '', log: [],
      percent: null, stepDone: null, stepTotal: null, tokens: 0, attempt: null, phase: null, end: null,
    }
    acts.set(id, act)
    if (acts.size > MAX_AGENTS) {
      const victim = [...acts.values()].find(a => a.end !== null) ?? acts.values().next().value
      if (victim !== undefined && victim.id !== id) {
        acts.delete(victim.id)
        cursors.delete(victim.id)
      }
    }
  }
  act.updatedAt = now
  return act
}

function push(act: Activity, line: string): void {
  act.line = clip(line, LINE)
  act.log.push(act.line)
  if (act.log.length > RING) act.log.splice(0, act.log.length - RING)
}

export function noteStep(id: string, now: number): void {
  const act = touch(id, now)
  act.steps += 1
  if (act.end === null) act.line = 'pensando…'
}

export function noteTool(id: string, now: number, tool: string, summary: string): void {
  const act = touch(id, now)
  act.toolCount += 1
  const key = tool.replace(/^mcp__/, '')
  if (key in act.tools || Object.keys(act.tools).length < TOOL_KINDS) act.tools[key] = (act.tools[key] ?? 0) + 1
  push(act, summary)
}

export function noteSnippet(id: string, now: number, text: string): void {
  const flat = clip(text, SNIPPET)
  if (flat !== '') touch(id, now).snippet = flat
}

export function noteUsage(id: string, now: number, tokens: number): void {
  touch(id, now).tokens = Math.max(0, Math.round(tokens))
}

export function noteSelfReport(id: string, now: number, input: { done?: unknown; total?: unknown; note?: unknown; percent?: unknown }): void {
  const act = touch(id, now)
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null)
  const total = num(input.total) ?? act.stepTotal
  const done = num(input.done) ?? act.stepDone
  if (total !== null && total > 0 && done !== null) {
    act.stepTotal = total
    act.stepDone = Math.min(done, total)
    act.percent = Math.round((act.stepDone / total) * 100)
  } else if (num(input.percent) !== null && (num(input.percent) as number) <= 100) {
    act.percent = num(input.percent)
  }
  if (typeof input.note === 'string' && input.note.trim() !== '') push(act, input.note)
}

export function noteEnd(id: string, now: number, ok: boolean, text: string): void {
  const act = touch(id, now)
  act.end = ok ? 'done' : 'failed'
  act.endedAt = now
  const snippet = clip(text, SNIPPET)
  if (snippet !== '') act.snippet = snippet
  act.line = ok ? 'pronto' : 'falhou'
}

export type TailEvent = { type: string; [key: string]: unknown }

export function parseTail(text: string): TailEvent[] {
  const out: TailEvent[] = []
  for (const row of text.split('\n')) {
    if (row.trim() === '') continue
    try {
      const parsed = JSON.parse(row) as unknown
      if (typeof parsed === 'object' && parsed !== null && typeof (parsed as TailEvent).type === 'string') out.push(parsed as TailEvent)
    } catch {
      continue
    }
  }
  return out
}

export function applyTail(id: string, now: number, events: TailEvent[]): void {
  const act = touch(id, now)
  for (const ev of events) {
    if (ev.type === 'queued') act.phase = 'na fila'
    else if (ev.type === 'start') {
      act.phase = 'rodando'
      act.attempt = typeof ev.attempt === 'number' ? ev.attempt : (act.attempt ?? 0) + 1
    } else if (ev.type === 'out' && typeof ev.line === 'string') {
      push(act, ev.line)
      act.snippet = clip(ev.line, SNIPPET)
      act.phase = 'rodando'
    } else if (ev.type === 'progress') {
      noteSelfReport(id, now, ev)
    } else if (ev.type === 'detached') act.phase = 'destacado'
    else if (ev.type === 'timeout') act.phase = 'timeout'
    else if (ev.type === 'interrupted') {
      act.phase = 'interrompido'
      act.end = 'failed'
      act.endedAt = now
    } else if (ev.type === 'exit') {
      const ok = ev.outcome === 'done' || (ev.outcome === undefined && ev.code === 0)
      act.end = ok ? 'done' : 'failed'
      act.endedAt = now
      act.phase = ok ? 'pronto' : typeof ev.outcome === 'string' ? ev.outcome : 'falhou'
      if (typeof ev.tail === 'string' && ev.tail.trim() !== '') act.snippet = clip(ev.tail.split('\n').filter(l => l.trim() !== '').slice(-1)[0] ?? '', SNIPPET)
    }
  }
}

export const cursorOf = (id: string): number => cursors.get(id) ?? 0
export const setCursor = (id: string, at: number): void => {
  cursors.set(id, at)
}
export const dropCursor = (id: string): void => {
  cursors.delete(id)
}

export const hasRunning = (): boolean => [...acts.values()].some(a => a.end === null)
export const snapshotActivity = (): Record<string, Activity> =>
  Object.fromEntries([...acts.entries()].map(([id, a]) => [id, { ...a, tools: { ...a.tools }, log: [...a.log] }]))

async function flush($: EngineInterface, now: number): Promise<void> {
  lastFlush = now
  await update($, activityAtom, () => snapshotActivity()).catch(() => undefined)
  if (hasRunning()) ensureTicker($)
}

export async function publishActivity($: EngineInterface): Promise<void> {
  let now: number
  try {
    now = await $.clock.now()
  } catch {
    now = Date.now()
  }
  const wait = REDRAW_MS - (now - lastFlush)
  if (wait <= 0) {
    pending?.cancel()
    pending = null
    return flush($, now)
  }
  pending ??= $.clock.after(wait, () => {
    pending = null
    void (async () => {
      let at = lastFlush + REDRAW_MS
      try {
        at = await $.clock.now()
      } catch {
        at = Date.now()
      }
      await flush($, at)
    })()
  })
}

function ensureTicker($: EngineInterface): void {
  if (ticker !== null) return
  ticker = $.clock.every(1000, () => {
    if (!hasRunning()) {
      ticker?.cancel()
      ticker = null
      return
    }
    try {
      $.ui.invalidate('ui.render')
    } catch {
      return
    }
  })
}

export async function toastFailureOnce($: EngineInterface, id: string, label: string): Promise<void> {
  const key = `jev.failed.${id}`
  if (toasted.has(key)) return
  toasted.add(key)
  try {
    if (await $.store.get(key)) return
    await $.store.set(key, true)
  } catch {
    return
  }
  $.ui.toast(`agente falhou: ${clip(label, 60)}`)
}

export function percentOf(act: Activity | undefined): number | null {
  if (act === undefined) return null
  return act.percent !== null && act.percent >= 0 && act.percent <= 100 ? act.percent : null
}

const FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
export const spinnerFrame = (now: number): string => FRAMES[Math.floor(now / 250) % FRAMES.length] as string

export function elapsedWord(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

export const tokensDown = (n: number): string => `↓ ${n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : n}`

export const tokenWord = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k ctx` : `${n} ctx`)

export const isEnded = (id: string): boolean => acts.get(id)?.end != null

export type Signal = 'running' | 'slow' | 'quiet' | 'done' | 'failed'
export function signalOf(act: Activity, now: number): Signal {
  if (act.end !== null) return act.end
  const idle = now - act.updatedAt
  if (idle > 120_000) return 'quiet'
  if (idle > 30_000) return 'slow'
  return 'running'
}
