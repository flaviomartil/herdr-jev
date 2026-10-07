import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import * as launcher from "../src/herdr/launcher.js";
import { parseCrossHarnessConfig } from "../src/delegation/cross-harness.js";
import { resetHarnessCaches } from "../src/harness/bridge.js";
import { resolveStateDir } from "../src/herdr/state-dir.js";
import type { PipelinePlan, TriageDecision } from "../src/types/index.js";
import { createTempHome, createTestStateDir } from "./helpers.js";
import { createFakeHarness, type FakeHarness } from "./fake-harness.js";

const original = { ...launcher };
const launches: Array<{ client: string; stageClient?: string; model: string }> = [];
let runPipeline: typeof import("../src/orchestration/pipeline.js").runPipeline;
let resumePipeline: typeof import("../src/orchestration/pipeline.js").resumePipeline;
const { planExecution } = await import("../src/pipelines/planner.js");

beforeAll(async () => {
  mock.module("../src/herdr/launcher.js", () => ({
    ...original,
    launchStageInHerdr: async (input: { client: string; stage: { client?: string; model: string } }) => {
      launches.push({ client: input.client, stageClient: input.stage.client, model: input.stage.model });
      return { ok: false, ackStatus: "rejected", error: "stopped", commandText: "" };
    },
  }));
  ({ runPipeline, resumePipeline } = await import("../src/orchestration/pipeline.js"));
});

afterAll(() => { mock.module("../src/herdr/launcher.js", () => original); });

const triage: TriageDecision = { complexity: "moderate", confidence: 1, needsResearch: false, effort: "high", recommendedPipeline: "triad", latencyMs: 0, rawAnswers: {} };

describe("launch path stage client", () => {
  let harness: FakeHarness;
  let state: ReturnType<typeof createTestStateDir>;
  const saved = { env: process.env.HERDR_ENV, cross: process.env.HERDR_JEV_CROSS_HARNESS };

  const run = (stages: unknown[], cross?: string, wait?: boolean) => {
    harness = createFakeHarness("contract", { FAKE_PROFILE: "routed", FAKE_PIPELINE_STAGES: JSON.stringify(stages) });
    const plan: PipelinePlan = planExecution("task", "claude", triage, { forceTriad: true, requestDelegation: true,
      ...(cross ? { crossHarness: parseCrossHarnessConfig(cross) } : {}), delegation: { model: "opus-5", availableModels: ["claude-sonnet-5", "opus-5"] } });
    return runPipeline(plan, { delegation: { model: "opus-5", availableModels: [] }, timeoutMs: 5000, cwd: process.cwd(), ...(wait ? { wait } : {}),
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

  it("does not dispatch a pending prompt to a peer pane that is no longer authorised", async () => {
    const result: any = await run([{ id: "implementer", role: "implementer", client: "codex", model: "gpt-5.6-luna", effort: "xhigh",
      state: "working", promptPending: true, agent: "agent-implementer", pane: "w1:1" }]);
    expect(launches).toEqual([]);
    expect(result.error).toBe("peer_unavailable");
    expect(result.run.stages[0].state).toBe("working");
    const actions = harness.callsFor("external-run").map((call) => call[call.indexOf("--action") + 1]);
    expect(actions).not.toContain("prompt-claim");
    expect(actions).not.toContain("settle");
  });

  it("does not observe a blocked peer stage whose client is no longer authorised", async () => {
    const result: any = await run([{ id: "implementer", role: "implementer", client: "codex", model: "gpt-5.6-luna", effort: "xhigh",
      state: "blocked", promptPending: true, agent: "agent-implementer", pane: "w1:1", token: "old-token" }], undefined, true);
    expect(launches).toEqual([]);
    expect(result.error).toBe("peer_unavailable");
    expect(result.run.stages[0]).toMatchObject({ state: "blocked", token: "old-token" });
    const actions = harness.callsFor("external-run").map((call) => call[call.indexOf("--action") + 1]);
    expect(actions).not.toContain("observe");
    expect(actions).not.toContain("settle");
  });

  describe("resume with --cross-harness", () => {
    const task = "resume task";
    const id = "00000000-0000-4000-8000-0000000000aa";
    const resume = (cross?: string) => {
      harness = createFakeHarness("contract", {
        FAKE_PIPELINE_STAGES: JSON.stringify([{ id: "implementer", role: "implementer", client: "codex", model: "gpt-5.6-luna", effort: "xhigh" }]),
        FAKE_PIPELINE_CLIENT: "claude", FAKE_PIPELINE_CWD: process.cwd(), FAKE_PIPELINE_DIGEST: createHash("sha256").update(task).digest("hex"),
      });
      mkdirSync(join(resolveStateDir(), id), { recursive: true });
      writeFileSync(join(resolveStateDir(), id, "objective.md"), task);
      return resumePipeline(id, { delegation: {}, wait: true, timeoutMs: 5000, cwd: process.cwd(), ...(cross ? { crossHarness: parseCrossHarnessConfig(cross) } : {}) });
    };

    it("launches the queued peer stage when the run's cross-harness setting allows it", async () => {
      await resume("claude:codex");
      expect(launches).toEqual([{ client: "codex", stageClient: "codex", model: "gpt-5.6-luna" }]);
    });

    it("returns peer_unavailable without launching when cross-harness is disabled", async () => {
      const result: any = await resume("disabled");
      expect(launches).toEqual([]);
      expect(result.error).toBe("peer_unavailable");
      expect(result.run.stages[0].state).toBe("queued");
    });
  });

  it("offers --cross-harness on run-resume and runs retry", () => {
    const cli = resolve(import.meta.dir, "../src/cli.ts");
    for (const args of [["run-resume", "--help"], ["runs", "retry", "--help"]]) {
      const help = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, HOME: createTempHome() }, timeout: 60_000 });
      expect(help.stdout).toContain("--cross-harness <mode>");
    }
  });
});
