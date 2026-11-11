import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { resetDelegation } from '../hooks/delegation'
import { resetModPane } from '../hooks/mod-pane'
import { MISSES_TO_GONE, emptyCrew, reconcileCrew } from '../hooks/pane-crew'
import { PAGE_SIZE, attentionLines, buildCrew, headerText, orderTree, reportLines } from '../hooks/pane-rows'
import type { CrewInput } from '../hooks/pane-rows'
import { QUIET_MS, SIGNAL_VIEW, SLOW_MS, classifySignal } from '../hooks/pane-signal'
import type { Signal } from '../hooks/pane-signal'
import { BAND_PROPS, CWD, PANE_PROPS, wire } from './support'

const live = { options: { delegation: true } }
const start = ($: Engine) => $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
const jevUi = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'harness', surface, component: 'Pane', requestId: 'jev', props: { ...PANE_PROPS, title: 'Jev' } })

function setup(on: Parameters<typeof wire>[0]) {
  resetDelegation()
  resetModPane()
  const seen = wire(on)
  mock.env(on, { HOME: '/home/user' })
  on('fs.read', () => ({ value: '' }))
  seen.runHook = async () => ({ exitCode: 0, stdout: '/bin/x', stderr: '' })
  return seen
}

const input = (id: string, extra: Partial<CrewInput> = {}): CrewInput => ({
  id,
  actId: id,
  name: id.toUpperCase(),
  kind: 'claude',
  cli: 'claude',
  role: null,
  state: 'working',
  line: '',
  percent: null,
  act: { startedAt: 0, updatedAt: 0, endedAt: null, end: null },
  ...extra,
})

const ctx = (extra: Partial<Parameters<typeof buildCrew>[1]> = {}) => ({ parents: {}, gone: {}, waiting: {}, listed: [], now: 1000, page: 0, ...extra })

test('signal classifier table', () => {
  const rows: [Parameters<typeof classifySignal>[0], Signal][] = [
    [{ end: null, gone: false, waiting: false, idleMs: 0 }, 'running'],
    [{ end: null, gone: false, waiting: false, idleMs: SLOW_MS }, 'running'],
    [{ end: null, gone: false, waiting: false, idleMs: SLOW_MS + 1 }, 'slow'],
    [{ end: null, gone: false, waiting: false, idleMs: QUIET_MS + 1 }, 'quiet'],
    [{ end: null, gone: false, waiting: true, idleMs: 1_000_000 }, 'waiting'],
    [{ end: null, gone: true, waiting: true, idleMs: 0 }, 'gone'],
    [{ end: 'done', gone: true, waiting: true, idleMs: 0 }, 'done'],
    [{ end: 'failed', gone: false, waiting: false, idleMs: 0 }, 'failed'],
  ]
  for (const [given, want] of rows) expect(classifySignal(given)).toBe(want)
  expect(SIGNAL_VIEW.waiting).toMatchObject({ glyph: '!', color: 'warning' })
  expect(SIGNAL_VIEW.failed.toast?.('Ada')).toBe('Ada falhou')
  expect(SIGNAL_VIEW.running.toast).toBeNull()
  expect(SIGNAL_VIEW.done.toast).toBeNull()
  for (const signal of Object.keys(SIGNAL_VIEW) as Signal[]) expect(SIGNAL_VIEW[signal].glyph.length).toBe(1)
})

test('reconcile: a tracked node is gone only after 2 consecutive misses, a return resets', () => {
  let state = emptyCrew()
  let misses = new Map<string, number>()
  const step = (listed: string[]) => {
    const out = reconcileCrew(state, misses, listed.map(id => ({ id })), ['a', 'b'])
    state = out.crew
    misses = out.misses
    return out.newlyGone
  }
  expect(MISSES_TO_GONE).toBe(2)
  expect(step(['a', 'b'])).toEqual([])
  expect(step(['a'])).toEqual([])
  expect(state.gone.b).toBeUndefined()
  expect(step(['a', 'b'])).toEqual([])
  expect(step(['a'])).toEqual([])
  expect(step(['a'])).toEqual(['b'])
  expect(state.gone.b).toBe(true)
  expect(step(['a'])).toEqual([])
  expect(step(['a', 'b'])).toEqual([])
  expect(state.gone.b).toBeUndefined()
})

