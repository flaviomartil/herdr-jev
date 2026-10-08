import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  appendEntry,
  classifyCommand,
  detectClaims,
  isMutatingCommand,
  LOG_LIMIT,
  unverifiedClaims,
  warningLine,
} from '../hooks/claims'
import type { ClaimCheck, ClaimEntry } from '../types'
import { BAND_PROPS, CWD, makePlan, wire } from './support'

const SURFACES = ['terminal', 'desktop'] as const

const kinds = (text: string) => detectClaims(text).map(claim => claim.kind)

test('English claims are detected one per kind and quoted as written', () => {
  expect(kinds('Fixed the parser. All tests pass.')).toEqual(['test'])
  expect(kinds('The 42 unit tests are passing now.')).toEqual(['test'])
  expect(kinds('Tests are green.')).toEqual(['test'])
  expect(kinds('Typecheck clean.')).toEqual(['lint'])
  expect(kinds('Lint is clean.')).toEqual(['lint'])
  expect(kinds('The build passes.')).toEqual(['build'])
  expect(kinds('CI is green.')).toEqual(['ci'])
  expect(kinds('All checks pass.')).toEqual(['verified'])
  expect(kinds('I verified it works.')).toEqual(['verified'])
  expect(kinds('I verified the change.')).toEqual(['verified'])
  expect(kinds('Verified.')).toEqual(['verified'])
  expect(kinds('Everything passes.')).toEqual(['verified'])
  expect(kinds('All 143 tests passed.')).toEqual(['test'])
  expect(kinds('Tests pass ✅')).toEqual(['test'])
  expect(kinds('Tests pass. Really, all tests pass.')).toEqual(['test'])
  expect(kinds('Typecheck clean and all tests pass.')).toEqual(['lint', 'test'])
  expect(detectClaims('Done, tests pass.')).toEqual([{ kind: 'test', quote: 'tests pass' }])
  expect(detectClaims('CI green, merging.')[0]?.quote).toBe('CI green')
})

test('Portuguese claims are detected', () => {
  expect(kinds('Todos os testes passaram.')).toEqual(['test'])
  expect(kinds('Os testes passaram.')).toEqual(['test'])
  expect(kinds('Testes unitários passam.')).toEqual(['test'])
  expect(kinds('Typecheck limpo.')).toEqual(['lint'])
  expect(kinds('O typecheck passou.')).toEqual(['lint'])
  expect(kinds('CI verde.')).toEqual(['ci'])
  expect(kinds('O CI está verde.')).toEqual(['ci'])
  expect(kinds('O build passou.')).toEqual(['build'])
  expect(kinds('Todos os checks passaram.')).toEqual(['verified'])
  expect(kinds('Está verificado.')).toEqual(['verified'])
  expect(kinds('Tudo verificado.')).toEqual(['verified'])
  expect(kinds('Rodei tudo e todos passaram.')).toEqual(['verified'])
  expect(kinds('Verifiquei que funciona.')).toEqual(['verified'])
  expect(detectClaims('Feito, testes passaram.')).toEqual([{ kind: 'test', quote: 'testes passaram' }])
})

test('negations, hedges, conditions and questions are not claims', () => {
  for (const text of [
    'The tests do not pass.',
    'Not all tests pass.',
    'None of the tests pass.',
    "Tests aren't passing.",
    'CI is not green yet.',
    "I haven't verified it works.",
    'This is not verified.',
    'It still needs to be verified.',
    'The tests should pass now.',
    'Once the tests pass I will open the PR.',
    'Make sure CI is green before merging.',
    'Do the tests pass?',
    'Os testes não passaram.',
    'Nem todos os testes passaram.',
    'O CI ainda não está verde.',
    'Ainda não verificado.',
    'Quando os testes passarem eu abro o PR.',
    'O prazo passou do limite.',
  ]) {
    expect(kinds(text), text).toEqual([])
  }
})

