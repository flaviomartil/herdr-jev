import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { HarnessCost } from '../types'
import {
  addCost,
  cleanLine,
  compact,
  costText,
  deriveExternal,
  isReviewerResult,
  lastLineOf,
  levelHue,
  orderedExternal,
  pruneExternal,
  reportFacts,
  REVIEWER_RULE,
  runningExternal,
  stopExternal,
  usageOf,
  usageParts,
} from '../hooks/visual'
import type { AgentState } from '../hooks/external'
import { BAND_PROPS, CWD, finish, makePlan, PANE_PROPS, planState, runTask, STATUS_TOOL, wire } from './support'

const start = ($: Engine) => $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

const paneUi = ($: Engine, columns = PANE_PROPS.bodyColumns) =>
  $.ui.mount({ plugin: 'harness', surface: 'terminal', component: 'Pane', requestId: 'harness', props: { ...PANE_PROPS, bodyColumns: columns } })

const bandUi = ($: Engine) =>
  $.ui.mount({ plugin: 'harness', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })

const OPTIONS = { options: { autoRun: false } }

const THREE = {
  objective: 'Ship the parser',
  tasks: [{ title: 'Add parser' }, { title: 'Design the data model' }],
}

test('token counts are compact', () => {
  expect(compact(0)).toBe('0')
  expect(compact(Number.NaN)).toBe('0')
  expect(compact(950)).toBe('950')
  expect(compact(1500)).toBe('1.5k')
  expect(compact(2000)).toBe('2k')
  expect(compact(12_345)).toBe('12k')
  expect(compact(999_900)).toBe('1M')
  expect(compact(1_200_000)).toBe('1.2M')
})

test('thresholds colour 70 as warning and 90 as error and leave the rest dim', () => {
  expect(levelHue(0)).toBe('dim')
  expect(levelHue(69.9)).toBe('dim')
  expect(levelHue(70)).toBe('warning')
  expect(levelHue(89.9)).toBe('warning')
  expect(levelHue(90)).toBe('error')
  expect(levelHue(100)).toBe('error')
})

test('usage keeps only what the engine reported and never invents a zero', () => {
  expect(usageOf({}, [])).toBeNull()
  expect(usageOf(undefined, undefined)).toBeNull()
  expect(usageOf({ window: 200_000 }, [])).toBeNull()
  expect(usageOf({ tokens: 10, window: 0 }, [])).toBeNull()
  expect(usageOf({ tokens: 50_000, window: 200_000 }, [])).toMatchObject({ tokens: 50_000, window: 200_000, percent: 25, limits: [] })
  expect(usageOf({ tokens: 1, window: 100, percent: 7 }, [])?.percent).toBe(7)
  expect(usageOf({}, [{ kind: 'spend_limit', percentUsed: 50 }])).toBeNull()
  expect(usageOf({}, [{ kind: 'five_hour' }, { kind: 'seven_day', percentUsed: Number.NaN }])).toBeNull()
  expect(usageOf({}, [{ kind: 'five_hour', percentUsed: 0 }])?.limits).toEqual([{ kind: 'five_hour', percentUsed: 0 }])
})

test('usage parts are a context bar with tokens over window and the two quota windows', () => {
  const parts = usageParts(usageOf({ tokens: 120_000, window: 200_000, percent: 60 }, [
    { kind: 'seven_day', percentUsed: 81.2 },
    { kind: 'five_hour', percentUsed: 23.4 },
  ]))
  expect(parts.map(one => one.text)).toEqual(['ctx ██████░░░░ 120k/200k', '5h 23%', 'week 81%'])
  expect(parts.map(one => one.hue)).toEqual(['dim', 'dim', 'warning'])
  expect(usageParts(null)).toEqual([])
  expect(usageParts(usageOf({}, [{ kind: 'seven_day', percentUsed: 3 }])).map(one => one.key)).toEqual(['seven_day'])
})

test('control characters, escapes and invisible direction marks never reach a row', () => {
  expect(cleanLine('work \u001b[31mred\u001b[0m\u0007 bell\r\u0000 ‮end')).toBe('work red bell end')
  expect(cleanLine('a\u001b]0;title\u0007b\tc')).toBe('ab c')
  expect(cleanLine('\u0085\u009b31m')).toBe('31m')
  expect(lastLineOf('one\n\n  two  \u0007\n\u001b[2K\n')).toBe('two')
  expect(lastLineOf('\n\n')).toBe('')
})

