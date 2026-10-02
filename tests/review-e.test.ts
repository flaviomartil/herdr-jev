import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { createFakeHerdr, createTempHome } from "./helpers.ts";
import { createProcessCommandAdapter } from "../src/herdr/client.ts";
import { handleNotifyCommand, updateEscalations } from "../src/herdr/notify.ts";
import * as classifier from "../src/triage/pane-classifier.ts";

const ROOT = resolve(import.meta.dir, "..");
const CLI = join(ROOT, "src/cli.ts");
const ENV_KEYS = [
  "HERDR_JEV_STATE_DIR",
  "HERDR_BIN_PATH",
  "HERDR_JEV_NOTIFY",
  "HERDR_JEV_NOTIFY_HOOK",
  "HERDR_JEV_NOTIFY_COOLDOWN_S",
  "HERDR_JEV_ESCALATE_BLOCKED",
  "FAKE_HERDR_AGENT_STATUS",
];

let savedEnv: Record<string, string | undefined> = {};
let stateDir = "";
let herdrLog = "";

const sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));
const okRunner = async () => ({ ok: true, code: 0, stdout: "", stderr: "" });

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  stateDir = mkdtempSync(join(tmpdir(), "herdr-jev-review-e-"));
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

function herdrCalls(): string[][] {
  if (!existsSync(herdrLog)) return [];
  return readFileSync(herdrLog, "utf-8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function runCli(args: string[], input?: string) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, HOME: createTempHome() } as NodeJS.ProcessEnv,
    input,
    encoding: "utf-8",
    timeout: 30000,
  });
}

function pastDate(ms: number): Date {
  return new Date(Date.now() - ms);
}

const failingPaneGet = (stderr = "pane lookup failed") => async (argv: readonly string[]) => {
  if (argv.includes("pane") && argv.includes("get")) return { ok: false, code: 1, stdout: "", stderr };
  return createProcessCommandAdapter()(argv);
};

test("item 1: an unrecognised pane get failure keeps the escalation record and counts an attempt on release", async () => {
  writeFileSync(escalationsFile(), JSON.stringify([{ pane: "w1:p1", agent: "kiro", time: Date.now(), attempts: 0 }]));
  const res = await handleNotifyCommand({ release: true, pane: "w1:p1" }, failingPaneGet());
  expect(res.sent).toBe(false);
  expect(res.skippedReason).toBe("release failed");
  expect(readRecords()).toHaveLength(1);
  expect(readRecords()[0].attempts).toBe(1);
  expect(herdrCalls().filter((call) => call.includes("release-agent"))).toEqual([]);

  await handleNotifyCommand({ release: true, pane: "w1:p1" }, failingPaneGet());
  await handleNotifyCommand({ release: true, pane: "w1:p1" }, failingPaneGet());
  expect(readRecords()).toEqual([]);
});

test("item 1: an unrecognised pane get failure keeps records on release-stale and release-all", async () => {
  const old = Date.now() - 20 * 60 * 1000;
  writeFileSync(escalationsFile(), JSON.stringify([
    { pane: "w1:old", agent: "kiro", time: old, attempts: 0 },
    { pane: "w1:new", agent: "kiro", time: Date.now(), attempts: 0 },
  ]));
  await handleNotifyCommand({ releaseStale: true }, failingPaneGet());
  const afterStale = readRecords();
  expect(afterStale.map((record) => record.pane).sort()).toEqual(["w1:new", "w1:old"]);
  expect(afterStale.find((record) => record.pane === "w1:old").attempts).toBe(1);
  expect(afterStale.find((record) => record.pane === "w1:new").attempts).toBe(0);

  await handleNotifyCommand({ releaseAll: true }, failingPaneGet());
  const afterAll = readRecords();
  expect(afterAll.map((record) => record.pane).sort()).toEqual(["w1:new", "w1:old"]);
  expect(afterAll.find((record) => record.pane === "w1:old").attempts).toBe(2);
  expect(afterAll.find((record) => record.pane === "w1:new").attempts).toBe(1);
});

test("item 1: a recognised pane not found result still drops the record", async () => {
  const shapes = [
    { stdout: JSON.stringify({ error: "pane_not_found" }), stderr: "" },
    { stdout: JSON.stringify({ error: { code: "pane_not_found", message: "gone" } }), stderr: "" },
    { stdout: "", stderr: JSON.stringify({ error: { code: "not_found" } }) },
  ];
  for (const shape of shapes) {
    writeFileSync(escalationsFile(), JSON.stringify([{ pane: "w1:gone", agent: "kiro", time: Date.now(), attempts: 0 }]));
    const runner = async () => ({ ok: false, code: 1, ...shape });
    const res = await handleNotifyCommand({ release: true, pane: "w1:gone" }, runner);
    expect(res.sent).toBe(true);
    expect(readRecords()).toEqual([]);
  }
});

