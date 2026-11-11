import { atom, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions } from 'claude-code'
import type { OddFeatureRow, OddView } from '../types'
import {
  addLog,
  addSpec,
  addTask,
  completeTask,
  featurePath,
  featuresDir,
  inferPhase,
  isInside,
  newDoc,
  normalizeCommand,
  normalizeTaskId,
  parseDoc,
  parseEvidence,
  parseFeatureCommand,
  progress,
  renderDoc,
  shouldAsk,
  verifyEvidence,
  writerWarning,
} from './odd-core'
import type { EvidencePorts, FeatureDoc, Phase } from './odd-core'

export const TOOL_DONE = 'mcp__harness__harness_task_done'
export const TOOL_ADD = 'mcp__harness__harness_task_add'
const RAN_CAP = 200
const EMPTY: OddView = { repo: '', current: null, features: [], phase: null }
const oddAtom = atom({ plugin: 'harness', key: 'odd' } as const, EMPTY, { shape: 'odd-1' })

type Where = { home: string; cwd: string; root: string; repo: string }

let current: string | null = null
let asked = false
let open: OddFeatureRow[] = []
let phase: Phase | null = null
let where: Where | null = null
const ran = new Map<string, boolean>()

export const oddEnabled = (options: PluginOptions): boolean => options.odd === true

export function resetOdd(): void {
  current = null
  asked = false
  open = []
  phase = null
  where = null
  ran.clear()
}

async function attempt<T>(run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run()
  } catch {
    return undefined
  }
}

async function locate($: EngineInterface): Promise<Where | null> {
  const home = await attempt(() => $.env.get('HOME'))
  const cwd = await attempt(() => $.session.cwd())
  if (home === undefined || cwd === undefined) return null
  if (where !== null && where.cwd === cwd && where.home === home) return where
  const top = await attempt(() => $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd, timeoutMs: 3000 }))
  const root = top !== undefined && top.exitCode === 0 && top.stdout.trim().length > 0 ? top.stdout.trim() : cwd
  where = { home, cwd, root, repo: root.slice(root.lastIndexOf('/') + 1) }
  return where
}

const rowOf = (doc: FeatureDoc, path: string): OddFeatureRow => ({ name: doc.name, path, ...progress(doc) })

async function readDoc($: EngineInterface, path: string): Promise<FeatureDoc | null> {
  const text = await attempt(() => $.fs.read(path))
  return typeof text === 'string' ? parseDoc(text) : null
}

async function publish($: EngineInterface, w: Where | null): Promise<void> {
  await update($, oddAtom, () => (w === null ? EMPTY : { repo: w.repo, current, features: open, phase }))
}

async function scan($: EngineInterface, w: Where): Promise<OddFeatureRow[]> {
  const dir = featuresDir(w.home, w.repo)
  const entries = await attempt(() => $.fs.list(dir))
  const rows: OddFeatureRow[] = []
  for (const entry of entries ?? []) {
    if (!entry.name.endsWith('.md')) continue
    const path = `${dir}/${entry.name}`
    const doc = await readDoc($, path)
    if (doc !== null) rows.push(rowOf(doc, path))
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name))
}

async function refresh($: EngineInterface, w: Where): Promise<void> {
  open = await scan($, w)
  if (current !== null && !open.some(row => row.name === current)) current = null
  await publish($, w)
}

const bar = (row: OddFeatureRow): string => `${row.name} ${row.done}/${row.total} (${row.percent}%)`

