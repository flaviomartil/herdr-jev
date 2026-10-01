import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { cleanModel, matchRunForPane, readOverview } from "./overview.js";
import { listRunHistory, runStateSummary, type RunHistoryEntry } from "../orchestration/run-history.js";
import { lastMeaningfulLine, redactSecrets } from "./pane-text.js";
import { defaultGitRunner, type GitRunner } from "./agents.js";
import { createProcessCommandAdapter, type HerdrClient, type RunCommand } from "./client.js";

export interface DailyAgentItem {
  project: string;
  agent: string;
  handle: string | null;
  model: string | null;
  state: string;
  branch: string | null;
  cwd: string | null;
  commitsCount: number;
  commitSubjects: string[];
  uncommittedCount: number;
  runSummary: string | null;
  lastLine: string | null;
  paneId: string;
}

export interface DailyProjectGroup {
  project: string;
  branch: string | null;
  agents: DailyAgentItem[];
}

export interface DailyReport {
  date: Date;
  projects: DailyProjectGroup[];
}

export interface DailyReportOptions {
  since?: string | Date;
  now?: number;
}

export interface DailyReportDeps {
  overview?: readonly any[];
  readOverview?: () => Promise<any[]>;
  git?: GitRunner;
  gitRunner?: GitRunner;
  runs?: readonly RunHistoryEntry[];
  listRunHistory?: (stateDir?: string) => RunHistoryEntry[];
  stateDir?: string;
  readPane?: (paneId: string, lines?: number) => Promise<string | { ok: boolean; stdout: string }>;
  herdrClient?: HerdrClient;
  runCommand?: RunCommand;
  now?: number;
}

function sanitizeText(text: string): string {
  return text
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}\u{1F100}-\u{1F64F}\u{1F680}-\u{1F6FF}]/gu, "")
    .replace(/[•·]/g, "-");
}

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

