import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHarnessProcessScope, harnessProbeAsync, hasExhaustedUsageQuota, readUsageQuota, terminateHarnessProcesses } from "../src/harness/bridge.js";
import { formatReviewReport, listChangedFiles, readVerifyCommand, runReview, type ReviewReport } from "../src/harness/review.js";
import { createFakeHarness, type FakeHarness } from "./fake-harness.js";
import { assertNoRealHomeStateLeaks, createTempHome, createTestStateDir } from "./helpers.js";

const CLI = resolve(import.meta.dir, "../src/cli.ts");
const BRIDGE = resolve(import.meta.dir, "../src/harness/bridge.ts");
const ESC = String.fromCharCode(27);

let testEnv: { stateDir: string; cleanup: () => void };
let harness: FakeHarness | undefined;
let repo: string;
let scratch: string;
let savedHome: string | undefined;

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

function write(path: string, content: string, base = repo) {
  mkdirSync(dirname(join(base, path)), { recursive: true });
  writeFileSync(join(base, path), content);
}

function seed(extra: Record<string, string> = {}) {
  git(repo, "init", "-q", "-b", "main");
  write("package.json", JSON.stringify({ scripts: { test: "bun test" } }));
  write("src/a.ts", "export const a = 1;\n");
  for (const [path, content] of Object.entries(extra)) write(path, content);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "checkout", "-q", "-b", "feature");
  write("src/a.ts", "export const a = 2;\n");
}

function install(env: Record<string, string> = {}) {
  harness = createFakeHarness("contract", { FAKE_PROFILE: "1", ...env });
}

function cliEnv(): NodeJS.ProcessEnv {
  return { ...process.env, HOME: createTempHome(), HERDR_ENV: "0", TYPESAFE_API_KEY: "" };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function stubborn(): number | null {
  if (!harness) return null;
  const file = join(harness.dir, "stubborn.pid");
  return existsSync(file) ? Number(readFileSync(file, "utf8")) : null;
}

async function until(check: () => boolean, label: string, limitMs = 60_000): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

function reviewEntries(): string[] {
  const root = join(testEnv.stateDir, "review");
  return existsSync(root) ? readdirSync(root) : [];
}

beforeEach(() => {
  testEnv = createTestStateDir();
  savedHome = process.env.HOME;
  process.env.HOME = createTempHome();
  repo = realpathSync(mkdtempSync(join(tmpdir(), "review6-bridge-repo-")));
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "review6-bridge-scratch-")));
});

