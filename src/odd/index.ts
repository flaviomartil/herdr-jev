export type Phase = "explore" | "implement" | "verify";
export type EvidenceType = "commit" | "test" | "command" | "diff";
export type Evidence = { type: EvidenceType; value: string };
export type Spec = { id: string; text: string };
export type Task = { id: string; spec: string; title: string; done: boolean; evidence: string | null };
export type LogEntry = { id: string; text: string };
export type FeatureDoc = {
  name: string;
  repo: string;
  created: string;
  specs: Spec[];
  tasks: Task[];
  log: LogEntry[];
};
export type Progress = { done: number; total: number; percent: number };
export type EvidencePorts = {
  commitExists: (sha: string) => Promise<boolean>;
  ranOk: (command: string) => boolean;
  run: (command: string) => Promise<number>;
  changed: (files: string[]) => Promise<boolean>;
};
export type Verdict = { ok: boolean; line: string; note: string };

export const FEATURES_SUBDIR = ".local/state/herdr-jev/features";
const EVIDENCE_TYPES: readonly EvidenceType[] = ["commit", "test", "command", "diff"];
const TASK_THRESHOLD = 4;
const READ_ONLY_AGENTS = new Set(["Explore", "Plan", "claude-code-guide", "web-fetch", "statusline-setup"]);

export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

export const featuresDir = (home: string, repo: string): string => `${home}/${FEATURES_SUBDIR}/${slugify(repo) || "repo"}`;
export const featurePath = (home: string, repo: string, feature: string): string => `${featuresDir(home, repo)}/${slugify(feature)}.md`;

export const isInside = (path: string, root: string): boolean => {
  const base = root.endsWith("/") ? root : `${root}/`;
  return path === root || path.startsWith(base);
};

export const newDoc = (name: string, repo: string, created: string, request: string): FeatureDoc => {
  const text = request.trim();
  return {
    name,
    repo,
    created,
    specs: text.length > 0 ? [{ id: "S1", text }] : [],
    tasks: [],
    log: [{ id: "L1", text: text.length > 0 ? text : "(no request text given)" }],
  };
};

const indent = (text: string): string => text.replace(/\r?\n/g, "\n  ");

export function renderDoc(doc: FeatureDoc): string {
  const out: string[] = [`# Feature: ${doc.name}`, `repo: ${doc.repo}`, `created: ${doc.created}`, "", "## Specs", ""];
  for (const s of doc.specs) out.push(`- ${s.id}: ${indent(s.text)}`);
  out.push("", "## Tasks", "");
  for (const t of doc.tasks) {
    out.push(`- ${t.id} [${t.spec}] ${t.done ? "done" : "open"}: ${indent(t.title)}`);
    if (t.evidence !== null) out.push(`  evidence: ${t.evidence}`);
  }
  out.push("", "## Log", "");
  for (const l of doc.log) out.push(`- ${l.id}: ${indent(l.text)}`);
  return `${out.join("\n")}\n`;
}

