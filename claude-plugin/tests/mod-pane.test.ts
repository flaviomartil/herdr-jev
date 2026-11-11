import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { resetDelegation } from '../hooks/delegation'
import { resetModPane, agentRows } from '../hooks/mod-pane'
import { avatar, avatarSignature } from '../hooks/identity-core'
import { CWD, PANE_PROPS, wire } from './support'

const row = (agentId: string, client: string, model: string | null, status: string, lastLine: string) => ({
  agentId,
  client,
  model,
  status,
  startedAt: 1,
  lastLine,
})
const THREE = {
  'agent-a': row('agent-a', 'codex', 'luna', 'running', 'editing parser'),
  'agent-b': row('agent-b', 'agy', 'flash', 'failed', 'quota'),
  'agent-c': row('agent-c', 'claude', 'haiku', 'done', 'finished'),
}
const jevUi = ($: Engine) => $.ui.mount({ plugin: 'harness', surface: 'terminal', component: 'Pane', requestId: 'jev', props: { ...PANE_PROPS, title: 'Jev' } })

test('mod pane: 3 agents of distinct CLIs get stable names, distinct avatars and their states', { options: { delegation: true } }, async ($, on) => {
  resetDelegation()
  resetModPane()
  const seen = wire(on)
  mock.env(on, { HOME: '/home/user' })
  on('fs.read', () => ({ value: '' }))
  seen.runHook = async () => ({ exitCode: 0, stdout: '/bin/x', stderr: '' })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__harness__harness_delegate', tool_use_id: 't1', tasks: [{ task: 'Find the config' }, { task: 'Find a', prefer: 'codex' }, { task: 'Find b', prefer: 'agy' }] } as never)
  const ui = await jevUi($)
  for (const text of ['Ada', 'Bo', 'Cass']) {
    expect(await ui.find({ type: 'Text', text })).toBeDefined()
  }
  expect(await ui.find({ type: 'Text', text: /\d+%/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'codex' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'agy' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'claude' })).toBeDefined()
  for (const section of ['Precisa de voce', 'Trabalhando', 'Modelos e proxies', 'Propostas']) {
    expect(await ui.find({ type: 'Text', text: new RegExp(section) })).toBeDefined()
  }
  expect(await ui.find({ type: 'Text', text: /Sem propostas/ })).toBeDefined()
  const first = (await ui.findAll({ type: 'Text', text: /^(Ada|Bo|Cass)$/ })).map(t => t.text)
  await ui.unmount()
  const again = await jevUi($)
  expect((await again.findAll({ type: 'Text', text: /^(Ada|Bo|Cass)$/ })).map(t => t.text)).toEqual(first)
  const rows = agentRows({ delegations: [], roster: {}, plan: null, asks: [], workers: {}, usage: null, external: THREE as never })
  expect(new Set(rows.map(r => r.kind))).toEqual(new Set(['codex', 'agy', 'haiku']))
  expect(new Set(rows.map(r => avatarSignature(avatar(r.kind, r.id)))).size).toBe(3)
  expect(rows.map(r => r.state)).toEqual(['working', 'failed', 'done'])
})

test('mod pane: empty state and no herdr needed', async ($, on) => {
  resetDelegation()
  resetModPane()
  wire(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  const ui = await jevUi($)
  expect(await ui.find({ type: 'Text', text: /Nenhum agente ativo/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Nada pendente/ })).toBeDefined()
})

const delegate = ($: Engine, tasks: unknown[]) =>
  $.tool.call({ tool: 'mcp__harness__harness_delegate', tool_use_id: 't9', tasks } as never)
const NAME = /^(Ada|Bo|Cass|Dev|Ede|Fen)$/
const delegating = { options: { delegation: true } }

test('mod pane: a delegation started after the pane is mounted redraws it', delegating, async ($, on) => {
  resetDelegation()
  resetModPane()
  const seen = wire(on)
  mock.env(on, { HOME: '/home/user' })
  on('fs.read', () => ({ value: '' }))
  seen.runHook = async () => ({ exitCode: 0, stdout: '/bin/x', stderr: '' })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  const ui = await jevUi($)
  expect(await ui.find({ type: 'Text', text: /Nenhum agente ativo/ })).toBeDefined()
  await delegate($, [{ task: 'Find the config' }])
  expect(await ui.find({ type: 'Text', text: 'Ada' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Nenhum agente ativo/ })).toBeUndefined()
})

test('mod pane: names survive a reload through the stored roster', delegating, async ($, on) => {
  resetDelegation()
  resetModPane()
  const seen = wire(on)
  mock.env(on, { HOME: '/home/user' })
  on('fs.read', () => ({ value: '' }))
  seen.runHook = async () => ({ exitCode: 0, stdout: '/bin/x', stderr: '' })
  seen.saved.set('jev.roster', { stored: 5 })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await delegate($, [{ task: 'Find the config' }])
  const ui = await jevUi($)
  expect(await ui.find({ type: 'Text', text: 'Gus' })).toBeDefined()
  expect(seen.saved.get('jev.roster')).toMatchObject({ stored: 5 })
})

test('mod pane: text uses theme tokens, avatars carry a background, runs are merged', delegating, async ($, on) => {
  resetDelegation()
  resetModPane()
  const seen = wire(on)
  mock.env(on, { HOME: '/home/user' })
  on('fs.read', () => ({ value: '' }))
  seen.runHook = async () => ({ exitCode: 0, stdout: '/bin/x', stderr: '' })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await delegate($, [{ task: 'Find the config' }])
  const ui = await jevUi($)
  const texts = await ui.findAll({ type: 'Text' })
  for (const t of texts) if (typeof t.props.color === 'string' && t.props.color.startsWith('#')) expect(t.props.backgroundColor).toBeDefined()
  expect((await ui.find({ type: 'Text', text: 'Ada' }))?.props.color).toBe('remember')
  const cells = texts.filter(t => typeof t.props.color === 'string' && t.props.color.startsWith('#'))
  expect(cells.length).toBeLessThan(12)
})

test('mod pane: a narrow pane drops the avatar', delegating, async ($, on) => {
  resetDelegation()
  resetModPane()
  const seen = wire(on)
  mock.env(on, { HOME: '/home/user' })
  on('fs.read', () => ({ value: '' }))
  seen.runHook = async () => ({ exitCode: 0, stdout: '/bin/x', stderr: '' })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await delegate($, [{ task: 'Find the config' }])
  const ui = await $.ui.mount({ plugin: 'harness', surface: 'terminal', component: 'Pane', requestId: 'jev', props: { ...PANE_PROPS, title: 'Jev', bodyColumns: 30 } })
  expect((await ui.findAll({ type: 'Text' })).some(t => typeof t.props.color === 'string' && t.props.color.startsWith('#'))).toBe(false)
  expect(await ui.find({ type: 'Text', text: 'Ada' })).toBeDefined()
})

test("mod pane: run ids are unique across sessions so stored names never collide", delegating, async ($, on) => {
  resetDelegation()
  resetModPane()
  const seen = wire(on)
  mock.env(on, { HOME: "/home/user" })
  on("fs.read", () => ({ value: "" }))
  seen.runHook = async () => ({ exitCode: 0, stdout: "/bin/x", stderr: "" })
  await $.session.start({ cwd: CWD, surface: "terminal", isInteractive: true })
  await delegate($, [{ task: "Find the config" }, { task: "Find a" }])
  await jevUi($)
  const ids = Object.keys(seen.saved.get("jev.roster") as Record<string, number>)
  expect(ids).toHaveLength(2)
  for (const id of ids) expect(id).toMatch(/^[0-9a-z]{6,}-run-\d+$/)
})
