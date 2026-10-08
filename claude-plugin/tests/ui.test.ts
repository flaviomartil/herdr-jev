import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { BAND_PROPS, CWD, finish, makePlan, PANE_PROPS, pendingReport, planState, runTask, wire } from './support'

const SURFACES = ['terminal', 'desktop'] as const

const THREE = {
  objective: 'Ship the parser',
  tasks: [
    { title: 'Add parser' },
    { title: 'Design the data model' },
    { title: 'Read the logs', deps: ['Add parser'] },
  ],
}

test('the band falls through to the engine while there is no plan', { options: { autoRun: false } }, async ($, on) => {
  wire(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'harness', surface, component: 'AbovePrompt', props: BAND_PROPS })
    expect(await ui.find({ type: 'engine' })).toBeDefined()
    await ui.unmount()
  }
})

const bandUi = ($: Engine, surface: 'terminal' | 'desktop', props: typeof BAND_PROPS = BAND_PROPS) =>
  $.ui.mount({ plugin: 'harness', surface, component: 'AbovePrompt', props })

const paneUi = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal', props: typeof PANE_PROPS = PANE_PROPS) =>
  $.ui.mount({ plugin: 'harness', surface, component: 'Pane', requestId: 'harness', props })

const FILL = /^━+$/
const FREE = /^─+$/

test('the band is one borderless row with toggle, glyph, title, filling bar, counts and buttons on both surfaces, and yields to a survey', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await makePlan($, THREE)

  for (const surface of SURFACES) {
    const ui = await bandUi($, surface)
    const boxes = await ui.findAll({ type: 'Box' })
    expect(boxes.some(box => box.props.borderStyle !== undefined)).toBe(false)
    expect((await ui.find({ type: 'Text', text: '○' }))?.props.color).toBe('inactive')
    expect((await ui.find({ type: 'Text', text: 'Add parser' }))?.props.wrap).toBe('truncate-end')
    expect((await ui.find({ type: 'Text', text: FREE }))?.props.dimColor).toBe(true)
    expect(await ui.find({ type: 'Text', text: FILL })).toBeUndefined()
    const bar = await ui.find({ type: 'Box', key: 'bar' })
    expect(bar?.props.flexGrow).toBe(1)
    expect(bar?.props.overflow).toBe('hidden')
    expect(await ui.find({ type: 'Text', text: '0/3' })).toBeDefined()
    const percent = await ui.find({ type: 'Text', text: '0%' })
    expect(percent?.props.bold).toBe(true)
    expect(percent?.props.color).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /harness · demo/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /expected Fable/ })).toBeUndefined()
    expect((await ui.find({ type: 'Button', key: 'toggle' }))?.props.label).toBe('▸')
    expect((await ui.find({ type: 'Button', key: 'plan' }))?.props.label).toBe('Plan')
    expect((await ui.find({ type: 'Button', key: 'hide' }))?.props.label).toBe('×')
    expect((await ui.find({ type: 'Button', key: 'plan' }))?.props.plain).toBe(true)
    expect(await ui.find({ type: 'Button', key: 'cover' }) !== undefined).toBe(surface === 'desktop')
    await ui.unmount()

    const survey = await bandUi($, surface, { ...BAND_PROPS, hasSurvey: true })
    expect(await survey.find({ type: 'engine' })).toBeDefined()
    await survey.unmount()
  }

  await runTask($)
  for (const surface of SURFACES) {
    const ui = await bandUi($, surface)
    expect((await ui.find({ type: 'Text', text: '●' }))?.props.color).toBe('claude')
    expect(await ui.find({ type: 'Text', text: 'Add parser' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '0s' })).toBeDefined()
    await ui.unmount()
  }
  expect(planState(seen)?.tasks[0]?.state).toBe('running')
})

