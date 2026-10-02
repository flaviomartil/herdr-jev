import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const STARTUP_CWD = process.cwd();

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

function absoluteDir(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const expanded = expandHome(trimmed);
  return isAbsolute(expanded) ? expanded : resolve(STARTUP_CWD, expanded);
}

export function legacyStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME?.trim() || homedir(), ".local", "state", "herdr-jev");
}

export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = absoluteDir(env.HERDR_JEV_STATE_DIR);
  if (explicit) return explicit;
  const isForeignPlugin = Boolean(env.HERDR_PLUGIN_ID && env.HERDR_PLUGIN_ID !== "herdr-jev");
  const plugin = isForeignPlugin ? undefined : absoluteDir(env.HERDR_PLUGIN_STATE_DIR);
  if (plugin) return plugin;
  if (isTestGuardActive(env)) {
    throw new Error("state_dir_required_in_tests");
  }
  const legacy = legacyStateDir(env);
  const configured = readToolEnv(env).stateDir;
  if (!configured) return legacy;
  return configured !== legacy && !existsSync(configured) && existsSync(legacy) ? legacy : configured;
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
