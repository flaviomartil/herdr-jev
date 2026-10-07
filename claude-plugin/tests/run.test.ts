import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { HarnessPlan, HarnessTask } from '../types'
import {
  asksState,
  CWD,
  finish,
  makePlan,
  PLAN_TOOL,
  pendingReport,
  planState,
  RUN_TOOL,
  runTask,
  settle,
  STATUS_TOOL,
  wire,
  workersState,
} from './support'
import type { SpecSeen } from './support'

const THREE = {
  objective: 'Ship the parser',
  tasks: [
    { title: 'Add parser', paths: ['src/parser.ts'], checks: ['pnpm test'] },
    { title: 'Design the data model' },
    { title: 'Rename flags', deps: ['Add parser'] },
  ],
}

const start = ($: Engine) => $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

const lastSpec = (specs: SpecSeen[], name: string) => [...specs].reverse().find(spec => spec.name === name)

test('harness_plan reads models list once and triages each task, never herdr-jev plan', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await start($)
  await settle()
  seen.runs.length = 0

  const text = await makePlan($, THREE)
  expect(seen.runs.filter(argv => argv[1] === 'models')).toEqual([
    ['herdr-jev', 'models', 'list', '--json', '--client', 'claude'],
  ])
  expect(seen.runs.filter(argv => argv[1] === 'triage')).toHaveLength(3)
  expect(seen.runs).toContainEqual(['herdr-jev', 'triage', 'Add parser', '--json'])
  expect(seen.runs.some(argv => argv[1] === 'plan')).toBe(false)

  const plan = planState(seen)
  expect(plan?.objective).toBe('Ship the parser')
  const [add, design, rename] = plan?.tasks ?? []
  expect(add).toMatchObject({
    role: 'implementer', writes: false, model: 'sonnet-5', effort: 'high', review: true,
    reviewModel: 'opus-5', state: 'proposed', paths: ['src/parser.ts'], checks: ['pnpm test'],
  })
  expect(design).toMatchObject({ role: 'advisor', state: 'advisor', model: 'claude-fable-5-1' })
  expect(rename).toMatchObject({
    role: 'reader', writes: true, model: 'claude-haiku-4-5-20251001', effort: 'standard',
    review: true, reviewModel: 'opus-5', deps: [add?.id],
  })
  expect(plan?.roles.reviewer?.cliModel).toBe('claude-opus-5-5')
  expect(text).toContain(add?.id ?? 'missing')
  expect(seen.registered).toContain('tool:harness_plan')
  expect(seen.state.get('harness.stale')).toBe(false)
})

test('a failing models list marks the plan stale, shows unknown models and refuses to spawn', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  seen.failModels = true
  await start($)

  const text = await makePlan($, { objective: 'Goal', tasks: [{ title: 'Add parser' }] })
  expect(text).toContain('stale')
  expect(text).toContain('models')
  expect(planState(seen)?.tasks[0]).toMatchObject({ role: 'implementer', model: null, effort: null, state: 'proposed' })
  expect(seen.state.get('harness.stale')).toBe(true)

  const out = await runTask($)
  expect(out).toContain('models list')
  expect(seen.spawns).toHaveLength(0)
  expect(seen.specs).toHaveLength(0)
  expect(planState(seen)?.tasks[0]?.state).toBe('proposed')

  const single = await runTask($, planState(seen)?.tasks[0]?.id)
  expect(single).toContain('not started')
  expect(seen.spawns).toHaveLength(0)
})

test('a role without cliModel is missing: stale plan, that role is never spawned', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  seen.models.roles.reviewer = { model: 'opus-5', cliModel: null, error: 'unresolved', effort: 'xhigh' }
  await start($)

  const text = await makePlan($, { objective: 'Goal', tasks: [{ title: 'Add parser' }] })
  expect(text).toContain('reviewer')
  expect(seen.state.get('harness.stale')).toBe(true)

  await runTask($)
  expect(seen.spawns).toHaveLength(1)
  await finish($, 'agent-1', 'done')
  expect(seen.spawns).toHaveLength(1)
  expect(planState(seen)?.tasks[0]).toMatchObject({ state: 'review', reviewModel: null })
  expect(planState(seen)?.tasks[0]?.note).toContain('reviewer not started')
  expect(seen.specs.some(spec => spec.name === 'reviewer')).toBe(false)
})

test('harness_plan rejects a bad input with text, never a throw', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await start($)
  const out = await $.tool.call({ tool: 'mcp__harness__harness_plan', objective: '', tasks: [] })
  expect(String(out.result)).toContain('objective')
  expect(planState(seen)).toBeNull()
})

