import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { resetDelegation } from '../hooks/delegation'
import { resetModPane } from '../hooks/mod-pane'
import { resetOdd } from '../hooks/odd'
import { CWD, PANE_PROPS, wire } from './support'

const HOME = '/home/user'
const STATE = `${HOME}/.local/state/herdr-jev`
const DAY = 86400
const fail = (ts: number, cwd: string) =>
  JSON.stringify({ ts: String(ts), tool: 'Bash', input: "{'command': 'ssh cast-prd uptime'}", error: 'Exit code 1\nssh: connect to host x port 22: Connection timed out', project: 'cast', cwd })
const FAILED = [fail(1_700_000_000, '/a'), fail(1_700_000_100, '/a'), fail(1_700_000_000 + DAY, '/b')].join('\n')

function world(on: On, files: Record<string, string>) {
  const fs = new Map(Object.entries(files))
  const seen = wire(on)
  mock.env(on, { HOME })
  on('fs.read', (_$, e) => {
    const text = fs.get(e.path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text } as never
  })
  on('fs.write', (_$, e) => {
    fs.set(e.path, e.text)
    return { value: undefined } as never
  })
  on('fs.list', (_$, e) => {
    const names = [...fs.keys()].filter(p => p.startsWith(`${e.path}/`) && !p.slice(e.path!.length + 1).includes('/')).map(p => p.slice(e.path!.length + 1))
    if (names.length === 0) throw new Error('ENOENT')
    return { value: names.map(name => ({ name, kind: 'file', size: 0, mtimeMs: 1, isLink: false })) } as never
  })
  on('tool.call', { tool: 'Agent' }, () => ({ result: 'ok' }) as never)
  seen.runHook = async (argv, init) => {
    if (argv[0] === 'rm') fs.delete(argv[2] as string)
    if (argv[0] === 'mv') {
      fs.set(argv[3] as string, fs.get(argv[2] as string) as string)
      fs.delete(argv[2] as string)
    }
    if (argv[0] === 'tee') fs.set(argv[2] as string, (fs.get(argv[2] as string) ?? '') + String(init?.stdin ?? ''))
    return argv[0] === 'git' ? undefined : { exitCode: 0, stdout: '', stderr: '' }
  }
  return { fs, seen }
}
const start = ($: Engine) => $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
const pane = ($: Engine) => $.ui.mount({ plugin: 'harness', surface: 'terminal', component: 'Pane', requestId: 'jev', props: { ...PANE_PROPS, title: 'Jev' } })
const reset = () => {
  resetOdd()
  resetModPane()
  resetDelegation()
}
const pending = (fs: Map<string, string>) => [...fs.keys()].filter(k => /\/proposals\/p-[0-9a-f]+\.json$/.test(k))

test('improve: flag off mines nothing', { options: { improve: false } }, async ($, on) => {
  reset()
  const w = world(on, { [`${HOME}/.claude/failed-attempts.jsonl`]: FAILED })
  await start($)
  expect(pending(w.fs)).toEqual([])
})

test('improve: one proposal, nothing applied until approve, then the file is written', { options: { improve: true } }, async ($, on) => {
  reset()
  const w = world(on, { [`${HOME}/.claude/failed-attempts.jsonl`]: FAILED })
  await start($)
  const [file] = pending(w.fs)
  expect(pending(w.fs).length).toBe(1)
  const id = file!.split('/').pop()!.slice(0, -5)
  const ui = await pane($)
  expect(await ui.find({ type: 'Text', text: /recover-/ })).toBeDefined()
  expect([...w.fs.keys()].some(k => k.includes('/runbooks/'))).toBe(false)
  await ui.press({ key: `df-${id}` })
  expect(await ui.find({ type: 'Text', text: /^\+\+\+ / })).toBeDefined()
  await ui.press({ key: `ok-${id}` })
  expect([...w.fs.keys()].some(k => k.includes('/runbooks/recover-'))).toBe(true)
})

test('improve: reject quarantines', { options: { improve: true } }, async ($, on) => {
  reset()
  const w = world(on, { [`${HOME}/.claude/failed-attempts.jsonl`]: FAILED })
  await start($)
  const id = pending(w.fs)[0]!.split('/').pop()!.slice(0, -5)
  const ui = await pane($)
  await ui.press({ key: `no-${id}` })
  expect(w.fs.has(`${STATE}/proposals/quarantine/${id}.json`)).toBe(true)
  expect(pending(w.fs)).toEqual([])
})

test('router: default conclave records a shadow decision with why; harness mode does not', { options: {} }, async ($, on) => {
  reset()
  const w = world(on, {})
  await start($)
  await $.tool.call({ tool: 'Agent', tool_use_id: 'a1', subagent_type: 'general-purpose', description: 'find config', prompt: 'search the repo for the config loader' } as never)
  const log = w.fs.get(`${STATE}/route-shadow.jsonl`) ?? ''
  expect(log).toContain('"kind":"shadow"')
  expect(JSON.parse(log.trim().split('\n')[0]!).why.length).toBeGreaterThan(0)
})

test('router: harness mode keeps the shadow off', { options: { router: 'harness' } }, async ($, on) => {
  reset()
  const w = world(on, {})
  await start($)
  await $.tool.call({ tool: 'Agent', tool_use_id: 'a1', subagent_type: 'general-purpose', prompt: 'search the repo' } as never)
  expect(w.fs.has(`${STATE}/route-shadow.jsonl`)).toBe(false)
})