test('the band bar fills a share of its width in the state colour', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await makePlan($, { objective: 'Reading', tasks: [{ title: 'Read the logs' }, { title: 'Read the config', deps: ['Read the logs'] }] })
  await finish($, 'agent-1', 'Found it.')

  for (const surface of SURFACES) {
    const ui = await bandUi($, surface)
    const fill = await ui.find({ type: 'Box', key: 'bar-fill' })
    expect(fill?.props.width).toBe('50%')
    expect(fill?.props.overflow).toBe('hidden')
    expect((await ui.find({ type: 'Text', text: FILL }))?.props.color).toBe('claude')
    expect((await ui.find({ type: 'Box', key: 'bar-free' }))?.props.flexGrow).toBe(1)
    expect((await ui.find({ type: 'Text', text: FREE }))?.props.dimColor).toBe(true)
    expect(await ui.find({ type: 'Text', text: '1/2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '50%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Read the config' })).toBeDefined()
    await ui.unmount()
  }
})

test('the band glyph, note and percent follow review, failure and questions', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await makePlan($, THREE)
  await runTask($)
  await finish($, 'agent-1', 'done')

  for (const surface of SURFACES) {
    const ui = await bandUi($, surface)
    expect((await ui.find({ type: 'Text', text: '●' }))?.props.color).toBe('claude')
    expect(await ui.find({ type: 'Text', text: 'review' })).toBeDefined()
    await ui.unmount()
  }

  await finish($, 'agent-2', 'Bad.\nREVIEW_GATE_VERDICT: CHANGES_REQUIRED')
  for (const surface of SURFACES) {
    const ui = await bandUi($, surface)
    expect((await ui.find({ type: 'Text', text: '!' }))?.props.color).toBe('error')
    const note = await ui.find({ type: 'Text', text: 'failed' })
    expect(note?.props.color).toBe('error')
    expect(note?.props.bold).toBe(true)
    expect((await ui.find({ type: 'Text', text: '0%' }))?.props.color).toBe('error')
    await ui.unmount()
  }

  await runTask($, planState(seen)?.tasks[0]?.id)
  await finish($, 'agent-3', 'Blocked.\nNEEDS_YOU: which library?')
  for (const surface of SURFACES) {
    const ui = await bandUi($, surface)
    expect((await ui.find({ type: 'Text', text: '?' }))?.props.color).toBe('warning')
    const note = await ui.find({ type: 'Text', text: 'needs you' })
    expect(note?.props.color).toBe('warning')
    expect(note?.props.bold).toBe(true)
    expect((await ui.find({ type: 'Text', text: '0%' }))?.props.color).toBe('warning')
    expect((await ui.find({ type: 'Text', text: '1' }))?.props.color).toBe('warning')
    await ui.unmount()
  }
})

test('the band names the failed task while another one runs', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await makePlan($, { objective: 'Two', tasks: [{ title: 'Add a' }, { title: 'Add b' }] })
  await finish($, 'agent-1', 'x', 'error')

  const ui = await bandUi($, 'terminal')
  expect((await ui.find({ type: 'Text', text: '!' }))?.props.color).toBe('error')
  expect(await ui.find({ type: 'Text', text: 'Add b' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: 'failed: Add a' }))?.props.color).toBe('error')
  await ui.unmount()
})

