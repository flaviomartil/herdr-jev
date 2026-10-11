import { expect, test } from 'claude-code/testing'
import { automaticCall, automaticResult, automaticSummary } from '../hooks/automatic'
import type { Automatic } from '../types'
import { CWD, finish, makePlan, PANE_PROPS, planState, runTask, settle, wire as baseWire } from './support'

const wire: typeof baseWire = (on, extra) => {
  on('env.get', () => ({ value: undefined }))
  on('classic.UserPromptSubmit', () => ({}))
  return baseWire(on, extra)
}

const ID = '11111111-1111-4111-a111-111111111111'
const initial: Automatic = { turn: 'turn-auto', cwd: CWD, task: 'implement parser', model: 'claude-fable-5-1', state: 'planning', reason: 'planning', stages: [] }
const response = (state: string) => ({ id: ID, run: { id: ID, stages: [
  { role: 'implementer', client: 'codex', model: 'gpt-6.1-sol', state },
  { role: 'reviewer', client: 'claude', model: 'claude-opus-5-5', state: state === 'verified' ? state : 'queued' },
] } })

test('automatic calls reject failed exits even when stdout contains a valid decision', async () => {
  const run = async () => ({ exitCode: 1, stdout: JSON.stringify(response('verified')), stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
  await expect(automaticCall(run, { bin: 'herdr-jev', cwd: CWD }, ['mod-status'], 5000)).rejects.toThrow('automatic_command_failed')
});

test('automatic result distinguishes reports, verified work and uncertain responses', () => {
  expect(automaticResult(initial, response('working')).state).toBe('working')
  expect(automaticResult(initial, response('reported')).state).toBe('returned')
  expect(automaticResult(initial, response('verified')).state).toBe('verified')
  expect(automaticResult(initial, response('unknown')).state).toBe('unknown')
  expect(automaticResult(initial, { ...response('verified'), error: 'dispatch failed' }).state).toBe('unknown')
  expect(automaticResult(initial, { ...response('reported'), error: 'verification_failed' })).toMatchObject({ state: 'failed', reason: 'verification_failed' })
  expect(automaticResult({ ...initial, id: ID }, { run: { ...response('working').run, id: '22222222-2222-4222-a222-222222222222' } }).state).toBe('unknown')
  expect(automaticResult(initial, { mode: 'direct', reason: 'model_unknown' }).state).toBe('direct')
  const run = automaticResult(initial, { ...response('reported'), handoff: 'x'.repeat(20000) })
  expect(run.report?.length).toBe(16384)
  expect(automaticSummary(run)).toContain('untrusted data')
})

test('main human turn persists ownership before engine start and duplicate turns do not dispatch again', async ($, on) => {
  const seen = wire(on)
  let acknowledged = false
  seen.runHook = async (argv, init) => {
    if (argv[1] !== 'mod-route') return undefined
    expect(seen.turnIds).toEqual([initial.turn])
    expect(init?.stdin).toBe(initial.task)
    expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ state: 'planning' })
    acknowledged = true
    return { exitCode: 0, stdout: JSON.stringify(response('working')), stderr: '' }
  }
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: initial.task, origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: initial.task, turnId: initial.turn })
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ state: 'planning' })
  await seen.clock.advance(1)
  await settle()
  expect(acknowledged).toBe(true)
  await $.prompt.submit({ text: initial.task, origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: initial.task, turnId: initial.turn })
  expect(seen.runs.filter(argv => argv[1] === 'mod-route')).toHaveLength(1)
})

test('internal prompts, slash commands and subagent turns never dispatch', async ($, on) => {
  const seen = wire(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  for (const [text, origin] of [['internal', { kind: 'plugin', name: 'harness' }], ['/harness', { kind: 'composer' }], ['', { kind: 'composer' }]] as const) {
    await $.prompt.submit({ text, origin } as never)
    await $.turn.start({ text, turnId: text })
  }
  await $.prompt.submit({ text: 'child', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'child', turnId: 'child', agentId: 'worker' } as never)
  expect(seen.runs.some(argv => argv[1] === 'mod-route')).toBe(false)
  seen.runHook = async argv => argv[1] === 'mod-route' ? { exitCode: 0, stdout: JSON.stringify(response('working')), stderr: '' } : undefined
  await $.prompt.submit({ text: 'human after child', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'human after child', turnId: 'after-child' })
  await seen.clock.advance(1)
  await settle()
  expect(seen.runs.filter(argv => argv[1] === 'mod-route')).toHaveLength(1)
})

test('identical internal and human prompts retain their submission order', async ($, on) => {
  const seen = wire(on)
  seen.runHook = async argv => argv[1] === 'mod-route' ? { exitCode: 0, stdout: JSON.stringify(response('working')), stderr: '' } : undefined
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: initial.task, origin: { kind: 'plugin', name: 'harness' } } as never)
  await $.prompt.submit({ text: initial.task, origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: initial.task, turnId: 'internal' })
  await seen.clock.advance(1)
  await settle()
  expect(seen.runs.some(argv => argv[1] === 'mod-route')).toBe(false)
  await $.turn.start({ text: initial.task, turnId: 'human' })
  await seen.clock.advance(1)
  await settle()
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ turn: 'human', state: 'working' })
});