test('claims inside code blocks, inline code, quotes and blockquotes are not claims', () => {
  expect(kinds('Output:\n```\n12 tests pass\n```\nThe fix is in.')).toEqual([])
  expect(kinds('The log line `all tests pass` came from the old run.')).toEqual([])
  expect(kinds('The script prints "all tests pass" at the end.')).toEqual([])
  expect(kinds('A tela mostra “testes passaram” no final.')).toEqual([])
  expect(kinds('> all tests pass\nThat was the old report.')).toEqual([])
  expect(kinds("The label 'CI green' is only a badge.")).toEqual([])
  expect(kinds('The script prints "ok". All tests pass.')).toEqual(['test'])
})

test('ordinary prose with verified, passou, ok or checks is not a claim', () => {
  for (const text of [
    'O handler leu o body e passou o id para o serviço.',
    'Ele passou o parâmetro errado.',
    'Isso passou despercebido na revisão.',
    'Mas passou muito tempo desde o deploy.',
    'Foi verificado que o bug existe.',
    'I verified that the config key exists in harness.yml.',
    'Verified that the bug reproduces on main.',
    'Verified: the error comes from the parser.',
    'Verificado: o erro vem do parser.',
    'Everything is ok on my side, waiting for your answer.',
    'The account is verified by email.',
    'It was verified in the file.',
    'Passou.',
    'All checks pass on PR #42.',
  ]) {
    expect(kinds(text), text).toEqual([])
  }
})

test('verb senses, instructions, checklists, criteria and third-party reports are not claims', () => {
  for (const text of [
    'The build passes arguments to the linker.',
    'The test passes the id to the handler.',
    'Os testes passam os dados pela fila.',
    'O build passou a usar o cache.',
    'Run bun test and confirm tests pass.',
    'Check that CI is green before merging.',
    '- [ ] All tests pass',
    'Acceptance criteria: tests pass, typecheck clean.',
    'DoD: typecheck clean and tests green.',
    '| tests pass | pending |',
    'I need to fix two more things before the tests pass.',
    'The reviewer says tests pass.',
    'The subagent reported that all 143 tests pass.',
    'According to the CI log, all checks pass.',
    'Codex reports that the build passes.',
    'You said the tests pass.',
    'O revisor disse que os testes passaram.',
    'Earlier the tests passed, but now two fail.',
    'I have not run anything; tests pass is unconfirmed.',
    'To get the tests passing I would need the fixture.',
    'I changed the parser to make the tests pass.',
    'The tests are passing data through the queue.',
    'Rode os testes e confirme que os testes passam.',
  ]) {
    expect(kinds(text), text).toEqual([])
  }
})

test('Bash commands are classified by the check they run', () => {
  expect(classifyCommand('cd /repo && bun test')).toEqual(['test'])
  expect(classifyCommand('pytest -x tests/')).toEqual(['test'])
  expect(classifyCommand('bun run typecheck')).toEqual(['lint'])
  expect(classifyCommand('npx tsc --noEmit')).toEqual(['lint'])
  expect(classifyCommand('pnpm build')).toEqual(['build'])
  expect(classifyCommand('gh pr checks 42')).toEqual(['ci'])
  expect(classifyCommand('git push origin main')).toEqual(['push'])
  expect(classifyCommand('git -C /repo push')).toEqual(['push'])
  expect(classifyCommand('npm run lint && npm test')).toEqual(['test', 'lint'])
  expect(classifyCommand('rtk -u bun test')).toEqual(['test'])
  expect(classifyCommand('rtk git push')).toEqual(['push'])
})

