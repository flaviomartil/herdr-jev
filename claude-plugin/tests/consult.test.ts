import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { CWD, finish, makePlan, planState, runTask, settle, STATUS_TOOL, wire, workersState } from './support'
import type { Seen } from './support'

const OPUS = 'claude-opus-5-5'

const PLAN = {
  objective: 'Ship the cache',
  tasks: [
    { title: 'Design the cache layer', paths: ['src/cache'] },
    { title: 'Add cache tests', paths: ['tests/cache.test.ts'], checks: ['bun test'] },
  ],
}

const PROFILE = {
  id: 'claude-opus-5',
  client: 'claude',
  advisor: 'opus-5',
  executor: { model: 'claude-sonnet-5', cliModel: 'claude-sonnet-5-5', effort: 'high' },
  reviewer: { model: 'opus-5', cliModel: 'claude-opus-5-5', effort: 'xhigh' },
}

const CONSULT = { client: 'claude', model: 'fable-5', cliModel: 'claude-fable-5-1', effort: 'high' }

const start = ($: Engine) => $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

function answerDelegation(seen: Seen, consultOn: readonly string[] = ['architectural']): void {
  seen.runHook = async argv => {
    if (argv[1] !== 'delegation-plan') return undefined
    const complexity = argv[argv.indexOf('--complexity') + 1] ?? ''
    const body = consultOn.includes(complexity) ? { mode: 'delegate', profile: PROFILE, consult: CONSULT } : { mode: 'delegate', profile: PROFILE }
    return { exitCode: 0, stdout: JSON.stringify(body), stderr: '' }
  }
}

const delegationCalls = (seen: Seen) => seen.runs.filter(argv => argv[1] === 'delegation-plan')

test('an architectural task gets one read-only Fable consult before anything starts', { options: { autoRun: true } }, async ($, on) => {
  const seen = wire(on, { model: OPUS })
  answerDelegation(seen)
  await start($)
  await settle()

  const text = await makePlan($, PLAN)
  const calls = delegationCalls(seen)
  expect(calls).toHaveLength(2)
  expect(calls[0]?.slice(0, 7)).toEqual(['herdr-jev', 'delegation-plan', '--client', 'claude', '--model', OPUS, '--complexity'])
  expect(calls[0]).toContain('--json')
  const available = calls[0]?.[calls[0].indexOf('--available-models') + 1] ?? ''
  expect(available.split(',')).toContain('claude-fable-5-1')
  expect(available.split(',')).toContain(OPUS)

  const consults = seen.spawns.filter(spawn => spawn.subagentType === 'harness:consultant')
  expect(consults).toHaveLength(1)
  expect(consults[0]?.model).toBe('fable')
  expect(consults[0]?.prompt).toContain('Design the cache layer')
  const spec = seen.specs.find(one => one.name === 'consultant')
  expect(spec).toMatchObject({ model: 'fable', effort: 'high', tools: ['Read', 'Glob', 'Grep'] })
  for (const tool of ['Edit', 'Write', 'Bash', 'Agent', 'NotebookEdit']) expect(spec?.disallowedTools).toContain(tool)

  const [design, tests] = planState(seen)?.tasks ?? []
  expect(design?.consult).toMatchObject({ model: 'fable-5', cliModel: 'claude-fable-5-1', effort: 'high', state: 'running', agentId: 'agent-1' })
  expect(tests?.consult).toBeUndefined()
  expect(workersState(seen)['agent-1']).toMatchObject({ taskId: design?.id, role: 'advisor', writes: false })
  expect(text).toContain('read-only consult started on fable-5')
  expect(seen.state.get('harness.stale')).toBe(false)
})

test('the consult recommendation goes to the session and never starts the task by itself', { options: { autoRun: true } }, async ($, on) => {
  const seen = wire(on, { model: OPUS })
  answerDelegation(seen, ['architectural', 'routine'])
  await start($)
  await settle()
  await makePlan($, PLAN)

  const consults = seen.spawns.filter(spawn => spawn.subagentType === 'harness:consultant')
  expect(consults).toHaveLength(2)
  expect(seen.spawns.some(spawn => spawn.subagentType === 'harness:implementer')).toBe(false)

  const testsTask = planState(seen)?.tasks[1]
  const consultAgent = testsTask?.consult?.agentId ?? 'missing'
  const early = await runTask($, testsTask?.id)
  expect(early).toContain('waits for its read-only consult')

  await finish($, consultAgent, 'Decomposition: one task. Risks: stale entries. Order: tests first.')
  await settle()
  const after = planState(seen)?.tasks[1]
  expect(after?.consult).toMatchObject({ state: 'done', report: 'Decomposition: one task. Risks: stale entries. Order: tests first.' })
  expect(after?.state).toBe('proposed')
  expect(workersState(seen)[consultAgent]).toBeUndefined()
  expect(seen.toasts.some(toast => toast.includes('consult ready'))).toBe(true)
  expect(seen.spawns.some(spawn => spawn.subagentType === 'harness:implementer')).toBe(false)

  const status = String((await $.tool.call({ tool: STATUS_TOOL })).result)
  expect(status).toContain('Risks: stale entries')
  expect(status).toContain('you decide')

  const started = await runTask($, after?.id)
  expect(started).toContain('started as implementer')
  const implementer = seen.spawns.find(spawn => spawn.subagentType === 'harness:implementer')
  expect(implementer?.prompt).not.toContain('Risks: stale entries')
})

test('a consult that ends without an answer is recorded as failed', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on, { model: OPUS })
  answerDelegation(seen)
  await start($)
  await settle()
  await makePlan($, PLAN)
  const agent = planState(seen)?.tasks[0]?.consult?.agentId ?? 'missing'
  await finish($, agent, '', 'aborted')
  await settle()
  expect(planState(seen)?.tasks[0]?.consult).toMatchObject({ state: 'failed', note: 'consult turn ended: aborted' })
})

test('no consult field, a failed lookup or a non-claude consult means no consult and no stale plan', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on, { model: OPUS })
  answerDelegation(seen, [])
  await start($)
  await settle()
  await makePlan($, PLAN)
  expect(seen.spawns).toHaveLength(0)
  expect(planState(seen)?.tasks.every(task => task.consult === undefined)).toBe(true)

  seen.runHook = async argv => (argv[1] === 'delegation-plan' ? { exitCode: 2, stdout: '', stderr: 'down' } : undefined)
  await makePlan($, PLAN)
  expect(seen.spawns).toHaveLength(0)
  expect(seen.state.get('harness.stale')).toBe(false)

  seen.runHook = async argv => argv[1] === 'delegation-plan'
    ? { exitCode: 0, stdout: JSON.stringify({ mode: 'delegate', profile: PROFILE, consult: { ...CONSULT, client: 'codex' } }), stderr: '' }
    : undefined
  await makePlan($, PLAN)
  expect(seen.spawns).toHaveLength(0)
})

test('a reload marks a vanished consult as failed and keeps the plan', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on, { model: OPUS })
  answerDelegation(seen)
  await start($)
  await settle()
  await makePlan($, PLAN)
  seen.alive = []
  await start($)
  await settle()
  expect(planState(seen)?.tasks[0]?.consult).toMatchObject({ state: 'failed', note: 'consult agent is gone' })
})
