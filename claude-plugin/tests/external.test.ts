import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, TurnStepChunk, TurnStepResult } from 'claude-code'

import {
  AGENT_DESCRIPTION,
  AGENT_PROMPT,
  HOOK_BUDGET_MS,
  ENGINE,
  FILTER,
  RUNNER,
  SCRIPTS,
  agentSpec,
  budgetFor,
  cleanupAgent,
  codexArgv,
  composeReport,
  createExternal,
  externalRefusal,
  externalStep,
  filterDrivers,
  filterOverrides,
  gitArgv,
  handbackFacts,
  mapCodexLine,
  maxMinutesOf,
  parseModelLine,
  signature,
  spawnDenial,
  stateDirOf,
} from '../hooks/external'
import type { AgentState, CodexEvent, External, Ports, RunInit, StateEnv } from '../hooks/external'
import { EDIT, FAILED, READ } from './fixtures/codex'
import { CWD, finish, wire } from './support'
import type { Seen } from './support'

const PROGRESS = 'mcp__harness__codex_progress'
const STATE = '/state'
const REPO = '/work/demo'
const HEAD = 'abc1234def5678abc1234def5678abc1234def56'
const BASE = '9999999def5678abc1234def5678abc1234def56'
const THREAD = '01a118dd-652a-7780-8e55-1beb581eae54'
const GIT_MARK = 'umask 077; exec "$@"'

type Done = { exitCode: number; stdout: string; stderr: string }

type GitCall = { args: string[]; env: string[]; dir: string; timeoutMs: number | undefined }

type Fake = {
  repo: string | null
  stat: string
  killResult: string
  failGit: string | null
  throwTail: boolean
  alive: boolean
  stderr: string
  rollout: string
  git: GitCall[]
  writes: Map<string, string>
  mkdirs: string[]
  copies: string[][]
  removed: string[]
  started: string[][]
  kills: string[][]
  leases: string[]
  rollouts: string[]
  patches: string[]
  file: string[]
  batches: string[][]
  tails: number
  pending: number
  overlap: number
  delay: number
  handle: (argv: string[], init: RunInit | undefined) => Promise<Done | undefined>
}

const out = (stdout = '', exitCode = 0, stderr = ''): Done => ({ exitCode, stdout, stderr })

function newFake(): Fake {
  const fake: Fake = {
    repo: REPO,
    stat: '',
    killResult: 'gone',
    failGit: null,
    throwTail: false,
    alive: true,
    stderr: '',
    rollout: '',
    git: [],
    writes: new Map(),
    mkdirs: [],
    copies: [],
    removed: [],
    started: [],
    kills: [],
    leases: [],
    rollouts: [],
    patches: [],
    file: [],
    batches: [],
    tails: 0,
    pending: 0,
    overlap: 0,
    delay: 0,
    handle: async () => undefined,
  }
  fake.handle = async (argv, init) => {
    if (argv[0] !== 'sh' || argv[1] !== '-c') return undefined
    const script = argv[2]
    const args = argv.slice(4)
    for (let turn = 0; turn < fake.delay; turn += 1) await Promise.resolve()
    if (script === GIT_MARK) {
      const at = argv.indexOf('git', 5)
      const env = argv.slice(5, at)
      let gargs = argv.slice(at + 3)
      let dir = ''
      if (gargs[0] === '-C') {
        dir = gargs[1] ?? ''
        gargs = gargs.slice(2)
      }
      fake.git.push({ args: gargs, env, dir, timeoutMs: init?.timeoutMs })
      const sub = gargs.find(arg => !arg.startsWith('-') && !arg.includes('=')) ?? ''
      if (gargs.includes('--show-toplevel')) {
        fake.pending += 1
        fake.overlap = Math.max(fake.overlap, fake.pending)
        return fake.repo === null ? out('', 128, 'fatal: not a git repository') : out(`${fake.repo}\n`)
      }
      if (fake.failGit === sub) return out('', 1, 'boom')
      if (sub === 'rev-parse') return out(`${dir === fake.repo ? HEAD : BASE}\n`)
      if (sub === 'config') return out('filter.fake.smudge\nfilter.fake.required\n')
      if (sub === 'diff' && gargs.includes('--stat')) return out(fake.stat)
      if (sub === 'diff') {
        fake.patches.push(gargs.find(arg => arg.startsWith('--output=')) ?? '')
        return out()
      }
      return out()
    }
    if (script === SCRIPTS.mkdir) {
      fake.mkdirs.push(args[0] ?? '')
      return out()
    }
    if (script === SCRIPTS.write) {
      fake.writes.set(args[1] ?? '', init?.stdin ?? '')
      return out()
    }
    if (script === SCRIPTS.copy) {
      fake.copies.push(args)
      if (args[1]?.endsWith('/pristine.git')) fake.pending -= 1
      return out()
    }
    if (script === SCRIPTS.remove) {
      fake.removed.push(args[0] ?? '')
      return out()
    }
    if (script === SCRIPTS.start) {
      fake.started.push(args)
      return out('4242\n7777\n')
    }
    if (script === SCRIPTS.tail) {
      fake.tails += 1
      fake.leases.push(args[3] ?? '')
      if (fake.throwTail) throw new Error('tail down')
      const batch = fake.batches.shift()
      if (batch !== undefined) fake.file.push(...batch)
      const text = fake.file.slice(Number(args[1]) - 1)
      const body = text.length === 0 ? '' : `${text.join('\n')}\n`
      return out(fake.alive ? body : `${body}\n{"type":"harness.exited"}\n`)
    }
    if (script === SCRIPTS.kill) {
      fake.kills.push(args)
      return out(`${fake.killResult}\n`)
    }
    if (script === SCRIPTS.stderr) return out(fake.stderr)
    if (script === SCRIPTS.rollout) {
      fake.rollouts.push(args[0] ?? '')
      return fake.rollout === '' ? out('', 1) : out(fake.rollout)
    }
    return undefined
  }
  return fake
}

const gitSub = (call: GitCall) => call.args.find(arg => !arg.startsWith('-') && !arg.includes('=')) ?? ''
const gitSubs = (fake: Fake) => fake.git.map(gitSub)
const callsOf = (fake: Fake, sub: string) => fake.git.filter(call => gitSub(call) === sub)
const runDirOf = (fake: Fake) => (fake.started[0]?.[1] ?? '')

function freshState(prompt: string): AgentState {
  return { prompt, cwd: null, runs: 0, deliveries: 0, run: null, delivered: null, lastReport: '', used: false }
}

type Harness = {
  fake: Fake
  store: Map<string, AgentState>
  notes: string[]
  ext: External
  ports: Ports
  clock: { t: number }
  messages: string[]
  exists: Set<string>
  fails: { save: number }
  step: (agentId: string, remaining?: () => number, signal?: AbortSignal) => Promise<{ chunks: TurnStepChunk[]; result: TurnStepResult }>
  drain: (agentId: string) => Promise<{ chunks: TurnStepChunk[]; result: TurnStepResult; steps: number }>
}

