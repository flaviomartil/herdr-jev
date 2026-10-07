export type BaseClientKind = "claude" | "codex" | "antigravity" | "cursor" | "opencode" | "kimi" | "kiro";
export type ClientKind = BaseClientKind | (string & {});

export type TaskComplexity = "trivial" | "routine" | "moderate" | "architectural";

export type ReasoningEffort = "standard" | "high" | "xhigh";

export const ROLE_KINDS = ["advisor", "implementer", "reviewer", "researcher", "reader"] as const;
export type RoleKind = (typeof ROLE_KINDS)[number];

export interface TriageDecision {
  complexity: TaskComplexity;
  confidence: number;
  needsResearch: boolean;
  effort: ReasoningEffort;
  recommendedPipeline: "direct" | "triad";
  latencyMs: number;
  rawAnswers: Record<string, unknown>;
}

export interface StageSpec {
  role: RoleKind;
  model: string;
  effort: ReasoningEffort;
  extraFlags: string[];
  description: string;
  client?: ClientKind;
  cliModel?: string;
}

export interface PipelinePlan {
  task: string;
  client: ClientKind;
  triage: TriageDecision;
  stages: StageSpec[];
  spawnResearchSubagent: boolean;
  autoImprovement: boolean;
  delegation?: import("../harness/bridge.js").HarnessDecision;
  executionStages?: StageSpec[];
}

export interface HerdrCommandResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}
