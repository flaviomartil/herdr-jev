import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { resolveStateDir } from "../herdr/state-dir.js";
import { printable, singleLine } from "./printable.js";

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  onSpawn?: (pid: number) => void;
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
  skippedPaths: string[];
  skippedCount: number;
  dependencies: ProveDependencies;
  withoutSource?: ProveRun;
  withSource?: ProveRun;
  workspaceRemoved: boolean;
  cleanupError?: string;
}

export interface ProveOptions {
  cwd: string;
  base?: string;
  testCommand: string[];
  testFiles?: string[];
  setupCommand?: string[];
  testAtRoot?: boolean;
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
const STALE_FLOOR_MS = 7_200_000;
const SKIPPED_LISTED = 100;
const GIT_SAFE_CONFIG = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
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
      if (child.pid !== undefined) options.onSpawn?.(child.pid);
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
  const result = spawnSync("git", [...GIT_SAFE_CONFIG, ...args], {
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
  if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new Error(`unsafe_path: ${brief(rel)} resolves outside the workspace`);
  return true;
}

function realDirectories(base: string, parts: readonly string[]): boolean {
  let current = base;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    if (!lstatOrNull(current)?.isDirectory()) return false;
  }
  return true;
}

function applyFiles(root: string, workspace: string, files: readonly string[]): void {
  const realRoot = realpathSync(workspace);
  for (const file of files) {
    const rel = safeRelative(file);
    const parts = rel.split("/");
    const source = join(root, rel);
    const target = join(workspace, rel);
    const sourceStat = realDirectories(root, parts) ? lstatOrNull(source) : null;
    if (!sourceStat) {
      if (realDirectories(workspace, parts) && containedParent(realRoot, dirname(target), rel)) removeEntry(target);
      continue;
    }
    let current = workspace;
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
  skipped: string[];
  submodules: string[];
}

function skippedUntracked(path: string): boolean {
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
  const tracked = git(root, ["diff", "--raw", "-z", "--no-renames", "--no-ext-diff", "--ignore-submodules=dirty", baseSha, "--"]);
  if (!tracked.ok) throw new Error(`git_failed: git diff did not finish: ${brief(tracked.stderr)}`);
  const trackedFiles: string[] = [];
  const submodules: string[] = [];
  const tokens = nulList(tracked.stdout);
  for (let index = 0; index < tokens.length; index += 2) {
    const meta = /^:(\d+) (\d+) /.exec(tokens[index]!);
    const path = tokens[index + 1];
    if (!meta || path === undefined) throw new Error("git_failed: git diff returned output that could not be read");
    trackedFiles.push(path);
    if (meta[1] === "160000" || meta[2] === "160000") submodules.push(path);
  }
  const untracked = git(root, ["ls-files", "-z", "--others", "--exclude-standard", "--full-name", "--", ":/"]);
  if (!untracked.ok) throw new Error(`git_failed: git ls-files did not finish: ${brief(untracked.stderr)}`);
  const untrackedAll = nulList(untracked.stdout);
  const skipped = untrackedAll.filter(skippedUntracked).sort();
  const files = [...new Set([...trackedFiles, ...untrackedAll.filter((file) => !skippedUntracked(file))])].sort();
  return { root, subdir: prefix, baseSha, files, skipped, submodules: submodules.sort() };
}

interface Meta {
  startedAt: number;
  timeoutMs: number;
  owner?: number;
  ownerStart?: string;
  pid?: number;
  argv?: string[];
}

function metaPath(path: string): string {
  return `${path}.meta.json`;
}

function writeMeta(path: string, meta: Meta): void {
  try {
    writeFileSync(metaPath(path), JSON.stringify(meta), { mode: 0o600 });
  } catch {
  }
}

function readMeta(path: string): Meta | null {
  try {
    const parsed = JSON.parse(readFileSync(metaPath(path), "utf8"));
    if (typeof parsed?.startedAt !== "number" || typeof parsed?.timeoutMs !== "number") return null;
    return parsed as Meta;
  } catch {
    return null;
  }
}

export function readProcessStat(pid: number): { pgrp: number; start: string } | null {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    const pgrp = Number(fields[2]);
    const start = fields[19];
    if (!Number.isInteger(pgrp) || !start) return null;
    return { pgrp, start };
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function currentUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function ownerIsLive(meta: Meta): boolean {
  const owner = meta.owner;
  if (typeof owner !== "number" || !Number.isInteger(owner) || owner <= 1 || !processAlive(owner)) return false;
  if (meta.ownerStart === undefined) return true;
  return readProcessStat(owner)?.start === meta.ownerStart;
}

function killableOrphan(pid: unknown, dir: string): pid is number {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) return false;
  const uid = currentUid();
  if (uid === null) return false;
  try {
    if (statSync(`/proc/${pid}`).uid !== uid) return false;
    const stat = readProcessStat(pid);
    if (!stat || stat.pgrp !== pid) return false;
    const cwd = readlinkSync(`/proc/${pid}/cwd`);
    const real = realpathSync(dir);
    return cwd === real || cwd.startsWith(real + sep);
  } catch {
    return false;
  }
}

function trustedFile(path: string, directory: boolean): boolean {
  const stat = lstatOrNull(path);
  if (!stat) return false;
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid) return false;
  if (stat.isSymbolicLink()) return false;
  if (directory ? !stat.isDirectory() : !stat.isFile()) return false;
  return (stat.mode & 0o022) === 0;
}

function sweepStale(parent: string): void {
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return;
  }
  const ids = new Set(names.map((name) => (name.endsWith(".meta.json") ? name.slice(0, -".meta.json".length) : name)));
  for (const id of ids) {
    try {
      const dir = join(parent, id);
      const uid = currentUid();
      const dirStat = lstatOrNull(dir);
      if (dirStat && uid !== null && dirStat.uid !== uid) continue;
      const meta = trustedFile(metaPath(dir), false) ? readMeta(dir) : null;
      let startedAt = meta?.startedAt;
      if (startedAt === undefined) startedAt = dirStat?.mtimeMs ?? 0;
      const threshold = Math.max(STALE_FLOOR_MS, 3 * (meta?.timeoutMs ?? DEFAULT_PROVE_TIMEOUT_MS));
      if (Date.now() - startedAt < threshold) continue;
      if (meta && ownerIsLive(meta)) continue;
      if (meta && dirStat?.isDirectory() && killableOrphan(meta.pid, dir)) {
        try {
          process.kill(-meta.pid!, "SIGKILL");
        } catch {
        }
      }
      rmSync(dir, { recursive: true, force: true });
      rmSync(metaPath(dir), { force: true });
    } catch {
    }
  }
}