function harness(over: Partial<Ports> = {}, env: StateEnv = { stateDir: STATE, home: '/home/user' }): Harness {
  const fake = newFake()
  const store = new Map<string, AgentState>()
  const notes: string[] = []
  const clock = { t: 1_000_000 }
  const messages = ['task']
  const exists = new Set<string>()
  const fails = { save: 0 }
  const ports: Ports = {
    run: async (argv, init) => (await fake.handle([...argv], init)) ?? out(),
    now: async () => clock.t,
    sleep: async (ms, signal) => {
      if (signal.aborted) throw new Error('aborted')
      clock.t += ms
    },
    cwd: async () => REPO,
    env: async () => env,
    readText: async () => {
      throw new Error('missing')
    },
    exists: async path => exists.has(path),
    userTexts: async () => messages,
    agentType: async () => 'harness:codex',
    loadState: async id => {
      const found = store.get(id)
      return found === undefined ? null : (JSON.parse(JSON.stringify(found)) as AgentState)
    },
    saveState: async (id, value) => {
      if (fails.save > 0 && value !== null && value.run !== null) {
        fails.save -= 1
        throw new Error('save down')
      }
      if (value === null) store.delete(id)
      else store.set(id, JSON.parse(JSON.stringify(value)) as AgentState)
    },
    sessionAgents: async () => [...store.keys()],
    notify: text => {
      notes.push(text)
    },
    ...over,
  }
  const ext = createExternal(30)
  const step: Harness['step'] = async (agentId, remaining = () => Number.POSITIVE_INFINITY, signal = new AbortController().signal) => {
    const stream = externalStep(ports, ext, { turnId: 't', index: 0 }, agentId, signal, remaining)
    const chunks: TurnStepChunk[] = []
    for (;;) {
      const next = await stream.next()
      if (next.done) return { chunks, result: next.value }
      chunks.push(next.value)
    }
  }
  const drain: Harness['drain'] = async agentId => {
    const all: TurnStepChunk[] = []
    for (let steps = 1; steps < 60; steps += 1) {
      const { chunks, result } = await step(agentId)
      all.push(...chunks)
      if (result.stopReason === 'end_turn') return { chunks: all, result, steps }
    }
    throw new Error('never ended')
  }
  return { fake, store, notes, ext, ports, clock, messages, exists, fails, step, drain }
}

