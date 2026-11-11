import type { SwarmRun, SwarmTask } from "./types.js"

export const TAIL_MAX = 1200


const TRIGGER = /(^|[^\p{L}\p{N}_\-/])swarm(?![\p{L}\p{N}_\-])/iu

export function swarmTrigger(text: string): { count: number | null } | null {
  if (!TRIGGER.test(text)) return null
  if (/^\s*\/?(no-?swarm|sem swarm)\b/i.test(text)) return null
  const n =
    text.match(/swarm\s*(?:x|de|com|with|of)?\s*(\d{1,2})\b/i)?.[1] ??
    text.match(/\b(\d{1,2})\s*(?:agentes|agents|workers)\b/i)?.[1]
  return { count: n ? Math.min(Math.max(parseInt(n, 10), 1), 32) : null }
}

export function orchestratorContext(count: number | null, tools: { run: string; models: string }): string {
  return `<swarm_mode>
MODO SWARM ativado pelo usuário. Você é o ORQUESTRADOR; os agentes rodam em outros modelos via OmniRouter.

1. Se ainda não fez nesta sessão, chame ${tools.models} para ver os modelos disponíveis.
2. Planeje ${count ? `exatamente ${count}` : 'de 3 a 8 (decida pelo tamanho do trabalho)'} subtarefas:
   - o mais independentes possível; use depends_on só quando uma precisa do resultado de outra (ex.: revisão depois da implementação);
   - cada prompt AUTOCONTIDO: o agente não vê esta conversa nem arquivos. Leia você mesmo o necessário e cole no prompt os trechos de código, requisitos e restrições;
   - escolha o modelo de cada subtarefa pela natureza dela: código/arquitetura → modelos fortes em código; pesquisa, resumo, rascunho → rápidos/baratos; revisão crítica → um modelo diferente do autor. Informe fallback_model quando houver alternativa boa;
   - expected_tokens realista (calibra a barra de progresso).
3. Chame ${tools.run} uma única vez com goal e tasks. O progresso aparece ao vivo na linha da tool; não narre a espera.
4. Consolide você mesmo: confira contradições e erros entre os agentes, corrija e una num resultado único. Se for código, aplique as mudanças nos arquivos você mesmo.
5. Responda ao usuário com o resultado consolidado.
Se ${tools.run} falhar por configuração (URL/token do OmniRouter), diga ao usuário como configurar (/config → OmniSwarm) e resolva a tarefa normalmente.
</swarm_mode>`
}


export const modelList = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map(m => (typeof m === 'string' ? m.trim() : '')).filter(Boolean)

export const modelChain = (model: string, taskFallbacks: unknown, globalFallbacks: string[]) => [
  ...new Set([model, ...modelList(taskFallbacks), ...globalFallbacks].filter(Boolean)),
]

export type PlanTask = {
  id: string
  title?: string
  prompt: string
  model?: string
  fallback_model?: string | string[]
  depends_on?: string[]
  expected_tokens?: number
  max_tokens?: number
  temperature?: number
}

export function validatePlan(tasks: unknown): PlanTask[] {
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('o plano precisa de ao menos 1 tarefa')
  if (tasks.length > 32) throw new Error('máximo de 32 tarefas por swarm')
  const list = tasks as PlanTask[]
  const ids = new Set<string>()
  for (const t of list) {
    if (!t || typeof t.id !== 'string' || !/^[\w.-]{1,40}$/.test(t.id)) throw new Error(`id inválido: "${t?.id}" (letras, números, _ . -)`)
    if (ids.has(t.id)) throw new Error(`id duplicado: ${t.id}`)
    ids.add(t.id)
    if (typeof t.prompt !== 'string' || !t.prompt.trim()) throw new Error(`tarefa ${t.id} sem prompt`)
  }
  for (const t of list)
    for (const d of t.depends_on ?? []) {
      if (!ids.has(d)) throw new Error(`tarefa ${t.id} depende de "${d}", que não existe`)
      if (d === t.id) throw new Error(`tarefa ${t.id} depende de si mesma`)
    }
  const indeg = new Map(list.map(t => [t.id, (t.depends_on ?? []).length]))
  const queue = list.filter(t => !(t.depends_on ?? []).length).map(t => t.id)
  let seen = 0
  while (queue.length) {
    const id = queue.shift() as string
    seen++
    for (const t of list)
      if (t.depends_on?.includes(id)) {
        indeg.set(t.id, (indeg.get(t.id) ?? 1) - 1)
        if (indeg.get(t.id) === 0) queue.push(t.id)
      }
  }
  if (seen !== list.length) throw new Error('as dependências formam um ciclo')
  return list
}

