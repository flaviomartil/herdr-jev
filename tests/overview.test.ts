import { expect, test } from "bun:test";
import { formatOverviewRun, matchRunForPane, readOverview, cleanModel } from "../src/herdr/overview.js";

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

test("overview matches runs by pane id, agent handle, or cwd fallback and formats summary with age", async () => {
  const now = 1_000_000;
  const runs = [
    {
      id: "run-new-cwd",
      timestampMs: now - 30_000,
      mtimeMs: now - 30_000,
      projection: {
        cwd: "/tmp/api",
        tasks: [{ id: "implementer", state: "done" }],
      },
    },
    {
      id: "run-direct-pane",
      timestampMs: now - 120_000,
      mtimeMs: now - 120_000,
      projection: {
        tasks: [
          {
            id: "implementer",
            state: "failed",
            attempts: [{ pane: "pane-target" }],
          },
        ],
      },
    },
    {
      id: "run-direct-handle",
      timestampMs: now - 60_000,
      mtimeMs: now - 60_000,
      projection: {
        tasks: [
          {
            id: "advisor",
            state: "done",
            attempts: [{ agent: "jev-handle-1" }],
          },
        ],
      },
    },
  ];

  const paneMatch = matchRunForPane(runs, { pane: "pane-target", cwd: "/tmp/api" });
  expect(paneMatch?.id).toBe("run-direct-pane");
  expect(formatOverviewRun(paneMatch, now)).toBe("implementer:failed 2m ago");

  const handleMatch = matchRunForPane(runs, { pane: "other-pane", handle: "jev-handle-1" });
  expect(handleMatch?.id).toBe("run-direct-handle");
  expect(formatOverviewRun(handleMatch, now)).toBe("advisor:done 1m ago");

  const cwdMatch = matchRunForPane(runs, { pane: "unreferenced-pane", cwd: "/tmp/api" });
  expect(cwdMatch?.id).toBe("run-new-cwd");
  expect(formatOverviewRun(cwdMatch, now)).toBe("implementer:done 30s ago");

  const noMatch = matchRunForPane(runs, { pane: "nowhere", cwd: "/tmp/other" });
  expect(noMatch).toBeUndefined();
  expect(formatOverviewRun(noMatch, now)).toBe("");

  const runCommand = async (argv: readonly string[]) => {
    return {
      ok: true,
      code: 0,
      stderr: "",
      stdout: argv.includes("snapshot")
        ? JSON.stringify({
            result: {
              snapshot: {
                workspaces: [{ workspace_id: "w1", label: "API" }],
                agents: [
                  {
                    workspace_id: "w1",
                    pane_id: "pane-target",
                    cwd: "/tmp/api",
                    agent: "codex",
                    agent_status: "working",
                    tokens: {},
                  },
                  {
                    workspace_id: "w1",
                    pane_id: "pane-unmatched",
                    cwd: "/tmp/other",
                    agent: "codex",
                    agent_status: "idle",
                    tokens: {},
                  },
                ],
              },
            },
          })
        : "feature/task\n",
    };
  };

  const agents = await readOverview(runCommand, runs, now);
  expect(agents[0].run).toBe("implementer:failed 2m ago");
  expect(agents[1].run).toBe("");
});

test("cleanModel and readOverview trim leading zero-width spaces and whitespace from models", async () => {
  expect(cleanModel(" \u200B gpt-6.1-sol ")).toBe("gpt-6.1-sol");
  expect(cleanModel("")).toBeNull();
  expect(cleanModel(null)).toBeNull();

  const runCommand = async () => ({
    ok: true,
    code: 0,
    stderr: "",
    stdout: JSON.stringify({
      result: {
        snapshot: {
          workspaces: [{ workspace_id: "w1", label: "API" }],
          agents: [
            {
              workspace_id: "w1",
              pane_id: "p1",
              cwd: "/tmp/api",
              agent: "codex",
              agent_status: "working",
              tokens: { quota_model: "  \u200B  gpt-6.1-sol  " },
            },
          ],
        },
      },
    }),
  });

  const agents = await readOverview(runCommand);
  expect(agents[0].model).toBe("gpt-6.1-sol");
});
