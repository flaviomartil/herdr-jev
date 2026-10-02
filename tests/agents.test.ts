import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  buildAgentsView,
  formatAgentsTable,
  type GitRunner,
  type AgentRow,
} from "../src/herdr/agents.js";
import {
  readGridWorkers,
  readGridWorkerRecords,
  writeGridWorkers,
  updateGridWorkers,
  gridStatePath,
  type GridWorkerRecord,
} from "../src/herdr/launcher.js";
import { createTestStateDir, assertNoRealHomeStateLeaks } from "./helpers.js";

let testEnv: { stateDir: string; cleanup: () => void };

beforeEach(() => {
  testEnv = createTestStateDir();
});

afterEach(() => {
  testEnv?.cleanup();
  assertNoRealHomeStateLeaks();
});

test("buildAgentsView groups agents by git toplevel basename", async () => {
  const workers: GridWorkerRecord[] = [
    {
      paneId: "pane-1",
      handle: "jev-impl-1",
      cwd: "/repos/proj-alpha/wt1",
      branch: "feat/alpha",
      forkSha: "sha-alpha-1",
    },
    {
      paneId: "pane-2",
      handle: "jev-impl-2",
      cwd: "/repos/proj-beta/wt2",
      branch: "feat/beta",
      forkSha: "sha-beta-1",
    },
    {
      paneId: "pane-3",
      handle: "jev-impl-3",
      cwd: "/repos/proj-alpha/wt3",
      branch: "feat/alpha-2",
      forkSha: "sha-alpha-2",
    },
  ];

  const fakeGit: GitRunner = async (args, cwd) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      if (cwd?.includes("proj-alpha")) {
        return { ok: true, stdout: "/repos/proj-alpha\n", stderr: "" };
      }
      if (cwd?.includes("proj-beta")) {
        return { ok: true, stdout: "/repos/proj-beta\n", stderr: "" };
      }
    }
    if (args[0] === "rev-list" && args[1] === "--count") {
      return { ok: true, stdout: "3\n", stderr: "" };
    }
    if (args[0] === "status" && args[1] === "--porcelain") {
      return { ok: true, stdout: " M file.ts\n", stderr: "" };
    }
    return { ok: true, stdout: "", stderr: "" };
  };

  const overviewData = [
    { pane: "pane-1", state: "working", agent: "codex", model: "gpt-6.1-sol" },
    { pane: "pane-2", state: "blocked", agent: "claude", model: "claude-sonnet-5" },
    { pane: "pane-3", state: "done", agent: "codex", model: "gpt-6.1-sol" },
  ];

  const groups = await buildAgentsView(undefined, {
    workers,
    git: fakeGit,
    overviewData,
  });

  expect(groups.length).toBe(2);
  const alphaGroup = groups.find((g) => g.project === "proj-alpha");
  const betaGroup = groups.find((g) => g.project === "proj-beta");

  expect(alphaGroup).toBeDefined();
  expect(betaGroup).toBeDefined();
  expect(alphaGroup?.rows.length).toBe(2);
  expect(betaGroup?.rows.length).toBe(1);

  expect(alphaGroup?.rows[0].paneId).toBe("pane-1");
  expect(alphaGroup?.rows[1].paneId).toBe("pane-3");
  expect(betaGroup?.rows[0].paneId).toBe("pane-2");
});

test("buildAgentsView sorts rows within groups by slot 1-9 in insertion order", async () => {
  const workers: GridWorkerRecord[] = [
    { paneId: "w1", handle: "agent-1", cwd: "/repos/my-repo" },
    { paneId: "w2", handle: "agent-2", cwd: "/repos/my-repo" },
    { paneId: "w3", handle: "agent-3", cwd: "/repos/my-repo" },
  ];

  const fakeGit: GitRunner = async (args) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return { ok: true, stdout: "/repos/my-repo\n", stderr: "" };
    }
    return { ok: true, stdout: "", stderr: "" };
  };

  const groups = await buildAgentsView(undefined, {
    workers,
    git: fakeGit,
    overviewData: [],
  });

  expect(groups.length).toBe(1);
  const rows = groups[0].rows;
  expect(rows.length).toBe(3);
  expect(rows[0].slot).toBe(1);
  expect(rows[1].slot).toBe(2);
  expect(rows[2].slot).toBe(3);
});

