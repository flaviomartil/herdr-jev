import { existsSync, readFileSync } from "node:fs";
import { commitFiles, createEvaluator, writtenPaths } from "./core.js";
import type { RuleEvent, Verdict } from "./core.js";
import { loadRules } from "./index.js";

export type CheckResult = { code: number; stdout: string; stderr: string };

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

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
  const cmd = Array.isArray(input.command) ? input.command.join(" ") : str(input.command);
  if (cmd !== undefined && tool !== "apply_patch") {
    for (const file of commitFiles(cmd)) {
      const abs = file.startsWith("/") ? file : `${cwd ?? ""}/${file}`;
      try {
        files[file] = readFileSync(abs, "utf8");
      } catch {
        void 0;
      }
    }
  }
  let isNew: boolean | undefined;
  if (tool === "Write") {
    const [path] = writtenPaths(tool, input);
    if (path) isNew = !existsSync(path.startsWith("/") ? path : `${cwd ?? ""}/${path}`);
  }
  return { type: "tool", tool, input, cwd, home, sessionId, files, isNew };
}

export function render(verdict: Verdict, hook: string | undefined): CheckResult {
  if (verdict.decision === "deny") return { code: 2, stdout: "", stderr: `${verdict.reason}\n` };
  if (verdict.decision === "ask") {
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

export function runCheck(stdin: string, env: Record<string, string | undefined> = process.env): CheckResult {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(stdin);
  } catch {
    return { code: 0, stdout: "", stderr: "herdr-jev rules: unreadable hook input, allowed\n" };
  }
  try {
    const event = toEvent(payload, env);
    if (event === null) return { code: 0, stdout: "", stderr: "" };
    const verdict = createEvaluator(loadRules(env)).evaluate(event);
    return render(verdict, str(payload.hook_event_name));
  } catch (error) {
    return { code: 0, stdout: "", stderr: `herdr-jev rules: ${error instanceof Error ? error.message : String(error)}, allowed\n` };
  }
}

export async function main(argv: string[]): Promise<number> {
  if (argv[0] !== "check") {
    process.stderr.write("usage: herdr-jev rules check < hook.json\n");
    return 64;
  }
  const result = runCheck(await Bun.stdin.text());
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.code;
}
