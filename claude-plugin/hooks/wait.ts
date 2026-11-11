import { atom, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Timer } from 'claude-code'
import { cliConfig, runJson } from './cli'

export type WaitReason = 'quota' | 'overload'
export type WaitInfo = { model: string; reason: WaitReason; until: number | null }
export type WaitView = { text: string; until: number | null }

export const waitAtom = atom({ plugin: 'harness', key: 'wait' } as const, null as WaitView | null)

const PROBE_MS = [60_000, 120_000, 300_000, 600_000, 900_000]
const DEFAULT_MAX_MINUTES = 360
const PROBE_TIMEOUT_MS = 20_000
const HEALTH_TIMEOUT_MS = 10_000
const RESUME_TEXT = 'The model is available again. Continue the task that was interrupted.'

type Current = {
  info: WaitInfo
  startedAt: number
  probe: number
  nextAt: number
  wake: Timer | null
  tick: Timer | null
}

let current: Current | null = null

export const waitEnabled = (options: PluginOptions): boolean => options.failover === true
export const autoResume = (options: PluginOptions): boolean => options.autoResume === true
export const isWaiting = (): boolean => current !== null

export function maxWaitMs(options: PluginOptions): number {
  const raw = options.maxWaitMinutes
  return (typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_MINUTES) * 60_000
}

export function family(model: string): string {
  const found = /opus|sonnet|haiku|fable/i.exec(model)
  return found === null ? model : found[0].toLowerCase()
}

export function countdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`
}

export function viewOf(wait: Current, now: number): WaitView {
  const label = `${family(wait.info.model)} ${wait.info.reason === 'quota' ? 'quota' : 'overloaded'}`
  const until = wait.info.until
  return until === null
    ? { text: `waiting: ${label}, next probe in ${countdown(wait.nextAt - now)}`, until: null }
    : { text: `waiting: ${label}, back in ${countdown(until - now)}`, until }
}

export function resetWait(): void {
  current?.wake?.cancel()
  current?.tick?.cancel()
  current = null
}

async function health($: EngineInterface, options: PluginOptions, argv: string[]): Promise<void> {
  try {
    const cwd = await $.session.cwd()
    await runJson((a, init) => $.process.run(a, init), cliConfig(options, cwd), ['health', ...argv], HEALTH_TIMEOUT_MS)
  } catch {
    return
  }
}

async function clear($: EngineInterface): Promise<void> {
  current?.wake?.cancel()
  current?.tick?.cancel()
  current = null
  try {
    await update($, waitAtom, () => null)
  } catch {
    return
  }
}

async function release($: EngineInterface, options: PluginOptions, info: WaitInfo): Promise<void> {
  await clear($)
  await health($, options, ['clear', '--key', `claude/${family(info.model)}`])
  const name = family(info.model)
  if (autoResume(options)) {
    $.ui.toast(`${name} is back, resuming`, { timeoutMs: 8000 })
    void $.prompt.submit({ text: RESUME_TEXT })
    return
  }
  $.ui.toast(`${name} is back. Send a message to continue.`, { timeoutMs: 15000 })
  $.ui.log(`Model ${name} is available again. Continue the interrupted task? Send a message, for example "continue".`)
}

async function end($: EngineInterface, info: WaitInfo): Promise<void> {
  await clear($)
  $.ui.toast(`Stopped waiting for ${family(info.model)} after the wait ceiling. Check the account and retry.`, { timeoutMs: 15000 })
}

function schedule($: EngineInterface, options: PluginOptions, wait: Current, now: number): void {
  const until = wait.info.until
  const at = until !== null ? until : now + PROBE_MS[Math.min(wait.probe, PROBE_MS.length - 1)]!
  wait.nextAt = at
  wait.wake?.cancel()
  wait.wake = $.clock.after(Math.max(0, at - now), () => {
    void onWake($, options, wait)
  })
}

async function onWake($: EngineInterface, options: PluginOptions, wait: Current): Promise<void> {
  if (current !== wait) return
  const now = await $.clock.now()
  if (now - wait.startedAt >= maxWaitMs(options)) return end($, wait.info)
  if (wait.info.until !== null) return release($, options, wait.info)
  let answered = false
  try {
    const r = await $.model.complete({ model: wait.info.model, prompt: 'ping', maxTokens: 1, effort: 'low', timeoutMs: PROBE_TIMEOUT_MS })
    answered = r.isAnswered || r.reason === 'empty-reply'
  } catch {
    answered = false
  }
  if (current !== wait) return
  if (answered) return release($, options, wait.info)
  wait.probe += 1
  schedule($, options, wait, await $.clock.now())
}

export async function startWait($: EngineInterface, options: PluginOptions, info: WaitInfo): Promise<void> {
  if (!waitEnabled(options)) return
  if (current !== null) return
  const now = await $.clock.now()
  const wait: Current = { info, startedAt: now, probe: 0, nextAt: now, wake: null, tick: null }
  current = wait
  schedule($, options, wait, now)
  const paint = async (at: number) => {
    if (current !== wait) return
    await update($, waitAtom, () => viewOf(wait, at))
  }
  await paint(now)
  wait.tick = $.clock.every(1000, () => {
    void $.clock.now().then(paint)
  })
  $.ui.toast(`Waiting for ${family(info.model)} (${info.reason}). Any message cancels the wait.`, { timeoutMs: 10000 })
}

export async function cancelWait($: EngineInterface): Promise<boolean> {
  if (current === null) return false
  const name = family(current.info.model)
  await clear($)
  $.ui.toast(`Wait for ${name} cancelled`, { timeoutMs: 5000 })
  return true
}
