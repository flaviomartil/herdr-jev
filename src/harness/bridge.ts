import { existsSync, realpathSync, readFileSync, statSync } from "node:fs";
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
  if (result.error) throw new Error((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? "harness_command_timeout" : "harness_command_failed");
  const stdout = result.stdout ?? "";
  let parsed: any;
  let parseable = false;
  try { parsed = JSON.parse(stdout); parseable = true; } catch {}
  if (result.status !== 0) {
    if (parseable && args[0]?.startsWith("review-") && parsed?.status === "changes_required") return parsed;
    throw new Error(errorCode(stdout, result.stderr ?? ""));
  }
  if (!parseable) throw new Error("invalid_harness_output");
  if (parsed && typeof parsed === "object" && typeof parsed.error === "string") throw new Error(errorCode(stdout, ""));
  return parsed;
}

const STAGE_EFFORTS = ["standard", "high", "xhigh"] as const;
type StageEffort = typeof STAGE_EFFORTS[number];

export interface DelegationInput {
  model?: string;
  availableModels?: string[];
  role?: "advisor" | "executor" | "reviewer";
}

export type HarnessDecision = { mode: "direct"; reason: string } | {
  mode: "delegate";
  profile: { id: string; client: string; advisor: string;
    executor: { model: string; cliModel?: string; effort?: StageEffort };
    reviewer: { model: string; cliModel?: string; effort?: StageEffort } };
};

function validStage(value: any): boolean {
  return Boolean(value) && typeof value === "object" && typeof value.model === "string" && value.model.length > 0
    && (value.cliModel === undefined || typeof value.cliModel === "string") && (value.effort === undefined || STAGE_EFFORTS.includes(value.effort));
}

function parseDecision(value: any): HarnessDecision | null {
  if (!value || typeof value !== "object") return null;
  if (value.mode === "direct") return { mode: "direct", reason: typeof value.reason === "string" ? value.reason : "unspecified" };
  const profile = value.profile;
  if (value.mode === "delegate" && profile && typeof profile === "object" && typeof profile.id === "string" && typeof profile.client === "string"
    && typeof profile.advisor === "string" && validStage(profile.executor) && validStage(profile.reviewer)) return value as HarnessDecision;
  return null;
}

export function resolveHarnessDelegation(client: string, substantive: boolean, input: DelegationInput = {}): HarnessDecision {
  try {
    const decision = parseDecision(harnessCommand<unknown>(["delegation-plan", "--client", client,
      "--work", substantive ? "substantive" : "simple", "--role", input.role ?? "advisor",
      ...(input.model ? ["--model", input.model] : []),
      ...(input.availableModels?.length ? ["--available-models", input.availableModels.join(",")] : [])]));
    return decision ?? { mode: "direct", reason: "invalid_delegation_plan" };
  } catch (error) {
    const reason = error instanceof Error && /^[a-z][a-z0-9_]*$/.test(error.message) ? error.message : "harness_unavailable";
    return { mode: "direct", reason };
  }
}

export function externalRun<T = any>(action: string, request: Record<string, unknown>): T {
  return harnessCommand<T>(["external-run", "--action", action, "--request-json", JSON.stringify(request)]);
}

const QUOTA_MAX_BYTES = 1024 * 1024;
const QUOTA_MAX_WINDOWS = 8;
const QUOTA_CALL_TIMEOUT_MS = 5_000;
const QUOTA_CACHE_MS = 30_000;
const QUOTA_DEGRADED_CACHE_MS = 60_000;
const QUOTA_FRESH_MS = 15 * 60_000;
const QUOTA_STOP_ERROR = /^(?:harness_command_timeout|harness_command_failed|harness_unavailable|unknown_command|invalid_external_action|unknown_option)/;
let quotaCache: { key: string; at: number; ttl: number; value: unknown[] } | undefined;
let quotaHarnessDownUntil = 0;

function localQuotaObservation(request: { provider: string; scope: string; observedAt: number | null; remainingPercent: number | null; resetsAt: number | null }): unknown {
  const now = Date.now();
  const exhausted = typeof request.remainingPercent === "number" && request.remainingPercent <= 0 && (request.resetsAt === null || request.resetsAt > now);
  const fresh = request.observedAt !== null && now - request.observedAt <= QUOTA_FRESH_MS && request.observedAt <= now + 60_000;
  return { provider: request.provider, scope: request.scope, freshness: fresh ? "fresh" : "stale", status: exhausted ? "exhausted" : "unknown", source: "local_fallback" };
}

