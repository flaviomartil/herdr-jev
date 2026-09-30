import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { ClientKind, RoleKind, StageSpec, TriageDecision, ReasoningEffort } from "../types/index.js";
import { classifyHerdrCommandFailure, createHerdrClient, readHerdrObservedState, requiresTrustConfirmation, type HerdrClient, type HerdrObservedState } from "./client.js";
import { reserveHerdrHandle, claimHerdrSpawn } from "./reservation.js";

export interface LaunchResult {
  ok: boolean;
  ackStatus?: "acknowledged" | "rejected" | "unknown" | "not_attempted";
  completionState?: HerdrObservedState | "not_requested";
  completionObserved?: boolean;
  workEvidence?: "not_checked";
  error?: string;
  paneCreated?: boolean;
  promptPending?: boolean;
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
      result?: { pane?: { pane_id?: unknown }; root_pane?: { pane_id?: unknown } };
      pane?: { pane_id?: unknown };
    };
    const id = data.result?.pane?.pane_id ?? data.result?.root_pane?.pane_id ?? data.pane?.pane_id;
    if (typeof id === "string" && id.length > 0) return id;
    return undefined;
  } catch {
    // Non-JSON plain text fallback
  }
  return /^[a-zA-Z0-9:_-]+$/.test(trimmed) ? trimmed : undefined;
}

import { resolveBaseClientKind, resolveClientExecutable } from "../config/aliases.js";

export function nativeStageEffort(client: ClientKind, effort: ReasoningEffort): string | undefined {
  const base = resolveBaseClientKind(client);
  if (!["codex", "claude", "antigravity"].includes(base)) return undefined;
  return effort === "standard" ? "medium" : base === "antigravity" && effort === "xhigh" ? "max" : effort;
}

function stageFlags(client: ClientKind, stage: StageSpec): string[] {
  const base = resolveBaseClientKind(client);
  if (base !== "codex" && base !== "claude" && base !== "antigravity") return stage.extraFlags;
  const flags: string[] = [];
  for (let i = 0; i < stage.extraFlags.length; i++) {
    if (base === "codex" && stage.extraFlags[i] === "-c" && stage.extraFlags[i + 1]?.startsWith("model_reasoning_effort=")) { i++; continue; }
    if ((base === "claude" || base === "antigravity") && stage.extraFlags[i] === "--effort") { i++; continue; }
    flags.push(stage.extraFlags[i]);
  }
  const effort = nativeStageEffort(client, stage.effort)!;
  return [...flags, ...(base === "codex" ? ["-c", `model_reasoning_effort="${effort}"`] : ["--effort", effort])];
}

export function buildAgentCommand(client: ClientKind, stage: StageSpec): string[] {
  stage = { ...stage, extraFlags: stageFlags(client, stage) };
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
      return [bin, "--model", stage.model, ...stage.extraFlags];
    }
    case "kimi": {
      const args = [bin, "-m", stage.model, "--yolo"];
      if (stage.extraFlags.length > 0) {
        args.push(...stage.extraFlags);
      }
      return args;
    }
    case "kiro": {
      return [bin, "chat", "--trust-all-tools", "--agent", "ai-harness", "--model", stage.model, ...stage.extraFlags];
    }
  }
}

export function mapClientToHerdrKind(client: ClientKind): "claude" | "codex" | "cursor" | "opencode" | "agy" | "kimi" | "kiro" {
  const base = resolveBaseClientKind(client);
  if (base === "claude") return "claude";
  if (base === "codex") return "codex";
  if (base === "cursor") return "cursor";
  if (base === "antigravity") return "agy";
  if (base === "kimi") return "kimi";
  if (base === "kiro") return "kiro";
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
  const token = (suffix ?? randomBytes(4).toString("hex")).toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(-12);

  const candidate = `jev-${roleTag}-${cleanModel}`.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return `${candidate.slice(0, 31 - token.length)}-${token}`;
}

