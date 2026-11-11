import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { resetDelegation, waitWindowMs } from '../hooks/delegation'
import { parsePaneCommand, summarizeEvents } from '../hooks/panes-core'
import { wire } from './support'

const on_ = { options: { delegation: true, panes: true } }
const off_ = { options: { delegation: true } }
const start = ($: Engine) => $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive: true })
const call = ($: Engine, tool: string, input: Record<string, unknown>) =>
  $.tool.call({ tool: `mcp__harness__${tool}`, tool_use_id: `t-${tool}`, ...input } as never)
const command = ($: Engine, args: string) =>
  $.command.run({ command: 'harness', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

const EVENTS = '/state/runs/x1/events.jsonl'
const exitLine = (outcome: string, code: number, tail: string) => JSON.stringify({ t: 1, type: 'exit', code, outcome, tail })

type Seen = ReturnType<typeof wire>
function setup(on: Parameters<typeof wire>[0], files: Map<string, string> = new Map()) {
  resetDelegation()
  const seen = wire(on)
  const cli: { argv: string[]; stdin?: string }[] = []
  seen.runHook = async (argv, init) => {
    if (argv[0] === 'sleep') {
      await new Promise(resolve => setTimeout(resolve, 20))
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    if (argv[1] === 'panes') {
      cli.push({ argv: [...argv], stdin: init?.stdin })
      const sub = argv[2]
      if (sub === 'start') return { exitCode: 0, stdout: JSON.stringify({ runId: 'x1', status: 'started', host: argv.includes('background') ? 'background' : 'herdr', paneId: 'p-1', eventsFile: EVENTS }), stderr: '' }
      if (sub === 'close' && !argv.includes('--yes')) return { exitCode: 1, stdout: JSON.stringify({ ok: false, needsConfirm: true, message: 'carl is still running' }), stderr: '' }
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, message: `ran ${sub}` }), stderr: '' }
    }
    if (argv[0] === 'sh') return { exitCode: 0, stdout: '/bin/codex', stderr: '' }
    return undefined
  }
  on('fs.read', (_$, e) => ({ value: files.get((e as unknown as { path: string }).path) ?? '' }))
  return { seen: seen as Seen, cli, files }
}

test('summarizeEvents maps exit, interrupt and running states', () => {
  expect(summarizeEvents('').state).toBe('running')
  expect(summarizeEvents(`${exitLine('done', 0, 'ok')}\n`)).toMatchObject({ state: 'done', tail: 'ok' })
  expect(summarizeEvents(exitLine('timeout', 124, 'slow'))).toMatchObject({ state: 'failed', outcome: 'timeout' })
  expect(summarizeEvents(`{"type":"interrupted"}\n${exitLine('failed', 1, '')}`)).toMatchObject({ state: 'failed', outcome: 'interrupted' })
  expect(summarizeEvents('not json\n{"type":"out","line":"a"}\n{"type":"out","line":"b"}').tail).toBe('a\nb')
})

test('parsePaneCommand recognises the pane verbs only', () => {
  expect(parsePaneCommand('send carl hello  there')).toEqual({ verb: 'send', argv: ['carl', 'hello  there'] })
  expect(parsePaneCommand('tab my feature')).toEqual({ verb: 'tab', argv: ['my feature'] })
  expect(parsePaneCommand('layout save')).toEqual({ verb: 'layout', argv: ['save'] })
  expect(parsePaneCommand('review')).toBeNull()
  expect(parsePaneCommand('')).toBeNull()
})

test('panes: an external delegation goes to panes start with the judged CLI, model, effort and the passo 0 prompt', on_, async ($, on) => {
  const { cli } = setup(on)
  await start($)
  const out = await call($, 'harness_delegate', { tasks: [{ task: 'Find the config', prefer: 'codex' }] })
  const run = (JSON.parse(String(out.result)) as { runs: { worker: string; state: string; host: string }[] }).runs[0]!
  expect([run.worker, run.state, run.host]).toEqual(['codex', 'running', 'herdr'])
  const started = cli.find(c => c.argv[2] === 'start')!
  expect(started.argv).toContain('--stdin-prompt')
  expect(started.argv.slice(started.argv.indexOf('--cli'), started.argv.indexOf('--cli') + 2)).toEqual(['--cli', 'codex'])
  expect(started.argv).not.toContain('--host')
  expect(started.stdin?.startsWith('Passo 0:')).toBe(true)
})

test('panes: with the flag off the same worker runs in the background host', off_, async ($, on) => {
  const { cli } = setup(on)
  await start($)
  await call($, 'harness_delegate', { tasks: [{ task: 'Find the config', prefer: 'codex' }] })
  const started = cli.find(c => c.argv[2] === 'start')!
  expect(started.argv.slice(started.argv.indexOf('--host'), started.argv.indexOf('--host') + 2)).toEqual(['--host', 'background'])
})

test('panes: harness_wait reads events.jsonl and settles done and failed runs', on_, async ($, on) => {
  const { files } = setup(on)
  await start($)
  const out = await call($, 'harness_delegate', { tasks: [{ task: 'Find the config', prefer: 'codex' }] })
  const id = (JSON.parse(String(out.result)) as { runs: { runId: string }[] }).runs[0]!.runId
  files.set(EVENTS, `${exitLine('done', 0, 'found it')}\n`)
  const done = JSON.parse(String((await call($, 'harness_wait', { runIds: [id] })).result)) as { results: { state: string; result: string }[]; pending: string[] }
  expect(done.results[0]).toMatchObject({ state: 'done', result: 'found it' })
  expect(done.pending).toEqual([])
})

