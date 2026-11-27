import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { createProcessCommandAdapter, type RunCommand } from "./client.js";
import { withFileLock } from "./file-lock.js";
import { inputLineText, isVimNormalMode } from "./pane-text.js";
import { reserveHerdrHandle } from "./reservation.js";
import { resolveStateDir } from "./state-dir.js";

const codexLevels = ["low", "medium", "high", "xhigh"] as const;
const claudeLevels = ["low", "medium", "high", "max", "auto"] as const;
const allLevels = ["low", "medium", "high", "xhigh", "max", "auto"] as const;

export const DEFAULT_EFFORT_COOLDOWN_MS = 30_000;
export const DEFAULT_EFFORT_WINDOW_MS = 5 * 60_000;
export const DEFAULT_MAX_EFFORT_SWITCHES = 3;

export interface ChangeEffortOptions {
  allowMidTurnQueue?: boolean;
  cooldownMs?: number;
  maxSwitchesPerWindow?: number;
  windowMs?: number;
  topTierUnlocked?: boolean;
  now?: number;
  stateDir?: string;
}

const CACHE_INVALIDATION_WARNING =
  /cache[- ]?invalidat|invalidat(?:e|ing)\s+(?:prompt\s+)?cache|(?:bedrock|gateway)[^\n]*(?:cache|invalidat)|prompt\s+cache[^\n]*(?:warn|reset|bust|clear)/i;
const SESSION_ONLY_PROMPT =
  /\bs\b[^\n]{0,24}session[- ]only|\(s\)\s*session|\[s\]\s*session|press\s+s\s+for\s+session/i;
const PERSISTENT_SAVE_PROMPT = /\bsettings\.json\b|save\s+as\s+default/i;

const CODEX_WORKING_CHROME =
  /^(?:[\s─━│┃╭╮╯╰┌┐└┘├┤┬┴┼·•⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◑◒◓✳✶✻⏱⏵▶⚡⚙]+|esc\s+to\s+interrupt|working\.{0,3}|running\.{0,3}|type\s+to\s+(?:steer|reply)|tab\s+to\s+queue|\?\s*for\s+shortcuts|context\s+left|\d+%\s*(?:left|context)|ctrl\+[a-z]\s+to\s+\w+)$/i;

const CLAUDE_FOOTER_CHROME =
  /^(?:[\s─━│┃╭╮╯╰┌┐└┘├┤┬┴┼·•]+|\?\s*for\s+shortcuts|bypass\s+permissions.*|shift\+tab.*|ctrl\+[a-z].*|esc\s+to\s+.*|set\s+effort\s+level\s+to\s+.*|effort\s+(?:set\s+to|is\s+now|:).*)$/i;

function isWorkingFooterPrefixClean(prefix: string): boolean {
  if (!prefix.trim()) return true;
  for (const rawLine of prefix.split("\n")) {
    const segments = rawLine
      .split(/[·•│┃|]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const seg of segments) {
      if (!CODEX_WORKING_CHROME.test(seg)) return false;
    }
  }
  return true;
}

function parseCodexScreen(raw: string, allowWorkingFooter: boolean) {
  if (isVimNormalMode(raw)) throw new Error("Codex vim normal mode active; no keys sent");
  const lines = stripVTControlCharacters(raw).replace(/\r/g, "").split("\n");
  const index = lines.map((line) => /^\s*›/.test(line)).lastIndexOf(true);
  if (index < 0) throw new Error("Codex composer unavailable; no keys sent");
  if (inputLineText(raw, /^\s*›/) || lines.slice(index + 1).some((line) => /\bPlan mode\b/.test(line))) {
    throw new Error("Codex input busy or in plan mode; no keys sent");
  }
  const footer = lines.slice(index + 1).join("\n");
  const match = footer.match(/\b(gpt-[\w.-]+)\s+(low|medium|high|xhigh)\b/i);
  if (!match) throw new Error("Codex model and effort footer unavailable; no keys sent");
  const prefix = footer.slice(0, match.index);
  if (prefix.trim()) {
    if (!allowWorkingFooter || !isWorkingFooterPrefixClean(prefix)) {
      throw new Error("Codex wrapped input or unknown footer; no keys sent");
    }
  }
  return { model: match[1]!.toLowerCase(), effort: match[2]!.toLowerCase() };
}

