import { expect, test } from "bun:test"

import { bar, createSseParser, curlConfig, deadModelReason, fallbackWorthy, fixMojibake, modelChain, retryDelay, slideLine, softFailure, swarmTrigger, tickerLines, validatePlan } from "../src/swarm/model.js"

test('a palavra swarm liga o modo; variações de código não', async () => {
  expect(swarmTrigger('Swarm 5: refatora o módulo de auth')).toEqual({ count: 5 })
  expect(swarmTrigger('usa o swarm com 4 agentes pra revisar')).toEqual({ count: 4 })
  expect(swarmTrigger('swarm: revisa a segurança')).toEqual({ count: null })
  expect(swarmTrigger('atualiza o swarm-mod')).toBe(null)
  expect(swarmTrigger('chama mcp__omniswarm__run')).toBe(null)
  expect(swarmTrigger('olá, tudo bem?')).toBe(null)
})

test('plano: ids, dependências e ciclos', async () => {
  expect(() => validatePlan([])).toThrow()
  expect(() => validatePlan([{ id: 'a', prompt: 'x', depends_on: ['b'] }, { id: 'b', prompt: 'y', depends_on: ['a'] }])).toThrow(/ciclo/)
  expect(() => validatePlan([{ id: 'a', prompt: 'x', depends_on: ['z'] }])).toThrow(/não existe/)
  expect(validatePlan([{ id: 'a', prompt: 'x' }, { id: 'b', prompt: 'y', depends_on: ['a'] }]).length).toBe(2)
})

test('parser SSE: texto em pedaços, usage e status HTTP do curl', async () => {
  const p = createSseParser()
  const a = p.push('data: {"choices":[{"delta":{"content":"Olá"}}]}\n\ndata: {"choices":[{"de')
  const b = p.push('lta":{"content":" mundo"}}]}\n\ndata: {"choices":[],"usage":{"completion_tokens":7}}\n\ndata: [DONE]\n\n')
  const c = p.push('\n__OMNISWARM_HTTP__200\n')
  const end = p.end()
  expect(a).toEqual([{ kind: 'text', text: 'Olá' }])
  expect(b).toEqual([{ kind: 'text', text: ' mundo' }, { kind: 'usage', tokens: 7 }])
  expect(c).toEqual([])
  expect(end).toEqual({ status: 200, events: [] })

  const e = createSseParser()
  e.push('{"error":{"message":"modelo x indisponível"}}\n__OMNISWARM_HTTP__500\n')
  expect(e.end().events).toEqual([{ kind: 'error', message: 'HTTP 500: modelo x indisponível' }])

  const j = createSseParser()
  j.push('{"choices":[{"message":{"content":"sem stream"}}]}\n__OMNISWARM_HTTP__200\n')
  expect(j.end().events).toEqual([{ kind: 'text', text: 'sem stream' }])
})

test('config do curl: token só no stdin, aspas escapadas', async () => {
  const c = curlConfig('http://x/v1/chat/completions', 'sk-1', '{"a":"b\\"c"}')
  expect(c).toContain('header = "Authorization: Bearer sk-1"')
  expect(c).toContain('data-raw = "{\\"a\\":\\"b\\\\\\"c\\"}"')
})

test('ticker mostra o fim do texto em linhas da largura pedida', async () => {
  const lines = tickerLines('um dois tres quatro cinco seis sete oito nove dez', 12, 2)
  // quebra por palavra: a última linha é a que está crescendo
  expect(lines).toEqual(['oito nove', 'dez'])
  expect(tickerLines('x'.repeat(30), 12, 3).every(l => l.length <= 12)).toBe(true)
  expect(bar(0.5, 10).fill).toBe('█████')
  expect(bar(1, 10).rest).toBe('')
})

test('ticker de uma linha rola: sempre cheio, com reticências à esquerda', async () => {
  expect(slideLine('curto', 20)).toBe('curto')
  const l = slideLine('um dois tres quatro cinco seis sete oito nove dez onze', 20)
  expect(l.startsWith('…')).toBe(true)
  expect(l.endsWith('dez onze')).toBe(true)
  expect(l.length).toBeLessThanOrEqual(20)
})

test('aviso curto com HTTP 200 conta como falha; resposta longa não', async () => {
  expect(softFailure('The model claude-opus-4-6-thinking is no longer available.')).toContain('no longer available')
  expect(softFailure('Error: quota exceeded for this account')).not.toBe(null)
  expect(softFailure('No credits remaining')).not.toBe(null)
  expect(softFailure('OK')).toBe(null)
  expect(softFailure(`${'texto normal '.repeat(80)} rate limit`)).toBe(null)
})

test('repete uma vez só em 503 e 429', async () => {
  expect(retryDelay('HTTP 503: No server is available to handle this request')).toBe(1500)
  expect(retryDelay('HTTP 429: too many requests')).toBe(3000)
  expect(retryDelay('HTTP 401: unauthorized')).toBe(null)
})

