import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  createHarnessProcessScope, harnessCommand, harnessProbe, harnessProbeAsync, hasExhaustedUsageQuota, interruptHarnessProcesses,
  readUsageQuota, resetHarnessCaches, terminateHarnessProcesses,
} from "../src/harness/bridge.js";
import { formatReviewReport, runReview } from "../src/harness/review.js";
import { assertNoRealHomeStateLeaks, createTempHome, createTestStateDir } from "./helpers.js";

const CLI = resolve(import.meta.dir, "../src/cli.ts");

const SCRIPT = `#!${process.execPath}
import { appendFileSync, copyFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

const argv = process.argv.slice(2);
const command = argv[0];
const dir = process.env.FAKE5_DIR;
const mode = process.env.FAKE5_MODE || "";
const option = (name) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
const pretty = (value) => process.stdout.write(JSON.stringify(value, null, 2) + "\\n");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
appendFileSync(join(dir, "calls.log"), command + "\\n");

if (process.env.FAKE5_HANG && process.env.FAKE5_HANG === command) {
  const child = spawn("sleep", ["120"], { detached: true, stdio: "ignore" });
  child.unref();
  const group = (signal) => { try { process.kill(-child.pid, signal); } catch {} };
  if (mode === "stubborn") process.on("SIGTERM", () => {});
  else process.on("SIGTERM", async () => {
    group("SIGTERM");
    const end = Date.now() + 2000;
    while (Date.now() < end) { try { process.kill(-child.pid, 0); } catch { break; } await sleep(25); }
    group("SIGKILL");
    process.exit(143);
  });
  process.on("exit", () => group("SIGKILL"));
  if (mode === "flood") {
    const chunk = "x".repeat(65536);
    for (let index = 0; index < 100; index++) process.stdout.write(chunk);
  }
  appendFileSync(join(dir, "tree.pids"), process.pid + " " + child.pid + "\\n");
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}

if (mode === "pending-json") { pretty({ status: "pending_review", reason: "timeout" }); process.exit(1); }
if (mode === "bare-json") { pretty({ detail: 1 }); process.exit(1); }
if (command === "delegation-plan") { pretty({ mode: "direct", reason: "fake" }); process.exit(0); }
if (command === "review-verify") { pretty({ status: mode === "numeric" ? 7 : "pending_review" }); process.exit(0); }
if (command === "review-judge") {
  copyFileSync(option("--command-json"), join(dir, "judge-command.json"));
  pretty({ status: "approved" });
  process.exit(0);
}
if (command === "review-findings") {
  if (mode === "numeric") { process.stderr.write(JSON.stringify({ error: "unknown_command" }) + "\\n"); process.exit(1); }
  pretty({ status: "approved", scopes: [] });
  process.exit(0);
}
if (command === "review-status") { pretty({ status: mode === "numeric" ? {} : "approved" }); process.exit(0); }
process.stderr.write(JSON.stringify({ error: "unknown_command" }) + "\\n");
process.exit(1);
`;

let fakeDir: string;
let repo: string;
let testEnv: { stateDir: string; cleanup: () => void };
const saved = new Map<string, string | undefined>();

function setEnv(key: string, value: string | undefined): void {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function install(mode = "", hang = ""): void {
  const bin = join(fakeDir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "ai-harness"), SCRIPT, { mode: 0o755 });
  chmodSync(join(bin, "ai-harness"), 0o755);
  mkdirSync(join(fakeDir, "root"), { recursive: true });
  setEnv("PATH", `${bin}:${saved.get("PATH") ?? process.env.PATH ?? ""}`);
  setEnv("AI_HARNESS_ROOT", join(fakeDir, "root"));
  setEnv("FAKE5_DIR", fakeDir);
  setEnv("FAKE5_MODE", mode || undefined);
  setEnv("FAKE5_HANG", hang || undefined);
  resetHarnessCaches();
}

function calls(): string[] {
  const path = join(fakeDir, "calls.log");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
}

function pids(): Array<{ harness: number; grandchild: number }> {
  const path = join(fakeDir, "tree.pids");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => {
    const [harness, grandchild] = line.split(" ").map(Number);
    return { harness: harness!, grandchild: grandchild! };
  });
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function until(check: () => boolean, label: string, limitMs = 30_000): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

function seedRepo(): void {
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base commit");
  git(repo, "checkout", "-q", "-b", "feature");
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\n");
}

beforeEach(() => {
  testEnv = createTestStateDir();
  fakeDir = realpathSync(mkdtempSync(join(tmpdir(), "r5-bridge-")));
  repo = realpathSync(mkdtempSync(join(tmpdir(), "r5-bridge-repo-")));
  setEnv("HOME", createTempHome());
  setEnv("AI_HARNESS_GENERATED_DIR", join(fakeDir, "generated"));
});

