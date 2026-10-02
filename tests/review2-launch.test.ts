import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { buildAgentsView } from "../src/herdr/agents.js";
import type { HerdrClient } from "../src/herdr/client.js";
import { closeWorkerPanes, gridStatePath, launchStageInHerdr, readGridWorkerRecords, registerWorkerRun, settleDeadRecords, updateGridWorkers, withGridLock, writeGridWorkers } from "../src/herdr/launcher.js";
import { migrateLegacyState, resolveConfigDirs, resolveStateDir } from "../src/herdr/state-dir.js";
import { confirmWorkspaceTrust } from "../src/herdr/trust.js";
import { isClientPromptReady } from "../src/herdr/launcher.js";
import type { HerdrCommandResult, StageSpec } from "../src/types/index.js";
import { createFakeHarness, type FakeHarness, type FakeHarnessMode } from "./fake-harness.js";
import { assertNoRealHomeStateLeaks, createTestStateDir } from "./helpers.js";
import { writeHerdrFake } from "./launch-support.js";
import { resumePipeline } from "../src/orchestration/pipeline.js";

const stage: StageSpec = { role: "implementer", model: "sonnet-5", effort: "high", extraFlags: [], description: "synthetic" };
const ok = (stdout = ""): HerdrCommandResult => ({ ok: true, code: 0, stdout, stderr: "" });
const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
const DIALOG_NO = fixture("claude-trust-dialog-27cols.txt");
const DIALOG_YES = DIALOG_NO.replace("❯ No, exit\n  Yes, I trust this", "  No, exit\n❯ Yes, I trust this");
const READY = fixture("claude-ready-placeholder-30cols.txt");

let testEnv: { stateDir: string; cleanup: () => void };
let sandbox: string;
let harness: FakeHarness | undefined;
let counter = 0;
const savedHerdrEnv = process.env.HERDR_ENV;

beforeEach(() => {
  testEnv = createTestStateDir();
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "review2-launch-")));
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

function install(mode: FakeHarnessMode = "contract") {
  harness = createFakeHarness(mode);
}

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, encoding: "utf8" });
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

function makeRepo(name = "repo") {
  const repo = join(sandbox, name);
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "fixture");
  return repo;
}

const settleCalls = () => harness!.callsFor("external-run").filter((argv) => argv[2] === "worker-settle");
const runStates = () => JSON.parse(readFileSync(join(harness!.dir, "state.json"), "utf8")).runs.map((run: any) => run.stages[0].state);

function swarm(callerId = "caller-A", overrides: Partial<HerdrClient> = {}): HerdrClient & { created: string[] } {
  const created: string[] = [];
  const last = new Map<string, string>();
  let next = 0;
  const open = async () => {
    const id = `w-${++next}`;
    created.push(id);
    return ok(JSON.stringify({ result: { pane: { pane_id: id } } }));
  };
  return {
    created,
    paneLayout: async () => ok(JSON.stringify({ result: { layout: { area: { x: 0, y: 0, width: 200, height: 50 },
      panes: [{ pane_id: callerId, rect: { x: 0, y: 0, width: 100, height: 50 } }, ...created.map((id, index) => ({ pane_id: id, rect: { x: 100, y: index * 10, width: 100, height: 10 } }))] } } })),
    splitCurrent: open,
    createTab: open,
    startAgent: async () => ok(),
    reportSpawn: async () => ok(),
    prompt: async (input) => { last.set(input.target, input.text); return ok(); },
    waitFor: async () => ok("done"),
    readAgent: async (target) => ok(last.get(target) ?? "❯ "),
    getAgent: async () => ok(JSON.stringify({ result: { agent: { agent_status: "idle" } } })),
    closePane: async () => ok(),
    notify: async () => ok(),
    ...overrides,
  };
}

function launch(herdr: HerdrClient, name: string, extra: Partial<Parameters<typeof launchStageInHerdr>[0]> = {}) {
  return launchStageInHerdr({ client: "claude", stage, handoffPrompt: "parallel task", herdr, agentName: name, sourcePaneId: "caller-A", cwd: sandbox, ...extra });
}

function aged(path: string, seconds = 60) {
  const old = new Date(Date.now() - seconds * 1000);
  utimesSync(path, old, old);
}

