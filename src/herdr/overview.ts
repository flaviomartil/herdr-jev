import { createProcessCommandAdapter, type RunCommand } from "./client.js";
import { listRunHistory, runStateSummary, formatRunAge, type RunHistoryEntry } from "../orchestration/run-history.js";

function runReferencesPane(
  projection: Record<string, any>,
  paneId: string,
  handle?: string | null,
  agentName?: string | null,
): boolean {
  const targets = new Set([paneId, handle, agentName].filter((id): id is string => typeof id === "string" && id.length > 0));
  if (!targets.size) return false;

  const matches = (value: unknown) => typeof value === "string" && targets.has(value);

  if (matches(projection.pane) || matches(projection.agent) || matches(projection.pane_id)) return true;

  const tasks = Array.isArray(projection.tasks) ? projection.tasks : Array.isArray(projection.stages) ? projection.stages : [];
  for (const task of tasks) {
    if (!task || typeof task !== "object") continue;
    if (matches(task.pane) || matches(task.agent) || matches(task.pane_id)) return true;
    if (Array.isArray(task.attempts)) {
      for (const attempt of task.attempts) {
        if (!attempt || typeof attempt !== "object") continue;
        if (matches(attempt.pane) || matches(attempt.agent) || matches(attempt.pane_id)) return true;
      }
    }
  }
  return false;
}

function runMatchesCwd(projection: Record<string, any>, paneCwd?: string | null): boolean {
  if (!paneCwd || typeof paneCwd !== "string") return false;
  const cwd = projection.cwd ?? projection.run?.cwd;
  return typeof cwd === "string" && cwd === paneCwd;
}

export function matchRunForPane(
  runs: readonly RunHistoryEntry[],
  pane: { pane: string; handle?: string | null; agent?: string | null; cwd?: string | null },
): RunHistoryEntry | undefined {
  const sorted = [...runs].sort((a, b) => b.timestampMs - a.timestampMs || b.mtimeMs - a.mtimeMs);
  const directMatch = sorted.find((r) => runReferencesPane(r.projection, pane.pane, pane.handle, pane.agent));
  if (directMatch) return directMatch;
  if (pane.cwd) {
    return sorted.find((r) => runMatchesCwd(r.projection, pane.cwd));
  }
  return undefined;
}

export function cleanModel(model?: string | null): string | null {
  if (typeof model !== "string") return null;
  const cleaned = model.replace(/^[\s\u200B\u200C\u200D\uFEFF]+|[\s\u200B\u200C\u200D\uFEFF]+$/g, "").trim();
  return cleaned.length > 0 ? cleaned : null;
}

export function formatOverviewRun(entry?: RunHistoryEntry, now?: number): string {
  if (!entry) return "";
  const summary = runStateSummary(entry.projection);
  const age = formatRunAge(entry.timestampMs, now);
  return `${summary} ${age}`.trim();
}

export async function readOverview(
  run: RunCommand = createProcessCommandAdapter(),
  runsOrStateDir?: readonly RunHistoryEntry[] | string,
  now?: number,
) {
  const result = await run([process.env.HERDR_BIN_PATH || "herdr", "api", "snapshot"]);
  if (!result.ok) throw new Error(result.stderr || "Herdr snapshot unavailable");
  const snapshot = JSON.parse(result.stdout).result?.snapshot;
  if (!Array.isArray(snapshot?.agents) || !Array.isArray(snapshot?.workspaces)) {
    throw new Error("Invalid Herdr snapshot");
  }
  const runs = Array.isArray(runsOrStateDir)
    ? runsOrStateDir
    : listRunHistory(typeof runsOrStateDir === "string" ? runsOrStateDir : undefined);
  const workspaces = new Map<string, string>(snapshot.workspaces.map((w: any) => [w.workspace_id, w.label]));
  const branches = new Map<string, Promise<string | null>>();
  return Promise.all(snapshot.agents.map(async (agent: any) => {
    const cwd = agent.foreground_cwd || agent.cwd;
    if (typeof cwd === "string" && !branches.has(cwd)) {
      branches.set(cwd, run(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"])
        .then((git) => git.ok ? git.stdout.trim() : null));
    }
    const tokens = agent.tokens ?? {};
    const weekly = ["quota_week_normal", "quota_week_warning", "quota_week_danger", "quota_week_unknown",
      "quota_week_inline_normal", "quota_week_inline_warning", "quota_week_inline_danger", "quota_week_inline_unknown"];
    const pane = agent.pane_id;
    const handle = tokens.jev_handle || null;
    const matchedRun = matchRunForPane(runs, {
      pane,
      handle,
      agent: agent.agent || null,
      cwd: typeof cwd === "string" ? cwd : null,
    });
    return {
      project: workspaces.get(agent.workspace_id) ?? agent.workspace_id,
      pane: agent.pane_id,
      state: agent.agent_status ?? "unknown",
      agent: agent.agent,
      model: cleanModel(tokens.quota_model || tokens.jev_model),
      parent: tokens.jev_parent || null,
      role: tokens.jev_role || null,
      handle,
      branch: typeof cwd === "string" ? await branches.get(cwd) : null,
      cwd: typeof cwd === "string" ? cwd : null,
      weekly: weekly.map((key) => tokens[key]).find(Boolean) ?? null,
      context: tokens.quota_context || null,
      run: formatOverviewRun(matchedRun, now),
    };
  }));
}
