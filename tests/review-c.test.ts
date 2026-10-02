import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setupWorktree } from "../src/herdr/agents.js";
import { classifyPaneBlock, requiresTrustConfirmation, type HerdrClient } from "../src/herdr/client.js";
import { gridStateDir, isClientPromptReady, launchStageInHerdr, resolveClaudeModel } from "../src/herdr/launcher.js";
import { lastMeaningfulLine, redactSecrets } from "../src/herdr/pane-text.js";
import { executeStandupCommand, parseStandupFile } from "../src/herdr/standup.js";
import type { HerdrCommandResult, StageSpec } from "../src/types/index.js";

const stage: StageSpec = { role: "implementer", model: "fake-model", effort: "high", extraFlags: [], description: "" };

function fixture(name: string): string {
  return readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
}

function res(ok: boolean, stdout = "", stderr = ""): HerdrCommandResult {
  return { ok, code: ok ? 0 : 1, stdout, stderr };
}

function stdoutOnly(stdout: string): HerdrCommandResult {
  return res(true, stdout);
}

function advancingClock() {
  let now = 1_000_000;
  return { now: () => now, sleep: async (ms: number) => { now += ms; } };
}

type ScreenFn = (promptCalls: number) => string;

function buildClient(options: {
  screen: ScreenFn;
  agentOutput: (promptCalls: number) => string;
  prompt?: (calls: number) => HerdrCommandResult;
}) {
  let promptCalls = 0;
  const client: HerdrClient = {
    splitCurrent: async () => res(true, '{"result":{"pane":{"pane_id":"pane-42"}}}'),
    startAgent: async () => res(true),
    closePane: async () => res(true),
    getAgent: async () => res(true, options.agentOutput(promptCalls)),
    readAgent: async () => res(true, options.screen(promptCalls)),
    readPane: async () => res(true, options.screen(promptCalls)),
    waitFor: async () => res(true),
    notify: async () => res(true),
    prompt: async () => {
      promptCalls++;
      return options.prompt ? options.prompt(promptCalls) : res(true);
    },
  };
  return { client, calls: () => promptCalls };
}

const idleJson = '{"result":{"agent":{"agent_status":"idle"}}}';
const unknownJson = '{"result":{"agent":{"agent_status":"unknown"}}}';

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

describe("review-c redaction", () => {
  test("N1: Basic prose stays unchanged while real Basic credentials are redacted", () => {
    expect(redactSecrets("add basic tests")).toBe("add basic tests");
    expect(redactSecrets("Basic usage notes")).toBe("Basic usage notes");
    expect(redactSecrets("Authorization: Basic dXNlcjpwYXNzd29yZA==")).toBe("Authorization: Basic [REDACTED]");
  });

  test("N2: bare password, token and secret words stay unchanged while --flag values are redacted", () => {
    expect(redactSecrets("refresh token rotation")).toBe("refresh token rotation");
    expect(redactSecrets("rotate the secret quarterly")).toBe("rotate the secret quarterly");
    expect(redactSecrets("--token abc123def456")).toBe("--token [REDACTED]");
    expect(redactSecrets("run --password hunter2value now")).toBe("run --password [REDACTED] now");
  });

  test("19: a password containing a slash inside a URL is redacted", () => {
    expect(redactSecrets("postgres://user:pa/ss@host:5432/db")).toBe("postgres://user:[REDACTED]@host:5432/db");
    expect(redactSecrets("https://user:password123@example.com")).toBe("https://user:[REDACTED]@example.com");
    expect(redactSecrets("see https://example.com/docs/guide")).toBe("see https://example.com/docs/guide");
  });

  test("22: a token wrapped so that neither half reaches 32 characters is not shown", () => {
    const text = "all checks done\nQ1w2E3r4T5y6U7i8O9p0\nAsDfGhJkLzXcVbNm1234";
    expect(lastMeaningfulLine(text)).toBe("all checks done");
    const headOnly = "all checks done\nAsDfGhJkLzXcVbNm1234\nQ1w2E3r4T5y6U7i8O9p0\n";
    expect(lastMeaningfulLine(headOnly)).toBe("all checks done");
    expect(lastMeaningfulLine("first line\nsecond line")).toBe("second line");
  });
});