test("buildAgentsView measures change counts against recorded fork SHA, not moving base", async () => {
  const revListCalls: string[] = [];
  const statusCalls: string[] = [];

  const recordedFork = "a1b2c3d4e5f67890";
  const movingBase = "9988776655443322";

  const workers: GridWorkerRecord[] = [
    {
      paneId: "worker-fork-test",
      handle: "agent-fork",
      cwd: "/repo/worktree-1",
      branch: "feat/fork-check",
      forkSha: recordedFork,
    },
  ];

  const fakeGit: GitRunner = async (args) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return { ok: true, stdout: "/repo/worktree-1\n", stderr: "" };
    }
    if (args[0] === "rev-list" && args[1] === "--count") {
      revListCalls.push(args[2]);
      return { ok: true, stdout: "5\n", stderr: "" };
    }
    if (args[0] === "status" && args[1] === "--porcelain") {
      statusCalls.push(args.join(" "));
      return { ok: true, stdout: " M src/index.ts\n?? tests/new.ts\n", stderr: "" };
    }
    return { ok: true, stdout: "", stderr: "" };
  };

  const groups = await buildAgentsView(undefined, {
    workers,
    git: fakeGit,
    overviewData: [{ pane: "worker-fork-test", state: "working" }],
  });

  expect(groups.length).toBe(1);
  const row = groups[0].rows[0];
  expect(row.commitsAhead).toBe(5);
  expect(row.uncommitted).toBe(2);

  expect(revListCalls).toEqual([`${recordedFork}..HEAD`]);
  expect(revListCalls.some((c) => c.includes(movingBase))).toBe(false);
  expect(statusCalls).toEqual(["status --porcelain"]);
});

test("legacy tracking format is read without rewriting and migrated by the next write, preserving pane ids", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-jev-legacy-"));
  try {
    const callerId = "legacy-caller";
    const legacyPath = gridStatePath(callerId, root);
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, JSON.stringify(["worker-leg-1", "worker-leg-2"]));

    const paneIds = readGridWorkers(callerId, root);
    expect(paneIds).toEqual(["worker-leg-1", "worker-leg-2"]);

    expect(JSON.parse(readFileSync(legacyPath, "utf8"))).toEqual(["worker-leg-1", "worker-leg-2"]);
    updateGridWorkers(callerId, (current) => current, root);
    const migratedJson = JSON.parse(readFileSync(legacyPath, "utf8"));
    expect(Array.isArray(migratedJson)).toBe(false);
    expect(migratedJson.callerPaneId).toBe(callerId);
    expect(migratedJson.workerPaneIds).toEqual(["worker-leg-1", "worker-leg-2"]);
    expect(migratedJson.workers).toEqual([
      { paneId: "worker-leg-1", handle: null, cwd: null, branch: null, forkSha: null },
      { paneId: "worker-leg-2", handle: null, cwd: null, branch: null, forkSha: null },
    ]);

    const records = readGridWorkerRecords(callerId, root);
    expect(records).toEqual([
      { paneId: "worker-leg-1", handle: null, cwd: null, branch: null, forkSha: null },
      { paneId: "worker-leg-2", handle: null, cwd: null, branch: null, forkSha: null },
    ]);

    const fakeGit: GitRunner = async (args) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return { ok: true, stdout: "/repos/migrated-proj\n", stderr: "" };
      }
      return { ok: true, stdout: "", stderr: "" };
    };

    const groups = await buildAgentsView(callerId, {
      stateDir: root,
      git: fakeGit,
      overviewData: [
        { pane: "worker-leg-1", state: "blocked", agent: "codex" },
        { pane: "worker-leg-2", state: "idle", agent: "claude" },
      ],
    });

    expect(groups.length).toBe(1);
    expect(groups[0].project).toBe("migrated-proj");
    expect(groups[0].rows.length).toBe(2);
    expect(groups[0].rows[0].slot).toBe(1);
    expect(groups[0].rows[0].state).toBe("blocked");
    expect(groups[0].rows[0].loud).toBe(true);
    expect(groups[0].rows[1].slot).toBe(2);
    expect(groups[0].rows[1].state).toBe("idle");
    expect(groups[0].rows[1].loud).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy tracking object with workerPaneIds only is read as is and gains workers on the next write", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-jev-legacy-obj-"));
  try {
    const callerId = "caller-obj-leg";
    const legacyPath = gridStatePath(callerId, root);
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, JSON.stringify({ callerPaneId: callerId, workerPaneIds: ["w-1", "w-2"] }));

    const records = readGridWorkerRecords(callerId, root);
    expect(records.map((r) => r.paneId)).toEqual(["w-1", "w-2"]);

    expect(JSON.parse(readFileSync(legacyPath, "utf8")).workers).toBeUndefined();
    updateGridWorkers(callerId, (current) => current, root);
    const migratedJson = JSON.parse(readFileSync(legacyPath, "utf8"));
    expect(Array.isArray(migratedJson.workers)).toBe(true);
    expect(migratedJson.workers.length).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildAgentsView sets loud boolean true only for blocked state and binds run summary", async () => {
  const workers: GridWorkerRecord[] = [
    { paneId: "w-blocked", handle: "h-blocked", cwd: "/repo/p1" },
    { paneId: "w-working", handle: "h-working", cwd: "/repo/p1" },
  ];

  const fakeGit: GitRunner = async (args) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return { ok: true, stdout: "/repo/p1\n", stderr: "" };
    }
    return { ok: true, stdout: "", stderr: "" };
  };

  const runs = [
    {
      id: "run-blocked",
      timestampMs: 1000,
      mtimeMs: 1000,
      projection: {
        agent: "h-blocked",
        tasks: [{ id: "t1", state: "failed" }],
      },
    },
  ];

  const groups = await buildAgentsView(undefined, {
    workers,
    git: fakeGit,
    overviewData: [
      { pane: "w-blocked", handle: "h-blocked", state: "blocked", agent: "codex", model: "m1" },
      { pane: "w-working", handle: "h-working", state: "working", agent: "claude", model: "m2" },
    ],
    runs,
    now: 1000,
  });

  const rows = groups[0].rows;
  expect(rows[0].loud).toBe(true);
  expect(rows[0].state).toBe("blocked");
  expect(rows[0].run).toBe("t1:failed 0s ago");
  expect(rows[1].loud).toBe(false);
  expect(rows[1].state).toBe("working");
  expect(rows[1].run).toBeNull();
});

