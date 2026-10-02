import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildAgentsView } from "../src/herdr/agents.js";
import { isTestSafeBinary } from "../src/herdr/client.js";
import { gridStatePath, readGridWorkerRecords, readGridWorkers, writeGridWorkers } from "../src/herdr/launcher.js";
import { createFakeHarness, type FakeHarness } from "./fake-harness.js";
import { assertNoRealHomeStateLeaks, createTempHome, createTestStateDir } from "./helpers.js";

const cli = resolve(import.meta.dir, "../src/cli.ts");
const noGit = async () => ({ ok: false, stdout: "", stderr: "" });

let testEnv: { stateDir: string; cleanup: () => void };
let sandbox: string;

beforeEach(() => {
  testEnv = createTestStateDir();
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "review3-launch-")));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
  testEnv.cleanup();
  assertNoRealHomeStateLeaks();
});

function paneListFake(dir: string, panes: string[]): string {
  const bin = join(dir, "herdr");
  writeFileSync(bin, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "pane" && args[1] === "list") console.log(JSON.stringify({ result: { panes: ${JSON.stringify(panes.map((id) => ({ pane_id: id })))} } }));
else console.log("{}");
process.exit(0);
`, { mode: 0o755 });
  chmodSync(bin, 0o755);
  return bin;
}

describe("dead-worker pruning on the all-callers path", () => {
  const caller = "wE5:pF";

  it("uses the caller pane id stored in the grid file, not the sanitized file name", async () => {
    writeGridWorkers(caller, [{ paneId: "wE5:pG" }, { paneId: "wE5:pDead" }]);
    expect(gridStatePath(caller)).toContain("wE5_pF.json");
    const client = { listPanes: async () => ({ ok: true, code: 0, stderr: "", stdout: JSON.stringify({ result: { panes: [{ pane_id: caller }, { pane_id: "wE5:pG" }] } }) }) };
    const previous = process.env.HERDR_PANE_ID;
    delete process.env.HERDR_PANE_ID;
    try {
      const groups = await buildAgentsView(undefined, { client: client as any, overviewData: [], runs: [], git: noGit });
      expect(groups.flatMap((group) => group.rows.map((row) => row.paneId))).toEqual(["wE5:pG"]);
      expect(groups[0]!.rows[0]!.callerPaneId).toBe(caller);
    } finally {
      if (previous !== undefined) process.env.HERDR_PANE_ID = previous;
    }
    expect(readGridWorkers(caller)).toEqual(["wE5:pG"]);
  });

  it("does not prune when the stored caller pane is itself gone", async () => {
    writeGridWorkers(caller, [{ paneId: "wE5:pG" }]);
    const client = { listPanes: async () => ({ ok: true, code: 0, stderr: "", stdout: JSON.stringify({ result: { panes: [{ pane_id: "wX:pY" }] } }) }) };
    const previous = process.env.HERDR_PANE_ID;
    delete process.env.HERDR_PANE_ID;
    try {
      await buildAgentsView(undefined, { client: client as any, overviewData: [], runs: [], git: noGit });
    } finally {
      if (previous !== undefined) process.env.HERDR_PANE_ID = previous;
    }
    expect(readGridWorkers(caller)).toEqual(["wE5:pG"]);
  });

  it("agents --all --json prunes the dead worker of a real-looking caller id", () => {
    writeGridWorkers(caller, [{ paneId: "wE5:pG" }, { paneId: "wE5:pDead" }]);
    const bin = paneListFake(sandbox, [caller, "wE5:pG"]);
    const env = { ...process.env, HOME: createTempHome(), HERDR_ENV: "1", HERDR_BIN_PATH: bin, HERDR_PANE_ID: "", TYPESAFE_API_KEY: "" };
    const run = spawnSync(process.execPath, [cli, "agents", "--all", "--json"], { encoding: "utf8", env, cwd: sandbox, timeout: 60_000 });
    expect([run.status, run.stderr]).toEqual([0, ""]);
    const rows = JSON.parse(run.stdout).flatMap((group: any) => group.rows.map((row: any) => row.paneId));
    expect(rows).toEqual(["wE5:pG"]);
    expect(readGridWorkerRecords(caller).map((record) => record.paneId)).toEqual(["wE5:pG"]);
  });
});

describe("agents view harness run lookup", () => {
  let harness: FakeHarness | undefined;

  afterEach(() => {
    harness?.restore();
    harness = undefined;
  });

  const worker = () => writeGridWorkers("caller-1", [{ paneId: "pane-1", runId: "11111111-1111-4111-8111-111111111111", cwd: sandbox }]);
  const view = (extra: Record<string, unknown> = {}) =>
    buildAgentsView("caller-1", { workers: readGridWorkerRecords("caller-1"), overviewData: [], runs: [], git: noGit, ...extra });

  it("treats an injected null harness result as no runs without calling the real harness", async () => {
    harness = createFakeHarness("contract");
    worker();
    const groups = await view({ harnessRuns: null });
    expect(groups[0]!.rows[0]!.runState).toBeUndefined();
    expect(harness.callsFor("external-run")).toEqual([]);
  });

  it("reads the runs from the harness when none are injected, without blocking the event loop", async () => {
    harness = createFakeHarness("contract");
    worker();
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    try {
      await view();
    } finally {
      clearInterval(timer);
    }
    expect(harness.callsFor("external-run").length).toBe(1);
    expect(ticks).toBeGreaterThan(0);
  });

  it("degrades to no run state when the harness is unavailable", async () => {
    harness = createFakeHarness("unknown");
    worker();
    const groups = await view();
    expect(groups[0]!.rows[0]!.paneId).toBe("pane-1");
    expect(groups[0]!.rows[0]!.runState).toBeUndefined();
  });
});

describe("the test guard binary check", () => {
  it("rejects a bare binary name even when a file of that name sits in the cwd", () => {
    const previous = process.cwd();
    writeFileSync(join(sandbox, "herdr"), "#!/bin/sh\n", { mode: 0o755 });
    mkdirSync(join(sandbox, "bin"), { recursive: true });
    process.chdir(sandbox);
    try {
      expect(isTestSafeBinary("herdr")).toBe(false);
      expect(isTestSafeBinary(join(sandbox, "herdr"))).toBe(true);
    } finally {
      process.chdir(previous);
    }
  });
});