test('panes: harness_wait with several ids returns both as pending when none finishes', on_, async ($, on) => {
  const { seen } = setup(on)
  await start($)
  const out = await call($, 'harness_delegate', { tasks: [{ task: 'one', prefer: 'codex' }, { task: 'two', prefer: 'codex' }] })
  const ids = (JSON.parse(String(out.result)) as { runs: { runId: string }[] }).runs.map(r => r.runId)
  expect(ids).toHaveLength(2)
  const waiting = call($, 'harness_wait', { runIds: ids, timeoutMs: 3000 })
  await seen.clock.advance(4000)
  const body = JSON.parse(String((await waiting).result)) as { results: { state: string }[]; pending: string[] }
  expect(body.results.map(r => r.state)).toEqual(['running', 'running'])
  expect(body.pending).toEqual(ids)
})

test('waitWindowMs keeps the wait inside the hook budget', () => {
  expect(waitWindowMs(120_000, 10_000)).toBe(7_500)
  expect(waitWindowMs(3_000, 10_000)).toBe(3_000)
  expect(waitWindowMs(120_000, 1_000)).toBe(0)
  expect(waitWindowMs(120_000, Number.POSITIVE_INFINITY)).toBe(120_000)
})

test('summarizeEvents prefers the exit result over the tail', () => {
  const line = JSON.stringify({ t: 1, type: 'exit', code: 0, outcome: 'done', tail: 'noise', result: 'the answer' })
  expect(summarizeEvents(line)).toMatchObject({ state: 'done', tail: 'noise', result: 'the answer' })
})

test('panes: harness_wait returns the exit result and not the tail', on_, async ($, on) => {
  const { files } = setup(on)
  await start($)
  const out = await call($, 'harness_delegate', { tasks: [{ task: 'Find the config', prefer: 'codex' }] })
  const id = (JSON.parse(String(out.result)) as { runs: { runId: string }[] }).runs[0]!.runId
  files.set(EVENTS, `${JSON.stringify({ t: 1, type: 'exit', code: 0, outcome: 'done', tail: '', result: 'final answer' })}\n`)
  const done = JSON.parse(String((await call($, 'harness_wait', { runIds: [id] })).result)) as { results: { result: string }[] }
  expect(done.results[0]!.result).toBe('final answer')
})

test('panes: a timed out external run comes back failed with its outcome', on_, async ($, on) => {
  const { files } = setup(on)
  await start($)
  const out = await call($, 'harness_delegate', { tasks: [{ task: 'Find the config', prefer: 'codex' }] })
  const id = (JSON.parse(String(out.result)) as { runs: { runId: string }[] }).runs[0]!.runId
  files.set(EVENTS, `${exitLine('timeout', 124, 'stuck')}\n`)
  const body = JSON.parse(String((await call($, 'harness_wait', { runIds: [id] })).result)) as { results: { state: string; result: string }[] }
  expect(body.results[0]!.state).toBe('failed')
  expect(body.results[0]!.result).toContain('timeout')
})

test('panes: /harness close asks before killing and --yes confirms; focus, send, tab and layout reach the CLI', on_, async ($, on) => {
  const { cli } = setup(on)
  await start($)
  const refused = await command($, 'close carl')
  expect(JSON.stringify(refused)).toContain('--yes')
  await command($, 'close carl --yes')
  expect(cli.filter(c => c.argv[2] === 'close').map(c => c.argv.includes('--yes'))).toEqual([false, true])
  await command($, 'send carl keep going')
  expect(cli.find(c => c.argv[2] === 'send')!.argv.slice(2, 5)).toEqual(['send', 'carl', 'keep going'])
  await command($, 'focus carl')
  await command($, 'tab feature-x')
  await command($, 'layout restore')
  expect(cli.map(c => c.argv[2])).toEqual(['close', 'close', 'send', 'focus', 'tab', 'layout'])
  expect(cli.find(c => c.argv[2] === 'layout')!.argv.slice(2, 4)).toEqual(['layout', 'restore'])
})

test('panes: pane commands say the flag is off instead of running anything', off_, async ($, on) => {
  const { cli } = setup(on)
  await start($)
  const res = await command($, 'close carl')
  expect(JSON.stringify(res)).toContain('Panes are off')
  expect(cli).toHaveLength(0)
})

test('panes: aborting a turn kills the session external runs, and session end interrupts background ones', on_, async ($, on) => {
  const { cli } = setup(on)
  await start($)
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: true, turnId: 't1', reason: 'aborted' } as never)
  expect(cli.some(c => c.argv[2] === 'abort')).toBe(false)
  await call($, 'harness_delegate', { tasks: [{ task: 'Find the config', prefer: 'codex' }] })
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: true, turnId: 't1', reason: 'aborted' } as never)
  expect(cli.some(c => c.argv[2] === 'abort' && c.argv.includes('--session') && !c.argv.includes('--background-only'))).toBe(true)
  await $.session.end({ reason: 'exit', sessionId: 'sess-1' } as never)
  expect(cli.some(c => c.argv[2] === 'abort' && c.argv.includes('--background-only'))).toBe(true)
  expect(cli.some(c => c.argv[2] === 'detach' && c.argv.includes('--session'))).toBe(true)
})
