import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const core = readFileSync(join(root, "src/rules/core.ts"), "utf8");
const yml = readFileSync(join(root, "rules/jev-rules.yml"), "utf8");
writeFileSync(join(root, "claude-plugin/hooks/rules-core.ts"), core);
writeFileSync(join(root, "claude-plugin/hooks/rules-data.ts"), `export const DEFAULT_RULES = ${JSON.stringify(yml)}\n`);
