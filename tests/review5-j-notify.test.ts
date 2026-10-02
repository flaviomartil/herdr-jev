import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeHerdr } from "./helpers.ts";
import { handleNotifyCommand, restoreGrave, updateEscalations } from "../src/herdr/notify.ts";

const ENV_KEYS = ["HERDR_JEV_STATE_DIR", "HERDR_BIN_PATH", "HERDR_JEV_NOTIFY", "HERDR_JEV_NOTIFY_HOOK", "HERDR_JEV_ESCALATE_BLOCKED"];

let savedEnv: Record<string, string | undefined> = {};
let stateDir = "";

const okResult = { ok: true, code: 0, stdout: "", stderr: "" };
const failure = (stderr: string, stdout = "") => ({ ok: false, code: 1, stdout, stderr });

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  stateDir = mkdtempSync(join(tmpdir(), "herdr-jev-review5-j-"));
  process.env.HERDR_JEV_STATE_DIR = stateDir;
  process.env.HERDR_BIN_PATH = createFakeHerdr(stateDir);
  process.env.HERDR_JEV_NOTIFY = "1";
  process.env.HERDR_JEV_NOTIFY_HOOK = "off";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
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

const eperm = () => {
  throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
};

test("review 5 notify: restoring a grave without hard links never overwrites a lock created in the meantime", () => {
  const lock = join(notifyDir(), "escalations.json.lock");
  const grave = `${lock}.1.grave`;
  writeFileSync(grave, "displaced-holder");
  writeFileSync(lock, "third-owner");
  restoreGrave(lock, grave, eperm);
  expect(readFileSync(lock, "utf-8")).toBe("third-owner");
  expect(existsSync(grave)).toBe(false);
});

test("review 5 notify: restoring a grave without hard links still renames it back when the lock is free", () => {
  const lock = join(notifyDir(), "escalations.json.lock");
  const grave = `${lock}.2.grave`;
  writeFileSync(grave, "displaced-holder");
  restoreGrave(lock, grave, eperm);
  expect(readFileSync(lock, "utf-8")).toBe("displaced-holder");
  expect(existsSync(grave)).toBe(false);
});

test("review 5 notify: a writer that lost its lock does not write and retries once the new owner is done", async () => {
  const file = escalationsFile();
  const lock = `${file}.lock`;
  writeFileSync(file, JSON.stringify([{ pane: "w1:keep", agent: "kiro", time: 1, attempts: 0 }]));
  let calls = 0;
  let contentWhileForeign = "";
  await updateEscalations(file, (records) => {
    calls++;
    if (calls === 1) {
      writeFileSync(lock, "foreign-owner");
      setTimeout(() => {
        contentWhileForeign = readFileSync(file, "utf-8");
        rmSync(lock, { force: true });
      }, 120);
      return [];
    }
    return [...records, { pane: "w1:added", agent: "kiro", time: 2, attempts: 0 }];
  });
  expect(calls).toBe(2);
  expect(JSON.parse(contentWhileForeign).map((r: any) => r.pane)).toEqual(["w1:keep"]);
  expect(readRecords().map((r) => r.pane)).toEqual(["w1:keep", "w1:added"]);
  expect(existsSync(lock)).toBe(false);
});

test("review 5 notify: a writer that keeps losing its lock gives up without writing", async () => {
  const file = escalationsFile();
  const lock = `${file}.lock`;
  writeFileSync(file, JSON.stringify([{ pane: "w1:keep", agent: "kiro", time: 1, attempts: 0 }]));
  let calls = 0;
  await expect(
    updateEscalations(file, () => {
      calls++;
      writeFileSync(lock, "foreign-owner");
      setTimeout(() => rmSync(lock, { force: true }), 5);
      return [];
    }),
  ).rejects.toThrow("escalation_lock_lost");
  expect(calls).toBeGreaterThan(1);
  expect(readRecords().map((r) => r.pane)).toEqual(["w1:keep"]);
});

const PLAIN_TEXT_GONE = [
  "pane w1:gone not found",
  "Error: pane w1:gone not found.",
  "error: pane not found",
  "pane_not_found: w1:gone",
];

for (const message of PLAIN_TEXT_GONE) {
  test(`review 5 notify: a plain text reply ${JSON.stringify(message)} drops the record on the first release`, async () => {
    writeFileSync(escalationsFile(), JSON.stringify([{ pane: "w1:gone", agent: "kiro", time: Date.now(), attempts: 0 }]));
    const runner = async (argv: readonly string[]) => (argv.includes("get") ? failure(message) : okResult);
    const res = await handleNotifyCommand({ release: true, pane: "w1:gone" }, runner);
    expect(res).toEqual({ sent: true, channels: ["release"] });
    expect(readRecords()).toEqual([]);
  });
}