export function parseDoc(text: string): FeatureDoc | null {
  const lines = text.split(/\r?\n/);
  const head = lines[0]?.match(/^# Feature: (.+)$/);
  if (head === null || head === undefined) return null;
  const doc: FeatureDoc = { name: head[1] as string, repo: "", created: "", specs: [], tasks: [], log: [] };
  let section: "head" | "specs" | "tasks" | "log" = "head";
  for (const line of lines.slice(1)) {
    if (line === "## Specs") section = "specs";
    else if (line === "## Tasks") section = "tasks";
    else if (line === "## Log") section = "log";
    else if (section === "head") {
      const m = line.match(/^(repo|created): (.*)$/);
      if (m !== null) doc[m[1] as "repo" | "created"] = m[2] as string;
    } else if (line.startsWith("  ")) {
      const rest = line.slice(2);
      if (section === "tasks") {
        const ev = rest.match(/^evidence: (.*)$/);
        const last = doc.tasks[doc.tasks.length - 1];
        if (last === undefined) continue;
        if (ev !== null) last.evidence = ev[1] as string;
        else last.title += `\n${rest}`;
      } else {
        const list = section === "specs" ? doc.specs : doc.log;
        const last = list[list.length - 1];
        if (last !== undefined) last.text += `\n${rest}`;
      }
    } else if (section === "specs" || section === "log") {
      const m = line.match(/^- ([SL]\d+): (.*)$/);
      if (m !== null) (section === "specs" ? doc.specs : doc.log).push({ id: m[1] as string, text: m[2] as string });
    } else if (section === "tasks") {
      const m = line.match(/^- (T\d+) \[(S\d+)\] (open|done): (.*)$/);
      if (m !== null) doc.tasks.push({ id: m[1] as string, spec: m[2] as string, done: m[3] === "done", title: m[4] as string, evidence: null });
    }
  }
  return doc;
}

export function progress(doc: FeatureDoc): Progress {
  const total = doc.tasks.length;
  const done = doc.tasks.filter(t => t.done).length;
  return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

const nextId = (prefix: string, ids: string[]): string =>
  `${prefix}${Math.max(0, ...ids.map(id => Number(id.slice(1)) || 0)) + 1}`;

export const addSpec = (doc: FeatureDoc, text: string): FeatureDoc => ({
  ...doc,
  specs: [...doc.specs, { id: nextId("S", doc.specs.map(s => s.id)), text: text.trim() }],
});

export const addTask = (doc: FeatureDoc, title: string, spec: string): FeatureDoc | string => {
  if (!doc.specs.some(s => s.id === spec)) return `spec ${spec} does not exist in this feature`;
  const id = nextId("T", doc.tasks.map(t => t.id));
  return { ...doc, tasks: [...doc.tasks, { id, spec, title: title.trim(), done: false, evidence: null }] };
};

export const addLog = (doc: FeatureDoc, text: string): FeatureDoc => ({
  ...doc,
  log: [...doc.log, { id: nextId("L", doc.log.map(l => l.id)), text }],
});

export const completeTask = (doc: FeatureDoc, id: string, evidence: string): FeatureDoc =>
  addLog({ ...doc, tasks: doc.tasks.map(t => (t.id === id ? { ...t, done: true, evidence } : t)) }, `${id} done: ${evidence}`);

export const normalizeTaskId = (raw: unknown): string | null => {
  const m = String(raw ?? "").trim().match(/^T?(\d+)$/i);
  return m === null ? null : `T${Number(m[1])}`;
};

export const normalizeCommand = (command: string): string => command.trim().replace(/\s+/g, " ");

export function parseEvidence(raw: unknown): Evidence | string {
  let type: unknown;
  let value: unknown;
  if (typeof raw === "string") {
    const cut = raw.indexOf(":");
    type = cut < 0 ? "" : raw.slice(0, cut).trim();
    value = cut < 0 ? raw : raw.slice(cut + 1);
  } else if (typeof raw === "object" && raw !== null) {
    type = (raw as Record<string, unknown>).type;
    value = (raw as Record<string, unknown>).value;
  }
  if (!EVIDENCE_TYPES.includes(type as EvidenceType)) return "evidence.type must be commit, test, command or diff";
  if (typeof value !== "string" || value.trim().length === 0) return "evidence.value is empty";
  return { type: type as EvidenceType, value: value.trim() };
}

export async function verifyEvidence(ev: Evidence, ports: EvidencePorts): Promise<Verdict> {
  if (ev.type === "commit") {
    const sha = ev.value.toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(sha)) return { ok: false, line: "", note: "commit value is not a sha" };
    return (await ports.commitExists(sha))
      ? { ok: true, line: `commit ${sha}`, note: "commit exists" }
      : { ok: false, line: "", note: `commit ${sha} not found in this repo` };
  }
  if (ev.type === "diff") {
    const files = ev.value.split(/[\s,]+/).filter(Boolean);
    return (await ports.changed(files))
      ? { ok: true, line: `diff ${files.join(" ")}`, note: "files changed in git" }
      : { ok: false, line: "", note: "none of the cited files has a change in git" };
  }
  const cmd = normalizeCommand(ev.value);
  if (ports.ranOk(cmd)) return { ok: true, line: `${ev.type} ${cmd} exit 0`, note: "exit 0 recorded this session" };
  return (await ports.run(cmd)) === 0
    ? { ok: true, line: `${ev.type} ${cmd} exit 0`, note: "re-run exit 0" }
    : { ok: false, line: "", note: "command did not exit 0" };
}

const TEST_COMMAND = /(^|[\s;&|(])(bun\s+(run\s+)?test|npm\s+(run\s+)?test|pnpm\s+(run\s+)?test|yarn\s+test|npx\s+(vitest|jest)|vitest|jest|pytest|python3?\s+-m\s+pytest|cargo\s+(test|check|clippy)|go\s+(test|vet)|tsc|phpunit|make\s+(test|check)|claude\s+plugin\s+(test|validate)|(bun|npm|pnpm)\s+run\s+(typecheck|lint))(\s|$)/;
const EXPLORE_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export function inferPhase(tool: string, command?: string): Phase | undefined {
  if (EXPLORE_TOOLS.has(tool)) return "explore";
  if (WRITE_TOOLS.has(tool)) return "implement";
  if (tool === "Bash" && typeof command === "string" && TEST_COMMAND.test(command)) return "verify";
  return undefined;
}

export const shouldAsk = (signal: { tasks?: number; judgeClass?: string }): boolean =>
  (signal.tasks ?? 0) >= TASK_THRESHOLD || signal.judgeClass === "architectural";

export const isWriter = (subagentType: string | undefined): boolean => !READ_ONLY_AGENTS.has(subagentType ?? "") && !/review|explore|reader/i.test(subagentType ?? "");

export const writerWarning = (subagentType: string | undefined, prompt: string): string | null =>
  isWriter(subagentType) && !/\bSpec:\s*T\d+/i.test(prompt) ? "writer prompt has no 'Spec: T#' line for the open feature" : null;

export type FeatureCommand =
  | { kind: "list" }
  | { kind: "spec"; text: string }
  | { kind: "open"; name: string; request: string }
  | { kind: "usage"; reason: string };

export function parseFeatureCommand(args: string): FeatureCommand | null {
  const m = args.trim().match(/^feature(?:\s+([\s\S]*))?$/);
  if (m === null) return null;
  const rest = (m[1] ?? "").trim();
  if (rest.length === 0) return { kind: "list" };
  const word = rest.match(/^(\S+)(?:\s+([\s\S]*))?$/) as RegExpMatchArray;
  const tail = (word[2] ?? "").trim();
  if (word[1] === "spec") return tail.length === 0 ? { kind: "usage", reason: "usage: /harness feature spec <text>" } : { kind: "spec", text: tail };
  if (slugify(word[1] as string).length === 0) return { kind: "usage", reason: "feature name needs letters or digits" };
  return { kind: "open", name: slugify(word[1] as string), request: tail };
}