test('native plan mode keeps implementation with the advisor and bypass mode still delegates', async ($, on) => {
  const seen = wire(on)
  seen.runHook = async argv => argv[1] === 'mod-route' ? { exitCode: 0, stdout: JSON.stringify(response('working')), stderr: '' } : undefined
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: false })
  await $.classic.SessionStart({ permission_mode: 'plan' } as never)
  await $.prompt.submit({ text: initial.task, origin: { kind: 'composer' } } as never)
  await $.classic.UserPromptSubmit({ permission_mode: 'plan' } as never)
  await $.turn.start({ text: initial.task, turnId: 'planning-only' })
  await seen.clock.advance(1)
  await settle()
  expect(seen.runs.some(argv => argv[1] === 'mod-route')).toBe(false)
  await $.prompt.submit({ text: initial.task, origin: { kind: 'composer' } } as never)
  await $.classic.UserPromptSubmit({ permission_mode: 'bypassPermissions' } as never)
  await $.turn.start({ text: initial.task, turnId: 'execution' })
  await seen.clock.advance(1)
  await settle()
  expect(seen.runs.filter(argv => argv[1] === 'mod-route')).toHaveLength(1)
});

test('entering plan mode before scheduled dispatch prevents the writing launch', async ($, on) => {
  const seen = wire(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: false })
  await $.prompt.submit({ text: initial.task, origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: initial.task, turnId: 'queued-before-plan' })
  await $.classic.UserPromptSubmit({ permission_mode: 'plan' } as never)
  await seen.clock.advance(1)
  await settle()
  expect(seen.runs.some(argv => argv[1] === 'mod-route')).toBe(false)
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ state: 'direct', reason: 'plan_mode' })
});

test('a completed old collection cannot overwrite a new human task', async ($, on) => {
  const seen = wire(on, { store: { 'harness:auto:sess-1:current': { ...initial, id: ID, state: 'verified' } } })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  seen.runHook = async argv => {
    if (argv[1] === 'mod-status') {
      await held
      return { exitCode: 0, stdout: JSON.stringify(response('verified')), stderr: '' }
    }
    return argv[1] === 'mod-route' ? { exitCode: 0, stdout: JSON.stringify(response('working')), stderr: '' } : undefined
  }
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await seen.clock.advance(5000)
  await seen.clock.advance(1)
  await settle()
  await $.prompt.submit({ text: 'next task', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'next task', turnId: 'new-human' })
  await seen.clock.advance(1)
  await settle()
  release()
  await settle()
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ turn: 'new-human', state: 'working' })
});

test('an accepted consult cannot be overwritten by an earlier status response', async ($, on) => {
  const seen = wire(on, { store: { 'harness:auto:sess-1:current': { ...initial, id: ID, state: 'unknown' } } })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let acceptedInput = ''
  seen.runHook = async (argv, init) => {
    if (argv[1] === 'mod-status') {
      await held
      return { exitCode: 0, stdout: JSON.stringify({ mode: 'consult', id: ID }), stderr: '' }
    }
    if (argv[1] === 'mod-route') acceptedInput = init?.stdin ?? ''
    return argv[1] === 'mod-route' ? { exitCode: 0, stdout: JSON.stringify(response('working')), stderr: '' } : undefined
  }
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: false })
  await $.tool.call({ tool: 'mcp__harness__harness_collect', tool_use_id: 'held-status' } as never)
  await seen.clock.advance(1)
  await settle()
  await $.session.end({ reason: 'exit', sessionId: 'sess-1' } as never)
  seen.saved.set('harness:auto:sess-1:current', { ...initial, id: ID, state: 'consult_ready', consultReport: 'Recommendation' })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: false })
  await $.tool.call({ tool: 'mcp__harness__harness_delegate', tool_use_id: 'accept-during-status' } as never)
  release()
  await settle()
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ state: 'planning', consultReviewed: true })
  await seen.clock.advance(1)
  await settle()
  expect(seen.runs.filter(argv => argv[1] === 'mod-route')).toHaveLength(1)
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ state: 'working', consultReviewed: true })
  const dispatched = seen.runs.find(argv => argv[1] === 'mod-route')!
  expect(dispatched).toContain('--request-json-stdin')
  expect(dispatched).not.toContain('Recommendation')
  expect(JSON.parse(acceptedInput)).toEqual({ task: initial.task, consultReport: 'Recommendation' })
  expect(seen.spawns).toHaveLength(0)
});

test('an existing manual plan waits while automatic implementation is active', async ($, on) => {
  const seen = wire(on)
  seen.runHook = async argv => argv[1] === 'mod-route' ? { exitCode: 0, stdout: JSON.stringify(response('working')), stderr: '' } : undefined
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: false })
  await makePlan($, { objective: 'Manual parser', tasks: [{ title: 'Implement parser' }] })
  await $.session.end({ reason: 'exit', sessionId: 'sess-1' } as never)
  seen.saved.set('harness:auto:sess-1:current', { ...initial, id: ID, state: 'working' })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: false })
  const before = seen.spawns.length
  const result = await $.tool.call({ tool: 'mcp__harness__harness_run', tool_use_id: 'manual-run' } as never)
  expect(String(result.result)).toContain('Automatic delegation working')
  expect(seen.spawns).toHaveLength(before)
});