test('runners of the usual stacks are evidence', () => {
  const tests = [
    'pnpm --filter @recast/worker test',
    'pnpm -r test',
    'pnpm -C apps/api test',
    'npm --prefix web test',
    'npm run -w pkg test',
    'yarn workspace foo test',
    'bun --cwd claude-plugin test',
    'bun run test:unit',
    'npx playwright test',
    'node --test',
    'python -m unittest',
    'python -m pytest -q',
    'uv run pytest',
    'cargo nextest run',
    'composer test',
    'vendor/bin/pest',
    'php vendor/bin/phpunit',
    'make check',
    'bun run smoke',
    'pnpm smoke',
    'ai-harness review-verify --client claude',
    'herdr-jev review --base main',
    'herdr-jev prove',
    'claude plugin test .',
  ]
  for (const command of tests) expect(classifyCommand(command), command).toEqual(['test'])
  const lints = ['claude plugin validate .', 'astro check', 'php -l src/a.php', 'pnpm -r typecheck', 'composer phpstan', 'pnpm check']
  for (const command of lints) expect(classifyCommand(command), command).toEqual(['lint'])
  const builds = ['pnpm --filter x build', 'pnpm --filter @recast/web build', 'astro build', 'docker compose build']
  for (const command of builds) expect(classifyCommand(command), command).toEqual(['build'])
  const reads = ['az pipelines runs list', 'az repos pr show --id 1', 'gh run list --limit 3']
  for (const command of reads) expect(classifyCommand(command), command).toEqual(['ci'])
})

test('commands that only mention a runner, install one or ask for help are not evidence', () => {
  for (const command of [
    'echo "run bun test later"',
    'grep -rn pytest docs/',
    'rtk grep -rn pytest docs/',
    'git log --grep=jest',
    'ls node_modules/.bin/jest',
    'git diff --stat src/lint.ts',
    "sed -n '1,20p' scripts/typecheck.sh",
    'find . -name jest.config.js',
    'command -v pytest',
    'pip show pytest',
    'tsc --version',
    'bun test --help',
    'git add tests/pytest.ini',
    'git commit -m "fix tests"',
    'npm install -D jest',
    'pnpm add -D vitest',
    'pnpm -r add jest',
    'gh pr create --fill',
    'composer install',
  ]) {
    expect(classifyCommand(command), command).toEqual([])
  }
  expect(classifyCommand('git push --dry-run')).toEqual([])
  expect(classifyCommand('git push -n origin main')).toEqual([])
})

test('Bash commands that write files in the tree are mutating', () => {
  for (const command of [
    "sed -i s/a/b/ src/a.ts",
    'sed -e s/a/b/ -i file.ts',
    'perl -pi -e s/a/b/ f',
    'echo hi > out.txt',
    'cat a >> b.txt',
    'cmd &> out.txt',
    'git checkout -- src/a.ts',
    'git checkout main',
    'git switch main',
    'git restore src/a.ts',
    'git reset --hard',
    'git merge feat',
    'git clean -fd',
    'git stash',
    'git stash pop',
    'git pull',
    'git apply fix.patch',
    'patch -p1 < fix.patch',
    'npx prettier --write src',
    'eslint --fix src',
    'ruff format .',
    'mv a b',
    'cp a.ts b.ts',
    'rm out.log',
    'bun test 2>&1 | tee out.log',
    'xargs sed -i s/a/b/',
  ]) {
    expect(isMutatingCommand(command), command).toBe(true)
  }
})

test('read-only, scratch and branch-only Bash commands are not mutating', () => {
  for (const command of [
    'git checkout -b feat/x && git add -A && git commit -m done',
    'git switch -c feat/x',
    'git stash list',
    'git stash show -p',
    'git merge-base main HEAD',
    'git diff $(git merge-base main HEAD)..HEAD --stat',
    'git restore --staged f',
    'git reset HEAD f',
    'git reset --soft HEAD~1',
    'git clean -n',
    'git clean -nd',
    'git rm --cached x',
    'git add -A',
    'git commit -m fix',
    'git worktree add ../wt feat',
    'rm -rf /tmp/x',
    'cp a.ts /tmp/b.ts',
    'mv a.ts /tmp/b.ts',
    'git diff > /tmp/p.diff',
    'bun test > /tmp/test.log 2>&1',
    'bun test > /dev/null 2>&1',
    'bun test 2>&1 | tail -5',
    'eslint --fix-dry-run src',
    'ruff format --check .',
    'echo "a > b"',
    'echo hi >&2',
    'cmd &>/dev/null',
    '[ 3 -gt 2 ] && echo ok',
    'git status',
    'ls src',
  ]) {
    expect(isMutatingCommand(command), command).toBe(false)
  }
  expect(isMutatingCommand('git checkout main', true)).toBe(false)
})

