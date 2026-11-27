import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { buildAgentsView } from "../src/herdr/agents.js";
import type { HerdrClient, RunCommand } from "../src/herdr/client.js";
import {
  launchStageInHerdr,
  MIN_SPLIT_HEIGHT,
  MIN_SPLIT_WIDTH,
  parseHerdrTerminalId,
  planGridSplit,
  readGridWorkerRecords,
  writeGridWorkers,
} from "../src/herdr/launcher.js";
import { reportProgress } from "../src/herdr/progress.js";
import type { HerdrCommandResult, StageSpec } from "../src/types/index.js";
import { assertNoRealHomeStateLeaks, createTestStateDir } from "./helpers.js";

const stage: StageSpec = {
  role: "implementer",
  model: "sonnet-5",
  effort: "high",
  extraFlags: [],
  description: "synthetic",
};

const ok = (stdout = ""): HerdrCommandResult => ({ ok: true, code: 0, stdout, stderr: "" });
const fail = (stderr: string, stdout = ""): HerdrCommandResult => ({ ok: false, code: 1, stdout, stderr });

let testEnv: { stateDir: string; cleanup: () => void };
const savedHerdrEnv = process.env.HERDR_ENV;

beforeEach(() => {
  testEnv = createTestStateDir();
  process.env.HERDR_ENV = "1";
});

afterEach(() => {
  if (savedHerdrEnv === undefined) delete process.env.HERDR_ENV;
  else process.env.HERDR_ENV = savedHerdrEnv;
  testEnv.cleanup();
  assertNoRealHomeStateLeaks();
});

