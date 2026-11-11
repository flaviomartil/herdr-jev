import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { wire } from './support'

const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command } as never)
const write = ($: Engine, file_path: string, content: string) => $.tool.call({ tool: 'Write', file_path, content } as never)

test('rules: a co-author commit is denied and a clean one is not', async ($, on) => {
  wire(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'ok' }) as never)
  const blocked = await bash($, 'git commit -m "x" -m "Co-Authored-By: A <a@b.c>"')
  expect(String(blocked.deny)).toContain('harness rules')
  const passed = await bash($, 'git commit -m "feat: x"')
  expect(passed.deny).toBeUndefined()
})

test('rules: a secret in a written file is denied', async ($, on) => {
  wire(on)
  on('tool.call', { tool: 'Write' }, () => ({ result: 'ok' }) as never)
  const key = `AKI${'A'}${'1234567890ABCDEF'}`
  expect(String((await write($, '/tmp/rules-a.ts', `const k = "${key}"`)).deny)).toContain('harness rules')
  expect((await write($, '/tmp/rules-a.ts', 'const k = 1')).deny).toBeUndefined()
})

test('rules: a plain rm passes untouched', async ($, on) => {
  wire(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'ok' }) as never)
  expect((await bash($, 'rm build.log')).deny).toBeUndefined()
})

test('rules: a generic new file name adds a warning', async ($, on) => {
  wire(on)
  on('tool.call', { tool: 'Write' }, () => ({ result: 'ok' }) as never)
  const ran = await write($, '/tmp/rules-scratch/notes.md', 'x')
  expect(ran.deny).toBeUndefined()
  expect((ran.context ?? []).join(' ')).toContain('Generic file name')
})
