import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveBaseClientKind } from "../src/config/aliases.js";
import { parseListLimit, peerBroadcastFailed } from "../src/cli-support.js";
import { readUsageQuota } from "../src/harness/bridge.js";
import { buildJudgePrompt, formatReviewReport, listChangedFiles, parseHunkRanges, runReview, splitOversizedScopes, type ReviewScope } from "../src/harness/review.js";
import { formatRunHistory, mergeRunHistory } from "../src/orchestration/run-history.js";
import { createFakeHarness, fakeHarnessCommands, fakeJudgePids, type FakeHarness, type FakeHarnessMode } from "./fake-harness.js";
import { assertNoRealHomeStateLeaks, createTempHome, createTestStateDir } from "./helpers.js";

const CLI = resolve(import.meta.dir, "../src/cli.ts");
const ROOT = resolve(import.meta.dir, "..");
const ESC = String.fromCharCode(27);

let testEnv: { stateDir: string; cleanup: () => void };
let harness: FakeHarness | undefined;
let repo: string;
let scratch: string;

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8" });
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

function write(path: string, content: string, base = repo) {
  mkdirSync(dirname(join(base, path)), { recursive: true });
  writeFileSync(join(base, path), content);
}

function seed(extraBase: Record<string, string> = {}) {
  git(repo, "init", "-q", "-b", "main");
  write("package.json", JSON.stringify({ scripts: { test: "bun test" } }));
  write("src/a.ts", "export const a = 1;\n");
  write("docs/x.md", "doc\n");
  for (const [path, content] of Object.entries(extraBase)) write(path, content);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "checkout", "-q", "-b", "feature");
  write("src/a.ts", "export const a = 2;\n");
  write("src/b.ts", "export const b = 1;\n");
}

function install(mode: FakeHarnessMode = "contract", env: Record<string, string> = {}) {
  harness = createFakeHarness(mode, { FAKE_PROFILE: "1", ...env });
}

function cliEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, HOME: createTempHome(), HERDR_ENV: "0", TYPESAFE_API_KEY: "", ...extra };
}

function reviewRoot(): string {
  return join(testEnv.stateDir, "review");
}

function unlockReviewDirs() {
  if (!existsSync(reviewRoot())) return;
  for (const entry of readdirSync(reviewRoot())) {
    try { chmodSync(join(reviewRoot(), entry), 0o700); } catch {}
  }
}

async function until(check: () => boolean, label: string, limitMs = 60_000): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

beforeEach(() => {
  testEnv = createTestStateDir();
  repo = realpathSync(mkdtempSync(join(tmpdir(), "review3-repo-")));
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "review3-scratch-")));
});