test('cost adds the four counts across steps and prints a compact total', () => {
  let cost: HarnessCost | undefined
  cost = addCost(cost, { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 4000, cache_creation_input_tokens: 500 })
  cost = addCost(cost, { input_tokens: 500, output_tokens: 50, cache_read_input_tokens: 6000, cache_creation_input_tokens: 0 })
  expect(cost).toEqual({ input: 1500, output: 250, cacheRead: 10_000, cacheWrite: 500, steps: 2 })
  expect(costText(cost)).toBe('in 1.5k out 250 cache 11k')
  expect(costText(undefined)).toBe('')
  expect(costText(addCost(undefined, { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }))).toBe('')
  expect(costText({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, steps: 1 })).toBe('in 10 out 5')
})

const REPORT_PATCH = [
  'Done.',
  '',
  'Patch (mode 0600): /state/codex-patches/a.patch',
  "Check it first with: git -C '/work' apply --stat --check '/state/codex-patches/a.patch'",
  'git diff --stat:\n hello.txt | 1 +\n 1 file changed, 1 insertion(+)',
  '',
  '— answered by codex, gpt-6.1-sol',
].join('\n')

test('a finished report yields the model, the patch path and the diff stat summary', () => {
  expect(reportFacts(REPORT_PATCH)).toEqual({
    isDone: true,
    model: 'gpt-6.1-sol',
    patch: '/state/codex-patches/a.patch',
    stat: '1 file changed, 1 insertion(+)',
    note: undefined,
  })
  expect(reportFacts('hello\n\nCodex made no changes; the throwaway copy was removed.\n\n— answered by codex, unknown model')).toMatchObject({
    isDone: true,
    model: null,
    patch: undefined,
    stat: 'no changes',
  })
  expect(reportFacts('x\n\n— answered by codex, requested gpt-9, unconfirmed').model).toBeNull()
  expect(reportFacts('Done\n\nCould not build the patch (git add failed). The throwaway copy was kept at /s.\n\n— answered by codex, m').note).toBe('no patch: git add failed')
  expect(reportFacts('Codex ended with no answer.\nboom')).toMatchObject({ isDone: false, note: 'Codex ended with no answer.' })
  expect(reportFacts('harness:codex did not run: the prompt is empty.').isDone).toBe(false)
})

const stateOf = (over: Partial<AgentState> = {}): AgentState => ({
  prompt: 'x',
  cwd: null,
  runs: 1,
  deliveries: 0,
  run: null,
  delivered: null,
  lastReport: '',
  used: true,
  ...over,
})

const liveRun = (model: string): NonNullable<AgentState['run']> =>
  ({ model, requested: null, id: 1 }) as unknown as NonNullable<AgentState['run']>

test('an external row follows the run: running with the model it reports, then finished and frozen', () => {
  const running = deriveExternal(undefined, 'a1', stateOf({ run: liveRun('') }), 100, 120, '▸ cat note.txt')
  expect(running).toEqual({ agentId: 'a1', client: 'codex', model: null, status: 'running', startedAt: 100, lastLine: '▸ cat note.txt' })
  const confirmed = deriveExternal(running ?? undefined, 'a1', stateOf({ run: liveRun('gpt-6.1-sol') }), 200, 220, '')
  expect(confirmed).toMatchObject({ model: 'gpt-6.1-sol', status: 'running', startedAt: 100, lastLine: '▸ cat note.txt' })
  const done = deriveExternal(confirmed ?? undefined, 'a1', stateOf({ lastReport: REPORT_PATCH }), 300, 340, '')
  expect(done).toMatchObject({
    status: 'done',
    model: 'gpt-6.1-sol',
    startedAt: 100,
    endedAt: 340,
    patch: '/state/codex-patches/a.patch',
    stat: '1 file changed, 1 insertion(+)',
  })
  expect(deriveExternal(done ?? undefined, 'a1', stateOf({ lastReport: 'harness:codex follow-ups are not supported yet.' }), 400, 440, '')).toBeNull()
  expect(deriveExternal(undefined, 'a1', null, 1, 1, '')).toBeNull()
  expect(deriveExternal(undefined, 'a1', stateOf({ used: false }), 1, 1, '')).toBeNull()
  expect(deriveExternal(undefined, 'a1', stateOf({ lastReport: 'harness:codex did not run: no.' }), 1, 2, '')).toMatchObject({ status: 'failed', note: 'harness:codex did not run: no.' })
})

