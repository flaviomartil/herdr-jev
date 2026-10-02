import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildAgentsView } from "../src/herdr/agents.js";
import type { HerdrClient } from "../src/herdr/client.js";
import { executeWorkerClose, readGridWorkerRecords, registerWorkerRun, writeGridWorkers } from "../src/herdr/launcher.js";
import { formatRunHistory, mergeRunHistory } from "../src/orchestration/run-history.js";
import { createFakeHarness, type FakeHarness, type FakeHarnessMode } from "./fake-harness.js";
import { assertNoRealHomeStateLeaks, createTestStateDir } from "./helpers.js";

const PROMPT = "PRIVATE-OBJECTIVE-TEXT implement the billing export and keep this wording out of every request";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let testEnv: { stateDir: string; cleanup: () => void };
let harness: FakeHarness | undefined;
let repo: string;

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, encoding: "utf8" });
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

function install(mode: FakeHarnessMode = "contract") {
  harness = createFakeHarness(mode);
}

beforeEach(() => {
  testEnv = createTestStateDir();
  repo = realpathSync(mkdtempSync(join(tmpdir(), "workers-repo-")));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "fixture");
});

afterEach(() => {
  harness?.restore();
  harness = undefined;
  rmSync(repo, { recursive: true, force: true });
  testEnv.cleanup();
  assertNoRealHomeStateLeaks();
});

function register(callerPaneId = "caller-1") {
  return registerWorkerRun({ client: "claude", model: "sonnet-5", role: "researcher", cwd: repo, pane: "pane-42", handle: "jev-research-sonnet5-abc",
    prompt: PROMPT, callerPaneId });
}

function seedRecord(extra: Record<string, unknown> = {}) {
  writeGridWorkers("caller-1", [{ paneId: "pane-42", handle: "jev-research-sonnet5-abc", cwd: repo, branch: "main", forkSha: git(repo, "rev-parse", "HEAD"), ...extra }]);
}