test("review 5 notify: plain text pane-gone replies also drop records on release-all and release-stale", async () => {
  const old = Date.now() - 20 * 60 * 1000;
  writeFileSync(escalationsFile(), JSON.stringify([{ pane: "w1:gone", agent: "kiro", time: old, attempts: 0 }]));
  const runner = async (argv: readonly string[]) => (argv.includes("get") ? failure("pane w1:gone not found") : okResult);
  expect((await handleNotifyCommand({ releaseStale: true }, runner)).sent).toBe(true);
  expect(readRecords()).toEqual([]);
  writeFileSync(escalationsFile(), JSON.stringify([{ pane: "w1:gone", agent: "kiro", time: old, attempts: 0 }]));
  expect((await handleNotifyCommand({ releaseAll: true }, runner)).sent).toBe(true);
  expect(readRecords()).toEqual([]);
});

test("review 5 notify: an unrelated plain text failure is not mistaken for a gone pane", async () => {
  writeFileSync(escalationsFile(), JSON.stringify([{ pane: "w1:busy", agent: "kiro", time: Date.now(), attempts: 0 }]));
  const runner = async (argv: readonly string[]) => (argv.includes("get") ? failure("error: permission denied while reading pane w1:busy") : okResult);
  const res = await handleNotifyCommand({ release: true, pane: "w1:busy" }, runner);
  expect(res.sent).toBe(false);
  expect(readRecords()).toHaveLength(1);
  expect(readRecords()[0].attempts).toBe(1);
});

function forbiddenRunner() {
  const calls: string[][] = [];
  const runner = async (argv: readonly string[]) => {
    calls.push([...argv]);
    return okResult;
  };
  return { calls, runner };
}

test("review 5 notify: dry-run on --release changes nothing and runs nothing", async () => {
  const body = JSON.stringify([{ pane: "w1:dry", agent: "kiro", time: Date.now(), attempts: 0 }]);
  writeFileSync(escalationsFile(), body);
  const { calls, runner } = forbiddenRunner();
  const res = await handleNotifyCommand({ release: true, pane: "w1:dry", dryRun: true }, runner);
  expect(res).toEqual({ sent: false, dryRun: true, wouldSend: ["release"], channels: [] });
  const missing = await handleNotifyCommand({ release: true, pane: "w1:none", dryRun: true }, runner);
  expect(missing).toEqual({ sent: false, skippedReason: "no escalation", dryRun: true, channels: [] });
  expect(calls).toEqual([]);
  expect(readFileSync(escalationsFile(), "utf-8")).toBe(body);
});

test("review 5 notify: dry-run on --release-stale changes nothing and runs nothing", async () => {
  const body = JSON.stringify([
    { pane: "w1:old", agent: "kiro", time: Date.now() - 20 * 60 * 1000, attempts: 0 },
    { pane: "w1:new", agent: "kiro", time: Date.now(), attempts: 0 },
  ]);
  writeFileSync(escalationsFile(), body);
  const { calls, runner } = forbiddenRunner();
  const res = await handleNotifyCommand({ releaseStale: true, dryRun: true }, runner);
  expect(res).toEqual({ sent: false, dryRun: true, wouldSend: ["release-stale"], channels: [] });
  expect(calls).toEqual([]);
  expect(readFileSync(escalationsFile(), "utf-8")).toBe(body);
  writeFileSync(escalationsFile(), JSON.stringify([{ pane: "w1:new", agent: "kiro", time: Date.now(), attempts: 0 }]));
  expect(await handleNotifyCommand({ releaseStale: true, dryRun: true }, runner)).toEqual({ sent: false, dryRun: true, channels: [] });
});

test("review 5 notify: dry-run on --release-all changes nothing and runs nothing", async () => {
  const body = JSON.stringify([{ pane: "w1:all", agent: "kiro", time: Date.now(), attempts: 0, owner: "999999999-dead" }]);
  writeFileSync(escalationsFile(), body);
  const { calls, runner } = forbiddenRunner();
  const res = await handleNotifyCommand({ releaseAll: true, owner: "999999999-dead", dryRun: true }, runner);
  expect(res).toEqual({ sent: false, dryRun: true, wouldSend: ["release-all"], channels: [] });
  expect(await handleNotifyCommand({ releaseAll: true, owner: "1-other", dryRun: true }, runner)).toEqual({ sent: false, dryRun: true, channels: [] });
  expect(calls).toEqual([]);
  expect(readFileSync(escalationsFile(), "utf-8")).toBe(body);
});