test('manual UI run and rerun respect automatic ownership', { options: { autoRun: false } }, async ($, on) => {
  const seen = wire(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: false })
  await makePlan($, { objective: 'Manual parser', tasks: [{ title: 'Implement parser' }] })
  const id = planState(seen)!.tasks[0]!.id
  await runTask($, id)
  await finish($, planState(seen)!.tasks[0]!.agentId!, 'Manual worker failed', 'error')
  await $.session.end({ reason: 'exit', sessionId: 'sess-1' } as never)
  seen.saved.set('harness:auto:sess-1:current', { ...initial, id: ID, state: 'working' })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: false })
  const before = seen.spawns.length
  const pane = await $.ui.mount({ plugin: 'harness', surface: 'terminal', component: 'Pane', requestId: 'harness', props: PANE_PROPS })
  await pane.press({ key: 'run-ready' })
  await pane.press({ key: `fold-${id}` })
  await pane.press({ key: `rerun-${id}` })
  expect(seen.spawns).toHaveLength(before)
  expect(seen.toasts.filter(text => text.includes('Automatic delegation working'))).toHaveLength(2)
  await pane.unmount()
});

test('a Claude consult may specify its model without an optional cliModel', async ($, on) => {
  const seen = wire(on)
  seen.runHook = async argv => argv[1] === 'mod-route'
    ? { exitCode: 0, stdout: JSON.stringify({ mode: 'consult', id: ID, target: { client: 'claude', model: 'claude-fable-5-1', effort: 'xhigh' } }), stderr: '' } : undefined
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: initial.task, origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: initial.task, turnId: initial.turn })
  await seen.clock.advance(1)
  await settle()
  expect(seen.spawns).toHaveLength(1)
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ state: 'consulting', consultAgent: 'agent-1' })
});

for (const rejected of ['register', 'spawn']) test(`a rejected consult ${rejected} fails visibly without stranding the queue`, async ($, on) => {
  const seen = wire(on)
  if (rejected === 'register') seen.failRegister = true
  else seen.denySpawn = ['harness:consultant']
  seen.runHook = async argv => argv[1] === 'mod-route'
    ? { exitCode: 0, stdout: JSON.stringify({ mode: 'consult', id: ID, target: { client: 'claude', model: 'claude-fable-5-1' } }), stderr: '' } : undefined
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: initial.task, origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: initial.task, turnId: initial.turn })
  await seen.clock.advance(1)
  await settle()
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ state: 'failed', reason: 'consult_launch_rejected' })
  expect(seen.submitted.some(text => text.includes('consult_launch_rejected'))).toBe(true)
  seen.failRegister = false
  seen.denySpawn = []
  seen.runHook = async argv => argv[1] === 'mod-route' ? { exitCode: 0, stdout: JSON.stringify(response('working')), stderr: '' } : undefined
  await $.prompt.submit({ text: 'Implement next parser', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'Implement next parser', turnId: 'next-turn' })
  await seen.clock.advance(1)
  await settle()
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ state: 'working', turn: 'next-turn' })
});

test('an uncertain consult spawn remains fenced during recovery', async ($, on) => {
  const seen = wire(on)
  seen.throwSpawn = 'transport lost'
  seen.runHook = async argv => ['mod-route', 'mod-status'].includes(argv[1]!)
    ? { exitCode: 0, stdout: JSON.stringify({ mode: 'consult', id: ID, target: { client: 'claude', model: 'claude-fable-5-1' } }), stderr: '' } : undefined
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: initial.task, origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: initial.task, turnId: initial.turn })
  await seen.clock.advance(1)
  await settle()
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ state: 'unknown', reason: 'consult_dispatch_unconfirmed' })
  const before = seen.spawns.length
  await $.tool.call({ tool: 'mcp__harness__harness_collect', tool_use_id: 'uncertain-consult' } as never)
  await seen.clock.advance(1)
  await settle()
  expect(seen.spawns).toHaveLength(before)
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ state: 'unknown', reason: 'consult_requires_reconciliation' })
});

test('a failed consult reports its failure without requesting an acceptance', async ($, on) => {
  const seen = wire(on)
  seen.runHook = async argv => argv[1] === 'mod-route'
    ? { exitCode: 0, stdout: JSON.stringify({ mode: 'consult', id: ID, target: { client: 'claude', model: 'claude-fable-5-1', effort: 'xhigh' } }), stderr: '' } : undefined
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: false })
  await $.prompt.submit({ text: initial.task, origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: initial.task, turnId: initial.turn })
  await seen.clock.advance(1)
  await settle()
  await finish($, 'agent-1', 'Consult interrupted', 'aborted')
  await settle()
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ state: 'failed', reason: 'consult_failed' })
  expect(seen.submitted.some(text => text.includes('consult_failed'))).toBe(true)
  expect(seen.submitted.some(text => text.includes('harness_delegate'))).toBe(false)
});

test('a lost route response recovers the recorded consult before any consult launch', async ($, on) => {
  const seen = wire(on)
  seen.runHook = async argv => argv[1] === 'mod-route'
    ? { exitCode: 1, stdout: '', stderr: 'lost response' }
    : argv[1] === 'mod-status' ? { exitCode: 0, stdout: JSON.stringify({ mode: 'consult', id: ID, target: { client: 'claude', cliModel: 'claude-fable-5-1', effort: 'xhigh' } }), stderr: '' } : undefined
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: initial.task, origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: initial.task, turnId: initial.turn })
  await seen.clock.advance(1)
  await settle()
  expect(seen.spawns).toHaveLength(1)
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ state: 'consulting', consultAgent: 'agent-1' })
});

