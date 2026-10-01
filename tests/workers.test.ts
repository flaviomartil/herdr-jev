import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  filterWorkerClosePlan,
  listAllGridWorkers,
  pruneGridWorkers,
  readGridWorkers,
  writeGridWorkers,
  executeWorkerClose,
  type TrackedWorkerRecord,
} from "../src/herdr/launcher.js";
import type { HerdrClient } from "../src/herdr/client.js";
import { createTestStateDir, assertNoRealHomeStateLeaks } from "./helpers.js";

let testEnv: { stateDir: string; cleanup: () => void };

beforeEach(() => {
  testEnv = createTestStateDir();
});

afterEach(() => {
  testEnv?.cleanup();
  assertNoRealHomeStateLeaks();
});

test("filterWorkerClosePlan targets only tracked idle or done workers", () => {
  const tracked: TrackedWorkerRecord[] = [
    { callerPaneId: "caller-1", workerPaneId: "worker-idle" },
    { callerPaneId: "caller-1", workerPaneId: "worker-done" },
    { callerPaneId: "caller-1", workerPaneId: "worker-working" },
    { callerPaneId: "caller-2", workerPaneId: "worker-blocked" },
    { callerPaneId: "caller-2", workerPaneId: "worker-2-idle" },
  ];

  const statuses: Record<string, string> = {
    "worker-idle": "idle",
    "worker-done": "done",
    "worker-working": "working",
    "worker-blocked": "blocked",
    "worker-2-idle": "idle",
    "caller-1": "idle",
    "untracked-pane": "idle",
  };

  const allIdlePlan = filterWorkerClosePlan(tracked, statuses, { allIdle: true });
  expect(allIdlePlan).toEqual([
    { callerPaneId: "caller-1", paneId: "worker-idle", status: "idle" },
    { callerPaneId: "caller-1", paneId: "worker-done", status: "done" },
    { callerPaneId: "caller-2", paneId: "worker-2-idle", status: "idle" },
  ]);

  const specificIdle = filterWorkerClosePlan(tracked, statuses, { pane: "worker-idle" });
  expect(specificIdle).toEqual([
    { callerPaneId: "caller-1", paneId: "worker-idle", status: "idle" },
  ]);

  const specificDone = filterWorkerClosePlan(tracked, statuses, { pane: "worker-done" });
  expect(specificDone).toEqual([
    { callerPaneId: "caller-1", paneId: "worker-done", status: "done" },
  ]);

  const specificWorking = filterWorkerClosePlan(tracked, statuses, { pane: "worker-working" });
  expect(specificWorking).toEqual([]);

  const specificBlocked = filterWorkerClosePlan(tracked, statuses, { pane: "worker-blocked" });
  expect(specificBlocked).toEqual([]);

  const callerPlan = filterWorkerClosePlan(tracked, statuses, { pane: "caller-1" });
  expect(callerPlan).toEqual([]);

  const untrackedPlan = filterWorkerClosePlan(tracked, statuses, { pane: "untracked-pane" });
  expect(untrackedPlan).toEqual([]);

  const emptyPlan = filterWorkerClosePlan(tracked, statuses, {});
  expect(emptyPlan).toEqual([]);
});

test("grid worker state tracking, listing, and pruning", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-jev-grid-"));
  try {
    writeGridWorkers("caller-a", ["worker-1", "worker-2"], root);
    writeGridWorkers("caller-b", ["worker-3"], root);

    expect(readGridWorkers("caller-a", root)).toEqual(["worker-1", "worker-2"]);
    expect(readGridWorkers("caller-b", root)).toEqual(["worker-3"]);

    const all = listAllGridWorkers(root);
    expect(all).toEqual([
      { callerPaneId: "caller-a", workerPaneId: "worker-1" },
      { callerPaneId: "caller-a", workerPaneId: "worker-2" },
      { callerPaneId: "caller-b", workerPaneId: "worker-3" },
    ]);

    pruneGridWorkers(["worker-1"], root);
    expect(readGridWorkers("caller-a", root)).toEqual(["worker-2"]);

    const closedPanes: string[] = [];
    const fakeClient = {
      closePane: async (paneId: string) => {
        closedPanes.push(paneId);
        return { ok: true, code: 0, stdout: "", stderr: "" };
      },
    } as unknown as HerdrClient;

    await executeWorkerClose(
      fakeClient,
      [
        { callerPaneId: "caller-a", paneId: "worker-2", status: "idle" },
        { callerPaneId: "caller-b", paneId: "worker-3", status: "done" },
      ],
      root,
    );

    expect(closedPanes).toEqual(["worker-2", "worker-3"]);
    expect(readGridWorkers("caller-a", root)).toEqual([]);
    expect(readGridWorkers("caller-b", root)).toEqual([]);
    expect(listAllGridWorkers(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
