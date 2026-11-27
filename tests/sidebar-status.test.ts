import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDisplayAgentArgs,
  clearHerdrSidebarCapabilitiesCache,
  computeStickyBadgeState,
  detectHerdrSidebarCapabilities,
  formatSidebarBadge,
  MAX_SIDEBAR_BADGE_CHARS,
  resolveAgentRepoMetadata,
} from "../src/herdr/sidebar-status.js";
import { readOverview } from "../src/herdr/overview.js";
import { reportProgress } from "../src/herdr/progress.js";
import type { RunCommand } from "../src/herdr/client.js";

let sockDir = "";
let servers: Server[] = [];

beforeEach(() => {
  sockDir = mkdtempSync(join(tmpdir(), "herdr-sidebar-test-"));
  servers = [];
  clearHerdrSidebarCapabilitiesCache();
});

afterEach(async () => {
  clearHerdrSidebarCapabilitiesCache();
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  rmSync(sockDir, { recursive: true, force: true });
});

async function startSchemaServer(schemaResponse: Record<string, unknown>, onCall?: () => void): Promise<string> {
  const socketPath = join(sockDir, `schema-${servers.length + 1}.sock`);
  const server = createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const req = JSON.parse(buf.slice(0, nl));
      onCall?.();
      socket.end(`${JSON.stringify({ id: req.id, result: schemaResponse })}\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return socketPath;
}

describe("detectHerdrSidebarCapabilities", () => {
  test("detects display_agent and agent.view.set from socket api.schema and caches per socket path", async () => {
    let calls = 0;
    const sockA = await startSchemaServer(
      {
        protocol: 22,
        schema_version: 1,
        schemas: {
          request: {
            oneOf: [{ properties: { method: { const: "agent.view.set" } } }],
            $defs: {
              PaneReportMetadataParams: {
                properties: {
                  display_agent: { type: ["string", "null"] },
                },
              },
            },
          },
        },
      },
      () => {
        calls += 1;
      },
    );

    const sockB = await startSchemaServer({
      protocol: 21,
      schema_version: 1,
      schemas: {
        request: {
          oneOf: [{ properties: { method: { const: "pane.report_metadata" } } }],
          $defs: {
            PaneReportMetadataParams: {
              properties: {
                title: { type: ["string", "null"] },
              },
            },
          },
        },
      },
    });

    const capsA1 = await detectHerdrSidebarCapabilities({ socketPath: sockA });
    const capsA2 = await detectHerdrSidebarCapabilities({ socketPath: sockA });
    expect(capsA1).toEqual({
      displayAgentFlag: true,
      agentViewSetRpc: true,
      protocol: 22,
      schemaVersion: 1,
    });
    expect(capsA2).toEqual(capsA1);
    expect(calls).toBe(1);

    const capsB = await detectHerdrSidebarCapabilities({ socketPath: sockB });
    expect(capsB).toEqual({
      displayAgentFlag: false,
      agentViewSetRpc: false,
      protocol: 21,
      schemaVersion: 1,
    });

    clearHerdrSidebarCapabilitiesCache(sockA);
    await detectHerdrSidebarCapabilities({ socketPath: sockA });
    expect(calls).toBe(2);
  });

  test("falls back to CLI run adapter when socket is absent and safely returns false under test guard", async () => {
    const guarded = await detectHerdrSidebarCapabilities({
      env: { HERDR_JEV_TEST_GUARD: "1" },
    });
    expect(guarded).toEqual({ displayAgentFlag: false, agentViewSetRpc: false });

    clearHerdrSidebarCapabilitiesCache();
    const run: RunCommand = async (argv) => {
      expect(argv.slice(-3)).toEqual(["api", "schema", "--json"]);
      return {
        ok: true,
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          protocol: 22,
          schema_version: 1,
          schemas: {
            request: {
              oneOf: [{ properties: { method: { const: "agent.view.set" } } }],
              $defs: {
                PaneReportMetadataParams: {
                  properties: { display_agent: { type: ["string", "null"] } },
                },
              },
            },
          },
        }),
      };
    };

    const viaRun = await detectHerdrSidebarCapabilities({ socketPath: null, run });
    expect(viaRun.displayAgentFlag).toBe(true);
    expect(viaRun.agentViewSetRpc).toBe(true);
  });

  test("does not cache transient failures, test-guard-rejected sockets, or fall back to CLI on explicit client/socket failure", async () => {
    let runCalls = 0;
    const run: RunCommand = async () => {
      runCalls += 1;
      return {
        ok: true,
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          protocol: 22,
          schema_version: 1,
          schemas: {
            request: {
              oneOf: [{ properties: { method: { const: "agent.view.set" } } }],
              $defs: { PaneReportMetadataParams: { properties: { display_agent: { type: ["string", "null"] } } } },
            },
          },
        }),
      };
    };

    // Test guard rejects unsafe socketPath without caching and without falling back to CLI.
    const rejected = await detectHerdrSidebarCapabilities({
      env: { HERDR_JEV_TEST_GUARD: "1" },
      socketPath: "/etc/unsafe-herdr.sock",
      run,
    });
    expect(rejected).toEqual({ displayAgentFlag: false, agentViewSetRpc: false });
    expect(runCalls).toBe(0);

    // Explicit client failing apiSchema() does NOT fall back to CLI and does NOT cache failure.
    let schemaAttempts = 0;
    const flakySocket = join(sockDir, "flaky.sock");
    const flakyClient = {
      socketPath: flakySocket,
      apiSchema: async () => {
        schemaAttempts += 1;
        if (schemaAttempts === 1) throw new Error("transient failure");
        return {
          protocol: 22,
          schema_version: 1,
          schemas: {
            request: {
              oneOf: [{ properties: { method: { const: "agent.view.set" } } }],
              $defs: { PaneReportMetadataParams: { properties: { display_agent: { type: ["string", "null"] } } } },
            },
          },
        };
      },
    };

    const first = await detectHerdrSidebarCapabilities({ client: flakyClient, run });
    expect(first).toEqual({ displayAgentFlag: false, agentViewSetRpc: false });
    expect(runCalls).toBe(0);

    const second = await detectHerdrSidebarCapabilities({ client: flakyClient, run });
    expect(second.displayAgentFlag).toBe(true);
    expect(schemaAttempts).toBe(2);
  });
});

describe("formatSidebarBadge and buildDisplayAgentArgs", () => {
  test("produces telegraphic badges strictly capped at 20 chars", () => {
    const cases = [
      formatSidebarBadge({ state: "idle", reason: "approval" }),
      formatSidebarBadge({ state: "working", reason: "question" }),
      formatSidebarBadge({ state: "blocked" }),
      formatSidebarBadge({ state: "idle", quietMinutes: 12 }),
      formatSidebarBadge({ state: "working", stalledMinutes: 45 }),
      formatSidebarBadge({ state: "idle", reason: "review" }),
      formatSidebarBadge({ state: "working" }),
      formatSidebarBadge({ state: "done" }),
      formatSidebarBadge({ state: "idle" }),
      formatSidebarBadge({ state: "working", stalledMinutes: 123456789012345 }),
    ];

    expect(cases.slice(0, 9)).toEqual([
      "!! approval",
      "!! question",
      "blocked",
      "quiet 12m",
      "stalled 45m",
      "review",
      "working",
      "done",
      "idle",
    ]);
    for (const badge of cases) {
      expect(badge.length).toBeLessThanOrEqual(MAX_SIDEBAR_BADGE_CHARS);
    }
  });

  test("buildDisplayAgentArgs emits --display-agent only when enabled and sanitized label <= 20 chars", () => {
    expect(buildDisplayAgentArgs("!! approval", false)).toEqual([]);
    expect(buildDisplayAgentArgs("!! approval", { displayAgentFlag: false })).toEqual([]);
    expect(buildDisplayAgentArgs("!! approval", true)).toEqual(["--display-agent", "!! approval"]);
    expect(buildDisplayAgentArgs("  \u001b[31mworking\u001b[0m\n ", { displayAgentFlag: true })).toEqual([
      "--display-agent",
      "working",
    ]);
    expect(buildDisplayAgentArgs("this label is over twenty chars", true)).toEqual([]);
    expect(buildDisplayAgentArgs("   \n\t ", true)).toEqual([]);
  });
});

describe("computeStickyBadgeState", () => {
  test("holds done_hold and blocked_hold within TTL and clears after expiry when detection is active", () => {
    const blocked = computeStickyBadgeState({
      agent: { agent_status: "blocked", screen_detection_skipped: false },
      reason: "approval",
      now: 1000,
      blockedHoldTtlMs: 5000,
    });
    expect(blocked).toMatchObject({ kind: "blocked_hold", reason: "approval", heldStatus: "blocked" });

    const stillBlocked = computeStickyBadgeState({
      agent: { agent_status: "idle", screen_detection_skipped: false },
      previous: blocked,
      now: 4000,
      blockedHoldTtlMs: 5000,
    });
    expect(stillBlocked.kind).toBe("blocked_hold");
    expect(formatSidebarBadge({ state: "idle", stickyState: stillBlocked })).toBe("!! approval");

    const expired = computeStickyBadgeState({
      agent: { agent_status: "idle", screen_detection_skipped: false },
      previous: stillBlocked,
      now: 6000,
      blockedHoldTtlMs: 5000,
    });
    expect(expired.kind).toBe("none");
    expect(formatSidebarBadge({ state: "idle", stickyState: expired })).toBe("idle");

    const done = computeStickyBadgeState({
      agent: { agent_status: "done", screen_detection_skipped: false },
      now: 10_000,
      doneHoldTtlMs: 3000,
    });
    expect(done.kind).toBe("done_hold");
    expect(
      computeStickyBadgeState({
        agent: { agent_status: "working", screen_detection_skipped: false },
        previous: done,
        now: 11_000,
      }).kind,
    ).toBe("none");
  });

  test("never resets held state to idle while screen_detection_skipped is true even past TTL", () => {
    const done = computeStickyBadgeState({
      agent: { agent_status: "done", screen_detection_skipped: false },
      now: 1000,
      doneHoldTtlMs: 1000,
    });
    const heldDuringSkip = computeStickyBadgeState({
      agent: { agent_status: "idle", screen_detection_skipped: true },
      previous: done,
      now: 999_999,
      doneHoldTtlMs: 1000,
    });
    expect(heldDuringSkip.kind).toBe("done_hold");
    expect(heldDuringSkip.heldStatus).toBe("done");
    expect(formatSidebarBadge({ state: "idle", stickyState: heldDuringSkip })).toBe("done");

    const blocked = computeStickyBadgeState({
      agent: { agent_status: "blocked", screen_detection_skipped: false },
      reason: "question",
      now: 1000,
      blockedHoldTtlMs: 1000,
    });
    const heldBlockedDuringSkip = computeStickyBadgeState({
      agent: { agent_status: "unknown", screen_detection_skipped: true },
      previous: blocked,
      now: 999_999,
      blockedHoldTtlMs: 1000,
    });
    expect(heldBlockedDuringSkip.kind).toBe("blocked_hold");
    expect(formatSidebarBadge({ state: "unknown", stickyState: heldBlockedDuringSkip })).toBe("!! question");
  });

  test("normalizes reason case and expires done_hold on idle even when reason=review remains", () => {
    const blocked = computeStickyBadgeState({
      agent: { agent_status: "idle", screen_detection_skipped: false },
      reason: "Approval",
      now: 1000,
      blockedHoldTtlMs: 5000,
    });
    expect(blocked).toMatchObject({ kind: "blocked_hold", reason: "approval" });

    const done = computeStickyBadgeState({
      agent: { agent_status: "done", screen_detection_skipped: false },
      reason: "REVIEW",
      now: 1000,
      doneHoldTtlMs: 2000,
    });
    expect(done).toMatchObject({ kind: "done_hold", reason: "review", expiresAtMs: 3000 });

    const stillHeld = computeStickyBadgeState({
      agent: { agent_status: "idle", screen_detection_skipped: false },
      previous: done,
      reason: "review",
      now: 2500,
      doneHoldTtlMs: 2000,
    });
    expect(stillHeld.kind).toBe("done_hold");
    expect(stillHeld.expiresAtMs).toBe(3000);

    const expired = computeStickyBadgeState({
      agent: { agent_status: "idle", screen_detection_skipped: false },
      previous: stillHeld,
      reason: "review",
      now: 3000,
      doneHoldTtlMs: 2000,
    });
    expect(expired.kind).toBe("none");
  });
});

describe("resolveAgentRepoMetadata and readOverview snapshot optimization", () => {
  test("extracts project, branch, worktreePath, workspaceId from snapshot without spawning git rev-parse", async () => {
    const snapshot = {
      workspaces: [
        {
          workspace_id: "w1",
          label: "Core",
          worktree: {
            repo_key: "core",
            repo_name: "core-repo",
            repo_root: "/repos/core",
            checkout_path: "/repos/core/wt-1",
            is_linked_worktree: true,
          },
        },
      ],
      worktrees: [
        {
          path: "/repos/core/wt-1",
          branch: "feat/native-snap",
          open_workspace_id: "w1",
          label: "wt-1",
        },
      ],
      agents: [
        {
          workspace_id: "w1",
          pane_id: "w1:p1",
          cwd: "/repos/core/wt-1/packages/api",
          agent: "codex",
          agent_status: "working",
          tokens: {},
        },
      ],
    };

    expect(resolveAgentRepoMetadata(snapshot.agents[0], snapshot)).toEqual({
      project: "Core",
      branch: "feat/native-snap",
      worktreePath: "/repos/core/wt-1",
      workspaceId: "w1",
    });

    const calls: string[][] = [];
    const run: RunCommand = async (argv) => {
      calls.push([...argv]);
      if (argv.includes("snapshot")) {
        return { ok: true, code: 0, stderr: "", stdout: JSON.stringify({ result: { snapshot } }) };
      }
      throw new Error("git rev-parse should not be spawned when branch is present in snapshot");
    };

    const overview = await readOverview(run, [], 1000);
    expect(calls).toHaveLength(1);
    expect(overview[0]).toMatchObject({
      project: "Core",
      branch: "feat/native-snap",
      pane: "w1:p1",
    });
  });

  test("falls back to git rev-parse only when snapshot lacks branch metadata", async () => {
    const calls: string[][] = [];
    const run: RunCommand = async (argv) => {
      calls.push([...argv]);
      if (argv.includes("snapshot")) {
        return {
          ok: true,
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            result: {
              snapshot: {
                workspaces: [{ workspace_id: "w1", label: "FallbackProj" }],
                agents: [
                  {
                    workspace_id: "w1",
                    pane_id: "w1:p1",
                    cwd: "/tmp/fallback",
                    agent: "claude",
                    agent_status: "idle",
                    tokens: {},
                  },
                ],
              },
            },
          }),
        };
      }
      return { ok: true, code: 0, stderr: "", stdout: "main\n" };
    };

    const overview = await readOverview(run, [], 1000);
    expect(calls).toHaveLength(2);
    expect(overview[0]).toMatchObject({
      project: "FallbackProj",
      branch: "main",
    });
  });

  test("reportProgress emits jev_badge alongside jev_progress with jev_progress preserved as last token", async () => {
    const savedPane = process.env.HERDR_PANE_ID;
    process.env.HERDR_PANE_ID = "w1:p1";
    const calls: string[][] = [];
    const sourceAgent = {
      pane_id: "w1:p1",
      terminal_id: "term-1",
      cwd: "/tmp/repo",
      agent: "codex",
      agent_status: "blocked",
      agent_session: { kind: "id", value: "native-1" },
      tokens: {},
    };
    const run: RunCommand = async (argv) => {
      calls.push([...argv]);
      if (argv.includes("get")) {
        return { ok: true, code: 0, stderr: "", stdout: JSON.stringify({ result: { agent: sourceAgent } }) };
      }
      return { ok: true, code: 0, stderr: "", stdout: "" };
    };
    const history = async (argv: string[]) =>
      argv[0] === "show"
        ? { session: { native_id: "native-1", client: "codex", cwd: sourceAgent.cwd, key: "codex:origin" } }
        : { work: { id: "event-1", status: "open" } };
    try {
      await reportProgress(
        { pane: "w1:p1", activity: "Need approval", reason: "approval" },
        run,
        history,
        async () => async () => {},
        1_000_000,
      );
      const reportCall = calls.find((argv) => argv.includes("report-metadata"));
      expect(reportCall).toBeDefined();
      expect(reportCall).toContain("jev_badge=!! approval");
      expect(reportCall!.at(-1)?.startsWith("jev_progress=")).toBe(true);
    } finally {
      if (savedPane === undefined) delete process.env.HERDR_PANE_ID;
      else process.env.HERDR_PANE_ID = savedPane;
    }
  });
});
