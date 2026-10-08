import { spawn as nodeSpawn } from "node:child_process";

export interface SpawnOptions {
  cwd: string;
  stdin?: string;
}

export interface ProcessOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SpawnedProcess {
  result: Promise<ProcessOutput>;
  kill(): void;
}

export type SpawnFn = (argv: readonly string[], options: SpawnOptions) => SpawnedProcess;

const MAX_CAPTURE = 8 * 1024 * 1024;

export const defaultSpawn: SpawnFn = (argv, options) => {
  const [bin, ...args] = argv;
  const child = nodeSpawn(bin, args, {
    cwd: options.cwd,
    detached: true,
    stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const result = new Promise<ProcessOutput>((resolve) => {
    let settled = false;
    const finish = (exitCode: number, extra = "") => {
      if (settled) return;
      settled = true;
      resolve({ exitCode, stdout, stderr: extra ? `${stderr}${extra}` : stderr });
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_CAPTURE) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_CAPTURE) stderr += chunk.toString("utf8");
    });
    child.on("error", (error: NodeJS.ErrnoException) => finish(error.code === "ENOENT" ? 127 : 126, `${error.code ?? ""} ${error.message}`.trim()));
    child.on("close", (code) => finish(code ?? 1));
  });
  if (options.stdin !== undefined && child.stdin) {
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.stdin);
  }
  return {
    result,
    kill() {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          return;
        }
      }
    },
  };
};
