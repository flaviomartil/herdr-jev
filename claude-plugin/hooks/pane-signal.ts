export type Signal = 'running' | 'waiting' | 'slow' | 'quiet' | 'done' | 'failed' | 'gone'

export type SignalInput = {
  end: 'done' | 'failed' | null
  gone: boolean
  waiting: boolean
  idleMs: number
}

export const SLOW_MS = 30_000
export const QUIET_MS = 120_000

export type SignalView = {
  glyph: string
  color: string
  word: string
  needsAttention: boolean
  toast: ((label: string) => string) | null
}

export const SIGNAL_VIEW: Record<Signal, SignalView> = {
  running: { glyph: '●', color: 'success', word: 'trabalhando', needsAttention: false, toast: null },
  waiting: { glyph: '!', color: 'warning', word: 'aguarda aprovacao', needsAttention: true, toast: label => `${label} aguarda aprovacao` },
  slow: { glyph: '…', color: 'warning', word: 'lento', needsAttention: true, toast: label => `${label} esta lento` },
  quiet: { glyph: 'z', color: 'inactive', word: 'quieto', needsAttention: true, toast: label => `${label} quieto ha mais de 2 min` },
  done: { glyph: '✓', color: 'success', word: 'pronto', needsAttention: false, toast: null },
  failed: { glyph: '✗', color: 'error', word: 'falhou', needsAttention: true, toast: label => `${label} falhou` },
  gone: { glyph: '○', color: 'inactive', word: 'sumiu', needsAttention: true, toast: label => `${label} sumiu da lista de agentes` },
}

export function classifySignal(input: SignalInput): Signal {
  if (input.end !== null) return input.end
  if (input.gone) return 'gone'
  if (input.waiting) return 'waiting'
  if (input.idleMs > QUIET_MS) return 'quiet'
  if (input.idleMs > SLOW_MS) return 'slow'
  return 'running'
}
