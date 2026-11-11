import { expect, test } from "bun:test";
import { approve, listProposals, mine, mineAndSave, parseFailedAttempts, reject, whereFor, visible, mergeRule } from "../src/improve/index.js";
import type { Ports } from "../src/improve/index.js";
import { shadowLine, trimShadow, compare, formatCompare, parseRouteLog, parseShadow, shadowEntry } from "../src/router/shadow.js";

const w = whereFor({}, "/h");
function mem(): { ports: Ports; files: Map<string, string>; ran: string[][] } {
  const files = new Map<string, string>();
  const ran: string[][] = [];
  const ports: Ports = {
    read: async (p) => files.get(p),
    write: async (p, t) => void files.set(p, t),
    list: async (d) => [...files.keys()].filter((p) => p.startsWith(`${d}/`) && !p.slice(d.length + 1).includes("/")).map((p) => p.slice(d.length + 1)),
    run: async (argv) => {
      ran.push(argv);
      if (argv[0] === "rm") files.delete(argv[2]!);
      if (argv[0] === "mv") {
        files.set(argv[3]!, files.get(argv[2]!)!);
        files.delete(argv[2]!);
      }
      return { code: 0, out: "" };
    },
  };
  return { ports, files, ran };
}
const DAY = 86400;
const row = (ts: number, cwd: string, error = "Exit code 1\nssh: connect to host x port 22: Connection timed out") =>
  JSON.stringify({ ts: String(ts), tool: "Bash", input: "{'command': 'ssh cast-prd uptime'}", error, project: "cast", cwd });
const failed = [row(1_700_000_000, "/a"), row(1_700_000_100, "/a"), row(1_700_000_000 + DAY, "/b")].join("\n") + "\nnot json\n";

test("pattern 3x in 2 sessions yields one proposal and changes nothing", async () => {
  const { ports, files } = mem();
  const found = await mineAndSave(ports, w, { failed }, 5);
  expect(found.length).toBe(1);
  expect(found[0]!.kind).toBe("runbook");
  expect(found[0]!.name).toContain("cast");
  expect([...files.keys()].every((k) => k.startsWith("/h/.local/state/herdr-jev/proposals/"))).toBe(true);
  expect((await mineAndSave(ports, w, { failed }, 6)).length).toBe(0);
});

test("below thresholds: same session or fewer than 3 gives nothing", () => {
  const sameSession = [row(1_700_000_000, "/a"), row(1_700_000_050, "/a"), row(1_700_000_100, "/a")].join("\n");
  expect(mine(parseFailedAttempts(sameSession), new Set(), w, 1)).toEqual([]);
  const two = [row(1_700_000_000, "/a"), row(1_700_000_000 + DAY, "/b")].join("\n");
  expect(mine(parseFailedAttempts(two), new Set(), w, 1)).toEqual([]);
});

test("approve writes the target file; rerun refuses overwrite", async () => {
  const { ports, files } = mem();
  const [p] = await mineAndSave(ports, w, { failed }, 5);
  const res = await approve(ports, w, p!.id);
  expect(res.ok).toBe(true);
  expect(files.get(p!.target)).toBe(p!.content);
  expect(p!.target.startsWith("/h/projects/personal/ai-harness-core/runbooks/")).toBe(true);
  expect((await approve(ports, w, p!.id)).ok).toBe(false);
  expect((await listProposals(ports, w, "pending")).length).toBe(0);
});

test("reject quarantines, removes the pending file and blocks re-proposal", async () => {
  const { ports, files } = mem();
  const [p] = await mineAndSave(ports, w, { failed }, 5);
  expect((await reject(ports, w, p!.id)).ok).toBe(true);
  expect(files.has(`/h/.local/state/herdr-jev/proposals/quarantine/${p!.id}.json`)).toBe(true);
  expect(files.has(`/h/.local/state/herdr-jev/proposals/${p!.id}.json`)).toBe(false);
  expect(files.has(p!.target)).toBe(false);
  expect((await mineAndSave(ports, w, { failed }, 9)).length).toBe(0);
});

