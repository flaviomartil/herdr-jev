import { execSync } from "node:child_process";
import type { TaskComplexity, ReasoningEffort, TriageDecision } from "../types/index.js";

const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

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

export async function triageTaskWithJev(taskDescription: string, apiKey?: string | null): Promise<TriageDecision> {
  const resolvedKey = apiKey ?? resolveTypeSafeApiKey();
  const startTime = Date.now();

  if (!resolvedKey) {
    return createDeterministicFallback(taskDescription, "missing-api-key", Date.now() - startTime);
  }

  const payload = {
    state: `You are the triage gate for an AI development harness. Evaluate this coding task:\n\n"${taskDescription}"`,
    model: "jev-latest",
    questions: {
      complexity: {
        type: "choice",
        instructions: "What is the architectural and operational complexity level of this software engineering task?",
        criteria: {
          trivial: "Single-line edits, doc fixes, typos, single config value bump, quick git status or log query.",
          routine: "Standard bugfix, adding a simple endpoint, writing unit tests for existing code, localized component tweak.",
          moderate: "Multi-file refactoring, integrating a new external API or SDK, database migrations, debugging non-trivial errors.",
          architectural: "Cross-system integrations, multi-tenant designs, complete service orchestration, distributed consensus, protocol migrations.",
        },
      },
      needs_research: {
        type: "noul",
        instructions: "Does this task require deep codebase exploration, external documentation lookup, or multi-repo investigation before implementation?",
      },
      effort: {
        type: "choice",
        instructions: "What reasoning effort is required from the model to solve this task safely and correctly?",
        criteria: {
          standard: "Direct answers, straightforward patterns, simple edits with obvious solutions.",
          high: "Moderate complexity requiring careful validation, edge cases checking, or regression avoidance.",
          xhigh: "Complex distributed logic, multi-step invariant verification, critical security or financial flows.",
        },
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
      return createDeterministicFallback(taskDescription, `http-error-${response.status}`, latencyMs);
    }

    const data = (await response.json()) as {
      answers?: {
        complexity?: { choice?: string; confidence?: number };
        needs_research?: { noul?: number };
        effort?: { choice?: string; confidence?: number };
      };
    };

    const answers = data?.answers;
    if (!answers) {
      return createDeterministicFallback(taskDescription, "invalid-response-shape", latencyMs);
    }

    const rawComplexity = (answers.complexity?.choice ?? "routine") as TaskComplexity;
    const confidence = answers.complexity?.confidence ?? 0.85;
    const needsResearch = (answers.needs_research?.noul ?? 0) > 0.5;
    const rawEffort = (answers.effort?.choice ?? "standard") as ReasoningEffort;

    const recommendedPipeline: "direct" | "triad" =
      rawComplexity === "moderate" || rawComplexity === "architectural" ? "triad" : "direct";

    return {
      complexity: rawComplexity,
      confidence,
      needsResearch,
      effort: rawEffort,
      recommendedPipeline,
      latencyMs,
      rawAnswers: answers,
    };
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    return createDeterministicFallback(taskDescription, `network-exception: ${String(err)}`, latencyMs);
  }
}

function createDeterministicFallback(task: string, reason: string, latencyMs: number): TriageDecision {
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
