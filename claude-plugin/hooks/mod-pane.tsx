import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions } from 'claude-code'
import type { OddView, DelegationRow, HarnessExternalRow, HarnessHumanAsk, HarnessPlan, HarnessUsage, HarnessWorkerRow } from '../types'
import { CLI_THEME, avatar, cliKind, nameFor, parseRosterFile } from './identity-core'
import type { CliKind } from './identity-core'
import { proposalAction, toggleDiff, visibleProposals } from './improve'
import { noteAgents } from './jev-state'
import { elapsedWord, percentOf, resetActivity, spinnerFrame, tokenWord } from './activity'
import { markUserClosed, paneWanted, resetAutoOpen } from './activity-hooks'
import type { Activity } from '../types'
import { roleMarkOf } from './art-core'
import type { RoleMark } from './art-core'
import { Art } from './pane-art'
import { currentTick, emptyCrew, reducedMotion, resetCrew } from './pane-crew'
import { buildCrew, headerText, reportLines } from './pane-rows'
import type { CrewInput, CrewModel } from './pane-rows'

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
  role: RoleMark | null
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
const proposalsAtom = atom({ plugin: 'harness', key: 'proposals' } as const, [], { shape: 'proposals-1' })
const expandedAtom = atom({ plugin: 'harness', key: 'proposalExpanded' } as const, '')
const usageAtom = atom({ plugin: 'harness', key: 'usage' } as const, null)

const activityAtom = atom({ plugin: 'harness', key: 'activity' } as const, {}, { shape: 'activity-1' })
const crewAtom = atom({ plugin: 'harness', key: 'crew' } as const, emptyCrew())
const pageAtom = atom({ plugin: 'harness', key: 'crewPage' } as const, 0)
const progressAtom = atom({ plugin: 'harness', key: 'flowProgress' } as const, null)
const expandedAtom = atom({ plugin: 'harness', key: 'expandedAgents' } as const, {})
const WORKER_CLI = { 'claude-subagent': 'claude', codex: 'codex', agy: 'agy' } as const

const WORKER_ROLE: Record<string, RoleMark> = { implementer: 'implement', reviewer: 'review', reader: 'explore' }
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
      role: roleMarkOf(run.class),
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
      role: WORKER_ROLE[worker.role] ?? null,
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
      role: null,
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
      role: null,
      act,
    })
  }
  return [...rows.values()]
}

export async function readModData($: EngineInterface): Promise<ModData> {
  return {
    delegations: await read($, delegationsAtom),
    roster: await read($, rosterIdsAtom),
    plan: await read($, planAtom),
    asks: await read($, needsYouAtom),
    workers: await read($, workersAtom),
    external: await read($, externalAtom),
    usage: await read($, usageAtom),
    activity: await read($, activityAtom),
  }
}

export function crewInputs(rows: AgentRow[], roster: Record<string, number>, names: string[]): CrewInput[] {
  return rows.map((row, at) => {
    const unknown = rows.slice(0, at).filter(r => roster[r.id] === undefined).length
    return {
      id: row.id,
      actId: row.act?.id ?? null,
      name: nameFor(roster, row.id, unknown, names.length > 0 ? names : undefined),
      kind: row.kind,
      cli: row.cli,
      role: row.role,
      state: row.state,
      line: row.act !== null && row.act.line !== '' ? row.act.line : row.detail,
      percent: row.percent,
      act: row.act,
    }
  })
}

export async function crewModelNow($: EngineInterface): Promise<{ model: CrewModel; data: ModData; rows: AgentRow[] }> {
  const data = await readModData($)
  const rows = agentRows(data)
  const crew = await read($, crewAtom)
  const model = buildCrew(crewInputs(rows, data.roster, await personalNames($)), { ...crew, now: await $.clock.now(), page: await read($, pageAtom) })
  return { model, data, rows }
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
  resetCrew()
  resetAutoOpen()
}