describe("Frente 1 launcher hardening", () => {
  it("parses terminal_id from split and tab outputs", () => {
    expect(parseHerdrTerminalId(JSON.stringify({ result: { pane: { pane_id: "p1", terminal_id: "t1" } } }))).toBe("t1");
    expect(parseHerdrTerminalId(JSON.stringify({ result: { root_pane: { pane_id: "p2", terminal_id: "t2" } } }))).toBe("t2");
    expect(parseHerdrTerminalId("p-plain")).toBeUndefined();
  });

  it("performs conditional within-generation orphan reclaim when getPane is present", async () => {
    let closed: string[] = [];
    const baseClient = (paneResp: HerdrCommandResult): HerdrClient => ({
      splitCurrent: async () => ok(JSON.stringify({ result: { pane: { pane_id: "w-1", terminal_id: "term-1" } } })),
      startAgent: async () => fail("unsupported agent kind"),
      getPane: async () => paneResp,
      closePane: async (id) => { closed.push(id); return ok(); },
      prompt: async () => ok(),
      waitFor: async () => ok("done"),
      notify: async () => ok(),
    });

    // 1. Matching orphan (no agent, no agent_session, matching terminal_id) -> closed
    const orphanRes = await launchStageInHerdr({
      client: "claude",
      stage,
      handoffPrompt: "",
      agentName: "orphan-ok",
      sourcePaneId: "caller-1",
      herdr: baseClient(ok(JSON.stringify({ result: { pane: { pane_id: "w-1", terminal_id: "term-1", agent: null, agent_session: null } } }))),
    });
    expect(orphanRes.recovery).toBe("closed");
    expect(orphanRes.paneCreated).toBe(false);
    expect(closed).toEqual(["w-1"]);

    // 2. Pane reused by a different terminal_id -> refuses close (recovery: "none")
    closed = [];
    const mismatchRes = await launchStageInHerdr({
      client: "claude",
      stage,
      handoffPrompt: "",
      agentName: "orphan-mismatch",
      sourcePaneId: "caller-1",
      herdr: baseClient(ok(JSON.stringify({ result: { pane: { pane_id: "w-1", terminal_id: "term-other", agent: null } } }))),
    });
    expect(mismatchRes.recovery).toBe("none");
    expect(mismatchRes.paneCreated).toBe(true);
    expect(closed).toEqual([]);

    // 3. Pane already has an agent/agent_session -> refuses close (recovery: "none")
    const occupiedRes = await launchStageInHerdr({
      client: "claude",
      stage,
      handoffPrompt: "",
      agentName: "orphan-occupied",
      sourcePaneId: "caller-1",
      herdr: baseClient(ok(JSON.stringify({ result: { pane: { pane_id: "w-1", terminal_id: "term-1", agent: "codex" } } }))),
    });
    expect(occupiedRes.recovery).toBe("none");
    expect(closed).toEqual([]);

    // 4. getPane transport failure -> recovery: "unknown", refuses close
    const unknownRes = await launchStageInHerdr({
      client: "claude",
      stage,
      handoffPrompt: "",
      agentName: "orphan-unknown",
      sourcePaneId: "caller-1",
      herdr: baseClient(fail("socket error")),
    });
    expect(unknownRes.recovery).toBe("unknown");
    expect(closed).toEqual([]);
  });

  it("reconciles moved worker paneId by terminalId during grid launch and agents view", async () => {
    writeGridWorkers("caller-A", [{ paneId: "w-old", terminalId: "term-moved", handle: "peer-moved", cwd: "/tmp/repo" }]);
    const herdr: HerdrClient = {
      paneLayout: async () =>
        ok(
          JSON.stringify({
            result: {
              layout: {
                area: { x: 0, y: 0, width: 200, height: 60 },
                panes: [
                  { pane_id: "caller-A", terminal_id: "term-caller", rect: { x: 0, y: 0, width: 100, height: 60 } },
                  { pane_id: "w-new", terminal_id: "term-moved", rect: { x: 100, y: 0, width: 100, height: 60 } },
                ],
              },
            },
          }),
        ),
      splitCurrent: async () => ok(JSON.stringify({ result: { pane: { pane_id: "w-2", terminal_id: "term-2" } } })),
      startAgent: async () => ok(),
      getAgent: async () => ok(JSON.stringify({ result: { agent: { agent_status: "idle" } } })),
      readAgent: async () => ok("❯ "),
      prompt: async () => ok(),
      waitFor: async () => ok("done"),
      closePane: async () => ok(),
      notify: async () => ok(),
    };
    const res = await launchStageInHerdr({
      client: "claude",
      stage,
      handoffPrompt: "",
      agentName: "peer-2",
      sourcePaneId: "caller-A",
      cwd: "/tmp/repo",
      herdr,
    });
    expect(res.ok).toBe(true);
    const records = readGridWorkerRecords("caller-A");
    expect(records.map((r) => r.paneId)).toEqual(["w-new", "w-2"]);
    expect(records[0]!.terminalId).toBe("term-moved");

    const groups = await buildAgentsView("caller-A", {
      client: {
        listPanes: async () =>
          ok(
            JSON.stringify({
              result: {
                panes: [
                  { pane_id: "caller-A", terminal_id: "term-caller" },
                  { pane_id: "w-moved-again", terminal_id: "term-moved" },
                  { pane_id: "w-2", terminal_id: "term-2" },
                ],
              },
            }),
          ),
      } as unknown as HerdrClient,
      overviewData: [],
      runs: [],
      git: async () => ({ ok: false, stdout: "", stderr: "" }),
    });
    expect(groups.flatMap((g) => g.rows.map((r) => r.paneId))).toEqual(["w-moved-again", "w-2"]);
    expect(readGridWorkerRecords("caller-A").map((r) => r.paneId)).toEqual(["w-moved-again", "w-2"]);
  });

  it("rejects readiness while agent.launch_pending is true", async () => {
    let getCalls = 0;
    let promptCalls = 0;
    let now = 0;
    const herdr: HerdrClient = {
      splitCurrent: async () => ok(JSON.stringify({ result: { pane: { pane_id: "w-1", terminal_id: "term-1" } } })),
      startAgent: async () => ok(),
      getAgent: async () => {
        getCalls += 1;
        return ok(
          JSON.stringify({
            result: {
              agent: {
                agent_status: "idle",
                launch_pending: getCalls < 3,
              },
            },
          }),
        );
      },
      readAgent: async () => ok(promptCalls > 0 ? "my prompt text" : "❯ "),
      prompt: async () => {
        promptCalls += 1;
        expect(getCalls).toBeGreaterThanOrEqual(3);
        return ok();
      },
      waitFor: async () => ok("done"),
      closePane: async () => ok(),
      notify: async () => ok(),
    };

    const res = await launchStageInHerdr({
      client: "claude",
      stage,
      handoffPrompt: "my prompt text",
      agentName: "pending-guard",
      sourcePaneId: "caller-1",
      herdr,
      clock: {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    });
    expect(res.ok).toBe(true);
    expect(getCalls).toBeGreaterThanOrEqual(3);
    expect(promptCalls).toBe(1);
  });

  it("flags tooSmall in planGridSplit only when all eligible panes fall below minimum geometry", () => {
    const tinyLayout = {
      result: {
        layout: {
          area: { x: 0, y: 0, width: 60, height: 16 },
          panes: [
            { pane_id: "caller", rect: { x: 0, y: 0, width: MIN_SPLIT_WIDTH - 1, height: MIN_SPLIT_HEIGHT - 1 } },
            { pane_id: "w-1", rect: { x: 35, y: 0, width: 25, height: 9 } },
          ],
        },
      },
    };
    expect(planGridSplit(tinyLayout, "caller", ["w-1"]).tooSmall).toBe(true);

    const mixedLayout = {
      result: {
        layout: {
          area: { x: 0, y: 0, width: 120, height: 40 },
          panes: [
            { pane_id: "caller", rect: { x: 0, y: 0, width: 80, height: 40 } },
            { pane_id: "w-1", rect: { x: 80, y: 0, width: 40, height: 40 } },
          ],
        },
      },
    };
    expect(planGridSplit(mixedLayout, "caller", ["w-1"]).tooSmall).toBeUndefined();
  });

  it("allows reportProgress to match by terminalId when pane moved after resolve while keeping own-pane guard", async () => {
    const savedPane = process.env.HERDR_PANE_ID;
    const savedTerm = process.env.HERDR_TERMINAL_ID;
    process.env.HERDR_PANE_ID = "w1:p1";
    process.env.HERDR_TERMINAL_ID = "term-1";
    const calls: string[][] = [];
    const run: RunCommand = async (argv) => {
      calls.push([...argv]);
      if (argv[1] === "agent" && argv[2] === "get") {
        return fail("not found");
      }
      if (argv[1] === "agent" && argv[2] === "list") {
        return ok(
          JSON.stringify({
            result: {
              agents: [
                {
                  pane_id: "w2:p9",
                  terminal_id: "term-1",
                  cwd: "/tmp/repo",
                  agent: "codex",
                  agent_session: { kind: "id", value: "s-1" },
                },
              ],
            },
          }),
        );
      }
      return ok();
    };
    try {
      await expect(
        reportProgress({ pane: "w1:other", activity: "Working" }, run, async () => ({}), async () => async () => {}),
      ).rejects.toThrow("own pane");

      const reported = await reportProgress(
        { pane: "w1:p1", activity: "Working" },
        run,
        async () => ({}),
        async () => async () => {},
        1_000_000,
      );
      expect(reported.pane).toBe("w2:p9");
      expect(calls.at(-1)).toContain("w2:p9");

      const spoofedRun: RunCommand = async (argv) => {
        if (argv[1] === "agent" && argv[2] === "get") {
          return ok(
            JSON.stringify({
              result: {
                agent: {
                  pane_id: "w1:p1",
                  terminal_id: "term-other",
                  cwd: "/tmp/repo",
                  agent: "codex",
                },
              },
            }),
          );
        }
        return ok();
      };
      await expect(
        reportProgress({ pane: "w1:p1", activity: "Working" }, spoofedRun, async () => ({}), async () => async () => {}),
      ).rejects.toThrow("verified agent and terminal identity");
    } finally {
      if (savedPane === undefined) delete process.env.HERDR_PANE_ID;
      else process.env.HERDR_PANE_ID = savedPane;
      if (savedTerm === undefined) delete process.env.HERDR_TERMINAL_ID;
      else process.env.HERDR_TERMINAL_ID = savedTerm;
    }
  });
});
