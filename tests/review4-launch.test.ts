import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrClient } from "../src/herdr/client.js";
import { gridStatePath, launchStageInHerdr, pruneGridWorkers, readGridWorkerRecords, updateGridWorkers, withGridLock, writeGridWorkers } from "../src/herdr/launcher.js";
import { migrateLegacyState, resolveStateDir } from "../src/herdr/state-dir.js";
import { dialogMatchesPath, dialogPathVerdict } from "../src/herdr/trust.js";
import type { HerdrCommandResult, StageSpec } from "../src/types/index.js";
import { assertNoRealHomeStateLeaks, createTestStateDir } from "./helpers.js";

const stage: StageSpec = { role: "implementer", model: "sonnet-5", effort: "high", extraFlags: [], description: "synthetic" };
const ok = (stdout = ""): HerdrCommandResult => ({ ok: true, code: 0, stdout, stderr: "" });
const fail = (stderr: string, stdout = ""): HerdrCommandResult => ({ ok: false, code: 1, stdout, stderr });
const unprivileged = typeof process.getuid === "function" && process.getuid() !== 0;

let testEnv: { stateDir: string; cleanup: () => void };
let sandbox: string;
const savedHerdrEnv = process.env.HERDR_ENV;

beforeEach(() => {
  testEnv = createTestStateDir();
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "r4-launch-")));
  process.env.HERDR_ENV = "1";
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
  if (savedHerdrEnv === undefined) delete process.env.HERDR_ENV;
  else process.env.HERDR_ENV = savedHerdrEnv;
  testEnv.cleanup();
  assertNoRealHomeStateLeaks();
});

function staleDirectoryLock(path: string): string {
  const lock = `${path}.lock`;
  mkdirSync(lock, { recursive: true });
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(lock, old, old);
  return lock;
}

describe("a stale directory lock", () => {
  it("never deletes a lock another waiter took over after the stale directory was seen", () => {
    const path = join(sandbox, "grid", "caller.json");
    const lock = staleDirectoryLock(path);
    let ran = false;
    let seen = 0;
    expect(() => withGridLock(path, () => { ran = true; }, {
      waitMs: 300,
      afterStaleSeen: () => {
        if (seen++ > 0) return;
        rmSync(lock, { recursive: true, force: true });
        writeFileSync(lock, "other-holder", { flag: "wx" });
      },
    })).toThrow("grid_state_lock_timeout");
    expect(ran).toBe(false);
    expect(readFileSync(lock, "utf8")).toBe("other-holder");
  });

  it("is removed when nobody else touched it and the lock is then acquired", () => {
    const path = join(sandbox, "grid", "caller.json");
    const lock = staleDirectoryLock(path);
    expect(withGridLock(path, () => statSync(lock).isFile())).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });
});

describe("an unreadable grid file", () => {
  const caller = "caller-A";

  it.skipIf(!unprivileged)("aborts the update and keeps the existing records and run ids", () => {
    writeGridWorkers(caller, [{ paneId: "w-1", runId: "run-1" }, { paneId: "w-2", runId: "run-2" }], sandbox);
    const file = gridStatePath(caller, sandbox);
    chmodSync(file, 0o000);
    try {
      expect(() => updateGridWorkers(caller, (records) => [...records, { paneId: "w-3" }], sandbox)).toThrow("grid_state_unreadable");
    } finally {
      chmodSync(file, 0o600);
    }
    expect(readGridWorkerRecords(caller, sandbox).map((record) => [record.paneId, record.runId])).toEqual([["w-1", "run-1"], ["w-2", "run-2"]]);
  });

  it.skipIf(!unprivileged)("is reported by pruning instead of being rewritten", () => {
    writeGridWorkers(caller, [{ paneId: "w-1", runId: "run-1" }], sandbox);
    const file = gridStatePath(caller, sandbox);
    chmodSync(file, 0o000);
    const failures: Array<{ file: string; error: string }> = [];
    try {
      pruneGridWorkers(["w-1"], sandbox, { failures });
    } finally {
      chmodSync(file, 0o600);
    }
    expect(failures).toHaveLength(1);
    expect(failures[0]!.error).toContain("grid_state_unreadable");
    expect(readGridWorkerRecords(caller, sandbox).map((record) => record.runId)).toEqual(["run-1"]);
  });

  it("still treats a missing file as empty and a corrupt file as recoverable", () => {
    expect(updateGridWorkers(caller, (records) => [...records, { paneId: "w-1" }], sandbox).before).toEqual([]);
    writeFileSync(gridStatePath(caller, sandbox), "{broken");
    expect(updateGridWorkers(caller, (records) => [...records, { paneId: "w-2" }], sandbox).before).toEqual([]);
    expect(existsSync(`${gridStatePath(caller, sandbox)}.corrupt`)).toBe(true);
  });
});

