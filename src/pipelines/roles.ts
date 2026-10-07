import { resolveActiveModel } from "../config/catalog.js";
import { resolveBaseClientKind } from "../config/aliases.js";
import { harnessModelResolve, type HarnessRole } from "../harness/bridge.js";
import { ROLE_KINDS, type ClientKind, type ReasoningEffort, type RoleKind } from "../types/index.js";

export interface RoleMatrixEntry {
  model: string;
  cliModel: string | null;
  effort: ReasoningEffort;
  readonly: boolean;
  fallbackActive: boolean;
  error?: string;
}

export interface RoleMatrix {
  client: ClientKind;
  roles: Record<RoleKind, RoleMatrixEntry>;
}

const READONLY_ROLES: ReadonlySet<RoleKind> = new Set(["reviewer", "researcher", "reader"]);

function entryFor(client: ClientKind, role: RoleKind): RoleMatrixEntry {
  const active = resolveActiveModel(client, role);
  const effort = active.entry.defaultEffort;
  const base: RoleMatrixEntry = { model: active.model, cliModel: null, effort, readonly: READONLY_ROLES.has(role), fallbackActive: active.usedFallback };
  try {
    const harnessRole: HarnessRole = role === "reader" ? "researcher" : role;
    const resolution = harnessModelResolve({ client: resolveBaseClientKind(client), model: active.model, effort, role: harnessRole });
    if (!resolution) return { ...base, error: "harness model-resolve unavailable" };
    if (!resolution.known) return { ...base, error: "harness does not know this model" };
    return { ...base, cliModel: resolution.cliModel };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message.slice(0, 120) : "model-resolve failed" };
  }
}

export async function resolveRoleMatrix(client: ClientKind): Promise<RoleMatrix> {
  const roles = {} as Record<RoleKind, RoleMatrixEntry>;
  for (const role of ROLE_KINDS) roles[role] = entryFor(client, role);
  return { client, roles };
}
