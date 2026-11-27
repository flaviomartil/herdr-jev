import { performance } from "node:perf_hooks";
import {
  APIError,
  APIUserAbortError,
  TypeSafeClient,
  noul,
  type Fetch,
  type JsonValue,
  type Questions,
  type SystemOneResult,
} from "@typesafe-ai/sdk";
import { Lru, hashKey } from "../cache/lru.js";
import { resolveTypeSafeApiKey } from "./client.js";

/** Pinned default model, never unpinned 'jev-latest' */
export const DEFAULT_JEV_MODEL = process.env.TYPESAFE_DEFAULT_MODEL ?? "jev-1.13.0";

export const DEADLINE_ENV = "HERDR_JEV_DEADLINE_MS";
export const HARNESS_DEADLINE_ENV = "HARNESS_ROUTER_DEADLINE_MS";
export const FALLBACK_DEADLINE_MS = 1000;

export function getResolvedDeadlineMs(): number {
  const envVal = Number(process.env[DEADLINE_ENV] ?? process.env[HARNESS_DEADLINE_ENV]);
  return Number.isFinite(envVal) && envVal > 0 ? envVal : FALLBACK_DEADLINE_MS;
}

export type JevFailure = "deadline" | "aborted" | "api" | "network" | "missing_key" | "unsafe_state";

const PRIVATE_KEY_BLOCK_PATTERN = /-----BEGIN\s+(?:[A-Z0-9-]+\s+)*PRIVATE KEY(?:\s+BLOCK)?-----/;
const MAX_GUARD_CHUNK = 7500;
const GUARD_CHUNK_STEP = 6988;

const EXPLICIT_SECRET_PATTERNS: readonly RegExp[] = [
  PRIVATE_KEY_BLOCK_PATTERN,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\bhf_[A-Za-z0-9]{16,}\b/,
  /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\bBearer[ \t]+(?!\[REDACTED\])[A-Za-z0-9._~+/-]{8,}=*/i,
  /\bBasic[ \t]+(?!\[REDACTED\])(?=[A-Za-z0-9+/=]*[0-9+/=A-Z])[A-Za-z0-9+/]{8,}={0,2}/,
];

const URL_CREDENTIALS_PATTERN = /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:\/\/([^\s:@/]+):([^\s@/]{1,512})@/g;

const INLINE_SECRET_KEY =
  "(?:[a-zA-Z0-9_.-]*(?:pass(?:word|wd|wrd|phrase)|secret|credentials?)|(?:api|access|secret|private)[_-]?key|(?:auth|access|refresh|id|session|oauth|bot|csrf)[_-]?token|token|bearer)";

const INLINE_KEY_VALUE_SECRET = new RegExp(
  `(?:^|[\\s,;({\\[])["']?${INLINE_SECRET_KEY}["']?\\s*(?:===|==|=>|:=|!==|!=|=|:)\\s*(?:"([^"\\r\\n]*)"|'([^'\\r\\n]*)'|([^\\s"';&,}\\]]+))`,
  "gi",
);

const INLINE_FLAG_SECRET = new RegExp(
  `(?:^|\\s)--[a-z0-9_-]*(?:password|passwd|secret|api-key|private-key|auth-token|access-token|refresh-token|credential|token)\\b\\s+(?:"([^"\\r\\n]*)"|'([^'\\r\\n]*)'|([^\\s"';&,}\\]]+))`,
  "gi",
);

const SECRET_PROP_NAME =
  /^(?:.*(?:pass(?:word|wd|wrd|phrase)|secret|credentials?)|(?:api|access|secret|private)[_-]?key|(?:auth|access|refresh|id|session|oauth|bot|csrf)[_-]?token|token|bearer)$/i;

function isBenignTokenValue(raw: string): boolean {
  const trimmed = raw.trim();
  return trimmed === "" || trimmed === "[REDACTED]" || /^(?:true|false|null|undefined)$/i.test(trimmed);
}

