import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { sep } from "node:path";
import type { HerdrCommandResult } from "../types/index.js";
import { classifyHerdrError } from "./errors.js";
import { ANSI_PATTERN } from "./pane-text.js";
import { isTestGuardActive } from "./state-dir.js";

const TRUSTED_TMP_ROOTS: readonly string[] = ["/tmp", "/var/tmp", "/private/tmp", "/private/var/tmp"];

export function resolveFakeBinDir(reported: string = tmpdir(), real: (path: string) => string = realpathSync): string {
  let candidate = "/tmp";
  try {
    const resolved = real(reported.replace(/\/+$/, "") || "/");
    if (TRUSTED_TMP_ROOTS.includes(resolved) || resolved.startsWith("/private/var/folders/")) candidate = resolved;
  } catch {}
  try {
    return real(candidate);
  } catch {
    return candidate;
  }
}

const FAKE_BIN_DIR = resolveFakeBinDir();

export function isTestSafeBinary(path: string): boolean {
  if (!path.includes("/")) return false;
  try {
    return realpathSync(path).startsWith(FAKE_BIN_DIR + sep);
  } catch {
    return false;
  }
}

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
  getPane?(paneId: string): Promise<HerdrCommandResult>;
  paneProcessInfo?(paneId?: string): Promise<HerdrCommandResult>;
  readAgent?(target: string, lines?: number, source?: "visible" | "recent", format?: "plain" | "ansi"): Promise<HerdrCommandResult>;
  readPane?(paneId: string, lines?: number, format?: "plain" | "ansi"): Promise<HerdrCommandResult>;
  getAgent?(target: string): Promise<HerdrCommandResult>;
  sendKeys?(target: string, keys: readonly string[]): Promise<HerdrCommandResult>;
  reportSpawn?(paneId: string, tokens: Record<string, string>): Promise<HerdrCommandResult>;
  notify(title: string, body: string, sound?: string): Promise<HerdrCommandResult>;
}

export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function appendCapped(chunks: Buffer[], totalBytes: number, incoming: Buffer, limit: number): number {
  if (totalBytes >= limit) return totalBytes;
  const remaining = limit - totalBytes;
  const slice = incoming.length > remaining ? incoming.subarray(0, remaining) : incoming;
  chunks.push(slice);
  return totalBytes + slice.length;
}

export function createProcessCommandAdapter(
  options: { timeoutMs?: number; maxOutputBytes?: number; env?: NodeJS.ProcessEnv } = {},
): RunCommand {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return (argv) =>
    new Promise((resolve) => {
      const [command, ...args] = argv;
      if (!command) {
        resolve({ ok: false, code: 1, stdout: "", stderr: "missing command" });
        return;
      }
      if (isTestGuardActive() && (command === "herdr" || command.endsWith("/herdr") || command === process.env.HERDR_BIN_PATH)) {
        if (!isTestSafeBinary(command)) {
          const cmdPath = args.join(" ");
          const isReadOnly = /^(?:agent|pane) (?:get|list|read|layout|current|process-info)\b/.test(cmdPath);
          if (!isReadOnly) {
            resolve({ ok: false, code: 126, stdout: "", stderr: "blocked_by_test_guard" });
            return;
          }
        }
      }
      const child = spawn(command, args, { detached: true, stdio: ["ignore", "pipe", "pipe"], env: options.env ?? process.env });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;
      const nativeTimeout = Number(args[args.indexOf("--timeout") + 1]);
      const deadline = args.includes("--timeout") && Number.isSafeInteger(nativeTimeout) && nativeTimeout > 0
        ? Math.max(timeoutMs, nativeTimeout + 2000) : timeoutMs;
      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
            return;
          } catch {
          }
        }
        child.kill("SIGKILL");
      }, deadline);

      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutBytes = appendCapped(stdoutChunks, stdoutBytes, chunk, maxOutputBytes);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrBytes = appendCapped(stderrChunks, stderrBytes, chunk, maxOutputBytes);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({
          ok: false,
          code: 1,
          stdout: Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8"),
          stderr: String(error),
        });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const exit = code ?? 1;
        const stdout = Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8");
        const stderr = Buffer.concat(stderrChunks, stderrBytes).toString("utf8");
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

function parseStructuredState(stdout: string): HerdrAgentState | null {
  try {
    const parsed = JSON.parse(stdout) as {
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
  return null;
}

export function readHerdrStructuredState(result: HerdrCommandResult): HerdrAgentState | null {
  return parseStructuredState(result.stdout);
}

export function readHerdrObservedState(result: HerdrCommandResult): HerdrObservedState | null {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  const structured = parseStructuredState(result.stdout);
  if (structured) return structured;
  if (/\b(?:timeout|timed[ -]?out)\b/.test(output)) return "timeout";
  if (/\bpending\b/.test(output)) return "pending";
  for (const state of ["blocked", "done", "unknown", "working", "idle"] as const) {
    if (new RegExp(`\\b${state}\\b`).test(output)) return state;
  }
  return null;
}

const LEGACY_UNKNOWN_FAILURE_PATTERN = /(?:transport|timeout|timed[ -]?out|econn|eof|socket|spawn|enoent|closed|agent_not_ready|agent_blocked|agent_prompt_stalled)/i;

export function classifyHerdrCommandFailure(result: HerdrCommandResult): "rejected" | "unknown" {
  const classified = classifyHerdrError(result);
  if (classified.code !== null) return classified.legacyAck;
  const output = `${result.stdout}\n${result.stderr}`;
  return LEGACY_UNKNOWN_FAILURE_PATTERN.test(output) ? "unknown" : "rejected";
}

export type PaneBlockKind = "trust" | "selection";

const SELECTION_FOOTER = /\b(?:enter|return)\s+(?:to\s+)?(?:confirm|select|choose)\b|\besc\s+to\s+cancel\b|↑\s*\/?\s*↓/i;
const SELECTION_FOOTER_LINES = 5;
const NUMBERED_CURSOR_LINE = /^[ \t│┃|]*[❯›>]\s*\d+[.)]\s+\S/;
const NUMBERED_OPTION_LINE = /(^|\n)[ \t│┃|]*(?!\s*[❯›>])\d+[.)]\s+\S/;
const CURSOR_LINE = /^[ \t│┃|]*[❯›>][ \t]+\S/;

