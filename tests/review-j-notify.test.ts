import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFakeHerdr, createTempHome } from "./helpers.ts";
import { createProcessCommandAdapter } from "../src/herdr/client.ts";
import { handleNotifyCommand, isInsideDir, takeOverStale, updateEscalations } from "../src/herdr/notify.ts";

const ROOT = resolve(import.meta.dir, "..");
const CLI = join(ROOT, "src/cli.ts");
const AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE";
const ENV_KEYS = [
  "HERDR_JEV_STATE_DIR",
  "HERDR_BIN_PATH",
  "HERDR_JEV_NOTIFY",
  "HERDR_JEV_NOTIFY_HOOK",
  "HERDR_JEV_NOTIFY_COOLDOWN_S",
  "HERDR_JEV_ESCALATE_BLOCKED",
  "HERDR_JEV_TEST_GUARD",
  "AI_HARNESS_TEST_GUARD",
  "FAKE_HERDR_AGENT_STATUS",
];

let savedEnv: Record<string, string | undefined> = {};
let stateDir = "";
let herdrLog = "";

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const okRunner = async () => ({ ok: true, code: 0, stdout: "", stderr: "" });
const failure = (stderr: string) => ({ ok: false, code: 1, stdout: "", stderr });

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  stateDir = mkdtempSync(join(tmpdir(), "herdr-jev-review-j-"));
  herdrLog = join(stateDir, "herdr.log");
  process.env.HERDR_JEV_STATE_DIR = stateDir;
  process.env.HERDR_BIN_PATH = createFakeHerdr(stateDir, { logFile: herdrLog });
  process.env.HERDR_JEV_NOTIFY = "1";
  process.env.HERDR_JEV_NOTIFY_HOOK = "off";
  delete process.env.HERDR_JEV_ESCALATE_BLOCKED;
  delete process.env.FAKE_HERDR_AGENT_STATUS;
  delete process.env.HERDR_JEV_NOTIFY_COOLDOWN_S;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  try { chmodSync(join(stateDir, "notify"), 0o755); } catch (e) {}
  rmSync(stateDir, { recursive: true, force: true });
});

