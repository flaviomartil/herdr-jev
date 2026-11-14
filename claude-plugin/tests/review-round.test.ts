import { expect, test } from 'claude-code/testing'

import { buildPrompt, CYCLE_CEILING_MS, FINAL_ROUND_MARGIN_MS, isFinalRound } from '../hooks/workers'
import type { HarnessPlan, HarnessTask } from '../types'

const task = {
  id: 't1',
  title: 'Add endpoint',
  paths: ['src/a.ts'],
  checks: ['bun test'],
} as HarnessTask

const plan = { objective: 'Ship it', at: 1000 } as HarnessPlan

test('a first reviewer round carries no previous findings and no final notice', () => {
  const prompt = buildPrompt(plan, task, 'reviewer', { report: 'done', diff: 'DIFF' })
  expect(prompt).not.toContain('previous round findings')
  expect(prompt).not.toContain('Final round')
})

test('a later reviewer round carries its own previous findings and the one by one instruction', () => {
  const prompt = buildPrompt(plan, task, 'reviewer', { report: 'done', diff: 'DIFF', previousFindings: 'F1 missing null check' })
  expect(prompt).toContain('F1 missing null check')
  expect(prompt).toContain('Verify each one by one')
  expect(prompt).toContain('REVIEW_GATE_VERDICT: APPROVE once all are resolved')
})

test('previous findings never reach an implementer through the reviewer block', () => {
  const prompt = buildPrompt(plan, task, 'implementer', { previousFindings: 'F1 missing null check' })
  expect(prompt).not.toContain('Verify each one by one')
})

test('the final round prompt carries the notice', () => {
  const prompt = buildPrompt(plan, task, 'reviewer', { diff: 'DIFF', previousFindings: 'F1', finalRound: true })
  expect(prompt).toContain('Final round')
})

test('a round is final only near the cycle ceiling', () => {
  expect(isFinalRound(plan, 1000 + CYCLE_CEILING_MS - FINAL_ROUND_MARGIN_MS - 1)).toBe(false)
  expect(isFinalRound(plan, 1000 + CYCLE_CEILING_MS - FINAL_ROUND_MARGIN_MS)).toBe(true)
  expect(isFinalRound({ ...plan, at: undefined }, 10 ** 12)).toBe(false)
})