test("formatAgentsTable produces compact formatted text table", () => {
  const groups = [
    {
      project: "my-project",
      rows: [
        {
          slot: 1,
          state: "working" as const,
          loud: false,
          handle: "jev-impl-1",
          client: "codex",
          model: "gpt-6.1-sol",
          branch: "feat/agents",
          commitsAhead: 3,
          uncommitted: 0,
          run: "t1:done 1m ago",
        },
        {
          slot: 2,
          state: "blocked" as const,
          loud: true,
          handle: "jev-rev-1",
          client: "claude",
          model: "opus-5",
          branch: "feat/agents",
          commitsAhead: 0,
          uncommitted: 2,
          run: null,
        },
      ],
    },
  ];

  const table = formatAgentsTable(groups);
  expect(table).toContain("my-project");
  expect(table).toContain("1  working");
  expect(table).toContain("3/0");
  expect(table).toContain("jev-impl-1");
  expect(table).toContain("0/2");
  expect(table).toContain("t1:done 1m ago");

  expect(formatAgentsTable([])).toBe("No tracked grid agents.");
});

test("buildAgentsView drops dead worker panes not in client and persists pruned tracking file", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-jev-prune-"));
  try {
    const callerId = "caller-prune";
    writeGridWorkers(callerId, ["worker-live", "worker-dead"], root);
    expect(readGridWorkers(callerId, root)).toEqual(["worker-live", "worker-dead"]);

    const fakeGit: GitRunner = async (args) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return { ok: true, stdout: "/repos/proj-prune\n", stderr: "" };
      }
      return { ok: true, stdout: "", stderr: "" };
    };

    const fakeClient = {
      listPanes: async () => ({
        ok: true,
        code: 0,
        stderr: "",
        stdout: JSON.stringify({ panes: [{ id: callerId }, { id: "worker-live" }] }),
      }),
    };

    const groups = await buildAgentsView(callerId, {
      stateDir: root,
      git: fakeGit,
      client: fakeClient as any,
      overviewData: [
        { pane: "worker-live", state: "working", agent: "codex" },
      ],
    });

    expect(groups.length).toBe(1);
    expect(groups[0].rows.length).toBe(1);
    expect(groups[0].rows[0].paneId).toBe("worker-live");

    const remainingTracked = readGridWorkers(callerId, root);
    expect(remainingTracked).toEqual(["worker-live"]);
    expect(remainingTracked).not.toContain("worker-dead");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
