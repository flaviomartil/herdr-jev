import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BaseClientKind } from "../types/index.js";
import { BASE_CLIENTS, resolveClientExecutable } from "../config/aliases.js";
import { loadBaseCatalog, loadQuotaRecords } from "../config/catalog.js";

export interface DetectedHarness {
  client: BaseClientKind;
  binary: string;
  binaryPath: string | null;
  installed: boolean;
  version?: string;
  quotaStatus: "healthy" | "degraded" | "exhausted" | "unconfigured";
  healthy: boolean;
  availableModels: string[];
  exhaustedModels: string[];
}

export interface AutoConfigRecommendation {
  crossHarness: string;
  splitSubagents: string;
  splitDirection: string;
  allowAliases: string;
  summary: string;
  healthyClients: BaseClientKind[];
}

const CLIENT_BINARY_CANDIDATES: Record<BaseClientKind, string[]> = {
  claude: ["claude"],
  codex: ["codex"],
  antigravity: ["agy", "antigravity"],
  cursor: ["agent", "cursor"],
  opencode: ["opencode"],
  kimi: ["kimi", "kimi-cli"],
};

/**
 * Probes the version of a detected binary safely with timeout.
 */
async function probeBinaryVersion(binPath: string): Promise<string | undefined> {
  try {
    const proc = Bun.spawn([binPath, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeout = new Promise<undefined>((resolvePromise) => {
      setTimeout(() => resolvePromise(undefined), 1200);
    });

    const readVersion = async () => {
      const exitCode = await proc.exited;
      if (exitCode === 0) {
        const text = await new Response(proc.stdout).text();
        return text.trim().split("\n")[0]?.slice(0, 40);
      }
      return undefined;
    };

    return await Promise.race([readVersion(), timeout]);
  } catch {
    return undefined;
  }
}

/**
 * Detects installed agent harnesses in PATH and probes quota availability.
 */
export async function detectInstalledHarnesses(): Promise<DetectedHarness[]> {
  const catalog = loadBaseCatalog();
  const quotas = loadQuotaRecords();
  const results: DetectedHarness[] = [];

  for (const client of BASE_CLIENTS) {
    const preferredBin = resolveClientExecutable(client);
    const candidates = Array.from(new Set([preferredBin, ...(CLIENT_BINARY_CANDIDATES[client] || [])]));

    let foundPath: string | null = null;
    let foundBin = preferredBin;

    for (const cand of candidates) {
      const p = Bun.which(cand);
      if (p) {
        foundPath = p;
        foundBin = cand;
        break;
      }
    }

    const clientRoles = (catalog.clients?.[client] ?? {}) as Record<string, { model: string; fallbackChain: string[] }>;
    const clientModels = Array.from(new Set(
      Object.values(clientRoles).flatMap((entry) => [entry.model, ...(entry.fallbackChain || [])])
    ));
    const clientExhausted = quotas.filter((q) => q.client === client).map((q) => q.model);
    const available = clientModels.filter((m) => !clientExhausted.includes(m));

    let quotaStatus: "healthy" | "degraded" | "exhausted" | "unconfigured" = "healthy";
    let healthy = false;

    const envExhausted = process.env[`HERDR_JEV_${client.toUpperCase()}_EXHAUSTED`] === "1";
    const isOpencode = client === "opencode";
    const isOpencodeEnabled = process.env.HERDR_JEV_ENABLE_OPENCODE === "1";

    if (foundPath) {
      if (isOpencode && !isOpencodeEnabled) {
        quotaStatus = "unconfigured";
        healthy = false;
      } else if (envExhausted || (clientModels.length > 0 && available.length === 0)) {
        quotaStatus = "exhausted";
        healthy = false;
      } else if (clientExhausted.length > 0) {
        quotaStatus = "degraded";
        healthy = true;
      } else {
        quotaStatus = "healthy";
        healthy = true;
      }
    }

    let version: string | undefined;
    if (foundPath) {
      version = await probeBinaryVersion(foundPath);
    }

    results.push({
      client,
      binary: foundBin,
      binaryPath: foundPath,
      installed: foundPath !== null,
      version,
      quotaStatus,
      healthy,
      availableModels: available,
      exhaustedModels: clientExhausted,
    });
  }

  return results;
}

/**
 * Generates an optimal recommendation for cross-harness and execution configuration.
 */
export function recommendConfiguration(harnesses: DetectedHarness[]): AutoConfigRecommendation {
  const isOpencodeEnabled = process.env.HERDR_JEV_ENABLE_OPENCODE === "1";
  const excludedClients = (process.env.HERDR_JEV_EXCLUDE_CLIENTS ?? "")
    .toLowerCase()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const healthy = harnesses
    .filter((h) => {
      if (!h.installed || !h.healthy || h.quotaStatus === "exhausted" || h.quotaStatus === "unconfigured") {
        return false;
      }
      if (h.client === "opencode" && !isOpencodeEnabled) {
        return false;
      }
      if (excludedClients.includes(h.client)) {
        return false;
      }
      return true;
    })
    .map((h) => h.client);

  if (healthy.length <= 1) {
    return {
      crossHarness: "0",
      splitSubagents: "1",
      splitDirection: "auto",
      allowAliases: "0",
      summary: healthy.length === 1
        ? `Single healthy harness detected (${healthy[0]}). Self-only delegation is recommended to avoid cross-client overhead.`
        : "No active harnesses with healthy quota detected. Defaulting to safe zero-config.",
      healthyClients: healthy,
    };
  }

  // If multiple healthy clients are detected, order them by strength
  // Preferred implementers: antigravity (Gemini 3.8 Flash High), codex, claude
  const crossHarness = healthy.join(",");

  return {
    crossHarness,
    splitSubagents: "1",
    splitDirection: "auto",
    allowAliases: "0",
    summary: `Multiple healthy harnesses detected (${healthy.join(", ")}). Cross-harness delegation enabled with fallback cascade.`,
    healthyClients: healthy,
  };
}

/**
 * Formats detection results into an aligned text table.
 */
export function formatHarnessTable(harnesses: DetectedHarness[]): string {
  const lines: string[] = [];
  lines.push("┌──────────────┬────────────┬──────────────┬────────────────┬──────────────────────────┐");
  lines.push("│ Client       │ Binary     │ Installed    │ Quota Status   │ Available Models         │");
  lines.push("├──────────────┼────────────┼──────────────┼────────────────┼──────────────────────────┤");

  for (const h of harnesses) {
    const c = h.client.padEnd(12);
    const b = h.binary.padEnd(10);
    const inst = (h.installed ? "YES" : "NO").padEnd(12);
    const q = (h.installed ? h.quotaStatus.toUpperCase() : "N/A").padEnd(14);
    const m = (h.availableModels.slice(0, 2).join(", ") || (h.installed ? "None" : "N/A")).slice(0, 24).padEnd(24);
    lines.push(`│ ${c} │ ${b} │ ${inst} │ ${q} │ ${m} │`);
  }

  lines.push("└──────────────┴────────────┴──────────────┴────────────────┴──────────────────────────┘");
  return lines.join("\n");
}

/**
 * Writes or updates the .env file with recommended auto-configuration.
 */
export function writeAutoConfigEnv(targetPath: string, rec: AutoConfigRecommendation): void {
  const fullPath = resolve(targetPath);
  let content = "";

  if (existsSync(fullPath)) {
    content = readFileSync(fullPath, "utf-8");
  }

  const updates: Record<string, string> = {
    HERDR_JEV_CROSS_HARNESS: rec.crossHarness,
    HERDR_JEV_SPLIT_SUBAGENTS: rec.splitSubagents,
    HERDR_JEV_SPLIT_DIRECTION: rec.splitDirection,
    HERDR_JEV_ALLOW_ALIASES: rec.allowAliases,
  };

  let newContent = content;

  for (const [key, val] of Object.entries(updates)) {
    const regex = new RegExp(`^#?\\s*${key}=.*$`, "m");
    if (regex.test(newContent)) {
      newContent = newContent.replace(regex, `${key}=${val}`);
    } else {
      newContent += `\n${key}=${val}`;
    }
  }

  writeFileSync(fullPath, newContent.trim() + "\n", "utf-8");
}