describe("the grid lock belongs to its owner", () => {
  it("takes over a stale file lock", () => {
    const path = gridStatePath("caller-A");
    mkdirSync(join(testEnv.stateDir, "grid"), { recursive: true });
    writeFileSync(`${path}.lock`, "dead-owner");
    aged(`${path}.lock`);
    updateGridWorkers("caller-A", () => [{ paneId: "w-1" }]);
    expect(readGridWorkerRecords("caller-A").map((record) => record.paneId)).toEqual(["w-1"]);
    expect(existsSync(`${path}.lock`)).toBe(false);
    expect(readdirSync(join(testEnv.stateDir, "grid")).filter((name) => name.endsWith(".stale") || name.endsWith(".grave"))).toEqual([]);
  });

  it("does not delete a lock another process created after this one saw it stale", () => {
    const path = gridStatePath("caller-A");
    const lock = `${path}.lock`;
    mkdirSync(join(testEnv.stateDir, "grid"), { recursive: true });
    writeFileSync(lock, "stale-owner");
    aged(lock);
    const events: string[] = [];
    const result = withGridLock(path, () => {
      events.push("ran");
      return "done";
    }, {
      waitMs: 3000,
      afterStaleSeen: () => {
        unlinkSync(lock);
        writeFileSync(lock, "fresh-owner");
        events.push("replaced");
      },
      onWait: () => {
        if (events.includes("released")) return;
        events.push(readFileSync(lock, "utf8") === "fresh-owner" ? "fresh-intact" : "fresh-lost");
        unlinkSync(lock);
        events.push("released");
      },
    });
    expect(result).toBe("done");
    expect(events).toEqual(["replaced", "fresh-intact", "released", "ran"]);
  });

  it("releases only the lock it owns", () => {
    const path = gridStatePath("caller-A");
    const lock = `${path}.lock`;
    withGridLock(path, () => {
      unlinkSync(lock);
      writeFileSync(lock, "other-owner");
    });
    expect(readFileSync(lock, "utf8")).toBe("other-owner");
  });

  it("gives up at the deadline when the lock cannot be inspected instead of spinning", () => {
    const path = gridStatePath("caller-A");
    mkdirSync(join(testEnv.stateDir, "grid"), { recursive: true });
    symlinkSync(join(sandbox, "nowhere"), `${path}.lock`);
    expect(() => withGridLock(path, () => 1, { waitMs: 150 })).toThrow("grid_state_lock_timeout");
  });
});

describe("a grid state failure after the pane exists", () => {
  function breakGridState() {
    writeFileSync(join(testEnv.stateDir, "grid"), "not a directory");
  }

  it("still starts the agent and reports the pane", async () => {
    breakGridState();
    const result = await launch(swarm(), "peer-broken");
    expect(result.ok).toBe(true);
    expect(result.paneId).toBe("w-1");
    expect(result.paneCreated).toBe(true);
    expect(result.promptDelivered).toBe(true);
    expect(result.trackingError).toBeTruthy();
  });

  it("does the same on the retry path that names the peer", async () => {
    breakGridState();
    const missing = JSON.stringify({ error: { code: "agent_not_found" } });
    let started = false;
    const herdr = swarm("caller-A", {
      getAgent: async () => started ? ok(JSON.stringify({ result: { agent: { agent_status: "idle" } } })) : { ok: false, code: 1, stdout: missing, stderr: "" },
      startAgent: async () => { started = true; return ok(); },
    });
    const result = await launch(herdr, "peer-retry", { reuseExisting: true });
    expect(result.ok).toBe(true);
    expect(result.paneId).toBe("w-1");
    expect(result.trackingError).toBeTruthy();
  });

  it("reports an unreadable pane layout without throwing and frees the handle", async () => {
    let calls = 0;
    const herdr = swarm("caller-A");
    const real = herdr.paneLayout!;
    herdr.paneLayout = async (pane) => ++calls === 1 ? ok("null") : real(pane);
    const first = await launch(herdr, "peer-null");
    expect(first.ok).toBe(false);
    expect(first.error).toBe("Could not parse Herdr pane layout");
    expect((await launch(herdr, "peer-null")).ok).toBe(true);
  });
});

