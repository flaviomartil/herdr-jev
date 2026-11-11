import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ProxyScope = "user" | "system";

export type Proxy = {
  id: string;
  port: number;
  health?: string;
  unit?: string;
  scope: ProxyScope;
  dependsOn: string[];
  usedBy: string[];
};

export const registryPath = (home = homedir()): string => join(home, ".config", "jev", "proxies.local.yml");

const unquote = (v: string): string => v.replace(/^(["'])(.*)\1$/, "$2");

function list(v: string): string[] {
  const inner = v.trim().replace(/^\[/, "").replace(/\]$/, "");
  return inner.split(",").map((s) => unquote(s.trim())).filter(Boolean);
}

export function parseRegistry(text: string): Proxy[] {
  const out: Proxy[] = [];
  let cur: Record<string, string> | null = null;
  const flush = () => {
    if (!cur) return;
    const id = cur.id;
    if (!id) throw new Error("proxy entry without id");
    const port = Number(cur.port);
    if (cur.port === undefined || !(Number.isInteger(port) && port > 0 && port < 65536)) throw new Error(`${id}: port required`);
    if (cur.unit && !/^[\w@.-]+\.service$/.test(cur.unit)) throw new Error(`${id}: invalid unit name`);
    out.push({
      id,
      port,
      ...(cur.health ? { health: cur.health } : {}),
      ...(cur.unit ? { unit: cur.unit } : {}),
      scope: cur.scope === "system" ? "system" : "user",
      dependsOn: list(cur.dependsOn ?? ""),
      usedBy: list(cur.usedBy ?? ""),
    });
    cur = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/(^|\s)#.*$/, "").trimEnd();
    if (!line.trim() || /^proxies:\s*$/.test(line)) continue;
    const m = /^\s*(-\s+)?([A-Za-z]+):\s*(.*)$/.exec(line);
    if (!m) throw new Error(`unparseable line: ${raw.trim()}`);
    if (m[1]) {
      flush();
      cur = {};
    }
    if (!cur) throw new Error(`field outside entry: ${raw.trim()}`);
    cur[m[2]!] = unquote(m[3]!.trim());
  }
  flush();
  const ids = new Set(out.map((p) => p.id));
  if (ids.size !== out.length) throw new Error("duplicate proxy id");
  for (const p of out) for (const d of p.dependsOn) if (!ids.has(d)) throw new Error(`${p.id}: unknown dependency ${d}`);
  return out;
}

export function loadRegistry(path = registryPath(), read: (p: string) => string = (p) => readFileSync(p, "utf8")): Proxy[] {
  return parseRegistry(read(path));
}