test('harness_run spawns the implementer with the Claude Code model alias and a registered type with its effort', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await start($)
  await makePlan($, THREE)

  const text = await runTask($)
  expect(seen.spawns).toHaveLength(1)
  expect(seen.spawns[0]).toMatchObject({ subagentType: 'harness:implementer', model: 'sonnet', cwd: CWD })
  expect(seen.spawns[0]?.prompt).toContain('Ship the parser')
  expect(seen.spawns[0]?.prompt).toContain('src/parser.ts')
  expect(seen.spawns[0]?.prompt).toContain('pnpm test')
  expect(text).toContain('agent-1')

  const spec = lastSpec(seen.specs, 'implementer')
  expect(spec).toMatchObject({ model: 'sonnet', effort: 'high' })
  expect(spec?.tools).toBeUndefined()
  expect(spec?.disallowedTools).toEqual(['Agent', 'mcp__harness__harness_run', 'mcp__harness__harness_plan'])

  const plan = planState(seen)
  expect(plan?.tasks[0]).toMatchObject({ state: 'running', agentId: 'agent-1', startedAt: 1_000_000 })
  expect(plan?.tasks[1]?.state).toBe('advisor')
  expect(plan?.tasks[2]?.state).toBe('proposed')
  expect(Object.keys(workersState(seen))).toEqual(['agent-1'])
})

test('the reviewer is read-only by tools and carries the implementer report', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await start($)
  await makePlan($, THREE)
  await runTask($)

  await finish($, 'agent-1', 'Implemented. Files changed: src/parser.ts')
  const plan = planState(seen)
  expect(plan?.tasks[0]).toMatchObject({ state: 'review', agentId: 'agent-1', reviewAgentId: 'agent-2' })
  expect(seen.spawns[1]).toMatchObject({ subagentType: 'harness:reviewer', model: 'opus' })
  expect(seen.spawns[1]?.prompt).toContain('REVIEW_GATE_VERDICT: APPROVE')
  expect(seen.spawns[1]?.prompt).toContain('REVIEW_GATE_VERDICT: CHANGES_REQUIRED')
  expect(seen.spawns[1]?.prompt).toContain('Implementer report:')
  expect(seen.spawns[1]?.prompt).toContain('Implemented. Files changed: src/parser.ts')
  expect(Object.keys(workersState(seen))).toEqual(['agent-2'])

  const spec = lastSpec(seen.specs, 'reviewer')
  expect(spec).toMatchObject({ model: 'opus', effort: 'xhigh' })
  expect(spec?.tools).toEqual(['Read', 'Glob', 'Grep'])
  for (const name of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'Agent', 'mcp__harness__harness_run', 'mcp__harness__harness_plan']) {
    expect(spec?.disallowedTools).toContain(name)
  }
})

test('reviewer CHANGES_REQUIRED marks the task failed with the verdict and a toast', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await start($)
  await makePlan($, THREE)
  await runTask($)
  await finish($, 'agent-1', 'done')
  await finish($, 'agent-2', 'The parser drops tokens.\nREVIEW_GATE_VERDICT: CHANGES_REQUIRED')

  expect(planState(seen)?.tasks[0]).toMatchObject({ state: 'failed', verdict: 'CHANGES_REQUIRED' })
  expect(seen.toasts.some(line => line.includes('requires changes'))).toBe(true)
  expect(workersState(seen)).toEqual({})
})

test('reviewer APPROVE moves the task to approved, not verified, and still unblocks dependents', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await start($)
  await makePlan($, THREE)
  await runTask($)
  await finish($, 'agent-1', 'done')
  await finish($, 'agent-2', 'Clean.\nREVIEW_GATE_VERDICT: APPROVE')

  expect(planState(seen)?.tasks[0]).toMatchObject({ state: 'approved', verdict: 'APPROVE' })
  const text = await runTask($)
  expect(text).toContain('started as mechanic')
  expect(await runTask($, planState(seen)?.tasks[0]?.id)).toContain('waits for the harness review')
})

test('the mechanic writes on the reader model, shows as reader, and always chains the reviewer', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await start($)
  await makePlan($, { objective: 'Tidy', tasks: [{ title: 'Create fixtures', paths: ['tests/fixtures'] }] })

  await runTask($)
  expect(seen.spawns[0]).toMatchObject({ subagentType: 'harness:mechanic', model: 'haiku' })
  const spec = lastSpec(seen.specs, 'mechanic')
  expect(spec).toMatchObject({ model: 'haiku', effort: 'medium' })
  expect(spec?.tools).toEqual(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'])
  expect(spec?.disallowedTools).toEqual(['Agent', 'mcp__harness__harness_run', 'mcp__harness__harness_plan'])
  expect(Object.values(workersState(seen))[0]).toMatchObject({ role: 'reader', writes: true })

  await finish($, 'agent-1', 'Created fixtures.')
  expect(planState(seen)?.tasks[0]).toMatchObject({ state: 'review', reviewAgentId: 'agent-2' })
  expect(seen.spawns[1]).toMatchObject({ subagentType: 'harness:reviewer', model: 'opus' })
  expect(seen.spawns[1]?.prompt).toContain('Created fixtures.')
})

test('the reader is read-only, needs no review and ends done', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await start($)
  await makePlan($, { objective: 'Look', tasks: [{ title: 'Read the config files' }] })
  expect(planState(seen)?.tasks[0]).toMatchObject({ role: 'reader', writes: false, review: false })

  await runTask($)
  expect(seen.spawns[0]).toMatchObject({ subagentType: 'harness:reader', model: 'haiku' })
  const spec = lastSpec(seen.specs, 'reader')
  expect(spec).toMatchObject({ effort: 'medium' })
  expect(spec?.tools).toEqual(['Read', 'Glob', 'Grep'])
  expect(spec?.disallowedTools).toContain('Bash')

  await finish($, 'agent-1', 'Found 3 files.')
  expect(planState(seen)?.tasks[0]).toMatchObject({ state: 'done', agentId: 'agent-1' })
  expect(seen.spawns).toHaveLength(1)
})

