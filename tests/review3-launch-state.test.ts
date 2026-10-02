import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrClient } from "../src/herdr/client.js";
import { buildAgentCommand, closeWorkerPanes, launchStageInHerdr, readGridWorkerRecords, registerWorkerRun, writeGridWorkers } from "../src/herdr/launcher.js";
import { migrateLegacyState, resolveStateDir } from "../src/herdr/state-dir.js";
import type { HerdrCommandResult, StageSpec } from "../src/types/index.js";
import { createFakeHarness, type FakeHarness } from "./fake-harness.js";
import { assertNoRealHomeStateLeaks, createTestStateDir } from "./helpers.js";

const stage: StageSpec = { role: "implementer", model: "sonnet-5", effort: "high", extraFlags: [], description: "synthetic" };
const ok = (stdout = ""): HerdrCommandResult => ({ ok: true, code: 0, stdout, stderr: "" });
const fail = (stderr: string, stdout = ""): HerdrCommandResult => ({ ok: false, code: 1, stdout, stderr });
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

let testEnv: { stateDir: string; cleanup: () => void };
let sandbox: string;
let harness: FakeHarness | undefined;
const savedHerdrEnv = process.env.HERDR_ENV;

beforeEach(() => {
  testEnv = createTestStateDir();
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "r3-launch-state-")));
  process.env.HERDR_ENV = "1";
});

afterEach(() => {
  harness?.restore();
  harness = undefined;
  rmSync(sandbox, { recursive: true, force: true });
  if (savedHerdrEnv === undefined) delete process.env.HERDR_ENV;
  else process.env.HERDR_ENV = savedHerdrEnv;
  testEnv.cleanup();
  assertNoRealHomeStateLeaks();
});

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8" });
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

function swarm(overrides: Partial<HerdrClient> = {}, callerId = "caller-A") {
  const created: string[] = [];
  let counter = 0;
  const client: HerdrClient = {
    paneLayout: async () => {
      await sleep(3);
      const panes = [{ pane_id: callerId, rect: { x: 0, y: 0, width: 100, height: 50 } },
        ...created.map((id, index) => ({ pane_id: id, rect: { x: 100, y: index * 10, width: 100, height: 10 } }))];
      return ok(JSON.stringify({ result: { layout: { area: { x: 0, y: 0, width: 200, height: 50 }, panes } } }));
    },
    splitCurrent: async () => {
      await sleep(3);
      const id = `w-${++counter}`;
      created.push(id);
      return ok(JSON.stringify({ result: { pane: { pane_id: id } } }));
    },
    startAgent: async () => ok(),
    reportSpawn: async () => ok(),
    prompt: async () => ok(),
    waitFor: async () => ok("done"),
    readAgent: async () => ok("❯ "),
    getAgent: async () => ok(JSON.stringify({ result: { agent: { agent_status: "idle" } } })),
    closePane: async () => ok(),
    notify: async () => ok(),
    ...overrides,
  };
  return { client, created };
}

const launch = (client: HerdrClient, agentName: string) =>
  launchStageInHerdr({ client: "claude", stage, handoffPrompt: "", herdr: client, agentName, sourcePaneId: "caller-A", cwd: sandbox });

describe("a rejected agent start", () => {
  it("closes the pane, drops its tracking record and reports no pane", async () => {
    const closed: string[] = [];
    const { client } = swarm({ startAgent: async () => fail("unsupported agent kind"), closePane: async (pane) => { closed.push(pane); return ok(); } });
    const result = await launch(client, "peer-rejected-1");
    expect(result.ok).toBe(false);
    expect(result.ackStatus).toBe("rejected");
    expect(closed).toEqual(["w-1"]);
    expect(result.paneCreated).toBe(false);
    expect(readGridWorkerRecords("caller-A")).toEqual([]);
    expect(existsSync(join(testEnv.stateDir, "grid", "caller-A.json"))).toBe(false);
  });

  it("drops the record when the pane was already gone", async () => {
    const { client } = swarm({ startAgent: async () => fail("unsupported agent kind"), closePane: async () => fail("", JSON.stringify({ error: { code: "pane_not_found" } })) });
    const result = await launch(client, "peer-rejected-2");
    expect(result.paneCreated).toBe(false);
    expect(readGridWorkerRecords("caller-A")).toEqual([]);
  });

  it("keeps the record and reports the pane when it could not be closed", async () => {
    const { client } = swarm({ startAgent: async () => fail("unsupported agent kind"), closePane: async () => fail("pane busy") });
    const result = await launch(client, "peer-rejected-3");
    expect(result.ackStatus).toBe("rejected");
    expect(result.paneCreated).toBe(true);
    expect(result.paneId).toBe("w-1");
    expect(readGridWorkerRecords("caller-A").map((record) => record.paneId)).toEqual(["w-1"]);
  });
});

