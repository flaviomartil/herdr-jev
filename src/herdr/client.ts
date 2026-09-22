import { spawn } from "node:child_process";
import type { HerdrCommandResult } from "../types/index.js";

export type RunCommand = (argv: readonly string[]) => Promise<HerdrCommandResult>;

export type HerdrAgentState = "idle" | "working" | "blocked" | "done" | "unknown";
export type HerdrCompletionState = "blocked" | "done" | "unknown";
export type HerdrObservedState = HerdrAgentState | "pending" | "timeout";
const HERDR_COMPLETION_STATES: readonly HerdrCompletionState[] = ["done", "blocked", "unknown"];

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
    until?: HerdrCompletionState[];
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

function completionStateArgs(until?: readonly HerdrAgentState[], timeoutMs?: number): string[] {
  const requested = (until ?? []).filter((state): state is HerdrCompletionState => HERDR_COMPLETION_STATES.includes(state as HerdrCompletionState));
  return buildStateArgs(requested.length > 0 ? requested : [...HERDR_COMPLETION_STATES], timeoutMs);
}

export function readHerdrObservedState(result: HerdrCommandResult): HerdrObservedState | null {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (/\b(?:timeout|timed[ -]?out)\b/.test(output)) return "timeout";
  if (/\bpending\b/.test(output)) return "pending";
  try {
    const parsed = JSON.parse(result.stdout) as {
      state?: unknown;
      status?: unknown;
      agent_status?: unknown;
      agent?: { agent_status?: unknown; status?: unknown };
      result?: {
        state?: unknown;
        status?: unknown;
        agent_status?: unknown;
        agent?: { agent_status?: unknown; status?: unknown };
      };
    };
    const state = parsed.result?.agent?.agent_status
      ?? parsed.result?.agent?.status
      ?? parsed.result?.agent_status
      ?? parsed.result?.state
      ?? parsed.result?.status
      ?? parsed.agent?.agent_status
      ?? parsed.agent?.status
      ?? parsed.agent_status
      ?? parsed.state
      ?? parsed.status;
    if (state === "idle" || state === "working" || state === "blocked" || state === "done" || state === "unknown") return state;
  } catch {
  }
  for (const state of ["blocked", "done", "unknown", "working", "idle"] as const) {
    if (new RegExp(`\\b${state}\\b`).test(output)) return state;
  }
  return null;
}

export function classifyHerdrCommandFailure(result: HerdrCommandResult): "rejected" | "unknown" {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return /(?:transport|timeout|timed[ -]?out|econn|eof|socket|spawn|enoent|closed)/.test(output) ? "unknown" : "rejected";
}

function waitResult(result: HerdrCommandResult): HerdrCommandResult {
  if (!result.ok) return result;
  const state = readHerdrObservedState(result);
  if (state === "done" || state === "blocked" || state === "unknown") return result;
  return {
    ...result,
    ok: false,
    stderr: result.stderr || (state === null ? "completion_state_unrecognized" : `completion_state_${state}`),
  };
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
        argv.push("--wait", ...completionStateArgs(input.until, input.timeoutMs));
        return runCommand(argv).then(waitResult);
      }
      return runCommand(argv);
    },
    waitFor(input) {
      return runCommand([
        herdrBin,
        "agent",
        "wait",
        input.target,
        ...completionStateArgs(input.until, input.timeoutMs),
      ]).then(waitResult);
    },
    closePane(paneId) {
      return runCommand([herdrBin, "pane", "close", paneId]);
    },
    notify(title, body, sound = "none") {
      return runCommand([herdrBin, "notification", "show", title, "--body", body, "--sound", sound]);
    },
  };
}
