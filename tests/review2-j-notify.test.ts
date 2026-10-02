import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFakeHerdr } from "./helpers.ts";
import { handleNotifyCommand, takeOverStale, updateEscalations } from "../src/herdr/notify.ts";

const ROOT = resolve(import.meta.dir, "..");
const CLI = join(ROOT, "src/cli.ts");
const ENV_KEYS = [
  "HERDR_JEV_STATE_DIR",
  "HERDR_BIN_PATH",
  "HERDR_JEV_NOTIFY",
  "HERDR_JEV_NOTIFY_HOOK",
  "HERDR_JEV_NOTIFY_COOLDOWN_S",
  "HERDR_JEV_ESCALATE_BLOCKED",
];

let savedEnv: Record<string, string | undefined> = {};
let stateDir = "";
let fakeHome = "";

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const okRunner = async () => ({ ok: true, code: 0, stdout: "", stderr: "" });
const failure = (stderr: string) => ({ ok: false, code: 1, stdout: "", stderr });
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  stateDir = mkdtempSync(join(tmpdir(), "herdr-jev-review2-j-"));
  fakeHome = mkdtempSync(join(tmpdir(), "herdr-jev-review2-home-"));
  process.env.HERDR_JEV_STATE_DIR = stateDir;
  process.env.HERDR_BIN_PATH = createFakeHerdr(stateDir);
  process.env.HERDR_JEV_NOTIFY = "1";
  process.env.HERDR_JEV_NOTIFY_HOOK = "off";
  delete process.env.HERDR_JEV_ESCALATE_BLOCKED;
  delete process.env.HERDR_JEV_NOTIFY_COOLDOWN_S;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  try { chmodSync(join(stateDir, "notify"), 0o755); } catch (e) {}
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
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

function permissionError(code: string): Error {
  const error: any = new Error(code);
  error.code = code;
  return error;
}

test("round 2 finding 4: a lock replaced before the rename is never moved aside", () => {
  const lock = join(notifyDir(), "swap.lock");
  writeFileSync(lock, "old-holder");
  const renames: string[] = [];
  const realRename = fs.renameSync;
  const spy = spyOn(fs, "renameSync").mockImplementation(((from: string, to: string) => {
    renames.push(String(from));
    return realRename(from, to);
  }) as any);
  let replacementIno = 0;
  try {
    const outcome = takeOverStale(lock, () => {
      const tmp = `${lock}.replacement`;
      writeFileSync(tmp, "new-holder");
      realRename(tmp, lock);
      replacementIno = statSync(lock).ino;
      return true;
    });
    expect(outcome).toBe("fresh");
  } finally {
    spy.mockRestore();
  }
  expect(renames.filter((from) => from === lock)).toEqual([]);
  expect(readFileSync(lock, "utf-8")).toBe("new-holder");
  expect(statSync(lock).ino).toBe(replacementIno);
  expect(readdirSync(notifyDir()).filter((name) => name.endsWith(".stale") || name.endsWith(".grave"))).toEqual([]);
});

test("round 2 finding 4: a lock removed by its holder before the rename reports missing and leaves nothing behind", () => {
  const lock = join(notifyDir(), "gone.lock");
  writeFileSync(lock, "old-holder");
  const outcome = takeOverStale(lock, () => {
    fs.unlinkSync(lock);
    return true;
  });
  expect(outcome).toBe("missing");
  expect(existsSync(lock)).toBe(false);
  expect(readdirSync(notifyDir()).filter((name) => name.endsWith(".stale") || name.endsWith(".grave"))).toEqual([]);
});

test("round 2 finding 5: without hard links a stale lock is still taken over", async () => {
  const file = escalationsFile();
  const lock = `${file}.lock`;
  writeFileSync(lock, "dead-owner");
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  const spy = spyOn(fs, "linkSync").mockImplementation((() => { throw permissionError("EPERM"); }) as any);
  try {
    let mutated = false;
    await updateEscalations(file, (records) => { mutated = true; return records; });
    expect(mutated).toBe(true);
  } finally {
    spy.mockRestore();
  }
  expect(existsSync(lock)).toBe(false);
  expect(readdirSync(notifyDir()).filter((name) => name.endsWith(".stale") || name.endsWith(".grave"))).toEqual([]);
}, 60_000);

