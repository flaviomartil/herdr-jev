import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProcessOutput, SpawnedProcess, SpawnFn, SpawnOptions } from "../src/council/spawn.js";

export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

export function writeIn(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

export function makeRepo(): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "council-repo-")));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "core.excludesFile", "/dev/null");
  writeIn(repo, "src/a.ts", "export const a = 1;\n");
  writeIn(repo, "README.md", "readme\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  return repo;
}

export interface Call {
  argv: string[];
  cwd: string;
  stdin?: string;
  killed: boolean;
}

export type Handler = (call: Call) => ProcessOutput | Promise<ProcessOutput> | "hang";

export interface FakeSpawn {
  spawn: SpawnFn;
  calls: Call[];
  reviewCalls: Call[];
}

export function fakeSpawn(handlers: Record<string, Handler>, installed: string[] = Object.keys(handlers)): FakeSpawn {
  const calls: Call[] = [];
  const spawn: SpawnFn = (argv: readonly string[], options: SpawnOptions): SpawnedProcess => {
    const call: Call = { argv: [...argv], cwd: options.cwd, stdin: options.stdin, killed: false };
    calls.push(call);
    const bin = argv[0];
    if (argv[1] === "--version") {
      return { result: Promise.resolve({ exitCode: installed.includes(bin) ? 0 : 127, stdout: installed.includes(bin) ? "1.0.0\n" : "", stderr: "" }), kill() {} };
    }
    let release: (output: ProcessOutput) => void = () => {};
    const killedResult = new Promise<ProcessOutput>((resolve) => {
      release = resolve;
    });
    const handled = handlers[bin]?.(call);
    const result = handled === "hang" || handled === undefined ? killedResult : Promise.resolve(handled);
    return {
      result,
      kill() {
        call.killed = true;
        release({ exitCode: 137, stdout: "", stderr: "killed" });
      },
    };
  };
  return { spawn, calls, get reviewCalls() { return calls.filter((call) => call.argv[1] !== "--version"); } };
}

export const ok = (stdout: string): ProcessOutput => ({ exitCode: 0, stdout, stderr: "" });