export function normalizePaneText(text: string): string {
  return text.replace(ANSI_PATTERN, "").replace(/\r/g, "").replace(/\u00a0/g, " ");
}

function lastLineIndex(lines: readonly string[], pattern: RegExp): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (pattern.test(lines[i])) return i;
  }
  return -1;
}

function hasFooterAfter(lines: readonly string[], cursorIndex: number): boolean {
  const tail = lines.slice(cursorIndex + 1).filter((line) => line.trim() !== "").slice(-SELECTION_FOOTER_LINES);
  return SELECTION_FOOTER.test(tail.join(" ").replace(/\s+/g, " "));
}

export function looksLikeSelectionMenu(text: string): boolean {
  const clean = normalizePaneText(text);
  const lines = clean.split("\n");
  const numberedCursor = lastLineIndex(lines, NUMBERED_CURSOR_LINE);
  if (numberedCursor !== -1) return hasFooterAfter(lines, numberedCursor) || NUMBERED_OPTION_LINE.test(clean);
  const cursor = lastLineIndex(lines, CURSOR_LINE);
  return cursor !== -1 && hasFooterAfter(lines, cursor);
}

export function classifyPaneBlock(result: HerdrCommandResult): PaneBlockKind | null {
  const clean = normalizePaneText(result.stdout).replace(/\s+/g, " ");
  const trust = /Trust and continue/i.test(clean) ||
         (/Yes, I trust (?:this|the) (?:folder|directory|files)/i.test(clean) && /enter (?:to )?confirm|press enter/i.test(clean)) ||
         /Do you trust this folder\?/i.test(clean) ||
         /Do you trust the contents of this project\?/i.test(clean) ||
         /trust the files in this folder/i.test(clean) ||
         /Yes, proceed/i.test(clean);
  if (trust) return "trust";
  return looksLikeSelectionMenu(result.stdout) ? "selection" : null;
}

export function requiresTrustConfirmation(result: HerdrCommandResult): boolean {
  return classifyPaneBlock(result) !== null;
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
      return runCommand([
        herdrBin,
        "tab",
        "create",
        "--label",
        options.label,
        "--cwd",
        options.cwd,
        ...(options.workspaceId ? ["--workspace", options.workspaceId] : []),
        "--env",
        "CLAUDECODE=",
        "--env",
        "CLAUDE_CODE_SESSION_ID=",
        "--env",
        "CODEX_THREAD_ID=",
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
        "--timeout",
        "45000",
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
        if (input.until && input.until.length > 0) {
          const allowed = new Set<HerdrAgentState>(input.until);
          argv.push("--wait", ...buildStateArgs(input.until, input.timeoutMs));
          return runCommand(argv).then((result) => {
            if (!result.ok) return result;
            const state = readHerdrObservedState(result);
            if (state && state !== "pending" && state !== "timeout" && allowed.has(state)) return result;
            return {
              ...result,
              ok: false,
              stderr: result.stderr || (state === null ? "completion_state_unrecognized" : `completion_state_${state}`),
            };
          });
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
    getPane(paneId) {
      return runCommand([herdrBin, "pane", "get", paneId]);
    },
    paneProcessInfo(paneId) {
      return runCommand([herdrBin, "pane", "process-info", ...(paneId ? ["--pane", paneId] : ["--current"])]);
    },
    reportSpawn(paneId, tokens) {
      return runCommand([herdrBin, "pane", "report-metadata", paneId, "--source", "herdr-jev",
        "--ttl-ms", "86400000", ...Object.entries(tokens).flatMap(([key, value]) => ["--token", `${key}=${value}`])]);
    },
    readAgent(target, lines = 40, source = "visible", format) {
      if (!Number.isInteger(lines) || lines < 1 || lines > 100000) throw new Error("Invalid terminal line limit");
      return runCommand([
        herdrBin,
        "agent",
        "read",
        target,
        "--source",
        source,
        "--lines",
        String(lines),
        ...(format ? ["--format", format === "plain" ? "text" : "ansi"] : []),
      ]);
    },
    readPane(paneId, lines = 40, format) {
      if (!Number.isInteger(lines) || lines < 1 || lines > 100000) throw new Error("Invalid terminal line limit");
      return runCommand([
        herdrBin,
        "pane",
        "read",
        paneId,
        "--lines",
        String(lines),
        ...(format ? ["--format", format === "plain" ? "text" : "ansi"] : []),
      ]);
    },
    getAgent(target) {
      return runCommand([herdrBin, "agent", "get", target]);
    },
    sendKeys(target, keys) {
      return runCommand([herdrBin, "agent", "send-keys", target, ...keys]);
    },
    notify(title, body, sound = "none") {
      return runCommand([herdrBin, "notification", "show", title, "--body", body, "--sound", sound]);
    },
  };
}
