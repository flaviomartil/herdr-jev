import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrClient } from "../src/herdr/client.js";
import { launchStageInHerdr } from "../src/herdr/launcher.js";
import { autoTrustEnabled, confirmWorkspaceTrust, parseTrustMenu } from "../src/herdr/trust.js";
import type { HerdrCommandResult, StageSpec } from "../src/types/index.js";
import { createFakeHarness, type FakeHarness, type FakeHarnessMode } from "./fake-harness.js";
import { assertNoRealHomeStateLeaks, createTestStateDir } from "./helpers.js";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
const CLAUDE_DIALOG_NO = fixture("claude-trust-dialog-27cols.txt");
const CLAUDE_DIALOG_YES = CLAUDE_DIALOG_NO.replace("❯ No, exit\n  Yes, I trust this", "  No, exit\n❯ Yes, I trust this");
const CLAUDE_READY = fixture("claude-ready-placeholder-30cols.txt");
const AGY_FIXTURE = fixture("agy-trust-dialog-27cols.txt");
const agyDialog = (path: string) => AGY_FIXTURE.replace("/tmp/jev-live-Mnv4-wt-t3", path);
const AGY_READY = "Antigravity CLI\n\n> \n";
const NUMBERED_MENU = "Pick the session model\n\n❯ 1. Opus\n  2. Sonnet\n\nEnter to confirm · Esc to cancel\n";
const COMMAND_APPROVAL = "Would you like to run the following command?\n\n  $ rm -rf build\n\n› 1. Yes, proceed (y)\n  2. No, and tell Codex what to do differently (esc)\n\nPress enter to confirm or esc to cancel\n";

function ok(stdout = ""): HerdrCommandResult {
  return { ok: true, code: 0, stdout, stderr: "" };
}

const claudeStage: StageSpec = { role: "implementer", model: "sonnet-5", effort: "high", extraFlags: [], description: "synthetic" };

interface Pane {
  client: HerdrClient;
  keys: string[][];
  prompts: string[];
  screenAtPrompt: string[];
}

function claudePane(options: { dialog: string; ready: string; dialogKind?: "claude" | "agy" | "static"; reactToKeys?: boolean }): Pane {
  let screen = options.dialog;
  let afterEnterReads = -1;
  const pane: Pane = { keys: [], prompts: [], screenAtPrompt: [], client: undefined as unknown as HerdrClient };
  let lastPrompt = "";
  pane.client = {
    splitCurrent: async () => ok(JSON.stringify({ result: { pane: { pane_id: "pane-42" } } })),
    startAgent: async () => ok(),
    reportSpawn: async () => ok(),
    prompt: async (input) => {
      pane.prompts.push(input.text);
      pane.screenAtPrompt.push(screen);
      lastPrompt = input.text;
      return ok();
    },
    waitFor: async () => ok("done"),
    readAgent: async () => {
      if (lastPrompt) return ok(lastPrompt);
      if (afterEnterReads >= 0) {
        afterEnterReads++;
        screen = afterEnterReads >= 3 ? options.ready : "Starting...\n";
      }
      return ok(screen);
    },
    getAgent: async () => ok(JSON.stringify({ result: { agent: { agent_status: "idle" } } })),
    sendKeys: async (_target, keys) => {
      pane.keys.push([...keys]);
      if (options.reactToKeys === false) return ok();
      const key = keys[0];
      if (options.dialogKind === "claude") {
        if (key === "down" && screen === CLAUDE_DIALOG_NO) screen = CLAUDE_DIALOG_YES;
        else if (key === "up" && screen === CLAUDE_DIALOG_YES) screen = CLAUDE_DIALOG_NO;
        else if (key === "enter" && screen === CLAUDE_DIALOG_YES) afterEnterReads = 0;
        else if (key === "enter") screen = "Exiting...\n";
      } else if (key === "enter") {
        afterEnterReads = 0;
      }
      return ok();
    },
    closePane: async () => ok(),
    notify: async () => ok(),
  };
  return pane;
}

function clock() {
  let now = 0;
  return { now: () => now, sleep: async (ms: number) => { now += ms; } };
}

let testEnv: { stateDir: string; cleanup: () => void };
let harness: FakeHarness | undefined;
let workdir: string;
const saved = { herdrEnv: process.env.HERDR_ENV, autoTrust: process.env.HERDR_JEV_AUTO_TRUST };
let counter = 0;

function install(mode: FakeHarnessMode = "contract", trustRoots = workdir) {
  harness = createFakeHarness(mode, { FAKE_TRUST_ROOTS: trustRoots });
}

beforeEach(() => {
  testEnv = createTestStateDir();
  workdir = realpathSync(mkdtempSync(join(tmpdir(), "trust-work-")));
  process.env.HERDR_ENV = "1";
  delete process.env.HERDR_JEV_AUTO_TRUST;
});

