import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions, ToolCheckResult } from 'claude-code'

import { analyze } from './pr-detect'
import type { DirectoryPlan, PrDetection, ReviewRun } from './pr-detect'
import {
  CLIENT_PATTERN,
  mergeReviewIds,
  parseReviewIds,
  parseReviewRun,
  reviewIdsKey,
  STATUS_PATTERN,
  TOKEN_PATTERN,
} from './review-run'
import type { ReviewIds, StoredReview } from './review-run'

export { mergeReviewIds, parseReviewIds, parseReviewRun, reviewIdsKey } from './review-run'

export type GateStatus = { status: string; reason?: string; since?: number }

export type Held = { status: GateStatus; dir: string | null; here?: boolean }

const STATUS_TIMEOUT_MS = 5000
const GIT_TIMEOUT_MS = 2000

const reviewIdsAtom = atom({ plugin: 'harness', key: 'reviewIds' } as const, {})

const ADVICE =
  'Review after committing: commit, then run `herdr-jev review`, address the findings, then open the PR; or tell the user the PR is unreviewed.'

const clean = (value: string): string => value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 160)

const quoted = (value: string): string => (/^[A-Za-z0-9_./@:+-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`)

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

const stamp = (at: number | undefined): string => {
  if (at === undefined || !Number.isFinite(at)) return 'an earlier time'
  try {
    return new Date(at).toISOString()
  } catch {
    return 'an earlier time'
  }
}

export const noticeText = (status: GateStatus, dir: string | null, here = true): string => {
  const lead = `Review status read before the PR command${where(dir)}`
  if (status.status === 'ready') return `${lead}: ready.`
  if (status.status === 'unknown') {
    const why = status.reason === undefined ? '' : ` (${clean(status.reason)})`
    return `${lead}: unknown${why}. The status could not be read, so nothing is claimed about the review. ${ADVICE}`
  }
  if (status.status === 'stale') {
    return `${lead}: stale. The last review of this checkout was ready at ${stamp(status.since)}; the checkout changed since (a commit or a new untracked file counts). ${ADVICE}`
  }
  if (status.status === 'none') {
    const how =
      here || dir === null
        ? 'run `herdr-jev review` in a shell (this check finds it) or ask the user to run `/harness review`'
        : `run \`herdr-jev review\` in ${quoted(clean(dir))} (for example \`cd ${quoted(clean(dir))} && herdr-jev review\`); \`/harness review\` reviews the session directory instead`
    return `${lead}: none. The mod has no review on record for this checkout; to produce one, ${how}. ${ADVICE}`
  }
  return `${lead}: ${status.status}. No ready independent review is recorded for this change. ${ADVICE}`
}

export const askReason = (held: Held): string =>
  `Harness review status${where(held.dir)} is ${held.status.status}. Open the PR anyway?`

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