describe("review-c ready and selection detection", () => {
  test("N3: numbered selection menus return selectionRequired and real trust dialogs keep trustRequired", async () => {
    expect(classifyPaneBlock(stdoutOnly("> 1. first quoted item\nsome reply"))).toBeNull();
    expect(requiresTrustConfirmation(stdoutOnly("> 1. first quoted item"))).toBe(false);
    expect(classifyPaneBlock(stdoutOnly("Pick one\n❯ 1. Option A\n  2. Option B\nEnter to select"))).toBe("selection");
    expect(classifyPaneBlock(stdoutOnly(fixture("agy-trust-dialog-27cols.txt")))).toBe("trust");
    expect(classifyPaneBlock(stdoutOnly(fixture("claude-trust-dialog-27cols.txt")))).toBe("trust");

    const menu = "Pick one\n❯ 1. Option A\n  2. Option B\nEnter to select";
    const menuRun = buildClient({ screen: () => menu, agentOutput: () => idleJson });
    const menuResult = await launchStageInHerdr({ client: "claude", stage, layout: "split", herdr: menuRun.client, handoffPrompt: "hello", clock: advancingClock() } as any);
    expect(menuResult.ok).toBe(false);
    expect(menuResult.selectionRequired).toBe(true);
    expect(menuResult.trustRequired).toBeUndefined();
    expect(menuResult.promptPending).toBe(true);
    expect(menuRun.calls()).toBe(0);

    for (const name of ["agy-trust-dialog-27cols.txt", "claude-trust-dialog-27cols.txt"]) {
      const dialog = fixture(name);
      const run = buildClient({ screen: () => dialog, agentOutput: () => idleJson });
      const result = await launchStageInHerdr({ client: name.startsWith("agy") ? "antigravity" : "claude", stage, layout: "split", herdr: run.client, handoffPrompt: "hello", clock: advancingClock() } as any);
      expect(result.trustRequired).toBe(true);
      expect(result.selectionRequired).toBeUndefined();
      expect(result.ackStatus).toBe("blocked");
      expect(run.calls()).toBe(0);
    }
  });

  test("3: an unnumbered selection menu is not a ready claude prompt", () => {
    expect(isClientPromptReady("claude", "❯ Yes\n  No, exit\n\nEnter to confirm · Esc to cancel")).toBe(false);
    expect(isClientPromptReady("claude", fixture("claude-trust-dialog-27cols.txt"))).toBe(false);
    expect(isClientPromptReady("claude", fixture("claude-ready-placeholder-30cols.txt"))).toBe(true);
  });

  test("N4: claude readiness accepts no-break space, trimmed empty prompt, boxed prompt and wrapped placeholder", () => {
    expect(isClientPromptReady("claude", "banner\n❯ \n")).toBe(true);
    expect(isClientPromptReady("claude", "banner\n❯\n")).toBe(true);
    expect(isClientPromptReady("claude", "banner\n❯")).toBe(true);
    expect(isClientPromptReady("claude", "╭────╮\n│ ❯ \n╰────╯")).toBe(true);
    expect(isClientPromptReady("claude", "❯ Try \"write a test\n  for …\"\n────\n  ⏵⏵ bypass permissions on")).toBe(true);
    expect(isClientPromptReady("claude", "Loading...")).toBe(false);
  });

  test("N4: live screen with placeholder text and bypass permissions status is ready when herdr reports idle", async () => {
    const screen = fixture("claude-ready-placeholder-30cols.txt");
    const run = buildClient({
      screen: (calls) => (calls > 0 ? `${screen}\nhello` : screen),
      agentOutput: () => idleJson,
    });
    const result = await launchStageInHerdr({ client: "claude", stage, layout: "split", herdr: run.client, handoffPrompt: "hello", clock: advancingClock() } as any);
    expect(result.ok).toBe(true);
    expect(result.ackStatus).toBe("acknowledged");
    expect(run.calls()).toBe(1);
  });

  test("N5: a state reported as unknown still receives the prompt once a stable prompt is on screen", async () => {
    const screen = fixture("claude-ready-placeholder-30cols.txt");
    const run = buildClient({
      screen: (calls) => (calls > 0 ? `${screen}\nhello` : screen),
      agentOutput: (calls) => (calls > 0 ? '{"result":{"agent":{"agent_status":"working"}}}' : unknownJson),
    });
    const result = await launchStageInHerdr({ client: "claude", stage, layout: "split", herdr: run.client, handoffPrompt: "hello", clock: advancingClock() } as any);
    expect(result.ok).toBe(true);
    expect(run.calls()).toBe(1);

    const none = buildClient({ screen: () => "Loading...", agentOutput: () => unknownJson });
    const timedOut = await launchStageInHerdr({ client: "claude", stage, layout: "split", herdr: none.client, handoffPrompt: "hello", clock: advancingClock() } as any);
    expect(timedOut.ok).toBe(false);
    expect(timedOut.error).toContain("readiness timed out");
    expect(none.calls()).toBe(0);
  });

  test("N6: private-mode escape sequences do not break the line-start anchors", async () => {
    expect(isClientPromptReady("claude", "\x1b[?25l❯ Try \"write a test for …\"")).toBe(true);
    const run = buildClient({
      screen: (calls) => (calls > 0 ? "\x1b[?25l❯ hello" : "\x1b[?25l❯ Try \"x\""),
      agentOutput: () => idleJson,
    });
    const result = await launchStageInHerdr({ client: "claude", stage, layout: "split", herdr: run.client, handoffPrompt: "hello", clock: advancingClock() } as any);
    expect(result.ok).toBe(true);
    expect(run.calls()).toBe(1);

    const stalled = buildClient({
      screen: (calls) => (calls > 0 ? "\x1b[?25l\x1b[2Khello" : "\x1b[?25l❯ ready"),
      agentOutput: () => idleJson,
      prompt: () => res(false, "agent_prompt_stalled"),
    });
    const stalledResult = await launchStageInHerdr({ client: "claude", stage, layout: "split", herdr: stalled.client, handoffPrompt: "hello", clock: advancingClock() } as any);
    expect(stalledResult.ok).toBe(false);
    expect(stalled.calls()).toBe(1);
  });

  test("N7: a stalled prompt with the text already typed reports promptPending and a hint", async () => {
    const run = buildClient({
      screen: (calls) => (calls > 0 ? "❯ hello world" : "❯ "),
      agentOutput: () => idleJson,
      prompt: () => res(false, "agent_prompt_stalled"),
    });
    const result = await launchStageInHerdr({ client: "claude", stage, layout: "split", herdr: run.client, handoffPrompt: "hello world", clock: advancingClock() } as any);
    expect(result.ok).toBe(false);
    expect(run.calls()).toBe(1);
    expect(result.promptPending).toBe(true);
    expect(result.hint).toContain("submit or clear");
  });

  test("10: the delivery state path ignores words in unstructured output", async () => {
    const run = buildClient({
      screen: (calls) => (calls > 0 ? "❯ " : "❯ "),
      agentOutput: (calls) => (calls > 0 ? "agent is working on something else" : idleJson),
    });
    const result = await launchStageInHerdr({ client: "claude", stage, layout: "split", herdr: run.client, handoffPrompt: "hello world", deliveryTimeoutMs: 500, clock: advancingClock() } as any);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("prompt not observed");

    const structured = buildClient({
      screen: () => "❯ ",
      agentOutput: (calls) => (calls > 0 ? '{"result":{"agent":{"agent_status":"working"}}}' : idleJson),
    });
    const delivered = await launchStageInHerdr({ client: "claude", stage, layout: "split", herdr: structured.client, handoffPrompt: "hello world", deliveryTimeoutMs: 500, clock: advancingClock() } as any);
    expect(delivered.ok).toBe(true);
    expect(delivered.promptDelivered).toBe(true);
  });
});

