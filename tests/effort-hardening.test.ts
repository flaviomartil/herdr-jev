import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_EFFORT_COOLDOWN_MS,
  DEFAULT_MAX_EFFORT_SWITCHES,
  changeEffort,
  claudeEffortScreen,
  codexEffortScreen,
} from "../src/herdr/effort.js";
import { inputLineText, isVimNormalMode } from "../src/herdr/pane-text.js";
import type { RunCommand } from "../src/herdr/client.js";

const success = (result: unknown) => ({ ok: true, code: 0, stdout: JSON.stringify({ result }), stderr: "" });
const unlocked = async () => async () => {};

function freshStateDir(): string {
  return mkdtempSync(join(tmpdir(), "effort-hardening-"));
}

async function withPaneEnv<T>(pane: string, extra: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prevPane = process.env.HERDR_PANE_ID;
  const prevExtra = new Map<string, string | undefined>();
  process.env.HERDR_PANE_ID = pane;
  for (const [k, v] of Object.entries(extra)) {
    prevExtra.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    if (prevPane === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = prevPane;
    for (const [k, v] of prevExtra.entries()) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("inputLineText and isVimNormalMode", () => {
  test("strips ANSI and ignores SGR-2 / SGR-90 ghost text after composer marker", () => {
    expect(inputLineText("› \x1b[2mAsk anything\x1b[22m\ngpt-6.1-sol medium")).toBe("");
    expect(inputLineText("❯ \x1b[90mTry \"fix the build\"\x1b[39m\nOpus 4.6")).toBe("");
    expect(inputLineText("\x1b[2m›\x1b[0m \x1b[2mAsk anything\x1b[22m")).toBe("");
    expect(inputLineText("› previous prompt\n\n› fix auth \x1b[2mwith tests\x1b[22m")).toBe("fix auth");
    expect(inputLineText("› \x1b[38;5;2mgreen text\x1b[39m")).toBe("green text");
    expect(inputLineText("› \x1b[90mghost \x1b[38;5;15mlive text\x1b[0m")).toBe("live text");
    expect(inputLineText("› \x1b[90mghost \x1b[38:2:255:255:255mcolon live\x1b[0m")).toBe("colon live");
    expect(inputLineText("no prompt here")).toBe("");
  });

  test("detects vim normal mode in footer without prose or markdown table false positives", () => {
    expect(isVimNormalMode("›\n-- NORMAL --\ngpt-6.1-sol medium")).toBe(true);
    expect(isVimNormalMode("›\n-- Normal --\ngpt-6.1-sol medium")).toBe(true);
    expect(isVimNormalMode("❯\n· normal · ? for shortcuts")).toBe(true);
    expect(isVimNormalMode("❯\n│ NORMAL │")).toBe(true);
    expect(isVimNormalMode("❯\n[NORMAL]")).toBe(true);

    expect(isVimNormalMode("• Everything returned to NORMAL after deploy\n›\n? for shortcuts")).toBe(false);
    expect(isVimNormalMode("›\nThe NORMAL mode prose in docs\ngpt-6.1-sol medium")).toBe(false);
    expect(isVimNormalMode("| Col | NORMAL | State |")).toBe(false);
    expect(isVimNormalMode("Normal operation resumed")).toBe(false);
  });
});

describe("codexEffortScreen hardening", () => {
  test("accepts faint SGR-2/SGR-90 placeholder ghost text while rejecting live input and vim normal mode", () => {
    expect(codexEffortScreen("› \x1b[2mAsk anything\x1b[22m\ngpt-6.1-sol medium")).toEqual({
      model: "gpt-6.1-sol",
      effort: "medium",
    });
    expect(codexEffortScreen("› \x1b[90mSummarize changes\x1b[39m\ngpt-6.1-sol high")).toEqual({
      model: "gpt-6.1-sol",
      effort: "high",
    });
    expect(() => codexEffortScreen("› real draft \x1b[2msuggestion\x1b[22m\ngpt-6.1-sol medium")).toThrow();
    expect(() => codexEffortScreen("›\n-- NORMAL --\ngpt-6.1-sol medium")).toThrow(/vim normal mode/i);
  });
});

describe("changeEffort Codex mid-turn queue", () => {
  test("rejects working Codex pane unless allowMidTurnQueue is enabled, and dispatches Tab safely when opt-in", async () => {
    const pane = "w2:p1";
    const stateDir = freshStateDir();
    await withPaneEnv(pane, {}, async () => {
      const agent = { pane_id: pane, terminal_id: "term-w", agent: "codex", agent_status: "working", agent_session: { kind: "id", value: "s-1" } };
      let effort = "medium";
      let screen = `› \x1b[2mAsk anything\x1b[22m\nesc to interrupt · gpt-6.1-sol ${effort}`;
      const sent: string[][] = [];
      const run: RunCommand = async (argv) => {
        if (argv.includes("get")) return success({ agent });
        if (argv.includes("send-keys")) {
          sent.push([...argv]);
          effort = "high";
          screen = `› \x1b[2mAsk anything\x1b[22m\nesc to interrupt · gpt-6.1-sol ${effort}`;
          return success({});
        }
        return { ok: true, code: 0, stdout: screen, stderr: "" };
      };

      await expect(changeEffort(pane, "high", run, unlocked, { stateDir })).rejects.toThrow("idle Codex");
      expect(sent).toHaveLength(0);

      // Unsafe composer with live draft must still block even with allowMidTurnQueue
      screen = "› typed draft\nesc to interrupt · gpt-6.1-sol medium";
      await expect(changeEffort(pane, "high", run, unlocked, { allowMidTurnQueue: true, stateDir })).rejects.toThrow();
      expect(sent).toHaveLength(0);

      // Wrapped draft / unknown overlay in working footer must still block
      screen = "›\nwrapped draft\nesc to interrupt · gpt-6.1-sol medium";
      await expect(changeEffort(pane, "high", run, unlocked, { allowMidTurnQueue: true, stateDir })).rejects.toThrow(/wrapped input|unknown footer/i);
      expect(sent).toHaveLength(0);

      // Vim normal mode must block even with allowMidTurnQueue
      screen = "›\n-- NORMAL --\nesc to interrupt · gpt-6.1-sol medium";
      await expect(changeEffort(pane, "high", run, unlocked, { allowMidTurnQueue: true, stateDir })).rejects.toThrow(/vim normal mode/i);
      expect(sent).toHaveLength(0);

      // Clean working composer with allowMidTurnQueue sends tab + alt+.
      screen = `› \x1b[2mAsk anything\x1b[22m\nesc to interrupt · gpt-6.1-sol medium`;
      const res = await changeEffort(pane, "high", run, unlocked, { allowMidTurnQueue: true, stateDir });
      expect(res).toMatchObject({ status: "applied", effort: "high", effective: "next-turn", queued: true });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("tab");
      expect(sent[0]!.at(-1)).toBe("alt+.");
    });
  });
});

describe("changeEffort Claude session-only /effort and safety dialogs", () => {
  test("applies session-only /effort (mapping xhigh -> max) and handles session-only prompt without touching settings.json", async () => {
    const pane = "w2:p2";
    const stateDir = freshStateDir();
    await withPaneEnv(pane, {}, async () => {
      const agent = { pane_id: pane, terminal_id: "term-c1", agent: "claude", agent_status: "idle", agent_session: { kind: "id", value: "c-1" } };
      let screen = "❯ \x1b[2mTry something\x1b[22m\nOpus 4.6 · effort: medium";
      const sent: string[][] = [];
      const run: RunCommand = async (argv) => {
        if (argv.includes("get")) return success({ agent });
        if (argv.includes("send-keys")) {
          sent.push([...argv]);
          if (argv.includes("/effort max")) {
            screen = "Effort slider\nPress s for session-only";
          } else if (argv.includes("s")) {
            screen = "❯\nOpus 4.6 · effort: max";
          }
          return success({});
        }
        return { ok: true, code: 0, stdout: screen, stderr: "" };
      };

      const res = await changeEffort(pane, "xhigh", run, unlocked, { stateDir });
      expect(res).toMatchObject({ status: "applied", effort: "max", sessionOnly: true });
      expect(sent.map((c) => c.slice(4))).toEqual([
        ["/effort max", "enter"],
        ["s"],
      ]);
    });
  });

  test("auto-dismisses Bedrock/gateway cache-invalidation warning with esc and never confirms", async () => {
    const pane = "w2:p3";
    const stateDir = freshStateDir();
    await withPaneEnv(pane, {}, async () => {
      const agent = { pane_id: pane, terminal_id: "term-c2", agent: "claude", agent_status: "idle", agent_session: { kind: "id", value: "c-2" } };
      let screen = "❯\nOpus 4.6 · effort: medium";
      const sent: string[][] = [];
      const run: RunCommand = async (argv) => {
        if (argv.includes("get")) return success({ agent });
        if (argv.includes("send-keys")) {
          sent.push([...argv]);
          if (argv.includes("/effort high")) {
            screen = "Warning: Bedrock prompt cache invalidation will reset cache. Press Enter to confirm or Esc to cancel.";
          }
          return success({});
        }
        return { ok: true, code: 0, stdout: screen, stderr: "" };
      };

      await expect(changeEffort(pane, "high", run, unlocked, { stateDir })).rejects.toThrow(/cache-invalidation warning dismissed with esc/i);
      expect(sent.at(-1)!.at(-1)).toBe("esc");
      expect(claudeEffortScreen("❯\nOpus 4.6 · effort: high")).toMatchObject({ hasComposer: true, effort: "high" });
      // Scrollback mentioning cache invalidation or effort above ❯ must not trigger false positives
      expect(
        claudeEffortScreen("User: Bedrock cache invalidation happened earlier\nSet effort level to low\n❯\nOpus 4.6 · effort: high"),
      ).toMatchObject({ hasComposer: true, effort: "high", cacheWarning: false });
      // Multi-line wrapped draft between ❯ and footer must throw
      expect(() => claudeEffortScreen("❯\nwrapped multi-line draft\nOpus 4.6 · effort: high")).toThrow(/wrapped input/i);
    });
  });
});

describe("anti-flap cooldown, window cap, and topTierUnlocked gate", () => {
  test("enforces 30s cooldown and 3-switch 5m window cap", async () => {
    const pane = "w2:p4";
    const stateDir = freshStateDir();
    await withPaneEnv(pane, {}, async () => {
      const agent = { pane_id: pane, terminal_id: "term-af", agent: "codex", agent_status: "idle", agent_session: { kind: "id", value: "s-af" } };
      let effort = "low";
      const run: RunCommand = async (argv) => {
        if (argv.includes("get")) return success({ agent });
        if (argv.includes("send-keys")) {
          const keys = argv.slice(4);
          const levels = ["low", "medium", "high", "xhigh"];
          let idx = levels.indexOf(effort);
          for (const k of keys) idx += k === "alt+." ? 1 : -1;
          effort = levels[idx]!;
          return success({});
        }
        return { ok: true, code: 0, stdout: `›\ngpt-6.1-sol ${effort}`, stderr: "" };
      };

      const t0 = 1_000_000;
      await changeEffort(pane, "medium", run, unlocked, { stateDir, now: t0 });
      // Rapid switch inside 30s cooldown fails
      await expect(
        changeEffort(pane, "high", run, unlocked, { stateDir, now: t0 + DEFAULT_EFFORT_COOLDOWN_MS - 1000 }),
      ).rejects.toThrow(/cooldown/i);

      // Switches spaced >30s succeed up to cap (3)
      await changeEffort(pane, "high", run, unlocked, { stateDir, now: t0 + DEFAULT_EFFORT_COOLDOWN_MS + 1000 });
      await changeEffort(pane, "medium", run, unlocked, { stateDir, now: t0 + (DEFAULT_EFFORT_COOLDOWN_MS + 1000) * 2 });

      // 4th switch within 5m window hits cap
      await expect(
        changeEffort(pane, "low", run, unlocked, { stateDir, now: t0 + (DEFAULT_EFFORT_COOLDOWN_MS + 1000) * 3 }),
      ).rejects.toThrow(new RegExp(`${DEFAULT_MAX_EFFORT_SWITCHES}/${DEFAULT_MAX_EFFORT_SWITCHES}`));
    });
  });

  test("gates xhigh/max for delegated subagents (cannot self-bypass via env) unless options.topTierUnlocked is set", async () => {
    const pane = "w2:p5";
    const stateDir = freshStateDir();
    await withPaneEnv(pane, { HERDR_JEV_IS_WORKER: undefined, HERDR_JEV_TOP_TIER_UNLOCKED: "1" }, async () => {
      for (const tokens of [
        { jev_parent: "w1:p0" },
        { jev_role: "implementer" },
        { jev_handle: "worker-1" },
      ]) {
        const agent = {
          pane_id: pane,
          terminal_id: "term-top",
          agent: "codex",
          agent_status: "idle",
          agent_session: { kind: "id", value: "s-top" },
          tokens,
        };
        let effort = "high";
        const run: RunCommand = async (argv) => {
          if (argv.includes("get")) return success({ agent });
          if (argv.includes("send-keys")) {
            effort = "xhigh";
            return success({});
          }
          return { ok: true, code: 0, stdout: `›\ngpt-6.1-sol ${effort}`, stderr: "" };
        };

        // Even with HERDR_JEV_TOP_TIER_UNLOCKED=1 in env, worker tokens cannot self-bypass
        await expect(changeEffort(pane, "xhigh", run, unlocked, { stateDir })).rejects.toThrow(/top-tier effort/i);
      }

      const agent = {
        pane_id: pane,
        terminal_id: "term-top",
        agent: "codex",
        agent_status: "idle",
        agent_session: { kind: "id", value: "s-top" },
        tokens: { jev_parent: "w1:p0" },
      };
      let effort = "high";
      const run: RunCommand = async (argv) => {
        if (argv.includes("get")) return success({ agent });
        if (argv.includes("send-keys")) {
          effort = "xhigh";
          return success({});
        }
        return { ok: true, code: 0, stdout: `›\ngpt-6.1-sol ${effort}`, stderr: "" };
      };
      const res = await changeEffort(pane, "xhigh", run, unlocked, { stateDir, topTierUnlocked: true });
      expect(res).toMatchObject({ status: "applied", effort: "xhigh" });
    });

    // Also gate via HERDR_JEV_IS_WORKER=1 env var even when HERDR_JEV_TOP_TIER_UNLOCKED=1
    await withPaneEnv(pane, { HERDR_JEV_IS_WORKER: "1", HERDR_JEV_TOP_TIER_UNLOCKED: "1" }, async () => {
      const agent = { pane_id: pane, terminal_id: "term-top2", agent: "claude", agent_status: "idle", agent_session: { kind: "id", value: "c-top" } };
      const run: RunCommand = async (argv) => {
        if (argv.includes("get")) return success({ agent });
        return { ok: true, code: 0, stdout: "❯\nOpus 4.6 · effort: high", stderr: "" };
      };
      await expect(changeEffort(pane, "max", run, unlocked, { stateDir })).rejects.toThrow(/top-tier effort/i);
    });
  });
});
