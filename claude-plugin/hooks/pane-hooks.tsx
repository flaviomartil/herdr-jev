import type { EngineInterface, On, PluginOptions } from 'claude-code'
import { liveEnabled } from './activity'
import { JEV_PANE_ID, maybeAutoOpen } from './activity-hooks'
import { crewModelNow } from './mod-pane'
import { ensureCrewTimers, recordParent, setProgress, setWaiting, crewNow } from './pane-crew'
import { attentionLines } from './pane-rows'

export const PROGRESS_TOOL = /^mcp__harness__harness_progress$/

export const autoOpenAny = (options: PluginOptions): boolean => options.autoOpenMode === 'any'

export async function registerProgressTool($: EngineInterface, options: PluginOptions): Promise<void> {
  if (!liveEnabled(options)) return
  await $.tool
    .register({
      name: 'harness_progress',
      description:
        'For the main agent only: report the flow to the Jev pane bar. Give a short flow title, the current phase, how many tasks are planned and how many were accepted. Subagents must use harness_step instead. Silent: it only draws a header.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Flow title, a few words.' },
          phase: { type: 'string', description: 'Current phase, one or two words.' },
          planned: { type: 'integer', minimum: 0, description: 'Tasks planned.' },
          accepted: { type: 'integer', minimum: 0, description: 'Tasks accepted so far.' },
        },
        required: ['title'],
      },
      isDeferred: false,
    })
    .catch(() => undefined)
}

const clipWord = (value: unknown, max: number): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '')
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0)

export async function paneSpawned($: EngineInterface, options: PluginOptions, parentId: string | undefined, agentId: string | undefined): Promise<void> {
  if (agentId === undefined || !liveEnabled(options)) return
  await recordParent($, agentId, parentId)
  ensureCrewTimers($, options)
  if (autoOpenAny(options)) await maybeAutoOpen($, options)
}

export async function paneToolCall($: EngineInterface, options: PluginOptions, agentId: string | undefined): Promise<void> {
  if (agentId === undefined || !liveEnabled(options)) return
  if (crewNow().waiting[agentId] === true) await setWaiting($, agentId, false)
  ensureCrewTimers($, options)
  if (autoOpenAny(options)) await maybeAutoOpen($, options)
}

export function registerPaneVisual(on: On, options: PluginOptions): void {
  on('tool.call', { tool: PROGRESS_TOOL }, async ($, e) => {
    if (e.agentId !== undefined || !liveEnabled(options)) return { result: 'ignored: only the main agent reports flow progress' }
    const input = e as unknown as Record<string, unknown>
    const planned = count(input.planned)
    const accepted = Math.min(count(input.accepted), planned)
    await setProgress($, { title: clipWord(input.title, 60), phase: clipWord(input.phase, 20), planned, accepted })
    return { result: 'ok' }
  }).catch(($, e, next) => (next.called ? next(e) : { result: 'ignored' }))

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    const agentId = (e as { agentId?: string }).agentId
    if (agentId !== undefined && liveEnabled(options) && (verdict as { decision?: string }).decision === 'ask') await setWaiting($, agentId, true)
    return verdict
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rendered = await next(e)
    if (!liveEnabled(options) || e.props.hasSurvey) return rendered
    const { model } = await crewModelNow($)
    if (model.rows.length === 0) return rendered
    const placed = (await $.ui.panes().catch(() => [])).some(p => p.id === JEV_PANE_ID && p.isPlaced)
    const lines = placed ? [] : attentionLines(model)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box key="crew-band" flexDirection="column">
        {rendered}
        <Box key="crew-head" paddingX={1} flexDirection="row" columnGap={1}>
          <Button key="crew-open" plain label={`◉ ${model.rows.length}`} onPress={() => $.ui.open({ id: JEV_PANE_ID, title: 'Jev', focus: true, closeOnEscape: true })} />
          <Text key="crew-sum" dimColor>{`${model.hub?.running ?? 0} ativos`}</Text>
        </Box>
        {lines.map((line, i) => (
          <Box key={`crew-l${i}`} paddingX={1}>
            <Text dimColor wrap="truncate-end">{line}</Text>
          </Box>
        ))}
      </Box>
    )
  }).catch(($, e, next) => next(e))
}
