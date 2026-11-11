import { atom, update } from 'claude-code'
import type { EngineInterface, PluginOptions } from 'claude-code'
import type { ProposalRow } from '../types'
import { approve, listProposals, mineAndSave, reject, visible, whereFor } from './improve-core'
import type { Ports, Where } from './improve-core'
import { judge } from './judge-core'
import { appendShadow, shadowEntry } from './shadow-core'

export const improveEnabled = (options: PluginOptions): boolean => options.improve === true
export const routerMode = (options: PluginOptions): 'conclave' | 'harness' => (options.router === 'harness' ? 'harness' : 'conclave')

export const proposalsAtom = atom({ plugin: 'harness', key: 'proposals' } as const, [], { shape: 'proposals-1' })
export const expandedAtom = atom({ plugin: 'harness', key: 'proposalExpanded' } as const, '')

const FAILED_LINES = 4000

async function attempt<T>(run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run()
  } catch {
    return undefined
  }
}

function portsOf($: EngineInterface): Ports {
  return {
    read: async path => attempt(() => $.fs.read(path)),
    write: async (path, text) => {
      await $.process.run(['mkdir', '-p', path.slice(0, path.lastIndexOf('/'))], { timeoutMs: 5000 })
      await $.fs.write(path, text)
    },
    list: async dir => (await attempt(() => $.fs.list(dir)))?.map(entry => entry.name) ?? [],
    run: async argv => {
      const ran = await $.process.run(argv, { timeoutMs: 60000 })
      return { code: ran.exitCode, out: `${ran.stdout}${ran.stderr}` }
    },
  }
}

async function whereOf($: EngineInterface): Promise<Where | null> {
  const home = await attempt(() => $.env.get('HOME'))
  if (home === undefined) return null
  const env: Record<string, string | undefined> = {
    HERDR_JEV_STATE_DIR: await attempt(() => $.env.get('HERDR_JEV_STATE_DIR')),
    AI_HARNESS_CORE: await attempt(() => $.env.get('AI_HARNESS_CORE')),
    JEV_CONFIG_DIR: await attempt(() => $.env.get('JEV_CONFIG_DIR')),
  }
  return whereFor(env, home)
}

const rowOf = (p: Awaited<ReturnType<typeof listProposals>>[number]): ProposalRow => ({
  id: p.id,
  kind: p.kind,
  name: p.name,
  count: p.count,
  sessions: p.sessions,
  evidence: p.evidence,
  diff: p.diff,
})

export async function refreshProposals($: EngineInterface): Promise<void> {
  const w = await whereOf($)
  const rows = w === null ? [] : (await listProposals(portsOf($), w, 'pending')).map(rowOf)
  await update($, proposalsAtom, () => rows)
}

export async function improveStart($: EngineInterface, options: PluginOptions): Promise<void> {
  if (!improveEnabled(options)) return
  const w = await whereOf($)
  if (w === null) return
  const ports = portsOf($)
  const failedText = (await ports.read(`${w.home}/.claude/failed-attempts.jsonl`)) ?? ''
  const failed = failedText.split('\n').slice(-FAILED_LINES).join('\n')
  const events = (await ports.read(`${w.state}/events.jsonl`)) ?? ''
  await mineAndSave(ports, w, { failed, events }, Math.floor((await $.clock.now()) / 1000))
  await refreshProposals($)
}

export async function proposalAction($: EngineInterface, verb: 'approve' | 'reject', id: string): Promise<string> {
  const w = await whereOf($)
  if (w === null) return 'no HOME'
  const done = await (verb === 'approve' ? approve : reject)(portsOf($), w, id)
  await refreshProposals($)
  $.ui.toast(done.message.slice(0, 200))
  return done.message
}

export async function toggleDiff($: EngineInterface, id: string): Promise<void> {
  await update($, expandedAtom, current => (current === id ? '' : id))
}

export const visibleProposals = (rows: readonly ProposalRow[]) => visible(rows as never, 3) as unknown as { shown: ProposalRow[]; hidden: number }

export async function recordShadow($: EngineInterface, options: PluginOptions, e: Record<string, unknown>): Promise<void> {
  if (routerMode(options) !== 'conclave') return
  const kind = typeof e.subagent_type === 'string' ? e.subagent_type : undefined
  if (kind?.startsWith('harness:') === true) return
  const prompt = typeof e.prompt === 'string' ? e.prompt : ''
  if (prompt.length === 0) return
  const w = await whereOf($)
  if (w === null) return
  const description = typeof e.description === 'string' ? e.description : undefined
  const decision = judge(`${description ?? ''}\n${prompt}`)
  const ts = Math.floor((await $.clock.now()) / 1000)
  const entry = shadowEntry({ subagentType: kind, model: typeof e.model === 'string' ? e.model : undefined, prompt, description }, decision, ts)
  const ports = portsOf($)
  const file = `${w.state}/route-shadow.jsonl`
  await ports.write(file, appendShadow((await ports.read(file)) ?? '', entry))
}
