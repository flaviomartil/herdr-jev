import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProcessCommandAdapter, type RunCommand } from "./client.js";
import type { DelegationInput } from "../harness/bridge.js";
import { loadClientAliases } from "../config/aliases.js";

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
      if (!currentId && env.HERDR_PANE_ID) currentId = env.HERDR_PANE_ID;
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
          const match = agents.find((a: any) => {
            const aCwd = a.foreground_cwd || a.cwd;
            const aClient = a.agent === "agy" ? "antigravity" : a.agent;
            const cwdMatches = Boolean(aCwd && targetCwd && aCwd.replace(/\/+$/, "") === targetCwd.replace(/\/+$/, ""));
            const clientMatches = aClient === targetClient || aliases[targetClient] === aClient || a.agent === targetClient;
            return Boolean(a.pane_id && cwdMatches && clientMatches);
          });
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
    cwd: agent?.foreground_cwd ?? agent?.cwd ?? pluginContext?.focused_pane_cwd ?? process.cwd() };
}
