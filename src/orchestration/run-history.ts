import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { HarnessWorkerRun } from "../harness/bridge.js";

export const runIdPattern = /^[a-f0-9-]{36}$/;
export const retryableStageStates = new Set(["failed", "unknown", "blocked"]);

export type RunHistoryEntry = {
  id: string;
  projection: Record<string, any>;
  mtimeMs: number;
  timestampMs: number;
};

export function runStateDir(stateDir = process.env.HERDR_JEV_STATE_DIR ?? join(homedir(), ".local/state/herdr-jev")): string {
  return stateDir;
}

export function assertRunId(id: string): void {
  if (!runIdPattern.test(id)) throw new Error("invalid_run_id");
}

export function retryableStages<T extends { state: string }>(stages: readonly T[]): T[] {
  return stages.filter((stage) => retryableStageStates.has(stage.state));
}

function projectionTimestamp(projection: Record<string, any>): number | undefined {
  const values = [projection.generated_at, projection.timestamp, projection.created_at,
    projection.run?.started_at, projection.run?.created_at];
  for (const value of values) {
    const timestamp = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return undefined;
}

export function listRunHistory(stateDir?: string, limit = 20): RunHistoryEntry[] {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("invalid_limit");
  const root = runStateDir(stateDir);
  let directories: string[];
  try { directories = readdirSync(root); } catch { return []; }

  return directories.filter((id) => runIdPattern.test(id)).flatMap((id) => {
    try {
      const path = join(root, id, "run.json");
      const projection = JSON.parse(readFileSync(path, "utf8"));
      if (!projection || typeof projection !== "object" || Array.isArray(projection)) return [];
      const mtimeMs = statSync(path).mtimeMs;
      return [{ id, projection, mtimeMs, timestampMs: Math.max(mtimeMs, projectionTimestamp(projection) ?? 0) }];
    } catch { return []; }
  }).sort((a, b) => b.timestampMs - a.timestampMs || b.mtimeMs - a.mtimeMs).slice(0, limit);
}

function stages(projection: Record<string, any>): Array<{ id?: string; state?: string; blocked_reason?: string }> {
  if (Array.isArray(projection.tasks)) return projection.tasks;
  if (Array.isArray(projection.stages)) return projection.stages;
  return [];
}

export function runStateSummary(projection: Record<string, any>): string {
  const summary = stages(projection).map((stage) => `${stage.id ?? "stage"}:${stage.state ?? "unknown"}${stage.blocked_reason ? `(${stage.blocked_reason})` : ""}`);
  return summary.length ? summary.join(",") : "no-stages";
}

export function runLocation(projection: Record<string, any>): string | undefined {
  const cwd = projection.cwd ?? projection.run?.cwd;
  if (typeof cwd === "string" && cwd) return `cwd=${cwd}`;
  const objectiveDigest = projection.objectiveDigest ?? projection.run?.objectiveDigest;
  return typeof objectiveDigest === "string" && objectiveDigest ? `objective=${objectiveDigest}` : undefined;
}

export function formatRunAge(timestampMs: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - timestampMs) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export type MergedRunEntry = RunHistoryEntry & { kind: string; source: "local" | "harness" | "both" };

export function mergeRunHistory(local: readonly RunHistoryEntry[], remote: readonly HarnessWorkerRun[] | null, limit = 20): MergedRunEntry[] {
  const merged = new Map<string, MergedRunEntry>();
  for (const entry of local) merged.set(entry.id, { ...entry, kind: "pipeline", source: "local" });
  for (const run of remote ?? []) {
    const kind = typeof run.kind === "string" && run.kind ? run.kind : "pipeline";
    const existing = merged.get(run.id);
    if (existing) {
      merged.set(run.id, { ...existing, kind, source: "both" });
      continue;
    }
    const created = typeof run.createdAt === "string" ? Date.parse(run.createdAt) : NaN;
    const timestampMs = Number.isFinite(created) ? created : 0;
    const projection = { id: run.id, kind, cwd: run.cwd, created_at: run.createdAt,
      tasks: (run.stages ?? []).map((stage) => ({ id: stage.role, state: stage.state })) };
    merged.set(run.id, { id: run.id, projection, mtimeMs: timestampMs, timestampMs, kind, source: "harness" });
  }
  return [...merged.values()].sort((a, b) => b.timestampMs - a.timestampMs || b.mtimeMs - a.mtimeMs).slice(0, limit);
}

export function formatRunHistory(entry: RunHistoryEntry & { kind?: string }, now = Date.now()): string {
  return [entry.id, entry.kind, runStateSummary(entry.projection), runLocation(entry.projection), formatRunAge(entry.timestampMs, now)].filter(Boolean).join("  ");
}