describe("pane close results", () => {
  const plan = [{ callerPaneId: "caller-A", paneId: "w-1", status: "idle" }];

  async function closeWith(result: HerdrCommandResult) {
    writeGridWorkers("caller-A", [{ paneId: "w-1" }]);
    const outcome = await closeWorkerPanes({ closePane: async () => result } as unknown as HerdrClient, plan);
    return { outcome, records: readGridWorkerRecords("caller-A").map((record) => record.paneId) };
  }

  it("keeps a live pane whose error only mentions something not found", async () => {
    for (const result of [fail("pane busy: config file not found"), fail("pane is attached\nsession not found"), fail("cannot close pane w-1: socket not found")]) {
      const { outcome, records } = await closeWith(result);
      expect(outcome.closed).toEqual([]);
      expect(outcome.failed.map((item) => item.paneId)).toEqual(["w-1"]);
      expect(records).toEqual(["w-1"]);
    }
  });

  it("treats the structured code and a plain pane-not-found line as already closed", async () => {
    for (const result of [fail("", JSON.stringify({ error: { code: "pane_not_found" } })), fail("Error: pane w-1 not found"), fail("pane not found.")]) {
      const { outcome, records } = await closeWith(result);
      expect(outcome.closed).toEqual(["w-1"]);
      expect(records).toEqual([]);
    }
  });
});

describe("dead records reaped by a launch", () => {
  const settleCalls = () => harness!.callsFor("external-run").filter((argv) => argv[2] === "worker-settle");

  function deadWorker() {
    const repo = join(sandbox, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "commit", "-q", "--allow-empty", "-m", "fixture");
    writeGridWorkers("caller-A", [{ paneId: "gone-1", handle: "dead-worker", cwd: repo, branch: "main", forkSha: git(repo, "rev-parse", "HEAD") }]);
    return registerWorkerRun({ client: "claude", model: "sonnet-5", role: "researcher", cwd: repo, pane: "gone-1", handle: "dead-worker", prompt: "task", callerPaneId: "caller-A" })!;
  }

  it("settles the run once even when two launches overlap", async () => {
    harness = createFakeHarness("contract");
    deadWorker();
    const { client } = swarm();
    const [first, second] = await Promise.all([launch(client, "peer-overlap-1"), launch(client, "peer-overlap-2")]);
    expect([first.ok, second.ok]).toEqual([true, true]);
    expect(settleCalls()).toHaveLength(1);
    expect(readGridWorkerRecords("caller-A").map((record) => record.paneId).sort()).toEqual(["w-1", "w-2"]);
  });

  it("settles before any pane is created, so no empty pane waits on the harness", async () => {
    harness = createFakeHarness("contract");
    deadWorker();
    const seen: number[] = [];
    const base = swarm();
    const split = base.client.splitCurrent.bind(base.client);
    base.client.splitCurrent = async (options) => { seen.push(settleCalls().length); return split(options); };
    const result = await launch(base.client, "peer-order-1");
    expect(result.ok).toBe(true);
    expect(seen).toEqual([1]);
  });

  it("keeps a record whose settlement failed for a later attempt and drops it after the last one", async () => {
    harness = createFakeHarness("legacy");
    writeGridWorkers("caller-A", [{ paneId: "gone-1", handle: "dead-worker", cwd: sandbox, runId: "00000000-0000-4000-8000-000000000009" }]);
    const { client } = swarm();
    expect((await launch(client, "peer-keep-1")).ok).toBe(true);
    expect(readGridWorkerRecords("caller-A").map((record) => [record.paneId, record.settleAttempts]).sort()).toEqual([["gone-1", 1], ["w-1", undefined]]);
    expect((await launch(client, "peer-keep-2")).ok).toBe(true);
    expect((await launch(client, "peer-keep-3")).ok).toBe(true);
    expect(readGridWorkerRecords("caller-A").map((record) => record.paneId).sort()).toEqual(["w-1", "w-2", "w-3"]);
  });
});

