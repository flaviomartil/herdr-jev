import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProcessCommandAdapter, type RunCommand } from "./client.js";
import { classifyHerdrError } from "./errors.js";
import type { DelegationInput } from "../harness/bridge.js";
import { loadClientAliases } from "../config/aliases.js";

export interface CallerAncestryResult {
  verified: boolean;
  skipped?: boolean;
  shellPid?: number;
  reason?: string;
}

function readParentPid(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rparen = stat.lastIndexOf(")");
    if (rparen !== -1) {
      const fields = stat.slice(rparen + 2).trim().split(/\s+/);
      const ppid = Number.parseInt(fields[1] ?? "", 10);
      if (Number.isInteger(ppid) && ppid > 0) return ppid;
    }
  } catch {}
  try {
    const res = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 64 * 1024,
    });
    if (res.status === 0) {
      const ppid = Number.parseInt(res.stdout.trim(), 10);
      if (Number.isInteger(ppid) && ppid > 0) return ppid;
    }
  } catch {}
  return null;
}

function collectAncestorPids(
  startPid: number,
  getParentPid: (pid: number) => number | null = readParentPid,
): number[] {
  const ancestors: number[] = [];
  const seen = new Set<number>();
  let current: number | null = startPid;
  for (let depth = 0; depth < 64 && current && current > 1 && !seen.has(current); depth++) {
    seen.add(current);
    ancestors.push(current);
    current = getParentPid(current);
  }
  return ancestors;
}

/**
 * Verify that the caller process descends from the pane's shell_pid reported by
 * `herdr pane process-info`, skipping gracefully when the command is unavailable.
 */
export async function verifyCallerPaneAncestry(
  paneId: string,
  runCommand: RunCommand,
  deps?: {
    ancestorPids?: readonly number[];
    pid?: number;
    getParentPid?: (pid: number) => number | null;
    herdrBin?: string;
  },
): Promise<CallerAncestryResult> {
  const herdrBin = deps?.herdrBin || process.env.HERDR_BIN_PATH || "herdr";
  const res = await runCommand([herdrBin, "pane", "process-info", "--pane", paneId]);
  if (!res.ok) {
    const classified = classifyHerdrError(res);
    if (classified.code === "unknown_command" || classified.code === "unsupported") {
      return { verified: true, skipped: true, reason: classified.code };
    }
    return { verified: false, skipped: false, reason: classified.code ?? "process_info_failed" };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return { verified: false, skipped: false, reason: "invalid_process_info" };
  }
  const shellPid = parsed?.result?.process_info?.shell_pid ?? parsed?.process_info?.shell_pid;
  if (shellPid === undefined || shellPid === null) {
    return { verified: true, skipped: true, reason: "missing_shell_pid" };
  }
  if (typeof shellPid !== "number" || !Number.isInteger(shellPid) || shellPid <= 0) {
    return { verified: false, skipped: false, reason: "invalid_shell_pid" };
  }
  const ancestors = deps?.ancestorPids
    ? [...deps.ancestorPids]
    : collectAncestorPids(deps?.pid ?? process.pid, deps?.getParentPid);
  if (ancestors.includes(shellPid)) {
    return { verified: true, skipped: false, shellPid };
  }
  return { verified: false, skipped: false, shellPid, reason: "ancestry_mismatch" };
}

