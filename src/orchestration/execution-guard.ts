import type { TaskComplexity, ReasoningEffort, RoleKind } from "../types/index.js";
import { resolveHarnessDelegation, type DelegationInput } from "../harness/bridge.js";

export type ModelTier = "fast" | "standard" | "deep" | "frontier";

export interface TierMapping {
  tier: ModelTier;
  recommendedModel: string;
  reasoningEffort: ReasoningEffort;
  description: string;
}

export const MODEL_TIERS: Record<ModelTier, TierMapping> = {
  fast: {
    tier: "fast",
    recommendedModel: "haiku",
    reasoningEffort: "standard",
    description: "Mechanical, bounded, single-file or fully specified edits without ambiguous constraints.",
  },
  standard: {
    tier: "standard",
    recommendedModel: "sonnet",
    reasoningEffort: "standard",
    description: "Standard implementation, localized component edits, unit tests, well-defined contracts.",
  },
  deep: {
    tier: "deep",
    recommendedModel: "opus",
    reasoningEffort: "high",
    description: "Complex multi-system refactors, interacting constraints, non-trivial debugging, security flows.",
  },
  frontier: {
    tier: "frontier",
    recommendedModel: "fable",
    reasoningEffort: "xhigh",
    description: "Foundational architectural uncertainty, novel protocols, cross-system consensus.",
  },
};

export interface ExecutionGuardDecision {
  allowed: boolean;
  requiresDelegation: boolean;
  recommendedTier: ModelTier;
  suggestedRole: RoleKind;
  reason: string;
}

/**
 * Checks whether the current agent is permitted to write/edit code directly,
 * or whether the Execution Guard forces delegation to an autonomous subagent.
 * Inspired by jev-gate V5 Judged Workflow.
 */
export function checkExecutionGuard(params: {
  complexity: TaskComplexity;
  agentRole: "coordinator" | "subagent" | "standalone";
  isCodeMutation: boolean;
  client?: string;
  delegation?: DelegationInput;
}): ExecutionGuardDecision {
  const { complexity, agentRole, isCodeMutation } = params;

  // Subagents and standalone workers can implement directly
  if (agentRole === "subagent" || agentRole === "standalone") {
    const tier: ModelTier =
      complexity === "architectural"
        ? "deep"
        : complexity === "moderate"
        ? "standard"
        : "fast";

    return {
      allowed: true,
      requiresDelegation: false,
      recommendedTier: tier,
      suggestedRole: "implementer",
      reason: "Subagent or standalone worker authorized to implement within its assigned boundary.",
    };
  }

  // Coordinator role:
  // If task is complex/moderate and involves code mutation, Execution Guard blocks direct edits
  // to prevent context pollution and force structured delegation.
  if (isCodeMutation && (complexity === "architectural" || complexity === "moderate")) {
    const tier: ModelTier = complexity === "architectural" ? "deep" : "standard";
    const role: RoleKind = complexity === "architectural" ? "advisor" : "implementer";
    const decision = resolveHarnessDelegation(params.client ?? "codex", true, params.delegation);

    return {
      allowed: true,
      requiresDelegation: decision.mode === "delegate",
      recommendedTier: tier,
      suggestedRole: role,
      reason: `Complexity is advisory. Delegate only with an exact available AI Harness profile; direct execution remains allowed. ${decision.mode === "direct" ? decision.reason : decision.profile.id}`,
    };
  }

  // Routine/trivial tasks can be executed directly by the coordinator
  return {
    allowed: true,
    requiresDelegation: false,
    recommendedTier: "fast",
    suggestedRole: "implementer",
    reason: "Routine or read-only action; direct execution allowed.",
  };
}

export interface ContractCheckResult {
  acceptedByCode: boolean;
  advisoryVerdict: "satisfies" | "deviates" | "incomplete";
  contractChecks: Array<{ check: string; passed: boolean }>;
  notes: string;
}

/**
 * Validates deliverables against required checks and contracts.
 * Doctrine: "Code owns acceptance" — tests, linters, and compilers are authoritative.
 * Jev provides advisory sanity check.
 */
export function verifyContractAdvisory(params: {
  contractSpec: string;
  testPassed: boolean;
  deliverableSummary: string;
  linterClean?: boolean;
}): ContractCheckResult {
  const { contractSpec, testPassed, deliverableSummary, linterClean = true } = params;

  const checks = [
    { check: "Deterministic tests passing", passed: testPassed },
    { check: "Linters and typechecks passing", passed: linterClean },
    { check: "Deliverable non-empty", passed: deliverableSummary.trim().length > 0 },
  ];

  const allPassed = checks.every((c) => c.passed);

  let advisoryVerdict: ContractCheckResult["advisoryVerdict"] = "satisfies";
  if (!allPassed) {
    advisoryVerdict = "incomplete";
  } else if (contractSpec.toLowerCase().includes("strict") && !deliverableSummary.includes("spec")) {
    advisoryVerdict = "deviates";
  }

  return {
    acceptedByCode: allPassed,
    advisoryVerdict,
    contractChecks: checks,
    notes: allPassed
      ? "Code ownership satisfied: tests and linters passed. Contract accepted."
      : "Code ownership rejection: deterministic tests or linter checks failed.",
  };
}

export interface SignalSufficiencyResult {
  isSelfSufficient: boolean;
  score: number;
  recommendation: "jev_system_one" | "llm_retrieval_first" | "human_escalation";
  rationale: string;
}

/**
 * Validates if the prompt/state obeys the "Law of Signal Self-Sufficiency"
 * (Zaious/jev-capability-atlas):
 * Jev excels when all facts needed for the judgment are inside the state text.
 * If external knowledge or subjective creation is needed, an LLM or retrieval must run first.
 */
export function checkSignalSufficiency(stateText: string, questionText: string): SignalSufficiencyResult {
  const lowerState = stateText.toLowerCase();
  const lowerQ = questionText.toLowerCase();

  const stateLength = stateText.trim().length;
  const asksForCreation =
    lowerQ.includes("escreva") ||
    lowerQ.includes("gere") ||
    lowerQ.includes("crie um texto") ||
    lowerQ.includes("implemente");

  const asksForExternalFacts =
    lowerQ.includes("quem foi") ||
    lowerQ.includes("quando ocorreu") ||
    lowerQ.includes("história") ||
    lowerQ.includes("qual a capital");

  if (asksForCreation) {
    return {
      isSelfSufficient: false,
      score: 0.1,
      recommendation: "llm_retrieval_first",
      rationale: "Task asks for generative text or code creation, which Jev does not do. Route to LLM.",
    };
  }

  if (stateLength < 30 && asksForExternalFacts) {
    return {
      isSelfSufficient: false,
      score: 0.2,
      recommendation: "llm_retrieval_first",
      rationale: "State is brief and question requires external world knowledge not contained in state. Retrieve first.",
    };
  }

  // If state contains error logs, XML, diffs, or explicit text to classify
  const hasSignals =
    lowerState.includes("error") ||
    lowerState.includes("exception") ||
    lowerState.includes("code") ||
    lowerState.includes("diff") ||
    lowerState.includes("status") ||
    stateLength > 100;

  if (hasSignals) {
    return {
      isSelfSufficient: true,
      score: 0.92,
      recommendation: "jev_system_one",
      rationale: "State is self-sufficient with rich context/signals for probabilistic typed judgment.",
    };
  }

  return {
    isSelfSufficient: true,
    score: 0.7,
    recommendation: "jev_system_one",
    rationale: "Moderate signal presence in state; suitable for Jev System One evaluation.",
  };
}