export function schedule(tasks: SwarmTask[], running: number, limit: number): { start: string[]; skip: string[] } {
  const byId = new Map(tasks.map(t => [t.id, t]))
  const start: string[] = []
  const skip: string[] = []
  let slots = limit - running
  for (const t of tasks) {
    if (t.status !== 'queued') continue
    const deps = t.dependsOn.map(d => byId.get(d))
    if (deps.some(d => !d || d.status === 'error' || d.status === 'skipped')) skip.push(t.id)
    else if (slots > 0 && deps.every(d => d?.status === 'done')) {
      start.push(t.id)
      slots--
    }
  }
  return { start, skip }
}

export function systemPrompt(goal: string, total: number, task: { id: string; title: string }): string {
  return [
    `Você é o agente "${task.id}" de um swarm com ${total} agentes, orquestrado pelo Claude.`,
    `Objetivo geral do swarm: ${goal}`,
    `Sua parte: ${task.title}.`,
    'Faça SOMENTE a sua subtarefa, de forma completa e autocontida; outro agente vai consolidar tudo.',
    'Você não tem acesso à conversa original nem a arquivos: use apenas o que está no prompt.',
    'Não peça esclarecimentos. Se faltar informação, assuma o mais razoável e declare a suposição em uma linha.',
    'Responda no mesmo idioma do objetivo, em Markdown, sem preâmbulo.',
  ].join('\n')
}

export function userPrompt(prompt: string, deps: { id: string; title: string; output: string }[], maxChars = 6000): string {
  if (!deps.length) return prompt
  let p = `${prompt}\n\n---\n## Resultados de tarefas anteriores (use como insumo)\n`
  for (const d of deps) {
    const out = d.output || '(sem saída)'
    p += `\n### [${d.id}] ${d.title}\n${out.length > maxChars ? `${out.slice(0, maxChars)}\n…(truncado)` : out}\n`
  }
  return p
}


export type StreamEvent = { kind: 'text'; text: string } | { kind: 'usage'; tokens: number } | { kind: 'error'; message: string }

export const STATUS_MARK = '\n__OMNISWARM_HTTP__'

