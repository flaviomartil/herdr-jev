import { expect, test } from "bun:test";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import {
  parseStandupFile,
  planStandup,
  runStandup,
  executeStandupCommand,
  buildAgentMessage,
  substituteVariables,
  formatStandupDate,
  capMessageBytes,
  resolveStandupEnvironment,
} from "../src/herdr/standup.js";

test("parseStandupFile parses front matter with custom states and max", () => {
  const content = `---
states: idle, paused, done
max: 5
---
Global daily message.
## API
API daily task.`;

  const parsed = parseStandupFile(content);
  expect(parsed.options.states).toEqual(["idle", "paused", "done"]);
  expect(parsed.options.max).toBe(5);
  expect(parsed.global).toBe("Global daily message.");
  expect(parsed.sections["api"]).toBe("API daily task.");
  expect(parsed.sections["API"]).toBe("API daily task.");
});

test("parseStandupFile uses default options when front matter is omitted", () => {
  const content = `Global daily instruction without front matter.

## Frontend
Work on user interface.`;

  const parsed = parseStandupFile(content);
  expect(parsed.options.states).toEqual(["idle", "done"]);
  expect(parsed.options.max).toBe(12);
  expect(parsed.global).toBe("Global daily instruction without front matter.");
  expect(parsed.sections["frontend"]).toBe("Work on user interface.");
});

test("parseStandupFile handles blank files gracefully", () => {
  const emptyParsed = parseStandupFile("");
  expect(emptyParsed.global).toBe("");
  expect(Object.keys(emptyParsed.sections).length).toBe(0);
  expect(emptyParsed.options.states).toEqual(["idle", "done"]);
  expect(emptyParsed.options.max).toBe(12);

  const whitespaceParsed = parseStandupFile("   \n\n\t  \n");
  expect(whitespaceParsed.global).toBe("");
  expect(Object.keys(whitespaceParsed.sections).length).toBe(0);
});

test("sections match case-insensitively and join global text with a blank line", () => {
  const content = `Base task for everyone.

## CoreService
Core service work.`;

  const parsed = parseStandupFile(content);
  const targetMatch = { project: "coreservice", agent: "agent-1" };
  const message = buildAgentMessage(parsed, targetMatch);
  expect(message).toBe("Base task for everyone.\n\nCore service work.");

  const targetUpper = { project: "CORESERVICE", agent: "agent-2" };
  const messageUpper = buildAgentMessage(parsed, targetUpper);
  expect(messageUpper).toBe("Base task for everyone.\n\nCore service work.");

  const targetNoSection = { project: "Analytics", agent: "agent-3" };
  const messageGlobalOnly = buildAgentMessage(parsed, targetNoSection);
  expect(messageGlobalOnly).toBe("Base task for everyone.");

  const noGlobalContent = `## CoreService\nOnly core service.`;
  const parsedNoGlobal = parseStandupFile(noGlobalContent);
  const messageNoMatch = buildAgentMessage(parsedNoGlobal, { project: "Analytics" });
  expect(messageNoMatch).toBe("");
});

test("substituteVariables correctly replaces date, project, branch, and agent", () => {
  const template = "Standup {{date}} for {{agent}} in {{project}} on branch {{branch}}";
  const fixedDate = new Date(2026, 9, 1);
  const formatted = formatStandupDate(fixedDate);
  expect(formatted).toBe("01/10/2026");

  const result = substituteVariables(template, {
    date: formatted,
    project: "Billing",
    branch: "feat/invoicing",
    agent: "codex-1",
  });
  expect(result).toBe("Standup 01/10/2026 for codex-1 in Billing on branch feat/invoicing");

  const nullBranchResult = substituteVariables("Branch: {{branch}}", {
    branch: null,
  });
  expect(nullBranchResult).toBe("Branch: ");
});

test("capMessageBytes bounds message length at 8 KB", () => {
  const shortText = "Short text";
  expect(capMessageBytes(shortText, 8192)).toBe(shortText);

  const hugeText = "a".repeat(10000);
  const capped = capMessageBytes(hugeText, 8192);
  expect(Buffer.byteLength(capped, "utf-8")).toBe(8192);
});

