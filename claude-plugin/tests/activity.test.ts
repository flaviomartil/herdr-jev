import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { resetDelegation } from '../hooks/delegation'
import { resetModPane } from '../hooks/mod-pane'
import type { Activity } from '../types'
import { MAX_AGENTS, RING, applyTail, cursorOf, noteEnd, noteStep, parseTail, percentOf, resetActivity, setCursor, snapshotActivity } from '../hooks/activity'
import { toolLine } from '../hooks/activity-hooks'
import { CWD, PANE_PROPS, wire } from './support'

const live = { options: { delegation: true } }
const start = ($: Engine) => $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
const jevUi = ($: Engine) => $.ui.mount({ plugin: 'harness', surface: 'terminal', component: 'Pane', requestId: 'jev', props: { ...PANE_PROPS, title: 'Jev' } })

const acts = (seen: { state: Map<string, unknown> }): Record<string, Activity> => ((): Record<string, Activity> => { const raw = seen.state.get('harness.activity') as { shape?: string; value?: Record<string, Activity> } | undefined; return (raw?.shape === undefined ? raw : raw.value) as Record<string, Activity> ?? {} })()
const flush = (seen: { clock: { advance: (ms: number) => Promise<void> } }) => seen.clock.advance(300)

function setup(on: Parameters<typeof wire>[0]) {
  resetDelegation()
  resetModPane()
  const seen = wire(on)
  mock.env(on, { HOME: '/home/user' })
  on('fs.read', () => ({ value: '' }))
  seen.runHook = async () => ({ exitCode: 0, stdout: '/bin/x', stderr: '' })
  return seen
}

test('activity: a subagent tool.call updates its activity line and the pane shows it', live, async ($, on) => {
  const seen = setup(on)
  await start($)
  await $.tool.call({ tool: 'Read', tool_use_id: 'a1', file_path: '/src/foo.ts', agentId: 'sub-1' } as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'a2', command: 'bun test', agentId: 'sub-1' } as never)
  await flush(seen)
  const act = acts(seen)['sub-1']
  expect(act?.line).toBe('Bash: bun test')
  expect(act?.toolCount).toBe(2)
  expect(act?.tools).toEqual({ Read: 1, Bash: 1 })
  const ui = await jevUi($)
  expect(await ui.find({ type: 'Text', text: 'Bash: bun test' })).toBeDefined()
})

