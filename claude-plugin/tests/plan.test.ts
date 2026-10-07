import { expect, test } from 'claude-code/testing'

import {
  assignRole,
  bar,
  buildPlan,
  claudeEffort,
  describeTool,
  kindOf,
  missingRoles,
  normalizeModels,
  normalizeReview,
  parseNeedsYou,
  parseSaved,
  parseVerdict,
  reviewPhrase,
  spawnModelOf,
  taskId,
} from '../hooks/plan'
import { runReview } from '../hooks/cli'
import type { TriageResult } from '../hooks/plan'
import type { HarnessRoleTable } from '../types'
import { modelsFixture } from './support'

const triage = (complexity: string, confidence = 0.8): TriageResult => ({
  complexity,
  confidence,
  needsResearch: false,
  effort: 'high',
})

const table = (): HarnessRoleTable => normalizeModels(modelsFixture()) ?? {}

test('assignRole follows the triage table', async () => {
  expect(assignRole(triage('trivial'), { title: 'Fix a typo' })).toEqual({
    role: 'reader',
    writes: true,
    review: true,
    why: 'triage trivial without a read hint',
  })
  expect(assignRole(triage('trivial'), { title: 'List adapters' })).toEqual({
    role: 'reader',
    writes: false,
    review: false,
    why: 'triage trivial with a read hint',
  })
  expect(assignRole(triage('routine'), { title: 'Add endpoint' }).role).toBe('implementer')
  expect(assignRole(triage('moderate'), { title: 'Add endpoint' }).review).toBe(true)
  expect(assignRole(triage('architectural'), { title: 'Split the service' })).toMatchObject({
    role: 'advisor',
    review: false,
  })
  expect(assignRole(null, { title: 'Add endpoint' })).toMatchObject({
    role: 'implementer',
    why: 'triage unavailable',
  })
})

test('assignRole sends reading titles to the read-only reader and mechanical writing to the mechanic', async () => {
  for (const title of ['Read the config files', 'Collect usages', 'Inventory scripts', 'Research the cache options']) {
    expect(assignRole(triage('moderate'), { title })).toMatchObject({ role: 'reader', writes: false, review: false })
  }
  for (const title of ['Scaffold the module', 'Create fixtures', 'Lint the package', 'Convert the config to JSON', 'Rename flags']) {
    expect(assignRole(triage('moderate'), { title })).toMatchObject({ role: 'reader', writes: true, review: true })
  }
  expect(assignRole(triage('moderate'), { title: 'Update README' }).role).toBe('implementer')
  expect(assignRole(triage('moderate'), { title: 'Wire handler', hint: 'collect' })).toMatchObject({ role: 'reader', writes: false })
  expect(assignRole(triage('trivial'), { title: 'Wire handler', hint: 'implementer' })).toMatchObject({
    role: 'implementer',
    why: 'manual',
  })
  expect(assignRole(triage('routine'), { title: 'Wire handler', hint: 'mechanic' })).toEqual({
    role: 'reader',
    writes: true,
    review: true,
    why: 'manual',
  })
})

test('trivial goes to the reader only with a whole-word read hint, otherwise to the reviewed mechanic', async () => {
  const mechanic = { role: 'reader', writes: true, review: true }
  const reader = { role: 'reader', writes: false, review: false }
  expect(assignRole(triage('trivial'), { title: 'Fix typo in README' })).toMatchObject(mechanic)
  expect(assignRole(triage('trivial'), { title: 'Rename the thread pool' })).toMatchObject(mechanic)
  expect(assignRole(triage('trivial'), { title: 'Bump the version' })).toMatchObject(mechanic)
  for (const title of [
    'Inventory adapters',
    'List the adapters',
    'Inspect the cache layout',
    'Audit the lockfile',
    'Map the entry points',
    'Summarize the changelog',
    'Research cache options',
    'Collect usages',
    'Read the config',
  ]) {
    expect(assignRole(triage('trivial'), { title })).toMatchObject(reader)
  }
  expect(assignRole(triage('trivial'), { title: 'Tidy things', hint: 'inspect' })).toMatchObject(reader)
  expect(assignRole(triage('trivial'), { title: 'Update the readme and thread docs' })).toMatchObject(mechanic)
  expect(assignRole(triage('trivial'), { title: 'Check the timeout read path' })).toMatchObject(reader)
})

