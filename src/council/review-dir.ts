import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { resolveStateDir } from "../herdr/state-dir.js";
import { cleanEnv } from "./env.js";
import { reviewRoot, trackPath } from "./scope.js";
import { isSensitivePath } from "./sensitive.js";

export const MAX_UNTRACKED_BYTES = 5 * 1024 * 1024;
const BASE_REF = /^[A-Za-z0-9._\/@~^+-]{1,200}$/u;
const DIFF_FLAGS = ["--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/"];
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null", "-c", "core.quotePath=false"];

export interface ReviewPatch {
  repoRoot: string;
  baseCommit: string;
  patch: string;
  promptDiff: string;
  hash: string;
  skippedPaths: string[];
  oversizedPaths: string[];
}

export interface ReviewWorktree {
  path: string;
  roots: string[];
  remove(): Promise<string | undefined>;
}

export { isSensitivePath as isSecretLikePath };

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

const REVIEW_GIT_ENV: NodeJS.ProcessEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "council",
  GIT_AUTHOR_EMAIL: "council@localhost",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "council",
  GIT_COMMITTER_EMAIL: "council@localhost",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};

function isolatedEnv(): NodeJS.ProcessEnv {
  return { ...cleanEnv(), ...REVIEW_GIT_ENV };
}

interface GitOptions {
  input?: string;
  env?: NodeJS.ProcessEnv;
  extra?: string[];
}

function git(cwd: string, args: string[], options: GitOptions = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", [...NO_HOOKS, ...(options.extra ?? []), ...args], { cwd, env: options.env ?? cleanEnv(), stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => resolve({ code: 127, stdout: "", stderr: error.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
    if (options.input !== undefined && child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.input);
    }
  });
}

function lastLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .at(-1) ?? ""
  );
}

async function gitOk(cwd: string, args: string[], options: GitOptions = {}): Promise<string> {
  const result = await git(cwd, args, options);
  if (result.code !== 0) throw new Error(`git_failed: git ${args[0]} exited ${result.code}: ${lastLine(result.stderr)}`.slice(0, 300));
  return result.stdout;
}

export function validateBase(base: string): void {
  if (base.startsWith("-") || !BASE_REF.test(base)) throw new Error("invalid_base: the base ref must not start with '-' and may use only ref characters");
}

export async function resolveRepoRoot(cwd: string): Promise<string> {
  return (await gitOk(cwd, ["rev-parse", "--show-toplevel"])).trim();
}

function splitZ(text: string): string[] {
  return text.split("\0").filter((entry) => entry !== "");
}