function textBlocks(chunks: TurnStepChunk[]): string[] {
  const blocks = new Map<number, string>()
  for (const chunk of chunks) {
    if (chunk.kind === 'text') blocks.set(chunk.index, (blocks.get(chunk.index) ?? '') + chunk.text)
  }
  return [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(entry => entry[1])
}

const lastBlock = (chunks: TurnStepChunk[]) => textBlocks(chunks).at(-1) ?? ''
const toolNames = (chunks: TurnStepChunk[]) => chunks.flatMap(chunk => (chunk.kind === 'tool' ? [chunk.name] : []))
const eventsOf = (lines: readonly string[]): CodexEvent[] => lines.flatMap(line => mapCodexLine(line))
const readyHarness = (prompt = 'Read note.txt', id = 'agent-1') => {
  const h = harness()
  h.store.set(id, freshState(prompt))
  return h
}

test('the read fixture maps to thread, narration, command note, answer, usage and end', () => {
  expect(eventsOf(READ)).toEqual([
    { k: 'thread', id: '01a118dc-ab47-7000-aaf3-6b7134d87795' },
    { k: 'text', t: 'I’ll read `note.txt`.\n' },
    { k: 'note', t: '▸ cat note.txt' },
    { k: 'text', t: 'hello fixture' },
    { k: 'usage', i: 23983, o: 49, cr: 18304, cw: 0 },
    { k: 'end' },
  ])
})

test('the edit fixture maps a file change note, a shell note, the answer and usage', () => {
  const events = eventsOf(EDIT)
  expect(events[0]).toEqual({ k: 'thread', id: THREAD })
  const notes = events.flatMap(event => (event.k === 'note' ? [event.t] : []))
  expect(notes).toHaveLength(2)
  expect(notes[0]).toMatch(/^▸ sed -n '1,240p'/)
  expect(notes[1]).toBe('▸ add /work/demo/cx2/hello.txt')
  expect(events).toContainEqual({ k: 'text', t: 'Deu certo: `hello.txt` criado com `hi`.' })
  expect(events.at(-2)).toEqual({ k: 'usage', i: 22497, o: 333, cr: 40448, cw: 0 })
  expect(events.at(-1)).toEqual({ k: 'end' })
})

test('the failed fixture maps the plain error, a failed marker and end, ignoring item warnings', () => {
  const events = eventsOf(FAILED)
  expect(events.filter(event => event.k === 'text')).toEqual([])
  expect(events).toContainEqual({
    k: 'error',
    t: "The 'not-a-real-model-xyz' model is not supported when using Codex with a ChatGPT account.",
  })
  expect(events.slice(-2)).toEqual([{ k: 'failed' }, { k: 'end' }])
})

test('reasoning, a model field and unknown or broken lines never throw and unknown ones map to nothing', () => {
  expect(mapCodexLine('{"type":"item.completed","item":{"id":"i","type":"reasoning","text":"thinking it over"}}')).toEqual([
    { k: 'thinking', t: 'thinking it over' },
  ])
  expect(mapCodexLine('{"type":"thread.started","thread_id":"t1","model":"gpt-x"}')).toEqual([
    { k: 'model', model: 'gpt-x' },
    { k: 'thread', id: 't1' },
  ])
  for (const line of [
    'not json',
    '',
    '[]',
    'null',
    '{"type":"mystery"}',
    '{"type":"item.completed","item":{"type":"future_thing"}}',
    '{"type":"item.started","item":{"type":"command_execution"}}',
    '{"type":"turn.started"}',
  ]) {
    expect(mapCodexLine(line)).toEqual([])
  }
})

test('codex-model on the first line is parsed and anything unsafe is rejected', () => {
  expect(parseModelLine('codex-model: gpt-5.6-terra\nFix the bug')).toEqual({ prompt: 'Fix the bug', model: 'gpt-5.6-terra' })
  expect(parseModelLine('\n  Codex-Model:openai/o3:high@v1+x\nDo it')).toEqual({ prompt: 'Do it', model: 'openai/o3:high@v1+x' })
  expect(parseModelLine('Fix the bug')).toEqual({ prompt: 'Fix the bug' })
  expect(parseModelLine('Fix it\ncodex-model: gpt-5')).toEqual({ prompt: 'Fix it\ncodex-model: gpt-5' })
  for (const bad of ['--dangerously-bypass', '-m', 'a b', '$(touch x)', 'x;y', '`id`', 'a|b', "a'b", 'x'.repeat(65), '']) {
    expect(parseModelLine(`codex-model: ${bad}\nDo it`)).toEqual({ prompt: 'Do it', rejected: bad })
  }
})

test('a pathological first line costs linear time and is rejected', () => {
  const hostile = `codex-model: a${' '.repeat(120_000)}b\nDo it`
  const started = Date.now()
  const parsed = parseModelLine(hostile)
  expect(Date.now() - started).toBeLessThan(500)
  expect(parsed.rejected).toBeDefined()
  expect((parsed.rejected ?? '').length).toBeLessThanOrEqual(80)
  expect(parsed.prompt).toBe('Do it')
})

test('the codex argv pins every sandbox flag explicitly, drops user config and reads the prompt from stdin', () => {
  expect(codexArgv('/state/wt', '/state/tmp', undefined)).toEqual([
    'codex', 'exec', '--json', '--skip-git-repo-check', '--ignore-user-config', '-C', '/state/wt', '-s', 'workspace-write',
    '-c', 'sandbox_workspace_write.exclude_slash_tmp=true',
    '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
    '-c', 'sandbox_workspace_write.network_access=false',
    '-c', 'sandbox_workspace_write.writable_roots=[]',
    '--add-dir', '/state/tmp', '-',
  ])
  const withModel = codexArgv('/w', '/t', 'gpt-5.6-terra')
  expect(withModel.slice(-4)).toEqual(['/t', '-m', 'gpt-5.6-terra', '-'])
  expect(withModel).not.toContain('--')
  expect(withModel.join(' ')).not.toContain('Do it')
})

test('the engine budget dependency is a literal type and the step fits inside it', () => {
  expect(HOOK_BUDGET_MS).toBe(10_000)
  expect(ENGINE.stepBudgetMs + ENGINE.budgetMarginMs).toBeLessThanOrEqual(HOOK_BUDGET_MS)
  expect(budgetFor(Infinity)).toBe(ENGINE.stepBudgetMs)
  expect(budgetFor(10_000)).toBe(ENGINE.stepBudgetMs)
  expect(budgetFor(4_000)).toBe(1_500)
  expect(budgetFor(1_000)).toBe(0)
  expect(ENGINE.handbackTool).toBe('SubagentHandback')
  expect(ENGINE.bouncePrefix).toBe('[handback-send-enforce]')
})

test('composeReport and signature never invent a model', () => {
  expect(signature({ model: 'gpt-x', requested: 'gpt-y' })).toBe('— answered by codex, gpt-x')
  expect(signature({ model: '', requested: 'gpt-y' })).toBe('— answered by codex, requested gpt-y, unconfirmed')
  expect(signature({ model: '', requested: null })).toBe('— answered by codex, unknown model')
  expect(composeReport({ answer: 'done', failure: '', notes: '', footer: 'Patch: p', signature: '— s' })).toBe('done\n\nPatch: p\n\n— s')
  expect(composeReport({ answer: '', failure: 'ended with no answer', notes: '', footer: 'Patch: p', signature: '— s' })).toBe(
    'ended with no answer\n\nPatch: p',
  )
})

test('the fallback agent spec carries no write tools and its prompt refuses to work', () => {
  const spec = agentSpec(PROGRESS)
  expect(spec.model).toBe('haiku')
  expect([...spec.tools].sort()).toEqual([PROGRESS, 'SubagentHandback'].sort())
  for (const tool of ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Agent']) expect(spec.tools).not.toContain(tool)
  expect(AGENT_PROMPT).toContain('NOT Codex')
  expect(AGENT_PROMPT).toContain('do not use any tools')
  expect(AGENT_PROMPT).toContain('function hooks are not active')
  expect(AGENT_PROMPT).toContain('Codex did not run')
  expect(AGENT_DESCRIPTION).toContain('— answered by codex, <model>')
  expect(AGENT_DESCRIPTION).toContain('uncommitted work is absent')
  expect(AGENT_DESCRIPTION).toContain('Reads are not restricted')
})

test('the spawn gate refuses plan mode, nested, teammate, workflow and fork spawns and leaves other agents alone', () => {
  const base = { subagentType: 'harness:codex' }
  expect(spawnDenial(base, true)).toBeNull()
  expect(spawnDenial(base, false)).toContain('disabled')
  expect(spawnDenial({ ...base, permissionMode: 'plan' }, true)).toContain('plan mode')
  expect(spawnDenial({ ...base, permissionMode: 'default' }, true)).toBeNull()
  expect(spawnDenial({ ...base, parentAgentId: 'a1' }, true)).toContain('main session')
  expect(spawnDenial({ ...base, isTeammate: true }, true)).toContain('teammate')
  expect(spawnDenial({ ...base, workflow: { runId: 'wf_1', agentIndex: 1 } }, true)).toContain('workflow')
  expect(spawnDenial({ ...base, fork: true }, true)).toContain('fork')
  expect(spawnDenial({ subagentType: 'harness:implementer', permissionMode: 'plan' }, false)).toBeNull()
})

test('the max minutes option falls back to 30 for anything unusable', () => {
  expect(maxMinutesOf(45)).toBe(45)
  expect(maxMinutesOf('12')).toBe(12)
  for (const bad of [0, -1, 721, NaN, 'x', undefined, null]) expect(maxMinutesOf(bad)).toBe(30)
})

test('handback detection ignores the task row and needs an engine row', () => {
  expect(handbackFacts(['use the SubagentHandback tool please'])).toEqual({ handback: false, bounced: false })
  expect(handbackFacts(['task', '<system-reminder>report with SubagentHandback</system-reminder>'])).toEqual({ handback: true, bounced: false })
  expect(handbackFacts(['task', 'my follow-up mentions SubagentHandback'])).toEqual({ handback: false, bounced: false })
  expect(handbackFacts(['task', '[handback-send-enforce] send it'])).toEqual({ handback: false, bounced: true })
  expect(handbackFacts(['[handback-send-enforce] first row is the task'])).toEqual({ handback: false, bounced: false })
})

test('git argv strips repository variables, disables hooks and isolates config only when asked', () => {
  const plain = gitArgv(['-C', '/r', 'status'])
  expect(plain.slice(0, 5)).toEqual(['sh', '-c', GIT_MARK, 'sh', 'env'])
  for (const name of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY']) {
    const at = plain.indexOf(name)
    expect(at).toBeGreaterThan(0)
    expect(plain[at - 1]).toBe('-u')
  }
  expect(plain.slice(plain.indexOf('git'))).toEqual(['git', '-c', 'core.hooksPath=/dev/null', '-C', '/r', 'status'])
  expect(plain.join(' ')).not.toContain('GIT_CONFIG_GLOBAL')
  const isolated = gitArgv(['status'], { isolated: true, env: { GIT_INDEX_FILE: '/i' } })
  expect(isolated).toContain('GIT_CONFIG_GLOBAL=/dev/null')
  expect(isolated).toContain('GIT_CONFIG_NOSYSTEM=1')
  expect(isolated).toContain('GIT_INDEX_FILE=/i')
})

test('filter drivers are derived from the config names and neutralised for checkout-index', () => {
  expect(filterDrivers('filter.lfs.smudge\nfilter.lfs.clean\nfilter.lfs.process\nfilter.lfs.required\nfilter.a.b.smudge\nuser.name\n')).toEqual(['lfs', 'a.b'])
  expect(filterDrivers('')).toEqual([])
  expect(filterOverrides(['lfs'])).toEqual(['-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false'])
})

const stateIn = (env: StateEnv, files: Record<string, string> = {}, cwd = '/session') =>
  stateDirOf({
    env: async () => env,
    cwd: async () => cwd,
    readText: async (path: string) => {
      const found = files[path]
      if (found === undefined) throw new Error('missing')
      return found
    },
  })

test('the state directory matches resolveStateDir: explicit, plugin, guard, tool env and legacy', async () => {
  expect(await stateIn({ stateDir: '/explicit/', home: '/h' })).toBe('/explicit')
  expect(await stateIn({ stateDir: 'rel/dir', home: '/h' }, {}, '/session')).toBe('/session/rel/dir')
  expect(await stateIn({ stateDir: '~/s', home: '/h' })).toBe('/h/s')
  expect(await stateIn({ stateDir: 'relative', pluginStateDir: '/plugin', home: '/h' })).toBe('/session/relative')
  expect(await stateIn({ pluginStateDir: '/plugin', pluginId: 'other', home: '/h' })).toBe('/h/.local/state/herdr-jev')
  expect(await stateIn({ pluginStateDir: '/plugin', pluginId: 'herdr-jev', home: '/h' })).toBe('/plugin')
  expect(await stateIn({ pluginStateDir: 'p/x', home: '/h' })).toBe('/session/p/x')
  expect(await stateIn({ home: '/h' })).toBe('/h/.local/state/herdr-jev')
  const toolEnv = (stateDir: string) => ({ '/h/.local/share/ai-harness/generated/tool-env.json': JSON.stringify({ tools: { 'herdr-jev': { stateDir } } }) })
  expect(await stateIn({ home: '/h' }, toolEnv('~/.state/jev'))).toBe('/h/.state/jev')
  expect(await stateIn({ home: '/h' }, toolEnv('relative'))).toBe('/h/.local/state/herdr-jev')
  expect(await stateIn({ home: '/h' }, toolEnv('/h/.local/state/herdr-jev'))).toBe('/h/.local/state/herdr-jev')
  expect(await stateIn({ home: '/h', generatedDir: '/gen' }, { '/gen/tool-env.json': 'not json' })).toBe('/h/.local/state/herdr-jev')
  await expect(stateIn({ home: '/h', testGuard: '1' })).rejects.toThrow('state_dir_required_in_tests')
  await expect(stateIn({ home: '/h', aiHarnessTestGuard: '1' })).rejects.toThrow('state_dir_required_in_tests')
  expect(await stateIn({ home: '/h', testGuard: '1', stateDir: '/explicit' })).toBe('/explicit')
})

test('a run without changes streams notes, signs the confirmed model and removes the copy', async () => {
  const h = readyHarness('codex-model: gpt-5.6-terra\nRead note.txt')
  h.fake.batches = [[...READ.slice(0, 4)], [...READ.slice(4)]]
  h.fake.rollout = JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6.1-sol' } })
  const { chunks, result } = await h.drain('agent-1')
  const dir = runDirOf(h.fake)
  expect(dir).toMatch(new RegExp(`^${STATE}/codex-runs/agent1-`))
  const call = h.fake.started[0] ?? []
  expect(call.slice(7)).toEqual(codexArgv(`${dir}/work`, `${dir}/tmp`, 'gpt-5.6-terra'))
  expect(call[0]).toBe(`${dir}/runner.sh`)
  expect(call[4]).toBe(String(30 * 60))
  expect(call[5]).toBe(`${dir}/lease`)
  expect(call[6]).toBe(FILTER)
  expect(h.fake.writes.get(`${dir}/prompt`)).toBe('Read note.txt')
  expect(h.fake.writes.get(`${dir}/runner.sh`)).toBe(RUNNER)
  const blocks = textBlocks(chunks)
  expect(blocks[0]).toContain('▸ cat note.txt')
  expect(blocks[0]).not.toContain('hello fixture')
  const report = blocks.at(-1) ?? ''
  expect(report.startsWith('hello fixture')).toBe(true)
  expect(report).toContain('Codex made no changes; the throwaway copy was removed.')
  expect(report.endsWith('— answered by codex, gpt-6.1-sol')).toBe(true)
  expect(h.fake.removed).toContain(dir)
  expect(h.fake.patches).toEqual([])
  expect(result.stopReason).toBe('end_turn')
  expect(h.store.get('agent-1')?.run).toBeNull()
  expect(h.fake.rollouts).toEqual(['01a118dc-ab47-7000-aaf3-6b7134d87795'])
})

test('a run with changes writes a patch outside the repo, keeps no branch and reports stat and the apply command', async () => {
  const h = readyHarness('Create hello.txt')
  h.fake.batches = [[...EDIT]]
  h.fake.stat = ' hello.txt | 1 +\n 1 file changed, 1 insertion(+)'
  const { chunks } = await h.drain('agent-1')
  const dir = runDirOf(h.fake)
  const patch = h.fake.patches[0] ?? ''
  expect(patch).toMatch(new RegExp(`^--output=${STATE}/codex-patches/agent1-.*\\.patch$`))
  const path = patch.slice('--output='.length)
  const report = lastBlock(chunks)
  expect(report).toContain(`Patch (mode 0600): ${path}`)
  expect(report).toContain(`Check it first with: git -C '${REPO}' apply --stat --check '${path}'`)
  expect(report).toContain(`Then apply it with: git -C '${REPO}' apply '${path}'`)
  expect(report.indexOf('--stat --check')).toBeLessThan(report.indexOf('Then apply it with'))
  expect(report).toContain('computed against HEAD')
  expect(report).toContain('may add files and symlinks')
  expect(report).toContain('uncommitted work was not in the copy')
  expect(report).toContain('hello.txt | 1 +')
  expect(report).toContain('— answered by codex, unknown model')
  expect(h.fake.removed).toContain(dir)
  const subs = gitSubs(h.fake)
  expect(subs).not.toContain('worktree')
  expect(subs).not.toContain('branch')
  expect(subs).not.toContain('clone')
  const diff = callsOf(h.fake, 'diff').at(-1)
  expect(diff?.args).toEqual(expect.arrayContaining(['--cached', '--binary', '--no-ext-diff', '--no-textconv', BASE]))
  expect(diff?.dir).toBe(`${dir}/work`)
  expect(h.fake.copies).toContainEqual([`${dir}/pristine.git`, `${dir}/work/.git`])
})

test('export sequence uses a temporary index, neutral filters, a fixed identity and strips repository variables on every git call', async () => {
  const h = readyHarness()
  h.fake.batches = [[...READ]]
  await h.drain('agent-1')
  const dir = runDirOf(h.fake)
  const subs = gitSubs(h.fake)
  const order = ['rev-parse', 'rev-parse', 'config', 'read-tree', 'checkout-index', 'init', 'add', 'commit', 'rev-parse']
  expect(subs.slice(0, order.length)).toEqual(order)
  for (const call of h.fake.git) {
    for (const name of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY']) {
      expect(call.env).toContain(name)
    }
    expect(call.timeoutMs ?? 0).toBeGreaterThanOrEqual(120_000)
  }
  const readTree = callsOf(h.fake, 'read-tree')[0]
  expect(readTree?.env).toContain(`GIT_INDEX_FILE=${dir}/export.index`)
  expect(readTree?.dir).toBe(REPO)
  const checkout = callsOf(h.fake, 'checkout-index')[0]
  expect(checkout?.env).toContain(`GIT_INDEX_FILE=${dir}/export.index`)
  expect(checkout?.args).toEqual(
    expect.arrayContaining(['core.autocrlf=false', 'filter.fake.smudge=', 'filter.fake.process=', 'filter.fake.required=false', `--prefix=${dir}/work/`]),
  )
  expect(checkout?.env).not.toContain('GIT_CONFIG_GLOBAL=/dev/null')
  const init = callsOf(h.fake, 'init')[0]
  expect(init?.args).toEqual(['init', '-q', '--template=', `${dir}/work`])
  const commit = callsOf(h.fake, 'commit')[0]
  expect(commit?.env).toEqual(expect.arrayContaining(['GIT_CONFIG_GLOBAL=/dev/null', 'GIT_CONFIG_NOSYSTEM=1', 'GIT_AUTHOR_NAME=codex-base', 'GIT_COMMITTER_NAME=codex-base']))
  expect(commit?.args).toEqual(expect.arrayContaining(['commit.gpgsign=false', '--no-verify']))
  expect(commit?.dir).toBe(`${dir}/work`)
  for (const call of h.fake.git.filter(one => one.dir === `${dir}/work`)) expect(call.env).toContain('GIT_CONFIG_NOSYSTEM=1')
})

test('outside a git repository codex refuses and nothing is created or started', async () => {
  const h = readyHarness()
  h.fake.repo = null
  const { chunks } = await h.step('agent-1')
  expect(lastBlock(chunks)).toContain('harness:codex did not run:')
  expect(lastBlock(chunks)).toContain('not inside a git repository')
  expect(h.fake.started).toEqual([])
  expect(h.fake.mkdirs).toEqual([])
  expect(h.fake.writes.size).toBe(0)
  expect(lastBlock(chunks)).not.toContain('answered by codex')
})

test('a taken run directory gets a suffix', async () => {
  const h = readyHarness()
  h.fake.batches = [[...READ]]
  h.ports.exists = async () => true
  await h.drain('agent-1')
  expect(runDirOf(h.fake).endsWith('-2')).toBe(true)
})

test('a failed export removes the partial directory and starts nothing', async () => {
  const h = readyHarness()
  h.fake.failGit = 'checkout-index'
  const { chunks } = await h.step('agent-1')
  expect(lastBlock(chunks)).toContain('git checkout-index failed')
  expect(h.fake.started).toEqual([])
  expect(h.fake.removed.length).toBe(1)
  expect(h.fake.removed[0]).toMatch(new RegExp(`^${STATE}/codex-runs/agent1-`))
})

test('two concurrent exports never overlap', async () => {
  const h = harness()
  h.store.set('a-1', freshState('one'))
  h.store.set('a-2', freshState('two'))
  h.fake.delay = 20
  h.fake.batches = [[...READ], [...READ]]
  await Promise.all([h.step('a-1'), h.step('a-2')])
  expect(h.fake.overlap).toBe(1)
  expect(h.fake.started).toHaveLength(2)
})

test('an unsafe codex-model line and an empty prompt refuse before anything is created', async () => {
  const unsafe = readyHarness('codex-model: --sandbox danger-full-access\nDo it')
  expect(lastBlock((await unsafe.step('agent-1')).chunks)).toContain('not an accepted model id')
  expect(unsafe.fake.git).toEqual([])
  const empty = readyHarness('codex-model: gpt-5\n')
  expect(lastBlock((await empty.step('agent-1')).chunks)).toContain('prompt is empty')
  expect(empty.fake.started).toEqual([])
})

test('a missing progress tool refuses instead of running something that cannot be continued', async () => {
  const h = readyHarness()
  h.ext.progressTool = ''
  const { chunks } = await h.step('agent-1')
  expect(lastBlock(chunks)).toContain('progress tool is not registered')
  expect(h.fake.started).toEqual([])
  expect(h.fake.git).toEqual([])
})

test('a step that outlives the budget ends on the progress tool, touches the lease and the next step continues the same run', async () => {
  const h = readyHarness()
  h.fake.batches = [...Array.from({ length: 80 }, () => [] as string[]), [...READ]]
  const first = await h.step('agent-1')
  expect(first.result.stopReason).toBe('tool_use')
  expect(first.result.toolUses).toEqual([{ name: PROGRESS, input: {} }])
  expect(toolNames(first.chunks)).toEqual([PROGRESS])
  expect(h.fake.started).toHaveLength(1)
  expect(h.clock.t - 1_000_000).toBeGreaterThanOrEqual(ENGINE.stepBudgetMs)
  expect(h.clock.t - 1_000_000).toBeLessThan(HOOK_BUDGET_MS)
  expect(h.fake.leases.length).toBeGreaterThan(30)
  expect(new Set(h.fake.leases)).toEqual(new Set([`${runDirOf(h.fake)}/lease`]))
  const saved = h.store.get('agent-1')
  expect(saved?.run?.pid).toBe('4242')
  expect(saved?.run?.start).toBe('7777')
  expect(saved?.run?.read).toBeGreaterThanOrEqual(0)

  const rest = await h.drain('agent-1')
  expect(h.fake.started).toHaveLength(1)
  expect(rest.result.stopReason).toBe('end_turn')
  expect(lastBlock(rest.chunks).startsWith('hello fixture')).toBe(true)
  expect(lastBlock(rest.chunks).endsWith('— answered by codex, unknown model')).toBe(true)
})

test('run state lives in the store: a second External continues the run the first one started', async () => {
  const h = readyHarness()
  h.fake.batches = [...Array.from({ length: 80 }, () => [] as string[]), [...READ]]
  await h.step('agent-1')
  expect(h.fake.started).toHaveLength(1)
  const reloaded = createExternal(30)
  const stream = externalStep(h.ports, reloaded, { turnId: 't', index: 1 }, 'agent-1', new AbortController().signal, () => Number.POSITIVE_INFINITY)
  let result: TurnStepResult | undefined
  for (;;) {
    const next = await stream.next()
    if (next.done) {
      result = next.value
      break
    }
  }
  expect(h.fake.started).toHaveLength(1)
  expect(result?.stopReason === 'tool_use' || result?.stopReason === 'end_turn').toBe(true)
})

test('the step budget reads the remaining time live and never the first snapshot', async () => {
  const slow = readyHarness()
  slow.fake.batches = Array.from({ length: 80 }, () => [] as string[])
  await slow.step('agent-1')
  const full = slow.fake.tails
  expect(full).toBeGreaterThan(30)

  const live = readyHarness()
  live.fake.batches = Array.from({ length: 80 }, () => [] as string[])
  await live.step('agent-1', () => (live.clock.t > 1_000_000 + 1_000 ? 100 : 10_000))
  expect(live.fake.tails).toBeLessThan(12)

  const snapshot = readyHarness()
  snapshot.fake.batches = Array.from({ length: 80 }, () => [] as string[])
  await snapshot.step('agent-1', () => 3_000)
  expect(snapshot.fake.tails).toBeLessThan(8)
})

test('a codex that exits with no answer reports its stderr tail without provenance and removes the copy', async () => {
  const h = readyHarness()
  h.fake.alive = false
  h.fake.batches = [[`{"type":"thread.started","thread_id":"${THREAD}"}`]]
  h.fake.stderr = '\u001b[31merror:\u001b[0m codex: command not found\nsecond line\n'
  const { chunks, result } = await h.drain('agent-1')
  const report = lastBlock(chunks)
  expect(report).toContain('Codex ended with no answer.')
  expect(report).toContain('error: codex: command not found')
  expect(report).not.toContain('\u001b')
  expect(report).not.toContain('answered by codex')
  expect(result.stopReason).toBe('end_turn')
  expect(h.fake.removed).toContain(runDirOf(h.fake))
})

test('an answer followed by a failed turn keeps the answer, notes the error and still signs', async () => {
  const h = readyHarness()
  h.fake.batches = [
    [
      `{"type":"thread.started","thread_id":"${THREAD}","model":"gpt-x"}`,
      '{"type":"item.completed","item":{"type":"agent_message","text":"partial answer"}}',
      '{"type":"turn.failed","error":{"message":"{\\"detail\\":\\"quota exceeded\\"}"}}',
    ],
  ]
  const { chunks } = await h.drain('agent-1')
  const report = lastBlock(chunks)
  expect(report.startsWith('partial answer')).toBe(true)
  expect(report).toContain('Codex reported an error after this answer: quota exceeded')
  expect(report.endsWith('— answered by codex, gpt-x')).toBe(true)
})

test('a failed turn alone reports the plain error without provenance', async () => {
  const h = readyHarness('codex-model: gpt-5\nDo it')
  h.fake.batches = [[...FAILED]]
  const { chunks } = await h.drain('agent-1')
  const report = lastBlock(chunks)
  expect(report).toContain('Codex ended with no answer.')
  expect(report).toContain('model is not supported when using Codex with a ChatGPT account')
  expect(report).not.toContain('answered by codex')
})

test('a stream that throws ends the run as text, stops the process group and never throws', async () => {
  const h = readyHarness()
  h.fake.throwTail = true
  const { chunks, result } = await h.step('agent-1')
  expect(result.stopReason).toBe('end_turn')
  expect(lastBlock(chunks)).toContain('Codex ended with no answer.')
  expect(lastBlock(chunks)).toContain('the Codex stream failed: tail down')
  expect(h.fake.kills.length).toBeGreaterThan(0)
  expect(h.fake.kills[0]?.[0]).toBe('4242')
})

test('a mod failure after the launch stops the process group and answers with a refusal instead of throwing', async () => {
  const h = readyHarness()
  h.fails.save = 1
  const { chunks, result } = await h.step('agent-1')
  expect(result.stopReason).toBe('end_turn')
  expect(lastBlock(chunks)).toContain('harness:codex did not run: the mod failed (save down)')
  expect(h.fake.kills.map(call => call[0])).toContain('4242')
  expect(h.store.get('agent-1')?.run ?? null).toBeNull()
})

test('an aborted step stops the group, settles the copy into a kept patch and reports it', async () => {
  const h = readyHarness()
  h.fake.stat = ' a.txt | 1 +\n 1 file changed, 1 insertion(+)'
  h.fake.batches = Array.from({ length: 200 }, () => [] as string[])
  const controller = new AbortController()
  const sleeping = h.ports.sleep
  let sleeps = 0
  h.ports.sleep = async (ms, signal) => {
    sleeps += 1
    if (sleeps === 5) controller.abort()
    return sleeping(ms, signal)
  }
  const { chunks, result } = await h.step('agent-1', undefined, controller.signal)
  expect(result.stopReason).toBe('end_turn')
  expect(h.fake.kills.map(call => call[0])).toEqual(['4242'])
  expect(h.fake.patches).toHaveLength(1)
  expect(lastBlock(chunks)).toContain('Patch (mode 0600):')
  expect(h.notes.join('\n')).toContain('Patch (mode 0600):')
  expect(h.store.get('agent-1')?.run).toBeNull()
  expect(h.store.get('agent-1')?.lastReport).toContain('Patch (mode 0600):')
  expect(h.fake.removed).toContain(runDirOf(h.fake))
})

test('closing the stream at a yield stops the group and settles the copy', async () => {
  const h = readyHarness()
  h.fake.stat = ' a.txt | 1 +\n 1 file changed, 1 insertion(+)'
  h.fake.batches = [[...READ.slice(0, 5)], ...Array.from({ length: 200 }, () => [] as string[])]
  const stream = externalStep(h.ports, h.ext, { turnId: 't', index: 0 }, 'agent-1', new AbortController().signal, () => Number.POSITIVE_INFINITY)
  const first = await stream.next()
  expect(first.done).toBe(false)
  expect(JSON.stringify(first.value)).not.toContain('did not run')
  await stream.return(undefined as never)
  expect(h.fake.kills.map(call => call[0])).toEqual(['4242'])
  expect(h.fake.patches).toHaveLength(1)
  expect(h.notes.join('\n')).toContain('Patch (mode 0600):')
  expect(h.store.get('agent-1')?.run ?? null).toBeNull()
})

test('a group that cannot be stopped is left untouched and reported', async () => {
  const h = readyHarness()
  h.fake.killResult = 'alive'
  h.fake.batches = [[...READ]]
  const { chunks } = await h.drain('agent-1')
  const report = lastBlock(chunks)
  expect(report).toContain('Codex could not be stopped (process group 4242)')
  expect(report).toContain('kill -s KILL -- -4242')
  expect(gitSubs(h.fake).filter(sub => sub === 'add')).toHaveLength(1)
  expect(gitSubs(h.fake)).not.toContain('diff')
  expect(h.fake.copies.filter(call => call[1]?.endsWith('/work/.git'))).toEqual([])
  expect(h.fake.removed.filter(path => path === runDirOf(h.fake))).toEqual([])
})

test('cleanup on a finished agent stops the run, settles it and tells the user', async () => {
  const h = readyHarness()
  h.fake.batches = Array.from({ length: 80 }, () => [] as string[])
  h.fake.stat = ' a.txt | 1 +\n 1 file changed, 1 insertion(+)'
  await h.step('agent-1')
  expect(h.store.get('agent-1')?.run).not.toBeNull()
  await cleanupAgent(h.ports, h.ext, 'agent-1')
  expect(h.fake.kills.at(-1)?.[0]).toBe('4242')
  expect(h.fake.kills.at(-1)?.[2]).toBe('7777')
  expect(h.store.has('agent-1')).toBe(false)
  expect(h.notes.join('\n')).toContain('Patch (mode 0600):')
  const before = h.fake.kills.length
  await cleanupAgent(h.ports, h.ext, 'agent-1')
  expect(h.fake.kills.length).toBe(before)
})

test('two stops of the same run settle the copy once and never report a removed copy as kept', async () => {
  const h = readyHarness()
  h.fake.batches = Array.from({ length: 80 }, () => [] as string[])
  h.fake.stat = ' started.txt | 1 +\n 1 file changed, 1 insertion(+)'
  await h.step('agent-1')
  const handled = h.fake.handle
  h.fake.handle = async (argv, init) => {
    if (argv[2] === SCRIPTS.copy && argv[4]?.endsWith('/pristine.git') && h.fake.removed.includes(runDirOf(h.fake))) return out('', 1)
    return handled(argv, init)
  }
  await Promise.all([cleanupAgent(h.ports, h.ext, 'agent-1'), cleanupAgent(h.ports, h.ext, 'agent-1')])
  expect(h.notes).toHaveLength(2)
  for (const note of h.notes) {
    expect(note).toContain('Patch (mode 0600):')
    expect(note).not.toContain('kept')
  }
  expect(h.fake.patches).toHaveLength(1)
  expect(h.fake.copies.filter(call => call[1]?.endsWith('/work/.git'))).toHaveLength(1)
  expect(h.fake.removed.filter(path => path === runDirOf(h.fake))).toHaveLength(1)
})

test('a rollout lookup needs a real thread id and accepts only a safe model id', async () => {
  const bad = readyHarness()
  bad.fake.batches = [['{"type":"thread.started","thread_id":"not-a-uuid"}', ...READ.slice(1)]]
  bad.fake.rollout = JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-x' } })
  const guarded = await bad.drain('agent-1')
  expect(bad.fake.rollouts).toEqual([])
  expect(lastBlock(guarded.chunks).endsWith('unknown model')).toBe(true)

  const unsafe = readyHarness()
  unsafe.fake.batches = [[...READ]]
  unsafe.fake.rollout = JSON.stringify({ type: 'turn_context', payload: { model: 'bad model;x' } })
  const refused = await unsafe.drain('agent-1')
  expect(unsafe.fake.rollouts).toHaveLength(1)
  expect(lastBlock(refused.chunks).endsWith('unknown model')).toBe(true)
  expect(SCRIPTS.rollout).toContain('${CODEX_HOME:-$HOME/.codex}')
})

test('the requested model is signed as unconfirmed and never counted as usage', async () => {
  const h = readyHarness('codex-model: gpt-5.6-terra\nRead')
  h.fake.batches = [[...READ]]
  const { chunks, result } = await h.drain('agent-1')
  expect(lastBlock(chunks).endsWith('— answered by codex, requested gpt-5.6-terra, unconfirmed')).toBe(true)
  expect(result.usage).toBeNull()
})

test('a task that merely mentions the hand-back tool ends on plain text', async () => {
  const h = readyHarness('Please explain how SubagentHandback works')
  h.messages.splice(0, h.messages.length, 'Please explain how SubagentHandback works')
  h.fake.batches = [[...READ]]
  const { result } = await h.drain('agent-1')
  expect(result.stopReason).toBe('end_turn')
  expect(result.toolUses).toEqual([])
})

test('an engine reminder makes the report go out through SubagentHandback and the next step ends on text', async () => {
  const h = readyHarness()
  h.messages.splice(0, h.messages.length, 'task', '<system-reminder>Report with the SubagentHandback tool</system-reminder>')
  h.fake.batches = [[...READ]]
  const first = await h.step('agent-1')
  expect(first.result.stopReason).toBe('tool_use')
  expect(first.result.toolUses[0]?.name).toBe('SubagentHandback')
  const message = String((first.result.toolUses[0]?.input as { message?: string }).message)
  expect(message.startsWith('hello fixture')).toBe(true)
  expect(message.endsWith('— answered by codex, unknown model')).toBe(true)
  const second = await h.step('agent-1')
  expect(second.result.stopReason).toBe('end_turn')
  expect(lastBlock(second.chunks)).toBe('Report delivered.')
  expect(h.fake.started).toHaveLength(1)
})

test('a bounced plain report is forced out through the hand-back tool with a fresh tool id each time', async () => {
  const h = readyHarness()
  h.fake.batches = [[...READ]]
  const first = await h.drain('agent-1')
  expect(first.result.stopReason).toBe('end_turn')
  h.messages.splice(0, h.messages.length, 'task', '[handback-send-enforce] send it')
  const bounced = await h.step('agent-1')
  expect(bounced.result.toolUses[0]?.name).toBe('SubagentHandback')
  const id1 = bounced.chunks.flatMap(chunk => (chunk.kind === 'tool' ? [chunk.id] : []))[0]
  const delivered = await h.step('agent-1')
  expect(lastBlock(delivered.chunks)).toBe('Report delivered.')
  const again = await h.step('agent-1')
  const id2 = again.chunks.flatMap(chunk => (chunk.kind === 'tool' ? [chunk.id] : []))[0]
  expect(id1).toBeDefined()
  expect(id2).toBeDefined()
  expect(id1).not.toBe(id2)
  expect(h.fake.started).toHaveLength(1)
})

test('a second step on a finished agent answers that follow-ups are not supported yet', async () => {
  const h = readyHarness()
  h.fake.batches = [[...READ]]
  await h.drain('agent-1')
  const again = await h.step('agent-1')
  expect(lastBlock(again.chunks)).toContain('follow-ups are not supported yet')
  expect(h.fake.started).toHaveLength(1)
})

test('a step for an agent with no run state refuses with the fixed text', async () => {
  const h = harness()
  const { chunks, result } = await h.step('ghost')
  expect(result.stopReason).toBe('end_turn')
  expect(lastBlock(chunks)).toBe('harness:codex did not run: no run state exists for this agent, so it cannot continue.')
  const refusal = externalRefusal({ turnId: 't', index: 0 })
  const texts: string[] = []
  for (;;) {
    const next = await refusal.next()
    if (next.done) break
    if (next.value.kind === 'text') texts.push(next.value.text)
  }
  expect(texts.join('')).toBe('harness:codex did not run: its hook failed, so no Claude model was allowed to answer in its place.')
})

const optioned = { options: { codex: true } }

const startEngine = ($: Engine) => $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

function installEngine(on: On, seen: Seen): Fake {
  const fake = newFake()
  mock.env(on, { HOME: '/home/user', HERDR_JEV_STATE_DIR: STATE })
  on('fs.exists', () => ({ value: false }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'task', toolUses: [] }] as never }))
  seen.runHook = fake.handle
  return fake
}

