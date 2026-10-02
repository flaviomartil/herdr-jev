import { basename } from "node:path";
import { spawnSync } from "node:child_process";
import { readGridWorkerRecords, readAllGridWorkerRecords, pruneGridWorkers, settleDeadRecords, type GridWorkerRecord } from "./launcher.js";
import { readOverview, matchRunForPane, formatOverviewRun } from "./overview.js";
import { listRunHistory, type RunHistoryEntry } from "../orchestration/run-history.js";
import { createHerdrClient, type HerdrClient } from "./client.js";
import { listHarnessRunsAsync, type HarnessWorkerRun } from "../harness/bridge.js";

export type AgentState = "blocked" | "working" | "idle" | "done" | "unknown";

export interface AgentRow {
  slot: number;
  state: AgentState;
  loud: boolean;
  handle: string | null;
  client: string | null;
  model: string | null;
  branch: string | null;
  commitsAhead: number | null;
  uncommitted: number | null;
  run: string | null;
  paneId?: string;
  callerPaneId?: string;
  runId?: string;
  runState?: string;
}

export interface AgentProjectGroup {
  project: string;
  rows: AgentRow[];
}

export type GitRunner = (
  args: string[],
  cwd?: string,
) => Promise<{ ok: boolean; stdout: string; stderr: string; code?: number } | string>;

export interface AgentsViewDeps {
  stateDir?: string;
  git?: GitRunner;
  gitRunner?: GitRunner;
  overviewData?: readonly any[];
  readOverview?: () => Promise<any[]>;
  runs?: readonly RunHistoryEntry[];
  now?: number;
  workers?: readonly GridWorkerRecord[];
  client?: HerdrClient;
  herdrClient?: HerdrClient;
  harnessRuns?: readonly HarnessWorkerRun[] | null;
}

const HARNESS_RUNS_TIMEOUT_MS = 3_000;

export const defaultGitRunner: GitRunner = async (args: string[], cwd?: string) => {
  const proc = spawnSync("git", args, { cwd: cwd ?? process.cwd(), encoding: "utf8" });
  return {
    ok: proc.status === 0,
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? "",
    code: proc.status ?? 1,
  };
};

async function execGit(
  runner: GitRunner,
  args: string[],
  cwd?: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const res = await runner(args, cwd);
    if (typeof res === "string") {
      return { ok: true, stdout: res, stderr: "" };
    }
    return {
      ok: res.ok ?? (res.code === 0),
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
    };
  } catch (err) {
    return { ok: false, stdout: "", stderr: String(err) };
  }
}

function normalizeState(state?: string | null): AgentState {
  if (!state) return "unknown";
  const s = state.toLowerCase();
  if (s === "blocked") return "blocked";
  if (s === "working" || s === "running") return "working";
  if (s === "idle") return "idle";
  if (s === "done" || s === "completed" || s === "finished") return "done";
  return "unknown";
}

function parseLivePaneIds(stdout: string): Set<string> | null {
  if (!stdout || !stdout.trim()) return null;
  let parsed: any = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    const firstBrace = stdout.indexOf("{");
    const lastBrace = stdout.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        parsed = JSON.parse(stdout.slice(firstBrace, lastBrace + 1));
      } catch {
      }
    }
  }
  if (parsed) {
    const layout = parsed.result?.layout ?? parsed.layout ?? parsed.result?.panes ?? parsed.panes ?? parsed.result ?? parsed;
    const panes = Array.isArray(layout.panes)
      ? layout.panes
      : Array.isArray(layout)
      ? layout
      : [];
    const ids = panes
      .map((p: any) => (typeof p === "string" ? p : p?.pane_id ?? p?.id))
      .filter((id: any): id is string => typeof id === "string" && id.length > 0);
    return ids.length > 0 ? new Set(ids) : null;
  }
  return null;
}