test('rows are ordered running first, stopped when their turn ends, and pruned oldest finished first', () => {
  const rows = {
    a: { agentId: 'a', client: 'codex', model: null, status: 'done' as const, startedAt: 1, endedAt: 50, lastLine: '' },
    b: { agentId: 'b', client: 'codex', model: null, status: 'running' as const, startedAt: 20, lastLine: '' },
    c: { agentId: 'c', client: 'codex', model: null, status: 'failed' as const, startedAt: 2, endedAt: 90, lastLine: '' },
    d: { agentId: 'd', client: 'codex', model: null, status: 'running' as const, startedAt: 10, lastLine: '' },
  }
  expect(orderedExternal(rows).map(one => one.agentId)).toEqual(['d', 'b', 'c', 'a'])
  expect(runningExternal(rows)).toBe(2)
  expect(stopExternal(rows.b, 99)).toMatchObject({ status: 'failed', endedAt: 99, note: 'stopped before it finished' })
  expect(stopExternal(rows.a, 99)).toBe(rows.a)
  expect(Object.keys(pruneExternal(rows, 3))).toEqual(['b', 'c', 'd'])
  expect(Object.keys(pruneExternal(rows, 2))).toEqual(['b', 'd'])
  expect(pruneExternal(rows, 10)).toBe(rows)
})

test('only a completed harness:reviewer result counts as a reviewer result', () => {
  expect(isReviewerResult({ subagent_type: 'harness:reviewer' }, { status: 'completed', agentId: 'a' })).toBe(true)
  expect(isReviewerResult({}, { status: 'completed', agentType: 'harness:reviewer' })).toBe(true)
  expect(isReviewerResult({ subagent_type: 'harness:reviewer' }, { status: 'async_launched', agentId: 'a' })).toBe(false)
  expect(isReviewerResult({ subagent_type: 'harness:implementer' }, { status: 'completed', agentType: 'harness:implementer' })).toBe(false)
  expect(isReviewerResult({ subagent_type: 'harness:reviewer' }, 'text')).toBe(false)
  expect(isReviewerResult({ subagent_type: 'harness:reviewer' }, null)).toBe(false)
})

test('the pane footer is one compact line with the context bar and both quota windows', async ($, on) => {
  const seen = wire(on)
  seen.usage.context = { tokens: 120_000, window: 200_000, percent: 60 }
  seen.usage.rateLimits = [
    { kind: 'five_hour', percentUsed: 23.4 },
    { kind: 'seven_day', percentUsed: 7 },
  ]
  await start($)
  const ui = await paneUi($)
  expect((await ui.find({ type: 'Text', text: /^ctx / }))?.text).toBe('ctx ██████░░░░ 120k/200k')
  expect((await ui.find({ type: 'Text', text: '5h 23%' }))?.props.dimColor).toBe(true)
  expect((await ui.find({ type: 'Text', text: 'week 7%' }))?.props.dimColor).toBe(true)
  expect(await ui.find({ type: 'Box', key: 'usage' })).toBeDefined()
  expect(seen.usageCalls.length).toBeGreaterThan(0)
  expect(seen.usageCalls.every(call => call === undefined)).toBe(true)
  await ui.unmount()
})

test('the footer sits under the plan footer too', OPTIONS, async ($, on) => {
  const seen = wire(on)
  seen.usage.context = { tokens: 20_000, window: 200_000, percent: 10 }
  await start($)
  await makePlan($, THREE)
  const ui = await paneUi($)
  expect(await ui.find({ type: 'Text', text: /advisor fable-5-1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'ctx █░░░░░░░░░ 20k/200k' })).toBeDefined()
  await ui.unmount()
})

test('session.measure pushes new figures and the footer colours them by threshold', async ($, on) => {
  const seen = wire(on)
  seen.usage.context = { tokens: 20_000, window: 200_000, percent: 10 }
  await start($)
  await $.session.measure({
    context: { tokens: 185_000, window: 200_000, percent: 92.5 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 71 },
      { kind: 'seven_day', percentUsed: 95.2 },
    ],
    changed: ['context', 'rateLimits'],
  })
  const ui = await paneUi($)
  const ctx = await ui.find({ type: 'Text', text: /^ctx / })
  expect(ctx?.text).toBe('ctx █████████░ 185k/200k')
  expect(ctx?.props.color).toBe('error')
  expect((await ui.find({ type: 'Text', text: '5h 71%' }))?.props.color).toBe('warning')
  expect((await ui.find({ type: 'Text', text: 'week 95%' }))?.props.color).toBe('error')
  expect(seen.state.get('harness.usage')).toMatchObject({ tokens: 185_000, window: 200_000, percent: 92.5 })
  await ui.unmount()
})

