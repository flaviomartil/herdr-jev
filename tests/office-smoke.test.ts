import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

test("office smoke runs once with demo data and exits cleanly", () => {
  const officeScript = resolve(import.meta.dir, "../herdr-plugin/office/office.mjs");
  const result = spawnSync("node", [officeScript, "--once", "--demo"], {
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  expect(result.stdout.trim().length).toBeGreaterThan(0);
  expect(result.stdout).toContain("JEV OFFICE");
});

test("three consecutive --once --demo frames at different fake clock values differ", () => {
  const officeScript = resolve(import.meta.dir, "../herdr-plugin/office/office.mjs");
  const t0 = 1700000000000;
  const frames = [0, 320, 640].map((dt) => {
    const result = spawnSync("node", [officeScript, "--once", "--demo", `--clock=${t0 + dt}`], {
      encoding: "utf8",
      env: { ...process.env, COLUMNS: "136", LINES: "52", HERDR_OFFICE_CLOCK: String(t0 + dt) },
    });
    expect(result.status).toBe(0);
    return result.stdout;
  });

  expect(frames[0]).not.toBe(frames[1]);
  expect(frames[1]).not.toBe(frames[2]);
  expect(frames[0]).not.toBe(frames[2]);
});

test("demo frame contains swarm badge for primaries with subagents", () => {
  const officeScript = resolve(import.meta.dir, "../herdr-plugin/office/office.mjs");
  const result = spawnSync("node", [officeScript, "--once", "--demo"], {
    encoding: "utf8",
    env: { ...process.env, COLUMNS: "136", LINES: "52" },
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("3 sub · 1 blocked");
  expect(result.stdout).toContain("2 sub · working");
});

test("frame with swarm panel open contains subagent rows with slot numbers", () => {
  const officeScript = resolve(import.meta.dir, "../herdr-plugin/office/office.mjs");
  const result = spawnSync("node", [officeScript, "--once", "--demo", "--panel", "w1:p1"], {
    encoding: "utf8",
    env: { ...process.env, COLUMNS: "136", LINES: "52" },
  });
  expect(result.status).toBe(0);
  const plain = result.stdout.replace(/\x1b\[[0-9;]*m/g, "");
  expect(plain).toContain("SWARM");
  expect(plain).toContain("Ada (3 subagents)");
  expect(plain).toMatch(/1\s+!\s*blocked\s+worker-1-sub1/);
  expect(plain).toMatch(/2\s+\*\s*working\s+worker-1-sub2/);
  expect(plain).toMatch(/3\s+-\s*idle\s+worker-1-sub3/);
  expect(plain).toContain("worker-1-sub1");
  expect(plain).toContain("claude/sonnet-5");
  expect(plain).toContain("1-9 focus subagent");
});

test("classification helper separates primaries and subagents", async () => {
  const { classifyPanes, aggregateSwarmBadge } = await import("../herdr-plugin/office/src/swarm.mjs");
  const panes = [
    { pane_id: "w1:p1", title: "primary 1" },
    { pane_id: "w1:p2", title: "primary 2" },
    { pane_id: "sub-1", title: "subagent 1" },
    { pane_id: "sub-2", title: "subagent 2" },
  ];
  const trackingData = [
    { callerPaneId: "w1:p1", workerPaneId: "sub-1" },
    { callerPaneId: "w1:p1", workerPaneId: "sub-2" },
  ];
  const { primaries, subagents } = classifyPanes(panes, trackingData);
  expect(primaries.map((p: any) => p.pane_id)).toEqual(["w1:p1", "w1:p2"]);
  expect(subagents.map((s: any) => s.pane_id)).toEqual(["sub-1", "sub-2"]);

  const badgeBlocked = aggregateSwarmBadge([
    { slot: 1, state: "blocked" },
    { slot: 2, state: "working" },
  ]);
  expect(badgeBlocked?.text).toBe("2 sub · 1 blocked");
  expect(badgeBlocked?.state).toBe("blocked");

  const badgeWorking = aggregateSwarmBadge([
    { slot: 1, state: "working" },
    { slot: 2, state: "working" },
  ]);
  expect(badgeWorking?.text).toBe("2 sub · working");
  expect(badgeWorking?.state).toBe("working");

  const badgeIdle = aggregateSwarmBadge([
    { slot: 1, state: "idle" },
    { slot: 2, state: "done" },
  ]);
  expect(badgeIdle?.text).toBe("2 sub · idle");

  const badgeEmpty = aggregateSwarmBadge([]);
  expect(badgeEmpty).toBeNull();
});