test('cadeia de modelos: tarefa, reservas da tarefa e globais, sem repetir', async () => {
  expect(modelChain('a', 'b, c', ['c', 'auto'])).toEqual(['a', 'b', 'c', 'auto'])
  expect(modelChain('a', ['b'], [])).toEqual(['a', 'b'])
  expect(modelChain('a', undefined, ['a'])).toEqual(['a'])
})

test('acento corrompido volta a UTF-8; texto correto fica igual', async () => {
  expect(fixMojibake('configuraÃ§Ã£o Ã© vÃ¡lida')).toBe('configuração é válida')
  expect(fixMojibake('travessÃ£o â€” aqui')).toBe('travessão — aqui')
  expect(fixMojibake('configuração já certa')).toBe('configuração já certa')
  expect(fixMojibake('Ã§ misturado com ç')).toBe('Ã§ misturado com ç')
})

test('só troca de modelo quando a falha depende do modelo ou da capacidade', () => {
  for (const e of [
    'HTTP 503: No server is available to handle this request',
    'HTTP 502: bad gateway',
    'HTTP 504: gateway timeout',
    'HTTP 429: too many requests',
    'HTTP 402: insufficient credits',
    "HTTP 400: Unable to determine provider for model 'no-such-model'",
    "HTTP 404: The model 'gone' does not exist",
    'HTTP 400: maximum context length exceeded',
    'HTTP 401: No active credentials for provider: openai.',
    'curl 28: timeout',
    'aviso do gateway: This model is no longer available',
    'resposta vazia',
  ]) expect(fallbackWorthy(e)).toBe(true)
  for (const e of [
    'HTTP 401: invalid api key',
    'HTTP 403: forbidden',
    'HTTP 400: Missing model',
    'HTTP 404: Not Found',
    'curl 7: não conectou',
    'cancelado',
  ]) expect(fallbackWorthy(e)).toBe(false)
})

test('Retry-After do gateway vale no lugar do backoff padrão, com teto de 10 s', () => {
  expect(retryDelay('HTTP 503: x', 2)).toBe(2000)
  expect(retryDelay('HTTP 429: x', 60)).toBe(10000)
  expect(retryDelay('HTTP 429: x')).toBe(3000)
  expect(retryDelay('HTTP 401: x', 2)).toBe(null)
})

test('parser lê o Retry-After que o curl imprime no fim, e ignora quando não vem', () => {
  const busy = createSseParser()
  busy.push('{"error":{"message":"busy"}}\n__OMNISWARM_HTTP__503\n__OMNISWARM_RETRY__2\n')
  expect(busy.end()).toMatchObject({ status: 503, retryAfter: 2 })
  const sem = createSseParser()
  sem.push('__OMNISWARM_HTTP__503\n__OMNISWARM_RETRY__%header{retry-after}\n')
  expect(sem.end().retryAfter).toBe(undefined)
})

test('resposta de provedor deslogado vira falha; "sign up" no meio de resposta normal não', () => {
  expect(softFailure('Sign up and repeat your request.')).toBe('provider logged out: Sign up and repeat your request.')
  expect(softFailure('Please log in to continue.')).toBe('provider logged out: Please log in to continue.')
  expect(softFailure('please log in')).toBe('provider logged out: please log in')
  expect(softFailure('Para continuar, faça sign up no portal e repita o pedido.')).toBe(null)
  expect(softFailure('Sign up and repeat your request to get a discount on this great item.')).toBe(null)
})

test('logged-out exige prompt longo; "Sign in" de rótulo continua sucesso; variantes de login e Unauthorized', () => {
  expect(softFailure('Sign in', 600, 'write the login button label'.length)).toBe(null)
  expect(softFailure('Sign in', 600, 400)).toBe('provider logged out: Sign in')
  expect(softFailure('You are not logged in.')).toBe('provider logged out: You are not logged in.')
  expect(softFailure('Please log in again')).toBe('provider logged out: Please log in again')
  expect(softFailure('Unauthorized')).toBe('provider logged out: Unauthorized')
  expect(softFailure('Unauthorized access to the admin panel is a crime, so never share your credentials with others.')).toBe(null)
})

test('motivo de modelo morto: fora do ar, sem credencial, 503 depois do retry; timeout e resposta vazia não', () => {
  expect(deadModelReason('provider logged out: Sign up and repeat your request.')).toBe(true)
  expect(deadModelReason("HTTP 400: Unable to determine provider for model 'no-such-model'")).toBe(true)
  expect(deadModelReason('HTTP 401: No active credentials for provider: openai.')).toBe(true)
  expect(deadModelReason('HTTP 503: No server is available')).toBe(true)
  expect(deadModelReason('aviso do gateway: This model is no longer available')).toBe(true)
  expect(deadModelReason('HTTP 401: invalid api key')).toBe(false)
  expect(deadModelReason('HTTP 500: internal error')).toBe(false)
  expect(deadModelReason('Claude Web stream protocol error')).toBe(false)
  expect(deadModelReason('curl 28: timeout')).toBe(false)
  expect(deadModelReason('resposta vazia')).toBe(false)
})
