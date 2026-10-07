import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import {
  agentReason,
  filterSkillListing,
  invokedSkill,
  listOption,
  parseRoute,
  parseSkillSelect,
  skillReason,
  EMPTY_SCOPE,
} from '../hooks/scope'
import { BAND_PROPS, CWD, makePlan, PANE_PROPS, settle, wire } from './support'
import type { Seen } from './support'

const HEADER = 'The following skills are available for use with the Skill tool:'

const LISTING = [
  HEADER,
  '',
  '- tdd: Test driven development.',
  '- vault: Read secrets from the vault.',
  '- repo-skill: Only for this repo.',
  '- veo-video-gen: Make videos.',
  'TRIGGER — read BEFORE opening the target file.',
  '- claude-api: Reference for the Claude API.',
  '- hookify:configure: Configure hooks',
  '- promote: Promote rules.',
].join('\n')

const NAMES = ['tdd', 'vault', 'repo-skill', 'veo-video-gen', 'claude-api', 'hookify:configure', 'promote']

const start = ($: Engine) => $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

function listed(text: string | null | undefined): string[] {
  return (text ?? '')
    .split('\n')
    .filter(line => line.startsWith('- '))
    .map(line => line.slice(2).split(': ')[0] ?? '')
}

async function listing($: Engine, text = LISTING): Promise<string | null> {
  const out = await $.prompt.attachment({ type: 'skill_listing', text, origin: { kind: 'engine' } } as never)
  return out.text
}

function ready(seen: Seen): void {
  seen.skills = [
    { name: 'repo-skill', source: 'projectSettings' },
    ...NAMES.filter(one => one !== 'repo-skill').map(name => ({ name, source: 'userSettings' })),
  ]
}

const offer = ($: Engine, agent: string, source = 'userSettings') =>
  $.agent.offer({ agent, description: '', source, provider: { plugin: 'engine', tier: 'core' } } as never)

test('filterSkillListing keeps what the predicate keeps byte for byte and ignores unknown formats', async () => {
  const out = filterSkillListing(LISTING, name => name === 'tdd' || name === 'claude-api')
  expect(out?.removed).toEqual(['vault', 'repo-skill', 'veo-video-gen', 'hookify:configure', 'promote'])
  expect(out?.text).toContain('- tdd: Test driven development.')
  expect(out?.text).not.toContain('TRIGGER')
  expect(out?.text).not.toContain('vault')
  const kept = filterSkillListing(LISTING, name => name !== 'repo-skill')
  expect(kept?.text).toContain('TRIGGER — read BEFORE opening the target file.\n- claude-api')
  expect(filterSkillListing('Something else entirely', () => false)).toBeNull()
  expect(filterSkillListing(`${HEADER}\nnothing`, () => false)).toBeNull()
})

test('skillReason ranks project, invoked, always, skill-select and route-turn', async () => {
  const state = { ...EMPTY_SCOPE, status: 'ready' as const, selected: ['tdd'], clis: ['git-insight-mcp'], turn: ['refactor'], invoked: ['veo-video-gen'] }
  const ctx = { own: new Map([['repo-skill', 'project' as const]]), always: ['vault'], state }
  expect(skillReason('repo-skill', ctx)).toBe('project')
  expect(skillReason('veo-video-gen', ctx)).toBe('invoked')
  expect(skillReason('vault', ctx)).toBe('always')
  expect(skillReason('plug:vault', ctx)).toBe('always')
  expect(skillReason('tdd', ctx)).toBe('skill-select')
  expect(skillReason('git-insight-mcp', ctx)).toBe('skill-select')
  expect(skillReason('refactor', ctx)).toBe('route-turn')
  expect(skillReason('claude-api', ctx)).toBeNull()
})

test('agentReason keeps built-ins, harness agents, project agents and the allowlist', async () => {
  const always = ['software-engineer']
  expect(agentReason('Explore', 'built-in', always)).toBe('built-in')
  expect(agentReason('PlanChecker', 'userSettings', always)).toBe('built-in')
  expect(agentReason('harness:reviewer', 'plugin', always)).toBe('harness')
  expect(agentReason('mine', 'projectSettings', always)).toBe('project')
  expect(agentReason('software-engineer', 'userSettings', always)).toBe('always')
  expect(agentReason('llmtrim-grok', 'userSettings', always)).toBeNull()
  expect(agentReason('GrokForge', 'userSettings', always)).toBeNull()
})

