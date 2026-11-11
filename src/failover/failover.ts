import { classify } from "./outcome/index.js";
import type { Outcome } from "./outcome/index.js";
import type { Health } from "./health.js";

export interface Target {
  cli: "codex" | "agy" | "claude";
  model: string;
  effort?: string;
}

export interface AttemptReport {
  code: number;
  outcome: "done" | "failed" | "timeout" | "interrupted";
  output: string;
}

export interface ChainDeps {
  runAttempt: (target: Target, attempt: number) => Promise<AttemptReport>;
  health: Health;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  emit?: (event: Record<string, unknown> & { type: string }) => void;
  echo?: (line: string) => void;
  setTitle?: (title: string) => void;
  signal: AbortSignal;
  maxAttempts?: number;
  maxWaitMs?: number;
}

export const MAX_ATTEMPTS = 6;
const MAX_TRANSIENT_RETRIES = 2;
const BACKOFF_MS = [2000, 8000];
const LONG_RETRY_AFTER_MS = 120_000;
const DEFAULT_QUOTA_LOCK_MS = 1_800_000;
const COUNTDOWN_SLICE_MS = 30_000;
const MAX_WAIT_MS = 21_600_000;
const CLIS = ["codex", "agy", "claude"];

export const targetKey = (t: Target): string => `${t.cli}/${t.model}`;

export function parseChain(text: string | undefined): Target[] {
  if (!text) return [];
  const out: Target[] = [];
  for (const part of text.split(",")) {
    const at = part.indexOf("/");
    const cli = part.slice(0, at).trim();
    const model = part.slice(at + 1).trim();
    if (at > 0 && model && CLIS.includes(cli)) out.push({ cli: cli as Target["cli"], model });
  }
  return out;
}

interface Block {
  until: number | null;
  reason: string;
}

function blockOf(health: Health, t: Target, now: number): Block | null {
  const lock = health.lockoutFor(t.cli, t.model);
  if (lock) return { until: lock.reason === "auth" || lock.reason === "model_gone" ? null : (lock.until ?? null), reason: lock.reason };
  const open = health.breakerUntil(t.cli);
  return open > now ? { until: open, reason: "breaker" } : null;
}

