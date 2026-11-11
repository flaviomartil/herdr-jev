import { atom, read } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { HarnessExternalRow, HarnessHumanAsk, HarnessPlan, HarnessUsage, HarnessWorkerRow } from '../types'
import { Roster, avatar, cliKind, parseRosterFile } from './identity-core'
import type { Avatar, CliKind } from './identity-core'
import { CLI_COLORS } from './identity-core'
import { delegationRuns } from './delegation'

export const MOD_PANE_ID = 'jev'
const ROSTER_FILE = '.config/jev/roster.json'

export type AgentState = 'working' | 'queued' | 'done' | 'failed'
export type AgentRow = {
  id: string
  kind: CliKind
  cli: string
  model: string
  effort: string | null
  phase: string
  state: AgentState
  percent: number | null
  detail: string
}
export type ModData = {
  plan: HarnessPlan | null
  asks: HarnessHumanAsk[]
  workers: Record<string, HarnessWorkerRow>
  external: Record<string, HarnessExternalRow>
  usage: HarnessUsage | null
}
const planAtom = atom({ plugin: 'harness', key: 'plan' } as const, null)
const workersAtom = atom({ plugin: 'harness', key: 'workers' } as const, {})
const needsYouAtom = atom({ plugin: 'harness', key: 'needsYou' } as const, [])
const externalAtom = atom({ plugin: 'harness', key: 'external' } as const, {})
const usageAtom = atom({ plugin: 'harness', key: 'usage' } as const, null)

const WORKER_CLI = { 'claude-subagent': 'claude', codex: 'codex', agy: 'agy' } as const

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const realPercent = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value) : null

export function agentRows(data: ModData): AgentRow[] {
  const rows = new Map<string, AgentRow>()
  for (const run of delegationRuns()) {
    const cli = WORKER_CLI[run.worker as keyof typeof WORKER_CLI] ?? run.worker
    const state: AgentState =
      run.state === 'running' ? 'working' : run.state === 'queued' ? 'queued' : run.state === 'done' ? 'done' : 'failed'
    rows.set(run.agentId ?? run.runId, {
      id: run.agentId ?? run.runId,
      kind: cliKind(cli, run.model),
      cli,
      model: run.model,
      effort: run.effort,
      phase: run.class,
      state,
      percent: null,
      detail: clip(run.task, 60),
    })
  }
  for (const worker of Object.values(data.workers)) {
    const task = data.plan?.tasks.find(t => t.id === worker.taskId)
    rows.set(worker.agentId, {
      id: worker.agentId,
      kind: cliKind('claude', worker.model),
      cli: 'claude',
      model: worker.model ?? '?',
      effort: task?.effort ?? null,
      phase: task?.state ?? 'running',
      state: task?.state === 'failed' ? 'failed' : task?.state === 'done' ? 'done' : 'working',
      percent: null,
      detail: worker.lastTool ?? clip(task?.title ?? '', 60),
    })
  }
  for (const ext of Object.values(data.external)) {
    rows.set(ext.agentId, {
      id: ext.agentId,
      kind: cliKind(ext.client, ext.model),
      cli: ext.client,
      model: ext.model ?? '?',
      effort: null,
      phase: ext.status,
      state: ext.status === 'running' ? 'working' : ext.status === 'done' ? 'done' : 'failed',
      percent: null,
      detail: clip(ext.lastLine, 60),
    })
  }
  return [...rows.values()]
}

export function featureShare(plan: HarnessPlan | null): { done: number; total: number; percent: number } | null {
  if (plan === null || plan.tasks.length === 0) return null
  const done = plan.tasks.filter(t => t.state === 'done' || t.state === 'verified' || t.state === 'approved').length
  return { done, total: plan.tasks.length, percent: Math.round((done / plan.tasks.length) * 100) }
}

export function needsRows(data: ModData, rows: AgentRow[]): string[] {
  const lines = data.asks.map(ask => `pergunta: ${clip(ask.question, 80)}`)
  for (const task of data.plan?.tasks ?? []) {
    if (task.state === 'needs_you') lines.push(`precisa de voce: ${clip(task.title, 70)}`)
    if (task.state === 'failed') lines.push(`falhou: ${clip(task.title, 70)}`)
  }
  for (const row of rows) if (row.state === 'failed' && row.cli !== 'claude') lines.push(`erro: ${row.cli} ${clip(row.detail, 60)}`)
  return lines
}

const STATE_COLOR: Record<AgentState, string> = { working: 'success', queued: 'inactive', done: 'success', failed: 'error' }
const STATE_WORD: Record<AgentState, string> = { working: 'trabalhando', queued: 'na fila', done: 'pronto', failed: 'falhou' }

let roster = new Roster()
let rosterNames: string[] | null = null
export function resetModPane(): void {
  roster = new Roster()
  rosterNames = null
}

async function personalNames($: EngineInterface): Promise<string[]> {
  if (rosterNames !== null) return rosterNames
  try {
    const home = await $.env.get('HOME')
    rosterNames = home === undefined ? [] : parseRosterFile(await $.fs.read(`${home}/${ROSTER_FILE}`))
  } catch {
    rosterNames = []
  }
  if (rosterNames.length > 0) roster = new Roster(rosterNames)
  return rosterNames
}

