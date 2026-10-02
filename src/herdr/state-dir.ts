import { randomBytes } from "node:crypto";
import { copyFileSync, constants, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

function startupCwd(): string {
  try {
    return process.cwd();
  } catch {
    return homedir();
  }
}

const STARTUP_CWD = startupCwd();

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

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error));
}

function copyEntry(from: string, to: string): "copied" | "exists" {
  const staging = `${to}.${process.pid}.${randomBytes(4).toString("hex")}.migrating`;
  copyFileSync(from, staging, constants.COPYFILE_EXCL);
  try {
    try {
      linkSync(staging, to);
      return "copied";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return "exists";
      if (code !== "EPERM" && code !== "EXDEV") throw error;
    }
    if (existsSync(to)) return "exists";
    renameSync(staging, to);
    return "copied";
  } finally {
    rmSync(staging, { force: true });
  }
}

function moveEntries(source: string, target: string, errors: string[]): void {
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(source)) {
    const from = join(source, name);
    const to = join(target, name);
    try {
      if (lstatSync(from).isDirectory()) {
        if (!existsSync(to)) {
          try {
            renameSync(from, to);
            continue;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "EEXIST" && code !== "ENOTEMPTY" && code !== "EXDEV") throw error;
          }
        }
        if (!existsSync(to) || lstatSync(to).isDirectory()) moveEntries(from, to, errors);
        else errors.push(`${name}: conflict`);
        continue;
      }
      try {
        linkSync(from, to);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST" || code === "ENOENT") continue;
        if (code !== "EXDEV" && code !== "EPERM") throw error;
        if (copyEntry(from, to) === "exists") continue;
      }
      unlinkSync(from);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(`${name}: ${errorCode(error)}`);
    }
  }
  try {
    rmdirSync(source);
  } catch {
  }
}

export function migrateLegacyState(legacy: string, configured: string): string[] {
  const errors: string[] = [];
  if (legacy === configured || !existsSync(legacy)) return errors;
  try {
    mkdirSync(dirname(configured), { recursive: true, mode: 0o700 });
    if (!existsSync(configured)) {
      try {
        renameSync(legacy, configured);
        return errors;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return errors;
        if (code !== "EEXIST" && code !== "ENOTEMPTY" && code !== "EXDEV") {
          errors.push(`${legacy}: ${errorCode(error)}`);
          return errors;
        }
      }
    }
    moveEntries(legacy, configured, errors);
  } catch (error) {
    errors.push(`${legacy}: ${errorCode(error)}`);
  }
  return errors;
}

const resolvedRoots = new Map<string, string>();

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
  if (!configured || configured === legacy) return legacy;
  const key = `${legacy}\0${configured}`;
  if (!resolvedRoots.has(key)) {
    const errors = migrateLegacyState(legacy, configured);
    if (errors.length > 0) {
      console.error(`[herdr-jev] State migration from ${legacy} to ${configured} is incomplete (${errors.slice(0, 5).join(", ")}); entries left in the old directory stay invisible until a later run moves them.`);
    }
    resolvedRoots.set(key, configured);
  }
  return resolvedRoots.get(key)!;
}

export function legacyConfigDir(): string {
  return join(homedir(), ".config", "herdr");
}

export function resolveConfigDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const override = absoluteDir(env.HERDR_JEV_CONFIG_DIR);
  if (override) return [override];
  if (isTestGuardActive(env)) {
    throw new Error("config_dir_required_in_tests");
  }
  const configured = readToolEnv(env).configDir;
  return configured ? [configured, legacyConfigDir()] : [legacyConfigDir()];
}

export function resolveConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveConfigDirs(env)[0]!;
}
