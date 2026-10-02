import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export function isTestGuardActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HERDR_JEV_TEST_GUARD === "1" || env.AI_HARNESS_TEST_GUARD === "1";
}

export function harnessGeneratedDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AI_HARNESS_GENERATED_DIR?.trim();
  return override ? override : join(homedir(), ".local", "share", "ai-harness", "generated");
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

export interface ToolEnv {
  configDir?: string;
  stateDir?: string;
}

export function readToolEnv(env: NodeJS.ProcessEnv = process.env, tool = "herdr-jev"): ToolEnv {
  if (isTestGuardActive(env)) return {};
  try {
    const parsed = JSON.parse(readFileSync(join(harnessGeneratedDir(env), "tool-env.json"), "utf8"));
    const entry = parsed?.tools?.[tool];
    if (!entry || typeof entry !== "object") return {};
    const result: ToolEnv = {};
    for (const key of ["configDir", "stateDir"] as const) {
      const value = typeof entry[key] === "string" ? expandHome(entry[key].trim()) : "";
      if (value && isAbsolute(value)) result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HERDR_JEV_STATE_DIR) {
    return env.HERDR_JEV_STATE_DIR;
  }
  const isForeignPlugin = Boolean(env.HERDR_PLUGIN_ID && env.HERDR_PLUGIN_ID !== "herdr-jev");
  if (!isForeignPlugin && env.HERDR_PLUGIN_STATE_DIR) {
    return env.HERDR_PLUGIN_STATE_DIR;
  }
  if (isTestGuardActive(env)) {
    throw new Error("state_dir_required_in_tests");
  }
  return readToolEnv(env).stateDir ?? join(homedir(), ".local", "state", "herdr-jev");
}

export function legacyConfigDir(): string {
  return join(homedir(), ".config", "herdr");
}

export function resolveConfigDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const override = env.HERDR_JEV_CONFIG_DIR?.trim();
  if (override) return [override];
  const configured = readToolEnv(env).configDir;
  return configured ? [configured, legacyConfigDir()] : [legacyConfigDir()];
}

export function resolveConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveConfigDirs(env)[0]!;
}