test('harness_run spawns a reader on haiku and an implementer on sonnet, never the exact CLI id', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await start($)
  await makePlan($, { objective: 'Mixed', tasks: [{ title: 'Inventory adapters' }, { title: 'Fix the read timeout in client.ts' }] })
  expect(planState(seen)?.tasks[0]).toMatchObject({ role: 'reader', model: 'claude-haiku-4-5-20251001' })

  await runTask($)
  const byType = new Map(seen.spawns.map(spawn => [spawn.subagentType, spawn.model]))
  expect(byType.get('harness:reader')).toBe('haiku')
  expect(byType.get('harness:implementer')).toBe('sonnet')
  expect(seen.spawns.every(spawn => spawn.model === 'haiku' || spawn.model === 'sonnet')).toBe(true)
  expect(seen.specs.every(spec => spec.model === 'haiku' || spec.model === 'sonnet' || spec.model === 'opus')).toBe(true)
  expect(planState(seen)?.tasks[0]?.model).toBe('claude-haiku-4-5-20251001')
})

test('a model without a Claude Code alias is refused with a reason and the task stays proposed', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  seen.models.roles.implementer = { model: 'mystery-1', cliModel: 'mystery-1', effort: 'high', readonly: false, fallbackActive: false }
  await start($)
  expect(seen.specs.some(spec => spec.name === 'implementer')).toBe(false)
  await makePlan($, { objective: 'One', tasks: [{ title: 'Add parser' }] })

  const out = await runTask($)
  expect(out).toContain('model mystery-1 has no Claude Code alias')
  expect(seen.spawns).toHaveLength(0)
  expect(seen.specs.some(spec => spec.name === 'implementer')).toBe(false)
  expect(planState(seen)?.tasks[0]).toMatchObject({ state: 'proposed' })
})

test('a spawn denied by the engine returns the task to proposed with the reason in its note', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await start($)
  await makePlan($, { objective: 'One', tasks: [{ title: 'Add parser' }] })
  seen.denySpawn = ['harness:implementer']

  const out = await runTask($)
  expect(out).toContain('refused harness:implementer')
  const task = planState(seen)?.tasks[0]
  expect(task).toMatchObject({ state: 'proposed' })
  expect(task?.note).toContain('refused harness:implementer')
  expect(task?.agentId).toBeUndefined()
  expect(Object.keys(workersState(seen))).toHaveLength(0)

  seen.denySpawn = []
  await runTask($)
  expect(planState(seen)?.tasks[0]).toMatchObject({ state: 'running', agentId: 'agent-1' })
})

test('a thrown spawn returns the task to proposed with the reason in its note', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await start($)
  await makePlan($, { objective: 'One', tasks: [{ title: 'Add parser' }] })
  seen.throwSpawn = 'InputValidationError: path ["model"] Invalid option'

  const out = await runTask($)
  expect(out).toContain('not started')
  const task = planState(seen)?.tasks[0]
  expect(task).toMatchObject({ state: 'proposed' })
  expect(task?.note).toContain('spawn refused')
  expect(task?.agentId).toBeUndefined()
  expect(Object.keys(workersState(seen))).toHaveLength(0)
  expect(seen.spawns).toHaveLength(0)
})

test('a changed effort re-registers the type before the next spawn', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await start($)
  await makePlan($, { objective: 'One', tasks: [{ title: 'Add a' }] })
  await runTask($)
  await finish($, 'agent-1', 'done')
  await finish($, 'agent-2', 'REVIEW_GATE_VERDICT: APPROVE')
  expect(seen.specs.filter(spec => spec.name === 'implementer')).toHaveLength(1)

  seen.models.roles.implementer = { model: 'sonnet-5', cliModel: 'claude-sonnet-5-6', effort: 'xhigh', readonly: false, fallbackActive: false }
  await makePlan($, { objective: 'Two', tasks: [{ title: 'Add b' }, { title: 'Add c' }] })
  await runTask($)
  const registered = seen.specs.filter(spec => spec.name === 'implementer')
  expect(registered).toHaveLength(2)
  expect(registered[1]).toMatchObject({ model: 'sonnet', effort: 'xhigh' })
  expect(seen.spawns.at(-1)).toMatchObject({ model: 'sonnet' })
})

test('a reviewer answer without a verdict line needs you', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await start($)
  await makePlan($, THREE)
  await runTask($)
  await finish($, 'agent-1', 'done')
  await finish($, 'agent-2', 'Looks fine to me.')

  expect(planState(seen)?.tasks[0]?.state).toBe('needs_you')
  expect(asksState(seen)[0]?.question).toContain('no verdict')
})

test('an implementer asking NEEDS_YOU records the question', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await start($)
  await makePlan($, THREE)
  await runTask($)
  await finish($, 'agent-1', 'Blocked.\nNEEDS_YOU: which parser library?')

  expect(planState(seen)?.tasks[0]).toMatchObject({ state: 'needs_you', note: 'which parser library?' })
  expect(asksState(seen)[0]).toMatchObject({ question: 'which parser library?' })
})

