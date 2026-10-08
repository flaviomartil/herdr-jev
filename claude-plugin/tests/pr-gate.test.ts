import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { askEnabled, askVerdict, leadingCdOf, noticeText, parseStatus, prCommandOf, resolveDir, shouldAsk } from '../hooks/pr-gate'
import type { Verdict } from '../hooks/pr-gate'
import { CWD, settle, wire } from './support'
import type { Seen } from './support'

const ADVICE = 'Run `herdr-jev review` and address findings before publishing, or tell the user the PR is unreviewed.'

const bash = ($: Engine, command: string, extra: Record<string, unknown> = {}) =>
  $.tool.call({ tool: 'Bash', command, ...extra } as never)

const statusRuns = (seen: Seen) => seen.runs.filter(argv => argv[0] === 'ai-harness' && argv[1] === 'review-status')

test('detects the PR commands of GitHub and Azure DevOps that the shell would run', () => {
  const hits: [string, string, string][] = [
    ['gh pr create --fill', 'github', 'create'],
    ['gh pr new --fill', 'github', 'new'],
    ['gh pr edit 42 --body-file body.md', 'github', 'edit'],
    ['gh pr ready 42', 'github', 'ready'],
    ['gh -R acme/app pr create', 'github', 'create'],
    ['cd /work/app && gh pr create --title "x"', 'github', 'create'],
    ['git push -u origin HEAD && gh pr create --fill', 'github', 'create'],
    ['GH_PROMPT_DISABLED=1 gh pr create', 'github', 'create'],
    ['rtk -u gh pr create --fill', 'github', 'create'],
    ['/usr/bin/gh pr edit 3', 'github', 'edit'],
    ['gh pr create --title "x" --body "$(cat <<\'EOF\'\nSummary\n\nEOF\n)"', 'github', 'create'],
    ['gh pr create --help; gh pr create --fill', 'github', 'create'],
    ['az repos pr create --title x --source-branch a --target-branch b', 'azure', 'create'],
    ['az repos pr update --id 7 --status completed', 'azure', 'update'],
    ['cd /work/app && az repos pr create --draft true', 'azure', 'create'],
    ['(az repos pr update --id 7 --title "x")', 'azure', 'update'],
  ]
  for (const [command, platform, action] of hits) {
    expect({ command, hit: prCommandOf(command) }).toEqual({ command, hit: { platform, action } })
  }
})

test('ignores heredoc bodies, quoted text, echo, help, dry runs and other commands', () => {
  for (const command of [
    'git commit -m "docs: run gh pr create later"',
    "git commit -m 'a; gh pr create'",
    'echo gh pr create',
    'echo "gh pr create --fill"',
    'printf "az repos pr create"',
    'cat <<EOF > notes.md\ngh pr create --fill\naz repos pr create\nEOF',
    'gh pr create --help',
    'gh pr create -h',
    'gh pr edit --help',
    'az repos pr create --help',
    'az repos pr update -h',
    'gh pr create --dry-run',
    'gh pr ready 42 --undo',
    'git push -u origin HEAD',
    'git push origin feat/x && echo done',
    'gh pr view 42',
    'gh pr list',
    'gh pr checkout 42',
    'gh pr status',
    'az repos pr list',
    'az repos pr show --id 7',
    'git log --grep "gh pr create"',
    'ls',
  ]) {
    expect({ command, hit: prCommandOf(command) }).toEqual({ command, hit: null })
  }
})

test('reads the leading cd and resolves the directory', () => {
  expect(leadingCdOf("cd '/work/app' && gh pr create")).toBe('/work/app')
  expect(leadingCdOf('cd "/work/my app" && gh pr create')).toBe('/work/my app')
  expect(leadingCdOf('gh pr create && cd /x')).toBeUndefined()
  expect(resolveDir('/work/app', CWD, undefined)).toBe('/work/app')
  expect(resolveDir('../other', CWD, undefined)).toBe('/work/other')
  expect(resolveDir('sub', CWD, undefined)).toBe('/work/demo/sub')
  expect(resolveDir('~/code', CWD, '/home/me')).toBe('/home/me/code')
  expect(resolveDir('~/code', CWD, undefined)).toBe(CWD)
  expect(resolveDir(undefined, CWD, undefined)).toBe(CWD)
})

test('parses the review-status output and treats anything odd as unknown', () => {
  expect(parseStatus({ status: 'ready' })).toEqual({ status: 'ready' })
  expect(parseStatus({ status: 'pending_judge' })).toEqual({ status: 'pending_judge' })
  expect(parseStatus(null)).toEqual({ status: 'none' })
  expect(parseStatus({ status: null })).toEqual({ status: 'none' })
  expect(parseStatus('x').status).toBe('unknown')
  expect(parseStatus([]).status).toBe('unknown')
})

test('notice text is short for ready and carries the command for anything else', () => {
  expect(noticeText({ status: 'ready' })).toBe('Harness review status: ready.')
  const none = noticeText({ status: 'none' })
  expect(none).toContain('Harness review status: none.')
  expect(none).toContain('No ready independent review is recorded for this change.')
  expect(none).toContain(ADVICE)
  const unknown = noticeText({ status: 'unknown', reason: 'ai-harness review-status timed out after 5 s' })
  expect(unknown).toContain('unknown (ai-harness review-status timed out after 5 s)')
  expect(unknown).toContain('not held')
  expect(unknown).toContain(ADVICE)
})