test('reconcile: parent ids come from the list and are kept', () => {
  const out = reconcileCrew(emptyCrew(), new Map(), [{ id: 'w', parentId: 'h' }], [])
  expect(out.crew.parents).toEqual({ w: 'h' })
  const again = reconcileCrew(out.crew, new Map(), [{ id: 'w' }], [])
  expect(again.crew.parents).toEqual({ w: 'h' })
})

test('reconcile through the engine: gone after 2 lists, toast once, unknown ids grouped', live, async ($, on) => {
  const seen = setup(on)
  await start($)
  seen.alive.push({ id: 'ghost-1', status: 'running' }, { id: 'ghost-2', status: 'running' })
  await $.tool.call({ tool: 'Read', tool_use_id: 'r', file_path: '/a', agentId: 'sub-1' } as never)
  await seen.clock.advance(2000)
  expect(seen.toasts.filter(t => /sumiu/.test(t))).toHaveLength(0)
  await seen.clock.advance(2000)
  expect(seen.toasts.filter(t => /sumiu/.test(t))).toHaveLength(1)
  await seen.clock.advance(4000)
  expect(seen.toasts.filter(t => /sumiu/.test(t))).toHaveLength(1)
  const ui = await jevUi($)
  expect(await ui.find({ type: 'Text', text: /\? 2 agentes desconhecidos/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /sumiu/ })).toBeDefined()
})

test('tree order: hub, workers, then the reviewer indented under them', () => {
  const inputs = [
    input('rev', { role: 'review' }),
    input('w1', { role: 'implement' }),
    input('w2', { role: 'implement' }),
    input('kid', { role: 'explore' }),
  ]
  const model = buildCrew(inputs, ctx({ parents: { kid: 'w1' } }))
  expect(model.hub).toEqual({ running: 4, total: 4 })
  expect(model.rows.map(r => [r.id, r.depth])).toEqual([
    ['w1', 1],
    ['kid', 2],
    ['w2', 1],
    ['rev', 2],
  ])
  expect(model.rows.find(r => r.id === 'w1')?.isLead).toBe(true)
  expect(model.rows.find(r => r.id === 'rev')?.isLead).toBe(false)
  expect(orderTree([input('only')], {}).map(r => r.depth)).toEqual([0])
  expect(buildCrew([input('x', { state: 'done', act: { startedAt: 0, updatedAt: 0, endedAt: 5, end: 'done' } })], ctx()).hub).toBeNull()
})

test('text fallback: at most 5 rows needing attention, then the full report', () => {
  const failed = Array.from({ length: 7 }, (_, i) => input(`f${i}`, { state: 'failed', act: { startedAt: 0, updatedAt: 0, endedAt: 1, end: 'failed' }, line: 'boom' }))
  const model = buildCrew([...failed, input('ok')], ctx({ listed: ['stranger'] }))
  const lines = attentionLines(model)
  expect(lines).toHaveLength(7)
  expect(lines[0]).toContain('✗ F0 claude falhou: boom')
  expect(lines[5]).toBe('+2 precisam de atencao')
  expect(lines[6]).toBe('? 1 agentes desconhecidos')
  expect(attentionLines(buildCrew([input('ok')], ctx()))).toEqual([])
  const report = reportLines(model)
  expect(report[0]).toBe('◆ lead · 1/8 trabalhando')
  expect(report).toHaveLength(1 + 8 + 1)
  expect(reportLines(buildCrew([], ctx()))).toEqual(['Nenhum agente ativo.'])
  const waiting = buildCrew([input('w')], ctx({ waiting: { w: true } }))
  expect(waiting.rows[0]?.artState).toBe('waiting')
  expect(attentionLines(waiting)[0]).toContain('! W claude aguarda aprovacao')
})