describe("every worker created in the harness can be settled", () => {
  it("tracks tab and split workers with their layout kind", async () => {
    const herdr = swarm();
    expect((await launch(herdr, "peer-tab", { layout: "tab" })).ok).toBe(true);
    expect((await launch(herdr, "peer-right", { direction: "right" })).ok).toBe(true);
    expect((await launch(herdr, "peer-grid")).ok).toBe(true);
    const records = readGridWorkerRecords("caller-A");
    expect(records.map((record) => [record.handle, record.layout, record.cwd])).toEqual([
      ["peer-tab", "tab", sandbox], ["peer-right", "split", sandbox], ["peer-grid", "grid", sandbox],
    ]);
  });

  it("creates the run of a tab worker, stores its id and settles it on close", async () => {
    install();
    const herdr = swarm();
    const result = await launch(herdr, "peer-tab", { layout: "tab" });
    const runId = registerWorkerRun({ client: "claude", model: "sonnet-5", role: "implementer", cwd: sandbox, pane: result.paneId!, handle: "peer-tab", prompt: "task", callerPaneId: "caller-A" });
    expect(runId).toBeTruthy();
    expect(readGridWorkerRecords("caller-A")[0]!.runId).toBe(runId!);
    const outcome = await closeWorkerPanes(herdr, [{ callerPaneId: "caller-A", paneId: result.paneId!, status: "idle" }]);
    expect(outcome.settlements).toEqual([{ paneId: result.paneId!, runId: runId!, settled: true }]);
    expect(runStates()).toEqual(["closed"]);
    expect(readGridWorkerRecords("caller-A")).toEqual([]);
  });

  it("does not create a run for a worker nothing tracks", () => {
    install();
    expect(registerWorkerRun({ client: "claude", model: "sonnet-5", role: "implementer", cwd: sandbox, pane: "w-9", handle: "h", prompt: "task", callerPaneId: "caller-A" })).toBeNull();
    expect(harness!.callsFor("external-run")).toEqual([]);
  });

  it("keeps a tab worker out of the dead set computed from the layout of another tab", async () => {
    install();
    const repo = makeRepo();
    writeGridWorkers("caller-A", [{ paneId: "tab-1", handle: "t", cwd: repo, layout: "tab" }]);
    registerWorkerRun({ client: "claude", model: "sonnet-5", role: "implementer", cwd: repo, pane: "tab-1", handle: "t", prompt: "task", callerPaneId: "caller-A" });
    expect((await launch(swarm(), "peer-next")).ok).toBe(true);
    expect(readGridWorkerRecords("caller-A").map((record) => record.paneId)).toEqual(["tab-1", "w-1"]);
    expect(settleCalls()).toHaveLength(0);
  });

  it("runs the whole way through the CLI for a split worker", () => {
    install();
    const repo = makeRepo();
    const herdr = writeHerdrFake(sandbox);
    const stateDir = join(sandbox, "state");
    mkdirSync(stateDir);
    const env = { ...process.env, HERDR_ENV: "1", HERDR_BIN_PATH: herdr.bin, HERDR_JEV_SOURCE_PANE_ID: "caller-1", HERDR_JEV_STATE_DIR: stateDir,
      HERDR_JEV_TEST_GUARD: "1", HOME: sandbox, TYPESAFE_API_KEY: "", HERDR_JEV_READY_TIMEOUT_MS: "3000", HERDR_JEV_CROSS_HARNESS: "disabled",
      HERDR_JEV_CONFIG_DIR: join(sandbox, "config") };
    const cli = resolve(import.meta.dir, "../src/cli.ts");
    const spawned = spawnSync(process.execPath, [cli, "subagent", "split task", "--target", "claude", "--model", "sonnet-5", "--direction", "right", "--cwd", repo],
      { encoding: "utf8", env, cwd: repo, timeout: 60_000 });
    expect(spawned.status).toBe(0);
    const summary = JSON.parse(spawned.stdout.trim().split("\n").filter((line) => line.startsWith("{")).at(-1)!);
    expect(summary.runId).toBeTruthy();
    expect(JSON.parse(readFileSync(join(stateDir, "grid", "caller-1.json"), "utf8")).workers[0]).toMatchObject({ paneId: "pane-42", runId: summary.runId, layout: "split" });
    const closed = spawnSync(process.execPath, [cli, "workers", "close", "--all-idle", "--yes"], { encoding: "utf8", env, cwd: repo, timeout: 60_000 });
    expect(closed.status).toBe(0);
    expect(closed.stdout).toContain(`run ${summary.runId} settled`);
    expect(runStates()).toEqual(["closed"]);
  });

  it("still prints the result when the bookkeeping fails after a successful spawn", () => {
    install();
    const repo = makeRepo();
    const herdr = writeHerdrFake(sandbox);
    const stateDir = join(sandbox, "state");
    mkdirSync(stateDir);
    writeFileSync(join(stateDir, "grid"), "not a directory");
    const env = { ...process.env, HERDR_ENV: "1", HERDR_BIN_PATH: herdr.bin, HERDR_JEV_SOURCE_PANE_ID: "caller-1", HERDR_JEV_STATE_DIR: stateDir,
      HERDR_JEV_TEST_GUARD: "1", HOME: sandbox, TYPESAFE_API_KEY: "", HERDR_JEV_READY_TIMEOUT_MS: "3000", HERDR_JEV_CROSS_HARNESS: "disabled",
      HERDR_JEV_CONFIG_DIR: join(sandbox, "config") };
    const spawned = spawnSync(process.execPath, [resolve(import.meta.dir, "../src/cli.ts"), "subagent", "task", "--target", "claude", "--model", "sonnet-5", "--worktree", "bk", "--cwd", repo],
      { encoding: "utf8", env, cwd: repo, timeout: 60_000 });
    expect(spawned.status).toBe(0);
    const summary = JSON.parse(spawned.stdout.trim().split("\n").filter((line) => line.startsWith("{")).at(-1)!);
    expect(summary).toMatchObject({ ok: true, paneId: "pane-42" });
    expect("runId" in summary).toBe(false);
    expect(spawned.stderr).toContain("Worker bookkeeping failed");
    expect(harness!.callsFor("external-run").filter((argv) => argv[2] === "worker-create")).toEqual([]);
  });
});