function removeWorkspace(path: string): { workspaceRemoved: boolean; error?: string } {
  let error: string | undefined;
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (cause) {
    error = `rm: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
  const workspaceRemoved = !existsSync(path);
  if (!workspaceRemoved) error = `${error ? `${error}; ` : ""}workspace still present: ${brief(path)}`;
  return { workspaceRemoved, ...(error ? { error } : {}) };
}

function freshWorkspace(): { path: string } {
  const parent = join(resolveStateDir(), "prove");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  try {
    chmodSync(parent, 0o700);
  } catch {
  }
  sweepStale(parent);
  const realParent = realpathSync(parent);
  for (let attempt = 0; attempt < 8; attempt++) {
    const path = join(realParent, `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`);
    if (!existsSync(path)) return { path };
  }
  throw new Error("workspace_path_unavailable: could not find an unused workspace path");
}

function resolveExplicit(file: string, changes: ChangeSet, known: ReadonlySet<string>): string | null {
  const candidates: string[] = [];
  if (isAbsolute(file)) {
    const rel = relative(changes.root, file).split(sep).join("/");
    if (rel && !rel.startsWith("..")) candidates.push(rel);
  } else {
    candidates.push(posix.normalize(posix.join(changes.subdir, file)), posix.normalize(file));
  }
  for (const candidate of candidates) if (known.has(candidate)) return candidate;
  return null;
}

function failed(partial: Partial<ProveReport> & { reason: string }): ProveReport {
  return { verdict: "error", base: null, baseRef: null, testFiles: [], sourceFiles: [], skippedPaths: [], skippedCount: 0, dependencies: "none", workspaceRemoved: true, ...partial };
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
  const known = new Set(changes.files);
  const explicit = new Set<string>();
  const unknown: string[] = [];
  for (const file of opts.testFiles ?? []) {
    const resolved = resolveExplicit(file, changes, known);
    if (resolved === null) unknown.push(file);
    else explicit.add(resolved);
  }
  if (unknown.length > 0) return failed({ reason: `test_file_not_in_change_set: ${unknown.slice(0, 5).map(brief).join(", ")} is not a changed file; --test-file takes a path relative to the directory you run from, or to the repository root, of a file that changed` });
  const testFiles = changes.files.filter((file) => isTestPath(file, explicit));
  const sourceFiles = changes.files.filter((file) => !isTestPath(file, explicit));
  const common = { base: changes.baseSha, baseRef: opts.base ?? null, testFiles, sourceFiles, skippedPaths: changes.skipped.slice(0, SKIPPED_LISTED), skippedCount: changes.skipped.length };
  if (testFiles.length === 0) return { verdict: "no_tests", reason: "no changed test files", ...common, dependencies: "none", workspaceRemoved: true };
  if (changes.submodules.length > 0) return failed({ ...common, reason: `submodule_change_unsupported: ${changes.submodules.slice(0, 5).map(brief).join(", ")} changed its commit pointer; submodule updates cannot be applied to the copy` });

  let workspace: { path: string };
  try {
    workspace = freshWorkspace();
  } catch (error) {
    return failed({ ...common, reason: error instanceof Error ? error.message : String(error) });
  }
  const meta: Meta = { startedAt: Date.now(), timeoutMs, owner: process.pid, ownerStart: readProcessStat(process.pid)?.start };
  writeMeta(workspace.path, meta);
  let report: ProveReport;
  try {
    report = await prove({ ...opts, run, timeoutMs }, changes, workspace.path, common, meta);
  } catch (error) {
    report = failed({ ...common, workspaceRemoved: false, reason: error instanceof Error ? error.message : String(error) });
  }
  const cleanup = removeWorkspace(workspace.path);
  report.workspaceRemoved = cleanup.workspaceRemoved;
  if (cleanup.error) report.cleanupError = cleanup.error;
  if (cleanup.workspaceRemoved) rmSync(metaPath(workspace.path), { force: true });
  return report;
}

function partialClone(root: string): boolean {
  const config = git(root, ["config", "--get-regexp", "^(extensions\\.partialclone|remote\\..*\\.(promisor|partialclonefilter))$"]);
  return config.ok && config.stdout.trim().length > 0;
}

async function createWorkspace(opts: ProveOptions & { timeoutMs: number }, changes: ChangeSet, path: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (partialClone(changes.root)) return "partial_clone_unsupported: the repository is a partial clone, so the base commit may be missing objects; run prove in a full clone";
  const steps: Array<[string, string[]]> = [
    ["clone", ["git", ...GIT_SAFE_CONFIG, "clone", "--quiet", "--shared", "--no-checkout", "--template=", "--origin", "origin", changes.root, path]],
    ["checkout", ["git", "-C", path, ...GIT_SAFE_CONFIG, "checkout", "--quiet", "--force", "--detach", changes.baseSha]],
    ["remote", ["git", "-C", path, ...GIT_SAFE_CONFIG, "remote", "remove", "origin"]],
    ["fetch", ["git", "-C", path, ...GIT_SAFE_CONFIG, "fetch", "--quiet", "--no-tags", changes.root, "+refs/heads/*:refs/heads/*", "+refs/remotes/*:refs/remotes/*"]],
  ];
  for (const [name, argv] of steps) {
    const result = await defaultRun(argv, { cwd: changes.root, timeoutMs: opts.timeoutMs, signal: opts.signal, env: { ...env, GIT_OPTIONAL_LOCKS: "0" } });
    if (result.aborted) return "aborted";
    if (result.timedOut) return `workspace_timeout: git ${name}`;
    if (result.exitCode !== 0) return `workspace_failed: git ${name}: ${brief(result.output)}`;
  }
  return null;
}

async function prove(
  opts: ProveOptions & { timeoutMs: number; run: RunFn },
  changes: ChangeSet,
  path: string,
  common: Pick<ProveReport, "base" | "baseRef" | "testFiles" | "sourceFiles" | "skippedPaths" | "skippedCount">,
  meta: Meta,
): Promise<ProveReport> {
  const base = { ...common, workspaceRemoved: false };
  const env = cleanEnv();
  const creation = await createWorkspace(opts, changes, path, env);
  if (creation) return { verdict: "error", reason: creation, dependencies: "none", ...base };

  const execute = async (argv: readonly string[], cwd: string): Promise<RunResult> => {
    const result = await opts.run(argv, { cwd, timeoutMs: opts.timeoutMs, signal: opts.signal, env, onSpawn: (pid) => writeMeta(path, { ...meta, pid, argv: [...argv] }) });
    writeMeta(path, meta);
    return result;
  };
  const setupIn = join(path, changes.subdir);
  const testIn = opts.testAtRoot ? path : setupIn;
  let dependencies: ProveDependencies = "none";
  if (opts.setupCommand) {
    dependencies = "setup_command";
    if (!existsSync(setupIn)) return { verdict: "error", reason: `setup_cwd_missing: ${brief(changes.subdir)} does not exist at the base commit; run from the repository root or a directory present at the base`, dependencies, ...base };
    const setup = await execute(opts.setupCommand, setupIn);
    const infra = infraReason("setup", setup);
    if (infra) return { verdict: "error", reason: infra, dependencies, ...base };
    if (setup.exitCode !== 0) return { verdict: "error", reason: `setup_failed: exit ${setup.exitCode}: ${brief(tailOf(setup.output).slice(-300))}`, dependencies, ...base };
  } else {
    const modules = join(changes.root, "node_modules");
    const target = join(path, "node_modules");
    if (existsSync(modules) && !lstatOrNull(target)) {
      const underLink = [...common.testFiles, ...common.sourceFiles].filter((file) => file.startsWith("node_modules/"));
      if (underLink.length > 0) return { verdict: "error", reason: `tracked_file_under_linked_node_modules: ${underLink.slice(0, 5).map(brief).join(", ")} changed under the root node_modules that is linked from your checkout; pass --setup-command-json to use a copy of its own`, dependencies, ...base };
      symlinkSync(modules, target);
      dependencies = "node_modules_symlink";
    }
  }

  applyFiles(changes.root, path, common.testFiles);
  if (!existsSync(testIn)) return { verdict: "error", reason: `test_cwd_missing: ${brief(changes.subdir)} does not exist with only the test files applied; run from the repository root`, dependencies, ...base };
  const first = await execute(opts.testCommand, testIn);
  const withoutSource = toRun(first);
  const firstInfra = infraReason("test", first);
  if (firstInfra) return { verdict: "error", reason: firstInfra, dependencies, withoutSource, ...base };
  if (first.exitCode === 0) return { verdict: "not_proven", reason: "tests passed without the source change", dependencies, withoutSource, ...base };
  if (common.sourceFiles.length === 0) return { verdict: "broken", reason: "tests fail and the change has no source files to fix them", dependencies, withoutSource, ...base };

  applyFiles(changes.root, path, common.sourceFiles);
  const second = await execute(opts.testCommand, testIn);
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
  if (report.skippedCount > 0) lines.push(`Skipped untracked paths: ${report.skippedCount} (${report.skippedPaths.slice(0, 5).map(brief).join(", ")}${report.skippedCount > 5 ? ", ..." : ""})`);
  lines.push(...describeRun("Without source change", report.withoutSource));
  lines.push(...describeRun("With source change", report.withSource));
  if (report.cleanupError) lines.push(`Cleanup incomplete: ${report.cleanupError}`);
  return lines.join("\n");
}