test('a read word inside a fix title never makes a reader', async () => {
  const routine = assignRole(triage('routine'), { title: 'Fix the read timeout in client.ts' })
  expect(routine).toMatchObject({ role: 'implementer', review: true })
  const trivial = assignRole(triage('trivial'), { title: 'Fix the read timeout in client.ts' })
  expect(trivial).toMatchObject({ role: 'reader', writes: true, review: true })
  expect(assignRole(triage('moderate'), { title: 'Add list endpoint' }).role).toBe('implementer')
  expect(assignRole(triage('trivial'), { title: 'Add list endpoint' })).toMatchObject({ writes: true })
})

test('kindOf separates reader, mechanic and implementer', async () => {
  expect(kindOf({ role: 'reader', writes: false })).toBe('reader')
  expect(kindOf({ role: 'reader', writes: true })).toBe('mechanic')
  expect(kindOf({ role: 'implementer', writes: false })).toBe('implementer')
  expect(kindOf({ role: 'advisor', writes: false })).toBeNull()
})

test('claudeEffort maps Herdr-Jev efforts to Claude Code levels', async () => {
  expect(claudeEffort('standard')).toBe('medium')
  expect(claudeEffort('high')).toBe('high')
  expect(claudeEffort('xhigh')).toBe('xhigh')
  expect(claudeEffort('weird')).toBeUndefined()
  expect(claudeEffort(null)).toBeUndefined()
})

test('spawnModelOf maps catalog ids to Claude Code aliases and refuses unknown ids', async () => {
  expect(spawnModelOf('claude-fable-5-1')).toBe('fable')
  expect(spawnModelOf('claude-opus-5-5')).toBe('opus')
  expect(spawnModelOf('claude-sonnet-5-5')).toBe('sonnet')
  expect(spawnModelOf('claude-sonnet-5-6')).toBe('sonnet')
  expect(spawnModelOf('claude-haiku-4-5-20251001')).toBe('haiku')
  expect(spawnModelOf('Claude-Opus-5-5')).toBe('opus')
  expect(spawnModelOf('gpt-5.5')).toBeNull()
})

test('taskId is stable and eight hex digits', async () => {
  const first = taskId('ship it', 'Add endpoint')
  expect(first).toMatch(/^hp-[0-9a-f]{8}$/)
  expect(taskId('ship it', 'Add endpoint')).toBe(first)
  expect(taskId('ship it', 'Other title')).not.toBe(first)
  expect(taskId('other goal', 'Add endpoint')).not.toBe(first)
})

test('normalizeModels keeps exact CLI ids and drops roles with an error or no cliModel', async () => {
  const roles = normalizeModels({
    client: 'claude',
    roles: {
      implementer: { model: 'sonnet-5', cliModel: 'claude-sonnet-5-5', effort: 'high', readonly: false, fallbackActive: true },
      reviewer: { model: 'opus-5', cliModel: null, error: 'no model', effort: 'xhigh' },
      reader: 'junk',
    },
  })
  expect(roles?.implementer).toEqual({
    model: 'sonnet-5',
    cliModel: 'claude-sonnet-5-5',
    effort: 'high',
    readonly: false,
    fallbackActive: true,
  })
  expect(roles?.reviewer).toBeUndefined()
  expect(roles?.reader).toBeUndefined()
  expect(normalizeModels(null)).toBeNull()
  expect(normalizeModels({ client: 'codex', roles: {} })).toBeNull()
  expect(normalizeModels({ client: 'claude' })).toBeNull()
})

test('buildPlan takes models, efforts and review models from the models list', async () => {
  const plan = buildPlan(
    'ship it',
    [
      { title: 'Add endpoint', paths: ['src/api.ts'], checks: ['pnpm test'] },
      { title: 'Design the data model' },
      { title: 'Collect usages', deps: ['Add endpoint'] },
      { title: 'Create fixtures' },
    ],
    [triage('routine'), triage('architectural'), triage('trivial'), triage('routine')],
    table(),
    'claude-fable-5-1',
  )

  const [implement, advise, collect, fixtures] = plan.tasks
  expect(implement).toMatchObject({
    role: 'implementer',
    writes: false,
    model: 'sonnet-5',
    effort: 'high',
    review: true,
    reviewModel: 'opus-5',
    state: 'proposed',
    paths: ['src/api.ts'],
    checks: ['pnpm test'],
    toolCount: 0,
  })
  expect(implement?.reason).toContain('claude-sonnet-5-5')
  expect(implement?.reason).toContain('models list')
  expect(advise).toMatchObject({ role: 'advisor', state: 'advisor', model: 'claude-fable-5-1', review: false })
  expect(collect).toMatchObject({ role: 'reader', writes: false, review: false, deps: [implement?.id], model: 'claude-haiku-4-5-20251001', effort: 'standard' })
  expect(fixtures).toMatchObject({ role: 'reader', writes: true, review: true, model: 'claude-haiku-4-5-20251001', reviewModel: 'opus-5' })
  expect(plan.roles.reviewer?.cliModel).toBe('claude-opus-5-5')
  expect(plan.tasks.every(task => /^hp-[0-9a-f]{8}$/.test(task.id))).toBe(true)
  expect(missingRoles(plan)).toEqual([])
})