test('an aborted worker turn fails the task', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await start($)
  await makePlan($, THREE)
  await runTask($)
  await finish($, 'agent-1', '', 'aborted')
  expect(planState(seen)?.tasks[0]).toMatchObject({ state: 'failed' })
  expect(seen.toasts.length).toBeGreaterThan(0)
})

test('harness_run on a running task returns its agent id and never spawns twice', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await start($)
  await makePlan($, THREE)
  const id = planState(seen)?.tasks[0]?.id

  await runTask($, id)
  const again = await runTask($, id)
  expect(again).toContain('agent-1')
  expect(seen.spawns).toHaveLength(1)

  const both = await Promise.all([runTask($, id), runTask($)])
  expect(both.join('\n')).toContain('agent-1')
  expect(seen.spawns).toHaveLength(1)
})

test('three concurrent harness_run calls on a review task without a reviewer spawn exactly one reviewer', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await start($)
  await makePlan($, { objective: 'One', tasks: [{ title: 'Add parser' }] })
  const id = planState(seen)?.tasks[0]?.id
  await runTask($, id)

  seen.denySpawn = ['harness:reviewer']
  await finish($, 'agent-1', 'done')
  expect(planState(seen)?.tasks[0]).toMatchObject({ state: 'review' })
  expect(planState(seen)?.tasks[0]?.reviewAgentId).toBeUndefined()
  expect(planState(seen)?.tasks[0]?.reviewStarting).toBeUndefined()

  seen.denySpawn = []
  const before = seen.spawns.length
  const outs = await Promise.all([runTask($, id), runTask($), runTask($, id)])
  const reviewers = seen.spawns.slice(before).filter(spawn => spawn.subagentType === 'harness:reviewer')
  expect(reviewers).toHaveLength(1)
  expect(outs.filter(out => out.includes('review started'))).toHaveLength(1)
  expect(planState(seen)?.tasks[0]?.reviewAgentId).toBeDefined()
  expect(Object.values(workersState(seen)).filter(row => row.role === 'reviewer')).toHaveLength(1)
})

test('a reload keeps a live worker and resets a vanished one to proposed', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await start($)
  await makePlan($, THREE)
  const id = planState(seen)?.tasks[0]?.id
  await runTask($, id)

  await start($)
  expect(planState(seen)?.tasks[0]).toMatchObject({ state: 'running', agentId: 'agent-1' })
  expect(await runTask($, id)).toContain('agent-1')
  expect(seen.spawns).toHaveLength(1)

  seen.alive = []
  await start($)
  expect(planState(seen)?.tasks[0]).toMatchObject({ state: 'proposed' })
  expect(planState(seen)?.tasks[0]?.agentId).toBeUndefined()
  await runTask($, id)
  expect(seen.spawns).toHaveLength(2)
})

test('a worker that completed while the mod was away needs you instead of silently restarting', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await start($)
  await makePlan($, THREE)
  await runTask($, planState(seen)?.tasks[0]?.id)

  seen.alive = [{ id: 'agent-1', status: 'completed' }]
  await start($)
  expect(planState(seen)?.tasks[0]).toMatchObject({ state: 'needs_you' })
  expect(planState(seen)?.tasks[0]?.note).toContain('finished while the mod was not listening')
  expect(asksState(seen)).toHaveLength(1)
  expect(Object.keys(workersState(seen))).toEqual([])
})

test('a thrown agent list keeps running tasks and workers and marks the plan stale', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await start($)
  await makePlan($, THREE)
  await runTask($, planState(seen)?.tasks[0]?.id)

  seen.failList = true
  await start($)
  expect(planState(seen)?.tasks[0]).toMatchObject({ state: 'running', agentId: 'agent-1' })
  expect(Object.keys(workersState(seen))).toEqual(['agent-1'])
  expect(seen.state.get('harness.stale')).toBe(true)
  expect(String(seen.state.get('harness.staleNote'))).toContain('agent list unavailable')

  seen.failList = false
  expect(await runTask($, planState(seen)?.tasks[0]?.id)).toContain('agent-1')
  expect(seen.spawns).toHaveLength(1)
})

const savedTask = (over: Partial<HarnessTask>): HarnessTask => ({
  id: 'hp-0000000a',
  title: 'Saved task',
  role: 'implementer',
  writes: false,
  model: 'sonnet-5',
  effort: 'high',
  reason: 'seeded',
  deps: [],
  paths: [],
  checks: [],
  state: 'approved',
  review: true,
  reviewModel: 'opus-5',
  toolCount: 0,
  ...over,
})

const savedPlan = (tasks: HarnessTask[]): { plan: HarnessPlan; workers: object; needsYou: object[] } => ({
  plan: { objective: 'Seeded', advisorModel: 'claude-fable-5-1', roles: {}, tasks },
  workers: {},
  needsYou: [],
})

test('restore reads only the store entry of this session', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on, {
    store: {
      [`state:other:${CWD}`]: savedPlan([savedTask({})]),
      [`state:${CWD}`]: savedPlan([savedTask({})]),
    },
  })
  await start($)
  expect(planState(seen)).toBeNull()
})

test('restore brings back the plan saved under this session id', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on, {
    store: {
      [`state:sess-1:${CWD}`]: savedPlan([
        savedTask({}),
        savedTask({ id: 'hp-0000000b', title: 'Other', state: 'proposed' }),
      ]),
    },
  })
  await start($)
  expect(planState(seen)?.objective).toBe('Seeded')
  expect(planState(seen)?.tasks.map(task => task.state)).toEqual(['approved', 'proposed'])
})

