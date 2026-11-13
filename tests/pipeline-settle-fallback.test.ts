import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as launcher from "../src/herdr/launcher.js";
import * as clientModule from "../src/herdr/client.js";
import { resetHarnessCaches } from "../src/harness/bridge.js";
import { resolveStateDir } from "../src/herdr/state-dir.js";
import type { TriageDecision } from "../src/types/index.js";
import { createTestStateDir } from "./helpers.js";
import { createFakeHarness, type FakeHarness } from "./fake-harness.js";

const originalLauncher = { ...launcher };
const originalClient = { ...clientModule };
let waitOutput = '{"state":"done"}';
let waitOk = true;
let finalReply = "final worker reply";
let runPipeline: typeof import("../src/orchestration/pipeline.js").runPipeline;
const { planExecution } = await import("../src/pipelines/planner.js");

beforeAll(async () => {
  mock.module("../src/herdr/launcher.js", () => ({
    ...originalLauncher,
    launchStageInHerdr: async () => ({ ok: true, paneId: "pane-1", ackStatus: "accepted", commandText: "" }),
  }));
  mock.module("../src/herdr/client.js", () => ({
    ...originalClient,
    createHerdrClient: () => ({
      waitFor: async () => ({ ok: waitOk, stdout: waitOutput, stderr: "", code: waitOk ? 0 : 1 }),
      readAgent: async () => ({ ok: true, stdout: finalReply, stderr: "", code: 0 }),
      notify: async () => ({ ok: true, stdout: "", stderr: "", code: 0 }),
    }),
  }));
  ({ runPipeline } = await import("../src/orchestration/pipeline.js"));
});

afterAll(() => {
  mock.module("../src/herdr/launcher.js", () => originalLauncher);
  mock.module("../src/herdr/client.js", () => originalClient);
});

const triage: TriageDecision = { complexity: "moderate", confidence: 1, needsResearch: false, effort: "high", recommendedPipeline: "triad", latencyMs: 0, rawAnswers: {} };

describe("delegated run without implementer handoff", () => {
  let harness: FakeHarness;
  let state: ReturnType<typeof createTestStateDir>;
  const savedEnv = process.env.HERDR_ENV;

  const run = (timeoutMs = 5000) => {
    harness = createFakeHarness("contract", {
      FAKE_PROFILE: "routed",
      FAKE_CLAIM_DEADLINE_MS: String(timeoutMs),
      FAKE_PIPELINE_STAGES: JSON.stringify([{ id: "implementer", role: "implementer", client: "claude", model: "claude-sonnet-5" }]),
    });
    const plan = planExecution("task", "claude", triage, { forceTriad: true, requestDelegation: true,
      delegation: { model: "opus-5", availableModels: ["claude-sonnet-5", "opus-5"] } });
    return runPipeline(plan, { delegation: { model: "opus-5", availableModels: [] }, timeoutMs, cwd: process.cwd(), wait: true });
  };

  const settles = () => harness.callsFor("external-run")
    .filter((argv) => argv[argv.indexOf("--action") + 1] === "settle")
    .map((argv) => JSON.parse(argv[argv.indexOf("--request-json") + 1]) as Record<string, unknown>);

  beforeEach(() => {
    state = createTestStateDir();
    process.env.HERDR_ENV = "1";
    waitOutput = '{"state":"done"}';
    waitOk = true;
    finalReply = "final worker reply";
    resetHarnessCaches();
  });

  afterEach(() => {
    harness?.restore();
    state.cleanup();
    if (savedEnv === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = savedEnv;
    resetHarnessCaches();
  });

  it("settles once using the worker final reply as handoff", async () => {
    await run();
    const calls = settles();
    expect(calls).toHaveLength(1);
    expect(calls[0].state).toBe("done");
    const handoff = calls[0].handoff as string;
    expect(existsSync(handoff)).toBe(true);
    expect(readFileSync(handoff, "utf8")).toContain("final worker reply");
  });

  it("settles once as unknown when the worker wait fails", async () => {
    waitOk = false;
    waitOutput = "";
    await run();
    const calls = settles();
    expect(calls).toHaveLength(1);
    expect(calls[0].state).toBe("unknown");
  });

  it("settles once as unknown when the deadline passes while the worker is still working", async () => {
    waitOutput = "{\"state\":\"working\"}";
    await run(1000);
    const calls = settles();
    expect(calls).toHaveLength(1);
    expect(calls[0].state).toBe("unknown");
  });
});
