import { resolveTypeSafeApiKey } from "./client.js";
import { ResilientJevClient, getGlobalJevClient } from "./jev-client.js";
import { scoreQuantile } from "./quantile.js";

export type QuestionType = "noul" | "choice" | "score";

export interface NoulQuestion {
  type: "noul";
  instructions: string;
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: string;
  levels?: string[];
  criteria?: string[] | Record<string, string>;
}

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export function noul(instructions: string): NoulQuestion {
  return { type: "noul", instructions };
}

export function choice(instructions: string, criteria: Record<string, string>): ChoiceQuestion {
  return { type: "choice", instructions, criteria };
}

export function score(instructions: string, levelsOrCriteria: string[] | Record<string, string>): ScoreQuestion {
  const criteria = Array.isArray(levelsOrCriteria) ? levelsOrCriteria : levelsOrCriteria;
  return {
    type: "score",
    instructions,
    levels: Array.isArray(levelsOrCriteria) ? levelsOrCriteria : Object.values(levelsOrCriteria),
    criteria,
  };
}

export interface EvaluateResult {
  answers: Record<
    string,
    {
      type: QuestionType;
      value: boolean | string | number;
      confidence: number;
      raw?: unknown;
    }
  >;
  fallback: boolean;
  latencyMs: number;
}

export type GateVerdict = "execute" | "confirm" | "escalate" | "abort";

export interface ConfidenceGateResult {
  verdict: GateVerdict;
  confidence: number;
  riskScore: number;
  reason: string;
  fallback: boolean;
  latencyMs: number;
}

/**
 * Evaluates arbitrary typed questions against a state text via TypeSafe Jev System One
 * (or deterministic heuristics when no API key is available).
 * Uses ResilientJevClient with connection pooling, deadline racing, and LRU caching.
 */
export async function evaluateQuestions(
  state: string,
  questions: Record<string, JevQuestion>,
  apiKey?: string | null,
): Promise<EvaluateResult> {
  const resolvedKey = apiKey === null ? null : (apiKey ?? resolveTypeSafeApiKey());
  const startTime = Date.now();

  if (!resolvedKey) {
    return evaluateFallback(state, questions, Date.now() - startTime);
  }

  const payloadQuestions: Record<string, any> = {};
  for (const [key, q] of Object.entries(questions)) {
    if (q.type === "noul") {
      payloadQuestions[key] = { type: "noul", instructions: q.instructions };
    } else if (q.type === "choice") {
      payloadQuestions[key] = { type: "choice", instructions: q.instructions, criteria: q.criteria };
    } else if (q.type === "score") {
      payloadQuestions[key] = {
        type: "score",
        instructions: q.instructions,
        criteria: q.criteria ?? q.levels ?? [],
      };
    }
  }

  try {
    const client = apiKey ? new ResilientJevClient({ apiKey }) : getGlobalJevClient();
    const outcome = await client.ask(state, payloadQuestions);
    const answersData = outcome.answers as Record<string, any> | undefined;

    if (!answersData) {
      return evaluateFallback(state, questions, outcome.jevMs);
    }

    const parsedAnswers: EvaluateResult["answers"] = {};
    for (const [key, q] of Object.entries(questions)) {
      const rawAns = answersData[key];
      if (!rawAns) continue;

      if (q.type === "noul") {
        const prob = typeof rawAns.noul === "number" ? rawAns.noul : 0.5;
        parsedAnswers[key] = {
          type: "noul",
          value: prob >= 0.5,
          confidence: Math.abs(prob - 0.5) * 2,
          raw: rawAns,
        };
      } else if (q.type === "choice") {
        parsedAnswers[key] = {
          type: "choice",
          value: rawAns.choice ?? Object.keys(q.criteria)[0] ?? "",
          confidence: rawAns.confidence ?? 0.75,
          raw: rawAns,
        };
      } else if (q.type === "score") {
        // Read 0.60 quantile if probability distribution is provided, else raw score
        let scoreVal = typeof rawAns.score === "number" ? rawAns.score : 0.5;
        if (rawAns.probabilities) {
          scoreVal = scoreQuantile(rawAns.probabilities, 0.60);
        }
        parsedAnswers[key] = {
          type: "score",
          value: scoreVal,
          confidence: rawAns.confidence ?? 0.75,
          raw: rawAns,
        };
      }
    }

    return {
      answers: parsedAnswers,
      fallback: false,
      latencyMs: Math.round(outcome.jevMs),
    };
  } catch {
    return evaluateFallback(state, questions, Date.now() - startTime);
  }
}

