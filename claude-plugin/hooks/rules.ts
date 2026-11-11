import type { EngineInterface, On, PluginOptions } from 'claude-code'
import { commitFiles, createEvaluator, failureVerdict, mergeRules, parseRules, pushNeedsBranch, writtenPaths } from './rules-core'
import type { Evaluator } from './rules-core'
import { DEFAULT_RULES } from './rules-data'

const TOOLS = ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const
const LOCAL_FILE = '.config/jev/rules.local.yml'

export const rulesEnabled = (options: PluginOptions): boolean => options.rules !== false

async function attempt<T>(run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run()
  } catch {
    return undefined
  }
}

async function realOf($: EngineInterface, path: string): Promise<string | undefined> {
  const hit = await attempt(() => $.fs.stat(path, { resolve: true }))
  if (hit?.realPath !== undefined) return hit.realPath
  const cut = path.lastIndexOf('/')
  if (cut <= 0) return undefined
  const parent = await attempt(() => $.fs.stat(path.slice(0, cut), { resolve: true }))
  return parent?.realPath === undefined ? undefined : `${parent.realPath}${path.slice(cut)}`
}

async function readText($: EngineInterface, path: string): Promise<string | null> {
  try {
    return await $.fs.read(path)
  } catch {
    return null
  }
}

let loaded: Promise<Evaluator> | null = null
let sessionId: Promise<string> | null = null
const held = new Map<string, string>()

function evaluator($: EngineInterface): Promise<Evaluator> {
  loaded ??= (async () => {
    const home = await attempt(() => $.env.get('HOME'))
    const base = parseRules(DEFAULT_RULES)
    const text = home === undefined ? null : await readText($, `${home}/${LOCAL_FILE}`)
    let config = base
    if (text !== null) {
      try {
        config = mergeRules(base, parseRules(text))
      } catch {
        return { evaluate: failureVerdict }
      }
    }
    return createEvaluator(config)
  })()
  return loaded
}

function session($: EngineInterface): Promise<string> {
  sessionId ??= attempt(() => $.session.id()).then(id => id ?? 'default')
  return sessionId
}

export async function rulesPromptContext($: EngineInterface, origin: string | undefined, options: PluginOptions): Promise<string[]> {
  if (!rulesEnabled(options) || origin === 'plugin') return []
  try {
    const verdict = (await evaluator($)).evaluate({ type: 'prompt', sessionId: await session($) })
    return verdict.decision === 'allow' ? (verdict.context ?? []) : []
  } catch {
    return []
  }
}

export function registerRules(on: On, options: PluginOptions): void {
  for (const tool of TOOLS) {
    on('tool.call', { tool }, async ($, e, next) => {
      if (!rulesEnabled(options)) return next(e)
      const input = e as unknown as Record<string, unknown>
      const cwd = await attempt(() => $.session.cwd())
      const home = await attempt(() => $.env.get('HOME'))
      const files: Record<string, string> = {}
      const unreadable: string[] = []
      const realPaths: Record<string, string> = {}
      let branch: string | undefined
      let isNew: boolean | undefined
      if (tool === 'Bash' && typeof input.command === 'string') {
        for (const file of commitFiles(input.command)) {
          const text = await readText($, file.startsWith('/') ? file : `${cwd}/${file}`)
          if (text === null) unreadable.push(file)
          else files[file] = text
        }
        if (pushNeedsBranch(input.command)) {
          const run = await attempt(() => $.process.run(['git', 'symbolic-ref', '--short', 'HEAD'], { cwd, timeoutMs: 1000 }))
          if (run !== undefined && run.exitCode === 0) branch = run.stdout.trim()
        }
      }
      for (const path of writtenPaths(tool, input)) {
        const abs = path.startsWith('/') ? path : `${cwd ?? ''}/${path}`
        const real = await realOf($, abs)
        if (real !== undefined) realPaths[path] = real
      }
      if (tool === 'Write') {
        const [path] = writtenPaths(tool, input)
        if (path !== undefined) {
          try {
            isNew = !(await $.fs.exists(path.startsWith('/') ? path : `${cwd}/${path}`))
          } catch {
            isNew = undefined
          }
        }
      }
      const verdict = (await evaluator($)).evaluate({ type: 'tool', tool, input, cwd, home, files, unreadable, realPaths, branch, isNew })
      if (verdict.decision === 'deny') return { deny: `harness rules: ${verdict.reason}` }
      if (verdict.decision === 'ask') {
        const id = e.tool_use_id
        if (id !== undefined) held.set(id, `harness rules: ${verdict.reason}`)
        try {
          return await next(e)
        } finally {
          if (id !== undefined) held.delete(id)
        }
      }
      if (verdict.decision === 'warn') {
        const ran = await next(e)
        if (ran.deny !== undefined) return ran
        return { ...ran, context: [...(ran.context ?? []), `harness rules: ${verdict.reason}`] } as typeof ran
      }
      return next(e)
    }).catch(($, e, next) => {
      if (next.called) return next(e)
      const failed = failureVerdict({ type: 'tool', tool, input: e as unknown as Record<string, unknown> })
      return failed.decision === 'deny' ? { deny: `harness rules: ${failed.reason}` } : next(e)
    })

    on('tool.check', { tool }, async ($, e, next) => {
      const id = e.tool_use_id
      const reason = id === undefined ? undefined : held.get(id)
      const verdict = await next(e)
      return reason === undefined || verdict.decision !== 'allow' ? verdict : { decision: 'ask', reason }
    }).catch(($, e, next) => next(e))
  }
}
