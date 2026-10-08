import type { HarnessCost, HarnessExternalRow, HarnessUsage, HarnessUsageLimit } from '../types'
import type { AgentState } from './external'
import { barParts } from './plan'
import type { Hue } from './plan'

export const REVIEWER_TYPE = 'harness:reviewer'

export const REVIEWER_RULE =
  "Each finding is a candidate, not a fact: it counts only with evidence (a failing test or command, a measurement, or a concrete scenario with file:line); reproduce before fixing; tell the user what you discarded and why; a requirement the user did not ask for is not a defect; 'approved with no findings' is a valid result."

export const EXTERNAL_KEEP = 12

const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g
const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿]/g
const SIGNATURE = /^— answered by codex, (.+)$/m
const PATCH_LINE = /^Patch \(mode 0600\): (.+)$/m
const STAT_BLOCK = /git diff --stat:\n([\s\S]*?)(?:\n\n— answered by codex|$)/
const STAT_TOTAL = /\d+ files? changed/
const KEPT_COPY = /^Could not build the patch \((.*?)\)\./m
const NOTE_LIMIT = 120

export function cleanLine(text: string): string {
  return text
    .replace(OSC, '')
    .replace(CSI, '')
    .replace(/\t/g, ' ')
    .replace(CONTROL, '')
    .replace(INVISIBLE, '')
    .replace(/ {2,}/g, ' ')
    .trim()
}

