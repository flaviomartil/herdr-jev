import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { createProcessCommandAdapter, type RunCommand } from "./client.js";
import { ANSI_PATTERN, redactSecrets } from "./pane-text.js";
import { reserveHerdrHandle } from "./reservation.js";
import { historyCommand } from "./sessions.js";

export const PROGRESS_TTL_MS = 300_000;
const REASONS = ["none", "question", "approval", "error", "review"] as const;
type ProgressReason = typeof REASONS[number];

export interface ProgressReport {
  terminalId: string;
  sessionId: string;
  agent: string;
  cwd: string;
  activity: string;
  percent: number | null;
  reason: ProgressReason;
  reportedAt: number;
  inbox: string | null;
}

function cleanActivity(activity: string): string {
  return redactSecrets(activity).replace(ANSI_PATTERN, "").replace(/[\p{Cc}\p{Cf}]/gu, " ").trim().slice(0, 120);
}

function identity(agent: any) {
  const cwd = agent?.foreground_cwd || agent?.cwd;
  const terminalId = agent?.terminal_id;
  const sessionId = agent?.agent_session?.kind === "id" ? agent.agent_session.value : terminalId;
  if (typeof terminalId !== "string" || !terminalId || typeof sessionId !== "string" || !sessionId
    || typeof agent?.agent !== "string" || !agent.agent || typeof cwd !== "string" || !isAbsolute(cwd)) return null;
  return { terminalId, sessionId, agent: agent.agent, cwd };
}

export function progressForAgent(agent: any, now = Date.now()): ProgressReport | null {
  const expected = identity(agent);
  const token = agent?.tokens?.jev_progress;
  if (!expected || typeof token !== "string" || token.length > 4096) return null;
  try {
    const report = JSON.parse(token);
    if (!report || Object.entries(expected).some(([key, value]) => report[key] !== value)
      || !Number.isSafeInteger(report.reportedAt) || report.reportedAt > now || now - report.reportedAt >= PROGRESS_TTL_MS
      || typeof report.activity !== "string" || !report.activity || cleanActivity(report.activity) !== report.activity
      || (report.percent !== null && (!Number.isInteger(report.percent) || report.percent < 0 || report.percent > 100))
      || !REASONS.includes(report.reason)
      || (report.inbox !== null && (typeof report.inbox !== "string" || !/^[a-zA-Z0-9:_-]{1,128}$/.test(report.inbox)))) return null;
    return { ...expected, activity: report.activity, percent: report.percent, reason: report.reason,
      reportedAt: report.reportedAt, inbox: report.inbox };
  } catch { return null; }
}

export function progressAttention(state: string, report: ProgressReport | null) {
  if (state === "blocked") return { attention: "now", attentionReason: report && ["question", "approval", "error"].includes(report.reason) ? report.reason : "blocked" };
  if (report && ["question", "approval", "error"].includes(report.reason)) return { attention: "now", attentionReason: report.reason };
  if (report && (report.reason === "review" || report.percent === 100) && ["idle", "done"].includes(state)) {
    return { attention: "soon", attentionReason: "review" };
  }
  return { attention: "none", attentionReason: null };
}

export async function reportProgress(
  input: { pane: string; activity: string; percent?: number; reason?: string; event?: string },
  run: RunCommand = createProcessCommandAdapter(),
  history: (args: string[]) => Promise<any> = historyCommand,
  reserve = reserveHerdrHandle,
  now = Date.now(),
) {
  if (!/^[a-zA-Z0-9:_-]+$/.test(input.pane) || input.pane !== process.env.HERDR_PANE_ID) throw new Error("Progress can only be reported for the caller's own pane");
  if (typeof input.activity !== "string" || input.activity.length > 2048 || !cleanActivity(input.activity)) throw new Error("Invalid progress activity");
  if (input.percent !== undefined && (!Number.isInteger(input.percent) || input.percent < 0 || input.percent > 100)) throw new Error("Progress percent must be 0 to 100");
  const reason = input.reason === undefined || input.reason === "none" ? input.percent === 100 ? "review" : "none" : input.reason;
  if (!REASONS.includes(reason as ProgressReason)) throw new Error("Invalid progress reason");
  if (input.event !== undefined && !/^[a-zA-Z0-9:_-]{1,128}$/.test(input.event)) throw new Error("Invalid progress event key");
  const release = await reserve(`progress:${input.pane}`);
  try {
    const herdr = process.env.HERDR_BIN_PATH || "herdr";
    const result = await run([herdr, "agent", "get", input.pane]);
    if (!result.ok) throw new Error("Progress source unavailable");
    const agent = JSON.parse(result.stdout).result?.agent;
    const source = identity(agent);
    if (!source || agent.pane_id !== input.pane) throw new Error("Progress requires a verified agent and terminal identity");
    const report: ProgressReport = { ...source, activity: cleanActivity(input.activity), percent: input.percent ?? null,
      reason: reason as ProgressReason, reportedAt: now, inbox: null };
    if (reason !== "none") {
      if (agent.agent_session?.kind !== "id" || !["claude", "codex", "kimi", "opencode"].includes(source.agent)) throw new Error("Inbox requires an indexed native source session");
      const session = `${source.agent}:${source.sessionId}`;
      const shown = await history(["show", "--session", session, "--no-index", "--limit", "1", "--budget", "512"]);
      if (shown.session?.native_id !== source.sessionId || shown.session?.client !== source.agent || shown.session?.cwd !== source.cwd) throw new Error("Progress source session does not match its repository");
      const event = input.event ?? createHash("sha256").update(JSON.stringify([reason, report.activity])).digest("hex");
      const pending = await history(["work-event", "--session", shown.session.key, "--event", event, "--kind", reason, "--title", report.activity]);
      if (typeof pending.work?.id !== "string" || !/^[a-zA-Z0-9:_-]{1,128}$/.test(pending.work.id)) throw new Error("Inbox acknowledgement invalid; inspect pending work before retrying");
      report.inbox = pending.work.id;
    }
    const reported = await run([herdr, "pane", "report-metadata", input.pane, "--source", "herdr-jev",
      "--ttl-ms", String(PROGRESS_TTL_MS), "--token", `jev_progress=${JSON.stringify(report)}`]);
    if (!reported.ok) throw new Error("Progress dispatch unconfirmed; any inbox event remains pending");
    return { status: "reported", pane: input.pane, report, evidence: "reported" };
  } finally { await release(); }
}
