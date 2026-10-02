import { existsSync, readFileSync } from "node:fs";

const loadedKeys = new Set<string>();

export function loadEnvFile(filePath: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!existsSync(filePath)) return [];
  const set: string[] = [];
  try {
    for (const line of readFileSync(filePath, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (env[key] === undefined) {
        env[key] = val;
        set.push(key);
        if (env === process.env) loadedKeys.add(key);
      }
    }
  } catch {
    // Ignore read errors
  }
  return set;
}

export function envFileKeys(): string[] {
  return [...loadedKeys];
}

export function reviewExcludedEnv(keys: readonly string[]): string[] {
  return keys.filter((key) => key.startsWith("HERDR_JEV_"));
}

export function withoutKeys(env: NodeJS.ProcessEnv, keys: readonly string[]): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const key of reviewExcludedEnv(keys)) delete copy[key];
  return copy;
}