export async function buildDailyReport(
  deps?: DailyReportDeps,
  options?: DailyReportOptions,
): Promise<DailyReport> {
  const now = deps?.now ?? options?.now ?? Date.now();
  let sinceTimestamp: number;
  let gitSinceArg: string;

  if (options?.since) {
    const parsedSince = typeof options.since === "string" ? new Date(options.since) : options.since;
    sinceTimestamp = parsedSince.getTime();
    gitSinceArg = `--since=${typeof options.since === "string" ? options.since : options.since.toISOString()}`;
  } else {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    sinceTimestamp = midnight.getTime();
    gitSinceArg = "--since=midnight";
  }

  let overviewRows: any[];
  if (deps?.overview) {
    overviewRows = [...deps.overview];
  } else if (deps?.readOverview) {
    overviewRows = await deps.readOverview();
  } else {
    overviewRows = await readOverview(deps?.runCommand, deps?.runs ?? deps?.stateDir, now);
  }

  let allRuns: readonly RunHistoryEntry[];
  if (deps?.runs) {
    allRuns = deps.runs;
  } else if (deps?.listRunHistory) {
    allRuns = deps.listRunHistory(deps?.stateDir);
  } else {
    allRuns = listRunHistory(deps?.stateDir);
  }

  const todayRuns = allRuns.filter((r) => r.timestampMs >= sinceTimestamp);
  const git = deps?.git ?? deps?.gitRunner ?? defaultGitRunner;

  const cwdCache = new Map<
    string,
    Promise<{
      commitsCount: number;
      commitSubjects: string[];
      uncommittedCount: number;
      branch: string | null;
    }>
  >();

  const getCwdInfo = (cwd: string | null) => {
    if (!cwd) {
      return Promise.resolve({
        commitsCount: 0,
        commitSubjects: [],
        uncommittedCount: 0,
        branch: null,
      });
    }
    if (!cwdCache.has(cwd)) {
      cwdCache.set(
        cwd,
        (async () => {
          const [logRes, statusRes, branchRes] = await Promise.all([
            execGit(git, ["log", gitSinceArg, "--pretty=%s"], cwd),
            execGit(git, ["status", "--porcelain"], cwd),
            execGit(git, ["rev-parse", "--abbrev-ref", "HEAD"], cwd),
          ]);

          const commits = logRes.ok
            ? logRes.stdout
                .split("\n")
                .map((s) => s.trim())
                .filter((s) => s.length > 0)
            : [];
          const uncommittedCount = statusRes.ok
            ? statusRes.stdout
                .split("\n")
                .map((s) => s.trim())
                .filter((s) => s.length > 0).length
            : 0;
          const branch = branchRes.ok && branchRes.stdout.trim() ? branchRes.stdout.trim() : null;

          return {
            commitsCount: commits.length,
            commitSubjects: commits.slice(0, 3).map(sanitizeText),
            uncommittedCount,
            branch,
          };
        })(),
      );
    }
    return cwdCache.get(cwd)!;
  };

  const readPaneText = async (paneId: string): Promise<string> => {
    if (deps?.readPane) {
      const res = await deps.readPane(paneId, 40);
      if (typeof res === "string") return res;
      return res.ok ? res.stdout : "";
    }
    if (deps?.herdrClient?.readPane) {
      const res = await deps.herdrClient.readPane(paneId, 40);
      return res.ok ? res.stdout : "";
    }
    const runCmd = deps?.runCommand ?? createProcessCommandAdapter();
    const res = await runCmd([process.env.HERDR_BIN_PATH || "herdr", "pane", "read", paneId, "--lines", "40"]);
    return res.ok ? res.stdout : "";
  };

  const projectMap = new Map<string, DailyAgentItem[]>();
  const projectBranchMap = new Map<string, string | null>();

  for (const row of overviewRows) {
    const project = row.project || "unknown";
    const paneId = row.pane ?? "";
    const cwd = row.cwd ?? null;
    const cwdInfo = await getCwdInfo(cwd);

    const handle = row.handle ?? null;
    const agent = row.agent || "agent";
    const model = cleanModel(row.model);
    const state = row.state ?? "unknown";
    const branch = cwdInfo.branch ?? row.branch ?? null;

    if (!projectBranchMap.has(project) && branch) {
      projectBranchMap.set(project, branch);
    }

    const matchedRun = matchRunForPane(todayRuns, {
      pane: paneId,
      handle,
      agent,
      cwd,
    });
    const runSummary = matchedRun ? runStateSummary(matchedRun.projection) : null;

    let lastLine: string | null = null;
    if (paneId) {
      try {
        const rawPane = await readPaneText(paneId);
        const meaningful = lastMeaningfulLine(rawPane);
        if (meaningful) {
          lastLine = sanitizeText(redactSecrets(meaningful));
        }
      } catch {
        lastLine = null;
      }
    }

    const agentItem: DailyAgentItem = {
      project,
      agent,
      handle,
      model,
      state,
      branch,
      cwd,
      commitsCount: cwdInfo.commitsCount,
      commitSubjects: cwdInfo.commitSubjects,
      uncommittedCount: cwdInfo.uncommittedCount,
      runSummary,
      lastLine,
      paneId,
    };

    const group = projectMap.get(project) ?? [];
    group.push(agentItem);
    projectMap.set(project, group);
  }

  const projects: DailyProjectGroup[] = [];
  for (const [project, agents] of projectMap) {
    const branch = projectBranchMap.get(project) ?? agents.find((a) => a.branch)?.branch ?? null;
    projects.push({ project, branch, agents });
  }

  return {
    date: new Date(now),
    projects,
  };
}