type Step =
  | 'edit'
  | 'test'
  | 'lint'
  | 'push'
  | 'failed-push'
  | 'ci'
  | 'failed-test'
  | 'interrupted-test'
  | 'sub-edit'
  | 'sub-test'
  | 'sub-failed-test'

const checkOf = (step: Step): ClaimCheck =>
  step.includes('test') ? 'test' : step.includes('push') ? 'push' : (step as 'lint' | 'ci')

const log = (...steps: Step[]): ClaimEntry[] =>
  steps.reduce<ClaimEntry[]>((all, step) => {
    if (step === 'edit') return appendEntry(all, { type: 'edit', path: 'a.ts' })
    if (step === 'sub-edit') return appendEntry(all, { type: 'edit', path: 'a.ts', agentId: 'sub-1' })
    return appendEntry(all, {
      type: 'run',
      checks: [checkOf(step)],
      command: `run ${step}`,
      isOk: !step.includes('failed') && step !== 'interrupted-test',
      isInterrupted: step === 'interrupted-test',
      ...(step.startsWith('sub-') ? { agentId: 'sub-1' } : {}),
    })
  }, [])

const claim = (kind: 'test' | 'lint' | 'build' | 'ci' | 'verified') => [{ kind, quote: 'q' }]

test('evidence counts only when it runs after the last edit, and nothing warns without an edit', () => {
  expect(unverifiedClaims(claim('test'), log('edit'))).toEqual([{ kind: 'test', quote: 'q', reason: 'no test ran after the last edit' }])
  expect(unverifiedClaims(claim('test'), log('test', 'edit'))).toHaveLength(1)
  expect(unverifiedClaims(claim('test'), log('edit', 'test'))).toEqual([])
  expect(unverifiedClaims(claim('test'), log('edit', 'test', 'edit'))).toHaveLength(1)
  expect(unverifiedClaims(claim('test'), log('edit', 'lint'))).toHaveLength(1)
  expect(unverifiedClaims(claim('lint'), log('edit', 'lint'))).toEqual([])
  expect(unverifiedClaims(claim('test'), log())).toEqual([])
  expect(unverifiedClaims(claim('verified'), log())).toEqual([])
  expect(unverifiedClaims(claim('test'), log('test'))).toEqual([])
})

test('a failed or interrupted last run does not back a claim', () => {
  expect(unverifiedClaims(claim('test'), log('edit', 'failed-test'))[0]?.reason).toBe('the last test run failed (run failed-test)')
  expect(unverifiedClaims(claim('test'), log('edit', 'interrupted-test'))[0]?.reason).toBe('the last test run was interrupted (run interrupted-test)')
  expect(unverifiedClaims(claim('test'), log('edit', 'failed-test', 'test'))).toEqual([])
})

test('a subagent run backs a claim but a failed subagent run is never reported', () => {
  expect(unverifiedClaims(claim('test'), log('edit', 'sub-test'))).toEqual([])
  expect(unverifiedClaims(claim('test'), log('edit', 'sub-failed-test'))[0]?.reason).toBe('no test ran after the last edit')
  expect(unverifiedClaims(claim('test'), log('edit', 'test', 'sub-failed-test'))).toEqual([])
  expect(unverifiedClaims(claim('test'), log('test', 'sub-edit'))).toHaveLength(1)
})

test('a verified claim is backed by any check and a CI claim is judged against the last push', () => {
  expect(unverifiedClaims(claim('verified'), log('edit', 'lint'))).toEqual([])
  expect(unverifiedClaims(claim('verified'), log('edit'))[0]?.reason).toBe('no check ran after the last edit')
  expect(unverifiedClaims(claim('ci'), log('push'))[0]?.reason).toBe('no CI check ran after the last push')
  expect(unverifiedClaims(claim('ci'), log('push', 'ci'))).toEqual([])
  expect(unverifiedClaims(claim('ci'), log('ci', 'push'))).toHaveLength(1)
  expect(unverifiedClaims(claim('ci'), log())[0]?.reason).toBe('no CI check ran this session')
})