export async function buildAgentsView(
  callerPaneId?: string,
  deps?: AgentsViewDeps,
): Promise<AgentProjectGroup[]> {
  const git = deps?.git ?? deps?.gitRunner ?? defaultGitRunner;
  let workers: GridWorkerRecord[] = [];
  if (deps?.workers) {
    workers = [...deps.workers];
  } else if (callerPaneId) {
    workers = readGridWorkerRecords(callerPaneId, deps?.stateDir);
  } else if (process.env.HERDR_PANE_ID) {
    workers = readGridWorkerRecords(process.env.HERDR_PANE_ID, deps?.stateDir);
  } else {
    workers = readAllGridWorkerRecords(deps?.stateDir);
  }

  const herdr = deps?.client ?? deps?.herdrClient ?? (deps?.workers || deps?.stateDir ? undefined : createHerdrClient());
  let livePaneIds: Set<string> | null = null;
  let liveScope: "all" | "tab" = "all";
  const fallbackCaller = callerPaneId ?? process.env.HERDR_PANE_ID;
  if (herdr) {
    try {
      if (herdr.listPanes) {
        const res = await herdr.listPanes();
        if (res.ok) {
          livePaneIds = parseLivePaneIds(res.stdout);
        }
      }
      if (!livePaneIds && herdr.paneLayout && fallbackCaller) {
        const res = await herdr.paneLayout(fallbackCaller);
        if (res.ok) {
          livePaneIds = parseLivePaneIds(res.stdout);
          liveScope = "tab";
        }
      }
    } catch {
    }
  }

  if (livePaneIds) {
    const live = livePaneIds;
    const deadWorkers: GridWorkerRecord[] = [];
    const liveWorkers: GridWorkerRecord[] = [];
    for (const w of workers) {
      const caller = w.callerPaneId ?? fallbackCaller;
      const verifiable = !!caller && live.has(caller) && !(liveScope === "tab" && w.layout === "tab");
      if (!verifiable || live.has(w.paneId)) {
        liveWorkers.push(w);
      } else {
        deadWorkers.push(w);
      }
    }
    if (deadWorkers.length > 0) {
      workers = liveWorkers;
      try {
        const { kept } = settleDeadRecords(deadWorkers);
        pruneGridWorkers(deadWorkers.map((w) => w.paneId), deps?.stateDir, { kept });
      } catch {
      }
    }
  }

  let overviewData: any[] = [];
  if (deps?.overviewData) {
    overviewData = [...deps.overviewData];
  } else if (deps?.readOverview) {
    try {
      overviewData = await deps.readOverview();
    } catch {
      overviewData = [];
    }
  } else {
    try {
      overviewData = await readOverview();
    } catch {
      overviewData = [];
    }
  }

  let runs: readonly RunHistoryEntry[] = [];
  if (deps?.runs) {
    runs = deps.runs;
  } else {
    try {
      runs = listRunHistory();
    } catch {
      runs = [];
    }
  }

  let harnessRuns: readonly HarnessWorkerRun[] = [];
  if (workers.some((worker) => worker.runId)) {
    if (deps?.harnessRuns !== undefined) harnessRuns = deps.harnessRuns ?? [];
    else harnessRuns = (await listHarnessRunsAsync({ limit: 100, kind: "worker" }, { timeout: HARNESS_RUNS_TIMEOUT_MS })) ?? [];
  }

  const groupsMap = new Map<string, AgentRow[]>();

  for (let i = 0; i < workers.length; i++) {
    const worker = workers[i];
    const slot = i + 1;
    const overviewAgent = overviewData.find(
      (a) => a.pane === worker.paneId || (worker.handle && a.handle === worker.handle),
    );

    const workerCwd = worker.cwd || overviewAgent?.cwd || process.cwd();

    const topLevelRes = await execGit(git, ["rev-parse", "--show-toplevel"], workerCwd);
    let project = "unknown";
    if (topLevelRes.ok && topLevelRes.stdout.trim()) {
      project = basename(topLevelRes.stdout.trim());
    } else if (workerCwd) {
      project = basename(workerCwd);
    }

    const state = normalizeState(overviewAgent?.state);
    const loud = state === "blocked";
    const handle = worker.handle ?? overviewAgent?.handle ?? null;
    const client = overviewAgent?.agent ?? overviewAgent?.client ?? null;
    const model = overviewAgent?.model ?? null;

    let branch = worker.branch ?? overviewAgent?.branch ?? null;
    if (!branch) {
      const branchRes = await execGit(git, ["rev-parse", "--abbrev-ref", "HEAD"], workerCwd);
      if (branchRes.ok && branchRes.stdout.trim()) {
        branch = branchRes.stdout.trim();
      }
    }

    let commitsAhead: number | null = null;
    if (worker.forkSha) {
      const revListRes = await execGit(git, ["rev-list", "--count", `${worker.forkSha}..HEAD`], workerCwd);
      if (revListRes.ok) {
        const val = parseInt(revListRes.stdout.trim(), 10);
        commitsAhead = Number.isFinite(val) ? val : null;
      }
    }

    let uncommitted: number | null = null;
    const statusRes = await execGit(git, ["status", "--porcelain"], workerCwd);
    if (statusRes.ok) {
      uncommitted = statusRes.stdout
        .split("\n")
        .filter((l) => l.trim().length > 0).length;
    }

    let run: string | null = null;
    if (overviewAgent?.run && typeof overviewAgent.run === "string" && overviewAgent.run.length > 0) {
      run = overviewAgent.run;
    } else {
      const matched = matchRunForPane(runs, {
        pane: worker.paneId,
        handle,
        agent: client,
        cwd: workerCwd,
      });
      if (matched) {
        const formatted = formatOverviewRun(matched, deps?.now);
        run = formatted.length > 0 ? formatted : null;
      }
    }

    const harnessRun = worker.runId ? harnessRuns.find((candidate) => candidate.id === worker.runId) : undefined;
    const runState = harnessRun?.stages?.[0]?.state ?? (typeof harnessRun?.state === "string" ? harnessRun.state : undefined);
    if (!run && runState) run = `worker: ${runState}`;

    const row: AgentRow = {
      slot,
      state,
      loud,
      handle,
      client,
      model,
      branch,
      commitsAhead,
      uncommitted,
      run,
      paneId: worker.paneId,
      callerPaneId: worker.callerPaneId ?? callerPaneId,
      ...(worker.runId ? { runId: worker.runId } : {}),
      ...(worker.runId && runState ? { runState } : {}),
    };

    const groupRows = groupsMap.get(project) ?? [];
    groupRows.push(row);
    groupsMap.set(project, groupRows);
  }

  const result: AgentProjectGroup[] = [];
  for (const [project, rows] of groupsMap) {
    rows.sort((a, b) => a.slot - b.slot);
    result.push({ project, rows });
  }

  return result;
}

