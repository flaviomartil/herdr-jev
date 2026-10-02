import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFakeHerdr } from "./helpers.ts";
import { createProcessCommandAdapter } from "../src/herdr/client.ts";
import { handleNotifyCommand } from "../src/herdr/notify.ts";
import * as classifier from "../src/triage/pane-classifier.ts";
import * as notifyArgs from "../herdr-plugin/office/src/notify-args.mjs";

process.env.HERDR_OFFICE_TEST_UNIT = "1";
const office: any = await import("../herdr-plugin/office/office.mjs");
const hooks = office._testHooks;

const ROOT = resolve(import.meta.dir, "..");
const CLI = join(ROOT, "src/cli.ts");
const OFFICE_SOURCE = join(ROOT, "herdr-plugin/office/office.mjs");
const ENV_KEYS = [
  "HERDR_JEV_STATE_DIR",
  "HERDR_BIN_PATH",
  "HERDR_JEV_NOTIFY",
  "HERDR_JEV_NOTIFY_HOOK",
  "HERDR_JEV_NOTIFY_COOLDOWN_S",
  "HERDR_JEV_ESCALATE_BLOCKED",
  "HERDR_JEV_BIN",
  "HERDR_JEV_OFFICE_JEV",
  "FAKE_HERDR_AGENT_STATUS",
  "REVIEW_D_CAPTURE",
];

let savedEnv: Record<string, string | undefined> = {};
let stateDir = "";
let herdrLog = "";

const sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));
const okRunner = async () => ({ ok: true, code: 0, stdout: "", stderr: "" });

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  stateDir = mkdtempSync(join(tmpdir(), "herdr-jev-review-d-"));
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
  hooks.notifyTaskTimeoutMs = 12000;
  hooks.jevPolling = false;
  hooks.notifyPending.length = 0;
  hooks.notifyState.clear();
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

function blockedPerson(overrides: Record<string, unknown> = {}): any {
  return {
    id: "w1:p1",
    cwd: "/work/proj",
    title: "fix the tests",
    status: "idle",
    jevAttention: "now",
    jevBlockedReason: "approval",
    jevConfidence: 0.9,
    jevState: "blocked",
    jevBlockedReasonConfidence: 0.95,
    kind: "codex",
    revision: 1,
    focused: false,
    ...overrides,
  };
}

function runCli(args: string[], input?: string) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env } as NodeJS.ProcessEnv,
    input,
    encoding: "utf-8",
    timeout: 30000,
  });
}

function lastJson(stdout: string): any {
  return JSON.parse(stdout.trim().split("\n").pop() ?? "");
}