test('a failed push is not a marker for CI evidence', () => {
  expect(unverifiedClaims(claim('ci'), log('push', 'ci', 'failed-push'))).toEqual([])
})

test('the log keeps the newest entries only', () => {
  let all: ClaimEntry[] = []
  for (let index = 0; index < LOG_LIMIT + 50; index += 1) all = appendEntry(all, { type: 'edit', path: `f${index}` })
  expect(all).toHaveLength(LOG_LIMIT)
  expect(all[all.length - 1]?.seq).toBe(LOG_LIMIT + 50)
  expect(all[0]?.seq).toBe(51)
})

test('the warning line is plain', () => {
  expect(warningLine({ kind: 'test', quote: 'all tests pass', reason: 'no test ran after the last edit' })).toBe(
    'unverified: "all tests pass" · no test ran after the last edit',
  )
})

type World = { submitted: string[] }

function world(on: On): World & { seen: ReturnType<typeof wire> } {
  const submitted: string[] = []
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    const command = String((e as { command?: unknown }).command ?? '')
    if (command.includes('DENY')) return { deny: 'blocked' }
    if (command.includes('FAIL')) return { result: { interrupted: false }, isError: true }
    if (command.includes('INTERRUPT')) return { result: { interrupted: true } }
    if (/^git (?:diff|status|log)\b/.test(command)) return { result: { interrupted: false }, isReadOnly: true }
    return { result: { interrupted: false } }
  })
  on('tool.call', { tool: 'Edit' }, (_$, e) => {
    const path = String((e as { file_path?: unknown }).file_path ?? '')
    if (path.includes('DENY')) return { deny: 'blocked' }
    if (path.includes('FAIL')) return { result: {}, isError: true }
    return { result: {} }
  })
  on('prompt.submit', { text: /[\s\S]*/ }, (_$, e, next) => {
    submitted.push(e.text)
    return next(e)
  })
  return { seen: wire(on), submitted }
}

const SRC = `${CWD}/src/a.ts`
const start = ($: Engine) => $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
const edit = ($: Engine, options: { agentId?: string; path?: string } = {}) =>
  $.tool.call({
    tool: 'Edit',
    file_path: options.path ?? SRC,
    old_string: 'a',
    new_string: 'b',
    ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
  })
const write = ($: Engine, path: string) => $.tool.call({ tool: 'Write', file_path: path, content: 'x' })
const bash = ($: Engine, command: string, agentId?: string) =>
  $.tool.call({ tool: 'Bash', command, ...(agentId === undefined ? {} : { agentId }) })
let turns = 0
const answer = async ($: Engine, text: string, reason: 'answer' | 'aborted' | 'error' = 'answer', agentId?: string) => {
  turns += 1
  return $.turn.complete({
    answer: text,
    durationMs: 10,
    isAborted: reason === 'aborted',
    turnId: `turn-${turns}`,
    reason,
    ...(agentId === undefined ? {} : { agentId }),
  })
}
const beginTurn = ($: Engine) => {
  turns += 1
  return $.turn.start({ text: 'go', turnId: `turn-${turns}` })
}
const userPrompt = ($: Engine, text: string, kind: 'composer' | 'task-notification' | 'plugin' = 'composer') =>
  $.prompt.submit({ text, origin: kind === 'plugin' ? { kind, name: 'x' } : { kind } } as never)

async function warnings($: Engine, surface: (typeof SURFACES)[number] = 'terminal'): Promise<string[]> {
  const ui = await $.ui.mount({ plugin: 'harness', surface, component: 'AbovePrompt', props: BAND_PROPS })
  const found = await ui.findAll({ type: 'Text', text: /unverified|more unverified/ })
  await ui.unmount()
  return found.map(one => one.text)
}

const OPTIONS = { options: { autoRun: false } }

