import type { EngineInterface, PluginOptions, TurnStepChunk, TurnStepInput, TurnStepResult } from 'claude-code'
import { cliConfig, runJson } from './cli'
import { family, isWaiting, startWait } from './wait'

export const failoverEnabled = (options: PluginOptions): boolean => options.failover === true

const DIAGNOSE_EVERY_MS = 300_000
const DIAGNOSE_TIMEOUT_MS = 15_000
const HEALTH_TIMEOUT_MS = 10_000
const TIER_BELOW: Record<string, string> = { opus: 'sonnet', sonnet: 'haiku' }

const swapped = new Set<string>()
const turnModels = new Map<string, string>()
const diagnosedAt = new Map<string, number>()

type StepNext = ((input: TurnStepInput) => AsyncGenerator<TurnStepChunk, TurnStepResult>) & {
  budget: { remainingMs: number }
  signal: AbortSignal
}

export function resetFailover(): void {
  swapped.clear()
  turnModels.clear()
  diagnosedAt.clear()
}

export function tierBelow(model: string): string | null {
  return TIER_BELOW[family(model)] ?? null
}

export function isEmptyStep(result: TurnStepResult): boolean {
  return result.answer === '' && result.toolUses.length === 0 && result.stopReason === null
}

export async function* failoverStep(options: PluginOptions, e: TurnStepInput, next: StepNext): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  const first = yield* next(e)
  if (!failoverEnabled(options)) return first
  turnModels.set(e.turnId, e.model)
  if (!isEmptyStep(first) || swapped.has(e.turnId) || next.signal.aborted || next.budget.remainingMs <= 0) return first
  const to = tierBelow(e.model)
  if (to === null) return first
  swapped.add(e.turnId)
  turnModels.set(e.turnId, to)
  return yield* next({ ...e, model: to })
}

type Diagnosis = { kind: 'ok' } | { kind: 'quota' | 'overload' | 'auth'; status: number | null }

export function classifyStatus(status: number | null): 'quota' | 'overload' | 'auth' {
  if (status === 429) return 'quota'
  if (status === 401 || status === 403) return 'auth'
  return 'overload'
}

async function lockState($: EngineInterface, options: PluginOptions, key: string): Promise<{ locked: boolean; until: number | null }> {
  const cwd = await $.session.cwd()
  const ran = await runJson((a, init) => $.process.run(a, init), cliConfig(options, cwd), ['health', 'check', '--key', key], HEALTH_TIMEOUT_MS)
  const value = ran.ok && typeof ran.value === 'object' && ran.value !== null ? (ran.value as { locked?: unknown; until?: unknown }) : {}
  return { locked: value.locked === true, until: typeof value.until === 'number' ? value.until : null }
}

async function lock($: EngineInterface, options: PluginOptions, key: string, reason: string): Promise<void> {
  const cwd = await $.session.cwd()
  await runJson((a, init) => $.process.run(a, init), cliConfig(options, cwd), ['health', 'lock', '--key', key, '--reason', reason], HEALTH_TIMEOUT_MS)
}

export async function diagnose($: EngineInterface, options: PluginOptions, model: string): Promise<Diagnosis | 'skipped'> {
  const now = await $.clock.now()
  const last = diagnosedAt.get(family(model))
  if (last !== undefined && now - last < DIAGNOSE_EVERY_MS) return 'skipped'
  const key = `claude/${family(model)}`
  const existing = await lockState($, options, key)
  if (existing.locked) return 'skipped'
  diagnosedAt.set(family(model), now)
  const r = await $.model.complete({ model, prompt: 'ping', maxTokens: 1, effort: 'low', timeoutMs: DIAGNOSE_TIMEOUT_MS })
  if (r.isAnswered || r.reason === 'empty-reply') return { kind: 'ok' }
  if (r.reason !== 'api-error') return { kind: 'ok' }
  const kind = classifyStatus(r.status)
  await lock($, options, key, kind === 'auth' ? 'auth' : 'quota').catch(() => undefined)
  return { kind, status: r.status }
}

export async function onTurnComplete($: EngineInterface, options: PluginOptions, turnId: string, reason: string): Promise<void> {
  const model = turnModels.get(turnId)
  turnModels.delete(turnId)
  swapped.delete(turnId)
  if (!failoverEnabled(options) || reason !== 'error' || model === undefined || isWaiting()) return
  try {
    const state = await lockState($, options, `claude/${family(model)}`)
    if (state.locked) return await startWait($, options, { model, reason: 'quota', until: state.until })
    const out = await diagnose($, options, model)
    if (out === 'skipped' || out.kind === 'ok') return
    if (out.kind === 'auth') {
      $.ui.toast(`Claude login failed for ${family(model)}. Run /login.`, { timeoutMs: 15000 })
      return
    }
    await startWait($, options, { model, reason: out.kind, until: null })
  } catch {
    return
  }
}
