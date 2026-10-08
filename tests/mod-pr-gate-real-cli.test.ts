import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = Bun.which("ai-harness");
const real = cli ? test : test.skip;
const skipped = cli ? "" : " (skipped: ai-harness is not on PATH)";

const base = realpathSync(mkdtempSync(join(tmpdir(), "pr-gate-real-")));
const state = join(base, "state");
mkdirSync(state);
const env = { ...process.env, AI_HARNESS_TEST_GUARD: "1", AI_HARNESS_STATE_DIR: state };

afterAll(() => rmSync(base, { recursive: true, force: true }));

type Row = { status: string; revision: number; scopes?: unknown[] } | null;

function run(args: string[]): { code: number; out: string; err: string } {
  const ran = Bun.spawnSync(["ai-harness", ...args], { env, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  return { code: ran.exitCode ?? -1, out: ran.stdout.toString().trim(), err: ran.stderr.toString().trim() };
}

function git(cwd: string, ...args: string[]): void {
  const ran = Bun.spawnSync(["git", "-c", "user.name=T", "-c", "user.email=t@example.invalid", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  expect(ran.exitCode).toBe(0);
}

function repo(name: string): string {
  const dir = join(base, name);
  mkdirSync(dir);
  git(dir, "init", "-q", ".");
  git(dir, "commit", "-q", "--allow-empty", "-m", "initial");
  return dir;
}

const argvFile = (name: string, argv: string[]): string => {
  const path = join(base, name);
  writeFileSync(path, JSON.stringify(argv));
  return path;
};

const pass = argvFile("pass.json", ["true"]);
const approve = argvFile("approve.json", ["sh", "-c", "echo fine; echo REVIEW_GATE_VERDICT: APPROVE"]);

const identity = (session: string, cwd: string): string[] => ["--client", "claude", "--session", session, "--cwd", cwd];

const status = (session: string, cwd: string): Row => {
  const ran = run(["review-status", ...identity(session, cwd)]);
  expect(ran.code).toBe(0);
  return JSON.parse(ran.out) as Row;
};

function reachReady(session: string, cwd: string): void {
  const verified = run(["review-verify", ...identity(session, cwd), "--command-json", pass]);
  expect(verified.code).toBe(0);
  const judged = run(["review-judge", ...identity(session, cwd), "--command-json", approve, "--timeout-ms", "20000"]);
  expect(judged.code).toBe(0);
  expect(status(session, cwd)?.status).toBe("ready");
}

real(`a sandboxed state directory is used and an identity no review wrote reads null${skipped}`, () => {
  const dir = repo("fresh");
  expect(status("jev-review-neverused", dir)).toBeNull();
  const missing = run(["review-status", "--client", "claude", "--cwd", dir]);
  expect(missing.code).toBe(1);
  expect(missing.out).toBe("");
  expect(JSON.parse(missing.err)).toEqual({ error: "missing_session" });
}, 90_000);

real(`a ready review turns pending_verification once the reviewed content is committed${skipped}`, () => {
  const dir = repo("commit-after");
  writeFileSync(join(dir, "a.txt"), "reviewed\n");
  reachReady("jev-review-commit1", dir);
  const before = status("jev-review-commit1", dir);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "reviewed content");
  const after = status("jev-review-commit1", dir);
  expect(after?.status).toBe("pending_verification");
  expect(after?.revision).toBeGreaterThan(before?.revision ?? 0);
  expect(after?.scopes).toEqual([]);
  expect(status("jev-review-commit1", dir)?.status).toBe("pending_verification");
}, 90_000);

real(`a ready review turns pending_verification when a new untracked file appears${skipped}`, () => {
  const dir = repo("untracked");
  writeFileSync(join(dir, "a.txt"), "reviewed\n");
  reachReady("jev-review-untrk1", dir);
  writeFileSync(join(dir, "b.txt"), "new file\n");
  expect(status("jev-review-untrk1", dir)?.status).toBe("pending_verification");
}, 90_000);

real(`committing first and reviewing after stays ready across branch, remote and config changes${skipped}`, () => {
  const dir = repo("review-after");
  writeFileSync(join(dir, "a.txt"), "content\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "content");
  reachReady("jev-review-after1", dir);
  git(dir, "branch", "other");
  git(dir, "remote", "add", "origin", "https://example.invalid/acme/app.git");
  git(dir, "config", "pr-gate.probe", "1");
  expect(status("jev-review-after1", dir)?.status).toBe("ready");
  expect(status("jev-review-after1", dir)?.status).toBe("ready");
}, 90_000);

real(`every stored status is one of the four the gate understands${skipped}`, () => {
  const dir = repo("vocabulary");
  const seen = new Set<string>();
  const verified = run(["review-verify", ...identity("jev-review-vocab01", dir), "--command-json", pass]);
  expect(verified.code).toBe(0);
  seen.add(JSON.parse(verified.out).status);
  reachReady("jev-review-vocab02", dir);
  seen.add(status("jev-review-vocab02", dir)?.status as string);
  writeFileSync(join(dir, "c.txt"), "x\n");
  seen.add(status("jev-review-vocab02", dir)?.status as string);
  expect([...seen].sort()).toEqual(["pending_review", "pending_verification", "ready"]);
  for (const one of seen) expect(one).toMatch(/^[a-z_]{1,40}$/);
}, 90_000);