function evaluateFallback(
  state: string,
  questions: Record<string, JevQuestion>,
  latencyMs: number,
): EvaluateResult {
  const lower = state.toLowerCase();
  const answers: EvaluateResult["answers"] = {};

  for (const [key, q] of Object.entries(questions)) {
    if (q.type === "noul") {
      let positive = false;
      const lowerKey = key.toLowerCase();
      if (lowerKey.includes("destructive") || lowerKey.includes("danger") || lowerKey.includes("risk")) {
        positive =
          lower.includes("drop") ||
          lower.includes("rm ") ||
          lower.includes("delete") ||
          lower.includes("destroy") ||
          lower.includes("truncate");
      } else {
        positive =
          lower.includes("yes") ||
          lower.includes("sim") ||
          lower.includes("ok") ||
          lower.includes("permitir") ||
          lower.includes("safe") ||
          lower.includes("status") ||
          lower.includes("log");
      }
      answers[key] = {
        type: "noul",
        value: positive,
        confidence: 0.6,
        raw: { fallback: true },
      };
    } else if (q.type === "choice") {
      const keys = Object.keys(q.criteria);
      let matched = keys[0] ?? "unknown";
      for (const k of keys) {
        if (lower.includes(k.toLowerCase())) {
          matched = k;
          break;
        }
      }
      answers[key] = {
        type: "choice",
        value: matched,
        confidence: 0.6,
        raw: { fallback: true },
      };
    } else if (q.type === "score") {
      answers[key] = {
        type: "score",
        value: 0.5,
        confidence: 0.5,
        raw: { fallback: true },
      };
    }
  }

  return {
    answers,
    fallback: true,
    latencyMs,
  };
}

/**
 * Evaluates an action or tool call against safety, destructive risk, and confidence thresholds.
 */
export async function evaluateConfidenceGate(params: {
  state: string;
  proposedAction: string;
  executeThreshold?: number;
  confirmThreshold?: number;
  apiKey?: string | null;
}): Promise<ConfidenceGateResult> {
  const {
    state,
    proposedAction,
    executeThreshold = 0.75,
    confirmThreshold = 0.45,
    apiKey,
  } = params;

  const questions: Record<string, JevQuestion> = {
    is_destructive: noul("Does this proposed action destroy data, delete files, drop tables, or rewrite production state?"),
    is_safe: noul("Is this proposed action safe, reversible, and aligned with user intent?"),
    confidence: score("Rate the overall confidence that this action will succeed without unintended side effects.", [
      "Extremely risky or unknown",
      "Moderate uncertainty",
      "Well understood with safeguards",
      "Completely routine and safe",
    ]),
  };

  const evalRes = await evaluateQuestions(
    `Current State:\n${state}\n\nProposed Action:\n${proposedAction}`,
    questions,
    apiKey,
  );

  const isDestructive = evalRes.answers.is_destructive?.value === true;
  const isSafe = evalRes.answers.is_safe?.value === true;
  const scoreVal = typeof evalRes.answers.confidence?.value === "number" ? evalRes.answers.confidence.value : 0.5;
  const confidence = evalRes.answers.is_safe?.confidence ?? 0.6;

  let verdict: GateVerdict = "confirm";
  let reason = "Standard verification required before execution.";

  if (isDestructive && !isSafe) {
    verdict = "abort";
    reason = "Proposed action appears destructive without sufficient validation or safe reversibility.";
  } else if (isSafe && scoreVal >= executeThreshold && !isDestructive) {
    verdict = "execute";
    reason = "High confidence and verified safe to proceed automatically.";
  } else if (scoreVal < confirmThreshold) {
    verdict = "escalate";
    reason = "Low confidence or ambiguous requirements. Recommend escalating to human review or frontier model.";
  } else {
    verdict = "confirm";
    reason = isDestructive
      ? "Action involves state mutation or potential data removal; confirm before running."
      : "Moderate confidence; confirm with user.";
  }

  return {
    verdict,
    confidence,
    riskScore: isDestructive ? 0.9 : 1 - scoreVal,
    reason,
    fallback: evalRes.fallback,
    latencyMs: evalRes.latencyMs,
  };
}