test('a claim with no check after the last edit warns on every surface and the engine band still renders', OPTIONS, async ($, on) => {
  world(on)
  await start($)
  await edit($)
  await answer($, 'Fixed it. All tests pass.')
  for (const surface of SURFACES) {
    expect(await warnings($, surface)).toEqual(['unverified: "All tests pass" · no test ran after the last edit'])
    const ui = await $.ui.mount({ plugin: 'harness', surface, component: 'AbovePrompt', props: BAND_PROPS })
    expect(await ui.find({ type: 'engine' })).toBeDefined()
    await ui.unmount()
  }
})

test('the warning is padded once and the engine band is not wrapped in padding', OPTIONS, async ($, on) => {
  world(on)
  await start($)
  await edit($)
  await answer($, 'All tests pass.')
  const ui = await $.ui.mount({ plugin: 'harness', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  const padded = (await ui.findAll({ type: 'Box' })).filter(box => box.props.paddingX !== undefined)
  expect(padded).toHaveLength(1)
  expect((await ui.find({ type: 'Box', key: 'claims' }))?.props.paddingX).toBeUndefined()
  await ui.unmount()
})

test('Portuguese claims warn too', OPTIONS, async ($, on) => {
  world(on)
  await start($)
  await edit($)
  await answer($, 'Corrigi. Os testes passaram e o typecheck limpo.')
  expect(await warnings($)).toEqual([
    'unverified: "typecheck limpo" · no lint or typecheck ran after the last edit',
    'unverified: "Os testes passaram" · no test ran after the last edit',
  ])
})

test('a check after the last edit backs the claim', OPTIONS, async ($, on) => {
  world(on)
  await start($)
  await edit($)
  await bash($, 'cd /repo && bun test')
  await answer($, 'Fixed it. All tests pass.')
  expect(await warnings($)).toEqual([])
})

test('a check before the last edit does not count', OPTIONS, async ($, on) => {
  world(on)
  await start($)
  await bash($, 'bun test')
  await edit($)
  await answer($, 'All tests pass.')
  expect(await warnings($)).toEqual(['unverified: "All tests pass" · no test ran after the last edit'])
})

test('no edit at all means no warning', OPTIONS, async ($, on) => {
  world(on)
  await start($)
  await answer($, 'All tests pass.')
  expect(await warnings($)).toEqual([])
})

test('committing on a new branch after the tests keeps them as evidence', OPTIONS, async ($, on) => {
  world(on)
  await start($)
  await edit($)
  await bash($, 'bun test')
  await bash($, 'git checkout -b feat/x && git add -A && git commit -m done')
  await bash($, 'git switch -c feat/y')
  await bash($, 'git stash list')
  await bash($, 'rm -rf /tmp/x')
  await bash($, 'git diff > /tmp/p.diff')
  await answer($, 'Committed on feat/x. All tests pass.')
  expect(await warnings($)).toEqual([])
})

test('a read-only call marked by the engine never invalidates evidence', OPTIONS, async ($, on) => {
  world(on)
  await start($)
  await edit($)
  await bash($, 'bun test')
  await bash($, 'git diff > out.diff')
  await answer($, 'All tests pass.')
  expect(await warnings($)).toEqual([])
})

test('a mutating Bash command invalidates earlier evidence, a read-only one does not', OPTIONS, async ($, on) => {
  world(on)
  await start($)
  await edit($)
  await bash($, 'bun test')
  await bash($, 'git status')
  await answer($, 'All tests pass.')
  expect(await warnings($)).toEqual([])
  await bash($, "sed -i 's/a/b/' src/a.ts")
  await answer($, 'All tests pass.')
  expect(await warnings($)).toHaveLength(1)
  await bash($, 'bun test 2>&1 | tee out.log')
  await answer($, 'All tests pass.')
  expect(await warnings($)).toEqual([])
})

test('edits to markdown or outside the session folder do not invalidate evidence', OPTIONS, async ($, on) => {
  world(on)
  await start($)
  await edit($)
  await bash($, 'bun test')
  await edit($, { path: `${CWD}/README.md` })
  await write($, `${CWD}/docs/pr-body.md`)
  await write($, '/tmp/scratch/pr-body.txt')
  await edit($, { path: '/other/repo/src/b.ts' })
  await answer($, 'All tests pass.')
  expect(await warnings($)).toEqual([])
  await write($, `${CWD}/src/new.ts`)
  await answer($, 'All tests pass.')
  expect(await warnings($)).toHaveLength(1)
})

test('a failed Edit and a denied call are not recorded', OPTIONS, async ($, on) => {
  world(on)
  await start($)
  await edit($)
  await bash($, 'bun test')
  await edit($, { path: `${CWD}/src/FAIL.ts` })
  await edit($, { path: `${CWD}/src/DENY.ts` })
  await bash($, 'echo x > out.txt DENY')
  await answer($, 'All tests pass.')
  expect(await warnings($)).toEqual([])
})

test('a failing or interrupted run is not evidence', OPTIONS, async ($, on) => {
  world(on)
  await start($)
  await edit($)
  await bash($, 'bun test FAIL')
  await answer($, 'Tests pass now.')
  expect(await warnings($)).toEqual(['unverified: "Tests pass now" · the last test run failed (bun test FAIL)'])
  await bash($, 'bun test INTERRUPT')
  await answer($, 'Tests pass now.')
  expect(await warnings($)).toEqual(['unverified: "Tests pass now" · the last test run was interrupted (bun test INTERRUPT)'])
})

test('a failed compound command does not blame or back any single check', OPTIONS, async ($, on) => {
  world(on)
  await start($)
  await edit($)
  await bash($, 'bun test')
  await bash($, 'bun test && bun run typecheck FAIL')
  await answer($, 'The tests pass; the typecheck still reports two errors.')
  expect(await warnings($)).toEqual([])
})

test('a failed compound command is no evidence either', OPTIONS, async ($, on) => {
  world(on)
  await start($)
  await edit($)
  await bash($, 'bun test && bun run typecheck FAIL')
  await answer($, 'All tests pass.')
  expect(await warnings($)).toEqual(['unverified: "All tests pass" · no test ran after the last edit'])
})

test('CI claims are judged against the last push and a status read is evidence', OPTIONS, async ($, on) => {
  world(on)
  await start($)
  await edit($)
  await bash($, 'git push origin main')
  await answer($, 'Pushed. CI is green.')
  expect(await warnings($)).toEqual(['unverified: "CI is green" · no CI check ran after the last push'])
  await bash($, 'gh run view 123')
  await answer($, 'CI is green.')
  expect(await warnings($)).toEqual([])
})

test('a dry run push is not a push', OPTIONS, async ($, on) => {
  world(on)
  await start($)
  await bash($, 'git push origin main')
  await bash($, 'gh pr checks 1')
  await bash($, 'git push --dry-run')
  await answer($, 'CI is green.')
  expect(await warnings($)).toEqual([])
})

test('no claim, a negation or a quoted claim shows nothing', OPTIONS, async ($, on) => {
  world(on)
  await start($)
  await edit($)
  for (const text of ['Changed the parser.', 'The tests do not pass yet.', 'It prints "all tests pass" at the end.', 'Testes ainda não passaram.']) {
    await answer($, text)
    expect(await warnings($)).toEqual([])
  }
})

test('aborted and errored turns are not checked', OPTIONS, async ($, on) => {
  world(on)
  await start($)
  await edit($)
  await answer($, 'All tests pass.', 'aborted')
  await answer($, 'All tests pass.', 'error')
  expect(await warnings($)).toEqual([])
})

test('the next turn clears the warning, whatever started it', OPTIONS, async ($, on) => {
  world(on)
  await start($)
  await edit($)
  await answer($, 'All tests pass.')
  expect(await warnings($)).toHaveLength(1)
  await userPrompt($, 'a background task finished', 'task-notification')
  expect(await warnings($)).toHaveLength(1)
  await beginTurn($)
  expect(await warnings($)).toEqual([])
})

test('the notice also goes to the transcript with the answer', OPTIONS, async ($, on) => {
  const { seen } = world(on)
  await start($)
  await edit($)
  await answer($, 'All tests pass.')
  expect(seen.logs).toContain('unverified: "All tests pass" · no test ran after the last edit')
  const before = seen.logs.length
  await bash($, 'bun test')
  await answer($, 'All tests pass.')
  expect(seen.logs).toHaveLength(before)
})

test('the next answer replaces the warnings', OPTIONS, async ($, on) => {
  world(on)
  await start($)
  await edit($)
  await answer($, 'All tests pass.')
  await bash($, 'bun test')
  await answer($, 'All tests pass.')
  expect(await warnings($)).toEqual([])
})

test('only three warnings are drawn and the rest are counted', OPTIONS, async ($, on) => {
  world(on)
  await start($)
  await edit($)
  await answer($, 'All tests pass. Typecheck clean. The build passes. CI is green. I verified it works.')
  const lines = await warnings($)
  expect(lines).toHaveLength(4)
  expect(lines[3]).toBe('+2 more unverified')
})

test('a subagent edit in the session folder invalidates evidence, one elsewhere does not', OPTIONS, async ($, on) => {
  world(on)
  await start($)
  await edit($)
  await bash($, 'bun test')
  await edit($, { agentId: 'sub-1', path: '/tmp/worktrees/other/src/a.ts' })
  await bash($, 'git diff $(git merge-base main HEAD)', 'sub-1')
  await answer($, 'All tests pass.')
  expect(await warnings($)).toEqual([])
  await edit($, { agentId: 'sub-1' })
  await answer($, 'All tests pass.')
  expect(await warnings($)).toHaveLength(1)
})

test('a subagent run backs the claim and a failing one is never reported', OPTIONS, async ($, on) => {
  world(on)
  await start($)
  await edit($)
  await bash($, 'bun test FAIL', 'sub-1')
  await answer($, 'All tests pass.')
  expect(await warnings($)).toEqual(['unverified: "All tests pass" · no test ran after the last edit'])
  await bash($, 'bun test', 'sub-1')
  await answer($, 'All tests pass.')
  expect(await warnings($)).toEqual([])
})

test('a subagent answer is never checked', OPTIONS, async ($, on) => {
  world(on)
  await start($)
  await edit($)
  await answer($, 'All tests pass.', 'answer', 'sub-1')
  expect(await warnings($)).toEqual([])
})

test('the warning shows beside the plan band and yields to a survey', OPTIONS, async ($, on) => {
  world(on)
  await start($)
  await makePlan($, { objective: 'Ship it', tasks: [{ title: 'Add parser' }] })
  await edit($)
  await answer($, 'All tests pass.')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'harness', surface, component: 'AbovePrompt', props: BAND_PROPS })
    expect(await ui.find({ type: 'Text', text: 'Add parser' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /unverified: "All tests pass"/ })).toBeDefined()
    await ui.unmount()
    const survey = await $.ui.mount({ plugin: 'harness', surface, component: 'AbovePrompt', props: { ...BAND_PROPS, hasSurvey: true } })
    expect(await survey.find({ type: 'Text', text: /unverified/ })).toBeUndefined()
    await survey.unmount()
  }
})

test('nothing is ever denied, held or submitted', OPTIONS, async ($, on) => {
  const { submitted } = world(on)
  await start($)
  const calls = [
    await edit($),
    await bash($, 'bun test FAIL'),
    await bash($, "sed -i 's/a/b/' src/a.ts"),
    await $.tool.call({ tool: 'Read', file_path: SRC }),
  ]
  for (const out of calls) expect('deny' in out).toBe(false)
  const done = await answer($, 'All tests pass. Typecheck clean. CI is green. I verified it works.')
  expect(done.text).toBe('All tests pass. Typecheck clean. CI is green. I verified it works.')
  expect(await warnings($)).not.toEqual([])
  const out = await userPrompt($, 'next')
  expect(out.text).toBe('next')
  expect('drop' in out).toBe(false)
  expect(submitted).toEqual(['next'])
})