test("item 2: a loser of the stale claim takeover does not notify a second time", async () => {
  const now = Date.now();
  const claim = join(notifyDir(), "pane-w1-t2.claim");
  const state = join(notifyDir(), "pane-w1-t2.json");
  writeFileSync(claim, JSON.stringify({ time: now - 120000 }));
  const opts = { pane: "w1:t2", project: "proj", reason: "approval", attention: "now", agent: "kiro", now };

  let open!: () => void;
  const gate = new Promise<void>((resolveGate) => { open = resolveGate; });
  let inFlight!: () => void;
  const winnerReachedNotification = new Promise<void>((resolveFlight) => { inFlight = resolveFlight; });
  const shown: string[] = [];
  const winnerRunner = async (argv: readonly string[]) => {
    if (argv.includes("notification")) {
      shown.push("winner");
      inFlight();
      await gate;
    }
    return { ok: true, code: 0, stdout: "", stderr: "" };
  };
  const loserRunner = async (argv: readonly string[]) => {
    if (argv.includes("notification")) shown.push("loser");
    return { ok: true, code: 0, stdout: "", stderr: "" };
  };

  let winner!: ReturnType<typeof handleNotifyCommand>;
  const loser = await handleNotifyCommand(opts, loserRunner, {
    afterStaleClaimSeen: async () => {
      winner = handleNotifyCommand(opts, winnerRunner);
      await winnerReachedNotification;
    },
  });
  open();
  const won = await winner;

  expect(shown).toEqual(["winner"]);
  expect(loser.sent).toBe(false);
  expect(loser.skippedReason).toBe("cooldown");
  expect(won.sent).toBe(true);
  expect(existsSync(claim)).toBe(false);
  expect(existsSync(state)).toBe(true);
  expect(readdirSync(notifyDir()).filter((name) => name.endsWith(".stale"))).toEqual([]);
});

test("item 2: a claim that vanishes before the state rename does not fail a sent notification", async () => {
  const claim = join(notifyDir(), "pane-w1-t2b.claim");
  const state = join(notifyDir(), "pane-w1-t2b.json");
  const runner = async (argv: readonly string[]) => {
    if (argv.includes("notification")) rmSync(claim, { force: true });
    return { ok: true, code: 0, stdout: "", stderr: "" };
  };
  const res = await handleNotifyCommand({ pane: "w1:t2b", project: "proj", reason: "approval", attention: "now", now: Date.now() }, runner);
  expect(res.sent).toBe(true);
  expect(existsSync(state)).toBe(true);
  const again = await handleNotifyCommand({ pane: "w1:t2b", project: "proj", reason: "approval", attention: "now", now: Date.now() }, runner);
  expect(again.skippedReason).toBe("cooldown");
});

test("item 3: a writer whose lock was taken over leaves the new owner's lock in place", async () => {
  const lock = `${escalationsFile()}.lock`;
  await updateEscalations(escalationsFile(), (records) => {
    writeFileSync(lock, "another-owner-token");
    return records;
  });
  expect(existsSync(lock)).toBe(true);
  expect(readFileSync(lock, "utf-8")).toBe("another-owner-token");
});

test("item 3: a writer releases its own lock", async () => {
  const lock = `${escalationsFile()}.lock`;
  await updateEscalations(escalationsFile(), (records) => records);
  expect(existsSync(lock)).toBe(false);
});

test("item 3: a stale lock takeover never removes a lock that another writer just took", async () => {
  const lock = `${escalationsFile()}.lock`;
  writeFileSync(lock, "dead-owner");
  utimesSync(lock, pastDate(60000), pastDate(60000));

  let competitorLockRemoved = false;
  let removedBeforeMutate = false;
  let lockSeenByMutate = "";
  setTimeout(() => { competitorLockRemoved = true; rmSync(lock, { force: true }); }, 300);
  await updateEscalations(
    escalationsFile(),
    (records) => {
      removedBeforeMutate = competitorLockRemoved;
      lockSeenByMutate = readFileSync(lock, "utf-8");
      return records;
    },
    {
      afterStaleLockSeen: () => {
        rmSync(lock, { force: true });
        writeFileSync(lock, "competitor-token");
      },
    },
  );
  expect(removedBeforeMutate).toBe(true);
  expect(lockSeenByMutate).not.toBe("competitor-token");
  expect(existsSync(lock)).toBe(false);
  expect(readdirSync(notifyDir()).filter((name) => name.endsWith(".stale"))).toEqual([]);
});

