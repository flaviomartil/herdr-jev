import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reviewerCommand } from "../orchestration/pipeline.js";
import { resolveStageSpec } from "../pipelines/matrix.js";
import { resolveStateDir } from "../herdr/state-dir.js";
import type { StageSpec } from "../types/index.js";
import { harnessProbeAsync, resolveHarnessDelegation, type HarnessProbe } from "./bridge.js";

export interface ReviewScope {
  name: string;
  files: string[];
}

export interface DeclaredScope {
  name: string;
  paths: string[];
}

const SCOPE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const MAX_SCOPES = 8;
const MAX_PROMPT_FILES = 200;
export const DERIVED_SCOPE_LIMIT = 4;
export const DEFAULT_JUDGE_TIMEOUT_MS = 600_000;
export const MAX_JUDGE_TIMEOUT_MS = 1_800_000;

export function parseScopes(spec: string): DeclaredScope[] {
  const declared: DeclaredScope[] = [];
  for (const part of spec.split(";").map((item) => item.trim()).filter(Boolean)) {
    const separator = part.indexOf("=");
    if (separator <= 0) throw new Error(`invalid_scopes: expected name=path1,path2 in "${part}"`);
    const name = part.slice(0, separator).trim();
    if (!SCOPE_NAME.test(name)) throw new Error(`invalid_scopes: invalid scope name "${name}"`);
    if (declared.some((scope) => scope.name === name)) throw new Error(`invalid_scopes: duplicate scope "${name}"`);
    const paths = part.slice(separator + 1).split(",").map((item) => item.trim().replace(/^\.\//, "").replace(/\/+$/, "")).filter(Boolean);
    if (paths.length === 0) throw new Error(`invalid_scopes: scope "${name}" has no paths`);
    for (const path of paths) {
      if (path.startsWith("/") || path.split("/").includes("..")) throw new Error(`invalid_scopes: path "${path}" must be relative to the repository`);
    }
    declared.push({ name, paths });
  }
  if (declared.length === 0) throw new Error("invalid_scopes: no scopes declared");
  if (declared.length > MAX_SCOPES) throw new Error(`invalid_scopes: at most ${MAX_SCOPES} scopes`);
  return declared;
}

function git(cwd: string, args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { ok: result.status === 0, stdout: result.stdout ?? "" };
}

function nulList(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

export function resolveDefaultBranch(cwd: string): string | null {
  const remoteHead = git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const candidates = [remoteHead.ok ? remoteHead.stdout.trim() : "", "main", "master"].filter(Boolean);
  for (const candidate of candidates) {
    if (git(cwd, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`]).ok) return candidate;
  }
  return null;
}

export function listChangedFiles(cwd: string): { base: string | null; files: string[] } {
  const defaultBranch = resolveDefaultBranch(cwd);
  const mergeBase = defaultBranch ? git(cwd, ["merge-base", defaultBranch, "HEAD"]) : { ok: false, stdout: "" };
  const base = mergeBase.ok && mergeBase.stdout.trim() ? mergeBase.stdout.trim() : "HEAD";
  const tracked = git(cwd, ["diff", "--name-only", "-z", base, "--"]);
  const untracked = git(cwd, ["ls-files", "-z", "--others", "--exclude-standard"]);
  const files = [...new Set([...(tracked.ok ? nulList(tracked.stdout) : []), ...(untracked.ok ? nulList(untracked.stdout) : [])])].sort();
  return { base: defaultBranch ? `${defaultBranch}` : null, files };
}

function sanitizeScopeName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[^A-Za-z0-9]+/, "").slice(0, 40);
  return cleaned || "root";
}

export function deriveScopes(files: readonly string[], limit = DERIVED_SCOPE_LIMIT): ReviewScope[] {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const separator = file.indexOf("/");
    const name = separator === -1 ? "root" : sanitizeScopeName(file.slice(0, separator));
    groups.set(name, [...(groups.get(name) ?? []), file]);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  if (ordered.length <= limit) return ordered.map(([name, members]) => ({ name, files: members }));
  const kept = ordered.slice(0, limit - 1);
  const rest = ordered.slice(limit - 1).flatMap(([, members]) => members);
  const taken = new Set(kept.map(([name]) => name));
  const otherName = taken.has("other") ? "other-files" : "other";
  return [...kept.map(([name, members]) => ({ name, files: members })), { name: otherName, files: rest }];
}

function insideScope(file: string, path: string): boolean {
  return file === path || file.startsWith(`${path}/`);
}

export function assignScopes(declared: readonly DeclaredScope[], changed: readonly string[]): ReviewScope[] {
  return declared.map((scope) => {
    const matched = changed.filter((file) => scope.paths.some((path) => insideScope(file, path)));
    return { name: scope.name, files: matched.length ? matched : [...scope.paths] };
  });
}

export function buildJudgePrompt(scope: ReviewScope, base: string | null): string {
  const shown = scope.files.slice(0, MAX_PROMPT_FILES);
  const hidden = scope.files.length - shown.length;
  return [
    "You are an independent read-only reviewer. Do not delegate and do not modify any file.",
    `Review scope "${scope.name}" of the current change${base ? ` against ${base}` : ""}.`,
    "Files in scope:",
    ...shown.map((file) => `- ${file}`),
    ...(hidden > 0 ? [`- ... and ${hidden} more files in this scope`] : []),
    "Inspect only these files and the minimum surrounding code needed to judge them. Report concrete defects with file and line.",
    "End with exactly one final line: REVIEW_GATE_VERDICT: APPROVE or REVIEW_GATE_VERDICT: CHANGES_REQUIRED",
  ].join("\n");
}

export function detectVerifyCommand(cwd: string): string[] | null {
  try {
    const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    if (typeof manifest?.scripts?.test === "string" && manifest.scripts.test.trim()) return ["bun", "test"];
  } catch {
  }
  return null;
}

export function readVerifyCommand(path: string): string[] {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((part) => typeof part !== "string" || !part)) throw new Error("invalid_verify_command");
  return parsed;
}

export function resolveReviewerStage(client: string, options: { model?: string; availableModels?: string[] } = {}): { source: "profile" | "matrix"; stage: StageSpec } {
  const decision = resolveHarnessDelegation(client, true, { role: "reviewer", model: options.model, availableModels: options.availableModels });
  if (decision.mode === "delegate") {
    const reviewer = decision.profile.reviewer;
    return { source: "profile", stage: { role: "reviewer", client: decision.profile.client, model: reviewer.model,
      effort: reviewer.effort ?? "standard", extraFlags: [], description: `AI Harness profile: ${decision.profile.id}` } };
  }
  const stage = resolveStageSpec(client, "reviewer");
  stage.client = client;
  return { source: "matrix", stage };
}

export interface ReviewOptions {
  cwd: string;
  client: string;
  session?: string;
  scopes?: string;
  timeoutMs?: number;
  verifyCommandJson?: string;
  model?: string;
  availableModels?: string[];
}

export interface ReviewReport {
  session: string;
  client: string;
  cwd: string;
  base: string | null;
  degraded?: "scopes_unsupported";
  reviewer?: { source: "profile" | "matrix"; client: string; model: string; effort: string };
  scopes: Array<{ name: string; fileCount: number }>;
  verify?: { status: string | null; error?: string };
  judges: Array<{ scope: string; status: string | null; error?: string }>;
  status: string | null;
  findings?: unknown;
  error?: string;
}

const UNSUPPORTED_SCOPE_FLAG = /scope|unknown_option/;

function failedProbe(probe: HarnessProbe<unknown>): string {
  return probe.error ?? "harness_command_failed";
}

export async function runReview(options: ReviewOptions): Promise<ReviewReport> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_JUDGE_TIMEOUT_MS) throw new Error("invalid_timeout");
  const session = options.session ?? `jev-review-${randomBytes(6).toString("hex")}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(session)) throw new Error("invalid_session");
  const { base, files } = listChangedFiles(options.cwd);
  let scopes = options.scopes ? assignScopes(parseScopes(options.scopes), files) : deriveScopes(files);
  const report: ReviewReport = { session, client: options.client, cwd: options.cwd, base, scopes: [], judges: [], status: null };
  if (scopes.length === 0) return { ...report, error: "no_changed_files" };

  const verifyArgv = options.verifyCommandJson ? readVerifyCommand(options.verifyCommandJson) : detectVerifyCommand(options.cwd);
  if (!verifyArgv) return { ...report, scopes: scopes.map((scope) => ({ name: scope.name, fileCount: scope.files.length })), error: "verify_command_required" };
  const reviewer = resolveReviewerStage(options.client, { model: options.model, availableModels: options.availableModels });
  const reviewerClient = reviewer.stage.client ?? options.client;
  report.reviewer = { source: reviewer.source, client: reviewerClient, model: reviewer.stage.model, effort: reviewer.stage.effort };
  const commands = scopes.map((scope) => reviewerCommand(reviewerClient, reviewer.stage, buildJudgePrompt(scope, base)));

  const dir = join(resolveStateDir(), "review", session);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const verifyFile = join(dir, "verify-command.json");
  writeFileSync(verifyFile, JSON.stringify(verifyArgv), { mode: 0o600 });
  const identity = ["--client", options.client, "--session", session, "--cwd", options.cwd];

  let scoped = true;
  let verify = await harnessProbeAsync<{ status?: string }>(["review-verify", ...identity, "--command-json", verifyFile,
    "--scopes", scopes.map((scope) => scope.name).join(",")], { timeout: 11 * 60_000, acceptNonZeroJson: true });
  if (!verify.ok && (verify.unsupported || UNSUPPORTED_SCOPE_FLAG.test(verify.error ?? "")) && verify.error !== "harness_unavailable") {
    scoped = false;
    scopes = [{ name: "default", files: scopes.flatMap((scope) => scope.files) }];
    report.degraded = "scopes_unsupported";
    verify = await harnessProbeAsync(["review-verify", ...identity, "--command-json", verifyFile], { timeout: 11 * 60_000, acceptNonZeroJson: true });
  }
  report.scopes = scopes.map((scope) => ({ name: scope.name, fileCount: scope.files.length }));
  if (!verify.ok) return { ...report, verify: { status: null, error: failedProbe(verify) }, error: failedProbe(verify) };
  report.verify = { status: verify.value?.status ?? null };

  if (verify.value?.status === "pending_review") {
    const judgeCommands = scoped ? commands : [reviewerCommand(reviewerClient, reviewer.stage, buildJudgePrompt(scopes[0]!, base))];
    report.judges = await Promise.all(scopes.map(async (scope, index) => {
      const commandFile = join(dir, `judge-${scope.name}.json`);
      writeFileSync(commandFile, JSON.stringify(judgeCommands[index]), { mode: 0o600 });
      const judged = await harnessProbeAsync<{ status?: string }>(["review-judge", ...identity, "--command-json", commandFile,
        ...(scoped ? ["--scope", scope.name, "--timeout-ms", String(timeoutMs)] : [])], { timeout: timeoutMs + 60_000, acceptNonZeroJson: true });
      return judged.ok ? { scope: scope.name, status: judged.value?.status ?? null } : { scope: scope.name, status: null, error: failedProbe(judged) };
    }));
  }

  const findings = await harnessProbeAsync<{ status?: string }>(["review-findings", ...identity], { acceptNonZeroJson: true });
  if (findings.ok) {
    report.findings = findings.value;
    report.status = findings.value?.status ?? null;
    return report;
  }
  const status = await harnessProbeAsync<{ status?: string }>(["review-status", ...identity], { acceptNonZeroJson: true });
  if (status.ok) report.status = status.value?.status ?? null;
  else report.error = failedProbe(status);
  return report;
}

export function formatReviewReport(report: ReviewReport): string {
  const lines = [`Review session ${report.session} (${report.client}) in ${report.cwd}`];
  if (report.base) lines.push(`Changes against ${report.base}`);
  if (report.reviewer) lines.push(`Reviewer ${report.reviewer.client}/${report.reviewer.model} (${report.reviewer.effort}, ${report.reviewer.source})`);
  if (report.degraded) lines.push("Harness without scope support: reviewed as a single scope");
  for (const scope of report.scopes) lines.push(`Scope ${scope.name}: ${scope.fileCount} files`);
  if (report.verify) lines.push(`Verify: ${report.verify.status ?? report.verify.error ?? "unknown"}`);
  for (const judge of report.judges) lines.push(`Judge ${judge.scope}: ${judge.status ?? judge.error ?? "unknown"}`);
  const scopedFindings = (report.findings as { scopes?: Array<{ name: string; verdict: string; findings?: string }> } | undefined)?.scopes ?? [];
  for (const scope of scopedFindings) {
    lines.push(`Verdict ${scope.name}: ${scope.verdict}`);
    if (scope.findings) lines.push(scope.findings.length > 4000 ? `${scope.findings.slice(0, 4000)}\n[truncated]` : scope.findings);
  }
  lines.push(`Status: ${report.status ?? "unavailable"}${report.error ? ` (${report.error})` : ""}`);
  return lines.join("\n");
}
