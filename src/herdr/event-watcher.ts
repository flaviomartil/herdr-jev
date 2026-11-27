import net from "node:net";
import { isAbsolute } from "node:path";
import {
  HerdrEventStream,
  HerdrSocketClient,
  HerdrSocketError,
  isAllowedTestSocketPath,
  resolveHerdrSocketPath,
} from "./socket.js";
import { isTestGuardActive } from "./state-dir.js";

export const WAKE_HINT_EVENTS = [
  "pane.agent_status_changed",
  "pane.created",
  "pane.closed",
  "pane.moved",
  "pane.exited",
  "tab.closed",
] as const;

export type WakeHintEventType = typeof WAKE_HINT_EVENTS[number];

const WAKE_HINT_SET = new Set<string>(WAKE_HINT_EVENTS);
const GLOBAL_WAKE_KEY = "__global__";
const DEFAULT_MAX_RECONNECT_DELAY_MS = 15_000;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;

export type DebouncedPumpCallback = (keys: string[]) => void | Promise<void>;

/**
 * Coalesces rapid bursts per key or globally within `debounceMs` without dropping
 * trailing wakeups triggered while a flush is already in flight.
 */
export class DebouncedPump {
  readonly debounceMs: number;
  private readonly callback: DebouncedPumpCallback;
  private readonly onError?: (error: Error) => void;
  private readonly pendingKeys = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private flushRequested = false;
  private disposed = false;

  constructor(callback: DebouncedPumpCallback, debounceMs = 2000, onError?: (error: Error) => void) {
    this.callback = callback;
    this.debounceMs = Math.max(0, debounceMs);
    this.onError = onError;
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  trigger(key: string = GLOBAL_WAKE_KEY): void {
    if (this.disposed) return;
    this.pendingKeys.add(key);
    if (this.inFlight || this.timer) return;
    this.scheduleTimer();
  }

  private scheduleTimer(): void {
    if (this.disposed || this.timer || this.pendingKeys.size === 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runScheduledFlush().catch((err) => {
        this.onError?.(err instanceof Error ? err : new Error(String(err)));
      });
    }, this.debounceMs);
  }

  private async runScheduledFlush(): Promise<void> {
    if (this.disposed || this.inFlight || this.pendingKeys.size === 0) return;
    const batch = [...this.pendingKeys];
    this.pendingKeys.clear();
    const run = Promise.resolve(this.callback(batch)).finally(() => {
      if (this.inFlight === run) {
        this.inFlight = null;
      }
    });
    this.inFlight = run;
    await run;
    if (!this.disposed && this.pendingKeys.size > 0 && !this.flushRequested) {
      if (this.debounceMs > 0) {
        this.scheduleTimer();
      } else {
        await this.runScheduledFlush();
      }
    }
  }

