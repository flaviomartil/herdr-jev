import { existsSync, realpathSync, readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { isTestSafeBinary } from "../herdr/client.js";
import { isTestGuardActive } from "../herdr/state-dir.js";

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

export function resolveHarnessBinary(): string | undefined {
  const binary = Bun.which("ai-harness", { PATH: process.env.PATH ?? "" });
  if (!binary) return undefined;
  if (isTestGuardActive() && !isTestSafeBinary(binary)) return undefined;
  return binary;
}

export function harnessCommand<T = any>(args: string[], timeout = 15_000): T {
  const root = resolveHarnessRoot();
  const binary = resolveHarnessBinary();
  if (!binary || !root) throw new Error("harness_unavailable");
  const result = spawnSync(binary, [...args, "--root", root], { encoding: "utf8", timeout, maxBuffer: 1024 * 1024, env: process.env });
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

export function hasExhaustedUsageQuota(client: string, observations = readUsageQuota()): boolean {
  return observations.some((value: any) => value?.provider === client && value.scope === "account"
    && value.freshness === "fresh" && value.status === "exhausted");
}

export interface HarnessProbe<T> {
  ok: boolean;
  value?: T;
  error?: string;
  unsupported?: boolean;
}

export interface ProbeOptions {
  timeout?: number;
  acceptNonZeroJson?: boolean;
}

const UNSUPPORTED_ERROR = /^(?:unknown_command|invalid_external_action|unknown_option)/;

function errorCode(stdout: string, stderr: string): string {
  for (const text of [stderr, stdout]) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const error = parsed?.error;
      const code = typeof error === "string" ? error : typeof error?.code === "string" ? error.code : undefined;
      if (code) return code;
    } catch {
      return trimmed.split(/\r?\n/)[0]!.slice(0, 200);
    }
  }
  return "harness_command_failed";
}

function interpretProbe<T>(status: number | null, stdout: string, stderr: string, options: ProbeOptions): HarnessProbe<T> {
  let parsed: any;
  let parseable = false;
  try { parsed = JSON.parse(stdout); parseable = true; } catch {}
  const failed = status !== 0;
  if (!failed && parseable && !(parsed && typeof parsed === "object" && typeof parsed.error === "string")) return { ok: true, value: parsed as T };
  if (failed && parseable && options.acceptNonZeroJson && parsed && typeof parsed === "object" && typeof parsed.status === "string") {
    return { ok: true, value: parsed as T };
  }
  const code = failed || !parseable ? errorCode(stdout, stderr) : typeof parsed.error === "string" ? parsed.error : "harness_command_failed";
  return { ok: false, error: code, unsupported: UNSUPPORTED_ERROR.test(code) };
}

function probeInvocation(args: string[]): string[] | null {
  const root = resolveHarnessRoot();
  const binary = resolveHarnessBinary();
  if (!binary || !root) return null;
  return [binary, ...args, "--root", root];
}

export function harnessProbe<T = any>(args: string[], options: ProbeOptions = {}): HarnessProbe<T> {
  const argv = probeInvocation(args);
  if (!argv) return { ok: false, error: "harness_unavailable", unsupported: true };
  const result = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", timeout: options.timeout ?? 10_000, maxBuffer: 4 * 1024 * 1024, env: process.env });
  if (result.error) return { ok: false, error: "harness_command_failed" };
  return interpretProbe<T>(result.status, result.stdout ?? "", result.stderr ?? "", options);
}

export function harnessProbeAsync<T = any>(args: string[], options: ProbeOptions = {}): Promise<HarnessProbe<T>> {
  const argv = probeInvocation(args);
  if (!argv) return Promise.resolve({ ok: false, error: "harness_unavailable", unsupported: true });
  return new Promise((resolvePromise) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value: HarnessProbe<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish({ ok: false, error: "harness_command_timeout" }); }, options.timeout ?? 10_000);
    child.stdout?.on("data", (chunk: Buffer) => { if (stdout.length < 4 * 1024 * 1024) stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { if (stderr.length < 1024 * 1024) stderr += chunk.toString("utf8"); });
    child.on("error", () => finish({ ok: false, error: "harness_command_failed" }));
    child.on("close", (code) => finish(interpretProbe<T>(code, stdout, stderr, options)));
  });
}

export type HarnessRole = "executor" | "reviewer" | "advisor" | "researcher";

export interface ModelResolution {
  client: string;
  known: boolean;
  model: string;
  cliModel: string;
  effort: string | null;
  effortArgs: string[];
  bypassArgs: string[];
  readonlyArgs: string[];
}

