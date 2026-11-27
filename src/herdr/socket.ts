import { existsSync, realpathSync } from "node:fs";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { resolveFakeBinDir } from "./client.js";
import { isTestGuardActive } from "./state-dir.js";

export type HerdrSocketPhase = "connect" | "io" | "rpc" | "timeout";

export class HerdrSocketError extends Error {
  readonly code: string;
  readonly phase: HerdrSocketPhase;

  constructor(
    message: string,
    options: { code: string; phase: HerdrSocketPhase; cause?: unknown },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "HerdrSocketError";
    this.code = options.code;
    this.phase = options.phase;
  }
}

function resolveWithExistingAncestor(targetPath: string): string {
  const abs = resolve(targetPath);
  if (existsSync(abs)) {
    try {
      return realpathSync(abs);
    } catch {
      return abs;
    }
  }
  const suffix: string[] = [];
  let cursor = abs;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return abs;
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
  try {
    return join(realpathSync(cursor), ...suffix);
  } catch {
    return abs;
  }
}

function isWithinDir(candidate: string, root: string): boolean {
  const normalizedRoot = root.endsWith(sep) ? root : root + sep;
  return candidate.startsWith(normalizedRoot);
}

export function isAllowedTestSocketPath(candidatePath: string): boolean {
  if (!isAbsolute(candidatePath)) return false;
  const resolved = resolveWithExistingAncestor(candidatePath);
  const allowedRoots: string[] = [resolveFakeBinDir()];
  try {
    allowedRoots.push(realpathSync(tmpdir()));
  } catch {
    allowedRoots.push(resolve(tmpdir()));
  }
  return allowedRoots.some((root) => isWithinDir(resolved, root));
}

export function resolveHerdrSocketPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.HERDR_SOCKET_PATH?.trim();
  const testGuard = isTestGuardActive(env);
  if (override) {
    if (testGuard) {
      return isAllowedTestSocketPath(override) ? override : null;
    }
    return override;
  }
  if (testGuard) return null;
  const base = join(env.HOME?.trim() || homedir(), ".config", "herdr");
  const session = env.HERDR_SESSION?.trim();
  return session ? join(base, "sessions", session, "herdr.sock") : join(base, "herdr.sock");
}

export interface HerdrSocketClientOptions {
  socketPath?: string | null;
  env?: NodeJS.ProcessEnv;
  maxConcurrent?: number;
  maxLineBytes?: number;
  defaultTimeoutMs?: number;
}

export interface HerdrPongResult {
  type?: string;
  version?: string;
  protocol: number;
  capabilities?: Record<string, unknown> | null;
}

const DEFAULT_MAX_CONCURRENT = 16;
const DEFAULT_MAX_LINE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;
const MIN_HERDR_PROTOCOL = 22;

const protocolCache = new Map<string, number>();

export function clearHerdrProtocolCache(socketPath?: string): void {
  if (socketPath === undefined) protocolCache.clear();
  else protocolCache.delete(socketPath);
}

export class HerdrSocketClient {
  readonly socketPath: string | null;
  private readonly maxConcurrent: number;
  private readonly maxLineBytes: number;
  private readonly defaultTimeoutMs: number;
  private seq = 0;
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private readonly liveSockets = new Set<net.Socket>();
  private closed = false;