test("planStandup applies all exclusion filters properly", async () => {
  const rows = [
    { pane: "%caller", agent: "caller-agent", project: "App", state: "idle" },
    { pane: "%no-agent", agent: null, project: "App", state: "idle" },
    { pane: "%empty-agent", agent: "   ", project: "App", state: "idle" },
    { pane: "%lantern", agent: "agent-1", project: "Jev Lantern", state: "idle" },
    { pane: "%office", agent: "agent-2", project: "Jev Office", state: "idle" },
    { pane: "%radar", agent: "agent-3", project: "Jev Radar", state: "idle" },
    { pane: "%radar-lower", agent: "agent-4", project: "jev radar", state: "idle" },
    { pane: "%working", agent: "agent-5", project: "App", state: "working" },
    { pane: "%blocked", agent: "agent-6", project: "App", state: "blocked" },
    { pane: "%offline", agent: "agent-7", project: "App", state: "offline" },
    { pane: "%valid-1", agent: "agent-valid-1", project: "App", state: "idle" },
    { pane: "%valid-1", agent: "agent-valid-1", project: "App", state: "idle" },
    { pane: "%valid-2", agent: "agent-valid-2", project: "App", state: "done" },
    { pane: "%valid-3", agent: "agent-valid-3", project: "App", state: "idle" },
    { pane: "%valid-4", agent: "agent-valid-4", project: "App", state: "idle" },
  ];

  const parsed = parseStandupFile(`---
max: 2
states: idle, done
---
Daily standup task.`);

  const targets = await planStandup(
    {
      overviewRows: rows,
      callerPaneId: "%caller",
    },
    parsed,
  );

  expect(targets.length).toBe(2);
  expect(targets[0].pane).toBe("%valid-1");
  expect(targets[0].agent).toBe("agent-valid-1");
  expect(targets[1].pane).toBe("%valid-2");
  expect(targets[1].agent).toBe("agent-valid-2");
  expect(targets.skipped).toEqual([
    { pane: "%caller", reason: "caller" },
    { pane: "%no-agent", reason: "no_agent" },
    { pane: "%empty-agent", reason: "no_agent" },
    { pane: "%lantern", reason: "plugin_pane" },
    { pane: "%office", reason: "plugin_pane" },
    { pane: "%radar", reason: "plugin_pane" },
    { pane: "%radar-lower", reason: "plugin_pane" },
    { pane: "%valid-3", reason: "beyond_max" },
    { pane: "%valid-4", reason: "beyond_max" },
  ]);
});

test("planStandup works without caller pane when unset", async () => {
  const rows = [
    { pane: "%p1", agent: "agent-1", project: "App", state: "idle" },
  ];

  const parsed = parseStandupFile("Daily task.");
  const targets = await planStandup(
    {
      overviewRows: rows,
    },
    parsed,
  );

  expect(targets.length).toBe(1);
  expect(targets[0].pane).toBe("%p1");
});

test("executeStandupCommand auto mode guard: missing file", async () => {
  const logs: string[] = [];
  const result = await executeStandupCommand(
    { auto: true, file: "/nonexistent/standup.md" },
    {
      fileExists: () => false,
      overviewRows: [],
      sendPeer: async () => ({ ok: true }),
      log: (msg) => logs.push(msg),
    },
  );

  expect(result).toEqual({ skipped: "no_file" });
  expect(logs).toContain(JSON.stringify({ skipped: "no_file" }));
});

test("executeStandupCommand auto mode guard: blank file", async () => {
  const logs: string[] = [];
  const result = await executeStandupCommand(
    { auto: true, file: "/tmp/blank.md" },
    {
      fileExists: () => true,
      readFile: () => "   \n\n\t  ",
      overviewRows: [],
      sendPeer: async () => ({ ok: true }),
      log: (msg) => logs.push(msg),
    },
  );

  expect(result).toEqual({ skipped: "no_file" });
  expect(logs).toContain(JSON.stringify({ skipped: "no_file" }));
});

