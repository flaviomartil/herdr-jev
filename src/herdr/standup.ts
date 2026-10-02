import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readOverview } from "./overview.js";
import { converseWithPeer } from "./peer.js";
import { createHerdrClient, type HerdrClient } from "./client.js";
import { isTestGuardActive, resolveStateDir } from "./state-dir.js";
import { redactSecrets } from "./pane-text.js";

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

export interface StandupSkippedTarget {
  pane: string;
  reason: string;
}

export interface StandupEnvironment {
  configDir: string;
  defaultFile: string;
  stateDir: string;
  callerPaneId?: string;
}

export function resolveStandupEnvironment(env: NodeJS.ProcessEnv = process.env): StandupEnvironment {
  const isForeignPlugin = Boolean(env.HERDR_PLUGIN_ID && env.HERDR_PLUGIN_ID !== "herdr-jev");

  const defaultConfigDir = join(homedir(), ".config", "herdr", "plugins", "config", "herdr-jev");
  const defaultStateDir = join(homedir(), ".local", "state", "herdr-jev");

  const configDir = isForeignPlugin
    ? defaultConfigDir
    : (env.HERDR_PLUGIN_CONFIG_DIR || defaultConfigDir);

  const stateDir = resolveStateDir(env);

  const callerPaneId = env.HERDR_JEV_SOURCE_PANE_ID ||
    (!isForeignPlugin ? env.HERDR_PANE_ID : undefined);

  return {
    configDir,
    defaultFile: join(configDir, "standup.md"),
    stateDir,
    callerPaneId: callerPaneId || undefined,
  };
}

export interface StandupPlanDeps {
  env?: NodeJS.ProcessEnv;
  readOverview?: () => Promise<any[]>;
  overviewRows?: any[];
  callerPaneId?: string;
  now?: Date | number;
  panes?: string[];
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
  pane?: string | string[];
  panes?: string | string[];
}

export interface StandupCommandDeps extends StandupPlanDeps, StandupRunDeps {
  configDir?: string;
  stateDir?: string;
  fileExists?: (path: string) => boolean;
  readFile?: (path: string) => string;
  writeFile?: (path: string, content: string, options?: any) => void;
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
    .replace(/\{\{\s*date\s*\}\}/gi, () => dateStr)
    .replace(/\{\{\s*project\s*\}\}/gi, () => vars.project ?? "")
    .replace(/\{\{\s*branch\s*\}\}/gi, () => vars.branch ?? "")
    .replace(/\{\{\s*agent\s*\}\}/gi, () => vars.agent ?? "");
}

export function capMessageBytes(text: string, maxBytes = 8192): string {
  const buf = Buffer.from(text, "utf-8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xC0) === 0x80) {
    end--;
  }
  return buf.subarray(0, end).toString("utf-8");
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
  if (/^---[ \t]*(?:\n|$)/.test(trimmedStart)) {
    const match = trimmedStart.match(/^---[ \t]*\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n|$)([\s\S]*)$/);
    if (!match) throw new Error("Standup front matter is not closed with ---");
    const fm = match[1] ?? "";
    content = match[2];
    const lines = fm ? fm.split("\n") : [];
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
            max = Math.min(parsedMax, 100);
          }
        }
      }
    }
  }

  const lines = content.split("\n");
  let globalText = "";
  const sectionsData: Record<string, string> = Object.create(null);
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
    if (Object.prototype.hasOwnProperty.call(sections, candidate)) {
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
): Promise<StandupTarget[] & { skipped: StandupSkippedTarget[] }> {

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
    const standupEnv = resolveStandupEnvironment(deps.env);
    callerPaneId = standupEnv.callerPaneId;
  }

  const allowedStates = new Set(
    (parsed.options?.states ?? ["idle", "done"]).map((s) => s.trim().toLowerCase()),
  );
  const max = parsed.options?.max ?? 12;
  const PLUGIN_LABELS = new Set(["jev lantern", "jev office", "jev radar"]);
  const targets: StandupTarget[] = [];
  const skipped: StandupSkippedTarget[] = [];
  const seenPanes = new Set<string>();

  const rawPanes = deps.panes;
  const paneFilter = rawPanes && rawPanes.length > 0
    ? new Set(rawPanes.flatMap((p) => [String(p).trim(), String(p).trim().toLowerCase()]))
    : null;

  for (const row of rows) {
    const state = (row.state ?? "").trim().toLowerCase();
    if (!allowedStates.has(state)) continue;
    if (state === "working" || state === "blocked") continue;

    if (!row.pane || seenPanes.has(row.pane)) continue;
    seenPanes.add(row.pane);

    if (paneFilter && !paneFilter.has(row.pane) && !paneFilter.has(row.pane.toLowerCase())) {
      skipped.push({ pane: row.pane, reason: "filtered" });
      continue;
    }

    if (callerPaneId && row.pane === callerPaneId) {
      skipped.push({ pane: row.pane, reason: "caller" });
      continue;
    }

    if (!row.agent || typeof row.agent !== "string" || !row.agent.trim()) {
      skipped.push({ pane: row.pane, reason: "no_agent" });
      continue;
    }

    const isPlugin = [row.project, row.label, row.title, row.agent, row.handle].some(
      (val) => typeof val === "string" && PLUGIN_LABELS.has(val.trim().toLowerCase()),
    );
    if (isPlugin) {
      skipped.push({ pane: row.pane, reason: "plugin_pane" });
      continue;
    }

    const message = buildAgentMessage(parsed, row, deps.now);
    if (!message.trim()) {
      skipped.push({ pane: row.pane, reason: "no_text" });
      continue;
    }

    if (targets.length >= max) {
      skipped.push({ pane: row.pane, reason: "beyond_max" });
      continue;
    }

    targets.push({
      pane: row.pane,
      agent: row.agent,
      project: row.project ?? "",
      branch: row.branch ?? null,
      state: row.state,
      message: capMessageBytes(message, 8192),
    });
  }

  Object.assign(targets, { skipped });
  return targets as StandupTarget[] & { skipped: StandupSkippedTarget[] };
}

