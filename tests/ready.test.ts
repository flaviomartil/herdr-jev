import { describe, expect, it } from "bun:test";
import { launchStageInHerdr, type StageSpec } from "../src/herdr/launcher.js";
import type { HerdrCommandResult, HerdrClient } from "../src/herdr/client.js";

const stage: StageSpec = { role: "implementer", model: "fake-model", effort: "high", extraFlags: [], description: "" };

function commandResult(ok: boolean, stdout = "", stderr = ""): HerdrCommandResult {
  return { ok, code: ok ? 0 : 1, stdout, stderr };
}

describe("launcher prompt readiness and retry", () => {
  it("waits for readiness, times out if text never appears, retries once on agent_prompt_stalled, no retry if text visible", async () => {
    let mockNow = 1000000;
    const fakeClock = {
      now: () => mockNow,
      sleep: async (ms: number) => {
        mockNow += ms;
        await Promise.resolve(); // yield to microtask queue
      }
    };

    process.env.HERDR_ENV = "1";
    process.env.HERDR_JEV_READY_TIMEOUT_MS = "5000";

    // 1. Slow boot then delivery
    let readCount = 0;
    let promptCalls = 0;
    let client: HerdrClient = {
      splitCurrent: async () => commandResult(true, '{"result":{"pane":{"pane_id":"pane-42"}}}'),
      startAgent: async () => commandResult(true),
      closePane: async () => commandResult(true),
      getAgent: async () => commandResult(true, '{"result":{"agent":{"agent_status":"idle"}}}'),
      readPane: async () => {
        readCount++;
        if (promptCalls > 0) return commandResult(true, "some text\n>\nhello");
        if (readCount >= 3) return commandResult(true, "some text\n>\nmore text");
        return commandResult(true, "booting...");
      },
      readAgent: async () => {
        readCount++;
        if (promptCalls > 0) return commandResult(true, "some text\n>\nhello");
        if (readCount >= 3) return commandResult(true, "some text\n>\nmore text");
        return commandResult(true, "booting...");
      },
      prompt: async () => { promptCalls++; return commandResult(true); },
    };

    let res = await launchStageInHerdr({
      client: "antigravity", stage, layout: "split", herdr: client, handoffPrompt: "hello", clock: fakeClock
    } as any);
    if(!res.ok) console.log(res); expect(res.ok).toBe(true);
    expect(readCount).toBeGreaterThanOrEqual(3);
    expect(promptCalls).toBe(1);

    // 2. Timeout without sending
    readCount = 0;
    promptCalls = 0;
    client = {
      splitCurrent: async () => commandResult(true, '{"result":{"pane":{"pane_id":"pane-42"}}}'),
      startAgent: async () => commandResult(true),
      closePane: async () => commandResult(true),
      getAgent: async () => commandResult(true, '{"result":{"agent":{"agent_status":"idle"}}}'),
      readPane: async () => { readCount++; return commandResult(true, "never ready text"); },
      readAgent: async () => { readCount++; return commandResult(true, "never ready text"); },
      prompt: async () => { promptCalls++; return commandResult(true); },
    };

    res = await launchStageInHerdr({
      client: "antigravity", stage, layout: "split", herdr: client, handoffPrompt: "hello", clock: fakeClock
    } as any);
    expect(res.ok).toBe(false);
    expect(res.ackStatus).toBe("unknown");
    expect(res.error).toContain("timed out");
    expect(promptCalls).toBe(0);

    // 3. Stalled once then delivered on the single retry
    readCount = 0;
    promptCalls = 0;
    client = {
      splitCurrent: async () => commandResult(true, '{"result":{"pane":{"pane_id":"pane-42"}}}'),
      startAgent: async () => commandResult(true),
      closePane: async () => commandResult(true),
      getAgent: async () => commandResult(true, '{"result":{"agent":{"agent_status":"idle"}}}'),
      readPane: async () => {
        readCount++;
        if (promptCalls === 0) return commandResult(true, "\n>\n");
        if (promptCalls === 1) return commandResult(true, "\n>\n");
        return commandResult(true, "\n>\nhello");
      },
      readAgent: async () => {
        readCount++;
        if (promptCalls === 0) return commandResult(true, "\n>\n");
        if (promptCalls === 1) return commandResult(true, "\n>\n");
        return commandResult(true, "\n>\nhello");
      },
      prompt: async () => {
        promptCalls++;
        if (promptCalls === 1) return commandResult(false, "agent_prompt_stalled");
        return commandResult(true);
      },
    };

    res = await launchStageInHerdr({
      client: "antigravity", stage, layout: "split", herdr: client, handoffPrompt: "hello", clock: fakeClock
    } as any);
    expect(res.ok).toBe(true);
    expect(promptCalls).toBe(2);

    // 4. Text already visible means no retry
    readCount = 0;
    promptCalls = 0;
    client = {
      splitCurrent: async () => commandResult(true, '{"result":{"pane":{"pane_id":"pane-42"}}}'),
      startAgent: async () => commandResult(true),
      closePane: async () => commandResult(true),
      getAgent: async () => commandResult(true, '{"result":{"agent":{"agent_status":"idle"}}}'),
      readPane: async () => {
        readCount++;
        if (promptCalls === 0) return commandResult(true, "\n>\n");
        return commandResult(true, "\n>\nhello");
      },
      readAgent: async () => {
        readCount++;
        if (promptCalls === 0) return commandResult(true, "\n>\n");
        return commandResult(true, "\n>\nhello");
      },
      prompt: async () => {
        promptCalls++;
        return commandResult(false, "agent_prompt_stalled");
      },
    };

    res = await launchStageInHerdr({
      client: "antigravity", stage, layout: "split", herdr: client, handoffPrompt: "hello", clock: fakeClock
    } as any);
    expect(res.ok).toBe(false);
    expect(promptCalls).toBe(1);
  });

  it("detects agy trust dialog and returns blocked", async () => {
    const fakeClock = { now: () => 1000000, sleep: async () => {} };
    const client = {
      splitCurrent: async () => commandResult(true, '{"result":{"pane":{"pane_id":"pane-42"}}}'),
      startAgent: async () => commandResult(true),
      closePane: async () => commandResult(true),
      getAgent: async () => commandResult(true, '{"result":{"agent":{"agent_status":"idle"}}}'),
      readPane: async () => commandResult(true, "Do you trust this folder? Yes, I trust this folder / No, exit"),
      readAgent: async () => commandResult(true, "Do you trust this folder? Yes, I trust this folder / No, exit"),
      prompt: async () => commandResult(true),
    };
    const res = await launchStageInHerdr({ client: "antigravity", stage, layout: "split", herdr: client, handoffPrompt: "hello", clock: fakeClock } as any);
    expect(res.ok).toBe(false);
    expect(res.ackStatus).toBe("blocked");
    expect(res.trustRequired).toBe(true);
    expect(res.promptPending).toBe(true);
    expect(res.hint).toContain("confirm trust in the pane, then send the task with peer-message");
  });

  it("detects Claude Code trust dialog and returns blocked", async () => {
    const fakeClock = { now: () => 1000000, sleep: async () => {} };
    const client = {
      splitCurrent: async () => commandResult(true, '{"result":{"pane":{"pane_id":"pane-42"}}}'),
      startAgent: async () => commandResult(true),
      closePane: async () => commandResult(true),
      getAgent: async () => commandResult(true, '{"result":{"agent":{"agent_status":"idle"}}}'),
      readPane: async () => commandResult(true, "1) Trust and continue\n2) Exit"),
      readAgent: async () => commandResult(true, "1) Trust and continue\n2) Exit"),
      prompt: async () => commandResult(true),
    };
    const res = await launchStageInHerdr({ client: "claude", stage, layout: "split", herdr: client, handoffPrompt: "hello", clock: fakeClock } as any);
    expect(res.ok).toBe(false);
    expect(res.ackStatus).toBe("blocked");
    expect(res.trustRequired).toBe(true);
  });

  it("detects Codex trust dialog and returns blocked", async () => {
    const fakeClock = { now: () => 1000000, sleep: async () => {} };
    const client = {
      splitCurrent: async () => commandResult(true, '{"result":{"pane":{"pane_id":"pane-42"}}}'),
      startAgent: async () => commandResult(true),
      closePane: async () => commandResult(true),
      getAgent: async () => commandResult(true, '{"result":{"agent":{"agent_status":"idle"}}}'),
      readPane: async () => commandResult(true, "Yes, I trust this folder\nEnter to confirm"),
      readAgent: async () => commandResult(true, "Yes, I trust this folder\nEnter to confirm"),
      prompt: async () => commandResult(true),
    };
    const res = await launchStageInHerdr({ client: "codex", stage, layout: "split", herdr: client, handoffPrompt: "hello", clock: fakeClock } as any);
    expect(res.ok).toBe(false);
    expect(res.ackStatus).toBe("blocked");
    expect(res.trustRequired).toBe(true);
  });

  it("polls for the trust dialog on every tick and returns immediately on appearance", async () => {
    let tickCount = 0;
    const fakeClock = { 
      now: () => 1000000 + tickCount * 500, 
      sleep: async () => { tickCount++; } 
    };
    
    let readAgentCount = 0;
    const client = {
      splitCurrent: async () => commandResult(true, '{"result":{"pane":{"pane_id":"pane-42"}}}'),
      startAgent: async () => commandResult(true),
      closePane: async () => commandResult(true),
      getAgent: async () => commandResult(true, '{"result":{"agent":{"agent_status":"starting"}}}'),
      readAgent: async () => {
        readAgentCount++;
        if (readAgentCount === 3) {
          return commandResult(true, "Do you trust the contents\nof this project?\n\n> Yes, I trust this\nfolder");
        }
        return commandResult(true, "Loading...");
      },
      prompt: async () => commandResult(true),
    };
    const res = await launchStageInHerdr({ client: "antigravity", stage, layout: "split", herdr: client, handoffPrompt: "hello", clock: fakeClock } as any);
    expect(res.ok).toBe(false);
    expect(res.ackStatus).toBe("blocked");
    expect(res.trustRequired).toBe(true);
    // It should exit exactly on the 3rd readAgent call.
    expect(readAgentCount).toBe(3);
    // Which means it slept exactly 2 times (initial check + tick 1 + tick 2). Wait: 
    // initial check (1) -> loop start -> getAgent/readAgent (2) -> sleep -> loop start -> getAgent/readAgent (3) -> detected!
    expect(tickCount).toBe(1);
  });

  it("detects 27-column agy trust dialog from fixture and returns trustRequired", async () => {
    const fixturePath = require("path").join(process.cwd(), "tests/fixtures/agy-trust-dialog-27cols.txt");
    const stdout = require("fs").readFileSync(fixturePath, "utf-8");
    const fakeClock = { now: () => 1000000, sleep: async () => {} };
    const client = {
      splitCurrent: async () => commandResult(true, '{"result":{"pane":{"pane_id":"pane-42"}}}'),
      startAgent: async () => commandResult(true),
      closePane: async () => commandResult(true),
      getAgent: async () => commandResult(true, '{"result":{"agent":{"agent_status":"idle"}}}'),
      readPane: async () => commandResult(true, stdout),
      readAgent: async () => commandResult(true, stdout),
      prompt: async () => commandResult(true),
    };
    const res = await launchStageInHerdr({ client: "antigravity", stage, layout: "split", herdr: client, handoffPrompt: "hello", clock: fakeClock } as any);
    expect(res.ok).toBe(false);
    expect(res.ackStatus).toBe("blocked");
    expect(res.trustRequired).toBe(true);
  });
});