export const retryAfterSeconds = (v: string): number | undefined => {
  const n = Number(v.trim())
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export function createSseParser() {
  let buf = ''
  let raw = ''
  let sawSse = false
  let status: number | null = null
  let retryAfter: number | undefined

  const parseLine = (line: string, out: StreamEvent[]) => {
    const l = line.trim()
    if (!l.startsWith('data:')) return
    sawSse = true
    const data = l.slice(5).trim()
    if (!data || data === '[DONE]') return
    let j: any
    try {
      j = JSON.parse(data)
    } catch {
      return
    }
    if (j.error) {
      out.push({ kind: 'error', message: String(j.error.message ?? JSON.stringify(j.error)) })
      return
    }
    const delta = j.choices?.[0]?.delta ?? {}
    if (typeof delta.content === 'string' && delta.content) out.push({ kind: 'text', text: delta.content })
    if (j.usage?.completion_tokens) out.push({ kind: 'usage', tokens: j.usage.completion_tokens })
  }

  return {
    push(chunk: string): StreamEvent[] {
      const out: StreamEvent[] = []
      buf += chunk
      if (raw.length < 200_000) raw += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line.startsWith('__OMNISWARM_HTTP__')) status = Number(line.slice(18)) || 0
        else if (line.startsWith('__OMNISWARM_RETRY__')) retryAfter = retryAfterSeconds(line.slice(19))
        else parseLine(line, out)
      }
      return out
    },
    end(): { status: number | null; retryAfter?: number; events: StreamEvent[] } {
      const out: StreamEvent[] = []
      const rest = buf
      buf = ''
      const m = rest.match(/__OMNISWARM_HTTP__(\d+)/)
      const r = rest.match(/__OMNISWARM_RETRY__(\S*)/)
      if (r) retryAfter = retryAfterSeconds(r[1])
      if (m) status = Number(m[1])
      else if (rest.trim()) parseLine(rest, out)
      const body = raw.split(STATUS_MARK)[0] ?? ''
      if (status !== null && status >= 400) {
        out.push({ kind: 'error', message: `HTTP ${status}: ${errorText(body)}` })
      } else if (!sawSse && body.trim()) {
        out.push(...parseJsonCompletion(body))
      }
      return { status, retryAfter, events: out }
    },
  }
}

export function errorText(body: string): string {
  try {
    const j = JSON.parse(body)
    return String(j.error?.message ?? j.message ?? body).slice(0, 300)
  } catch {
    return body.trim().slice(0, 300) || '(sem corpo)'
  }
}

export function parseJsonCompletion(body: string): StreamEvent[] {
  try {
    const j = JSON.parse(body)
    if (j.error) return [{ kind: 'error', message: String(j.error.message ?? JSON.stringify(j.error)) }]
    const text = j.choices?.[0]?.message?.content
    const out: StreamEvent[] = []
    if (typeof text === 'string' && text) out.push({ kind: 'text', text })
    if (j.usage?.completion_tokens) out.push({ kind: 'usage', tokens: j.usage.completion_tokens })
    return out
  } catch {
    return [{ kind: 'error', message: `resposta inesperada: ${body.trim().slice(0, 200)}` }]
  }
}

export const curlQuote = (s: string) =>
  `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`

export function curlConfig(url: string, apiKey: string, body: string): string {
  const lines = [
    `url = ${curlQuote(url)}`,
    `header = ${curlQuote('Content-Type: application/json')}`,
    `header = ${curlQuote('Accept: text/event-stream')}`,
  ]
  if (apiKey) lines.push(`header = ${curlQuote(`Authorization: Bearer ${apiKey}`)}`)
  lines.push(`data-raw = ${curlQuote(body)}`)
  return lines.join('\n') + '\n'
}


const SOFT_FAILURE =
  /no longer available|(no|insufficient|out of) (credits?|balance|quota)|quota (exceeded|exhausted)|exceeded (your )?(current )?quota|rate[ -]?limit(ed| exceeded| reached)?|too many requests|model (is |has been )?(deprecated|discontinued)/i

const LOGGED_OUT =
  /^((please\s+)?(sign\s*(up|in)|log\s*in)(\s+(again|first))?(\s+(and|to)\s+(repeat|continue|retry|try|send|proceed)\b[^.!?]{0,40})?|you\s+are\s+not\s+logged\s+in|unauthorized)\s*[.!]?$/i

export function softFailure(text: string, maxLen = 600, promptChars?: number): string | null {
  const t = text.trim()
  if (!t || t.length > maxLen) return null
  if (t.length <= 120 && LOGGED_OUT.test(t) && (promptChars === undefined || promptChars > 200)) return `provider logged out: ${t}`
  return SOFT_FAILURE.test(t) ? `aviso do gateway: ${t.replace(/\s+/g, ' ').slice(0, 160)}` : null
}

const retryAfterMs = (s: number | undefined, fallback: number) => (s === undefined ? fallback : Math.min(s, 10) * 1000)