export function formatDailyMarkdown(report: DailyReport): string {
  const date = report.date;
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = date.getFullYear();
  const lines: string[] = [`Resumo do dia ${dd}/${mm}/${yyyy}`];

  for (const group of report.projects) {
    lines.push("");
    const branchStr = group.branch ? ` (${group.branch})` : "";
    lines.push(`### ${group.project}${branchStr}`);

    const activeBullets: string[] = [];
    const inactiveAgents: string[] = [];

    for (const item of group.agents) {
      const isInactive =
        item.commitsCount === 0 &&
        item.uncommittedCount === 0 &&
        !item.runSummary &&
        item.state === "idle";

      const agentName = item.handle ?? item.agent;

      if (isInactive) {
        inactiveAgents.push(agentName);
        continue;
      }

      const parts: string[] = [];
      const modelStr = item.model ? ` ${item.model}` : "";
      parts.push(`${agentName}${modelStr}: ${item.state}`);

      if (item.commitsCount > 0) {
        const commitWord = item.commitsCount === 1 ? "commit" : "commits";
        const subjectsStr =
          item.commitSubjects.length > 0
            ? ` (${item.commitSubjects.join("; ")})`
            : "";
        parts.push(`${item.commitsCount} ${commitWord} hoje${subjectsStr}`);
      }

      if (item.uncommittedCount > 0) {
        const fileWord = item.uncommittedCount === 1 ? "arquivo não commitado" : "arquivos não commitados";
        parts.push(`${item.uncommittedCount} ${fileWord}`);
      }

      if (item.runSummary) {
        parts.push(`run: ${item.runSummary}`);
      }

      if (item.lastLine) {
        parts.push(`último: ${item.lastLine}`);
      }

      activeBullets.push(`- ${parts.join("; ")}`);
    }

    for (const bullet of activeBullets) {
      lines.push(bullet);
    }

    if (inactiveAgents.length > 0) {
      lines.push(`Sem atividade: ${inactiveAgents.join(", ")}`);
    }
  }

  return sanitizeText(lines.join("\n"));
}

export function formatDailyText(report: DailyReport): string {
  if (report.projects.length === 0) {
    return "No activity recorded.";
  }

  const lines: string[] = [];
  for (const group of report.projects) {
    if (lines.length > 0) lines.push("");
    const branchStr = group.branch ? ` (${group.branch})` : "";
    lines.push(`${group.project}${branchStr}`);
    lines.push("  AGENT        MODEL        STATE    COMMITS  CHANGES  RUN                 LAST");

    const inactiveAgents: string[] = [];
    for (const item of group.agents) {
      const isInactive =
        item.commitsCount === 0 &&
        item.uncommittedCount === 0 &&
        !item.runSummary &&
        item.state === "idle";

      const agentName = item.handle ?? item.agent;
      if (isInactive) {
        inactiveAgents.push(agentName);
        continue;
      }

      const agentCol = agentName.slice(0, 12).padEnd(12);
      const modelCol = (item.model ?? "-").slice(0, 12).padEnd(12);
      const stateCol = item.state.slice(0, 8).padEnd(8);
      const commitsCol = String(item.commitsCount).padEnd(8);
      const changesCol = String(item.uncommittedCount).padEnd(8);
      const runCol = (item.runSummary ?? "-").slice(0, 19).padEnd(19);
      const lastCol = item.lastLine ?? "";

      lines.push(`  ${agentCol} ${modelCol} ${stateCol} ${commitsCol} ${changesCol} ${runCol} ${lastCol}`.trimEnd());
    }

    if (inactiveAgents.length > 0) {
      lines.push(`  Sem atividade: ${inactiveAgents.join(", ")}`);
    }
  }

  return sanitizeText(lines.join("\n"));
}

export function writeDailyMarkdown(report: DailyReport, stateDir?: string): string {
  const dir = stateDir ?? process.env.HERDR_JEV_STATE_DIR ?? join(homedir(), ".local/state/herdr-jev");
  const dailyDir = join(dir, "daily");
  mkdirSync(dailyDir, { recursive: true, mode: 0o700 });
  const date = report.date;
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const filePath = join(dailyDir, `${yyyy}-${mm}-${dd}.md`);
  const markdown = formatDailyMarkdown(report);
  writeFileSync(filePath, markdown, { encoding: "utf8", mode: 0o600 });
  return filePath;
}