export function readUsageQuota(path = join(homedir(), ".local/state/herdr/plugins/herdr-agent-usage/codex-app-server.json"), callTimeoutMs = QUOTA_CALL_TIMEOUT_MS): unknown[] {
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size > QUOTA_MAX_BYTES) return [];
    const key = `${path}\0${info.mtimeMs}\0${info.size}`;
    if (quotaCache && quotaCache.key === key && Date.now() - quotaCache.at < quotaCache.ttl) return quotaCache.value;
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(data.windows)) return [];
    let harnessDown = Date.now() < quotaHarnessDownUntil;
    let degraded = harnessDown;
    const value = data.windows.slice(0, QUOTA_MAX_WINDOWS).map((window: any) => {
      const request = {
        provider: "codex", scope: data.session_quota_only ? "unknown" : data.account_id ? "account" : "unknown",
        observedAt: typeof data.fetched_at_unix === "number" ? data.fetched_at_unix * 1000 : null,
        remainingPercent: typeof window?.remaining_percent === "number" ? window.remaining_percent : null,
        resetsAt: typeof window?.resets_at === "number" ? window.resets_at * 1000 : null,
      };
      if (harnessDown) return localQuotaObservation(request);
      try { return harnessCommand(["quota-normalize", "--request-json", JSON.stringify(request)], callTimeoutMs); }
      catch (error) {
        degraded = true;
        harnessDown = QUOTA_STOP_ERROR.test(error instanceof Error ? error.message : "");
        if (harnessDown) quotaHarnessDownUntil = Date.now() + QUOTA_DEGRADED_CACHE_MS;
        return localQuotaObservation(request);
      }
    });
    quotaCache = { key, at: Date.now(), ttl: degraded ? QUOTA_DEGRADED_CACHE_MS : QUOTA_CACHE_MS, value };
    return value;
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
  env?: NodeJS.ProcessEnv;
}

const UNSUPPORTED_ERROR = /^(?:unknown_command|invalid_external_action|unknown_option)/;

const ERROR_MULTILINE_ATTEMPTS = 8;

function jsonErrorCode(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const fromValue = (value: any): string | undefined => {
    const error = value?.error;
    return typeof error === "string" ? error : typeof error?.code === "string" ? error.code : undefined;
  };
  try { const code = fromValue(JSON.parse(trimmed)); if (code) return code; } catch {}
  const lines = trimmed.split(/\r?\n/);
  let multiline = 0;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!.trim();
    if (!line.startsWith("{")) continue;
    const candidates = line === "{" && multiline++ < ERROR_MULTILINE_ATTEMPTS ? [lines.slice(index).join("\n"), line] : [line];
    for (const candidate of candidates) {
      try { const code = fromValue(JSON.parse(candidate)); if (code) return code; } catch {}
    }
  }
  return undefined;
}

