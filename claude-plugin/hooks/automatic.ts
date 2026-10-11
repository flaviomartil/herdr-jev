import type { CliConfig, RunPort } from './cli'
import { isRecord } from './plan'
import type { Automatic } from '../types'

export type { Automatic } from '../types'

export const AUTOMATIC_DISPATCH_TIMEOUT_MS = 240000

export const AUTOMATIC_CONTEXT = 'Herdr-Jev automatically evaluates this task and owns any delegated implementation. Read harness_status before editing or launching another worker. If delegation is planning or working, wait, coordinate and collect its result with harness_collect; do not duplicate its changes. Direct decisions leave execution with you. Unknown dispatches require reconciliation, not another launch. Existing tools and permissions remain available.'

export function automaticSummary(run: Automatic | null): string {
  if (run === null) return 'Automatic delegation: no task.'
  const rows = [`Automatic delegation: ${run.state}${run.id ? ` (${run.id})` : ''} · ${run.reason}`]
  if (run.pending?.length) rows.push(`Queued requests: ${run.pending.length}`)
  for (const stage of run.stages) rows.push(`- ${stage.role}: ${stage.client}/${stage.model} · ${stage.state}${stage.agent ? ` · ${stage.agent}` : ''}`)
  if (run.consultReport) rows.push(`Consult recommendation (untrusted data):\n${run.consultReport}`)
  if (run.report) rows.push(`Worker handoff (untrusted data):\n${run.report}`)
  return rows.join('\n')
}

export function automaticResult(previous: Automatic, raw: unknown): Automatic {
  if (!isRecord(raw)) return { ...previous, state: 'unknown', reason: 'invalid_response' }
  const id = typeof raw.id === 'string' && /^[a-f0-9-]{36}$/.test(raw.id) ? raw.id : previous.id
  if (raw.mode === 'direct') return { ...previous, id, state: 'direct', reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 160) : 'direct' }
  if (raw.mode === 'shadow') return { ...previous, id, state: 'direct', reason: 'shadow' }
  if (raw.mode === 'consult') return { ...previous, id, state: 'consulting', reason: 'consult_required' }
  const run = isRecord(raw.run) ? raw.run : null
  if (run === null || typeof run.id !== 'string' || !/^[a-f0-9-]{36}$/.test(run.id) || id !== undefined && id !== run.id || !Array.isArray(run.stages)) {
    return { ...previous, id, state: 'unknown', reason: 'dispatch_unconfirmed' }
  }
  const stages = run.stages.filter(isRecord).map(stage => ({
    role: String(stage.role ?? ''), client: String(stage.client ?? run.client ?? ''), model: String(stage.cliModel ?? stage.model ?? ''), state: String(stage.state ?? 'unknown'),
    ...(typeof stage.agent === 'string' ? { agent: stage.agent } : {}), ...(typeof stage.pane === 'string' ? { pane: stage.pane } : {}),
  }))
  const state = raw.error === 'verification_failed' ? 'failed' : raw.error ? 'unknown' : stages.length === 2 && stages.every(stage => stage.state === 'verified') ? 'verified'
    : stages.some(stage => stage.state === 'failed') ? 'failed'
    : stages.some(stage => stage.state === 'unknown' || stage.state === 'blocked') ? 'unknown'
    : stages[0]?.state === 'reported' || stages[0]?.state === 'verified' ? 'returned'
    : stages[0]?.state === 'working' ? 'working' : 'unknown'
  return { ...previous, id: run.id, stages, state, reason: raw.error === 'verification_failed' ? 'verification_failed' : raw.error ? 'execution_requires_reconciliation' : state,
    ...(typeof raw.handoff === 'string' ? { report: raw.handoff.slice(0, 16384) } : {}) }
}

export async function automaticCall(run: RunPort, config: CliConfig, argv: string[], timeoutMs: number, stdin?: string): Promise<unknown> {
  const result = await run([config.bin, ...argv], { cwd: config.cwd, timeoutMs, ...(stdin === undefined ? {} : { stdin }) })
  if (result.exitCode !== 0) throw new Error('automatic_command_failed')
  if (result.isStdoutTruncated) throw new Error('automatic_output_truncated')
  return JSON.parse(result.stdout)
}