test('missing usage data shows nothing, never a zero', async ($, on) => {
  const seen = wire(on)
  await start($)
  const bare = await paneUi($)
  for (const text of [/^ctx /, /^5h /, /^week /, /0%/]) expect(await bare.find({ type: 'Text', text })).toBeUndefined()
  expect(await bare.find({ type: 'Box', key: 'usage' })).toBeUndefined()
  await bare.unmount()

  seen.usage.context = { window: 200_000 }
  seen.usage.rateLimits = [{ kind: 'seven_day', percentUsed: 12 }]
  const partial = await paneUi($)
  expect(await partial.find({ type: 'Text', text: /^ctx / })).toBeUndefined()
  expect(await partial.find({ type: 'Text', text: /^5h / })).toBeUndefined()
  expect(await partial.find({ type: 'Text', text: 'week 12%' })).toBeDefined()
  await partial.unmount()

  seen.failUsage = true
  const down = await paneUi($)
  expect(await down.find({ type: 'Box', key: 'usage' })).toBeUndefined()
  await down.unmount()
})

test('a measure without usable figures clears the footer instead of keeping stale ones', async ($, on) => {
  const seen = wire(on)
  seen.usage.context = { tokens: 20_000, window: 200_000, percent: 10 }
  await start($)
  await $.session.measure({ context: { tokens: 20_000, window: 200_000, percent: 10 }, rateLimits: [], changed: ['context'] })
  await $.session.measure({ context: { window: 200_000 }, rateLimits: [], changed: ['context'] })
  expect(seen.state.get('harness.usage')).toBeNull()
})

async function stepUsage($: Engine, agentId: string, index: number): Promise<void> {
  const stream = $.turn.step({ turnId: 'turn-1', index, model: 'sonnet', messageCount: 1, agentId })
  for (;;) {
    const next = await stream.next()
    if (next.done) return
  }
}

test('cost accumulates per agent across steps and each worker row shows the total', OPTIONS, async ($, on) => {
  const seen = wire(on)
  const usages = [
    { model: 'sonnet', input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 4000, cache_creation_input_tokens: 500 },
    { model: 'sonnet', input_tokens: 500, output_tokens: 50, cache_read_input_tokens: 6000, cache_creation_input_tokens: 0 },
  ]
  let calls = 0
  on('turn.step', async function* (_$, e) {
    const usage = e.agentId === 'agent-2' ? { ...usages[0]!, input_tokens: 7 } : usages[calls % 2]!
    calls += 1
    yield { kind: 'text', index: 0, text: 'working' }
    yield { kind: 'stop', stopReason: 'end_turn', usage }
    return { turnId: e.turnId, index: e.index, answer: 'working', toolUses: [], stopReason: 'end_turn' as const, usage }
  })
  await start($)
  await makePlan($, { objective: 'Two jobs', tasks: [{ title: 'Add parser' }, { title: 'Fix lexer' }] })
  await runTask($)
  await stepUsage($, 'agent-1', 0)
  await stepUsage($, 'agent-1', 1)
  await stepUsage($, 'agent-2', 0)
  await $.turn.step({ turnId: 'turn-m', index: 0, model: 'sonnet', messageCount: 1 }).next()

  const costs = seen.state.get('harness.costs') as Record<string, HarnessCost>
  expect(costs['agent-1']).toEqual({ input: 1500, output: 250, cacheRead: 10_000, cacheWrite: 500, steps: 2 })
  expect(costs['agent-2']).toMatchObject({ input: 7, steps: 1 })
  expect(Object.keys(costs).sort()).toEqual(['agent-1', 'agent-2'])

  const ui = await paneUi($)
  expect(await ui.find({ type: 'Text', text: /agent-1 · starting · \d+s · in 1\.5k out 250 cache 11k/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /agent-2 · starting · \d+s · in 7 out 200 cache 4\.5k/ })).toBeDefined()
  await ui.unmount()
})

test('a finished worker keeps its total on the task and a worker with no usage shows none', OPTIONS, async ($, on) => {
  const seen = wire(on)
  on('turn.step', async function* (_$, e) {
    const usage = { model: 'sonnet', input_tokens: 90, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    yield { kind: 'stop', stopReason: 'end_turn', usage: e.agentId === 'agent-1' ? usage : null }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: e.agentId === 'agent-1' ? usage : null }
  })
  await start($)
  await makePlan($, { objective: 'Two jobs', tasks: [{ title: 'Add parser' }, { title: 'Fix lexer' }] })
  await runTask($)
  await stepUsage($, 'agent-1', 0)
  await stepUsage($, 'agent-2', 0)
  expect(Object.keys(seen.state.get('harness.costs') as object)).toEqual(['agent-1'])

  const live = await paneUi($)
  expect(await live.find({ type: 'Text', text: /agent-1 · starting · \d+s · in 90 out 10$/ })).toBeDefined()
  expect(await live.find({ type: 'Text', text: /agent-2 · starting · \d+s$/ })).toBeDefined()
  await live.unmount()

  await finish($, 'agent-1', 'done')
  const taskId = planState(seen)?.tasks[0]?.id ?? ''
  const ui = await paneUi($)
  await $.ui.press({ plugin: 'harness', key: `fold-${taskId}` })
  expect(await ui.find({ type: 'Text', text: 'in 90 out 10' })).toBeDefined()
  await ui.unmount()
})

