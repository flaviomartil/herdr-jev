import { existsSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { commitFiles, createEvaluator, failureVerdict, pushNeedsBranch, writtenPaths } from "./core.js";
import type { RuleEvent, Verdict } from "./core.js";
import { loadRules } from "./index.js";

export type CheckResult = { code: number; stdout: string; stderr: string };
export type Client = "claude" | "codex";

const STDIN_TIMEOUT_MS = 3000;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function resolveReal(path: string, depth: number): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    void 0;
  }
  if (depth < 8) {
    try {
      const target = readlinkSync(path);
      return resolveReal(target.startsWith("/") ? target : join(dirname(path), target), depth + 1);
    } catch {
      void 0;
    }
  }
  try {
    return `${realpathSync(dirname(path))}/${basename(path)}`;
  } catch {
    return undefined;
  }
}

export function toEvent(payload: Record<string, unknown>, env: Record<string, string | undefined>): RuleEvent | null {
  const hook = str(payload.hook_event_name);
  const sessionId = str(payload.session_id) ?? str(payload.sessionId);
  if (hook === "UserPromptSubmit") return { type: "prompt", sessionId };
  const tool = str(payload.tool_name);
  const raw = payload.tool_input;
  if (!tool || typeof raw !== "object" || raw === null) return null;
  const input = raw as Record<string, unknown>;
  const cwd = str(payload.cwd);
  const home = env.HOME;
  const files: Record<string, string> = {};
  const unreadable: string[] = [];
  const realPaths: Record<string, string> = {};
  let branch: string | undefined;
  let isNew: boolean | undefined;
  const cmd = Array.isArray(input.command) ? input.command.join(" ") : str(input.command);
  if (cmd !== undefined && tool !== "apply_patch") {
    for (const file of commitFiles(cmd)) {
      const abs = file.startsWith("/") ? file : `${cwd ?? ""}/${file}`;
      try {
        files[file] = readFileSync(abs, "utf8");
      } catch {
        unreadable.push(file);
      }
    }
    if (pushNeedsBranch(cmd)) {
      const run = spawnSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd, timeout: 1000, encoding: "utf8" });
      if (run.status === 0) branch = run.stdout.trim();
    }
  }
  for (const path of writtenPaths(tool, input)) {
    const abs = path.startsWith("/") ? path : `${cwd ?? ""}/${path}`;
    const real = resolveReal(abs, 0);
    if (real !== undefined) realPaths[path] = real;
    if (tool === "Write") isNew = !existsSync(abs);
  }
  return { type: "tool", tool, input, cwd, home, sessionId, files, unreadable, realPaths, branch, isNew };
}

export function render(verdict: Verdict, hook: string | undefined, client: Client = "claude"): CheckResult {
  if (verdict.decision === "deny") return { code: 2, stdout: "", stderr: `${verdict.reason}\n` };
  if (verdict.decision === "ask") {
    if (client === "codex") return { code: 2, stdout: "", stderr: `${verdict.reason} (confirme e rode de novo)\n` };
    const out = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: verdict.reason } };
    return { code: 0, stdout: `${JSON.stringify(out)}\n`, stderr: "" };
  }
  if (verdict.decision === "warn") return { code: 0, stdout: "", stderr: `${verdict.reason}\n` };
  if (verdict.context?.length) {
    const out = { hookSpecificOutput: { hookEventName: hook ?? "UserPromptSubmit", additionalContext: verdict.context.join("\n") } };
    return { code: 0, stdout: `${JSON.stringify(out)}\n`, stderr: "" };
  }
  return { code: 0, stdout: "", stderr: "" };
}

export function failureFromText(text: string, why: string): CheckResult {
  const risky = /"tool_name"\s*:\s*"(Write|Edit|MultiEdit|NotebookEdit|apply_patch)"/.test(text) || /\bgit\b[\s\S]*\bcommit\b/.test(text);
  if (risky) return { code: 2, stdout: "", stderr: `herdr-jev rules: ${why}; blocked because the call writes files or commits\n` };
  return { code: 0, stdout: "", stderr: `herdr-jev rules: ${why}, allowed\n` };
}

export function runCheck(stdin: string, env: Record<string, string | undefined> = process.env, client: Client = "claude"): CheckResult {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(stdin);
  } catch {
    return failureFromText(stdin, "unreadable hook input");
  }
  let event: RuleEvent | null = null;
  try {
    event = toEvent(payload, env);
    if (event === null) return { code: 0, stdout: "", stderr: "" };
    return render(createEvaluator(loadRules(env)).evaluate(event), str(payload.hook_event_name), client);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    if (event === null) return failureFromText(stdin, why);
    const verdict = failureVerdict(event);
    return verdict.decision === "deny"
      ? { code: 2, stdout: "", stderr: `herdr-jev rules: ${why}; blocked because the call writes files or commits\n` }
      : { code: 0, stdout: "", stderr: `herdr-jev rules: ${why}, allowed\n` };
  }
}

export async function readStdin(timeoutMs: number = STDIN_TIMEOUT_MS): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Uint8Array[] = [];
  const reader = Bun.stdin.stream().getReader();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    const result = await Promise.race([reader.read(), new Promise<null>(resolve => setTimeout(() => resolve(null), left))]);
    if (result === null || result.done) break;
    chunks.push(result.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function main(argv: string[]): Promise<number> {
  if (argv[0] !== "check") {
    process.stderr.write("usage: herdr-jev rules check [--client claude|codex] < hook.json\n");
    return 64;
  }
  const at = argv.indexOf("--client");
  const client: Client = at >= 0 && argv[at + 1] === "codex" ? "codex" : "claude";
  const result = runCheck(await readStdin(), process.env, client);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.code;
}
