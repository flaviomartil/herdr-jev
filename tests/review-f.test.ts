import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setupWorktree } from "../src/herdr/agents.js";
import { classifyPaneBlock, looksLikeSelectionMenu, resolveFakeBinDir, type HerdrClient } from "../src/herdr/client.js";
import { launchStageInHerdr } from "../src/herdr/launcher.js";
import { lastMeaningfulLine, redactSecrets } from "../src/herdr/pane-text.js";
import { converseWithPeer } from "../src/herdr/peer.js";
import type { HerdrCommandResult, StageSpec } from "../src/types/index.js";

const stage: StageSpec = { role: "implementer", model: "fake-model", effort: "high", extraFlags: [], description: "" };

function fixture(name: string): string {
  return readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
}

function res(ok: boolean, stdout = "", stderr = ""): HerdrCommandResult {
  return { ok, code: ok ? 0 : 1, stdout, stderr };
}

function advancingClock() {
  let now = 1_000_000;
  return { now: () => now, sleep: async (ms: number) => { now += ms; } };
}

const idleJson = '{"result":{"agent":{"agent_status":"idle"}}}';

function buildClient(options: { screen: (promptCalls: number) => string; agentOutput?: (promptCalls: number) => string }) {
  let promptCalls = 0;
  const client: HerdrClient = {
    splitCurrent: async () => res(true, '{"result":{"pane":{"pane_id":"pane-f"}}}'),
    startAgent: async () => res(true),
    closePane: async () => res(true),
    getAgent: async () => res(true, (options.agentOutput ?? (() => idleJson))(promptCalls)),
    readAgent: async () => res(true, options.screen(promptCalls)),
    readPane: async () => res(true, options.screen(promptCalls)),
    waitFor: async () => res(true),
    notify: async () => res(true),
    prompt: async () => {
      promptCalls++;
      return res(true);
    },
  };
  return { client, calls: () => promptCalls };
}

function peerClient(paneId: string, screen: string) {
  let prompts = 0;
  const client = {
    getAgent: async () => res(true, JSON.stringify({ result: { agent: { pane_id: paneId, agent_status: "idle" } } })),
    readAgent: async () => res(true, screen),
    prompt: async () => {
      prompts++;
      return res(true, '{"state":"working"}');
    },
  } as unknown as HerdrClient;
  return { client, prompts: () => prompts };
}

let savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  savedEnv = { HERDR_ENV: process.env.HERDR_ENV, HERDR_JEV_READY_TIMEOUT_MS: process.env.HERDR_JEV_READY_TIMEOUT_MS };
  process.env.HERDR_ENV = "1";
  process.env.HERDR_JEV_READY_TIMEOUT_MS = "6000";
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("review-f redaction and wrapped lines", () => {
  test("item 1: Basic prose stays unchanged while real Basic credentials are redacted", () => {
    expect(redactSecrets("Basic authentication")).toBe("Basic authentication");
    expect(redactSecrets("Basic Authentication required")).toBe("Basic Authentication required");
    expect(redactSecrets("Basic configuration options")).toBe("Basic configuration options");
    expect(redactSecrets("Basic usage/examples")).toBe("Basic usage/examples");
    expect(redactSecrets("Basic dXNlcjpwYXNzd29yZA==")).toBe("Basic [REDACTED]");
    expect(redactSecrets("Authorization: Basic dXNlcjpwYXNzd29yZA==")).toBe("Authorization: Basic [REDACTED]");
    expect(redactSecrets("curl -H 'Authorization: Basic YWRtaW46YWRtaW4=' host")).toBe("curl -H 'Authorization: Basic [REDACTED]' host");
    expect(redactSecrets("Proxy-Authorization: Basic abcdefghijkl")).toBe("Proxy-Authorization: Basic [REDACTED]");
  });

  test("N2: a URL with a port and a later @ stays unchanged while real URL credentials are redacted", () => {
    expect(redactSecrets("https://registry.npmjs.org:443/@scope/pkg")).toBe("https://registry.npmjs.org:443/@scope/pkg");
    expect(redactSecrets("http://localhost:4873/@scope/pkg")).toBe("http://localhost:4873/@scope/pkg");
    expect(redactSecrets("https://user:secret@host/path")).toBe("https://user:[REDACTED]@host/path");
    expect(redactSecrets("https://admin:12345@host/path")).toBe("https://admin:[REDACTED]@host/path");
    expect(redactSecrets("https://admin:12345/pass@host/path")).toBe("https://admin:[REDACTED]@host/path");
    expect(redactSecrets("postgres://user:pa/ss@host:5432/db")).toBe("postgres://user:[REDACTED]@host:5432/db");
    expect(redactSecrets("npm https://registry.npmjs.org:443/@scope/pkg then https://user:secret@host/path")).toBe(
      "npm https://registry.npmjs.org:443/@scope/pkg then https://user:[REDACTED]@host/path",
    );
  });

  test("N4: a clean line after a line that holds a secret is still the meaningful line", () => {
    expect(lastMeaningfulLine("token: abcd1234efgh\nall done")).toBe("all done");
    expect(lastMeaningfulLine("│ token: abcd1234efgh │\n│ all done │")).toBe("all done");
    expect(lastMeaningfulLine("Running command with token sk-proj-1234567890abcdef1234567890123\n4567890")).toBe("Running command with token [REDACTED]");
    expect(lastMeaningfulLine("all checks done\nQ1w2E3r4T5y6U7i8O9p0\nAsDfGhJkLzXcVbNm1234")).toBe("all checks done");
  });

  test("item 15: a token wrapped across boxed lines is not shown", () => {
    const tail = "all checks done\n│ Q1w2E3r4T5y6U7i8O9p0 │\n│ AsDfGhJkLzXcVbNm1234 │";
    expect(lastMeaningfulLine(tail)).toBe("all checks done");
    const head = "all checks done\n│ AsDfGhJkLzXcVbNm1234 │\n│ Q1w2E3r4T5y6U7i8O9p0 │\n";
    expect(lastMeaningfulLine(head)).toBe("all checks done");
    const heavy = "all checks done\n┃ Q1w2E3r4T5y6U7i8O9p0 ┃\n┃ AsDfGhJkLzXcVbNm1234 ┃";
    expect(lastMeaningfulLine(heavy)).toBe("all checks done");
    expect(lastMeaningfulLine("│ first line │\n│ second line │")).toBe("second line");
  });
});

