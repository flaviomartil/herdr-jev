import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { resetFailover } from '../hooks/failover'
import { resetWait } from '../hooks/wait'
import { wire } from './support'

const OPUS = 'claude-opus-5-5'
const on_ = { options: { failover: true } }
const start = ($: Engine) => $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive: true })

type Reply = { answer: string; stopReason: string | null }
const empty: Reply = { answer: '', stopReason: null }
const fine: Reply = { answer: 'ok', stopReason: 'end_turn' }

function arrange(on: Parameters<typeof wire>[0], reply: (model: string) => Reply) {
  const seen = wire(on)
  mock.env(on, {})
  const models: string[] = []
  on('turn.step', async function* (_$, e) {
    models.push(e.model)
    const r = reply(e.model)
    return { turnId: e.turnId, index: e.index, answer: r.answer, toolUses: [], stopReason: r.stopReason, usage: null } as never
  })
  return { seen, models }
}

async function step($: Engine, turnId: string, model = OPUS): Promise<unknown> {
  const stream = $.turn.step({ turnId, index: 0, model } as never)
  for (;;) {
    const next = await stream.next()
    if (next.done) return next.value
  }
}

const fail = ($: Engine, turnId: string) =>
  $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId, reason: 'error' } as never)

type Complete = { isAnswered: boolean; status?: number | null }
function modelComplete(on: Parameters<typeof wire>[0], result: () => Complete) {
  const calls: string[] = []
  on('model.complete', (_$, e) => {
    calls.push(String((e as { model?: string }).model))
    const r = result()
    return { value: r.isAnswered
      ? { isAnswered: true, text: 'pong', usage: {} }
      : { isAnswered: false, reason: 'api-error', status: r.status ?? 429, error: {}, usage: {} } } as never
  })
  return calls
}

function health(seen: ReturnType<typeof wire>, answer: () => { locked: boolean; until?: number | null }) {
  seen.runHook = async argv => (argv[1] === 'health' && argv[2] === 'check' ? { exitCode: 0, stdout: JSON.stringify(answer()), stderr: '' } : argv[1] === 'health' ? { exitCode: 0, stdout: '{"ok":true}', stderr: '' } : undefined)
}

const say = async ($: Engine, args: string) => String(((await $.command.run({ command: 'harness', args } as never)) as { text?: string }).text)

test('failover: empty main step swaps once to the tier below and returns its answer', on_, async ($, on) => {
  resetWait()
  resetFailover()
  const { models } = arrange(on, model => (model === 'sonnet' ? fine : empty))
  await start($)
  const result = (await step($, 't1')) as { answer: string }
  expect(models).toEqual([OPUS, 'sonnet'])
  expect(result.answer).toBe('ok')
})

test('failover: one swap per turn, a second empty step is returned as is', on_, async ($, on) => {
  resetWait()
  resetFailover()
  const { models } = arrange(on, () => empty)
  await start($)
  await step($, 't1')
  expect(models).toEqual([OPUS, 'sonnet'])
  await step($, 't1')
  expect(models).toEqual([OPUS, 'sonnet', OPUS])
})

test('failover: flag off never swaps', async ($, on) => {
  resetWait()
  resetFailover()
  const { models } = arrange(on, () => empty)
  await start($)
  await step($, 't1')
  expect(models).toEqual([OPUS])
})

test('failover: diagnostic runs at most once per model in 5 minutes', on_, async ($, on) => {
  resetWait()
  resetFailover()
  const { seen } = arrange(on, () => empty)
  health(seen, () => ({ locked: false }))
  const calls = modelComplete(on, () => ({ isAnswered: true }))
  await start($)
  await step($, 't1')
  await fail($, 't1')
  await seen.clock.advance(1000)
  expect(calls).toHaveLength(1)
  await step($, 't2')
  await fail($, 't2')
  await seen.clock.advance(1000)
  expect(calls).toHaveLength(1)
  await seen.clock.advance(300_000)
  await step($, 't3')
  await fail($, 't3')
  await seen.clock.advance(1000)
  expect(calls).toHaveLength(2)
})

test('failover: diagnostic is skipped while a lockout is active, and the wait starts from its until', on_, async ($, on) => {
  resetWait()
  resetFailover()
  const { seen } = arrange(on, () => empty)
  health(seen, () => ({ locked: true, until: seen.clock.now() + 90_000 }))
  const calls = modelComplete(on, () => ({ isAnswered: true }))
  await start($)
  await step($, 't1')
  await fail($, 't1')
  await seen.clock.advance(10)
  expect(calls).toHaveLength(0)
  expect(await say($, 'wait')).toContain('back in')
})