  constructor(options: HerdrSocketClientOptions = {}) {
    const env = options.env ?? process.env;
    if (options.socketPath !== undefined) {
      if (options.socketPath === null) {
        this.socketPath = null;
      } else if (isTestGuardActive(env) && !isAllowedTestSocketPath(options.socketPath)) {
        this.socketPath = null;
      } else {
        this.socketPath = options.socketPath;
      }
    } else {
      this.socketPath = resolveHerdrSocketPath(env);
    }
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
    this.maxLineBytes = Math.max(1024, options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES);
    this.defaultTimeoutMs = Math.max(1, options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  private acquireSlot(): Promise<void> {
    if (this.closed) {
      return Promise.reject(
        new HerdrSocketError("herdr socket client is closed", { code: "client_closed", phase: "io" }),
      );
    }
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  private releaseSlot(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.active = Math.max(0, this.active - 1);
    }
  }

  async request<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = this.defaultTimeoutMs,
  ): Promise<T> {
    if (!this.socketPath) {
      throw new HerdrSocketError("herdr socket unavailable", {
        code: "socket_unavailable",
        phase: "connect",
      });
    }
    await this.acquireSlot();
    try {
      if (this.closed) {
        throw new HerdrSocketError("herdr socket client is closed", {
          code: "client_closed",
          phase: "io",
        });
      }
      return await this.sendOnce<T>(this.socketPath, method, params, timeoutMs);
    } finally {
      this.releaseSlot();
    }
  }

  private sendOnce<T>(
    socketPath: string,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<T> {
    const id = `jev-${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      let sock: net.Socket | null = null;
      let connected = false;
      let settled = false;
      const chunks: Buffer[] = [];
      let bufferedBytes = 0;

      const finish = (err: HerdrSocketError | null, result?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (sock) {
          this.liveSockets.delete(sock);
          sock.removeAllListeners();
          sock.destroy();
          sock = null;
        }
        if (err) reject(err);
        else resolve(result as T);
      };

      const timer = setTimeout(() => {
        finish(
          new HerdrSocketError(`timeout waiting for ${method}`, {
            code: "timeout",
            phase: "timeout",
          }),
        );
      }, timeoutMs);

      sock = net.createConnection(socketPath);
      this.liveSockets.add(sock);

      sock.once("connect", () => {
        if (settled || !sock) return;
        connected = true;
        sock.write(`${JSON.stringify({ id, method, params })}\n`);
      });

      sock.on("data", (chunk: Buffer | string) => {
        if (settled) return;
        const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
        chunks.push(buf);
        bufferedBytes += buf.length;

        let full = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, bufferedBytes);
        let nlIdx = full.indexOf(0x0a);

        while (nlIdx >= 0 && !settled) {
          if (nlIdx > this.maxLineBytes) {
            finish(
              new HerdrSocketError(`response line exceeded maxLineBytes (${this.maxLineBytes})`, {
                code: "line_too_large",
                phase: "io",
              }),
            );
            return;
          }

          const line = full.subarray(0, nlIdx).toString("utf8").trim();
          full = full.subarray(nlIdx + 1);
          chunks.length = 0;
          bufferedBytes = full.length;
          if (full.length > 0) chunks.push(full);

          if (!line) {
            nlIdx = full.indexOf(0x0a);
            continue;
          }

          let msg: Record<string, unknown>;
          try {
            const parsed = JSON.parse(line);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
              throw new Error("response is not a JSON object");
            }
            msg = parsed as Record<string, unknown>;
          } catch (err) {
            finish(
              new HerdrSocketError("invalid JSON response from herdr", {
                code: "invalid_json",
                phase: "io",
                cause: err,
              }),
            );
            return;
          }

          if (msg.id !== id) {
            finish(
              new HerdrSocketError(`response id mismatch: expected ${id}, got ${String(msg.id)}`, {
                code: "id_mismatch",
                phase: "rpc",
              }),
            );
            return;
          }

          const hasResult = Object.prototype.hasOwnProperty.call(msg, "result") && msg.result !== undefined;
          const hasError = Object.prototype.hasOwnProperty.call(msg, "error") && msg.error !== undefined && msg.error !== null;
          if (hasResult === hasError) {
            finish(
              new HerdrSocketError("herdr response must contain result XOR error", {
                code: "invalid_response",
                phase: "rpc",
              }),
            );
            return;
          }

          if (hasError) {
            const errObj = msg.error as { code?: unknown; message?: unknown };
            const code = typeof errObj?.code === "string" && errObj.code ? errObj.code : "rpc_error";
            const message = typeof errObj?.message === "string" && errObj.message ? errObj.message : "herdr api error";
            finish(new HerdrSocketError(message, { code, phase: "rpc" }));
            return;
          }

          finish(null, msg.result as T);
          return;
        }

        if (!settled && bufferedBytes > this.maxLineBytes) {
          finish(
            new HerdrSocketError(`response exceeded maxLineBytes (${this.maxLineBytes})`, {
              code: "line_too_large",
              phase: "io",
            }),
          );
        }
      });

      sock.on("error", (err: NodeJS.ErrnoException) => {
        const code = typeof err.code === "string" && err.code ? err.code : connected ? "io_error" : "connect_error";
        finish(
          new HerdrSocketError(err.message || "herdr socket error", {
            code,
            phase: connected ? "io" : "connect",
            cause: err,
          }),
        );
      });

      sock.on("close", () => {
        finish(
          new HerdrSocketError("herdr socket closed before it answered", {
            code: "unexpected_eof",
            phase: connected ? "io" : "connect",
          }),
        );
      });
    });
  }

  ping(timeoutMs?: number): Promise<HerdrPongResult> {
    return this.request<HerdrPongResult>("ping", {}, timeoutMs);
  }

  async ensureProtocol(minProtocol: number = MIN_HERDR_PROTOCOL): Promise<number> {
    if (!this.socketPath) {
      throw new HerdrSocketError("herdr socket unavailable", {
        code: "socket_unavailable",
        phase: "connect",
      });
    }
    let protocol = protocolCache.get(this.socketPath);
    if (protocol === undefined) {
      const pong = await this.ping();
      const parsed = pong?.protocol;
      if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
        throw new HerdrSocketError("herdr ping response missing numeric protocol version", {
          code: "invalid_response",
          phase: "rpc",
        });
      }
      protocol = parsed;
      protocolCache.set(this.socketPath, protocol);
    }
    if (protocol < minProtocol) {
      throw new HerdrSocketError(
        `herdr protocol ${protocol} is below minimum required ${minProtocol}`,
        { code: "unsupported_protocol", phase: "rpc" },
      );
    }
    return protocol;
  }

  paneFocus(paneId: string) {
    return this.request("pane.focus", { pane_id: paneId });
  }

  paneGet(paneId: string) {
    return this.request("pane.get", { pane_id: paneId });
  }

  paneList(workspaceId?: string) {
    return this.request("pane.list", workspaceId ? { workspace_id: workspaceId } : {});
  }

  paneLayout(paneId?: string) {
    return this.request("pane.layout", paneId ? { pane_id: paneId } : {});
  }

  paneMove(params: { pane_id: string; destination: unknown; focus?: boolean }) {
    return this.request("pane.move", params as Record<string, unknown>);
  }

  paneProcessInfo(paneId?: string) {
    return this.request("pane.process_info", paneId ? { pane_id: paneId } : {});
  }

  paneClose(paneId: string) {
    return this.request("pane.close", { pane_id: paneId });
  }

  layoutExport(params?: { pane_id?: string | null; tab_id?: string | null }) {
    return this.request("layout.export", (params ?? {}) as Record<string, unknown>);
  }

  layoutApply(params: {
    root: unknown;
    tab_id?: string | null;
    tab_label?: string | null;
    workspace_id?: string | null;
    focus?: boolean;
  }) {
    return this.request("layout.apply", params as Record<string, unknown>);
  }

  worktreeList(params?: { cwd?: string | null; trust_repository?: boolean; workspace_id?: string | null }) {
    return this.request("worktree.list", (params ?? {}) as Record<string, unknown>);
  }

  worktreeCreate(params: {
    base?: string | null;
    branch?: string | null;
    cwd?: string | null;
    focus?: boolean;
    label?: string | null;
    path?: string | null;
    trust_repository?: boolean;
    workspace_id?: string | null;
  }) {
    return this.request("worktree.create", params as Record<string, unknown>);
  }

  worktreeOpen(params: {
    branch?: string | null;
    cwd?: string | null;
    focus?: boolean;
    label?: string | null;
    path?: string | null;
    trust_repository?: boolean;
    workspace_id?: string | null;
  }) {
    return this.request("worktree.open", params as Record<string, unknown>);
  }

  sessionSnapshot() {
    return this.request("session.snapshot", {});
  }

  apiSchema() {
    return this.request("api.schema", {});
  }

  close(): void {
    this.closed = true;
    for (const sock of this.liveSockets) {
      sock.destroy();
    }
    this.liveSockets.clear();
    while (this.queue.length > 0) {
      const next = this.queue.shift();
      next?.();
    }
  }
}

export interface HerdrEventStreamOptions {
  socketPath?: string | null;
  env?: NodeJS.ProcessEnv;
  maxLineBytes?: number;
  ackTimeoutMs?: number;
}

export class HerdrEventStream {
  readonly socketPath: string | null;
  private readonly maxLineBytes: number;
  private readonly ackTimeoutMs: number;
  private sock: net.Socket | null = null;
  private closed = false;
  private seq = 0;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingReject: ((err: HerdrSocketError) => void) | null = null;

  constructor(options: HerdrEventStreamOptions = {}) {
    const env = options.env ?? process.env;
    if (options.socketPath !== undefined) {
      if (options.socketPath === null) {
        this.socketPath = null;
      } else if (isTestGuardActive(env) && !isAllowedTestSocketPath(options.socketPath)) {
        this.socketPath = null;
      } else {
        this.socketPath = options.socketPath;
      }
    } else {
      this.socketPath = resolveHerdrSocketPath(env);
    }
    this.maxLineBytes = Math.max(1024, options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES);
    this.ackTimeoutMs = Math.max(1, options.ackTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  open(
    subs: ReadonlyArray<string | Record<string, unknown>>,
    onEvent: (event: Record<string, unknown>) => void,
    onError?: (error: Error) => void,
  ): Promise<this> {
    if (!this.socketPath) {
      return Promise.reject(
        new HerdrSocketError("herdr socket unavailable", {
          code: "socket_unavailable",
          phase: "connect",
        }),
      );
    }
    this.close();
    this.closed = false;

    const id = `jev-events-${++this.seq}`;
    const subscriptions = subs.map((s) => (typeof s === "string" ? { type: s } : s));
    const socketPath = this.socketPath;

    return new Promise<this>((resolve, reject) => {
      let acked = false;
      let connected = false;
      let settled = false;
      const chunks: Buffer[] = [];
      let bufferedBytes = 0;

      const sock = net.createConnection(socketPath);
      this.sock = sock;

      const failOpen = (err: HerdrSocketError) => {
        if (settled) return;
        settled = true;
        if (this.pendingTimer) {
          clearTimeout(this.pendingTimer);
          this.pendingTimer = null;
        }
        this.pendingReject = null;
        this.close();
        reject(err);
      };

      this.pendingReject = (err: HerdrSocketError) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      this.pendingTimer = setTimeout(() => {
        failOpen(
          new HerdrSocketError("timeout waiting for events.subscribe ack", {
            code: "timeout",
            phase: "timeout",
          }),
        );
      }, this.ackTimeoutMs);

      sock.once("connect", () => {
        if (this.closed || settled) return;
        connected = true;
        sock.write(
          `${JSON.stringify({ id, method: "events.subscribe", params: { subscriptions } })}\n`,
        );
      });

      sock.on("data", (chunk: Buffer | string) => {
        if (this.closed) return;
        const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
        chunks.push(buf);
        bufferedBytes += buf.length;

        let full = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, bufferedBytes);
        let nlIdx = full.indexOf(0x0a);

        while (nlIdx >= 0 && !this.closed) {
          if (nlIdx > this.maxLineBytes) {
            const err = new HerdrSocketError(`event stream line exceeded maxLineBytes (${this.maxLineBytes})`, {
              code: "line_too_large",
              phase: "io",
            });
            if (!acked) failOpen(err);
            else {
              this.close();
              onError?.(err);
            }
            return;
          }
          const line = full.subarray(0, nlIdx).toString("utf8").trim();
          full = full.subarray(nlIdx + 1);
          chunks.length = 0;
          bufferedBytes = full.length;
          if (full.length > 0) chunks.push(full);

          if (line) {
            let msg: Record<string, unknown>;
            try {
              const parsed = JSON.parse(line);
              if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                throw new Error("event line is not a JSON object");
              }
              msg = parsed as Record<string, unknown>;
            } catch (err) {
              const sockErr = new HerdrSocketError("invalid JSON from event stream", {
                code: "invalid_json",
                phase: "io",
                cause: err,
              });
              if (!acked) {
                failOpen(sockErr);
                return;
              }
              onError?.(sockErr);
              nlIdx = full.indexOf(0x0a);
              continue;
            }

            if (!acked) {
              if (msg.id !== id) {
                failOpen(
                  new HerdrSocketError(`event subscribe ack id mismatch: expected ${id}, got ${String(msg.id)}`, {
                    code: "id_mismatch",
                    phase: "rpc",
                  }),
                );
                return;
              }
              if (msg.error) {
                const errObj = msg.error as { code?: unknown; message?: unknown };
                failOpen(
                  new HerdrSocketError(
                    typeof errObj?.message === "string" ? errObj.message : "events.subscribe failed",
                    {
                      code: typeof errObj?.code === "string" ? errObj.code : "rpc_error",
                      phase: "rpc",
                    },
                  ),
                );
                return;
              }
              acked = true;
              settled = true;
              if (this.pendingTimer) {
                clearTimeout(this.pendingTimer);
                this.pendingTimer = null;
              }
              this.pendingReject = null;
              resolve(this);
            } else {
              onEvent(msg);
            }
          }
          nlIdx = full.indexOf(0x0a);
        }

        if (!this.closed && bufferedBytes > this.maxLineBytes) {
          const err = new HerdrSocketError(`event stream line exceeded maxLineBytes (${this.maxLineBytes})`, {
            code: "line_too_large",
            phase: "io",
          });
          if (!acked) failOpen(err);
          else {
            this.close();
            onError?.(err);
          }
        }
      });

      sock.on("error", (err: NodeJS.ErrnoException) => {
        if (this.closed) return;
        const sockErr = new HerdrSocketError(err.message || "herdr event stream error", {
          code: typeof err.code === "string" && err.code ? err.code : connected ? "io_error" : "connect_error",
          phase: connected ? "io" : "connect",
          cause: err,
        });
        if (!acked) {
          failOpen(sockErr);
        } else {
          this.close();
          onError?.(sockErr);
        }
      });

      sock.on("close", () => {
        if (this.closed) return;
        const sockErr = new HerdrSocketError("event stream closed", {
          code: "unexpected_eof",
          phase: connected ? "io" : "connect",
        });
        if (!acked) {
          failOpen(sockErr);
        } else {
          this.sock = null;
          onError?.(sockErr);
        }
      });
    });
  }

  close(): void {
    this.closed = true;
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    const rejectPending = this.pendingReject;
    this.pendingReject = null;
    if (this.sock) {
      this.sock.removeAllListeners();
      this.sock.destroy();
      this.sock = null;
    }
    rejectPending?.(new HerdrSocketError("aborted", { code: "aborted", phase: "io" }));
  }
}
