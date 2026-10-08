import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { resolveStateDir } from "../herdr/state-dir.js";
import { printable, singleLine } from "./printable.js";

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  output: string;
  durationMs: number;
  error?: string;
}

export type RunFn = (argv: readonly string[], options: RunOptions) => Promise<RunResult>;

export type ProveVerdict = "proven" | "not_proven" | "broken" | "no_tests" | "error";
export type ProveDependencies = "setup_command" | "node_modules_symlink" | "none";

export interface ProveRun {
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  outputTail: string;
}

export interface ProveReport {
  verdict: ProveVerdict;
  reason?: string;
  base: string | null;
  baseRef: string | null;
  testFiles: string[];
  sourceFiles: string[];
  dependencies: ProveDependencies;
  withoutSource?: ProveRun;
  withSource?: ProveRun;
  worktreeRemoved: boolean;
  branchRemoved: boolean;
  cleanupError?: string;
}

export interface ProveOptions {
  cwd: string;
  base?: string;
  testCommand: string[];
  testFiles?: string[];
  setupCommand?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  run?: RunFn;
}

export const DEFAULT_PROVE_TIMEOUT_MS = 600_000;
export const MAX_PROVE_TIMEOUT_MS = 3_600_000;
const OUTPUT_TAIL_CHARS = 4000;
const CAPTURE_CHARS = 64 * 1024;
const EXIT_GRACE_MS = 1000;

const TEST_PATH = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[^/]+$/;

export function isTestPath(path: string, explicit: ReadonlySet<string> = new Set()): boolean {
  return explicit.has(path) || TEST_PATH.test(path);
}

function tailOf(text: string): string {
  const clean = printable(text);
  return clean.length > OUTPUT_TAIL_CHARS ? `...${clean.slice(-OUTPUT_TAIL_CHARS)}` : clean;
}

export const defaultRun: RunFn = (argv, options) =>
  new Promise<RunResult>((resolveRun) => {
    const started = Date.now();
    const done = (result: Omit<RunResult, "durationMs">) => resolveRun({ ...result, durationMs: Date.now() - started });
    if (options.signal?.aborted) {
      done({ exitCode: null, timedOut: false, aborted: true, output: "" });
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(argv[0]!, argv.slice(1), { cwd: options.cwd, env: options.env ?? process.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      done({ exitCode: null, timedOut: false, aborted: false, output: "", error: error instanceof Error ? error.message : String(error) });
      return;
    }
    let output = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let spawnError: string | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const collect = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > CAPTURE_CHARS * 2) output = output.slice(-CAPTURE_CHARS);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const killGroup = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, options.timeoutMs);
    const onAbort = () => {
      aborted = true;
      killGroup();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      options.signal?.removeEventListener("abort", onAbort);
      done({ exitCode: code, timedOut, aborted, output: output.slice(-CAPTURE_CHARS), ...(spawnError ? { error: spawnError } : {}) });
    };
    child.on("error", (error) => {
      spawnError = error.message;
      finish(null);
    });
    child.on("exit", (code) => {
      graceTimer = setTimeout(() => {
        killGroup();
        finish(code);
      }, EXIT_GRACE_MS);
    });
    child.on("close", (code) => finish(code));
  });

function git(cwd: string, args: string[], extraConfig: string[] = []): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", [...extraConfig.flatMap((entry) => ["-c", entry]), ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return { ok: result.status === 0 && !result.error, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function nulList(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

function brief(text: string): string {
  return singleLine(text).trim().slice(0, 200);
}

function safeRelative(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (!normalized || isAbsolute(normalized) || normalized.split("/").some((part) => part === ".." || part === "")) throw new Error(`unsafe_path: ${brief(path)}`);
  return normalized;
}