describe("legacy state migration", () => {
  function tree() {
    const legacy = join(sandbox, "old");
    const configured = join(sandbox, "new");
    mkdirSync(join(legacy, "grid"), { recursive: true });
    mkdirSync(join(configured, "grid"), { recursive: true });
    return { legacy, configured };
  }

  it("reports a same-named file with different content and leaves the legacy file in place", () => {
    const { legacy, configured } = tree();
    writeFileSync(join(legacy, "grid", "pane.json"), JSON.stringify({ workers: [{ paneId: "legacy" }] }));
    writeFileSync(join(configured, "grid", "pane.json"), JSON.stringify({ workers: [{ paneId: "configured" }] }));
    expect(migrateLegacyState(legacy, configured)).toEqual(["grid/pane.json: conflict"]);
    expect(readFileSync(join(legacy, "grid", "pane.json"), "utf8")).toContain("legacy");
    expect(readFileSync(join(configured, "grid", "pane.json"), "utf8")).toContain("configured");
  });

  it("reports a top-level conflict too", () => {
    const { legacy, configured } = tree();
    writeFileSync(join(legacy, "fence"), "a");
    writeFileSync(join(configured, "fence"), "b");
    expect(migrateLegacyState(legacy, configured)).toEqual(["fence: conflict"]);
  });

  it("drops the legacy file when the configured one is the same inode", () => {
    const { legacy, configured } = tree();
    writeFileSync(join(configured, "grid", "pane.json"), "{}");
    linkSync(join(configured, "grid", "pane.json"), join(legacy, "grid", "pane.json"));
    expect(migrateLegacyState(legacy, configured)).toEqual([]);
    expect(existsSync(join(legacy, "grid", "pane.json"))).toBe(false);
    expect(readFileSync(join(configured, "grid", "pane.json"), "utf8")).toBe("{}");
  });

  it("drops the legacy file when the configured copy has identical content", () => {
    const { legacy, configured } = tree();
    writeFileSync(join(configured, "grid", "pane.json"), "{\"same\":true}");
    writeFileSync(join(legacy, "grid", "pane.json"), "{\"same\":true}");
    expect(migrateLegacyState(legacy, configured)).toEqual([]);
    expect(existsSync(join(legacy, "grid", "pane.json"))).toBe(false);
  });

  it("does not report a top-level ENOENT when another process finished the move first", () => {
    const { legacy, configured } = tree();
    writeFileSync(join(legacy, "grid", "pane.json"), "{}");
    const errors = migrateLegacyState(legacy, configured, { beforeMove: () => rmSync(legacy, { recursive: true, force: true }) });
    expect(errors).toEqual([]);
  });

  it("prints the conflict once when the configured root is resolved", () => {
    const home = join(sandbox, "home");
    const legacy = join(home, ".local", "state", "herdr-jev");
    const configured = join(sandbox, "configured");
    mkdirSync(join(legacy, "grid"), { recursive: true });
    mkdirSync(join(configured, "grid"), { recursive: true });
    writeFileSync(join(legacy, "grid", "p.json"), "{\"a\":1}");
    writeFileSync(join(configured, "grid", "p.json"), "{\"b\":2}");
    const generated = join(sandbox, "generated");
    mkdirSync(generated);
    writeFileSync(join(generated, "tool-env.json"), JSON.stringify({ tools: { "herdr-jev": { stateDir: configured } } }));
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const env = { HOME: home, AI_HARNESS_GENERATED_DIR: generated };
      expect(resolveStateDir(env)).toBe(configured);
      const warnings = spy.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("State migration"));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("grid/p.json: conflict");
      expect(warnings[0]).not.toContain("a later run moves");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("the resolved state root", () => {
  it("stays fixed for the process when tool-env.json later becomes unreadable or disappears", () => {
    const home = join(sandbox, "home");
    mkdirSync(home);
    const configured = join(sandbox, "configured-root");
    const generated = join(sandbox, "generated");
    mkdirSync(generated);
    const file = join(generated, "tool-env.json");
    writeFileSync(file, JSON.stringify({ tools: { "herdr-jev": { stateDir: configured } } }));
    const env = { HOME: home, AI_HARNESS_GENERATED_DIR: generated };
    expect(resolveStateDir(env)).toBe(configured);
    writeFileSync(file, "{half written");
    expect(resolveStateDir(env)).toBe(configured);
    rmSync(file);
    expect(resolveStateDir(env)).toBe(configured);
  });

  it("does not freeze the legacy fallback", () => {
    const home = join(sandbox, "home2");
    mkdirSync(home);
    const configured = join(sandbox, "configured-late");
    const generated = join(sandbox, "generated2");
    mkdirSync(generated);
    const env = { HOME: home, AI_HARNESS_GENERATED_DIR: generated };
    expect(resolveStateDir(env)).toBe(join(home, ".local", "state", "herdr-jev"));
    writeFileSync(join(generated, "tool-env.json"), JSON.stringify({ tools: { "herdr-jev": { stateDir: configured } } }));
    expect(resolveStateDir(env)).toBe(configured);
  });
});

describe("dialog path confirmation fails closed", () => {
  const expected = "/home/dev/work/project";

  it("requires a positively matching path", () => {
    expect(dialogMatchesPath("Do you trust the files in /home/dev/work/project\n", expected)).toBe(true);
    expect(dialogMatchesPath("/home/dev/work/project/\n", expected)).toBe(true);
    expect(dialogPathVerdict("no path here\n", expected)).toBe("unverified");
    expect(dialogMatchesPath("no path here\n", expected)).toBe(false);
    expect(dialogMatchesPath("Do you trust this folder? Use /srv\n", expected)).toBe(false);
    expect(dialogMatchesPath("", expected)).toBe(false);
  });

  it("does not confirm on a truncated path alone", () => {
    expect(dialogPathVerdict("…/work/project\n", expected)).toBe("unverified");
    expect(dialogPathVerdict("/home/dev/wo…\n", expected)).toBe("unverified");
    expect(dialogMatchesPath("…/work/project\n", expected)).toBe(false);
    expect(dialogMatchesPath("/home/dev/wo…\n", expected)).toBe(false);
  });

  it("still reports a conflicting truncated path as a mismatch", () => {
    expect(dialogPathVerdict("…/work/other\n", expected)).toBe("mismatch");
    expect(dialogPathVerdict("/home/dev/xx…\n", expected)).toBe("mismatch");
  });

  it("confirms a full path even when a truncated one is shown beside it, and refuses a different full path", () => {
    expect(dialogMatchesPath("/home/dev/work/project\n\n…/work/project\n", expected)).toBe(true);
    expect(dialogMatchesPath("/home/dev/work/project\n\n/home/dev/work/other\n", expected)).toBe(false);
  });
});

function swarm(overrides: Partial<HerdrClient> = {}, callerId = "caller-A") {
  const created: string[] = [];
  let counter = 0;
  const client: HerdrClient = {
    paneLayout: async () => {
      const panes = [{ pane_id: callerId, rect: { x: 0, y: 0, width: 100, height: 50 } },
        ...created.map((id, index) => ({ pane_id: id, rect: { x: 100, y: index * 10, width: 100, height: 10 } }))];
      return ok(JSON.stringify({ result: { layout: { area: { x: 0, y: 0, width: 200, height: 50 }, panes } } }));
    },
    splitCurrent: async () => {
      const id = `w-${++counter}`;
      created.push(id);
      return ok(JSON.stringify({ result: { pane: { pane_id: id } } }));
    },
    startAgent: async () => ok(),
    reportSpawn: async () => ok(),
    prompt: async () => ok(),
    waitFor: async () => ok("done"),
    readAgent: async () => ok("❯ "),
    getAgent: async () => ok(JSON.stringify({ result: { agent: { agent_status: "idle" } } })),
    closePane: async () => ok(),
    notify: async () => ok(),
    ...overrides,
  };
  return { client, created };
}

const launch = (client: HerdrClient, agentName: string) =>
  launchStageInHerdr({ client: "claude", stage, handoffPrompt: "", herdr: client, agentName, sourcePaneId: "caller-A", cwd: sandbox });

describe("the spawn fence", () => {
  it("is released after a rejected start whose pane was closed", async () => {
    const closed: string[] = [];
    const { client } = swarm({ startAgent: async () => fail("unsupported agent kind"), closePane: async (pane) => { closed.push(pane); return ok(); } });
    const first = await launch(client, "peer-fence-1");
    expect(first.ackStatus).toBe("rejected");
    expect(first.paneCreated).toBe(false);
    const second = await launch(client, "peer-fence-1");
    expect(second.error ?? "").not.toContain("Named spawn already attempted");
    expect(second.ackStatus).toBe("rejected");
    expect(closed).toEqual(["w-1", "w-2"]);
  });

  it("stays held when the rejected pane could not be closed", async () => {
    const { client } = swarm({ startAgent: async () => fail("unsupported agent kind"), closePane: async () => fail("pane busy") });
    const first = await launch(client, "peer-fence-2");
    expect(first.paneCreated).toBe(true);
    const second = await launch(client, "peer-fence-2");
    expect(second.error ?? "").toContain("Named spawn already attempted");
  });

  it.each([
    ["a null pane entry", JSON.stringify({ result: { layout: { panes: [null, { pane_id: "caller-A", rect: { x: 0, y: 0, width: 100, height: 50 } }] } } })],
    ["a non-array pane list", JSON.stringify({ result: { layout: { panes: "none" } } })],
    ["a non-object pane entry", JSON.stringify({ result: { layout: { panes: [7, "x"] } } })],
  ])("does not leak the fence or reject the launch for %s in the pane layout", async (_label, layoutJson) => {
    const { client } = swarm({ paneLayout: async () => ok(layoutJson) });
    const first = await launch(client, "peer-layout-1");
    expect(first.ok).toBe(true);
    expect(first.paneId).toBe("w-1");
  });
});