function ports($: EngineInterface, w: Where): EvidencePorts {
  const git = (args: string[]) => $.process.run(['git', ...args], { cwd: w.root, timeoutMs: 5000 })
  return {
    commitExists: async sha => (await attempt(() => git(['cat-file', '-e', `${sha}^{commit}`])))?.exitCode === 0,
    ranOk: command => ran.get(command) === true,
    run: async command => {
      const out = await attempt(() => $.tool.call({ tool: 'Bash', command } as never))
      return out === undefined || (out as { isError?: boolean }).isError === true || (out as { deny?: string }).deny !== undefined ? 1 : 0
    },
    changed: async files => {
      const safe = files.filter(file => !file.startsWith('-'))
      if (safe.length === 0) return false
      const status = await attempt(() => git(['status', '--porcelain', '--', ...safe]))
      if (status !== undefined && status.exitCode === 0 && status.stdout.trim().length > 0) return true
      const last = await attempt(() => git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD', '--', ...safe]))
      return last !== undefined && last.exitCode === 0 && last.stdout.trim().length > 0
    },
  }
}

async function save($: EngineInterface, w: Where, name: string, doc: FeatureDoc): Promise<string> {
  const path = featurePath(w.home, w.repo, name)
  await $.fs.write(path, renderDoc(doc))
  await refresh($, w)
  return path
}

async function currentDoc($: EngineInterface, w: Where): Promise<{ doc: FeatureDoc; name: string } | string> {
  if (current === null) {
    return open.length === 0
      ? 'No open feature. The user opens one with /harness feature <name> <request>.'
      : `Several open features (${open.map(row => row.name).join(', ')}). The user picks one with /harness feature <name>.`
  }
  const doc = await readDoc($, featurePath(w.home, w.repo, current))
  return doc === null ? `Feature document for ${current} is unreadable.` : { doc, name: current }
}

export async function oddCommand($: EngineInterface, options: PluginOptions, args: string): Promise<string | null> {
  const cmd = parseFeatureCommand(args)
  if (cmd === null) return null
  if (!oddEnabled(options)) return 'ODD is off. Enable the odd option of the harness mod to use features.'
  const w = await locate($)
  if (w === null) return 'Cannot resolve the home or working directory.'
  await refresh($, w)
  if (cmd.kind === 'usage') return cmd.reason
  if (cmd.kind === 'list') return open.length === 0 ? 'No open features.' : open.map(bar).join('\n')
  if (cmd.kind === 'spec') {
    const found = await currentDoc($, w)
    if (typeof found === 'string') return found
    await save($, w, found.name, addSpec(found.doc, cmd.text))
    return `Spec added to ${found.name}.`
  }
  const path = featurePath(w.home, w.repo, cmd.name)
  if (isInside(path, w.root)) return 'Feature documents must live outside the work repo.'
  const existing = await readDoc($, path)
  if (existing !== null) {
    current = cmd.name
    await publish($, w)
    return `Feature ${cmd.name} resumed: ${path}`
  }
  const created = new Date(await $.clock.now()).toISOString()
  current = cmd.name
  await save($, w, cmd.name, newDoc(cmd.name, w.repo, created, cmd.request))
  return `Feature ${cmd.name} opened: ${path}`
}

export async function oddAfterPlan($: EngineInterface, options: PluginOptions, tasks: number): Promise<string> {
  if (!oddEnabled(options) || current !== null || asked || !shouldAsk({ tasks })) return ''
  asked = true
  return `\n\nODD: this plan has ${tasks} tasks. Ask the user once, in one sentence, whether to open a feature document. They answer with /harness feature <name> <request>. Do not ask again this session.`
}

async function taskDone($: EngineInterface, e: Record<string, unknown>): Promise<string> {
  const w = await locate($)
  if (w === null) return 'harness_task_done: cannot resolve the working directory.'
  const found = await currentDoc($, w)
  if (typeof found === 'string') return `harness_task_done: ${found}`
  const id = normalizeTaskId(e.task)
  const task = found.doc.tasks.find(t => t.id === id)
  if (task === undefined) return `harness_task_done: task ${String(e.task)} not found in ${found.name}.`
  if (task.done) return `${task.id} is already done.`
  const evidence = parseEvidence(e.evidence)
  if (typeof evidence === 'string') return `harness_task_done: ${evidence}. ${task.id} stays open.`
  const verdict = await verifyEvidence(evidence, ports($, w))
  if (!verdict.ok) return `harness_task_done: evidence not accepted (${verdict.note}). ${task.id} stays open.`
  await save($, w, found.name, completeTask(found.doc, task.id, verdict.line))
  const row = open.find(r => r.name === found.name)
  return `${task.id} done (${verdict.note}). ${row === undefined ? '' : bar(row)}`
}

async function taskAdd($: EngineInterface, e: Record<string, unknown>): Promise<string> {
  const w = await locate($)
  if (w === null) return 'harness_task_add: cannot resolve the working directory.'
  const found = await currentDoc($, w)
  if (typeof found === 'string') return `harness_task_add: ${found}`
  const title = typeof e.title === 'string' ? e.title.trim() : ''
  if (title.length === 0) return 'harness_task_add: title is empty.'
  const spec = typeof e.spec === 'string' ? e.spec.trim().toUpperCase() : ''
  const next = addTask(found.doc, title, spec)
  if (typeof next === 'string') return `harness_task_add: ${next}.`
  await save($, w, found.name, next)
  return `T${next.tasks.length} added to ${found.name}, linked to ${spec}.`
}

const DONE_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'string', description: 'Task id in the open feature document, such as T2.' },
    evidence: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['commit', 'test', 'command', 'diff'] },
        value: { type: 'string', description: 'commit: sha. test or command: the command line. diff: the changed files.' },
      },
      required: ['type', 'value'],
    },
  },
  required: ['task', 'evidence'],
} as const