function scanStringForSecrets(text: string): void {
  if (!text) return;
  for (let offset = 0; offset < text.length; offset += GUARD_CHUNK_STEP) {
    const chunk = text.slice(offset, offset + MAX_GUARD_CHUNK);
    for (const pattern of EXPLICIT_SECRET_PATTERNS) {
      if (pattern.test(chunk)) {
        throw new JevError("unsafe_state", "Refusing to send unredacted secret material to TypeSafe Jev");
      }
    }
    URL_CREDENTIALS_PATTERN.lastIndex = 0;
    for (const match of chunk.matchAll(URL_CREDENTIALS_PATTERN)) {
      const user = match[1] ?? "";
      const pass = match[2] ?? "";
      const isHostAndPort = /^\d{1,5}(?:\/|$)/.test(pass) && (user === "localhost" || user.includes("."));
      if (!isHostAndPort && !isBenignTokenValue(pass)) {
        throw new JevError("unsafe_state", "Refusing to send unredacted secret material to TypeSafe Jev");
      }
    }
    for (const pattern of [INLINE_KEY_VALUE_SECRET, INLINE_FLAG_SECRET]) {
      pattern.lastIndex = 0;
      for (const match of chunk.matchAll(pattern)) {
        const value = match[1] ?? match[2] ?? match[3] ?? "";
        if (!isBenignTokenValue(value)) {
          throw new JevError("unsafe_state", "Refusing to send unredacted secret material to TypeSafe Jev");
        }
      }
    }
    if (offset + MAX_GUARD_CHUNK >= text.length) break;
  }
}

function scanObjectForSecrets(value: unknown, insideSecretKey = false, seen = new WeakSet<object>()): void {
  if (value === null || value === undefined || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (insideSecretKey && !isBenignTokenValue(value)) {
      throw new JevError("unsafe_state", "Refusing to send unredacted secret material to TypeSafe Jev");
    }
    scanStringForSecrets(value);
    return;
  }
  if (typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      scanObjectForSecrets(item, insideSecretKey, seen);
    }
    return;
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record).sort()) {
    const child = record[key];
    const isSecretProp = SECRET_PROP_NAME.test(key);
    if (isSecretProp && typeof child === "string" && !isBenignTokenValue(child)) {
      throw new JevError("unsafe_state", "Refusing to send unredacted secret material to TypeSafe Jev");
    }
    scanObjectForSecrets(child, insideSecretKey || isSecretProp, seen);
  }
}

function normalizeStateForCheck(state: unknown): unknown {
  if (state === null || state === undefined || typeof state !== "object") return state;
  try {
    return JSON.parse(JSON.stringify(state));
  } catch {
    return state;
  }
}

export function assertSafeState(state: unknown): void {
  const normalized = normalizeStateForCheck(state);
  scanObjectForSecrets(normalized);
}

export class JevError extends Error {
  constructor(
    readonly failure: JevFailure,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "JevError";
  }
}

export interface JevOutcome<Q extends Questions> {
  readonly answers: SystemOneResult<Q>["answers"];
  readonly jevMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly model: string;
  readonly requestId?: string;
  readonly fromCache?: boolean;
}

export type LateHandler<Q extends Questions> = (outcome: JevOutcome<Q>) => void;

export interface ResilientJevOptions {
  readonly deadlineMs?: number;
  readonly model?: string;
  readonly apiKey?: string | null;
  readonly fetch?: Fetch;
  readonly cacheSize?: number;
}

/**
 * Resilient TypeSafe Jev Client with connection pooling, non-aborting deadline race,
 * in-process LRU cache, and connection prewarming.
 */
export class ResilientJevClient {
  private client: TypeSafeClient | null = null;
  private readonly cache: Lru<JevOutcome<any>>;
  private readonly deadlineMs: number;
  private readonly model: string;
  private readonly apiKey: string | null;
  private readonly injectedFetch?: Fetch;

  constructor(options: ResilientJevOptions = {}) {
    this.deadlineMs = options.deadlineMs ?? getResolvedDeadlineMs();
    this.model = options.model ?? process.env.TYPESAFE_DEFAULT_MODEL ?? DEFAULT_JEV_MODEL;
    this.apiKey = options.apiKey !== undefined ? options.apiKey : null;
    this.injectedFetch = options.fetch;
    this.cache = new Lru<JevOutcome<any>>(options.cacheSize ?? 256);
  }

  get deadline(): number {
    return this.deadlineMs;
  }

  clearCache(): void {
    this.cache.clear();
  }