export async function runStandup(
  targets: StandupTarget[],
  deps: StandupRunDeps = {},
): Promise<StandupTargetResult[]> {
  if (isTestGuardActive() && !deps.sendPeer) throw new Error('standup_requires_injected_deps_in_tests');
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
      const sendTarget = target.pane;
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
      reason = redactSecrets(reason);
      if (reason.length > 100) {
        reason = reason.slice(0, 100);
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
  const standupEnv = resolveStandupEnvironment(deps.env);


  const fileExists = deps.fileExists ?? existsSync;
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf-8"));
  const writeFile =
    deps.writeFile ??
    ((p: string, c: string, opt?: any) =>
      writeFileSync(p, c, typeof opt === "string" ? { encoding: opt, mode: 0o600 } : { mode: 0o600, ...opt }));
  const mkdir = deps.mkdir ?? ((p: string, opt?: any) => mkdirSync(p, { recursive: true, mode: 0o700, ...opt }));
  const log = deps.log ?? console.log;

  const configDir = deps.configDir ?? standupEnv.configDir;
  const filePath = options.file ?? (deps.configDir ? join(deps.configDir, "standup.md") : standupEnv.defaultFile);

  const stateDir = deps.stateDir ?? standupEnv.stateDir;

  const now = deps.now ? (typeof deps.now === "number" ? new Date(deps.now) : deps.now) : new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const dateIso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const stateFilePath = join(stateDir, "standup", `${dateIso}${options.auto ? ".auto" : `.manual-${now.getTime()}`}.json`);

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
  const rawPanes = options.panes ?? options.pane;
  const panes = rawPanes
    ? (Array.isArray(rawPanes) ? rawPanes : [rawPanes]).map((p) => String(p).trim()).filter(Boolean)
    : undefined;
  const planDeps = {
    ...deps,
    panes: deps.panes ?? panes,
    callerPaneId: deps.callerPaneId ?? standupEnv.callerPaneId,
  };
  const targets = await planStandup(planDeps, parsed);
  const skipped = (targets as any).skipped ?? [];

  const isDryRun = Boolean(options.dryRun) || (!options.yes && !options.auto);

  if (isDryRun) {
    const planResult = {
      date: dateIso,
      file: filePath,
      dryRun: true,
      targets,
      skipped,
    };
    if (options.json) {
      log(JSON.stringify(planResult, null, 2));
    } else {
      if (targets.length === 0 && skipped.length === 0) log("no eligible targets");
      for (const t of targets) {
        log(`${t.pane} ${t.agent} (${t.project}): planned`);
      }
      for (const s of skipped) {
        log(`${s.pane}: skipped (${s.reason})`);
      }
    }
    return planResult;
  }

  if (options.auto) {
    if (targets.length === 0) {
      const resultObj = { date: dateIso, file: filePath, results: [], skipped };
      log(options.json ? JSON.stringify(resultObj, null, 2) : JSON.stringify(resultObj));
      return resultObj;
    }
    try {
      mkdir(join(stateDir, "standup"), { recursive: true, mode: 0o700 });
    } catch {}

    const claimPayload = JSON.stringify({ status: "running", date: dateIso }, null, 2);
    if (!options.force) {
      try {
        writeFile(stateFilePath, claimPayload, { flag: "wx", mode: 0o600 });
      } catch (err: any) {
        if (err?.code === "EEXIST" || fileExists(stateFilePath)) {
          const skipped = { skipped: "already_ran_today" };
          log(JSON.stringify(skipped));
          return skipped;
        }
        throw err;
      }
    } else {
      writeFile(stateFilePath, claimPayload, { encoding: "utf-8", mode: 0o600 });
    }
  }

  const results = await runStandup(targets, deps);

  try {
    mkdir(join(stateDir, "standup"), { recursive: true, mode: 0o700 });
    writeFile(stateFilePath, JSON.stringify(results, null, 2), { encoding: "utf-8", mode: 0o600 });
  } catch {}

  const resultObj = {
    date: dateIso,
    file: filePath,
    results,
    skipped,
  };

  if (options.json) {
    log(JSON.stringify(resultObj, null, 2));
  } else {
    if (results.length === 0 && skipped.length === 0) log("no eligible targets");
    for (const r of results) {
      if (r.sent) {
        log(`${r.pane} ${r.agent} (${r.project}): sent`);
      } else {
        log(`${r.pane} ${r.agent} (${r.project}): not sent (${r.reason})`);
      }
    }
    for (const s of skipped) {
      log(`${s.pane}: skipped (${s.reason})`);
    }
  }

  return resultObj;
}
