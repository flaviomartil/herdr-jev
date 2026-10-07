import type { PluginOptions, ProcessRunInit, ProcessRunResult } from 'claude-code'

import { normalizeModels, normalizeReview, normalizeTriage } from './plan'
import type { ReviewResult, TriageResult } from './plan'
import type { HarnessRoleTable } from '../types'

export type CliResult<T> = { ok: true; value: T } | { ok: false; reason: string; timedOut?: boolean }

export type RunPort = (
  argv: readonly string[],
  init: ProcessRunInit,
) => Promise<ProcessRunResult>

export type CliConfig = {
  bin: string
  cwd: string
}

const DEFAULT_BIN = 'herdr-jev'
const QUICK_TIMEOUT_MS = 30000
const REVIEW_PROCESS_TIMEOUT_MS = 600000
const REVIEW_JUDGE_TIMEOUT_MS = 540000
const TIMEOUT_MESSAGE = /time[ds]? ?out|still running/i

export function cliConfig(options: PluginOptions, cwd: string): CliConfig {
  const configured = options.herdrJevBin
  const bin = typeof configured === 'string' && configured.trim().length > 0 ? configured.trim() : DEFAULT_BIN
  return { bin, cwd }
}

export function maxWorkers(options: PluginOptions): number {
  const configured = options.maxWorkers
  return typeof configured === 'number' && Number.isFinite(configured) && configured >= 1
    ? Math.floor(configured)
    : 3
}

export function autoRun(options: PluginOptions): boolean {
  return options.autoRun !== false
}

export function autoReview(options: PluginOptions): boolean {
  return options.autoReview === true
}

function parseJson(stdout: string): CliResult<unknown> {
  const body = stdout.trim()
  if (body.length === 0) return { ok: false, reason: 'empty output' }

  try {
    return { ok: true, value: JSON.parse(body) as unknown }
  } catch {
    const start = body.indexOf('{')
    const end = body.lastIndexOf('}')
    if (start < 0 || end <= start) return { ok: false, reason: 'output is not JSON' }
    try {
      return { ok: true, value: JSON.parse(body.slice(start, end + 1)) as unknown }
    } catch {
      return { ok: false, reason: 'output is not valid JSON' }
    }
  }
}

function firstLine(value: string): string {
  const line = value.split('\n').find(one => one.trim().length > 0)
  return line === undefined ? '' : line.trim().slice(0, 160)
}

export async function runJson(
  run: RunPort,
  config: CliConfig,
  argv: readonly string[],
  timeoutMs: number,
): Promise<CliResult<unknown>> {
  const label = `${config.bin} ${argv[0] ?? ''}`.trim()
  try {
    const ran = await run([config.bin, ...argv], { cwd: config.cwd, timeoutMs })
    const parsed = parseJson(ran.stdout)
    if (parsed.ok) return parsed
    if (ran.exitCode !== 0) {
      const detail = firstLine(ran.stderr)
      return {
        ok: false,
        reason: `${label} exited ${ran.exitCode}${detail.length > 0 ? `: ${detail}` : ''}`,
      }
    }
    return { ok: false, reason: `${label}: ${parsed.reason}` }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (TIMEOUT_MESSAGE.test(message)) {
      return { ok: false, reason: `${label} timed out after ${Math.round(timeoutMs / 1000)} s`, timedOut: true }
    }
    return { ok: false, reason: `${label} failed: ${message.slice(0, 160)}` }
  }
}

export function safeTask(task: string): string {
  const clean = task.replace(/\s+/g, ' ').trim()
  return clean.startsWith('-') ? `Task: ${clean}` : clean
}

export async function runTriage(
  run: RunPort,
  config: CliConfig,
  task: string,
): Promise<CliResult<TriageResult>> {
  const ran = await runJson(run, config, ['triage', safeTask(task), '--json'], QUICK_TIMEOUT_MS)
  if (!ran.ok) return ran
  const triage = normalizeTriage(ran.value)
  return triage === null ? { ok: false, reason: 'triage output has no complexity' } : { ok: true, value: triage }
}

export async function runModels(
  run: RunPort,
  config: CliConfig,
): Promise<CliResult<HarnessRoleTable>> {
  const ran = await runJson(run, config, ['models', 'list', '--json', '--client', 'claude'], QUICK_TIMEOUT_MS)
  if (!ran.ok) return ran
  const table = normalizeModels(ran.value)
  return table === null ? { ok: false, reason: 'models list output has no roles' } : { ok: true, value: table }
}

export async function runReview(run: RunPort, config: CliConfig): Promise<CliResult<ReviewResult>> {
  const ran = await runJson(
    run,
    config,
    ['review', '--json', '--timeout-ms', String(REVIEW_JUDGE_TIMEOUT_MS)],
    REVIEW_PROCESS_TIMEOUT_MS,
  )
  if (!ran.ok) return ran
  const review = normalizeReview(ran.value)
  return review === null ? { ok: false, reason: 'review output is not an object' } : { ok: true, value: review }
}
