import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { resetProxies, summarize } from '../hooks/proxies'
import { wire } from './support'

const opts = { options: { proxies: true } }
const start = ($: Engine) => $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive: true })
const results = { results: [{ id: 'alpha', healthy: false, action: 'restart', restarted: true, recovered: true }] }

test('proxies: summarize reports down ids and restart toasts', () => {
  const out = summarize([
    { id: 'a', healthy: false, action: 'warn', command: 'systemctl --user restart a' },
    { id: 'b', healthy: false, action: 'restart', restarted: true, recovered: true },
    { id: 'c', healthy: true, action: 'none' },
  ])
  expect(out.note).toBe('proxy down: a')
  expect(out.toasts).toEqual(['proxy a down, run: systemctl --user restart a', 'proxy b restarted'])
})

test('proxies: off by default never runs the check', async ($, on) => {
  resetProxies()
  const seen = wire(on)
  await start($)
  expect(seen.runs.some(argv => argv[1] === 'proxies')).toBe(false)
})

test('proxies: enabled runs check --repair at start and toasts a restart', opts, async ($, on) => {
  resetProxies()
  const seen = wire(on)
  seen.runHook = async argv => (argv[1] === 'proxies' ? { exitCode: 1, stdout: JSON.stringify(results), stderr: '' } : undefined)
  await start($)
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(seen.runs.find(argv => argv[1] === 'proxies')).toEqual(['herdr-jev', 'proxies', 'check', '--repair', '--json'])
  expect(seen.toasts.some(text => text.includes('proxy alpha restarted'))).toBe(true)
})

test('proxies: inactive unit with no action is not shown as down', () => {
  const out = summarize([{ id: 'o', healthy: false, action: 'none', activeState: 'inactive' }])
  expect(out.note).toBe('')
})