test('a saved plan with an unknown state or role is rejected on restore', { options: { autoRun: false } }, async ($, on) => {
  const badState = wire(on, {
    store: { [`state:sess-1:${CWD}`]: savedPlan([savedTask({ state: 'exploded' as never })]) },
  })
  await start($)
  expect(planState(badState)).toBeNull()
})

test('a saved plan with an unknown role is rejected on restore', { options: { autoRun: false } }, async ($, on) => {
  const badRole = wire(on, {
    store: { [`state:sess-1:${CWD}`]: savedPlan([savedTask({ role: 'wizard' as never })]) },
  })
  await start($)
  expect(planState(badRole)).toBeNull()
})

test('saving writes under the session-scoped key only', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await start($)
  await makePlan($, THREE)
  expect(seen.saved.has(`state:sess-1:${CWD}`)).toBe(true)
  expect(seen.saved.has(`state:${CWD}`)).toBe(false)
})

test('harness_run honours maxWorkers', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await start($)
  await makePlan($, {
    objective: 'Many',
    tasks: [{ title: 'Add a' }, { title: 'Add b' }, { title: 'Add c' }, { title: 'Add d' }],
  })
  await runTask($)
  expect(seen.spawns).toHaveLength(3)
  const text = await runTask($)
  expect(text).toContain('limit')
  expect(seen.spawns).toHaveLength(3)
})

test('harness_run honours the maxWorkers option', { options: { maxWorkers: 1, autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await start($)
  await makePlan($, { objective: 'Many', tasks: [{ title: 'Add a' }, { title: 'Add b' }] })
  await runTask($)
  expect(seen.spawns).toHaveLength(1)
})

test('herdrJevBin overrides the binary', { options: { herdrJevBin: '/opt/hj', autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await start($)
  await makePlan($, { objective: 'Goal', tasks: [{ title: 'Add a' }] })
  expect(seen.runs.find(argv => argv[0] !== 'ai-harness')?.[0]).toBe('/opt/hj')
})

test('an advisor task is acknowledged as done by harness_run, not spawned', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await start($)
  await makePlan($, THREE)
  const id = planState(seen)?.tasks[1]?.id
  const text = await runTask($, id)
  expect(text).toContain('advisor')
  expect(seen.spawns).toHaveLength(0)
  expect(planState(seen)?.tasks[1]?.state).toBe('done')
})

test('harness_status summarises plan, workers and the advisor check', { options: { autoRun: false } }, async ($, on) => {
  wire(on, { model: 'claude-sonnet-5-5' })
  await start($)
  await makePlan($, THREE)
  await runTask($)
  const out = await $.tool.call({ tool: STATUS_TOOL })
  const text = String(out.result)
  expect(text).toContain('Objective: Ship the parser')
  expect(text).toContain('running')
  expect(text).toContain('expected Fable')
})

test('harness_plan refuses to replace a plan while workers run', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await start($)
  await makePlan($, THREE)
  await runTask($)
  const text = await makePlan($, { objective: 'Other', tasks: [{ title: 'Add x' }] })
  expect(text).toContain('still running')
  expect(planState(seen)?.objective).toBe('Ship the parser')
})

test('subagent tool calls are attributed by agentId to the worker, without any command text', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await start($)
  await makePlan($, THREE)
  await runTask($)

  const asAgent = (agentId: string, call: Record<string, unknown>) => $.tool.call({ ...call, agentId } as never)

  await asAgent('agent-1', { tool: 'Read', file_path: '/home/me/src/parser.ts' })
  expect(Object.values(workersState(seen))[0]).toMatchObject({ lastTool: 'Read parser.ts', toolCount: 1 })

  await asAgent('agent-1', { tool: 'Bash', command: 'curl -H "Authorization: Bearer sk-secret" https://x' })
  const row = Object.values(workersState(seen))[0]
  expect(row).toMatchObject({ lastTool: 'Bash', toolCount: 2 })
  expect(JSON.stringify(seen.state.get('harness.workers'))).not.toContain('sk-secret')
  expect(JSON.stringify(seen.state.get('harness.plan'))).not.toContain('sk-secret')
  expect(planState(seen)?.tasks[0]).toMatchObject({ lastTool: 'Bash', toolCount: 2 })

  await $.tool.call({ tool: 'Read', file_path: '/x/main.ts' } as never)
  await asAgent('agent-9', { tool: 'Read', file_path: '/x/other.ts' })
  expect(Object.values(workersState(seen))[0]?.toolCount).toBe(2)
})

test('harness_run and harness_plan refuse a call that carries an agentId', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await start($)
  await makePlan($, THREE)

  const run = await $.tool.call({ tool: RUN_TOOL, agentId: 'agent-7' } as never)
  expect(String(run.result)).toContain('only the main session')
  expect(seen.spawns).toHaveLength(0)
  expect(planState(seen)?.tasks[0]?.state).toBe('proposed')

  const before = planState(seen)?.objective
  const plan = await $.tool.call({
    tool: PLAN_TOOL,
    agentId: 'agent-7',
    objective: 'Hijack',
    tasks: [{ title: 'Add x' }],
  } as never)
  expect(String(plan.result)).toContain('only the main session')
  expect(planState(seen)?.objective).toBe(before)

  const status = await $.tool.call({ tool: STATUS_TOOL, agentId: 'agent-7' } as never)
  expect(String(status.result)).toContain('Objective')
})