function applyFiles(root: string, worktree: string, files: readonly string[]): void {
  for (const file of files) {
    const rel = safeRelative(file);
    const source = join(root, rel);
    const target = join(worktree, rel);
    const inside = relative(worktree, resolve(target));
    if (inside.startsWith("..") || isAbsolute(inside)) throw new Error(`unsafe_path: ${brief(file)}`);
    let stat;
    try {
      stat = lstatSync(source);
    } catch {
      rmSync(target, { force: true, recursive: true });
      continue;
    }
    if (stat.isDirectory()) continue;
    mkdirSync(dirname(target), { recursive: true });
    rmSync(target, { force: true, recursive: true });
    if (stat.isSymbolicLink()) symlinkSync(readlinkSync(source), target);
    else copyFileSync(source, target);
  }
}

function toRun(result: RunResult): ProveRun {
  return { exitCode: result.exitCode, durationMs: result.durationMs, timedOut: result.timedOut, outputTail: tailOf(result.output) };
}

function infraReason(stage: string, result: RunResult): string | null {
  if (result.aborted) return "aborted";
  if (result.timedOut) return `${stage}_timeout`;
  if (result.error) return `${stage}_not_runnable: ${brief(result.error)}`;
  return null;
}

function validCommand(command: unknown): command is string[] {
  return Array.isArray(command) && command.length > 0 && command.every((part) => typeof part === "string" && part.length > 0);
}

export function readCommandJson(path: string, label: string): string[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`invalid_${label}: file could not be read`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`invalid_${label}: file is not valid JSON`);
  }
  if (!validCommand(parsed)) throw new Error(`invalid_${label}: expected a non-empty JSON array of non-empty strings`);
  return parsed;
}

interface ChangeSet {
  root: string;
  subdir: string;
  baseSha: string;
  files: string[];
}

function computeChangeSet(cwd: string, baseRef: string | undefined): ChangeSet {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  const root = top.stdout.trim();
  if (!top.ok || !root) throw new Error(`not_a_git_repository: ${brief(cwd)}`);
  const prefix = git(cwd, ["rev-parse", "--show-prefix"]).stdout.trim().replace(/\/$/, "");
  let baseSha: string;
  if (baseRef !== undefined) {
    const ref = baseRef.trim();
    if (!ref || ref.startsWith("-") || !git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).ok) throw new Error(`invalid_base: "${brief(baseRef)}" is not a commit in this repository`);
    const merge = git(root, ["merge-base", ref, "HEAD"]);
    baseSha = merge.stdout.trim();
    if (!merge.ok || !baseSha) throw new Error(`no_merge_base: "${brief(ref)}" and HEAD share no history`);
  } else {
    const head = git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    baseSha = head.stdout.trim();
    if (!head.ok || !baseSha) throw new Error("no_commits: the repository has no commit to compare against");
  }
  const tracked = git(root, ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", baseSha, "--"]);
  if (!tracked.ok) throw new Error(`git_failed: git diff did not finish: ${brief(tracked.stderr)}`);
  const untracked = git(root, ["ls-files", "-z", "--others", "--exclude-standard", "--full-name", "--", ":/"]);
  if (!untracked.ok) throw new Error(`git_failed: git ls-files did not finish: ${brief(untracked.stderr)}`);
  const files = [...new Set([...nulList(tracked.stdout), ...nulList(untracked.stdout)])].sort();
  return { root, subdir: prefix, baseSha, files };
}

function worktreeListed(root: string, path: string): boolean {
  const listing = git(root, ["worktree", "list", "--porcelain"]);
  return listing.stdout.split("\n").some((line) => line === `worktree ${path}`);
}

function branchExists(root: string, branch: string): boolean {
  return git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
}