function writeScript(name: string, body: string): string {
  const file = join(stateDir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

async function waitFor(check: () => boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await sleep(25);
}

function deadPid(): number {
  const child = spawnSync("true");
  return child.pid as number;
}

test("N1: Office argv carries an owner and the CLI writes it into the escalation record", () => {
  process.env.HERDR_JEV_ESCALATE_BLOCKED = "1";
  process.env.FAKE_HERDR_AGENT_STATUS = "blocked";
  const owner = `${process.pid}-feed1234`;
  const res = runCli((notifyArgs as any).buildNotifyArgs(blockedPerson(), owner));
  expect(res.status).toBe(0);
  const out = lastJson(res.stdout);
  expect(out.escalation).toBe("applied");
  expect(readRecords()[0].owner).toBe(owner);
  const report = herdrCalls().find((call) => call[1] === "report-agent");
  expect(report?.[2]).toBe("w1:p1");
  expect(report).not.toContain("--");
});

test("N1: the Office instance owner is its process id plus a random instance id", () => {
  const owner = (notifyArgs as any).officeOwner as string;
  expect(owner).toMatch(new RegExp(`^${process.pid}-[0-9a-f]{8}$`));
  const argv = (notifyArgs as any).buildNotifyArgs(blockedPerson());
  expect(argv[argv.indexOf("--owner") + 1]).toBe(owner);
});

test("N1: release-all with --owner releases only that owner's records", async () => {
  const mine = `${process.pid}-aaaa1111`;
  const other = `${process.pid}-bbbb2222`;
  writeFileSync(escalationsFile(), JSON.stringify([
    { pane: "w1:a", agent: "kiro", time: Date.now(), attempts: 0, owner: mine },
    { pane: "w1:b", agent: "kiro", time: Date.now(), attempts: 0, owner: other },
    { pane: "w1:c", agent: "kiro", time: Date.now(), attempts: 0 },
  ]));
  const res = await handleNotifyCommand({ releaseAll: true, owner: mine }, createProcessCommandAdapter());
  expect(res.sent).toBe(true);
  expect(res.channels).toContain("release-all");
  const released = herdrCalls().filter((call) => call[1] === "release-agent").map((call) => call[2]);
  expect(released).toEqual(["w1:a"]);
  expect(readRecords().map((record) => record.pane).sort()).toEqual(["w1:b", "w1:c"]);
});

test("N1: release-all without --owner releases only records whose owner process is gone", async () => {
  const alive = `${process.pid}-aaaa1111`;
  const dead = `${deadPid()}-bbbb2222`;
  writeFileSync(escalationsFile(), JSON.stringify([
    { pane: "w1:live", agent: "kiro", time: Date.now(), attempts: 0, owner: alive },
    { pane: "w1:dead", agent: "kiro", time: Date.now(), attempts: 0, owner: dead },
    { pane: "w1:none", agent: "kiro", time: Date.now(), attempts: 0 },
  ]));
  const res = await handleNotifyCommand({ releaseAll: true }, createProcessCommandAdapter());
  expect(res.sent).toBe(true);
  const released = herdrCalls().filter((call) => call[1] === "release-agent").map((call) => call[2]).sort();
  expect(released).toEqual(["w1:dead", "w1:none"]);
  expect(readRecords().map((record) => record.pane)).toEqual(["w1:live"]);
});

test("N1: the real notify command accepts --release-all --owner and rejects a malformed owner", () => {
  const mine = `${process.pid}-cafe0001`;
  writeFileSync(escalationsFile(), JSON.stringify([
    { pane: "w1:a", agent: "codex", time: Date.now(), attempts: 0, owner: mine },
    { pane: "w1:b", agent: "codex", time: Date.now(), attempts: 0, owner: `${process.pid}-cafe0002` },
  ]));
  const res = runCli(["notify", "--release-all", "--owner", mine, "--json"]);
  expect(res.status).toBe(0);
  expect(lastJson(res.stdout).channels).toContain("release-all");
  const release = herdrCalls().find((call) => call[1] === "release-agent");
  expect(release?.slice(0, 3)).toEqual(["pane", "release-agent", "w1:a"]);
  expect(release).not.toContain("--");
  expect(readRecords().map((record) => record.pane)).toEqual(["w1:b"]);

  const bad = runCli(["notify", "--release-all", "--owner", "--evil", "--json"]);
  expect(lastJson(bad.stdout).skippedReason).toBe("invalid owner");
  expect(herdrCalls().filter((call) => call[1] === "release-agent").length).toBe(1);
});

test("N1: the Office no longer calls release-all at startup and never without an owner", () => {
  const source = readFileSync(OFFICE_SOURCE, "utf-8");
  expect(source).not.toMatch(/'--release-all'(?!, '--owner')/);
  expect(source).toContain("'--release-stale'");
});

test("N2: applyJevData queues one release per pane until it settles", async () => {
  process.env.HERDR_JEV_ESCALATE_BLOCKED = "1";
  process.env.HERDR_JEV_OFFICE_JEV = "0";
  const releases = () => hooks.notifyPending.filter((task: any) => task.args[1] === "--release");
  hooks.roster.people = [blockedPerson({ id: "w1:n2", revision: 2, status: "idle", jevAttention: "none" })];
  hooks.notifyState.set("w1:n2", { rev: 2, attention: "", status: "idle", escalatedRev: 1 });

  for (let i = 0; i < 5; i++) hooks.applyJevData();
  expect(releases().length).toBe(1);

  hooks.notifyPending.length = 0;
  process.env.HERDR_JEV_BIN = writeScript("fail.sh", "exit 1");
  hooks.notifyState.get("w1:n2").releasePending = true;
  hooks.notifyPending.push({
    args: ["notify", "--release", "--pane", "w1:n2", "--json"],
    onSettled: () => { hooks.notifyState.get("w1:n2").releasePending = false; },
  });
  await hooks.pollJevClassify();
  expect(hooks.notifyState.get("w1:n2").releasePending).toBe(false);
  hooks.notifyPending.length = 0;

  for (let i = 0; i < 3; i++) hooks.applyJevData();
  expect(releases().length).toBe(1);
  expect(hooks.notifyState.get("w1:n2").releasePending).toBe(true);

  await hooks.pollJevClassify();
  expect(hooks.notifyState.get("w1:n2").releasePending).toBe(false);
  expect(hooks.notifyPending.length).toBe(0);
});

test("N2: a hanging release clears the pending flag when it times out", async () => {
  process.env.HERDR_JEV_ESCALATE_BLOCKED = "1";
  process.env.HERDR_JEV_OFFICE_JEV = "0";
  process.env.HERDR_JEV_BIN = writeScript("hang.sh", "exec sleep 5");
  hooks.notifyTaskTimeoutMs = 150;
  hooks.roster.people = [blockedPerson({ id: "w1:n2h", revision: 2, status: "idle", jevAttention: "none" })];
  hooks.notifyState.set("w1:n2h", { rev: 2, attention: "", status: "idle", escalatedRev: 1 });

  hooks.applyJevData();
  hooks.applyJevData();
  expect(hooks.notifyState.get("w1:n2h").releasePending).toBe(true);
  const started = Date.now();
  await hooks.pollJevClassify();
  expect(Date.now() - started).toBeLessThan(2500);
  expect(hooks.notifyState.get("w1:n2h").releasePending).toBe(false);
});

test("N3: a second process that passed the cooldown check before the first finished does not notify again", async () => {
  const calls: string[][] = [];
  const runner = async (argv: readonly string[]) => {
    calls.push([...argv]);
    return { ok: true, code: 0, stdout: "", stderr: "" };
  };
  const stateFile = join(notifyDir(), "pane-w1-p3.json");
  const res = await handleNotifyCommand(
    { pane: "w1:p3", project: "proj", reason: "approval", attention: "now", agent: "kiro" },
    runner,
    { afterCooldownCheck: () => { writeFileSync(stateFile, JSON.stringify({ time: Date.now() })); } },
  );
  expect(res.sent).toBe(false);
  expect(res.skippedReason).toBe("cooldown");
  expect(calls.filter((call) => call.includes("notification"))).toEqual([]);
  expect(existsSync(join(notifyDir(), "pane-w1-p3.claim"))).toBe(false);
});

test("N4: null and malformed entries in the escalation file do not break any release path", async () => {
  const old = Date.now() - 20 * 60 * 1000;
  const seed = () => writeFileSync(escalationsFile(), JSON.stringify([
    null, 5, "x", [], { pane: 1, agent: "kiro" }, { pane: "w1:noagent" },
    { pane: "w1:ok", agent: "kiro", time: old, attempts: 0 },
  ]));
  const runner = createProcessCommandAdapter();

  seed();
  const released = await handleNotifyCommand({ release: true, pane: "w1:ok" }, runner);
  expect(released.sent).toBe(true);
  expect(readRecords()).toEqual([]);

  seed();
  const stale = await handleNotifyCommand({ releaseStale: true }, runner);
  expect(stale.sent).toBe(true);
  expect(readRecords()).toEqual([]);

  seed();
  const all = await handleNotifyCommand({ releaseAll: true }, runner);
  expect(all.sent).toBe(true);
  expect(readRecords()).toEqual([]);
});

test("N4: release-stale keeps an escalation recorded while it was running", async () => {
  writeFileSync(escalationsFile(), JSON.stringify([
    { pane: "w1:old", agent: "kiro", time: Date.now() - 20 * 60 * 1000, attempts: 0 },
  ]));
  let open!: () => void;
  const gate = new Promise<void>((resolveGate) => { open = resolveGate; });
  const base = createProcessCommandAdapter();
  const gated = async (argv: readonly string[]) => {
    if (argv.includes("get") && argv.includes("w1:old")) await gate;
    return base(argv);
  };
  const stale = handleNotifyCommand({ releaseStale: true }, gated);
  await sleep(50);

  process.env.HERDR_JEV_ESCALATE_BLOCKED = "1";
  process.env.FAKE_HERDR_AGENT_STATUS = "blocked";
  const added = await handleNotifyCommand({
    pane: "w1:new", project: "proj", reason: "approval", attention: "now", jevState: "blocked",
    reasonConfidence: 0.9, nativeStatus: "idle", agent: "kiro", owner: `${process.pid}-aaaa1111`,
  }, base);
  expect(added.escalation).toBe("applied");

  open();
  await stale;
  expect(readRecords().map((record) => record.pane)).toEqual(["w1:new"]);
});

test("N4: the escalation lock is honored and a stale lock is recovered", async () => {
  const lock = `${escalationsFile()}.lock`;
  const seed = () => writeFileSync(escalationsFile(), JSON.stringify([
    { pane: "w1:old", agent: "kiro", time: Date.now() - 20 * 60 * 1000, attempts: 0 },
  ]));

  seed();
  writeFileSync(lock, "999999");
  let lockRemoved = false;
  setTimeout(() => { lockRemoved = true; rmSync(lock, { force: true }); }, 200);
  const held = await handleNotifyCommand({ releaseStale: true }, createProcessCommandAdapter());
  expect(lockRemoved).toBe(true);
  expect(held.sent).toBe(true);
  expect(readRecords()).toEqual([]);

  seed();
  writeFileSync(lock, "999999");
  const past = new Date(Date.now() - 60000);
  utimesSync(lock, past, past);
  const recovered = await handleNotifyCommand({ releaseStale: true }, createProcessCommandAdapter());
  expect(recovered.sent).toBe(true);
  expect(readRecords()).toEqual([]);
  expect(existsSync(lock)).toBe(false);
});

test("N4: concurrent processes keep every escalation record and leave no temp or lock files", async () => {
  process.env.HERDR_JEV_ESCALATE_BLOCKED = "1";
  process.env.FAKE_HERDR_AGENT_STATUS = "blocked";
  const owner = `${process.pid}-feed1234`;
  const codes = await Promise.all(Array.from({ length: 6 }, (_, i) =>
    new Promise<number | null>((resolveCode) => {
      const argv = (notifyArgs as any).buildNotifyArgs(blockedPerson({ id: `w1:c${i}` }), owner);
      const child = spawn(process.execPath, [CLI, ...argv], { env: { ...process.env } as NodeJS.ProcessEnv, stdio: "ignore" });
      child.on("close", resolveCode);
    }),
  ));
  expect(codes).toEqual([0, 0, 0, 0, 0, 0]);
  expect(readRecords().map((record) => record.pane).sort()).toEqual(["w1:c0", "w1:c1", "w1:c2", "w1:c3", "w1:c4", "w1:c5"]);
  expect(readdirSync(notifyDir()).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock"))).toEqual([]);
});

test("N4: the escalation file is written through a per process temp name", async () => {
  process.env.HERDR_JEV_ESCALATE_BLOCKED = "1";
  process.env.FAKE_HERDR_AGENT_STATUS = "blocked";
  mkdirSync(`${escalationsFile()}.tmp`);
  const res = await handleNotifyCommand({
    pane: "w1:tmp", project: "proj", reason: "approval", attention: "now", jevState: "blocked",
    reasonConfidence: 0.9, nativeStatus: "idle", agent: "kiro", owner: `${process.pid}-aaaa1111`,
  }, createProcessCommandAdapter());
  expect(res.escalation).toBe("applied");
  expect(readRecords().map((record) => record.pane)).toEqual(["w1:tmp"]);
});

test("N5 (item 3): an empty, unparseable or time-less claim file expires instead of muting the pane forever", async () => {
  const contents = ["", "{broken", "{}", '{"time":"soon"}'];
  for (const [i, content] of contents.entries()) {
    const pane = `w1:c${i}`;
    const claim = join(notifyDir(), `pane-w1-c${i}.claim`);
    writeFileSync(claim, content);
    const past = new Date(Date.now() - 120000);
    utimesSync(claim, past, past);
    const res = await handleNotifyCommand({ pane, project: "proj", reason: "approval", attention: "now" }, okRunner);
    expect(res.sent).toBe(true);
    expect(existsSync(claim)).toBe(false);
  }

  const fresh = join(notifyDir(), "pane-w1-fresh.claim");
  writeFileSync(fresh, "");
  const muted = await handleNotifyCommand({ pane: "w1:fresh", project: "proj", reason: "approval", attention: "now" }, okRunner);
  expect(muted.sent).toBe(false);
  expect(muted.skippedReason).toBe("cooldown");
});

test("N6 (item 4): pane ids that differ only by an underscore or a colon get separate cooldown files", async () => {
  const first = await handleNotifyCommand({ pane: "a:b_3Ac", project: "proj", reason: "approval", attention: "now" }, okRunner);
  const second = await handleNotifyCommand({ pane: "a_3Ab:c", project: "proj", reason: "approval", attention: "now" }, okRunner);
  expect(first.sent).toBe(true);
  expect(second.sent).toBe(true);
  expect(existsSync(join(notifyDir(), "pane-a-b_3Ac.json"))).toBe(true);
  expect(existsSync(join(notifyDir(), "pane-a_3Ab-c.json"))).toBe(true);
});

test("N7: buildNotifyArgs tolerates a non-string cwd or title", () => {
  const build = (notifyArgs as any).buildNotifyArgs;
  const argv = build({ id: "w1:p1", cwd: 42, title: { text: "x" }, status: "blocked", kind: "codex" }, "1-aa");
  expect(argv[argv.indexOf("--project") + 1]).toBe("Project");
  expect(argv[argv.indexOf("--task") + 1]).toBe("");
});

test("N7: applyJevData swallows a failing argument builder instead of raising an unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const person = blockedPerson({ id: "w1:n7", status: "blocked", revision: 1 });
    Object.defineProperty(person, "title", { get() { throw new Error("boom"); } });
    hooks.roster.people = [person];
    hooks.applyJevData();
    await sleep(150);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  expect(unhandled).toEqual([]);
  expect(hooks.notifyPending.length).toBe(0);
});

test("N8: classify-pane rejects malformed stdin through the real command entry point", () => {
  const cases: Array<[string, string]> = [
    ["not json", "not json"],
    ["non-string paneText", JSON.stringify({ paneText: 5, agent: "codex", status: "idle" })],
    ["array", "[]"],
    ["null", "null"],
    ["oversize", JSON.stringify({ paneText: "x".repeat(200000) })],
  ];
  for (const [label, input] of cases) {
    const res = runCli(["classify-pane", "--json"], input);
    expect(res.status, label).toBe(1);
    expect(res.stderr, label).toContain("invalid classify-pane input");
    expect(res.stderr, label).not.toContain("    at ");
  }
});

test("N8: classifyPaneText caps the text before and after redaction and normalizes agent and status", async () => {
  const asked: any[] = [];
  const client = { ask: async (state: any) => { asked.push(state); return { answers: {}, jevMs: 1, model: "m" }; } } as any;
  const secret = "ghp_" + "a1B2c3D4e5".repeat(4);
  const paneText = "y".repeat(30000) + `\ntoken=${secret}\n` + "tail line";
  await classifier.classifyPaneText({ paneText, agent: { nope: true } as any, status: 7 as any }, client);
  expect(asked.length).toBe(1);
  expect(asked[0].paneText.length).toBeLessThanOrEqual((classifier as any).MAX_CLASSIFY_PANE_TEXT_CHARS);
  expect(asked[0].paneText.endsWith("tail line")).toBe(true);
  expect(asked[0].paneText).not.toContain(secret);
  expect(asked[0].agent).toBe("unknown");
  expect(asked[0].status).toBe("unknown");
  await expect(classifier.classifyPaneText({ paneText: 5 as any, agent: "a", status: "b" }, client)).rejects.toThrow("paneText must be a string");
});

test("N8: a huge single line cannot stall classification", async () => {
  const client = { ask: async () => ({ answers: {}, jevMs: 1, model: "m" }) } as any;
  const started = performance.now();
  await classifier.classifyPaneText({ paneText: "a.".repeat(15000), agent: "codex", status: "idle" }, client);
  expect(performance.now() - started).toBeLessThan(2500);
});

test("N8: the Office sends the same 30 line slice that it hashes for the cache key", async () => {
  const capture = join(stateDir, "stdin.json");
  process.env.REVIEW_D_CAPTURE = capture;
  process.env.HERDR_JEV_BIN = writeScript(
    "classify.sh",
    `cat > "$REVIEW_D_CAPTURE"\necho '{"state":"working","stateConfidence":0.9,"attention":"none","blockedReason":"none","activityConfidence":0}'`,
  );
  delete process.env.HERDR_JEV_OFFICE_JEV;
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
  hooks.api = { request: async () => ({ read: { text: lines.join("\n") } }) };
  hooks.roster.people = [{ id: "w1:n8", revision: 1, status: "working", cwd: "/work/proj", kind: "codex" }];
  hooks.classifyTimestamps.delete("w1:n8");
  hooks.paneRevisions.delete("w1:n8");
  hooks.classifyCountMinute = 0;
  hooks.classifyMinuteStart = Date.now();

  await hooks.pollJevClassify();

  const sent = JSON.parse(readFileSync(capture, "utf-8"));
  const hashed = lines.slice(-30).join("\n");
  expect(sent.paneText).toBe(hashed);
  const key = hooks.classifyHashes.get("w1:n8") as string;
  expect(key.split(":")[0]).toBe(createHash("sha1").update(sent.paneText).digest("hex"));
});

test("N9: the hook receives the body with the option guard prefix", async () => {
  const out = join(stateDir, "hook-second-arg");
  process.env.HERDR_JEV_NOTIFY_HOOK = writeScript("hook.sh", `printf '%s' "$2" > "${out}"`);
  const res = await handleNotifyCommand({ pane: "w1:h1", project: "Proj", reason: "approval", attention: "now", agent: "kiro", task: "-x" }, okRunner);
  expect(res.channels).toContain("hook");
  expect(readFileSync(out, "utf-8")).toBe("· -x: aguardando aprovação");
});

test("N10: a long token near the old 80 character cut is redacted before it reaches the notification", () => {
  const token = "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5nP7r";
  expect(token.length).toBe(40);
  const title = `${"A".repeat(55)} ${token} end`;
  const argv = (notifyArgs as any).buildNotifyArgs(blockedPerson({ title, status: "blocked" }), `${process.pid}-feed1234`);
  const res = runCli(argv);
  expect(res.status).toBe(0);
  expect(lastJson(res.stdout).sent).toBe(true);
  const shown = herdrCalls().find((call) => call[0] === "notification" && call[1] === "show");
  expect(shown).toBeDefined();
  const body = shown![shown!.indexOf("--body") + 1];
  expect(body).toContain("[REDACTED]");
  expect(shown!.join(" ")).not.toContain(token.slice(0, 16));
});

test("N11: quit releases through one detached call and does not wait for it", async () => {
  process.env.HERDR_JEV_ESCALATE_BLOCKED = "1";
  const log = join(stateDir, "quit.log");
  process.env.HERDR_JEV_BIN = writeScript("quit.sh", `printf '%s\\n' "$*" >> "${log}"\nexec sleep 3`);
  hooks.roster.people = ["w1:q1", "w1:q2", "w1:q3"].map((id) => blockedPerson({ id, status: "blocked" }));
  hooks.applyJevData();
  await sleep(150);
  expect(hooks.notifyOwner).toBe((notifyArgs as any).officeOwner);
  for (const state of hooks.notifyState.values()) state.escalatedRev = 1;

  const started = performance.now();
  hooks.releaseOwnedEscalations();
  expect(performance.now() - started).toBeLessThan(500);

  await waitFor(() => existsSync(log) && readFileSync(log, "utf-8").includes("\n"));
  const lines = readFileSync(log, "utf-8").trim().split("\n");
  expect(lines).toEqual([`notify --release-all --owner ${hooks.notifyOwner}`]);
});
