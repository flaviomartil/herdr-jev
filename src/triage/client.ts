import { execSync } from "node:child_process";
import { choice, noul } from "@typesafe-ai/sdk";
import { ResilientJevClient, getGlobalJevClient } from "./jev-client.js";
import { scoreQuantile, probabilityMargin } from "./quantile.js";
import type { TaskComplexity, ReasoningEffort, TriageDecision } from "../types/index.js";

export function resolveTypeSafeApiKey(): string | null {
  if (process.env.TYPESAFE_API_KEY && process.env.TYPESAFE_API_KEY.trim().length > 0) {
    return process.env.TYPESAFE_API_KEY.trim();
  }

  try {
    const stdout = execSync("vault get AI-Providers/TypeSafe", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    const key = stdout.trim();
    if (key.length > 0 && !key.includes("Error") && !key.includes("vault:")) {
      return key;
    }
  } catch {
    // Vault lookup failed or vault is locked
  }

  return null;
}

export async function triageTaskWithJev(
  taskDescription: string,
  apiKey?: string | null,
): Promise<TriageDecision> {
  const resolvedKey = apiKey ?? resolveTypeSafeApiKey();
  const startTime = Date.now();

  if (!resolvedKey) {
    return createDeterministicFallback(taskDescription, "missing-api-key", Date.now() - startTime);
  }

  const client = apiKey ? new ResilientJevClient({ apiKey }) : getGlobalJevClient();

  const statePayload = `You are the triage gate for an AI development harness. Evaluate this coding task:\n\n"${taskDescription}"`;

  const questions = {
    complexity: choice(
      "What is the architectural and operational complexity level of this software engineering task?",
      {
        trivial: "Single-line edits, doc fixes, typos, single config value bump, quick git status or log query.",
        routine: "Standard bugfix, adding a simple endpoint, writing unit tests for existing code, localized component tweak.",
        moderate: "Multi-file refactoring, integrating a new external API or SDK, database migrations, debugging non-trivial errors.",
        architectural: "Cross-system integrations, multi-tenant designs, complete service orchestration, distributed consensus, protocol migrations.",
      },
    ),
    needs_research: noul(
      "Does this task require deep codebase exploration, external documentation lookup, or multi-repo investigation before implementation?",
    ),
    effort: choice(
      "What reasoning effort is required from the model to solve this task safely and correctly?",
      {
        standard: "Direct answers, straightforward patterns, simple edits with obvious solutions.",
        high: "Moderate complexity requiring careful validation, edge cases checking, or regression avoidance.",
        xhigh: "Complex distributed logic, multi-step invariant verification, critical security or financial flows.",
      },
    ),
  };

  try {
    const outcome = await client.ask(statePayload, questions);
    const answers = outcome.answers as any;

    if (!answers) {
      return createDeterministicFallback(taskDescription, "invalid-response-shape", outcome.jevMs);
    }

    // Evaluate complexity with quantile leaning if probabilities exist, or choice
    const complexityAns = answers.complexity;
    let rawComplexity: TaskComplexity = (complexityAns?.choice ?? "routine") as TaskComplexity;
    let confidence = complexityAns?.confidence ?? 0.85;

    // If probability distribution is provided, check for contested bimodal hard tail
    if (complexityAns?.probabilities) {
      const probs = complexityAns.probabilities as Record<string, number>;
      const hardMass = (probs.moderate ?? 0) + (probs.architectural ?? 0);
      // If 40%+ of probability indicates moderate/architectural, escalate to protect against under-provisioning
      if (hardMass >= 0.40 && rawComplexity !== "architectural") {
        if ((probs.architectural ?? 0) >= 0.35) {
          rawComplexity = "architectural";
        } else if (rawComplexity === "trivial" || rawComplexity === "routine") {
          rawComplexity = "moderate";
        }
      }
      confidence = 1.0 - probabilityMargin(probs);
    }

    const needsResearch = (answers.needs_research?.noul ?? 0) > 0.5;
    const rawEffort = (answers.effort?.choice ?? "standard") as ReasoningEffort;

    const recommendedPipeline: "direct" | "triad" =
      rawComplexity === "moderate" || rawComplexity === "architectural" ? "triad" : "direct";

    return {
      complexity: rawComplexity,
      confidence: Math.max(0.5, Math.min(1.0, confidence)),
      needsResearch,
      effort: rawEffort,
      recommendedPipeline,
      latencyMs: Math.round(outcome.jevMs),
      rawAnswers: answers,
    };
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    return createDeterministicFallback(taskDescription, `network-exception: ${String(err)}`, latencyMs);
  }
}

export function createDeterministicFallback(
  task: string,
  reason: string,
  latencyMs: number,
): TriageDecision {
  const lower = task.toLowerCase();
  const isArchitectural =
    lower.includes("arquitetura") ||
    lower.includes("multi-tenant") ||
    lower.includes("migracao") ||
    lower.includes("refactor global");
  const isModerate =
    lower.includes("integra") || lower.includes("banco") || lower.includes("api") || lower.includes("sap");
  const needsResearch = isArchitectural || isModerate || lower.includes("pesquis") || lower.includes("investig");

  const complexity: TaskComplexity = isArchitectural ? "architectural" : isModerate ? "moderate" : "routine";
  const effort: ReasoningEffort = isArchitectural ? "xhigh" : isModerate ? "high" : "standard";

  return {
    complexity,
    confidence: 0.5,
    needsResearch,
    effort,
    recommendedPipeline: complexity === "routine" ? "direct" : "triad",
    latencyMs,
    rawAnswers: { fallback: true, reason },
  };
}
