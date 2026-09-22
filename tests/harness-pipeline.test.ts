import { expect, test } from "bun:test";
import { planExecution } from "../src/pipelines/planner.js";
import { runPipeline, reviewerCommand, projectRun } from "../src/orchestration/pipeline.js";
import type { TriageDecision } from "../src/types/index.js";

const triage: TriageDecision = { complexity: "architectural", confidence: 1, needsResearch: true,
  effort: "xhigh", recommendedPipeline: "triad", latencyMs: 0, rawAnswers: {} };

test("Jev recommendations cannot authorize automatic delegation with an unknown actual model", async () => {
  const plan = planExecution("Change architecture", "codex", triage, { forceTriad: true });
  expect(plan.stages).toHaveLength(3);
  expect(plan.executionStages).toEqual([]);
  expect(plan.delegation?.mode).toBe("direct");
  expect(await runPipeline(plan, { delegation: {}, timeoutMs: 1000 })).toMatchObject({ mode: "direct" });
});

test("independent reviewer commands preserve exact model and effort with read-only tools", () => {
  const stage = { role: "reviewer" as const, model: "gpt-5.6-sol", effort: "xhigh" as const,
    extraFlags: ["-c", 'model_reasoning_effort="xhigh"'], description: "review" };
  const argv = reviewerCommand("codex", stage, "Review task");
  expect(argv).toContain("gpt-5.6-sol");
  expect(argv).toContain('model_reasoning_effort="xhigh"');
  expect(argv.slice(-2)).toEqual(["--sandbox", "read-only"]);
  expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(() => reviewerCommand("opencode", stage, "review")).toThrow("adapter_unavailable");
  expect(() => projectRun("../escape")).toThrow("invalid_run_id");
});