describe("a layout that cannot be trusted never prunes", () => {
  function seedDead() {
    install();
    const repo = makeRepo();
    writeGridWorkers("caller-A", [{ paneId: "gone-1", handle: "old", cwd: repo, branch: "main", forkSha: git(repo, "rev-parse", "HEAD") }]);
    registerWorkerRun({ client: "claude", model: "sonnet-5", role: "implementer", cwd: repo, pane: "gone-1", handle: "old", prompt: "task", callerPaneId: "caller-A" });
  }

  it("keeps every record when the layout does not contain the caller pane", async () => {
    seedDead();
    const herdr = swarm("caller-A", { paneLayout: async () => ok(JSON.stringify({ result: { layout: { panes: [] } } })) });
    expect((await launch(herdr, "peer-one")).ok).toBe(true);
    expect(readGridWorkerRecords("caller-A").map((record) => record.paneId).sort()).toEqual(["gone-1", "w-1"]);
    expect(settleCalls()).toHaveLength(0);
  });

  it("keeps a worker whose pane is listed without a rectangle", async () => {
    seedDead();
    const herdr = swarm("caller-A", { paneLayout: async () => ok(JSON.stringify({ result: { layout: { panes: [{ pane_id: "caller-A" }, { pane_id: "gone-1" }] } } })) });
    expect((await launch(herdr, "peer-one")).ok).toBe(true);
    expect(readGridWorkerRecords("caller-A").map((record) => record.paneId).sort()).toEqual(["gone-1", "w-1"]);
    expect(settleCalls()).toHaveLength(0);
  });

  it("prunes and settles once the layout shows the caller without the worker", async () => {
    seedDead();
    expect((await launch(swarm(), "peer-one")).ok).toBe(true);
    expect(readGridWorkerRecords("caller-A").map((record) => record.paneId)).toEqual(["w-1"]);
    expect(settleCalls()).toHaveLength(1);
  });
});

describe("the swarm view treats an unknown live set as unknown", () => {
  const noGit = async () => ({ ok: false, stdout: "", stderr: "" });

  function seed() {
    install();
    const repo = makeRepo();
    writeGridWorkers("caller-1", [{ paneId: "pane-42", handle: "h", cwd: repo, branch: "main", forkSha: git(repo, "rev-parse", "HEAD") }]);
    registerWorkerRun({ client: "claude", model: "sonnet-5", role: "implementer", cwd: repo, pane: "pane-42", handle: "h", prompt: "task", callerPaneId: "caller-1" });
  }

  const listing = (payload: unknown) => ({ listPanes: async () => ok(JSON.stringify(payload)) }) as unknown as HerdrClient;

  for (const [label, payload] of [
    ["an empty list", { result: { panes: [] } }],
    ["an unrecognised shape", { result: { workspaces: [1] } }],
    ["a list without the caller pane", { result: { panes: [{ pane_id: "other-pane" }] } }],
  ] as const) {
    it(`does not prune or settle on ${label}`, async () => {
      seed();
      await buildAgentsView("caller-1", { client: listing(payload), overviewData: [], runs: [], git: noGit });
      expect(readGridWorkerRecords("caller-1").map((record) => record.paneId)).toEqual(["pane-42"]);
      expect(settleCalls()).toHaveLength(0);
      expect(runStates()).toEqual(["working"]);
    });
  }

  it("prunes a worker the live list confirms gone", async () => {
    seed();
    await buildAgentsView("caller-1", { client: listing({ result: { panes: [{ pane_id: "caller-1" }] } }), overviewData: [], runs: [], git: noGit });
    expect(readGridWorkerRecords("caller-1")).toEqual([]);
    expect(runStates()).toEqual(["closed"]);
  });

  it("does not judge a tab worker from the layout of the caller tab", async () => {
    install();
    writeGridWorkers("caller-1", [{ paneId: "tab-1", handle: "t", layout: "tab" }, { paneId: "split-1", handle: "s", layout: "split" }]);
    const client = { paneLayout: async () => ok(JSON.stringify({ result: { layout: { panes: [{ pane_id: "caller-1" }] } } })) } as unknown as HerdrClient;
    await buildAgentsView("caller-1", { client, overviewData: [], runs: [], git: noGit });
    expect(readGridWorkerRecords("caller-1").map((record) => record.paneId)).toEqual(["tab-1"]);
  });
});