test('activity: percent only when real, otherwise step counter', live, async ($, on) => {
  const seen = setup(on)
  await start($)
  await $.tool.call({ tool: 'Read', tool_use_id: 'a1', file_path: '/src/foo.ts', agentId: 's' } as never)
  await flush(seen)
  expect(percentOf(acts(seen).s)).toBeNull()
  let ui = await jevUi($)
  expect(await ui.find({ type: 'Text', text: /\d+%/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'iniciando' })).toBeDefined()
  await ui.unmount()
  await $.tool.call({ tool: 'mcp__harness__harness_step', tool_use_id: 'p1', done: 1, total: 4, note: 'lendo', agentId: 's' } as never)
  await flush(seen)
  expect(percentOf(acts(seen).s)).toBe(25)
  ui = await jevUi($)
  expect(await ui.find({ type: 'Text', text: '25%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'passo 1/4' })).toBeDefined()
})

test('activity: worker-run events update tail, attempt and phase, and percent from progress events', live, async ($, on) => {
  resetActivity()
  const events = [
    { type: 'queued' },
    { type: 'start', pid: 1 },
    { type: 'out', line: 'editing parser' },
    { type: 'progress', percent: 40 },
    { type: 'out', line: 'running tests' },
  ].map(e => JSON.stringify(e)).join('\n')
  applyTail('x1', 5, parseTail(`${events}\n{"type":"out","line":"half`))
  const act = snapshotActivity().x1
  expect(act?.line).toBe('running tests')
  expect(act?.phase).toBe('rodando')
  expect(act?.attempt).toBe(1)
  expect(act?.percent).toBe(40)
  applyTail('x1', 9, parseTail('{"type":"exit","code":0,"outcome":"done","tail":"all green"}'))
  expect(snapshotActivity().x1?.end).toBe('done')
  expect(snapshotActivity().x1?.snippet).toBe('all green')
})

test('activity: external run tail is read by cursor, only new bytes', { options: { delegation: true } }, async ($, on) => {
  const seen = setup(on)
  const file = '/state/runs/x/events.jsonl'
  let body = `${JSON.stringify({ type: 'start' })}\n${JSON.stringify({ type: 'out', line: 'one' })}\n`
  const tails: string[] = []
  seen.runHook = async (argv) => {
    if (argv[0] === 'tail') {
      tails.push(argv[2] as string)
      return { exitCode: 0, stdout: body.slice(Number(argv[2]?.slice(1)) - 1), stderr: '' }
    }
    if (argv.includes('panes')) return { exitCode: 0, stdout: JSON.stringify({ status: 'started', eventsFile: file, host: 'background' }), stderr: '' }
    return { exitCode: 0, stdout: '/bin/x', stderr: '' }
  }
  on('fs.stat', () => ({ value: { kind: 'file', size: new TextEncoder().encode(body).length, mtimeMs: 0, isLink: false } }))
  await start($)
  await $.tool.call({ tool: 'mcp__harness__harness_delegate', tool_use_id: 'd', tasks: [{ task: 'Find a', prefer: 'codex' }] } as never)
  await seen.clock.advance(1100)
  await flush(seen)
  expect(Object.values(acts(seen)).some(a => a.line === 'one')).toBe(true)
  body += `${JSON.stringify({ type: 'out', line: 'two' })}\n`
  await seen.clock.advance(1100)
  await flush(seen)
  expect(Object.values(acts(seen)).some(a => a.line === 'two')).toBe(true)
  expect(tails[0]).toBe('+1')
  expect(Number(tails[tails.length - 1]?.slice(1))).toBeGreaterThan(1)
})

test('activity: delegation opens the jev pane once, a user close is respected, narrow terminal shows a hint', live, async ($, on) => {
  const seen = setup(on)
  await start($)
  await $.tool.call({ tool: 'mcp__harness__harness_delegate', tool_use_id: 'd1', tasks: [{ task: 'Find the config' }] } as never)
  expect(seen.opened.filter(id => id === 'jev')).toHaveLength(1)
  const ui = await jevUi($)
  await ui.press({ key: 'close' })
  await $.tool.call({ tool: 'mcp__harness__harness_delegate', tool_use_id: 'd2', tasks: [{ task: 'Find the other' }] } as never)
  expect(seen.opened.filter(id => id === 'jev')).toHaveLength(1)
})

test('activity: autoOpenPane off never opens', { options: { delegation: true, autoOpenPane: false } }, async ($, on) => {
  const seen = setup(on)
  await start($)
  await $.tool.call({ tool: 'mcp__harness__harness_delegate', tool_use_id: 'd1', tasks: [{ task: 'Find the config' }] } as never)
  await $.tool.call({ tool: 'Agent', tool_use_id: 'ag', prompt: 'x' } as never)
  expect(seen.opened).not.toContain('jev')
})

test('activity: Agent spawn opens the pane', live, async ($, on) => {
  const seen = setup(on)
  await start($)
  await $.tool.call({ tool: 'Agent', tool_use_id: 'ag', prompt: 'x' } as never)
  expect(seen.opened).toContain('jev')
})

test('activity: redraws are throttled to 4 per second and the log is a ring buffer', live, async ($, on) => {
  const seen = setup(on)
  const sets = () => seen.sets['harness.activity'] ?? 0
  await start($)
  await $.tool.call({ tool: 'Read', tool_use_id: 'w', file_path: '/a', agentId: 't' } as never)
  const base = sets()
  for (let i = 0; i < 30; i += 1) await $.tool.call({ tool: 'Read', tool_use_id: `r${i}`, file_path: `/f${i}`, agentId: 't' } as never)
  expect(sets() - base).toBeLessThanOrEqual(1)
  await flush(seen)
  expect(sets() - base).toBeLessThanOrEqual(2)
  const log = acts(seen).t?.log ?? []
  expect(log).toHaveLength(RING)
  expect(log.at(-1)).toBe('Read f29')
  expect(toolLine('Bash', { command: 'bun test' })).toBe('Bash: bun test')
})

test('activity: finished agent collapses to one line and expands on press', live, async ($, on) => {
  const seen = setup(on)
  await start($)
  await $.tool.call({ tool: 'Read', tool_use_id: 'a1', file_path: '/src/foo.ts', agentId: 'sub-2' } as never)
  await $.turn.complete({ turnId: 't', reason: 'answer', answer: 'todos verdes', agentId: 'sub-2' } as never)
  await flush(seen)
  const ui = await jevUi($)
  expect(await ui.find({ type: 'Text', text: /pronto/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'todos verdes' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Read foo.ts' })).toBeUndefined()
  await ui.press({ key: 'tg-sub-2' })
  expect(await ui.find({ type: 'Text', text: 'Read foo.ts' })).toBeDefined()
})

const EXT_FILE = '/state/runs/x/events.jsonl'

function externalTail(seen: ReturnType<typeof setup>, on: Parameters<typeof wire>[0], body: () => string, gate?: () => Promise<void>) {
  const tails: string[] = []
  seen.runHook = async (argv) => {
    if (argv[0] === 'tail') {
      tails.push(argv[2] as string)
      if (gate !== undefined) await gate()
      return { exitCode: 0, stdout: body().slice(Number(argv[2]?.slice(1)) - 1), stderr: '' }
    }
    if (argv.includes('panes')) return { exitCode: 0, stdout: JSON.stringify({ status: 'started', eventsFile: EXT_FILE, host: 'background' }), stderr: '' }
    return { exitCode: 0, stdout: '/bin/x', stderr: '' }
  }
  on('fs.stat', () => ({ value: { kind: 'file', size: new TextEncoder().encode(body()).length, mtimeMs: 0, isLink: false } }))
  return tails
}

test('activity: a slow tail read is not applied twice by overlapping ticks', { options: { delegation: true } }, async ($, on) => {
  const seen = setup(on)
  const body = `${JSON.stringify({ type: 'out', line: 'one' })}\n`
  let release: () => void = () => undefined
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  const tails = externalTail(seen, on, () => body, () => held)
  await start($)
  await $.tool.call({ tool: 'mcp__harness__harness_delegate', tool_use_id: 'd', tasks: [{ task: 'Find a', prefer: 'codex' }] } as never)
  await seen.clock.advance(3500)
  expect(tails).toHaveLength(1)
  release()
  await seen.clock.advance(1100)
  await flush(seen)
  const act = Object.values(acts(seen)).find(a => a.line === 'one')
  expect(act?.log.filter(line => line === 'one')).toHaveLength(1)
})

test('activity: a huge chunk without a newline advances the cursor', { options: { delegation: true } }, async ($, on) => {
  const seen = setup(on)
  const body = 'x'.repeat(300_000)
  const tails = externalTail(seen, on, () => body)
  await start($)
  await $.tool.call({ tool: 'mcp__harness__harness_delegate', tool_use_id: 'd', tasks: [{ task: 'Find a', prefer: 'codex' }] } as never)
  await seen.clock.advance(3500)
  expect(tails).toHaveLength(1)
  expect(tails[0]).toBe('+37857')
})

test('activity: evicting an agent drops its cursor', async () => {
  resetActivity()
  noteStep('old', 1)
  setCursor('old', 50)
  noteEnd('old', 2, true, 'ok')
  for (let i = 0; i < MAX_AGENTS; i += 1) noteStep(`n${i}`, 3 + i)
  expect(cursorOf('old')).toBe(0)
})
