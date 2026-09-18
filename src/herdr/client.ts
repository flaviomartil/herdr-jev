import { spawn } from "node:child_process";
import type { HerdrCommandResult } from "../types/index.js";

export type RunCommand = (argv: readonly string[]) => Promise<HerdrCommandResult>;

export type HerdrAgentState = "idle" | "working" | "blocked" | "done" | "unknown";

export interface HerdrClient {
  splitCurrent(options?: { direction?: "right" | "down" }): Promise<HerdrCommandResult>;
  startAgent(input: {
    name: string;
    kind: "claude" | "codex" | "cursor" | "opencode" | "agy" | "kimi";
    paneId: string;
    agentArgs: string[];
  }): Promise<HerdrCommandResult>;
  prompt(input: {
    target: string;
    text: string;
    wait?: boolean;
    until?: HerdrAgentState[];
    timeoutMs?: number;
  }): Promise<HerdrCommandResult>;
  waitFor(input: {
    target: string;
    until?: HerdrAgentState[];
    timeoutMs?: number;
  }): Promise<HerdrCommandResult>;
  closePane(paneId: string): Promise<HerdrCommandResult>;
  notify(title: string, body: string, sound?: string): Promise<HerdrCommandResult>;
}

export function createProcessCommandAdapter(
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): RunCommand {
  const timeoutMs = options.timeoutMs ?? 60_000;
  return (argv) =>
    new Promise((resolve) => {
      const [command, ...args] = argv;
      if (!command) {
        resolve({ ok: false, code: 1, stdout: "", stderr: "missing command" });
        return;
      }
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: options.env ?? process.env });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ ok: false, code: 1, stdout, stderr: String(error) });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const exit = code ?? 1;
        resolve({ ok: exit === 0, code: exit, stdout, stderr });
      });
    });
}

function buildStateArgs(until: HerdrAgentState[] = [], timeoutMs?: number): string[] {
  return [
    ...until.flatMap((state) => ["--until", state]),
    ...(timeoutMs === undefined ? [] : ["--timeout", String(timeoutMs)]),
  ];
}

export function createHerdrClient(runCommand: RunCommand = createProcessCommandAdapter()): HerdrClient {
  const herdrBin = process.env.HERDR_BIN_PATH || "herdr";

  return {
    splitCurrent(options) {
      return runCommand([
        herdrBin,
        "pane",
        "split",
        "--current",
        "--direction",
        options?.direction ?? "right",
        "--no-focus",
      ]);
    },
    startAgent(input) {
      return runCommand([
        herdrBin,
        "agent",
        "start",
        input.name,
        "--kind",
        input.kind,
        "--pane",
        input.paneId,
        "--",
        ...input.agentArgs,
      ]);
    },
    prompt(input) {
      const argv = [herdrBin, "agent", "prompt", input.target, input.text];
      if (input.wait === true) {
        argv.push("--wait", ...buildStateArgs(input.until, input.timeoutMs));
      }
      return runCommand(argv);
    },
    waitFor(input) {
      return runCommand([
        herdrBin,
        "agent",
        "wait",
        input.target,
        ...buildStateArgs(input.until, input.timeoutMs),
      ]);
    },
    closePane(paneId) {
      return runCommand([herdrBin, "pane", "close", paneId]);
    },
    notify(title, body, sound = "none") {
      return runCommand([herdrBin, "notification", "show", title, "--body", body, "--sound", sound]);
    },
  };
}