export function retryDelay(error: string, retryAfter?: number): number | null {
  if (/\bHTTP 429\b|too many requests|rate[ -]?limit/i.test(error)) return retryAfterMs(retryAfter, 3000)
  if (/\bHTTP 503\b|no server is available/i.test(error)) return retryAfterMs(retryAfter, 1500)
  return null
}

const MODEL_GONE =
  /unknown model|invalid model|determine provider|model.{0,40}(not found|does not exist|not exist|unavailable|no longer available|not supported)|quota|insufficient|credits?\b|balance|exhausted|context (length|window)|maximum context|too many tokens|rate[ -]?limit|too many requests|no server is available/i
const PROVIDER_DOWN = /credential|not configured/i

export function fallbackWorthy(error: string): boolean {
  const http = error.match(/^HTTP (\d{3})\b/)
  if (http) {
    const code = Number(http[1])
    if (code === 401 || code === 403) return /provider/i.test(error) && PROVIDER_DOWN.test(error)
    if (code === 402 || code === 408 || code === 429 || code >= 500) return true
    return MODEL_GONE.test(error)
  }
  return !/^curl (6|7|35):/.test(error) && error !== 'cancelado'
}

export const deadModelReason = (why: string): boolean => {
  if (/^(provider logged out|aviso do gateway)/.test(why)) return true
  const http = why.match(/^HTTP (\d{3})\b/)
  if (!http) return false
  const code = Number(http[1])
  return code === 429 || code === 503 || ([400, 401, 402, 403, 404, 422].includes(code) && fallbackWorthy(why))
}

const CP1252: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88,
  0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93,
  0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
}

export function fixMojibake(s: string): string {
  if (!/Ã[ -¿]|â€/.test(s)) return s
  const bytes = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    const b = c <= 0xff ? c : CP1252[c]
    if (b === undefined) return s
    bytes[i] = b
  }
  const out = new TextDecoder('utf-8').decode(bytes)
  return out.includes('�') && !s.includes('�') ? s : out
}


export const clean = (s: string) =>
  s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b[\]P^_][\s\S]*?(\x07|\x1b\\)/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')

export const appendTail = (tail: string, text: string) => {
  const t = tail + clean(text)
  return t.length > TAIL_MAX ? t.slice(t.length - TAIL_MAX) : t
}

export function tickerLines(tail: string, width: number, lines: number): string[] {
  const flat = tail.replace(/\s+/g, ' ').trimStart()
  if (!flat.trim()) return []
  const w = Math.max(10, width)
  const window = flat.length > w * (lines + 2) ? flat.slice(flat.indexOf(' ', flat.length - w * (lines + 2)) + 1) : flat
  const out: string[] = []
  let line = ''
  for (const word of window.split(' ')) {
    let wd = word
    while (wd.length > w) {
      if (line) out.push(line), (line = '')
      out.push(wd.slice(0, w))
      wd = wd.slice(w)
    }
    if (!line) line = wd
    else if (line.length + 1 + wd.length <= w) line += ` ${wd}`
    else out.push(line), (line = wd)
  }
  out.push(line)
  return out.slice(-lines)
}

export function taskProgress(t: SwarmTask): number {
  if (t.status === 'done' || t.status === 'error' || t.status === 'skipped') return 1
  if (t.status !== 'running') return 0
  return Math.min(0.95, 0.03 + (t.chars / (Math.max(50, t.expected) * 4)) * 0.92)
}

export function runProgress(r: SwarmRun, now: number): number {
  if (r.phase === 'done') return 1
  if (r.phase === 'error' || r.phase === 'cancelled') return r.tasks.reduce((s, t) => s + taskProgress(t), 0) / r.tasks.length
  const agents = r.tasks.reduce((s, t) => s + taskProgress(t), 0) / r.tasks.length
  if (r.phase === 'consolidating') {
    const since = (now - (r.agentsDoneAt ?? now)) / 1000
    return 0.9 + 0.08 * (1 - Math.exp(-since / 25))
  }
  return agents * 0.9
}

