import type { ClientKind, RoleKind, StageSpec, ReasoningEffort } from "../types/index.js";
import { resolveActiveModel, loadBaseCatalog, type ModelCatalogEntry } from "../config/catalog.js";

export function resolveStageSpec(
  client: ClientKind,
  role: RoleKind,
  overrideEffort?: ReasoningEffort,
): StageSpec {
  const resolved = resolveActiveModel(client, role);
  const description = resolved.usedFallback
    ? `${resolved.entry.description} (FALLBACK from ${resolved.originalRequested} due to quota exhaustion)`
    : resolved.entry.description;

  return {
    role,
    model: resolved.model,
    effort: overrideEffort ?? resolved.entry.defaultEffort,
    extraFlags: [...resolved.entry.extraFlags],
    description,
  };
}

export function getClientModelMatrix(): Record<ClientKind, Record<RoleKind, ModelCatalogEntry>> {
  const catalog = loadBaseCatalog();
  return catalog.clients;
}

export const CLIENT_MODEL_MATRIX = getClientModelMatrix();