test('pagination: 3 agents per page, pages clamp', () => {
  const inputs = Array.from({ length: 7 }, (_, i) => input(`p${i}`))
  expect(PAGE_SIZE).toBe(3)
  const first = buildCrew(inputs, ctx())
  expect([first.pages, first.page, first.pageRows.map(r => r.id)]).toEqual([3, 0, ['p0', 'p1', 'p2']])
  expect(buildCrew(inputs, ctx({ page: 2 })).pageRows.map(r => r.id)).toEqual(['p6'])
  expect(buildCrew(inputs, ctx({ page: 99 })).page).toBe(2)
  expect(buildCrew(inputs, ctx({ page: -4 })).page).toBe(0)
})

test('header text prefers the open ODD feature, else the flow', () => {
  expect(headerText({ title: 'Ship', phase: 'build', planned: 4, accepted: 1 }, null)).toBe('Ship · build · 1/4')
  expect(headerText({ title: 'Ship', phase: 'build', planned: 4, accepted: 1 }, { name: 'login', done: 2, total: 5, phase: 'verificando' })).toBe('login · verificando · 2/5')
  expect(headerText(null, null)).toBeNull()
})

test('harness_progress is ignored from a subagent and drives the header from the main agent', live, async ($, on) => {
  setup(on)
  await start($)
  const call = (extra: Record<string, unknown>) =>
    $.tool.call({ tool: 'mcp__harness__harness_progress', tool_use_id: 'p', title: 'Ship parser', phase: 'build', planned: 4, accepted: 2, ...extra } as never)
  expect(await call({ agentId: 'sub-1', title: 'Hijack' })).toMatchObject({ result: expect.stringContaining('ignored') })
  let ui = await jevUi($)
  expect(await ui.find({ type: 'Text', text: /Hijack/ })).toBeUndefined()
  await ui.unmount()
  expect(await call({})).toMatchObject({ result: 'ok' })
  ui = await jevUi($)
  expect(await ui.find({ type: 'Text', text: /Ship parser · build · 2\/4/ })).toBeDefined()
})

test('harness_progress is registered with the step tool and a worker keeps harness_step', live, async ($, on) => {
  const seen = setup(on)
  await start($)
  expect(seen.registered).toContain('tool:harness_progress')
  expect(seen.registered).toContain('tool:harness_step')
  expect(await $.tool.call({ tool: 'mcp__harness__harness_step', tool_use_id: 's', done: 1, total: 3, agentId: 'sub-1' } as never)).toMatchObject({ result: 'ok' })
  expect(await $.tool.call({ tool: 'mcp__harness__harness_step', tool_use_id: 's2', done: 1, total: 3 } as never)).toMatchObject({ result: expect.stringContaining('ignored') })
})

const seed = async ($: Engine, count: number) => {
  for (let i = 0; i < count; i += 1) await $.tool.call({ tool: 'Read', tool_use_id: `t${i}`, file_path: `/f${i}`, agentId: `sub-${i}` } as never)
}
const NAMES = /^(Ada|Bo|Cass|Dev|Ede|Fen)$/

test('pane: 3 agents per page with next and previous keys', live, async ($, on) => {
  const seen = setup(on)
  await start($)
  await seed($, 5)
  await seen.clock.advance(300)
  const ui = await jevUi($)
  expect(await ui.findAll({ type: 'Text', text: NAMES })).toHaveLength(3)
  expect(await ui.find({ type: 'Text', text: '1/2' })).toBeDefined()
  await ui.press({ key: 'pg-next' })
  expect(await ui.findAll({ type: 'Text', text: NAMES })).toHaveLength(2)
  expect(await ui.find({ type: 'Text', text: '2/2' })).toBeDefined()
  await ui.press({ key: 'pg-prev' })
  expect(await ui.findAll({ type: 'Text', text: NAMES })).toHaveLength(3)
})

test('terminal draws a Raster per agent and the desktop an Svg', live, async ($, on) => {
  const seen = setup(on)
  await start($)
  await seed($, 2)
  await seen.clock.advance(300)
  const term = await jevUi($, 'terminal')
  const rasters = await term.findAll({ type: 'Raster' })
  expect(rasters).toHaveLength(2)
  expect(rasters[0]?.props).toMatchObject({ columns: 7, rows: 5 })
  expect(await term.find({ type: 'Svg' })).toBeUndefined()
  await term.unmount()
  const desk = await jevUi($, 'desktop')
  const svgs = await desk.findAll({ type: 'Svg' })
  expect(svgs).toHaveLength(2)
  expect(String(svgs[0]?.props.source)).toContain('crispEdges')
  expect(await desk.find({ type: 'Raster' })).toBeUndefined()
})