export function formatAgentsTable(groups: AgentProjectGroup[]): string {
  const totalRows = groups.reduce((acc, g) => acc + g.rows.length, 0);
  if (totalRows === 0) {
    return "No tracked grid agents.";
  }
  const lines: string[] = [];
  for (const group of groups) {
    if (lines.length > 0) lines.push("");
    lines.push(group.project);
    lines.push("  #  STATE    C/U   HANDLE        CLIENT       MODEL        BRANCH            RUN");
    for (const r of group.rows) {
      const slotStr = String(r.slot).padEnd(3);
      const stateText = r.state.padEnd(8);
      const stateStr = r.loud ? `\x1b[7m\x1b[31m${stateText}\x1b[0m` : stateText;
      const counts = `${r.commitsAhead ?? "-"}/${r.uncommitted ?? "-"}`.padEnd(6);
      const handle = (r.handle ?? "-").padEnd(14);
      const client = (r.client ?? "-").padEnd(13);
      const model = (r.model ?? "-").padEnd(13);
      const branch = (r.branch ?? "-").padEnd(18);
      const run = r.run ?? "";
      lines.push(`  ${slotStr}${stateStr} ${counts}${handle}${client}${model}${branch}${run}`.trimEnd());
    }
  }
  return lines.join("\n");
}

export async function setupWorktree(options: { worktree?: boolean | string; name?: string; gitRunner?: any }, finalCwd: string): Promise<{ worktreePath: string | null; worktreeBranch: string | null; error?: string }> {
  const runner: GitRunner = options.gitRunner || defaultGitRunner;
  const toplevelRes = await execGit(runner, ["rev-parse", "--show-toplevel"], finalCwd);
  if (!toplevelRes.ok) {
    return { worktreePath: null, worktreeBranch: null, error: `Error: Directory is not inside a git repository (${finalCwd})` };
  }
  const repoDir = toplevelRes.stdout.trim();
  const slug = (typeof options.worktree === "string" && options.worktree) ? options.worktree : (options.name || Math.random().toString(36).substring(2, 8));
  if (slug.startsWith("codex/")) {
    return { worktreePath: null, worktreeBranch: null, error: `Error: Worktree branch name cannot start with codex/` };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug) || slug.includes("..") || slug.endsWith(".lock") || slug.endsWith(".")) {
    return { worktreePath: null, worktreeBranch: null, error: `Error: Invalid worktree slug` };
  }
  const branchName = `wt/${slug}`;
  const targetDir = `${repoDir}-wt-${slug}`;
  if (require("node:path").dirname(targetDir) !== require("node:path").dirname(repoDir)) {
    return { worktreePath: null, worktreeBranch: null, error: `Error: targetDir must be a sibling of repoDir` };
  }
  const targetCommonDirRes = await execGit(runner, ["rev-parse", "--path-format=absolute", "--git-common-dir"], targetDir);
  if (targetCommonDirRes.ok && targetCommonDirRes.stdout.trim() !== "") {
    const commonDirRes = await execGit(runner, ["rev-parse", "--path-format=absolute", "--git-common-dir"], repoDir);
    if (commonDirRes.ok && targetCommonDirRes.stdout.trim() === commonDirRes.stdout.trim()) {
      const targetBranchRes = await execGit(runner, ["rev-parse", "--abbrev-ref", "HEAD"], targetDir);
      if (targetBranchRes.ok && targetBranchRes.stdout.trim() === branchName) {
        return { worktreePath: targetDir, worktreeBranch: branchName };
      }
      return { worktreePath: null, worktreeBranch: null, error: `Error: Directory ${targetDir} is a worktree but not on branch ${branchName}` };
    } else {
      return { worktreePath: null, worktreeBranch: null, error: `Error: Directory ${targetDir} already exists but is not a worktree of ${repoDir}` };
    }
  } else {
    const branchRes = await execGit(runner, ["show-ref", "--verify", `refs/heads/${branchName}`], repoDir);
    if (branchRes.ok && branchRes.stdout.trim() !== "") {
      return { worktreePath: null, worktreeBranch: null, error: `Error: Branch ${branchName} already exists` };
    }
    const addRes = await execGit(runner, ["worktree", "add", "-b", branchName, targetDir, "HEAD"], repoDir);
    if (!addRes.ok) {
      return { worktreePath: null, worktreeBranch: null, error: `Error creating worktree: ${addRes.stderr}` };
    }
    return { worktreePath: targetDir, worktreeBranch: branchName };
  }
}