const BLOCKS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
export function bar(p: number, width: number): { fill: string; rest: string } {
  const w = Math.max(4, width)
  const cells = Math.max(0, Math.min(1, p)) * w
  const full = Math.floor(cells)
  const part = BLOCKS[Math.floor((cells - full) * 8)] ?? ''
  const fill = '█'.repeat(full) + part
  return { fill, rest: '░'.repeat(Math.max(0, w - full - (part ? 1 : 0))) }
}

export const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

export function counts(r: SwarmRun) {
  const done = r.tasks.filter(t => t.status === 'done').length
  const failed = r.tasks.filter(t => t.status === 'error' || t.status === 'skipped').length
  const running = r.tasks.filter(t => t.status === 'running').length
  const tokens = r.tasks.reduce((s, t) => s + (t.tokens ?? Math.round(t.chars / 4)), 0)
  return { done, failed, running, tokens }
}

export const PHASE_LABEL: Record<SwarmRun['phase'], string> = {
  running: 'executando',
  consolidating: 'consolidando',
  done: 'concluído',
  error: 'falhou',
  cancelled: 'cancelado',
}


export function report(run: SwarmRun, outputs: Map<string, string>, maxChars: number): string {
  const c = counts(run)
  const lines = [
    `run_id: ${run.id}`,
    `status: ${run.phase === 'running' ? 'running' : c.done ? 'agents_done' : 'failed'} (${c.done}/${run.tasks.length} agentes concluídos)`,
  ]
  if (run.outDir) lines.push(`saídas completas: ${run.outDir}`)
  for (const t of run.tasks) {
    const secs = t.startedAt && t.endedAt ? ` | ${((t.endedAt - t.startedAt) / 1000).toFixed(1)}s` : ''
    lines.push('', `## [${t.id}] ${t.title}`, `modelo: ${t.model} | status: ${t.status}${secs}${t.tokens ? ` | ${t.tokens} tokens` : ''}`)
    if (t.failures?.length) lines.push(`falhas: ${t.failures.map(f => `${f.model} (${f.why})`).join('; ')}`)
    if (t.status !== 'done') {
      lines.push(`erro: ${t.error ?? t.status}`)
      continue
    }
    const out = outputs.get(t.id) ?? ''
    lines.push(out.length > maxChars ? `${out.slice(0, maxChars)}\n\n…(truncado em ${maxChars} de ${out.length} caracteres${run.outDir ? '; leia o arquivo para o texto completo' : ''})` : out)
  }
  lines.push('', '---', 'Próximo passo: consolide os resultados (corrija contradições, una num resultado único) e responda ao usuário.')
  return lines.join('\n')
}


export function thin(p: number, width: number): { fill: string; rest: string } {
  const w = Math.max(4, width)
  const cells = Math.max(0, Math.min(1, p)) * w
  const full = Math.floor(cells)
  const half = cells - full >= 0.5 && full < w
  return { fill: '━'.repeat(full) + (half ? '╸' : ''), rest: '─'.repeat(Math.max(0, w - full - (half ? 1 : 0))) }
}

export const plain = (s: string) =>
  s
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*([-*+]|\d+\.)\s+/gm, '')
    .replace(/\*\*|__|`|~~|^>\s?/gm, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()

export function dur(ms: number): string {
  const s = ms / 1000
  if (s < 10) return `${s.toFixed(1)}s`
  if (s < 60) return `${Math.round(s)}s`
  return `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`
}

export function slideLine(flow: string, width: number): string {
  const w = Math.max(10, width)
  if (flow.length <= w) return flow
  const cut = flow.slice(-(w - 1))
  const sp = cut.indexOf(' ')
  return `…${sp > 0 && sp < 12 ? cut.slice(sp + 1) : cut}`
}
