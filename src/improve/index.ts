export type Kind = "agent" | "runbook" | "skill" | "rule";
export type Status = "pending" | "approved" | "rejected";
export type Observation = { pattern: string; session: string; project: string; tool: string; sample: string; ts: number; source: string; command: string; cwd: string };
export type Proposal = {
  id: string;
  kind: Kind;
  name: string;
  project: string;
  pattern: string;
  count: number;
  sessions: number;
  evidence: string[];
  target: string;
  content: string;
  diff: string;
  status: Status;
  createdAt: number;
};
export type Ports = {
  read: (path: string) => Promise<string | undefined>;
  write: (path: string, text: string) => Promise<void>;
  list: (dir: string) => Promise<string[]>;
  run: (argv: string[]) => Promise<{ code: number; out: string }>;
  append?: (path: string, text: string) => Promise<void>;
};
export const ID_PATTERN = /^p-[0-9a-f]{8}$/;
const KINDS: readonly Kind[] = ["agent", "runbook", "skill", "rule"];
export type Where = { home: string; state: string; harnessRoot: string; rulesLocal: string };
export const MIN_COUNT = 3;
export const MIN_SESSIONS = 2;

export function whereFor(env: Record<string, string | undefined>, home: string): Where {
  return {
    home,
    state: `${env.HERDR_JEV_STATE_DIR ?? `${home}/.local/state/herdr-jev`}`,
    harnessRoot: env.AI_HARNESS_CORE ?? `${home}/projects/personal/ai-harness-core`,
    rulesLocal: `${env.JEV_CONFIG_DIR ?? `${home}/.config/jev`}/rules.local.yml`,
  };
}
export const proposalsDir = (w: Where): string => `${w.state}/proposals`;
export const quarantineDir = (w: Where): string => `${w.state}/proposals/quarantine`;

export function slug(text: string, max = 40): string {
  return text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "");
}
export function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
export const proposalId = (pattern: string): string => `p-${hash(pattern)}`;

function normalizeLine(text: string): string {
  return text
    .toLowerCase()
    .replace(/^(?:[\w/.-]*\/)?(?:bash|sh|zsh)(?:: line \d+)?: /, "")
    .replace(/0x[0-9a-f]+|\b[0-9a-f]{7,}\b/g, "<h>")
    .replace(/(?:\/[\w.@-]+){2,}/g, "<p>")
    .replace(/~\/[\w.@/-]*/g, "<p>")
    .replace(/(?:\/[\w.@-]+){2,}/g, "<p>")
    .replace(/"[^"]*"|'[^']*'/g, "<s>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}
function errorLine(error: string): string {
  const lines = error.split("\n").map((l) => l.trim()).filter(Boolean);
  const real = lines.find((l) => !/^exit code \d+$/i.test(l));
  return normalizeLine(real ?? lines[0] ?? "empty");
}
function commandOf(input: string): string {
  const m = /'command':\s*'([^']*)/.exec(input) ?? /"command":\s*"([^"]*)/.exec(input);
  return (m?.[1] ?? "").replace(/^(?:\w+=\S+\s+)+/, "").replace(/\s+/g, " ").trim().slice(0, 120);
}
export function projectOf(cwd: string, fallback: string): string {
  const m = /\/projects\/[^/]+\/([^/]+)/.exec(cwd);
  if (m) return m[1]!;
  const seg = cwd.split("/").filter(Boolean);
  if (seg.length >= 3 && seg[0] === "home") return seg[seg.length - 1]!;
  return fallback;
}
const dayOf = (ts: number): string => new Date(ts * 1000).toISOString().slice(0, 10);

export function parseFailedAttempts(text: string): Observation[] {
  const out: Observation[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const tool = typeof row.tool === "string" ? row.tool : "";
    const error = typeof row.error === "string" ? row.error : "";
    const ts = Number(row.ts);
    if (!tool || !error || !Number.isFinite(ts)) continue;
    const input = typeof row.input === "string" ? row.input : JSON.stringify(row.input ?? "");
    const command = commandOf(input);
    const cwd = typeof row.cwd === "string" ? row.cwd : "";
    const project = projectOf(cwd, typeof row.project === "string" && row.project ? row.project : "unknown");
    out.push({
      pattern: `${tool}:${errorLine(error)}`,
      session: `${cwd}|${dayOf(ts)}`,
      project,
      tool,
      sample: `${error.split("\n").find((l) => l.trim() && !/^exit code \d+$/i.test(l.trim())) ?? error}`.trim().slice(0, 160),
      ts,
      source: "failed-attempts",
      command,
      cwd,
    });
  }
  return out;
}