async function launchStageInHerdrAttempt(input: {
  client: ClientKind;
  stage: StageSpec;
  handoffPrompt: string;
  herdr?: HerdrClient;
  direction?: SplitDirectionOption;
  triage?: TriageDecision;
  waitForCompletion?: boolean;
  completionTimeoutMs?: number;
  agentName?: string;
  layout?: "split" | "tab";
  reuseExisting?: boolean;
  sourcePaneId?: string;
  workspaceId?: string;
  cwd?: string;
}): Promise<LaunchResult> {
  const herdr = input.herdr ?? createHerdrClient();
  const effectiveClient = input.stage.client ?? input.client;
  const command = buildAgentCommand(effectiveClient, input.stage);
  const commandText = command.join(" ");

  if (process.env.HERDR_ENV !== "1") {
    return {
      ok: true,
      ackStatus: "not_attempted",
      completionState: "not_requested",
      completionObserved: false,
      workEvidence: "not_checked",
      paneCreated: false,
      commandText,
      error: "Not in Herdr environment (HERDR_ENV != 1). Run manually or launch from Herdr pane.",
    };
  }

  const agentName = input.agentName ?? formatHerdrAgentName(effectiveClient, input.stage.role, input.stage.model);
  if (input.reuseExisting) {
    if (!input.agentName || !herdr.getAgent) return { ok: false, ackStatus: "rejected", error: "A stable agent name and native lookup are required for retry recovery", commandText };
    const existing = await herdr.getAgent(agentName);
    if (existing.ok) {
      let existingPane: string | undefined;
      try { existingPane = JSON.parse(existing.stdout).result?.agent?.pane_id; } catch {}
      return { ok: false, ackStatus: "unknown", paneCreated: true, agentName, paneId: existingPane, commandText,
        error: "Existing peer retained. Use peer-read and peer-message on this handle; spawn recovery never resends a prompt or opens another tab." };
    }
    let code: string | undefined;
    try { code = JSON.parse(existing.stdout || existing.stderr).error?.code; } catch {}
    if (code !== "agent_not_found" && code !== "not_found") return { ok: false, ackStatus: "unknown", agentName, commandText,
      error: "Peer existence cannot be determined; inspect the existing attempt before retrying." };
  }
  try { claimHerdrSpawn(`spawn:${agentName}`); }
  catch (error) { return { ok: false, ackStatus: "unknown", agentName, commandText,
    error: `Named spawn already attempted or cannot be fenced. Inspect existing tabs/panes before choosing a fresh handle: ${String(error)}` }; }
  const splitDirection = resolveSplitDirection(input.stage.role, input.triage, input.direction);

  // 1. Split current pane with resolved direction
  const split = input.layout === "tab"
    ? await herdr.createTab?.({ label: agentName, cwd: input.cwd ?? process.cwd(), workspaceId: input.workspaceId })
    : await herdr.splitCurrent({ direction: splitDirection, paneId: input.sourcePaneId, cwd: input.cwd });
  if (!split) return { ok: false, ackStatus: "rejected", error: "Tab creation unavailable", commandText };
  if (!split.ok) {
    return { ok: false, ackStatus: classifyHerdrCommandFailure(split), completionState: "not_requested", completionObserved: false, workEvidence: "not_checked", error: `Pane split failed: ${split.stderr || split.stdout}`, commandText, direction: splitDirection };
  }

  const paneId = parseHerdrPaneId(split.stdout);
  if (!paneId) {
    return { ok: false, ackStatus: "unknown", completionState: "not_requested", completionObserved: false, workEvidence: "not_checked", error: "Could not resolve pane ID from Herdr output", commandText, direction: splitDirection };
  }

  let releasePane: (() => Promise<void>) | undefined;
  try { releasePane = await reserveHerdrHandle(`pane:${paneId}`); }
  catch (error) { return { ok: false, ackStatus: "unknown", paneCreated: true, agentName, paneId, error: String(error), commandText }; }
  try {

  // 2. Start agent inside pane
  const herdrKind = mapClientToHerdrKind(effectiveClient);
  const started = await herdr.startAgent({
    name: agentName,
    kind: herdrKind,
    paneId,
    agentArgs: command.slice(1),
  });

  if (!started.ok) {
    const ackStatus = classifyHerdrCommandFailure(started);
    if (ackStatus === "rejected") await herdr.closePane(paneId);
    return { ok: false, ackStatus, paneCreated: ackStatus === "unknown", promptPending: true, agentName, completionState: "not_requested", completionObserved: false, workEvidence: "not_checked", error: `Agent start failed: ${started.stderr || started.stdout}`, paneId, commandText, direction: splitDirection };
  }

  // 3. Send initial prompt/handoff immediately into the split pane
  if (herdr.readAgent) {
    const screen = await herdr.readAgent(agentName);
    if (!screen.ok || requiresTrustConfirmation(screen)) {
      return { ok: false, ackStatus: screen.ok ? "rejected" : "unknown", completionState: screen.ok ? "blocked" : "unknown", paneCreated: true, promptPending: true, agentName, paneId, commandText,
        error: screen.ok ? "Agent requires repository trust confirmation; resolve it in the pane before dispatching work." : "Agent readiness could not be inspected" };
    }
  }
  if (input.handoffPrompt && input.handoffPrompt.trim().length > 0) {
    const prompted = await herdr.prompt({
      target: agentName,
      text: input.handoffPrompt,
      wait: true,
      waitForStart: true,
    });
    if (!prompted.ok) {
      return {
        ok: false,
        ackStatus: classifyHerdrCommandFailure(prompted),
        completionState: "not_requested",
        completionObserved: false,
        workEvidence: "not_checked",
        error: `Prompt dispatch failed: ${prompted.stderr || prompted.stdout || "no acknowledgement"}`,
        paneCreated: true,
        agentName,
        paneId,
        commandText,
        direction: splitDirection,
      };
    }
  }

  if (input.waitForCompletion) {
    const waited = await herdr.waitFor({ target: agentName, timeoutMs: input.completionTimeoutMs });
    const completionState = readHerdrObservedState(waited) ?? (waited.ok ? "unknown" : "pending");
    return {
      ok: true,
      ackStatus: "acknowledged",
      completionState,
      completionObserved: completionState === "done" || completionState === "blocked" || completionState === "unknown",
      workEvidence: "not_checked",
      paneCreated: true,
      agentName,
      paneId,
      commandText,
      direction: splitDirection,
    };
  }

  return {
    ok: true,
    ackStatus: "acknowledged",
    completionState: "not_requested",
    completionObserved: false,
    workEvidence: "not_checked",
    paneCreated: true,
    agentName,
    paneId,
    commandText,
    direction: splitDirection,
  };
  } finally { await releasePane(); }
}

export async function launchStageInHerdr(input: Parameters<typeof launchStageInHerdrAttempt>[0]): Promise<LaunchResult> {
  if (!input.reuseExisting || !input.agentName || process.env.HERDR_ENV !== "1") return launchStageInHerdrAttempt(input);
  let release: (() => Promise<void>) | undefined;
  try {
    release = await reserveHerdrHandle(`spawn:${input.agentName}`);
    return await launchStageInHerdrAttempt(input);
  } catch (error) {
    return { ok: false, ackStatus: "unknown", agentName: input.agentName, error: String(error) };
  } finally { await release?.(); }
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
  stage = { ...stage, extraFlags: stageFlags(client, stage) };
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
        return [bin, "-p", promptText, "--model", stage.model, ...stage.extraFlags];
      }
      return [bin, "-i", promptText, "--model", stage.model, ...stage.extraFlags];
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
    case "kiro": {
      return [bin, "chat", "--trust-all-tools", "--agent", "ai-harness", "--model", stage.model, ...stage.extraFlags, ...(nonInteractive ? ["--no-interactive"] : []), promptText];
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