const ADD_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    spec: { type: 'string', description: 'Spec id the task serves, such as S1.' },
  },
  required: ['title', 'spec'],
} as const

export async function oddStart($: EngineInterface, options: PluginOptions): Promise<void> {
  if (!oddEnabled(options)) return
  resetOdd()
  await attempt(() => $.tool.register({ name: 'harness_task_done', description: 'Mark a task of the open feature document done. Needs evidence the mod verifies: a commit sha that exists, a test or command that exited 0, or files changed in git.', inputSchema: DONE_SCHEMA } as never))
  await attempt(() => $.tool.register({ name: 'harness_task_add', description: 'Add a task linked to a spec of the open feature document.', inputSchema: ADD_SCHEMA } as never))
  const w = await locate($)
  if (w === null) return
  await refresh($, w)
  if (open.length === 1) current = (open[0] as OddFeatureRow).name
  await publish($, w)
}

export function registerOdd(on: On, options: PluginOptions): void {
  on('prompt.compose', async ($, e, next) => {
    if (!oddEnabled(options)) return next(e)
    const out = await next(e)
    if (open.length === 0) return out
    const lines = open.map(row => `${bar(row)}: ${row.path}`).join('\n')
    return { ...out, sections: [...out.sections, { id: 'harness:odd', scope: 'session', text: `Open feature documents for this repo (outside the repo, the only source of the feature):\n${lines}\nResume from the document. Close tasks with harness_task_done.` }] }
  }).catch(($, e, next) => next(e))
}

export async function oddToolCall($: EngineInterface, options: PluginOptions, e: any, next: any): Promise<any> {
  if (!oddEnabled(options)) return next(e)
  const input = e as Record<string, unknown>
  if (e.tool === TOOL_DONE || e.tool === TOOL_ADD) {
    if (e.agentId !== undefined) return { result: 'Main session only.' }
    return { result: await (e.tool === TOOL_DONE ? taskDone($, input) : taskAdd($, input)) }
  }
  if (current === null) return next(e)
  const command = e.tool === 'Bash' ? String(input.command ?? '') : undefined
  const seen = inferPhase(String(e.tool), command)
  if (seen !== undefined && seen !== phase) {
    phase = seen
    void attempt(() => publish($, where))
  }
  if (e.tool === 'Agent') {
    const warn = writerWarning(typeof input.subagent_type === 'string' ? input.subagent_type : undefined, String(input.prompt ?? ''))
    if (warn !== null) $.ui.toast(warn)
  }
  const out = await next(e)
  if (command !== undefined && out.deny === undefined) {
    if (ran.size >= RAN_CAP) ran.delete(ran.keys().next().value as string)
    ran.set(normalizeCommand(command), out.isError !== true)
  }
  return out
}
