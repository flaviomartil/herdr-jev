import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { ClientKind, RoleKind, StageSpec, TriageDecision } from "../types/index.js";
import { createHerdrClient, type HerdrClient } from "./client.js";

export interface LaunchResult {
  ok: boolean;
  error?: string;
  paneCreated?: boolean;
  agentName?: string;
  paneId?: string;
  commandText?: string;
  direction?: "right" | "down";
}

export interface InlineRunResult {
  ok: boolean;
  exitCode?: number | null;
  error?: string;
  commandText: string;
}

export type SplitDirectionOption = "right" | "down" | "auto";

/**
 * Resolves split pane direction based on CLI option, env var, or Jev role heuristic:
 * researcher: "right" (side-by-side with code for parallel investigation)
 * implementer: "right" (side-by-side editing / pair programming)
 * reviewer: "down" (bottom pane for inspecting test logs, diffs, and review notes)
 * advisor: "right" (side-by-side architectural guidance)
 */
export function resolveSplitDirection(
  role: RoleKind,
  triage?: TriageDecision,
  cliOption?: string,
): "right" | "down" {
  if (cliOption === "right" || cliOption === "down") {
    return cliOption;
  }
  const envDir = (process.env.HERDR_JEV_SPLIT_DIRECTION ?? "").trim().toLowerCase();
  if (envDir === "right" || envDir === "down") {
    return envDir;
  }
  // Auto: Jev role-based layout heuristic
  if (role === "reviewer") {
    return "down";
  }
  return "right";
}

export function parseHerdrPaneId(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    const data = JSON.parse(trimmed) as {
      result?: { pane?: { pane_id?: unknown } };
      pane?: { pane_id?: unknown };
    };
    const id = data.result?.pane?.pane_id ?? data.pane?.pane_id;
    if (typeof id === "string" && id.length > 0) return id;
  } catch {
    // Non-JSON plain text fallback
  }
  return trimmed.split(/\s+/)[0];
}

import { resolveBaseClientKind, resolveClientExecutable } from "../config/aliases.js";

export function buildAgentCommand(client: ClientKind, stage: StageSpec): string[] {
  const base = resolveBaseClientKind(client);
  const bin = resolveClientExecutable(client);
  switch (base) {
    case "claude": {
      const args = [bin, "--model", stage.model];
      if (stage.extraFlags.length > 0) {
        args.push(...stage.extraFlags);
      }
      return args;
    }
    case "codex": {
      const args = [bin, "--model", stage.model];
      if (stage.extraFlags.length > 0) {
        args.push(...stage.extraFlags);
      }
      return args;
    }
    case "cursor": {
      return [bin, "--model", stage.model];
    }
    case "opencode": {
      return [bin, "--model", stage.model];
    }
    case "antigravity": {
      return [bin];
    }
    case "kimi": {
      const args = [bin, "-m", stage.model, "--yolo"];
      if (stage.extraFlags.length > 0) {
        args.push(...stage.extraFlags);
      }
      return args;
    }
  }
}

export function mapClientToHerdrKind(client: ClientKind): "claude" | "codex" | "cursor" | "opencode" | "agy" | "kimi" {
  const base = resolveBaseClientKind(client);
  if (base === "claude") return "claude";
  if (base === "codex") return "codex";
  if (base === "cursor") return "cursor";
  if (base === "antigravity") return "agy";
  if (base === "kimi") return "kimi";
  return "opencode";
}

export function formatHerdrAgentName(
  client: ClientKind,
  role: string,
  model: string,
  suffix?: string,
): string {
  const cleanModel = model
    .toLowerCase()
    .replace(/^gpt-[0-9.]+-/, "")
    .replace(/^claude-/, "")
    .replace(/[^a-z0-9]/g, "");

  const roleTag = role === "implementer" ? "impl" : role;
  const token = suffix ?? randomBytes(2).toString("hex");

  const candidate = `jev-${roleTag}-${cleanModel}-${token}`.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return candidate.slice(0, 32);
}

export async function launchStageInHerdr(input: {
  client: ClientKind;
  stage: StageSpec;
  handoffPrompt: string;
  herdr?: HerdrClient;
  direction?: SplitDirectionOption;
  triage?: TriageDecision;
}): Promise<LaunchResult> {
  const herdr = input.herdr ?? createHerdrClient();
  const effectiveClient = input.stage.client ?? input.client;
  const command = buildAgentCommand(effectiveClient, input.stage);
  const commandText = command.join(" ");

  if (process.env.HERDR_ENV !== "1") {
    return {
      ok: true,
      paneCreated: false,
      commandText,
      error: "Not in Herdr environment (HERDR_ENV != 1). Run manually or launch from Herdr pane.",
    };
  }

  const agentName = formatHerdrAgentName(effectiveClient, input.stage.role, input.stage.model);
  const splitDirection = resolveSplitDirection(input.stage.role, input.triage, input.direction);

  // 1. Split current pane with resolved direction
  const split = await herdr.splitCurrent({ direction: splitDirection });
  if (!split.ok) {
    return { ok: false, error: `Pane split failed: ${split.stderr || split.stdout}`, commandText, direction: splitDirection };
  }

  const paneId = parseHerdrPaneId(split.stdout);
  if (!paneId) {
    return { ok: false, error: "Could not resolve pane ID from Herdr output", commandText, direction: splitDirection };
  }

  // 2. Start agent inside pane
  const herdrKind = mapClientToHerdrKind(effectiveClient);
  const started = await herdr.startAgent({
    name: agentName,
    kind: herdrKind,
    paneId,
    agentArgs: command.slice(1),
  });

  if (!started.ok) {
    await herdr.closePane(paneId);
    return { ok: false, error: `Agent start failed: ${started.stderr || started.stdout}`, paneId, commandText, direction: splitDirection };
  }

  // 3. Send initial prompt/handoff immediately into the split pane
  if (input.handoffPrompt && input.handoffPrompt.trim().length > 0) {
    await herdr.prompt({
      target: agentName,
      text: input.handoffPrompt,
      wait: false,
    });
  }

  return {
    ok: true,
    paneCreated: true,
    agentName,
    paneId,
    commandText,
    direction: splitDirection,
  };
}

