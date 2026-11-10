import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHarnessRoot } from "../harness/bridge.js";

export type SyncClient = "codex" | "antigravity" | "kimi" | "opencode" | "claude" | "cursor" | "kiro";

export interface Discovery {
  client: SyncClient;
  ok: boolean;
  reason?: string;
  ids: string[];
}

export interface RoleRepair {
  client: string;
  role: string;
  from: string;
  to: string;
}

export interface SyncReport {
  applied: boolean;
  discoveries: Discovery[];
  missingInHarness: Record<string, string[]>;
  staleInHarness: Record<string, string[]>;
  repairs: RoleRepair[];
  unresolved: Array<{ client: string; role: string; model: string }>;
  invalidOverrides: Array<{ key: string; model: string }>;
  harnessPath: string;
  matrixPath: string;
  validation?: { ok: boolean; output: string };
}

export interface SyncDeps {
  run: (command: string, args: string[], timeoutMs: number) => { ok: boolean; stdout: string; stderr: string };
  read: (path: string) => string | undefined;
  write: (path: string, text: string) => void;
  home: string;
  harnessRoot: string;
  matrixPath: string;
  overridesPath: string;
}

const MATRIX_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../config/models.json");
const EFFORT_SUFFIX = /-(low|medium|high)$/;

export function defaultSyncDeps(): SyncDeps {
  const home = homedir();
  return {
    run: (command, args, timeoutMs) => {
      const result = spawnSync(command, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
      return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? String(result.error ?? "") };
    },
    read: (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
    write: (path, text) => writeFileSync(path, text),
    home,
    harnessRoot: resolveHarnessRoot(),
    matrixPath: MATRIX_PATH,
    overridesPath: join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "herdr", "herdr-jev-models.json"),
  };
}

export function parseCodexCache(text: string): string[] {
  const parsed = JSON.parse(text) as { models?: Array<{ slug?: string; visibility?: string }> };
  return (parsed.models ?? [])
    .filter((model) => typeof model.slug === "string" && model.visibility === "list" && /^gpt-/.test(model.slug))
    .map((model) => model.slug as string);
}

export function parseTabbedList(text: string): string[] {
  return text.split("\n").map((line) => line.split("\t")[0]!.trim()).filter((id) => /^[a-z0-9][\w.-]*-(low|medium|high)$/i.test(id));
}