test("item 4: a state file dated in the future does not mute the pane", async () => {
  const now = Date.now();
  const state = join(notifyDir(), "pane-w1-t4.json");
  writeFileSync(state, JSON.stringify({ time: now + 3_600_000 }));
  const res = await handleNotifyCommand({ pane: "w1:t4", project: "proj", reason: "approval", attention: "now", now }, okRunner);
  expect(res.sent).toBe(true);
  expect(JSON.parse(readFileSync(state, "utf-8")).time).toBe(now);
});

test("item 4: a claim dated in the future is removed instead of muting the pane", async () => {
  const now = Date.now();
  const claim = join(notifyDir(), "pane-w1-t4c.claim");
  writeFileSync(claim, JSON.stringify({ time: now + 3_600_000 }));
  const res = await handleNotifyCommand({ pane: "w1:t4c", project: "proj", reason: "approval", attention: "now", now }, okRunner);
  expect(res.sent).toBe(true);
  expect(existsSync(claim)).toBe(false);

  const mtimeClaim = join(notifyDir(), "pane-w1-t4d.claim");
  writeFileSync(mtimeClaim, "");
  const future = new Date(now + 3_600_000);
  utimesSync(mtimeClaim, future, future);
  const second = await handleNotifyCommand({ pane: "w1:t4d", project: "proj", reason: "approval", attention: "now", now }, okRunner);
  expect(second.sent).toBe(true);
  expect(existsSync(mtimeClaim)).toBe(false);
});

test("item 4: a timestamp a few milliseconds ahead from a concurrent writer still counts as a cooldown", async () => {
  const now = Date.now();
  writeFileSync(join(notifyDir(), "pane-w1-t4e.json"), JSON.stringify({ time: now + 40 }));
  const state = await handleNotifyCommand({ pane: "w1:t4e", project: "proj", reason: "approval", attention: "now", now }, okRunner);
  expect(state.sent).toBe(false);
  expect(state.skippedReason).toBe("cooldown");

  writeFileSync(join(notifyDir(), "pane-w1-t4f.claim"), JSON.stringify({ time: now + 40 }));
  const claim = await handleNotifyCommand({ pane: "w1:t4f", project: "proj", reason: "approval", attention: "now", now }, okRunner);
  expect(claim.sent).toBe(false);
  expect(claim.skippedReason).toBe("cooldown");
});

test("item 5: records without a finite numeric time are dropped and attempts is coerced to an integer", async () => {
  const old = Date.now() - 20 * 60 * 1000;
  writeFileSync(escalationsFile(), JSON.stringify([
    { pane: "w1:bad1", agent: "kiro", time: "soon" },
    { pane: "w1:bad2", agent: "kiro" },
    { pane: "w1:bad3", agent: "kiro", time: null },
    { pane: "w1:good", agent: "kiro", time: old, attempts: "1" },
  ]));
  const seen: string[] = [];
  const runner = async (argv: readonly string[]) => {
    if (argv.includes("get")) seen.push(argv[argv.length - 1]);
    return { ok: false, code: 1, stdout: "", stderr: "pane lookup failed" };
  };
  await handleNotifyCommand({ releaseStale: true }, runner);
  expect(seen).toEqual(["w1:good"]);
  const records = readRecords();
  expect(records).toHaveLength(1);
  expect(records[0].pane).toBe("w1:good");
  expect(records[0].attempts).toBe(2);
});

test("item 5: negative, fractional and non numeric attempts are normalised", async () => {
  const old = Date.now() - 20 * 60 * 1000;
  writeFileSync(escalationsFile(), JSON.stringify([
    { pane: "w1:a1", agent: "kiro", time: old, attempts: -4 },
    { pane: "w1:a2", agent: "kiro", time: old, attempts: 0.9 },
    { pane: "w1:a3", agent: "kiro", time: old, attempts: "x" },
  ]));
  await handleNotifyCommand({ releaseAll: true, owner: undefined }, failingPaneGet());
  const records = readRecords();
  expect(records.map((record) => record.attempts)).toEqual([1, 1, 1]);
  for (const record of records) expect(Number.isInteger(record.attempts)).toBe(true);
});

test("item 6: a long single line cut inside a keyword never sends the secret value", async () => {
  const asked: any[] = [];
  const client = { ask: async (state: any) => { asked.push(state); return { answers: {}, jevMs: 1, model: "m" }; } } as any;
  const tailStart = "rd=hunter2 ";
  const filler = "ab ".repeat(2000).slice(-(classifier.MAX_CLASSIFY_PANE_TEXT_CHARS - tailStart.length));
  const paneText = `${"y".repeat(2000)} passwo${tailStart}${filler}`;
  expect(paneText.slice(-classifier.MAX_CLASSIFY_PANE_TEXT_CHARS).startsWith("rd=hunter2")).toBe(true);
  await classifier.classifyPaneText({ paneText, agent: "codex", status: "idle" }, client);
  expect(asked).toHaveLength(1);
  expect(asked[0].paneText).not.toContain("hunter2");
  expect(asked[0].paneText.length).toBeLessThanOrEqual(classifier.MAX_CLASSIFY_PANE_TEXT_CHARS);
  expect(asked[0].paneText.length).toBeGreaterThan(5000);
});

