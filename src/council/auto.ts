import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveStateDir } from "../herdr/state-dir.js";
import { triageTaskWithJev } from "../triage/client.js";
import { buildReviewPatch } from "./review-dir.js";

export const DEFAULT_COUNCIL_COOLDOWN_MS = 10 * 60 * 1000;
export const MAX_COUNCIL_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const AUTO_COMPLEXITIES: readonly string[] = ["moderate", "architectural"];
const TASK_CAP = 4000;
const AUTO_DIR = "council-auto";
const RUN_ID = /^[a-f0-9-]{36}$/;

export type TriageFn = (task: string) => Promise<{ complexity: string; rawAnswers?: Record<string, unknown> }>;

export interface AutoGateInput {
  task?: string;
  cwd: string;
  base?: string;
  cooldownMs?: number;
}

export interface AutoGateDeps {
  triage?: TriageFn;
  stateDir?: string;
  now?: () => number;
}

export type AutoGate = { run: true; diffHash: string } | { run: false; note: string };

export interface LastCouncilRun {
  diffHash: string;
  at: number;
}

export function parseCouncilCooldown(value: string | undefined): number {
  if (value === undefined) return DEFAULT_COUNCIL_COOLDOWN_MS;
  const ms = /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isSafeInteger(ms) || ms > MAX_COUNCIL_COOLDOWN_MS) {
    throw new Error(`invalid council cooldown; use an integer between 0 and ${MAX_COUNCIL_COOLDOWN_MS} milliseconds`);
  }
  return ms;
}

function statePath(stateDir: string, repoRoot: string): string {
  return join(stateDir, AUTO_DIR, `${createHash("sha256").update(repoRoot).digest("hex")}.json`);
}

export function readLastCouncilRun(stateDir: string, repoRoot: string): LastCouncilRun | undefined {
  try {
    const parsed = JSON.parse(readFileSync(statePath(stateDir, repoRoot), "utf8"));
    if (typeof parsed?.diffHash === "string" && typeof parsed?.at === "number" && Number.isFinite(parsed.at)) return { diffHash: parsed.diffHash, at: parsed.at };
  } catch {
  }
  return undefined;
}

export function recordCouncilRun(stateDir: string, repoRoot: string, diffHash: string, at: number): void {
  try {
    const dir = join(stateDir, AUTO_DIR);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const path = statePath(stateDir, repoRoot);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ diffHash, at }), { mode: 0o600 });
    renameSync(temporary, path);
  } catch {
  }
}

export function readRunObjective(id: string | undefined, stateDir: string = resolveStateDir()): string | undefined {
  if (!id || !RUN_ID.test(id)) return undefined;
  try {
    const path = join(stateDir, id, "objective.md");
    if (!existsSync(path)) return undefined;
    const text = readFileSync(path, "utf8").trim();
    return text === "" ? undefined : text;
  } catch {
    return undefined;
  }
}

function seconds(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

export async function decideAutoCouncil(input: AutoGateInput, deps: AutoGateDeps = {}): Promise<AutoGate> {
  const task = input.task?.trim().slice(0, TASK_CAP) ?? "";
  if (task === "") return { run: false, note: "council skipped: no task summary" };

  let complexity: string;
  try {
    const decision = await (deps.triage ?? triageTaskWithJev)(task);
    if (decision.rawAnswers?.fallback === true) return { run: false, note: "council skipped: triage unavailable" };
    complexity = String(decision.complexity);
  } catch {
    return { run: false, note: "council skipped: triage unavailable" };
  }
  if (!AUTO_COMPLEXITIES.includes(complexity)) return { run: false, note: `council skipped: triage ${complexity.slice(0, 40)}` };

  let repoRoot: string;
  let hash: string;
  try {
    const patch = await buildReviewPatch(input.cwd, input.base);
    if (patch.patch.trim() === "") return { run: false, note: "council skipped: no diff" };
    repoRoot = patch.repoRoot;
    hash = patch.hash;
  } catch {
    return { run: false, note: "council skipped: cannot read the diff" };
  }

  let stateDir: string;
  try {
    stateDir = deps.stateDir ?? resolveStateDir();
  } catch {
    return { run: true, diffHash: hash };
  }
  const last = readLastCouncilRun(stateDir, repoRoot);
  if (last) {
    if (last.diffHash === hash) return { run: false, note: "council skipped: same diff as the last council run" };
    const cooldownMs = input.cooldownMs ?? DEFAULT_COUNCIL_COOLDOWN_MS;
    const age = (deps.now ?? Date.now)() - last.at;
    if (cooldownMs > 0 && age >= 0 && age < cooldownMs) {
      return { run: false, note: `council skipped: cooldown, last council run ${seconds(age)} ago (window ${seconds(cooldownMs)})` };
    }
  }
  return { run: true, diffHash: hash };
}