test('recovery launches a recorded consult only when its native launch has not been claimed', async ($, on) => {
  const seen = wire(on, { store: { 'harness:auto:sess-1:current': { ...initial, id: ID, state: 'consulting' } } })
  seen.runHook = async argv => argv[1] === 'mod-status'
    ? { exitCode: 0, stdout: JSON.stringify({ mode: 'consult', id: ID, target: { client: 'claude', model: 'claude-fable-5-1', effort: 'xhigh' } }), stderr: '' } : undefined
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await seen.clock.advance(5000)
  await seen.clock.advance(1)
  await settle()
  expect(seen.spawns).toHaveLength(1)
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ state: 'consulting', consultLaunchAttempted: true, consultAgent: 'agent-1' })
});

test('an uncertain claimed consult never starts a replacement consultant during recovery', async ($, on) => {
  const seen = wire(on, { store: { 'harness:auto:sess-1:current': { ...initial, id: ID, state: 'unknown', consultLaunchAttempted: true } } })
  seen.runHook = async argv => argv[1] === 'mod-status'
    ? { exitCode: 0, stdout: JSON.stringify({ mode: 'consult', id: ID, target: { client: 'claude', model: 'claude-fable-5-1', effort: 'xhigh' } }), stderr: '' } : undefined
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await seen.clock.advance(5000)
  await seen.clock.advance(1)
  await settle()
  expect(seen.spawns).toHaveLength(0)
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ state: 'unknown', reason: 'consult_requires_reconciliation' })
});

test('verification cancelled before its timer persists and resumes with the same session', async ($, on) => {
  const seen = wire(on, { store: { 'harness:auto:sess-1:current': { ...initial, id: ID, state: 'returned' } } })
  seen.runHook = async argv => argv[1] === 'mod-collect'
    ? { exitCode: 0, stdout: JSON.stringify(response('verified')), stderr: '' } : undefined
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: false })
  await $.tool.call({ tool: 'mcp__harness__harness_collect', verify: true, tool_use_id: 'persist-verify' } as never)
  await $.session.end({ reason: 'exit', sessionId: 'sess-1' } as never)
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ verifyRequested: true })
  expect(seen.runs.some(argv => argv[1] === 'mod-collect')).toBe(false)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: false })
  await seen.clock.advance(1)
  await settle()
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ state: 'verified', verifyRequested: false })
  expect(seen.runs.filter(argv => argv[1] === 'mod-collect')).toHaveLength(1)
});

test('restoring an interrupted verification observes until a fresh explicit reconciliation', async ($, on) => {
  const seen = wire(on, { store: { 'harness:auto:sess-1:current': {
    ...initial, id: ID, state: 'verifying', verifyRequested: true, verificationAttempted: true,
  } } })
  seen.runHook = async argv => ['mod-status', 'mod-collect'].includes(argv[1] ?? '')
    ? { exitCode: 0, stdout: JSON.stringify(response(argv.includes('--wait') ? 'verified' : 'reported')), stderr: '' } : undefined
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await seen.clock.advance(5000)
  await settle()
  await seen.clock.advance(5000)
  await settle()
  await seen.clock.advance(1)
  await settle()
  expect(seen.runs.some(argv => argv[1] === 'mod-collect' && argv.includes('--wait'))).toBe(false)
  await $.tool.call({ tool: 'mcp__harness__harness_collect', verify: true, tool_use_id: 'reconcile-interrupted' } as never)
  await seen.clock.advance(1)
  await settle()
  expect(seen.runs.filter(argv => argv[1] === 'mod-collect' && argv.includes('--wait'))).toHaveLength(1)
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ state: 'verified', verifyRequested: false })
})

test('plan mode observes a queued implementation and permits recovery after leaving plan mode', async ($, on) => {
  const seen = wire(on, { store: { 'harness:auto:sess-1:current': { ...initial, id: ID, state: 'unknown' } } })
  seen.runHook = async argv => argv[1] === 'mod-status'
    ? { exitCode: 0, stdout: JSON.stringify(response('queued')), stderr: '' }
    : argv[1] === 'mod-collect' ? { exitCode: 0, stdout: JSON.stringify(response('working')), stderr: '' } : undefined
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: false })
  await $.classic.UserPromptSubmit({ permission_mode: 'plan' } as never)
  await $.tool.call({ tool: 'mcp__harness__harness_collect', verify: true, tool_use_id: 'plan-recovery' } as never)
  await seen.clock.advance(1)
  await settle()
  expect(seen.runs.some(argv => argv[1] === 'mod-status')).toBe(true)
  expect(seen.runs.some(argv => argv[1] === 'mod-collect')).toBe(false)
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ state: 'unknown' })
  await $.classic.UserPromptSubmit({ permission_mode: 'bypassPermissions' } as never)
  await $.tool.call({ tool: 'mcp__harness__harness_collect', verify: true, tool_use_id: 'bypass-recovery' } as never)
  await seen.clock.advance(1)
  await settle()
  expect(seen.runs.filter(argv => argv[1] === 'mod-collect' && argv.includes('--wait'))).toHaveLength(1)
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ state: 'working' })
});