describe("review-c models, state dir, worktree and standup", () => {
  test("12: every claude 5.5 alias form maps to the canonical id", () => {
    expect(resolveClaudeModel("fable-5-1")).toBe("claude-fable-5-1");
    expect(resolveClaudeModel("opus-5-5")).toBe("claude-opus-5-5");
    expect(resolveClaudeModel("sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(resolveClaudeModel("claude-fable-5.1")).toBe("claude-fable-5-1");
    expect(resolveClaudeModel("claude-opus-5.5")).toBe("claude-opus-5-5");
    expect(resolveClaudeModel("claude-sonnet-5.5")).toBe("claude-sonnet-5-5");
    expect(resolveClaudeModel("claude-haiku-4.5")).toBe("claude-haiku-4-5-20251001");
    expect(resolveClaudeModel("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5-20251001");
    expect(resolveClaudeModel("sonnet")).toBe("sonnet");
    expect(resolveClaudeModel("claude-opus-4-6")).toBe("claude-opus-4-6");
  });

  test("N10: grid state follows the plugin state directory when no explicit override exists", () => {
    const saved = { jev: process.env.HERDR_JEV_STATE_DIR, plugin: process.env.HERDR_PLUGIN_STATE_DIR, id: process.env.HERDR_PLUGIN_ID };
    try {
      delete process.env.HERDR_JEV_STATE_DIR;
      delete process.env.HERDR_PLUGIN_ID;
      process.env.HERDR_PLUGIN_STATE_DIR = "/tmp/review-c-plugin-state";
      expect(gridStateDir()).toBe("/tmp/review-c-plugin-state/grid");
      process.env.HERDR_JEV_STATE_DIR = "/tmp/review-c-jev-state";
      expect(gridStateDir()).toBe("/tmp/review-c-jev-state/grid");
    } finally {
      for (const [key, value] of [["HERDR_JEV_STATE_DIR", saved.jev], ["HERDR_PLUGIN_STATE_DIR", saved.plugin], ["HERDR_PLUGIN_ID", saved.id]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("N8: slugs with slashes, double dots or a .lock suffix get a clear slug error", async () => {
    const runner = async (args: string[], cwd?: string) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { ok: true, stdout: cwd ?? "/repo", stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    };
    for (const slug of ["a/b", "a..b", "foo.lock", "-lead", "trail."]) {
      const result = await setupWorktree({ worktree: slug, gitRunner: runner }, "/repo");
      expect(result.error).toBe("Error: Invalid worktree slug");
    }
    const codex = await setupWorktree({ worktree: "codex/abc", gitRunner: runner }, "/repo");
    expect(codex.error).toContain("cannot start with codex/");
    const good = await setupWorktree({ worktree: "my.feature-1", gitRunner: async (args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { ok: true, stdout: "/repo", stderr: "" };
      if (args[0] === "worktree") return { ok: true, stdout: "", stderr: "" };
      return { ok: false, stdout: "", stderr: "" };
    } }, "/repo");
    expect(good.error).toBeUndefined();
    expect(good.worktreeBranch).toBe("wt/my.feature-1");
  });

  test("N9: a git runner that returns plain strings works through the shared exec helper", async () => {
    const runner = async (args: string[]): Promise<string> => {
      if (args[1] === "--show-toplevel") return "/repo";
      if (args[2] === "--git-common-dir") return "/repo/.git";
      if (args[1] === "--abbrev-ref") return "wt/foo";
      return "";
    };
    const result = await setupWorktree({ worktree: "foo", gitRunner: runner as any }, "/repo");
    expect(result.error).toBeUndefined();
    expect(result.worktreePath).toBe("/repo-wt-foo");
    expect(result.worktreeBranch).toBe("wt/foo");
  });

  test("13: front matter with trailing spaces parses and an unclosed block is rejected", () => {
    const spaced = parseStandupFile("--- \nmax: 5\nstates: idle\n---  \nBody text.");
    expect(spaced.options.max).toBe(5);
    expect(spaced.options.states).toEqual(["idle"]);
    expect(spaced.global).toBe("Body text.");
    expect(() => parseStandupFile("---\nmax: 5\nBody text without closing")).toThrow("not closed");
    expect(() => parseStandupFile("--- \nmax: 5\n")).toThrow("not closed");
    expect(parseStandupFile("Body only").global).toBe("Body only");
  });

  test("17: manual dry-run and --yes runs print a line when no row is eligible", async () => {
    const rows = [{ pane: "%1", agent: "agent-1", project: "API", state: "working" }];
    const deps = (logs: string[]) => ({
      fileExists: () => true,
      readFile: () => "Standup message.",
      overviewRows: rows,
      sendPeer: async () => ({ ok: true }),
      writeFile: () => {},
      mkdir: () => {},
      log: (msg: string) => logs.push(msg),
    });
    const dryLogs: string[] = [];
    await executeStandupCommand({ file: "/tmp/standup.md", dryRun: true }, deps(dryLogs));
    expect(dryLogs).toEqual(["no eligible targets"]);

    const yesLogs: string[] = [];
    await executeStandupCommand({ file: "/tmp/standup.md", yes: true }, deps(yesLogs));
    expect(yesLogs).toEqual(["no eligible targets"]);

    const jsonLogs: string[] = [];
    await executeStandupCommand({ file: "/tmp/standup.md", dryRun: true, json: true }, deps(jsonLogs));
    expect(jsonLogs.length).toBe(1);
    expect(JSON.parse(jsonLogs[0]).targets).toEqual([]);
  });
});

describe("review-c test guard", () => {
  const cleanup: string[] = [];
  afterAll(() => {
    for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
  });

  test("5: the guard does not trust TMPDIR when deciding where a fake herdr may live", () => {
    const base = existsSync("/dev/shm") ? "/dev/shm" : homedir();
    const dir = mkdtempSync(join(base, "herdr-jev-guard-"));
    cleanup.push(dir);
    const bin = join(dir, "herdr");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(bin, 0o755);
    const clientPath = join(import.meta.dir, "..", "src", "herdr", "client.ts");
    const script = `const m = await import(${JSON.stringify(clientPath)});
const r = await m.createProcessCommandAdapter()([${JSON.stringify(bin)}, "agent", "start", "x"]);
console.log(String(r.code));`;
    const child = spawnSync("bun", ["-e", script], {
      env: { ...process.env, TMPDIR: dir, HERDR_JEV_TEST_GUARD: "1" },
      encoding: "utf8",
    });
    expect(child.stdout.trim()).toBe("126");
  });
});