test("executeStandupCommand auto mode guard: already ran today without force", async () => {
  const logs: string[] = [];
  const stateDir = "/tmp/test-state-dir";
  const now = new Date(2026, 9, 1);

  const result = await executeStandupCommand(
    { auto: true, file: "/tmp/standup.md" },
    {
      stateDir,
      now,
      fileExists: (p) => p.includes("2026-10-01.auto.json") || p.includes("standup.md"),
      readFile: () => "Standup message.",
      overviewRows: [],
      sendPeer: async () => ({ ok: true }),
      log: (msg) => logs.push(msg),
    },
  );

  expect(result).toEqual({ skipped: "already_ran_today" });
  expect(logs).toContain(JSON.stringify({ skipped: "already_ran_today" }));
});

test("executeStandupCommand auto mode guard: already ran today overridden by force", async () => {
  const logs: string[] = [];
  const sentCalls: any[] = [];
  const stateDir = "/tmp/test-state-dir";
  const now = new Date(2026, 9, 1);

  const result = await executeStandupCommand(
    { auto: true, force: true, file: "/tmp/standup.md" },
    {
      stateDir,
      now,
      fileExists: () => true,
      readFile: () => "Daily standup message.",
      overviewRows: [
        { pane: "%1", agent: "agent-1", project: "API", state: "idle" },
      ],
      sendPeer: async (input) => {
        sentCalls.push(input);
        return { ok: true };
      },
      writeFile: () => {},
      mkdir: () => {},
      log: (msg) => logs.push(msg),
    },
  );

  expect(result.results.length).toBe(1);
  expect(result.results[0].sent).toBe(true);
  expect(sentCalls.length).toBe(1);
});

test("runStandup sends sequentially and reports busy peer as not sent", async () => {
  const sendOrder: string[] = [];
  const targets = [
    { pane: "%1", agent: "alice", project: "API", state: "idle", message: "Task 1" },
    { pane: "%2", agent: "bob", project: "Web", state: "working", message: "Task 2" },
    { pane: "%3", agent: "charlie", project: "Worker", state: "idle", message: "Task 3" },
    { pane: "%4", agent: "david", project: "DB", state: "idle", message: "Task 4" },
  ];

  const results = await runStandup(targets, {
    sendPeer: async (input) => {
      sendOrder.push(input.target);
      if (input.target === "%3") {
        throw new Error("Peer is working; read or wait before sending another turn");
      }
      return { ok: true };
    },
  });

  expect(sendOrder).toEqual(["%1", "%3", "%4"]);
  expect(results.length).toBe(4);

  expect(results[0]).toEqual({
    pane: "%1",
    agent: "alice",
    project: "API",
    sent: true,
  });

  expect(results[1]).toEqual({
    pane: "%2",
    agent: "bob",
    project: "Web",
    sent: false,
    reason: "working",
  });

  expect(results[2]).toEqual({
    pane: "%3",
    agent: "charlie",
    project: "Worker",
    sent: false,
    reason: "working",
  });

  expect(results[3]).toEqual({
    pane: "%4",
    agent: "david",
    project: "DB",
    sent: true,
  });
});

test("dry run guarantees nothing is sent", async () => {
  const sentCalls: any[] = [];
  const logs: string[] = [];

  const resultWithoutYes = await executeStandupCommand(
    { file: "/tmp/standup.md" },
    {
      fileExists: () => true,
      readFile: () => "Standup message.",
      overviewRows: [
        { pane: "%1", agent: "agent-1", project: "API", state: "idle" },
      ],
      sendPeer: async (input) => {
        sentCalls.push(input);
        return { ok: true };
      },
      log: (msg) => logs.push(msg),
    },
  );

  expect(resultWithoutYes.dryRun).toBe(true);
  expect(sentCalls.length).toBe(0);

  const resultWithDryRunFlag = await executeStandupCommand(
    { dryRun: true, file: "/tmp/standup.md" },
    {
      fileExists: () => true,
      readFile: () => "Standup message.",
      overviewRows: [
        { pane: "%1", agent: "agent-1", project: "API", state: "idle" },
      ],
      sendPeer: async (input) => {
        sentCalls.push(input);
        return { ok: true };
      },
      log: (msg) => logs.push(msg),
    },
  );

  expect(resultWithDryRunFlag.dryRun).toBe(true);
  expect(sentCalls.length).toBe(0);
});

