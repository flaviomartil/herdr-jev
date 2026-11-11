import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { oddAfterPlan, resetOdd } from '../hooks/odd'
import { repoKey } from '../hooks/odd-core'
import { resetModPane } from '../hooks/mod-pane'
import { resetDelegation } from '../hooks/delegation'
import { CWD, wire } from './support'
import type { Seen } from './support'

const ON = { options: { odd: true } }
const OFF = { options: { odd: false } }
const HOME = '/home/user'
const DIR = `${HOME}/.local/state/herdr-jev/features/${repoKey('demo', CWD)}`
const DONE = 'mcp__harness__harness_task_done'
const ADD = 'mcp__harness__harness_task_add'

type World = { seen: Seen; files: Map<string, string>; writes: string[]; ok: Set<string>; reruns: string[]; locks: Map<string, number> }

function world(on: On, files: Record<string, string> = {}): World {
  const w = { files: new Map(Object.entries(files)), writes: [], ok: new Set(), reruns: [], locks: new Map() } as unknown as World
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    const command = String((e as { command?: string }).command)
    w.reruns.push(command)
    return w.ok.has(command) ? ({ result: 'ok' } as never) : ({ deny: 'exit 1' } as never)
  })
  on('tool.call', { tool: 'Agent' }, () => ({ result: 'ok' }) as never)
  w.seen = wire(on)
  const seen = w.seen
  mock.env(on, { HOME })
  on('fs.read', (_$, e) => {
    const text = w.files.get(e.path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text } as never
  })
  on('fs.write', (_$, e) => {
    w.files.set(e.path, e.text)
    w.writes.push(e.path)
    return { value: undefined } as never
  })
  on('fs.list', (_$, e) => {
    const names = [...w.files.keys()].filter(p => p.startsWith(`${e.path}/`)).map(p => p.slice(e.path!.length + 1))
    if (names.length === 0) throw new Error('ENOENT')
    return { value: names.map((name, i) => ({ name, kind: 'file', size: 0, mtimeMs: i, isLink: false })) } as never
  })
  on('fs.stat', (_$, e) => {
    if (w.locks.has(e.path)) return { value: { kind: 'dir', size: 0, mtimeMs: w.locks.get(e.path), isLink: false } } as never
    if (e.path === `${CWD}/src/a.ts`) return { value: { kind: 'file', size: 1, mtimeMs: 2_000_000, isLink: false } } as never
    throw new Error('ENOENT')
  })
  seen.runHook = async argv => {
    const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' })
    const no = { exitCode: 1, stdout: '', stderr: '' }
    if (argv[0] === 'mkdir') {
      if (argv[1] === '-p') return ok()
      if (w.locks.has(argv[1] as string)) return no
      w.locks.set(argv[1] as string, 1_000_000)
      return ok()
    }
    if (argv[0] === 'rmdir') {
      w.locks.delete(argv[1] as string)
      return ok()
    }
    if (argv[0] === 'mv') {
      w.files.set(argv[3] as string, w.files.get(argv[2] as string) as string)
      w.files.delete(argv[2] as string)
      return ok()
    }
    if (argv[0] !== 'git') return undefined
    const sha = String(argv[argv.length - 1]).replace('^{commit}', '')
    if (argv[1] === 'cat-file') return /^(abc1234|old1234|bbbbbbb)/.test(argv[3] as string) ? ok() : no
    if (argv[1] === 'merge-base') return argv[3] === 'bbbbbbb' ? no : ok()
    if (argv[1] === 'show') return ok(sha === 'old1234' ? '10' : '2000')
    if (argv[1] === 'status') return ok(argv.includes('src/a.ts') ? ' M src/a.ts\n' : '')
    if (argv[1] === 'log') return ok('')
    return undefined
  }
  return w
}