describe("review-f selection and trust classification", () => {
  test("N1: a peer on a selection menu gets a selection error and a trust dialog keeps the trust error", async () => {
    const menu = "Pick one\n❯ 1. Option A\n  2. Option B\nEnter to select";
    const menuPeer = peerClient("pane-f-menu", menu);
    await expect(converseWithPeer({ target: "peer", text: "next turn" }, menuPeer.client)).rejects.toThrow("selection menu");
    expect(menuPeer.prompts()).toBe(0);

    const trustPeer = peerClient("pane-f-trust", fixture("claude-trust-dialog-27cols.txt"));
    await expect(converseWithPeer({ target: "peer", text: "next turn" }, trustPeer.client)).rejects.toThrow("repository trust");
    expect(trustPeer.prompts()).toBe(0);

    const readyPeer = peerClient("pane-f-ready", fixture("claude-ready-placeholder-30cols.txt"));
    await converseWithPeer({ target: "peer", text: "next turn" }, readyPeer.client);
    expect(readyPeer.prompts()).toBe(1);
  });

  test("N3: footer words earlier in the pane do not turn a placeholder prompt into a selection menu", async () => {
    const scrollback = "Use ↑/↓ to navigate the list\nthen navigate the repo\n> Try \"fix the bug\"\n──────\n  ? for shortcuts";
    expect(looksLikeSelectionMenu(scrollback)).toBe(false);
    expect(classifyPaneBlock(res(true, scrollback))).toBeNull();
    expect(classifyPaneBlock(res(true, "I will navigate to the page\n❯ Try \"x\""))).toBeNull();
    expect(classifyPaneBlock(res(true, "Choose\n❯ Option A\n  Option B\n\n  ↑/↓ Navigate\n  enter Confirm"))).toBe("selection");
    expect(classifyPaneBlock(res(true, "Choose\n❯ Option A\n  Option B\n\nUse arrow keys to navigate"))).toBeNull();
    expect(classifyPaneBlock(res(true, "Pick one\n❯ 1. Option A\n  2. Option B\nEnter to select"))).toBe("selection");
    expect(classifyPaneBlock(res(true, fixture("agy-trust-dialog-27cols.txt")))).toBe("trust");
    expect(classifyPaneBlock(res(true, fixture("claude-trust-dialog-27cols.txt")))).toBe("trust");
    expect(classifyPaneBlock(res(true, fixture("claude-ready-placeholder-30cols.txt")))).toBeNull();

    const run = buildClient({ screen: (calls) => (calls > 0 ? `${scrollback}\nhello` : scrollback) });
    const result = await launchStageInHerdr({ client: "claude", stage, layout: "split", herdr: run.client, handoffPrompt: "hello", clock: advancingClock() } as any);
    expect(result.selectionRequired).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(run.calls()).toBe(1);
  });
});

describe("review-f delivery check", () => {
  test("N5: a prompt with a newline or a wrap inside its first 32 characters is still seen as delivered", async () => {
    const withNewline = "Fix the failing test\nthen report the result to me";
    const newlineRun = buildClient({ screen: (calls) => (calls > 0 ? "❯ Fix the failing test\n  then report the result to me" : "❯ ") });
    const newlineResult = await launchStageInHerdr({ client: "claude", stage, layout: "split", herdr: newlineRun.client, handoffPrompt: withNewline, deliveryTimeoutMs: 500, clock: advancingClock() } as any);
    expect(newlineResult.ok).toBe(true);
    expect(newlineResult.promptDelivered).toBe(true);

    const plain = "Fix the failing test then report the result to me";
    const wrapRun = buildClient({ screen: (calls) => (calls > 0 ? "❯ Fix the failing te\n  st then report the res\n  ult to me" : "❯ ") });
    const wrapResult = await launchStageInHerdr({ client: "claude", stage, layout: "split", herdr: wrapRun.client, handoffPrompt: plain, deliveryTimeoutMs: 500, clock: advancingClock() } as any);
    expect(wrapResult.ok).toBe(true);
    expect(wrapResult.promptDelivered).toBe(true);

    const missing = buildClient({ screen: () => "❯ " });
    const missingResult = await launchStageInHerdr({ client: "claude", stage, layout: "split", herdr: missing.client, handoffPrompt: withNewline, deliveryTimeoutMs: 500, clock: advancingClock() } as any);
    expect(missingResult.ok).toBe(false);
    expect(missingResult.error).toContain("prompt not observed");
  });
});