test('plan mode prevents ordinary collection from submitting a pending implementation prompt', async ($, on) => {
  const seen = wire(on, { store: { 'harness:auto:sess-1:current': { ...initial, id: ID, state: 'working' } } })
  seen.runHook = async argv => argv[1] === 'mod-collect'
    ? { exitCode: 0, stdout: JSON.stringify(response('working')), stderr: '' } : undefined
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: false })
  await $.classic.UserPromptSubmit({ permission_mode: 'plan' } as never)
  await $.tool.call({ tool: 'mcp__harness__harness_collect', tool_use_id: 'plan-pending-prompt' } as never)
  await seen.clock.advance(1)
  await settle()
  expect(seen.runs.some(argv => argv[1] === 'mod-collect')).toBe(false)
  await $.classic.UserPromptSubmit({ permission_mode: 'bypassPermissions' } as never)
  await $.tool.call({ tool: 'mcp__harness__harness_collect', tool_use_id: 'bypass-pending-prompt' } as never)
  await seen.clock.advance(1)
  await settle()
  expect(seen.runs.filter(argv => argv[1] === 'mod-collect')).toHaveLength(1)
});

test('explicit reconciliation resumes a recorded queued implementation and retains its later verification', async ($, on) => {
  const seen = wire(on, { store: { 'harness:auto:sess-1:current': { ...initial, id: ID, state: 'unknown' } } })
  seen.runHook = async argv => argv[1] === 'mod-status'
    ? { exitCode: 0, stdout: JSON.stringify(response('queued')), stderr: '' }
    : argv[1] === 'mod-collect' ? { exitCode: 0, stdout: JSON.stringify(response('working')), stderr: '' } : undefined
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: false })
  await $.tool.call({ tool: 'mcp__harness__harness_collect', verify: true, tool_use_id: 'resume-queued' } as never)
  await seen.clock.advance(1)
  await settle()
  expect(seen.runs.filter(argv => argv[1] === 'mod-collect' && argv.includes('--wait'))).toHaveLength(1)
  expect(seen.runs.some(argv => argv[1] === 'mod-route')).toBe(false)
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ state: 'working', verificationAttempted: false, verifyRequested: true })
})

test('declining a completed consult releases the next queued request', async ($, on) => {
  const seen = wire(on, { store: { 'harness:auto:sess-1:current': { ...initial, id: ID, state: 'consult_ready', consultReport: 'Recommendation' } } })
  seen.runHook = async argv => argv[1] === 'mod-route' ? { exitCode: 0, stdout: JSON.stringify({ mode: 'direct', reason: 'simple_work' }), stderr: '' } : undefined
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: false })
  await $.prompt.submit({ text: 'next task', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'next task', turnId: 'next-task' })
  await $.tool.call({ tool: 'mcp__harness__harness_delegate', accept: false, tool_use_id: 'decline-consult' } as never)
  await seen.clock.advance(1)
  await settle()
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ turn: 'next-task', state: 'direct' })
  expect(seen.spawns).toHaveLength(0)
});

test('losing an accepted consult dispatch response never launches the consultant again', async ($, on) => {
  const seen = wire(on, { store: { 'harness:auto:sess-1:current': { ...initial, id: ID, state: 'consult_ready', consultReport: 'Recommendation' } } })
  seen.runHook = async argv => {
    if (argv[1] === 'mod-route') return { exitCode: 1, stdout: '', stderr: 'lost response' }
    if (argv[1] === 'mod-status') {
      expect(argv).toContain('--consult-reviewed')
      return { exitCode: 0, stdout: JSON.stringify({ id: ID, mode: 'unknown', recorded: true, runMissing: true }), stderr: '' }
    }
    return undefined
  }
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: false })
  await $.tool.call({ tool: 'mcp__harness__harness_delegate', tool_use_id: 'accept-consult' } as never)
  await seen.clock.advance(1)
  await settle()
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ state: 'unknown', consultReviewed: true })
  expect(seen.spawns).toHaveLength(0)
});

test('accepting a consult persists before its dispatch timer and survives session end', async ($, on) => {
  const seen = wire(on, { store: { 'harness:auto:sess-1:current': { ...initial, id: ID, state: 'consult_ready', consultReport: 'Recommendation' } } })
  seen.runHook = async argv => {
    if (argv[1] === 'mod-collect') return { exitCode: 0, stdout: JSON.stringify(response('working')), stderr: '' }
    if (argv[1] === 'mod-route') {
      expect(argv).toContain('--consult-reviewed')
      return { exitCode: 0, stdout: JSON.stringify(response('working')), stderr: '' }
    }
    if (argv[1] === 'mod-status') {
      expect(argv).toContain('--consult-reviewed')
      return { exitCode: 0, stdout: JSON.stringify({ id: ID, mode: 'unknown', recorded: true, runMissing: true }), stderr: '' }
    }
    return undefined
  }
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: false })
  await $.tool.call({ tool: 'mcp__harness__harness_delegate', tool_use_id: 'accept-before-exit' } as never)
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ state: 'planning', consultReviewed: true })
  await $.session.end({ reason: 'exit', sessionId: 'sess-1' } as never)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: false })
  await $.tool.call({ tool: 'mcp__harness__harness_collect', tool_use_id: 'recover-accepted-consult' } as never)
  await seen.clock.advance(1)
  await settle()
  expect(seen.runs.filter(argv => argv[1] === 'mod-route')).toHaveLength(1)
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ state: 'working', consultReviewed: true })
  expect(seen.spawns).toHaveLength(0)
});

