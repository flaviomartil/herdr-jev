import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Automatic } from '../types'
import { CWD, settle, wire as baseWire } from './support'

const wire: typeof baseWire = (on, extra) => {
  on('env.get', () => ({ value: undefined }))
  on('classic.UserPromptSubmit', () => ({}))
  return baseWire(on, extra)
}

const KEY = 'harness:auto:sess-1:current'
const row = (turn: string, task: string) => ({ turn, task, cwd: CWD, model: 'claude-fable-5-1' })
const ID = '11111111-1111-4111-a111-111111111111'
const active: Automatic = {
  turn: 'turn-auto', cwd: CWD, task: 'implement parser', model: 'claude-fable-5-1', id: ID,
  state: 'working', reason: 'working', stages: [], pending: [row('q1', 'first queued'), row('q2', 'second queued')],
}

const start = ($: Engine) => $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: false })
const run = async ($: Engine, command: 'queue' | 'before', args: string) =>
  String(((await $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)) as { text?: string }).text)
const tasks = (seen: ReturnType<typeof wire>) =>
  ((seen.saved.get(KEY) as Automatic | undefined)?.pending ?? []).map(one => one.task)

test('/queue lists the queued prompts in order', { options: { autoDelegate: true } }, async ($, on) => {
  const seen = wire(on, { store: { [KEY]: active } })
  await start($)
  const text = await run($, 'queue', '')
  expect(text).toContain('1. first queued')
  expect(text).toContain('2. second queued')
  expect(text.indexOf('first queued')).toBeLessThan(text.indexOf('second queued'))
  expect(seen.spawns).toHaveLength(0)
})

test('/queue says when nothing is queued', { options: { autoDelegate: true } }, async ($, on) => {
  wire(on, { store: { [KEY]: { ...active, pending: [] } } })
  await start($)
  expect(await run($, 'queue', '')).toBe('Queue is empty.')
})

test('/before puts a task first in the queue', { options: { autoDelegate: true } }, async ($, on) => {
  const seen = wire(on, { store: { [KEY]: active } })
  await start($)
  const text = await run($, 'before', 'fix the login bug')
  expect(text).toContain('fix the login bug')
  expect(tasks(seen)).toEqual(['fix the login bug', 'first queued', 'second queued'])
  expect(seen.spawns).toHaveLength(0)
})

test('/before without a task or without an active run changes nothing', { options: { autoDelegate: true } }, async ($, on) => {
  const seen = wire(on, { store: { [KEY]: { ...active, state: 'verified', pending: [] } } })
  await start($)
  expect(await run($, 'before', '  ')).toContain('Usage')
  expect(await run($, 'before', 'later')).toContain('Nothing is running')
  expect(tasks(seen)).toEqual([])
})

test('/queue rm removes the numbered item', { options: { autoDelegate: true } }, async ($, on) => {
  const seen = wire(on, { store: { [KEY]: active } })
  await start($)
  expect(await run($, 'queue', 'rm 1')).toContain('first queued')
  expect(tasks(seen)).toEqual(['second queued'])
  expect(await run($, 'queue', 'rm 5')).toContain('No item 5')
  expect(tasks(seen)).toEqual(['second queued'])
})

test('/queue edit replaces the text of the numbered item', { options: { autoDelegate: true } }, async ($, on) => {
  const seen = wire(on, { store: { [KEY]: active } })
  await start($)
  expect(await run($, 'queue', 'edit 2 second, but with tests')).toContain('second, but with tests')
  expect(tasks(seen)).toEqual(['first queued', 'second, but with tests'])
  expect(await run($, 'queue', 'edit 2')).toContain('Usage')
  expect(tasks(seen)).toEqual(['first queued', 'second, but with tests'])
})

const working = { id: ID, run: { id: ID, stages: [{ role: 'implementer', client: 'codex', model: 'gpt-6.1-sol', state: 'running' }] } }

const drive = async (seen: ReturnType<typeof wire>) => {
  for (let i = 0; i < 4; i += 1) {
    await seen.clock.advance(1)
    await settle()
  }
}

test('/queue rm and edit refuse an item that was dispatched after the listing instead of shifting', { options: { autoDelegate: true } }, async ($, on) => {
  let release = () => undefined as void
  const held = new Promise<void>(resolve => { release = resolve })
  const seen = wire(on, { store: { [KEY]: active } })
  seen.runHook = async argv => {
    if (argv[1] === 'mod-route') {
      await held
      return { exitCode: 0, stdout: JSON.stringify({ mode: 'direct', reason: 'simple_work' }), stderr: '' }
    }
    return undefined
  }
  await start($)
  expect(await run($, 'queue', '')).toContain('1. first queued')
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: true, turnId: 'turn-user', reason: 'aborted' } as never)
  await drive(seen)
  expect(tasks(seen)).toEqual(['second queued'])

  expect(await run($, 'queue', 'rm 1')).toContain('no longer queued')
  expect(await run($, 'queue', 'edit 1 changed')).toContain('no longer queued')
  expect(tasks(seen)).toEqual(['second queued'])
  expect(await run($, 'queue', 'rm 2')).toContain('second queued')
  expect(tasks(seen)).toEqual([])
  release()
  await drive(seen)
})

test('an item removed while a collection holds an older copy of the run stays removed', { options: { autoDelegate: true } }, async ($, on) => {
  let release = () => undefined as void
  const held = new Promise<void>(resolve => { release = resolve })
  let collecting = false
  const seen = wire(on, { store: { [KEY]: active } })
  seen.runHook = async argv => {
    if (argv[1] === 'mod-collect') {
      collecting = true
      await held
      return { exitCode: 0, stdout: JSON.stringify(working), stderr: '' }
    }
    return undefined
  }
  await start($)
  await $.tool.call({ tool: 'mcp__harness__harness_collect', tool_use_id: 'collect-1' } as never)
  await drive(seen)
  expect(collecting).toBe(true)

  expect(await run($, 'queue', 'rm 1')).toContain('first queued')
  release()
  await drive(seen)
  expect(tasks(seen)).toEqual(['second queued'])
})