test('the band truncates the title to a share of the width', { options: { autoRun: false } }, async ($, on) => {
  wire(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  const long = 'Add a parser that handles every single exotic input format we ever met'
  await makePlan($, { objective: 'Long', tasks: [{ title: long }] })
  await runTask($)
  const ui = await bandUi($, 'terminal', { ...BAND_PROPS, bodyColumns: 80 })
  const boxes = await ui.findAll({ type: 'Box' })
  const widths = boxes.map(box => box.props.width).filter((width): width is number => typeof width === 'number')
  expect(widths.some(width => width >= 8 && width < long.length)).toBe(true)
  await ui.unmount()
})

test('the toggle opens a card with one row per open task, capped at four with a count line', { options: { autoRun: false } }, async ($, on) => {
  wire(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await makePlan($, { objective: 'Many', tasks: [1, 2, 3, 4, 5, 6].map(n => ({ title: `Add item ${n}` })) })

  for (const surface of SURFACES) {
    const ui = await bandUi($, surface)
    expect(await ui.find({ type: 'Text', text: 'Add item 2' })).toBeUndefined()
    await ui.press({ key: 'toggle' })
    expect((await ui.find({ type: 'Button', key: 'toggle' }))?.props.label).toBe('▾')
    const card = (await ui.findAll({ type: 'Box' })).find(box => box.props.borderStyle === 'round')
    expect(card?.props.borderDimColor).toBe(true)
    expect(card?.props.paddingX).toBe(2)
    expect(card?.props.paddingY).toBe(1)
    expect(card?.props.rowGap).toBe(1)
    expect(await ui.find({ type: 'Text', text: 'Add item 4' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Add item 5' })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: '+2 more' }))?.props.dimColor).toBe(true)
    expect(await ui.find({ type: 'Text', text: '(implementer · sonnet-5 · high)' })).toBeDefined()
    await ui.press({ key: 'toggle' })
    expect(await ui.find({ type: 'Text', text: 'Add item 2' })).toBeUndefined()
    await ui.unmount()
  }
})

test('the whole line toggles the card on desktop through the overlay button', { options: { autoRun: false } }, async ($, on) => {
  wire(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await makePlan($, THREE)
  const ui = await bandUi($, 'desktop')
  const cover = await ui.find({ type: 'Button', key: 'cover' })
  expect(cover?.props.plain).toBe(true)
  expect(cover?.props.label).toBe(' '.repeat(600))
  await ui.press({ key: 'cover' })
  expect((await ui.find({ type: 'Button', key: 'toggle' }))?.props.label).toBe('▾')
  expect(await ui.find({ type: 'Text', text: 'Design the data model' })).toBeDefined()
  await ui.unmount()
})

test('the expanded band colours each dot by state and shows the live tool and elapsed', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await makePlan($, THREE)
  await runTask($)
  await $.tool.call({ tool: 'Read', file_path: '/work/demo/src/parser.ts', agentId: 'agent-1' } as never)
  await seen.clock.advance(12000)
  const ui = await bandUi($, 'terminal')
  await ui.press({ key: 'toggle' })
  const dots = await ui.findAll({ type: 'Text', text: '●' })
  expect(dots.some(one => one.props.color === 'claude')).toBe(true)
  expect(dots.some(one => one.props.dimColor === true)).toBe(true)
  expect((await ui.find({ type: 'Text', text: 'Read parser.ts' }))?.props.dimColor).toBe(true)
  expect((await ui.findAll({ type: 'Text', text: '12s' })).length).toBeGreaterThanOrEqual(1)
  await ui.unmount()
})

test('Hide hides the band and Plan opens the pane', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await makePlan($, THREE)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'harness', surface, component: 'AbovePrompt', props: BAND_PROPS })
    await ui.press({ key: 'plan' })
    expect(seen.opened).toContain('harness')
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'harness', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await ui.press({ key: 'hide' })
  expect(await ui.find({ type: 'engine' })).toBeDefined()
  await ui.unmount()
})

test('the band shows approved with harness review pending, then all verified after a ready review', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await makePlan($, { objective: 'One thing', tasks: [{ title: 'Add parser' }] })
  await runTask($)
  await finish($, 'agent-1', 'done')
  await finish($, 'agent-2', 'Clean.\nREVIEW_GATE_VERDICT: APPROVE')

  const ui = await $.ui.mount({ plugin: 'harness', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect((await ui.find({ type: 'Text', text: '◆' }))?.props.color).toBe('warning')
  const waiting = await ui.find({ type: 'Text', text: 'review pending' })
  expect(waiting?.props.color).toBe('warning')
  expect(waiting?.props.bold).toBe(true)
  expect((await ui.find({ type: 'Text', text: 'approved 1' }))?.props.dimColor).toBe(true)
  expect(await ui.find({ type: 'Text', text: /all verified/ })).toBeUndefined()
  await ui.unmount()

  const pane = await $.ui.mount({ plugin: 'harness', surface: 'terminal', component: 'Pane', requestId: 'harness', props: PANE_PROPS })
  await pane.press({ key: 'refresh-review' })
  await pane.unmount()
  expect(planState(seen)?.tasks[0]?.state).toBe('verified')

  const band = await $.ui.mount({ plugin: 'harness', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect((await band.find({ type: 'Text', text: '✓' }))?.props.color).toBe('success')
  expect(await band.find({ type: 'Text', text: 'Done' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: '1/1' })).toBeDefined()
  const percent = await band.find({ type: 'Text', text: '100%' })
  expect(percent?.props.color).toBe('success')
  expect(percent?.props.bold).toBe(true)
  expect((await band.find({ type: 'Box', key: 'bar-fill' }))?.props.width).toBe('100%')
  expect((await band.find({ type: 'Text', text: FILL }))?.props.color).toBe('success')
  await seen.clock.advance(19000)
  expect(await band.find({ type: 'Text', text: 'Done' })).toBeDefined()
  await seen.clock.advance(2000)
  expect(await band.find({ type: 'engine' })).toBeDefined()
  await band.unmount()
})

test('a pending review keeps tasks approved and a failed refresh is reported', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await makePlan($, { objective: 'One thing', tasks: [{ title: 'Add parser' }] })
  await runTask($)
  await finish($, 'agent-1', 'done')
  await finish($, 'agent-2', 'Clean.\nREVIEW_GATE_VERDICT: APPROVE')

  seen.reviewExit = 1
  seen.reviewBody = pendingReport()
  const pane = await $.ui.mount({ plugin: 'harness', surface: 'terminal', component: 'Pane', requestId: 'harness', props: PANE_PROPS })
  await pane.press({ key: 'refresh-review' })
  expect(planState(seen)?.tasks[0]?.state).toBe('approved')
  expect(await pane.find({ type: 'Text', text: /Review: pending_judge · verify ready, auto pending_judge/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /1 approved, harness review: pending_judge/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /harness review pending/ })).toBeUndefined()

  const band = await $.ui.mount({ plugin: 'harness', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await band.find({ type: 'Text', text: 'review: pending_judge' })).toBeDefined()
  await band.unmount()

  seen.failCli = true
  seen.reviewBody = {}
  await pane.press({ key: 'refresh-review' })
  expect(planState(seen)?.tasks[0]?.state).toBe('approved')
  await pane.unmount()
})

test('review running shows in the band and the pane, and a second refresh never runs a second review', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await makePlan($, { objective: 'One thing', tasks: [{ title: 'Add parser' }] })
  await runTask($)
  await finish($, 'agent-1', 'done')
  await finish($, 'agent-2', 'Clean.\nREVIEW_GATE_VERDICT: APPROVE')

  let release: () => void = () => undefined
  seen.reviewGate = new Promise<void>(resolve => {
    release = resolve
  })

  const pane = await $.ui.mount({ plugin: 'harness', surface: 'terminal', component: 'Pane', requestId: 'harness', props: PANE_PROPS })
  const first = pane.press({ key: 'refresh-review' })
  await seen.clock.advance(1)
  expect(seen.state.get('harness.isReviewRunning')).toBe(true)

  const band = await $.ui.mount({ plugin: 'harness', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await band.find({ type: 'Text', text: 'review running' })).toBeDefined()
  await band.unmount()

  await pane.press({ key: 'refresh-review' })
  expect(seen.runs.filter(argv => argv[1] === 'review')).toHaveLength(1)

  release()
  await first
  expect(seen.runs.filter(argv => argv[1] === 'review')).toHaveLength(1)
  expect(seen.state.get('harness.isReviewRunning')).toBe(false)
  expect(planState(seen)?.tasks[0]?.state).toBe('verified')
  await pane.unmount()
})

test('the pane header, bar, sections, footer and buttons on every surface', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await makePlan($, THREE)
  const plan = planState(seen)

  for (const surface of SURFACES) {
    const ui = await paneUi($, surface)
    expect((await ui.find({ type: 'Text', text: 'Ship the parser' }))?.props.bold).toBe(true)
    expect((await ui.find({ type: 'Text', text: 'planned now' }))?.props.dimColor).toBe(true)
    expect(await ui.find({ type: 'Text', text: '0%' })).toBeDefined()
    expect((await ui.find({ type: 'Box', key: 'bar' }))?.props.flexGrow).toBe(1)
    expect((await ui.find({ type: 'Text', text: FREE }))?.props.dimColor).toBe(true)
    expect((await ui.find({ type: 'Button', key: 'run-ready' }))?.props.label).toBe('Run ready')
    expect((await ui.find({ type: 'Button', key: 'refresh-review' }))?.props.label).toBe('↻ review')
    expect((await ui.find({ type: 'Button', key: 'close' }))?.props.label).toBe('✕')
    expect(await ui.find({ type: 'Text', text: 'Tasks' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Needs you' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '☐' })).toBeUndefined()

    const heading = surface === 'desktop' ? { type: 'Text', text: 'Queued' } : { type: 'Button', key: 'section-queued' }
    expect(await ui.find(heading)).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'section-queued' })).toBeDefined()
    for (const task of plan?.tasks ?? []) {
      expect(await ui.find({ type: 'Text', text: task.id.slice(0, 7) })).toBeDefined()
      expect((await ui.find({ type: 'Button', key: `fold-${task.id}` }))?.props.label).toBe('▸')
    }
    expect(await ui.find({ type: 'Text', text: 'implementer · sonnet-5 · high' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'reader · haiku-4-5 · medium' })).toBeDefined()
    expect((await ui.findAll({ type: 'Text', text: '●' })).some(one => one.props.dimColor === true)).toBe(true)
    const footer = await ui.find({ type: 'Text', text: 'demo · advisor fable-5-1 · review not run · auto-run off · auto-review off' })
    expect(footer?.props.dimColor).toBe(true)
    await ui.unmount()
  }
})

test('the Done section starts folded and its heading unfolds it, on both surfaces', async ($, on) => {
  const seen = wire(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await makePlan($, { objective: 'Reading', tasks: [{ title: 'Read the logs' }, { title: 'Read the config', deps: ['Read the logs'] }] })
  await finish($, 'agent-1', 'Found it.')
  const logs = planState(seen)?.tasks[0]?.id ?? ''

  for (const surface of SURFACES) {
    const ui = await paneUi($, surface)
    expect(await ui.find({ type: 'Button', key: 'section-working' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: `fold-${logs}` })).toBeUndefined()
    if (surface === 'terminal') {
      expect((await ui.find({ type: 'Button', key: 'section-done' }))?.props.label).toBe('Done …')
    } else {
      expect((await ui.find({ type: 'Text', text: 'Done' }))?.props.dimColor).toBe(true)
    }
    await ui.press({ key: 'section-done' })
    expect(await ui.find({ type: 'Button', key: `fold-${logs}` })).toBeDefined()
    await ui.press({ key: 'section-done' })
    expect(await ui.find({ type: 'Button', key: `fold-${logs}` })).toBeUndefined()
    await ui.unmount()
  }
})

test('the close button closes the pane', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await makePlan($, THREE)
  const ui = await paneUi($)
  await ui.press({ key: 'close' })
  expect(seen.closed).toContain('harness')
  await ui.unmount()
})

test('the pane footer reports the auto settings', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await makePlan($, { objective: 'One', tasks: [{ title: 'Read the logs' }] })
  const ui = await paneUi($)
  expect(await ui.find({ type: 'Text', text: /auto-run on · auto-review off/ })).toBeDefined()
  await ui.unmount()
})

test('the pane unfolds the running task with its key and value block and colours rows by state', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await makePlan($, THREE)
  await runTask($)
  await seen.clock.advance(12000)
  const first = planState(seen)?.tasks[0]?.id ?? ''

  for (const surface of SURFACES) {
    const ui = await paneUi($, surface)
    expect((await ui.find({ type: 'Button', key: `fold-${first}` }))?.props.label).toBe('▾')
    expect((await ui.find({ type: 'Text', text: '◐' }))?.props.color).toBe('claude')
    expect(await ui.find({ type: 'Text', text: /agent-1 · starting · 12s/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: 'worker' }))?.props.dimColor).toBe(true)
    expect((await ui.find({ type: 'Text', text: 'review' }))?.props.dimColor).toBe(true)
    expect(await ui.find({ type: 'Text', text: 'by opus-5' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: `rerun-${first}` })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '12s' })).toBeDefined()
    await ui.unmount()
  }

  await finish($, 'agent-1', 'done')
  const reviewing = await paneUi($)
  expect((await reviewing.find({ type: 'Text', text: '◐' }))?.props.dimColor).toBe(true)
  expect((await reviewing.find({ type: 'Button', key: `fold-${first}` }))?.props.label).toBe('▸')
  expect(await reviewing.find({ type: 'Text', text: 'reviewer · opus-5' })).toBeDefined()
  await reviewing.unmount()

  await finish($, 'agent-2', 'Clean.\nREVIEW_GATE_VERDICT: APPROVE')
  const approved = await paneUi($)
  expect(await approved.find({ type: 'Button', key: 'section-approved' })).toBeDefined()
  expect((await approved.find({ type: 'Text', text: '●' }))?.props.color).toBe('warning')
  await approved.unmount()
})

