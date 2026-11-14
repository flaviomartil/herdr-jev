import { expect, test } from 'claude-code/testing'
import type { Automatic } from '../types'
import { CWD, settle, wire as baseWire } from './support'

const wire: typeof baseWire = (on, extra) => {
  on('env.get', () => ({ value: undefined }))
  on('classic.UserPromptSubmit', () => ({}))
  return baseWire(on, extra)
}

const ID = '11111111-1111-4111-a111-111111111111'
const first = { turn: 'queued-1', task: 'first queued', cwd: CWD, model: 'claude-fable-5-1' }
const second = { turn: 'queued-2', task: 'second queued', cwd: CWD, model: 'claude-fable-5-1' }
const active: Automatic = { turn: 'turn-auto', cwd: CWD, task: 'implement parser', model: 'claude-fable-5-1', id: ID, state: 'working', reason: 'working', stages: [], pending: [first, second] }
const response = (state: string) => ({ id: ID, run: { id: ID, stages: [
  { role: 'implementer', client: 'codex', model: 'gpt-6.1-sol', state },
  { role: 'reviewer', client: 'claude', model: 'claude-opus-5-5', state: 'queued' },
] } })

test('queued prompts are sent in order after a failed run', async ($, on) => {
  const stdins: string[] = []
  const seen = wire(on, { store: { 'harness:auto:sess-1:current': active } })
  seen.runHook = async (argv, init) => {
    if (argv[1] === 'mod-collect') return { exitCode: 0, stdout: JSON.stringify({ ...response('reported'), error: 'verification_failed' }), stderr: '' }
    if (argv[1] === 'mod-route') { stdins.push(init?.stdin ?? ''); return { exitCode: 0, stdout: JSON.stringify({ mode: 'direct', reason: 'simple_work' }), stderr: '' } }
    return undefined
  }
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: false })
  await $.tool.call({ tool: 'mcp__harness__harness_collect', tool_use_id: 'finish-active' } as never)
  for (let i = 0; i < 4; i += 1) { await seen.clock.advance(1); await settle() }
  expect(stdins).toEqual(['first queued', 'second queued'])
})

test('an unconfirmed (unknown) run holds the queue so nothing runs in parallel with it', async ($, on) => {
  const stdins: string[] = []
  const seen = wire(on, { store: { 'harness:auto:sess-1:current': active } })
  seen.runHook = async (argv, init) => {
    if (argv[1] === 'mod-collect') return { exitCode: 0, stdout: JSON.stringify(response('unknown')), stderr: '' }
    if (argv[1] === 'mod-route') { stdins.push(init?.stdin ?? ''); return { exitCode: 0, stdout: JSON.stringify({ mode: 'direct', reason: 'simple_work' }), stderr: '' } }
    return undefined
  }
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: false })
  await $.tool.call({ tool: 'mcp__harness__harness_collect', tool_use_id: 'finish-active' } as never)
  for (let i = 0; i < 4; i += 1) { await seen.clock.advance(1); await settle() }
  expect(stdins).toEqual([])
})

test('queued prompts are sent in order after the active turn is interrupted', async ($, on) => {
  const stdins: string[] = []
  const seen = wire(on, { store: { 'harness:auto:sess-1:current': active } })
  seen.runHook = async (argv, init) => {
    if (argv[1] === 'mod-route') { stdins.push(init?.stdin ?? ''); return { exitCode: 0, stdout: JSON.stringify({ mode: 'direct', reason: 'simple_work' }), stderr: '' } }
    return undefined
  }
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: false })
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: true, turnId: 'turn-user', reason: 'aborted' } as never)
  for (let i = 0; i < 4; i += 1) { await seen.clock.advance(1); await settle() }
  expect(stdins).toEqual(['first queued', 'second queued'])
})
