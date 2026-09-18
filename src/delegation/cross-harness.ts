import type { BaseClientKind, ClientKind, RoleKind, TriageDecision } from "../types/index.js";
import { isClientExhausted } from "../config/catalog.js";
import { BASE_CLIENTS, resolveBaseClientKind, areAliasesEnabled } from "../config/aliases.js";

export type CrossHarnessMode = "disabled" | "auto" | "mapped";

export interface CrossHarnessConfig {
  mode: CrossHarnessMode;
  allowedPeers: Record<string, ClientKind[]>;
  rawEnv?: string;
}

const ALL_CLIENTS: ClientKind[] = [...BASE_CLIENTS];

/**
 * Creates a default peer dictionary with self-only delegation.
 */
function createSelfOnlyPeers(extraClients: string[] = []): Record<string, ClientKind[]> {
  const map: Record<string, ClientKind[]> = {};
  for (const c of BASE_CLIENTS) {
    map[c] = [c];
  }
  for (const c of extraClients) {
    map[c] = [c];
  }
  return map;
}

/**
 * Creates an all-inclusive peer dictionary where any client can delegate to any client.
 */
function createAllInclusivePeers(extraClients: string[] = []): Record<string, ClientKind[]> {
  const all: ClientKind[] = Array.from(new Set([...BASE_CLIENTS, ...extraClients]));
  const map: Record<string, ClientKind[]> = {};
  for (const c of all) {
    map[c] = [...all];
  }
  return map;
}

/**
 * Parses HERDR_JEV_CROSS_HARNESS env var or explicit CLI option.
 * Supported modes:
 * (1) Disabled: "0", "false", "off", "none", "disabled" (strict self-delegation)
 * (2) Auto / Jev decides: "1", "true", "on", "auto", "" (when active without explicit map)
 * (3) Mapped pairs: "claude:codex,antigravity;codex:claude"
 * (4) Mapped JSON map: '{"claude":["codex","antigravity"]}'
 * (5) Mapped JSON array: '["codex","antigravity"]'
 * (6) Allowed array / list: "codex,antigravity"
 */
