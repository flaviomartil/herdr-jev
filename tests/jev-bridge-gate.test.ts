import { describe, it, expect } from "bun:test";
import { noul, choice, score, evaluateQuestions, evaluateConfidenceGate } from "../src/triage/evaluator.js";
import {
  checkExecutionGuard,
  verifyContractAdvisory,
  checkSignalSufficiency,
  MODEL_TIERS,
} from "../src/orchestration/execution-guard.js";

describe("Jevbridge & Jev-Gate Adaptations", () => {
  describe("Typed Question Evaluator (Jevbridge)", () => {
    it("creates typed questions correctly", () => {
      const qNoul = noul("Is this a migration?");
      expect(qNoul.type).toBe("noul");

      const qChoice = choice("Pick tier", { fast: "Fast tier", deep: "Deep tier" });
      expect(qChoice.type).toBe("choice");
      expect(Object.keys(qChoice.criteria)).toContain("fast");

      const qScore = score("Rate safety", ["low", "high"]);
      expect(qScore.type).toBe("score");
      expect(qScore.levels).toHaveLength(2);
    });

    it("evaluates questions with deterministic fallback when no live API key", async () => {
      const res = await evaluateQuestions(
        "User confirmed: ok, sim, permitir migration",
        {
          is_allowed: noul("Is migration allowed?"),
          tier: choice("Pick tier", { fast: "fast", deep: "deep" }),
        },
        null
      );

      expect(res.fallback).toBe(true);
      expect(res.answers.is_allowed.value).toBe(true);
      expect(res.answers.tier.type).toBe("choice");
    });
  });

  describe("Confidence Gate (Jevbridge)", () => {
    it("aborts unvalidated destructive actions", async () => {
      const gate = await evaluateConfidenceGate({
        state: "Production SQL Server for InvoiceCon",
        proposedAction: "DROP TABLE adonis_schema; rm -rf /var/data",
        apiKey: null,
      });

      // Destructive keywords trigger abort or confirm in fallback
      expect(["abort", "confirm"]).toContain(gate.verdict);
      expect(gate.riskScore).toBeGreaterThan(0.5);
    });

    it("approves routine read-only actions with execute or confirm", async () => {
      const gate = await evaluateConfidenceGate({
        state: "Repository workspace clean",
        proposedAction: "git status && git log -n 5",
        apiKey: null,
      });

      expect(["execute", "confirm"]).toContain(gate.verdict);
    });
  });

  describe("Execution Guard (Jev-Gate V5)", () => {
    it("keeps architectural complexity advisory without an exact delegation profile", () => {
      const decision = checkExecutionGuard({
        complexity: "architectural",
        agentRole: "coordinator",
        isCodeMutation: true,
      });

      expect(decision.allowed).toBe(true);
      expect(decision.requiresDelegation).toBe(false);
      expect(decision.recommendedTier).toBe("deep");
      expect(decision.suggestedRole).toBe("advisor");
      expect(decision.reason).toContain("exact available AI Harness profile");
    });

    it("permits direct implementation of moderate tasks when the current model is unknown", () => {
      const decision = checkExecutionGuard({
        complexity: "moderate",
        agentRole: "coordinator",
        isCodeMutation: true,
      });

      expect(decision.allowed).toBe(true);
      expect(decision.requiresDelegation).toBe(false);
      expect(decision.recommendedTier).toBe("standard");
      expect(decision.suggestedRole).toBe("implementer");
    });

    it("permits coordinator to run routine read/status tasks directly", () => {
      const decision = checkExecutionGuard({
        complexity: "routine",
        agentRole: "coordinator",
        isCodeMutation: false,
      });

      expect(decision.allowed).toBe(true);
      expect(decision.requiresDelegation).toBe(false);
      expect(decision.recommendedTier).toBe("fast");
    });

    it("permits subagents to mutate code within their assigned tier", () => {
      const decision = checkExecutionGuard({
        complexity: "moderate",
        agentRole: "subagent",
        isCodeMutation: true,
      });

      expect(decision.allowed).toBe(true);
      expect(decision.requiresDelegation).toBe(false);
      expect(decision.recommendedTier).toBe("standard");
    });
  });

  describe("Contract Verification ('Code owns acceptance')", () => {
    it("accepts deliverable when tests and linter pass", () => {
      const result = verifyContractAdvisory({
        contractSpec: "Implement and test user router",
        testPassed: true,
        linterClean: true,
        deliverableSummary: "src/router.ts and tests passing with 100% coverage",
      });

      expect(result.acceptedByCode).toBe(true);
      expect(result.advisoryVerdict).toBe("satisfies");
    });

    it("rejects deliverable when automated tests fail", () => {
      const result = verifyContractAdvisory({
        contractSpec: "Implement user router",
        testPassed: false,
        linterClean: true,
        deliverableSummary: "Added router code but 2 unit tests failed",
      });

      expect(result.acceptedByCode).toBe(false);
      expect(result.advisoryVerdict).toBe("incomplete");
    });
  });

  describe("Signal Self-Sufficiency Check (Jev-Capability-Atlas)", () => {
    it("recognizes self-sufficient error state for Jev System One", () => {
      const state = "Error: E23 SAP RFC call failed with status 500: PGTPA/INVOICECON_SRV metadata not loaded at line 42";
      const question = "Which tier should diagnose this error?";

      const res = checkSignalSufficiency(state, question);
      expect(res.isSelfSufficient).toBe(true);
      expect(res.recommendation).toBe("jev_system_one");
      expect(res.score).toBeGreaterThan(0.8);
    });

    it("flags open-ended text generation tasks for LLM routing", () => {
      const state = "Context is empty";
      const question = "Escreva uma redação sobre história do Brasil";

      const res = checkSignalSufficiency(state, question);
      expect(res.isSelfSufficient).toBe(false);
      expect(res.recommendation).toBe("llm_retrieval_first");
    });
  });

  describe("Model Tier Mapping", () => {
    it("defines 4 tiers with concrete models and reasoning effort", () => {
      expect(MODEL_TIERS.fast.recommendedModel).toBe("haiku");
      expect(MODEL_TIERS.standard.recommendedModel).toBe("sonnet");
      expect(MODEL_TIERS.deep.recommendedModel).toBe("opus");
      expect(MODEL_TIERS.frontier.recommendedModel).toBe("fable");
    });
  });
});
