import { createProcessCommandAdapter, type RunCommand } from "./client.js";

export async function readOverview(run: RunCommand = createProcessCommandAdapter()) {
  const result = await run([process.env.HERDR_BIN_PATH || "herdr", "api", "snapshot"]);
  if (!result.ok) throw new Error(result.stderr || "Herdr snapshot unavailable");
  const snapshot = JSON.parse(result.stdout).result?.snapshot;
  if (!Array.isArray(snapshot?.agents) || !Array.isArray(snapshot?.workspaces)) {
    throw new Error("Invalid Herdr snapshot");
  }
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
    return {
      project: workspaces.get(agent.workspace_id) ?? agent.workspace_id,
      pane: agent.pane_id,
      state: agent.agent_status ?? "unknown",
      agent: agent.agent,
      model: tokens.quota_model || tokens.jev_model || null,
      parent: tokens.jev_parent || null,
      role: tokens.jev_role || null,
      handle: tokens.jev_handle || null,
      branch: typeof cwd === "string" ? await branches.get(cwd) : null,
      cwd: typeof cwd === "string" ? cwd : null,
      weekly: weekly.map((key) => tokens[key]).find(Boolean) ?? null,
      context: tokens.quota_context || null,
    };
  }));
}
