import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGY_AUTH_EARLY } from "../failover/outcome/agy.js";
import { redactSecrets } from "../herdr/pane-text.js";
import { parseModelOverrides } from "../judge/index.js";
import { appendEvent, runDir } from "./events.js";

export type WorkerCli = "codex" | "agy" | "claude";

export interface Invocation {
  argv: string[];
  stdin?: string;
}

export interface InvocationInput {
  cli: WorkerCli;
  model: string;
  effort?: string;
  prompt: string;
  resultFile?: string;
}

export interface InvocationDeps {
  codexProfileExists?: (name: string) => boolean;
  codexMap?: Record<string, string | undefined>;
}

const CODEX_TIER_ALIASES = ["luna", "terra", "sol", "astra"];
const MODELS_FILE = [".config", "jev", "models.local.yml"];

export function loadCodexMap(home = homedir()): Record<string, string | undefined> {
  try {
    return parseModelOverrides(readFileSync(join(home, ...MODELS_FILE), "utf8")).codex ?? {};
  } catch {
    return {};
  }
}

function codexTarget(model: string, deps: InvocationDeps): { profile?: string; model?: string } {
  const exists = deps.codexProfileExists ?? ((n: string) => codexProfileExists(n));
  const mapped = deps.codexMap?.[model] ?? model;
  if (mapped.startsWith("profile:")) {
    const profile = mapped.slice(8);
    if (!exists(profile)) throw new Error(`codex profile ${profile} ausente`);
    return { profile };
  }
  if (exists(mapped)) return { profile: mapped };
  if (CODEX_TIER_ALIASES.includes(mapped)) throw new Error(`codex profile ${mapped} ausente`);
  return { model: mapped };
}

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/\-[\]]{0,80}$/;
const EFFORT = /^(low|medium|high|xhigh|max|minimal)$/;

export function codexProfileExists(name: string, home = homedir()): boolean {
  return existsSync(join(home, ".codex", `${name}.config.toml`));
}

export function buildInvocation(input: InvocationInput, deps: InvocationDeps = {}): Invocation {
  if (!MODEL.test(input.model)) throw new Error(`invalid model: ${input.model}`);
  if (input.effort !== undefined && !EFFORT.test(input.effort)) throw new Error(`invalid effort: ${input.effort}`);
  const effort = input.effort;
  if (input.cli === "codex") {
    const target = codexTarget(input.model, deps);
    return {
      argv: ["codex", "exec", ...(target.profile ? ["-p", target.profile] : ["--model", target.model!]),
        ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
        ...(input.resultFile ? ["--output-last-message", input.resultFile] : []), "-"],
      stdin: input.prompt,
    };
  }
  if (input.cli === "agy") {
    return {
      argv: ["agy", "--model", input.model, ...(effort ? ["--effort", effort] : []), "--dangerously-skip-permissions", `-p=${input.prompt}`],
    };
  }
  return { argv: ["claude", "-p", "--model", input.model, ...(effort ? ["--effort", effort] : [])], stdin: input.prompt };
}

export interface WorkerOptions {
  runId: string;
  cli: WorkerCli;
  model: string;
  effort?: string;
  promptFile: string;
  cwd?: string;
  timeoutMs?: number;
  inactivityMs?: number;
  env?: NodeJS.ProcessEnv;
  echo?: (line: string) => void;
  graceMs?: number;
  finalExit?: boolean;
}

export interface WorkerReport {
  code: number;
  outcome: "done" | "failed" | "timeout" | "interrupted";
  output: string;
  result: string;
}

const MAX_OUT_EVENTS = 5000;
const MAX_LINE = 600;
const TAIL_LINES = 40;
const TAIL_CHARS = 4000;
const RESULT_CHARS = 8000;
const RAW_LINES = 2000;