describe("worker runs recorded in the harness", () => {
  it("creates a worker run with the prompt digest only and stores the run id in the grid record", () => {
    install();
    seedRecord();
    const id = register();
    expect(id).toMatch(RUN_ID);
    const creates = harness!.callsFor("external-run");
    expect(creates).toHaveLength(1);
    expect(creates[0]!.slice(0, 3)).toEqual(["external-run", "--action", "worker-create"]);
    const request = JSON.parse(creates[0]![creates[0]!.indexOf("--request-json") + 1]!);
    expect(request).toEqual({ client: "claude", model: "sonnet-5", role: "researcher", cwd: repo, branch: "main", forkSha: git(repo, "rev-parse", "HEAD"),
      pane: "pane-42", handle: "jev-research-sonnet5-abc", objectiveDigest: digest(PROMPT) });
    expect(harness!.rawLog()).not.toContain("PRIVATE-OBJECTIVE-TEXT");
    expect(readGridWorkerRecords("caller-1")[0]!.runId).toBe(id);
  });

  it("derives the branch and fork point from the repository when the tracked record carries none", () => {
    install();
    writeGridWorkers("caller-1", [{ paneId: "pane-42", handle: "jev-research-sonnet5-abc", cwd: repo }]);
    const id = register();
    expect(id).toMatch(RUN_ID);
    const request = JSON.parse(harness!.callsFor("external-run")[0]![harness!.callsFor("external-run")[0]!.indexOf("--request-json") + 1]!);
    expect(request.branch).toBe("main");
    expect(request.forkSha).toBe(git(repo, "rev-parse", "HEAD"));
    expect(readGridWorkerRecords("caller-1")[0]!.runId).toBe(id);
  });

  it("never creates a run for a pane that no record tracks", () => {
    install();
    expect(register("untracked-caller")).toBeNull();
    expect(register(undefined as unknown as string)).toBeNull();
    expect(harness!.callsFor("external-run")).toEqual([]);
    expect(readGridWorkerRecords("untracked-caller")).toEqual([]);
  });

  for (const mode of ["unknown", "legacy"] as const) {
    it(`records nothing and keeps working when the harness lacks worker runs (${mode})`, () => {
      install(mode);
      seedRecord();
      expect(register()).toBeNull();
      expect(readGridWorkerRecords("caller-1")[0]!.runId).toBeUndefined();
    });
  }

  it("records nothing when no harness is installed", () => {
    seedRecord();
    expect(register()).toBeNull();
  });

  it("settles the run as closed with the worker branch head when the worker is closed", async () => {
    install();
    seedRecord();
    const id = register()!;
    const closed: string[] = [];
    const client = { closePane: async (pane: string) => { closed.push(pane); return { ok: true, code: 0, stdout: "", stderr: "" }; } } as unknown as HerdrClient;
    const head = git(repo, "rev-parse", "HEAD");
    const settlements = await executeWorkerClose(client, [{ callerPaneId: "caller-1", paneId: "pane-42", status: "idle" }]);
    expect(closed).toEqual(["pane-42"]);
    expect(settlements).toEqual([{ paneId: "pane-42", runId: id, settled: true }]);
    const settle = harness!.callsFor("external-run").find((argv) => argv[2] === "worker-settle")!;
    expect(JSON.parse(settle[settle.indexOf("--request-json") + 1]!)).toEqual({ id, state: "closed", head });
    const state = JSON.parse(readFileSync(join(harness!.dir, "state.json"), "utf8"));
    expect(state.runs[0].stages[0].state).toBe("closed");
    expect(readGridWorkerRecords("caller-1")).toEqual([]);
  });

  it("closes workers without a run id and tolerates a harness that cannot settle", async () => {
    install("legacy");
    seedRecord({ runId: "00000000-0000-4000-8000-000000000009" });
    const client = { closePane: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }) } as unknown as HerdrClient;
    const settlements = await executeWorkerClose(client, [{ callerPaneId: "caller-1", paneId: "pane-42", status: "done" }]);
    expect(settlements).toEqual([{ paneId: "pane-42", runId: "00000000-0000-4000-8000-000000000009", settled: false }]);
    seedRecord();
    expect(await executeWorkerClose(client, [{ callerPaneId: "caller-1", paneId: "pane-42", status: "done" }])).toEqual([]);
  });

  it("exposes the run id and state per worker in the swarm data", async () => {
    install();
    seedRecord();
    const id = register()!;
    const noGit = async () => ({ ok: false, stdout: "", stderr: "" });
    const groups = await buildAgentsView("caller-1", { workers: readGridWorkerRecords("caller-1"), overviewData: [], runs: [], git: noGit });
    const row = groups[0]!.rows[0]!;
    expect(row.runId).toBe(id);
    expect(row.runState).toBe("working");
    expect(row.run).toBe("worker: working");
    const injected = await buildAgentsView("caller-1", { workers: readGridWorkerRecords("caller-1"), overviewData: [], runs: [], git: noGit,
      harnessRuns: [{ id, kind: "worker", stages: [{ role: "researcher", state: "closed" }] }] });
    expect(injected[0]!.rows[0]!.runState).toBe("closed");
  });

  it("leaves the swarm rows unchanged for workers without a run", async () => {
    writeGridWorkers("caller-1", [{ paneId: "pane-1", handle: "h", cwd: repo }]);
    const groups = await buildAgentsView("caller-1", { workers: readGridWorkerRecords("caller-1"), overviewData: [], runs: [], git: async () => ({ ok: false, stdout: "", stderr: "" }) });
    const row = groups[0]!.rows[0]!;
    expect("runId" in row).toBe(false);
    expect("runState" in row).toBe(false);
    expect(row.run).toBeNull();
  });
});