test('the fold button reveals deps, reason and review, clicking the row title folds again', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await makePlan($, THREE)
  const first = planState(seen)?.tasks[0]?.id ?? ''
  const logs = planState(seen)?.tasks[2]?.id ?? ''

  for (const surface of SURFACES) {
    const ui = await paneUi($, surface)
    expect(await ui.find({ type: 'Text', text: `after ${first}` })).toBeUndefined()
    await ui.press({ key: `fold-${logs}` })
    expect((await ui.find({ type: 'Button', key: `fold-${logs}` }))?.props.label).toBe('▾')
    expect((await ui.find({ type: 'Text', text: 'deps' }))?.props.dimColor).toBe(true)
    expect(await ui.find({ type: 'Text', text: `after ${first}` })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /reader because/ })).toBeDefined()
    await ui.press({ key: `title-${logs}` })
    expect(await ui.find({ type: 'Text', text: `after ${first}` })).toBeUndefined()
    await ui.unmount()
  }
})

test('the pane keeps the stale note and the advisor mismatch on one warning line', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on, { model: 'claude-sonnet-5-5' })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  seen.failModels = true
  await makePlan($, THREE)

  for (const surface of SURFACES) {
    const ui = await paneUi($, surface)
    const line = await ui.find({ type: 'Text', text: /advisor model is sonnet-5-5, expected Fable · Herdr-Jev data is stale/ })
    expect(line?.props.color).toBe('warning')
    await ui.unmount()
  }
})