test('a headless verification request during planning runs after the pending dispatch', async ($, on) => {
  const seen = wire(on, { store: { 'harness:auto:sess-1:current': { ...initial, reason: 'dispatch_pending' } } })
  seen.runHook = async argv => {
    if (argv[1] === 'mod-route') return { exitCode: 0, stdout: JSON.stringify(response('reported')), stderr: '' }
    if (argv[1] === 'mod-collect') {
      expect(argv).toContain('--wait')
      return { exitCode: 0, stdout: JSON.stringify(response('verified')), stderr: '' }
    }
    return undefined
  }
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: false })
  await $.tool.call({ tool: 'mcp__harness__harness_collect', verify: true, tool_use_id: 'verify-before-dispatch' } as never)
  for (let i = 0; i < 3; i++) { await seen.clock.advance(1); await settle() }
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ state: 'verified' })
  expect(seen.runs.filter(argv => argv[1] === 'mod-route')).toHaveLength(1)
  expect(seen.runs.filter(argv => argv[1] === 'mod-collect')).toHaveLength(1)
});

test('explicit verification collects the run ID recovered in the same headless call', async ($, on) => {
  const seen = wire(on, { store: { 'harness:auto:sess-1:current': { ...initial, state: 'unknown', reason: 'dispatch_requires_reconciliation' } } })
  seen.runHook = async argv => {
    if (argv[1] === 'mod-status') return { exitCode: 0, stdout: JSON.stringify(response('reported')), stderr: '' }
    if (argv[1] === 'mod-collect') {
      expect(argv).toContain(ID)
      expect(argv).toContain('--wait')
      return { exitCode: 0, stdout: JSON.stringify(response('verified')), stderr: '' }
    }
    return undefined
  }
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: false })
  await $.tool.call({ tool: 'mcp__harness__harness_collect', verify: true, tool_use_id: 'recover-and-verify' } as never)
  await seen.clock.advance(1)
  await settle()
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ id: ID, state: 'verified' })
  expect(seen.runs.filter(argv => argv[1] === 'mod-collect')).toHaveLength(1)
  expect(seen.spawns).toHaveLength(0)
});

test('a consultant completing before spawn returns still delivers its recommendation', async ($, on) => {
  let completed = Promise.resolve()
  const seen = wire(on)
  seen.spawnHook = async agentId => { completed = finish($, agentId, 'Read-only recommendation'); await settle() }
  seen.runHook = async argv => argv[1] === 'mod-route'
    ? { exitCode: 0, stdout: JSON.stringify({ mode: 'consult', id: ID, target: { client: 'claude', model: 'claude-fable-5-1', effort: 'xhigh' } }), stderr: '' } : undefined
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: false })
  await $.prompt.submit({ text: initial.task, origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: initial.task, turnId: initial.turn })
  await seen.clock.advance(1)
  await settle()
  await completed
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ state: 'consult_ready', consultAgent: 'agent-1', consultReport: 'Read-only recommendation' })
});

test('a clear during dispatch does not drop the next session first task', async ($, on) => {
  const seen = wire(on)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  seen.runHook = async argv => {
    if (argv[1] !== 'mod-route') return undefined
    if (++calls === 1) await held
    return { exitCode: 0, stdout: JSON.stringify(response('working')), stderr: '' }
  }
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: false })
  await $.prompt.submit({ text: initial.task, origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: initial.task, turnId: initial.turn })
  await seen.clock.advance(1)
  await settle()
  await $.session.end({ reason: 'clear', sessionId: 'sess-1' } as never)
  seen.sessionId = 'new-session'
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: false })
  await $.prompt.submit({ text: 'new task', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'new task', turnId: 'new-turn' })
  await seen.clock.advance(1)
  await settle()
  release()
  await settle()
  expect(seen.saved.get('harness:auto:new-session:current')).toMatchObject({ turn: 'new-turn', state: 'working' })
  expect(seen.runs.filter(argv => argv[1] === 'mod-route')).toHaveLength(2)
});

test('explicit collection while working does not consume the later verification attempt', async ($, on) => {
  const seen = wire(on, { store: { 'harness:auto:sess-1:current': { ...initial, id: ID, state: 'working' } } })
  let calls = 0
  seen.runHook = async argv => argv[1] === 'mod-collect'
    ? { exitCode: 0, stdout: JSON.stringify(response(++calls === 1 ? 'working' : calls === 2 ? 'reported' : 'verified')), stderr: '' } : undefined
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: false })
  await $.tool.call({ tool: 'mcp__harness__harness_collect', verify: true, tool_use_id: 'early-collect' } as never)
  await seen.clock.advance(1)
  await settle()
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ state: 'working' })
  await $.tool.call({ tool: 'mcp__harness__harness_collect', verify: true, tool_use_id: 'finish-collect' } as never)
  await seen.clock.advance(1)
  await settle()
  expect(calls).toBe(3)
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ state: 'verified' })
});

test('automatic delegation disabled preserves ordinary tool execution', { options: { autoDelegate: false } }, async ($, on) => {
  const seen = wire(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: initial.task, origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: initial.task, turnId: initial.turn })
  expect(seen.runs.some(argv => argv[1] === 'mod-route')).toBe(false)
  expect(await $.tool.call({ tool: 'Bash', command: 'pwd', tool_use_id: 'ordinary' })).toMatchObject({ result: 'ok' })
})