describe("run history merge", () => {
  const localId = "11111111-1111-1111-1111-111111111111";
  const local = [{ id: localId, projection: { generated_at: "2026-09-30T00:00:00.000Z", tasks: [{ id: "implementer", state: "done" }] }, mtimeMs: 10, timestampMs: Date.parse("2026-09-30T00:00:00.000Z") }];

  it("merges local projections with the harness list and shows the kind", () => {
    const remote = [
      { id: "00000000-0000-4000-8000-000000000001", kind: "worker", cwd: "/repo", createdAt: "2026-10-01T12:00:00.000Z", stages: [{ role: "researcher", state: "working" }] },
      { id: localId, kind: "pipeline", createdAt: "2026-09-30T00:00:00.000Z", stages: [] },
    ];
    const merged = mergeRunHistory(local, remote, 10);
    expect(merged.map((entry) => [entry.id, entry.kind, entry.source])).toEqual([
      ["00000000-0000-4000-8000-000000000001", "worker", "harness"],
      [localId, "pipeline", "both"],
    ]);
    expect(formatRunHistory(merged[0]!, Date.parse("2026-10-01T12:00:30.000Z"))).toBe("00000000-0000-4000-8000-000000000001  worker  researcher:working  cwd=/repo  30s ago");
    expect(formatRunHistory(merged[1]!, Date.parse("2026-09-30T00:01:00.000Z"))).toContain(`${localId}  pipeline  implementer:done`);
  });

  it("keeps local projections as pipelines when the harness cannot list and honors the limit", () => {
    expect(mergeRunHistory(local, null, 5).map((entry) => [entry.id, entry.kind, entry.source])).toEqual([[localId, "pipeline", "local"]]);
    expect(mergeRunHistory(local, [{ id: "00000000-0000-4000-8000-000000000002", kind: "worker", createdAt: "2026-10-01T00:00:00.000Z" }], 1)).toHaveLength(1);
    expect(formatRunHistory(local[0]!, Date.parse("2026-09-30T00:00:10.000Z"))).toBe(`${localId}  implementer:done  10s ago`);
  });
});

function writeFakeHerdr(dir: string): { bin: string; log: string } {
  const bin = join(dir, "herdr");
  const log = join(dir, "herdr.jsonl");
  const marker = join(dir, "prompted");
  writeFileSync(bin, `#!${process.execPath}
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const prompted = existsSync(${JSON.stringify(marker)});
const [group, action] = args;
if (group === "pane" && action === "layout") {
  console.log(JSON.stringify({ result: { layout: { area: { x: 0, y: 0, width: 200, height: 50 }, panes: [{ pane_id: "caller-1", rect: { x: 0, y: 0, width: 200, height: 50 } }, { pane_id: "pane-42", rect: { x: 100, y: 0, width: 100, height: 50 } }] } } }));
} else if (group === "pane" && action === "split") {
  console.log(JSON.stringify({ result: { pane: { pane_id: "pane-42" } } }));
} else if (group === "agent" && action === "get") {
  const target = args[2];
  if (target === "caller-1") console.log(JSON.stringify({ result: { agent: { name: "caller", agent: "claude", pane_id: "caller-1", agent_status: "idle", cwd: ${JSON.stringify(dir)} } } }));
  else console.log(JSON.stringify({ result: { agent: { name: target, agent: "claude", pane_id: "pane-42", agent_status: prompted ? "idle" : "idle" } } }));
} else if (group === "agent" && action === "read") {
  console.log(prompted ? "PRIVATE-OBJECTIVE-TEXT implement the billing export" : "❯ ");
} else if (group === "agent" && action === "prompt") {
  writeFileSync(${JSON.stringify(marker)}, "1");
  console.log(JSON.stringify({ result: { agent: { agent_status: "working" } } }));
}
process.exit(0);
`, { mode: 0o755 });
  chmodSync(bin, 0o755);
  return { bin, log };
}

