import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { cleanModel, matchRunForPane, readOverview } from "./overview.js";
import { listRunHistory, runStateSummary, type RunHistoryEntry } from "../orchestration/run-history.js";
import { lastMeaningfulLine, redactSecrets } from "./pane-text.js";
import { defaultGitRunner, type GitRunner } from "./agents.js";
import { createProcessCommandAdapter, type HerdrClient, type RunCommand } from "./client.js";
import { resolveStateDir } from "./state-dir.js";

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
  tarefa?: string | null;
  workspaceProject?: string;
}

export interface DailyProjectGroup {
  project: string;
  branch: string | null;
  commitsCount?: number;
  commitSubjects?: string[];
  uncommittedCount?: number;
  sharedCheckoutCount?: number;
  agents: DailyAgentItem[];
}

export interface DailyReport {
  date: Date;
  projects: DailyProjectGroup[];
}

export interface DailyReportOptions {
  since?: string | Date;
  now?: number;
  projects?: string[];
  project?: string[];
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
  paneList?: readonly any[];
  listPanes?: () => Promise<any[] | { ok: boolean; stdout: string }>;
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

function cleanGitLine(stdout: string): string {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("AI Harness active"));
  return lines[0] ?? "";
}

function cleanGitLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("AI Harness active"));
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

function parsePaneList(stdout: string): any[] {
  try {
    const start = stdout.indexOf("{");
    const end = stdout.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      const parsed = JSON.parse(stdout.slice(start, end + 1));
      if (Array.isArray(parsed?.panes)) return parsed.panes;
      if (Array.isArray(parsed?.result?.panes)) return parsed.result.panes;
    }
  } catch {}
  return [];
}