export function cleanAnswer(lines: string[]): string {
  const kept = lines.filter((l) => !/^hook: /.test(l));
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === "") kept.pop();
  const last = kept[kept.length - 1]?.trim() ?? "";
  const prev = kept[kept.length - 2]?.trim() ?? "";
  if (/^tokens used$/i.test(prev) && /^[\d.,]+$/.test(last)) kept.splice(-2);
  else if (/^tokens?( used)?\s*[:=]/i.test(last)) kept.pop();
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === "") kept.pop();
  return kept.join("\n").trim();
}

export function boundResult(text: string): string {
  return text.length > RESULT_CHARS ? text.slice(0, RESULT_CHARS) : text;
}

export function killGroup(pgid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

function reportHerdr(env: NodeJS.ProcessEnv, cli: string, state: string, message: string): void {
  const pane = env.HERDR_PANE_ID;
  if (!pane) return;
  try {
    spawnSync(env.HERDR_BIN_PATH || "herdr", ["pane", "report-agent", pane, "--source", "herdr-jev", "--agent", cli, "--state", state, "--message", message.slice(0, 120)], { timeout: 2000, stdio: "ignore" });
  } catch {
    void 0;
  }
}

function resetResult(file: string): void {
  try {
    writeFileSync(file, "", { mode: 0o600 });
  } catch {
    void 0;
  }
}

function collectResult(resultFile: string, raw: string[]): string {
  let fromFile = "";
  try {
    fromFile = readFileSync(resultFile, "utf8").trim();
  } catch {
    void 0;
  }
  const text = fromFile || cleanAnswer(raw);
  if (text !== fromFile) {
    try {
      writeFileSync(resultFile, `${text}\n`, { mode: 0o600 });
    } catch {
      void 0;
    }
  }
  return text;
}

export async function runWorker(opts: WorkerOptions): Promise<number> {
  return (await runWorkerDetailed(opts)).code;
}

export async function runWorkerDetailed(opts: WorkerOptions): Promise<WorkerReport> {
  const env = opts.env ?? process.env;
  const echo = opts.echo ?? ((line: string) => process.stdout.write(`${line}\n`));
  const prompt = readFileSync(opts.promptFile, "utf8");
  let invocation: Invocation;
  const resultFile = join(runDir(opts.runId, env), "result.txt");
  try {
    mkdirSync(runDir(opts.runId, env), { recursive: true, mode: 0o700 });
    resetResult(resultFile);
    invocation = buildInvocation({ cli: opts.cli, model: opts.model, effort: opts.effort, prompt, resultFile }, { codexMap: opts.cli === "codex" ? loadCodexMap(env.HOME || homedir()) : undefined, codexProfileExists: (n) => codexProfileExists(n, env.HOME || homedir()) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    echo(message);
    if (opts.finalExit !== false) appendEvent(opts.runId, { type: "exit", code: 2, outcome: "failed", tail: message }, env);
    return { code: 2, outcome: "failed", output: message, result: "" };
  }
  const [bin, ...args] = invocation.argv as [string, ...string[]];
  const shownArgs = args.map((a) => (a.startsWith("-p=") ? "-p=<prompt>" : a));
  const timeoutMs = opts.timeoutMs ?? 1_800_000;
  const inactivityMs = opts.inactivityMs ?? 300_000;
  const grace = opts.graceMs ?? 3000;

  return new Promise<WorkerReport>((resolve) => {
    const child = spawn(bin, args, { cwd: opts.cwd, detached: true, stdio: ["pipe", "pipe", "pipe"], env });
    const pid = child.pid ?? 0;
    let finished = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let outcome: "done" | "failed" | "timeout" | "interrupted" = "failed";
    let outCount = 0;
    const tail: string[] = [];
    const raw: string[] = [];

    appendEvent(opts.runId, { type: "start", pid, pgid: pid, wrapperPid: process.pid, cli: opts.cli, model: opts.model, effort: opts.effort ?? null, argv: [bin, ...shownArgs], cwd: opts.cwd ?? process.cwd() }, env);
    reportHerdr(env, opts.cli, "working", `${opts.cli} ${opts.model}`);

    let authKilled = false;
    const stop = (kind: "timeout" | "interrupted" | "auth") => {
      if (kind === "auth") {
        if (finished || authKilled) return;
        authKilled = true;
        killGroup(pid, "SIGTERM");
        killTimer = setTimeout(() => killGroup(pid, "SIGKILL"), grace);
        return;
      }
      if (finished || outcome === "timeout" || outcome === "interrupted") return;
      outcome = kind;
      if (kind === "timeout") appendEvent(opts.runId, { type: "timeout", kind: stopKind }, env);
      killGroup(pid, "SIGTERM");
      killTimer = setTimeout(() => killGroup(pid, "SIGKILL"), grace);
    };
    let stopKind = "absolute";

    const absolute = setTimeout(() => {
      stopKind = "absolute";
      stop("timeout");
    }, timeoutMs);
    let idle: ReturnType<typeof setTimeout>;
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        stopKind = "inactivity";
        stop("timeout");
      }, inactivityMs);
    };
    arm();

    const line = (rawLine: string, fromStdout = false) => {
      const text = redactSecrets(rawLine).slice(0, MAX_LINE);
      echo(text);
      if (fromStdout) {
        raw.push(redactSecrets(rawLine));
        if (raw.length > RAW_LINES) raw.shift();
      }
      tail.push(text);
      if (opts.cli === "agy" && !authKilled && AGY_AUTH_EARLY.test(text)) stop("auth");
      if (tail.length > TAIL_LINES) tail.shift();
      if (outCount < MAX_OUT_EVENTS) {
        outCount += 1;
        appendEvent(opts.runId, { type: "out", line: text }, env);
      }
    };
    const splitter = (fromStdout: boolean) => {
      let buf = "";
      return (chunk: Buffer) => {
        arm();
        buf += chunk.toString("utf8");
        let at = buf.indexOf("\n");
        while (at >= 0) {
          line(buf.slice(0, at).replace(/\r$/, ""), fromStdout);
          buf = buf.slice(at + 1);
          at = buf.indexOf("\n");
        }
        if (buf.length > 8192) {
          line(buf, fromStdout);
          buf = "";
        }
      };
    };
    child.stdout.on("data", splitter(true));
    child.stderr.on("data", splitter(false));

    const onSignal = (sig: NodeJS.Signals) => {
      appendEvent(opts.runId, { type: "interrupted", signal: sig }, env);
      stop("interrupted");
    };
    const handlers: [NodeJS.Signals, () => void][] = (["SIGTERM", "SIGINT", "SIGHUP"] as const).map((s) => [s, () => onSignal(s)]);
    for (const [s, h] of handlers) process.on(s, h);

    const finish = (code: number | null, signal: string | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(absolute);
      clearTimeout(idle);
      clearTimeout(killTimer);
      killGroup(pid, "SIGKILL");
      for (const [s, h] of handlers) process.off(s, h);
      if (outcome === "failed" && code === 0) outcome = "done";
      const exitCode = outcome === "timeout" ? 124 : outcome === "interrupted" ? 130 : authKilled ? 1 : code ?? 1;
      const joined = tail.join("\n");
      const result = outcome === "done" ? boundResult(collectResult(resultFile, raw)) : "";
      if (opts.finalExit !== false) {
        appendEvent(opts.runId, { type: "exit", code: exitCode, signal, outcome, tail: joined.length > TAIL_CHARS ? joined.slice(-TAIL_CHARS) : joined, ...(result ? { result } : {}) }, env);
        reportHerdr(env, opts.cli, outcome === "done" ? "done" : "blocked", `${outcome} (${exitCode})`);
      }
      resolve({ code: exitCode, outcome, output: joined, result });
    };
    child.on("error", (error) => {
      line(`spawn failed: ${error.message}`);
      finish(127, null);
    });
    child.on("close", (code, signal) => finish(code, signal));

    child.stdin.on("error", () => undefined);
    if (invocation.stdin !== undefined) child.stdin.end(invocation.stdin);
    else child.stdin.end();
  });
}
