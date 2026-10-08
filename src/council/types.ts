export type CouncilMemberName = "codex" | "kimi" | "antigravity";

export interface CouncilFinding {
  member: CouncilMemberName;
  path: string;
  line?: number;
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
}

export interface CouncilMemberResult {
  member: CouncilMemberName;
  status: "done" | "failed" | "skipped";
  reason?: string;
  findings: CouncilFinding[];
  durationMs: number;
}

export interface CouncilRun {
  members: CouncilMemberResult[];
  diffHash: string;
  ran: boolean;
  note?: string;
}