test("agent, skill and rule kinds apply to their own targets", async () => {
  const { ports, files, ran } = mem();
  const mk = (tool: string, error: string, input = "{}") =>
    [0, 1, 2].map((i) => JSON.stringify({ ts: String(1_700_000_000 + i * DAY), tool, input, error, project: "cast", cwd: `/c${i}` })).join("\n");
  const found = await mineAndSave(ports, w, { failed: [mk("Agent", "agent crashed"), mk("Skill", "skill missing"), mk("Bash", "commit rejected: co-authored-by line found", "{'command': 'git commit -m x'}")].join("\n") }, 5);
  expect(found.map((p) => p.kind).sort()).toEqual(["agent", "rule", "skill"]);
  for (const p of found) expect((await approve(ports, w, p.id)).ok).toBe(true);
  const agent = found.find((p) => p.kind === "agent")!;
  expect(agent.target.startsWith("/h/.claude/agents/")).toBe(true);
  expect(files.get(agent.target)).toContain("name: ");
  expect(ran.some((a) => a[0] === "skillctl" && a[1] === "adopt")).toBe(true);
  expect(files.get("/h/.config/jev/rules.local.yml")).toBe("commit:\n  forbidden:\n    - 'co-authored-by\\s*:'\n");
});

test("mergeRule keeps existing lists and dedups", () => {
  const base = "commit:\n  forbidden:\n    - 'a'\n";
  const merged = mergeRule(base, "commit", "forbidden", "b");
  expect(merged).toContain("    - 'b'");
  expect(mergeRule(merged, "commit", "forbidden", "b")).toBe(merged);
  expect(mergeRule("", "commit", "forbidden", "b")).toBe("commit:\n  forbidden:\n    - 'b'\n");
});

test("a repeated failure without a rule-able shape never becomes a rule", () => {
  const mk = [0, 1, 2].map((i) => JSON.stringify({ ts: String(1_700_000_000 + i * DAY), tool: "Write", input: "{}", error: "denied: notes.md blocked", project: "cast", cwd: `/c${i}` })).join("\n");
  expect(mine(parseFailedAttempts(mk), new Set(), w, 1).map((p) => p.kind)).toEqual(["runbook"]);
});

test("ids are validated: traversal ids are refused and a tampered target is ignored", async () => {
  const { ports, files } = mem();
  for (const bad of ["../x", "p-zzzzzzzz", "p-123", "../../etc/passwd"]) {
    expect((await approve(ports, w, bad)).ok).toBe(false);
    expect((await reject(ports, w, bad)).ok).toBe(false);
  }
  const [p] = await mineAndSave(ports, w, { failed }, 5);
  const file = `/h/.local/state/herdr-jev/proposals/${p!.id}.json`;
  files.set(file, JSON.stringify({ ...JSON.parse(files.get(file)!), target: "/etc/evil", name: "../../evil" }));
  const res = await approve(ports, w, p!.id);
  expect([...files.keys()].every((k) => k.startsWith("/h/.local/state/herdr-jev/proposals/") || k.startsWith("/h/projects/personal/ai-harness-core/runbooks/evil.yml"))).toBe(true);
  expect(files.has("/etc/evil")).toBe(false);
  expect(res.ok === false || [...files.keys()].some((k) => k.startsWith("/h/projects/personal/ai-harness-core/runbooks/"))).toBe(true);
});

test("dry run writes nothing and reject moves instead of copying", async () => {
  const { ports, files, ran } = mem();
  expect((await mineAndSave(ports, w, { failed }, 5, true)).length).toBe(1);
  expect(files.size).toBe(0);
  const [p] = await mineAndSave(ports, w, { failed }, 5);
  await reject(ports, w, p!.id);
  expect(ran.some((a) => a[0] === "mv")).toBe(true);
});

