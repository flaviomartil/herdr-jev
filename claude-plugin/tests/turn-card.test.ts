import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { cardText, emptyTally } from '../hooks/turn-card'
import { BAND_PROPS, CWD, wire } from './support'

const start = ($: Engine) => $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
const band = ($: Engine) => $.ui.mount({ plugin: 'harness', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
const turnStart = ($: Engine) => $.turn.start({ turnId: 'turn-1', text: 'do it' } as never)
const turnEnd = ($: Engine) => $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 'turn-1', reason: 'answer' } as never)

const work = async ($: Engine) => {
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/a.ts`, old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/a.ts`, old_string: 'b', new_string: 'c' })
  await $.tool.call({ tool: 'Write', file_path: `${CWD}/src/b.ts`, content: 'x' })
  await $.tool.call({ tool: 'Bash', command: 'bun test' })
  await $.tool.call({ tool: 'Bash', command: 'bun test FAIL' })
  await $.tool.call({ tool: 'Bash', command: 'git commit -m "feat: x"' })
  await $.agent.spawn({ prompt: 'implement it', subagentType: 'general-purpose' } as never)
}

const failing = (on: Parameters<typeof wire>[0]) =>
  on('tool.call', { tool: 'Bash' }, (_$, e) =>
    String((e as { command?: unknown }).command ?? '').includes('FAIL') ? { result: { interrupted: false }, isError: true } : { result: { interrupted: false } },
  )

test('the card text counts files, tests, commits and delegated runs on one line', () => {
  expect(cardText({ files: ['a', 'b'], passed: 1, failed: 1, commits: 1, delegated: 2 })).toBe(
    'turno · 2 arquivos · testes ✓1 ✗1 · 1 commit · 2 delegados',
  )
  expect(cardText({ ...emptyTally(), files: ['a'] })).toBe('turno · 1 arquivo')
  expect(cardText(emptyTally())).toBeNull()
})

test('the card shows once at turn complete and hides on the next prompt', async ($, on) => {
  failing(on)
  wire(on)
  await start($)
  await turnStart($)
  await work($)

  const during = await band($)
  expect(await during.find({ type: 'Text', text: /^turno/ })).toBeUndefined()
  await during.unmount()

  await turnEnd($)
  const shown = await band($)
  expect(await shown.find({ type: 'Text', text: 'turno · 2 arquivos · testes ✓1 ✗1 · 1 commit · 1 delegado' })).toBeDefined()
  await shown.unmount()

  await $.prompt.submit({ text: 'next' } as never)
  const hidden = await band($)
  expect(await hidden.find({ type: 'Text', text: /^turno/ })).toBeUndefined()
  await hidden.unmount()
})

test('a turn with nothing to report shows no card and each turn counts from zero', async ($, on) => {
  failing(on)
  wire(on)
  await start($)
  await turnStart($)
  await work($)
  await turnEnd($)
  await $.prompt.submit({ text: 'next' } as never)
  await turnStart($)
  await turnEnd($)
  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: /^turno/ })).toBeUndefined()
  await ui.unmount()
})

test('the turnCard option off never shows the card', { options: { turnCard: false } }, async ($, on) => {
  failing(on)
  wire(on)
  await start($)
  await turnStart($)
  await work($)
  await turnEnd($)
  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: /^turno/ })).toBeUndefined()
  await ui.unmount()
})
