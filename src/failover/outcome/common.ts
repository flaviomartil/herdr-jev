import type { AttemptResult, Outcome } from "./types.js";

const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
const UNIT_WORD = /^(d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)$/i;

export function parseDuration(text: string): number | undefined {
  const parts = [...text.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)].filter((m) => UNIT_WORD.test(m[2]!));
  if (parts.length === 0) return undefined;
  let total = 0;
  for (const part of parts) total += Number(part[1]) * UNIT_MS[part[2]!.toLowerCase()[0]!]!;
  return total > 0 ? Math.round(total) : undefined;
}

export function parseRetryAfter(output: string): number | undefined {
  const header = output.match(/retry-after["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)/i);
  if (header) return Math.round(Number(header[1]) * 1000);
  const prose = output.match(/retry(?:ing)? (?:again )?(?:after|in)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?)\b/i);
  if (prose) return Math.round(Number(prose[1]) * (/^ms|^milli/i.test(prose[2]!) ? 1 : 1000));
  return undefined;
}

export function parseResetIn(output: string, now: number): number | undefined {
  const m = output.match(/(?:resets?|try again|available again|retry)\s+(?:after|in)\s+((?:\d+(?:\.\d+)?\s*[a-z]+[\s,]*(?:and\s+)?)+)/i);
  if (!m) return undefined;
  const ms = parseDuration(m[1]!);
  return ms === undefined ? undefined : now + ms;
}

export function parseResetDate(output: string, now: number): number | undefined {
  const m = output.match(/(?:[Rr]esets?(?: at)?|[Tt]ry again at|[Aa]vailable again at)\s*:?\s*((?:[A-Z][a-z]{2,8}\s+\d{1,2}(?:st|nd|rd|th)?,?\s+(?:\d{4},?\s+)?)?\d{1,2}(?::\d{2})?\s*(?:am|pm|AM|PM)?(?:\s*\(?(?:UTC|GMT)\)?)?)/);
  if (!m) return undefined;
  const raw = m[1]!.replace(/(\d)(st|nd|rd|th)/, "$1").replace(/\(|\)/g, "").trim();
  const utc = /UTC|GMT/i.test(raw);
  const clean = raw.replace(/\s*(UTC|GMT)/i, "").trim();
  const dated = Date.parse(utc ? `${clean} UTC` : clean);
  if (!Number.isNaN(dated) && /[A-Za-z]{3}/.test(clean)) {
    const at = /\d{4}/.test(clean) ? dated : new Date(dated).setFullYear(new Date(now).getFullYear());
    return at > now ? at : undefined;
  }
  const t = clean.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!t) return undefined;
  let hour = Number(t[1]);
  if (t[3]) hour = (hour % 12) + (t[3].toLowerCase() === "pm" ? 12 : 0);
  const base = new Date(now);
  const at = utc
    ? Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hour, Number(t[2] ?? 0))
    : new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, Number(t[2] ?? 0)).getTime();
  return at > now ? at : at + 86_400_000;
}

export function parseReset(output: string, now: number): number | undefined {
  return parseResetIn(output, now) ?? parseResetDate(output, now);
}

export interface Rules {
  quota: RegExp;
  auth: RegExp;
  transient: RegExp;
  request: RegExp;
  reset?: (output: string, now: number) => number | undefined;
}

export function classifyWith(rules: Rules, result: AttemptResult): Outcome {
  const text = result.output;
  if (result.timedOut) return { kind: "Timeout", why: "inactivity or absolute timeout" };
  if (result.code === 0) return { kind: "Success", why: "exit 0" };
  const retryAfterMs = parseRetryAfter(text);
  if (rules.quota.test(text)) {
    const resetAt = (rules.reset ?? parseReset)(text, result.now);
    return { kind: "Quota", ...(resetAt ? { resetAt } : {}), why: "quota exhausted" };
  }
  if (rules.auth.test(text)) return { kind: "Auth", why: "authentication failed" };
  if (rules.transient.test(text)) return { kind: "Transient", ...(retryAfterMs ? { retryAfterMs } : {}), why: "transient upstream error" };
  if (rules.request.test(text)) return { kind: "Failed", request: true, why: "invalid request" };
  return { kind: "Failed", why: `unrecognized failure (exit ${result.code})` };
}