describe("closing and settling stay retryable", () => {
  it("keeps a record whose settlement failed and drops it after the last attempt", async () => {
    install("legacy");
    const repo = makeRepo();
    const record = { paneId: "pane-1", handle: "h", cwd: repo, runId: "00000000-0000-4000-8000-000000000009" };
    const client = { closePane: async () => ok() } as unknown as HerdrClient;
    const plan = [{ callerPaneId: "caller-1", paneId: "pane-1", status: "idle" }];
    writeGridWorkers("caller-1", [record]);
    expect((await closeWorkerPanes(client, plan)).settlements[0]!.settled).toBe(false);
    expect(readGridWorkerRecords("caller-1").map((item) => [item.paneId, item.settleAttempts])).toEqual([["pane-1", 1]]);
    await closeWorkerPanes(client, plan);
    expect(readGridWorkerRecords("caller-1")[0]!.settleAttempts).toBe(2);
    await closeWorkerPanes(client, plan);
    expect(readGridWorkerRecords("caller-1")).toEqual([]);
  });

  it("settles a worker whose branch survives its removed worktree with the branch head", () => {
    install();
    const repo = makeRepo();
    const tree = join(sandbox, "tree");
    git(repo, "worktree", "add", "-q", "-b", "wt/gone", tree);
    git(tree, "commit", "-q", "--allow-empty", "-m", "work");
    const head = git(tree, "rev-parse", "HEAD");
    const common = git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir");
    writeGridWorkers("caller-1", [{ paneId: "pane-1", handle: "h", cwd: tree, branch: "wt/gone", forkSha: head, gitDir: common }]);
    expect(registerWorkerRun({ client: "claude", model: "sonnet-5", role: "implementer", cwd: tree, pane: "pane-1", handle: "h", prompt: "task", callerPaneId: "caller-1" })).toBeTruthy();
    rmSync(tree, { recursive: true, force: true });
    const outcome = settleDeadRecords(readGridWorkerRecords("caller-1"));
    expect(outcome.settlements[0]!.settled).toBe(true);
    const settle = settleCalls()[0]!;
    expect(JSON.parse(settle[settle.indexOf("--request-json") + 1]!).head).toBe(head);
  });

  it("does not take a generic not-found answer for a closed pane", async () => {
    writeGridWorkers("caller-1", [{ paneId: "pane-1" }]);
    const reply = (stdout: string) => ({ closePane: async () => ({ ok: false, code: 1, stdout, stderr: "" }) }) as unknown as HerdrClient;
    const plan = [{ callerPaneId: "caller-1", paneId: "pane-1", status: "idle" }];
    const generic = await closeWorkerPanes(reply(JSON.stringify({ error: { code: "workspace_not_found" } })), plan);
    expect(generic.closed).toEqual([]);
    expect(readGridWorkerRecords("caller-1")).toHaveLength(1);
    const gone = await closeWorkerPanes(reply(JSON.stringify({ error: { code: "pane_not_found", message: "pane pane-1 not found" } })), plan);
    expect(gone.closed).toEqual(["pane-1"]);
  });

  it("reports a record it could not update", async () => {
    if (process.getuid?.() === 0) return;
    writeGridWorkers("caller-1", [{ paneId: "pane-1" }]);
    const grid = join(testEnv.stateDir, "grid");
    chmodSync(grid, 0o500);
    try {
      const outcome = await closeWorkerPanes({ closePane: async () => ok() } as unknown as HerdrClient, [{ callerPaneId: "caller-1", paneId: "pane-1", status: "idle" }]);
      expect(outcome.closed).toEqual(["pane-1"]);
      expect(outcome.pruneFailures.length).toBeGreaterThan(0);
      expect(outcome.pruneFailures[0]!.file).toContain("caller-1.json");
    } finally {
      chmodSync(grid, 0o700);
    }
  });
});