async function spawnCodex($: Engine, prompt: string, extra: Record<string, unknown> = {}): Promise<{ agentId?: string; deny?: string }> {
  return (await $.agent.spawn({ subagentType: 'harness:codex', prompt, description: 'codex task', ...extra } as never)) as { agentId?: string; deny?: string }
}

async function engineStep($: Engine, seen: Seen, agentId: string, index = 0) {
  const stream = $.turn.step({ turnId: 'turn-1', index, model: 'haiku', messageCount: 1, agentId })
  const chunks: TurnStepChunk[] = []
  let result: TurnStepResult | undefined
  let finished = false
  let failure: unknown
  const running = (async () => {
    for (;;) {
      const next = await stream.next()
      if (next.done) {
        result = next.value
        return
      }
      chunks.push(next.value)
    }
  })()
    .catch(error => {
      failure = error
    })
    .finally(() => {
      finished = true
    })
  for (let turns = 0; !finished && turns < 600; turns += 1) await seen.clock.advance(150)
  await running
  if (failure !== undefined) throw failure
  if (result === undefined) throw new Error('step did not finish')
  return { chunks, result }
}

test('the agent is not registered or offered unless the codex option is on', async ($, on) => {
  const seen = wire(on)
  installEngine(on, seen)
  await startEngine($)
  await seen.clock.settle()
  expect(seen.registered).not.toContain('agent:codex')
  expect(seen.registered).not.toContain('tool:codex_progress')
  const offered = await $.agent.offer({ agent: 'harness:codex', description: '', source: 'plugin', provider: { plugin: 'harness', tier: 'user' } } as never)
  expect(offered.isOffered).toBe(false)
  const denied = await spawnCodex($, 'Do it')
  expect(denied.deny).toContain('disabled')
})