test('parsers and helpers read the CLI JSON, the slash command and the config lists', async () => {
  expect(parseSkillSelect({ selected: [{ name: 'a' }], cliSelected: [{ name: 'b' }], totalEligible: 74 })).toEqual({ skills: ['a'], clis: ['b'], total: 74 })
  expect(parseSkillSelect({ nope: 1 })).toBeNull()
  expect(parseRoute({ decision: { skill: 'tdd' } })).toBe('tdd')
  expect(parseRoute({ decision: { skill: null } })).toBeNull()
  expect(invokedSkill('/veo-video-gen make it')).toBe('veo-video-gen')
  expect(invokedSkill('  /ns:skill')).toBe('ns:skill')
  expect(invokedSkill('plain text /not')).toBeNull()
  expect(listOption('a, b\nc', ['x'])).toEqual(['a', 'b', 'c'])
  expect(listOption(undefined, ['x'])).toEqual(['x'])
})

test('enforce hides skills nothing selected, keeps project, always, selected and invoked ones', async ($, on) => {
  const seen = wire(on)
  ready(seen)
  await start($)
  await settle()
  expect(seen.runs.some(argv => argv[0] === 'ai-harness' && argv[1] === 'skill-select')).toBe(true)

  const names = listed(await listing($))
  expect(names).toEqual(['tdd', 'vault', 'repo-skill', 'promote'])

  await $.prompt.submit({ text: '/veo-video-gen make a clip' } as never)
  await settle()
  expect(listed(await listing($))).toContain('veo-video-gen')
})

test('report mode hides nothing but still computes the receipt', { options: { scopeMode: 'report' } }, async ($, on) => {
  const seen = wire(on)
  ready(seen)
  await start($)
  await settle()
  expect(listed(await listing($))).toEqual(listed(LISTING))
  const ran = await $.command.run({ command: 'harness', args: 'scope', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(ran.text).toBeUndefined()
  const log = seen.logs.find(line => line.startsWith('Scope · report'))
  expect(log).toContain('would hide 3')
  expect(log).toContain('project: repo-skill')
  expect(seen.logs.some(line => line.includes('hookify:configure'))).toBe(true)
})

test('off mode leaves everything alone', { options: { scopeMode: 'off' } }, async ($, on) => {
  const seen = wire(on)
  ready(seen)
  await start($)
  await settle()
  expect(seen.runs.some(argv => argv[1] === 'skill-select')).toBe(false)
  expect(await listing($)).toBe(LISTING)
  expect((await offer($, 'llmtrim-grok')).isOffered).toBe(true)
})

test('a failing skill-select marks the scope partial and hides no skill', async ($, on) => {
  const seen = wire(on)
  ready(seen)
  seen.failSelect = true
  await start($)
  await settle()
  expect(await listing($)).toBe(LISTING)
  expect(seen.state.get('harness.scope')).toMatchObject({ status: 'partial' })
  expect(seen.logs.some(line => line.includes('skill-select unavailable'))).toBe(true)
  expect(seen.logs.filter(line => line.includes('skill-select unavailable'))).toHaveLength(1)
  await listing($)
  expect(seen.logs.filter(line => line.includes('skill-select unavailable'))).toHaveLength(1)
})

test('an unknown listing format or unreadable project skills pass through with one note', async ($, on) => {
  const seen = wire(on)
  ready(seen)
  await start($)
  await settle()
  expect(await listing($, 'A different listing\n- tdd: x')).toBe('A different listing\n- tdd: x')
  seen.failUsage = true
  expect(await listing($)).toBe(LISTING)
  expect(seen.logs.some(line => line.includes('unexpected format'))).toBe(true)
  expect(seen.logs.some(line => line.includes('could not tell project skills apart'))).toBe(true)
})

test('only engine listings are filtered', async ($, on) => {
  const seen = wire(on)
  ready(seen)
  await start($)
  await settle()
  const out = await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: { kind: 'plugin', name: 'x' } } as never)
  expect(out.text).toBe(LISTING)
  const other = await $.prompt.attachment({ type: 'todo_reminder', text: LISTING, origin: { kind: 'engine' } } as never)
  expect(other.text).toBe(LISTING)
})