test('a finished collection command failure gets one automatic verification retry without dispatch', async ($, on) => {
  const seen = wire(on, { store: { 'harness:auto:sess-1:current': { ...initial, id: ID, state: 'returned' } } })
  let attempts = 0
  seen.runHook = async argv => argv[1] === 'mod-status'
    ? { exitCode: 0, stdout: JSON.stringify(response('reported')), stderr: '' }
    : argv[1] === 'mod-collect' ? ++attempts === 1
      ? { exitCode: 1, stdout: '', stderr: 'transient command failure' }
      : { exitCode: 0, stdout: JSON.stringify(response('verified')), stderr: '' } : undefined
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 3; i++) {
    await seen.clock.advance(5000)
    await seen.clock.advance(1)
    await settle()
  }
  expect(attempts).toBe(2)
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ state: 'verified', verificationRetried: true })
  expect(seen.runs.some(argv => argv[1] === 'mod-route')).toBe(false)
});

test('uncertain dispatch recovers persistent status and never resubmits', async ($, on) => {
  const seen = wire(on)
  seen.runHook = async argv => argv[1] === 'mod-route'
    ? { exitCode: 1, stdout: '', stderr: 'timeout' }
    : argv[1] === 'mod-status' ? { exitCode: 0, stdout: JSON.stringify(response('unknown')), stderr: '' } : undefined
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: initial.task, origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: initial.task, turnId: initial.turn })
  await seen.clock.advance(1)
  await settle()
  await $.prompt.submit({ text: 'another task', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'another task', turnId: 'next' })
  expect(seen.runs.filter(argv => argv[1] === 'mod-route')).toHaveLength(1)
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ id: ID, state: 'unknown' })
})

test('an absent restored dispatch retains its queue while the original command can still complete', async ($, on) => {
  const seen = wire(on, { store: { 'harness:auto:sess-1:current': { ...initial, state: 'planning', queuedAt: 800000 } } })
  seen.runHook = async argv => argv[1] === 'mod-status'
    ? { exitCode: 0, stdout: JSON.stringify({ mode: 'unknown', recorded: false }), stderr: '' } : undefined
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await seen.clock.advance(5000)
  await settle()
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ state: 'planning' })
  await $.prompt.submit({ text: 'another task', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'another task', turnId: 'queued-after-restore' })
  await seen.clock.advance(1)
  await settle()
  expect(seen.runs.some(argv => argv[1] === 'mod-route')).toBe(false)
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ pending: [expect.objectContaining({ turn: 'queued-after-restore' })] })
})

test('confirmed absent dispatch after its deadline releases later human turns', async ($, on) => {
  const seen = wire(on, { store: { 'harness:auto:sess-1:current': { ...initial, state: 'unknown', queuedAt: 700000 } } })
  seen.runHook = async argv => argv[1] === 'mod-status'
    ? { exitCode: 0, stdout: JSON.stringify({ mode: 'unknown', recorded: false }), stderr: '' }
    : argv[1] === 'mod-route' ? { exitCode: 0, stdout: JSON.stringify(response('working')), stderr: '' } : undefined
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await seen.clock.advance(5000)
  await seen.clock.advance(1)
  await settle()
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ state: 'failed', reason: 'dispatch_not_recorded' })
  await $.prompt.submit({ text: 'next task', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'next task', turnId: 'next-task' })
  await seen.clock.advance(1)
  await settle()
  expect(seen.runs.filter(argv => argv[1] === 'mod-route')).toHaveLength(1)
});

test('a recorded decision without a run expires safely before accepting another task', async ($, on) => {
  const seen = wire(on, { store: { 'harness:auto:sess-1:current': { ...initial, id: ID, state: 'unknown', queuedAt: 700000 } } })
  seen.runHook = async argv => argv[1] === 'mod-status'
    ? { exitCode: 0, stdout: JSON.stringify({ mode: 'unknown', id: ID, recorded: true, runMissing: true }), stderr: '' } : undefined
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await seen.clock.advance(5000)
  await seen.clock.advance(1)
  await settle()
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ state: 'failed', reason: 'dispatch_not_created' })
  expect(seen.runs.some(argv => argv[1] === 'mod-route')).toBe(false)
});

test('restored queued work dispatches with its captured repository and advisor model', async ($, on) => {
  const captured = { turn: 'queued-turn', task: 'Implement queued parser', cwd: '/original/queued/repo', model: 'claude-opus-5-5' }
  const seen = wire(on, { store: { 'harness:auto:sess-1:current': { ...initial, id: ID, state: 'working', pending: [captured] } } })
  seen.runHook = async argv => argv[1] === 'mod-collect' ? { exitCode: 0, stdout: JSON.stringify(response('verified')), stderr: '' }
    : argv[1] === 'mod-route' ? { exitCode: 0, stdout: JSON.stringify({ mode: 'direct', reason: 'simple_work' }), stderr: '' } : undefined
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: false })
  await $.tool.call({ tool: 'mcp__harness__harness_collect', tool_use_id: 'finish-active' } as never)
  await seen.clock.advance(1)
  await settle()
  await seen.clock.advance(1)
  await settle()
  const dispatched = seen.runs.find(argv => argv[1] === 'mod-route')!
  expect(dispatched[dispatched.indexOf('--cwd') + 1]).toBe(captured.cwd)
  expect(dispatched[dispatched.indexOf('--model') + 1]).toBe(captured.model)
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ ...captured, state: 'direct' })
});