describe("review-f worktree helper", () => {
  test("item 8: a git runner that returns plain strings creates a fresh worktree and reports an existing branch", async () => {
    const calls: string[] = [];
    const fresh = async (args: string[]): Promise<string> => {
      calls.push(args.join(" "));
      if (args[1] === "--show-toplevel") return "/repo";
      return "";
    };
    const created = await setupWorktree({ worktree: "foo", gitRunner: fresh as any }, "/repo");
    expect(created.error).toBeUndefined();
    expect(created.worktreePath).toBe("/repo-wt-foo");
    expect(created.worktreeBranch).toBe("wt/foo");
    expect(calls).toContain("worktree add -b wt/foo /repo-wt-foo HEAD");

    const throwing = async (args: string[]): Promise<string> => {
      if (args[1] === "--show-toplevel") return "/repo";
      if (args[0] === "worktree") return "";
      throw new Error("exit 128");
    };
    const viaThrow = await setupWorktree({ worktree: "foo", gitRunner: throwing as any }, "/repo");
    expect(viaThrow.error).toBeUndefined();
    expect(viaThrow.worktreePath).toBe("/repo-wt-foo");

    const branchExists = async (args: string[]): Promise<string> => {
      if (args[1] === "--show-toplevel") return "/repo";
      if (args[0] === "show-ref") return "abc123 refs/heads/wt/foo";
      throw new Error("exit 128");
    };
    const taken = await setupWorktree({ worktree: "foo", gitRunner: branchExists as any }, "/repo");
    expect(taken.error).toContain("already exists");
  });
});

describe("review-f test guard", () => {
  const cleanup: string[] = [];
  afterAll(() => {
    for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
  });

  function runLauncherGuard(dir: string, tmpOverride: string | null) {
    const bin = join(dir, "claude");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(bin, 0o755);
    const launcherPath = join(import.meta.dir, "..", "src", "herdr", "launcher.ts");
    const script = `const m = await import(${JSON.stringify(launcherPath)});
const stage = { model: "m", role: "implementer", extraFlags: [] };
const captured = m.runAgentCaptured({ client: "claude", stage, promptText: "hi" });
const inline = m.runAgentInline({ client: "claude", stage, promptText: "hi", nonInteractive: true });
console.log(JSON.stringify({ captured: captured.exitCode, inline: inline.exitCode }));`;
    const env: Record<string, string | undefined> = {
      ...process.env,
      HERDR_JEV_TEST_GUARD: "1",
      HERDR_JEV_ALLOW_ALIASES: "1",
      HERDR_JEV_BIN_CLAUDE: bin,
    };
    delete env.TMPDIR;
    delete env.TMP;
    delete env.TEMP;
    if (tmpOverride !== null) env.TMPDIR = tmpOverride;
    const child = spawnSync("bun", ["-e", script], { env: env as NodeJS.ProcessEnv, encoding: "utf8" });
    return JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "{}") as { captured: number | null; inline: number | null };
  }

  test("item 10: launcher guards ignore TMPDIR and still allow fake binaries under the OS temp directory", () => {
    const base = existsSync("/dev/shm") ? "/dev/shm" : homedir();
    const outside = mkdtempSync(join(base, "herdr-jev-launcher-guard-"));
    cleanup.push(outside);
    expect(runLauncherGuard(outside, outside)).toEqual({ captured: 126, inline: 126 });

    const inside = mkdtempSync("/tmp/herdr-jev-launcher-guard-");
    cleanup.push(inside);
    expect(runLauncherGuard(inside, null)).toEqual({ captured: 0, inline: 0 });
  });

  test("N6: a macOS style temp directory is resolved before the allowlist check", () => {
    const macReal = (path: string) => path.replace(/^\/var\//, "/private/var/");
    expect(resolveFakeBinDir("/var/folders/ab/cd/T/", macReal)).toBe("/private/var/folders/ab/cd/T");
    expect(resolveFakeBinDir("/private/var/folders/ab/cd/T", macReal)).toBe("/private/var/folders/ab/cd/T");
    expect(resolveFakeBinDir("/dev/shm/elsewhere", (path) => path)).toBe("/tmp");
    expect(resolveFakeBinDir("/var/folders/ab/cd/T", () => { throw new Error("ENOENT"); })).toBe("/tmp");
    expect(resolveFakeBinDir("/tmp/", (path) => path)).toBe("/tmp");
  });
});