  async flush(): Promise<void> {
    if (this.disposed) return;
    this.flushRequested = true;
    try {
      while (!this.disposed && (this.inFlight || this.pendingKeys.size > 0)) {
        if (this.timer) {
          clearTimeout(this.timer);
          this.timer = null;
        }
        if (this.inFlight) {
          await this.inFlight;
          continue;
        }
        if (this.pendingKeys.size === 0) break;
        const batch = [...this.pendingKeys];
        this.pendingKeys.clear();
        const run = Promise.resolve(this.callback(batch)).finally(() => {
          if (this.inFlight === run) {
            this.inFlight = null;
          }
        });
        this.inFlight = run;
        await run;
      }
    } finally {
      this.flushRequested = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.flushRequested = false;
    this.pendingKeys.clear();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

export interface WakeEventHint {
  type: string;
  paneId?: string;
  raw: Record<string, unknown>;
}

export interface HerdrWakeWatcherOptions {
  socketPath?: string | null;
  env?: NodeJS.ProcessEnv;
  paneIds?: readonly string[];
  debounceMs?: number;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  maxConsecutiveFailures?: number;
  resyncOnStart?: boolean;
  onWake: (keys: string[], hints: WakeEventHint[]) => void | Promise<void>;
  onResync?: (snapshot: Record<string, unknown> | null, reason: "startup" | "live_handoff" | "reconnect") => void | Promise<void>;
  onError?: (error: Error) => void;
  onTerminalStop?: (reason: string, error?: Error) => void;
}

export interface HerdrWakeWatcherStartResult {
  started: boolean;
  reason?: string;
  error?: Error;
}

function extractEventType(msg: Record<string, unknown>): string {
  if (typeof msg.event === "string") return msg.event;
  const ev = msg.event as Record<string, unknown> | undefined;
  if (ev && typeof ev.type === "string") return ev.type;
  const data = msg.data as Record<string, unknown> | undefined;
  if (data && typeof data.type === "string") return data.type;
  if (typeof msg.type === "string") return msg.type;
  return "";
}

function extractEventPaneId(msg: Record<string, unknown>): string | undefined {
  const data = (msg.data ?? msg.event ?? msg) as Record<string, unknown>;
  const candidate =
    data?.pane_id ??
    (data?.pane as Record<string, unknown> | undefined)?.pane_id ??
    (data?.agent as Record<string, unknown> | undefined)?.pane_id ??
    msg.pane_id;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function extractPreviousPaneId(msg: Record<string, unknown>): string | undefined {
  const data = (msg.data ?? msg.event ?? msg) as Record<string, unknown>;
  const candidate =
    data?.previous_pane_id ??
    data?.old_pane_id ??
    data?.from_pane_id ??
    (data?.pane as Record<string, unknown> | undefined)?.previous_pane_id ??
    msg.previous_pane_id;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function normalizeEventType(rawType: string): string {
  switch (rawType) {
    case "pane_agent_status_changed":
      return "pane.agent_status_changed";
    case "pane_created":
      return "pane.created";
    case "pane_closed":
      return "pane.closed";
    case "pane_moved":
      return "pane.moved";
    case "pane_exited":
      return "pane.exited";
    case "tab_closed":
      return "tab.closed";
    case "pane_updated":
      return "pane.updated";
    case "workspace_metadata_updated":
      return "workspace.metadata_updated";
    default:
      return rawType;
  }
}

function isLiveHandoffEvent(rawType: string, msg: Record<string, unknown>): boolean {
  return (
    rawType === "live_handoff" ||
    rawType === "server.live_handoff" ||
    rawType === "server_live_handoff" ||
    msg.live_handoff === true
  );
}

function extractSnapshotPanes(snapshotResult: unknown): string[] {
  const root = snapshotResult as Record<string, any> | undefined;
  const snap = root?.snapshot ?? root?.result?.snapshot ?? root;
  const ids = new Set<string>();
  for (const list of [snap?.agents, snap?.panes]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item?.pane_id === "string" && item.pane_id.length > 0) {
        ids.add(item.pane_id);
      }
    }
  }
  return [...ids];
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findMissingPaneFromError(error: unknown, tracked: ReadonlySet<string>): string | null {
  if (error && typeof error === "object") {
    const obj = error as Record<string, any>;
    const structured = obj.data?.pane_id ?? obj.pane_id;
    if (typeof structured === "string" && tracked.has(structured)) {
      return structured;
    }
  }
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : typeof (error as any)?.message === "string"
          ? (error as any).message
          : "";
  if (!message) return null;

  const sorted = [...tracked].sort((a, b) => b.length - a.length);
  for (const paneId of sorted) {
    const boundary = new RegExp(`(?:^|[^a-zA-Z0-9:_-])${escapeRegex(paneId)}(?:[^a-zA-Z0-9:_-]|$)`);
    if (boundary.test(message)) return paneId;
  }
  return null;
}

function isTerminalTransportError(err: unknown): boolean {
  const code =
    err instanceof HerdrSocketError
      ? err.code
      : (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

/** Build `events.subscribe` subscription entries strictly from `WAKE_HINT_EVENTS`. */
export function buildWakeSubscriptions(trackedPaneIds: ReadonlySet<string>): Array<Record<string, unknown>> {
  const subs: Array<Record<string, unknown>> = [];
  for (const eventType of WAKE_HINT_EVENTS) {
    if (eventType === "pane.agent_status_changed") {
      for (const paneId of trackedPaneIds) {
        subs.push({ type: eventType, pane_id: paneId });
      }
    } else {
      subs.push({ type: eventType });
    }
  }
  return subs;
}

/**
 * Long-lived wake-hint watcher over `HerdrEventStream`.
 * Subscribes only to `WAKE_HINT_EVENTS`, prunes tracked pane IDs on `pane_not_found`,
 * triggers `session.snapshot` resync on `live_handoff` or reconnect, and debounces wakeups.
 */
export class HerdrWakeWatcher {
  private readonly socketPath: string | null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly trackedPaneIds = new Set<string>();
  private readonly debounceMs: number;
  private readonly reconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly maxConsecutiveFailures: number;
  private readonly resyncOnStart: boolean;
  private readonly onWakeHandler: HerdrWakeWatcherOptions["onWake"];
  private readonly onResync?: HerdrWakeWatcherOptions["onResync"];
  private readonly onError?: HerdrWakeWatcherOptions["onError"];
  private readonly onTerminalStop?: HerdrWakeWatcherOptions["onTerminalStop"];
  private readonly bufferedHints: WakeEventHint[] = [];
  private pump: DebouncedPump;
  private stream: HerdrEventStream | null = null;
  private client: HerdrSocketClient | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveFailures = 0;
  private consecutiveTerminalFailures = 0;
  private running = false;
  private stopped = false;

  constructor(options: HerdrWakeWatcherOptions) {
    this.env = options.env ?? process.env;
    if (options.socketPath !== undefined) {
      this.socketPath =
        options.socketPath === null
          ? null
          : isTestGuardActive(this.env) && !isAllowedTestSocketPath(options.socketPath)
            ? null
            : options.socketPath;
    } else {
      this.socketPath = resolveHerdrSocketPath(this.env);
    }
    for (const id of options.paneIds ?? []) {
      if (typeof id === "string" && id.length > 0) this.trackedPaneIds.add(id);
    }
    this.debounceMs = options.debounceMs ?? 2000;
    this.reconnectDelayMs = Math.max(10, options.reconnectDelayMs ?? 150);
    this.maxReconnectDelayMs = Math.max(this.reconnectDelayMs, options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS);
    this.maxConsecutiveFailures = Math.max(1, options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES);
    this.resyncOnStart = options.resyncOnStart ?? true;
    this.onWakeHandler = options.onWake;
    this.onResync = options.onResync;
    this.onError = options.onError;
    this.onTerminalStop = options.onTerminalStop;
    this.pump = this.createPump();
  }

  private createPump(): DebouncedPump {
    return new DebouncedPump(
      async (keys) => {
        const hints = this.bufferedHints.splice(0, this.bufferedHints.length);
        await this.onWakeHandler(keys, hints);
      },
      this.debounceMs,
      (err) => this.onError?.(err),
    );
  }

  getTrackedPaneIds(): string[] {
    return [...this.trackedPaneIds];
  }

  isRunning(): boolean {
    return this.running;
  }

  async flush(): Promise<void> {
    await this.pump.flush();
  }

  async start(): Promise<HerdrWakeWatcherStartResult> {
    if (!this.socketPath) {
      const err = new HerdrSocketError("herdr socket unavailable", {
        code: "socket_unavailable",
        phase: "connect",
      });
      this.onError?.(err);
      return { started: false, reason: "socket_unavailable", error: err };
    }

    this.stopped = false;
    this.consecutiveFailures = 0;
    this.consecutiveTerminalFailures = 0;
    this.bufferedHints.length = 0;
    if (this.pump.isDisposed()) {
      this.pump = this.createPump();
    }
    this.client?.close();
    this.client = new HerdrSocketClient({ socketPath: this.socketPath, env: this.env });

    if (this.resyncOnStart) {
      await this.performResync("startup");
      if (this.stopped) return { started: false, reason: "stopped" };
    }

    try {
      await this.openStreamWithPrune();
      if (this.stopped) return { started: false, reason: "stopped" };
      this.running = true;
      return { started: true };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.onError?.(error);
      this.stop();
      return { started: false, reason: err instanceof HerdrSocketError ? err.code : "connect_failed", error };
    }
  }

  private async performResync(reason: "startup" | "live_handoff" | "reconnect"): Promise<void> {
    let snapshot: Record<string, unknown> | null = null;
    if (this.client && !this.stopped) {
      try {
        const res = await this.client.sessionSnapshot();
        if (res && typeof res === "object") {
          snapshot = res;
          const paneIds = extractSnapshotPanes(res);
          if (paneIds.length > 0) {
            this.trackedPaneIds.clear();
            for (const id of paneIds) this.trackedPaneIds.add(id);
          }
        }
      } catch {
        // Snapshot may be unavailable on minimal test servers or transient handoff; continue cleanly.
      }
    }
    if (!this.stopped) {
      await this.onResync?.(snapshot, reason);
    }
  }

  private async openStreamWithPrune(): Promise<void> {
    const maxAttempts = Math.max(2, this.trackedPaneIds.size + 2);
    let lastError: unknown = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (this.stopped) return;
      const stream = new HerdrEventStream({ socketPath: this.socketPath, env: this.env });
      this.stream = stream;
      const subs = buildWakeSubscriptions(this.trackedPaneIds);
      try {
        await stream.open(
          subs,
          (msg) => this.handleStreamMessage(msg),
          (err) => this.handleStreamError(err),
        );
        this.consecutiveFailures = 0;
        this.consecutiveTerminalFailures = 0;
        return;
      } catch (err) {
        lastError = err;
        this.stream = null;
        if (err instanceof HerdrSocketError && err.code === "pane_not_found" && this.trackedPaneIds.size > 0) {
          const pruned = await this.pruneMissingPane(err);
          if (pruned) continue;
        }
        throw err;
      }
    }
    this.stream = null;
    throw lastError instanceof Error
      ? lastError
      : new HerdrSocketError("exhausted subscribe retries while pruning missing panes", {
          code: "pane_not_found",
          phase: "rpc",
        });
  }

  private async pruneMissingPane(error: unknown): Promise<boolean> {
    const direct = findMissingPaneFromError(error, this.trackedPaneIds);
    if (direct) {
      this.trackedPaneIds.delete(direct);
      return true;
    }
    if (this.client) {
      try {
        const snap = await this.client.sessionSnapshot();
        const live = new Set(extractSnapshotPanes(snap));
        if (live.size > 0) {
          let removed = false;
          for (const id of [...this.trackedPaneIds]) {
            if (!live.has(id)) {
              this.trackedPaneIds.delete(id);
              removed = true;
            }
          }
          if (removed) return true;
        }
      } catch {
        // Fallback below if snapshot probe fails.
      }
    }
    this.trackedPaneIds.clear();
    return true;
  }

  private handleStreamMessage(msg: Record<string, unknown>): void {
    if (this.stopped) return;

    const errObj = msg.error as { code?: unknown; message?: unknown; data?: unknown; pane_id?: unknown } | undefined;
    if (errObj?.code === "pane_not_found") {
      void this.pruneMissingPane(errObj)
        .then((pruned) => {
          if (pruned && !this.stopped) {
            this.scheduleReconnect(false);
          }
        })
        .catch((err) => {
          this.onError?.(err instanceof Error ? err : new Error(String(err)));
        });
      return;
    }

    const rawType = extractEventType(msg);
    const normalizedType = normalizeEventType(rawType);

    if (isLiveHandoffEvent(rawType, msg)) {
      void this.handleLiveHandoff().catch((err) => {
        this.onError?.(err instanceof Error ? err : new Error(String(err)));
      });
      return;
    }

    if (!WAKE_HINT_SET.has(normalizedType)) {
      return;
    }

    const paneId = extractEventPaneId(msg);
    if ((normalizedType === "pane.closed" || normalizedType === "pane.exited") && paneId) {
      this.trackedPaneIds.delete(paneId);
    } else if (normalizedType === "pane.created" && paneId && !this.trackedPaneIds.has(paneId)) {
      this.trackedPaneIds.add(paneId);
      this.scheduleReconnect(false);
    } else if (normalizedType === "pane.moved") {
      const previousPaneId = extractPreviousPaneId(msg);
      let subscriptionsChanged = false;
      if (previousPaneId && previousPaneId !== paneId && this.trackedPaneIds.delete(previousPaneId)) {
        subscriptionsChanged = true;
      }
      if (paneId && !this.trackedPaneIds.has(paneId)) {
        this.trackedPaneIds.add(paneId);
        subscriptionsChanged = true;
      }
      if (subscriptionsChanged) {
        this.scheduleReconnect(false);
      }
    }

    this.bufferedHints.push({
      type: normalizedType,
      ...(paneId ? { paneId } : {}),
      raw: msg,
    });
    this.pump.trigger(paneId ?? GLOBAL_WAKE_KEY);
  }

  private async handleLiveHandoff(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.performResync("live_handoff");
    } catch (err) {
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (!this.stopped) {
        this.scheduleReconnect(false);
      }
    }
  }

  private handleStreamError(err: Error): void {
    if (this.stopped) return;
    this.onError?.(err);
    if (isTerminalTransportError(err)) {
      this.consecutiveTerminalFailures += 1;
      if (this.consecutiveTerminalFailures >= this.maxConsecutiveFailures) {
        const reason = err instanceof HerdrSocketError ? err.code : ((err as NodeJS.ErrnoException).code || "connect_failed");
        this.stop();
        this.onTerminalStop?.(reason, err);
        return;
      }
    }
    this.scheduleReconnect(true);
  }

  private scheduleReconnect(resync: boolean): void {
    if (this.stopped || this.reconnectTimer) return;
    this.stream?.close();
    this.stream = null;
    const delay = Math.min(
      this.maxReconnectDelayMs,
      this.reconnectDelayMs * 2 ** this.consecutiveFailures,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      void (async () => {
        try {
          if (resync) await this.performResync("reconnect");
          await this.openStreamWithPrune();
        } catch (err) {
          if (this.stopped) return;
          this.consecutiveFailures += 1;
          if (isTerminalTransportError(err)) {
            this.consecutiveTerminalFailures += 1;
          } else {
            this.consecutiveTerminalFailures = 0;
          }
          const error = err instanceof Error ? err : new Error(String(err));
          this.onError?.(error);
          if (this.consecutiveTerminalFailures >= this.maxConsecutiveFailures) {
            const reason =
              err instanceof HerdrSocketError
                ? err.code
                : ((err as NodeJS.ErrnoException | undefined)?.code || "connect_failed");
            this.stop();
            this.onTerminalStop?.(reason, error);
            return;
          }
          this.scheduleReconnect(true);
        }
      })();
    }, delay);
  }

  stop(): void {
    this.stopped = true;
    this.running = false;
    this.bufferedHints.length = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stream?.close();
    this.stream = null;
    this.client?.close();
    this.client = null;
    this.pump.dispose();
  }
}

export interface ClaudeMessagingPushResult {
  sent: boolean;
  reason?: string;
  error?: string;
}

/**
 * Feature-detected wake push for `CLAUDE_CODE_MESSAGING_SOCKET`.
 * Sends a newline-delimited JSON frame when configured and reachable;
 * cleanly returns `{ sent: false, reason: "unsupported" }` when absent.
 */
export async function pushClaudeMessagingSocket(
  env: NodeJS.ProcessEnv = process.env,
  payload: Record<string, unknown>,
  timeoutMs = 1000,
): Promise<ClaudeMessagingPushResult> {
  const socketPath = env.CLAUDE_CODE_MESSAGING_SOCKET?.trim();
  if (!socketPath) return { sent: false, reason: "unsupported" };
  if (isTestGuardActive(env) && (!isAbsolute(socketPath) || !isAllowedTestSocketPath(socketPath))) {
    return { sent: false, reason: "unsupported" };
  }

  return new Promise<ClaudeMessagingPushResult>((resolve) => {
    let settled = false;
    const sock = net.createConnection(socketPath);
    const finish = (result: ClaudeMessagingPushResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.removeAllListeners();
      sock.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ sent: false, reason: "timeout", error: "messaging socket timeout" });
    }, timeoutMs);

    sock.once("connect", () => {
      const frame = `${JSON.stringify(payload)}\n`;
      sock.write(frame, (err) => {
        if (err) {
          finish({ sent: false, reason: (err as NodeJS.ErrnoException).code || "write_error", error: err.message });
        } else {
          sock.end(() => finish({ sent: true }));
        }
      });
    });

    sock.once("error", (err: NodeJS.ErrnoException) => {
      finish({ sent: false, reason: err.code || "connect_error", error: err.message });
    });
  });
}