export function parseRouteEvents(text: string): Observation[] {
  const out: Observation[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ts = Number(row.ts);
    if (!Number.isFinite(ts)) continue;
    const data = (typeof row.data === "object" && row.data !== null ? row.data : {}) as Record<string, unknown>;
    const session = typeof row.session === "string" ? row.session : dayOf(ts);
    if (row.kind === "delegate" && typeof data.kind === "string" && data.kind !== "Success") {
      const cli = String(data.cli ?? "?");
      const model = String(data.model ?? "?");
      out.push({ pattern: `route:${cli}:${model}:${data.kind}`, session, project: "herdr-jev", tool: "route", sample: `${cli} ${model} ${data.kind}`, ts, source: "route", command: "", cwd: "" });
    } else if (row.kind === "health" && row.healthy === false) {
      const id = String(row.id ?? "?");
      out.push({ pattern: `health:${id}`, session, project: "herdr-jev", tool: "health", sample: `${id} unhealthy`, ts, source: "health", command: "", cwd: "" });
    }
  }
  return out;
}

const COMMIT_PHRASES: readonly { test: RegExp; value: string }[] = [
  { test: /co-authored-by/i, value: "co-authored-by\\s*:" },
  { test: /generated\s+with/i, value: "generated\\s+with" },
];
export function ruleFor(group: readonly Observation[]): { section: string; key: string; value: string } | null {
  const first = group[0]!;
  if (first.tool !== "Bash" || !/^git commit\b/.test(first.command)) return null;
  const hit = COMMIT_PHRASES.find((p) => p.test.test(first.sample));
  return hit ? { section: "commit", key: "forbidden", value: hit.value } : null;
}

export function meaningfulTokens(pattern: string): number {
  const msg = pattern.slice(pattern.indexOf(":") + 1);
  return msg.replace(/<[a-z]>/g, " ").split(/[^a-z]+/).filter((w) => w.length > 1 && w !== "exit" && w !== "code").length;
}

function inferKind(group: Observation[]): Kind {
  const first = group[0]!;
  if (first.tool === "Agent" || first.tool === "Task") return "agent";
  if (first.tool === "Skill" || /\bskill\b/i.test(first.pattern)) return "skill";
  if (ruleFor(group) !== null) return "rule";
  return "runbook";
}

export function slugWords(text: string, max: number): string {
  const words = slug(text, 200).split("-").filter(Boolean);
  const out: string[] = [];
  let len = 0;
  for (const w of words) {
    if (len + w.length + (out.length ? 1 : 0) > max) break;
    out.push(w);
    len += w.length + (out.length > 1 ? 1 : 0);
  }
  return out.join("-");
}

