export const DEFAULT_MAX_AUTO_HOPS = 3;
export const DEFAULT_IDLE_GRACE_SECONDS = 30;

export function canAutoHop(currentHops: number, maxHops: number = DEFAULT_MAX_AUTO_HOPS): boolean {
  if (!Number.isFinite(currentHops) || currentHops < 0) return false;
  if (!Number.isFinite(maxHops) || maxHops <= 0) return false;
  return currentHops < maxHops;
}

export function isPastIdleGrace(
  lastActivityMs: number,
  now: number = Date.now(),
  graceSeconds: number = DEFAULT_IDLE_GRACE_SECONDS,
): boolean {
  if (!Number.isFinite(lastActivityMs) || !Number.isFinite(now) || !Number.isFinite(graceSeconds) || graceSeconds < 0) {
    return false;
  }
  return now - lastActivityMs >= graceSeconds * 1000;
}

export interface SessionRescueRecord {
  paneId?: string;
  terminalId?: string;
  agent?: string;
  agentSession?: string | null;
}

export interface SessionRescuePlan {
  action: "resume" | "none";
  reason: "session-ready" | "still-alive" | "missing-session" | "unsupported-client";
  client?: string;
  sessionId?: string;
  command?: string;
  argv?: string[];
}

const DEAD_AGENT_STATUSES = new Set(["exited", "dead", "stopped"]);
const SAFE_SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;

function extractSessionId(agentSession: unknown): string | undefined {
  if (typeof agentSession === "string") {
    const trimmed = agentSession.trim();
    return trimmed || undefined;
  }
  if (agentSession && typeof agentSession === "object") {
    const rec = agentSession as { kind?: unknown; value?: unknown };
    if (rec.kind === "id" && typeof rec.value === "string" && rec.value.trim()) {
      return rec.value.trim();
    }
    if (rec.kind === undefined && typeof rec.value === "string" && rec.value.trim()) {
      return rec.value.trim();
    }
  }
  return undefined;
}

function isAgentStillAlive(entry: any): boolean {
  if (!entry || typeof entry !== "object") return false;
  if (entry.alive === false) return false;
  if (!entry.agent) return false;
  const status = typeof entry.agent_status === "string" ? entry.agent_status.toLowerCase() : "";
  if (DEAD_AGENT_STATUSES.has(status)) return false;
  return true;
}

export function planSessionRescue(
  record: SessionRescueRecord,
  liveAgents: readonly any[],
): SessionRescuePlan {
  const matched = record.terminalId
    ? liveAgents.find((a) => a && (a.terminal_id === record.terminalId || a.terminalId === record.terminalId))
    : record.paneId
      ? liveAgents.find((a) => a && (a.pane_id === record.paneId || a.paneId === record.paneId))
      : undefined;

  const client =
    (typeof matched?.agent === "string" && matched.agent) ||
    (typeof record.agent === "string" && record.agent) ||
    undefined;
  const sessionId = extractSessionId(matched?.agent_session) ?? extractSessionId(record.agentSession);

  if (matched && isAgentStillAlive(matched)) {
    return {
      action: "none",
      reason: "still-alive",
      ...(client ? { client } : {}),
      ...(sessionId ? { sessionId } : {}),
    };
  }

  if (!sessionId || !SAFE_SESSION_ID.test(sessionId)) {
    return {
      action: "none",
      reason: "missing-session",
      ...(client ? { client } : {}),
    };
  }

  if (client === "claude") {
    const argv = ["claude", "--resume", sessionId];
    return { action: "resume", reason: "session-ready", client, sessionId, argv, command: argv.join(" ") };
  }

  if (client === "codex") {
    const argv = ["codex", "resume", sessionId];
    return { action: "resume", reason: "session-ready", client, sessionId, argv, command: argv.join(" ") };
  }

  return {
    action: "none",
    reason: "unsupported-client",
    ...(client ? { client } : {}),
    sessionId,
  };
}
