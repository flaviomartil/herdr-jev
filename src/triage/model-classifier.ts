import { resolveTypeSafeApiKey } from "./client.js";
import type { RoleKind, ReasoningEffort } from "../types/index.js";

const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

export interface ModelClassificationResult {
  modelName: string;
  client: string;
  role: RoleKind;
  tier: "frontier" | "workhorse" | "lightweight";
  effort: ReasoningEffort;
  replacePrimary: boolean;
  confidence: number;
  rationale: string;
  latencyMs: number;
}

export async function classifyModelWithJev(
  client: string,
  modelName: string,
  apiKey?: string | null,
): Promise<ModelClassificationResult> {
  const resolvedKey = apiKey ?? resolveTypeSafeApiKey();
  const startTime = Date.now();

  if (!resolvedKey) {
    return createDeterministicModelFallback(client, modelName, Date.now() - startTime);
  }

  const payload = {
    state: `You are the model evaluator for an AI development harness. A new LLM model named "${modelName}" has been detected for the client "${client}". Evaluate its naming conventions, architecture tier, and provider patterns to determine its optimal role in an autonomous software development pipeline.`,
    model: "jev-latest",
    questions: {
      optimal_role: {
        type: "choice",
        instructions: "What is the optimal role for this model in a multi-model software development harness?",
        criteria: {
          advisor: "High-level architectural reasoning, strategic design, planning, and task breakdown.",
          implementer: "Core code generation, feature development, heavy refactoring, and test writing.",
          reviewer: "Independent code critique, bug finding, invariant checking, and contract verification.",
          researcher: "Rapid codebase exploration, symbol search, documentation retrieval, and summarization.",
        },
      },
      tier: {
        type: "choice",
        instructions: "What capability tier does this model belong to based on provider naming conventions?",
        criteria: {
          frontier: "Flagship top-tier reasoning model (e.g. Opus, Sol, o1/o3, Astra, Ultra).",
          workhorse: "High-speed high-accuracy balanced model (e.g. Sonnet, Luna, Flash High, Pro).",
          lightweight: "Ultra-fast low-cost model for quick queries (e.g. Flash Lite, Haiku, Mini, Nano).",
        },
      },
      recommended_effort: {
        type: "choice",
        instructions: "What reasoning effort level should be default for this model?",
        criteria: {
          standard: "Standard baseline inference with low reasoning overhead.",
          high: "High reasoning effort for complex validation and debugging.",
          xhigh: "Maximum reasoning effort for critical invariants and architectural design.",
        },
      },
      replace_primary: {
        type: "noul",
        instructions: "Does this model appear to be a newer flagship generation that should become the new primary default in its role, pushing older models down the fallback chain?",
      },
    },
  };

  try {
    const response = await fetch(TYPESAFE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resolvedKey}`,
      },
      body: JSON.stringify(payload),
    });

    const latencyMs = Date.now() - startTime;
    if (!response.ok) {
      return createDeterministicModelFallback(client, modelName, latencyMs);
    }

    const data = (await response.json()) as {
      answers?: {
        optimal_role?: { choice?: string; confidence?: number };
        tier?: { choice?: string; confidence?: number };
        recommended_effort?: { choice?: string; confidence?: number };
        replace_primary?: { noul?: number };
      };
    };

    const answers = data?.answers;
    if (!answers) {
      return createDeterministicModelFallback(client, modelName, latencyMs);
    }

    const role = (answers.optimal_role?.choice ?? "implementer") as RoleKind;
    const tier = (answers.tier?.choice ?? "workhorse") as "frontier" | "workhorse" | "lightweight";
    const effort = (answers.recommended_effort?.choice ?? "high") as ReasoningEffort;
    const replacePrimary = (answers.replace_primary?.noul ?? 0) > 0.5;
    const confidence = answers.optimal_role?.confidence ?? 0.85;

    return {
      modelName,
      client,
      role,
      tier,
      effort,
      replacePrimary,
      confidence,
      rationale: `TypeSafe Jev identified ${modelName} as ${tier} ${role} (effort: ${effort}, promote to primary: ${replacePrimary})`,
      latencyMs,
    };
  } catch {
    return createDeterministicModelFallback(client, modelName, Date.now() - startTime);
  }
}

function createDeterministicModelFallback(
  client: string,
  modelName: string,
  latencyMs: number,
): ModelClassificationResult {
  const lower = modelName.toLowerCase();
  const isAdvisor = lower.includes("fable") || lower.includes("astra") || lower.includes("think") || lower.includes("plan");
  const isReviewer = lower.includes("opus") || lower.includes("sol") || lower.includes("audit") || lower.includes("critic");
  const isResearcher = lower.includes("lite") || lower.includes("mini") || lower.includes("nano") || lower.includes("haiku");

  const role: RoleKind = isAdvisor
    ? "advisor"
    : isReviewer
      ? "reviewer"
      : isResearcher
        ? "researcher"
        : "implementer";

  const tier = lower.includes("opus") || lower.includes("sol") || lower.includes("ultra") || lower.includes("max")
    ? "frontier"
    : isResearcher
      ? "lightweight"
      : "workhorse";

  const effort: ReasoningEffort = tier === "frontier" ? "xhigh" : tier === "workhorse" ? "high" : "standard";

  return {
    modelName,
    client,
    role,
    tier,
    effort,
    replacePrimary: lower.includes("v2") || lower.includes("new") || lower.includes("6") || lower.includes("latest"),
    confidence: 0.6,
    rationale: `Deterministic heuristic classified ${modelName} as ${tier} ${role}`,
    latencyMs,
  };
}
