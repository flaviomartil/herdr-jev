import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { resetDelegation, spawnWithTier } from '../hooks/delegation'
import { finish, wire } from './support'

const opts = { options: { delegation: true } }
const start = ($: Engine) => $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive: true })
const call = ($: Engine, tool: string, input: Record<string, unknown>) =>
  $.tool.call({ tool: `mcp__harness__${tool}`, tool_use_id: `t-${tool}`, ...input } as never)

function setup(on: Parameters<typeof wire>[0]) {
  resetDelegation()
  const seen = wire(on)
  mock.env(on, { HOME: '/home/user' })
  on('fs.read', () => ({ value: '' }))
  return seen
}

test('delegation: judge agent types are registered per model and effort pair', opts, async ($, on) => {
  const seen = setup(on)
  await start($)
  const names = seen.specs.map(s => `${s.name}:${s.effort}`)
  for (const wanted of ['haiku-low:low', 'haiku-high:high', 'sonnet-medium:medium', 'opus-high:high']) expect(names).toContain(wanted)
  expect(seen.registered).toContain('tool:harness_wait')
})

test('delegation: off by default registers nothing and leaves spawns alone', async ($, on) => {
  const seen = setup(on)
  await start($)
  expect(seen.specs.some(s => s.name === 'haiku-low')).toBe(false)
  await $.agent.spawn({ subagentType: 'general-purpose', model: 'opus', prompt: 'Implement the endpoint', description: 'implement' } as never)
  expect(seen.spawns[0]!.model).toBe('opus')
  expect(seen.spawns[0]!.prompt).not.toContain('Passo 0')
})

test('delegation: Agent tool with opus to implement goes out as sonnet with passo 0', opts, async ($, on) => {
  const seen = setup(on)
  await start($)
  await $.agent.spawn({ subagentType: 'general-purpose', model: 'opus', prompt: 'Implement the endpoint', description: 'implement endpoint' } as never)
  const out = seen.spawns[0]!
  expect(out.subagentType).toBe('harness:sonnet-medium')
  expect(out.model).toBe('claude-sonnet-5-5')
  expect(out.prompt.startsWith('Passo 0: localizar e seguir as skills que cobrem a tarefa; reportar quais usou.')).toBe(true)
})

test('delegation: a type with the wrong effort is rewritten to the matching type', opts, async ($, on) => {
  const seen = setup(on)
  await start($)
  await $.agent.spawn({ subagentType: 'harness:sonnet-high', prompt: 'Fix the parser bug', description: 'fix parser' } as never)
  expect(seen.spawns[0]!.subagentType).toBe('harness:sonnet-medium')
  await $.agent.spawn({ subagentType: 'harness:sonnet-medium', prompt: 'Review the diff', description: 'review diff' } as never)
  expect(seen.spawns[1]!.subagentType).toBe('harness:opus-high')
  await $.agent.spawn({ model: 'opus', prompt: 'Find where routes live', description: 'find routes' } as never)
  expect(seen.spawns[2]!.subagentType).toBe('harness:haiku-low')
})

test('delegation: a batch of 3 returns 3 runIds without waiting, and harness_wait returns 3 results', opts, async ($, on) => {
  const seen = setup(on)
  await start($)
  const out = await call($, 'harness_delegate', {
    tasks: [{ task: 'Find where routes live' }, { task: 'Fix the parser bug' }, { task: 'Review the diff' }],
  })
  const started = JSON.parse(String(out.result)) as { runs: { runId: string; state: string; model: string; effort: string }[] }
  expect(started.runs.map(r => r.runId)).toHaveLength(3)
  expect(started.runs.every(r => r.state === 'running')).toBe(true)
  expect(started.runs.map(r => `${r.model}:${r.effort}`)).toEqual(['claude-haiku-5-5:low', 'claude-sonnet-5-5:medium', 'claude-opus-5-5:high'])
  expect(seen.spawns).toHaveLength(3)
  expect(seen.spawns.every(s => s.prompt.startsWith('Passo 0:'))).toBe(true)
  const waiting = call($, 'harness_wait', { runIds: started.runs.map(r => r.runId) })
  await finish($, 'agent-1', 'found')
  await finish($, 'agent-2', 'fixed')
  await finish($, 'agent-3', 'approved')
  const done = JSON.parse(String((await waiting).result)) as { results: { state: string; result: string }[]; pending: string[] }
  expect(done.results.map(r => r.result)).toEqual(['found', 'fixed', 'approved'])
  expect(done.results.every(r => r.state === 'done')).toBe(true)
  expect(done.pending).toEqual([])
})

test('delegation: an external worker run is a recorded stub, not a started process', opts, async ($, on) => {
  const seen = setup(on)
  seen.runHook = async () => ({ exitCode: 0, stdout: '/bin/codex', stderr: '' })
  await start($)
  const out = await call($, 'harness_delegate', { tasks: [{ task: 'Find the config', prefer: 'codex' }] })
  const run = (JSON.parse(String(out.result)) as { runs: { runId: string; worker: string; stub?: boolean; state: string }[] }).runs[0]!
  expect([run.worker, run.stub, run.state]).toEqual(['codex', true, 'skipped'])
  expect(seen.spawns).toHaveLength(0)
})

test('delegation: the mod own spawn keeps the judge hints and is not reclassified', opts, async ($, on) => {
  const seen = setup(on)
  await start($)
  await call($, 'harness_delegate', { tasks: [{ task: 'Review the retry flow and report', class: 'explore' }] })
  expect(seen.spawns[0]!.subagentType).toBe('harness:haiku-low')
})

test('delegation: a spawn error is not turned into a tier deny', opts, async ($, on) => {
  const seen = setup(on)
  await start($)
  seen.throwSpawn = 'engine down'
  await expect($.agent.spawn({ model: 'opus', prompt: 'Implement the endpoint', description: 'implement' } as never)).rejects.toThrow()
})

test('delegation: harness_wait names a lost run instead of hanging', opts, async ($, on) => {
  setup(on)
  await start($)
  const out = await call($, 'harness_wait', { runIds: ['run-999'] })
  const body = JSON.parse(String(out.result)) as { results: { state: string; result: string }[] }
  expect(body.results[0]).toMatchObject({ state: 'lost' })
  expect(body.results[0]!.result).toContain('perdido')
})

test('delegation: the runs table is bounded', opts, async ($, on) => {
  setup(on)
  await start($)
  for (let i = 0; i < 12; i += 1) {
    await call($, 'harness_delegate', { tasks: Array.from({ length: 20 }, (_v, k) => ({ task: `Find item ${i}-${k}`, prefer: 'codex' })) })
  }
  const first = await call($, 'harness_wait', { runIds: ['run-1'] })
  expect(String(first.result)).toContain('perdido')
})

test('delegation: a non-type error from next() is rethrown, not turned into a deny', opts, async ($, on) => {
  setup(on)
  await start($)
  const boom = async () => {
    throw new Error('boom')
  }
  await expect(spawnWithTier($ as never, { model: 'opus', prompt: 'Implement x', description: 'implement' }, boom, { delegation: true })).rejects.toThrow('boom')
})