test("round 2 finding 5: without hard links a fresh lock is left untouched", async () => {
  const file = escalationsFile();
  const lock = `${file}.lock`;
  writeFileSync(lock, "live-owner");
  const ino = statSync(lock).ino;
  const spy = spyOn(fs, "linkSync").mockImplementation((() => { throw permissionError("EPERM"); }) as any);
  try {
    expect(takeOverStale(lock, () => false)).toBe("fresh");
  } finally {
    spy.mockRestore();
  }
  expect(readFileSync(lock, "utf-8")).toBe("live-owner");
  expect(statSync(lock).ino).toBe(ino);
  expect(readdirSync(notifyDir()).filter((name) => name.endsWith(".stale") || name.endsWith(".grave"))).toEqual([]);
});

test("round 2 finding 5: without hard links a stale claim does not suppress the pane forever", async () => {
  const now = Date.now();
  const claim = join(notifyDir(), "pane-w1-r5a.claim");
  writeFileSync(claim, JSON.stringify({ time: now - 10 * 60_000, owner: "1-dead" }));
  const spy = spyOn(fs, "linkSync").mockImplementation((() => { throw permissionError("EPERM"); }) as any);
  try {
    const res = await handleNotifyCommand({ pane: "w1:r5a", project: "proj", reason: "approval", attention: "now", agent: "kiro", now }, okRunner);
    expect(res.sent).toBe(true);
    expect(res.channels).toEqual(["herdr"]);
  } finally {
    spy.mockRestore();
  }
  expect(existsSync(claim)).toBe(false);
});

test("round 2 finding 5: a claim that cannot be written is not reported as a cooldown", async () => {
  if (isRoot) return;
  notifyDir();
  chmodSync(notifyDir(), 0o555);
  const res = await handleNotifyCommand({ pane: "w1:r5b", project: "proj", reason: "approval", attention: "now", agent: "kiro" }, okRunner);
  chmodSync(notifyDir(), 0o755);
  expect(res.sent).toBe(false);
  expect(res.skippedReason).toBe("claim failed");
});

test("round 2 finding 5: a live claim still reports a cooldown", async () => {
  const now = Date.now();
  writeFileSync(join(notifyDir(), "pane-w1-r5c.claim"), JSON.stringify({ time: now - 1000, owner: "1-live" }));
  const res = await handleNotifyCommand({ pane: "w1:r5c", project: "proj", reason: "approval", attention: "now", agent: "kiro", now }, okRunner);
  expect(res).toEqual({ sent: false, skippedReason: "cooldown", channels: [] });
});

function releaseFixture(): string {
  const bin = join(stateDir, "release-herdr");
  writeFileSync(
    bin,
    `#!/bin/sh\nif [ "$1" = "pane" ] && [ "$2" = "release-agent" ]; then chmod 555 "${notifyDir()}"; fi\nexit 0\n`,
  );
  chmodSync(bin, 0o755);
  writeFileSync(escalationsFile(), JSON.stringify([{ pane: "w1:r6", agent: "kiro", time: Date.now(), attempts: 0 }]));
  return bin;
}

test("round 2 finding 6: a release that succeeded but whose record cannot be removed is reported as an update failure", async () => {
  if (isRoot) return;
  releaseFixture();
  const runner = async (argv: readonly string[]) => {
    if (argv.includes("release-agent")) chmodSync(notifyDir(), 0o555);
    return { ok: true, code: 0, stdout: "{}", stderr: "" };
  };
  const res = await handleNotifyCommand({ release: true, pane: "w1:r6" }, runner);
  chmodSync(notifyDir(), 0o755);
  expect(res).toEqual({ sent: false, skippedReason: "escalation update failed", channels: [] });
  expect(readRecords()).toHaveLength(1);
});

test("round 2 finding 6: the release command prints its JSON result when the bookkeeping fails", () => {
  if (isRoot) return;
  const bin = releaseFixture();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: fakeHome,
    HERDR_JEV_STATE_DIR: stateDir,
    HERDR_BIN_PATH: bin,
    HERDR_JEV_NOTIFY_HOOK: "off",
  };
  const res = spawnSync(process.execPath, [CLI, "notify", "--release", "--pane", "w1:r6", "--json"], { env, encoding: "utf-8", timeout: 60_000 });
  chmodSync(notifyDir(), 0o755);
  expect(res.status).toBe(0);
  expect(JSON.parse(res.stdout)).toEqual({ sent: false, skippedReason: "escalation update failed", channels: [] });
});

