import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
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
  signal?: string | null;
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
  signal: string | null;
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
const GIT_CALL_TIMEOUT_MS = 120_000;
const INHERITED_GIT_VARIABLES = ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE", "GIT_PREFIX", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY"];

const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[^/]+$|_test\.[^/]+$|(^|\/)test_[^/]+\.py$/;

export function isTestPath(path: string, explicit: ReadonlySet<string> = new Set()): boolean {
  return explicit.has(path) || TEST_PATH.test(path);
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of INHERITED_GIT_VARIABLES) delete env[name];
  return env;
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
    const finish = (code: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      options.signal?.removeEventListener("abort", onAbort);
      killGroup();
      done({ exitCode: code, signal, timedOut, aborted, output: output.slice(-CAPTURE_CHARS), ...(spawnError ? { error: spawnError } : {}) });
    };
    child.on("error", (error) => {
      spawnError = error.message;
      finish(null, null);
    });
    child.on("exit", (code, signal) => {
      graceTimer = setTimeout(() => finish(code, signal), EXIT_GRACE_MS);
    });
    child.on("close", (code, signal) => finish(code, signal));
  });

function git(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: GIT_CALL_TIMEOUT_MS,
    env: { ...cleanEnv(), GIT_OPTIONAL_LOCKS: "0" },
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
  if (!path || isAbsolute(path) || path.split("/").some((part) => part === ".." || part === "." || part === "")) throw new Error(`unsafe_path: ${brief(path)}`);
  return path;
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function removeEntry(path: string): void {
  const stat = lstatOrNull(path);
  if (!stat) return;
  if (stat.isDirectory()) rmSync(path, { recursive: true, force: true });
  else unlinkSync(path);
}

function ensureDirectory(path: string): void {
  const stat = lstatOrNull(path);
  if (stat?.isDirectory()) return;
  if (stat) unlinkSync(path);
  mkdirSync(path);
}

function containedParent(realRoot: string, parent: string, rel: string): boolean {
  let real: string;
  try {
    real = realpathSync(parent);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new Error(`unsafe_path: ${brief(rel)} resolves outside the worktree`);
  return true;
}

function applyFiles(root: string, worktree: string, files: readonly string[]): void {
  const realRoot = realpathSync(worktree);
  for (const file of files) {
    const rel = safeRelative(file);
    const parts = rel.split("/");
    const source = join(root, rel);
    const target = join(worktree, rel);
    const sourceStat = lstatOrNull(source);
    if (!sourceStat) {
      if (containedParent(realRoot, dirname(target), rel)) removeEntry(target);
      continue;
    }
    let current = worktree;
    for (const part of parts.slice(0, -1)) {
      current = join(current, part);
      ensureDirectory(current);
    }
    containedParent(realRoot, dirname(target), rel);
    if (sourceStat.isDirectory()) {
      ensureDirectory(target);
      continue;
    }
    removeEntry(target);
    if (sourceStat.isSymbolicLink()) symlinkSync(readlinkSync(source), target);
    else copyFileSync(source, target);
  }
}

function toRun(result: RunResult): ProveRun {
  return { exitCode: result.exitCode, signal: result.signal ?? null, durationMs: result.durationMs, timedOut: result.timedOut, outputTail: tailOf(result.output) };
}

function infraReason(stage: string, result: RunResult): string | null {
  if (result.aborted) return "aborted";
  if (result.timedOut) return `${stage}_timeout`;
  if (result.error) return `${stage}_not_runnable: ${brief(result.error)}`;
  if (result.exitCode === null) return `${stage}_killed${result.signal ? `: ${result.signal}` : ""}`;
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

function ignoredPath(path: string): boolean {
  return path.endsWith("/") || path.split("/").some((part) => part === "node_modules" || part.toLowerCase() === ".git");
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
  const files = [...new Set([...nulList(tracked.stdout), ...nulList(untracked.stdout)])].filter((file) => !ignoredPath(file)).sort();
  return { root, subdir: prefix, baseSha, files };
}

function worktreeListed(root: string, path: string): boolean {
  const listing = git(root, ["worktree", "list", "--porcelain"]);
  return listing.stdout.split("\n").some((line) => line === `worktree ${path}`);
}

function removeOwnAdminEntry(root: string, path: string): void {
  const common = git(root, ["rev-parse", "--git-common-dir"]).stdout.trim();
  if (!common) return;
  const admin = join(resolve(root, common), "worktrees");
  let names: string[];
  try {
    names = readdirSync(admin);
  } catch {
    return;
  }
  for (const name of names) {
    try {
      if (readFileSync(join(admin, name, "gitdir"), "utf8").trim() === join(path, ".git")) rmSync(join(admin, name), { recursive: true, force: true });
    } catch {
    }
  }
}

function removeWorktree(root: string, path: string, links: readonly string[]): { worktreeRemoved: boolean; error?: string } {
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
    if (worktreeListed(root, path)) removeOwnAdminEntry(root, path);
  }
  const worktreeRemoved = !existsSync(path) && !worktreeListed(root, path);
  if (!worktreeRemoved) errors.push(`worktree still present: ${brief(path)}`);
  return { worktreeRemoved, ...(errors.length > 0 ? { error: errors.join("; ") } : {}) };
}

function freshWorkspace(root: string): { path: string } {
  const parent = join(resolveStateDir(), "prove");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const realParent = realpathSync(parent);
  for (let attempt = 0; attempt < 8; attempt++) {
    const path = join(realParent, `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`);
    if (!existsSync(path) && !worktreeListed(root, path)) return { path };
  }
  throw new Error("worktree_path_unavailable: could not find an unused worktree path");
}

function failed(partial: Partial<ProveReport> & { reason: string }): ProveReport {
  return { verdict: "error", base: null, baseRef: null, testFiles: [], sourceFiles: [], dependencies: "none", worktreeRemoved: true, ...partial };
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
  const explicit = new Set((opts.testFiles ?? []).map((file) => file.replace(/^\.\//, "")));
  const testFiles = changes.files.filter((file) => isTestPath(file, explicit));
  const sourceFiles = changes.files.filter((file) => !isTestPath(file, explicit));
  const common = { base: changes.baseSha, baseRef: opts.base ?? null, testFiles, sourceFiles };
  if (testFiles.length === 0) return { verdict: "no_tests", reason: "no changed test files", ...common, dependencies: "none", worktreeRemoved: true };

  let workspace: { path: string };
  try {
    workspace = freshWorkspace(changes.root);
  } catch (error) {
    return failed({ ...common, reason: error instanceof Error ? error.message : String(error) });
  }
  const links: string[] = [];
  let report: ProveReport;
  try {
    report = await prove({ ...opts, run, timeoutMs }, changes, workspace.path, common, links);
  } catch (error) {
    report = failed({ ...common, reason: error instanceof Error ? error.message : String(error) });
  }
  const cleanup = removeWorktree(changes.root, workspace.path, links);
  report.worktreeRemoved = cleanup.worktreeRemoved;
  if (cleanup.error) report.cleanupError = cleanup.error;
  return report;
}

async function prove(
  opts: ProveOptions & { timeoutMs: number; run: RunFn },
  changes: ChangeSet,
  path: string,
  common: Pick<ProveReport, "base" | "baseRef" | "testFiles" | "sourceFiles">,
  links: string[],
): Promise<ProveReport> {
  const base = { ...common, worktreeRemoved: false };
  const env = cleanEnv();
  const add = await defaultRun(["git", "-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", path, changes.baseSha], {
    cwd: changes.root,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    env: { ...env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (add.aborted) return { verdict: "error", reason: "aborted", dependencies: "none", ...base };
  if (add.timedOut) return { verdict: "error", reason: "worktree_add_timeout", dependencies: "none", ...base };
  if (add.exitCode !== 0) return { verdict: "error", reason: `worktree_add_failed: ${brief(add.output)}`, dependencies: "none", ...base };

  const runIn = join(path, changes.subdir);
  let dependencies: ProveDependencies = "none";
  if (opts.setupCommand) {
    dependencies = "setup_command";
    if (!existsSync(runIn)) return { verdict: "error", reason: `setup_cwd_missing: ${brief(changes.subdir)} does not exist at the base commit; run from the repository root or a directory present at the base`, dependencies, ...base };
    const setup = await opts.run(opts.setupCommand, { cwd: runIn, timeoutMs: opts.timeoutMs, signal: opts.signal, env });
    const infra = infraReason("setup", setup);
    if (infra) return { verdict: "error", reason: infra, dependencies, ...base };
    if (setup.exitCode !== 0) return { verdict: "error", reason: `setup_failed: exit ${setup.exitCode}: ${brief(tailOf(setup.output).slice(-300))}`, dependencies, ...base };
  } else {
    const modules = join(changes.root, "node_modules");
    const target = join(path, "node_modules");
    if (existsSync(modules) && !lstatOrNull(target)) {
      symlinkSync(modules, target);
      links.push(target);
      dependencies = "node_modules_symlink";
    }
  }

  applyFiles(changes.root, path, common.testFiles);
  if (!existsSync(runIn)) return { verdict: "error", reason: `test_cwd_missing: ${brief(changes.subdir)} does not exist with only the test files applied; run from the repository root`, dependencies, ...base };
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
  const lines = [`${label}: exit ${run.exitCode === null ? `none${run.signal ? ` (${run.signal})` : ""}` : run.exitCode}${run.timedOut ? " (timed out)" : ""} in ${run.durationMs} ms`];
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
