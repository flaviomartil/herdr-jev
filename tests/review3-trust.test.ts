import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrClient } from "../src/herdr/client.js";
import { isClientPromptReady, launchStageInHerdr } from "../src/herdr/launcher.js";
import { confirmWorkspaceTrust, dialogMatchesPath, dialogPaths } from "../src/herdr/trust.js";
import type { HerdrCommandResult, StageSpec } from "../src/types/index.js";
import { createFakeHarness, type FakeHarness } from "./fake-harness.js";
import { assertNoRealHomeStateLeaks, createTestStateDir } from "./helpers.js";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
const DIALOG_NO = fixture("claude-trust-dialog-27cols.txt");
const DIALOG_YES = DIALOG_NO.replace("❯ No, exit\n  Yes, I trust this", "  No, exit\n❯ Yes, I trust this");
const READY = fixture("claude-ready-placeholder-30cols.txt");
const ok = (stdout = ""): HerdrCommandResult => ({ ok: true, code: 0, stdout, stderr: "" });
const stage: StageSpec = { role: "implementer", model: "sonnet-5", effort: "high", extraFlags: [], description: "synthetic" };

const withPath = (path: string, dialog = DIALOG_YES) => `Accessing workspace:\n\n${path}\n\nDo you trust the files in this folder?\n\n${dialog}`;

function clock() {
  let now = 0;
  return { now: () => now, sleep: async (ms: number) => { now += ms; } };
}

let testEnv: { stateDir: string; cleanup: () => void };
let harness: FakeHarness | undefined;
let workdir: string;
let counter = 0;
const saved = { herdrEnv: process.env.HERDR_ENV, autoTrust: process.env.HERDR_JEV_AUTO_TRUST };