/**
 * Resolves whether subagents should run in a split pane or inline.
 * Precedence:
 * 1. Explicit CLI argument (--split or --no-split)
 * 2. HERDR_JEV_SPLIT_SUBAGENTS env var ("0", "false", "off", "no" => false; "1", "true", "on", "yes" => true)
 * 3. Fallback: HERDR_ENV === "1" => true, otherwise false
 */
export function shouldSplitSubagents(cliOption?: boolean): boolean {
  if (cliOption !== undefined) {
    return cliOption;
  }
  const envVar = process.env.HERDR_JEV_SPLIT_SUBAGENTS;
  if (envVar !== undefined && envVar.trim() !== "") {
    const val = envVar.trim().toLowerCase();
    if (val === "0" || val === "false" || val === "off" || val === "no") {
      return false;
    }
    if (val === "1" || val === "true" || val === "on" || val === "yes") {
      return true;
    }
  }
  return process.env.HERDR_ENV === "1";
}

/**
 * Builds CLI command argument array for executing an agent inline in the current terminal.
 */
export function buildInlineCommand(
  client: ClientKind,
  stage: StageSpec,
  promptText: string,
  nonInteractive = false,
): string[] {
  const base = resolveBaseClientKind(client);
  const bin = resolveClientExecutable(client);
  switch (base) {
    case "claude": {
      if (nonInteractive) {
        const args = [bin, "-p", promptText, "--model", stage.model];
        if (stage.extraFlags.length > 0) args.push(...stage.extraFlags);
        return args;
      }
      const args = [bin, "--model", stage.model];
      if (stage.extraFlags.length > 0) args.push(...stage.extraFlags);
      args.push(promptText);
      return args;
    }
    case "codex": {
      if (nonInteractive) {
        const args = [bin, "exec", promptText, "--model", stage.model];
        if (stage.extraFlags.length > 0) args.push(...stage.extraFlags);
        return args;
      }
      const args = [bin, "--model", stage.model];
      if (stage.extraFlags.length > 0) args.push(...stage.extraFlags);
      args.push(promptText);
      return args;
    }
    case "antigravity": {
      if (nonInteractive) {
        return [bin, "-p", promptText];
      }
      return [bin, "-i", promptText];
    }
    case "cursor": {
      return [bin, "--model", stage.model, promptText];
    }
    case "opencode": {
      return [bin, "--model", stage.model, promptText];
    }
    case "kimi": {
      if (nonInteractive) {
        return [bin, "-m", stage.model, "-p", promptText];
      }
      return [bin, "-m", stage.model, "--yolo", promptText];
    }
  }
}

/**
 * Executes an agent inline in the current terminal using stdio: "inherit".
 */
export function runAgentInline(input: {
  client: ClientKind;
  stage: StageSpec;
  promptText: string;
  nonInteractive?: boolean;
}): InlineRunResult {
  const effectiveClient = input.stage.client ?? input.client;
  const args = buildInlineCommand(effectiveClient, input.stage, input.promptText, input.nonInteractive);
  const commandText = args.join(" ");

  try {
    const result = spawnSync(args[0], args.slice(1), {
      stdio: "inherit",
      env: process.env,
    });

    const exitCode = result.status;
    if (result.error) {
      return { ok: false, exitCode, error: result.error.message, commandText };
    }
    return { ok: exitCode === 0, exitCode, commandText };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: errorMsg, commandText };
  }
}

export interface CapturedRunResult {
  ok: boolean;
  output: string;
  exitCode: number | null;
  error?: string;
  commandText: string;
}

/**
 * Executes an agent non-interactively in the background and captures its output (stdout + stderr).
 * Perfect for in-prompt subagent delegation and MCP tool execution.
 */
export function runAgentCaptured(input: {
  client: ClientKind;
  stage: StageSpec;
  promptText: string;
  cwd?: string;
  timeoutMs?: number;
}): CapturedRunResult {
  const effectiveClient = input.stage.client ?? input.client;
  const args = buildInlineCommand(effectiveClient, input.stage, input.promptText, true);
  const commandText = args.join(" ");

  try {
    const result = spawnSync(args[0], args.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: input.timeoutMs ?? 120000,
      cwd: input.cwd ?? process.cwd(),
      env: process.env,
    });

    const exitCode = result.status;
    const stdout = (result.stdout || "").trim();
    const stderr = (result.stderr || "").trim();
    const output = stdout || stderr || (exitCode === 0 ? "(no output returned)" : "(command exited with error and no output)");

    if (result.error) {
      return { ok: false, output, exitCode, error: result.error.message, commandText };
    }
    return { ok: exitCode === 0, output, exitCode, commandText };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { ok: false, output: "", exitCode: 1, error: errorMsg, commandText };
  }
}