export async function resolveHerdrContext(input: {
  client?: string; model?: string; availableModels?: string[]; sourcePaneId?: string;
}, options: { env?: NodeJS.ProcessEnv; runCommand?: RunCommand; now?: number } = {}) {
  const env = options.env ?? process.env;
  let pluginContext: any;
  try { pluginContext = JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON ?? "{}"); } catch {}
  const configuredPaneId = input.sourcePaneId || env.HERDR_JEV_SOURCE_PANE_ID;
  let sourcePaneId = configuredPaneId || pluginContext?.focused_pane_id || env.HERDR_PANE_ID;
  if (env.HERDR_ENV === "1" && !sourcePaneId) throw new Error("Caller pane unavailable; pass --source-pane or sourcePaneId explicitly");
  const runCommand = options.runCommand ?? createProcessCommandAdapter();
  let agent: any;
  if (env.HERDR_ENV === "1") {
    const triedIds: string[] = [];
    const tryPane = async (id: string | undefined): Promise<any | undefined> => {
      if (!id || triedIds.includes(id)) return undefined;
      triedIds.push(id);
      const res = await runCommand([env.HERDR_BIN_PATH || "herdr", "agent", "get", id]);
      if (res.ok) {
        try {
          const parsed = JSON.parse(res.stdout);
          const a = parsed.result?.agent ?? parsed.agent;
          if (a && (!a.pane_id || a.pane_id === id)) return a;
        } catch {}
      }
      return undefined;
    };
    if (configuredPaneId) {
      agent = await tryPane(configuredPaneId);
      if (agent) sourcePaneId = configuredPaneId;
    }
    if (!agent && pluginContext?.focused_pane_id) {
      agent = await tryPane(pluginContext.focused_pane_id);
      if (agent) sourcePaneId = pluginContext.focused_pane_id;
    }
    if (!agent) {
      const currentRes = await runCommand([env.HERDR_BIN_PATH || "herdr", "pane", "current"]);
      let currentId: string | undefined;
      if (currentRes.ok) {
        try {
          const parsed = JSON.parse(currentRes.stdout);
          currentId = parsed.result?.pane?.pane_id ?? parsed.result?.pane_id ?? parsed.pane?.pane_id ?? parsed.pane_id ?? parsed.result?.agent?.pane_id ?? parsed.agent?.pane_id ?? parsed.result?.id ?? parsed.id;
        } catch {}
        if (!currentId) {
          const trimmed = currentRes.stdout.trim();
          if (/^[a-zA-Z0-9:_-]+$/.test(trimmed)) currentId = trimmed;
        }
      }
      if (!currentId && env.HERDR_PANE_ID) {
        const ancestry = await verifyCallerPaneAncestry(env.HERDR_PANE_ID, runCommand, {
          herdrBin: env.HERDR_BIN_PATH,
        });
        if (ancestry.verified) {
          currentId = env.HERDR_PANE_ID;
        } else if (!triedIds.includes(env.HERDR_PANE_ID)) {
          triedIds.push(env.HERDR_PANE_ID);
        }
      }
      if (currentId) {
        agent = await tryPane(currentId);
        if (agent) sourcePaneId = currentId;
      }
    }
    if (!agent) {
      let listRes = await runCommand([env.HERDR_BIN_PATH || "herdr", "agent", "list"]);
      if (!listRes.ok) listRes = await runCommand([env.HERDR_BIN_PATH || "herdr", "api", "snapshot"]);
      if (listRes.ok) {
        let agents: any[] = [];
        try {
          const parsed = JSON.parse(listRes.stdout);
          agents = parsed.result?.agents ?? parsed.result?.snapshot?.agents ?? parsed.snapshot?.agents ?? parsed.agents ?? [];
        } catch {}
        if (Array.isArray(agents)) {
          const targetCwd = pluginContext?.focused_pane_cwd ?? process.cwd();
          const targetClient = (input.client === "agy" ? "antigravity" : input.client) ?? "claude";
          const aliases = loadClientAliases();
          const normalizedTargetCwd = targetCwd ? targetCwd.replace(/\/+$/, "") || "/" : "";
          const matches = agents.filter((a: any) => {
            const aCwd = a.foreground_cwd || a.cwd;
            const aClient = a.agent === "agy" ? "antigravity" : a.agent;
            const normalizedACwd = aCwd ? aCwd.replace(/\/+$/, "") || "/" : "";
            const cwdMatches = Boolean(normalizedACwd && normalizedTargetCwd && normalizedACwd === normalizedTargetCwd);
            const clientMatches = aClient === targetClient || aliases[targetClient] === aClient || a.agent === targetClient;
            return Boolean(a.pane_id && cwdMatches && clientMatches);
          });
          if (matches.length > 1) {
            throw new Error(
              `Ambiguous source pane for ${targetClient} in ${targetCwd}; candidates: ${matches.map((m: any) => m.pane_id).join(", ")}. Pass --source-pane or set HERDR_JEV_SOURCE_PANE_ID`,
            );
          }
          const match = matches[0];
          if (match?.pane_id) {
            agent = await tryPane(match.pane_id);
            if (agent) sourcePaneId = match.pane_id;
          }
        }
      }
    }
    if (!agent) {
      throw new Error(`Cannot resolve source pane (tried ${triedIds.join(", ")}); select the actual caller pane`);
    }
  }
  const observedClient = agent?.agent === "agy" ? "antigravity" : agent?.agent;
  const requestedClient = input.client === "agy" ? "antigravity" : input.client;
  if (env.HERDR_ENV === "1") {
    if (!observedClient) throw new Error("Caller harness unavailable in the source pane");
    if (requestedClient && requestedClient !== observedClient && loadClientAliases()[requestedClient] !== observedClient) {
      throw new Error(`Requested source client ${requestedClient} conflicts with observed ${observedClient}`);
    }
  }
  const client = observedClient ?? requestedClient ?? "claude";
  const delegation: DelegationInput = { model: input.model, availableModels: input.availableModels };
  const observedModel = typeof agent?.tokens?.quota_model === "string" ? agent.tokens.quota_model.replace(/\p{Cf}/gu, "").trim() : undefined;
  if (!delegation.model && client === "codex" && agent?.agent === client && /^gpt-[a-z0-9.-]+$/.test(observedModel ?? "")) delegation.model = observedModel;
  if (client === "codex" && (!delegation.model || !delegation.availableModels)) {
    try {
      const cache = JSON.parse(readFileSync(join(env.CODEX_HOME || homedir() + "/.codex", "models_cache.json"), "utf8"));
      const age = (options.now ?? Date.now()) - Date.parse(cache.fetched_at);
      if (age >= 0 && age < 86_400_000 && Array.isArray(cache.models)) {
        const models = cache.models.filter((m: any) => m.visibility === "list" && typeof m.slug === "string").map((m: any) => m.slug);
        delegation.availableModels ??= models;
      }
    } catch {}
  }
  return { client, delegation, sourcePaneId, workspaceId: agent?.workspace_id ?? env.HERDR_WORKSPACE_ID,
    sourceAgentName: typeof agent?.name === "string" ? agent.name : undefined,
    cwd: agent?.foreground_cwd ?? agent?.cwd ?? pluginContext?.focused_pane_cwd ?? process.cwd() };
}
