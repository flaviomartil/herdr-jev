import type { HerdrCommandResult } from "../types/index.js";

export type HerdrErrorCategory =
  | "temporary_pre_invocation"
  | "temporary_no_event"
  | "definitive_non_retryable"
  | "ambiguous";

export interface HerdrClassifiedError {
  category: HerdrErrorCategory;
  code: string | null;
  retryable: boolean;
  mayHaveLanded: boolean;
  legacyAck: "rejected" | "unknown";
  message: string;
}

export type HerdrErrorInput =
  | Pick<HerdrCommandResult, "ok" | "code" | "stdout" | "stderr">
  | { stdout?: string; stderr?: string; code?: string | number | null };

const TEMPORARY_PRE_INVOCATION_CODES = new Set([
  "agent_not_found",
  "pane_not_found",
  "agent_busy",
  "agent_pane_busy",
  "agent_blocked",
]);

const TEMPORARY_NO_EVENT_CODES = new Set([
  "agent_not_ready",
  "conflict",
  "server_busy",
]);

const DEFINITIVE_NON_RETRYABLE_CODES = new Set([
  "invalid_request",
  "invalid_args",
  "invalid_input",
  "unsupported",
  "unknown_command",
]);

const AMBIGUOUS_CODES = new Set([
  "agent_prompt_stalled",
]);

const PLAIN_TEXT_ERROR_CODE =
  /(?:^|[^a-z0-9_])(agent_not_found|pane_not_found|agent_busy|agent_pane_busy|agent_blocked|agent_not_ready|conflict|server_busy|invalid_request|invalid_args|invalid_input|unsupported|unknown_command|agent_prompt_stalled)(?:$|[^a-z0-9_])/i;

function extractEnvelope(text: string): { code: string; message?: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const candidates = [trimmed];
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace && (firstBrace > 0 || lastBrace < trimmed.length - 1)) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as {
        code?: unknown;
        message?: unknown;
        error?: string | { code?: unknown; message?: unknown };
      };
      const rawCode = typeof parsed?.error === "string" ? parsed.error : (parsed?.error?.code ?? parsed?.code);
      if (typeof rawCode === "string" && rawCode.trim().length > 0) {
        const rawMessage = typeof parsed?.error === "object" && parsed.error !== null
          ? (parsed.error.message ?? parsed.message)
          : parsed?.message;
        return {
          code: rawCode.trim().toLowerCase(),
          ...(typeof rawMessage === "string" && rawMessage.trim().length > 0 ? { message: rawMessage.trim() } : {}),
        };
      }
    } catch {
    }
  }
  return null;
}

/** Classify a Herdr command failure into the 4-way invocation/retry taxonomy. */
export function classifyHerdrError(result: HerdrErrorInput): HerdrClassifiedError {
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";

  const envelope = extractEnvelope(stdout) ?? extractEnvelope(stderr);
  let code: string | null = envelope?.code ?? null;

  if (!code && typeof result.code === "string" && result.code.trim().length > 0) {
    code = result.code.trim().toLowerCase();
  }

  if (!code) {
    const plainMatch = `${stderr}\n${stdout}`.match(PLAIN_TEXT_ERROR_CODE);
    if (plainMatch) {
      code = plainMatch[1].toLowerCase();
    }
  }

  const fallbackMessage = stderr.trim() || stdout.trim() || (code ?? "unknown error");
  const message = envelope?.message ?? fallbackMessage;

  if (code && TEMPORARY_PRE_INVOCATION_CODES.has(code)) {
    return {
      category: "temporary_pre_invocation",
      code,
      retryable: true,
      mayHaveLanded: false,
      legacyAck: code === "agent_blocked" ? "unknown" : "rejected",
      message,
    };
  }

  if (code && TEMPORARY_NO_EVENT_CODES.has(code)) {
    return {
      category: "temporary_no_event",
      code,
      retryable: true,
      mayHaveLanded: false,
      legacyAck: "unknown",
      message,
    };
  }

  if (code && DEFINITIVE_NON_RETRYABLE_CODES.has(code)) {
    return {
      category: "definitive_non_retryable",
      code,
      retryable: false,
      mayHaveLanded: false,
      legacyAck: "rejected",
      message,
    };
  }

  if (code && AMBIGUOUS_CODES.has(code)) {
    return {
      category: "ambiguous",
      code,
      retryable: false,
      mayHaveLanded: true,
      legacyAck: "unknown",
      message,
    };
  }

  return {
    category: "ambiguous",
    code,
    retryable: false,
    mayHaveLanded: true,
    legacyAck: "unknown",
    message,
  };
}
