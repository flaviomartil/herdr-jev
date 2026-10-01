import { describe, expect, it, afterEach } from "bun:test";
import { launchStageInHerdr, type StageSpec } from "../src/herdr/launcher.js";
import type { HerdrCommandResult, HerdrClient } from "../src/herdr/client.js";

const stage: StageSpec = { role: "implementer", model: "fake-model", effort: "high", extraFlags: [], description: "" };

function commandResult(ok: boolean, stdout = "", stderr = ""): HerdrCommandResult {
  return { ok, code: ok ? 0 : 1, stdout, stderr };
}

describe("launcher prompt readiness and retry", () => {
  let originalSetTimeout = global.setTimeout;
  let originalDateNow = Date.now;

  afterEach(() => {
    global.setTimeout = originalSetTimeout;
    Date.now = originalDateNow;
  });

  it("waits for readiness, times out if text never appears, retries once on agent_prompt_stalled", async () => {
    let mockNow = 1000000;
    Date.now = () => mockNow;
    global.setTimeout = ((cb: Function, ms: number) => {
      mockNow += ms;
      queueMicrotask(() => cb());
    }) as any;

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
      readAgent: async () => {
        readCount++;
        if (promptCalls > 0) return commandResult(true, "some text\n>\nhello");
        if (readCount >= 3) return commandResult(true, "some text\n>\nmore text");
        return commandResult(true, "booting...");
      },
      prompt: async () => { promptCalls++; return commandResult(true); },
    };

    let res = await launchStageInHerdr({
      client: "antigravity", stage, layout: "split", herdr: client, handoffPrompt: "hello",
    });
    expect(res.ok).toBe(true);
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
      readAgent: async () => { readCount++; return commandResult(true, "never ready text"); },
      prompt: async () => { promptCalls++; return commandResult(true); },
    };

    res = await launchStageInHerdr({
      client: "antigravity", stage, layout: "split", herdr: client, handoffPrompt: "hello",
    });
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
      client: "antigravity", stage, layout: "split", herdr: client, handoffPrompt: "hello",
    });
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
      client: "antigravity", stage, layout: "split", herdr: client, handoffPrompt: "hello",
    });
    expect(res.ok).toBe(false);
    expect(promptCalls).toBe(1);
  });
});
