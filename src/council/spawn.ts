import { spawn as nodeSpawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { scrubbedEnv } from "./env.js";
import { trackChild } from "./scope.js";

export interface SpawnOptions {
  cwd: string;
  stdin?: string;
  maxBytes?: number;
  killGraceMs?: number;
  lifetimeMs?: number;
  repoRoots?: string[];
  timeoutCommand?: string | null;
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

export function findTimeoutCommand(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "timeout");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

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
  const wrapper = options.lifetimeMs === undefined ? undefined : options.timeoutCommand === undefined ? findTimeoutCommand() : (options.timeoutCommand ?? undefined);
  const full = wrapper && options.lifetimeMs !== undefined ? [wrapper, "-k", "1", String(Math.max(1, Math.ceil(options.lifetimeMs / 1000))), ...argv] : [...argv];
  const [bin, ...args] = full;
  const limit = options.maxBytes ?? MAX_CAPTURE_BYTES;
  const grace = options.killGraceMs ?? KILL_GRACE_MS;
  const child = nodeSpawn(bin, args, {
    cwd: options.cwd,
    env: scrubbedEnv(options.cwd, options.repoRoots).env,
    detached: true,
    stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  const untrack = trackChild(child);
  const stdout = new Capture(limit);
  const stderr = new Capture(limit);
  const result = new Promise<ProcessOutput>((resolve) => {
    let settled = false;
    const finish = (exitCode: number, extra = "") => {
      if (settled) return;
      settled = true;
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
      signalGroup("SIGTERM");
      setTimeout(() => {
        signalGroup("SIGKILL");
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.stdin?.destroy();
        child.unref();
        untrack();
      }, grace);
    },
  };
};