export function codexEffortScreen(raw: string) {
  return parseCodexScreen(raw, false);
}

export function claudeEffortScreen(raw: string): {
  hasComposer: boolean;
  model?: string;
  effort?: string;
  cacheWarning: boolean;
  sessionOnlyPrompt: boolean;
  persistentPrompt: boolean;
} {
  if (isVimNormalMode(raw)) throw new Error("Claude vim normal mode active; no keys sent");
  const stripped = stripVTControlCharacters(raw).replace(/\r/g, "");
  const lines = stripped.split("\n");
  const index = lines.map((line) => /^\s*[❯›]/.test(line)).lastIndexOf(true);

  if (index < 0) {
    const modalTail = lines.filter((line) => line.trim() !== "").slice(-12).join("\n");
    const cacheWarning = CACHE_INVALIDATION_WARNING.test(modalTail);
    const sessionOnlyPrompt = SESSION_ONLY_PROMPT.test(modalTail);
    const persistentPrompt = PERSISTENT_SAVE_PROMPT.test(modalTail);
    if (!cacheWarning && !sessionOnlyPrompt && !persistentPrompt) {
      throw new Error("Claude composer unavailable; no keys sent");
    }
    return { hasComposer: false, cacheWarning, sessionOnlyPrompt, persistentPrompt };
  }

  if (inputLineText(raw, /^\s*[❯›]/)) {
    throw new Error("Claude input busy; no keys sent");
  }

  const tailLines = lines.slice(index + 1);
  const tail = tailLines.join("\n");
  const cacheWarning = CACHE_INVALIDATION_WARNING.test(tail);
  const sessionOnlyPrompt = SESSION_ONLY_PROMPT.test(tail);
  const persistentPrompt = PERSISTENT_SAVE_PROMPT.test(tail);

  const modelMatch = tail.match(/\b(claude-[\w.-]+|opus(?:\s+\d+(?:\.\d+)?)?|sonnet(?:\s+\d+(?:\.\d+)?)?|haiku(?:\s+\d+(?:\.\d+)?)?)\b/i);
  const effortMatch =
    tail.match(/\beffort\s*[:=]\s*(low|medium|high|max|auto)\b/i) ??
    tail.match(/\b(low|medium|high|max|auto)\s+effort\b/i) ??
    tail.match(/\b(?:claude-[\w.-]+|opus(?:\s+\d+(?:\.\d+)?)?|sonnet(?:\s+\d+(?:\.\d+)?)?|haiku(?:\s+\d+(?:\.\d+)?)?)[^\n]*?\b(low|medium|high|max|auto)\b/i) ??
    tail.match(/\b(?:set\s+effort\s+level\s+to|effort\s+(?:set\s+to|is\s+now|:))\s*(low|medium|high|max|auto)\b/i);

  if (!cacheWarning && !sessionOnlyPrompt && !persistentPrompt) {
    const indices = [modelMatch?.index, effortMatch?.index].filter((i): i is number => typeof i === "number");
    const anchorIndex = indices.length > 0 ? Math.min(...indices) : -1;
    const prefix = anchorIndex >= 0 ? tail.slice(0, anchorIndex) : tail;
    for (const rawLine of prefix.split("\n")) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      if (!CLAUDE_FOOTER_CHROME.test(trimmed)) {
        throw new Error("Claude wrapped input or unknown footer; no keys sent");
      }
    }
  }

  return {
    hasComposer: true,
    ...(modelMatch ? { model: modelMatch[1]!.toLowerCase() } : {}),
    ...(effortMatch ? { effort: effortMatch[1]!.toLowerCase() } : {}),
    cacheWarning,
    sessionOnlyPrompt,
    persistentPrompt,
  };
}

const MAX_TRACKED_PANES = 128;

function switchTrackerPath(stateDir?: string): string | null {
  try {
    const dir = stateDir ?? resolveStateDir();
    return join(dir, "effort-switches.json");
  } catch {
    return null;
  }
}

