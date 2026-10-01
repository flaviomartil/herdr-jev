import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readOverview } from "./overview.js";
import { converseWithPeer } from "./peer.js";
import { createHerdrClient, type HerdrClient } from "./client.js";

export interface StandupOptions {
  states: string[];
  max: number;
}

export interface ParsedStandup {
  global: string;
  sections: Record<string, string>;
  options: StandupOptions;
}

export interface StandupTarget {
  pane: string;
  agent: string;
  project: string;
  branch?: string | null;
  state: string;
  message: string;
}

export interface StandupTargetResult {
  pane: string;
  agent: string;
  project: string;
  sent: boolean;
  reason?: string;
}

export interface StandupPlanDeps {
  readOverview?: () => Promise<any[]>;
  overviewRows?: any[];
  callerPaneId?: string;
  now?: Date | number;
}

export interface StandupRunDeps {
  herdr?: HerdrClient;
  sendPeer?: (input: { target: string; text: string; wait?: boolean }, herdr?: HerdrClient) => Promise<any>;
}

export interface StandupCommandOptions {
  file?: string;
  auto?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  force?: boolean;
  json?: boolean;
}

export interface StandupCommandDeps extends StandupPlanDeps, StandupRunDeps {
  configDir?: string;
  stateDir?: string;
  fileExists?: (path: string) => boolean;
  readFile?: (path: string) => string;
  writeFile?: (path: string, content: string) => void;
  mkdir?: (path: string) => void;
  log?: (msg: string) => void;
}

export function formatStandupDate(date: Date | number = new Date()): string {
  const d = typeof date === "number" ? new Date(date) : date;
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = pad(d.getDate());
  const month = pad(d.getMonth() + 1);
  const year = String(d.getFullYear());
  return `${day}/${month}/${year}`;
}

export function substituteVariables(
  text: string,
  vars: { date?: string; project?: string | null; branch?: string | null; agent?: string | null },
): string {
  const dateStr = vars.date ?? formatStandupDate();
  return text
    .replace(/\{\{\s*date\s*\}\}/gi, dateStr)
    .replace(/\{\{\s*project\s*\}\}/gi, vars.project ?? "")
    .replace(/\{\{\s*branch\s*\}\}/gi, vars.branch ?? "")
    .replace(/\{\{\s*agent\s*\}\}/gi, vars.agent ?? "");
}

export function capMessageBytes(text: string, maxBytes = 8192): string {
  const buf = Buffer.from(text, "utf-8");
  if (buf.length <= maxBytes) return text;
  return buf.subarray(0, maxBytes).toString("utf-8");
}

export function parseStandupFile(
  text: string,
  vars?: { date?: string; project?: string | null; branch?: string | null; agent?: string | null },
): ParsedStandup {
  const normalized = text.replace(/\r\n/g, "\n");
  let content = normalized;
  let states = ["idle", "done"];
  let max = 12;

  const trimmedStart = normalized.trimStart();
  if (trimmedStart.startsWith("---")) {
    const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (match) {
      const fm = match[1];
      content = match[2];
      const lines = fm.split("\n");
      for (const line of lines) {
        const colonIdx = line.indexOf(":");
        if (colonIdx > 0) {
          const key = line.slice(0, colonIdx).trim().toLowerCase();
          const val = line.slice(colonIdx + 1).trim();
          if (key === "states") {
            const parsedStates = val
              .split(",")
              .map((s) => s.trim().toLowerCase())
              .filter(Boolean);
            if (parsedStates.length > 0) {
              states = parsedStates;
            }
          } else if (key === "max") {
            const parsedMax = Number.parseInt(val, 10);
            if (!Number.isNaN(parsedMax) && parsedMax > 0) {
              max = parsedMax;
            }
          }
        }
      }
    }
  }

  const lines = content.split("\n");
  let globalText = "";
  const sectionsData: Record<string, string> = {};
  let currentSectionKey: string | null = null;
  let currentRawSection: string | null = null;
  const sectionLines: string[] = [];
  const globalLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (currentSectionKey === null) {
        globalText = globalLines.join("\n").trim();
      } else {
        const existing = sectionsData[currentSectionKey] ? sectionsData[currentSectionKey] + "\n\n" : "";
        const combined = (existing + sectionLines.join("\n")).trim();
        sectionsData[currentSectionKey] = combined;
        if (currentRawSection && currentRawSection !== currentSectionKey) {
          sectionsData[currentRawSection] = combined;
        }
        sectionLines.length = 0;
      }
      currentRawSection = line.slice(3).trim();
      currentSectionKey = currentRawSection.toLowerCase();
    } else if (currentSectionKey === null) {
      globalLines.push(line);
    } else {
      sectionLines.push(line);
    }
  }

  if (currentSectionKey === null) {
    globalText = globalLines.join("\n").trim();
  } else {
    const existing = sectionsData[currentSectionKey] ? sectionsData[currentSectionKey] + "\n\n" : "";
    const combined = (existing + sectionLines.join("\n")).trim();
    sectionsData[currentSectionKey] = combined;
    if (currentRawSection && currentRawSection !== currentSectionKey) {
      sectionsData[currentRawSection] = combined;
    }
  }

  if (vars) {
    globalText = substituteVariables(globalText, vars);
    for (const k of Object.keys(sectionsData)) {
      sectionsData[k] = substituteVariables(sectionsData[k], vars);
    }
  }

  const sections = new Proxy(sectionsData, {
    get(target, prop: string | symbol) {
      if (typeof prop === "string") {
        return target[prop] ?? target[prop.toLowerCase()];
      }
      return (target as any)[prop];
    },
    has(target, prop: string | symbol) {
      if (typeof prop === "string") {
        return prop in target || prop.toLowerCase() in target;
      }
      return prop in target;
    },
  });

  return {
    global: globalText,
    sections,
    options: {
      states,
      max,
    },
  };
}

