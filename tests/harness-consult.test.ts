import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { resetHarnessCaches, resolveHarnessDelegation } from "../src/harness/bridge.js";
import { runPipeline } from "../src/orchestration/pipeline.js";
import { planExecution } from "../src/pipelines/planner.js";
import type { TriageDecision } from "../src/types/index.js";
import { createFakeHarness, type FakeHarness } from "./fake-harness.js";

const profile = { id: "claude-opus-5", client: "claude", advisor: "opus-5", route: "architectural",
  executor: { client: "claude", model: "claude-sonnet-5", cliModel: "claude-sonnet-5-5", effort: "high" },
  reviewer: { client: "claude", model: "opus-5", cliModel: "claude-opus-5-5", effort: "xhigh" } };
const consult = { client: "claude", model: "fable-5", cliModel: "claude-fable-5-1", effort: "high" };
const architectural: TriageDecision = { complexity: "architectural", confidence: 1, needsResearch: false, effort: "high", recommendedPipeline: "triad", latencyMs: 0, rawAnswers: {} };
const delegation = { model: "claude-opus-5-5", availableModels: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"] };

let harness: FakeHarness | undefined;
const savedEnv = process.env.HERDR_ENV;

function install(decision: unknown) {
  harness = createFakeHarness("contract", { FAKE_DELEGATION_RAW: JSON.stringify(decision) });
}

beforeEach(() => {
  delete process.env.HERDR_ENV;
  resetHarnessCaches();
});

afterEach(() => {
  harness?.restore();
  harness = undefined;
  if (savedEnv === undefined) delete process.env.HERDR_ENV;
  else process.env.HERDR_ENV = savedEnv;
});

describe("consult stage from the delegation plan", () => {
  it("keeps a valid consult stage and forwards the complexity", () => {
    install({ mode: "delegate", profile, consult });
    const decision = resolveHarnessDelegation("claude", true, { ...delegation, complexity: "architectural" });
    expect(decision).toEqual({ mode: "delegate", profile, consult });
    const call = harness!.callsFor("delegation-plan").at(-1)!;
    expect(call[call.indexOf("--complexity") + 1]).toBe("architectural");
  });

  it("drops a malformed consult stage without losing the delegation", () => {
    for (const bad of [{ model: "" }, { model: "fable-5", effort: "max" }, "fable-5", { model: "fable-5", cliModel: 5 }]) {
      install({ mode: "delegate", profile, consult: bad });
      const decision = resolveHarnessDelegation("claude", true, delegation);
      expect(decision).toEqual({ mode: "delegate", profile });
      harness!.restore();
      harness = undefined;
    }
  });

  it("plans a read-only advisor consult stage before the implementer only when the harness returns one", () => {
    install({ mode: "delegate", profile, consult });
    const plan = planExecution("design the cache layer", "claude", architectural, { requestDelegation: true, delegation });
    expect(plan.consultStage).toEqual({ role: "advisor", client: "claude", model: "fable-5", cliModel: "claude-fable-5-1", effort: "high",
      extraFlags: [], description: "AI Harness consult: read-only recommendation before the implementer; the advisor decides" });
    expect(plan.executionStages?.map((stage) => stage.role)).toEqual(["implementer", "reviewer"]);
    harness!.restore();

    install({ mode: "delegate", profile });
    const without = planExecution("design the cache layer", "claude", architectural, { requestDelegation: true, delegation });
    expect(without).not.toHaveProperty("consultStage");
    expect(without.executionStages).toHaveLength(2);
  });

  it("previews the consult stage beside the execution stages", async () => {
    install({ mode: "delegate", profile, consult });
    const plan = planExecution("design the cache layer", "claude", architectural, { requestDelegation: true, delegation });
    const preview = await runPipeline(plan, { delegation, timeoutMs: 60_000 }) as Record<string, unknown>;
    expect(preview.mode).toBe("preview");
    expect(preview.consult).toMatchObject({ role: "advisor", model: "fable-5" });
    harness!.restore();

    install({ mode: "delegate", profile });
    const plain = await runPipeline(planExecution("design the cache layer", "claude", architectural, { requestDelegation: true, delegation }), { delegation, timeoutMs: 60_000 });
    expect(plain).not.toHaveProperty("consult");
  });

  it("delegation-plan prints the decision with its consult stage without triage", () => {
    install({ mode: "delegate", profile, consult });
    const run = spawnSync(process.execPath, [join(import.meta.dir, "..", "src", "cli.ts"), "delegation-plan", "--client", "claude", "--model", delegation.model,
      "--available-models", delegation.availableModels.join(","), "--complexity", "architectural", "--json"], { encoding: "utf8", env: process.env, timeout: 60_000 });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ mode: "delegate", profile, consult });
    const call = harness!.callsFor("delegation-plan").at(-1)!;
    expect(call.slice(0, 7)).toEqual(["delegation-plan", "--client", "claude", "--work", "substantive", "--role", "advisor"]);
    expect(call[call.indexOf("--available-models") + 1]).toBe(delegation.availableModels.join(","));
  });
});
