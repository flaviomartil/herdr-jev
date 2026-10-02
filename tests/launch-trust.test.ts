import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrClient } from "../src/herdr/client.js";
import { isClientPromptReady, launchStageInHerdr } from "../src/herdr/launcher.js";
import { confirmWorkspaceTrust } from "../src/herdr/trust.js";
import type { HerdrCommandResult, StageSpec } from "../src/types/index.js";
import { createFakeHarness, type FakeHarness, type FakeHarnessMode } from "./fake-harness.js";
import { assertNoRealHomeStateLeaks, createTestStateDir } from "./helpers.js";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
const DIALOG_NO = fixture("claude-trust-dialog-27cols.txt");
const DIALOG_YES = DIALOG_NO.replace("❯ No, exit\n  Yes, I trust this", "  No, exit\n❯ Yes, I trust this");
const READY = fixture("claude-ready-placeholder-30cols.txt");
const ok = (stdout = ""): HerdrCommandResult => ({ ok: true, code: 0, stdout, stderr: "" });
const stage: StageSpec = { role: "implementer", model: "sonnet-5", effort: "high", extraFlags: [], description: "synthetic" };

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
  workdir = realpathSync(mkdtempSync(join(tmpdir(), "launch-trust-")));
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

interface Scripted {
  client: HerdrClient;
  keys: string[];
  reads: string[];
  prompts: string[];
}

function scripted(options: { frames: (state: { reads: number; keys: string[]; enters: number; sinceEnter: number }) => string; promptOk?: boolean }): Scripted {
  const pane: Scripted = { keys: [], reads: [], prompts: [], client: undefined as unknown as HerdrClient };
  let enters = 0;
  let sinceEnter = -1;
  pane.client = {
    splitCurrent: async () => ok(JSON.stringify({ result: { pane: { pane_id: "pane-42" } } })),
    startAgent: async () => ok(),
    reportSpawn: async () => ok(),
    prompt: async (input) => { pane.prompts.push(input.text); return ok(); },
    waitFor: async () => ok("done"),
    readAgent: async () => {
      if (sinceEnter >= 0) sinceEnter++;
      const frame = options.frames({ reads: pane.reads.length, keys: pane.keys, enters, sinceEnter });
      pane.reads.push(frame);
      return ok(frame);
    },
    getAgent: async () => ok(JSON.stringify({ result: { agent: { agent_status: "idle" } } })),
    sendKeys: async (_target, keys) => {
      pane.keys.push(keys[0]!);
      if (keys[0] === "enter") { enters++; sinceEnter = 0; }
      return ok();
    },
    closePane: async () => ok(),
    notify: async () => ok(),
  };
  return pane;
}

const downs = (keys: string[]) => keys.filter((key) => key === "down").length;

describe("trust confirmation needs a settled dialog", () => {
  it("sends one arrow and waits for the render before deciding again", async () => {
    install();
    let lagReads = 0;
    const pane = scripted({ frames: ({ keys, enters, sinceEnter }) => {
      if (enters > 0) return sinceEnter >= 2 ? READY : "Starting...\n";
      if (downs(keys) === 0) return DIALOG_NO;
      lagReads++;
      return lagReads <= 3 ? DIALOG_NO : DIALOG_YES;
    } });
    const outcome = await confirmWorkspaceTrust({ herdr: pane.client, target: "peer", cwd: workdir, clock: clock(), ready: (text) => isClientPromptReady("claude", text) });
    expect(outcome).toEqual({ confirmed: true, reason: "under_trust_root" });
    expect(pane.keys).toEqual(["down", "enter"]);
  });

  it("does not move twice when the arrow never shows on the pane and never presses enter", async () => {
    install();
    const pane = scripted({ frames: () => DIALOG_NO });
    const outcome = await confirmWorkspaceTrust({ herdr: pane.client, target: "peer", cwd: workdir, clock: clock() });
    expect(outcome).toEqual({ confirmed: false, reason: "trust_cursor_unverified" });
    expect(pane.keys).toEqual(["down"]);
  });

  it("presses enter only after two identical consecutive reads", async () => {
    install();
    const frames = [`header one\n${DIALOG_YES}`, `header two\n${DIALOG_YES}`, `header three\n${DIALOG_YES}`, DIALOG_YES, DIALOG_YES];
    let enterAt = -1;
    const pane = scripted({ frames: ({ reads, enters, sinceEnter }) => {
      if (enters > 0) { if (enterAt < 0) enterAt = reads; return sinceEnter >= 1 ? READY : "Starting...\n"; }
      return frames[Math.min(reads, frames.length - 1)]!;
    } });
    const outcome = await confirmWorkspaceTrust({ herdr: pane.client, target: "peer", cwd: workdir, clock: clock(), ready: (text) => isClientPromptReady("claude", text) });
    expect(outcome.confirmed).toBe(true);
    expect(pane.keys).toEqual(["enter"]);
    expect(enterAt).toBeGreaterThanOrEqual(5);
    expect(pane.reads[enterAt - 1]).toBe(pane.reads[enterAt - 2]!);
  });

  it("never confirms while the frame keeps changing", async () => {
    install();
    const pane = scripted({ frames: ({ reads }) => `tick ${reads}\n${DIALOG_YES}` });
    const outcome = await confirmWorkspaceTrust({ herdr: pane.client, target: "peer", cwd: workdir, clock: clock() });
    expect(outcome).toEqual({ confirmed: false, reason: "trust_cursor_unverified" });
    expect(pane.keys).toEqual([]);
  });
});