function notifyDir(): string {
  const dir = join(stateDir, "notify");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function escalationsFile(): string {
  return join(notifyDir(), "escalations.json");
}

function readRecords(): any[] {
  return JSON.parse(readFileSync(escalationsFile(), "utf-8"));
}

function writeScript(name: string, body: string): string {
  const file = join(stateDir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

function cliEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: createTempHome() };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function runNotifyCli(env: NodeJS.ProcessEnv, extra: string[] = []) {
  return spawnSync(process.execPath, [CLI, "notify", "--pane", "w1:j1", "--project", "proj", "--reason", "approval", "--attention", "now", "--agent", "kiro", "--json", ...extra], {
    env,
    encoding: "utf-8",
    timeout: 30000,
  });
}

const blockedOpts = (pane: string, extra: Record<string, unknown> = {}) => ({
  pane,
  project: "proj",
  reason: "approval",
  attention: "now",
  jevState: "blocked",
  reasonConfidence: 0.9,
  nativeStatus: "idle",
  agent: "kiro",
  ...extra,
});

test("finding 3: control characters become spaces so a secret is redacted before and after stripping", async () => {
  const hookOut = join(stateDir, "hook-args");
  process.env.HERDR_JEV_NOTIFY_HOOK = writeScript("hook.sh", `printf '%s|%s' "$1" "$2" > "${hookOut}"`);
  let shown: string[] = [];
  const runner = async (argv: readonly string[]) => {
    if (argv.includes("notification")) shown = [...argv];
    return { ok: true, code: 0, stdout: "", stderr: "" };
  };
  const res = await handleNotifyCommand(
    { pane: "w1:j3", project: `proj\t${AWS_KEY}`, reason: "approval", attention: "now", agent: "kiro", task: `id\t${AWS_KEY}\nnext\x1b[31m\x07 ${AWS_KEY}` },
    runner,
  );
  expect(res.sent).toBe(true);
  const joined = shown.join("\n") + readFileSync(hookOut, "utf-8");
  expect(joined).not.toContain(AWS_KEY);
  expect(joined).not.toContain("idAKIA");
  expect(shown[shown.indexOf("--body") + 1]).toContain("id [REDACTED]");
  expect(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(joined.replace(/\n/g, ""))).toBe(false);
});

test("finding 6: a 200 KB task or project is bounded and handled in bounded time", async () => {
  let shown: string[] = [];
  const runner = async (argv: readonly string[]) => {
    if (argv.includes("notification")) shown = [...argv];
    return { ok: true, code: 0, stdout: "", stderr: "" };
  };
  const shapes = ["a-".repeat(100_000), "a.".repeat(100_000), "token".repeat(40_000), "a:".repeat(100_000)];
  for (const [i, task] of shapes.entries()) {
    rmSync(notifyDir(), { recursive: true, force: true });
    const started = performance.now();
    const res = await handleNotifyCommand({ pane: `w1:j6${i}`, project: task, reason: "approval", attention: "now", agent: "kiro", task }, runner);
    const elapsed = performance.now() - started;
    expect(res.sent).toBe(true);
    expect(elapsed).toBeLessThan(10_000);
    expect(shown[shown.indexOf("--body") + 1].length).toBeLessThan(120);
    expect(shown[3].length).toBeLessThanOrEqual(2200);
  }
});

test("finding 7: the escalation record exists before report-agent runs and is removed when it fails", async () => {
  process.env.HERDR_JEV_ESCALATE_BLOCKED = "1";
  let seenDuringReport: any[] | undefined;
  const runner = async (argv: readonly string[]) => {
    if (argv.includes("report-agent")) {
      seenDuringReport = readRecords();
      return failure("report-agent exploded");
    }
    return { ok: true, code: 0, stdout: "", stderr: "" };
  };
  const res = await handleNotifyCommand(blockedOpts("w1:j7a", { now: Date.now() }), runner);
  expect(seenDuringReport?.map((r) => r.pane)).toEqual(["w1:j7a"]);
  expect(res.sent).toBe(true);
  expect(res.escalation).toBe("ineffective");
  expect(res.channels).not.toContain("escalation");
  expect(readRecords()).toEqual([]);
});

test("finding 7: a crash between report-agent and verification leaves a record for release", async () => {
  process.env.HERDR_JEV_ESCALATE_BLOCKED = "1";
  const runner = async (argv: readonly string[]) => {
    if (argv.includes("report-agent")) {
      expect(readRecords().map((r) => r.pane)).toEqual(["w1:j7b"]);
      throw new Error("killed by the office timeout");
    }
    return { ok: true, code: 0, stdout: "", stderr: "" };
  };
  const res = await handleNotifyCommand(blockedOpts("w1:j7b", { now: Date.now() }), runner);
  expect(res.escalation).toBe("ineffective");
  expect(readRecords()).toEqual([]);
});

test("finding 7: a failed report restores the record it displaced and a verified one keeps its record", async () => {
  process.env.HERDR_JEV_ESCALATE_BLOCKED = "1";
  const old = { pane: "w1:j7c", agent: "kiro", time: Date.now() - 1000, attempts: 1 };
  writeFileSync(escalationsFile(), JSON.stringify([old, { pane: "w1:other", agent: "kiro", time: Date.now(), attempts: 0 }]));
  const failing = async (argv: readonly string[]) => (argv.includes("report-agent") ? failure("no") : { ok: true, code: 0, stdout: "", stderr: "" });
  await handleNotifyCommand(blockedOpts("w1:j7c", { now: Date.now() }), failing);
  const restored = readRecords();
  expect(restored.map((r) => r.pane).sort()).toEqual(["w1:j7c", "w1:other"]);
  expect(restored.find((r) => r.pane === "w1:j7c").time).toBe(old.time);

  process.env.FAKE_HERDR_AGENT_STATUS = "blocked";
  rmSync(join(notifyDir(), "pane-w1-j7c.json"), { force: true });
  const res = await handleNotifyCommand(blockedOpts("w1:j7c", { now: Date.now() + 1 }), createProcessCommandAdapter());
  expect(res.escalation).toBe("applied");
  expect(readRecords().filter((r) => r.pane === "w1:j7c")).toHaveLength(1);
  expect(readRecords().find((r) => r.pane === "w1:j7c").time).not.toBe(old.time);
});

test("finding 8: a claim younger than the runner timeout is not taken over", async () => {
  const now = Date.now();
  const claim = join(notifyDir(), "pane-w1-j8a.claim");
  writeFileSync(claim, JSON.stringify({ time: now - 70_000, owner: "1-other" }));
  const young = await handleNotifyCommand({ pane: "w1:j8a", project: "proj", reason: "approval", attention: "now", now }, okRunner);
  expect(young.sent).toBe(false);
  expect(young.skippedReason).toBe("cooldown");
  expect(existsSync(claim)).toBe(true);

  writeFileSync(claim, JSON.stringify({ time: now - 100_000, owner: "1-other" }));
  const old = await handleNotifyCommand({ pane: "w1:j8a", project: "proj", reason: "approval", attention: "now", now }, okRunner);
  expect(old.sent).toBe(true);
});

test("finding 8: a slow notification whose claim was replaced does not remove the new owner's claim", async () => {
  const now = Date.now();
  const claim = join(notifyDir(), "pane-w1-j8b.claim");
  const state = join(notifyDir(), "pane-w1-j8b.json");
  const runner = async (argv: readonly string[]) => {
    if (argv.includes("notification")) writeFileSync(claim, JSON.stringify({ time: now, owner: "999-newowner" }));
    return { ok: true, code: 0, stdout: "", stderr: "" };
  };
  const res = await handleNotifyCommand({ pane: "w1:j8b", project: "proj", reason: "approval", attention: "now", now }, runner);
  expect(res.sent).toBe(true);
  expect(JSON.parse(readFileSync(claim, "utf-8")).owner).toBe("999-newowner");
  expect(JSON.parse(readFileSync(state, "utf-8")).time).toBe(now);
});

test("finding 8: the claim carries an owner token and is released by its owner", async () => {
  const now = Date.now();
  const claim = join(notifyDir(), "pane-w1-j8c.claim");
  let owner = "";
  const runner = async (argv: readonly string[]) => {
    if (argv.includes("notification")) owner = JSON.parse(readFileSync(claim, "utf-8")).owner;
    return { ok: true, code: 0, stdout: "", stderr: "" };
  };
  await handleNotifyCommand({ pane: "w1:j8c", project: "proj", reason: "approval", attention: "now", now }, runner);
  expect(owner).toMatch(/^[0-9]+-[0-9a-f]{16}$/);
  expect(existsSync(claim)).toBe(false);
});

test("finding 9: taking over a fresh file never removes it and leaves no leftovers", () => {
  const lock = join(notifyDir(), "fresh.lock");
  writeFileSync(lock, "holder-token");
  const ino = statSync(lock).ino;
  expect(takeOverStale(lock, () => false)).toBe("fresh");
  expect(readFileSync(lock, "utf-8")).toBe("holder-token");
  expect(statSync(lock).ino).toBe(ino);
  expect(readdirSync(notifyDir()).filter((name) => name.endsWith(".stale") || name.endsWith(".grave"))).toEqual([]);

  expect(takeOverStale(lock, () => true)).toBe("taken");
  expect(existsSync(lock)).toBe(false);
  expect(takeOverStale(lock, () => true)).toBe("missing");
  expect(readdirSync(notifyDir()).filter((name) => name.endsWith(".stale") || name.endsWith(".grave"))).toEqual([]);
});

test("finding 9: a concurrent observer never sees a fresh lock vanish during repeated takeover attempts", async () => {
  const lock = join(notifyDir(), "observed.lock");
  const ready = join(notifyDir(), "observer.ready");
  const stop = join(notifyDir(), "observer.stop");
  writeFileSync(lock, "holder-token");
  const script = `
    const fs = require("node:fs");
    const { LOCK, READY, STOP } = process.env;
    let misses = 0, loops = 0;
    fs.writeFileSync(READY, "1");
    while (!fs.existsSync(STOP)) { loops++; if (!fs.existsSync(LOCK)) misses++; }
    process.stdout.write(JSON.stringify({ misses, loops }));
  `;
  const child = spawn(process.execPath, ["-e", script], { env: { ...process.env, LOCK: lock, READY: ready, STOP: stop }, stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk.toString(); });
  const closed = new Promise<void>((done) => child.on("close", () => done()));
  const deadline = Date.now() + 10_000;
  while (!existsSync(ready) && Date.now() < deadline) await sleep(10);
  for (let i = 0; i < 4000; i++) takeOverStale(lock, () => false);
  writeFileSync(stop, "1");
  await closed;
  const result = JSON.parse(out);
  expect(result.loops).toBeGreaterThan(0);
  expect(result.misses).toBe(0);
  expect(readFileSync(lock, "utf-8")).toBe("holder-token");
});

test("finding 10: the lock loop gives up at its deadline when takeover keeps failing", async () => {
  if (typeof process.getuid === "function" && process.getuid() === 0) return;
  const file = escalationsFile();
  const lock = `${file}.lock`;
  writeFileSync(lock, "dead-owner");
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  chmodSync(notifyDir(), 0o555);
  const started = Date.now();
  let error = "";
  try {
    await updateEscalations(file, (records) => records, { lockWaitMs: 200 });
  } catch (e: any) {
    error = e.message;
  }
  const elapsed = Date.now() - started;
  chmodSync(notifyDir(), 0o755);
  expect(error).toBe("escalation_lock_timeout");
  expect(elapsed).toBeGreaterThanOrEqual(150);
  expect(elapsed).toBeLessThan(10_000);
  expect(readFileSync(lock, "utf-8")).toBe("dead-owner");
});

test("finding 10: after the deadline a held lock is forcibly taken and the update completes", async () => {
  const file = escalationsFile();
  writeFileSync(`${file}.lock`, "slow-owner");
  let mutated = false;
  const started = Date.now();
  await updateEscalations(file, (records) => { mutated = true; return records; }, { lockWaitMs: 100 });
  expect(mutated).toBe(true);
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(existsSync(`${file}.lock`)).toBe(false);
});

test("finding 11: release removes the record it read and keeps a newer escalation for the same pane", async () => {
  const first = { pane: "w1:j11", agent: "kiro", time: Date.now() - 5000, attempts: 0 };
  const newer = { pane: "w1:j11", agent: "kiro", time: Date.now(), attempts: 0 };
  writeFileSync(escalationsFile(), JSON.stringify([first]));
  const runner = async (argv: readonly string[]) => {
    if (argv.includes("release-agent")) {
      await updateEscalations(escalationsFile(), (records) => [...records.filter((r) => r.time !== first.time), newer]);
    }
    return { ok: true, code: 0, stdout: "", stderr: "" };
  };
  const res = await handleNotifyCommand({ release: true, pane: "w1:j11" }, runner);
  expect(res.sent).toBe(true);
  expect(readRecords()).toEqual([newer]);
});

test("finding 11: a release that fails bumps only the record it read", async () => {
  const first = { pane: "w1:j11b", agent: "kiro", time: Date.now() - 5000, attempts: 0 };
  const newer = { pane: "w1:j11b", agent: "kiro", time: Date.now(), attempts: 0 };
  writeFileSync(escalationsFile(), JSON.stringify([first]));
  const runner = async (argv: readonly string[]) => {
    if (argv.includes("release-agent")) {
      await updateEscalations(escalationsFile(), (records) => [...records, newer]);
      return failure("release refused");
    }
    return { ok: true, code: 0, stdout: "", stderr: "" };
  };
  await handleNotifyCommand({ release: true, pane: "w1:j11b" }, runner);
  const records = readRecords();
  expect(records.find((r) => r.time === first.time).attempts).toBe(1);
  expect(records.find((r) => r.time === newer.time).attempts).toBe(0);
});

test("finding 12: transient Herdr failures do not count toward the three strikes on release", async () => {
  const messages = ["connection refused", "command timed out; acknowledgement unknown", "Error: spawn herdr ENOENT", "socket hang up"];
  for (const message of messages) {
    writeFileSync(escalationsFile(), JSON.stringify([{ pane: "w1:j12", agent: "kiro", time: Date.now(), attempts: 2 }]));
    const releaseFails = async (argv: readonly string[]) => (argv.includes("release-agent") ? failure(message) : { ok: true, code: 0, stdout: "", stderr: "" });
    const paneGetFails = async (argv: readonly string[]) => (argv.includes("get") ? failure(message) : { ok: true, code: 0, stdout: "", stderr: "" });
    for (const runner of [releaseFails, paneGetFails]) {
      for (let i = 0; i < 4; i++) {
        const res = await handleNotifyCommand({ release: true, pane: "w1:j12" }, runner);
        expect(res.sent).toBe(false);
        expect(res.skippedReason).toBe("release failed");
      }
      expect(readRecords()).toHaveLength(1);
      expect(readRecords()[0].attempts).toBe(2);
    }
  }
});

test("finding 12: transient failures keep records on release-stale and release-all, other failures still count", async () => {
  const old = Date.now() - 20 * 60 * 1000;
  writeFileSync(escalationsFile(), JSON.stringify([{ pane: "w1:j12b", agent: "kiro", time: old, attempts: 2 }]));
  const transient = async () => failure("connection refused");
  await handleNotifyCommand({ releaseStale: true }, transient);
  await handleNotifyCommand({ releaseAll: true }, transient);
  expect(readRecords()).toHaveLength(1);
  expect(readRecords()[0].attempts).toBe(2);

  const definite = async () => failure("agent rejected the release");
  await handleNotifyCommand({ releaseStale: true }, definite);
  expect(readRecords()).toEqual([]);
});

test("finding 13: the hook guard honors the AI harness guard and either guard alone blocks a hook outside the temp dir", () => {
  const linked = join(stateDir, "linked-hook");
  symlinkSync("/bin/true", linked);
  const base = { HERDR_JEV_STATE_DIR: stateDir, HERDR_BIN_PATH: process.env.HERDR_BIN_PATH, HERDR_JEV_NOTIFY: "1", HERDR_JEV_NOTIFY_HOOK: linked };

  const harnessOnly = runNotifyCli(cliEnv({ ...base, HERDR_JEV_TEST_GUARD: "", AI_HARNESS_TEST_GUARD: "1" }));
  expect(JSON.parse(harnessOnly.stdout).channels).toEqual(["herdr"]);

  const jevOnly = runNotifyCli(cliEnv({ ...base, HERDR_JEV_TEST_GUARD: "1", AI_HARNESS_TEST_GUARD: "" }), ["--pane", "w1:j13b"]);
  expect(JSON.parse(jevOnly.stdout).channels).toEqual(["herdr"]);

  rmSync(join(stateDir, "notify"), { recursive: true, force: true });
  const unguarded = runNotifyCli(cliEnv({ ...base, HERDR_JEV_TEST_GUARD: "", AI_HARNESS_TEST_GUARD: "" }), ["--pane", "w1:j13c"]);
  expect(JSON.parse(unguarded.stdout).channels).toEqual(["herdr", "hook"]);
});

test("finding 13: a hook script inside the temp dir still runs under the guard", () => {
  const marker = join(stateDir, "ran");
  const hook = writeScript("hook-in-tmp.sh", `echo ran > "${marker}"`);
  const res = runNotifyCli(cliEnv({ HERDR_JEV_STATE_DIR: stateDir, HERDR_BIN_PATH: process.env.HERDR_BIN_PATH, HERDR_JEV_NOTIFY: "1", HERDR_JEV_NOTIFY_HOOK: hook, AI_HARNESS_TEST_GUARD: "1", HERDR_JEV_TEST_GUARD: "" }));
  expect(JSON.parse(res.stdout).channels).toEqual(["herdr", "hook"]);
  expect(existsSync(marker)).toBe(true);
});

test("finding 13: the temp check needs a path separator and resolves dot segments and symlinks", () => {
  expect(isInsideDir("/tmp/x/hook", "/tmp")).toBe(true);
  expect(isInsideDir("/tmpevil/hook", "/tmp")).toBe(false);
  expect(isInsideDir("/tmp/../etc/hook", "/tmp")).toBe(false);
  expect(isInsideDir("/tmp", "/tmp")).toBe(false);
  expect(isInsideDir("/tmp/x/../../usr/bin/env", "/tmp")).toBe(false);
  const linked = join(stateDir, "linked");
  symlinkSync("/bin/true", linked);
  expect(isInsideDir(linked, tmpdir())).toBe(false);
});

test("finding 14: the hook channel is reported only when the hook ran and exited zero", () => {
  const env = (hook: string) => cliEnv({ HERDR_JEV_STATE_DIR: stateDir, HERDR_BIN_PATH: process.env.HERDR_BIN_PATH, HERDR_JEV_NOTIFY: "1", HERDR_JEV_NOTIFY_HOOK: hook, AI_HARNESS_TEST_GUARD: "1", HERDR_JEV_TEST_GUARD: "1" });
  const cases: Array<[string, string[]]> = [
    [writeScript("ok.sh", "exit 0"), ["herdr", "hook"]],
    [writeScript("bad.sh", "exit 3"), ["herdr"]],
    [join(stateDir, "does-not-exist"), ["herdr"]],
  ];
  cases.forEach(([hook, channels], i) => {
    rmSync(join(stateDir, "notify"), { recursive: true, force: true });
    const res = runNotifyCli(env(hook), ["--pane", `w1:j14${i}`]);
    expect(JSON.parse(res.stdout).channels).toEqual(channels);
  });
});

test("finding 14: a hook that ignores SIGTERM is killed and not reported", async () => {
  const pidFile = join(stateDir, "hook.pid");
  process.env.HERDR_JEV_NOTIFY_HOOK = writeScript("stubborn.sh", `trap '' TERM\necho $$ > "${pidFile}"\nwhile :; do sleep 0.1; done`);
  const started = Date.now();
  const res = await handleNotifyCommand(
    { pane: "w1:j14s", project: "proj", reason: "approval", attention: "now" },
    okRunner,
    { hookTimeoutMs: 300, hookKillGraceMs: 200 },
  );
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(res.sent).toBe(true);
  expect(res.channels).toEqual(["herdr"]);
  const pid = Number(readFileSync(pidFile, "utf-8").trim());
  let alive = true;
  for (let i = 0; i < 30 && alive; i++) {
    try { process.kill(pid, 0); await sleep(50); } catch (e) { alive = false; }
  }
  expect(alive).toBe(false);
});

test("finding 15: an agent label with a leading dash is rejected", async () => {
  for (const agent of ["-x", "--agent", "-"]) {
    const res = await handleNotifyCommand({ pane: "w1:j15", project: "proj", reason: "approval", attention: "now", agent }, okRunner);
    expect(res.sent).toBe(false);
    expect(res.skippedReason).toBe("invalid agent");
  }
  const ok = await handleNotifyCommand({ pane: "w1:j15", project: "proj", reason: "approval", attention: "now", agent: "kiro-2.x" }, okRunner);
  expect(ok.sent).toBe(true);
});