beforeEach(() => {
  testEnv = createTestStateDir();
  workdir = realpathSync(mkdtempSync(join(tmpdir(), "r3-trust-")));
  process.env.HERDR_ENV = "1";
  delete process.env.HERDR_JEV_AUTO_TRUST;
  harness = createFakeHarness("contract", { FAKE_TRUST_ROOTS: workdir });
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
  prompts: string[];
}

type Frames = (state: { keys: string[]; enters: number; sinceEnter: number }) => string | null;

function scripted(frames: Frames): Scripted {
  const pane: Scripted = { keys: [], prompts: [], client: undefined as unknown as HerdrClient };
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
      const frame = frames({ keys: pane.keys, enters, sinceEnter });
      if (frame === null) return { ok: false, code: 1, stdout: "", stderr: "unreadable" };
      if (pane.prompts.length) return ok(pane.prompts[0]!);
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

function launch(pane: Scripted, extra: { cwd?: string; stage?: StageSpec } = {}) {
  counter++;
  return launchStageInHerdr({ client: "claude", stage: extra.stage ?? stage, handoffPrompt: "private task text", sourcePaneId: "parent-1",
    agentName: `r3-peer-${process.pid}-${counter}`, herdr: pane.client, cwd: extra.cwd ?? workdir, clock: clock() });
}

const confirm = (pane: Scripted, cwd = workdir, flags?: readonly string[]) =>
  confirmWorkspaceTrust({ herdr: pane.client, target: "peer", cwd, flags, clock: clock(), ready: (text) => isClientPromptReady("claude", text) });

describe("trust acceptance is reported once enter was sent and the dialog is gone", () => {
  it("reports the acceptance with the policy reason while the agent is still starting", async () => {
    const pane = scripted(({ enters }) => enters > 0 ? "Starting...\n" : withPath(workdir));
    expect(await confirm(pane)).toEqual({ confirmed: true, reason: "under_trust_root", ready: false });
    expect(pane.keys).toEqual(["enter"]);
  });

  it("ends the launch ok with trustConfirmed when the prompt shows up after the confirmation window", async () => {
    const pane = scripted(({ enters, sinceEnter }) => enters > 0 ? (sinceEnter >= 30 ? READY : "Starting...\n") : withPath(workdir));
    const result = await launch(pane);
    expect(pane.keys).toEqual(["enter"]);
    expect(result.ok).toBe(true);
    expect(result.trustConfirmed).toBe(true);
    expect(result.trustPolicyReason).toBe("under_trust_root");
    expect(result.trustRequired).toBeUndefined();
  });

  it("never reports trustRequired when every read after enter fails", async () => {
    const pane = scripted(({ enters }) => enters > 0 ? null : withPath(workdir));
    const outcome = await confirm(pane);
    expect(outcome).toEqual({ confirmed: false, reason: "trust_dialog_persisted", entered: true });
    const result = await launch(scripted(({ enters }) => enters > 0 ? null : withPath(workdir)));
    expect(result.ok).toBe(false);
    expect(result.trustRequired).toBeUndefined();
    expect(result.trustConfirmed).toBeUndefined();
    expect(result.trustPolicyReason).toBe("trust_dialog_persisted");
    expect(result.paneCreated).toBe(true);
    expect(result.error).toContain("already sent");
  });

  it("never reports trustRequired when the same dialog stays on screen after enter", async () => {
    const pane = scripted(() => withPath(workdir));
    const result = await launch(pane);
    expect(pane.keys).toEqual(["enter"]);
    expect(result.trustRequired).toBeUndefined();
    expect(result.trustPolicyReason).toBe("trust_dialog_persisted");
    expect(pane.prompts).toEqual([]);
  });

  it("does not press enter a second time when the dialog comes back after the acceptance", async () => {
    const pane = scripted(({ enters, sinceEnter }) => enters > 0 && sinceEnter < 22 ? "Starting...\n" : withPath(workdir));
    const result = await launch(pane);
    expect(pane.keys).toEqual(["enter"]);
    expect(result.ok).toBe(false);
    expect(result.trustRequired).toBeUndefined();
    expect(result.trustConfirmed).toBe(true);
    expect(pane.prompts).toEqual([]);
  });
});

describe("the policy path is the directory the dialog is about", () => {
  const trusted = () => ({ trusted: true, reason: "under_trust_root" });

  it("fails closed when the cwd cannot be resolved and never asks the policy", async () => {
    const asked: string[] = [];
    for (const cwd of [join(workdir, "missing"), "", "   "]) {
      const pane = scripted(() => withPath(workdir));
      const outcome = await confirmWorkspaceTrust({ herdr: pane.client, target: "peer", cwd, clock: clock(), lookup: (path) => { asked.push(path); return trusted(); } });
      expect(outcome).toEqual({ confirmed: false, reason: "cwd_unresolved" });
      expect(pane.keys).toEqual([]);
    }
    expect(asked).toEqual([]);
  });

  it("reports an unresolved cwd as the blocked reason through the launch", async () => {
    const pane = scripted(() => withPath(workdir));
    const result = await launch(pane, { cwd: join(workdir, "missing") });
    expect(result.trustRequired).toBe(true);
    expect(result.trustPolicyReason).toBe("cwd_unresolved");
    expect(pane.keys).toEqual([]);
  });

  it("refuses attached and alternative directory flags", async () => {
    const flags = [["-C/elsewhere"], ["-C", "/elsewhere"], ["-w/elsewhere"], ["-w"], ["--work-dir=/elsewhere"], ["--work-dir", "/elsewhere"], ["--workdir"],
      ["--cd=/elsewhere"], ["--add-dir=/elsewhere"], ["--chdir", "/elsewhere"], ["--directory=/elsewhere"], ["--workspace", "/elsewhere"], ["--dir=/elsewhere"], ["--cwd", "/elsewhere"]];
    for (const list of flags) {
      const pane = scripted(() => withPath(workdir));
      expect(await confirm(pane, workdir, list)).toEqual({ confirmed: false, reason: "directory_flags_present" });
      expect(pane.keys).toEqual([]);
    }
  });

  it("keeps trusting launches with ordinary flags", async () => {
    const pane = scripted(({ enters, sinceEnter }) => enters > 0 ? (sinceEnter >= 2 ? READY : "Starting...\n") : withPath(workdir));
    const outcome = await confirm(pane, workdir, ["--model", "claude-sonnet-5-5", "--effort", "high", "-c", "model_reasoning_effort=high", "--dangerously-skip-permissions"]);
    expect(outcome.confirmed).toBe(true);
  });

  it("refuses a launch whose extra flags carry a directory option", async () => {
    const pane = scripted(() => withPath(workdir));
    const result = await launch(pane, { stage: { ...stage, extraFlags: ["--work-dir=/elsewhere"] } });
    expect(result.trustRequired).toBe(true);
    expect(result.trustPolicyReason).toBe("directory_flags_present");
    expect(pane.keys).toEqual([]);
  });

  it("refuses to confirm when the dialog is about another directory", async () => {
    const pane = scripted(() => withPath("/somewhere/else/entirely"));
    expect(await confirm(pane)).toEqual({ confirmed: false, reason: "trust_path_mismatch" });
    expect(pane.keys).toEqual([]);
    const result = await launch(scripted(() => withPath("/somewhere/else/entirely")));
    expect(result.trustRequired).toBe(true);
    expect(result.trustPolicyReason).toBe("trust_path_mismatch");
  });

  it("confirms when the dialog shows the checked directory, also through a symlink", async () => {
    const link = join(workdir, "..", `r3-link-${process.pid}-${counter}`);
    symlinkSync(workdir, link);
    try {
      for (const shown of [workdir, link, `${workdir}/`]) {
        const pane = scripted(({ enters, sinceEnter }) => enters > 0 ? (sinceEnter >= 2 ? READY : "Starting...\n") : withPath(shown));
        expect((await confirm(pane, workdir)).confirmed).toBe(true);
        expect(pane.keys).toEqual(["enter"]);
      }
    } finally {
      rmSync(link, { force: true });
    }
  });

  it("still confirms a dialog whose top scrolled away, because no directory is shown to compare", async () => {
    const pane = scripted(({ enters, sinceEnter }) => enters > 0 ? (sinceEnter >= 2 ? READY : "Starting...\n") : DIALOG_YES);
    expect((await confirm(pane)).confirmed).toBe(true);
  });
});

describe("directories shown in a trust dialog", () => {
  it("extracts an own-line path, an inline path and a path wrapped over a narrow pane", () => {
    expect(dialogPaths("Accessing workspace:\n\n/tmp/project-one\n\nDo you trust?")).toEqual(["/tmp/project-one"]);
    expect(dialogPaths("You are in /home/dev/work/project\n\n> 1. Yes, continue")).toEqual(["/home/dev/work/project"]);
    expect(dialogPaths("Accessing workspace:\n\n/tmp/aaaa-bbbb-cccc-dd\ndd-eeee\n\nDo you trust?")).toEqual(["/tmp/aaaa-bbbb-cccc-dddd-eeee"]);
    expect(dialogPaths("Use /help or press esc/enter\n\n❯ No, exit")).toEqual([]);
  });

  it("compares home, trailing slash and truncated forms", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "r3-home-")));
    const previous = process.env.HOME;
    process.env.HOME = home;
    mkdirSync(join(home, "proj"), { recursive: true });
    try {
      expect(dialogMatchesPath("~/proj\n", join(realpathSync(home), "proj"))).toBe(true);
      expect(dialogMatchesPath("~/other\n", join(realpathSync(home), "proj"))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
    expect(dialogMatchesPath("…/work/project\n", "/home/dev/work/project")).toBe(true);
    expect(dialogMatchesPath("…/work/other\n", "/home/dev/work/project")).toBe(false);
    expect(dialogMatchesPath("/home/dev/wo…\n", "/home/dev/work/project")).toBe(true);
    expect(dialogMatchesPath("/home/dev/xx…\n", "/home/dev/work/project")).toBe(false);
    expect(dialogMatchesPath("/home/dev/work/project/\n", "/home/dev/work/project")).toBe(true);
    expect(dialogMatchesPath("no path here\n", "/home/dev/work/project")).toBe(true);
  });
});
