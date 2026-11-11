import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { OddView, DelegationRow, HarnessExternalRow, HarnessHumanAsk, HarnessPlan, HarnessUsage, HarnessWorkerRow } from '../types'
import { CLI_THEME, avatar, avatarRuns, cliKind, nameFor, parseRosterFile } from './identity-core'
import type { Avatar, CliKind } from './identity-core'
import { noteAgents } from './jev-state'
import { elapsedWord, percentOf, resetActivity, signalOf, spinnerFrame, tokenWord } from './activity'
import { markUserClosed, paneWanted, resetAutoOpen } from './activity-hooks'
import type { Activity } from '../types'

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
  act: Activity | null
}
export type ModData = {
  delegations: DelegationRow[]
  roster: Record<string, number>
  plan: HarnessPlan | null
  asks: HarnessHumanAsk[]
  workers: Record<string, HarnessWorkerRow>
  external: Record<string, HarnessExternalRow>
  usage: HarnessUsage | null
  activity?: Record<string, Activity>
}
const planAtom = atom({ plugin: 'harness', key: 'plan' } as const, null)
const workersAtom = atom({ plugin: 'harness', key: 'workers' } as const, {})
const needsYouAtom = atom({ plugin: 'harness', key: 'needsYou' } as const, [])
const externalAtom = atom({ plugin: 'harness', key: 'external' } as const, {})
const delegationsAtom = atom({ plugin: 'harness', key: 'delegations' } as const, [], { shape: 'delegations-1' })
const rosterIdsAtom = atom({ plugin: 'harness', key: 'rosterIds' } as const, {}, { shape: 'roster-1' })
const oddAtom = atom({ plugin: 'harness', key: 'odd' } as const, { repo: '', current: null, features: [], phase: null } as OddView, { shape: 'odd-1' })
const usageAtom = atom({ plugin: 'harness', key: 'usage' } as const, null)

const activityAtom = atom({ plugin: 'harness', key: 'activity' } as const, {}, { shape: 'activity-1' })
const expandedAtom = atom({ plugin: 'harness', key: 'expandedAgents' } as const, {})
const WORKER_CLI = { 'claude-subagent': 'claude', codex: 'codex', agy: 'agy' } as const

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const realPercent = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value) : null

