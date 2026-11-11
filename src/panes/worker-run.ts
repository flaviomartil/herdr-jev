import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redactSecrets } from "../herdr/pane-text.js";
import { appendEvent } from "./events.js";

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
}

export interface InvocationDeps {
  codexProfileExists?: (name: string) => boolean;
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
    const hasProfile = (deps.codexProfileExists ?? codexProfileExists)(input.model);
    return {
      argv: ["codex", "exec", ...(hasProfile ? ["-p", input.model] : ["--model", input.model]),
        ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []), "-"],
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
}

const MAX_OUT_EVENTS = 5000;
const MAX_LINE = 600;
const TAIL_LINES = 40;
const TAIL_CHARS = 4000;

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

export async function runWorker(opts: WorkerOptions): Promise<number> {
  const env = opts.env ?? process.env;
  const echo = opts.echo ?? ((line: string) => process.stdout.write(`${line}\n`));
  const prompt = readFileSync(opts.promptFile, "utf8");
  const invocation = buildInvocation({ cli: opts.cli, model: opts.model, effort: opts.effort, prompt });
  const [bin, ...args] = invocation.argv as [string, ...string[]];
  const shownArgs = args.map((a) => (a.startsWith("-p=") ? "-p=<prompt>" : a));
  const timeoutMs = opts.timeoutMs ?? 1_800_000;
  const inactivityMs = opts.inactivityMs ?? 300_000;
  const grace = opts.graceMs ?? 3000;

  return new Promise<number>((resolve) => {
    const child = spawn(bin, args, { cwd: opts.cwd, detached: true, stdio: ["pipe", "pipe", "pipe"], env });
    const pid = child.pid ?? 0;
    let finished = false;
    let outcome: "done" | "failed" | "timeout" | "interrupted" = "failed";
    let outCount = 0;
    const tail: string[] = [];

    appendEvent(opts.runId, { type: "start", pid, pgid: pid, wrapperPid: process.pid, cli: opts.cli, model: opts.model, effort: opts.effort ?? null, argv: [bin, ...shownArgs], cwd: opts.cwd ?? process.cwd() }, env);
    reportHerdr(env, opts.cli, "working", `${opts.cli} ${opts.model}`);

    const stop = (kind: "timeout" | "interrupted") => {
      if (finished || outcome === "timeout" || outcome === "interrupted") return;
      outcome = kind;
      if (kind === "timeout") appendEvent(opts.runId, { type: "timeout", kind: stopKind }, env);
      killGroup(pid, "SIGTERM");
      setTimeout(() => killGroup(pid, "SIGKILL"), grace).unref();
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

    const line = (raw: string) => {
      const text = redactSecrets(raw).slice(0, MAX_LINE);
      echo(text);
      tail.push(text);
      if (tail.length > TAIL_LINES) tail.shift();
      if (outCount < MAX_OUT_EVENTS) {
        outCount += 1;
        appendEvent(opts.runId, { type: "out", line: text }, env);
      }
    };
    const splitter = () => {
      let buf = "";
      return (chunk: Buffer) => {
        arm();
        buf += chunk.toString("utf8");
        let at = buf.indexOf("\n");
        while (at >= 0) {
          line(buf.slice(0, at).replace(/\r$/, ""));
          buf = buf.slice(at + 1);
          at = buf.indexOf("\n");
        }
        if (buf.length > 8192) {
          line(buf);
          buf = "";
        }
      };
    };
    child.stdout.on("data", splitter());
    child.stderr.on("data", splitter());

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
      for (const [s, h] of handlers) process.off(s, h);
      if (outcome === "failed" && code === 0) outcome = "done";
      const exitCode = outcome === "timeout" ? 124 : outcome === "interrupted" ? 130 : code ?? 1;
      const joined = tail.join("\n");
      appendEvent(opts.runId, { type: "exit", code: exitCode, signal, outcome, tail: joined.length > TAIL_CHARS ? joined.slice(-TAIL_CHARS) : joined }, env);
      reportHerdr(env, opts.cli, outcome === "done" ? "done" : "blocked", `${outcome} (${exitCode})`);
      resolve(exitCode);
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