test('buildPlan keeps models unknown and reports missing roles when the list is absent or partial', async () => {
  const none = buildPlan('goal', [{ title: 'Add endpoint' }], [null], null, 'claude-fable-5-1')
  expect(none.tasks[0]).toMatchObject({ role: 'implementer', model: null, effort: null, review: true, reviewModel: null })
  expect(none.tasks[0]?.reason).toContain('triage unavailable')
  expect(none.tasks[0]?.reason).toContain('unavailable')
  expect(missingRoles(none).sort()).toEqual(['implementer', 'reviewer'])

  const partial = table()
  delete partial.reviewer
  const plan = buildPlan('goal', [{ title: 'Add endpoint' }, { title: 'Read logs' }], [triage('routine'), triage('trivial')], partial, 'm')
  expect(plan.tasks[0]).toMatchObject({ model: 'sonnet-5', reviewModel: null })
  expect(plan.tasks[0]?.reason).toContain('sonnet-5')
  expect(missingRoles(plan)).toEqual(['reviewer'])
})

test('buildPlan resolves deps by title or id, drops unknown and keeps ids unique', async () => {
  const first = taskId('goal', 'One')
  const plan = buildPlan(
    'goal',
    [{ title: 'One' }, { title: 'One' }, { title: 'Two', deps: ['one', first, 'missing', 'Two'] }],
    [triage('routine'), triage('routine'), triage('routine')],
    table(),
    'm',
  )
  const ids = plan.tasks.map(task => task.id)
  expect(new Set(ids).size).toBe(3)
  expect(plan.tasks[2]?.deps).toEqual([first])
})

test('parseVerdict and parseNeedsYou read the last matching line', async () => {
  expect(parseVerdict('ok\nREVIEW_GATE_VERDICT: APPROVE')).toBe('APPROVE')
  expect(parseVerdict('REVIEW_GATE_VERDICT: APPROVE\nmore\nREVIEW_GATE_VERDICT: CHANGES_REQUIRED\n')).toBe('CHANGES_REQUIRED')
  expect(parseVerdict('looks fine')).toBeNull()
  expect(parseNeedsYou('x\nNEEDS_YOU: which schema?')).toBe('which schema?')
  expect(parseNeedsYou('done')).toBeNull()
})

test('normalizeReview derives its detail from status and per-scope judges, with no verdict field', async () => {
  expect(normalizeReview(null)).toBeNull()
  expect(
    normalizeReview({
      status: 'pending_judge',
      verify: { status: 'ready' },
      judges: [{ scope: 'core', status: 'ready' }, { scope: 'ui', status: null, error: 'timeout' }],
    }),
  ).toEqual({ status: 'pending_judge', detail: 'verify ready, core ready, ui timeout', error: null })
  expect(normalizeReview({ error: 'invalid_verify_command' })).toEqual({ status: null, detail: null, error: 'invalid_verify_command' })
  expect(bar(3, 6)).toBe('█████░░░░░')
  expect(bar(0, 0)).toBe('░░░░░░░░░░')
})

test('describeTool never carries command text and keeps only basenames', async () => {
  expect(describeTool('Bash', { command: 'curl -H "Authorization: Bearer abc" https://x' })).toBe('Bash')
  expect(describeTool('Read', { file_path: '/home/me/secret/.env.production' })).toBe('Read .env.production')
  expect(describeTool('Edit', { file_path: '/a/b/c.ts', old_string: 'password=1' })).toBe('Edit c.ts')
  expect(describeTool('Write', { file_path: 'x.ts' })).toBe('Write x.ts')
  expect(describeTool('Glob', { pattern: 'src/**/*.ts' })).toBe('Glob *.ts')
  expect(describeTool('Grep', { pattern: 'token', path: '/a/b' })).toBe('Grep')
  expect(describeTool('WebFetch', { url: 'https://x/?k=1' })).toBe('WebFetch')
  expect(describeTool('Read', {})).toBe('Read')
})