function Face({ Box, Text }: { Box: any; Text: any }, av: Avatar, key: string) {
  return (
    <Box key={key} flexDirection="column" width={6} flexShrink={0}>
      {av.rows.map((row, y) => (
        <Box key={`${key}-${y}`} flexDirection="row">
          {row.map((cell, x) => (
            <Text key={`${key}-${y}-${x}`} color={cell.fg} backgroundColor={cell.bg}>
              {cell.ch}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  )
}

function bar(kit: { Box: any; Text: any }, key: string, percent: number, color: string) {
  const { Box, Text } = kit
  const filled = Math.round(percent / 10)
  return (
    <Box key={key} flexDirection="row" columnGap={1}>
      <Text color={color}>{'━'.repeat(filled)}</Text>
      <Text dimColor>{'─'.repeat(10 - filled)}</Text>
      <Text dimColor>{`${percent}%`}</Text>
    </Box>
  )
}

export function registerModPane(on: On): void {
  on('command.run', { command: 'jev' }, async $ => {
    await $.ui.open({ id: MOD_PANE_ID, title: 'Jev', closeOnEscape: true })
    return { text: 'Jev pane opened.' }
  })
  on('ui.render', { component: 'Pane', requestId: MOD_PANE_ID }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const kit = { Box, Text }
    await personalNames($)
    const data: ModData = {
      plan: await read($, planAtom),
      asks: await read($, needsYouAtom),
      workers: await read($, workersAtom),
      external: await read($, externalAtom),
      usage: await read($, usageAtom),
    }
    const rows = agentRows(data)
    const share = featureShare(data.plan)
    const needs = needsRows(data, rows)
    const limits = data.usage?.limits ?? []
    const head = (key: string, label: string) => (
      <Text key={key} bold dimColor>{`── ${label}`}</Text>
    )
    const empty = (key: string, text: string) => <Text key={key} dimColor>{text}</Text>
    return (
      <Box flexDirection="column" paddingX={1} rowGap={1}>
        <Box flexDirection="row" alignItems="center">
          <Text bold>Jev</Text>
          <Box flexGrow={1} />
          <Button key="close" plain dimColor label="✕" onPress={() => $.ui.close({ id: MOD_PANE_ID })} />
        </Box>
        <Box key="needs" flexDirection="column">
          {head('needs-h', 'Precisa de voce')}
          {needs.length === 0 ? empty('needs-0', 'Nada pendente.') : needs.map((line, i) => <Text key={`n${i}`} color="warning">{`☐ ${line}`}</Text>)}
        </Box>
        <Box key="work" flexDirection="column">
          {head('work-h', 'Trabalhando')}
          {share !== null && (
            <Box key="feature" flexDirection="row" columnGap={1}>
              <Text wrap="truncate-end">{data.plan?.objective ?? ''}</Text>
              {bar(kit, 'feature-bar', share.percent, 'success')}
              <Text dimColor>{`${share.done}/${share.total}`}</Text>
            </Box>
          )}
          {rows.length === 0
            ? empty('work-0', 'Nenhum agente ativo.')
            : rows.map(row => {
                const name = roster.name(row.id)
                const color = CLI_COLORS[row.kind]
                const chip = row.effort === null ? row.model : `${row.model}·${row.effort}`
                return (
                  <Box key={row.id} flexDirection="row" columnGap={1} marginTop={1}>
                    {Face(kit, avatar(row.kind, row.id), `av-${row.id}`)}
                    <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                      <Box flexDirection="row" columnGap={1}>
                        <Text bold color={color}>{name}</Text>
                        <Text dimColor>{row.cli}</Text>
                        <Text color={color}>{`[${chip}]`}</Text>
                        <Text color={STATE_COLOR[row.state]}>{STATE_WORD[row.state]}</Text>
                      </Box>
                      <Box flexDirection="row" columnGap={1}>
                        <Text dimColor>{row.phase}</Text>
                        {realPercent(row.percent) !== null && bar(kit, `pb-${row.id}`, row.percent as number, color)}
                        <Text dimColor wrap="truncate-end">{row.detail}</Text>
                      </Box>
                    </Box>
                  </Box>
                )
              })}
        </Box>
        <Box key="models" flexDirection="column">
          {head('models-h', 'Modelos e proxies')}
          {limits.map(limit => (
            <Box key={limit.kind} flexDirection="row" columnGap={1}>
              <Text>{limit.kind === 'five_hour' ? '5h' : '7d'}</Text>
              {bar(kit, `lim-${limit.kind}`, Math.max(0, Math.min(100, Math.round(limit.percentUsed))), limit.percentUsed >= 90 ? 'error' : 'success')}
            </Box>
          ))}
          {empty('models-lock', 'Lockouts: sem dados.')}
          {empty('models-proxy', 'Proxies: sem dados.')}
        </Box>
        <Box key="proposals" flexDirection="column">
          {head('prop-h', 'Propostas')}
          {empty('prop-0', 'Sem propostas.')}
        </Box>
      </Box>
    )
  })
}
