import { expect, test } from "bun:test";
import { readOverview } from "../src/herdr/overview.js";

test("overview joins projects, deduplicates branch reads and excludes transcripts", async () => {
  const calls: readonly string[][] = [];
  const run = async (argv: readonly string[]) => {
    (calls as string[][]).push([...argv]);
    return { ok: true, code: 0, stderr: "", stdout: argv.includes("snapshot") ? JSON.stringify({ result: { snapshot: {
      workspaces: [{ workspace_id: "w1", label: "API" }],
      agents: ["blocked", "working"].map((state) => ({ workspace_id: "w1", pane_id: state,
        cwd: "/tmp/api", agent: "codex", agent_status: state, terminal_title: "private transcript",
        tokens: { quota_model: "gpt-6.1-sol", quota_week_inline_normal: "7d 80%" } })),
    } } }) : "feature/task\n" };
  };
  const agents = await readOverview(run);
  expect(calls.length).toBe(2);
  expect(agents[0]).toMatchObject({ project: "API", branch: "feature/task", state: "blocked", weekly: "7d 80%" });
  expect(JSON.stringify(agents)).not.toContain("private transcript");
  await expect(readOverview(async () => ({ ok: true, code: 0, stderr: "", stdout: "{}" }))).rejects.toThrow("Invalid Herdr snapshot");
  await expect(readOverview(async () => ({ ok: false, code: 1, stderr: "offline", stdout: "" }))).rejects.toThrow("offline");
});
