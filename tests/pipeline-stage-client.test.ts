import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as launcher from "../src/herdr/launcher.js";
import { parseCrossHarnessConfig } from "../src/delegation/cross-harness.js";
import { resetHarnessCaches } from "../src/harness/bridge.js";
import type { PipelinePlan, TriageDecision } from "../src/types/index.js";
import { createTestStateDir } from "./helpers.js";
import { createFakeHarness, type FakeHarness } from "./fake-harness.js";

const original = { ...launcher };
const launches: Array<{ client: string; stageClient?: string; model: string }> = [];
mock.module("../src/herdr/launcher.js", () => ({
  ...original,
  launchStageInHerdr: async (input: { client: string; stage: { client?: string; model: string } }) => {
    launches.push({ client: input.client, stageClient: input.stage.client, model: input.stage.model });
    return { ok: false, ackStatus: "rejected", error: "stopped", commandText: "" };
  },
}));
const { runPipeline } = await import("../src/orchestration/pipeline.js");
const { planExecution } = await import("../src/pipelines/planner.js");

afterAll(() => { mock.module("../src/herdr/launcher.js", () => original); });

const triage: TriageDecision = { complexity: "moderate", confidence: 1, needsResearch: false, effort: "high", recommendedPipeline: "triad", latencyMs: 0, rawAnswers: {} };

describe("launch path stage client", () => {
  let harness: FakeHarness;
  let state: ReturnType<typeof createTestStateDir>;
  const saved = { env: process.env.HERDR_ENV, cross: process.env.HERDR_JEV_CROSS_HARNESS };

  const run = (stages: unknown[], cross?: string) => {
    harness = createFakeHarness("contract", { FAKE_PROFILE: "routed", FAKE_PIPELINE_STAGES: JSON.stringify(stages) });
    const plan: PipelinePlan = planExecution("task", "claude", triage, { forceTriad: true, requestDelegation: true,
      ...(cross ? { crossHarness: parseCrossHarnessConfig(cross) } : {}), delegation: { model: "opus-5", availableModels: ["claude-sonnet-5", "opus-5"] } });
    return runPipeline(plan, { delegation: { model: "opus-5", availableModels: [] }, timeoutMs: 5000, cwd: process.cwd(),
      ...(cross ? { crossHarness: parseCrossHarnessConfig(cross) } : {}) });
  };

  beforeEach(() => {
    state = createTestStateDir();
    launches.length = 0;
    process.env.HERDR_ENV = "1";
    delete process.env.HERDR_JEV_CROSS_HARNESS;
    resetHarnessCaches();
  });

  afterEach(() => {
    harness?.restore();
    state.cleanup();
    for (const [key, value] of [["HERDR_ENV", saved.env], ["HERDR_JEV_CROSS_HARNESS", saved.cross]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    resetHarnessCaches();
  });

  it("launches the implementer with the stage's own client", async () => {
    await run([{ id: "implementer", role: "implementer", client: "codex", model: "gpt-5.6-luna", effort: "xhigh" }], "claude:codex");
    expect(launches).toEqual([{ client: "codex", stageClient: "codex", model: "gpt-5.6-luna" }]);
  });

  it("uses the run client for a stage without a client", async () => {
    await run([{ id: "implementer", role: "implementer", model: "claude-sonnet-5", effort: "high" }]);
    expect(launches).toEqual([{ client: "claude", stageClient: "claude", model: "claude-sonnet-5" }]);
  });

  it("refuses to launch a queued peer stage whose client is no longer authorised", async () => {
    const result: any = await run([{ id: "implementer", role: "implementer", client: "codex", model: "gpt-5.6-luna", effort: "xhigh" }]);
    expect(launches).toEqual([]);
    expect(result.error).toBe("peer_unavailable");
    expect(result.run.stages[0].state).toBe("queued");
  });
});