test('a ready review adds one short confirmation and runs the command', async ($, on) => {
  const seen = wire(on, { session: 'sess-9' })
  const out = await bash($, 'gh pr create --fill')
  expect(out.deny).toBeUndefined()
  expect(out.result).toBe('ok')
  expect(out.context).toEqual(['Harness review status: ready.'])
  expect(statusRuns(seen)).toEqual([['ai-harness', 'review-status', '--client', 'claude', '--session', 'sess-9', '--cwd', CWD]])
})

test('a review that is not ready adds the warning and never denies the call', async ($, on) => {
  const seen = wire(on)
  for (const body of [{ status: 'pending_judge' }, { status: 'changes_required' }, null]) {
    seen.statusBody = body
    const out = await bash($, 'az repos pr create --title x')
    expect(out.deny).toBeUndefined()
    expect(out.result).toBe('ok')
    const text = (out.context ?? []).join('\n')
    expect(text).toContain('No ready independent review is recorded for this change.')
    expect(text).toContain(ADVICE)
    expect(text).toContain(`Harness review status: ${body === null ? 'none' : body.status}.`)
  }
})

test('the status is read from the directory of the leading cd', async ($, on) => {
  const seen = wire(on)
  await bash($, "cd '/work/other' && gh pr edit 3 --body-file b.md")
  expect(statusRuns(seen)[0]?.slice(-2)).toEqual(['--cwd', '/work/other'])
})

test('a failing status check fails open and says so', async ($, on) => {
  const seen = wire(on)
  seen.failStatus = true
  const out = await bash($, 'gh pr create --fill')
  expect(out.deny).toBeUndefined()
  expect(out.result).toBe('ok')
  const text = (out.context ?? []).join('\n')
  expect(text).toContain('Harness review status: unknown')
  expect(text).toContain('was not held')
  expect(text).toContain(ADVICE)
})

test('unparseable status output fails open', async ($, on) => {
  const seen = wire(on)
  seen.statusBody = 'garbage'
  const out = await bash($, 'gh pr ready 5')
  expect(out.result).toBe('ok')
  expect(out.deny).toBeUndefined()
  expect((out.context ?? []).join('\n')).toContain('Harness review status: unknown')
})

test('commands that are not PR commands are untouched and never query the status', async ($, on) => {
  const seen = wire(on)
  for (const command of ['git push -u origin HEAD', 'echo gh pr create', 'gh pr view 3', 'gh pr create --help']) {
    const out = await bash($, command)
    expect(out.result).toBe('ok')
    expect(out.context).toBeUndefined()
  }
  expect(statusRuns(seen)).toEqual([])
})

test('only Bash calls are inspected', async ($, on) => {
  const seen = wire(on)
  const out = await $.tool.call({ tool: 'Read', file_path: '/x/gh pr create' } as never)
  expect(out.context).toBeUndefined()
  expect(statusRuns(seen)).toEqual([])
})

test('ask mode is off by default: a not ready review still lets the call run without asking', async ($, on) => {
  const seen = wire(on)
  seen.statusBody = { status: 'pending_judge' }
  const out = await bash($, 'gh pr create --fill', { tool_use_id: 'toolu_1' })
  expect(out.result).toBe('ok')
  expect(out.deny).toBeUndefined()
  await settle()
})

test('ask is a plugin option, off unless set', () => {
  expect(askEnabled({})).toBe(false)
  expect(askEnabled({ prGateAsk: false })).toBe(false)
  expect(askEnabled({ prGateAsk: true })).toBe(true)
})

test('ask applies only to a known status that is not ready and never overrides a deny', () => {
  expect(shouldAsk(true, { status: 'none' })).toBe(true)
  expect(shouldAsk(true, { status: 'pending_judge' })).toBe(true)
  expect(shouldAsk(true, { status: 'ready' })).toBe(false)
  expect(shouldAsk(true, { status: 'unknown', reason: 'down' })).toBe(false)
  expect(shouldAsk(false, { status: 'none' })).toBe(false)
  const held = { status: 'none' }
  const base: Verdict = { decision: 'allow' }
  const asked = askVerdict(held, base)
  expect(asked.decision).toBe('ask')
  expect(asked.reason).toContain('Harness review status is none.')
  expect(asked.reason).toContain(ADVICE)
  expect(askVerdict(held, { decision: 'ask', reason: 'engine' } as Verdict).reason).toContain(ADVICE)
  expect(askVerdict(held, { decision: 'deny', reason: 'rule' } as Verdict)).toEqual({ decision: 'deny', reason: 'rule' })
  expect(askVerdict(undefined, base)).toEqual({ decision: 'allow' })
})

test('tool.check without a held PR call is passed through untouched', { options: { prGateAsk: true } }, async ($, on) => {
  wire(on)
  on('tool.check', () => ({ decision: 'allow' as const }))
  const verdict = await $.tool.check({ tool: 'Bash', input: { command: 'gh pr create --fill' } })
  expect(verdict.decision).toBe('allow')
})
