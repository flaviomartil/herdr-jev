import type { BaseClientKind, ClientKind } from "../types/index.js";

export const BASE_CLIENTS: BaseClientKind[] = [
  "claude",
  "codex",
  "antigravity",
  "cursor",
  "opencode",
  "kimi",
];

const DEFAULT_BINARIES: Record<BaseClientKind, string> = {
  claude: "claude",
  codex: "codex",
  antigravity: "agy",
  cursor: "agent",
  opencode: "opencode",
  kimi: "kimi",
};

/**
 * Checks whether custom client aliases are enabled via environment variable.
 * Default is false (standard base clients only).
 * Activate with HERDR_JEV_ALLOW_ALIASES=1 or HERDR_JEV_ENABLE_ALIASES=1.
 */
export function areAliasesEnabled(): boolean {
  const env = (process.env.HERDR_JEV_ALLOW_ALIASES ?? process.env.HERDR_JEV_ENABLE_ALIASES ?? "").trim().toLowerCase();
  return env === "1" || env === "true" || env === "yes" || env === "on";
}

/**
 * Loads explicit user alias mappings from environment variables.
 * Supported when HERDR_JEV_ALLOW_ALIASES=1:
 * 1. HERDR_JEV_ALIASES='{"claude-px":"claude","fcc-claude":"claude"}'
 * 2. HERDR_JEV_ALIAS_<NAME>=<BASE_CLIENT> (e.g. HERDR_JEV_ALIAS_CLAUDE_PX=claude)
 */
export function loadClientAliases(): Record<string, BaseClientKind> {
  if (!areAliasesEnabled()) {
    return {};
  }

  const aliases: Record<string, BaseClientKind> = {};

  // 1. Check HERDR_JEV_ALIASES JSON
  const jsonEnv = process.env.HERDR_JEV_ALIASES;
  if (jsonEnv && jsonEnv.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(jsonEnv.trim()) as Record<string, string>;
      for (const [k, v] of Object.entries(parsed)) {
        const base = v.trim().toLowerCase() as BaseClientKind;
        if (BASE_CLIENTS.includes(base)) {
          aliases[k.trim().toLowerCase()] = base;
        }
      }
    } catch {
      // ignore parse errors
    }
  }

  // 2. Check HERDR_JEV_ALIAS_<NAME> environment variables
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("HERDR_JEV_ALIAS_") && v) {
      const aliasName = k.replace(/^HERDR_JEV_ALIAS_/, "").toLowerCase().replace(/_/g, "-");
      const base = v.trim().toLowerCase() as BaseClientKind;
      if (BASE_CLIENTS.includes(base)) {
        aliases[aliasName] = base;
      }
    }
  }

  return aliases;
}

/**
 * Resolves any client name or alias (e.g. "claude-px", "fcc-claude", "my-codex")
 * to its underlying BaseClientKind ("claude", "codex", "antigravity", "cursor", "opencode").
 */
export function resolveBaseClientKind(client: ClientKind | string): BaseClientKind {
  const lower = (client ?? "").trim().toLowerCase();

  // Exact base client match
  if (BASE_CLIENTS.includes(lower as BaseClientKind)) {
    return lower as BaseClientKind;
  }

  // Explicit user-configured alias map
  const aliases = loadClientAliases();
  if (aliases[lower]) {
    return aliases[lower];
  }

  // Heuristic pattern matching
  if (lower.includes("claude")) return "claude";
  if (lower.includes("codex")) return "codex";
  if (lower.includes("antigravity") || lower.includes("agy") || lower.includes("gemini")) return "antigravity";
  if (lower.includes("cursor")) return "cursor";
  if (lower.includes("opencode")) return "opencode";
  if (lower.includes("kimi")) return "kimi";

  return "claude";
}

/**
 * Resolves the executable binary name to invoke for a client or alias.
 * Precedence:
 * 1. HERDR_JEV_BIN_<CLIENT> or HERDR_JEV_<CLIENT>_BIN
 * 2. For custom aliases (e.g. "claude-px", "fcc-claude"): the alias name itself
 * 3. Default binary for base client kind
 */
export function resolveClientExecutable(client: ClientKind | string): string {
  const normalized = (client ?? "").trim().toLowerCase();
  const base = resolveBaseClientKind(client);

  // If custom aliases are NOT enabled via env, always return standard base binary
  if (!areAliasesEnabled()) {
    return DEFAULT_BINARIES[base];
  }

  const envKeyName = normalized.toUpperCase().replace(/[^A-Z0-9]/g, "_");

  // Check specific binary override env vars
  const binEnv1 = process.env[`HERDR_JEV_BIN_${envKeyName}`];
  if (binEnv1 && binEnv1.trim()) return binEnv1.trim();

  const binEnv2 = process.env[`HERDR_JEV_${envKeyName}_BIN`];
  if (binEnv2 && binEnv2.trim()) return binEnv2.trim();

  const baseKeyName = base.toUpperCase();

  const baseBinEnv1 = process.env[`HERDR_JEV_BIN_${baseKeyName}`];
  if (baseBinEnv1 && baseBinEnv1.trim()) return baseBinEnv1.trim();

  const baseBinEnv2 = process.env[`HERDR_JEV_${baseKeyName}_BIN`];
  if (baseBinEnv2 && baseBinEnv2.trim()) return baseBinEnv2.trim();

  // If custom alias, use the alias string itself as the binary command
  if (!BASE_CLIENTS.includes(normalized as BaseClientKind)) {
    return normalized;
  }

  return DEFAULT_BINARIES[base];
}