export async function buildReviewPatch(cwd: string, base?: string, maxUntrackedBytes: number = MAX_UNTRACKED_BYTES): Promise<ReviewPatch> {
  if (base !== undefined) validateBase(base);
  const repoRoot = await resolveRepoRoot(cwd);
  let baseCommit = (await gitOk(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
  if (base) baseCommit = (await gitOk(repoRoot, ["merge-base", base, baseCommit])).trim();

  const changed = splitZ(await gitOk(repoRoot, ["diff", "--name-only", "-z", "--no-renames", baseCommit, "--"]));
  const untracked = splitZ(await gitOk(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"])).filter((entry) => !entry.endsWith("/"));
  const skippedPaths = [...new Set([...changed, ...untracked].filter(isSensitivePath))].sort();
  const excludes = changed.filter(isSensitivePath).map((path) => `:(exclude,literal)${path}`);
  const pathspec = ["--", ".", ...excludes];

  const tracked = await gitOk(repoRoot, ["diff", "--no-renames", "--binary", ...DIFF_FLAGS, baseCommit, ...pathspec]);
  const trackedText = await gitOk(repoRoot, ["diff", "--no-renames", ...DIFF_FLAGS, baseCommit, ...pathspec]);
  const patchParts: string[] = [tracked];
  const promptParts: string[] = [trackedText];
  const oversizedPaths: string[] = [];
  for (const file of untracked) {
    if (isSensitivePath(file)) continue;
    let size = 0;
    try {
      size = statSync(join(repoRoot, file)).size;
    } catch {
      oversizedPaths.push(file);
      continue;
    }
    if (size > maxUntrackedBytes) {
      oversizedPaths.push(file);
      continue;
    }
    const binary = await git(repoRoot, ["diff", "--no-index", "--binary", ...DIFF_FLAGS, "--", "/dev/null", file]);
    const text = await git(repoRoot, ["diff", "--no-index", ...DIFF_FLAGS, "--", "/dev/null", file]);
    if ((binary.code === 0 || binary.code === 1) && (text.code === 0 || text.code === 1)) {
      patchParts.push(binary.stdout);
      promptParts.push(text.stdout);
    } else {
      oversizedPaths.push(file);
    }
  }
  const patch = patchParts.join("");
  const hash = createHash("sha256").update(patch).digest("hex");
  return { repoRoot, baseCommit, patch, promptDiff: promptParts.join(""), hash, skippedPaths, oversizedPaths };
}

export async function createReviewWorktree(source: ReviewPatch, label: string, stateDir: string = resolveStateDir()): Promise<ReviewWorktree> {
  const safeLabel = label.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 40) || "member";
  const parent = reviewRoot(stateDir);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  chmodSync(parent, 0o700);
  const realParent = realpathSync(parent);
  const path = join(realParent, `${Date.now()}-${randomBytes(4).toString("hex")}-${safeLabel}`);
  if (existsSync(path)) throw new Error(`review_path_taken: ${path}`);
  const untrack = trackPath(path);

  const remove = async (): Promise<string | undefined> => {
    try {
      if (existsSync(path)) {
        const resolved = realpathSync(path);
        if (!resolved.startsWith(`${realParent}${sep}`)) return `refused to remove ${path}: resolves outside the review directory`;
        rmSync(path, { recursive: true, force: true });
      }
      return existsSync(path) ? `review directory ${path} still exists after removal` : undefined;
    } catch (error) {
      return `could not remove ${path}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300);
    } finally {
      untrack();
    }
  };

  const indexFile = join(realParent, `.${randomBytes(6).toString("hex")}.index`);
  try {
    mkdirSync(path, { mode: 0o700 });
    chmodSync(path, 0o700);
    const indexEnv = { ...cleanEnv(), GIT_INDEX_FILE: indexFile };
    await gitOk(source.repoRoot, ["read-tree", source.baseCommit], { env: indexEnv });
    const filterKeys = (await git(source.repoRoot, ["config", "--name-only", "--get-regexp", "^filter\\..+\\.(smudge|process|required)$"])).stdout.split("\n").filter(Boolean);
    const drivers = [...new Set(filterKeys.map((key) => key.replace(/^filter\./iu, "").replace(/\.(smudge|process|required)$/iu, "")))];
    const rawBlobs = drivers.flatMap((name) => ["-c", `filter.${name}.smudge=`, "-c", `filter.${name}.process=`, "-c", `filter.${name}.required=false`]);
    await gitOk(source.repoRoot, ["checkout-index", "-a", "-f", "-q", `--prefix=${path}/`], { env: indexEnv, extra: ["-c", "core.autocrlf=false", ...rawBlobs] });
    rmSync(indexFile, { force: true });
    const tracked = splitZ(await gitOk(source.repoRoot, ["ls-tree", "-r", "-z", "--name-only", source.baseCommit]));
    for (const file of tracked.filter(isSensitivePath)) rmSync(join(path, file), { recursive: true, force: true });
    const env = isolatedEnv();
    await gitOk(path, ["init", "-q", "--template="], { env, extra: ["-c", "init.defaultBranch=main"] });
    await gitOk(path, ["add", "-A", "-f"], { env, extra: ["-c", "core.autocrlf=false", "-c", "core.safecrlf=false"] });
    await gitOk(path, ["commit", "-q", "--no-verify", "--allow-empty", "-m", "review base"], { env, extra: ["-c", "commit.gpgsign=false"] });
    if (source.patch !== "") await gitOk(path, ["apply", "--binary", "--whitespace=nowarn", "-"], { env, input: source.patch });
  } catch (error) {
    rmSync(indexFile, { force: true });
    await remove();
    throw error;
  }
  const roots = [path];
  try {
    const real = realpathSync(path);
    if (real !== path) roots.push(real);
  } catch {
    roots.push(path);
  }
  return { path, roots, remove };
}