export function parseCrossHarnessConfig(envValue?: string): CrossHarnessConfig {
  const val = (envValue ?? process.env.HERDR_JEV_CROSS_HARNESS ?? "").trim();

  // If unset, default is disabled (self-delegation only)
  if (val === "") {
    return {
      mode: "disabled",
      allowedPeers: createSelfOnlyPeers(),
    };
  }

  const lower = val.toLowerCase();
  if (["0", "false", "off", "none", "disabled"].includes(lower)) {
    return {
      mode: "disabled",
      allowedPeers: createSelfOnlyPeers(),
      rawEnv: val,
    };
  }

  if (["1", "true", "on", "auto"].includes(lower)) {
    return {
      mode: "auto",
      allowedPeers: createAllInclusivePeers(),
      rawEnv: val,
    };
  }

  const sanitizeClient = (c: string): ClientKind | undefined => {
    const norm = c.trim().toLowerCase();
    if (!norm) return undefined;
    if (areAliasesEnabled()) return norm as ClientKind;
    return BASE_CLIENTS.includes(norm as BaseClientKind) ? (norm as ClientKind) : undefined;
  };

  // Try JSON map parsing: '{"claude":["codex","antigravity"]}'
  if (val.startsWith("{")) {
    try {
      const parsed = JSON.parse(val) as Record<string, string[]>;
      const keys = Object.keys(parsed).map(sanitizeClient).filter(Boolean) as ClientKind[];
      const allTargets = Object.values(parsed).flat().map((v) => sanitizeClient(String(v))).filter(Boolean) as ClientKind[];
      const extra = Array.from(new Set([...keys, ...allTargets]));
      const allowedPeers = createSelfOnlyPeers(extra);
      for (const [k, v] of Object.entries(parsed)) {
        const clientKey = sanitizeClient(k);
        if (clientKey && Array.isArray(v)) {
          const targets = v.map((item) => sanitizeClient(String(item))).filter(Boolean) as ClientKind[];
          allowedPeers[clientKey] = Array.from(new Set([clientKey, ...targets]));
        }
      }
      return { mode: "mapped", allowedPeers, rawEnv: val };
    } catch {
      // fallback to pair parser
    }
  }

  // Try JSON array parsing: '["codex","antigravity"]'
  if (val.startsWith("[")) {
    try {
      const parsed = JSON.parse(val) as string[];
      if (Array.isArray(parsed)) {
        const peers = parsed.map(sanitizeClient).filter(Boolean) as ClientKind[];
        const allowedPeers = createSelfOnlyPeers(peers);
        const all = Array.from(new Set([...BASE_CLIENTS, ...peers]));
        for (const c of all) {
          allowedPeers[c] = Array.from(new Set([c, ...peers]));
        }
        return { mode: "mapped", allowedPeers, rawEnv: val };
      }
    } catch {
      // fallback to pair parser
    }
  }

  // Comma/semicolon pair parsing: "claude:codex,antigravity;codex:claude"
  if (val.includes(":")) {
    const segments = val.split(";");
    const mentioned: ClientKind[] = [];
    for (const seg of segments) {
      const parts = seg.split(":");
      if (parts.length === 2) {
        const s = sanitizeClient(parts[0]);
        if (s) mentioned.push(s);
        const tgts = parts[1].split(",").map(sanitizeClient).filter(Boolean) as ClientKind[];
        mentioned.push(...tgts);
      }
    }
    const allowedPeers = createSelfOnlyPeers(mentioned);
    for (const seg of segments) {
      const parts = seg.split(":");
      if (parts.length === 2) {
        const src = sanitizeClient(parts[0]);
        if (src) {
          const targets = parts[1].split(",").map(sanitizeClient).filter(Boolean) as ClientKind[];
          allowedPeers[src] = Array.from(new Set([src, ...targets]));
        }
      }
    }
    return { mode: "mapped", allowedPeers, rawEnv: val };
  }

  // Simple comma list of peers: "codex,antigravity" or "claude,codex,antigravity"
  if (val.includes(",")) {
    const peers = val.split(",").map(sanitizeClient).filter(Boolean) as ClientKind[];

    const allowedPeers = createSelfOnlyPeers(peers);
    const all = Array.from(new Set([...BASE_CLIENTS, ...peers]));
    for (const c of all) {
      allowedPeers[c] = Array.from(new Set([c, ...peers]));
    }
    return { mode: "mapped", allowedPeers, rawEnv: val };
  }

  // Single valid client name: enables delegation to that client
  const singleClient = sanitizeClient(val);
  if (singleClient) {
    const allowedPeers = createSelfOnlyPeers([singleClient]);
    const all = Array.from(new Set([...BASE_CLIENTS, singleClient]));
    for (const c of all) {
      allowedPeers[c] = Array.from(new Set([c, singleClient]));
    }
    return { mode: "mapped", allowedPeers, rawEnv: val };
  }

  // Fallback to auto
  return {
    mode: "auto",
    allowedPeers: createAllInclusivePeers(),
    rawEnv: val,
  };
}

/**
 * Jev System One recommendation for the best client/harness for a given role.
 */
export function getJevRecommendedClientForRole(role: RoleKind, triage?: TriageDecision): ClientKind {
  const envKey = `HERDR_JEV_RECOMMENDED_${role.toUpperCase()}`;
  if (process.env[envKey] && process.env[envKey]!.trim()) {
    return process.env[envKey]!.trim();
  }

  if (triage?.effort === "xhigh") {
    if (role === "implementer" || role === "reviewer") return "codex";
  }

  switch (role) {
    case "advisor":
      return "claude";
    case "implementer":
      return "codex";
    case "reviewer":
      return "antigravity";
    case "researcher":
      return "antigravity";
  }
}

/**
 * Resolves the target client/harness for a delegation step according to policy and quota health.
 * If a target peer's quota is exhausted, cascades to the next allowed peer in the array,
 * or safely falls back to the source harness.
 */