export function findMatchingSection(
  sections: Record<string, string>,
  target: { project?: string | null; workspaceLabel?: string | null; label?: string | null },
): string {
  const candidates = [target.project, target.workspaceLabel, target.label]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim().toLowerCase());

  for (const candidate of candidates) {
    if (sections[candidate]) {
      return sections[candidate];
    }
  }
  return "";
}

export function buildAgentMessage(
  parsed: ParsedStandup,
  target: { project?: string | null; workspaceLabel?: string | null; label?: string | null; branch?: string | null; agent?: string | null },
  now?: Date | number,
): string {
  const globalText = (parsed.global || "").trim();
  const sectionText = findMatchingSection(parsed.sections, target).trim();

  const parts: string[] = [];
  if (globalText) parts.push(globalText);
  if (sectionText) parts.push(sectionText);

  if (parts.length === 0) return "";

  const rawMessage = parts.join("\n\n");
  const dateStr = formatStandupDate(now);

  return substituteVariables(rawMessage, {
    date: dateStr,
    project: target.project ?? target.workspaceLabel ?? target.label ?? "",
    branch: target.branch ?? "",
    agent: target.agent ?? "",
  });
}

export async function planStandup(
  deps: StandupPlanDeps,
  parsed: ParsedStandup,
): Promise<StandupTarget[]> {
  let rows: any[];
  if (deps.overviewRows) {
    rows = deps.overviewRows;
  } else if (deps.readOverview) {
    rows = await deps.readOverview();
  } else {
    rows = await readOverview();
  }

  let callerPaneId = deps.callerPaneId;
  if (!callerPaneId) {
    callerPaneId = process.env.HERDR_PANE_ID || process.env.HERDR_JEV_SOURCE_PANE_ID;
  }

  const allowedStates = new Set(
    (parsed.options?.states ?? ["idle", "done"]).map((s) => s.trim().toLowerCase()),
  );
  const max = parsed.options?.max ?? 12;
  const PLUGIN_LABELS = new Set(["jev lantern", "jev office", "jev radar"]);
  const targets: StandupTarget[] = [];
  const seenPanes = new Set<string>();
  const seenAgents = new Set<string>();

  for (const row of rows) {
    const state = (row.state ?? "").trim().toLowerCase();
    if (!allowedStates.has(state)) continue;
    if (state === "working" || state === "blocked") continue;

    if (callerPaneId && row.pane === callerPaneId) continue;
    if (!row.agent || typeof row.agent !== "string" || !row.agent.trim()) continue;

    const isPlugin = [row.project, row.label, row.title, row.agent, row.handle].some(
      (val) => typeof val === "string" && PLUGIN_LABELS.has(val.trim().toLowerCase()),
    );
    if (isPlugin) continue;

    if (seenPanes.has(row.pane)) continue;
    const agentKey = row.agent.trim().toLowerCase();
    if (seenAgents.has(agentKey)) continue;

    const message = buildAgentMessage(parsed, row, deps.now);
    if (!message.trim()) continue;

    seenPanes.add(row.pane);
    seenAgents.add(agentKey);

    targets.push({
      pane: row.pane,
      agent: row.agent,
      project: row.project ?? "",
      branch: row.branch ?? null,
      state: row.state,
      message: capMessageBytes(message, 8192),
    });

    if (targets.length >= max) break;
  }

  return targets;
}