function readSwitchHistory(trackerFile: string | null): Record<string, number[]> {
  if (!trackerFile || !existsSync(trackerFile)) return {};
  try {
    const parsed = JSON.parse(readFileSync(trackerFile, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, number[]>;
  } catch {
    return {};
  }
}

function pruneTimestamps(timestamps: readonly number[] | undefined, now: number, windowMs: number): number[] {
  if (!Array.isArray(timestamps)) return [];
  const cutoff = now - windowMs;
  return timestamps.filter((ts) => typeof ts === "number" && Number.isFinite(ts) && ts >= cutoff && ts <= now);
}

function writeSwitchHistory(trackerFile: string | null, history: Record<string, number[]>, now: number, windowMs: number): void {
  if (!trackerFile) return;
  const pruned: Record<string, number[]> = {};
  for (const [k, list] of Object.entries(history)) {
    const kept = pruneTimestamps(list, now, windowMs);
    if (kept.length > 0) pruned[k] = kept;
  }
  const keys = Object.keys(pruned);
  if (keys.length > MAX_TRACKED_PANES) {
    for (const stale of keys.slice(0, keys.length - MAX_TRACKED_PANES)) delete pruned[stale];
  }
  mkdirSync(dirname(trackerFile), { recursive: true, mode: 0o700 });
  const tmp = `${trackerFile}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(pruned), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, trackerFile);
}

async function withTrackerLock<T>(trackerFile: string | null, fn: () => T | Promise<T>): Promise<T> {
  if (!trackerFile) return fn();
  return withFileLock(`${trackerFile}.lock`, fn);
}

async function assertSwitchAllowed(
  pane: string,
  historyKey: string,
  options: ChangeEffortOptions,
): Promise<{ trackerFile: string | null; now: number; windowMs: number }> {
  const now = options.now ?? Date.now();
  const cooldownMs = options.cooldownMs ?? DEFAULT_EFFORT_COOLDOWN_MS;
  const windowMs = options.windowMs ?? DEFAULT_EFFORT_WINDOW_MS;
  const maxSwitches = options.maxSwitchesPerWindow ?? DEFAULT_MAX_EFFORT_SWITCHES;
  const trackerFile = switchTrackerPath(options.stateDir);

  await withTrackerLock(trackerFile, () => {
    const history = readSwitchHistory(trackerFile);
    const recent = pruneTimestamps(history[historyKey], now, windowMs);

    if (recent.length > 0 && cooldownMs > 0) {
      const elapsed = now - recent[recent.length - 1]!;
      if (elapsed < cooldownMs) {
        const waitSec = Math.ceil((cooldownMs - elapsed) / 1000);
        throw new Error(`Effort switch cooldown active for ${pane}; wait ${waitSec}s before switching again`);
      }
    }
    if (maxSwitches >= 0 && recent.length >= maxSwitches) {
      throw new Error(`Effort switch cap reached for ${pane} (${recent.length}/${maxSwitches} in window)`);
    }
  });

  return { trackerFile, now, windowMs };
}

async function recordSwitch(trackerFile: string | null, historyKey: string, now: number, windowMs: number): Promise<void> {
  if (!trackerFile) return;
  await withTrackerLock(trackerFile, () => {
    const history = readSwitchHistory(trackerFile);
    const recent = pruneTimestamps(history[historyKey], now, windowMs);
    recent.push(now);
    history[historyKey] = recent;
    writeSwitchHistory(trackerFile, history, now, windowMs);
  });
}

export async function changeEffort(
  pane: string,
  level: string,
  run: RunCommand = createProcessCommandAdapter(),
  reserve = reserveHerdrHandle,
  options: ChangeEffortOptions = {},
) {
  if (!/^[a-zA-Z0-9:_-]+$/.test(pane) || !allLevels.includes(level as (typeof allLevels)[number])) {
    throw new Error("Use a pane id and low|medium|high|xhigh|max|auto");
  }
  if ((process.env.CODEX_THREAD_ID || process.env.CLAUDECODE) && pane !== process.env.HERDR_PANE_ID) {
    throw new Error("An agent may only change its own pane effort");
  }
  const release = await reserve(`peer:${pane}`);
  const herdr = process.env.HERDR_BIN_PATH || "herdr";
  const call = async (...args: string[]) => {
    const result = await run([herdr, ...args]);
    if (!result.ok) throw new Error(result.stderr || "Effort acknowledgement unknown; inspect before retrying");
    return result.stdout;
  };
  try {
    const readAgent = async () => JSON.parse(await call("agent", "get", pane)).result?.agent;
    const agent = await readAgent();
    if (!agent || agent.pane_id !== pane || (agent.agent !== "codex" && agent.agent !== "claude")) {
      throw new Error("Live effort requires an idle Codex pane; other clients and working turns remain unchanged");
    }

    const isCodex = agent.agent === "codex";
    const targetLevel = isCodex ? level : level === "xhigh" ? "max" : level;
    if (isCodex && !codexLevels.includes(targetLevel as (typeof codexLevels)[number])) {
      throw new Error("Codex supports effort levels low|medium|high|xhigh");
    }
    if (!isCodex && !claudeLevels.includes(targetLevel as (typeof claudeLevels)[number])) {
      throw new Error("Claude supports effort levels low|medium|high|max|auto");
    }

    const isIdle = ["idle", "done"].includes(agent.agent_status);
    const isWorkingQueue = isCodex && Boolean(options.allowMidTurnQueue) && agent.agent_status === "working";
    if (isCodex && !isIdle && !isWorkingQueue) {
      throw new Error("Live effort requires an idle Codex pane; other clients and working turns remain unchanged");
    }
    if (!isCodex && !isIdle) {
      throw new Error("Live effort requires an idle Claude pane");
    }

    const isWorker = Boolean(
      agent.tokens?.jev_parent ||
        agent.tokens?.jev_role ||
        agent.tokens?.jev_handle ||
        process.env.HERDR_JEV_IS_WORKER === "1",
    );
    const topTierUnlocked = isWorker
      ? options.topTierUnlocked === true
      : (options.topTierUnlocked ?? process.env.HERDR_JEV_TOP_TIER_UNLOCKED === "1");
    if ((targetLevel === "xhigh" || targetLevel === "max") && isWorker && !topTierUnlocked) {
      throw new Error("Top-tier effort (xhigh/max) is gated to root sessions unless topTierUnlocked is set");
    }

    const historyKey = `${pane}:${agent.terminal_id ?? ""}`;

    if (isCodex) {
      const parse = (raw: string) => parseCodexScreen(raw, isWorkingQueue);
      const before = parse(await call("agent", "read", pane, "--source", "visible", "--lines", "60", "--ansi"));
      const current = await readAgent();
      if (
        current?.terminal_id !== agent.terminal_id ||
        current?.agent !== "codex" ||
        !(["idle", "done"].includes(current?.agent_status) || (isWorkingQueue && current?.agent_status === "working")) ||
        current?.agent_session?.value !== agent.agent_session?.value
      ) {
        throw new Error("Codex pane identity changed");
      }
      const second = parse(await call("agent", "read", pane, "--source", "visible", "--lines", "60", "--ansi"));
      if (second.model !== before.model || second.effort !== before.effort) {
        throw new Error("Codex effort changed before dispatch");
      }
      const steps =
        codexLevels.indexOf(targetLevel as (typeof codexLevels)[number]) -
        codexLevels.indexOf(before.effort as (typeof codexLevels)[number]);
      if (!steps) return { status: "unchanged", pane, model: before.model, effort: targetLevel };

      const budget = await assertSwitchAllowed(pane, historyKey, options);
      const preSend = await readAgent();
      if (
        preSend?.terminal_id !== agent.terminal_id ||
        preSend?.agent !== "codex" ||
        preSend?.agent_session?.value !== agent.agent_session?.value ||
        !(isWorkingQueue ? preSend?.agent_status === "working" : ["idle", "done"].includes(preSend?.agent_status))
      ) {
        throw new Error("Codex pane state changed before dispatch");
      }

      const stepKeys = Array.from({ length: Math.abs(steps) }, () => (steps > 0 ? "alt+." : "alt+,"));
      await call("agent", "send-keys", pane, ...(isWorkingQueue ? ["tab", ...stepKeys] : stepKeys));

      for (let attempt = 0; attempt < 10; attempt++) {
        await Bun.sleep(100);
        const observed = await readAgent();
        if (observed?.terminal_id !== agent.terminal_id || observed?.agent_session?.value !== agent.agent_session?.value) {
          throw new Error("Codex pane changed after effort dispatch; outcome unknown");
        }
        if (isWorkingQueue && !["working", "idle", "done"].includes(observed?.agent_status)) {
          throw new Error("Codex pane entered unexpected state during queued effort switch");
        }
        const after = parse(await call("agent", "read", pane, "--source", "visible", "--lines", "60", "--ansi"));
        if (after.model !== before.model) throw new Error("Model changed during effort dispatch; outcome unknown");
        if (after.effort === targetLevel) {
          await recordSwitch(budget.trackerFile, historyKey, budget.now, budget.windowMs);
          return {
            status: "applied",
            pane,
            model: before.model,
            from: before.effort,
            effort: targetLevel,
            effective: "next-turn",
            ...(isWorkingQueue ? { queued: true } : {}),
          };
        }
      }
      throw new Error("Effort not confirmed; no retry or new pane was dispatched");
    }

    // Claude session-only /effort path (never writes ~/.claude/settings.json)
    const beforeRaw = await call("agent", "read", pane, "--source", "visible", "--lines", "60", "--ansi");
    const before = claudeEffortScreen(beforeRaw);
    if (before.cacheWarning || before.persistentPrompt || before.sessionOnlyPrompt) {
      await call("agent", "send-keys", pane, "esc");
      throw new Error("Claude effort change aborted: modal/warning dismissed with esc");
    }
    if (!before.hasComposer) {
      throw new Error("Claude composer unavailable; no keys sent");
    }
    const current = await readAgent();
    if (
      current?.terminal_id !== agent.terminal_id ||
      current?.agent !== "claude" ||
      !["idle", "done"].includes(current?.agent_status) ||
      current?.agent_session?.value !== agent.agent_session?.value
    ) {
      throw new Error("Claude pane identity changed");
    }
    const second = claudeEffortScreen(await call("agent", "read", pane, "--source", "visible", "--lines", "60", "--ansi"));
    if (
      !second.hasComposer ||
      second.cacheWarning ||
      second.persistentPrompt ||
      second.sessionOnlyPrompt ||
      second.model !== before.model ||
      second.effort !== before.effort
    ) {
      throw new Error("Claude effort changed before dispatch");
    }
    if (before.effort === targetLevel) {
      return {
        status: "unchanged",
        pane,
        ...(before.model ? { model: before.model } : {}),
        effort: targetLevel,
        sessionOnly: true,
      };
    }

    const budget = await assertSwitchAllowed(pane, historyKey, options);
    await call("agent", "send-keys", pane, `/effort ${targetLevel}`, "enter");

    let sentSessionKey = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      await Bun.sleep(100);
      const observed = await readAgent();
      if (observed?.terminal_id !== agent.terminal_id || observed?.agent_session?.value !== agent.agent_session?.value) {
        throw new Error("Claude pane changed after effort dispatch; outcome unknown");
      }
      const afterRaw = await call("agent", "read", pane, "--source", "visible", "--lines", "60", "--ansi");
      const after = claudeEffortScreen(afterRaw);
      if (after.cacheWarning) {
        await call("agent", "send-keys", pane, "esc");
        throw new Error("Claude effort change aborted: cache-invalidation warning dismissed with esc");
      }
      if (after.persistentPrompt && !after.sessionOnlyPrompt) {
        await call("agent", "send-keys", pane, "esc");
        throw new Error("Claude effort change aborted: persistent settings prompt dismissed with esc");
      }
      if (after.sessionOnlyPrompt && !sentSessionKey) {
        sentSessionKey = true;
        await call("agent", "send-keys", pane, "s");
        continue;
      }
      if (after.hasComposer && after.effort === targetLevel) {
        await recordSwitch(budget.trackerFile, historyKey, budget.now, budget.windowMs);
        return {
          status: "applied",
          pane,
          ...(after.model ?? before.model ? { model: after.model ?? before.model } : {}),
          ...(before.effort ? { from: before.effort } : {}),
          effort: targetLevel,
          effective: "next-turn",
          sessionOnly: true,
        };
      }
    }
    throw new Error("Effort not confirmed; no retry or new pane was dispatched");
  } finally {
    await release();
  }
}
