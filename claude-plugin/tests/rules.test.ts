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

test('rules: rm -rf asks through tool.check and a plain rm does not', async ($, on) => {
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

test('rules: an invalid local rules file fails closed for writes and commits only', async ($, on) => {
  wire(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'ok' }) as never)
  on('tool.call', { tool: 'Write' }, () => ({ result: 'ok' }) as never)
  on('env.get', () => ({ value: '/home/dev' }))
  on('fs.read', () => ({ value: 'workRepo:\n  roots\n   - : [\n' }))
  expect(String((await write($, '/tmp/rules-b.ts', 'const a = 1')).deny)).toContain('harness rules')
  expect(String((await bash($, 'git commit -m "feat: x"')).deny)).toContain('harness rules')
  expect((await bash($, 'ls -la')).deny).toBeUndefined()
})

test('rules: the skill reminder rides the first prompt once, beside the automatic context', async ($, on) => {
  const seen = wire(on)
  on('env.get', () => ({ value: undefined }))
  await $.prompt.submit({ text: 'fix the failing build', origin: { kind: 'composer' } } as never)
  await $.prompt.submit({ text: 'and the lint too', origin: { kind: 'composer' } } as never)
  expect(seen.promptContext.length).toBeGreaterThan(1)
  const first = seen.promptContext[0]!.join('\n')
  expect(first).toContain('Before starting, check whether a skill')
  expect(first).toContain('Herdr-Jev automatically evaluates')
  expect(seen.promptContext[1]!.join('\n')).not.toContain('Before starting, check whether a skill')
})
