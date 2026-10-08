import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { appendEntry, classifyCommand, detectClaims, isMutatingCommand, unverifiedClaims, warningLine } from '../hooks/claims'
import type { ClaimEntry } from '../types'
import { BAND_PROPS, CWD, makePlan, wire } from './support'
import type { Seen } from './support'

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
  expect(kinds('All checks pass on PR #42.')).toEqual(['ci'])
  expect(kinds('I verified it works.')).toEqual(['verified'])
  expect(kinds('I verified the change.')).toEqual(['verified'])
  expect(kinds('Verified.')).toEqual(['verified'])
  expect(kinds('Everything passes.')).toEqual(['verified'])
  expect(kinds('Tests pass. Really, all tests pass.')).toEqual(['test'])
  expect(detectClaims('Done, tests pass.')).toEqual([{ kind: 'test', quote: 'tests pass' }])
  expect(detectClaims('CI green, merging.')[0]?.quote).toBe('CI green')
  expect(kinds('Typecheck clean and all tests pass.')).toEqual(['lint', 'test'])
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
  expect(kinds('Está verificado.')).toEqual(['verified'])
  expect(kinds('Tudo verificado.')).toEqual(['verified'])
  expect(kinds('Rodei tudo e passou.')).toEqual(['verified'])
  expect(kinds('Verifiquei que funciona.')).toEqual(['verified'])
  expect(detectClaims('Feito, testes passaram.')).toEqual([{ kind: 'test', quote: 'testes passaram' }])
})