afterEach(() => {
  unlockReviewDirs();
  if (harness) {
    for (const entry of fakeJudgePids(harness)) {
      if (alive(entry.pid)) { try { process.kill(entry.pid, "SIGKILL"); } catch {} }
    }
  }
  harness?.restore();
  harness = undefined;
  rmSync(repo, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
  testEnv.cleanup();
  assertNoRealHomeStateLeaks();
});

describe("should fix 1: judge command files are named by index", () => {
  it("scopes whose names differ only by case never share a command file", async () => {
    seed();
    install();
    const report = await runReview({ cwd: repo, client: "codex", session: "case-1", scopes: "Docs=docs;docs=src" });
    expect(report.status).toBe("ready");
    const judges = fakeHarnessCommands(harness!).filter((entry) => entry.command === "review-judge");
    expect(judges).toHaveLength(2);
    const files = judges.map((entry) => entry.file);
    expect(new Set(files.map((file) => file.toLowerCase())).size).toBe(2);
    for (const entry of judges) expect(entry.argv.some((part) => part.includes(`Review scope "${entry.scope}"`))).toBe(true);
  });
});

describe("should fix 2: cleanup never replaces the outcome and stops in-flight judges", () => {
  const manyScopes = Array.from({ length: 5 }, (_, index) => `s${index + 1}=src`).join(";");

  it("a failing cleanup does not replace a completed report", async () => {
    if (process.getuid?.() === 0) return;
    seed();
    install("contract", { FAKE_LOCK_DIR_AFTER: "s1", FAKE_LOCK_AFTER_STARTED: "2" });
    const report = await runReview({ cwd: repo, client: "codex", session: "rm-1", scopes: "s1=src;s2=src" });
    expect(report.status).toBe("ready");
    expect(report.judges).toHaveLength(2);
  }, 120_000);

  it("a lane that throws mid-run surfaces its own error and kills the judges still running", async () => {
    if (process.getuid?.() === 0) return;
    seed();
    install("contract", { FAKE_JUDGE_SLEEP_MS: "600000", FAKE_SLEEP_SCOPES: "s2,s3,s4", FAKE_LOCK_DIR_AFTER: "s1", FAKE_LOCK_AFTER_STARTED: "4" });
    const error = await runReview({ cwd: repo, client: "codex", session: "lane-1", scopes: manyScopes }).then(() => null, (thrown) => thrown as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toContain("judge-4.json");
    const running = fakeJudgePids(harness!).filter((entry) => entry.scope !== "s1");
    expect(running).toHaveLength(3);
    await until(() => running.every((entry) => !alive(entry.pid)), "the in-flight judges to be stopped");
  }, 120_000);
});

describe("should fix 3: the ranges map has no prototype keys", () => {
  const diff = (file: string, hunks: number) => [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`,
    ...Array.from({ length: hunks }, (_, index) => `@@ -${index * 3 + 1} +${index * 3 + 1},2 @@`)].join("\n");

  it("parses hunks of files named like Object.prototype members", () => {
    for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      const ranges = parseHunkRanges(diff(name, 1));
      expect(Object.hasOwn(ranges, name)).toBe(true);
      expect(ranges[name]).toEqual(["1-2"]);
    }
  });

  it("counts dropped ranges of such a file without corrupting the note", () => {
    const key: string = "constructor";
    const list = parseHunkRanges(diff(key, 23))[key]!;
    expect(list).toHaveLength(21);
    expect(list[20]).toBe("and 3 more ranges");
  });

  it("a prompt for such a file without known ranges lists only its name", () => {
    const scope: ReviewScope = { name: "root", files: ["constructor", "toString"], changed: ["constructor", "toString"] };
    const prompt = buildJudgePrompt(scope, "main", {});
    expect(prompt).toContain('- "constructor"\n');
    expect(prompt).toContain('- "toString"\n');
    expect(prompt).not.toContain("lines ");
  });

  it("the review of a change to such files completes", async () => {
    const names = ["constructor", "toString", "valueOf", "__proto__"];
    seed(Object.fromEntries(names.map((name) => [name, "one\n"])));
    for (const name of names) write(name, "one\ntwo\n");
    const key: string = "constructor";
    expect(listChangedFiles(repo).ranges[key]).toEqual(["2"]);
    install();
    const report = await runReview({ cwd: repo, client: "codex", session: "proto-1", scopes: "core=src;rest=constructor,toString,valueOf,__proto__" });
    expect(report.status).toBe("ready");
    const prompts = fakeHarnessCommands(harness!).filter((entry) => entry.command === "review-judge").map((entry) => entry.argv.join("\n"));
    expect(prompts.some((prompt) => prompt.includes('- "constructor": lines 2'))).toBe(true);
  });
});

describe("lower 4: findings shapes are validated", () => {
  const bad: Array<[string, string]> = [
    ["a scopes value that is not an array", '{"status":"ready","scopes":{"a":1}}'],
    ["a null scope item", '{"status":"ready","scopes":[null]}'],
    ["a scope with a numeric name", '{"status":"ready","scopes":[{"name":5,"verdict":"APPROVE"}]}'],
    ["a scope with a non-string verdict", '{"status":"ready","scopes":[{"name":"a","verdict":{}}]}'],
    ["a non-string status", '{"status":7,"scopes":[]}'],
    ["a null document", "null"],
  ];
  for (const [label, raw] of bad) {
    it(`keeps the report when the harness returns ${label}`, async () => {
      seed();
      install("contract", { FAKE_FINDINGS_RAW: raw });
      const report = await runReview({ cwd: repo, client: "codex", session: "shape-1", scopes: "core=src" });
      expect(report.judges).toHaveLength(1);
      expect(report.findings).toBeUndefined();
      expect(report.status).toBe("ready");
      expect(() => formatReviewReport(report)).not.toThrow();
    });
  }
});

describe("lower 5: a degraded quota path does not pay the timeout again when the file is rewritten", () => {
  it("asks the hung harness once while the usage file keeps changing", () => {
    install("contract", { FAKE_HANG: "quota-normalize" });
    const future = Math.floor(Date.now() / 1000) + 3600;
    const path = join(scratch, "quota.json");
    const body = (remaining: number) => JSON.stringify({ fetched_at_unix: Math.floor(Date.now() / 1000), account_id: "acct", windows: [{ remaining_percent: remaining, resets_at: future }] });
    writeFileSync(path, body(0));
    const first = readUsageQuota(path, 800) as any[];
    expect(first[0].status).toBe("exhausted");
    expect(harness!.callsFor("quota-normalize")).toHaveLength(1);
    writeFileSync(path, body(55) + " ");
    const second = readUsageQuota(path, 800) as any[];
    expect(second[0]).toMatchObject({ status: "unknown", source: "local_fallback" });
    writeFileSync(path, body(40) + "  ");
    readUsageQuota(path, 800);
    expect(harness!.callsFor("quota-normalize")).toHaveLength(1);
  }, 60_000);
});

describe("lower 6: the unscoped fallback merges overlapping scopes without duplicates", () => {
  it("counts and lists each file once", async () => {
    seed();
    install("legacy");
    const report = await runReview({ cwd: repo, client: "codex", session: "dedupe-1", scopes: "a=src;b=src/a.ts" });
    expect(report.degraded).toBe("scopes_unsupported");
    expect(report.scopes).toEqual([{ name: "default", fileCount: 2 }]);
    const prompt = fakeHarnessCommands(harness!).filter((entry) => entry.command === "review-judge")[0]!.argv.join("\n");
    expect(prompt.split('"src/a.ts"').length - 1).toBe(1);
  });
});

describe("lower 7: a diff larger than the buffer still lists the files", () => {
  it("drops the line ranges instead of aborting", () => {
    seed();
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "work");
    write("big.txt", "x\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "big");
    write("big.txt", "0123456789abcdef\n".repeat(1_300_000));
    const changed = listChangedFiles(repo);
    expect(changed.files).toContain("big.txt");
    expect(changed.files).toContain("src/a.ts");
    expect(changed.ranges["big.txt"]).toBeUndefined();
  }, 120_000);
});

describe("lower 8: sensitive files committed in the range are refused", () => {
  it("flags a committed key and names a remedy that is not committing", async () => {
    seed();
    write(".env", "TOKEN=placeholder\n");
    git(repo, "add", "-f", "-A");
    git(repo, "commit", "-q", "-m", "work");
    const changed = listChangedFiles(repo);
    expect(changed.sensitive).toEqual([".env"]);
    expect(changed.sensitiveCommitted).toEqual([".env"]);
    install();
    const error = await runReview({ cwd: repo, client: "codex", session: "sens-1" }).then(() => null, (thrown) => thrown as Error);
    expect(error!.message).toContain('sensitive_committed_files: ".env"');
    expect(error!.message).not.toMatch(/ignore, commit/);
    expect(harness!.callsFor("review-verify")).toHaveLength(0);
  });

  it("an uncommitted secret keeps its code and no longer suggests committing it", async () => {
    seed();
    write(".env", "TOKEN=placeholder\n");
    git(repo, "add", "-f", ".env");
    install();
    const error = await runReview({ cwd: repo, client: "codex", session: "sens-2" }).then(() => null, (thrown) => thrown as Error);
    expect(error!.message).toContain('sensitive_uncommitted_files: ".env"');
    expect(error!.message).toBe('sensitive_uncommitted_files: ".env"; ignore or remove them before the review');
  });

  it("does not flag a secret that is older than the base", () => {
    seed();
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "work");
    write("keys/server.pem", "x\n");
    git(repo, "add", "-f", "-A");
    git(repo, "commit", "-q", "-m", "key");
    expect(listChangedFiles(repo, "HEAD").sensitive).toEqual([]);
  });
});

describe("lower 9: the prompt of one judge stays under the argument limit", () => {
  const long = (char: string, extra = "") => `${char.repeat(240)}${extra}`;

  it("splits a scope by prompt size, keeping every file", () => {
    const files = Array.from({ length: 200 }, (_, index) => `${long("a")}/${long("b")}/${long("c", `-${index}`)}.ts`);
    const ranges: Record<string, string[]> = {};
    for (const file of files) ranges[file] = Array.from({ length: 20 }, (_, index) => `${index * 10 + 1}-${index * 10 + 5}`);
    const scopes = splitOversizedScopes([{ name: "big", files, changed: files }], ranges);
    expect(scopes.length).toBeGreaterThan(1);
    expect(scopes.flatMap((scope) => scope.files)).toEqual(files);
    for (const scope of scopes) expect(Buffer.byteLength(buildJudgePrompt(scope, "main", ranges))).toBeLessThan(120_000);
  });

  it("the review sends several judges instead of one oversized prompt", async () => {
    seed();
    for (let index = 0; index < 200; index++) write(`${long("d")}/${long("e")}/${long("f", `-${index}`)}.txt`, "x\n");
    install();
    const report = await runReview({ cwd: repo, client: "codex", session: "size-1" });
    expect(report.status).toBe("ready");
    expect(report.scopes.reduce((total, scope) => total + scope.fileCount, 0)).toBe(202);
    const judges = fakeHarnessCommands(harness!).filter((entry) => entry.command === "review-judge");
    expect(judges.length).toBeGreaterThanOrEqual(2);
    for (const entry of judges) {
      const prompt = entry.argv.find((part) => part.includes("Review scope"))!;
      expect(Buffer.byteLength(prompt)).toBeLessThan(120_000);
    }
  }, 120_000);
});

function seedHarnessRuns(runs: unknown[]) {
  writeFileSync(join(harness!.dir, "state.json"), JSON.stringify({ runs, reviews: {} }));
}

describe("uncovered 3 and 4: runs list degrades and prints safely", () => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

  it("merges runs whose stages are not arrays or hold null items", () => {
    const entries = mergeRunHistory([], [
      { id: id(1), kind: "worker", stages: "oops" } as any,
      { id: id(2), kind: "worker", stages: [null, { role: "implementer", state: 5 }, { role: "reviewer", state: "done" }] } as any,
      null as any,
      { id: 7 } as any,
    ]);
    expect(entries.map((entry) => entry.id).sort()).toEqual([id(1), id(2)]);
    expect(entries.map((entry) => formatRunHistory(entry)).join("\n")).toContain("reviewer:done");
  });

  it("strips terminal sequences and line breaks from harness supplied fields", () => {
    const entries = mergeRunHistory([], [{ id: id(1), kind: `wor${ESC}[31mker`, cwd: `/tmp/x${ESC}]0;title\u0007\nINJECTED`, createdAt: "2026-10-01T00:00:00.000Z",
      stages: [{ role: `impl${ESC}[2J`, state: "wor\nking" }] } as any]);
    const line = formatRunHistory(entries[0]!);
    expect(line.includes(ESC)).toBe(false);
    expect(line.includes("\n")).toBe(false);
    expect(line).toContain("INJECTED");
  });

  it("the runs list command survives malformed harness runs and prints one clean line each", () => {
    install();
    seedHarnessRuns([
      { id: id(1), kind: `wor${ESC}[31mker`, cwd: `/tmp/x${ESC}]0;t\u0007\nINJECTED`, createdAt: "2026-10-01T00:00:00.000Z", stages: [{ role: `impl${ESC}[2J`, state: "working" }] },
      { id: id(2), kind: "worker", cwd: "/tmp/y", createdAt: "2026-10-01T00:01:00.000Z", stages: "oops" },
      { id: id(3), kind: "worker", cwd: "/tmp/z", createdAt: "2026-10-01T00:02:00.000Z", stages: [null, 3] },
    ]);
    const result = spawnSync(process.execPath, [CLI, "runs", "list"], { encoding: "utf8", env: cliEnv(), cwd: scratch, timeout: 120_000 });
    expect(result.status).toBe(0);
    expect(result.stdout.includes(ESC)).toBe(false);
    const lines = result.stdout.split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    for (const entry of [id(1), id(2), id(3)]) expect(lines.filter((line) => line.startsWith(entry))).toHaveLength(1);
  }, 120_000);
});

describe("uncovered 5: prototype keys are not clients", () => {
  it("resolves them to the default client and refuses them in models catalog", () => {
    for (const name of ["constructor", "toString", "__proto__"]) expect(resolveBaseClientKind(name)).toBe("claude");
    for (const name of ["constructor", "__proto__"]) {
      const result = spawnSync(process.execPath, [CLI, "models", "catalog", name], { encoding: "utf8", env: cliEnv(), cwd: scratch, timeout: 120_000 });
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stderr.trim().split("\n").pop()!)).toMatchObject({ error: "unknown_client", client: name });
    }
  }, 120_000);
});

describe("uncovered 8: spawned CLI tests do not load the repository .env", () => {
  it("ignores a .env next to the sources while the test guard is active", () => {
    const copy = join(scratch, "copy");
    mkdirSync(join(copy, "src"), { recursive: true });
    cpSync(join(ROOT, "src"), join(copy, "src"), { recursive: true });
    cpSync(join(ROOT, "config"), join(copy, "config"), { recursive: true });
    cpSync(join(ROOT, "package.json"), join(copy, "package.json"));
    symlinkSync(join(ROOT, "node_modules"), join(copy, "node_modules"));
    writeFileSync(join(copy, ".env"), "HERDR_JEV_SPLIT_DIRECTION=down\n");
    const env = cliEnv();
    delete env.HERDR_JEV_SPLIT_DIRECTION;
    expect(env.HERDR_JEV_TEST_GUARD).toBe("1");
    const guarded = spawnSync(process.execPath, [join(copy, "src/cli.ts"), "status"], { encoding: "utf8", env, cwd: scratch, timeout: 120_000 });
    expect(guarded.status).toBe(0);
    expect(guarded.stdout).toContain("Split Direction: Auto");
    expect(guarded.stdout).not.toMatch(/Split Direction: Down/i);
  }, 120_000);
});

describe("uncovered 10 and 11: command argument handling", () => {
  it("treats a broadcast result that is not a clean acknowledged array as a failure", () => {
    expect(peerBroadcastFailed("[]")).toBe(false);
    expect(peerBroadcastFailed('[{"acknowledged":true}]')).toBe(false);
    expect(peerBroadcastFailed('[{"acknowledged":false}]')).toBe(true);
    expect(peerBroadcastFailed("[null]")).toBe(true);
    expect(peerBroadcastFailed('{"error":"x"}')).toBe(true);
    expect(peerBroadcastFailed("not json")).toBe(true);
  });

  it("validates the list limit", () => {
    expect(parseListLimit("20")).toBe(20);
    expect(parseListLimit("0")).toBe(0);
    for (const bad of ["abc", "", "-1", "1.5", "1e3", "99999999999999999999"]) expect(() => parseListLimit(bad)).toThrow("invalid_limit");
  });

  it("runs list reports a non-numeric limit without a stack trace", () => {
    install();
    const result = spawnSync(process.execPath, [CLI, "runs", "list", "--limit", "abc"], { encoding: "utf8", env: cliEnv(), cwd: scratch, timeout: 120_000 });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr.trim())).toEqual({ error: "invalid_limit" });
    expect(result.stderr).not.toContain("    at ");
  }, 120_000);
});