test('open questions render as a round box of checkbox rows, and failed or needs-you rows offer Rerun', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await makePlan($, { objective: 'Ship', tasks: [{ title: 'Add parser', checks: ['pnpm test'] }] })
  await runTask($)
  await finish($, 'agent-1', 'Blocked.\nNEEDS_YOU: which library?')
  const first = planState(seen)?.tasks[0]?.id ?? ''

  for (const surface of SURFACES) {
    const ui = await paneUi($, surface)
    const box = (await ui.findAll({ type: 'Box' })).find(one => one.props.borderStyle === 'round')
    expect(box?.props.borderColor).toBe('warning')
    expect((await ui.find({ type: 'Text', text: /── Needs you/ }))?.props.dimColor).toBe(true)
    const heading = await ui.find({ type: 'Text', text: '☐ 1 task for you' })
    expect(heading?.props.bold).toBe(true)
    const ask = await ui.find({ type: 'Text', text: '☐ #1 Add parser' })
    expect(ask?.props.bold).toBe(true)
    expect(ask?.props.color).toBe('warning')
    expect(await ui.find({ type: 'Text', text: 'which library?' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: 'Done when: pnpm test' }))?.props.dimColor).toBe(true)
    expect(await ui.find({ type: 'Button', key: 'section-needs' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: '●' }))?.props.color).toBe('warning')
    expect(await ui.find({ type: 'Button', key: `rerun-${first}` })).toBeUndefined()
    await ui.press({ key: `fold-${first}` })
    expect((await ui.find({ type: 'Text', text: 'note' }))?.props.dimColor).toBe(true)
    expect(await ui.find({ type: 'Button', key: `rerun-${first}` })).toBeDefined()
    await ui.press({ key: `fold-${first}` })
    await ui.unmount()
  }

  const ui = await paneUi($)
  await ui.press({ key: `fold-${first}` })
  await ui.press({ key: `rerun-${first}` })
  expect(seen.spawns).toHaveLength(2)
  await ui.unmount()
})

