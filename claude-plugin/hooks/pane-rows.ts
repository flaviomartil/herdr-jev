import type { ArtKind, ArtState, RoleMark } from './art-core'
import { SIGNAL_VIEW, classifySignal } from './pane-signal'
import type { Signal } from './pane-signal'

export const PAGE_SIZE = 3
export const ATTENTION_MAX = 5

export type CrewInput = {
  id: string
  actId: string | null
  name: string
  kind: ArtKind
  cli: string
  role: RoleMark | null
  state: 'working' | 'queued' | 'done' | 'failed'
  line: string
  percent: number | null
  act: { startedAt: number; updatedAt: number; endedAt: number | null; end: 'done' | 'failed' | null } | null
}

export type CrewContext = {
  parents: Readonly<Record<string, string>>
  gone: Readonly<Record<string, true>>
  waiting: Readonly<Record<string, true>>
  listed: readonly string[]
  now: number
  page: number
  pageSize?: number
}

export type CrewRow = CrewInput & {
  depth: number
  signal: Signal
  glyph: string
  color: string
  word: string
  artState: ArtState
  ageMs: number
  isLead: boolean
}

export type CrewModel = {
  hub: { running: number; total: number } | null
  rows: CrewRow[]
  pageRows: CrewRow[]
  page: number
  pages: number
  unknown: string[]
}