describe("reviewer flags", () => {
  const reviewer: StageSpec = { role: "reviewer", model: "gpt-5.6-sol", effort: "high", extraFlags: [], description: "synthetic" };

  it("strips attached short forms and config keys with leading whitespace", () => {
    const hostile = ['-csandbox_mode="danger-full-access"', "-c", ' sandbox_mode="danger-full-access"', "-capproval_policy=never", "--config", " approval_policy=never",
      "-c", '"sandbox_mode"="danger-full-access"', "-sdanger-full-access", "-anever", "--sandbox=danger-full-access", "--keep-me"];
    const argv = buildAgentCommand("codex", { ...reviewer, extraFlags: hostile });
    const joined = argv.join("\n");
    expect(joined).not.toContain("danger-full-access");
    expect(joined).not.toContain("approval_policy");
    expect(argv).not.toContain("-anever");
    expect(argv).toContain("--keep-me");
    expect(argv.slice(-2)).toEqual(["--sandbox", "read-only"]);
  });

  it("still keeps harmless short flags and config keys", () => {
    const argv = buildAgentCommand("codex", { ...reviewer, extraFlags: ["-c", "model_verbosity=low", "-cmodel_verbosity=low"] });
    expect(argv).toContain("model_verbosity=low");
    expect(argv).toContain("-cmodel_verbosity=low");
  });
});

describe("legacy state migration", () => {
  const sharedMemory = "/dev/shm";
  const crossDevice = () => existsSync(sharedMemory) && statSync(sharedMemory).dev !== statSync(sandbox).dev;

  it("moves a whole tree across devices without leaving staging files or partial names", () => {
    if (!crossDevice()) return;
    const configured = mkdtempSync(join(sharedMemory, "r3-state-"));
    try {
      const legacy = join(sandbox, "old");
      mkdirSync(join(legacy, "grid"), { recursive: true });
      writeFileSync(join(legacy, "grid", "caller.json"), JSON.stringify({ callerPaneId: "wE5:pF", workers: [{ paneId: "wE5:pG" }] }));
      writeFileSync(join(legacy, "fence.dispatch"), "1");
      expect(migrateLegacyState(legacy, join(configured, "state"))).toEqual([]);
      expect(JSON.parse(readFileSync(join(configured, "state", "grid", "caller.json"), "utf8")).callerPaneId).toBe("wE5:pF");
      expect(readFileSync(join(configured, "state", "fence.dispatch"), "utf8")).toBe("1");
      expect(existsSync(legacy)).toBe(false);
      expect(readdirSync(join(configured, "state", "grid"))).toEqual(["caller.json"]);
    } finally {
      rmSync(configured, { recursive: true, force: true });
    }
  });

  it("copies an entry across devices into a staging name before it appears under its final name", () => {
    if (!crossDevice()) return;
    const configured = mkdtempSync(join(sharedMemory, "r3-state-"));
    try {
      const legacy = join(sandbox, "old");
      mkdirSync(legacy, { recursive: true });
      writeFileSync(join(configured, "present"), "configured");
      writeFileSync(join(legacy, "present"), "legacy");
      writeFileSync(join(legacy, "fresh"), "legacy");
      expect(migrateLegacyState(legacy, configured)).toEqual(["present: conflict"]);
      expect(readFileSync(join(legacy, "present"), "utf8")).toBe("legacy");
      expect(readFileSync(join(configured, "present"), "utf8")).toBe("configured");
      expect(readFileSync(join(configured, "fresh"), "utf8")).toBe("legacy");
      expect(readdirSync(configured).filter((name) => name.endsWith(".migrating"))).toEqual([]);
    } finally {
      rmSync(configured, { recursive: true, force: true });
    }
  });

  it("returns what it could not move instead of swallowing it", () => {
    const legacy = join(sandbox, "old");
    const configured = join(sandbox, "new");
    mkdirSync(join(legacy, "grid"), { recursive: true });
    writeFileSync(join(legacy, "grid", "a.json"), "{}");
    mkdirSync(configured);
    writeFileSync(join(configured, "grid"), "not a directory");
    expect(migrateLegacyState(legacy, configured)).toEqual(["grid: conflict"]);
    expect(existsSync(join(legacy, "grid", "a.json"))).toBe(true);
  });

  it("warns once on stderr when the configured root is resolved with leftovers", () => {
    const home = join(sandbox, "home");
    const legacy = join(home, ".local", "state", "herdr-jev");
    const configured = join(sandbox, "configured");
    mkdirSync(join(legacy, "grid"), { recursive: true });
    writeFileSync(join(legacy, "grid", "a.json"), "{}");
    mkdirSync(configured);
    writeFileSync(join(configured, "grid"), "not a directory");
    const generated = join(sandbox, "generated");
    mkdirSync(generated);
    writeFileSync(join(generated, "tool-env.json"), JSON.stringify({ tools: { "herdr-jev": { stateDir: configured } } }));
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const env = { HOME: home, AI_HARNESS_GENERATED_DIR: generated };
      expect(resolveStateDir(env)).toBe(configured);
      expect(resolveStateDir(env)).toBe(configured);
      const warnings = spy.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("State migration"));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("grid: conflict");
    } finally {
      spy.mockRestore();
    }
  });
});
