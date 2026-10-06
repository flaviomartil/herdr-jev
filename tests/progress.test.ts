import { expect, test } from "bun:test";
import { progressForAgent, progressAttention, reportProgress, PROGRESS_TTL_MS } from "../src/herdr/progress.js";
import { readOverview } from "../src/herdr/overview.js";
import type { RunCommand } from "../src/herdr/client.js";

const unlocked = async () => async () => {};
const source = { pane_id: "w1:p1", terminal_id: "term-1", cwd: "/tmp/repo", agent: "codex",
  agent_status: "working", agent_session: { kind: "id", value: "native-1" }, tokens: {} as Record<string, string> };

test("reports validate their owner, redact activity, expire and never verify completion", async () => {
  const saved = process.env.HERDR_PANE_ID;
  process.env.HERDR_PANE_ID = source.pane_id;
  const calls: string[][] = [];
  const run: RunCommand = async argv => {
    calls.push([...argv]);
    if (argv.includes("get")) return { ok: true, code: 0, stderr: "", stdout: JSON.stringify({ result: { agent: source } }) };
    source.tokens.jev_progress = argv.at(-1)!.slice("jev_progress=".length);
    return { ok: true, code: 0, stderr: "", stdout: "" };
  };
  const historyCalls: string[][] = [];
  const history = async (argv: string[]) => {
    historyCalls.push(argv);
    return argv[0] === "show" ? { session: { native_id: "native-1", client: "codex", cwd: source.cwd, key: "codex:origin" } }
      : { work: { id: "event-1", status: "open" } };
  };
  try {
    const now = 1_000_000;
    const result = await reportProgress({ pane: source.pane_id, activity: "Testing\npassword: supersecret", percent: 40 }, run, history, unlocked, now);
    expect(result).toMatchObject({ status: "reported", evidence: "reported" });
    expect(JSON.stringify(result)).not.toContain("supersecret");
    expect(result.report.activity).not.toContain("\n");
    expect(historyCalls).toHaveLength(0);
    const fresh = progressForAgent(source, now + 1);
    expect(fresh?.percent).toBe(40);
    expect(progressForAgent(source, now + PROGRESS_TTL_MS)).toBeNull();
    expect(progressForAgent(source, now - 1)).toBeNull();
    expect(progressForAgent({ ...source, terminal_id: "replacement" }, now)).toBeNull();
    expect(progressForAgent({ ...source, agent_session: { kind: "id", value: "replacement" } }, now)).toBeNull();
    expect(progressForAgent({ ...source, cwd: "/different" }, now)).toBeNull();
    expect(progressForAgent({ ...source, tokens: { jev_progress: "null" } }, now)).toBeNull();
    const before = calls.length;
    for (const percent of [-1, 101, 1.5, NaN]) await expect(reportProgress({ pane: source.pane_id, activity: "Testing", percent }, run, history, unlocked)).rejects.toThrow("percent");
    await expect(reportProgress({ pane: "w1:p2", activity: "Testing" }, run, history, unlocked)).rejects.toThrow("own pane");
    await expect(reportProgress({ pane: source.pane_id, activity: "Testing", reason: "verified" }, run, history, unlocked)).rejects.toThrow("reason");
    expect(calls).toHaveLength(before);
    const completion = await reportProgress({ pane: source.pane_id, activity: "Ready for review", percent: 100 }, run, history, unlocked, now);
    expect(completion.report).toMatchObject({ reason: "review", inbox: "event-1" });
    expect(progressAttention("working", completion.report).attention).toBe("none");
    expect(progressAttention("idle", completion.report)).toEqual({ attention: "soon", attentionReason: "review" });
    expect(progressAttention("blocked", completion.report)).toEqual({ attention: "now", attentionReason: "blocked" });
    expect(calls.every(argv => !argv.includes("report-agent") && !argv.includes("verify") && !argv.includes("prompt"))).toBe(true);
    expect(source.agent_status).toBe("working");
  } finally {
    source.tokens = {};
    if (saved === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = saved;
  }
});

test("attention is persisted before dispatch and refuses a mismatched source session", async () => {
  const saved = process.env.HERDR_PANE_ID;
  process.env.HERDR_PANE_ID = source.pane_id;
  const order: string[] = [];
  const run: RunCommand = async argv => {
    order.push(argv.includes("get") ? "get" : "metadata");
    return argv.includes("get") ? { ok: true, code: 0, stderr: "", stdout: JSON.stringify({ result: { agent: source } }) }
      : { ok: false, code: 1, stderr: "timeout", stdout: "" };
  };
  let cwd = source.cwd;
  const history = async (argv: string[]) => {
    order.push(argv[0]!);
    return argv[0] === "show" ? { session: { native_id: "native-1", client: "codex", cwd, key: "codex:origin" } }
      : { work: { id: "event-1" } };
  };
  try {
    await expect(reportProgress({ pane: source.pane_id, activity: "Which branch?", reason: "question", event: "branch-1" }, run, history, unlocked)).rejects.toThrow("inbox event remains pending");
    expect(order).toEqual(["get", "show", "work-event", "metadata"]);
    order.length = 0; cwd = "/other";
    await expect(reportProgress({ pane: source.pane_id, activity: "Which branch?", reason: "question" }, run, history, unlocked)).rejects.toThrow("repository");
    expect(order).toEqual(["get", "show"]);
  } finally {
    if (saved === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = saved;
  }
});

test("overview prioritizes native blocks, explicit questions and review without altering states", async () => {
  const now = 1_000_000;
  const make = (pane: string, state: string, reason: string, percent: number | null) => {
    const report = { terminalId: "term-1", sessionId: "native-1", cwd: source.cwd, agent: "codex", activity: "Task",
      percent, reason, reportedAt: now, inbox: "event-1" };
    return { ...source, pane_id: pane, agent_status: state, workspace_id: "w1", tokens: { jev_progress: JSON.stringify(report) } };
  };
  const agents = [make("working", "working", "none", 40), make("review", "idle", "review", 100),
    make("question", "idle", "question", null), { ...source, pane_id: "blocked", agent_status: "blocked", workspace_id: "w1" }];
  const run: RunCommand = async argv => ({ ok: true, code: 0, stderr: "", stdout: argv.includes("snapshot")
    ? JSON.stringify({ result: { snapshot: { agents, workspaces: [{ workspace_id: "w1", label: "API" }] } } }) : "main" });
  const rows = await readOverview(run, [], now);
  expect(rows.map(row => row.pane)).toEqual(["question", "blocked", "review", "working"]);
  expect(rows.find(row => row.pane === "question")).toMatchObject({ state: "idle", attention: "now", attentionReason: "question" });
  expect(rows.find(row => row.pane === "review")).toMatchObject({ state: "idle", attention: "soon", report: { expiresAt: now + PROGRESS_TTL_MS } });
  expect((await readOverview(run, [], now + PROGRESS_TTL_MS)).filter(row => row.attention !== "none").map(row => row.pane)).toEqual(["blocked"]);
});
