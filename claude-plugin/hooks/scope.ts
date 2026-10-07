import type { PluginOptions } from 'claude-code'

import type { ScopeState } from '../types'
import { runJson, safeTask } from './cli'
import type { CliResult, RunPort } from './cli'
import { fit, isRecord } from './plan'

export type ScopeMode = 'off' | 'report' | 'enforce'

export type SkillReason = 'project' | 'built-in' | 'always' | 'skill-select' | 'route-turn' | 'invoked'

export type AgentReason = 'project' | 'built-in' | 'harness' | 'always'

export type Receipt = {
  skills: Map<string, SkillReason>
  hiddenSkills: Set<string>
  agents: Map<string, AgentReason>
  hiddenAgents: Set<string>
  notes: string[]
}

export type SkillSelect = {
  skills: string[]
  clis: string[]
  total: number | null
}

export type Filtered = { text: string; removed: string[] }

export const EMPTY_SCOPE: ScopeState = {
  status: 'pending',
  selected: [],
  clis: [],
  turn: [],
  invoked: [],
  query: '',
  total: null,
  note: null,
}

export const DEFAULT_SKILLS: readonly string[] = [
  'writing-clearly-and-concisely',
  'harness-router',
  'herdr-jev',
  'ai-harness-context',
  'plugin-authoring',
  'vault',
  'promote',
  'code-review',
  'simplify',
]

export const DEFAULT_AGENTS: readonly string[] = [
  'business-operator',
  'claudex-coordinator',
  'commercial-operator',
  'harness-operator',
  'knowledge-maintainer',
  'legacy-archaeologist',
  'media-producer',
  'platform-reliability',
  'product-discovery',
  'quality-reviewer',
  'recording-analyst',
  'research-analyst',
  'security-operator',
  'software-architect',
  'software-engineer',
  'web-experience',
]

export const BUILTIN_AGENTS: readonly string[] = [
  'general-purpose',
  'Explore',
  'Plan',
  'claude-code-guide',
  'statusline-setup',
  'PlanChecker',
]

const SKILL_HEADER = 'The following skills are available for use with the Skill tool:'
const SELECT_TIMEOUT_MS = 8000
const ROUTE_TIMEOUT_MS = 2000
const ROUTE_TEXT_LIMIT = 2000

export function newReceipt(): Receipt {
  return { skills: new Map(), hiddenSkills: new Set(), agents: new Map(), hiddenAgents: new Set(), notes: [] }
}

export function scopeMode(options: PluginOptions): ScopeMode {
  const value = options.scopeMode
  return value === 'off' || value === 'report' ? value : 'enforce'
}

export function listOption(value: unknown, fallback: readonly string[]): string[] {
  if (typeof value !== 'string') return [...fallback]
  const names = value.split(/[,\n]/).map(one => one.trim()).filter(one => one.length > 0)
  return names.length === 0 && value.trim().length === 0 ? [...fallback] : names
}

