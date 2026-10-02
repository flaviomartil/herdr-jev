import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeHerdr } from "./helpers.ts";
import { handleNotifyCommand, updateEscalations } from "../src/herdr/notify.ts";

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

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const okResult = { ok: true, code: 0, stdout: "", stderr: "" };
const failure = (stderr: string) => ({ ok: false, code: 1, stdout: "", stderr });

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  stateDir = mkdtempSync(join(tmpdir(), "herdr-jev-review4-j-"));
  process.env.HERDR_JEV_STATE_DIR = stateDir;
  process.env.HERDR_BIN_PATH = createFakeHerdr(stateDir);
  process.env.HERDR_JEV_NOTIFY = "1";
  process.env.HERDR_JEV_NOTIFY_HOOK = "off";
  process.env.HERDR_JEV_ESCALATE_BLOCKED = "1";
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

const blockedOpts = (pane: string) => ({
  pane,
  project: "proj",
  reason: "approval",
  attention: "now",
  jevState: "blocked",
  reasonConfidence: 0.9,
  nativeStatus: "idle",
  agent: "kiro",
  now: Date.now(),
});

const runnerFailingReport = (result: () => Promise<any>) => async (argv: readonly string[]) => {
  if (argv.includes("report-agent")) return result();
  return okResult;
};

test("round 4 finding 3: a report-agent timeout keeps the escalation record", async () => {
  const timedOut = runnerFailingReport(async () => failure("command timed out; acknowledgement unknown"));
  const res = await handleNotifyCommand(blockedOpts("w1:r4a"), timedOut);
  expect(res.escalation).toBe("ineffective");
  expect(readRecords().map((r) => r.pane)).toEqual(["w1:r4a"]);
});

test("round 4 finding 3: a lost transport keeps the record and the displaced one is not restored over it", async () => {
  const old = { pane: "w1:r4b", agent: "kiro", time: Date.now() - 5000, attempts: 1 };
  writeFileSync(escalationsFile(), JSON.stringify([old]));
  const lost = runnerFailingReport(async () => failure("error: connection reset by peer"));
  const res = await handleNotifyCommand(blockedOpts("w1:r4b"), lost);
  expect(res.escalation).toBe("ineffective");
  const records = readRecords();
  expect(records).toHaveLength(1);
  expect(records[0].time).not.toBe(old.time);
});

test("round 4 finding 3: a thrown report-agent keeps the record", async () => {
  const thrown = runnerFailingReport(async () => { throw new Error("socket hang up"); });
  const res = await handleNotifyCommand(blockedOpts("w1:r4c"), thrown);
  expect(res.escalation).toBe("ineffective");
  expect(readRecords().map((r) => r.pane)).toEqual(["w1:r4c"]);
});

test("round 4 finding 3: a definite rejection still drops the record", async () => {
  const rejected = runnerFailingReport(async () => ({ ok: false, code: 2, stdout: JSON.stringify({ error: { code: "invalid_state" } }), stderr: "unsupported state" }));
  const res = await handleNotifyCommand(blockedOpts("w1:r4d"), rejected);
  expect(res.escalation).toBe("ineffective");
  expect(readRecords()).toEqual([]);
});

test("round 4 finding 4: a dangling lock symlink times out instead of spinning", async () => {
  const file = escalationsFile();
  symlinkSync(join(stateDir, "missing-target"), `${file}.lock`);
  let mutated = false;
  let error = "";
  const started = Date.now();
  try {
    await updateEscalations(file, (records) => { mutated = true; return records; }, { lockWaitMs: 150 });
  } catch (e: any) {
    error = e.message;
  }
  expect(error).toBe("escalation_lock_timeout");
  expect(mutated).toBe(false);
  expect(Date.now() - started).toBeLessThan(10_000);
});

test("round 4 finding 6: a release whose record cannot be removed is not reported as sent", async () => {
  if (isRoot) return;
  writeFileSync(escalationsFile(), JSON.stringify([{ pane: "w1:r4f", agent: "kiro", time: Date.now(), attempts: 0 }]));
  const runner = async (argv: readonly string[]) => {
    if (argv.includes("release-agent")) chmodSync(notifyDir(), 0o555);
    return { ok: true, code: 0, stdout: "{}", stderr: "" };
  };
  const res = await handleNotifyCommand({ release: true, pane: "w1:r4f" }, runner);
  chmodSync(notifyDir(), 0o755);
  expect(res).toEqual({ sent: false, skippedReason: "escalation update failed", channels: [] });
  expect(readRecords()).toHaveLength(1);
});