function topProject(group: Observation[]): string {
  const counts = new Map<string, number>();
  for (const o of group) counts.set(o.project, (counts.get(o.project) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}

function describe(kind: Kind, group: Observation[]): { name: string; project: string } {
  const first = group[0]!;
  const project = topProject(group);
  const what = slugWords(first.pattern.replace(/<[a-z]>|#/g, " ").replace(/^(\w+):/, "$1 "), 40) || "failure";
  const prefix = kind === "agent" ? "handle" : kind === "runbook" ? "recover" : kind === "skill" ? "avoid" : "block";
  return { name: `${prefix}-${what}-${slugWords(project, 24) || "unknown"}`, project };
}

function targetFor(kind: Kind, name: string, w: Where): string {
  if (kind === "agent") return `${w.home}/.claude/agents/${name}.md`;
  if (kind === "runbook") return `${w.harnessRoot}/runbooks/${name}.yml`;
  if (kind === "skill") return `${w.home}/.claude/skills/${name}/SKILL.md`;
  return w.rulesLocal;
}

export function diagnosticFor(pattern: string, commands: readonly string[]): string {
  const missing = /^\w+:\s*([\w.-]+): (?:no such file or directory|command not found)/.exec(pattern);
  if (missing) return `command -v ${missing[1]}`;
  const first = /^([\w.-]+): (?:no such file or directory|command not found)/.exec(pattern.replace(/^\w+:/, ""));
  if (first) return `command -v ${first[1]}`;
  if (/timed out|refused|unreachable/.test(pattern)) return "ping and port check of the target host before retrying";
  return commands[0] ? `rerun with captured stderr: ${commands[0]}` : "rerun the failing call with captured stderr";
}

export function render(kind: Kind, name: string, p: { project: string; pattern: string; count: number; sessions: number; evidence: string[] }, group: Observation[]): string {
  const ev = p.evidence.map((e) => `- ${e}`).join("\n");
  const commands = [...new Set(group.map((o) => o.command).filter(Boolean))].slice(0, 3);
  const diag = diagnosticFor(p.pattern, commands);
  const summary = `Seen ${p.count} times in ${p.sessions} sessions (${p.project}): ${p.pattern}`;
  const detail = `${summary}. Error: ${group[0]!.sample}. Examples: ${commands.join(" | ") || "none"}`;
  if (kind === "agent") {
    return `---\nname: ${name}\ndescription: ${summary.replace(/:/g, " -")}\nmodel: sonnet\n---\nHandle this recurring failure before retrying.\n\nEvidence:\n${ev}\n`;
  }
  if (kind === "runbook") {
    return `schema_version: 2\nid: ${name}\ndescription: ${JSON.stringify(detail)}\nstatus: draft\nexecution:\n  default_mode: bounded_write\n  sandbox_profile: none\ntriggers:\n  - ${JSON.stringify(p.pattern)}\nskills:\n  required: []\n  on_demand: []\nservices: []\ncli_tools: []\nsteps:\n  - ${JSON.stringify(`run diagnostic: ${diag}`)}\n  - ${JSON.stringify(`fix the cause of: ${group[0]!.sample}`)}\n  - ${JSON.stringify("rerun the failing command and confirm the error is gone")}\nhandoffs: []\n`;
  }
  if (kind === "skill") {
    return `---\nname: ${name}\ndescription: ${summary.replace(/:/g, " -")}\n---\n# ${name}\n\nWhen to use: the failure below shows up again.\n\nEvidence:\n${ev}\n`;
  }
  const r = ruleFor(group)!;
  return `${r.section}:\n  ${r.key}:\n    - '${r.value}'\n`;
}

export function newFileDiff(path: string, content: string): string {
  const lines = content.replace(/\n$/, "").split("\n");
  return [`--- /dev/null`, `+++ ${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n");
}

export function mine(
  observations: readonly Observation[],
  known: ReadonlySet<string>,
  w: Where,
  now: number,
  limits: { count: number; sessions: number } = { count: MIN_COUNT, sessions: MIN_SESSIONS },
): Proposal[] {
  const groups = new Map<string, Observation[]>();
  for (const o of observations) {
    const g = groups.get(o.pattern);
    if (g) g.push(o);
    else groups.set(o.pattern, [o]);
  }
  const out: Proposal[] = [];
  for (const [pattern, group] of groups) {
    const sessions = new Set(group.map((o) => o.session)).size;
    if (group.length < limits.count || sessions < limits.sessions) continue;
    if (group[0]!.source === "failed-attempts" && meaningfulTokens(pattern) < 3) continue;
    const id = proposalId(pattern);
    if (known.has(id)) continue;
    const kind = inferKind(group);
    const { name, project } = describe(kind, group);
    const evidence = [
      ...[...new Set(group.map((o) => o.sample))].slice(0, 2),
      ...[...new Set(group.map((o) => o.command).filter(Boolean))].slice(0, 3).map((c) => `example: ${c}`),
    ];
    const content = render(kind, name, { project, pattern, count: group.length, sessions, evidence }, group);
    const target = targetFor(kind, name, w);
    out.push({ id, kind, name, project, pattern, count: group.length, sessions, evidence, target, content, diff: newFileDiff(target, content), status: "pending", createdAt: now });
  }
  return out.sort((a, b) => b.count - a.count).slice(0, 3);
}

const fileOf = (w: Where, id: string): string => {
  if (!ID_PATTERN.test(id)) throw new Error(`invalid proposal id: ${id}`);
  return `${proposalsDir(w)}/${id}.json`;
};

export async function ledgerIds(ports: Ports, w: Where): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const dir of [proposalsDir(w), quarantineDir(w)]) {
    for (const name of await ports.list(dir)) if (name.endsWith(".json")) ids.add(name.slice(0, -5));
  }
  return ids;
}
export async function listProposals(ports: Ports, w: Where, status: Status | "all" = "pending"): Promise<Proposal[]> {
  const rows: Proposal[] = [];
  for (const name of await ports.list(proposalsDir(w))) {
    if (!name.endsWith(".json")) continue;
    const text = await ports.read(`${proposalsDir(w)}/${name}`);
    if (!text) continue;
    try {
      const p = JSON.parse(text) as Proposal;
      if (status === "all" || p.status === status) rows.push(p);
    } catch {
      continue;
    }
  }
  return rows.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}
export async function loadProposal(ports: Ports, w: Where, id: string): Promise<Proposal | undefined> {
  if (!ID_PATTERN.test(id)) return undefined;
  const text = await ports.read(fileOf(w, id));
  if (!text) return undefined;
  try {
    const p = JSON.parse(text) as Proposal;
    return p.id === id && KINDS.includes(p.kind) && typeof p.name === "string" ? p : undefined;
  } catch {
    return undefined;
  }
}
export async function saveProposals(ports: Ports, w: Where, proposals: readonly Proposal[]): Promise<void> {
  for (const p of proposals) await ports.write(fileOf(w, p.id), `${JSON.stringify(p, null, 2)}\n`);
}

export async function mineAndSave(ports: Ports, w: Where, sources: { failed?: string; events?: string }, now: number, dryRun = false): Promise<Proposal[]> {
  const observations = [...parseFailedAttempts(sources.failed ?? ""), ...parseRouteEvents(sources.events ?? "")];
  const found = mine(observations, await ledgerIds(ports, w), w, now);
  if (!dryRun) await saveProposals(ports, w, found);
  return found;
}

export function mergeRule(existing: string, section: string, key: string, value: string): string {
  const entry = `    - '${value}'`;
  if (existing.split("\n").includes(entry)) return existing;
  const lines = existing.split("\n");
  const head = lines.findIndex((l) => l === `${section}:`);
  if (head < 0) return `${existing.trim() ? existing.replace(/\n*$/, "\n") : ""}${section}:\n  ${key}:\n${entry}\n`;
  let at = -1;
  for (let i = head + 1; i < lines.length && (/^\s/.test(lines[i]!) || !lines[i]!.trim()); i++) if (lines[i] === `  ${key}:`) at = i;
  if (at < 0) lines.splice(head + 1, 0, `  ${key}:`, entry);
  else lines.splice(at + 1, 0, entry);
  return lines.join("\n");
}

export async function approve(ports: Ports, w: Where, id: string): Promise<{ ok: boolean; message: string }> {
  const p = await loadProposal(ports, w, id);
  if (!p) return { ok: false, message: `proposal ${id} not found` };
  if (p.status !== "pending") return { ok: false, message: `proposal ${id} is ${p.status}` };
  const name = slug(p.name, 80);
  if (!name) return { ok: false, message: "invalid proposal name" };
  const target = targetFor(p.kind, name, w);
  if (p.kind === "rule") {
    const m = /^(\w+):\n  (\w+):\n    - '([^'\n]+)'\n?$/.exec(p.content);
    if (!m) return { ok: false, message: "invalid rule content" };
    await ports.write(target, mergeRule((await ports.read(target)) ?? "", m[1]!, m[2]!, m[3]!));
  } else if (p.kind === "skill") {
    const stage = `${proposalsDir(w)}/staging/${name}`;
    await ports.write(`${stage}/SKILL.md`, p.content);
    const ran = await ports.run(["skillctl", "adopt", stage, "--name", name, "--scope", "global"]);
    if (ran.code !== 0) return { ok: false, message: `skillctl adopt failed: ${ran.out.slice(0, 200)}` };
  } else {
    if ((await ports.read(target)) !== undefined) return { ok: false, message: `${target} already exists` };
    await ports.write(target, p.content);
  }
  await ports.write(fileOf(w, id), `${JSON.stringify({ ...p, status: "approved" }, null, 2)}\n`);
  return { ok: true, message: `applied ${p.kind} ${name} -> ${target}` };
}

export async function reject(ports: Ports, w: Where, id: string): Promise<{ ok: boolean; message: string }> {
  const p = await loadProposal(ports, w, id);
  if (!p) return { ok: false, message: `proposal ${id} not found` };
  if (p.status !== "pending") return { ok: false, message: `proposal ${id} is ${p.status}` };
  await ports.write(fileOf(w, id), `${JSON.stringify({ ...p, status: "rejected" }, null, 2)}\n`);
  await ports.run(["mkdir", "-p", quarantineDir(w)]);
  const moved = await ports.run(["mv", "-f", fileOf(w, id), `${quarantineDir(w)}/${id}.json`]);
  if (moved.code !== 0) return { ok: false, message: "could not move the proposal to quarantine" };
  return { ok: true, message: `quarantined ${p.name}` };
}

export function visible(proposals: readonly Proposal[], max = 3): { shown: Proposal[]; hidden: number } {
  return { shown: proposals.slice(0, max), hidden: Math.max(0, proposals.length - max) };
}