  private getClient(): TypeSafeClient {
    if (this.client) return this.client;
    const resolvedKey = this.apiKey ?? resolveTypeSafeApiKey();
    if (!resolvedKey && !this.injectedFetch) {
      throw new JevError("missing_key", "TYPESAFE_API_KEY is not set or resolved from Vault.");
    }

    this.client = new TypeSafeClient({
      // The SDK's timeout aborts fetch and destroys pooled TLS connections.
      // We set a generous backstop here so an abandoned request doesn't leak forever,
      // while our own timer enforces the strict turn deadline without socket destruction.
      timeout: Math.max(this.deadlineMs * 8, 10_000),
      retry: { maxRetries: 0 },
      defaultModel: this.model,
      logLevel: "error",
      apiKey: resolvedKey || "test-key",
      ...(this.injectedFetch ? { fetch: this.injectedFetch } : {}),
    });
    return this.client;
  }

  /**
   * Opens and warms the pooled connection before an actual user turn.
   * Two calls are required: call 1 takes ~885ms, call 2 ~912ms, and settling at ~350ms from call 3.
   */
  async prewarm(): Promise<boolean> {
    try {
      const client = this.getClient();
      const warmPayload = {
        state: "warmup",
        questions: { warm: noul("Is this a connection prewarm request?") },
      };
      const opts = { timeout: 10_000, retry: { maxRetries: 0 } } as const;
      await client.systemOne(warmPayload, opts);
      await client.systemOne(warmPayload, opts);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Asks questions against state with deadline racing and LRU cache.
   */
  async ask<const Q extends Questions>(
    state: unknown,
    questions: Q,
    signal?: AbortSignal,
    onLate?: LateHandler<Q>,
  ): Promise<JevOutcome<Q>> {
    let payloadObj: { [key: string]: JsonValue } | undefined;
    if (typeof state === "object" && state !== null) {
      const normalized = normalizeStateForCheck(state);
      assertSafeState(normalized);
      payloadObj = (normalized === state ? JSON.parse(JSON.stringify(state)) : normalized) as { [key: string]: JsonValue };
    } else {
      assertSafeState(state);
    }
    const payload = (payloadObj ?? { state: String(state) }) as { [key: string]: JsonValue };

    const key = hashKey("jev", { state: payloadObj ?? state, questions });
    const cached = this.cache.get(key);
    if (cached) {
      return { ...cached, fromCache: true } as JevOutcome<Q>;
    }

    const client = this.getClient();

    const started = performance.now();

    // Inflight request with SDK
    const inflight = client
      .systemOne({ state: payload, questions }, signal ? { signal } : {})
      .withResponse();

    try {
      const { data, requestId } = await Promise.race([
        inflight,
        deadlineRejection(this.deadlineMs),
      ]);

      const outcome: JevOutcome<Q> = {
        answers: data.answers,
        jevMs: performance.now() - started,
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
        model: data.model,
        requestId,
        fromCache: false,
      };

      this.cache.set(key, outcome);
      return outcome;
    } catch (error) {
      const failure = classifyError(error);
      if (failure.failure === "deadline") {
        // Abandoned request finishes in background: cleans connection pool and stores late answer
        inflight.then(
          ({ data, requestId }) => {
            const lateOutcome: JevOutcome<Q> = {
              answers: data.answers,
              jevMs: performance.now() - started,
              inputTokens: data.usage?.input_tokens ?? 0,
              outputTokens: data.usage?.output_tokens ?? 0,
              model: data.model,
              requestId,
              fromCache: false,
            };
            this.cache.set(key, lateOutcome);
            onLate?.(lateOutcome);
          },
          () => {},
        ).catch(() => {});
      } else {
        inflight.catch(() => {});
      }
      throw failure;
    }
  }
}

let globalClient: ResilientJevClient | null = null;

export function getGlobalJevClient(): ResilientJevClient {
  if (!globalClient) {
    globalClient = new ResilientJevClient();
  }
  return globalClient;
}

function deadlineRejection(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(
      () => reject(new JevError("deadline", `Jev request exceeded deadline of ${ms}ms`)),
      ms,
    );
    timer.unref?.();
  });
}

function classifyError(error: unknown): JevError {
  if (error instanceof JevError) return error;
  if (error instanceof APIUserAbortError) return new JevError("aborted", error.message);
  if (error instanceof APIError) {
    return new JevError("api", `TypeSafe ${error.status}: ${error.message}`, error.status);
  }
  if (error instanceof Error) {
    if (error.message.includes("TYPESAFE_API_KEY")) {
      return new JevError("missing_key", error.message);
    }
    return new JevError("network", error.message);
  }
  return new JevError("network", String(error));
}
