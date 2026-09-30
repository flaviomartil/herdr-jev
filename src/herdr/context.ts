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
  const sourcePaneId = input.sourcePaneId ?? env.HERDR_JEV_SOURCE_PANE_ID ?? pluginContext?.focused_pane_id ?? env.HERDR_PANE_ID;
  if (env.HERDR_ENV === "1" && !sourcePaneId) throw new Error("Caller pane unavailable; pass --source-pane or sourcePaneId explicitly");
  const runCommand = options.runCommand ?? createProcessCommandAdapter();
  let agent: any;
  if (env.HERDR_ENV === "1" && sourcePaneId) {
    const result = await runCommand([env.HERDR_BIN_PATH || "herdr", "agent", "get", sourcePaneId]);
    if (result.ok) {
      try { agent = JSON.parse(result.stdout).result?.agent; } catch {}
    }
    if (!agent || (agent.pane_id && agent.pane_id !== sourcePaneId)) throw new Error(`Cannot resolve source pane ${sourcePaneId}; select the actual caller pane`);
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