export function agentRows(data: ModData): AgentRow[] {
  const rows = new Map<string, AgentRow>()
  for (const run of data.delegations) {
    const cli = WORKER_CLI[run.worker as keyof typeof WORKER_CLI] ?? run.worker
    const state: AgentState =
      run.state === 'running' ? 'working' : run.state === 'queued' ? 'queued' : run.state === 'done' ? 'done' : 'failed'
    rows.set(run.id, {
      id: run.id,
      kind: cliKind(cli, run.model),
      cli,
      model: run.model,
      effort: run.effort,
      phase: run.class,
      state,
      percent: percentOf(data.activity?.[run.act ?? '']),
      detail: clip(run.task, 60),
      act: data.activity?.[run.act ?? ''] ?? null,
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
      percent: percentOf(data.activity?.[worker.agentId]),
      detail: worker.lastTool ?? clip(task?.title ?? '', 60),
      act: data.activity?.[worker.agentId] ?? null,
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
      percent: percentOf(data.activity?.[ext.agentId]),
      detail: clip(ext.lastLine, 60),
      act: data.activity?.[ext.agentId] ?? null,
    })
  }
  const claimed = new Set([...rows.values()].map(r => r.act?.id).filter((id): id is string => id !== undefined))
  for (const act of Object.values(data.activity ?? {})) {
    if (claimed.has(act.id)) continue
    rows.set(`act-${act.id}`, {
      id: act.id,
      kind: cliKind('claude', null),
      cli: 'claude',
      model: '?',
      effort: null,
      phase: 'subagente',
      state: act.end === 'done' ? 'done' : act.end === 'failed' ? 'failed' : 'working',
      percent: percentOf(act),
      detail: clip(act.line, 60),
      act,
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

let rosterNames: string[] | null = null
export function resetModPane(): void {
  rosterNames = null
  resetActivity()
  resetAutoOpen()
}

async function personalNames($: EngineInterface): Promise<string[]> {
  if (rosterNames !== null) return rosterNames
  try {
    const home = await $.env.get('HOME')
    rosterNames = home === undefined ? [] : parseRosterFile(await $.fs.read(`${home}/${ROSTER_FILE}`))
  } catch {
    rosterNames = []
  }
  return rosterNames
}

const PHASE_WORD = { explore: 'explorando', implement: 'implementando', verify: 'verificando' } as const
const EXPAND_LINES = 8
const LIMIT_LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d' }
const limitLabel = (kind: string): string => LIMIT_LABEL[kind] ?? kind.replace(/_/g, ' ')

function Face({ Box, Text }: { Box: any; Text: any }, av: Avatar, key: string) {
  return (
    <Box key={key} flexDirection="column" width={6} flexShrink={0}>
      {avatarRuns(av).map((row, y) => (
        <Box key={`${key}-${y}`} flexDirection="row">
          {row.map((run, x) => (
            <Text key={`${key}-${y}-${x}`} color={run.fg} backgroundColor={run.bg}>
              {run.text}
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
  on('state.set', async ($, e, next) => {
    const done = await next(e)
    if (e.plugin === 'harness' && (e.key === 'external' || e.key === 'workers')) {
      const value = (e as { value?: unknown }).value
      if (typeof value === 'object' && value !== null) await noteAgents($, Object.values(value as Record<string, { agentId?: string }>).map(r => r.agentId ?? '').filter(id => id !== ''))
    }
    return done
  })
  on('command.run', { command: 'jev' }, async $ => {
    paneWanted()
    await $.ui.open({ id: MOD_PANE_ID, title: 'Jev', closeOnEscape: true })
    return { text: 'Jev pane opened.' }
  })
  on('ui.render', { component: 'Pane', requestId: MOD_PANE_ID }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const kit = { Box, Text }
    const names = await personalNames($)
    const columns = Math.max(24, e.props.bodyColumns)
    const withFace = columns >= 44
    const data: ModData = {
      delegations: await read($, delegationsAtom),
      roster: await read($, rosterIdsAtom),
      plan: await read($, planAtom),
      asks: await read($, needsYouAtom),
      workers: await read($, workersAtom),
      external: await read($, externalAtom),
      usage: await read($, usageAtom),
      activity: await read($, activityAtom),
    }
    const expanded = await read($, expandedAtom)
    const now = await $.clock.now()
    const odd = await read($, oddAtom)
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
          <Button key="close" plain dimColor label="✕" onPress={() => {
            markUserClosed()
            return $.ui.close({ id: MOD_PANE_ID })
          }} />
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
          {odd.features.map(f => (
            <Box key={`odd-${f.name}`} flexDirection="row" columnGap={1}>
              <Text wrap="truncate-end">{f.name}</Text>
              {bar(kit, `odd-bar-${f.name}`, f.percent, 'success')}
              <Text dimColor>{`${f.done}/${f.total}`}</Text>
              {odd.current === f.name && odd.phase !== null && <Text dimColor>{PHASE_WORD[odd.phase]}</Text>}
            </Box>
          ))}
          {rows.length === 0
            ? empty('work-0', 'Nenhum agente ativo.')
            : rows.map((row, at) => {
                const unknown = rows.slice(0, at).filter(r => data.roster[r.id] === undefined).length
                const name = nameFor(data.roster, row.id, unknown, names.length > 0 ? names : undefined)
                const color = CLI_THEME[row.kind]
                const chip = row.effort === null ? row.model : `${row.model}·${row.effort}`
                const act = row.act
                const isFinished = row.state === 'done' || row.state === 'failed'
                const isOpen = expanded[row.id] === true
                const elapsed = act === null ? '' : elapsedWord((act.endedAt ?? now) - act.startedAt)
                const toggle = (
                  <Button
                    key={`tg-${row.id}`}
                    plain
                    dimColor
                    label={isOpen ? '▾' : '▸'}
                    onPress={() => update($, expandedAtom, cur => ({ ...cur, [row.id]: !cur[row.id] }))}
                  />
                )
                const tail = isOpen && act !== null && act.log.length > 0 && (
                  <Box key={`log-${row.id}`} flexDirection="column" paddingLeft={2}>
                    {act.log.slice(-EXPAND_LINES).map((line, i) => (
                      <Text key={`${row.id}-l${i}`} dimColor wrap="truncate-end">{line}</Text>
                    ))}
                  </Box>
                )
                if (isFinished) {
                  const mark = row.state === 'done' ? '✓' : '✗'
                  const result = clip(act?.snippet ?? row.detail, Math.max(10, columns - 34))
                  return (
                    <Box key={row.id} flexDirection="column">
                      <Box flexDirection="row" columnGap={1}>
                        {toggle}
                        <Text bold color={color}>{name}</Text>
                        <Text dimColor>{row.cli}</Text>
                        <Text color={STATE_COLOR[row.state]}>{`${mark} ${STATE_WORD[row.state]}`}</Text>
                        <Text dimColor wrap="truncate-end">{result}</Text>
                        {elapsed !== '' && <Text dimColor>{elapsed}</Text>}
                      </Box>
                      {tail}
                    </Box>
                  )
                }
                const steps = act === null ? 0 : act.steps
                const progress =
                  realPercent(row.percent) !== null ? (
                    <Box key={`pr-${row.id}`} flexDirection="row" columnGap={1}>
                      {bar(kit, `pb-${row.id}`, row.percent as number, color)}
                      {act?.stepTotal != null && <Text dimColor>{`passo ${act.stepDone ?? 0}/${act.stepTotal}`}</Text>}
                    </Box>
                  ) : row.state === 'queued' ? null : (
                    <Box key={`pr-${row.id}`} flexDirection="row" columnGap={1}>
                      <Text color={color}>{spinnerFrame(now)}</Text>
                      <Text dimColor>{steps > 0 ? `${steps} passos` : 'iniciando'}</Text>
                      {act !== null && act.tokens > 0 && <Text dimColor>{tokenWord(act.tokens)}</Text>}
                    </Box>
                  )
                const doing = act !== null && act.line !== '' ? act.line : row.detail
                return (
                  <Box key={row.id} flexDirection="row" columnGap={1} marginTop={1}>
                    {withFace && Face(kit, avatar(row.kind, row.id), `av-${row.id}`)}
                    <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                      <Box flexDirection="row" columnGap={1}>
                        {toggle}
                        <Text bold color={color}>{name}</Text>
                        <Text dimColor>{row.cli}</Text>
                        <Text color={color}>{`[${chip}]`}</Text>
                        <Text color={STATE_COLOR[row.state]}>{STATE_WORD[row.state]}</Text>
                        <Box flexGrow={1} />
                        {elapsed !== '' && <Text dimColor>{elapsed}</Text>}
                      </Box>
                      <Box flexDirection="row" columnGap={1}>
                        <Text dimColor>{act?.phase ?? row.phase}</Text>
                        {act?.attempt != null && act.attempt > 1 && <Text dimColor>{`tentativa ${act.attempt}`}</Text>}
                        {progress}
                        {act !== null && signalOf(act, now) === 'slow' && <Text color="warning">lento</Text>}
                        {act !== null && signalOf(act, now) === 'quiet' && <Text color="warning">quieto</Text>}
                      </Box>
                      <Text dimColor wrap="truncate-end">{clip(doing, Math.max(10, columns - (withFace ? 12 : 4)))}</Text>
                      {act !== null && act.snippet !== '' && <Text dimColor wrap="truncate-end">{`» ${clip(act.snippet, Math.max(10, columns - (withFace ? 14 : 6)))}`}</Text>}
                      {tail}
                    </Box>
                  </Box>
                )
              })}
        </Box>
        <Box key="models" flexDirection="column">
          {head('models-h', 'Modelos e proxies')}
          {limits.map(limit => (
            <Box key={limit.kind} flexDirection="row" columnGap={1}>
              <Text>{limitLabel(limit.kind)}</Text>
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