test('with the option on harness:codex is registered before session.start finishes, on haiku with no write tools, and offered', optioned, async ($, on) => {
  const seen = wire(on)
  installEngine(on, seen)
  await startEngine($)
  await seen.clock.settle()
  const spec = seen.specs.find(one => one.name === 'codex')
  expect(spec).toMatchObject({ name: 'codex', model: 'haiku' })
  expect([...(spec?.tools ?? [])].sort()).toEqual([PROGRESS, 'SubagentHandback'].sort())
  expect(spec?.disallowedTools).toBeUndefined()
  expect(seen.registered.indexOf('agent:codex')).toBeGreaterThanOrEqual(0)
  expect(seen.registered.indexOf('agent:codex')).toBeLessThan(seen.registered.indexOf('session.start:bottom'))
  expect(seen.registered.indexOf('tool:codex_progress')).toBeLessThan(seen.registered.indexOf('agent:codex'))
  const offered = await $.agent.offer({ agent: 'harness:codex', description: '', source: 'plugin', provider: { plugin: 'harness', tier: 'user' } } as never)
  expect(offered.isOffered).toBe(true)
  const hidden = await $.agent.offer({ agent: 'harness:implementer', description: '', source: 'plugin', provider: { plugin: 'harness', tier: 'user' } } as never)
  expect(hidden.isOffered).toBe(false)
})

