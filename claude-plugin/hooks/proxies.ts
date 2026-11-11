import type { EngineInterface, PluginOptions } from 'claude-code'
import { cliConfig, runJson } from './cli'

const CHECK_EVERY_MS = 30_000
const CHECK_TIMEOUT_MS = 90_000

type Row = { id: string; healthy: boolean; action: string; restarted?: boolean; recovered?: boolean; command?: string }

let note = ''
let running = false

export const proxiesEnabled = (options: PluginOptions): boolean => options.proxies === true

export const proxyNote = (): string => note

export function resetProxies(): void {
  note = ''
  running = false
}

export function summarize(rows: readonly Row[]): { note: string; toasts: string[] } {
  const down = rows.filter(row => !row.healthy && row.recovered !== true)
  const toasts: string[] = []
  for (const row of rows) {
    if (row.restarted === true) toasts.push(`proxy ${row.id} restarted${row.recovered === true ? '' : ', still down'}`)
    else if (row.action === 'warn' && !row.healthy) toasts.push(row.command ? `proxy ${row.id} down, run: ${row.command}` : `proxy ${row.id} down`)
  }
  return { note: down.length === 0 ? '' : `proxy down: ${down.map(row => row.id).join(', ')}`, toasts }
}

export async function startProxies($: EngineInterface, options: PluginOptions, cwd: string, isInteractive: boolean): Promise<void> {
  if (!proxiesEnabled(options) || !isInteractive) return
  const config = cliConfig(options, cwd)
  const tick = async () => {
    if (running) return
    running = true
    try {
      const ran = await runJson(
        (argv, init) => $.process.run(argv, init),
        config,
        ['proxies', 'check', '--repair', '--json'],
        CHECK_TIMEOUT_MS,
      )
      const raw = ran.ok && typeof ran.value === 'object' && ran.value !== null ? (ran.value as { results?: unknown }).results : undefined
      if (!Array.isArray(raw)) return
      const out = summarize(raw as Row[])
      note = out.note
      for (const text of out.toasts) $.ui.toast(text.slice(0, 200), { timeoutMs: 10000 })
    } catch {
      return
    } finally {
      running = false
    }
  }
  void tick()
  $.clock.every(CHECK_EVERY_MS, () => {
    void tick()
  })
}
