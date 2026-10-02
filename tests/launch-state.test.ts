import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { buildAgentsView } from "../src/herdr/agents.js";
import type { HerdrClient } from "../src/herdr/client.js";
import { closeWorkerPanes, executeWorkerClose, gridStatePath, launchStageInHerdr, readGridWorkerRecords, registerWorkerRun, updateGridWorkers, writeGridWorkers } from "../src/herdr/launcher.js";
import { resolveStateDir } from "../src/herdr/state-dir.js";
import type { HerdrCommandResult, StageSpec } from "../src/types/index.js";
import { createFakeHarness, type FakeHarness } from "./fake-harness.js";
import { assertNoRealHomeStateLeaks, createTestStateDir } from "./helpers.js";
import { writeHerdrFake } from "./launch-support.js";

const stage: StageSpec = { role: "implementer", model: "sonnet-5", effort: "high", extraFlags: [], description: "synthetic" };
const ok = (stdout = ""): HerdrCommandResult => ({ ok: true, code: 0, stdout, stderr: "" });
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

let testEnv: { stateDir: string; cleanup: () => void };
let sandbox: string;
let harness: FakeHarness | undefined;
const savedHerdrEnv = process.env.HERDR_ENV;

beforeEach(() => {
  testEnv = createTestStateDir();
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "launch-state-")));
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

interface FakeSwarm extends HerdrClient {
  created: string[];
}

function swarm(overrides: Partial<HerdrClient> = {}, callerId = "caller-A"): FakeSwarm {
  const created: string[] = [];
  const last = new Map<string, string>();
  let counter = 0;
  return {
    created,
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
    prompt: async (input) => { last.set(input.target, input.text); return ok(); },
    waitFor: async () => ok("done"),
    readAgent: async (target) => ok(last.get(target) ?? "❯ "),
    getAgent: async () => ok(JSON.stringify({ result: { agent: { agent_status: "idle" } } })),
    closePane: async () => ok(),
    notify: async () => ok(),
    ...overrides,
  };
}

function launch(herdr: HerdrClient, agentName: string) {
  return launchStageInHerdr({ client: "claude", stage, handoffPrompt: "parallel task", herdr, agentName, sourcePaneId: "caller-A", cwd: sandbox });
}