export function fitPageSize(availableRows: number, rowCount: number, rowHeight: number): number {
  if (rowCount * rowHeight <= availableRows) return Math.max(1, rowCount)
  return Math.max(1, Math.floor((availableRows - 1) / rowHeight))
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

export function artStateOf(signal: Signal, queued: boolean): ArtState {
  if (queued && signal === 'running') return 'idle'
  switch (signal) {
    case 'running':
    case 'slow':
      return 'running'
    case 'waiting':
      return 'waiting'
    case 'quiet':
      return 'idle'
    case 'done':
      return 'done'
    case 'failed':
      return 'failed'
    case 'gone':
      return 'gone'
  }
}

export function orderTree(inputs: readonly CrewInput[], parents: Readonly<Record<string, string>>): { input: CrewInput; depth: number; isLead: boolean }[] {
  const ids = new Set(inputs.map(i => i.id))
  const keyOf = (i: CrewInput): string[] => [i.id, ...(i.actId === null ? [] : [i.actId])]
  const idOf = new Map<string, string>()
  for (const i of inputs) for (const k of keyOf(i)) idOf.set(k, i.id)
  const parentOf = new Map<string, string>()
  for (const i of inputs) {
    const raw = keyOf(i).map(k => parents[k]).find(p => p !== undefined)
    const mapped = raw === undefined ? undefined : idOf.get(raw)
    if (mapped !== undefined && mapped !== i.id && ids.has(mapped)) parentOf.set(i.id, mapped)
  }
  const roots = inputs.filter(i => !parentOf.has(i.id))
  const workers = roots.filter(i => i.role !== 'review')
  const reviewer = workers.at(-1)
  if (reviewer !== undefined) {
    for (const r of roots) if (r.role === 'review') parentOf.set(r.id, reviewer.id)
  }
  const children = new Map<string, CrewInput[]>()
  for (const i of inputs) {
    const p = parentOf.get(i.id)
    if (p !== undefined) children.set(p, [...(children.get(p) ?? []), i])
  }
  const out: { input: CrewInput; depth: number; isLead: boolean }[] = []
  const seen = new Set<string>()
  const walk = (i: CrewInput, depth: number): void => {
    if (seen.has(i.id)) return
    seen.add(i.id)
    const kids = [...(children.get(i.id) ?? [])].sort((a, b) => Number(a.role === 'review') - Number(b.role === 'review'))
    out.push({ input: i, depth, isLead: kids.length > 0 && i.role !== 'review' })
    for (const kid of kids) walk(kid, depth + 1)
  }
  for (const root of roots.filter(r => parentOf.get(r.id) === undefined)) walk(root, 0)
  for (const i of inputs) walk(i, 0)
  return out
}

export function buildCrew(inputs: readonly CrewInput[], ctx: CrewContext): CrewModel {
  const tree = orderTree(inputs, ctx.parents)
  const delegating = inputs.some(i => i.state === 'working' || i.state === 'queued')
  const hub = inputs.length > 0 && delegating ? { running: inputs.filter(i => i.state === 'working').length, total: inputs.length } : null
  const base = hub === null ? 0 : 1
  const rows: CrewRow[] = tree.map(({ input, depth, isLead }) => {
    const end = input.act?.end ?? (input.state === 'done' ? 'done' : input.state === 'failed' ? 'failed' : null)
    const key = input.actId ?? input.id
    const signal = classifySignal({
      end,
      gone: ctx.gone[key] === true || ctx.gone[input.id] === true,
      waiting: ctx.waiting[key] === true || ctx.waiting[input.id] === true,
      idleMs: input.act === null ? 0 : Math.max(0, ctx.now - input.act.updatedAt),
    })
    const view = SIGNAL_VIEW[signal]
    return {
      ...input,
      depth: depth + base,
      signal,
      glyph: view.glyph,
      color: view.color,
      word: view.word,
      artState: artStateOf(signal, input.state === 'queued'),
      ageMs: input.act?.endedAt == null ? Number.POSITIVE_INFINITY : Math.max(0, ctx.now - input.act.endedAt),
      isLead,
    }
  })
  const known = new Set(inputs.flatMap(i => [i.id, ...(i.actId === null ? [] : [i.actId])]))
  const size = Math.max(1, ctx.pageSize ?? PAGE_SIZE)
  const pages = Math.max(1, Math.ceil(rows.length / size))
  const page = Math.min(Math.max(0, ctx.page), pages - 1)
  return {
    hub,
    rows,
    pageRows: rows.slice(page * size, page * size + size),
    page,
    pages,
    unknown: ctx.listed.filter(id => !known.has(id)),
  }
}

export const needsAttention = (row: CrewRow): boolean => SIGNAL_VIEW[row.signal].needsAttention

export function rowLine(row: CrewRow): string {
  const detail = row.line === '' ? '' : `: ${clip(row.line, 40)}`
  return `${'  '.repeat(row.depth)}${row.glyph} ${row.name} ${row.cli} ${row.word}${detail}`
}

export function attentionLines(model: CrewModel, max = ATTENTION_MAX): string[] {
  const wanted = model.rows.filter(needsAttention)
  const lines = wanted.slice(0, max).map(rowLine)
  const extra = wanted.length - lines.length
  if (extra > 0) lines.push(`+${extra} precisam de atencao`)
  if (model.unknown.length > 0) lines.push(`? ${model.unknown.length} agentes desconhecidos`)
  return lines
}

export function reportLines(model: CrewModel): string[] {
  if (model.rows.length === 0 && model.unknown.length === 0) return ['Nenhum agente ativo.']
  const lines = model.hub === null ? [] : [`◆ lead · ${model.hub.running}/${model.hub.total} trabalhando`]
  for (const row of model.rows) lines.push(rowLine(row))
  if (model.unknown.length > 0) lines.push(`? ${model.unknown.length} agentes desconhecidos`)
  return lines
}

export type FlowProgress = { title: string; phase: string; planned: number; accepted: number }
export type OddCurrent = { name: string; done: number; total: number; phase: string | null }

export function headerText(flow: FlowProgress | null, odd: OddCurrent | null): string | null {
  if (odd !== null) return [odd.name, odd.phase, `${odd.done}/${odd.total}`].filter(p => p !== null && p !== '').join(' · ')
  if (flow === null) return null
  return [flow.title, flow.phase, `${flow.accepted}/${flow.planned}`].filter(p => p !== '').join(' · ')
}