afterEach(() => {
  harness?.restore();
  harness = undefined;
  rmSync(workdir, { recursive: true, force: true });
  if (saved.herdrEnv === undefined) delete process.env.HERDR_ENV;
  else process.env.HERDR_ENV = saved.herdrEnv;
  if (saved.autoTrust === undefined) delete process.env.HERDR_JEV_AUTO_TRUST;
  else process.env.HERDR_JEV_AUTO_TRUST = saved.autoTrust;
  testEnv.cleanup();
  assertNoRealHomeStateLeaks();
});

function launch(pane: Pane, client: "claude" | "antigravity" = "claude") {
  counter++;
  return launchStageInHerdr({ client, stage: claudeStage, handoffPrompt: "private task text", sourcePaneId: "parent-1",
    agentName: `trust-peer-${process.pid}-${counter}`, herdr: pane.client, cwd: workdir, clock: clock() });
}

describe("trust menu parsing", () => {
  it("finds the cursor and the trust option in the wrapped claude dialog", () => {
    const menu = parseTrustMenu(CLAUDE_DIALOG_NO)!;
    expect(menu.options.map((option) => option.text)).toEqual(["No, exit", "Yes, I trust this"]);
    expect([menu.cursorIndex, menu.trustIndex]).toEqual([0, 1]);
    const moved = parseTrustMenu(CLAUDE_DIALOG_YES)!;
    expect([moved.cursorIndex, moved.trustIndex]).toEqual([1, 1]);
  });

  it("finds the cursor already on the trust option in the wrapped agy dialog and ignores the footer", () => {
    const menu = parseTrustMenu(AGY_FIXTURE)!;
    expect(menu.options.map((option) => option.text)).toEqual(["Yes, I trust this", "No, exit"]);
    expect([menu.cursorIndex, menu.trustIndex]).toEqual([0, 0]);
  });

  it("reports no trust option for menus that are not a trust dialog", () => {
    expect(parseTrustMenu(NUMBERED_MENU)!.trustIndex).toBe(-1);
    expect(parseTrustMenu(COMMAND_APPROVAL)!.trustIndex).toBe(-1);
    expect(parseTrustMenu("plain text without a cursor")).toBeNull();
  });

  it("reads HERDR_JEV_AUTO_TRUST", () => {
    expect(autoTrustEnabled({})).toBe(true);
    expect(autoTrustEnabled({ HERDR_JEV_AUTO_TRUST: "0" })).toBe(false);
    expect(autoTrustEnabled({ HERDR_JEV_AUTO_TRUST: "off" })).toBe(false);
    expect(autoTrustEnabled({ HERDR_JEV_AUTO_TRUST: "1" })).toBe(true);
  });
});