test('negations, hedges, conditions and questions are not claims', () => {
  expect(kinds('The tests do not pass.')).toEqual([])
  expect(kinds('Not all tests pass.')).toEqual([])
  expect(kinds('None of the tests pass.')).toEqual([])
  expect(kinds("Tests aren't passing.")).toEqual([])
  expect(kinds('CI is not green yet.')).toEqual([])
  expect(kinds("I haven't verified it works.")).toEqual([])
  expect(kinds('This is not verified.')).toEqual([])
  expect(kinds('It still needs to be verified.')).toEqual([])
  expect(kinds('The tests should pass now.')).toEqual([])
  expect(kinds('Once the tests pass I will open the PR.')).toEqual([])
  expect(kinds('Make sure CI is green before merging.')).toEqual([])
  expect(kinds('Do the tests pass?')).toEqual([])
  expect(kinds('Os testes não passaram.')).toEqual([])
  expect(kinds('Nem todos os testes passaram.')).toEqual([])
  expect(kinds('O CI ainda não está verde.')).toEqual([])
  expect(kinds('Ainda não verificado.')).toEqual([])
  expect(kinds('Quando os testes passarem eu abro o PR.')).toEqual([])
  expect(kinds('O prazo passou do limite.')).toEqual([])
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

test('Bash commands are classified by the check they run', () => {
  expect(classifyCommand('cd /repo && bun test')).toEqual(['test'])
  expect(classifyCommand('claude plugin test .')).toEqual(['test'])
  expect(classifyCommand('pytest -x tests/')).toEqual(['test'])
  expect(classifyCommand('bun run typecheck')).toEqual(['lint'])
  expect(classifyCommand('npx tsc --noEmit')).toEqual(['lint'])
  expect(classifyCommand('pnpm build')).toEqual(['build'])
  expect(classifyCommand('gh pr checks 42')).toEqual(['ci'])
  expect(classifyCommand('git push origin main')).toEqual(['push'])
  expect(classifyCommand('npm run lint && npm test')).toEqual(['test', 'lint'])
  expect(classifyCommand('echo "run bun test later"')).toEqual([])
  expect(classifyCommand('grep -rn pytest docs/')).toEqual([])
  expect(classifyCommand('npm install -D jest')).toEqual([])
  expect(classifyCommand('git commit -m "fix tests"')).toEqual([])
})

test('Bash commands that write files are mutating', () => {
  expect(isMutatingCommand('sed -i s/a/b/ src/a.ts')).toBe(true)
  expect(isMutatingCommand('echo hi > out.txt')).toBe(true)
  expect(isMutatingCommand('cat a >> b.txt')).toBe(true)
  expect(isMutatingCommand('git checkout -- src/a.ts')).toBe(true)
  expect(isMutatingCommand('npx prettier --write src')).toBe(true)
  expect(isMutatingCommand('mv a b')).toBe(true)
  expect(isMutatingCommand('bun test 2>&1 | tee out.log')).toBe(true)
  expect(isMutatingCommand('bun test > /dev/null 2>&1')).toBe(false)
  expect(isMutatingCommand('bun test 2>&1 | tail -5')).toBe(false)
  expect(isMutatingCommand('echo "a > b"')).toBe(false)
  expect(isMutatingCommand('git status')).toBe(false)
  expect(isMutatingCommand('ls src')).toBe(false)
})

const log = (...steps: ('edit' | 'test' | 'lint' | 'push' | 'ci' | 'failed-test' | 'interrupted-test')[]): ClaimEntry[] =>
  steps.reduce<ClaimEntry[]>((all, step) => {
    if (step === 'edit') return appendEntry(all, { type: 'edit', path: 'a.ts' })
    const check = step === 'failed-test' || step === 'interrupted-test' ? 'test' : step
    return appendEntry(all, {
      type: 'run',
      checks: [check],
      command: `run ${step}`,
      isOk: step !== 'failed-test' && step !== 'interrupted-test',
      isInterrupted: step === 'interrupted-test',
    })
  }, [])

const claim = (kind: 'test' | 'lint' | 'build' | 'ci' | 'verified') => [{ kind, quote: 'q' }]

test('evidence counts only when it runs after the last edit', () => {
  expect(unverifiedClaims(claim('test'), log('edit'))).toEqual([{ kind: 'test', quote: 'q', reason: 'no test ran after the last edit' }])
  expect(unverifiedClaims(claim('test'), log('test', 'edit'))).toHaveLength(1)
  expect(unverifiedClaims(claim('test'), log('edit', 'test'))).toEqual([])
  expect(unverifiedClaims(claim('test'), log('edit', 'test', 'edit'))).toHaveLength(1)
  expect(unverifiedClaims(claim('test'), log('edit', 'lint'))).toHaveLength(1)
  expect(unverifiedClaims(claim('lint'), log('edit', 'lint'))).toEqual([])
  expect(unverifiedClaims(claim('test'), log())[0]?.reason).toBe('no test ran this session')
  expect(unverifiedClaims(claim('test'), log('test'))).toEqual([])
})

test('a failed or interrupted last run does not back a claim', () => {
  expect(unverifiedClaims(claim('test'), log('edit', 'failed-test'))[0]?.reason).toBe('the last test run failed (run failed-test)')
  expect(unverifiedClaims(claim('test'), log('edit', 'interrupted-test'))[0]?.reason).toBe('the last test run was interrupted (run interrupted-test)')
  expect(unverifiedClaims(claim('test'), log('edit', 'failed-test', 'test'))).toEqual([])
})

test('a verified claim is backed by any check and a CI claim is judged against the last push', () => {
  expect(unverifiedClaims(claim('verified'), log('edit', 'lint'))).toEqual([])
  expect(unverifiedClaims(claim('verified'), log('edit'))[0]?.reason).toBe('no check ran after the last edit')
  expect(unverifiedClaims(claim('ci'), log('push'))[0]?.reason).toBe('no CI check ran after the last push')
  expect(unverifiedClaims(claim('ci'), log('push', 'ci'))).toEqual([])
  expect(unverifiedClaims(claim('ci'), log('ci', 'push'))).toHaveLength(1)
})

test('the warning line is plain', () => {
  expect(warningLine({ kind: 'test', quote: 'all tests pass', reason: 'no test ran after the last edit' })).toBe(
    'unverified: "all tests pass" · no test ran after the last edit',
  )
})

type World = { seen: Seen; submitted: string[] }

function world(on: On): World {
  const submitted: string[] = []
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    const command = String((e as { command?: unknown }).command ?? '')
    if (command.includes('FAIL')) return { result: { interrupted: false }, isError: true }
    if (command.includes('INTERRUPT')) return { result: { interrupted: true } }
    return { result: { interrupted: false } }
  })
  on('prompt.submit', { text: /[\s\S]*/ }, (_$, e, next) => {
    submitted.push(e.text)
    return next(e)
  })
  return { seen: wire(on), submitted }
}