test("shadow log appends one line per entry and trims to the cap", () => {
  const d = { class: "search", worker: "codex", model: "m", effort: "low", tier: "luna", reason: "r" };
  const line = shadowLine(shadowEntry({ prompt: "p" }, d, 1));
  expect(line.endsWith("\n")).toBe(true);
  const text = Array.from({ length: 5 }, () => line).join("");
  expect(trimShadow(text, 3).split("\n").filter(Boolean).length).toBe(3);
  expect(trimShadow(text, 10)).toBe(text);
});

test("pane shows at most 3 proposals", () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ id: String(i) }) as never);
  const v = visible(many);
  expect(v.shown.length).toBe(3);
  expect(v.hidden).toBe(2);
});

test("shadow entry records why and compare reports against the conclave log", () => {
  const d = { class: "feature", worker: "claude-subagent", model: "sonnet", effort: "medium", tier: "sonnet", reason: "feature, mid tier, small" };
  const e1 = shadowEntry({ prompt: "implement x", subagentType: "general-purpose" }, d, 1000);
  const e2 = shadowEntry({ prompt: "search y" }, { ...d, worker: "codex", model: "gpt-5.6-luna", tier: "luna", class: "search" }, 2000);
  const log = shadowLine(e1) + shadowLine(e2);
  const shadow = parseShadow(log);
  expect(shadow.length).toBe(2);
  expect(shadow[0]!.why[0]).toContain("feature");
  const route = parseRouteLog(
    [
      JSON.stringify({ kind: "delegate", ts: 1010, data: { cli: "claude", model: "sonnet", why: ["triage"] } }),
      JSON.stringify({ kind: "delegate", ts: 2005, data: { cli: "claude", model: "sonnet", why: ["triage"] } }),
    ].join("\n"),
  );
  const c = compare(shadow, route);
  expect(c.matched).toBe(2);
  expect(c.agreeCli).toBe(1);
  expect(c.disagreements.length).toBe(1);
  expect(formatCompare(c)).toContain("same cli: 1/2 (50%)");
  expect(formatCompare(compare(shadow, null))).toContain("not available");
});

test("rtk case: different cd dirs and one cause give exactly one clean proposal", () => {
  const mkrow = (i: number, dir: string) =>
    JSON.stringify({ ts: String(1_700_000_000 + i * DAY), tool: "Bash", input: `{'command': 'cd ${dir} && rtk git status'}`, error: "Exit code 127\n/bin/bash: line 1: rtk: No such file or directory", project: "whoami", cwd: `/home/dev/projects/acme/herdr-jev-p8/sub` });
  const text = [mkrow(0, "/home/dev/projects/acme/tool-a"), mkrow(1, "/home/dev/projects/acme/tool-b"), mkrow(2, "/home/dev/projects/acme/tool-c")].join("\n");
  const found = mine(parseFailedAttempts(text), new Set(), w, 1);
  expect(found.length).toBe(1);
  const p = found[0]!;
  expect(p.name).toBe("recover-bash-rtk-no-such-file-or-directory-herdr-jev-p8");
  expect(p.name).not.toMatch(/home|dev|whoami/);
  expect(p.content).toContain("command -v rtk");
  expect(p.content).toContain("No such file or directory");
  expect(p.content).toContain("cd /home/dev/projects/acme/tool-b");
  expect(p.count).toBe(3);
  expect(p.sessions).toBe(3);
});

test("generic exit code groups are dropped", () => {
  const generic = [0, 1, 2].map((i) => JSON.stringify({ ts: String(1_700_000_000 + i * DAY), tool: "Bash", input: "{}", error: `Exit code ${i + 1}`, project: "p", cwd: `/c${i}` })).join("\n");
  expect(mine(parseFailedAttempts(generic), new Set(), w, 1)).toEqual([]);
  const same = [0, 1, 2].map((i) => JSON.stringify({ ts: String(1_700_000_000 + i * DAY), tool: "Bash", input: "{}", error: "Exit code 1", project: "p", cwd: `/c${i}` })).join("\n");
  expect(mine(parseFailedAttempts(same), new Set(), w, 1)).toEqual([]);
});
