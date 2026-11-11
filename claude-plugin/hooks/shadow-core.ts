export type ShadowDecision = { class: string; worker: string; model: string; effort: string; tier: string; reason: string };
export type ShadowEntry = {
  ts: number;
  kind: "shadow";
  summary: string;
  spawn: { subagentType?: string; model?: string };
  harness: { worker: string; model: string; effort: string; class: string; tier: string };
  why: string[];
};
export type RouteEntry = { ts: number; cli: string; model: string; why: string[] };
export type Compare = {
  shadowTotal: number;
  conclaveTotal: number | null;
  matched: number;
  agreeCli: number;
  agreeModel: number;
  unmatched: number;
  byWorker: Record<string, number>;
  disagreements: { ts: number; summary: string; harness: string; conclave: string; why: string[] }[];
};

export const SHADOW_CAP = 2000;
export const WINDOW_SEC = 120;
const CLI_OF: Record<string, string> = { "claude-subagent": "claude", codex: "codex", agy: "agy" };

export function shadowEntry(spawn: { subagentType?: string; model?: string; prompt: string; description?: string }, d: ShadowDecision, ts: number): ShadowEntry {
  const summary = (spawn.description ?? spawn.prompt).replace(/\s+/g, " ").trim().slice(0, 80);
  return {
    ts,
    kind: "shadow",
    summary,
    spawn: { ...(spawn.subagentType ? { subagentType: spawn.subagentType } : {}), ...(spawn.model ? { model: spawn.model } : {}) },
    harness: { worker: d.worker, model: d.model, effort: d.effort, class: d.class, tier: d.tier },
    why: [d.reason, `class ${d.class}`, `tier ${d.tier}`],
  };
}

export function parseJsonl(text: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (typeof v === "object" && v !== null) rows.push(v as Record<string, unknown>);
    } catch {
      continue;
    }
  }
  return rows;
}

export function parseShadow(text: string): ShadowEntry[] {
  return parseJsonl(text).filter((r) => r.kind === "shadow" && typeof r.harness === "object" && Number.isFinite(Number(r.ts))) as unknown as ShadowEntry[];
}

export function parseRouteLog(text: string): RouteEntry[] {
  const out: RouteEntry[] = [];
  for (const r of parseJsonl(text)) {
    if (r.kind !== "delegate" || typeof r.data !== "object" || r.data === null) continue;
    const d = r.data as Record<string, unknown>;
    const ts = Number(r.ts);
    if (!Number.isFinite(ts)) continue;
    out.push({ ts, cli: String(d.cli ?? ""), model: String(d.model ?? ""), why: Array.isArray(d.why) ? d.why.map(String) : [] });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

const sameModel = (a: string, b: string): boolean => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y || x.includes(y) || y.includes(x);
};

export function compare(shadow: readonly ShadowEntry[], route: readonly RouteEntry[] | null, windowSec = WINDOW_SEC): Compare {
  const byWorker: Record<string, number> = {};
  for (const s of shadow) byWorker[s.harness.worker] = (byWorker[s.harness.worker] ?? 0) + 1;
  const out: Compare = { shadowTotal: shadow.length, conclaveTotal: route === null ? null : route.length, matched: 0, agreeCli: 0, agreeModel: 0, unmatched: 0, byWorker, disagreements: [] };
  if (route === null) return out;
  const used = new Set<number>();
  for (const s of shadow) {
    let best = -1;
    let bestGap = Infinity;
    route.forEach((r, i) => {
      const gap = Math.abs(r.ts - s.ts);
      if (!used.has(i) && gap <= windowSec && gap < bestGap) {
        best = i;
        bestGap = gap;
      }
    });
    if (best < 0) {
      out.unmatched++;
      continue;
    }
    used.add(best);
    const r = route[best]!;
    out.matched++;
    const cliOk = (CLI_OF[s.harness.worker] ?? s.harness.worker) === r.cli;
    const modelOk = sameModel(s.harness.model, r.model);
    if (cliOk) out.agreeCli++;
    if (cliOk && modelOk) out.agreeModel++;
    if (!cliOk || !modelOk) out.disagreements.push({ ts: s.ts, summary: s.summary, harness: `${s.harness.worker}/${s.harness.model}`, conclave: `${r.cli}/${r.model}`, why: [...s.why, ...r.why] });
  }
  return out;
}

export function formatCompare(c: Compare): string {
  const pct = (n: number, d: number): string => (d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`);
  const lines = [`shadow decisions: ${c.shadowTotal}`, `workers: ${Object.entries(c.byWorker).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`];
  if (c.conclaveTotal === null) {
    lines.push("conclave route-log: not available");
    return lines.join("\n");
  }
  lines.push(`conclave route-log entries: ${c.conclaveTotal}`, `matched (within ${WINDOW_SEC}s): ${c.matched}, unmatched shadow: ${c.unmatched}`);
  lines.push(`same cli: ${c.agreeCli}/${c.matched} (${pct(c.agreeCli, c.matched)})`, `same cli and model: ${c.agreeModel}/${c.matched} (${pct(c.agreeModel, c.matched)})`);
  for (const d of c.disagreements.slice(0, 10)) lines.push(`- ${new Date(d.ts * 1000).toISOString()} harness ${d.harness} vs conclave ${d.conclave} | ${d.summary} | why: ${d.why.join("; ")}`);
  return lines.join("\n");
}

export function appendShadow(existing: string, entry: ShadowEntry, cap = SHADOW_CAP): string {
  const lines = existing.split("\n").filter(Boolean);
  lines.push(JSON.stringify(entry));
  return `${lines.slice(-cap).join("\n")}\n`;
}