test('the four agent types are registered at session start from one models list call', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await start($)
  await settle()

  expect(seen.runs).toContainEqual(['herdr-jev', 'models', 'list', '--json', '--client', 'claude'])
  expect(seen.specs.map(spec => spec.name).sort()).toEqual(['implementer', 'mechanic', 'reader', 'reviewer'])
  expect(lastSpec(seen.specs, 'implementer')).toMatchObject({ model: 'sonnet', effort: 'high' })
  expect(lastSpec(seen.specs, 'reviewer')).toMatchObject({ model: 'opus', effort: 'xhigh' })
  expect(lastSpec(seen.specs, 'mechanic')).toMatchObject({ model: 'haiku', effort: 'medium' })
  expect(seen.registered).toContain('tool:harness_plan')

  await makePlan($, { objective: 'One', tasks: [{ title: 'Add a' }] })
  await runTask($)
  expect(seen.specs.filter(spec => spec.name === 'implementer')).toHaveLength(1)
  expect(seen.spawns).toHaveLength(1)
})

test('a failing models list at session start registers nothing, tolerates it, and the lazy path still works', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  seen.failModels = true
  await start($)
  await settle()

  expect(seen.specs).toHaveLength(0)
  expect(seen.registered).toContain('tool:harness_plan')
  expect(seen.logs.some(line => line.includes('not registered at start'))).toBe(true)

  seen.failModels = false
  await makePlan($, { objective: 'One', tasks: [{ title: 'Add a' }] })
  await runTask($)
  expect(seen.specs.filter(spec => spec.name === 'implementer')).toHaveLength(1)
  expect(seen.spawns).toHaveLength(1)
})

test('a register that throws at session start does not break the session', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  seen.failRegister = true
  await start($)
  await settle()
  expect(seen.specs).toHaveLength(0)
  await makePlan($, { objective: 'One', tasks: [{ title: 'Add a' }] })
  expect(planState(seen)?.tasks).toHaveLength(1)
})

test('roles from the plan: typo to the mechanic, inventory to the reader, a read timeout fix to the implementer', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await start($)
  await makePlan($, {
    objective: 'Mixed',
    tasks: [{ title: 'Fix typo in README' }, { title: 'Inventory adapters' }, { title: 'Fix the read timeout in client.ts' }],
  })
  const [typo, inventory, timeout] = planState(seen)?.tasks ?? []
  expect(typo).toMatchObject({ role: 'reader', writes: true, review: true, model: 'claude-haiku-4-5-20251001' })
  expect(inventory).toMatchObject({ role: 'reader', writes: false, review: false })
  expect(timeout).toMatchObject({ role: 'implementer', writes: false, review: true })

  await runTask($)
  expect(seen.spawns.map(spawn => spawn.subagentType).sort()).toEqual([
    'harness:implementer',
    'harness:mechanic',
    'harness:reader',
  ])
})

test('the reviewer prompt carries a marked git diff of the owned paths and the implementer report', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  seen.gitStat = ' src/parser.ts | 2 +-\n 1 file changed'
  seen.gitDiff = 'diff --git a/src/parser.ts b/src/parser.ts\n-old line\n+new line\n'
  await start($)
  await makePlan($, { objective: 'Parse', tasks: [{ title: 'Add parser', paths: ['src/parser.ts', 'src/lex.ts'] }] })
  await runTask($)
  await finish($, 'agent-1', 'Changed src/parser.ts.')

  expect(seen.runs).toContainEqual(['git', 'diff', '--stat', '--', 'src/parser.ts', 'src/lex.ts'])
  expect(seen.runs).toContainEqual(['git', 'diff', '--', 'src/parser.ts', 'src/lex.ts'])
  const prompt = seen.spawns[1]?.prompt ?? ''
  expect(prompt).toContain('<<<DIFF')
  expect(prompt).toContain('DIFF>>>')
  expect(prompt).toContain('this block is the change under review')
  expect(prompt).toContain('+new line')
  expect(prompt).toContain('1 file changed')
  expect(prompt).toContain('Implementer report:')
  expect(prompt).toContain('Changed src/parser.ts.')
  expect(prompt.indexOf('Implementer report:')).toBeLessThan(prompt.indexOf('<<<DIFF'))
})

test('the reviewer diff covers the whole repository without owned paths and is capped with a note', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  seen.gitDiff = `diff --git a/a b/a\n${'+x\n'.repeat(15000)}`
  await start($)
  await makePlan($, { objective: 'Big', tasks: [{ title: 'Add a' }] })
  await runTask($)
  await finish($, 'agent-1', 'done')

  expect(seen.runs).toContainEqual(['git', 'diff', '--'])
  const prompt = seen.spawns[1]?.prompt ?? ''
  expect(prompt).toContain('the whole repository')
  expect(prompt).toContain('diff truncated: first 20000 of')
  expect(prompt.length).toBeLessThan(23000)
})