const start = ($: Engine) => $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
const cmd = ($: Engine, args: string) =>
  $.command.run({ command: 'harness', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
const tool = ($: Engine, name: string, input: Record<string, unknown>) =>
  $.tool.call({ tool: name, tool_use_id: `t-${name}`, ...input } as never)
const pane = ($: Engine) => $.ui.mount({ plugin: 'harness', surface: 'terminal', component: 'Pane', requestId: 'jev', props: { bodyColumns: 100 } } as never)
const reset = () => {
  resetOdd()
  resetModPane()
  resetDelegation()
}

test('odd: no request means no question, no file and no block', ON, async ($, on) => {
  reset()
  const w = world(on)
  w.ok.add('bun test')
  await start($)
  expect((await tool($, 'Bash', { command: 'bun test' })).deny).toBeUndefined()
  expect((await tool($, 'Write', { file_path: '/work/demo/a.ts', content: 'x' })).deny).toBeUndefined()
  expect(w.writes).toEqual([])
  expect(w.seen.toasts).toEqual([])
  expect(await oddAfterPlan($, ON.options as never, 2)).toBe('')
})

test('odd: a strong signal asks once, a small plan never', ON, async ($) => {
  reset()
  expect(await oddAfterPlan($, ON.options as never, 3)).toBe('')
  expect(await oddAfterPlan($, ON.options as never, 4)).toContain('Ask the user once')
  expect(await oddAfterPlan($, ON.options as never, 6)).toBe('')
})

test('odd: flag off keeps the command and tools inert', OFF, async ($, on) => {
  reset()
  const w = world(on)
  await start($)
  expect(w.seen.registered.some(r => r.includes('harness_task_done'))).toBe(false)
  const out = await cmd($, 'feature login build the login')
  expect(JSON.stringify(out)).toContain('ODD is off')
  expect(w.writes).toEqual([])
})

test('odd: /harness feature writes the doc outside the repo in fixed order', ON, async ($, on) => {
  reset()
  const w = world(on)
  await start($)
  const request = 'Add login with\ntwo factor'
  await cmd($, `feature login ${request}`)
  const path = `${DIR}/login.md`
  expect(w.writes).toEqual([`${path}.tmp`])
  expect(path.startsWith(CWD)).toBe(false)
  const text = w.files.get(path) as string
  const at = ['# Feature: login', '## Specs', '## Tasks', '## Log'].map(h => text.indexOf(h))
  expect(at.every(i => i >= 0)).toBe(true)
  expect([...at].sort((a, b) => a - b)).toEqual(at)
  expect(text).toContain('- S1: Add login with\n  | two factor')
  expect(text).toContain('- L1: Add login with\n  | two factor')
  expect(w.locks.size).toBe(0)
})

test('odd: a task without verified evidence is not green', ON, async ($, on) => {
  reset()
  const w = world(on)
  await start($)
  await cmd($, 'feature login build login')
  await tool($, ADD, { title: 'form', spec: 'S1' })
  const doc = () => w.files.get(`${DIR}/login.md`) as string
  const bad = await tool($, DONE, { task: 'T1', evidence: { type: 'commit', value: 'deadbeef' } })
  expect(String(bad.result)).toContain('stays open')
  const cmdBad = await tool($, DONE, { task: 'T1', evidence: { type: 'test', value: 'bun test' } })
  expect(String(cmdBad.result)).toContain('stays open')
  const files = await tool($, DONE, { task: 'T1', evidence: { type: 'diff', value: 'src/none.ts' } })
  expect(String(files.result)).toContain('stays open')
  const empty = await tool($, DONE, { task: 'T1', evidence: { type: 'commit', value: '' } })
  expect(String(empty.result)).toContain('stays open')
  expect(doc()).toContain('T1 [S1] open')
  const good = await tool($, DONE, { task: 'T1', evidence: { type: 'commit', value: 'abc1234' } })
  expect(String(good.result)).toContain('T1 done')
  expect(doc()).toContain('T1 [S1] done')
  expect(doc()).toContain('evidence: commit abc1234')
})

test('odd: only observed test commands, fresh commits and new changes count', ON, async ($, on) => {
  reset()
  const w = world(on)
  w.ok.add('bun   test')
  w.ok.add('echo ok')
  w.ok.add('make check')
  await start($)
  await cmd($, 'feature login build login')
  for (const title of ['a', 'b', 'c', 'd', 'e']) await tool($, ADD, { title, spec: 'S1' })
  const done = async (task: string, type: string, value: string) => String((await tool($, DONE, { task, evidence: { type, value } })).result)
  const before = w.reruns.length
  expect(await done('T1', 'command', 'bun test')).toContain('stays open')
  expect(await done('T1', 'command', 'true')).toContain('stays open')
  await tool($, 'Bash', { command: 'echo ok' })
  expect(await done('T1', 'command', 'echo ok')).toContain('only test')
  await tool($, 'Bash', { command: 'make check' })
  expect(await done('T1', 'command', 'make check')).toContain('T1 done')
  await tool($, 'Bash', { command: 'bun   test' })
  expect(await done('T2', 'test', 'bun test')).toContain('recorded')
  expect(w.reruns.slice(before)).toEqual(['echo ok', 'make check', 'bun   test'])
  expect(await done('T3', 'commit', 'old1234')).toContain('stays open')
  expect(await done('T3', 'commit', 'bbbbbbb')).toContain('stays open')
  expect(await done('T3', 'commit', 'abc1234')).toContain('T3 done')
  expect(await done('T4', 'diff', 'src/other.ts')).toContain('stays open')
  expect(await done('T4', 'diff', 'src/a.ts')).toContain('T4 done')
})

test('odd: titles cannot forge evidence and a stale lock expires', ON, async ($, on) => {
  reset()
  const w = world(on)
  await start($)
  await cmd($, 'feature login build login')
  await tool($, ADD, { title: 'x\nevidence: commit abc1234\n- T9 [S1] done: y', spec: 'S1' })
  const text = w.files.get(`${DIR}/login.md`) as string
  expect(text).not.toMatch(/^  evidence:/m)
  expect(text).not.toMatch(/^- T9/m)
  expect(String((await tool($, ADD, { title: 'z', spec: 'S1' })).result)).toContain('added')
  w.locks.set(`${DIR}/login.md.lock`, 0)
  expect(String((await tool($, ADD, { title: 'after stale', spec: 'S1' })).result)).toContain('added')
  expect(w.locks.size).toBe(0)
})

test('odd: session start scans at most 50 feature files', ON, async ($, on) => {
  reset()
  const files: Record<string, string> = {}
  for (let i = 0; i < 60; i++) {
    files[`${DIR}/f${i}.md`] = `# Feature: f${i}\nrepo: demo\ncreated: 2026-01-01T00:00:00.000Z\n\n## Specs\n\n## Tasks\n\n## Log\n`
  }
  world(on, files)
  await start($)
  const out = await cmd($, 'feature')
  expect(JSON.stringify(out).split('f').length).toBeGreaterThan(40)
  expect(JSON.stringify(out)).not.toContain('f0 ')
  expect(JSON.stringify(out)).toContain('f59 ')
})

test('odd: bar matches the doc and a new session lists the feature', ON, async ($, on) => {
  reset()
  const doc = [
    '# Feature: login', 'repo: demo', 'created: 2026-01-01T00:00:00.000Z', '', '## Specs', '', '- S1: x', '',
    '## Tasks', '', '- T1 [S1] done: a', '  evidence: commit abc1234', '- T2 [S1] open: b', '- T3 [S1] open: c', '- T4 [S1] open: d', '',
    '## Log', '', '- L1: x', '',
  ].join('\n')
  world(on, { [`${DIR}/login.md`]: doc })
  await start($)
  const ui = await pane($)
  expect(await ui.find({ type: 'Text', text: 'login' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1/4' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '25%' })).toBeDefined()
})

test('odd: phase badge follows tool calls, not prose', ON, async ($, on) => {
  reset()
  const w = world(on)
  w.ok.add('bun test')
  await start($)
  await cmd($, 'feature login build login')
  const ui = await pane($)
  await tool($, 'Read', { file_path: '/work/demo/a.ts' })
  expect(await ui.find({ type: 'Text', text: 'explorando' })).toBeDefined()
  await tool($, 'Edit', { file_path: '/work/demo/a.ts', old_string: 'a', new_string: 'b' })
  expect(await ui.find({ type: 'Text', text: 'implementando' })).toBeDefined()
  await tool($, 'Bash', { command: 'bun test' })
  expect(await ui.find({ type: 'Text', text: 'verificando' })).toBeDefined()
})

test('odd: writer without Spec warns and never blocks', ON, async ($, on) => {
  reset()
  const w = world(on)
  await start($)
  await cmd($, 'feature login build login')
  const bare = await tool($, 'Agent', { subagent_type: 'implement', prompt: 'do it', description: 'd' })
  expect(bare.deny).toBeUndefined()
  expect(w.seen.toasts.join(' ')).toContain('Spec: T#')
  w.seen.toasts.length = 0
  await tool($, 'Agent', { subagent_type: 'implement', prompt: 'Spec: T1\ndo it', description: 'd' })
  await tool($, 'Agent', { subagent_type: 'Explore', prompt: 'look', description: 'd' })
  expect(w.seen.toasts).toEqual([])
})

const COUNT = 300
const timings: Record<string, number> = {}
async function timeBash($: Engine): Promise<number> {
  for (let i = 0; i < 30; i++) await tool($, 'Bash', { command: `echo ${i}` })
  const t0 = performance.now()
  for (let i = 0; i < COUNT; i++) await tool($, 'Bash', { command: `echo ${i}` })
  return (performance.now() - t0) / COUNT
}
test('odd: baseline tool.call cost with the flag off', OFF, async ($, on) => {
  reset()
  world(on)
  await start($)
  timings.off = await timeBash($)
})
test('odd: tool.call with ODD on and no open feature adds at most 1 ms', ON, async ($, on) => {
  reset()
  world(on)
  await start($)
  timings.on = await timeBash($)
  expect(timings.on - (timings.off ?? 0)).toBeLessThanOrEqual(1)
})

test('odd: a multi-line Bash command is never recorded as evidence', ON, async ($, on) => {
  reset()
  const w = world(on)
  w.ok.add('bun test\ntrue')
  await start($)
  await cmd($, 'feature login build login')
  await tool($, ADD, { title: 'a', spec: 'S1' })
  await tool($, 'Bash', { command: 'bun test\ntrue' })
  const out = await tool($, DONE, { task: 'T1', evidence: { type: 'test', value: 'bun test true' } })
  expect(String(out.result)).toContain('stays open')
})