test('route-turn adds its skill to the allowlist without blocking the prompt', async ($, on) => {
  const seen = wire(on)
  ready(seen)
  seen.routeSkill = 'claude-api'
  await start($)
  await settle()
  expect(listed(await listing($))).not.toContain('claude-api')
  const out = await $.prompt.submit({ text: 'call the claude api' } as never)
  expect(out.text).toBe('call the claude api')
  await settle()
  expect(seen.runs.some(argv => argv[1] === 'route-turn')).toBe(true)
  expect(listed(await listing($))).toContain('claude-api')
})

test('harness_plan refreshes the selection with the objective as the query', async ($, on) => {
  const seen = wire(on)
  ready(seen)
  await start($)
  await settle()
  seen.skillSelect = { selected: [{ name: 'claude-api' }], cliSelected: [], totalEligible: 74 }
  await makePlan($, { objective: 'Wire the Claude API client', tasks: [{ title: 'Add client' }] })
  await settle()
  const run = [...seen.runs].reverse().find(argv => argv[1] === 'skill-select')
  expect(run).toContain('Wire the Claude API client')
  expect(listed(await listing($))).toContain('claude-api')
  expect(listed(await listing($))).not.toContain('tdd')
})

test('a configured runbook is passed to skill-select', { options: { runbook: 'develop-typescript-javascript' } }, async ($, on) => {
  const seen = wire(on)
  await start($)
  await settle()
  const run = seen.runs.find(argv => argv[1] === 'skill-select')
  expect(run).toContain('--runbook')
  expect(run).toContain('develop-typescript-javascript')
})

test('agent.offer hides agents outside the allowlist in enforce and keeps them in report', async ($, on) => {
  wire(on)
  await start($)
  expect((await offer($, 'llmtrim-grok')).isOffered).toBe(false)
  expect((await offer($, 'GrokForge')).isOffered).toBe(false)
  expect((await offer($, 'pr-review-toolkit:code-reviewer', 'plugin')).isOffered).toBe(false)
  expect((await offer($, 'Explore', 'built-in')).isOffered).toBe(true)
  expect((await offer($, 'software-engineer')).isOffered).toBe(true)
  expect((await offer($, 'quality-reviewer')).isOffered).toBe(true)
  expect((await offer($, 'mine', 'projectSettings')).isOffered).toBe(true)
})

test('agent.offer in report mode hides nothing', { options: { scopeMode: 'report' } }, async ($, on) => {
  wire(on)
  await start($)
  expect((await offer($, 'llmtrim-grok')).isOffered).toBe(true)
})

test('the scope resets on clear and resume', async ($, on) => {
  const seen = wire(on)
  ready(seen)
  await start($)
  await settle()
  await listing($)
  expect(seen.state.get('harness.scope')).toMatchObject({ status: 'ready' })
  seen.failSelect = true
  await $.classic.SessionStart({ source: 'clear' } as never)
  await settle()
  expect(seen.state.get('harness.scope')).toMatchObject({ status: 'partial' })
  expect(await listing($)).toBe(LISTING)
})

test('the pane has a folded Scope section that lists kept items with reasons on unfold', async ($, on) => {
  const seen = wire(on)
  ready(seen)
  await start($)
  await settle()
  await listing($)
  await offer($, 'llmtrim-grok')
  await offer($, 'software-engineer')
  await makePlan($, { objective: 'One', tasks: [{ title: 'Add parser' }] })
  await settle()
  await listing($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'harness', surface, component: 'Pane', requestId: 'harness', props: PANE_PROPS })
    const heading = await ui.find({ type: 'Text', text: /^Scope · enforce · \d+ of \d+ skills · \d+ of \d+ agents$/ })
    expect(heading).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'section-scope' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /project: repo-skill/ })).toBeUndefined()
    await ui.press({ key: 'section-scope' })
    expect(await ui.find({ type: 'Text', text: /repo-skill/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /software-engineer/ })).toBeDefined()
    await ui.press({ key: 'section-scope' })
    await ui.unmount()
  }
})

test('the scope band is unaffected and the Skill tool is never denied', async ($, on) => {
  const seen = wire(on)
  ready(seen)
  await start($)
  await settle()
  await listing($)
  const out = await $.tool.call({ tool: 'Skill', skill: 'veo-video-gen' } as never)
  expect(out.deny).toBeUndefined()
  expect(BAND_PROPS.hasSurvey).toBe(false)
  expect(CWD).toBe('/work/demo')
})
