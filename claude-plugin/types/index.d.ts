export type HarnessRole = 'advisor' | 'implementer' | 'reviewer' | 'reader'

export type HarnessModelRole = 'advisor' | 'implementer' | 'reviewer' | 'researcher' | 'reader'

export type HarnessTaskState =
  | 'proposed'
  | 'advisor'
  | 'running'
  | 'review'
  | 'approved'
  | 'verified'
  | 'failed'
  | 'needs_you'
  | 'done'

export type HarnessVerdict = 'APPROVE' | 'CHANGES_REQUIRED'

export type HarnessRoleModel = {
  model: string
  cliModel: string
  effort: string
  readonly: boolean
  fallbackActive: boolean
}

export type HarnessRoleTable = Partial<Record<HarnessModelRole, HarnessRoleModel>>

export type HarnessTask = {
  id: string
  title: string
  role: HarnessRole
  writes: boolean
  model: string | null
  effort: string | null
  reason: string
  deps: string[]
  paths: string[]
  checks: string[]
  state: HarnessTaskState
  review: boolean
  reviewModel: string | null
  reviewStarting?: boolean
  agentId?: string
  reviewAgentId?: string
  verdict?: HarnessVerdict
  startedAt?: number
  endedAt?: number
  lastTool?: string
  toolCount: number
  note?: string
  report?: string
  reviewReport?: string
}

export type HarnessPlan = {
  objective: string
  advisorModel: string
  roles: HarnessRoleTable
  tasks: HarnessTask[]
  at?: number
}

export type HarnessWorkerRow = {
  taskId: string
  agentId: string
  role: HarnessRole
  writes: boolean
  model: string | null
  lastTool: string | null
  toolCount: number
  startedAt: number
}

export type HarnessHumanAsk = {
  id: string
  taskId: string
  question: string
  at: number
}

export type HarnessReview = {
  ok: boolean
  status: string | null
  detail: string | null
  reason: string | null
  isTimedOut?: boolean
  at: number
}

export type HarnessReviewIdentity = {
  client: string
  session: string
  at: number
  status: string | null
}

export type ScopeState = {
  status: 'pending' | 'ready' | 'partial'
  selected: string[]
  clis: string[]
  turn: string[]
  invoked: string[]
  query: string
  total: number | null
  note: string | null
}

export type ClaimKind = 'test' | 'lint' | 'build' | 'ci' | 'verified'

export type ClaimCheck = 'test' | 'lint' | 'build' | 'ci' | 'push'

export type ClaimEntry =
  | { seq: number; type: 'edit'; path: string; agentId?: string }
  | { seq: number; type: 'run'; checks: ClaimCheck[]; command: string; isOk: boolean; isInterrupted: boolean; agentId?: string }

export type ClaimWarning = {
  kind: ClaimKind
  quote: string
  reason: string
}

declare module 'claude-code' {
  interface PluginState {
    harness: {
      plan: HarnessPlan | null
      workers: Record<string, HarnessWorkerRow>
      needsYou: HarnessHumanAsk[]
      stale: boolean
      staleNote: string | null
      isHidden: boolean
      advisorModel: string
      review: HarnessReview | null
      isReviewRunning: boolean
      isExpanded: boolean
      folds: Record<string, boolean>
      scope: ScopeState
      claimLog: ClaimEntry[]
      claimWarnings: ClaimWarning[]
      reviewIds: Record<string, HarnessReviewIdentity>
    }
  }
}