afterEach(() => {
  for (const entry of pids()) {
    for (const pid of [entry.grandchild, entry.harness]) {
      try { process.kill(-pid, "SIGKILL"); } catch {}
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
  resetHarnessCaches();
  rmSync(fakeDir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
  testEnv.cleanup();
  assertNoRealHomeStateLeaks();
});

describe("a probe timeout stops the harness and the groups it started", () => {
  it("sends SIGTERM first so the harness can tear down its verify and judge group", async () => {
    install("", "review-judge");
    const probe = await harnessProbeAsync(["review-judge"], { timeout: 2000 });
    expect(probe).toMatchObject({ ok: false, error: "harness_command_timeout" });
    const [entry] = pids();
    expect(entry).toBeDefined();
    await until(() => !alive(entry!.grandchild), "the detached judge group to stop");
    expect(alive(entry!.harness)).toBe(false);
  }, 60_000);

  it("escalates to SIGKILL after the grace when the harness ignores SIGTERM", async () => {
    install("stubborn", "review-judge");
    const probe = await harnessProbeAsync(["review-judge"], { timeout: 2000, killGraceMs: 300 });
    expect(probe).toMatchObject({ ok: false, error: "harness_command_timeout" });
    const [entry] = pids();
    expect(entry).toBeDefined();
    await until(() => !alive(entry!.harness), "the stubborn harness to die");
  }, 60_000);

  it("keeps the harness grace above the two seconds the harness itself allows", async () => {
    install("", "review-judge");
    const started = Date.now();
    const probe = await harnessProbeAsync(["review-judge"], { timeout: 2000 });
    expect(probe.ok).toBe(false);
    const [entry] = pids();
    expect(alive(entry!.harness)).toBe(false);
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);
});

describe("an interrupted review stops the harness process groups", () => {
  it("terminateHarnessProcesses sends SIGTERM, waits and settles the pending probe as interrupted", async () => {
    install("", "review-judge");
    const scope = createHarnessProcessScope();
    const pending = harnessProbeAsync(["review-judge"], { timeout: 60_000, scope });
    await until(() => pids().length === 1, "the harness to start its group");
    const [entry] = pids();
    await terminateHarnessProcesses(scope);
    expect(alive(entry!.grandchild)).toBe(false);
    expect(alive(entry!.harness)).toBe(false);
    expect(await pending).toMatchObject({ ok: false, error: "harness_interrupted" });
    const before = calls().length;
    expect(await harnessProbeAsync(["review-judge"], { scope })).toMatchObject({ ok: false, error: "harness_interrupted" });
    expect(calls()).toHaveLength(before);
  }, 60_000);

  it("the synchronous interrupt sends SIGTERM, which lets the harness stop its own group", async () => {
    install("", "review-judge");
    const scope = createHarnessProcessScope();
    const pending = harnessProbeAsync(["review-judge"], { timeout: 60_000, scope });
    await until(() => pids().length === 1, "the harness to start its group");
    const [entry] = pids();
    interruptHarnessProcesses(scope);
    await until(() => !alive(entry!.grandchild), "the detached judge group to stop");
    await pending;
  }, 60_000);

  it("terminates only the scope it was given", async () => {
    install("", "review-judge");
    const first = createHarnessProcessScope();
    const second = createHarnessProcessScope();
    const one = harnessProbeAsync(["review-judge"], { timeout: 60_000, scope: first });
    const two = harnessProbeAsync(["review-judge"], { timeout: 60_000, scope: second });
    await until(() => pids().length === 2, "both harnesses to start their groups");
    const owned = new Map(pids().map((entry) => [entry.harness, entry]));
    await terminateHarnessProcesses(first);
    expect((await one).error).toBe("harness_interrupted");
    const survivors = [...owned.values()].filter((entry) => alive(entry.harness));
    expect(survivors).toHaveLength(1);
    expect(alive(survivors[0]!.grandchild)).toBe(true);
    await terminateHarnessProcesses(second);
    expect((await two).error).toBe("harness_interrupted");
    expect(alive(survivors[0]!.grandchild)).toBe(false);
  }, 60_000);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    it(`${signal} on herdr-jev review stops the detached verify group and removes the command files`, async () => {
      install("", "review-verify");
      seedRepo();
      const child = spawn(process.execPath, [CLI, "review", "--client", "codex", "--json", "--session", `r5-${signal}`], {
        cwd: repo,
        env: { ...process.env, HERDR_ENV: "0", TYPESAFE_API_KEY: "" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const closed = new Promise<number | null>((done) => child.on("close", (code) => done(code)));
      try {
        await until(() => pids().length === 1, "the verify command to hang");
        const [entry] = pids();
        expect(alive(entry!.grandchild)).toBe(true);
        child.kill(signal);
        expect(await closed).toBe(signal === "SIGINT" ? 130 : 143);
        await until(() => !alive(entry!.grandchild), "the verify group to stop");
        const review = join(testEnv.stateDir, "review");
        expect(existsSync(review) ? readdirSync(review) : []).toEqual([]);
      } finally {
        child.kill("SIGKILL");
      }
    }, 120_000);
  }

  it("process.exit during a review sends SIGTERM to the harness group", async () => {
    install("", "review-verify");
    seedRepo();
    const script = `import { existsSync } from "node:fs";
import { runReview } from ${JSON.stringify(resolve(import.meta.dir, "../src/harness/review.ts"))};
runReview({ cwd: process.argv[1], client: "codex", session: "exit-5" }).catch(() => {});
setInterval(() => { if (existsSync(process.env.FAKE5_DIR + "/tree.pids")) process.exit(7); }, 25);`;
    const child = spawn(process.execPath, ["-e", script, repo], { cwd: repo, env: { ...process.env, HERDR_ENV: "0", TYPESAFE_API_KEY: "" }, stdio: ["ignore", "ignore", "inherit"] });
    const closed = new Promise<number | null>((done) => child.on("close", (code) => done(code)));
    try {
      expect(await closed).toBe(7);
      const [entry] = pids();
      await until(() => !alive(entry!.grandchild), "the verify group to stop");
    } finally {
      child.kill("SIGKILL");
    }
  }, 120_000);
});

describe("output overflow", () => {
  it("stops the harness group and reports an explicit overflow instead of parsing truncated output", async () => {
    install("flood", "review-judge");
    const probe = await harnessProbeAsync(["review-judge"], { timeout: 30_000, killGraceMs: 500 });
    expect(probe).toMatchObject({ ok: false, error: "harness_output_overflow" });
    const [entry] = pids();
    expect(entry).toBeDefined();
    await until(() => !alive(entry!.grandchild), "the detached group to stop");
  }, 60_000);
});

describe("error codes", () => {
  it("returns a non-zero review payload that carries a string status instead of throwing", () => {
    install("pending-json");
    expect(harnessCommand(["review-judge"])).toEqual({ status: "pending_review", reason: "timeout" });
  });

  it("never turns the opening brace of a pretty-printed payload into the error code", () => {
    install("bare-json");
    expect(() => harnessCommand(["review-status"])).toThrow("harness_command_failed");
    expect(harnessProbe(["review-status"])).toMatchObject({ ok: false, error: "harness_command_failed" });
  });

  it("the asynchronous probe agrees with the synchronous one", async () => {
    install("bare-json");
    expect(await harnessProbeAsync(["review-status"])).toMatchObject({ ok: false, error: "harness_command_failed" });
  });
});

describe("the local quota fallback follows the harness", () => {
  const now = () => Math.floor(Date.now() / 1000);
  const observe = (fetchedAt: number, remaining: number) => {
    const empty = join(fakeDir, "empty");
    mkdirSync(empty, { recursive: true });
    setEnv("PATH", empty);
    resetHarnessCaches();
    const path = join(fakeDir, `quota-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(path, JSON.stringify({ fetched_at_unix: fetchedAt, account_id: "acct", windows: [{ remaining_percent: remaining, resets_at: now() + 3600 }] }));
    return readUsageQuota(path)[0] as Record<string, unknown>;
  };

  it("calls an observation older than two minutes stale", () => {
    const observation = observe(now() - 300, 0);
    expect(observation).toMatchObject({ source: "local_fallback", freshness: "stale" });
    expect(hasExhaustedUsageQuota("codex", [observation])).toBe(false);
  });

  it("calls an observation dated in the future stale", () => {
    expect(observe(now() + 30, 0)).toMatchObject({ freshness: "stale" });
  });

  it("keeps a recent exhausted observation fresh and exhausted", () => {
    const observation = observe(now() - 10, 0);
    expect(observation).toMatchObject({ freshness: "fresh", status: "exhausted" });
    expect(hasExhaustedUsageQuota("codex", [observation])).toBe(true);
  });

  it("does not treat a negative remaining percent as exhausted", () => {
    const observation = observe(now() - 10, -5);
    expect(observation).toMatchObject({ freshness: "fresh", status: "unknown" });
    expect(hasExhaustedUsageQuota("codex", [observation])).toBe(false);
  });
});

describe("review report", () => {
  it("accepts a non-string status from an exit-0 probe without throwing in the formatter", async () => {
    install("numeric");
    seedRepo();
    const report = await runReview({ cwd: repo, client: "codex", session: "numeric-1" });
    expect(report.verify?.status).toBeNull();
    expect(report.status).toBeNull();
    expect(() => formatReviewReport(report)).not.toThrow();
  }, 60_000);

  it("puts the resolved commit, never free text from --base, into the judge prompt", async () => {
    install();
    seedRepo();
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "feature work");
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 3;\n");
    const mergeBase = git(repo, "rev-parse", "main");
    const report = await runReview({ cwd: repo, client: "codex", session: "base-1", base: "HEAD^{/base commit}" });
    expect(report.error).toBeUndefined();
    const prompt = (JSON.parse(readFileSync(join(fakeDir, "judge-command.json"), "utf8")) as string[]).join("\n");
    expect(prompt).toContain(mergeBase.slice(0, 12));
    expect(prompt).not.toContain("base commit");
  }, 60_000);

  it("keeps a plain branch name in the judge prompt", async () => {
    install();
    seedRepo();
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "feature work");
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 3;\n");
    await runReview({ cwd: repo, client: "codex", session: "base-2", base: "main" });
    const prompt = (JSON.parse(readFileSync(join(fakeDir, "judge-command.json"), "utf8")) as string[]).join("\n");
    expect(prompt).toContain("against main (merge base");
  }, 60_000);
});