export async function runStandup(
  targets: StandupTarget[],
  deps: StandupRunDeps = {},
): Promise<StandupTargetResult[]> {
  const results: StandupTargetResult[] = [];
  const herdr = deps.herdr ?? createHerdrClient();

  for (const target of targets) {
    if (target.state === "working" || target.state === "blocked") {
      results.push({
        pane: target.pane,
        agent: target.agent,
        project: target.project,
        sent: false,
        reason: target.state,
      });
      continue;
    }

    const text = capMessageBytes(target.message || "", 8192).trim();
    if (!text) {
      results.push({
        pane: target.pane,
        agent: target.agent,
        project: target.project,
        sent: false,
        reason: "no_text",
      });
      continue;
    }

    try {
      const sendTarget = target.agent || target.pane;
      if (deps.sendPeer) {
        await deps.sendPeer({ target: sendTarget, text, wait: false }, herdr);
      } else {
        await converseWithPeer({ target: sendTarget, text, wait: false }, herdr);
      }
      results.push({
        pane: target.pane,
        agent: target.agent,
        project: target.project,
        sent: true,
      });
    } catch (err: any) {
      const msg = err?.message || String(err);
      let reason = msg;
      const match = msg.match(/Peer (?:is|response is) ([a-zA-Z0-9_-]+)/);
      if (match) {
        reason = match[1];
      }
      results.push({
        pane: target.pane,
        agent: target.agent,
        project: target.project,
        sent: false,
        reason,
      });
    }
  }

  return results;
}

export async function executeStandupCommand(
  options: StandupCommandOptions,
  deps: StandupCommandDeps = {},
): Promise<any> {
  const fileExists = deps.fileExists ?? existsSync;
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf-8"));
  const writeFile = deps.writeFile ?? ((p: string, c: string) => writeFileSync(p, c, "utf-8"));
  const mkdir = deps.mkdir ?? ((p: string) => mkdirSync(p, { recursive: true }));
  const log = deps.log ?? console.log;

  const configDir =
    deps.configDir ??
    process.env.HERDR_PLUGIN_CONFIG_DIR ??
    join(homedir(), ".config", "herdr", "plugins", "config", "herdr-jev");
  const filePath = options.file ?? join(configDir, "standup.md");

  const stateDir =
    deps.stateDir ??
    process.env.HERDR_JEV_STATE_DIR ??
    join(homedir(), ".local", "state", "herdr-jev");

  const now = deps.now ? (typeof deps.now === "number" ? new Date(deps.now) : deps.now) : new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const dateIso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const stateFilePath = join(stateDir, "standup", `${dateIso}.json`);

  if (options.auto) {
    const exists = fileExists(filePath);
    let rawText = "";
    if (exists) {
      try {
        rawText = readFile(filePath);
      } catch {
        rawText = "";
      }
    }
    if (!exists || !rawText.trim()) {
      const skipped = { skipped: "no_file" };
      log(JSON.stringify(skipped));
      return skipped;
    }

    if (!options.force && fileExists(stateFilePath)) {
      const skipped = { skipped: "already_ran_today" };
      log(JSON.stringify(skipped));
      return skipped;
    }
  }

  if (!fileExists(filePath)) {
    throw new Error(`Standup file not found: ${filePath}`);
  }

  const rawText = readFile(filePath);
  const parsed = parseStandupFile(rawText);
  const targets = await planStandup(deps, parsed);

  const isDryRun = Boolean(options.dryRun) || (!options.yes && !options.auto);

  if (isDryRun) {
    const planResult = {
      date: dateIso,
      file: filePath,
      dryRun: true,
      targets,
    };
    if (options.json) {
      log(JSON.stringify(planResult, null, 2));
    } else {
      for (const t of targets) {
        log(`${t.pane} ${t.agent} (${t.project}): planned`);
      }
    }
    return planResult;
  }

  const results = await runStandup(targets, deps);

  try {
    mkdir(join(stateDir, "standup"));
    writeFile(stateFilePath, JSON.stringify(results, null, 2));
  } catch {}

  const resultObj = {
    date: dateIso,
    file: filePath,
    results,
  };

  if (options.json) {
    log(JSON.stringify(resultObj, null, 2));
  } else {
    for (const r of results) {
      if (r.sent) {
        log(`${r.pane} ${r.agent} (${r.project}): sent`);
      } else {
        log(`${r.pane} ${r.agent} (${r.project}): not sent (${r.reason})`);
      }
    }
  }

  return resultObj;
}
