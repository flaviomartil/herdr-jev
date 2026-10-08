import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveStateDir } from "../herdr/state-dir.js";

const SECRET_NAME = /(?:^|\/)\.env[^/]*$|\.(?:pem|key)$|secret|credential/iu;
const MAX_UNTRACKED_BYTES = 5 * 1024 * 1024;
const DIFF_FLAGS = ["--binary", "--no-ext-diff", "--no-color", "--src-prefix=a/", "--dst-prefix=b/"];

export interface ReviewPatch {
  repoRoot: string;
  baseCommit: string;
  patch: string;
  hash: string;
  skippedUntracked: number;
}

export interface ReviewWorktree {
  path: string;
  roots: string[];
  remove(): Promise<void>;
}

export function isSecretLikePath(path: string): boolean {
  return SECRET_NAME.test(path);
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: string[], input?: string): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", ["-c", "core.quotePath=false", ...args], { cwd, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => resolve({ code: 127, stdout: "", stderr: error.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
    if (input !== undefined && child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(input);
    }
  });
}

async function gitOk(cwd: string, args: string[], input?: string): Promise<string> {
  const result = await git(cwd, args, input);
  if (result.code !== 0) throw new Error(`git_failed: git ${args[0]} exited ${result.code}: ${result.stderr.trim().split("\n")[0] ?? ""}`.slice(0, 300));
  return result.stdout;
}

export async function buildReviewPatch(cwd: string, base?: string): Promise<ReviewPatch> {
  const repoRoot = (await gitOk(cwd, ["rev-parse", "--show-toplevel"])).trim();
  let baseCommit = (await gitOk(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
  if (base) {
    const head = baseCommit;
    baseCommit = (await gitOk(repoRoot, ["merge-base", base, head])).trim();
  }
  const tracked = await gitOk(repoRoot, ["diff", baseCommit, ...DIFF_FLAGS]);
  const untracked = (await gitOk(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter((entry) => entry !== "" && !entry.endsWith("/"));
  const sections: string[] = [tracked];
  let skippedUntracked = 0;
  for (const file of untracked) {
    if (isSecretLikePath(file)) {
      skippedUntracked += 1;
      continue;
    }
    let size = 0;
    try {
      size = statSync(join(repoRoot, file)).size;
    } catch {
      skippedUntracked += 1;
      continue;
    }
    if (size > MAX_UNTRACKED_BYTES) {
      skippedUntracked += 1;
      continue;
    }
    const added = await git(repoRoot, ["diff", "--no-index", ...DIFF_FLAGS, "--", "/dev/null", file]);
    if (added.code === 0 || added.code === 1) sections.push(added.stdout);
    else skippedUntracked += 1;
  }
  const patch = sections.join("");
  const hash = createHash("sha256").update(patch).digest("hex");
  return { repoRoot, baseCommit, patch, hash, skippedUntracked };
}

export async function createReviewWorktree(source: ReviewPatch, label: string, stateDir: string = resolveStateDir()): Promise<ReviewWorktree> {
  const safeLabel = label.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 40) || "member";
  const parent = join(stateDir, "council");
  mkdirSync(parent, { recursive: true });
  const path = join(parent, `${Date.now()}-${randomBytes(4).toString("hex")}-${safeLabel}`);
  const listing = await gitOk(source.repoRoot, ["worktree", "list", "--porcelain"]);
  if (existsSync(path) || listing.includes(`worktree ${path}\n`)) throw new Error(`worktree_path_taken: ${path}`);

  const remove = async () => {
    await git(source.repoRoot, ["worktree", "remove", "--force", path]);
    rmSync(path, { recursive: true, force: true });
    await git(source.repoRoot, ["worktree", "prune"]);
  };

  await gitOk(source.repoRoot, ["worktree", "add", "--detach", path, source.baseCommit]);
  try {
    if (source.patch !== "") await gitOk(path, ["apply", "--binary", "--whitespace=nowarn", "-"], source.patch);
  } catch (error) {
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