function errorCode(stdout: string, stderr: string): string {
  for (const text of [stderr, stdout]) {
    const code = jsonErrorCode(text);
    if (code) return code;
  }
  for (const text of [stderr, stdout]) {
    const first = text.trim().split(/\r?\n/)[0];
    if (first) return first.slice(0, 200);
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
  const result = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", timeout: options.timeout ?? 10_000, maxBuffer: 4 * 1024 * 1024, env: options.env ?? process.env });
  if (result.error) return { ok: false, error: (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? "harness_command_timeout" : "harness_command_failed" };
  return interpretProbe<T>(result.status, result.stdout ?? "", result.stderr ?? "", options);
}

const activeGroups = new Set<number>();

export function terminateHarnessProcesses(): void {
  for (const pid of activeGroups) {
    try { process.kill(-pid, "SIGKILL"); } catch {}
  }
  activeGroups.clear();
}

export function harnessProbeAsync<T = any>(args: string[], options: ProbeOptions = {}): Promise<HarnessProbe<T>> {
  const argv = probeInvocation(args);
  if (!argv) return Promise.resolve({ ok: false, error: "harness_unavailable", unsupported: true });
  return new Promise((resolvePromise) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["ignore", "pipe", "pipe"], env: options.env ?? process.env, detached: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const pid = child.pid;
    if (pid !== undefined) activeGroups.add(pid);
    const killGroup = () => {
      try {
        if (pid === undefined) throw new Error("no_pid");
        process.kill(-pid, "SIGKILL");
      } catch { try { child.kill("SIGKILL"); } catch {} }
    };
    const finish = (value: HarnessProbe<T>) => {
      if (settled) return;
      settled = true;
      if (pid !== undefined) activeGroups.delete(pid);
      clearTimeout(timer);
      resolvePromise(value);
    };
    const timer = setTimeout(() => { killGroup(); finish({ ok: false, error: "harness_command_timeout" }); }, options.timeout ?? 10_000);
    child.stdout?.on("data", (chunk: Buffer) => { if (stdoutBytes < 4 * 1024 * 1024) { stdout.push(chunk); stdoutBytes += chunk.length; } });
    child.stderr?.on("data", (chunk: Buffer) => { if (stderrBytes < 1024 * 1024) { stderr.push(chunk); stderrBytes += chunk.length; } });
    child.on("error", () => finish({ ok: false, error: "harness_command_failed" }));
    child.on("close", (code) => finish(interpretProbe<T>(code, Buffer.concat(stdout).toString("utf8"), Buffer.concat(stderr).toString("utf8"), options)));
  });
}

export type HarnessRole = "implementer" | "executor" | "reviewer" | "advisor" | "researcher";

export interface ModelResolution {
  client: string;
  known: boolean;
  model: string;
  cliModel: string;
  effort: string | null;
  effortArgs: string[];
  bypassArgs: string[] | null;
  readonlyArgs: string[];
}

const PROBE_FAILURE_TTL_MS = 30_000;
const PROBE_SUCCESS_TTL_MS = 5 * 60_000;
const probeCache = new Map<string, { value: unknown; expires: number }>();

export function resetHarnessCaches(): void {
  probeCache.clear();
  quotaCache = undefined;
  quotaHarnessDownUntil = 0;
}

function remembered<T>(key: string, build: () => { value: T; ok: boolean }): T {
  const hit = probeCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as T;
  const { value, ok } = build();
  probeCache.set(key, { value, expires: Date.now() + (ok ? PROBE_SUCCESS_TTL_MS : PROBE_FAILURE_TTL_MS) });
  return value;
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
  const bypassArgs = value.bypassArgs === undefined || value.bypassArgs === null ? null : stringArray(value.bypassArgs);
  const readonlyArgs = stringArray(value.readonlyArgs ?? []);
  if (!effortArgs || !readonlyArgs || (bypassArgs === null && value.bypassArgs != null)) return null;
  return { client: String(value.client ?? ""), known: value.known === true, model: typeof value.model === "string" ? value.model : value.cliModel,
    cliModel: value.cliModel.trim(), effort: typeof value.effort === "string" ? value.effort : null, effortArgs, bypassArgs, readonlyArgs };
}

export function harnessModelResolve(input: { client: string; model: string; effort?: string; role?: HarnessRole }): ModelResolution | null {
  const key = cacheKey("model-resolve", input.client, input.model, input.effort ?? "", input.role ?? "");
  return remembered(key, () => {
    const probe = harnessProbe(["model-resolve", "--client", input.client, "--model", input.model,
      ...(input.effort ? ["--effort", input.effort] : []), ...(input.role ? ["--role", input.role] : [])]);
    const resolution = probe.ok ? parseModelResolution(probe.value) : null;
    return { value: resolution, ok: resolution !== null };
  });
}

export function harnessModelCatalog(client?: string): HarnessProbe<any> {
  const key = cacheKey("model-catalog", client ?? "");
  return remembered(key, () => {
    const probe = harnessProbe(["model-catalog", ...(client ? ["--client", client] : [])]);
    const result: HarnessProbe<any> = probe.ok && probe.value && typeof probe.value === "object" && probe.value.clients && typeof probe.value.clients === "object"
      ? probe : { ok: false, error: probe.ok ? "invalid_model_catalog" : probe.error, unsupported: probe.ok ? true : probe.unsupported };
    return { value: result, ok: result.ok };
  });
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