export function parseKimiConfig(text: string): string[] {
  return [...new Set([...text.matchAll(/"(kimi-code\/[^"]+)"\s*=\s*\{/g)].map((match) => match[1]!))];
}

export function parseOpencodeList(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter((line) => /^[\w.-]+\/\S+$/.test(line));
}

export function discover(client: SyncClient, deps: SyncDeps, probeClaude: string[] = []): Discovery {
  const fail = (reason: string): Discovery => ({ client, ok: false, reason, ids: [] });
  const done = (ids: string[], empty: string): Discovery => (ids.length ? { client, ok: true, ids } : fail(empty));
  try {
    if (client === "codex") {
      const cache = deps.read(join(deps.home, ".codex", "models_cache.json"));
      return cache ? done(parseCodexCache(cache), "empty_models_cache") : fail("models_cache_missing");
    }
    if (client === "antigravity") {
      const result = deps.run("agy", ["models"], 45_000);
      return result.ok ? done(parseTabbedList(result.stdout), "empty_model_list") : fail(firstLine(result.stderr || result.stdout));
    }
    if (client === "kimi") {
      const config = deps.read(join(deps.home, ".kimi-code", "config.toml"));
      return config ? done(parseKimiConfig(config), "no_models_in_config") : fail("config_missing");
    }
    if (client === "opencode") {
      const result = deps.run("opencode", ["models"], 45_000);
      return result.ok ? done(parseOpencodeList(result.stdout), "empty_model_list") : fail(firstLine(result.stderr || result.stdout));
    }
    if (client === "claude") {
      if (!probeClaude.length) return fail("no_list_command_use_probe");
      const alive = probeClaude.filter((id) => deps.run("claude", ["-p", "--model", id, "--tools", "", "--strict-mcp-config", "Reply with the single word ok"], 90_000).ok);
      return done(alive, "no_model_answered");
    }
    if (client === "cursor") {
      const result = deps.run("cursor-agent", ["models"], 20_000);
      return result.ok ? done(parseOpencodeList(result.stdout), "empty_model_list") : fail(firstLine(result.stderr || result.stdout));
    }
    return fail("no_list_command");
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find((line) => line.length > 0)?.slice(0, 160) ?? "command_failed";
}

interface Block { start: number; end: number; lines: string[] }

function clientBlock(lines: string[], client: string): Block | undefined {
  const root = lines.findIndex((line) => line === "models:");
  if (root < 0) return undefined;
  let start = -1;
  for (let index = root + 1; index < lines.length; index++) {
    if (/^\S/.test(lines[index]!)) break;
    if (lines[index] === `  ${client}:`) { start = index; break; }
  }
  if (start < 0) return undefined;
  let end = start + 1;
  while (end < lines.length && (lines[end]!.trim() === "" || /^ {3,}\S/.test(lines[end]!))) end++;
  while (end > start + 1 && lines[end - 1]!.trim() === "") end--;
  return { start, end, lines: lines.slice(start, end) };
}

export function catalogTokens(yaml: string, client: string): Set<string> {
  const block = clientBlock(yaml.split("\n"), client);
  const tokens = new Set<string>();
  if (!block) return tokens;
  const from = block.lines.findIndex((line) => /^ {4}models:/.test(line));
  for (const line of block.lines.slice(from < 0 ? 0 : from)) for (const token of line.match(/[A-Za-z0-9][\w./-]*/g) ?? []) tokens.add(token);
  return tokens;
}

export function catalogCliIds(yaml: string, client: string): string[] {
  const block = clientBlock(yaml.split("\n"), client);
  if (!block) return [];
  const ids: string[] = [];
  let current: { id: string; cli?: string; mapped: string[] } | undefined;
  const flush = () => { if (current) ids.push(...(current.mapped.length ? current.mapped : [current.cli ?? current.id])); };
  for (const line of block.lines) {
    const id = line.match(/^ {6}- id: (\S+)/);
    if (id) { flush(); current = { id: id[1]!, mapped: [] }; continue; }
    if (!current) continue;
    const cli = line.match(/^ {8}cli_id: (\S+)/);
    if (cli) current.cli = cli[1]!;
    const mapped = line.match(/^ {8}effort_cli_ids: \{(.*)\}/);
    if (mapped) current.mapped = mapped[1]!.split(",").map((pair) => pair.split(":")[1]!.trim());
  }
  flush();
  return ids;
}

export function harnessEntries(client: string, missing: string[]): { entries: string[]; names: string[] } {
  const entries: string[] = [];
  const names: string[] = [];
  if (client === "antigravity") {
    const bases = [...new Set(missing.map((id) => id.replace(EFFORT_SUFFIX, "")))];
    for (const base of bases) {
      const has = (suffix: string) => missing.includes(`${base}-${suffix}`);
      const id = base.replace(/\./g, "-");
      if (has("medium")) {
        names.push(id);
        entries.push(`      - id: ${id}`, `        cli_id: ${base}-medium`,
          `        efforts: [standard${has("high") ? ", high" : ""}]`,
          `        effort_cli_ids: {standard: ${base}-medium${has("high") ? `, high: ${base}-high` : ""}}`);
      }
      if (has("low")) {
        names.push(`${base}-low`);
        entries.push(`      - id: ${base}-low`, "        effort_style: none", "        efforts: [standard]");
      }
    }
    return { entries, names };
  }
  for (const id of missing) {
    names.push(id);
    entries.push(`      - id: ${id}`);
    if (client === "kimi") entries.push("        efforts: [standard]");
  }
  return { entries, names };
}

export function insertCatalogEntries(yaml: string, client: string, entries: string[]): string {
  if (!entries.length) return yaml;
  const lines = yaml.split("\n");
  const block = clientBlock(lines, client);
  if (!block) throw new Error(`harness_client_block_missing:${client}`);
  const empty = block.lines.findIndex((line) => /^ {4}models: \[\]\s*$/.test(line));
  if (empty >= 0) lines[block.start + empty] = "    models:";
  lines.splice(block.end, 0, ...entries);
  return lines.join("\n");
}

interface MatrixRole { model: string; fallbackChain: string[]; [key: string]: unknown }
interface Matrix { updatedAt?: string; clients: Record<string, Record<string, MatrixRole>> }

export function repairMatrix(matrix: Matrix, valid: Record<string, Set<string>>): { repairs: RoleRepair[]; unresolved: SyncReport["unresolved"] } {
  const repairs: RoleRepair[] = [];
  const unresolved: SyncReport["unresolved"] = [];
  for (const [client, roles] of Object.entries(matrix.clients)) {
    const names = valid[client];
    if (!names) continue;
    for (const [role, entry] of Object.entries(roles)) {
      const chain = entry.fallbackChain.filter((model) => names.has(model));
      if (names.has(entry.model)) {
        entry.fallbackChain = chain.includes(entry.model) ? chain : [entry.model, ...chain];
        continue;
      }
      const next = chain[0];
      if (!next) {
        unresolved.push({ client, role, model: entry.model });
        continue;
      }
      repairs.push({ client, role, from: entry.model, to: next });
      entry.model = next;
      entry.fallbackChain = chain;
    }
  }
  return { repairs, unresolved };
}

const DISCOVERABLE: SyncClient[] = ["codex", "antigravity", "kimi", "opencode", "claude", "cursor", "kiro"];
const HARNESS_PATCHED: SyncClient[] = ["codex", "antigravity", "kimi"];

export function syncModels(options: { apply?: boolean; probeClaude?: boolean; clients?: SyncClient[] } = {}, deps: SyncDeps = defaultSyncDeps()): SyncReport {
  const harnessPath = join(deps.harnessRoot, "harness.yml");
  const original = deps.read(harnessPath);
  if (original === undefined) throw new Error(`harness_yml_missing:${harnessPath}`);
  const matrixText = deps.read(deps.matrixPath);
  if (matrixText === undefined) throw new Error(`matrix_missing:${deps.matrixPath}`);
  const matrix = JSON.parse(matrixText) as Matrix;
  const clients = options.clients ?? DISCOVERABLE;
  const discoveries = clients.map((client) => discover(client, deps, options.probeClaude ? catalogCliIds(original, "claude") : []));

  let yaml = original;
  const missingInHarness: Record<string, string[]> = {};
  const staleInHarness: Record<string, string[]> = {};
  const valid: Record<string, Set<string>> = {};
  for (const found of discoveries) {
    if (!found.ok) continue;
    const cataloged = catalogCliIds(yaml, found.client);
    const stale = cataloged.filter((id) => !found.ids.includes(id));
    if (stale.length && found.client !== "opencode") staleInHarness[found.client] = stale;
    const names = new Set(found.ids);
    if (HARNESS_PATCHED.includes(found.client)) {
      const tokens = catalogTokens(yaml, found.client);
      const missing = found.ids.filter((id) => !tokens.has(id));
      const { entries, names: added } = harnessEntries(found.client, missing);
      if (added.length) missingInHarness[found.client] = added;
      yaml = insertCatalogEntries(yaml, found.client, entries);
    }
    if (found.client !== "opencode") {
      const dead = new Set(stale);
      for (const token of catalogTokens(yaml, found.client)) if (!dead.has(token)) names.add(token);
    }
    valid[found.client] = names;
  }

  const { repairs, unresolved } = repairMatrix(matrix, valid);
  const overridesText = deps.read(deps.overridesPath);
  const invalidOverrides: SyncReport["invalidOverrides"] = [];
  if (overridesText) {
    try {
      for (const [key, model] of Object.entries(JSON.parse(overridesText) as Record<string, string>)) {
        const names = valid[key.split(".")[0]!];
        if (names && !names.has(model)) invalidOverrides.push({ key, model });
      }
    } catch {
      invalidOverrides.push({ key: "*", model: "unreadable_overrides_file" });
    }
  }

  const report: SyncReport = { applied: false, discoveries, missingInHarness, staleInHarness, repairs, unresolved, invalidOverrides, harnessPath, matrixPath: deps.matrixPath };
  if (!options.apply) return report;

  if (yaml !== original) {
    deps.write(harnessPath, yaml);
    const checksums = join(deps.harnessRoot, "scripts", "update-checksums.py");
    if (deps.read(checksums) !== undefined) deps.run("python3", [checksums, "--write"], 120_000);
    const check = deps.run("ai-harness", ["validate", "--root", deps.harnessRoot], 120_000);
    report.validation = { ok: check.ok, output: firstLine(check.stderr || check.stdout) };
    if (!check.ok) {
      deps.write(harnessPath, original);
      if (deps.read(checksums) !== undefined) deps.run("python3", [checksums, "--write"], 120_000);
      return report;
    }
  }
  if (repairs.length) {
    matrix.updatedAt = new Date().toISOString();
    deps.write(deps.matrixPath, `${JSON.stringify(matrix, null, 2)}\n`);
  }
  report.applied = true;
  return report;
}

export function formatSyncReport(report: SyncReport): string {
  const lines: string[] = [];
  for (const found of report.discoveries) lines.push(found.ok ? `${found.client}: ${found.ids.length} live models` : `${found.client}: skipped (${found.reason})`);
  for (const [client, ids] of Object.entries(report.missingInHarness)) lines.push(`${report.applied ? "added to" : "missing in"} harness.yml [${client}]: ${ids.join(", ")}`);
  for (const [client, ids] of Object.entries(report.staleInHarness)) lines.push(`cataloged but not live [${client}]: ${ids.join(", ")}`);
  for (const fix of report.repairs) lines.push(`${report.applied ? "repaired" : "would repair"} ${fix.client}.${fix.role}: ${fix.from} -> ${fix.to}`);
  for (const item of report.unresolved) lines.push(`needs manual choice ${item.client}.${item.role}: ${item.model} is not live and no fallback is`);
  for (const item of report.invalidOverrides) lines.push(`user override not live: ${item.key} = ${item.model}`);
  if (report.validation) lines.push(`harness validate: ${report.validation.ok ? "ok" : `failed, harness.yml restored (${report.validation.output})`}`);
  const drift = Object.keys(report.missingInHarness).length + report.repairs.length;
  lines.push(drift === 0 ? "catalogs in sync" : report.applied ? "catalogs updated" : "drift found: rerun with --apply");
  return lines.join("\n");
}