describe("herdr-jev subagent, workers close and runs list against the contract fake", () => {
  it("records the worker, keeps the prompt out of every request, settles it on close and lists it", () => {
    install();
    const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "workers-cli-")));
    try {
      const herdr = writeFakeHerdr(sandbox);
      const cli = resolve(import.meta.dir, "../src/cli.ts");
      const stateDir = join(sandbox, "state");
      mkdirSync(stateDir);
      const env = { ...process.env, HERDR_ENV: "1", HERDR_BIN_PATH: herdr.bin, HERDR_JEV_SOURCE_PANE_ID: "caller-1", HERDR_JEV_STATE_DIR: stateDir,
        HERDR_JEV_TEST_GUARD: "1", HOME: sandbox, TYPESAFE_API_KEY: "", HERDR_JEV_READY_TIMEOUT_MS: "3000", HERDR_JEV_CROSS_HARNESS: "disabled",
        HERDR_JEV_CONFIG_DIR: join(sandbox, "config") };
      const spawned = spawnSync(process.execPath, [cli, "subagent", PROMPT, "--target", "claude", "--model", "sonnet-5", "--cwd", repo, "--role", "researcher", "--effort", "high"],
        { encoding: "utf8", env, cwd: repo, timeout: 60_000 });
      expect(spawned.status).toBe(0);
      const summary = JSON.parse(spawned.stdout.trim().split("\n").filter((line) => line.startsWith("{")).at(-1)!);
      expect(summary.runId).toMatch(RUN_ID);
      expect(summary.paneId).toBe("pane-42");

      const creates = harness!.callsFor("external-run").filter((argv) => argv[2] === "worker-create");
      expect(creates).toHaveLength(1);
      const request = JSON.parse(creates[0]![creates[0]!.indexOf("--request-json") + 1]!);
      expect(request).toMatchObject({ client: "claude", model: "sonnet-5", role: "researcher", cwd: repo, pane: "pane-42", branch: "main", objectiveDigest: digest(PROMPT) });
      expect(request.handle).toBe(summary.agentName);
      expect(harness!.rawLog()).not.toContain("PRIVATE-OBJECTIVE-TEXT");
      expect(readFileSync(join(harness!.dir, "state.json"), "utf8")).not.toContain("PRIVATE-OBJECTIVE-TEXT");
      const grid = JSON.parse(readFileSync(join(stateDir, "grid", "caller-1.json"), "utf8"));
      expect(grid.workers[0]).toMatchObject({ paneId: "pane-42", runId: summary.runId, cwd: repo });
      const startArgs = readFileSync(herdr.log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((argv: string[]) => argv[1] === "start")!;
      expect(startArgs.slice(startArgs.indexOf("--") + 1)).toEqual(["--model", "claude-sonnet-5-5", "--effort", "high", "--dangerously-skip-permissions"]);

      const listed = spawnSync(process.execPath, [cli, "runs", "list", "--json"], { encoding: "utf8", env, cwd: repo, timeout: 60_000 });
      expect(listed.status).toBe(0);
      expect(JSON.parse(listed.stdout).map((entry: any) => [entry.id, entry.kind])).toEqual([[summary.runId, "worker"]]);
      const text = spawnSync(process.execPath, [cli, "runs", "list"], { encoding: "utf8", env, cwd: repo, timeout: 60_000 });
      expect(text.stdout).toContain(`${summary.runId}  worker  researcher:working`);

      const closed = spawnSync(process.execPath, [cli, "workers", "close", "--all-idle", "--yes"], { encoding: "utf8", env, cwd: repo, timeout: 60_000 });
      expect(closed.status).toBe(0);
      expect(closed.stdout).toContain(`run ${summary.runId} settled`);
      const settle = harness!.callsFor("external-run").find((argv) => argv[2] === "worker-settle")!;
      expect(JSON.parse(settle[settle.indexOf("--request-json") + 1]!)).toEqual({ id: summary.runId, state: "closed", head: git(repo, "rev-parse", "HEAD") });
      expect(existsSync(join(stateDir, "grid", "caller-1.json"))).toBe(false);
    } finally { rmSync(sandbox, { recursive: true, force: true }); }
  });

  it("still launches the worker when the harness does not know worker runs", () => {
    install("legacy");
    const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "workers-cli-")));
    try {
      const herdr = writeFakeHerdr(sandbox);
      const stateDir = join(sandbox, "state");
      mkdirSync(stateDir);
      const env = { ...process.env, HERDR_ENV: "1", HERDR_BIN_PATH: herdr.bin, HERDR_JEV_SOURCE_PANE_ID: "caller-1", HERDR_JEV_STATE_DIR: stateDir,
        HERDR_JEV_TEST_GUARD: "1", HOME: sandbox, TYPESAFE_API_KEY: "", HERDR_JEV_READY_TIMEOUT_MS: "3000", HERDR_JEV_CROSS_HARNESS: "disabled",
        HERDR_JEV_CONFIG_DIR: join(sandbox, "config") };
      const spawned = spawnSync(process.execPath, [resolve(import.meta.dir, "../src/cli.ts"), "subagent", PROMPT, "--target", "claude", "--model", "sonnet-5", "--cwd", repo],
        { encoding: "utf8", env, cwd: repo, timeout: 60_000 });
      expect(spawned.status).toBe(0);
      const summary = JSON.parse(spawned.stdout.trim().split("\n").filter((line) => line.startsWith("{")).at(-1)!);
      expect(summary.ok).toBe(true);
      expect("runId" in summary).toBe(false);
      const grid = JSON.parse(readFileSync(join(stateDir, "grid", "caller-1.json"), "utf8"));
      expect(grid.workers[0].runId).toBeUndefined();
    } finally { rmSync(sandbox, { recursive: true, force: true }); }
  });
});