test('the pane without a plan shows one dim line and the buttons', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'harness', surface, component: 'Pane', requestId: 'harness', props: PANE_PROPS })
    const line = await ui.find({ type: 'Text', text: 'No plan yet. Ask the advisor for one.' })
    expect(line?.props.dimColor).toBe(true)
    expect(await ui.find({ type: 'Button', key: 'run-ready' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'refresh-review' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Tasks' })).toBeUndefined()
    await ui.unmount()
  }
})

test('Run ready in the pane starts the ready task, Refresh review runs herdr-jev review', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await makePlan($, THREE)

  const ui = await $.ui.mount({
    plugin: 'harness',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'harness',
    props: PANE_PROPS,
  })
  await ui.press({ key: 'run-ready' })
  expect(seen.spawns).toHaveLength(1)
  expect(seen.spawns[0]?.subagentType).toBe('harness:implementer')
  expect(await ui.find({ type: 'Text', text: /agent-1 · starting/ })).toBeDefined()

  await ui.press({ key: 'run-ready' })
  expect(seen.spawns).toHaveLength(1)

  await ui.press({ key: 'refresh-review' })
  expect(seen.runs).toContainEqual(['herdr-jev', 'review', '--json', '--timeout-ms', '540000'])
  expect(await ui.find({ type: 'Text', text: /Review: ready · verify ready, auto ready/ })).toBeDefined()
  await ui.unmount()
})

test('/harness opens the pane and un-hides the band', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  const ran = await $.command.run({ command: 'harness', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(ran.text).toContain('Harness pane opened')
  expect(seen.opened).toContain('harness')
})
