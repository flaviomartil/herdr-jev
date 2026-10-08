import { atom, read } from 'claude-code'
import type { EngineInterface, On, PluginOptions, ToolCheckResult } from 'claude-code'

import { detectPr } from './pr-detect'
import type { DirectoryPlan, PrDetection } from './pr-detect'

export type GateStatus = { status: string; reason?: string }

export type ReviewIdentity = { client: string; session: string; at: number }

export type Held = { status: GateStatus; dir: string | null }

const STATUS_TIMEOUT_MS = 5000
const GIT_TIMEOUT_MS = 5000
const STATUS_PATTERN = /^[a-z_]{1,40}$/
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

const reviewIdsAtom = atom({ plugin: 'harness', key: 'reviewIds' } as const, {})

const ADVICE =
  'Ask the user to run `/harness review` (or press Refresh review in the /harness pane), address the findings before publishing, or tell the user the PR is unreviewed.'

const clean = (value: string): string => value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 160)

export const parseStatus = (value: unknown): GateStatus => {
  if (value === null) return { status: 'none' }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const status = (value as Record<string, unknown>).status
    if (typeof status === 'string' && STATUS_PATTERN.test(status)) return { status }
  }
  return { status: 'unknown', reason: 'the status output had no usable status' }
}

export const resolveDir = (target: string | undefined, sessionCwd: string, home: string | undefined): string | null => {
  if (target === undefined || target.length === 0) return sessionCwd
  let base = target
  if (target === '~' || target.startsWith('~/')) {
    if (home === undefined || home.length === 0) return null
    base = `${home}${target.slice(1)}`
  } else if (target.startsWith('~')) {
    return null
  }
  const parts = (base.startsWith('/') ? base : `${sessionCwd}/${base}`).split('/')
  const stack: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') stack.pop()
    else stack.push(part)
  }
  return `/${stack.join('/')}`
}