export function runbookOption(options: PluginOptions): string | null {
  const value = options.runbook
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

export function nameMatches(name: string, allowed: readonly string[]): boolean {
  return allowed.some(one => name === one || name.endsWith(`:${one}`))
}

export type SkillContext = {
  own: ReadonlyMap<string, SkillReason>
  always: readonly string[]
  state: ScopeState
}

export function skillReason(name: string, ctx: SkillContext): SkillReason | null {
  const own = ctx.own.get(name)
  if (own !== undefined) return own
  if (ctx.state.invoked.includes(name)) return 'invoked'
  if (nameMatches(name, ctx.always)) return 'always'
  if (ctx.state.selected.includes(name) || ctx.state.clis.includes(name)) return 'skill-select'
  if (ctx.state.turn.includes(name)) return 'route-turn'
  return null
}

export function agentReason(agent: string, source: string, always: readonly string[]): AgentReason | null {
  if (source === 'projectSettings') return 'project'
  if (source === 'built-in' || BUILTIN_AGENTS.includes(agent)) return 'built-in'
  if (agent.startsWith('harness:')) return 'harness'
  if (nameMatches(agent, always)) return 'always'
  return null
}

function names(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(isRecord)
    .map(one => one.name)
    .filter((one): one is string => typeof one === 'string' && one.length > 0)
}

export function parseSkillSelect(raw: unknown): SkillSelect | null {
  if (!isRecord(raw) || !Array.isArray(raw.selected)) return null
  return {
    skills: names(raw.selected),
    clis: names(raw.cliSelected),
    total: typeof raw.totalEligible === 'number' ? raw.totalEligible : null,
  }
}

export function parseRoute(raw: unknown): string | null {
  if (!isRecord(raw) || !isRecord(raw.decision)) return null
  const skill = raw.decision.skill
  return typeof skill === 'string' && skill.length > 0 ? skill : null
}

export function invokedSkill(text: string): string | null {
  const match = /^\s*\/([A-Za-z0-9][A-Za-z0-9:_.-]*)(?:\s|$)/.exec(text)
  return match?.[1] ?? null
}

export async function runSkillSelect(
  run: RunPort,
  cwd: string,
  query: string,
  runbook: string | null,
): Promise<CliResult<SkillSelect>> {
  const argv = ['skill-select', '--client', 'claude', '--query', safeTask(query), ...(runbook === null ? [] : ['--runbook', runbook])]
  const ran = await runJson(run, { bin: 'ai-harness', cwd }, argv, SELECT_TIMEOUT_MS)
  if (!ran.ok) return ran
  const parsed = parseSkillSelect(ran.value)
  return parsed === null ? { ok: false, reason: 'ai-harness skill-select output has no selected list' } : { ok: true, value: parsed }
}

export async function runRoute(run: RunPort, bin: string, cwd: string, text: string): Promise<string | null> {
  const ran = await runJson(run, { bin, cwd }, ['route-turn', safeTask(fit(text, ROUTE_TEXT_LIMIT)), '--json'], ROUTE_TIMEOUT_MS)
  return ran.ok ? parseRoute(ran.value) : null
}

export function withNames(state: ScopeState, field: 'turn' | 'invoked', add: readonly string[]): ScopeState {
  const merged = [...new Set([...state[field], ...add])]
  return { ...state, [field]: merged }
}

function itemName(item: string): string {
  const firstLine = item.slice(2).split('\n', 1)[0] ?? ''
  const cut = firstLine.indexOf(': ')
  return cut === -1 ? firstLine : firstLine.slice(0, cut)
}

// Ported from shimo4228/harness-scope (MIT), plugin/hooks/listing.ts: null means the format is not the one this build writes.
export function filterSkillListing(text: string, keep: (name: string) => boolean): Filtered | null {
  if (!text.startsWith(SKILL_HEADER)) return null
  const parts = text.split(/\n(?=- )/)
  const head = parts[0] ?? ''
  const items: string[] = []
  for (const part of parts.slice(1)) {
    const last = items.length - 1
    if (/\s/.test(itemName(part)) && last >= 0) items[last] = `${items[last]}\n${part}`
    else items.push(part)
  }
  if (items.length === 0) return null
  const removed: string[] = []
  const kept = items.filter(item => {
    const name = itemName(item)
    if (keep(name)) return true
    removed.push(name)
    return false
  })
  return { text: [head, ...kept].join('\n'), removed }
}

export function scopeHeading(mode: ScopeMode, receipt: Receipt): string {
  const skills = receipt.skills.size + receipt.hiddenSkills.size
  const agents = receipt.agents.size + receipt.hiddenAgents.size
  return [
    'Scope',
    mode,
    skills === 0 ? 'skills not listed yet' : `${receipt.skills.size} of ${skills} skills`,
    agents === 0 ? 'agents not offered yet' : `${receipt.agents.size} of ${agents} agents`,
  ].join(' · ')
}

export function keptRows(receipt: Receipt): { kind: 'skill' | 'agent'; name: string; reason: string }[] {
  return [
    ...[...receipt.skills].map(([name, reason]) => ({ kind: 'skill' as const, name, reason })),
    ...[...receipt.agents].map(([name, reason]) => ({ kind: 'agent' as const, name, reason })),
  ]
}

function grouped(entries: ReadonlyMap<string, string>): string[] {
  const by = new Map<string, string[]>()
  for (const [name, reason] of entries) by.set(reason, [...(by.get(reason) ?? []), name])
  return [...by].map(([reason, list]) => `  ${reason}: ${list.join(', ')}`)
}

export function receiptText(mode: ScopeMode, state: ScopeState, receipt: Receipt): string {
  if (mode === 'off') return 'scope is off, nothing is hidden.'
  const verb = mode === 'report' ? 'would hide' : 'hidden'
  const lines = [
    `${scopeHeading(mode, receipt)} (skill-select ${state.status}${state.query.length > 0 ? `, query "${fit(state.query, 60)}"` : ''})`,
    `skills kept ${receipt.skills.size}, ${verb} ${receipt.hiddenSkills.size}`,
    ...grouped(receipt.skills),
    `agents kept ${receipt.agents.size}, ${verb} ${receipt.hiddenAgents.size}`,
    ...grouped(receipt.agents),
  ]
  if (receipt.hiddenSkills.size > 0) lines.push(`${verb} skills: ${[...receipt.hiddenSkills].join(', ')}`)
  if (receipt.hiddenAgents.size > 0) lines.push(`${verb} agents: ${[...receipt.hiddenAgents].join(', ')}`)
  if (state.note !== null) lines.push(state.note)
  lines.push(...receipt.notes)
  lines.push('CLIs, rules and explicitly invoked skills are never hidden; a hidden skill still runs when called.')
  return lines.join('\n')
}
