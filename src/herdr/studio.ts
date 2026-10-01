import { isAbsolute } from "node:path";
import { createProcessCommandAdapter, type RunCommand } from "./client.js";
import { reserveHerdrHandle } from "./reservation.js";

export async function studio(
  input: { pane: string; review?: boolean; event?: boolean; disable?: boolean },
  run: RunCommand = createProcessCommandAdapter(),
  reserve = reserveHerdrHandle,
) {
  if (!/^[a-zA-Z0-9:_-]+$/.test(input.pane)) throw new Error("Invalid studio source pane");
  const release = await reserve(`studio:${input.pane}`);
  const herdr = process.env.HERDR_BIN_PATH || "herdr";
  const call = async (...args: string[]) => {
    const result = await run([herdr, ...args]);
    if (!result.ok) throw new Error(result.stderr || "Studio command acknowledgement unknown");
    return result.stdout.trim() ? JSON.parse(result.stdout).result : {};
  };
  try {
    const snapshot = (await call("api", "snapshot"))?.snapshot;
    if (!Array.isArray(snapshot?.panes) || !Array.isArray(snapshot?.agents)) throw new Error("Invalid studio snapshot");
    const source = snapshot.agents.find((agent: any) => agent.pane_id === input.pane);
    if (!source || !source.agent || !source.tab_id) {
      if (input.event) return { status: "ignored" };
      throw new Error("Studio requires an existing agent pane");
    }
    const tokens = source.tokens ?? {};
    const session = source.agent_session?.kind === "id" ? source.agent_session.value : source.terminal_id;
    const cwd = source.foreground_cwd || source.cwd;
    if (typeof cwd !== "string" || !isAbsolute(cwd)) throw new Error("Studio repository unavailable");
    const report = async (key: string, value: string) => {
      await call("pane", "report-metadata", input.pane, "--source", "herdr-jev", "--ttl-ms", "86400000", "--token", `${key}=${value}`);
      tokens[key] = value;
    };
    if (input.disable) {
      await report("jev_studio_enabled", "false");
      return { status: "disabled", pane: input.pane };
    }
    if (input.event && (tokens.jev_studio_enabled !== "true" || source.agent_status !== "done"
      || !session || tokens.jev_studio_session !== session || tokens.jev_studio_cwd !== cwd)) return { status: "ignored" };
    if (!input.event) {
      if (!session) throw new Error("Studio requires a verified native session identity");
      await report("jev_studio_session", session);
      await report("jev_studio_cwd", cwd);
      await report("jev_studio_enabled", "true");
    }
    const live = (id: string) => snapshot.panes.find((pane: any) => pane.pane_id === id && pane.tab_id === source.tab_id);
    const open = async (key: string, plugin: string, entry: string, target: string, direction: string) => {
      const previous = tokens[key];
      if (previous === "pending" || previous === "failed") throw new Error("Studio pane dispatch unresolved; inspect panes before clearing metadata");
      if (previous && live(previous)) return previous;
      await report(key, "pending");
      const opened = await call("plugin", "pane", "open", "--plugin", plugin, "--entrypoint", entry,
        "--placement", "split", "--target-pane", target, "--direction", direction, "--cwd", cwd, "--no-focus");
      const id = opened?.plugin_pane?.pane?.pane_id;
      if (typeof id !== "string" || !/^[a-zA-Z0-9:_-]+$/.test(id)) throw new Error("Studio pane dispatch unresolved");
      await report(key, id);
      if (plugin !== "herdr-jev") {
        await Bun.sleep(200);
        const after = (await call("api", "snapshot"))?.snapshot;
        if (!Array.isArray(after?.panes)) throw new Error("Studio pane readiness unknown");
        if (!after.panes.some((pane: any) => pane.pane_id === id)) {
          await report(key, "failed");
          throw new Error(`Studio ${plugin} pane exited; inspect its installed binary before retrying`);
        }
      }
      return id;
    };
    if (!input.review && !input.event) {
      const shell = await open("jev_studio_shell", "herdr-jev", "studio-shell", input.pane, "right");
      const sidebar = snapshot.panes.find((pane: any) => pane.tab_id === source.tab_id && pane.tokens?.["herdr-sidebar-explorer"]);
      if (!sidebar) await open("jev_studio_files", "herdr-sidebar", "sidebar", shell, "right");
      return { status: "enabled", pane: input.pane, shell, autoReview: true };
    }
    const git = await run(["git", "-C", cwd, "status", "--porcelain"]);
    if (!git.ok) return { status: "ignored", reason: "not-a-repository" };
    let changed = Boolean(git.stdout.trim());
    if (!changed) {
      for (const ref of ["origin/main", "main", "origin/master", "master", "@{upstream}"]) {
        const base = await run(["git", "-C", cwd, "merge-base", "HEAD", ref]);
        if (!base.ok) continue;
        const diff = await run(["git", "-C", cwd, "diff", "--quiet", base.stdout.trim(), "--"]);
        if (diff.code > 1) throw new Error("Studio diff unavailable");
        changed = diff.code === 1;
        if (changed) break;
      }
    }
    if (!changed && input.event) return { status: "ignored", reason: "no-changes" };
    const target = live(tokens.jev_studio_shell)?.pane_id || input.pane;
    const review = await open("jev_studio_review", "persiyanov.reviewr", "sidebar", target, "down");
    return { status: "review-open", pane: input.pane, review, completion: "reported" };
  } finally { await release(); }
}

export function studioEventPane(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const event = JSON.parse(raw);
  const data = event.data ?? event;
  if ((data.status ?? data.agent_status ?? data.agent?.agent_status) !== "done") return undefined;
  return data.pane_id ?? data.agent?.pane_id ?? data.pane?.pane_id;
}
