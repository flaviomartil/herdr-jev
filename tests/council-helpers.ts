import { setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProcessOutput, SpawnedProcess, SpawnFn, SpawnOptions } from "../src/council/spawn.js";

setDefaultTimeout(30000);

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

export function gitRaw(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

export function git(cwd: string, ...args: string[]): string {
  return gitRaw(cwd, ...args).trim();
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
  lifetimeMs?: number;
  timeoutCommand?: string | null;
  killed: boolean;
}

export type Handler = (call: Call) => ProcessOutput | Promise<ProcessOutput> | "hang";

export interface FakeSpawnOptions {
  installed?: string[];
  versions?: Record<string, string>;
  hangProbe?: string[];
  onProbe?: (bin: string) => void;
}

export interface FakeSpawn {
  spawn: SpawnFn;
  calls: Call[];
  readonly reviewCalls: Call[];
  readonly probeCalls: Call[];
}

const DEFAULT_VERSIONS: Record<string, string> = { codex: "codex-cli 0.160.1\n", kimi: "2.1.1\n", agy: "1.3.1\n" };

export function fakeSpawn(handlers: Record<string, Handler>, options: FakeSpawnOptions = {}): FakeSpawn {
  const installed = options.installed ?? Object.keys(handlers);
  const calls: Call[] = [];
  const spawn: SpawnFn = (argv: readonly string[], spawnOptions: SpawnOptions): SpawnedProcess => {
    const call: Call = { argv: [...argv], cwd: spawnOptions.cwd, stdin: spawnOptions.stdin, lifetimeMs: spawnOptions.lifetimeMs, timeoutCommand: spawnOptions.timeoutCommand, killed: false };
    calls.push(call);
    const bin = argv[0];
    let release: (output: ProcessOutput) => void = () => {};
    const held = new Promise<ProcessOutput>((resolve) => {
      release = resolve;
    });
    const kill = () => {
      call.killed = true;
      release({ exitCode: 137, stdout: "", stderr: "killed" });
    };
    if (argv[1] === "--version") {
      options.onProbe?.(bin);
      if (options.hangProbe?.includes(bin)) return { result: held, kill };
      const ok = installed.includes(bin);
      const version = options.versions?.[bin] ?? DEFAULT_VERSIONS[bin] ?? "1.0.0\n";
      return { result: Promise.resolve({ exitCode: ok ? 0 : 127, stdout: ok ? version : "", stderr: "" }), kill };
    }
    const handled = handlers[bin]?.(call);
    const result = handled === "hang" || handled === undefined ? held : Promise.resolve(handled);
    return { result, kill };
  };
  return {
    spawn,
    calls,
    get reviewCalls() {
      return calls.filter((call) => call.argv[1] !== "--version");
    },
    get probeCalls() {
      return calls.filter((call) => call.argv[1] === "--version");
    },
  };
}

export const ok = (stdout: string): ProcessOutput => ({ exitCode: 0, stdout, stderr: "" });