test("executeStandupCommand text mode prints one line per target", async () => {
  const logs: string[] = [];
  await executeStandupCommand(
    { yes: true, file: "/tmp/standup.md" },
    {
      fileExists: () => true,
      readFile: () => "Standup task.",
      overviewRows: [
        { pane: "%1", agent: "alice", project: "API", state: "idle" },
        { pane: "%2", agent: "bob", project: "Web", state: "idle" },
      ],
      sendPeer: async () => ({ ok: true }),
      writeFile: () => {},
      mkdir: () => {},
      log: (msg) => logs.push(msg),
    },
  );

  expect(logs.length).toBe(2);
  expect(logs[0]).toBe("%1 alice (API): sent");
  expect(logs[1]).toBe("%2 bob (Web): sent");
});

test("executeStandupCommand json mode outputs json object", async () => {
  const logs: string[] = [];
  const res = await executeStandupCommand(
    { yes: true, json: true, file: "/tmp/standup.md" },
    {
      fileExists: () => true,
      readFile: () => "Standup task.",
      overviewRows: [
        { pane: "%1", agent: "alice", project: "API", state: "idle" },
      ],
      sendPeer: async () => ({ ok: true }),
      writeFile: () => {},
      mkdir: () => {},
      log: (msg) => logs.push(msg),
    },
  );

  expect(logs.length).toBe(1);
  const parsed = JSON.parse(logs[0]);
  expect(parsed.results.length).toBe(1);
  expect(parsed.results[0].sent).toBe(true);
  expect(res.results.length).toBe(1);
});

test("resolveStandupEnvironment handles foreign plugin env correctly", () => {
  const foreignEnv = {
    HERDR_PLUGIN_ID: "herdr-routines",
    HERDR_PLUGIN_CONFIG_DIR: "/routines/config",
    HERDR_PLUGIN_STATE_DIR: "/routines/state",
    HERDR_PANE_ID: "%stale-pane",
  };

  const res = resolveStandupEnvironment(foreignEnv);
  expect(res.configDir).toBe(join(homedir(), ".config", "herdr", "plugins", "config", "herdr-jev"));
  expect(res.defaultFile).toBe(join(homedir(), ".config", "herdr", "plugins", "config", "herdr-jev", "standup.md"));
  expect(res.stateDir).toBe(join(homedir(), ".local", "state", "herdr-jev"));
  expect(res.callerPaneId).toBeUndefined();

  const foreignWithAuth = {
    ...foreignEnv,
    HERDR_JEV_SOURCE_PANE_ID: "%auth-pane",
    HERDR_JEV_STATE_DIR: "/custom/auth/state",
  };

  const resAuth = resolveStandupEnvironment(foreignWithAuth);
  expect(resAuth.configDir).toBe(join(homedir(), ".config", "herdr", "plugins", "config", "herdr-jev"));
  expect(resAuth.defaultFile).toBe(join(homedir(), ".config", "herdr", "plugins", "config", "herdr-jev", "standup.md"));
  expect(resAuth.stateDir).toBe("/custom/auth/state");
  expect(resAuth.callerPaneId).toBe("%auth-pane");
});

test("resolveStandupEnvironment handles herdr-jev plugin env correctly", () => {
  const jevEnv = {
    HERDR_PLUGIN_ID: "herdr-jev",
    HERDR_PLUGIN_CONFIG_DIR: "/jev/config",
    HERDR_PLUGIN_STATE_DIR: "/jev/state",
    HERDR_PANE_ID: "%jev-pane",
  };

  const res = resolveStandupEnvironment(jevEnv);
  expect(res.configDir).toBe("/jev/config");
  expect(res.defaultFile).toBe("/jev/config/standup.md");
  expect(res.stateDir).toBe("/jev/state");
  expect(res.callerPaneId).toBe("%jev-pane");
});

