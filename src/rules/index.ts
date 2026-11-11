import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEvaluator, mergeRules, parseRules } from "./core.js";
import type { Evaluator, RuleConfig, RuleEvent, Verdict } from "./core.js";

export * from "./core.js";

const DEFAULT_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "rules", "jev-rules.yml");

export function localRulesPath(env: Record<string, string | undefined> = process.env): string {
  return join(env.JEV_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".config", "jev"), "rules.local.yml");
}

export function loadRules(env: Record<string, string | undefined> = process.env): RuleConfig {
  const base = parseRules(readFileSync(DEFAULT_FILE, "utf8"));
  const local = localRulesPath(env);
  if (!existsSync(local)) return base;
  try {
    return mergeRules(base, parseRules(readFileSync(local, "utf8")));
  } catch {
    return base;
  }
}

export function evaluate(event: RuleEvent, evaluator: Evaluator = createEvaluator(loadRules())): Verdict {
  return evaluator.evaluate(event);
}