export async function personalNames($: EngineInterface): Promise<string[]> {
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

export function registerModPane(on: On, options: PluginOptions): void {
  on('state.set', async ($, e, next) => {
    const done = await next(e)
    if (e.plugin === 'harness' && (e.key === 'external' || e.key === 'workers')) {
      const value = (e as { value?: unknown }).value
      if (typeof value === 'object' && value !== null) await noteAgents($, Object.values(value as Record<string, { agentId?: string }>).map(r => r.agentId ?? '').filter(id => id !== ''))
    }
    return done
  })
  on('command.run', { command: 'jev' }, async ($, e) => {
    paneWanted()
    const focus = e.args.trim() === 'open'
    const opened = await $.ui.open({ id: MOD_PANE_ID, title: 'Jev', closeOnEscape: true, ...(focus ? { focus: true } : {}) })
    if (opened?.isPlaced !== false) return { text: focus ? 'Jev pane focused.' : 'Jev pane opened.' }
    return { text: reportLines((await crewModelNow($)).model).join('\n') }
  })
  on('ui.render', { component: 'Pane', requestId: MOD_PANE_ID }, async ($, e) => {
    const table = $.ui.resolve(e) as unknown as Record<string, any>
    const { Box, Button, Text } = table
    const kit = { Box, Text }
    const names = await personalNames($)
    const columns = Math.max(24, e.props.bodyColumns)
    const withFace = columns >= 44
    const data = await readModData($)
    const expanded = await read($, expandedAtom)
    const now = await $.clock.now()
    const odd = await read($, oddAtom)
    const proposals = visibleProposals(await read($, proposalsAtom))
    const expanded = await read($, expandedAtom)
    const rows = agentRows(data)
    const crew = await read($, crewAtom)
    const model = buildCrew(crewInputs(rows, data.roster, names), { ...crew, now, page: await read($, pageAtom) })
    const byId = new Map(rows.map(r => [r.id, r]))
    const flow = await read($, progressAtom)
    const oddNow = odd.current === null ? undefined : odd.features.find(f => f.name === odd.current)
    const header = headerText(
      flow,
      oddNow === undefined ? null : { name: oddNow.name, done: oddNow.done, total: oddNow.total, phase: odd.phase === null ? null : PHASE_WORD[odd.phase] },
    )
    const isTerminal = e.surface === 'terminal'
    const artKit = { Box, Text, Raster: isTerminal ? table.Raster : undefined, Svg: isTerminal ? undefined : table.Svg }
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
          {header !== null && <Text key="flow-header" dimColor wrap="truncate-end">{`  ${header}`}</Text>}
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
          {model.hub !== null && <Text key="hub" bold>{`◆ lead · ${model.hub.running}/${model.hub.total} trabalhando`}</Text>}
          {rows.length === 0
            ? empty('work-0', 'Nenhum agente ativo.')
            : model.pageRows.map(view => {
                const row = byId.get(view.id) as AgentRow
                const name = view.name
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
                    <Box key={row.id} flexDirection="column" paddingLeft={view.depth * 2}>
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
                  <Box key={row.id} flexDirection="row" columnGap={1} marginTop={1} paddingLeft={view.depth * 2}>
                    {withFace && Art(artKit, { key: `av-${row.id}`, kind: row.kind, state: view.artState, role: row.role, lead: view.isLead, ageMs: view.ageMs, tick: currentTick(), reducedMotion: reducedMotion(options), fallback: avatar(row.kind, row.id) })}
                    <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                      <Box flexDirection="row" columnGap={1}>
                        {toggle}
                        <Text bold color={color}>{name}</Text>
                        <Text dimColor>{row.cli}</Text>
                        <Text color={color}>{`[${chip}]`}</Text>
                        <Text color={view.color}>{`${view.glyph} ${row.state === 'queued' ? STATE_WORD.queued : view.word}`}</Text>
                        <Box flexGrow={1} />
                        {elapsed !== '' && <Text dimColor>{elapsed}</Text>}
                      </Box>
                      <Box flexDirection="row" columnGap={1}>
                        <Text dimColor>{act?.phase ?? row.phase}</Text>
                        {act?.attempt != null && act.attempt > 1 && <Text dimColor>{`tentativa ${act.attempt}`}</Text>}
                        {progress}
                      </Box>
                      <Text dimColor wrap="truncate-end">{clip(doing, Math.max(10, columns - (withFace ? 12 : 4)))}</Text>
                      {act !== null && act.snippet !== '' && <Text dimColor wrap="truncate-end">{`» ${clip(act.snippet, Math.max(10, columns - (withFace ? 14 : 6)))}`}</Text>}
                      {tail}
                    </Box>
                  </Box>
                )
              })}
          {model.unknown.length > 0 && <Text key="unknown" dimColor>{`? ${model.unknown.length} agentes desconhecidos`}</Text>}
          {model.pages > 1 && (
            <Box key="pager" flexDirection="row" columnGap={1}>
              <Button key="pg-prev" plain hotkey="p" label="◀" onPress={() => update($, pageAtom, cur => Math.max(0, cur - 1))} />
              <Text dimColor>{`${model.page + 1}/${model.pages}`}</Text>
              <Button key="pg-next" plain hotkey="n" label="▶" onPress={() => update($, pageAtom, cur => Math.min(model.pages - 1, cur + 1))} />
            </Box>
          )}
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
          {proposals.shown.length === 0 && empty('prop-0', 'Sem propostas.')}
          {proposals.shown.map(p => (
            <Box key={`prop-${p.id}`} flexDirection="column">
              <Box flexDirection="row" columnGap={1}>
                <Text bold>{p.kind}</Text>
                <Text wrap="truncate-end">{p.name}</Text>
                <Text dimColor>{`${p.count}x/${p.sessions}s`}</Text>
              </Box>
              <Box flexDirection="row" columnGap={2}>
                <Button key={`ok-${p.id}`} label="Approve" onPress={() => void proposalAction($, 'approve', p.id)} />
                <Button key={`no-${p.id}`} label="Reject" onPress={() => void proposalAction($, 'reject', p.id)} />
                <Button key={`df-${p.id}`} plain dimColor label="View diff" onPress={() => void toggleDiff($, p.id)} />
              </Box>
              {expanded === p.id && p.diff.split('\n').slice(0, 14).map((line, i) => <Text key={`d${p.id}-${i}`} dimColor wrap="truncate-end">{line}</Text>)}
            </Box>
          ))}
          {proposals.hidden > 0 && empty('prop-more', `+${proposals.hidden} mais`)}
        </Box>
      </Box>
    )
  })
}