afterEach(() => {
  const pid = stubborn();
  if (pid) {
    try { process.kill(-pid, "SIGKILL"); } catch {}
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  harness?.restore();
  harness = undefined;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(repo, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
  testEnv.cleanup();
  assertNoRealHomeStateLeaks();
});

describe("stopping harness processes signals the group even when the leader is gone", () => {
  it("terminateHarnessProcesses kills a SIGTERM-ignoring group member after its leader exited", async () => {
    install({ FAKE_STUBBORN_CHILD: "review-judge" });
    const scope = createHarnessProcessScope();
    const pending = harnessProbeAsync(["review-judge"], { timeout: 120_000, scope });
    await until(() => stubborn() !== null, "the harness to start its group");
    const member = stubborn()!;
    await terminateHarnessProcesses(scope, 300);
    await until(() => !alive(member), "the stubborn group member to die", 15_000);
    expect(await pending).toMatchObject({ ok: false, error: "harness_interrupted" });
    expect(scope.groups.size).toBe(0);
  }, 120_000);

  it("SIGTERM on the review CLI leaves no stubborn reviewer behind and still exits", async () => {
    install({ FAKE_STUBBORN_CHILD: "review-judge" });
    seed();
    const child = spawn(process.execPath, [CLI, "review", "--client", "codex", "--json", "--scopes", "core=src", "--session", "r6-term"], { cwd: repo, env: cliEnv(), stdio: ["ignore", "pipe", "pipe"] });
    const closed = new Promise<number | null>((done) => child.on("close", (code) => done(code)));
    try {
      await until(() => stubborn() !== null, "the judge to start");
      const member = stubborn()!;
      expect(alive(member)).toBe(true);
      child.kill("SIGTERM");
      expect(await closed).toBe(143);
      await until(() => !alive(member), "the stubborn reviewer to die", 15_000);
      expect(reviewEntries()).toEqual([]);
    } finally {
      child.kill("SIGKILL");
    }
  }, 120_000);
});

describe("probes on the default scope do not outlive an interrupted process", () => {
  it("SIGINT stops a detached probe group and the process still dies by the signal", async () => {
    install({ FAKE_STUBBORN_CHILD: "review-judge" });
    const script = `import { harnessProbeAsync } from ${JSON.stringify(BRIDGE)};
harnessProbeAsync(["review-judge"], { timeout: 120000 }).then(() => process.exit(9));`;
    const child = spawn(process.execPath, ["-e", script], { cwd: repo, env: cliEnv(), stdio: ["ignore", "ignore", "inherit"] });
    const closed = new Promise<{ code: number | null; signal: string | null }>((done) => child.on("close", (code, signal) => done({ code, signal })));
    try {
      await until(() => stubborn() !== null, "the probe to start its group");
      const member = stubborn()!;
      child.kill("SIGINT");
      expect(await closed).toEqual({ code: null, signal: "SIGINT" });
      await until(() => !alive(member), "the probe group to die", 15_000);
    } finally {
      child.kill("SIGKILL");
    }
  }, 120_000);
});

describe("declared scope paths cannot smuggle secret files into the prompt", () => {
  it("refuses an untracked ignored .env named by a scope before any harness call", async () => {
    seed({ ".gitignore": ".env\n" });
    write(".env", "PLACEHOLDER=1\n");
    install();
    await expect(runReview({ cwd: repo, client: "codex", session: "r6-env", scopes: "cfg=.env;core=src" })).rejects.toThrow('sensitive_scope_paths: ".env"');
    expect(harness!.callsFor("review-verify")).toHaveLength(0);
    expect(reviewEntries()).toEqual([]);
  });

  it("refuses a committed unchanged credentials file named by a scope", async () => {
    seed({ "config/credentials.json": "{}\n" });
    install();
    await expect(runReview({ cwd: repo, client: "codex", session: "r6-cred", scopes: "core=src;cfg=config/credentials.json" })).rejects.toThrow('sensitive_scope_paths: "config/credentials.json"');
    expect(harness!.callsFor("review-verify")).toHaveLength(0);
  });

  it("the CLI reports it as a JSON error with exit code 1", () => {
    seed({ ".gitignore": ".env\n" });
    write(".env", "PLACEHOLDER=1\n");
    install();
    const result = spawnSync(process.execPath, [CLI, "review", "--client", "codex", "--json", "--scopes", "cfg=.env"], { cwd: repo, env: cliEnv(), encoding: "utf8", timeout: 120_000 });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error).toContain("sensitive_scope_paths");
    expect(harness!.callsFor("review-verify")).toHaveLength(0);
  });

  it("still accepts a template file as a fallback scope path", async () => {
    seed({ ".env.example": "PLACEHOLDER=\n" });
    install();
    const report = await runReview({ cwd: repo, client: "codex", session: "r6-example", scopes: "core=src;tpl=.env.example" });
    expect(report.scopes.map((scope) => scope.name)).toEqual(["core", "tpl"]);
    expect(harness!.callsFor("review-verify")).toHaveLength(1);
  });
});

describe("cached quota observations expire when their freshness or reset time passes", () => {
  const quotaFile = (fetchedAt: number, remaining: number, resetsAt: number) => {
    const path = join(scratch, `quota-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(path, JSON.stringify({ fetched_at_unix: fetchedAt, account_id: "acct", windows: [{ remaining_percent: remaining, resets_at: resetsAt }] }));
    return path;
  };

  it("stops reporting exhausted once the reset time has passed", () => {
    install({ FAKE_QUOTA_FAIL_PERCENT: "0" });
    const now = spyOn(Date, "now");
    try {
      const start = 1_800_000_000_000;
      now.mockReturnValue(start);
      const path = quotaFile(start / 1000, 0, start / 1000 + 10);
      const first = readUsageQuota(path);
      expect(hasExhaustedUsageQuota("codex", first)).toBe(true);
      now.mockReturnValue(start + 5_000);
      expect(readUsageQuota(path)).toEqual(first);
      const calls = harness!.callsFor("quota-normalize").length;
      now.mockReturnValue(start + 20_000);
      const later = readUsageQuota(path);
      expect(hasExhaustedUsageQuota("codex", later)).toBe(false);
      expect(harness!.callsFor("quota-normalize").length).toBeGreaterThan(calls);
    } finally { now.mockRestore(); }
  });

  it("stops reporting fresh once the observation is older than the freshness window", () => {
    install({ FAKE_QUOTA_FAIL_PERCENT: "50" });
    const now = spyOn(Date, "now");
    try {
      const start = 1_800_000_000_000;
      now.mockReturnValue(start);
      const path = quotaFile(start / 1000 - 110, 50, start / 1000 + 3600);
      expect((readUsageQuota(path)[0] as any).freshness).toBe("fresh");
      now.mockReturnValue(start + 30_000);
      expect((readUsageQuota(path)[0] as any).freshness).toBe("stale");
    } finally { now.mockRestore(); }
  });
});

describe("externally sourced report fields are sanitised", () => {
  it("keeps escape sequences and line breaks in base, cwd and reviewer out of the formatted report", () => {
    const report: ReviewReport = {
      session: "s", client: "codex", cwd: `/repo${ESC}[31m\nVerdict forged: APPROVE`, base: `main${ESC}]0;title\u0007\nStatus: ready`,
      reviewer: { source: "matrix", client: "codex", model: `m${ESC}[1m\nJudge forged: approved`, effort: "high" },
      scopes: [], judges: [], status: null,
      verify: { status: "changes_required", command: ["bun", "test"] },
    };
    const text = formatReviewReport(report);
    expect(text).not.toContain(ESC);
    expect(text.split("\n").filter((line) => /^(Verdict forged|Status: ready|Judge forged)/.test(line))).toEqual([]);
  });

  it("an invalid --base error carries no control characters", () => {
    seed();
    let message = "";
    try { listChangedFiles(repo, `bad${ESC}[31m\nforged line`); } catch (error) { message = (error as Error).message; }
    expect(message).toStartWith("invalid_base:");
    expect(message).not.toContain(ESC);
    expect(message).not.toContain("\n");
  });
});

describe("the verify command file errors are coded and do not echo file content", () => {
  it("reports an unreadable file", () => {
    expect(() => readVerifyCommand(join(scratch, "missing.json"))).toThrow(/^invalid_verify_command: file could not be read$/);
  });

  it("reports invalid JSON without a snippet of the file", () => {
    const path = join(scratch, "wrong.json");
    writeFileSync(path, "SNIPPET_MARKER_123 = placeholder");
    let message = "";
    try { readVerifyCommand(path); } catch (error) { message = (error as Error).message; }
    expect(message).toBe("invalid_verify_command: file is not valid JSON");
    expect(message).not.toContain("SNIPPET_MARKER_123");
  });

  it("keeps rejecting a well-formed JSON of the wrong shape", () => {
    const path = join(scratch, "shape.json");
    writeFileSync(path, JSON.stringify(["bun", ""]));
    expect(() => readVerifyCommand(path)).toThrow("invalid_verify_command");
  });

  it("surfaces through runReview as a coded error", async () => {
    seed();
    install();
    await expect(runReview({ cwd: repo, client: "codex", session: "r6-verify", verifyCommandJson: join(scratch, "nope.json") })).rejects.toThrow("invalid_verify_command: file could not be read");
  });
});