test("resolveStandupEnvironment handles no plugin env correctly", () => {
  const plainEnv = {
    HERDR_PLUGIN_CONFIG_DIR: "/plain/config",
    HERDR_PLUGIN_STATE_DIR: "/plain/state",
    HERDR_PANE_ID: "%plain-pane",
  };

  const res = resolveStandupEnvironment(plainEnv);
  expect(res.configDir).toBe("/plain/config");
  expect(res.defaultFile).toBe("/plain/config/standup.md");
  expect(res.stateDir).toBe("/plain/state");
  expect(res.callerPaneId).toBe("%plain-pane");

  const emptyRes = resolveStandupEnvironment({});
  expect(emptyRes.configDir).toBe(join(homedir(), ".config", "herdr", "plugins", "config", "herdr-jev"));
  expect(emptyRes.stateDir).toBe(join(homedir(), ".local", "state", "herdr-jev"));
  expect(emptyRes.callerPaneId).toBeUndefined();
});

test("planStandup ignores stale caller pane under foreign plugin env", async () => {
  const rows = [
    { pane: "%stale-pane", agent: "agent-1", project: "App", state: "idle" },
    { pane: "%other-pane", agent: "agent-2", project: "App", state: "idle" },
  ];

  const parsed = parseStandupFile("Daily task.");
  const targets = await planStandup(
    {
      overviewRows: rows,
      env: {
        HERDR_PLUGIN_ID: "herdr-routines",
        HERDR_PANE_ID: "%stale-pane",
      },
    },
    parsed,
  );

  expect(targets.length).toBe(2);
  expect(targets.map((t) => t.pane)).toEqual(["%stale-pane", "%other-pane"]);
});

