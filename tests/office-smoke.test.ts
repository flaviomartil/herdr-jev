import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";

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
  expect(result.stdout).toContain("3 sub ");
  expect(result.stdout).toContain("2 sub ");
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

test("F-01: demo compose never spawns child process", async () => {
  const officeScript = resolve(import.meta.dir, "../herdr-plugin/office/office.mjs");
  const marker = resolve(import.meta.dir, `../.test-demo-marker-${Date.now()}.tmp`);
  const mockBin = resolve(import.meta.dir, `../.test-mock-bin-${Date.now()}.mjs`);
  try { unlinkSync(marker); } catch {}
  writeFileSync(mockBin, `#!/usr/bin/env node\nimport fs from "fs";\nfs.writeFileSync("${marker}", "SPAWNED");\nprocess.exit(0);\n`);
  chmodSync(mockBin, 0o755);

  const proc = spawn("node", [officeScript, "--demo"], {
    env: { ...process.env, HERDR_JEV_BIN: mockBin, COLUMNS: "120", LINES: "40" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let output = "";
  proc.stdout?.on("data", (d) => { output += d.toString("utf8"); });

  await new Promise((r) => setTimeout(r, 200));
  proc.stdin?.write("s");
  await new Promise((r) => setTimeout(r, 200));
  proc.stdin?.write("reply in demo mode\r");
  await new Promise((r) => setTimeout(r, 200));
  proc.stdin?.write("q");
  await new Promise((r) => setTimeout(r, 200));
  proc.kill("SIGTERM");

  try { unlinkSync(mockBin); } catch {}
  const markerCreated = existsSync(marker);
  try { unlinkSync(marker); } catch {}

  expect(markerCreated).toBe(false);
  expect(output).toContain("demo mode: would send");
});

test("F-03: argv contains '--' before the prompt for subagent and peer-message", () => {
  const officeContent = readFileSync(resolve(import.meta.dir, "../herdr-plugin/office/office.mjs"), "utf8");
  expect(officeContent).toContain("args.push('--', text)");
  expect(officeContent).toContain("['peer-message', '--', handle, text]");

  const peerProgram = new Command();
  let receivedAgent = "";
  let receivedText = "";
  peerProgram.command("peer-message [agent] [text]").action((agent: string, text: string) => {
    receivedAgent = agent;
    receivedText = text;
  });
  peerProgram.parse(["node", "cli", "peer-message", "--", "worker-1", "--fix-issue"]);
  expect(receivedAgent).toBe("worker-1");
  expect(receivedText).toBe("--fix-issue");

  const subProgram = new Command();
  let receivedPrompt = "";
  subProgram.command("subagent <prompt>").option("-r, --role <role>").action((prompt: string) => {
    receivedPrompt = prompt;
  });
  subProgram.parse(["node", "cli", "subagent", "--role", "implementer", "--", "--fix-issue"]);
  expect(receivedPrompt).toBe("--fix-issue");
});

test("F-04: parseQuotaPercent rejects '7d 14h' and parses valid percent strings", async () => {
  const { parseQuotaPercent } = await import("../herdr-plugin/office/src/render.mjs");
  expect(parseQuotaPercent("7d 14h")).toBeNull();
  expect(parseQuotaPercent("50%")).toBe(50);
  expect(parseQuotaPercent("0%")).toBe(0);
  expect(parseQuotaPercent("100%")).toBe(100);
  expect(parseQuotaPercent("75")).toBe(75);
  expect(parseQuotaPercent("150")).toBeNull();
  expect(parseQuotaPercent("150%")).toBeNull();
  expect(parseQuotaPercent("-5%")).toBeNull();
  expect(parseQuotaPercent(null)).toBeNull();
  expect(parseQuotaPercent(undefined)).toBeNull();
  expect(parseQuotaPercent(80)).toBe(80);
});

test("F-08: stalled child in pollJevOverview is killed by timeout and jevPolling is reset", () => {
  const officeScript = resolve(import.meta.dir, "../herdr-plugin/office/office.mjs");
  const mockScript = resolve(import.meta.dir, `../.test-stalled-${Date.now()}.mjs`);
  const killLog = resolve(import.meta.dir, `../.test-kill-log-${Date.now()}.tmp`);

  writeFileSync(
    mockScript,
    `#!/usr/bin/env node\nimport fs from "fs";\nconst killLog = process.env.KILL_LOG;\nfs.writeFileSync(killLog, "STARTED\\n");\nprocess.on("SIGTERM", () => {\n  fs.writeFileSync(killLog, "KILLED\\n");\n  process.exit(0);\n});\nsetInterval(() => {}, 1000);\n`,
  );
  chmodSync(mockScript, 0o755);

  const res = spawnSync("node", [officeScript], {
    env: {
      ...process.env,
      HERDR_OFFICE_TEST_POLL: "1",
      HERDR_JEV_TIMEOUT_MS: "300",
      HERDR_JEV_BIN: mockScript,
      KILL_LOG: killLog,
    },
    encoding: "utf8",
  });

  expect(res.status).toBe(0);
  expect(res.stdout).toContain('"polled":true');
  const logged = readFileSync(killLog, "utf8").trim();
  expect(logged).toBe("KILLED");

  try { unlinkSync(mockScript); } catch {}
  try { unlinkSync(killLog); } catch {}
});

test("narrow-width shows hint and wide does not", () => {
  const officeScript = resolve(import.meta.dir, "../herdr-plugin/office/office.mjs");
  const narrow = spawnSync("node", [officeScript, "--once", "--demo"], {
    encoding: "utf8",
    env: { ...process.env, COLUMNS: "66", LINES: "24" },
  });
  expect(narrow.status).toBe(0);
  expect(narrow.stdout).toContain("widen the pane or press z");

  const wide = spawnSync("node", [officeScript, "--once", "--demo"], {
    encoding: "utf8",
    env: { ...process.env, COLUMNS: "136", LINES: "52" },
  });
  expect(wide.status).toBe(0);
  expect(wide.stdout).not.toContain("widen the pane or press z");
});

test("workspace scope fallback when tab has fewer than 2 primary agents", () => {
  const officeScript = resolve(import.meta.dir, "../herdr-plugin/office/office.mjs");
  const single = spawnSync("node", [officeScript, "--once", "--demo"], {
    encoding: "utf8",
    env: {
      ...process.env,
      COLUMNS: "136",
      LINES: "52",
      HERDR_TAB_ID: "w2:t4",
      HERDR_WORKSPACE_ID: "",
      HERDR_PANE_ID: "",
      HERDR_PLUGIN_CONTEXT_JSON: "",
      HERDR_JEV_SOURCE_PANE_ID: "",
    },
  });
  expect(single.status).toBe(0);
  expect(single.stdout).toContain(" workspace ");

  const multi = spawnSync("node", [officeScript, "--once", "--demo"], {
    encoding: "utf8",
    env: {
      ...process.env,
      COLUMNS: "136",
      LINES: "52",
      HERDR_TAB_ID: "w1:t1",
      HERDR_WORKSPACE_ID: "",
      HERDR_PANE_ID: "",
      HERDR_PLUGIN_CONTEXT_JSON: "",
      HERDR_JEV_SOURCE_PANE_ID: "",
    },
  });
  expect(multi.status).toBe(0);
  expect(multi.stdout).toContain(" tab ");
});

test("model trimming removes leading zero-width spaces and whitespace in roster", async () => {
  const { cleanModel, Roster } = await import("../herdr-plugin/office/src/roster.mjs");
  expect(cleanModel("  \u200Bgpt-6.1-sol")).toBe("gpt-6.1-sol");
  expect(cleanModel("\u200B\uFEFF  claude-3-7-sonnet  ")).toBe("claude-3-7-sonnet");
  expect(cleanModel("   ")).toBeNull();

  const roster = new Roster();
  roster.setHead("p1", { used: 42, model: "  \u200Bgpt-6.1-sol" });
  expect(roster.head("p1")?.model).toBe("gpt-6.1-sol");
});

test("no sparkle on initial roster at launch", () => {
  const officeScript = resolve(import.meta.dir, "../herdr-plugin/office/office.mjs");
  const result = spawnSync("node", [officeScript, "--once", "--demo"], {
    encoding: "utf8",
    env: {
      ...process.env,
      COLUMNS: "136",
      LINES: "52",
      HERDR_TAB_ID: "",
      HERDR_WORKSPACE_ID: "",
      HERDR_PANE_ID: "",
    },
  });
  expect(result.status).toBe(0);
  expect(result.stdout).not.toMatch(/[✦✧]/);
});


test("width guarantee holds at 100, 120, and 140 columns with panel open", () => {
  const officeScript = resolve(import.meta.dir, "../herdr-plugin/office/office.mjs");
  for (const cols of ["100", "120", "140"]) {
    const result = spawnSync("node", [officeScript, "--once", "--demo", "--panel", "w1:p1"], {
      encoding: "utf8",
      env: {
        ...process.env,
        COLUMNS: cols,
        LINES: "45",
      },
    });
    expect(result.status).toBe(0);
    const lines = result.stdout.split("\n").filter(line => line.length > 0);
    for (const line of lines) {
      const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
      // Some lines might just be empty strings at the end, but valid terminal lines are exactly 'cols' wide
      // Wait, let's measure with spread to handle surrogate pairs correctly, but string.length is fine for most boxes.
      // JS string length might differ if there are wide chars, but the grid guarantees ascii + single-width box chars.
      // So Array.from(stripped).length is safe.
      const len = Array.from(stripped).length;
      if (len !== 0) {
         expect(len).toBe(parseInt(cols, 10));
      }
    }
  }
});