test('failover: quota diagnosis enters a wait with a countdown that moves', on_, async ($, on) => {
  resetWait()
  resetFailover()
  const { seen } = arrange(on, () => empty)
  health(seen, () => ({ locked: false }))
  modelComplete(on, () => ({ isAnswered: false, status: 429 }))
  await start($)
  await step($, 't1')
  await fail($, 't1')
  await seen.clock.advance(5)
  expect(await say($, 'wait')).toBe('waiting: opus quota, next probe in 1m 00s')
  await seen.clock.advance(30_000)
  expect(await say($, 'wait')).toContain('30s')
  expect(seen.toasts.some(text => text.includes('Waiting for opus'))).toBe(true)
})

test('failover: release asks by default and does not send a prompt', on_, async ($, on) => {
  resetWait()
  resetFailover()
  const { seen } = arrange(on, () => empty)
  health(seen, () => ({ locked: true, until: seen.clock.now() + 60_000 }))
  await start($)
  await step($, 't1')
  await fail($, 't1')
  await seen.clock.advance(5)
  await seen.clock.advance(60_500)
  expect(seen.toasts.some(text => text.includes('opus is back. Send a message to continue'))).toBe(true)
  expect(seen.logs.some(text => text.includes('Continue the interrupted task?'))).toBe(true)
  expect(seen.submitted).toEqual([])
  expect(await say($, 'wait')).toBe('No wait is active.')
})

test('failover: autoResume sends the continue prompt on release', { options: { failover: true, autoResume: true } }, async ($, on) => {
  resetWait()
  resetFailover()
  const { seen } = arrange(on, () => empty)
  health(seen, () => ({ locked: true, until: seen.clock.now() + 60_000 }))
  await start($)
  await step($, 't1')
  await fail($, 't1')
  await seen.clock.advance(60_500)
  expect(seen.submitted).toHaveLength(1)
  expect(seen.submitted[0]).toContain('Continue the task')
})

test('failover: a user prompt cancels the wait and nothing fires later', on_, async ($, on) => {
  resetWait()
  resetFailover()
  const { seen } = arrange(on, () => empty)
  health(seen, () => ({ locked: true, until: seen.clock.now() + 60_000 }))
  await start($)
  await step($, 't1')
  await fail($, 't1')
  await seen.clock.advance(5)
  expect(await say($, 'wait')).toContain('back in')
  await $.prompt.submit({ text: 'let us do something else', origin: { kind: 'composer' } } as never)
  expect(seen.toasts.some(text => text.includes('Wait for opus cancelled'))).toBe(true)
  await seen.clock.advance(120_000)
  expect(seen.toasts.some(text => text.includes('is back'))).toBe(false)
  expect(await say($, 'wait')).toBe('No wait is active.')
})

test('failover: /harness wait cancel stops the wait', on_, async ($, on) => {
  resetWait()
  resetFailover()
  const { seen } = arrange(on, () => empty)
  health(seen, () => ({ locked: true, until: seen.clock.now() + 60_000 }))
  await start($)
  await step($, 't1')
  await fail($, 't1')
  await seen.clock.advance(5)
  expect(await say($, 'wait cancel')).toBe('Wait cancelled.')
  expect(await say($, 'wait cancel')).toBe('No wait is active.')
})

async function lockCase($: Engine, on: Parameters<typeof wire>[0], status: number, reason: string, ms: number) {
  resetWait()
  resetFailover()
  const { seen } = arrange(on, () => empty)
  health(seen, () => ({ locked: false }))
  modelComplete(on, () => ({ isAnswered: false, status }))
  await start($)
  await step($, 't1')
  const before = seen.clock.now()
  await fail($, 't1')
  await seen.clock.advance(5)
  const lock = seen.runs.find(argv => argv[1] === 'health' && argv[2] === 'lock')
  expect(lock?.[argv_index(lock, '--reason')]).toBe(reason)
  expect(Number(lock?.[argv_index(lock, '--until')])).toBeGreaterThanOrEqual(before + ms)
  expect(Number(lock?.[argv_index(lock, '--until')])).toBeLessThan(before + ms + 5000)
}

test('failover: a quota diagnosis locks for 30 minutes', on_, ($, on) => lockCase($, on, 429, 'quota', 1_800_000))

test('failover: an overload diagnosis locks for 5 minutes under its own reason', on_, ($, on) => lockCase($, on, 529, 'overload', 300_000))

function argv_index(argv: string[] | undefined, flag: string): number {
  return (argv ?? []).indexOf(flag) + 1
}

const cancel = ($: Engine) => say($, 'wait cancel')

test('failover: cancelling the wait clears the lockout', on_, async ($, on) => {
  resetWait()
  resetFailover()
  const { seen } = arrange(on, () => empty)
  health(seen, () => ({ locked: false }))
  modelComplete(on, () => ({ isAnswered: false, status: 429 }))
  await start($)
  await step($, 't1')
  await fail($, 't1')
  await seen.clock.advance(5)
  seen.runs.length = 0
  await cancel($)
  expect(seen.runs.some(argv => argv[1] === 'health' && argv[2] === 'clear' && argv.includes('claude/opus'))).toBe(true)
})
