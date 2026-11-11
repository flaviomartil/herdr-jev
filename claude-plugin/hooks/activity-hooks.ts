import { atom, read } from 'claude-code'
import type { EngineInterface, On, PluginOptions, TurnStepChunk, TurnStepResult } from 'claude-code'
import {
  STEP_TOOL, autoOpenEnabled, liveEnabled, noteEnd, noteSelfReport, noteSnippet, noteStep, noteTool, noteUsage,
  publishActivity, toastFailureOnce,
} from './activity'
import { describeTool } from './plan'
import { update } from 'claude-code'

const jevHintAtom = atom({ plugin: 'harness', key: 'jevHint' } as const, '')

export const JEV_PANE_ID = 'jev'
export const HINT_TEXT = '/jev para acompanhar'
let userClosed = false

export function resetAutoOpen(): void {
  userClosed = false
}

export function markUserClosed(): void {
  userClosed = true
}

export function paneWanted(): void {
  userClosed = false
}

async function nowOf($: EngineInterface): Promise<number> {
  try {
    return await $.clock.now()
  } catch {
    return Date.now()
  }
}

async function attempt($: EngineInterface, label: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work()
  } catch (error) {
    $.ui.log(`harness: ${label} failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`, { to: 'debug' })
  }
}

export async function maybeAutoOpen($: EngineInterface, options: PluginOptions): Promise<void> {
  if (!autoOpenEnabled(options) || userClosed) return
  await attempt($, 'auto open jev pane', async () => {
    const panes = await $.ui.panes().catch(() => [])
    if (panes.some(p => p.id === JEV_PANE_ID && p.isPlaced)) return
    const opened = await $.ui.open({ id: JEV_PANE_ID, title: 'Jev', closeOnEscape: true })
    if (opened?.isPlaced === false) {
      if ((await read($, jevHintAtom)) !== HINT_TEXT) $.ui.toast(HINT_TEXT)
      await update($, jevHintAtom, () => HINT_TEXT)
    } else await update($, jevHintAtom, () => '')
  })
}

export function toolLine(tool: string, input: Readonly<Record<string, unknown>>): string {
  const str = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 50) : '')
  if (tool === 'Bash' && str(input.command) !== '') return `Bash: ${str(input.command)}`
  if ((tool === 'Grep' || tool === 'WebSearch') && str(input.pattern ?? input.query) !== '') return `${tool}: ${str(input.pattern ?? input.query)}`
  return describeTool(tool, input)
}

export async function registerStepTool($: EngineInterface, options: PluginOptions): Promise<void> {
  if (!liveEnabled(options)) return
  await attempt($, 'register harness_step', () =>
    $.tool.register({
      name: 'harness_step',
      description:
        'For subagents: report progress on your own task to the Jev pane. Call it with total (your plan in 3 to 8 steps) and done 0 after reading the brief, then again as each step finishes. Cheap and silent: it only draws a bar.',
      inputSchema: {
        type: 'object',
        properties: {
          done: { type: 'integer', minimum: 0, description: 'Steps finished so far.' },
          total: { type: 'integer', minimum: 1, description: 'Steps planned; may change.' },
          percent: { type: 'number', minimum: 0, maximum: 100, description: 'Only when steps do not fit.' },
          note: { type: 'string', description: 'The step in progress, a few words.' },
        },
        required: ['done'],
      },
      isDeferred: false,
    }),
  )
}

export async function liveToolCall($: EngineInterface, options: PluginOptions, e: { tool: unknown; agentId?: string }): Promise<void> {
  if (!liveEnabled(options)) return
  const agentId = e.agentId
  const tool = String(e.tool)
  if (agentId !== undefined && !STEP_TOOL.test(tool)) {
    noteTool(agentId, await nowOf($), tool, toolLine(tool, e as unknown as Record<string, unknown>))
    await attempt($, 'publish tool', () => publishActivity($))
  } else if (agentId === undefined && tool === 'Agent') await maybeAutoOpen($, options)
}

export async function* liveStep(
  $: EngineInterface,
  options: PluginOptions,
  agentId: string,
  source: AsyncGenerator<TurnStepChunk, TurnStepResult>,
): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  if (!liveEnabled(options)) return yield* source
  noteStep(agentId, await nowOf($))
  await attempt($, 'publish step', () => publishActivity($))
  for (;;) {
    const step = await source.next()
    if (step.done) {
      const result = step.value
      const at = await nowOf($)
      if (typeof result.answer === 'string') noteSnippet(agentId, at, result.answer)
      const u = result.usage
      if (u !== null && u !== undefined) noteUsage(agentId, at, (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0))
      await attempt($, 'publish usage', () => publishActivity($))
      return result
    }
    yield step.value
  }
}

export async function liveTurnComplete($: EngineInterface, options: PluginOptions, e: { agentId?: string; reason: string; answer?: string }): Promise<void> {
  if (!liveEnabled(options) || e.agentId === undefined) return
  const agentId = e.agentId
  const ok = e.reason === 'answer'
  noteEnd(agentId, await nowOf($), ok, e.answer ?? '')
  await attempt($, 'publish end', () => publishActivity($))
  if (!ok) await attempt($, 'toast failure', () => toastFailureOnce($, agentId, e.answer || agentId))
}

export function registerActivity(on: On, options: PluginOptions): void {
  on('ui.close', async ($, e, next) => {
    if (e.id === JEV_PANE_ID && e.origin?.kind === 'person') userClosed = true
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: STEP_TOOL }, async ($, e) => {
    const agentId = e.agentId
    if (agentId === undefined || !liveEnabled(options)) return { result: 'ignored: only subagents report steps' }
    noteSelfReport(agentId, await nowOf($), e as unknown as Record<string, unknown>)
    await attempt($, 'publish step', () => publishActivity($))
    return { result: 'ok' }
  }).catch(($, e, next) => (next.called ? next(e) : { result: 'ignored' }))
}