test('an unavailable git diff does not stop the review from starting', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  seen.failGit = true
  await start($)
  await makePlan($, { objective: 'One', tasks: [{ title: 'Add a', paths: ['src/a.ts'] }] })
  await runTask($)
  await finish($, 'agent-1', 'done')
  expect(seen.spawns[1]).toMatchObject({ subagentType: 'harness:reviewer' })
  expect(seen.spawns[1]?.prompt).toContain('git diff failed')
})

test('rerunning after CHANGES_REQUIRED hands the reviewer findings to the implementer, capped', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await start($)
  await makePlan($, THREE)
  const id = planState(seen)?.tasks[0]?.id
  await runTask($, id)
  await finish($, 'agent-1', 'done')
  const findings = `The parser drops tokens at EOF.\n${'detail line\n'.repeat(1500)}REVIEW_GATE_VERDICT: CHANGES_REQUIRED`
  await finish($, 'agent-2', findings)

  const stored = planState(seen)?.tasks[0]
  expect(stored).toMatchObject({ state: 'failed', verdict: 'CHANGES_REQUIRED' })
  expect(stored?.reviewReport).toContain('The parser drops tokens at EOF.')
  expect((stored?.reviewReport ?? '').length).toBeLessThanOrEqual(8000)

  await runTask($, id)
  const rerun = seen.spawns[2]
  expect(rerun).toMatchObject({ subagentType: 'harness:implementer' })
  expect(rerun?.prompt).toContain('Previous review findings')
  expect(rerun?.prompt).toContain('The parser drops tokens at EOF.')
  expect(rerun?.prompt.length ?? 0).toBeLessThan(9500)

  await finish($, 'agent-3', 'Fixed.')
  await finish($, 'agent-4', 'Clean.\nREVIEW_GATE_VERDICT: APPROVE')
  expect(planState(seen)?.tasks[0]).toMatchObject({ state: 'approved' })
  expect(planState(seen)?.tasks[0]?.reviewReport).toBeUndefined()
})

test('a first run carries no previous findings heading', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await start($)
  await makePlan($, THREE)
  await runTask($)
  expect(seen.spawns[0]?.prompt).not.toContain('Previous review findings')
})

test('a reviewer needs_you rerun re-runs the review, not the implementer', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await start($)
  await makePlan($, THREE)
  const id = planState(seen)?.tasks[0]?.id
  await runTask($, id)
  await finish($, 'agent-1', 'Implemented src/parser.ts')
  await finish($, 'agent-2', 'Looks fine to me.')
  expect(planState(seen)?.tasks[0]).toMatchObject({ state: 'needs_you', reviewAgentId: 'agent-2' })

  const text = await runTask($, id)
  expect(text).toContain('review started')
  expect(seen.spawns).toHaveLength(3)
  expect(seen.spawns[2]).toMatchObject({ subagentType: 'harness:reviewer' })
  expect(seen.spawns[2]?.prompt).toContain('Implemented src/parser.ts')
  expect(planState(seen)?.tasks[0]).toMatchObject({ state: 'review', reviewAgentId: 'agent-3' })
  expect(asksState(seen)).toHaveLength(0)

  await finish($, 'agent-3', 'Clean.\nREVIEW_GATE_VERDICT: APPROVE')
  expect(planState(seen)?.tasks[0]?.state).toBe('approved')
})

test('a worker needs_you rerun still restarts the implementer', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await start($)
  await makePlan($, THREE)
  const id = planState(seen)?.tasks[0]?.id
  await runTask($, id)
  await finish($, 'agent-1', 'Blocked.\nNEEDS_YOU: which library?')
  await runTask($, id)
  expect(seen.spawns).toHaveLength(2)
  expect(seen.spawns[1]).toMatchObject({ subagentType: 'harness:implementer' })
})

test('the plan tool description does not hardcode a reviewer model', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await start($)
  const desc = seen.descriptions.get('harness_plan') ?? ''
  expect(desc).toContain('reviewer from Herdr-Jev')
  expect(desc).not.toContain('Opus')
})

test('a successful reconcile clears the stale mark an unavailable agent list left', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await start($)
  await makePlan($, THREE)
  await runTask($, planState(seen)?.tasks[0]?.id)

  seen.failList = true
  await start($)
  expect(seen.state.get('harness.stale')).toBe(true)

  seen.failList = false
  await start($)
  expect(seen.state.get('harness.stale')).toBe(false)
  expect(seen.state.get('harness.staleNote')).toBeNull()
})

const CHAIN = {
  objective: 'Read things',
  tasks: [{ title: 'Read the logs' }, { title: 'Read the config', deps: ['Read the logs'] }],
}

const IMPLEMENT = {
  objective: 'Implement things',
  tasks: [{ title: 'Add parser' }, { title: 'Add docs', deps: ['Add parser'] }],
}

const reviews = (seen: { runs: string[][] }) => seen.runs.filter(argv => argv[1] === 'review')

async function drain(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await settle()
}

