import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrCommandResult } from "../types/index.js";

export type RunCommand = (argv: readonly string[]) => Promise<HerdrCommandResult>;

export type HerdrAgentState = "idle" | "working" | "blocked" | "done" | "unknown";
export type HerdrCompletionState = "blocked" | "done" | "unknown";
export type HerdrObservedState = HerdrAgentState | "pending" | "timeout";
const HERDR_COMPLETION_STATES: readonly HerdrCompletionState[] = ["done", "blocked", "unknown"];

export interface HerdrClient {
  splitCurrent(options?: { direction?: "right" | "down"; paneId?: string; cwd?: string; ratio?: number }): Promise<HerdrCommandResult>;
  paneLayout?(paneId?: string): Promise<HerdrCommandResult>;
  listPanes?(): Promise<HerdrCommandResult>;
  createTab?(options: { label: string; cwd: string; workspaceId?: string }): Promise<HerdrCommandResult>;
  startAgent(input: {
    name: string;
    kind: "claude" | "codex" | "cursor" | "opencode" | "agy" | "kimi" | "kiro";
    paneId: string;
    agentArgs: string[];
  }): Promise<HerdrCommandResult>;
  prompt(input: {
    target: string;
    text: string;
    wait?: boolean;
    waitForStart?: boolean;
    waitForReply?: boolean;
    until?: HerdrAgentState[];
    timeoutMs?: number;
  }): Promise<HerdrCommandResult>;
  waitFor(input: {
    target: string;
    until?: HerdrCompletionState[];
    timeoutMs?: number;
    waitForReply?: boolean;
  }): Promise<HerdrCommandResult>;
  closePane(paneId: string): Promise<HerdrCommandResult>;
  readAgent?(target: string, lines?: number, source?: "visible" | "recent"): Promise<HerdrCommandResult>;
  readPane?(paneId: string, lines?: number): Promise<HerdrCommandResult>;
  getAgent?(target: string): Promise<HerdrCommandResult>;
  reportSpawn?(paneId: string, tokens: Record<string, string>): Promise<HerdrCommandResult>;
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
      if (process.env.HERDR_JEV_TEST_GUARD === '1' && (command === "herdr" || command.endsWith("/herdr") || command === process.env.HERDR_BIN_PATH)) {
        let isTempBin = false;
        try {
          const { realpathSync } = require("node:fs");
          const { tmpdir } = require("node:os");
          const { sep } = require("node:path");
          isTempBin = realpathSync(command).startsWith(realpathSync(tmpdir()) + sep);
        } catch {}
        if (!isTempBin) {
          const cmdPath = args.join(" ");
          const isReadOnly = /^(?:agent|pane) (?:get|list|read|layout|current)\b/.test(cmdPath);
          if (!isReadOnly) {
            resolve({ ok: false, code: 126, stdout: "", stderr: "blocked_by_test_guard" });
            return;
          }
        }
      }
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: options.env ?? process.env });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const nativeTimeout = Number(args[args.indexOf("--timeout") + 1]);
      const deadline = args.includes("--timeout") && Number.isSafeInteger(nativeTimeout) && nativeTimeout > 0
        ? Math.max(timeoutMs, nativeTimeout + 2000) : timeoutMs;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, deadline);

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
        resolve({ ok: exit === 0, code: exit, stdout, stderr: timedOut ? `${stderr}\ncommand timed out; acknowledgement unknown` : stderr });
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
  if (/\b(?:timeout|timed[ -]?out)\b/.test(output)) return "timeout";
  if (/\bpending\b/.test(output)) return "pending";
  for (const state of ["blocked", "done", "unknown", "working", "idle"] as const) {
    if (new RegExp(`\\b${state}\\b`).test(output)) return state;
  }
  return null;
}

export function classifyHerdrCommandFailure(result: HerdrCommandResult): "rejected" | "unknown" {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return /(?:transport|timeout|timed[ -]?out|econn|eof|socket|spawn|enoent|closed|agent_not_ready|agent_blocked|agent_prompt_stalled)/.test(output) ? "unknown" : "rejected";
}

