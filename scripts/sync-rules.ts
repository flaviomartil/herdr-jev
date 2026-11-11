import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const core = readFileSync(join(root, "src/rules/core.ts"), "utf8");
const yml = readFileSync(join(root, "rules/jev-rules.yml"), "utf8");
writeFileSync(join(root, "claude-plugin/hooks/rules-core.ts"), core);
writeFileSync(join(root, "claude-plugin/hooks/rules-data.ts"), `export const DEFAULT_RULES = ${JSON.stringify(yml)}\n`);
writeFileSync(join(root, "claude-plugin/hooks/judge-core.ts"), readFileSync(join(root, "src/judge/index.ts"), "utf8"));
writeFileSync(join(root, "claude-plugin/hooks/identity-core.ts"), readFileSync(join(root, "src/identity/index.ts"), "utf8"));
writeFileSync(join(root, "claude-plugin/hooks/odd-core.ts"), readFileSync(join(root, "src/odd/index.ts"), "utf8"));