test("item 6: a long text without any whitespace sends no partial token", async () => {
  const asked: any[] = [];
  const client = { ask: async (state: any) => { asked.push(state); return { answers: {}, jevMs: 1, model: "m" }; } } as any;
  await classifier.classifyPaneText({ paneText: `${"a".repeat(9000)}rd=hunter2`, agent: "codex", status: "idle" }, client);
  expect(asked[0].paneText).not.toContain("hunter2");
});

test("item 7: --reason outside approval, question, error or none never reaches the hook", async () => {
  const out = join(stateDir, "hook-args");
  const hook = join(stateDir, "hook.sh");
  writeFileSync(hook, `#!/bin/sh\nprintf '%s\\n' "$@" > "${out}"\n`);
  chmodSync(hook, 0o755);
  process.env.HERDR_JEV_NOTIFY_HOOK = hook;
  const calls: string[][] = [];
  const runner = async (argv: readonly string[]) => {
    calls.push([...argv]);
    return { ok: true, code: 0, stdout: "", stderr: "" };
  };
  for (const reason of ["-rf", "--help", "approval\nrm -rf", "APPROVAL", "x".repeat(500), "error "]) {
    const res = await handleNotifyCommand({ pane: "w1:t7", project: "proj", reason, attention: "now" }, runner);
    expect(res.sent).toBe(false);
    expect(res.skippedReason).toBe("invalid reason");
    expect(res.channels).toEqual([]);
  }
  expect(existsSync(out)).toBe(false);
  expect(calls).toEqual([]);
});

test("item 7: each allowed reason is still delivered to the hook", async () => {
  const out = join(stateDir, "hook-args");
  const hook = join(stateDir, "hook.sh");
  writeFileSync(hook, `#!/bin/sh\nprintf '%s' "$4" > "${out}"\n`);
  chmodSync(hook, 0o755);
  process.env.HERDR_JEV_NOTIFY_HOOK = hook;
  for (const [i, reason] of ["approval", "question", "error", "none"].entries()) {
    const res = await handleNotifyCommand({ pane: `w1:t7a${i}`, project: "proj", reason, attention: "now" }, okRunner);
    expect(res.sent).toBe(true);
    expect(res.channels).toContain("hook");
    expect(readFileSync(out, "utf-8")).toBe(reason);
  }
});

test("item 7: the real notify command rejects an unknown --reason", () => {
  const res = runCli(["notify", "--pane", "w1:t7c", "--project", "proj", "--attention", "now", "--reason=-evil", "--json"]);
  expect(res.status).toBe(0);
  const out = JSON.parse(res.stdout.trim().split("\n").pop() ?? "");
  expect(out.sent).toBe(false);
  expect(out.skippedReason).toBe("invalid reason");
  expect(herdrCalls().filter((call) => call[0] === "notification")).toEqual([]);
});

test("item 8: a multibyte character split across stdin chunks is decoded intact", async () => {
  const stream = new PassThrough();
  const bytes = Buffer.from('{"paneText":"café 日本語 😀"}', "utf-8");
  const input = classifier.readClassifyInput(stream);
  for (let i = 0; i < bytes.length; i += 1) {
    stream.write(bytes.subarray(i, i + 1));
    await sleep(1);
  }
  stream.end();
  const text = await input;
  expect(text).toBe(bytes.toString("utf-8"));
  expect(text).not.toContain("�");
  expect(classifier.parseClassifyInput(text).paneText).toBe("café 日本語 😀");
});

test("item 8: stdin reading still stops once the input cap is exceeded", async () => {
  const stream = new PassThrough();
  const input = classifier.readClassifyInput(stream);
  stream.write("x".repeat(classifier.MAX_CLASSIFY_INPUT_CHARS + 10));
  const text = await input;
  expect(text.length).toBeGreaterThan(classifier.MAX_CLASSIFY_INPUT_CHARS);
  expect(() => classifier.parseClassifyInput(text)).toThrow("input too large");
});

test("item 8: the classify-pane command reads stdin through the shared decoder", () => {
  const source = readFileSync(CLI, "utf-8");
  expect(source).toContain("readClassifyInput(process.stdin)");
  expect(source).not.toContain("for await (const chunk of process.stdin)");
});