describe("trust is bound to the folder that is confirmed", () => {
  function clock() {
    let now = 0;
    return { now: () => now, sleep: async (ms: number) => { now += ms; } };
  }

  function pane(frames: (state: { reads: number; enters: number; sinceEnter: number; keys: string[] }) => string) {
    const state = { keys: [] as string[], prompts: [] as string[], reads: 0, enters: 0, sinceEnter: -1 };
    const client: HerdrClient = {
      splitCurrent: async () => ok(JSON.stringify({ result: { pane: { pane_id: "pane-42" } } })),
      startAgent: async () => ok(),
      reportSpawn: async () => ok(),
      prompt: async (input) => { state.prompts.push(input.text); return ok(); },
      waitFor: async () => ok("done"),
      readAgent: async () => {
        if (state.prompts.length) return ok(state.prompts[0]!);
        if (state.sinceEnter >= 0) state.sinceEnter++;
        state.reads++;
        return ok(frames({ reads: state.reads, enters: state.enters, sinceEnter: state.sinceEnter, keys: state.keys }));
      },
      getAgent: async () => ok(JSON.stringify({ result: { agent: { agent_status: "idle" } } })),
      sendKeys: async (_target, keys) => {
        state.keys.push(keys[0]!);
        if (keys[0] === "enter") { state.enters++; state.sinceEnter = 0; }
        return ok();
      },
      closePane: async () => ok(),
      notify: async () => ok(),
    };
    return { client, state };
  }

  function trusting(workdir: string) {
    harness = createFakeHarness("contract", { FAKE_TRUST_ROOTS: workdir });
  }

  function start(client: HerdrClient, workdir: string, extra: Partial<StageSpec> = {}) {
    counter++;
    return launchStageInHerdr({ client: "claude", stage: { ...stage, ...extra }, handoffPrompt: "private task text", sourcePaneId: "parent-1",
      agentName: `bound-peer-${process.pid}-${counter}`, herdr: client, cwd: workdir, clock: clock() });
  }

  it("sends the resolved absolute folder to the policy check", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "bound-")));
    try {
      const seen: string[] = [];
      const { client } = pane(() => DIALOG_YES);
      await confirmWorkspaceTrust({ herdr: client, target: "peer", cwd: relative(process.cwd(), workdir), clock: clock(), lookup: (path) => { seen.push(path); return { trusted: false, reason: "no" }; } });
      expect(seen).toEqual([workdir]);
    } finally { rmSync(workdir, { recursive: true, force: true }); }
  });

  it("never confirms when a flag moves the agent to another folder", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "bound-")));
    try {
      trusting(workdir);
      for (const flags of [["--add-dir", "/etc"], ["--cd=/etc"], ["-C", "/etc"]]) {
        const { client, state } = pane(() => DIALOG_YES);
        const outcome = await confirmWorkspaceTrust({ herdr: client, target: "peer", cwd: workdir, flags, clock: clock() });
        expect(outcome).toEqual({ confirmed: false, reason: "directory_flags_present" });
        expect(state.keys).toEqual([]);
      }
      const { client, state } = pane(() => DIALOG_YES);
      const result = await start(client, workdir, { extraFlags: ["--add-dir", "/etc"] });
      expect(result.trustRequired).toBe(true);
      expect(result.trustPolicyReason).toBe("directory_flags_present");
      expect(state.keys).toEqual([]);
    } finally { rmSync(workdir, { recursive: true, force: true }); }
  });

  it("goes on to the readiness wait when the dialog is already gone", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "bound-")));
    try {
      trusting(workdir);
      const { client, state } = pane(({ reads }) => reads <= 1 ? DIALOG_YES : READY);
      const result = await start(client, workdir);
      expect(state.keys).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.trustRequired).toBeUndefined();
      expect(state.prompts).toHaveLength(1);
    } finally { rmSync(workdir, { recursive: true, force: true }); }
  });

  it("goes on to the readiness wait when the agent takes long to start after trust", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "bound-")));
    try {
      trusting(workdir);
      const { client, state } = pane(({ enters, sinceEnter }) => enters > 0 ? (sinceEnter >= 26 ? READY : "Starting...\n") : DIALOG_YES);
      const result = await start(client, workdir);
      expect(state.keys).toEqual(["enter"]);
      expect(result.ok).toBe(true);
      expect(result.trustRequired).toBeUndefined();
      expect(result.trustConfirmed).toBeUndefined();
      expect(state.prompts).toHaveLength(1);
    } finally { rmSync(workdir, { recursive: true, force: true }); }
  });

  it("does not claim a confirmation when the dialog comes back after one", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "bound-")));
    try {
      trusting(workdir);
      const { client, state } = pane(({ enters, sinceEnter }) => enters > 0 ? (sinceEnter <= 1 ? READY : DIALOG_YES) : DIALOG_YES);
      const result = await start(client, workdir);
      expect(state.keys).toEqual(["enter"]);
      expect(result.ok).toBe(false);
      expect(result.trustRequired).toBe(true);
      expect(result.trustConfirmed).toBeUndefined();
      expect(result.trustPolicyReason).toBe("trust_dialog_reappeared");
      expect(state.prompts).toEqual([]);
    } finally { rmSync(workdir, { recursive: true, force: true }); }
  });

  it("keeps the ready check of the agent in the confirmation", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "bound-")));
    try {
      trusting(workdir);
      const { client } = pane(({ enters }) => enters > 0 ? READY : DIALOG_YES);
      const outcome = await confirmWorkspaceTrust({ herdr: client, target: "peer", cwd: workdir, clock: clock(), ready: (text) => isClientPromptReady("claude", text) });
      expect(outcome.confirmed).toBe(true);
    } finally { rmSync(workdir, { recursive: true, force: true }); }
  });
});