const probeCache = new Map<string, unknown>();

export function resetHarnessCaches(): void {
  probeCache.clear();
}

function cacheKey(...parts: string[]): string {
  return [resolveHarnessBinary() ?? "", resolveHarnessRoot(), ...parts].join("\u0000");
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0 && !item.includes("\0")) ? value as string[] : null;
}

export function parseModelResolution(value: any): ModelResolution | null {
  if (!value || typeof value !== "object" || typeof value.cliModel !== "string" || !value.cliModel.trim()) return null;
  const effortArgs = stringArray(value.effortArgs ?? []);
  const bypassArgs = stringArray(value.bypassArgs ?? []);
  const readonlyArgs = stringArray(value.readonlyArgs ?? []);
  if (!effortArgs || !bypassArgs || !readonlyArgs) return null;
  return { client: String(value.client ?? ""), known: value.known === true, model: typeof value.model === "string" ? value.model : value.cliModel,
    cliModel: value.cliModel.trim(), effort: typeof value.effort === "string" ? value.effort : null, effortArgs, bypassArgs, readonlyArgs };
}

export function harnessModelResolve(input: { client: string; model: string; effort?: string; role?: HarnessRole }): ModelResolution | null {
  const key = cacheKey("model-resolve", input.client, input.model, input.effort ?? "", input.role ?? "");
  if (probeCache.has(key)) return probeCache.get(key) as ModelResolution | null;
  const probe = harnessProbe(["model-resolve", "--client", input.client, "--model", input.model,
    ...(input.effort ? ["--effort", input.effort] : []), ...(input.role ? ["--role", input.role] : [])]);
  const resolution = probe.ok ? parseModelResolution(probe.value) : null;
  probeCache.set(key, resolution);
  return resolution;
}

export function harnessModelCatalog(client?: string): HarnessProbe<any> {
  const key = cacheKey("model-catalog", client ?? "");
  if (probeCache.has(key)) return probeCache.get(key) as HarnessProbe<any>;
  const probe = harnessProbe(["model-catalog", ...(client ? ["--client", client] : [])]);
  const result: HarnessProbe<any> = probe.ok && probe.value && typeof probe.value === "object" && probe.value.clients && typeof probe.value.clients === "object"
    ? probe : { ok: false, error: probe.ok ? "invalid_model_catalog" : probe.error, unsupported: probe.ok ? true : probe.unsupported };
  probeCache.set(key, result);
  return result;
}

export interface TrustPolicy {
  trusted: boolean;
  reason: string;
}

export function harnessPolicyCheck(kind: "trust", path: string): TrustPolicy | null {
  const probe = harnessProbe(["policy-check", "--kind", kind, "--path", path]);
  const value = probe.value as any;
  if (!probe.ok || !value || typeof value.trusted !== "boolean") return null;
  return { trusted: value.trusted, reason: typeof value.reason === "string" ? value.reason : "unspecified" };
}

export interface HarnessWorkerRun {
  id: string;
  kind?: string;
  client?: string;
  cwd?: string;
  createdAt?: string;
  stages?: Array<{ role?: string; state?: string; model?: string; pane?: string; agent?: string }>;
  [key: string]: unknown;
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function runObject(value: unknown): HarnessWorkerRun | null {
  const run = value as HarnessWorkerRun | undefined;
  return run && typeof run === "object" && typeof run.id === "string" && RUN_ID.test(run.id) ? run : null;
}

export function createWorkerRun(request: {
  client: string; model: string; role: string; cwd: string; branch?: string | null; forkSha?: string | null;
  pane: string; handle: string; objectiveDigest: string;
}): HarnessWorkerRun | null {
  const probe = harnessProbe(["external-run", "--action", "worker-create", "--request-json", JSON.stringify(request)]);
  return probe.ok ? runObject(probe.value) : null;
}

export function settleWorkerRun(request: { id: string; state: "done" | "failed" | "closed"; head: string | null }): HarnessWorkerRun | null {
  const probe = harnessProbe(["external-run", "--action", "worker-settle", "--request-json", JSON.stringify(request)]);
  return probe.ok ? runObject(probe.value) : null;
}

export function listHarnessRuns(request: { limit: number; kind: "worker" | "pipeline" | "all"; cwd?: string }): HarnessWorkerRun[] | null {
  const probe = harnessProbe(["external-run", "--action", "list", "--request-json", JSON.stringify(request)]);
  if (!probe.ok || !Array.isArray(probe.value)) return null;
  return (probe.value as unknown[]).flatMap((item) => {
    const run = runObject(item);
    return run ? [run] : [];
  });
}