test('parseSaved validates states, roles and shapes', async () => {
  const task = {
    id: 'hp-00000001',
    title: 'One',
    role: 'implementer',
    writes: false,
    model: 'sonnet-5',
    effort: 'high',
    reason: 'x',
    deps: [],
    paths: [],
    checks: [],
    state: 'approved',
    review: true,
    reviewModel: 'opus-5',
    toolCount: 2,
  }
  const good = parseSaved({ plan: { objective: 'o', advisorModel: 'm', roles: {}, tasks: [task] }, workers: {}, needsYou: [] })
  expect(good?.plan.tasks[0]).toMatchObject({ id: 'hp-00000001', state: 'approved', toolCount: 2 })

  expect(parseSaved({ plan: { tasks: [{ ...task, state: 'exploded' }] } })).toBeNull()
  expect(parseSaved({ plan: { tasks: [{ ...task, role: 'wizard' }] } })).toBeNull()
  expect(parseSaved({ plan: { tasks: [{ ...task, id: 7 }] } })).toBeNull()
  expect(parseSaved({ plan: { tasks: 'x' } })).toBeNull()
  expect(parseSaved(null)).toBeNull()

  const mixed = parseSaved({
    plan: { tasks: [task] },
    workers: { a: { taskId: 't', agentId: 'a', role: 'nope', startedAt: 1 }, b: { taskId: 't', agentId: 'b', role: 'reader', startedAt: 2 } },
    needsYou: [{ id: 1 }, { id: 'a', taskId: 't', question: 'q', at: 3 }],
  })
  expect(Object.keys(mixed?.workers ?? {})).toEqual(['b'])
  expect(mixed?.needsYou).toHaveLength(1)
})

test('runReview passes a judge deadline under the process cap and tells a timeout from a failure', async () => {
  const seen: { argv: readonly string[]; timeoutMs: number | undefined }[] = []
  const body = JSON.stringify({ status: 'pending_judge', verify: { status: 'ready' }, judges: [] })
  const ok = await runReview(
    async (argv, init) => {
      seen.push({ argv, timeoutMs: init.timeoutMs })
      return { exitCode: 1, stdout: body, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    },
    { bin: 'herdr-jev', cwd: '/w' },
  )
  expect(ok).toMatchObject({ ok: true, value: { status: 'pending_judge' } })
  expect(seen[0]?.argv).toEqual(['herdr-jev', 'review', '--json', '--timeout-ms', '540000'])
  expect(seen[0]?.timeoutMs).toBe(600000)

  const killed = await runReview(
    async () => {
      throw new Error('process timed out after 600000ms')
    },
    { bin: 'herdr-jev', cwd: '/w' },
  )
  expect(killed).toMatchObject({ ok: false, timedOut: true })
  expect(killed.ok ? '' : killed.reason).toContain('timed out')

  const broken = await runReview(
    async () => {
      throw new Error('spawn herdr-jev ENOENT')
    },
    { bin: 'herdr-jev', cwd: '/w' },
  )
  expect(broken).toMatchObject({ ok: false })
  expect(broken.ok ? false : broken.timedOut).toBeUndefined()
})

test('reviewPhrase names the last status instead of pending once a review ran', async () => {
  expect(reviewPhrase(true, null)).toBe('harness review running')
  expect(reviewPhrase(false, null)).toBe('harness review pending')
  expect(reviewPhrase(false, { isOk: true, status: 'pending_judge', isTimedOut: false })).toBe('harness review: pending_judge')
  expect(reviewPhrase(false, { isOk: true, status: null, isTimedOut: false })).toBe('harness review: unknown')
  expect(reviewPhrase(false, { isOk: true, status: 'ready', isTimedOut: false })).toBe('harness review pending')
  expect(reviewPhrase(false, { isOk: false, status: null, isTimedOut: true })).toBe('harness review: timed out')
  expect(reviewPhrase(false, { isOk: false, status: null, isTimedOut: false })).toBe('harness review: failed')
  expect(reviewPhrase(true, { isOk: true, status: 'pending_judge', isTimedOut: false })).toBe('harness review running')
})