export function resolveDelegatedClient(
  sourceClient: ClientKind,
  targetRole: RoleKind,
  options?: {
    explicitTarget?: ClientKind;
    config?: CrossHarnessConfig;
    triage?: TriageDecision;
  },
): { client: ClientKind; delegated: boolean; reason: string } {
  const config = options?.config ?? parseCrossHarnessConfig();

  // Mode 1: Disabled (strictly self-delegation)
  if (config.mode === "disabled") {
    return {
      client: sourceClient,
      delegated: false,
      reason: `Cross-harness disabled: self-delegating within ${sourceClient}`,
    };
  }

  // If an explicit target is requested
  if (options?.explicitTarget) {
    const target = options.explicitTarget;
    if (target === sourceClient) {
      return {
        client: sourceClient,
        delegated: false,
        reason: `Explicit self-target: ${sourceClient}`,
      };
    }
    const allowed = config.allowedPeers[sourceClient] ?? [sourceClient];
    if (config.mode !== "auto" && !allowed.includes(target)) {
      return {
        client: sourceClient,
        delegated: false,
        reason: `Cross-harness restricted: ${target} is not in allowed peers for ${sourceClient} (falling back to ${sourceClient})`,
      };
    }

    // Check if target peer has active quota
    if (!isClientExhausted(target, targetRole)) {
      return {
        client: target,
        delegated: true,
        reason: `Cross-harness allowed: ${sourceClient} -> ${target}`,
      };
    }

    // Explicit target is quota exhausted: cascade to next available peer
    const candidatePeers = (config.mode === "auto" ? ALL_CLIENTS : allowed)
      .filter((p) => p !== target && p !== sourceClient);

    for (const peer of candidatePeers) {
      if (!isClientExhausted(peer, targetRole)) {
        return {
          client: peer,
          delegated: true,
          reason: `Explicit target ${target} quota exhausted: cascading to peer ${peer}`,
        };
      }
    }

    // All alternative peers exhausted: fallback to source harness
    return {
      client: sourceClient,
      delegated: false,
      reason: `Explicit target ${target} quota exhausted and no alternative peer available: falling back to source harness ${sourceClient}`,
    };
  }

  // Mode 2: Auto (Jev decides)
  if (config.mode === "auto") {
    const recommended = getJevRecommendedClientForRole(targetRole, options?.triage);

    if (!isClientExhausted(recommended, targetRole)) {
      return {
        client: recommended,
        delegated: recommended !== sourceClient,
        reason: `Jev dynamic cross-harness decision: optimal client for ${targetRole} is ${recommended}`,
      };
    }

    // Recommended client is exhausted: cascade to other clients
    const alternativeClients = ALL_CLIENTS.filter((c) => c !== recommended && c !== sourceClient);
    for (const candidate of alternativeClients) {
      if (!isClientExhausted(candidate, targetRole)) {
        return {
          client: candidate,
          delegated: true,
          reason: `Jev recommended ${recommended} quota exhausted: cascading to healthy peer ${candidate}`,
        };
      }
    }

    return {
      client: sourceClient,
      delegated: false,
      reason: `All cross-harness peers quota exhausted: falling back to source harness ${sourceClient}`,
    };
  }

  // Mode 3: Mapped
  const baseSource = resolveBaseClientKind(sourceClient);
  const allowed = config.allowedPeers[sourceClient] ?? config.allowedPeers[baseSource] ?? [sourceClient];
  const externalPeers = allowed.filter((p) => p !== sourceClient && p !== baseSource);

  if (externalPeers.length === 0) {
    return {
      client: sourceClient,
      delegated: false,
      reason: `Cross-harness self-fallback: no external peers mapped for ${sourceClient}`,
    };
  }

  const recommended = getJevRecommendedClientForRole(targetRole, options?.triage);

  // If Jev recommends sourceClient itself and sourceClient has quota
  if ((recommended === sourceClient || recommended === baseSource) && !isClientExhausted(sourceClient, targetRole)) {
    return {
      client: sourceClient,
      delegated: false,
      reason: `Source harness ${sourceClient} selected for ${targetRole}`,
    };
  }

  // Priority order: candidate peers in configured order
  const candidatePeers = [...externalPeers];

  for (const peer of candidatePeers) {
    if (!isClientExhausted(peer, targetRole)) {
      const isCascade = isClientExhausted(recommended, targetRole);
      return {
        client: peer,
        delegated: true,
        reason: peer === recommended
          ? `Cross-harness mapped peer chosen for ${targetRole}: ${peer}`
          : isCascade
            ? `Peer ${recommended} quota exhausted: cascading to next healthy peer ${peer} in mapped array`
            : `Cross-harness mapped peer chosen for ${targetRole}: ${peer}`,
      };
    }
  }

  // All mapped external peers exhausted: safely return to source harness
  return {
    client: sourceClient,
    delegated: false,
    reason: `All mapped peers (${externalPeers.join(", ")}) quota exhausted: falling back to source harness ${sourceClient}`,
  };
}