function launch(pane: Scripted) {
  counter++;
  return launchStageInHerdr({ client: "claude", stage, handoffPrompt: "private task text", sourcePaneId: "parent-1",
    agentName: `trust-peer-${process.pid}-${counter}`, herdr: pane.client, cwd: workdir, clock: clock() });
}

describe("trustConfirmed means the agent is ready", () => {
  it("does not report a confirmation for a worker that quit after enter", async () => {
    install();
    const pane = scripted({ frames: ({ enters }) => enters > 0 ? "Exiting...\n" : DIALOG_YES });
    const result = await launch(pane);
    expect(pane.keys).toEqual(["enter"]);
    expect(result.ok).toBe(false);
    expect(result.trustConfirmed).toBeUndefined();
    expect(result.trustRequired).toBe(true);
    expect(result.trustPolicyReason).toBe("agent_not_ready_after_trust");
    expect(pane.prompts).toEqual([]);
  });

  it("reports the confirmation once the prompt of the agent is on screen", async () => {
    install();
    const pane = scripted({ frames: ({ enters, sinceEnter }) => enters > 0 ? (sinceEnter >= 2 ? READY : "Starting...\n") : DIALOG_YES });
    const original = pane.client.prompt;
    pane.client.prompt = async (input) => { await original(input); return ok(); };
    pane.client.readAgent = ((read) => async (target: string) => {
      const screen = await read(target);
      return pane.prompts.length ? ok(pane.prompts[0]!) : screen;
    })(pane.client.readAgent!);
    const result = await launch(pane);
    expect(result.ok).toBe(true);
    expect(result.trustConfirmed).toBe(true);
    expect(result.trustPolicyReason).toBe("under_trust_root");
  });
});

describe("a blocked trust dialog reports why", () => {
  it("keeps the policy reason when the path is not trusted", async () => {
    install("contract", join(tmpdir(), "elsewhere"));
    const result = await launch(scripted({ frames: () => DIALOG_NO }));
    expect(result.trustRequired).toBe(true);
    expect(result.trustPolicyReason).toBe("not_under_trust_root");
  });

  it("reports an unavailable policy", async () => {
    install("unknown");
    const result = await launch(scripted({ frames: () => DIALOG_NO }));
    expect(result.trustPolicyReason).toBe("policy_unavailable");
  });

  it("reports a disabled toggle and an unverified cursor", async () => {
    install();
    process.env.HERDR_JEV_AUTO_TRUST = "off";
    expect((await launch(scripted({ frames: () => DIALOG_NO }))).trustPolicyReason).toBe("auto_trust_disabled");
    delete process.env.HERDR_JEV_AUTO_TRUST;
    expect((await launch(scripted({ frames: () => DIALOG_NO }))).trustPolicyReason).toBe("trust_cursor_unverified");
  });

  it("does not trust anything for an unrecognised toggle value", async () => {
    install();
    process.env.HERDR_JEV_AUTO_TRUST = "disabled";
    const pane = scripted({ frames: () => DIALOG_NO });
    const result = await launch(pane);
    expect(pane.keys).toEqual([]);
    expect(result.trustPolicyReason).toBe("auto_trust_disabled");
  });

  it("leaves the reason out of selection menus", async () => {
    install();
    const pane = scripted({ frames: () => "Pick the session model\n\n❯ 1. Opus\n  2. Sonnet\n\nEnter to confirm · Esc to cancel\n" });
    const result = await launch(pane);
    expect(result.selectionRequired).toBe(true);
    expect(result.trustPolicyReason).toBeUndefined();
  });
});

describe("a stalled prompt is not typed twice", () => {
  const PROMPT = "implement the billing export for the quarterly report";
  const WRAPPED = ["│ implement th│", "│ e billing ex│", "│ port for the│", "│ quarterly re│", "│ port        │"].join("\n");

  function stalledPane(screenAfterStall: string) {
    const prompts: string[] = [];
    let stalls = 0;
    const client: HerdrClient = {
      splitCurrent: async () => ok(JSON.stringify({ result: { pane: { pane_id: "pane-42" } } })),
      startAgent: async () => ok(),
      reportSpawn: async () => ok(),
      prompt: async (input) => {
        prompts.push(input.text);
        if (stalls++ === 0) return { ok: false, code: 1, stdout: "", stderr: "agent_prompt_stalled" };
        return ok();
      },
      waitFor: async () => ok("done"),
      readAgent: async () => ok(prompts.length === 0 ? "❯ " : screenAfterStall),
      getAgent: async () => ok(JSON.stringify({ result: { agent: { agent_status: "idle" } } })),
      closePane: async () => ok(),
      notify: async () => ok(),
    };
    return { client, prompts };
  }

  it("sees the prompt through the wrap of a narrow pane and sends it once", async () => {
    const { client, prompts } = stalledPane(WRAPPED);
    const result = await launchStageInHerdr({ client: "claude", stage, handoffPrompt: PROMPT, herdr: client, clock: clock(), cwd: workdir });
    expect(prompts).toEqual([PROMPT]);
    expect(result.ok).toBe(false);
    expect(result.promptPending).toBe(true);
    expect(result.hint).toContain("typed but unsent");
  });

  it("still retries once when the pane shows no trace of the prompt", async () => {
    const { client, prompts } = stalledPane("❯ ");
    const delivered = { value: false };
    const original = client.readAgent!;
    client.readAgent = async (target) => prompts.length >= 2 ? (delivered.value = true, ok(WRAPPED)) : original(target);
    const result = await launchStageInHerdr({ client: "claude", stage, handoffPrompt: PROMPT, herdr: client, clock: clock(), cwd: workdir });
    expect(prompts).toEqual([PROMPT, PROMPT]);
    expect(result.ok).toBe(true);
    expect(delivered.value).toBe(true);
  });
});