const shot = async ($: Engine) => {
  const ui = await jevUi($)
  const cells = String((await ui.find({ type: 'Raster' }))?.props.cells)
  await ui.unmount()
  return cells
}

test('motion: the frame ticks only while an agent runs and reduced motion is static', live, async ($, on) => {
  const seen = setup(on)
  await start($)
  await seed($, 1)
  await seen.clock.advance(300)
  const first = await shot($)
  await seen.clock.advance(125)
  const second = await shot($)
  expect(second).not.toBe(first)
  await seen.clock.advance(125)
  expect(await shot($)).toBe(first)
})

test('reduced motion keeps every frame identical', { options: { delegation: true, reducedMotion: true } }, async ($, on) => {
  const seen = setup(on)
  await start($)
  await seed($, 1)
  await seen.clock.advance(300)
  const first = await shot($)
  for (let i = 0; i < 5; i += 1) {
    await seen.clock.advance(125)
    expect(await shot($)).toBe(first)
  }
})

test('a waiting approval shows the bang and a toast, and clears on the next tool call', live, async ($, on) => {
  const seen = setup(on)
  on('tool.check', { tool: 'Write' }, () => ({ decision: 'ask' }) as never)
  await start($)
  await $.tool.call({ tool: 'Read', tool_use_id: 'r', file_path: '/a', agentId: 'sub-1' } as never)
  await $.tool.check({ tool: 'Write', tool_use_id: 'w', file_path: '/a', agentId: 'sub-1' } as never)
  expect(seen.toasts.some(t => /aguarda aprovacao/.test(t))).toBe(true)
  let ui = await jevUi($)
  expect(await ui.find({ type: 'Text', text: /aguarda aprovacao/ })).toBeDefined()
  await ui.unmount()
  await $.tool.call({ tool: 'Read', tool_use_id: 'r2', file_path: '/b', agentId: 'sub-1' } as never)
  ui = await jevUi($)
  expect(await ui.find({ type: 'Text', text: /aguarda aprovacao/ })).toBeUndefined()
})

test('band: crew button opens the pane focused and the compact text lists agents needing attention', live, async ($, on) => {
  const seen = setup(on)
  await start($)
  await $.tool.call({ tool: 'Read', tool_use_id: 'r', file_path: '/a', agentId: 'sub-1' } as never)
  await $.turn.complete({ agentId: 'sub-1', reason: 'error', answer: 'boom', text: 'boom' } as never)
  await seen.clock.advance(300)
  const band = await $.ui.mount({ plugin: 'harness', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await band.find({ type: 'Text', text: /✗ .* falhou/ })).toBeDefined()
  expect(await band.find({ type: 'Button', label: '◉ 1' })).toBeDefined()
})

test('/jev open focuses without toggling and /jev returns text when no surface places it', live, async ($, on) => {
  const seen = setup(on)
  await start($)
  const run = (args: string) => $.command.run({ command: 'jev', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)
  expect(await run('open')).toMatchObject({ text: 'Jev pane focused.' })
  expect(await run('open')).toMatchObject({ text: 'Jev pane focused.' })
  expect(seen.opened.filter(id => id === 'jev')).toHaveLength(2)
  expect(seen.closed).toHaveLength(0)
  seen.unplaced = true
  expect(await run('')).toMatchObject({ text: 'Nenhum agente ativo.' })
})

test('autoOpenMode delegated ignores a plain subagent tool call', live, async ($, on) => {
  const seen = setup(on)
  await start($)
  await $.tool.call({ tool: 'Read', tool_use_id: 'r', file_path: '/a', agentId: 'sub-1' } as never)
  expect(seen.opened).not.toContain('jev')
})

test('autoOpenMode any opens on the first subagent tool call', { options: { delegation: true, autoOpenMode: 'any' } }, async ($, on) => {
  const seen = setup(on)
  await start($)
  await $.tool.call({ tool: 'Read', tool_use_id: 'r', file_path: '/a', agentId: 'sub-1' } as never)
  expect(seen.opened).toContain('jev')
})
