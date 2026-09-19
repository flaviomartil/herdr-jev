import { resolveTypeSafeApiKey } from "./client.js";

const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

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
  levels: string[];
}

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export function noul(instructions: string): NoulQuestion {
  return { type: "noul", instructions };
}

export function choice(instructions: string, criteria: Record<string, string>): ChoiceQuestion {
  return { type: "choice", instructions, criteria };
}

export function score(instructions: string, levels: string[]): ScoreQuestion {
  return { type: "score", instructions, levels };
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
 */
export async function evaluateQuestions(
  state: string,
  questions: Record<string, JevQuestion>,
  apiKey?: string | null
): Promise<EvaluateResult> {
  const resolvedKey = apiKey === null ? null : (apiKey ?? resolveTypeSafeApiKey());
  const startTime = Date.now();

  if (!resolvedKey) {
    return evaluateFallback(state, questions, Date.now() - startTime);
  }

  const payloadQuestions: Record<string, unknown> = {};
  for (const [key, q] of Object.entries(questions)) {
    if (q.type === "noul") {
      payloadQuestions[key] = { type: "noul", instructions: q.instructions };
    } else if (q.type === "choice") {
      payloadQuestions[key] = { type: "choice", instructions: q.instructions, criteria: q.criteria };
    } else if (q.type === "score") {
      payloadQuestions[key] = { type: "score", instructions: q.instructions, levels: q.levels };
    }
  }

  try {
    const response = await fetch(TYPESAFE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resolvedKey}`,
      },
      body: JSON.stringify({
        state,
        model: "jev-latest",
        questions: payloadQuestions,
      }),
    });

    const latencyMs = Date.now() - startTime;
    if (!response.ok) {
      return evaluateFallback(state, questions, latencyMs);
    }

    const data = (await response.json()) as { answers?: Record<string, any> };
    if (!data.answers) {
      return evaluateFallback(state, questions, latencyMs);
    }

    const parsedAnswers: EvaluateResult["answers"] = {};
    for (const [key, q] of Object.entries(questions)) {
      const rawAns = data.answers[key];
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
        const scoreVal = typeof rawAns.score === "number" ? rawAns.score : 0.5;
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
      latencyMs,
    };
  } catch {
    return evaluateFallback(state, questions, Date.now() - startTime);
  }
}

function evaluateFallback(
  state: string,
  questions: Record<string, JevQuestion>,
  latencyMs: number
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
 * Returns:
 * - 'execute': High confidence that the action is safe and appropriate.
 * - 'confirm': Moderate confidence or non-trivial impact; requires user verification.
 * - 'escalate': High uncertainty or cross-cutting impact; escalate to stronger model or human.
 * - 'abort': Destructive without authorization or direct safety violation.
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
    apiKey
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