const agentResult = (over: Record<string, unknown>) => ({
  status: 'completed',
  agentId: 'rev-1',
  agentType: 'harness:reviewer',
  content: [{ type: 'text', text: 'APPROVE' }],
  ...over,
})

const callAgent = ($: Engine, type: string, extra: Record<string, unknown> = {}) =>
  $.tool.call({ tool: 'Agent', description: 'review', prompt: 'review it', subagent_type: type, ...extra } as never)

test('the reviewer evidence rule rides the Agent result once, as model-only context', async ($, on) => {
  let result: Record<string, unknown> = agentResult({})
  on('tool.call', { tool: 'Agent' }, () => ({ result: result as never }))
  wire(on)
  await start($)

  const first = (await callAgent($, 'harness:reviewer')) as { context?: string[]; result?: unknown }
  expect(first.context).toEqual([REVIEWER_RULE])
  expect(REVIEWER_RULE).toBe(
    "Each finding is a candidate, not a fact: it counts only with evidence (a failing test or command, a measurement, or a concrete scenario with file:line); reproduce before fixing; tell the user what you discarded and why; a requirement the user did not ask for is not a defect; 'approved with no findings' is a valid result.",
  )
  expect(first.result).toEqual(result)

  const again = (await callAgent($, 'harness:reviewer')) as { context?: string[] }
  expect(again.context).toBeUndefined()

  result = agentResult({ agentId: 'rev-2' })
  expect(((await callAgent($, 'harness:reviewer')) as { context?: string[] }).context).toEqual([REVIEWER_RULE])
})

test('the rule is never attached for other subagents, launches or failed calls', async ($, on) => {
  let result: Record<string, unknown> = agentResult({ agentType: 'harness:implementer', agentId: 'imp-1' })
  let isError = false
  on('tool.call', { tool: 'Agent' }, () => (isError ? ({ result: result as never, isError: true }) : { result: result as never }))
  wire(on)
  await start($)

  expect(((await callAgent($, 'harness:implementer')) as { context?: string[] }).context).toBeUndefined()
  expect(((await callAgent($, 'Explore')) as { context?: string[] }).context).toBeUndefined()

  result = { status: 'async_launched', agentId: 'rev-9', description: 'review' }
  expect(((await callAgent($, 'harness:reviewer')) as { context?: string[] }).context).toBeUndefined()

  result = agentResult({ agentId: 'rev-8' })
  isError = true
  expect(((await callAgent($, 'harness:reviewer')) as { context?: string[] }).context).toBeUndefined()
  isError = false
  expect(((await callAgent($, 'harness:reviewer')) as { context?: string[] }).context).toEqual([REVIEWER_RULE])
})

test('a reviewer the mod spawned delivers its result through harness_status with the rule once', OPTIONS, async ($, on) => {
  const seen = wire(on)
  await start($)
  await makePlan($, THREE)
  await runTask($)

  const before = (await $.tool.call({ tool: STATUS_TOOL })) as { context?: string[] }
  expect(before.context).toBeUndefined()

  await finish($, 'agent-1', 'done')
  const running = (await $.tool.call({ tool: STATUS_TOOL })) as { context?: string[] }
  expect(running.context).toBeUndefined()

  await finish($, 'agent-2', 'Clean.\nREVIEW_GATE_VERDICT: APPROVE')
  expect(planState(seen)?.tasks[0]).toMatchObject({ state: 'approved', reviewAgentId: 'agent-2' })
  const delivered = (await $.tool.call({ tool: STATUS_TOOL })) as { context?: string[]; result?: unknown }
  expect(delivered.context).toEqual([REVIEWER_RULE])
  expect(String(delivered.result)).toContain('approved')

  const repeat = (await $.tool.call({ tool: STATUS_TOOL })) as { context?: string[] }
  expect(repeat.context).toBeUndefined()
})

test('the band keeps its current look when no external worker runs', OPTIONS, async ($, on) => {
  wire(on)
  await start($)
  await makePlan($, THREE)
  const ui = await bandUi($)
  expect(await ui.find({ type: 'Text', text: 'Add parser' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\d+ native · \d+ external/ })).toBeUndefined()
  await ui.unmount()
})
