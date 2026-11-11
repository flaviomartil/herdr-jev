import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { approve, listProposals, loadProposal, mineAndSave, reject, whereFor } from "./index.js";
import type { Ports } from "./index.js";
import { compare, formatCompare, parseRouteLog, parseShadow } from "../router/shadow.js";

export const nodePorts: Ports = {
  read: async (p) => (existsSync(p) ? readFileSync(p, "utf8") : undefined),
  write: async (p, text) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  },
  list: async (d) => (existsSync(d) ? readdirSync(d) : []),
  append: async (p, text) => {
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, text);
  },
  run: async (argv) => {
    const r = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8" });
    return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  },
};

const env = (): Record<string, string | undefined> => process.env;
const home = (): string => env().HOME ?? homedir();

export function routeLogPath(): string {
  return env().CONCLAVE_ROUTE_LOG ?? join(env().CONCLAVE_HOME ?? join(home(), "conclave-home"), ".conclave", "route-log.jsonl");
}

export async function improveMain(action: string, id: string | undefined, options: { events?: string; failed?: string; json?: boolean; dryRun?: boolean }): Promise<number> {
  const w = whereFor(env(), home());
  const out = (text: string): void => console.log(text);
  if (action === "mine") {
    const failed = (await nodePorts.read(options.failed ?? join(home(), ".claude", "failed-attempts.jsonl"))) ?? "";
    const events = (await nodePorts.read(options.events ?? join(w.state, "events.jsonl"))) ?? "";
    const found = await mineAndSave(nodePorts, w, { failed, events }, Math.floor(Date.now() / 1000), options.dryRun === true);
    out(options.json ? JSON.stringify(found) : found.length === 0 ? "no new proposals" : `${options.dryRun ? "dry run, nothing written\n" : ""}${found.map((p) => `${p.id} ${p.kind} ${p.name} (${p.count}x, ${p.sessions} sessions)`).join("\n")}`);
    return 0;
  }
  if (action === "list") {
    const rows = await listProposals(nodePorts, w, "all");
    out(options.json ? JSON.stringify(rows) : rows.map((p) => `${p.id} ${p.status} ${p.kind} ${p.name}`).join("\n") || "no proposals");
    return 0;
  }
  if (!id) {
    console.error(`improve ${action}: proposal id required`);
    return 2;
  }
  if (action === "show") {
    const p = await loadProposal(nodePorts, w, id);
    if (!p) {
      console.error(`proposal ${id} not found`);
      return 1;
    }
    out(options.json ? JSON.stringify(p) : `${p.kind} ${p.name} [${p.status}]\n${p.evidence.map((e) => `evidence: ${e}`).join("\n")}\n${p.diff}`);
    return 0;
  }
  if (action === "approve" || action === "reject") {
    const res = await (action === "approve" ? approve : reject)(nodePorts, w, id);
    (res.ok ? out : console.error)(res.message);
    return res.ok ? 0 : 1;
  }
  console.error(`unknown improve action: ${action}`);
  return 2;
}

export async function routerMain(action: string, options: { shadow?: string; log?: string; json?: boolean }): Promise<number> {
  if (action !== "compare") {
    console.error(`unknown router action: ${action}`);
    return 2;
  }
  const w = whereFor(env(), home());
  const shadow = parseShadow((await nodePorts.read(options.shadow ?? join(w.state, "route-shadow.jsonl"))) ?? "");
  const log = await nodePorts.read(options.log ?? routeLogPath());
  const report = compare(shadow, log === undefined ? null : parseRouteLog(log));
  console.log(options.json ? JSON.stringify(report) : formatCompare(report));
  return 0;
}