describe("the state root", () => {
  const generated = () => {
    const dir = join(sandbox, "generated");
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const envFor = (configured: string) => {
    writeFileSync(join(generated(), "tool-env.json"), JSON.stringify({ tools: { "herdr-jev": { stateDir: configured } } }));
    return { AI_HARNESS_GENERATED_DIR: generated(), HOME: sandbox } as NodeJS.ProcessEnv;
  };

  it("merges the default state into a configured directory that already exists without overwriting it", () => {
    const legacy = join(sandbox, "old");
    const configured = join(sandbox, "new");
    mkdirSync(join(legacy, "grid"), { recursive: true });
    mkdirSync(join(configured, "grid"), { recursive: true });
    writeFileSync(join(legacy, "grid", "a.json"), "legacy-a");
    writeFileSync(join(legacy, "grid", "b.json"), "legacy-b");
    writeFileSync(join(legacy, "marker"), "legacy-marker");
    writeFileSync(join(configured, "grid", "a.json"), "configured-a");
    migrateLegacyState(legacy, configured);
    expect(readFileSync(join(configured, "grid", "a.json"), "utf8")).toBe("configured-a");
    expect(readFileSync(join(configured, "grid", "b.json"), "utf8")).toBe("legacy-b");
    expect(readFileSync(join(configured, "marker"), "utf8")).toBe("legacy-marker");
    expect(readFileSync(join(legacy, "grid", "a.json"), "utf8")).toBe("legacy-a");
    expect(existsSync(join(legacy, "grid", "b.json"))).toBe(false);
    migrateLegacyState(legacy, configured);
    expect(readFileSync(join(configured, "grid", "a.json"), "utf8")).toBe("configured-a");
  });

  it("moves a whole default directory in one step and does nothing without one", () => {
    const legacy = join(sandbox, "old");
    const configured = join(sandbox, "deep", "new");
    migrateLegacyState(legacy, configured);
    expect(existsSync(configured)).toBe(false);
    mkdirSync(legacy);
    writeFileSync(join(legacy, "fence.dispatch"), "1");
    migrateLegacyState(legacy, configured);
    expect(readFileSync(join(configured, "fence.dispatch"), "utf8")).toBe("1");
    expect(existsSync(legacy)).toBe(false);
  });

  it("answers the same root for the whole process even if the default directory comes back", () => {
    const legacy = join(sandbox, ".local", "state", "herdr-jev");
    const configured = join(sandbox, "configured");
    const env = envFor(configured);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "first"), "1");
    expect(resolveStateDir(env)).toBe(configured);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "second"), "2");
    expect(resolveStateDir(env)).toBe(configured);
    expect(existsSync(join(configured, "first"))).toBe(true);
    expect(existsSync(join(legacy, "second"))).toBe(true);
  });

  it("loses nothing when several processes resolve the configured root at once", async () => {
    const legacy = join(sandbox, ".local", "state", "herdr-jev");
    const configured = join(sandbox, "configured");
    const env = envFor(configured);
    mkdirSync(join(legacy, "grid"), { recursive: true });
    for (let i = 0; i < 60; i++) writeFileSync(join(legacy, "grid", `c${i}.json`), `record-${i}`);
    const script = join(sandbox, "resolve.mjs");
    writeFileSync(script, `import { resolveStateDir } from ${JSON.stringify(resolve(import.meta.dir, "../src/herdr/state-dir.ts"))};\nconsole.log(resolveStateDir(process.env));\n`);
    const childEnv = { ...process.env, ...env } as Record<string, string>;
    delete childEnv.HERDR_JEV_TEST_GUARD;
    delete childEnv.AI_HARNESS_TEST_GUARD;
    delete childEnv.HERDR_JEV_STATE_DIR;
    const runs = Array.from({ length: 4 }, () => new Promise<{ code: number | null; out: string }>((done) => {
      const child = spawn(process.execPath, [script], { env: childEnv, stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.on("close", (code) => done({ code, out: out.trim() }));
    }));
    for (const result of await Promise.all(runs)) expect(result).toEqual({ code: 0, out: configured });
    const names = readdirSync(join(configured, "grid")).sort();
    expect(names).toHaveLength(60);
    for (let i = 0; i < 60; i++) expect(readFileSync(join(configured, "grid", `c${i}.json`), "utf8")).toBe(`record-${i}`);
    expect(existsSync(legacy)).toBe(false);
  });

  it("anchors the configuration directory like the state directory", () => {
    expect(resolveConfigDirs({ HERDR_JEV_CONFIG_DIR: "~/herdr-config" })).toEqual([join(homedir(), "herdr-config")]);
    const before = resolveConfigDirs({ HERDR_JEV_CONFIG_DIR: "relative/config" })[0]!;
    expect(before.startsWith("/")).toBe(true);
    const cwd = process.cwd();
    process.chdir(sandbox);
    try {
      expect(resolveConfigDirs({ HERDR_JEV_CONFIG_DIR: "relative/config" })[0]).toBe(before);
    } finally {
      process.chdir(cwd);
    }
  });

  it("keeps loading after the starting directory is removed while running", () => {
    const script = join(sandbox, "vanish.mjs");
    writeFileSync(script, `import { mkdirSync, rmSync } from "node:fs";
const dir = process.argv[2];
mkdirSync(dir);
process.chdir(dir);
rmSync(dir, { recursive: true });
const state = await import(${JSON.stringify(resolve(import.meta.dir, "../src/herdr/state-dir.ts"))});
console.log(JSON.stringify([state.resolveStateDir({ HERDR_JEV_STATE_DIR: "/abs/state" }), state.resolveConfigDirs({ HERDR_JEV_CONFIG_DIR: "/abs/config" })[0]]));
`);
    const run = spawnSync(process.execPath, [script, join(sandbox, "vanishing")], { encoding: "utf8", cwd: sandbox, timeout: 60_000 });
    expect([run.status, run.stderr]).toEqual([0, ""]);
    expect(JSON.parse(run.stdout)).toEqual(["/abs/state", "/abs/config"]);
  });
});