describe("grid state survives concurrent writers", () => {
  it("keeps both worker records when two spawns of one caller overlap", async () => {
    const herdr = swarm();
    const [first, second] = await Promise.all([launch(herdr, "peer-one"), launch(herdr, "peer-two")]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const records = readGridWorkerRecords("caller-A");
    expect(records.map((record) => record.paneId).sort()).toEqual(["w-1", "w-2"]);
    expect(records.map((record) => record.handle).sort()).toEqual(["peer-one", "peer-two"]);
  });

  it("keeps every record when several processes update the same caller", async () => {
    const script = join(sandbox, "writer.mjs");
    writeFileSync(script, `import { updateGridWorkers } from ${JSON.stringify(resolve(import.meta.dir, "../src/herdr/launcher.ts"))};
const tag = process.argv[2];
for (let i = 0; i < 25; i++) updateGridWorkers("shared", (records) => [...records, { paneId: tag + "-" + i }]);
`);
    const children = ["a", "b", "c"].map((tag) => new Promise<number | null>((done) => {
      const child = spawn(process.execPath, [script, tag], { env: { ...process.env, HERDR_JEV_STATE_DIR: testEnv.stateDir }, stdio: "ignore" });
      child.on("close", done);
    }));
    expect(await Promise.all(children)).toEqual([0, 0, 0]);
    const ids = readGridWorkerRecords("shared").map((record) => record.paneId);
    expect(ids).toHaveLength(75);
    expect(new Set(ids).size).toBe(75);
    expect(readdirSync(join(testEnv.stateDir, "grid")).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock"))).toEqual([]);
  });

  it("writes atomically with private permissions and never on read", () => {
    writeGridWorkers("caller-A", [{ paneId: "w-1", handle: "h" }]);
    const path = gridStatePath("caller-A");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const before = readFileSync(path, "utf8");
    const mtime = statSync(path).mtimeMs;
    readGridWorkerRecords("caller-A");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(statSync(path).mtimeMs).toBe(mtime);
  });

  it("never rewrites a damaged file on read and keeps a copy when the next update replaces it", () => {
    const path = gridStatePath("caller-A");
    mkdirSync(join(testEnv.stateDir, "grid"), { recursive: true });
    writeFileSync(path, "{not json");
    expect(readGridWorkerRecords("caller-A")).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe("{not json");
    updateGridWorkers("caller-A", (records) => [...records, { paneId: "w-9" }]);
    expect(readFileSync(`${path}.corrupt`, "utf8")).toBe("{not json");
    expect(readGridWorkerRecords("caller-A").map((record) => record.paneId)).toEqual(["w-9"]);
  });

  it("breaks a stale legacy directory lock instead of blocking forever", () => {
    const path = gridStatePath("caller-A");
    mkdirSync(`${path}.lock`, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${path}.lock`, old, old);
    updateGridWorkers("caller-A", () => [{ paneId: "w-1" }]);
    expect(readGridWorkerRecords("caller-A").map((record) => record.paneId)).toEqual(["w-1"]);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it("does not prune records another spawn added while the layout was being read", async () => {
    writeGridWorkers("caller-A", [{ paneId: "gone-1", handle: "old" }]);
    const herdr = swarm({
      paneLayout: async () => {
        await sleep(5);
        updateGridWorkers("caller-A", (records) => [...records, { paneId: "late-1", handle: "late" }]);
        return ok(JSON.stringify({ result: { layout: { area: { x: 0, y: 0, width: 200, height: 50 }, panes: [{ pane_id: "caller-A", rect: { x: 0, y: 0, width: 100, height: 50 } }] } } }));
      },
    });
    expect((await launch(herdr, "peer-one")).ok).toBe(true);
    expect(readGridWorkerRecords("caller-A").map((record) => record.paneId).sort()).toEqual(["late-1", "w-1"]);
  });
});

describe("the spawn fence is released when nothing was created", () => {
  it("lets the same handle be used again after a rejected split", async () => {
    let attempts = 0;
    const herdr = swarm({ splitCurrent: async () => { attempts++; return attempts === 1 ? { ok: false, code: 1, stdout: "", stderr: "layout refused" } : ok(JSON.stringify({ result: { pane: { pane_id: "w-1" } } })); } });
    const first = await launch(herdr, "retry-peer");
    expect(first.ok).toBe(false);
    expect(first.ackStatus).toBe("rejected");
    const second = await launch(herdr, "retry-peer");
    expect(second.ok).toBe(true);
    expect(second.error).toBeUndefined();
  });

  it("lets the handle be used again when the pane layout cannot be read", async () => {
    let layouts = 0;
    const herdr = swarm();
    const readable = herdr.paneLayout!;
    herdr.paneLayout = async (paneId) => { layouts++; return layouts === 1 ? { ok: false, code: 1, stdout: "", stderr: "layout unavailable" } : readable(paneId); };
    expect((await launch(herdr, "layout-peer")).ok).toBe(false);
    expect((await launch(herdr, "layout-peer")).ok).toBe(true);
  });

  it("keeps the fence when the split acknowledgement is uncertain", async () => {
    const herdr = swarm({ splitCurrent: async () => ({ ok: false, code: 1, stdout: "", stderr: "transport closed" }) });
    expect((await launch(herdr, "uncertain-peer")).ackStatus).toBe("unknown");
    const retry = await launch(herdr, "uncertain-peer");
    expect(retry.ok).toBe(false);
    expect(retry.error).toContain("Named spawn already attempted");
  });

  it("keeps the fence when the pane id cannot be read after a successful split", async () => {
    const herdr = swarm({ splitCurrent: async () => ok(JSON.stringify({ result: {} })) });
    expect((await launch(herdr, "noid-peer")).ackStatus).toBe("unknown");
    expect((await launch(herdr, "noid-peer")).error).toContain("Named spawn already attempted");
  });
});

function install() {
  harness = createFakeHarness("contract");
}

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8" });
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

function repoWithWorker(runPane = "pane-42") {
  const repo = join(sandbox, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "fixture");
  writeGridWorkers("caller-1", [{ paneId: runPane, handle: "jev-research-sonnet5-abc", cwd: repo, branch: "main", forkSha: git(repo, "rev-parse", "HEAD") }]);
  return registerWorkerRun({ client: "claude", model: "sonnet-5", role: "researcher", cwd: repo, pane: runPane, handle: "jev-research-sonnet5-abc", prompt: "task", callerPaneId: "caller-1" })!;
}

const settleCalls = () => harness!.callsFor("external-run").filter((argv) => argv[2] === "worker-settle");
const runState = () => JSON.parse(readFileSync(join(harness!.dir, "state.json"), "utf8")).runs[0].stages[0].state;

describe("close and prune reconcile with the real pane state", () => {
  it("keeps the record and leaves the run open when the pane did not close", async () => {
    install();
    const runId = repoWithWorker();
    const client = { closePane: async () => ({ ok: false, code: 1, stdout: "", stderr: "pane busy" }) } as unknown as HerdrClient;
    const plan = [{ callerPaneId: "caller-1", paneId: "pane-42", status: "idle" }];
    const outcome = await closeWorkerPanes(client, plan);
    expect(outcome.closed).toEqual([]);
    expect(outcome.failed).toEqual([{ paneId: "pane-42", error: "pane busy" }]);
    expect(outcome.settlements).toEqual([]);
    expect(await executeWorkerClose(client, plan)).toEqual([]);
    expect(settleCalls()).toHaveLength(0);
    expect(runState()).toBe("working");
    expect(readGridWorkerRecords("caller-1").map((record) => [record.paneId, record.runId])).toEqual([["pane-42", runId]]);
  });

  it("settles the run once the pane is confirmed closed or already gone", async () => {
    install();
    const runId = repoWithWorker();
    const gone = { closePane: async () => ({ ok: false, code: 1, stdout: JSON.stringify({ error: { code: "pane_not_found" } }), stderr: "" }) } as unknown as HerdrClient;
    const outcome = await closeWorkerPanes(gone, [{ callerPaneId: "caller-1", paneId: "pane-42", status: "done" }]);
    expect(outcome.closed).toEqual(["pane-42"]);
    expect(outcome.settlements).toEqual([{ paneId: "pane-42", runId, settled: true }]);
    expect(runState()).toBe("closed");
    expect(readGridWorkerRecords("caller-1")).toEqual([]);
  });

  it("closes the healthy panes of a plan and keeps only the failed one", async () => {
    install();
    writeGridWorkers("caller-1", [{ paneId: "pane-1" }, { paneId: "pane-2" }]);
    const client = { closePane: async (pane: string) => pane === "pane-1" ? ok() : { ok: false, code: 1, stdout: "", stderr: "denied" } } as unknown as HerdrClient;
    const outcome = await closeWorkerPanes(client, [{ callerPaneId: "caller-1", paneId: "pane-1", status: "idle" }, { callerPaneId: "caller-1", paneId: "pane-2", status: "idle" }]);
    expect(outcome.closed).toEqual(["pane-1"]);
    expect(outcome.failed.map((item) => item.paneId)).toEqual(["pane-2"]);
    expect(readGridWorkerRecords("caller-1").map((record) => record.paneId)).toEqual(["pane-2"]);
  });

  function closeCli(mode: "fail" | "gone") {
    const herdr = writeHerdrFake(sandbox);
    const env = { ...process.env, HERDR_ENV: "1", HERDR_BIN_PATH: herdr.bin, HERDR_JEV_SOURCE_PANE_ID: "caller-1", HERDR_JEV_STATE_DIR: testEnv.stateDir,
      HERDR_JEV_TEST_GUARD: "1", HOME: sandbox, TYPESAFE_API_KEY: "", HERDR_JEV_CONFIG_DIR: join(sandbox, "config"), FAKE_HERDR_CLOSE: mode };
    return spawnSync(process.execPath, [resolve(import.meta.dir, "../src/cli.ts"), "workers", "close", "--all-idle", "--yes"], { encoding: "utf8", env, cwd: sandbox, timeout: 60_000 });
  }

  it("workers close reports a pane that stayed open and keeps its tracking", () => {
    install();
    const runId = repoWithWorker();
    const closed = closeCli("fail");
    expect(closed.status).toBe(1);
    expect(closed.stderr).toContain("Could not close pane-42");
    expect(closed.stdout).not.toContain("Closed pane-42");
    expect(runState()).toBe("working");
    expect(readGridWorkerRecords("caller-1")[0]!.runId).toBe(runId);
  });

  it("workers close settles a pane that is already gone", () => {
    install();
    const runId = repoWithWorker();
    const closed = closeCli("gone");
    expect(closed.status).toBe(0);
    expect(closed.stdout).toContain(`Closed pane-42 (idle) run ${runId} settled`);
    expect(runState()).toBe("closed");
  });

  it("settles the run of a record the launch layout filter drops", async () => {
    install();
    const runId = repoWithWorker("gone-1");
    const herdr = swarm({}, "caller-1");
    expect((await launchStageInHerdr({ client: "claude", stage, handoffPrompt: "next task", herdr, agentName: "next-peer", sourcePaneId: "caller-1", cwd: sandbox })).ok).toBe(true);
    expect(readGridWorkerRecords("caller-1").map((record) => record.paneId)).toEqual(["w-1"]);
    expect(settleCalls()).toHaveLength(1);
    expect(JSON.parse(settleCalls()[0]![settleCalls()[0]!.indexOf("--request-json") + 1]!)).toMatchObject({ id: runId, state: "closed" });
    expect(runState()).toBe("closed");
  });

  it("settles the run of a record the swarm view prunes as dead", async () => {
    install();
    const runId = repoWithWorker("gone-1");
    const client = { listPanes: async () => ok(JSON.stringify({ result: { panes: [{ pane_id: "caller-1" }] } })) } as unknown as HerdrClient;
    await buildAgentsView("caller-1", { client, overviewData: [], runs: [], git: async () => ({ ok: false, stdout: "", stderr: "" }) });
    expect(readGridWorkerRecords("caller-1")).toEqual([]);
    expect(settleCalls()).toHaveLength(1);
    expect(JSON.parse(settleCalls()[0]![settleCalls()[0]!.indexOf("--request-json") + 1]!)).toMatchObject({ id: runId, state: "closed" });
  });
});

describe("one state root for every module", () => {
  function isolatedEnv(extra: Record<string, string> = {}) {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const key of ["HERDR_JEV_STATE_DIR", "HERDR_PLUGIN_STATE_DIR", "HERDR_PLUGIN_ID", "AI_HARNESS_ROOT", "AI_HARNESS_CORE_PATH", "HERDR_JEV_TEST_GUARD", "AI_HARNESS_TEST_GUARD"]) delete env[key];
    return { ...env, HOME: sandbox, PATH: "/usr/bin:/bin", TYPESAFE_API_KEY: "", HERDR_JEV_CONFIG_DIR: join(sandbox, "config"), ...extra };
  }

  const RUN_ID = "11111111-1111-4111-8111-111111111111";

  function seedRun(root: string) {
    mkdirSync(join(root, RUN_ID), { recursive: true });
    writeFileSync(join(root, RUN_ID, "run.json"), JSON.stringify({ generated_at: "2026-10-01T00:00:00.000Z", cwd: "/repo", tasks: [{ id: "implementer", state: "done" }] }));
  }

  function listRuns(env: Record<string, string | undefined>) {
    const listed = spawnSync(process.execPath, [resolve(import.meta.dir, "../src/cli.ts"), "runs", "list", "--json"], { encoding: "utf8", env: env as NodeJS.ProcessEnv, cwd: sandbox, timeout: 60_000 });
    expect([listed.status, listed.stderr]).toEqual([0, ""]);
    return JSON.parse(listed.stdout).map((entry: any) => entry.id);
  }

  it("lists runs from the plugin state directory like every other module", () => {
    const pluginState = join(sandbox, "plugin-state");
    seedRun(pluginState);
    const env = isolatedEnv({ HERDR_PLUGIN_ID: "herdr-jev", HERDR_PLUGIN_STATE_DIR: pluginState, HERDR_JEV_TEST_GUARD: "1" });
    expect(listRuns(env)).toEqual([RUN_ID]);
  });

  it("keeps grid, peer locks and run history together under the plugin state directory", () => {
    const pluginState = join(sandbox, "plugin-state");
    const herdr = writeHerdrFake(sandbox);
    const env = isolatedEnv({ HERDR_PLUGIN_ID: "herdr-jev", HERDR_PLUGIN_STATE_DIR: pluginState, HERDR_JEV_TEST_GUARD: "1", HERDR_ENV: "1", HERDR_BIN_PATH: herdr.bin,
      HERDR_JEV_SOURCE_PANE_ID: "caller-1", HERDR_JEV_READY_TIMEOUT_MS: "3000", HERDR_JEV_CROSS_HARNESS: "disabled" });
    const spawned = spawnSync(process.execPath, [resolve(import.meta.dir, "../src/cli.ts"), "subagent", "implement the change", "--target", "claude", "--model", "sonnet-5", "--effort", "high", "--cwd", sandbox],
      { encoding: "utf8", env: env as NodeJS.ProcessEnv, cwd: sandbox, timeout: 60_000 });
    expect(spawned.status).toBe(0);
    expect(existsSync(join(pluginState, "grid", "caller-1.json"))).toBe(true);
    expect(readdirSync(join(pluginState, "peer-locks")).some((name) => name.endsWith(".dispatch"))).toBe(true);
    expect(existsSync(join(sandbox, ".local"))).toBe(false);
  });

  function toolEnv(configured: string) {
    const generated = join(sandbox, "generated");
    mkdirSync(generated, { recursive: true });
    writeFileSync(join(generated, "tool-env.json"), JSON.stringify({ tools: { "herdr-jev": { stateDir: configured } } }));
    return isolatedEnv({ AI_HARNESS_GENERATED_DIR: generated });
  }

  it("reads the state directory configured in tool-env.json", () => {
    const configured = join(sandbox, "configured-state");
    seedRun(configured);
    expect(listRuns(toolEnv(configured))).toEqual([RUN_ID]);
  });

  it("moves the default state directory over when the configured one is first used", () => {
    const configured = join(sandbox, "configured-state");
    const legacy = join(sandbox, ".local", "state", "herdr-jev");
    seedRun(legacy);
    expect(listRuns(toolEnv(configured))).toEqual([RUN_ID]);
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(join(configured, RUN_ID, "run.json"))).toBe(true);
    expect(listRuns(toolEnv(configured))).toEqual([RUN_ID]);
  });

  describe("resolveStateDir", () => {
    const generatedEnv = (extra: Record<string, string> = {}) => {
      const generated = join(sandbox, "generated");
      mkdirSync(generated, { recursive: true });
      return { AI_HARNESS_GENERATED_DIR: generated, HOME: sandbox, ...extra };
    };
    const writeToolEnv = (stateDir: string) => writeFileSync(join(sandbox, "generated", "tool-env.json"), JSON.stringify({ tools: { "herdr-jev": { stateDir } } }));

    it("moves the default state over once the configured directory is resolved and keeps answering the configured one", () => {
      const legacy = join(sandbox, ".local", "state", "herdr-jev");
      const configured = join(sandbox, "configured");
      const env = generatedEnv();
      writeToolEnv(configured);
      mkdirSync(join(legacy, "grid"), { recursive: true });
      writeFileSync(join(legacy, "grid", "caller.json"), "{}");
      expect(resolveStateDir(env)).toBe(configured);
      expect(readFileSync(join(configured, "grid", "caller.json"), "utf8")).toBe("{}");
      expect(existsSync(legacy)).toBe(false);
      mkdirSync(legacy, { recursive: true });
      expect(resolveStateDir(env)).toBe(configured);
      expect(resolveStateDir({ ...env, HERDR_JEV_STATE_DIR: join(sandbox, "explicit") })).toBe(join(sandbox, "explicit"));
    });

    it("anchors a relative state directory to the starting directory, not the current one", () => {
      const before = resolveStateDir({ HERDR_JEV_STATE_DIR: "relative/state" });
      expect(isAbsolute(before)).toBe(true);
      const cwd = process.cwd();
      process.chdir(sandbox);
      try {
        expect(resolveStateDir({ HERDR_JEV_STATE_DIR: "relative/state" })).toBe(before);
        expect(resolveStateDir({ HERDR_PLUGIN_STATE_DIR: "relative/plugin" })).toBe(resolve(cwd, "relative/plugin"));
      } finally {
        process.chdir(cwd);
      }
    });

    it("ignores a blank override and still refuses a missing directory under the test guard", () => {
      expect(() => resolveStateDir({ HERDR_JEV_STATE_DIR: "  ", HERDR_JEV_TEST_GUARD: "1" })).toThrow("state_dir_required_in_tests");
    });
  });
});
