import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ClientKind, RoleKind, ReasoningEffort } from "../types/index.js";

export interface ModelCatalogEntry {
  model: string;
  fallbackChain: string[];
  defaultEffort: ReasoningEffort;
  extraFlags: string[];
  description: string;
}

export type CatalogSchema = {
  updatedAt: string;
  clients: Record<ClientKind, Record<RoleKind, ModelCatalogEntry>>;
};

export interface QuotaEntry {
  client: string;
  model: string;
  exhaustedAt: string;
  expiresAt: string;
}

const DEFAULT_CONFIG_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../config/models.json",
);

function userConfigDir(): string {
  return join(homedir(), ".config", "herdr");
}

function userConfigFile(): string {
  return join(userConfigDir(), "herdr-jev-models.json");
}

function userQuotasFile(): string {
  return join(userConfigDir(), "herdr-jev-quotas.json");
}

export function loadBaseCatalog(): CatalogSchema {
  if (existsSync(DEFAULT_CONFIG_PATH)) {
    const raw = readFileSync(DEFAULT_CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as CatalogSchema;
  }
  throw new Error(`Base models configuration not found at ${DEFAULT_CONFIG_PATH}`);
}

export function loadUserOverrides(): Record<string, string> {
  const file = userConfigFile();
  if (existsSync(file)) {
    try {
      return JSON.parse(readFileSync(file, "utf-8"));
    } catch {
      return {};
    }
  }
  return {};
}

export function saveUserOverride(clientRoleKey: string, newModel: string): void {
  const dir = userConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const current = loadUserOverrides();
  current[clientRoleKey] = newModel;
  writeFileSync(userConfigFile(), JSON.stringify(current, null, 2), "utf-8");
}

export function loadQuotaRecords(): QuotaEntry[] {
  const file = userQuotasFile();
  if (existsSync(file)) {
    try {
      const records = JSON.parse(readFileSync(file, "utf-8")) as QuotaEntry[];
      const now = Date.now();
      // Filter out already expired entries
      return records.filter((r) => new Date(r.expiresAt).getTime() > now);
    } catch {
      return [];
    }
  }
  return [];
}

export function isModelExhausted(client: string, model: string): boolean {
  const activeQuotas = loadQuotaRecords();
  return activeQuotas.some(
    (q) =>
      q.client.toLowerCase() === client.toLowerCase() &&
      (q.model === "*" || q.model.toLowerCase() === model.toLowerCase()),
  );
}

export function markModelExhausted(client: string, model: string, durationMinutes = 120): void {
  const dir = userConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const now = new Date();
  const expires = new Date(now.getTime() + durationMinutes * 60 * 1000);
  const current = loadQuotaRecords().filter(
    (q) => !(q.client.toLowerCase() === client.toLowerCase() && (q.model === "*" || q.model.toLowerCase() === model.toLowerCase())),
  );
  current.push({
    client,
    model,
    exhaustedAt: now.toISOString(),
    expiresAt: expires.toISOString(),
  });
  writeFileSync(userQuotasFile(), JSON.stringify(current, null, 2), "utf-8");
}

export function resetQuotas(filterClient?: string, filterModel?: string): void {
  if (!filterClient && !filterModel) {
    writeFileSync(userQuotasFile(), JSON.stringify([], null, 2), "utf-8");
    return;
  }
  const current = loadQuotaRecords();
  const filtered = current.filter((q) => {
    if (filterClient && q.client.toLowerCase() !== filterClient.toLowerCase()) return true;
    if (filterModel && q.model.toLowerCase() !== filterModel.toLowerCase()) return true;
    return false;
  });
  writeFileSync(userQuotasFile(), JSON.stringify(filtered, null, 2), "utf-8");
}

import { resolveBaseClientKind } from "./aliases.js";

export interface ActiveModelResolution {
  model: string;
  entry: ModelCatalogEntry;
  usedFallback: boolean;
  originalRequested?: string;
  allExhausted: boolean;
}

export function resolveActiveModel(
  client: ClientKind,
  role: RoleKind,
): ActiveModelResolution {
  const base = resolveBaseClientKind(client);
  const catalog = loadBaseCatalog();
  const entry =
    (catalog.clients as Record<string, Record<RoleKind, ModelCatalogEntry>>)[client]?.[role] ??
    catalog.clients[base]?.[role] ??
    catalog.clients.claude[role];

  // 1. Check environment variable override: HERDR_JEV_<CLIENT>_<ROLE>, then HERDR_JEV_<BASE>_<ROLE>
  const clientKey = client.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const baseKey = base.toUpperCase();
  const envVar = process.env[`HERDR_JEV_${clientKey}_${role.toUpperCase()}`]
    ? `HERDR_JEV_${clientKey}_${role.toUpperCase()}`
    : `HERDR_JEV_${baseKey}_${role.toUpperCase()}`;

  // 2. Check user config overrides (~/.config/herdr/herdr-jev-models.json)
  const userOverrides = loadUserOverrides();
  const overrideKey = userOverrides[`${client}.${role}`]
    ? `${client}.${role}`
    : `${base}.${role}`;
  let primaryModel = (process.env[envVar] && process.env[envVar]!.trim().length > 0)
    ? process.env[envVar]!.trim()
    : (userOverrides[overrideKey] ?? entry.model);

  // Build candidate chain: primary model first, then fallbackChain
  const candidateChain = Array.from(new Set([primaryModel, ...(entry.fallbackChain ?? [primaryModel])]));

  // 3. Find first candidate in chain that has active quota
  for (const candidate of candidateChain) {
    if (!isModelExhausted(client, candidate) && !isModelExhausted(base, candidate)) {
      const isFallback = candidate !== primaryModel;
      return {
        model: candidate,
        entry: { ...entry, model: candidate },
        usedFallback: isFallback,
        originalRequested: isFallback ? primaryModel : undefined,
        allExhausted: false,
      };
    }
  }

  // If all are exhausted, use the last in chain with fallback indicator and allExhausted = true
  const lastResort = candidateChain[candidateChain.length - 1];
  return {
    model: lastResort,
    entry: { ...entry, model: lastResort },
    usedFallback: true,
    originalRequested: primaryModel,
    allExhausted: true,
  };
}

export function isClientExhausted(client: ClientKind, role: RoleKind): boolean {
  return resolveActiveModel(client, role).allExhausted;
}

export function integrateDiscoveredModel(input: {
  client: ClientKind;
  modelName: string;
  role: RoleKind;
  effort: ReasoningEffort;
  replacePrimary: boolean;
  description?: string;
}): { updated: boolean; role: RoleKind; isPrimary: boolean; chain: string[] } {
  const dir = userConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const base = resolveBaseClientKind(input.client);
  const catalog = loadBaseCatalog();
  const currentEntry =
    (catalog.clients as Record<string, Record<RoleKind, ModelCatalogEntry>>)[input.client]?.[input.role] ??
    catalog.clients[base]?.[input.role] ??
    catalog.clients.claude[input.role];
  const userOverrides = loadUserOverrides();
  const overrideKey = `${input.client}.${input.role}`;

  let currentPrimary = userOverrides[overrideKey] ?? currentEntry.model;
  let chain = currentEntry.fallbackChain ? [...currentEntry.fallbackChain] : [currentPrimary];

  if (!chain.includes(currentPrimary)) {
    chain.unshift(currentPrimary);
  }

  // If already in chain and already primary
  if (input.replacePrimary) {
    // New model becomes primary, previous primary becomes 2nd in fallback chain
    chain = [input.modelName, ...chain.filter((m) => m !== input.modelName)];
    saveUserOverride(overrideKey, input.modelName);
  } else {
    // New model appended to fallback chain
    if (!chain.includes(input.modelName)) {
      chain.push(input.modelName);
    }
  }

  return {
    updated: true,
    role: input.role,
    isPrimary: input.replacePrimary,
    chain,
  };
}