describe("trust confirmation with the real dialog fixtures", () => {
  it("moves the selection to the trust option, verifies it on the pane and only then presses enter", async () => {
    install();
    const pane = claudePane({ dialog: CLAUDE_DIALOG_NO, ready: CLAUDE_READY, dialogKind: "claude" });
    const result = await launch(pane);
    expect(pane.keys).toEqual([["down"], ["enter"]]);
    expect(result.ok).toBe(true);
    expect(result.trustConfirmed).toBe(true);
    expect(result.trustPolicyReason).toBe("under_trust_root");
    expect(result.trustRequired).toBeUndefined();
    expect(result.promptDelivered).toBe(true);
    expect(pane.prompts).toEqual(["private task text"]);
    expect(pane.screenAtPrompt[0]).toBe(CLAUDE_READY);
    expect(harness!.callsFor("policy-check")[0]!.slice(0, 5)).toEqual(["policy-check", "--kind", "trust", "--path", workdir]);
  });

  it("presses enter directly when the cursor already sits on the trust option (agy dialog)", async () => {
    install();
    const pane = claudePane({ dialog: agyDialog(workdir), ready: AGY_READY, dialogKind: "agy" });
    const result = await launch(pane, "antigravity");
    expect(pane.keys).toEqual([["enter"]]);
    expect(result.trustConfirmed).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("starts from the cursor on the trust option and never moves it", async () => {
    install();
    const pane = claudePane({ dialog: CLAUDE_DIALOG_YES, ready: CLAUDE_READY, dialogKind: "claude" });
    const outcome = await confirmWorkspaceTrust({ herdr: pane.client, target: "peer", cwd: workdir, clock: clock() });
    expect(outcome).toEqual({ confirmed: true, reason: "under_trust_root" });
    expect(pane.keys).toEqual([["enter"]]);
  });

  it("never presses enter when the cursor cannot be verified on the trust option", async () => {
    install();
    const pane = claudePane({ dialog: CLAUDE_DIALOG_NO, ready: CLAUDE_READY, dialogKind: "claude", reactToKeys: false });
    const result = await launch(pane);
    expect(pane.keys.flat()).not.toContain("enter");
    expect(pane.keys.length).toBeLessThanOrEqual(6);
    expect(result.ok).toBe(false);
    expect(result.trustRequired).toBe(true);
    expect(result.trustConfirmed).toBeUndefined();
    expect(pane.prompts).toEqual([]);
  });

  it("answers nothing when the harness says the path is not trusted", async () => {
    install("contract", join(tmpdir(), "some-other-root"));
    const pane = claudePane({ dialog: CLAUDE_DIALOG_NO, ready: CLAUDE_READY, dialogKind: "claude" });
    const result = await launch(pane);
    expect(pane.keys).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.trustRequired).toBe(true);
    expect(result.completionState).toBe("blocked");
    expect(result.trustConfirmed).toBeUndefined();
    expect(harness!.callsFor("policy-check")).toHaveLength(1);
  });

  for (const mode of ["unknown", "legacy"] as const) {
    it(`answers nothing when the harness does not know policy-check (${mode})`, async () => {
      install(mode);
      const pane = claudePane({ dialog: CLAUDE_DIALOG_NO, ready: CLAUDE_READY, dialogKind: "claude" });
      const result = await launch(pane);
      expect(pane.keys).toEqual([]);
      expect(result.trustRequired).toBe(true);
      expect(result.ok).toBe(false);
    });
  }

  it("answers nothing when no harness is installed", async () => {
    const pane = claudePane({ dialog: CLAUDE_DIALOG_NO, ready: CLAUDE_READY, dialogKind: "claude" });
    const result = await launch(pane);
    expect(pane.keys).toEqual([]);
    expect(result.trustRequired).toBe(true);
  });

  it("answers nothing and does not even ask the harness when HERDR_JEV_AUTO_TRUST=0", async () => {
    install();
    process.env.HERDR_JEV_AUTO_TRUST = "0";
    const pane = claudePane({ dialog: CLAUDE_DIALOG_NO, ready: CLAUDE_READY, dialogKind: "claude" });
    const result = await launch(pane);
    expect(pane.keys).toEqual([]);
    expect(result.trustRequired).toBe(true);
    expect(harness!.callsFor("policy-check")).toHaveLength(0);
  });

  it("never answers a selection menu that is not a trust dialog", async () => {
    install();
    const pane = claudePane({ dialog: NUMBERED_MENU, ready: CLAUDE_READY, dialogKind: "static" });
    const result = await launch(pane);
    expect(pane.keys).toEqual([]);
    expect(result.selectionRequired).toBe(true);
    expect(result.trustRequired).toBeUndefined();
    expect(harness!.callsFor("policy-check")).toHaveLength(0);
  });

  it("never answers a command approval prompt even when the path is trusted", async () => {
    install();
    const pane = claudePane({ dialog: COMMAND_APPROVAL, ready: CLAUDE_READY, dialogKind: "static" });
    const result = await launch(pane);
    expect(pane.keys).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.trustConfirmed).toBeUndefined();
    expect(pane.prompts).toEqual([]);
  });

  it("reports a persisting dialog instead of claiming the confirmation", async () => {
    install();
    const pane = claudePane({ dialog: agyDialog(workdir), ready: AGY_READY, dialogKind: "agy" });
    const stuck = { ...pane.client, sendKeys: async (_t: string, keys: readonly string[]) => { pane.keys.push([...keys]); return ok(); } };
    const outcome = await confirmWorkspaceTrust({ herdr: stuck, target: "peer", cwd: workdir, clock: clock() });
    expect(outcome).toEqual({ confirmed: false, reason: "trust_dialog_persisted", entered: true });
  });
});

describe("trust dialog raised while the agent starts", () => {
  const notReady = (pane: Pane) => {
    pane.client.startAgent = async () => ({ ok: false, code: 1, stdout: "", stderr: JSON.stringify({ error: { code: "agent_not_ready" } }) });
  };

  it("continues into the trust confirmation when Herdr reports agent_not_ready behind a trust dialog", async () => {
    install();
    const pane = claudePane({ dialog: CLAUDE_DIALOG_NO, ready: CLAUDE_READY, dialogKind: "claude" });
    notReady(pane);
    const result = await launch(pane);
    expect(pane.keys).toEqual([["down"], ["enter"]]);
    expect(result.ok).toBe(true);
    expect(result.trustConfirmed).toBe(true);
  });

  it("keeps the start failure when automatic trust is disabled", async () => {
    install();
    process.env.HERDR_JEV_AUTO_TRUST = "0";
    const pane = claudePane({ dialog: CLAUDE_DIALOG_NO, ready: CLAUDE_READY, dialogKind: "claude" });
    notReady(pane);
    const result = await launch(pane);
    expect(pane.keys).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Agent start failed");
  });
});