export async function runChain(chain: Target[], deps: ChainDeps): Promise<number> {
  const { health, now, signal } = deps;
  const random = deps.random ?? Math.random;
  const echo = deps.echo ?? (() => undefined);
  const emit = deps.emit ?? (() => undefined);
  const maxAttempts = deps.maxAttempts ?? MAX_ATTEMPTS;
  const maxWaitMs = deps.maxWaitMs ?? MAX_WAIT_MS;
  const tried = new Set<string>();
  let attempts = 0;
  let waited = 0;
  let failedCount = 0;
  let lastCode = 1;
  let current: Target | null = null;
  let retries = 0;
  let timeoutRetries = 0;

  const log = (target: Target, outcome: Outcome | string, extra: Record<string, unknown> = {}) =>
    health.routeLog({ target: targetKey(target), outcome: typeof outcome === "string" ? outcome : outcome.kind, why: typeof outcome === "string" ? outcome : outcome.why, tried: [...tried], ...extra });

  const wait = async (ms: number, label: string): Promise<boolean> => {
    const until = now() + ms;
    emit({ type: "wait", until, target: label });
    let remaining = ms;
    while (remaining > 0) {
      if (signal.aborted) return false;
      const slice = Math.min(COUNTDOWN_SLICE_MS, remaining);
      await deps.sleep(slice, signal);
      remaining -= slice;
      if (remaining > 0) {
        echo(`[failover] waiting ${Math.ceil(remaining / 1000)}s for ${label}`);
        deps.setTitle?.(`waiting ${Math.ceil(remaining / 1000)}s · ${label}`);
      }
    }
    return !signal.aborted;
  };

  const finish = (code: number, request = false): number => {
    emit({ type: "failover-end", code, attempts, ...(request ? { request: true } : {}) });
    return code;
  };

  for (;;) {
    if (signal.aborted) return finish(130);
    if (current === null) {
      const t0 = now();
      const open = chain.filter((t) => !tried.has(targetKey(t)));
      const free = open.find((t) => blockOf(health, t, t0) === null);
      if (free) {
        current = free;
        retries = 0;
        timeoutRetries = 0;
      } else {
        const waiting = chain
          .map((t) => ({ t, block: blockOf(health, t, t0) }))
          .filter((x): x is { t: Target; block: Block & { until: number } } => x.block !== null && x.block.until !== null);
        if (waiting.length === 0) return finish(lastCode);
        const soonest = waiting.reduce((a, b) => (a.block.until <= b.block.until ? a : b));
        const ms = Math.max(0, soonest.block.until - t0);
        if (waited + ms > maxWaitMs) {
          echo("[failover] wait ceiling reached");
          return finish(lastCode);
        }
        echo(`[failover] chain locked, waiting ${Math.ceil(ms / 1000)}s for ${targetKey(soonest.t)} (${soonest.block.reason})`);
        waited += ms;
        if (!(await wait(ms, targetKey(soonest.t)))) return finish(130);
        for (const w of waiting) tried.delete(targetKey(w.t));
        continue;
      }
    }
    if (attempts >= maxAttempts) {
      echo(`[failover] attempt ceiling ${maxAttempts} reached`);
      return finish(lastCode);
    }
    attempts += 1;
    const target = current;
    deps.setTitle?.(`${targetKey(target)} #${attempts}`);
    const report = await deps.runAttempt(target, attempts);
    lastCode = report.code;
    if (report.outcome === "interrupted" || signal.aborted) return finish(130);
    const outcome = classify(target.cli, { code: report.code, timedOut: report.outcome === "timeout", output: report.output, now: now() });
    const key = targetKey(target);
    log(target, outcome, { attempt: attempts });
    emit({ type: "attempt", target: key, outcome: outcome.kind, why: outcome.why, attempt: attempts });

    if (outcome.kind === "Success") {
      health.success(target.cli);
      return finish(0);
    }
    if (outcome.kind === "Failed" && outcome.request) {
      echo("[failover] request error, returning to the hub");
      return finish(lastCode, true);
    }

    const advance = () => {
      tried.add(key);
      current = null;
    };

    if (outcome.kind === "Transient") {
      const longRetry = outcome.retryAfterMs !== undefined && outcome.retryAfterMs > LONG_RETRY_AFTER_MS;
      if (longRetry) {
        health.lock(key, "quota", now() + outcome.retryAfterMs!);
        advance();
      } else if (retries < MAX_TRANSIENT_RETRIES) {
        const base = outcome.retryAfterMs ?? BACKOFF_MS[retries]! * (0.75 + random() * 0.5);
        retries += 1;
        echo(`[failover] transient on ${key}, retry ${retries} in ${Math.ceil(base / 1000)}s`);
        if (!(await wait(Math.round(base), key))) return finish(130);
      } else {
        health.failure(target.cli);
        advance();
      }
    } else if (outcome.kind === "Quota") {
      health.lock(key, "quota", outcome.resetAt ?? now() + DEFAULT_QUOTA_LOCK_MS);
      advance();
    } else if (outcome.kind === "Auth") {
      health.lock(`${target.cli}/*`, "auth");
      echo(`[failover] ${target.cli} needs login`);
      advance();
    } else if (outcome.kind === "Timeout") {
      if (timeoutRetries < 1) timeoutRetries += 1;
      else advance();
    } else {
      failedCount += 1;
      if (failedCount >= 2) {
        echo("[failover] second failure, returning to the hub");
        return finish(lastCode);
      }
      advance();
    }
    if (current === null) {
      const nextTarget = chain.find((t) => !tried.has(targetKey(t)) && blockOf(health, t, now()) === null);
      emit({ type: "failover", from: key, to: nextTarget ? targetKey(nextTarget) : null, outcome: outcome.kind });
      if (nextTarget) echo(`[failover] ${key} ${outcome.kind}, next ${targetKey(nextTarget)}`);
    }
  }
}
