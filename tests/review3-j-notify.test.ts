import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFakeHerdr, createTempHome } from "./helpers.ts";
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
  "PATH",
];

let savedEnv: Record<string, string | undefined> = {};
let savedCwd = "";
let stateDir = "";

const okRunner = async () => ({ ok: true, code: 0, stdout: "", stderr: "" });
const failure = (stderr: string) => ({ ok: false, code: 1, stdout: "", stderr });

beforeEach(() => {
  savedEnv = {};
  savedCwd = process.cwd();
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  stateDir = mkdtempSync(join(tmpdir(), "herdr-jev-review3-j-"));
  process.env.HERDR_JEV_STATE_DIR = stateDir;
  process.env.HERDR_BIN_PATH = createFakeHerdr(stateDir);
  process.env.HERDR_JEV_NOTIFY = "1";
  process.env.HERDR_JEV_NOTIFY_HOOK = "off";
  delete process.env.HERDR_JEV_ESCALATE_BLOCKED;
  delete process.env.HERDR_JEV_NOTIFY_COOLDOWN_S;
});

afterEach(() => {
  process.chdir(savedCwd);
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

function permissionError(code: string): Error {
  const error: any = new Error(code);
  error.code = code;
  return error;
}

function cliEnv(bin: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: createTempHome(),
    HERDR_JEV_STATE_DIR: stateDir,
    HERDR_BIN_PATH: bin,
    HERDR_JEV_NOTIFY: "1",
    HERDR_JEV_NOTIFY_HOOK: "off",
    HERDR_JEV_ESCALATE_BLOCKED: "1",
    ...extra,
  };
}

function runCli(env: NodeJS.ProcessEnv, args: string[]) {
  return spawnSync(process.execPath, [CLI, "notify", ...args, "--json"], { env, encoding: "utf-8", timeout: 60_000 });
}

function escalateArgs(pane: string): string[] {
  return ["--pane", pane, "--project", "proj", "--reason", "approval", "--attention", "now", "--agent", "kiro", "--jev-state", "blocked", "--reason-confidence", "0.9", "--native-status", "idle"];
}

function fakeHerdrBin(name: string, log: string, agentGet: string, releaseExit = 0): string {
  return writeScript(
    name,
    `echo "$@" >> "${log}"\nif [ "$1" = "agent" ] && [ "$2" = "get" ]; then ${agentGet}; fi\nif [ "$1" = "pane" ] && [ "$2" = "release-agent" ]; then exit ${releaseExit}; fi\nexit 0`,
  );
}

function logged(log: string): string[] {
  return existsSync(log) ? readFileSync(log, "utf-8").split("\n").filter(Boolean) : [];
}

test("round 3 finding 1: a verification read that fails keeps the record so the pane can be released", () => {
  const log = join(stateDir, "r3a.log");
  const bin = fakeHerdrBin("r3a-herdr", log, `echo "connection refused" >&2; exit 1`);
  const env = cliEnv(bin);
  const res = runCli(env, escalateArgs("w1:r3a"));
  expect(res.status).toBe(0);
  const out = JSON.parse(res.stdout);
  expect(out.sent).toBe(true);
  expect(out.escalation).toBe("ineffective");
  expect(out.channels).not.toContain("escalation");
  expect(readRecords().map((r) => r.pane)).toEqual(["w1:r3a"]);
  const released = runCli(env, ["--release", "--pane", "w1:r3a"]);
  expect(JSON.parse(released.stdout)).toEqual({ sent: true, channels: ["release"] });
  expect(logged(log).some((line) => line.startsWith("pane release-agent w1:r3a"))).toBe(true);
  expect(readRecords()).toEqual([]);
});

test("round 3 finding 1: a verification read with unparseable output keeps the record", async () => {
  process.env.HERDR_JEV_ESCALATE_BLOCKED = "1";
  const runner = async (argv: readonly string[]) => {
    if (argv.includes("get")) return { ok: true, code: 0, stdout: "???", stderr: "" };
    return { ok: true, code: 0, stdout: "", stderr: "" };
  };
  const res = await handleNotifyCommand({ pane: "w1:r3b", project: "proj", reason: "approval", attention: "now", jevState: "blocked", reasonConfidence: 0.9, nativeStatus: "idle", agent: "kiro" }, runner);
  expect(res.escalation).toBe("ineffective");
  expect(readRecords().map((r) => r.pane)).toEqual(["w1:r3b"]);
});

test("round 3 finding 1: a verified not blocked pane is released before its record is dropped", () => {
  const log = join(stateDir, "r3c.log");
  const bin = fakeHerdrBin("r3c-herdr", log, `echo '{"result":{"agent":{"agent_status":"idle"}}}'; exit 0`);
  const res = runCli(cliEnv(bin), escalateArgs("w1:r3c"));
  expect(JSON.parse(res.stdout).escalation).toBe("ineffective");
  const lines = logged(log);
  const reportAt = lines.findIndex((line) => line.startsWith("pane report-agent w1:r3c"));
  const releaseAt = lines.findIndex((line) => line.startsWith("pane release-agent w1:r3c"));
  expect(reportAt).toBeGreaterThanOrEqual(0);
  expect(releaseAt).toBeGreaterThan(reportAt);
  expect(readRecords()).toEqual([]);
});

test("round 3 finding 1: a verified not blocked pane whose release fails keeps the record", () => {
  const log = join(stateDir, "r3d.log");
  const bin = fakeHerdrBin("r3d-herdr", log, `echo '{"result":{"agent":{"agent_status":"idle"}}}'; exit 0`, 1);
  const res = runCli(cliEnv(bin), escalateArgs("w1:r3d"));
  expect(JSON.parse(res.stdout).escalation).toBe("ineffective");
  expect(readRecords().map((r) => r.pane)).toEqual(["w1:r3d"]);
});

test("round 3 finding 1: a failed report still restores the record it displaced", async () => {
  process.env.HERDR_JEV_ESCALATE_BLOCKED = "1";
  const old = { pane: "w1:r3e", agent: "kiro", time: Date.now() - 1000, attempts: 1 };
  writeFileSync(escalationsFile(), JSON.stringify([old]));
  const runner = async (argv: readonly string[]) => (argv.includes("report-agent") ? failure("rejected") : { ok: true, code: 0, stdout: "", stderr: "" });
  const res = await handleNotifyCommand({ pane: "w1:r3e", project: "proj", reason: "approval", attention: "now", jevState: "blocked", reasonConfidence: 0.9, nativeStatus: "idle", agent: "kiro" }, runner);
  expect(res.escalation).toBe("ineffective");
  expect(readRecords()).toEqual([old]);
});

test("round 3 finding 2: the lock path never takes over a fresh lock held by a live process", async () => {
  const file = escalationsFile();
  const lock = `${file}.lock`;
  writeFileSync(lock, "live-owner");
  const ino = statSync(lock).ino;
  let mutated = false;
  let error = "";
  try {
    await updateEscalations(file, (records) => { mutated = true; return records; }, { lockWaitMs: 100 });
  } catch (e: any) {
    error = e.message;
  }
  expect(error).toBe("escalation_lock_timeout");
  expect(mutated).toBe(false);
  expect(readFileSync(lock, "utf-8")).toBe("live-owner");
  expect(statSync(lock).ino).toBe(ino);
});

test("round 3 finding 2: a lock whose mtime is only slightly ahead is not taken over", async () => {
  const file = escalationsFile();
  const lock = `${file}.lock`;
  writeFileSync(lock, "live-owner");
  const ahead = new Date(Date.now() + 1000);
  utimesSync(lock, ahead, ahead);
  let error = "";
  try {
    await updateEscalations(file, (records) => records, { lockWaitMs: 100 });
  } catch (e: any) {
    error = e.message;
  }
  expect(error).toBe("escalation_lock_timeout");
  expect(readFileSync(lock, "utf-8")).toBe("live-owner");
});

test("round 3 finding 3: without hard links a fresh lock is never renamed away", () => {
  const lock = join(notifyDir(), "nolink.lock");
  writeFileSync(lock, "live-owner");
  const renames: string[] = [];
  const realRename = fs.renameSync;
  const link = spyOn(fs, "linkSync").mockImplementation((() => { throw permissionError("EPERM"); }) as any);
  const rename = spyOn(fs, "renameSync").mockImplementation(((from: string, to: string) => {
    renames.push(String(from));
    return realRename(from, to);
  }) as any);
  try {
    expect(takeOverStale(lock, () => false)).toBe("fresh");
  } finally {
    link.mockRestore();
    rename.mockRestore();
  }
  expect(renames.filter((from) => from === lock)).toEqual([]);
  expect(readFileSync(lock, "utf-8")).toBe("live-owner");
});

test("round 3 finding 3: without hard links a lock swapped in after the check is restored", () => {
  const lock = join(notifyDir(), "swap-nolink.lock");
  writeFileSync(lock, "old-holder");
  const realRename = fs.renameSync;
  const link = spyOn(fs, "linkSync").mockImplementation((() => { throw permissionError("EPERM"); }) as any);
  let calls = 0;
  try {
    const outcome = takeOverStale(lock, (path) => {
      calls++;
      if (calls === 1) {
        const tmp = `${lock}.replacement`;
        writeFileSync(tmp, "new-holder");
        realRename(tmp, lock);
        return true;
      }
      return readFileSync(path, "utf-8") === "old-holder";
    });
    expect(outcome).toBe("fresh");
  } finally {
    link.mockRestore();
  }
  expect(readFileSync(lock, "utf-8")).toBe("new-holder");
  expect(readdirSync(notifyDir()).filter((name) => name.endsWith(".grave") || name.endsWith(".stale"))).toEqual([]);
});

test("round 3 finding 4: a token cut by the title limit never leaves its prefix", async () => {
  const token = "Kd93Ls0QwErTyUiOpAsDfGhJkLzXcVbN12";
  const used = "kiro em ".length;
  const project = `${"a ".repeat(Math.floor((2048 - used - 20) / 2))}${token} tail`;
  let shown: string[] = [];
  const runner = async (argv: readonly string[]) => {
    if (argv.includes("notification")) shown = [...argv];
    return { ok: true, code: 0, stdout: "", stderr: "" };
  };
  const res = await handleNotifyCommand({ pane: "w1:r3t", project, reason: "approval", attention: "now", agent: "kiro" }, runner);
  expect(res.sent).toBe(true);
  expect(shown[3]).not.toContain(token.slice(0, 12));
  expect(shown[3].length).toBeLessThanOrEqual(2048);
});

test("round 3 finding 4: a long task is clipped after redaction", async () => {
  const token = "Kd93Ls0QwErTyUiOpAsDfGhJkLzXcVbN12";
  const task = `${"b ".repeat(10)}${token} ${"c ".repeat(600)}`;
  let shown: string[] = [];
  const runner = async (argv: readonly string[]) => {
    if (argv.includes("notification")) shown = [...argv];
    return { ok: true, code: 0, stdout: "", stderr: "" };
  };
  await handleNotifyCommand({ pane: "w1:r3u", project: "proj", reason: "approval", attention: "now", agent: "kiro", task }, runner);
  const body = shown[shown.indexOf("--body") + 1];
  expect(body).not.toContain(token.slice(0, 12));
  expect(body.length).toBeLessThan(120);
});

test("round 3 finding 5: a bare hook name is never run under the test guard even when it exists in the working directory", async () => {
  const bin = mkdtempSync(join(tmpdir(), "herdr-jev-review3-bin-"));
  const marker = join(stateDir, "bare-hook.ran");
  try {
    const script = join(bin, "r3-bare-hook");
    writeFileSync(script, `#!/bin/sh\necho ran > "${marker}"\n`);
    chmodSync(script, 0o755);
    process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
    process.env.HERDR_JEV_NOTIFY_HOOK = "r3-bare-hook";
    process.chdir(tmpdir());
    const res = await handleNotifyCommand({ pane: "w1:r3h", project: "proj", reason: "approval", attention: "now" }, okRunner);
    expect(res.sent).toBe(true);
    expect(res.channels).toEqual(["herdr"]);
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("round 3 finding 6: a hook that exits 0 after being terminated by the timeout is not a successful channel", async () => {
  process.env.HERDR_JEV_NOTIFY_HOOK = writeScript("term0.sh", `trap 'exit 0' TERM\nsleep 300 &\nwait`);
  const res = await handleNotifyCommand(
    { pane: "w1:r3i", project: "proj", reason: "approval", attention: "now" },
    okRunner,
    { hookTimeoutMs: 400, hookKillGraceMs: 5_000 },
  );
  expect(res.sent).toBe(true);
  expect(res.channels).toEqual(["herdr"]);
}, 60_000);

function staleReleaseFixture(attempts: number): { first: any } {
  const first = { pane: "w1:r3g", agent: "kiro", time: Date.now() - 60 * 60 * 1000, attempts };
  writeFileSync(escalationsFile(), JSON.stringify([first]));
  return { first };
}

test("round 3 finding 7: a record already gone from the locked state is not counted as released", async () => {
  staleReleaseFixture(2);
  const runner = async (argv: readonly string[]) => {
    if (argv.includes("release-agent")) {
      await updateEscalations(escalationsFile(), () => []);
      return failure("permission denied");
    }
    return { ok: true, code: 0, stdout: "{}", stderr: "" };
  };
  const res = await handleNotifyCommand({ releaseStale: true, now: Date.now() }, runner);
  expect(res.sent).toBe(false);
  expect(readRecords()).toEqual([]);
});

test("round 3 finding 7: a record that exhausts its attempts in the locked state still counts", async () => {
  staleReleaseFixture(2);
  const runner = async (argv: readonly string[]) =>
    argv.includes("release-agent") ? failure("permission denied") : { ok: true, code: 0, stdout: "{}", stderr: "" };
  const res = await handleNotifyCommand({ releaseStale: true, now: Date.now() }, runner);
  expect(res.sent).toBe(true);
  expect(readRecords()).toEqual([]);
});

test("round 3 finding 8: a cooldown that cannot be persisted still suppresses the next notification", async () => {
  const now = Date.now();
  mkdirSync(join(notifyDir(), "pane-w1-r3s.json"));
  const first = await handleNotifyCommand({ pane: "w1:r3s", project: "proj", reason: "approval", attention: "now", now }, okRunner);
  expect(first.sent).toBe(true);
  let shows = 0;
  const counting = async (argv: readonly string[]) => {
    if (argv.includes("notification")) shows++;
    return { ok: true, code: 0, stdout: "", stderr: "" };
  };
  const second = await handleNotifyCommand({ pane: "w1:r3s", project: "proj", reason: "approval", attention: "now", now: now + 1000 }, counting);
  expect(second).toEqual({ sent: false, skippedReason: "cooldown", channels: [] });
  expect(shows).toBe(0);
});

test("round 3 finding 8: a persisted cooldown still releases the claim", async () => {
  const now = Date.now();
  const res = await handleNotifyCommand({ pane: "w1:r3v", project: "proj", reason: "approval", attention: "now", now }, okRunner);
  expect(res.sent).toBe(true);
  expect(existsSync(join(notifyDir(), "pane-w1-r3v.claim"))).toBe(false);
  expect(existsSync(join(notifyDir(), "pane-w1-r3v.json"))).toBe(true);
});

test("round 3 finding 9: an unparseable escalations file is preserved before the next write", async () => {
  const file = escalationsFile();
  writeFileSync(file, `[{"pane":"w1:r3x","agent":"kiro","time":1,`);
  await updateEscalations(file, (records) => [...records, { pane: "w1:r3y", agent: "kiro", time: 2, attempts: 0 }]);
  expect(readRecords().map((r) => r.pane)).toEqual(["w1:r3y"]);
  const backups = readdirSync(notifyDir()).filter((name) => name.startsWith("escalations.json.corrupt."));
  expect(backups).toHaveLength(1);
  expect(readFileSync(join(notifyDir(), backups[0]), "utf-8")).toBe(`[{"pane":"w1:r3x","agent":"kiro","time":1,`);
});

test("round 3 finding 9: a healthy escalations file leaves no backup", async () => {
  const file = escalationsFile();
  writeFileSync(file, JSON.stringify([{ pane: "w1:r3z", agent: "kiro", time: 1, attempts: 0 }]));
  await updateEscalations(file, (records) => records);
  expect(readdirSync(notifyDir()).filter((name) => name.includes(".corrupt."))).toEqual([]);
});