describe("configuration commands", () => {
  function cliEnv(extra: Record<string, string> = {}) {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const key of ["HERDR_JEV_STATE_DIR", "HERDR_PLUGIN_STATE_DIR", "HERDR_PLUGIN_ID", "AI_HARNESS_ROOT", "AI_HARNESS_CORE_PATH", "HERDR_JEV_TEST_GUARD", "AI_HARNESS_TEST_GUARD", "HERDR_ENV"]) delete env[key];
    return { ...env, HOME: sandbox, PATH: "/usr/bin:/bin", TYPESAFE_API_KEY: "", ...extra } as NodeJS.ProcessEnv;
  }
  const cli = resolve(import.meta.dir, "../src/cli.ts");

  it("resets the quotas on a configuration directory that does not exist yet", () => {
    const config = join(sandbox, "fresh", "config");
    const reset = spawnSync(process.execPath, [cli, "quota", "reset"], { encoding: "utf8", env: cliEnv({ HERDR_JEV_CONFIG_DIR: config }), cwd: sandbox, timeout: 60_000 });
    expect([reset.status, reset.stderr]).toEqual([0, ""]);
    expect(JSON.parse(readFileSync(join(config, "herdr-jev-quotas.json"), "utf8"))).toEqual([]);
  });

  it("clears an exhaustion kept in the default directory when the configured one is new", () => {
    const legacy = join(sandbox, ".config", "herdr");
    mkdirSync(legacy, { recursive: true });
    const later = new Date(Date.now() + 3_600_000).toISOString();
    writeFileSync(join(legacy, "herdr-jev-quotas.json"), JSON.stringify([{ client: "claude", model: "*", exhaustedAt: new Date().toISOString(), expiresAt: later }]));
    const generated = join(sandbox, "generated");
    mkdirSync(generated, { recursive: true });
    const configured = join(sandbox, "fresh-config");
    writeFileSync(join(generated, "tool-env.json"), JSON.stringify({ tools: { "herdr-jev": { configDir: configured } } }));
    const env = cliEnv({ AI_HARNESS_GENERATED_DIR: generated });
    const reset = spawnSync(process.execPath, [cli, "quota", "reset"], { encoding: "utf8", env, cwd: sandbox, timeout: 60_000 });
    expect([reset.status, reset.stderr]).toEqual([0, ""]);
    expect(JSON.parse(readFileSync(join(configured, "herdr-jev-quotas.json"), "utf8"))).toEqual([]);
  });

  it("refuses a client name it does not know instead of printing the Claude catalog", () => {
    const typo = spawnSync(process.execPath, [cli, "models", "catalog", "codx"], { encoding: "utf8", env: cliEnv({ HERDR_JEV_CONFIG_DIR: join(sandbox, "config") }), cwd: sandbox, timeout: 60_000 });
    expect(typo.status).toBe(1);
    expect(JSON.parse(typo.stderr.trim())).toMatchObject({ error: "unknown_client", client: "codx" });
    expect(typo.stdout).toBe("");
    const known = spawnSync(process.execPath, [cli, "models", "catalog", "codex"], { encoding: "utf8", env: cliEnv({ HERDR_JEV_CONFIG_DIR: join(sandbox, "config") }), cwd: sandbox, timeout: 60_000 });
    expect(known.stderr).not.toContain("unknown_client");
  });
});

describe("resuming a run whose objective is not in the state directory", () => {
  it("fails with a named error instead of a raw file error", async () => {
    install();
    const repo = makeRepo();
    writeFileSync(join(harness!.bin, "ai-harness"), `#!${process.execPath}
const argv = process.argv.slice(2);
if (argv[0] === "external-run" && argv[2] === "status") console.log(JSON.stringify({ id: JSON.parse(argv[4]).id, cwd: ${JSON.stringify(repo)}, objectiveDigest: "x", stages: [] }));
`, { mode: 0o755 });
    await expect(resumePipeline("11111111-1111-4111-8111-111111111111", { delegation: {}, wait: false, timeoutMs: 5000, cwd: repo })).rejects.toThrow("resume_objective_missing");
  });
});
