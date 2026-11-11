import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { resetDelegation } from '../hooks/delegation'
import { finish, wire } from './support'

const opts = { options: { delegation: true, failover: true } }
const start = ($: Engine) => $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive: true })
const call = ($: Engine, tool: string, input: Record<string, unknown>) =>
  $.tool.call({ tool: `mcp__harness__${tool}`, tool_use_id: `t-${tool}`, ...input } as never)

function arrange(on: Parameters<typeof wire>[0], files: Record<string, string> = {}, locked: string[] = []) {
  resetDelegation()
  const seen = wire(on)
  mock.env(on, { HOME: '/home/user' })
  const store = new Map(Object.entries(files))
  on('fs.read', (_$, e) => ({ value: store.get((e as unknown as { path: string }).path) ?? '' }))
  const starts: string[][] = []
  seen.runHook = async argv => {
    if (argv[0] === 'sleep') {
      await new Promise(resolve => setTimeout(resolve, 20))
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    if (argv[1] === 'health' && argv[2] === 'check') return { exitCode: 0, stdout: JSON.stringify({ locked: locked.includes(String(argv[4])) }), stderr: '' }
    if (argv[1] === 'panes' && argv[2] === 'start') {
      starts.push([...argv])
      return { exitCode: 0, stdout: JSON.stringify({ status: 'started', eventsFile: '/ev/run.jsonl', host: 'background', paneId: null }), stderr: '' }
    }
    return undefined
  }
  return { seen, starts, store }
}

const flag = (argv: string[], name: string) => argv[argv.indexOf(name) + 1]
const delegate = async ($: Engine, task: string) => {
  const out = await call($, 'harness_delegate', { tasks: [{ task }] })
  return (JSON.parse(String(out.result)) as { runs: { runId: string }[] }).runs[0]!.runId
}

test('chain: a cheap task starts on codex luna with agy as the fallback inside worker-run', opts, async ($, on) => {
  const { starts } = arrange(on)
  await start($)
  await delegate($, 'Find where routes live')
  expect(flag(starts[0]!, '--cli')).toBe('codex')
  expect(starts[0]).toContain('--failover')
  expect(flag(starts[0]!, '--chain')).toBe('agy/gemini-flash')
})

test('chain: a locked codex is skipped and agy leads', opts, async ($, on) => {
  const { starts } = arrange(on, {}, ['codex/luna'])
  await start($)
  await delegate($, 'Find where routes live')
  expect(flag(starts[0]!, '--cli')).toBe('agy')
  expect(starts[0]).not.toContain('--chain')
})

test('chain: with every target locked the chain still goes to worker-run, which counts down', opts, async ($, on) => {
  const { starts } = arrange(on, {}, ['codex/luna', 'agy/gemini-flash', 'claude/haiku'])
  await start($)
  await delegate($, 'Find where routes live')
  expect(flag(starts[0]!, '--cli')).toBe('codex')
  expect(flag(starts[0]!, '--chain')).toBe('agy/gemini-flash')
})

test('chain: all external targets exhausted falls to the claude haiku subagent', opts, async ($, on) => {
  const { seen, store } = arrange(on)
  await start($)
  const id = await delegate($, 'Find where routes live')
  store.set('/ev/run.jsonl', `${JSON.stringify({ type: 'failover-end', code: 1, attempts: 3 })}\n${JSON.stringify({ type: 'exit', code: 1, outcome: 'failed', tail: 'quota' })}\n`)
  const waiting = call($, 'harness_wait', { runIds: [id] })
  for (let i = 0; i < 200 && seen.spawns.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 20))
  expect(seen.spawns).toHaveLength(1)
  expect(seen.spawns[0]!.subagentType).toBe('harness:haiku-low')
  await finish($, 'agent-1', 'found by haiku')
  const done = JSON.parse(String((await waiting).result)) as { results: { state: string; result: string }[] }
  expect(done.results[0]).toMatchObject({ state: 'done', result: 'found by haiku' })
})
test('chain: a request error never falls back', opts, async ($, on) => {
  const { seen, store } = arrange(on)
  await start($)
  const id = await delegate($, 'Find where routes live')
  store.set('/ev/run.jsonl', `${JSON.stringify({ type: 'failover-end', code: 1, request: true })}\n${JSON.stringify({ type: 'exit', code: 1, outcome: 'failed', tail: 'invalid_request_error' })}\n`)
  const waiting = call($, 'harness_wait', { runIds: [id] })
  await seen.clock.advance(2500)
  const done = JSON.parse(String((await waiting).result)) as { results: { state: string }[] }
  expect(done.results[0]!.state).toBe('failed')
  expect(seen.spawns).toHaveLength(0)
})

test('chain: a claude first step falls to codex when its turn fails', opts, async ($, on) => {
  const { seen, starts } = arrange(on)
  await start($)
  await delegate($, 'Fix the parser bug')
  expect(seen.spawns[0]!.subagentType).toBe('harness:sonnet-medium')
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'x', reason: 'error', agentId: 'agent-1' } as never)
  await seen.clock.advance(5)
  expect(flag(starts[0]!, '--cli')).toBe('codex')
  expect(flag(starts[0]!, '--model')).toBe('terra')
})

test('chain: models.local.yml chains override the defaults per class', opts, async ($, on) => {
  const { starts } = arrange(on, { '/home/user/.config/jev/models.local.yml': 'chains:\n  search: agy/flash, claude/haiku-high\n' })
  await start($)
  await delegate($, 'Find where routes live')
  expect(flag(starts[0]!, '--cli')).toBe('agy')
  expect(starts[0]).not.toContain('--chain')
})

test('chain: a refusal from a claude subagent does not fall back', opts, async ($, on) => {
  const { seen, starts } = arrange(on)
  await start($)
  await delegate($, 'Fix the parser bug')
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'x', reason: 'refusal', refusal: { category: null, explanation: null }, agentId: 'agent-1' } as never)
  await seen.clock.advance(5)
  expect(starts).toHaveLength(0)
})

test('chain: the 6 attempt cap is tracked across external and claude steps', opts, async ($, on) => {
  const { seen, starts, store } = arrange(on)
  await start($)
  const id = await delegate($, 'Find where routes live')
  expect(flag(starts[0]!, '--attempts-left')).toBe('6')
  store.set('/ev/run.jsonl', `${JSON.stringify({ type: 'failover-end', code: 1, attempts: 6 })}\n${JSON.stringify({ type: 'exit', code: 1, outcome: 'failed', tail: 'x' })}\n`)
  const waiting = call($, 'harness_wait', { runIds: [id] })
  await seen.clock.advance(2500)
  const done = JSON.parse(String((await waiting).result)) as { results: { state: string }[] }
  expect(done.results[0]!.state).toBe('failed')
  expect(seen.spawns).toHaveLength(0)
})

test('chain: attempts used by a claude step are passed on to the next external as attempts-left', opts, async ($, on) => {
  const { seen, starts } = arrange(on)
  await start($)
  await delegate($, 'Fix the parser bug')
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'x', reason: 'error', agentId: 'agent-1' } as never)
  await seen.clock.advance(5)
  expect(flag(starts[0]!, '--attempts-left')).toBe('5')
})