for (const error of [undefined, 'verification_failed']) test(`a queued request advances after collection ${error ?? 'success'}`, async ($, on) => {
  const seen = wire(on, { store: { 'harness:auto:sess-1:current': { ...initial, id: ID, state: 'working' } } })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  seen.runHook = async argv => {
    if (argv[1] === 'mod-collect') { await held; return { exitCode: 0, stdout: JSON.stringify({ ...response(error ? 'reported' : 'verified'), ...(error ? { error } : {}) }), stderr: '' } }
    return argv[1] === 'mod-route' ? { exitCode: 0, stdout: JSON.stringify({ mode: 'direct', reason: 'simple_work' }), stderr: '' } : undefined
  }
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await seen.clock.advance(5000)
  await seen.clock.advance(1)
  await settle()
  await $.prompt.submit({ text: 'next task', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'next task', turnId: 'next-task' })
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ turn: initial.turn, pending: [{ turn: 'next-task', task: 'next task', cwd: CWD, model: initial.model }] })
  expect(seen.runs.some(argv => argv[1] === 'mod-route')).toBe(false)
  release()
  await settle()
  await seen.clock.advance(1)
  await settle()
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ turn: 'next-task', state: 'direct', pending: [] })
  if (error) expect(seen.submitted.some(text => text.includes(ID) && text.includes('failed') && text.includes('run-status'))).toBe(true)
  expect(seen.runs.filter(argv => argv[1] === 'mod-route')).toHaveLength(1)
  await seen.clock.advance(10000)
  await settle()
  expect(seen.runs.filter(argv => argv[1] === 'mod-collect')).toHaveLength(1)
});

test('restored task belongs to its session and timer collects without spawning', async ($, on) => {
  const seen = wire(on, { session: 'restored', store: {
    'harness:auto:other:current': { ...initial, id: ID, state: 'working' },
    'harness:auto:restored:current': { ...initial, id: ID, state: 'working' },
  } })
  seen.runHook = async argv => argv[1] === 'mod-collect'
    ? { exitCode: 0, stdout: JSON.stringify(response('reported')), stderr: '' } : undefined
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await seen.clock.advance(5000)
  await seen.clock.advance(1)
  await settle()
  expect(seen.runs.some(argv => argv[1] === 'mod-collect' && argv[2] === ID)).toBe(true)
  expect(seen.runs.some(argv => argv[1] === 'mod-route')).toBe(false)
  expect(seen.saved.get('harness:auto:other:current')).toMatchObject({ state: 'working' })
  expect(seen.saved.get('harness:auto:restored:current')).toMatchObject({ state: 'returned' })
})

test('headless sessions restore state without a recurring collection timer', async ($, on) => {
  const seen = wire(on, { store: { 'harness:auto:sess-1:current': { ...initial, id: ID, state: 'working' } } })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: false })
  await seen.clock.advance(10000)
  await settle()
  expect(seen.runs.some(argv => argv[1] === 'mod-collect')).toBe(false)
})

test('clearing into a new session never restores the old session atom', async ($, on) => {
  const seen = wire(on, { store: { 'harness:auto:sess-1:current': { ...initial, id: ID, state: 'working' } } })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: false })
  await $.session.end({ reason: 'clear', sessionId: 'sess-1' } as never)
  seen.sessionId = 'new-session'
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: false })
  const status = await $.tool.call({ tool: 'mcp__harness__harness_status', tool_use_id: 'new-status' } as never)
  expect(status.result).toContain('No harness plan.')
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ state: 'working' })
});

test('verification requested during a headless collection runs after that collection', async ($, on) => {
  const seen = wire(on, { store: { 'harness:auto:sess-1:current': { ...initial, id: ID, state: 'working' } } })
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  seen.runHook = async argv => {
    if (argv[1] !== 'mod-collect') return undefined
    if (++calls === 1) await hold
    return { exitCode: 0, stdout: JSON.stringify(response(calls === 1 ? 'reported' : 'verified')), stderr: '' }
  }
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: false })
  await $.tool.call({ tool: 'mcp__harness__harness_collect', tool_use_id: 'poll' } as never)
  await seen.clock.advance(1)
  await settle()
  await $.tool.call({ tool: 'mcp__harness__harness_collect', verify: true, tool_use_id: 'pending-verify' } as never)
  release()
  await settle()
  await seen.clock.advance(1)
  await settle()
  expect(calls).toBe(2)
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ state: 'verified' })
});

test('manual collection schedules long verification outside the tool hook and deduplicates polling', async ($, on) => {
  const seen = wire(on, { store: { 'harness:auto:sess-1:current': { ...initial, id: ID, state: 'returned' } } })
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  seen.runHook = async argv => {
    if (argv[1] !== 'mod-collect') return undefined
    await hold
    return { exitCode: 0, stdout: JSON.stringify(response('verified')), stderr: '' }
  }
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: false })
  const out = await $.tool.call({ tool: 'mcp__harness__harness_collect', verify: true, tool_use_id: 'collect' } as never)
  expect(out.result).toContain('Collection scheduled')
  expect(out.result).toContain('returned')
  expect(seen.runs.some(argv => argv[1] === 'mod-collect')).toBe(false)
  await seen.clock.advance(1)
  await settle()
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ state: 'verifying' })
  await $.tool.call({ tool: 'mcp__harness__harness_collect', verify: true, tool_use_id: 'duplicate' } as never)
  expect(seen.runs.filter(argv => argv[1] === 'mod-collect')).toHaveLength(1)
  release()
  await settle()
  expect(seen.saved.get('harness:auto:sess-1:current')).toMatchObject({ state: 'verified' })
})