export function requiresTrustConfirmation(result: HerdrCommandResult): boolean {
  const clean = result.stdout.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\s+/g, " ");
  if (/[❯>]\s*\d+\./.test(clean)) return true;
  return /Trust and continue/i.test(clean) ||
         (/Yes, I trust (?:this|the) (?:folder|directory|files)/i.test(clean) && /enter (?:to )?confirm|press enter/i.test(clean)) ||
         /Do you trust this folder\?/i.test(clean) ||
         /Do you trust the contents of this project\?/i.test(clean) ||
         /trust the files in this folder/i.test(clean) ||
         /Yes, proceed/i.test(clean);
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
        ...(options?.paneId ? ["--pane", options.paneId] : ["--current"]),
        "--direction",
        options?.direction ?? "right",
        ...(options?.ratio === undefined ? [] : ["--ratio", String(options.ratio)]),
        "--cwd",
        options?.cwd ?? process.cwd(),
        "--no-focus",
      ]);
    },
    paneLayout(paneId) {
      return runCommand([herdrBin, "pane", "layout", ...(paneId ? ["--pane", paneId] : ["--current"])]);
    },
    listPanes() {
      return runCommand([herdrBin, "pane", "list"]);
    },
    createTab(options) {
      return runCommand([herdrBin, "tab", "create", "--label", options.label, "--cwd", options.cwd,
        ...(options.workspaceId ? ["--workspace", options.workspaceId] : []), "--no-focus"]);
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
      const safeText = input.text.startsWith("-") ? ` ${input.text}` : input.text;
      const argv = [herdrBin, "agent", "prompt", input.target, safeText];
      if (input.wait === true) {
        if (input.waitForStart) {
          argv.push("--wait", ...buildStateArgs(["working", "blocked", "unknown"], input.timeoutMs ?? 10000));
          return runCommand(argv).then(result => {
            if (!result.ok || readHerdrObservedState(result) === "working") return result;
            return { ...result, ok: false, stderr: `${result.stderr}\nagent_not_ready_after_submission:${readHerdrObservedState(result) ?? "unknown"}` };
          });
        }
        if (input.waitForReply) {
          argv.push("--wait", ...buildStateArgs(["idle", "done", "blocked", "unknown"], input.timeoutMs));
          return runCommand(argv);
        }
        argv.push("--wait", ...completionStateArgs(input.until, input.timeoutMs));
        return runCommand(argv).then(waitResult);
      }
      return runCommand(argv);
    },
    waitFor(input) {
      if (input.waitForReply) return runCommand([herdrBin, "agent", "wait", input.target,
        ...buildStateArgs(["idle", "done", "blocked", "unknown"], input.timeoutMs)]);
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
    reportSpawn(paneId, tokens) {
      return runCommand([herdrBin, "pane", "report-metadata", paneId, "--source", "herdr-jev",
        "--ttl-ms", "86400000", ...Object.entries(tokens).flatMap(([key, value]) => ["--token", `${key}=${value}`])]);
    },
    readAgent(target, lines = 40, source = "visible") {
      if (!Number.isInteger(lines) || lines < 1 || lines > 100000) throw new Error("Invalid terminal line limit");
      return runCommand([herdrBin, "agent", "read", target, "--source", source, "--lines", String(lines)]);
    },
    readPane(paneId, lines = 40) {
      if (!Number.isInteger(lines) || lines < 1 || lines > 100000) throw new Error("Invalid terminal line limit");
      return runCommand([herdrBin, "pane", "read", paneId, "--lines", String(lines)]);
    },
    getAgent(target) {
      return runCommand([herdrBin, "agent", "get", target]);
    },
    notify(title, body, sound = "none") {
      return runCommand([herdrBin, "notification", "show", title, "--body", body, "--sound", sound]);
    },
  };
}
