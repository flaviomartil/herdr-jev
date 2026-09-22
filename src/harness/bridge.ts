import { existsSync, realpathSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";

export interface HarnessBridgeStatus {
  available: boolean;
  harnessPath: string;
}

export function resolveHarnessRoot(): string {
  if (process.env.AI_HARNESS_ROOT && existsSync(process.env.AI_HARNESS_ROOT)) {
    return process.env.AI_HARNESS_ROOT;
  }
  if (process.env.AI_HARNESS_CORE_PATH && existsSync(process.env.AI_HARNESS_CORE_PATH)) {
    return process.env.AI_HARNESS_CORE_PATH;
  }

  // 1. Resolve from ai-harness-hook or ai-harness binary realpath
  try {
    const hookBin = Bun.which("ai-harness-hook") || Bun.which("ai-harness");
    if (hookBin) {
      const real = realpathSync(hookBin);
      const root = resolve(dirname(real), "..");
      if (existsSync(join(root, "package.json"))) {
        return root;
      }
    }
  } catch {
    // Ignore resolution errors
  }

  // 2. Search standard workspace and home directories
  const home = process.env.HOME || homedir();
  const candidates = [
    join(process.cwd(), "../ai-harness-core"),
    join(home, "projects/personal/ai-harness-core"),
    join(home, "projects/ai-harness-core"),
    join(home, ".ai-harness"),
    join(home, ".local/share/ai-harness"),
  ];

  for (const cand of candidates) {
    if (cand && existsSync(cand) && existsSync(join(cand, "package.json"))) {
      return cand;
    }
  }

  return "";
}

export function checkHarnessStatus(): HarnessBridgeStatus {
  const root = resolveHarnessRoot();
  return {
    available: root.length > 0 && existsSync(join(root, "package.json")),
    harnessPath: root,
  };
}

export interface LearningRecord {
  sessionId?: string;
  timestamp: string;
  task: string;
  client: string;
  stages: string[];
  learnings: string[];
  status: "success" | "partial" | "failed";
  receipt: HarnessRunReceipt;
}

export interface HarnessRunReceipt {
  schemaVersion: 1;
  launchStatus: "success" | "partial" | "failed";
  completionRequested: boolean;
  completionObserved: boolean;
  completionStates: string[];
  workEvidence: "not_checked";
}

export function recordAutoImprovement(record: LearningRecord): { recorded: boolean; path?: string } {
  try {
    return harnessCommand(["usage-record", "--client", record.client, "--session", record.sessionId ?? randomUUID(),
      "--agent", "harness-operator", "--runbook", "orchestrate-agents", "--cli", "herdr-jev",
      "--outcome", record.status === "failed" ? "failure" : record.status === "partial" ? "partial" : "success_unverified"]);
  } catch {
    return { recorded: false };
  }
}

export function harnessCommand<T = any>(args: string[], timeout = 15_000): T {
  const root = resolveHarnessRoot();
  const binary = Bun.which("ai-harness");
  if (!binary || !root) throw new Error("harness_unavailable");
  const result = spawnSync(binary, [...args, "--root", root], { encoding: "utf8", timeout, maxBuffer: 1024 * 1024 });
  if (result.error) throw new Error("harness_command_failed");
  const parsed = JSON.parse(result.stdout);
  if (result.status !== 0 && !(args[0]?.startsWith("review-") && parsed.status === "changes_required")) throw new Error("harness_command_failed");
  return parsed;
}

export interface DelegationInput {
  model?: string;
  availableModels?: string[];
  role?: "advisor" | "executor" | "reviewer";
}

export type HarnessDecision = { mode: "direct"; reason: string } | {
  mode: "delegate";
  profile: { id: string; client: string; advisor: string;
    executor: { model: string; effort?: "high" | "xhigh" };
    reviewer: { model: string; effort?: "high" | "xhigh" } };
};

export function resolveHarnessDelegation(client: string, substantive: boolean, input: DelegationInput = {}): HarnessDecision {
  try {
    return harnessCommand<HarnessDecision>(["delegation-plan", "--client", client,
      "--work", substantive ? "substantive" : "simple", "--role", input.role ?? "advisor",
      ...(input.model ? ["--model", input.model] : []),
      ...(input.availableModels?.length ? ["--available-models", input.availableModels.join(",")] : [])]);
  } catch { return { mode: "direct", reason: "harness_unavailable" }; }
}

export function externalRun<T = any>(action: string, request: Record<string, unknown>): T {
  return harnessCommand<T>(["external-run", "--action", action, "--request-json", JSON.stringify(request)]);
}

export function readUsageQuota(path = join(homedir(), ".local/state/herdr/plugins/herdr-agent-usage/codex-app-server.json")): unknown[] {
  try {
    const raw = readFileSync(path, "utf8");
    if (Buffer.byteLength(raw) > 1024 * 1024) return [];
    const data = JSON.parse(raw);
    if (!Array.isArray(data.windows)) return [];
    return data.windows.slice(0, 32).map((window: any) => harnessCommand(["quota-normalize", "--request-json", JSON.stringify({
      provider: "codex", scope: data.session_quota_only ? "unknown" : data.account_id ? "account" : "unknown",
      observedAt: typeof data.fetched_at_unix === "number" ? data.fetched_at_unix * 1000 : null,
      remainingPercent: window.remaining_percent ?? null,
      resetsAt: typeof window.resets_at === "number" ? window.resets_at * 1000 : null,
    })]));
  } catch { return []; }
}
