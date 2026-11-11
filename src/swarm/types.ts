export type SwarmTaskStatus = 'queued' | 'running' | 'done' | 'error' | 'skipped'

/** Um agente do swarm: uma subtarefa rodando num modelo do OmniRouter. Tempos em epoch ms. */
export type SwarmTask = {
  id: string
  title: string
  model: string
  dependsOn: string[]
  /** Estimativa de tokens da resposta; calibra a barra. */
  expected: number
  status: SwarmTaskStatus
  /** Cauda do texto gerado (o que o ticker mostra). */
  tail: string
  /** Total de caracteres recebidos. */
  chars: number
  tokens?: number
  attempt: number
  startedAt?: number
  endedAt?: number
  error?: string
  failures?: { model: string; why: string }[]
}

export type SwarmPhase = 'running' | 'consolidating' | 'done' | 'error' | 'cancelled'

export type SwarmRun = {
  id: string
  /** A chamada da tool que disparou o swarm: a linha da conversa onde ele é desenhado. */
  toolUseId: string
  goal: string
  phase: SwarmPhase
  createdAt: number
  agentsDoneAt?: number
  finishedAt?: number
  /** Pasta com as saídas completas, quando gravadas. */
  outDir?: string
  tasks: SwarmTask[]
}
