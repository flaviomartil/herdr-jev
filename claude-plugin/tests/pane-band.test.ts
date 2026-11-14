import { expect, test } from 'claude-code/testing'

import { bandText } from '../hooks/pane-rows'
import type { CrewModel, CrewRow } from '../hooks/pane-rows'

const NOW = 1_000_000

const row = (name: string, signal: CrewRow['signal'], ageSeconds = 0): CrewRow =>
  ({ id: name, name, signal, act: { startedAt: NOW - ageSeconds * 1000, updatedAt: NOW, endedAt: null, end: null } }) as unknown as CrewRow

const model = (rows: CrewRow[]): CrewModel => ({ hub: null, rows, pageRows: rows, page: 0, pages: 1, unknown: [] })

test('the band is hidden with no agents', () => {
  expect(bandText(model([]), NOW)).toBeNull()
})

test('the band is hidden when every agent is done and none failed', () => {
  expect(bandText(model([row('api', 'done'), row('ui', 'done')]), NOW)).toBeNull()
})

test('one active agent shows its count and age', () => {
  expect(bandText(model([row('api', 'running', 40)]), NOW)).toBe('● 1 ativo · api 40s')
})

test('three active agents show the count and the two longest running', () => {
  const rows = [row('db', 'running', 5), row('api', 'running', 40), row('ui', 'slow', 120)]
  expect(bandText(model(rows), NOW)).toBe('● 3 ativos · ui 2m · api 40s')
})

test('failures come first and active agents are only counted', () => {
  const rows = [row('api', 'running', 40), row('ui', 'running', 10), row('db', 'failed')]
  expect(bandText(model(rows), NOW)).toBe('✗ 1 falhou · ● 2 ativos')
})

test('more than five done agents collapse into a count', () => {
  const done = ['a', 'b', 'c', 'd', 'e', 'f'].map(name => row(name, 'done'))
  expect(bandText(model([row('api', 'running', 40), ...done]), NOW)).toBe('● 1 ativo · api 40s · 6 concluídos')
})

test('up to five done agents are listed by name', () => {
  const done = ['a', 'b'].map(name => row(name, 'done'))
  expect(bandText(model([row('api', 'running', 40), ...done]), NOW)).toBe('● 1 ativo · api 40s · ✓ a · ✓ b')
})