function truncateCell(value: string, width: number): string {
  if (value.length <= width) {
    return value.padEnd(width);
  }
  if (width <= 3) {
    return value.slice(0, width);
  }
  return (value.slice(0, width - 3) + "...").padEnd(width);
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

  const paneInfoMap = new Map<string, { terminal_title_stripped?: string; label?: string }>();
  try {
    let rawPanes: any[] = [];
    if (deps?.paneList) {
      rawPanes = [...deps.paneList];
    } else if (deps?.listPanes) {
      const res = await deps.listPanes();
      if (Array.isArray(res)) {
        rawPanes = res;
      } else if (res && typeof res === "object" && "stdout" in res) {
        rawPanes = parsePaneList(res.stdout);
      }
    } else if (deps?.herdrClient?.listPanes) {
      const res = await deps.herdrClient.listPanes();
      if (res && res.stdout) {
        rawPanes = parsePaneList(res.stdout);
      }
    } else {
      const runCmd = deps?.runCommand ?? createProcessCommandAdapter();
      const res = await runCmd([process.env.HERDR_BIN_PATH || "herdr", "pane", "list"]);
      if (res && res.stdout) {
        rawPanes = parsePaneList(res.stdout);
      }
    }

    for (const p of rawPanes) {
      const pId = p.pane_id ?? p.paneId ?? p.id ?? "";
      if (pId) {
        paneInfoMap.set(pId, {
          terminal_title_stripped: p.terminal_title_stripped ?? p.terminalTitleStripped ?? p.terminal_title ?? p.terminalTitle,
          label: p.label,
        });
      }
    }
  } catch {}

  const cwdCache = new Map<
    string,
    Promise<{
      repoName: string;
      branch: string | null;
      commitsCount: number;
      commitSubjects: string[];
      uncommittedCount: number;
    }>
  >();

  const getCwdInfo = (cwd: string | null, fallbackProject: string) => {
    if (!cwd) {
      return Promise.resolve({
        repoName: fallbackProject,
        branch: null,
        commitsCount: 0,
        commitSubjects: [],
        uncommittedCount: 0,
      });
    }
    if (!cwdCache.has(cwd)) {
      cwdCache.set(
        cwd,
        (async () => {
          let repoName = fallbackProject;
          const commonDirRes = await execGit(
            git,
            ["rev-parse", "--path-format=absolute", "--git-common-dir"],
            cwd,
          );
          if (commonDirRes.ok) {
            const commonDir = cleanGitLine(commonDirRes.stdout);
            if (commonDir && (commonDir.endsWith(".git") || commonDir.endsWith(".git/"))) {
              const absCommonDir = isAbsolute(commonDir) ? commonDir : resolve(cwd, commonDir);
              const parent = dirname(absCommonDir.replace(/\/+$/, ""));
              const resolvedName =
                basename(absCommonDir).endsWith(".git") && basename(absCommonDir) !== ".git"
                  ? basename(absCommonDir).replace(/\.git$/, "")
                  : basename(parent);
              if (resolvedName) {
                repoName = resolvedName;
              }
            }
          }

          const branchRes = await execGit(git, ["rev-parse", "--abbrev-ref", "HEAD"], cwd);
          const branch = branchRes.ok ? cleanGitLine(branchRes.stdout) || null : null;

          let defaultBranch = "main";
          const symRefRes = await execGit(
            git,
            ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
            cwd,
          );
          if (symRefRes.ok) {
            const ref = cleanGitLine(symRefRes.stdout).replace(/^origin\//, "");
            if (ref) defaultBranch = ref;
          } else {
            const checkMain = await execGit(git, ["rev-parse", "--verify", "main"], cwd);
            if (checkMain.ok) {
              defaultBranch = "main";
            } else {
              const checkMaster = await execGit(git, ["rev-parse", "--verify", "master"], cwd);
              if (checkMaster.ok) {
                defaultBranch = "master";
              }
            }
          }

          let logRes: { ok: boolean; stdout: string; stderr: string };
          if (branch && branch !== defaultBranch) {
            logRes = await execGit(git, ["log", `${defaultBranch}..HEAD`, gitSinceArg, "--pretty=%s"], cwd);
            if (!logRes.ok) {
              logRes = await execGit(git, ["log", gitSinceArg, "--pretty=%s"], cwd);
            }
          } else {
            logRes = await execGit(git, ["log", gitSinceArg, "--pretty=%s"], cwd);
          }

          const statusRes = await execGit(git, ["status", "--porcelain"], cwd);

          const commits = logRes.ok ? cleanGitLines(logRes.stdout) : [];
          const uncommittedCount = statusRes.ok ? cleanGitLines(statusRes.stdout).length : 0;

          return {
            repoName,
            branch,
            commitsCount: commits.length,
            commitSubjects: commits.slice(0, 3).map((s) => sanitizeText(redactSecrets(s))),
            uncommittedCount,
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

  const groupsMap = new Map<string, DailyProjectGroup>();

  for (const row of overviewRows) {
    const rawProject = row.project || "unknown";
    const paneId = row.pane ?? "";
    const cwd = row.cwd ?? null;
    const cwdInfo = await getCwdInfo(cwd, rawProject);

    const handle = row.handle ?? null;
    const agent = row.agent || "agent";
    const model = cleanModel(row.model);
    const state = row.state ?? "unknown";
    const branch = cwdInfo.branch ?? row.branch ?? null;

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

    const paneInfo = paneId ? paneInfoMap.get(paneId) : undefined;
    let tarefa: string | null = null;
    const rawTarefa = paneInfo?.terminal_title_stripped || paneInfo?.label || "";
    if (rawTarefa) {
      const stripped = rawTarefa.replace(/[\x00-\x1F\x7F]/g, "");
      const redacted = redactSecrets(stripped);
      const sanitized = sanitizeText(redacted).trim();
      const agentName = handle ?? agent;
      const isLaunchCommand = /^(?:agy|codex|claude|node)(?:\s+|$)/i.test(sanitized);
      if (
        sanitized.length > 0 &&
        !isLaunchCommand &&
        sanitized.toLowerCase() !== agentName.toLowerCase() &&
        sanitized.toLowerCase() !== agent.toLowerCase()
      ) {
        tarefa = sanitized.length > 60 ? sanitized.slice(0, 60).trim() : sanitized;
      }
    }

    const agentItem: DailyAgentItem = {
      project: cwdInfo.repoName,
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
      tarefa,
      workspaceProject: rawProject,
    };

    const groupKey = `${cwdInfo.repoName}:::${branch ?? ""}`;
    let group = groupsMap.get(groupKey);
    if (!group) {
      group = {
        project: cwdInfo.repoName,
        branch,
        commitsCount: cwdInfo.commitsCount,
        commitSubjects: cwdInfo.commitSubjects,
        uncommittedCount: cwdInfo.uncommittedCount,
        agents: [],
      };
      groupsMap.set(groupKey, group);
    } else {
      group.commitsCount = Math.max(group.commitsCount ?? 0, cwdInfo.commitsCount);
      if ((group.commitSubjects?.length ?? 0) === 0 && cwdInfo.commitSubjects.length > 0) {
        group.commitSubjects = cwdInfo.commitSubjects;
      }
      group.uncommittedCount = Math.max(group.uncommittedCount ?? 0, cwdInfo.uncommittedCount);
    }
    group.agents.push(agentItem);
  }

  for (const group of groupsMap.values()) {
    const cwdCounts = new Map<string, number>();
    for (const agent of group.agents) {
      if (agent.cwd) {
        cwdCounts.set(agent.cwd, (cwdCounts.get(agent.cwd) ?? 0) + 1);
      }
    }
    const sharedCounts = Array.from(cwdCounts.values()).filter((c) => c >= 2);
    if (sharedCounts.length > 0) {
      group.sharedCheckoutCount = sharedCounts.reduce((a, b) => a + b, 0);
    }
  }

  const rawFilter = options?.projects ?? options?.project;
  const projectFilters = (Array.isArray(rawFilter) ? rawFilter : rawFilter ? [rawFilter] : [])
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);

  let finalGroups = Array.from(groupsMap.values());
  if (projectFilters.length > 0) {
    finalGroups = finalGroups.filter((g) => {
      const matchRepo = projectFilters.includes(g.project.toLowerCase());
      const matchWorkspace = g.agents.some(
        (a) => a.workspaceProject && projectFilters.includes(a.workspaceProject.toLowerCase()),
      );
      return matchRepo || matchWorkspace;
    });
  }

  return {
    date: new Date(now),
    projects: finalGroups,
  };
}

export function formatDailyMarkdown(
  report: DailyReport,
  options?: boolean | { plain?: boolean },
): string {
  const isPlain = typeof options === "boolean" ? options : Boolean(options?.plain);
  const date = report.date;
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = date.getFullYear();
  const lines: string[] = [];
  if (!isPlain) {
    lines.push(`Resumo do dia ${dd}/${mm}/${yyyy}`);
  }

  for (const group of report.projects) {
    if (lines.length > 0) {
      lines.push("");
    }
    const branchStr = group.branch ? ` (${group.branch})` : "";
    lines.push(`### ${group.project}${branchStr}`);

    const commitsCount = group.commitsCount ?? Math.max(0, ...group.agents.map((a) => a.commitsCount));
    const commitSubjects = group.commitSubjects ?? group.agents.find((a) => a.commitSubjects.length > 0)?.commitSubjects ?? [];
    const uncommittedCount = group.uncommittedCount ?? Math.max(0, ...group.agents.map((a) => a.uncommittedCount));

    const repoFactsParts: string[] = [];
    if (commitsCount > 0) {
      const commitWord = commitsCount === 1 ? "commit" : "commits";
      const subjectsStr =
        commitSubjects.length > 0
          ? ` (${commitSubjects.join("; ")})`
          : "";
      repoFactsParts.push(`${commitsCount} ${commitWord} hoje${subjectsStr}`);
    }

    if (uncommittedCount > 0) {
      const fileWord = uncommittedCount === 1 ? "arquivo não commitado" : "arquivos não commitados";
      repoFactsParts.push(`${uncommittedCount} ${fileWord}`);
    }

    const cwdCounts = new Map<string, number>();
    for (const agent of group.agents) {
      if (agent.cwd) {
        cwdCounts.set(agent.cwd, (cwdCounts.get(agent.cwd) ?? 0) + 1);
      }
    }
    const sharedCounts = Array.from(cwdCounts.values()).filter((c) => c >= 2);
    const sharedCount = group.sharedCheckoutCount ?? (sharedCounts.length > 0 ? sharedCounts.reduce((a, b) => a + b, 0) : 0);
    if (sharedCount >= 2) {
      repoFactsParts.push(`${sharedCount} agentes no mesmo checkout`);
    }

    if (repoFactsParts.length > 0) {
      lines.push(repoFactsParts.join("; "));
    }

    const activeBullets: string[] = [];
    const inactiveAgents: string[] = [];

    for (const item of group.agents) {
      const isInactive =
        (item.state === "idle" || item.state === "done") &&
        !item.runSummary &&
        commitsCount === 0;

      const agentName = item.handle ?? item.agent;

      if (isInactive) {
        inactiveAgents.push(agentName);
        continue;
      }

      const parts: string[] = [];
      const tarefaStr = item.tarefa ? ` [${item.tarefa}]` : "";
      const modelStr = item.model ? ` ${item.model}` : "";
      parts.push(`${agentName}${tarefaStr}${modelStr}: ${item.state}`);

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

    const commitsCount = group.commitsCount ?? Math.max(0, ...group.agents.map((a) => a.commitsCount));
    const commitSubjects = group.commitSubjects ?? group.agents.find((a) => a.commitSubjects.length > 0)?.commitSubjects ?? [];
    const uncommittedCount = group.uncommittedCount ?? Math.max(0, ...group.agents.map((a) => a.uncommittedCount));

    const repoFactsParts: string[] = [];
    if (commitsCount > 0) {
      const commitWord = commitsCount === 1 ? "commit" : "commits";
      const subjectsStr =
        commitSubjects.length > 0
          ? ` (${commitSubjects.join("; ")})`
          : "";
      repoFactsParts.push(`${commitsCount} ${commitWord} hoje${subjectsStr}`);
    }

    if (uncommittedCount > 0) {
      const fileWord = uncommittedCount === 1 ? "arquivo não commitado" : "arquivos não commitados";
      repoFactsParts.push(`${uncommittedCount} ${fileWord}`);
    }

    const cwdCounts = new Map<string, number>();
    for (const agent of group.agents) {
      if (agent.cwd) {
        cwdCounts.set(agent.cwd, (cwdCounts.get(agent.cwd) ?? 0) + 1);
      }
    }
    const sharedCounts = Array.from(cwdCounts.values()).filter((c) => c >= 2);
    const sharedCount = group.sharedCheckoutCount ?? (sharedCounts.length > 0 ? sharedCounts.reduce((a, b) => a + b, 0) : 0);
    if (sharedCount >= 2) {
      repoFactsParts.push(`${sharedCount} agentes no mesmo checkout`);
    }

    if (repoFactsParts.length > 0) {
      lines.push(`  ${repoFactsParts.join("; ")}`);
    }

    lines.push("  AGENT        TASK                               MODEL        STATE    RUN                 LAST");

    const inactiveAgents: string[] = [];

    for (const item of group.agents) {
      const isInactive =
        (item.state === "idle" || item.state === "done") &&
        !item.runSummary &&
        commitsCount === 0;

      const agentName = item.handle ?? item.agent;
      if (isInactive) {
        inactiveAgents.push(agentName);
        continue;
      }

      const agentCol = truncateCell(agentName, 12);
      const taskCol = truncateCell(item.tarefa ?? "-", 34);
      const modelCol = truncateCell(item.model ?? "-", 12);
      const stateCol = truncateCell(item.state, 8);
      const runCol = truncateCell(item.runSummary ?? "-", 19);
      const lastCol = item.lastLine ?? "";

      lines.push(`  ${agentCol} ${taskCol} ${modelCol} ${stateCol} ${runCol} ${lastCol}`.trimEnd());
    }

    if (inactiveAgents.length > 0) {
      lines.push(`  Sem atividade: ${inactiveAgents.join(", ")}`);
    }
  }

  return sanitizeText(lines.join("\n"));
}

export function writeDailyMarkdown(
  report: DailyReport,
  stateDir?: string,
  options?: boolean | { plain?: boolean },
): string {
  const dir = stateDir ?? resolveStateDir();
  const dailyDir = join(dir, "daily");
  mkdirSync(dailyDir, { recursive: true, mode: 0o700 });
  const date = report.date;
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const filePath = join(dailyDir, `${yyyy}-${mm}-${dd}.md`);
  const markdown = formatDailyMarkdown(report, options);
  writeFileSync(filePath, markdown, { encoding: "utf8", mode: 0o600 });
  return filePath;
}