test("round 2 finding 6: a pane that is gone but whose record cannot be removed is reported, not thrown", async () => {
  if (isRoot) return;
  writeFileSync(escalationsFile(), JSON.stringify([{ pane: "w1:r6g", agent: "kiro", time: Date.now(), attempts: 0 }]));
  const runner = async () => {
    chmodSync(notifyDir(), 0o555);
    return { ok: false, code: 1, stdout: JSON.stringify({ error: "pane_not_found" }), stderr: "" };
  };
  const res = await handleNotifyCommand({ release: true, pane: "w1:r6g" }, runner);
  chmodSync(notifyDir(), 0o755);
  expect(res).toEqual({ sent: false, skippedReason: "escalation update failed", channels: [] });
});

test("round 2 finding 7: transient failures stop counting as transient once the record is old", async () => {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  writeFileSync(
    escalationsFile(),
    JSON.stringify([
      { pane: "w1:r7old", agent: "kiro", time: now - day, attempts: 2 },
      { pane: "w1:r7new", agent: "kiro", time: now - 30 * 60 * 1000, attempts: 2 },
    ]),
  );
  await handleNotifyCommand({ releaseStale: true, now }, async () => failure("connection refused"));
  expect(readRecords().map((record) => record.pane)).toEqual(["w1:r7new"]);
  expect(readRecords()[0].attempts).toBe(2);
});

test("round 2 finding 7: a permanent failure that matches the transient text is bounded on a single release", async () => {
  const now = Date.now();
  writeFileSync(escalationsFile(), JSON.stringify([{ pane: "w1:r7s", agent: "kiro", time: now - 24 * 60 * 60 * 1000, attempts: 0 }]));
  const runner = async () => failure("spawn herdr ENOENT");
  for (let i = 0; i < 3; i++) await handleNotifyCommand({ release: true, pane: "w1:r7s" }, runner);
  expect(readRecords()).toEqual([]);
});

function isAlive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch (e) {
    return false;
  }
}

test("round 2 finding 8: a timed out hook takes the children of its shell with it", async () => {
  const pidFile = join(stateDir, "child.pid");
  process.env.HERDR_JEV_NOTIFY_HOOK = writeScript(
    "family.sh",
    `trap '' TERM\nsleep 300 &\necho $! > "${pidFile}"\nwait`,
  );
  const res = await handleNotifyCommand(
    { pane: "w1:r8", project: "proj", reason: "approval", attention: "now" },
    okRunner,
    { hookTimeoutMs: 500, hookKillGraceMs: 500 },
  );
  expect(res.sent).toBe(true);
  expect(res.channels).toEqual(["herdr"]);
  const pid = Number(readFileSync(pidFile, "utf-8").trim());
  expect(pid).toBeGreaterThan(1);
  let alive = true;
  for (let i = 0; i < 100 && alive; i++) {
    alive = isAlive(pid);
    if (alive) await sleep(100);
  }
  expect(alive).toBe(false);
}, 60_000);

test("round 2 finding 8: a child that survives the leader is killed after the grace period", async () => {
  const pidFile = join(stateDir, "orphan.pid");
  process.env.HERDR_JEV_NOTIFY_HOOK = writeScript(
    "orphan.sh",
    `sh -c 'trap "" TERM; echo $$ > "${pidFile}"; while :; do sleep 1; done' &\nwhile [ ! -s "${pidFile}" ]; do sleep 0.05; done\nwhile :; do sleep 1; done`,
  );
  const res = await handleNotifyCommand(
    { pane: "w1:r8b", project: "proj", reason: "approval", attention: "now" },
    okRunner,
    { hookTimeoutMs: 800, hookKillGraceMs: 500 },
  );
  expect(res.channels).toEqual(["herdr"]);
  const pid = Number(readFileSync(pidFile, "utf-8").trim());
  let alive = true;
  for (let i = 0; i < 100 && alive; i++) {
    alive = isAlive(pid);
    if (alive) await sleep(100);
  }
  expect(alive).toBe(false);
}, 60_000);

test("round 2 finding 8: a hook that finishes normally is still reported", async () => {
  process.env.HERDR_JEV_NOTIFY_HOOK = writeScript("fine.sh", "exit 0");
  const res = await handleNotifyCommand({ pane: "w1:r8c", project: "proj", reason: "approval", attention: "now" }, okRunner);
  expect(res.channels).toEqual(["herdr", "hook"]);
});