const start = ($: Engine) => $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
const edit = ($: Engine, agentId?: string) =>
  $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b', ...(agentId === undefined ? {} : { agentId }) })
const bash = ($: Engine, command: string, agentId?: string) =>
  $.tool.call({ tool: 'Bash', command, ...(agentId === undefined ? {} : { agentId }) })
const answer = ($: Engine, text: string, reason: 'answer' | 'aborted' | 'error' = 'answer', agentId?: string) =>
  $.turn.complete({
    answer: text,
    durationMs: 10,
    isAborted: reason === 'aborted',
    turnId: 'turn-main',
    reason,
    ...(agentId === undefined ? {} : { agentId }),
  })
const userPrompt = ($: Engine, text: string, kind: 'composer' | 'task-notification' | 'plugin' = 'composer') =>
  $.prompt.submit({ text, origin: kind === 'plugin' ? { kind, name: 'x' } : { kind } } as never)

async function warnings($: Engine, surface: (typeof SURFACES)[number] = 'terminal'): Promise<string[]> {
  const ui = await $.ui.mount({ plugin: 'harness', surface, component: 'AbovePrompt', props: BAND_PROPS })
  const found = await ui.findAll({ type: 'Text', text: /unverified|more unverified/ })
  await ui.unmount()
  return found.map(one => one.text)
}

test('a claim with no check after the last edit warns on every surface and the engine band still renders', { options: { autoRun: false } }, async ($, on) => {
  world(on)
  await start($)
  await edit($)
  await answer($, 'Fixed it. All tests pass.')
  for (const surface of SURFACES) {
    expect(await warnings($, surface)).toEqual(['unverified: "All tests pass" · no test ran after the last edit'])
    const ui = await $.ui.mount({ plugin: 'harness', surface, component: 'AbovePrompt', props: BAND_PROPS })
    expect(await ui.find({ text: 'engine band' })).toBeDefined()
    await ui.unmount()
  }
})

test('Portuguese claims warn too', { options: { autoRun: false } }, async ($, on) => {
  world(on)
  await start($)
  await edit($)
  await answer($, 'Corrigi. Os testes passaram e o typecheck limpo.')
  expect(await warnings($)).toEqual([
    'unverified: "typecheck limpo" · no lint or typecheck ran after the last edit',
    'unverified: "Os testes passaram" · no test ran after the last edit',
  ])
})

test('a check after the last edit backs the claim', { options: { autoRun: false } }, async ($, on) => {
  world(on)
  await start($)
  await edit($)
  await bash($, 'cd /repo && bun test')
  await answer($, 'Fixed it. All tests pass.')
  expect(await warnings($)).toEqual([])
})

test('a check before the last edit does not count', { options: { autoRun: false } }, async ($, on) => {
  world(on)
  await start($)
  await bash($, 'bun test')
  await edit($)
  await answer($, 'All tests pass.')
  expect(await warnings($)).toEqual(['unverified: "All tests pass" · no test ran after the last edit'])
})