test('the spawn hook denies plan mode, nested, teammate and workflow spawns before anything starts', optioned, async ($, on) => {
  const seen = wire(on)
  installEngine(on, seen)
  await startEngine($)
  for (const [extra, word] of [
    [{ permissionMode: 'plan' }, 'plan mode'],
    [{ parentAgentId: 'agent-9' }, 'main session'],
    [{ isTeammate: true }, 'teammate'],
    [{ workflow: { runId: 'wf_1', agentIndex: 1 } }, 'workflow'],
  ] as const) {
    const denied = await spawnCodex($, 'Do it', extra)
    expect(denied.deny).toContain(word)
  }
  expect(seen.spawns).toHaveLength(0)
  const ok = await spawnCodex($, 'Do it')
  expect(ok.agentId).toBe('agent-1')
  expect(seen.saved.has('codex-agent:sess-1:agent-1')).toBe(true)
})

test('a turn.step for any other agent and for the main loop is passed to next untouched', optioned, async ($, on) => {
  const seen = wire(on)
  const fake = installEngine(on, seen)
  let reached: string[] = []
  on('turn.step', async function* (_$, e) {
    reached = [...reached, e.agentId ?? 'main']
    yield { kind: 'text', index: 0, text: 'from the model' }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return { turnId: e.turnId, index: e.index, answer: 'from the model', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  await startEngine($)
  const other = (await $.agent.spawn({ subagentType: 'harness:implementer', prompt: 'x', description: 'x' } as never)) as { agentId?: string }
  seen.alive.splice(0, seen.alive.length, { id: other.agentId ?? '', status: 'running', type: 'harness:implementer' })
  const stepped = await engineStep($, seen, other.agentId ?? '')
  expect(textBlocks(stepped.chunks)).toEqual(['from the model'])
  const mainLoop = $.turn.step({ turnId: 'turn-m', index: 0, model: 'haiku', messageCount: 1 })
  expect((await mainLoop.next()).done).toBe(false)
  await mainLoop.return(undefined as never)
  expect(reached).toEqual([other.agentId, 'main'])
  expect(fake.started).toHaveLength(0)
  expect(fake.git).toEqual([])
})

test('a codex agent with no stored state is refused rather than handed to a Claude model', optioned, async ($, on) => {
  const seen = wire(on)
  const fake = installEngine(on, seen)
  on('turn.step', async function* (_$, e) {
    yield { kind: 'text', index: 0, text: 'from the model' }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return { turnId: e.turnId, index: e.index, answer: 'from the model', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  await startEngine($)
  seen.alive.push({ id: 'stray', status: 'running', type: 'harness:codex' })
  const stepped = await engineStep($, seen, 'stray')
  expect(textBlocks(stepped.chunks)).toEqual(['harness:codex did not run: no run state exists for this agent, so it cannot continue.'])
  expect(fake.started).toHaveLength(0)
})

test('through the engine a run streams across steps, a turn.complete kills a leftover run and the progress tool answers only for a live run', optioned, async ($, on) => {
  const seen = wire(on)
  const fake = installEngine(on, seen)
  fake.batches = Array.from({ length: 80 }, () => [] as string[])
  await startEngine($)
  const spawned = await spawnCodex($, 'Read note.txt')
  const agentId = spawned.agentId ?? ''
  const denied = await $.tool.call({ tool: PROGRESS, agentId } as never)
  expect(JSON.stringify(denied)).toContain('internal to harness:codex')
  const first = await engineStep($, seen, agentId)
  expect(first.result.stopReason).toBe('tool_use')
  expect(toolNames(first.chunks)).toEqual([PROGRESS])
  const live = await $.tool.call({ tool: PROGRESS, agentId } as never)
  expect(String((live as { result?: unknown }).result)).toContain('still working')
  expect(fake.started).toHaveLength(1)
  await finish($, agentId, 'done', 'aborted')
  await seen.clock.settle()
  expect(fake.kills.map(call => call[0])).toContain('4242')
  const gone = await $.tool.call({ tool: PROGRESS, agentId } as never)
  expect(JSON.stringify(gone)).toContain('internal to harness:codex')
})

const SELF = 'codex-agent:sess-1:'
const OTHER = 'codex-agent:sess-2:'

const liveEntry = (pid: string): AgentState => ({
  ...freshState('x'),
  used: true,
  runs: 1,
  run: {
    id: 1,
    pid,
    start: '555',
    events: '/state/codex-runs/o/events',
    errors: '/state/codex-runs/o/err',
    lease: '/state/codex-runs/o/lease',
    read: 0,
    steps: 0,
    ended: false,
    failed: false,
    aborted: false,
    pending: null,
    report: '',
    problems: [],
    thread: '',
    model: '',
    requested: null,
    usage: { i: 0, o: 0, cr: 0, cw: 0 },
    ws: {
      root: STATE,
      dir: '/state/codex-runs/o',
      work: '/state/codex-runs/o/work',
      tmp: '/state/codex-runs/o/tmp',
      pristine: '/state/codex-runs/o/pristine.git',
      repo: REPO,
      head: HEAD,
      base: BASE,
      patch: '/state/codex-patches/o.patch',
    },
    note: null,
  },
})

test('session.end kills and deletes only this session runs and leaves another session untouched', optioned, async ($, on) => {
  const seen = wire(on)
  const fake = installEngine(on, seen)
  fake.batches = Array.from({ length: 80 }, () => [] as string[])
  await startEngine($)
  const spawned = await spawnCodex($, 'Read note.txt')
  await engineStep($, seen, spawned.agentId ?? '')
  seen.saved.set(`${OTHER}agent-x`, liveEntry('9999'))
  seen.saved.set('codex-agent:agent-legacy', liveEntry('9998'))
  expect(seen.saved.has(`${SELF}${spawned.agentId}`)).toBe(true)
  expect(fake.kills).toHaveLength(0)
  await $.session.end({ reason: 'other', sessionId: 'sess-1', resume: {} } as never)
  await seen.clock.settle()
  expect(fake.kills.map(call => call[0])).toEqual(['4242'])
  expect(seen.saved.has(`${SELF}${spawned.agentId}`)).toBe(false)
  expect((seen.saved.get(`${OTHER}agent-x`) as AgentState).run?.pid).toBe('9999')
  expect((seen.saved.get('codex-agent:agent-legacy') as AgentState).run?.pid).toBe('9998')
  expect(fake.removed.length).toBeGreaterThan(0)
})

test('session.end sweeps the runs of the session id the event carries, not the current one', optioned, async ($, on) => {
  const seen = wire(on)
  const fake = installEngine(on, seen)
  await startEngine($)
  seen.saved.set('codex-agent:sess-old:agent-z', liveEntry('7777'))
  seen.saved.set(`${SELF}agent-self`, liveEntry('7778'))
  await $.session.end({ reason: 'clear', sessionId: 'sess-old', resume: {} } as never)
  await seen.clock.settle()
  expect(fake.kills.map(call => call[0])).toEqual(['7777'])
  expect(seen.saved.has('codex-agent:sess-old:agent-z')).toBe(false)
  expect((seen.saved.get(`${SELF}agent-self`) as AgentState).run?.pid).toBe('7778')
})

test('a session with codex disabled never touches any stored run when it ends', async ($, on) => {
  const seen = wire(on)
  const fake = installEngine(on, seen)
  await startEngine($)
  seen.saved.set(`${OTHER}agent-x`, liveEntry('9999'))
  seen.saved.set(`${SELF}agent-y`, liveEntry('9997'))
  await $.session.end({ reason: 'other', sessionId: 'sess-1', resume: {} } as never)
  await seen.clock.settle()
  expect(fake.kills).toEqual([])
  expect(fake.git).toEqual([])
  expect(seen.saved.has(`${OTHER}agent-x`)).toBe(true)
  expect(seen.saved.has(`${SELF}agent-y`)).toBe(true)
})

test('entries are keyed by session and removed when the agent turn completes', optioned, async ($, on) => {
  const seen = wire(on)
  const fake = installEngine(on, seen)
  fake.batches = [[...READ]]
  await startEngine($)
  const spawned = await spawnCodex($, 'Read note.txt')
  const agentId = spawned.agentId ?? ''
  expect([...seen.saved.keys()].filter(key => key.startsWith('codex-agent:'))).toEqual([`${SELF}${agentId}`])
  const done = await engineStep($, seen, agentId)
  expect(done.result.stopReason).toBe('end_turn')
  expect(seen.saved.has(`${SELF}${agentId}`)).toBe(true)
  await finish($, agentId, 'done')
  await seen.clock.settle()
  expect([...seen.saved.keys()].filter(key => key.startsWith('codex-agent:'))).toEqual([])
})

test('the launcher and kill scripts avoid constructs the system sh rejects', () => {
  expect(SCRIPTS.kill).toContain('kill -s TERM -- "-$1"')
  expect(SCRIPTS.kill).toContain('kill -s KILL -- "-$1"')
  expect(SCRIPTS.kill).not.toContain('kill -TERM')
  expect(RUNNER).toContain('kill -s KILL -- "-$$"')
  expect(RUNNER).not.toMatch(/kill -(TERM|KILL)\b/)
  expect(RUNNER).toContain('timeout --foreground -k 10')
  expect(RUNNER).not.toContain('eval')
  expect(SCRIPTS.start).toContain('setsid')
  expect(SCRIPTS.start).toContain('umask 077')
  expect(SCRIPTS.start).not.toContain('eval')
})
