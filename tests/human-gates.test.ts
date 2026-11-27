import { describe, expect, test } from "bun:test";
import {
  DEFAULT_IDLE_GRACE_SECONDS,
  DEFAULT_MAX_AUTO_HOPS,
  canAutoHop,
  isPastIdleGrace,
  planSessionRescue,
} from "../src/herdr/human-gates.js";
import { studio } from "../src/herdr/studio.js";
import type { RunCommand } from "../src/herdr/client.js";

const success = (result: unknown) => ({ ok: true, code: 0, stdout: JSON.stringify({ result }), stderr: "" });
const unlocked = async () => async () => {};

describe("human gates helpers", () => {
  test("canAutoHop enforces DEFAULT_MAX_AUTO_HOPS and rejects invalid counters", () => {
    expect(DEFAULT_MAX_AUTO_HOPS).toBe(3);
    expect(canAutoHop(0)).toBe(true);
    expect(canAutoHop(1)).toBe(true);
    expect(canAutoHop(2)).toBe(true);
    expect(canAutoHop(3)).toBe(false);
    expect(canAutoHop(4)).toBe(false);
    expect(canAutoHop(-1)).toBe(false);
    expect(canAutoHop(Number.NaN)).toBe(false);
  });

  test("isPastIdleGrace honors DEFAULT_IDLE_GRACE_SECONDS boundary", () => {
    expect(DEFAULT_IDLE_GRACE_SECONDS).toBe(30);
    const t0 = 1_000_000;
    expect(isPastIdleGrace(t0, t0 + 29_999)).toBe(false);
    expect(isPastIdleGrace(t0, t0 + 30_000)).toBe(true);
    expect(isPastIdleGrace(t0, t0 + 5_000, 5)).toBe(true);
    expect(isPastIdleGrace(Number.NaN, t0)).toBe(false);
  });

  test("planSessionRescue uses AgentInfo.agent_session preferring terminal_id without prompts or credentials", () => {
    // Prefer terminal_id match over pane_id; exited agent can be rescued with its native session
    const plan = planSessionRescue(
      { paneId: "w1:p9", terminalId: "term-2", agent: "claude", agentSession: "stale-record" },
      [
        { pane_id: "w1:p9", terminal_id: "term-other", agent: "claude", agent_status: "exited", agent_session: { kind: "id", value: "wrong-id" } },
        { pane_id: "w1:p2", terminal_id: "term-2", agent: "claude", agent_status: "exited", agent_session: { kind: "id", value: "sess-term2" } },
      ],
    );
    expect(plan).toEqual({
      action: "resume",
      reason: "session-ready",
      client: "claude",
      sessionId: "sess-term2",
      argv: ["claude", "--resume", "sess-term2"],
      command: "claude --resume sess-term2",
    });

    // Codex fallback from record when pane vanished
    const codexPlan = planSessionRescue(
      { paneId: "w1:p3", terminalId: "term-3", agent: "codex", agentSession: "codex-abc-1" },
      [],
    );
    expect(codexPlan).toEqual({
      action: "resume",
      reason: "session-ready",
      client: "codex",
      sessionId: "codex-abc-1",
      argv: ["codex", "resume", "codex-abc-1"],
      command: "codex resume codex-abc-1",
    });

    // Still alive -> none
    expect(
      planSessionRescue(
        { terminalId: "term-live", agent: "claude", agentSession: "live-1" },
        [{ terminal_id: "term-live", agent: "claude", agent_status: "working", agent_session: { kind: "id", value: "live-1" } }],
      ),
    ).toMatchObject({ action: "none", reason: "still-alive" });

    // Missing terminal_id must NOT fall back to pane_id (could match a different terminal in a recycled pane)
    expect(
      planSessionRescue(
        { paneId: "w1:p9", terminalId: "term-gone", agent: "claude", agentSession: "sess-own" },
        [{ pane_id: "w1:p9", terminal_id: "term-new-occupant", agent: "claude", agent_status: "working", agent_session: { kind: "id", value: "sess-other" } }],
      ),
    ).toEqual({
      action: "resume",
      reason: "session-ready",
      client: "claude",
      sessionId: "sess-own",
      argv: ["claude", "--resume", "sess-own"],
      command: "claude --resume sess-own",
    });

    // Rejects leading '-' in session IDs to prevent CLI option injection
    expect(planSessionRescue({ paneId: "w1:p4", agent: "claude", agentSession: "--help" }, [])).toEqual({
      action: "none",
      reason: "missing-session",
      client: "claude",
    });

    // Missing session -> none
    expect(planSessionRescue({ paneId: "w1:p4", agent: "claude" }, [])).toEqual({
      action: "none",
      reason: "missing-session",
      client: "claude",
    });

    // Unsupported client -> none
    expect(planSessionRescue({ paneId: "w1:p5", agent: "kimi", agentSession: "k-1" }, [])).toEqual({
      action: "none",
      reason: "unsupported-client",
      client: "kimi",
      sessionId: "k-1",
    });
  });
});

describe("studio automatic event hop cap", () => {
  test("increments jev_studio_hops up to DEFAULT_MAX_AUTO_HOPS and ignores further auto events", async () => {
    const source = {
      pane_id: "w1:p1",
      tab_id: "w1:t1",
      agent: "codex",
      agent_status: "done",
      cwd: "/tmp/repo",
      agent_session: { kind: "id", value: "native-1" },
      tokens: {} as Record<string, string>,
    };
    const panes: any[] = [source];
    const run: RunCommand = async (argv) => {
      if (argv.includes("snapshot")) return success({ snapshot: { agents: [source], panes } });
      if (argv.includes("report-metadata")) {
        const token = argv.at(-1)!;
        const eq = token.indexOf("=");
        source.tokens[token.slice(0, eq)] = token.slice(eq + 1);
        return { ok: true, code: 0, stdout: "", stderr: "" };
      }
      if (argv.includes("open")) {
        const pane = { pane_id: `w1:p${panes.length + 1}`, tab_id: source.tab_id };
        panes.push(pane);
        return success({ plugin_pane: { pane } });
      }
      return { ok: true, code: 0, stdout: " M file.ts", stderr: "" };
    };

    await studio({ pane: source.pane_id }, run, unlocked);

    expect(await studio({ pane: source.pane_id, event: true }, run, unlocked)).toMatchObject({ status: "review-open" });
    expect(source.tokens.jev_studio_hops).toBe("1");

    expect(await studio({ pane: source.pane_id, event: true }, run, unlocked)).toMatchObject({ status: "review-open" });
    expect(source.tokens.jev_studio_hops).toBe("2");

    expect(await studio({ pane: source.pane_id, event: true }, run, unlocked)).toMatchObject({ status: "review-open" });
    expect(source.tokens.jev_studio_hops).toBe("3");

    expect(await studio({ pane: source.pane_id, event: true }, run, unlocked)).toEqual({
      status: "ignored",
      reason: "max-auto-hops",
    });
    expect(source.tokens.jev_studio_hops).toBe("3");

    // Manual studio({ pane, review: true }) resets jev_studio_hops to "0"
    await studio({ pane: source.pane_id, review: true }, run, unlocked);
    expect(source.tokens.jev_studio_hops).toBe("0");
    expect(await studio({ pane: source.pane_id, event: true }, run, unlocked)).toMatchObject({ status: "review-open" });
    expect(source.tokens.jev_studio_hops).toBe("1");
  });
});