test('a mutating Bash command invalidates earlier evidence, a read-only one does not', { options: { autoRun: false } }, async ($, on) => {
  world(on)
  await start($)
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

test('a failing or interrupted run is not evidence', { options: { autoRun: false } }, async ($, on) => {
  world(on)
  await start($)
  await edit($)
  await bash($, 'bun test FAIL')
  await answer($, 'Tests pass now.')
  expect(await warnings($)).toEqual(['unverified: "Tests pass" · the last test run failed (bun test FAIL)'])
  await bash($, 'bun test INTERRUPT')
  await answer($, 'Tests pass now.')
  expect(await warnings($)).toEqual(['unverified: "Tests pass" · the last test run was interrupted (bun test INTERRUPT)'])
})

test('CI claims are judged against the last push and a status read is evidence', { options: { autoRun: false } }, async ($, on) => {
  world(on)
  await start($)
  await bash($, 'git push origin main')
  await answer($, 'Pushed. CI is green.')
  expect(await warnings($)).toEqual(['unverified: "CI is green" · no CI check ran after the last push'])
  await bash($, 'gh run view 123')
  await answer($, 'CI is green.')
  expect(await warnings($)).toEqual([])
})

test('no claim, a negation or a quoted claim shows nothing', { options: { autoRun: false } }, async ($, on) => {
  world(on)
  await start($)
  await edit($)
  for (const text of ['Changed the parser.', 'The tests do not pass yet.', 'It prints "all tests pass" at the end.', 'Testes ainda não passaram.']) {
    await answer($, text)
    expect(await warnings($)).toEqual([])
  }
})

test('aborted and errored turns are not checked', { options: { autoRun: false } }, async ($, on) => {
  world(on)
  await start($)
  await edit($)
  await answer($, 'All tests pass.', 'aborted')
  await answer($, 'All tests pass.', 'error')
  expect(await warnings($)).toEqual([])
})

test('the next prompt from the person clears the warning, other prompts do not', { options: { autoRun: false } }, async ($, on) => {
  world(on)
  await start($)
  await edit($)
  await answer($, 'All tests pass.')
  expect(await warnings($)).toHaveLength(1)
  await userPrompt($, 'a background task finished', 'task-notification')
  await userPrompt($, 'plugin text', 'plugin')
  expect(await warnings($)).toHaveLength(1)
  await userPrompt($, 'ok, thanks')
  expect(await warnings($)).toEqual([])
})

test('the next answer replaces the warnings', { options: { autoRun: false } }, async ($, on) => {
  world(on)
  await start($)
  await edit($)
  await answer($, 'All tests pass.')
  await bash($, 'bun test')
  await answer($, 'All tests pass.')
  expect(await warnings($)).toEqual([])
})

test('only three warnings are drawn and the rest are counted', { options: { autoRun: false } }, async ($, on) => {
  world(on)
  await start($)
  await edit($)
  await answer($, 'All tests pass. Typecheck clean. The build passes. CI is green. I verified it works.')
  const lines = await warnings($)
  expect(lines).toHaveLength(4)
  expect(lines[3]).toBe('+2 more unverified')
})

test('a subagent edit invalidates evidence and a subagent run backs the claim', { options: { autoRun: false } }, async ($, on) => {
  world(on)
  await start($)
  await bash($, 'bun test')
  await edit($, 'sub-1')
  await answer($, 'All tests pass.')
  expect(await warnings($)).toHaveLength(1)
  await bash($, 'bun test', 'sub-1')
  await answer($, 'All tests pass.')
  expect(await warnings($)).toEqual([])
})

test('a subagent answer is never checked', { options: { autoRun: false } }, async ($, on) => {
  world(on)
  await start($)
  await edit($)
  await answer($, 'All tests pass.', 'answer', 'sub-1')
  expect(await warnings($)).toEqual([])
})

test('the warning shows beside the plan band and yields to a survey', { options: { autoRun: false } }, async ($, on) => {
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

test('nothing is ever denied, held or submitted', { options: { autoRun: false } }, async ($, on) => {
  const { submitted } = world(on)
  await start($)
  const calls = [
    await edit($),
    await bash($, 'bun test FAIL'),
    await bash($, "sed -i 's/a/b/' src/a.ts"),
    await $.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts' }),
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