function removeWorktree(root: string, path: string, branch: string, links: readonly string[]): { worktreeRemoved: boolean; branchRemoved: boolean; error?: string } {
  const errors: string[] = [];
  for (const link of links) {
    try {
      unlinkSync(link);
    } catch {
    }
  }
  if (worktreeListed(root, path) || existsSync(path)) {
    git(root, ["worktree", "remove", "--force", "--force", path]);
    if (existsSync(path)) {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch (error) {
        errors.push(`rm: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    git(root, ["worktree", "prune"]);
  }
  if (branchExists(root, branch)) git(root, ["branch", "-D", branch]);
  const worktreeRemoved = !existsSync(path) && !worktreeListed(root, path);
  const branchRemoved = !branchExists(root, branch);
  if (!worktreeRemoved) errors.push(`worktree still present: ${brief(path)}`);
  if (!branchRemoved) errors.push(`branch still present: ${brief(branch)}`);
  return { worktreeRemoved, branchRemoved, ...(errors.length > 0 ? { error: errors.join("; ") } : {}) };
}

function freshWorkspace(root: string): { id: string; path: string; branch: string } {
  const parent = join(resolveStateDir(), "prove");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
    const path = join(parent, id);
    const branch = `herdr-jev-prove-${id}`;
    if (!existsSync(path) && !worktreeListed(root, path) && !branchExists(root, branch)) return { id, path, branch };
  }
  throw new Error("worktree_path_unavailable: could not find an unused worktree path");
}

function failed(partial: Partial<ProveReport> & { reason: string }): ProveReport {
  return { verdict: "error", base: null, baseRef: null, testFiles: [], sourceFiles: [], dependencies: "none", worktreeRemoved: true, branchRemoved: true, ...partial };
}

export async function runProve(opts: ProveOptions): Promise<ProveReport> {
  const run = opts.run ?? defaultRun;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROVE_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_PROVE_TIMEOUT_MS) return failed({ reason: `invalid_timeout: expected 1 to ${MAX_PROVE_TIMEOUT_MS} milliseconds` });
  if (!validCommand(opts.testCommand)) return failed({ reason: "invalid_test_command: expected a non-empty argv array of non-empty strings" });
  if (opts.setupCommand !== undefined && !validCommand(opts.setupCommand)) return failed({ reason: "invalid_setup_command: expected a non-empty argv array of non-empty strings" });

  let changes: ChangeSet;
  try {
    changes = computeChangeSet(opts.cwd, opts.base);
  } catch (error) {
    return failed({ reason: error instanceof Error ? error.message : String(error) });
  }
  const explicit = new Set((opts.testFiles ?? []).map((file) => file.replace(/\\/g, "/").replace(/^\.\//, "")));
  const testFiles = changes.files.filter((file) => isTestPath(file, explicit));
  const sourceFiles = changes.files.filter((file) => !isTestPath(file, explicit));
  const common = { base: changes.baseSha, baseRef: opts.base ?? null, testFiles, sourceFiles };
  if (testFiles.length === 0) return { verdict: "no_tests", reason: "no changed test files", ...common, dependencies: "none", worktreeRemoved: true, branchRemoved: true };

  let workspace: { id: string; path: string; branch: string };
  try {
    workspace = freshWorkspace(changes.root);
  } catch (error) {
    return failed({ ...common, reason: error instanceof Error ? error.message : String(error) });
  }
  const { path, branch } = workspace;
  const links: string[] = [];
  let report: ProveReport;
  try {
    report = await prove({ ...opts, run, timeoutMs }, changes, workspace, common, links);
  } catch (error) {
    report = failed({ ...common, reason: error instanceof Error ? error.message : String(error) });
  }
  const cleanup = removeWorktree(changes.root, path, branch, links);
  report.worktreeRemoved = cleanup.worktreeRemoved;
  report.branchRemoved = cleanup.branchRemoved;
  if (cleanup.error) report.cleanupError = cleanup.error;
  return report;
}

async function prove(
  opts: ProveOptions & { timeoutMs: number; run: RunFn },
  changes: ChangeSet,
  workspace: { path: string; branch: string },
  common: Pick<ProveReport, "base" | "baseRef" | "testFiles" | "sourceFiles">,
  links: string[],
): Promise<ProveReport> {
  const { path, branch } = workspace;
  const base = { ...common, worktreeRemoved: false, branchRemoved: false };
  const add = git(changes.root, ["worktree", "add", "-b", branch, path, changes.baseSha], ["core.hooksPath=/dev/null"]);
  if (!add.ok) return { verdict: "error", reason: `worktree_add_failed: ${brief(add.stderr)}`, dependencies: "none", ...base };
  if (opts.signal?.aborted) return { verdict: "error", reason: "aborted", dependencies: "none", ...base };

  const runIn = join(path, changes.subdir);
  const env = process.env;
  let dependencies: ProveDependencies = "none";
  if (opts.setupCommand) {
    dependencies = "setup_command";
    const setup = await opts.run(opts.setupCommand, { cwd: runIn, timeoutMs: opts.timeoutMs, signal: opts.signal, env });
    const infra = infraReason("setup", setup);
    if (infra) return { verdict: "error", reason: infra, dependencies, ...base };
    if (setup.exitCode !== 0) return { verdict: "error", reason: `setup_failed: exit ${setup.exitCode}: ${brief(tailOf(setup.output).slice(-300))}`, dependencies, ...base };
  } else {
    const modules = join(changes.root, "node_modules");
    const target = join(path, "node_modules");
    if (existsSync(modules) && !existsSync(target)) {
      symlinkSync(modules, target);
      links.push(target);
      dependencies = "node_modules_symlink";
    }
  }

  applyFiles(changes.root, path, common.testFiles);
  const first = await opts.run(opts.testCommand, { cwd: runIn, timeoutMs: opts.timeoutMs, signal: opts.signal, env });
  const withoutSource = toRun(first);
  const firstInfra = infraReason("test", first);
  if (firstInfra) return { verdict: "error", reason: firstInfra, dependencies, withoutSource, ...base };
  if (first.exitCode === 0) return { verdict: "not_proven", reason: "tests passed without the source change", dependencies, withoutSource, ...base };
  if (common.sourceFiles.length === 0) return { verdict: "broken", reason: "tests fail and the change has no source files to fix them", dependencies, withoutSource, ...base };

  applyFiles(changes.root, path, common.sourceFiles);
  const second = await opts.run(opts.testCommand, { cwd: runIn, timeoutMs: opts.timeoutMs, signal: opts.signal, env });
  const withSource = toRun(second);
  const secondInfra = infraReason("test", second);
  if (secondInfra) return { verdict: "error", reason: secondInfra, dependencies, withoutSource, withSource, ...base };
  if (second.exitCode !== 0) return { verdict: "broken", reason: "tests fail with the full change", dependencies, withoutSource, withSource, ...base };
  return { verdict: "proven", dependencies, withoutSource, withSource, ...base };
}

function describeRun(label: string, run: ProveRun | undefined): string[] {
  if (!run) return [];
  const lines = [`${label}: exit ${run.exitCode === null ? "none" : run.exitCode}${run.timedOut ? " (timed out)" : ""} in ${run.durationMs} ms`];
  const tail = run.outputTail.trim();
  if (tail) lines.push(...tail.split("\n").slice(-12).map((line) => `  ${line}`));
  return lines;
}

export function formatProveReport(report: ProveReport): string {
  const lines = [`Prove: ${report.verdict}${report.reason ? ` (${report.reason})` : ""}`];
  if (report.base) lines.push(`Base: ${report.baseRef ? `${report.baseRef} ` : ""}${report.base.slice(0, 12)}`);
  lines.push(`Test files: ${report.testFiles.length}, source files: ${report.sourceFiles.length}, dependencies: ${report.dependencies}`);
  lines.push(...describeRun("Without source change", report.withoutSource));
  lines.push(...describeRun("With source change", report.withSource));
  if (report.cleanupError) lines.push(`Cleanup incomplete: ${report.cleanupError}`);
  return lines.join("\n");
}