export const sameRepo = (named: string, urls: readonly string[]): boolean => {
  const want = named.toLowerCase().replace(/\.git$/, '')
  if (want.length === 0 || /[\s$*?{}`]/.test(want)) return false
  return urls.some(url => {
    const one = url.toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '')
    return one.endsWith(`/${want}`) || one.endsWith(`:${want}`)
  })
}

const where = (dir: string | null): string => (dir === null ? '' : ` for ${clean(dir)}`)

export const noticeText = (status: GateStatus, dir: string | null): string => {
  const lead = `Review status read before the PR command${where(dir)}`
  if (status.status === 'ready') return `${lead}: ready.`
  if (status.status === 'unknown') {
    const why = status.reason === undefined ? '' : ` (${clean(status.reason)})`
    return `${lead}: unknown${why}. The status could not be read, so nothing is claimed about the review. ${ADVICE}`
  }
  const absent =
    status.status === 'none'
      ? ' This mod has no review recorded for the repository; a review started from a shell is not found by this check.'
      : ''
  return `${lead}: ${status.status}. No ready independent review is recorded for this change.${absent} ${ADVICE}`
}

export const askReason = (held: Held): string =>
  `Harness review status${where(held.dir)} is ${held.status.status}. No ready independent review is recorded for this change. Open the PR anyway?`

export const askEnabled = (options: PluginOptions): boolean => options.prGateAsk === true

export const shouldAsk = (enabled: boolean, status: GateStatus): boolean =>
  enabled && status.status !== 'ready' && status.status !== 'unknown'

export const askVerdict = (held: Held | undefined, verdict: ToolCheckResult): ToolCheckResult =>
  held === undefined || verdict.decision !== 'allow' ? verdict : { decision: 'ask', reason: askReason(held) }

const unknown = (reason: string): GateStatus => ({ status: 'unknown', reason })

type Run = EngineInterface['process']['run']

async function git($: EngineInterface, cwd: string, args: string[]): Promise<string | null> {
  try {
    const ran = await ($.process.run as Run)(['git', ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS })
    return ran.exitCode === 0 ? ran.stdout : null
  } catch {
    return null
  }
}

async function queryStatus($: EngineInterface, id: ReviewIdentity, cwd: string): Promise<GateStatus> {
  if (!/^[a-z][a-z0-9_-]{0,30}$/.test(id.client) || !TOKEN_PATTERN.test(id.session)) {
    return unknown('the stored review identity is not usable')
  }
  let stdout: string
  let exitCode: number
  try {
    const ran = await $.process.run(
      ['ai-harness', 'review-status', '--client', id.client, '--session', id.session, '--cwd', cwd],
      { cwd, timeoutMs: STATUS_TIMEOUT_MS },
    )
    stdout = ran.stdout
    exitCode = ran.exitCode
  } catch (error) {
    const timedOut = /time[ds]? ?out|still running/i.test(error instanceof Error ? error.message : '')
    return unknown(timedOut ? 'the status check timed out' : 'the status check could not run')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    return unknown(exitCode === 0 ? 'the status output could not be parsed' : 'the status check failed')
  }
  return parseStatus(parsed)
}

type Assessment = { status: GateStatus; dir: string | null }

function planDir(plan: DirectoryPlan): string | undefined | null {
  if (plan.kind === 'session') return undefined
  if (plan.kind === 'cd') return plan.target
  return null
}

async function assess($: EngineInterface, detection: PrDetection): Promise<Assessment> {
  const target = planDir(detection.directory)
  if (target === null) {
    const why = detection.directory.kind === 'unknown' ? detection.directory.why : 'the directory is unknown'
    return { status: unknown(why), dir: null }
  }
  if (detection.commands.some(one => one.targetsPr)) {
    return { status: unknown('the command targets a PR by number or id, which may not be the change reviewed in this checkout'), dir: null }
  }

  const sessionCwd = await $.session.cwd()
  const home = target?.startsWith('~') === true ? await $.env.get('HOME').catch(() => undefined) : undefined
  const resolved = resolveDir(target, sessionCwd, home)
  if (resolved === null) return { status: unknown('the directory could not be resolved'), dir: null }

  const top = await git($, resolved, ['rev-parse', '--show-toplevel'])
  const dir = top === null ? '' : top.trim()
  if (dir.length === 0) return { status: unknown('the directory is not inside a git checkout'), dir: null }

  const named = detection.commands.filter(one => one.repo !== null)
  if (named.length > 0) {
    const config = await git($, dir, ['config', '--get-regexp', '^remote\\..*\\.url$'])
    const urls = (config ?? '')
      .split('\n')
      .map(line => line.trim().split(/\s+/)[1] ?? '')
      .filter(line => line.length > 0)
    if (!named.every(one => sameRepo(one.repo as string, urls))) {
      return { status: unknown('the command names a repository that does not match this checkout'), dir }
    }
  }

  const ids = (await read($, reviewIdsAtom)) as Record<string, ReviewIdentity>
  const id = ids[dir]
  if (id === undefined) return { status: { status: 'none' }, dir }
  return { status: await queryStatus($, id, dir), dir }
}

export function registerPrGate(on: On, options: PluginOptions): void {
  const held = new Map<string, Held>()

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = typeof e.command === 'string' ? e.command : ''
    let detection: PrDetection | null = null
    try {
      detection = detectPr(command)
    } catch {
      detection = null
    }
    if (detection === null) return next(e)

    let found: Assessment
    try {
      found = await assess($, detection)
    } catch {
      found = { status: unknown('the status check failed'), dir: null }
    }

    const id = e.tool_use_id
    if (id !== undefined && shouldAsk(askEnabled(options), found.status)) held.set(id, found)
    try {
      const ran = await next(e)
      if (ran.deny !== undefined || ran.isError === true) return ran
      return { ...ran, context: [...(ran.context ?? []), noticeText(found.status, found.dir)] } as typeof ran
    } finally {
      if (id !== undefined) held.delete(id)
    }
  }).catch(($, e, next) => next(e))

  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const id = e.tool_use_id
    return askVerdict(id === undefined ? undefined : held.get(id), await next(e))
  }).catch(($, e, next) => next(e))
}
