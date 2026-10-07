import { expect, test } from 'claude-code/testing'

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

test('the band falls through to the engine while there is no plan', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'harness', surface, component: 'AbovePrompt', props: BAND_PROPS })
    expect(await ui.find({ text: 'engine band' })).toBeDefined()
    await ui.unmount()
  }
})

test('the band shows task counts on terminal and desktop and yields to a survey', async ($, on) => {
  const seen = wire(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await makePlan($, THREE)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'harness', surface, component: 'AbovePrompt', props: BAND_PROPS })
    const line = await ui.find({ type: 'Text', text: /harness · demo/ })
    expect(line?.text).toContain('0/3')
    expect(line?.text).toContain('░░░░░░░░░░')
    expect(await ui.find({ type: 'Button', key: 'plan' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'hide' })).toBeDefined()
    await ui.unmount()

    const survey = await $.ui.mount({
      plugin: 'harness',
      surface,
      component: 'AbovePrompt',
      props: { ...BAND_PROPS, hasSurvey: true },
    })
    expect(await survey.find({ text: 'engine band' })).toBeDefined()
    await survey.unmount()
  }

  await runTask($)
  const ui = await $.ui.mount({ plugin: 'harness', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  const running = await ui.find({ type: 'Text', text: /● Add parser/ })
  expect(running?.text).toContain('implementer/sonnet-5')
  expect(planState(seen)?.tasks[0]?.state).toBe('running')
  await ui.unmount()
})

test('the band counts settled tasks, flags failures and needs-you', async ($, on) => {
  wire(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await makePlan($, THREE)
  await runTask($)
  await finish($, 'agent-1', 'done')
  await finish($, 'agent-2', 'Bad.\nREVIEW_GATE_VERDICT: CHANGES_REQUIRED')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'harness', surface, component: 'AbovePrompt', props: BAND_PROPS })
    expect(await ui.find({ type: 'Text', text: /✗ Add parser/ })).toBeDefined()
    await ui.unmount()
  }

})

test('the band warns when the advisor model is not Fable', async ($, on) => {
  wire(on, { model: 'claude-sonnet-5-5' })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await makePlan($, THREE)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'harness', surface, component: 'AbovePrompt', props: BAND_PROPS })
    const warn = await ui.find({ type: 'Text', text: /expected Fable/ })
    expect(warn?.props.dimColor).toBe(true)
    await ui.unmount()
  }
})

test('Hide hides the band and Plan opens the pane', async ($, on) => {
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
  expect(await ui.find({ text: 'engine band' })).toBeDefined()
  await ui.unmount()
})

test('the band shows approved with harness review pending, then all verified after a ready review', async ($, on) => {
  const seen = wire(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await makePlan($, { objective: 'One thing', tasks: [{ title: 'Add parser' }] })
  await runTask($)
  await finish($, 'agent-1', 'done')
  await finish($, 'agent-2', 'Clean.\nREVIEW_GATE_VERDICT: APPROVE')

  const ui = await $.ui.mount({ plugin: 'harness', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ type: 'Text', text: /1 approved, harness review pending/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /all verified/ })).toBeUndefined()
  await ui.unmount()

  const pane = await $.ui.mount({ plugin: 'harness', surface: 'terminal', component: 'Pane', requestId: 'harness', props: PANE_PROPS })
  await pane.press({ key: 'refresh-review' })
  await pane.unmount()
  expect(planState(seen)?.tasks[0]?.state).toBe('verified')

  const band = await $.ui.mount({ plugin: 'harness', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  const ok = await band.find({ type: 'Text', text: /all verified/ })
  expect(ok?.props.color).toBe('success')
  await seen.clock.advance(19000)
  expect(await band.find({ type: 'Text', text: /all verified/ })).toBeDefined()
  await seen.clock.advance(2000)
  expect(await band.find({ text: 'engine band' })).toBeDefined()
  await band.unmount()
})

test('a pending review keeps tasks approved and a failed refresh is reported', async ($, on) => {
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
  expect(await band.find({ type: 'Text', text: /1 approved, harness review: pending_judge/ })).toBeDefined()
  await band.unmount()

  seen.failCli = true
  seen.reviewBody = {}
  await pane.press({ key: 'refresh-review' })
  expect(planState(seen)?.tasks[0]?.state).toBe('approved')
  await pane.unmount()
})

test('review running shows in the band and the pane, and a second refresh never runs a second review', async ($, on) => {
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
  expect(await band.find({ type: 'Text', text: /1 approved, harness review running/ })).toBeDefined()
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

test('the pane lists tasks, workers and buttons on every surface', async ($, on) => {
  const seen = wire(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await makePlan($, THREE)
  const plan = planState(seen)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'harness',
      surface,
      component: 'Pane',
      requestId: 'harness',
      props: PANE_PROPS,
    })
    expect(await ui.find({ type: 'Text', text: /Harness · Ship the parser/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Advisor: claude-fable-5-1/ })).toBeDefined()
    for (const task of plan?.tasks ?? []) {
      expect(await ui.find({ type: 'Text', text: task.id })).toBeDefined()
    }
    expect(await ui.find({ type: 'Text', text: /implementer\/sonnet-5\/high/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'No workers running.' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'run-next' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'refresh-review' })).toBeDefined()
    await ui.unmount()
  }
})

test('Run next in the pane starts the ready task, Refresh review runs herdr-jev review', async ($, on) => {
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
  await ui.press({ key: 'run-next' })
  expect(seen.spawns).toHaveLength(1)
  expect(seen.spawns[0]?.subagentType).toBe('harness:implementer')
  expect(await ui.find({ type: 'Text', text: /implementer\/sonnet-5 · starting/ })).toBeDefined()

  await ui.press({ key: 'run-next' })
  expect(seen.spawns).toHaveLength(1)

  await ui.press({ key: 'refresh-review' })
  expect(seen.runs).toContainEqual(['herdr-jev', 'review', '--json', '--timeout-ms', '540000'])
  expect(await ui.find({ type: 'Text', text: /Review: ready · verify ready, auto ready/ })).toBeDefined()
  await ui.unmount()
})

test('/harness opens the pane and un-hides the band', async ($, on) => {
  const seen = wire(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  const ran = await $.command.run({ command: 'harness', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(ran.text).toContain('Harness pane opened')
  expect(seen.opened).toContain('harness')
})