test("executeStandupCommand concurrent claim with two calls sharing temp state dir", async () => {
  const tmpDir = join("/tmp", `standup-claim-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const standupFile = join(tmpDir, "standup.md");
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(standupFile, "Daily task for {{agent}}.", "utf-8");

  try {
    const p1 = executeStandupCommand(
      { auto: true, file: standupFile },
      {
        stateDir: tmpDir,
        log: () => {},
        overviewRows: [
          { pane: "%1", agent: "alice", project: "App", state: "idle" },
        ],
        sendPeer: async () => {
          await new Promise((r) => setTimeout(r, 60));
          return { ok: true };
        },
      },
    );

    const p2 = (async () => {
      await new Promise((r) => setTimeout(r, 10));
      return executeStandupCommand(
        { auto: true, file: standupFile },
        {
          stateDir: tmpDir,
          log: () => {},
          overviewRows: [
            { pane: "%1", agent: "alice", project: "App", state: "idle" },
          ],
          sendPeer: async () => ({ ok: true }),
        },
      );
    })();

    const [res1, res2] = await Promise.all([p1, p2]);
    const results = [res1, res2];
    const skipped = results.find((r) => r.skipped === "already_ran_today");
    const completed = results.find((r) => r.results && r.results.length === 1);

    expect(skipped).toBeDefined();
    expect(completed).toBeDefined();
    expect(completed.results[0].sent).toBe(true);

    const pad = (n: number) => String(n).padStart(2, "0");
    const d = new Date();
    const dateIso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const stateContent = readFileSync(join(tmpDir, "standup", `${dateIso}.auto.json`), "utf-8");
    const stateObj = JSON.parse(stateContent);
    expect(Array.isArray(stateObj)).toBe(true);
    expect(stateObj[0].sent).toBe(true);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("executeStandupCommand crash recovery reports already_ran_today unless forced", async () => {
  const tmpDir = join("/tmp", `standup-crash-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const standupFile = join(tmpDir, "standup.md");
  mkdirSync(join(tmpDir, "standup"), { recursive: true });
  writeFileSync(standupFile, "Daily task for {{agent}}.", "utf-8");

  const pad = (n: number) => String(n).padStart(2, "0");
  const d = new Date();
  const dateIso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const stateFilePath = join(tmpDir, "standup", `${dateIso}.auto.json`);
  writeFileSync(stateFilePath, JSON.stringify({ status: "running", date: dateIso }, null, 2), "utf-8");

  try {
    const catchupRes = await executeStandupCommand(
      { auto: true, file: standupFile },
      {
        stateDir: tmpDir,
        log: () => {},
        overviewRows: [
          { pane: "%1", agent: "alice", project: "App", state: "idle" },
        ],
        sendPeer: async () => ({ ok: true }),
      },
    );
    expect(catchupRes).toEqual({ skipped: "already_ran_today" });

    const forceRes = await executeStandupCommand(
      { auto: true, force: true, file: standupFile },
      {
        stateDir: tmpDir,
        log: () => {},
        overviewRows: [
          { pane: "%1", agent: "alice", project: "App", state: "idle" },
        ],
        sendPeer: async () => ({ ok: true }),
      },
    );
    expect(forceRes.results.length).toBe(1);
    expect(forceRes.results[0].sent).toBe(true);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("runStandup delivers instructions to target pane id with fake sender", async () => {
  const sentTargets: string[] = [];
  const targets = [
    { pane: "wE1:p5", agent: "codex", project: "impmotordados", state: "idle", message: "Task 1" },
    { pane: "wEC:p7", agent: "codex", project: "InvoiceConAPI", state: "idle", message: "Task 2" },
    { pane: "wEC:pF", agent: "codex", project: "InvoiceConAPI", state: "idle", message: "Task 3" },
  ];

  const results = await runStandup(targets, {
    sendPeer: async (input) => {
      sentTargets.push(input.target);
      return { ok: true };
    },
  });

  expect(sentTargets).toEqual(["wE1:p5", "wEC:p7", "wEC:pF"]);
  expect(results.length).toBe(3);
  expect(results.every((r) => r.sent)).toBe(true);
});

test("runStandup never uses agent kind as target", async () => {
  const sentTargets: string[] = [];
  const targets = [
    { pane: "%target-pane-99", agent: "codex", project: "impmotordados", state: "idle", message: "Task 1" },
    { pane: "%target-pane-100", agent: "claude", project: "InvoiceConAPI", state: "idle", message: "Task 2" },
  ];

  await runStandup(targets, {
    sendPeer: async (input) => {
      sentTargets.push(input.target);
      return { ok: true };
    },
  });

  expect(sentTargets).not.toContain("codex");
  expect(sentTargets).not.toContain("claude");
  expect(sentTargets).toEqual(["%target-pane-99", "%target-pane-100"]);
});

test("planStandup plans multiple agents of same kind across projects with project sections", async () => {
  const content = `Global instructions.

## impmotordados
Impmotordados task.

## InvoiceConAPI
InvoiceConAPI task.`;
  const parsed = parseStandupFile(content);

  const rows = [
    { pane: "wE1:p5", agent: "codex", project: "impmotordados", state: "idle" },
    { pane: "wEC:p7", agent: "codex", project: "InvoiceConAPI", state: "idle" },
    { pane: "wEC:pF", agent: "codex", project: "InvoiceConAPI", state: "idle" },
  ];

  const targets = await planStandup({ overviewRows: rows }, parsed);

  expect(targets.length).toBe(3);
  expect(targets.map((t) => t.pane)).toEqual(["wE1:p5", "wEC:p7", "wEC:pF"]);
  expect(targets.every((t) => t.agent === "codex")).toBe(true);
  expect(targets[0].message).toBe("Global instructions.\n\nImpmotordados task.");
  expect(targets[1].message).toBe("Global instructions.\n\nInvoiceConAPI task.");
  expect(targets[2].message).toBe("Global instructions.\n\nInvoiceConAPI task.");
});

test("executeStandupCommand with --pane filters eligible panes in dry-run and lists skipped with filtered reason", async () => {
  const logs: string[] = [];
  const rows = [
    { pane: "wE1:p5", agent: "codex", project: "impmotordados", state: "idle" },
    { pane: "wEC:p7", agent: "codex", project: "InvoiceConAPI", state: "idle" },
    { pane: "wEC:pF", agent: "codex", project: "InvoiceConAPI", state: "idle" },
  ];

  const res = await executeStandupCommand(
    { dryRun: true, json: true, file: "/tmp/standup.md", pane: ["wE1:p5", "wEC:pF"] },
    {
      fileExists: () => true,
      readFile: () => "Global daily task.",
      overviewRows: rows,
      sendPeer: async () => ({ ok: true }),
      log: (msg) => logs.push(msg),
    },
  );

  expect(res.dryRun).toBe(true);
  expect(res.targets.length).toBe(2);
  expect(res.targets.map((t: any) => t.pane)).toEqual(["wE1:p5", "wEC:pF"]);
  expect(res.skipped).toEqual([{ pane: "wEC:p7", reason: "filtered" }]);

  const loggedJson = JSON.parse(logs[0]);
  expect(loggedJson.targets.map((t: any) => t.pane)).toEqual(["wE1:p5", "wEC:pF"]);
  expect(loggedJson.skipped).toEqual([{ pane: "wEC:p7", reason: "filtered" }]);
});

test("executeStandupCommand auto mode respects --pane filter", async () => {
  const sentCalls: any[] = [];
  const logs: string[] = [];
  const rows = [
    { pane: "%p1", agent: "codex", project: "impmotordados", state: "idle" },
    { pane: "%p2", agent: "codex", project: "InvoiceConAPI", state: "idle" },
    { pane: "%p3", agent: "claude", project: "InvoiceConAPI", state: "idle" },
  ];

  const res = await executeStandupCommand(
    { auto: true, force: true, file: "/tmp/standup.md", pane: ["%p2"] },
    {
      fileExists: () => true,
      readFile: () => "Global standup instruction.",
      overviewRows: rows,
      stateDir: "/tmp/test-state-dir-pane",
      sendPeer: async (input) => {
        sentCalls.push(input);
        return { ok: true };
      },
      writeFile: () => {},
      mkdir: () => {},
      log: (msg) => logs.push(msg),
    },
  );

  expect(res.results.length).toBe(1);
  expect(res.results[0].pane).toBe("%p2");
  expect(sentCalls.length).toBe(1);
  expect(sentCalls[0].target).toBe("%p2");
  expect(res.skipped).toEqual([
    { pane: "%p1", reason: "filtered" },
    { pane: "%p3", reason: "filtered" },
  ]);
});

test("--pane option is subject to agent state rules", async () => {
  const rows = [
    { pane: "%working-pane", agent: "codex", project: "App", state: "working" },
    { pane: "%idle-pane", agent: "codex", project: "App", state: "idle" },
  ];

  const res = await executeStandupCommand(
    { dryRun: true, json: true, file: "/tmp/standup.md", pane: ["%working-pane"] },
    {
      fileExists: () => true,
      readFile: () => "Global standup instruction.",
      overviewRows: rows,
      sendPeer: async () => ({ ok: true }),
      log: () => {},
    },
  );

  expect(res.targets.length).toBe(0);
});

test("planStandup records all eligible-state skipped reasons", async () => {
  const content = `---
max: 1
---
## App
Only app task.`;
  const parsed = parseStandupFile(content);

  const rows = [
    { pane: "%caller", agent: "caller-agent", project: "App", state: "idle" },
    { pane: "%filtered", agent: "filtered-agent", project: "App", state: "idle" },
    { pane: "%lantern", agent: "agent-1", project: "Jev Lantern", state: "idle" },
    { pane: "%no-text", agent: "agent-2", project: "OtherProject", state: "idle" },
    { pane: "%planned", agent: "agent-3", project: "App", state: "idle" },
    { pane: "%beyond", agent: "agent-4", project: "App", state: "idle" },
    { pane: "%working", agent: "agent-5", project: "App", state: "working" },
  ];

  const targets = await planStandup(
    {
      overviewRows: rows,
      callerPaneId: "%caller",
      panes: ["%caller", "%lantern", "%no-text", "%planned", "%beyond"],
    },
    parsed,
  );

  expect(targets.length).toBe(1);
  expect(targets[0].pane).toBe("%planned");

  expect(targets.skipped).toEqual([
    { pane: "%caller", reason: "caller" },
    { pane: "%filtered", reason: "filtered" },
    { pane: "%lantern", reason: "plugin_pane" },
    { pane: "%no-text", reason: "no_text" },
    { pane: "%beyond", reason: "beyond_max" },
  ]);
});