export function lastLineOf(text: string): string {
  const lines = text
    .split('\n')
    .map(cleanLine)
    .filter(line => line.length > 0)
  return lines[lines.length - 1] ?? ''
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function compact(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value < 1000) return String(Math.round(value))
  const thousands = Math.round(value / 1000)
  if (value < 10_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`
  if (thousands < 1000) return `${thousands}k`
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

type ContextInput = { tokens?: number; window?: number; percent?: number } | undefined

type LimitInput = { kind?: string; percentUsed?: number }

export function usageOf(context: ContextInput, limits: readonly LimitInput[] | undefined): HarnessUsage | null {
  const tokens = finite(context?.tokens)
  const window = finite(context?.window)
  const hasContext = tokens !== null && window !== null && window > 0
  const given = finite(context?.percent)
  const percent = hasContext ? (given ?? (tokens / window) * 100) : null
  const seen: HarnessUsageLimit[] = []
  for (const one of limits ?? []) {
    const used = finite(one.percentUsed)
    if (used === null || (one.kind !== 'five_hour' && one.kind !== 'seven_day')) continue
    seen.push({ kind: one.kind, percentUsed: used })
  }
  if (!hasContext && seen.length === 0) return null
  return { tokens: hasContext ? tokens : null, window: hasContext ? window : null, percent, limits: seen }
}

export function levelHue(percent: number): Hue {
  if (percent >= 90) return 'error'
  if (percent >= 70) return 'warning'
  return 'dim'
}

export type UsagePart = { key: string; text: string; hue: Hue }

export function usageParts(usage: HarnessUsage | null): UsagePart[] {
  if (usage === null) return []
  const parts: UsagePart[] = []
  if (usage.tokens !== null && usage.window !== null && usage.percent !== null) {
    const bar = barParts(usage.percent, 100)
    parts.push({
      key: 'context',
      text: `ctx ${bar.filled}${bar.empty} ${compact(usage.tokens)}/${compact(usage.window)}`,
      hue: levelHue(usage.percent),
    })
  }
  const five = usage.limits.find(one => one.kind === 'five_hour')
  if (five !== undefined) parts.push({ key: 'five_hour', text: `5h ${Math.round(five.percentUsed)}%`, hue: levelHue(five.percentUsed) })
  const week = usage.limits.find(one => one.kind === 'seven_day')
  if (week !== undefined) parts.push({ key: 'seven_day', text: `week ${Math.round(week.percentUsed)}%`, hue: levelHue(week.percentUsed) })
  return parts
}

type StepUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export function addCost(prev: HarnessCost | undefined, usage: StepUsage): HarnessCost {
  const base = prev ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, steps: 0 }
  return {
    input: base.input + (finite(usage.input_tokens) ?? 0),
    output: base.output + (finite(usage.output_tokens) ?? 0),
    cacheRead: base.cacheRead + (finite(usage.cache_read_input_tokens) ?? 0),
    cacheWrite: base.cacheWrite + (finite(usage.cache_creation_input_tokens) ?? 0),
    steps: base.steps + 1,
  }
}

export function costText(cost: HarnessCost | undefined): string {
  if (cost === undefined) return ''
  const cache = cost.cacheRead + cost.cacheWrite
  if (cost.input + cost.output + cache === 0) return ''
  return [`in ${compact(cost.input)}`, `out ${compact(cost.output)}`, cache > 0 ? `cache ${compact(cache)}` : null]
    .filter((one): one is string => one !== null)
    .join(' ')
}

export type ReportFacts = {
  isDone: boolean
  model: string | null
  patch: string | undefined
  stat: string | undefined
  note: string | undefined
}

export function reportFacts(trusted: string, report: string): ReportFacts {
  const signature = SIGNATURE.exec(trusted)
  const said = signature?.[1]?.trim()
  const model = said === undefined || said.startsWith('requested ') || said === 'unknown model' ? null : said
  const patch = PATCH_LINE.exec(trusted)?.[1]
  const block = STAT_BLOCK.exec(trusted)?.[1]
  const lines = (block ?? '')
    .split('\n')
    .map(cleanLine)
    .filter(line => line.length > 0)
  const total = lines.find(line => STAT_TOTAL.test(line))
  const stat = trusted.includes('Codex made no changes') ? 'no changes' : (total ?? lines[lines.length - 1])
  const kept = KEPT_COPY.exec(trusted)?.[1]
  const first = report
    .split('\n')
    .map(cleanLine)
    .find(line => line.length > 0)
  const isDone = signature !== null
  const note = kept !== undefined ? `no patch: ${cleanLine(kept)}` : isDone ? undefined : first?.slice(0, NOTE_LIMIT)
  return {
    isDone,
    model,
    patch: patch === undefined ? undefined : cleanLine(patch),
    stat: stat === undefined ? undefined : cleanLine(stat),
    note,
  }
}

export function deriveExternal(
  prev: HarnessExternalRow | undefined,
  agentId: string,
  state: AgentState | null,
  startedAt: number,
  now: number,
  line: string,
): HarnessExternalRow | null {
  if (prev !== undefined && prev.status !== 'running') return null
  if (state === null) return null
  const base: HarnessExternalRow = prev ?? { agentId, client: 'codex', model: null, status: 'running', startedAt, lastLine: '' }
  const lastLine = line === '' ? base.lastLine : line
  if (state.run !== null) {
    const model = state.run.model === '' ? base.model : cleanLine(state.run.model)
    return { ...base, model, status: 'running', lastLine }
  }
  if (!state.used) return null
  const facts = reportFacts(state.trusted ?? '', state.lastReport)
  const finished: HarnessExternalRow = {
    ...base,
    model: facts.isDone ? facts.model : base.model,
    status: facts.isDone ? 'done' : 'failed',
    endedAt: now,
    lastLine,
  }
  if (facts.patch !== undefined) finished.patch = facts.patch
  if (facts.stat !== undefined) finished.stat = facts.stat
  if (facts.note !== undefined) finished.note = facts.note
  return finished
}

export function stopExternal(row: HarnessExternalRow, now: number): HarnessExternalRow {
  return row.status === 'running' ? { ...row, status: 'failed', endedAt: now, note: 'stopped before it finished' } : row
}

export function pruneExternal(rows: Record<string, HarnessExternalRow>, keep = EXTERNAL_KEEP): Record<string, HarnessExternalRow> {
  const all = Object.values(rows)
  if (all.length <= keep) return rows
  const finished = all
    .filter(row => row.status !== 'running')
    .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
  const drop = new Set(finished.slice(0, all.length - keep).map(row => row.agentId))
  return Object.fromEntries(Object.entries(rows).filter(([id]) => !drop.has(id)))
}

export function orderedExternal(rows: Record<string, HarnessExternalRow>): HarnessExternalRow[] {
  return Object.values(rows).sort((a, b) => {
    if ((a.status === 'running') !== (b.status === 'running')) return a.status === 'running' ? -1 : 1
    return a.status === 'running' ? a.startedAt - b.startedAt : (b.endedAt ?? 0) - (a.endedAt ?? 0)
  })
}

export function runningExternal(rows: Record<string, HarnessExternalRow>): number {
  return Object.values(rows).filter(row => row.status === 'running').length
}

export function externalModel(row: HarnessExternalRow): string {
  return row.model === null || row.model === '' ? 'unconfirmed' : row.model
}

export function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

export function isReviewerResult(input: unknown, result: unknown): boolean {
  const call = recordOf(input)
  const done = recordOf(result)
  if (done === null || done.status !== 'completed') return false
  return call?.subagent_type === REVIEWER_TYPE || done.agentType === REVIEWER_TYPE
}
