import { spawn as nodeSpawn } from "node:child_process";
import { cleanEnv } from "./env.js";
import { trackChild } from "./scope.js";

export interface SpawnOptions {
  cwd: string;
  stdin?: string;
  maxBytes?: number;
  killGraceMs?: number;
}

export interface ProcessOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated?: boolean;
}

export interface SpawnedProcess {
  result: Promise<ProcessOutput>;
  kill(): void;
}

export type SpawnFn = (argv: readonly string[], options: SpawnOptions) => SpawnedProcess;

export const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
export const KILL_GRACE_MS = 1500;

class Capture {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    const room = this.limit - this.size;
    if (chunk.length > room) {
      if (room > 0) this.chunks.push(chunk.subarray(0, room));
      this.size += Math.max(room, 0);
      this.truncated = true;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

export const defaultSpawn: SpawnFn = (argv, options) => {
  const [bin, ...args] = argv;
  const limit = options.maxBytes ?? MAX_CAPTURE_BYTES;
  const grace = options.killGraceMs ?? KILL_GRACE_MS;
  const child = nodeSpawn(bin, args, {
    cwd: options.cwd,
    env: cleanEnv(),
    detached: true,
    stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  const untrack = trackChild(child);
  const stdout = new Capture(limit);
  const stderr = new Capture(limit);
  let closed = false;
  const result = new Promise<ProcessOutput>((resolve) => {
    let settled = false;
    const finish = (exitCode: number, extra = "") => {
      if (settled) return;
      settled = true;
      closed = true;
      untrack();
      const errText = stderr.text();
      resolve({
        exitCode,
        stdout: stdout.text(),
        stderr: extra ? `${errText}${errText ? "\n" : ""}${extra}` : errText,
        ...(stdout.truncated || stderr.truncated ? { truncated: true } : {}),
      });
    };
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error: NodeJS.ErrnoException) => finish(error.code === "ENOENT" ? 127 : 126, `${error.code ?? ""} ${error.message}`.trim()));
    child.on("close", (code) => finish(code ?? 1));
  });
  if (options.stdin !== undefined && child.stdin) {
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.stdin);
  }
  const signalGroup = (signal: NodeJS.Signals) => {
    const pid = child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        return;
      }
    }
  };
  return {
    result,
    kill() {
      if (closed) return;
      signalGroup("SIGTERM");
      const timer = setTimeout(() => {
        if (!closed) signalGroup("SIGKILL");
      }, grace);
      timer.unref();
    },
  };
};
