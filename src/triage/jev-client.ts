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
export const FALLBACK_DEADLINE_MS = 600;

export function getResolvedDeadlineMs(): number {
  const envVal = Number(process.env[DEADLINE_ENV] ?? process.env[HARNESS_DEADLINE_ENV]);
  return Number.isFinite(envVal) && envVal > 0 ? envVal : FALLBACK_DEADLINE_MS;
}

export type JevFailure = "deadline" | "aborted" | "api" | "network" | "missing_key";

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
    this.model = options.model ?? DEFAULT_JEV_MODEL;
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
    const key = hashKey("jev", { state, questions });
    const cached = this.cache.get(key);
    if (cached) {
      return { ...cached, fromCache: true } as JevOutcome<Q>;
    }

    const client = this.getClient();
    const payload = (typeof state === "object" && state !== null
      ? JSON.parse(JSON.stringify(state))
      : { state: String(state) }) as { [key: string]: JsonValue };

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
        inputTokens: data.usage.input_tokens,
        outputTokens: data.usage.output_tokens,
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
              inputTokens: data.usage.input_tokens,
              outputTokens: data.usage.output_tokens,
              model: data.model,
              requestId,
              fromCache: false,
            };
            this.cache.set(key, lateOutcome);
            onLate?.(lateOutcome);
          },
          () => {},
        );
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