async function queryStatus($: EngineInterface, id: StoredReview, cwd: string): Promise<GateStatus> {
  if (!CLIENT_PATTERN.test(id.client) || !TOKEN_PATTERN.test(id.session)) {
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

type Assessment = { status: GateStatus; dir: string | null; here: boolean }

const blind = (reason: string, dir: string | null = null): Assessment => ({ status: unknown(reason), dir, here: true })

function planDir(plan: DirectoryPlan): string | undefined | null {
  if (plan.kind === 'session') return undefined
  if (plan.kind === 'cd') return plan.target
  return null
}

async function storedIds($: EngineInterface): Promise<ReviewIds> {
  const live = (await read($, reviewIdsAtom)) as ReviewIds
  if (Object.keys(live).length > 0) return live
  try {
    return parseReviewIds(await $.store.get(reviewIdsKey(await $.session.id())))
  } catch {
    return {}
  }
}

async function assess($: EngineInterface, detection: PrDetection): Promise<Assessment> {
  const target = planDir(detection.directory)
  if (target === null) {
    return blind(detection.directory.kind === 'unknown' ? detection.directory.why : 'the directory is unknown')
  }
  const foreign = detection.commands.find(one => one.foreign !== null)
  if (foreign !== undefined) return blind(foreign.foreign as string)
  if (detection.commands.some(one => one.targetsPr)) {
    return blind('the command targets a PR by number or id, which may not be the change reviewed in this checkout')
  }
  const named = detection.commands.map(one => one.repo).filter((one): one is string => one !== null)
  if (named.some(one => one.includes('$'))) return blind('repository comes from a variable')

  const sessionCwd = await $.session.cwd()
  const home = target?.startsWith('~') === true ? await $.env.get('HOME').catch(() => undefined) : undefined
  const resolved = resolveDir(target, sessionCwd, home)
  if (resolved === null) return blind('the directory could not be resolved')

  const [top, config] = await Promise.all([
    git($, resolved, ['rev-parse', '--show-toplevel']),
    named.length > 0 ? git($, resolved, ['config', '--get-regexp', '^remote\\..*\\.url$']) : Promise.resolve(null),
  ])
  const dir = top === null ? '' : top.trim()
  if (dir.length === 0) return blind('the directory is not inside a git checkout')

  if (named.length > 0) {
    const urls = (config ?? '')
      .split('\n')
      .map(line => line.trim().split(/\s+/)[1] ?? '')
      .filter(line => line.length > 0)
    if (!named.every(one => sameRepo(one, urls))) {
      return blind('the command names a repository that does not match this checkout', dir)
    }
  }

  const here = sessionCwd === dir || sessionCwd.startsWith(`${dir}/`)
  const id = (await storedIds($))[dir]
  if (id === undefined) return { status: { status: 'none' }, dir, here }
  const queried = await queryStatus($, id, dir)
  if (queried.status === 'pending_verification' && id.status === 'ready') {
    return { status: { status: 'stale', since: id.at }, dir, here }
  }
  return { status: queried, dir, here }
}

async function recordRun($: EngineInterface, run: ReviewRun, output: string): Promise<void> {
  const report = parseReviewRun(output, run.json)
  if (report === null) return
  const at = await $.clock.now()
  const entry: StoredReview = { client: report.client, session: report.session, at, status: report.status }
  await update($, reviewIdsAtom, ids => mergeReviewIds(ids as ReviewIds, report.cwd, entry))
  await $.store.set(reviewIdsKey(await $.session.id()), await read($, reviewIdsAtom))
}

export function registerPrGate(on: On, options: PluginOptions): void {
  const held = new Map<string, Held>()

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = typeof e.command === 'string' ? e.command : ''
    let pr: PrDetection | null = null
    let review: ReviewRun | null = null
    try {
      const found = analyze(command)
      pr = found.pr
      review = found.review
    } catch {
      pr = null
      review = null
    }
    if (pr === null && review === null) return next(e)

    let found: Assessment | null = null
    if (pr !== null) {
      try {
        found = await assess($, pr)
      } catch {
        found = blind('the status check failed')
      }
    }

    const id = e.tool_use_id
    if (found !== null && id !== undefined && shouldAsk(askEnabled(options), found.status)) held.set(id, found)
    try {
      const ran = await next(e)
      if (ran.deny !== undefined) return ran
      if (review !== null) {
        try {
          const output = typeof ran.text === 'string' ? ran.text : typeof ran.result === 'string' ? ran.result : ''
          await recordRun($, review, output)
        } catch {
          void 0
        }
      }
      if (found === null || ran.isError === true) return ran
      return { ...ran, context: [...(ran.context ?? []), noticeText(found.status, found.dir, found.here)] } as typeof ran
    } finally {
      if (id !== undefined) held.delete(id)
    }
  }).catch(($, e, next) => next(e))

  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const id = e.tool_use_id
    return askVerdict(id === undefined ? undefined : held.get(id), await next(e))
  }).catch(($, e, next) => next(e))
}