test('autoRun starts the ready task at plan time and the dependent one when the first completes', async ($, on) => {
  const seen = wire(on)
  await start($)
  const text = await makePlan($, CHAIN)
  const plan = planState(seen)

  expect(text).toContain('Auto-run:')
  expect(seen.spawns).toHaveLength(1)
  expect(plan?.tasks.map(task => task.state)).toEqual(['running', 'proposed'])

  await finish($, 'agent-1', 'Found it.')
  expect(seen.spawns).toHaveLength(2)
  expect(planState(seen)?.tasks.map(task => task.state)).toEqual(['done', 'running'])
  expect(seen.spawns.map(spawn => spawn.subagentType)).toEqual(['harness:reader', 'harness:reader'])

  await finish($, 'agent-2', 'Found more.')
  expect(seen.spawns).toHaveLength(2)
  expect(planState(seen)?.tasks.map(task => task.state)).toEqual(['done', 'done'])
})

test('autoRun chains the reviewer and starts the dependent task once the review approves', async ($, on) => {
  const seen = wire(on)
  await start($)
  await makePlan($, IMPLEMENT)
  expect(seen.spawns).toHaveLength(1)

  await finish($, 'agent-1', 'Done.')
  expect(seen.spawns.map(spawn => spawn.subagentType)).toEqual(['harness:implementer', 'harness:reviewer'])
  expect(planState(seen)?.tasks[1]?.state).toBe('proposed')

  await finish($, 'agent-2', 'Clean.\nREVIEW_GATE_VERDICT: APPROVE')
  expect(planState(seen)?.tasks.map(task => task.state)).toEqual(['approved', 'running'])
  expect(seen.spawns.map(spawn => spawn.subagentType)).toEqual([
    'harness:implementer',
    'harness:reviewer',
    'harness:implementer',
  ])
})

test('autoRun runs the next ready tasks after a failure or a question, never the failed one again', async ($, on) => {
  const seen = wire(on)
  await start($)
  await makePlan($, { objective: 'Many', tasks: [{ title: 'Add a' }, { title: 'Add b' }, { title: 'Add c' }] })
  expect(seen.spawns).toHaveLength(3)
  await finish($, 'agent-1', 'Blocked.\nNEEDS_YOU: which one?')
  expect(seen.spawns).toHaveLength(3)
  expect(planState(seen)?.tasks[0]?.state).toBe('needs_you')
})

test('autoRun respects maxWorkers and fills the slot a settled task frees', { options: { maxWorkers: 1 } }, async ($, on) => {
  const seen = wire(on)
  await start($)
  await makePlan($, { objective: 'Many', tasks: [{ title: 'Read a' }, { title: 'Read b' }] })
  expect(seen.spawns).toHaveLength(1)
  await finish($, 'agent-1', 'ok')
  expect(seen.spawns).toHaveLength(2)
  expect(planState(seen)?.tasks.map(task => task.state)).toEqual(['done', 'running'])
})

test('without autoRun nothing starts until harness_run', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await start($)
  const text = await makePlan($, CHAIN)
  expect(text).not.toContain('Auto-run')
  expect(seen.spawns).toHaveLength(0)
  expect(planState(seen)?.tasks.map(task => task.state)).toEqual(['proposed', 'proposed'])

  await runTask($)
  expect(seen.spawns).toHaveLength(1)
  await finish($, 'agent-1', 'Found it.')
  expect(seen.spawns).toHaveLength(1)
  expect(planState(seen)?.tasks.map(task => task.state)).toEqual(['done', 'proposed'])
})

test('autoReview runs the harness review exactly once after the last approval', { options: { autoReview: true } }, async ($, on) => {
  const seen = wire(on)
  await start($)
  await makePlan($, IMPLEMENT)
  await finish($, 'agent-1', 'Done.')
  await finish($, 'agent-2', 'Clean.\nREVIEW_GATE_VERDICT: APPROVE')
  await drain()
  expect(reviews(seen)).toHaveLength(0)

  await finish($, 'agent-3', 'Done.')
  await finish($, 'agent-4', 'Clean.\nREVIEW_GATE_VERDICT: APPROVE')
  await drain()
  expect(reviews(seen)).toHaveLength(1)
  expect(planState(seen)?.tasks.map(task => task.state)).toEqual(['verified', 'verified'])

  await runTask($)
  await drain()
  expect(reviews(seen)).toHaveLength(1)
})

test('autoReview never repeats for the same approved set, even when the review is not ready', { options: { autoReview: true } }, async ($, on) => {
  const seen = wire(on)
  seen.reviewExit = 1
  seen.reviewBody = pendingReport()
  await start($)
  await makePlan($, { objective: 'One', tasks: [{ title: 'Add parser' }] })
  await finish($, 'agent-1', 'Done.')
  await finish($, 'agent-2', 'Clean.\nREVIEW_GATE_VERDICT: APPROVE')
  await drain()
  expect(reviews(seen)).toHaveLength(1)
  expect(planState(seen)?.tasks[0]?.state).toBe('approved')

  await runTask($)
  await drain()
  expect(reviews(seen)).toHaveLength(1)
})

test('autoReview stays off by default', async ($, on) => {
  const seen = wire(on)
  await start($)
  await makePlan($, { objective: 'One', tasks: [{ title: 'Add parser' }] })
  await finish($, 'agent-1', 'Done.')
  await finish($, 'agent-2', 'Clean.\nREVIEW_GATE_VERDICT: APPROVE')
  await drain()
  expect(reviews(seen)).toHaveLength(0)
  expect(planState(seen)?.tasks[0]?.state).toBe('approved')
})
