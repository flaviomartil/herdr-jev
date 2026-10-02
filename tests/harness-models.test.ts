import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { harnessModelCatalog, harnessModelResolve, resetHarnessCaches } from "../src/harness/bridge.js";
import { builtinLaunchArgs, buildAgentCommand, buildInlineCommand, bypassEnabled, readonlyReviewerArgs } from "../src/herdr/launcher.js";
import { reviewerCommand } from "../src/orchestration/pipeline.js";
import type { ClientKind, RoleKind, StageSpec } from "../src/types/index.js";
import { createFakeHarness, type FakeHarness, type FakeHarnessMode } from "./fake-harness.js";

const CLAUDE_BYPASS = "--dangerously-skip-permissions";
const CODEX_BYPASS = "--dangerously-bypass-approvals-and-sandbox";

function stage(role: RoleKind, model: string, effort: StageSpec["effort"] = "high", extraFlags: string[] = []): StageSpec {
  return { role, model, effort, extraFlags, description: "synthetic" };
}

let harness: FakeHarness | undefined;
const originalBypass = process.env.HERDR_JEV_BYPASS;

function install(mode: FakeHarnessMode = "contract", env: Record<string, string> = {}) {
  harness = createFakeHarness(mode, env);
}

beforeEach(() => {
  delete process.env.HERDR_JEV_BYPASS;
  resetHarnessCaches();
});

afterEach(() => {
  harness?.restore();
  harness = undefined;
  if (originalBypass === undefined) delete process.env.HERDR_JEV_BYPASS;
  else process.env.HERDR_JEV_BYPASS = originalBypass;
  resetHarnessCaches();
});

function expectedFallbackArgv(): Array<[string, string[]]> {
  return [
    ["claude", ["claude", "--model", "claude-sonnet-5-5", "--effort", "high", CLAUDE_BYPASS]],
    ["codex", ["codex", "--model", "gpt-5.6-luna", "-c", 'model_reasoning_effort="high"', CODEX_BYPASS]],
    ["antigravity", ["agy", "--model", "gemini-3.8-flash-high", CLAUDE_BYPASS]],
    ["kiro", ["kiro-cli", "chat", "--trust-all-tools", "--agent", "ai-harness", "--model", "kiro-model"]],
    ["kimi", ["kimi", "-m", "kimi-model", "--yolo"]],
  ];
}

const MODELS: Record<string, string> = { claude: "sonnet-5", codex: "gpt-5.6-luna", antigravity: "gemini-3-8-flash", kiro: "kiro-model", kimi: "kimi-model" };

describe("bypass mode without a harness answer", () => {
  it("starts advisors, implementers and researchers with the exact no-prompt argv for every client", () => {
    for (const role of ["advisor", "implementer", "researcher"] as const) {
      for (const [client, argv] of expectedFallbackArgv()) {
        expect(buildAgentCommand(client as ClientKind, stage(role, MODELS[client]!))).toEqual(argv);
      }
    }
  });

  it("builds the inline interactive and captured commands with bypass before the prompt text", () => {
    expect(buildInlineCommand("claude", stage("implementer", "sonnet-5"), "task")).toEqual(["claude", "--model", "claude-sonnet-5-5", "--effort", "high", CLAUDE_BYPASS, "task"]);
    expect(buildInlineCommand("claude", stage("researcher", "sonnet-5"), "task", true)).toEqual(["claude", "-p", "task", "--model", "claude-sonnet-5-5", "--effort", "high", CLAUDE_BYPASS]);
    expect(buildInlineCommand("codex", stage("implementer", "gpt-5.6-luna"), "task")).toEqual(["codex", "--model", "gpt-5.6-luna", "-c", 'model_reasoning_effort="high"', CODEX_BYPASS, "task"]);
    expect(buildInlineCommand("codex", stage("advisor", "gpt-5.6-luna"), "task", true)).toEqual(["codex", "exec", "task", "--model", "gpt-5.6-luna", "-c", 'model_reasoning_effort="high"', CODEX_BYPASS]);
    expect(buildInlineCommand("antigravity", stage("advisor", "gemini-3-8-flash"), "task", true)).toEqual(["agy", "-p", "task", "--model", "gemini-3.8-flash-high", CLAUDE_BYPASS]);
    expect(buildInlineCommand("kimi", stage("implementer", "kimi-model"), "task")).toEqual(["kimi", "-m", "kimi-model", "--yolo", "task"]);
  });

  it("never gives the reviewer role bypass arguments and keeps its read-only adapters", () => {
    for (const [client, model] of [["claude", "sonnet-5"], ["codex", "gpt-5.6-sol"], ["antigravity", "gemini-3-8-pro"], ["kimi", "kimi-model"]] as const) {
      const agent = buildAgentCommand(client, stage("reviewer", model));
      const inline = buildInlineCommand(client, stage("reviewer", model), "review", true);
      for (const argv of [agent, inline]) {
        expect(argv).not.toContain(CLAUDE_BYPASS);
        expect(argv).not.toContain(CODEX_BYPASS);
        expect(argv).not.toContain("--yolo");
      }
    }
    const codex = reviewerCommand("codex", stage("implementer", "gpt-5.6-sol"), "review");
    expect(codex).toEqual(["codex", "exec", "review", "--model", "gpt-5.6-sol", "-c", 'model_reasoning_effort="high"', "--sandbox", "read-only"]);
    const claude = reviewerCommand("claude", stage("reviewer", "sonnet-5"), "review");
    expect(claude).toEqual(["claude", "-p", "review", "--model", "claude-sonnet-5-5", "--effort", "high", "--tools", "Read,Glob,Grep"]);
    expect(() => reviewerCommand("antigravity", stage("reviewer", "gemini-3-8-pro"), "review")).toThrow("readonly_reviewer_adapter_unavailable");
  });

  it("drops the bypass arguments when HERDR_JEV_BYPASS=0 and keeps the structural kiro flag", () => {
    process.env.HERDR_JEV_BYPASS = "0";
    expect(bypassEnabled()).toBe(false);
    expect(buildAgentCommand("claude", stage("implementer", "sonnet-5"))).toEqual(["claude", "--model", "claude-sonnet-5-5", "--effort", "high"]);
    expect(buildAgentCommand("codex", stage("implementer", "gpt-5.6-luna"))).toEqual(["codex", "--model", "gpt-5.6-luna", "-c", 'model_reasoning_effort="high"']);
    expect(buildAgentCommand("antigravity", stage("implementer", "gemini-3-8-flash"))).toEqual(["agy", "--model", "gemini-3.8-flash-high"]);
    expect(buildAgentCommand("kimi", stage("implementer", "kimi-model"))).toEqual(["kimi", "-m", "kimi-model"]);
    expect(buildAgentCommand("kiro", stage("implementer", "kiro-model"))).toContain("--trust-all-tools");
    expect(buildInlineCommand("codex", stage("implementer", "gpt-5.6-luna"), "task", true)).not.toContain(CODEX_BYPASS);
  });

  it("never adds a bypass flag the stage already carries", () => {
    const claude = buildAgentCommand("claude", stage("implementer", "sonnet-5", "high", [CLAUDE_BYPASS]));
    expect(claude.filter((arg) => arg === CLAUDE_BYPASS)).toHaveLength(1);
    const codex = buildInlineCommand("codex", stage("implementer", "gpt-5.6-luna", "high", [CODEX_BYPASS]), "task", true);
    expect(codex.filter((arg) => arg === CODEX_BYPASS)).toHaveLength(1);
    const kimi = buildAgentCommand("kimi", stage("implementer", "kimi-model", "high", ["--yolo"]));
    expect(kimi.filter((arg) => arg === "--yolo")).toHaveLength(1);
    expect(buildAgentCommand("kiro", stage("implementer", "kiro-model")).filter((arg) => arg === "--trust-all-tools")).toHaveLength(1);
  });

  it("publishes the built-in fallback values", () => {
    expect(builtinLaunchArgs()).toEqual({
      bypass_args: { claude: [CLAUDE_BYPASS], codex: [CODEX_BYPASS], antigravity: [CLAUDE_BYPASS], kiro: ["--trust-all-tools"], kimi: ["--yolo"] },
      readonly_args: { codex: ["--sandbox", "read-only"], claude: ["--tools", "Read,Glob,Grep"] },
    });
  });
});

describe("model catalog through ai-harness", () => {
  it("resolves the CLI id, effort and role through model-resolve and caches the answer per process", () => {
    install();
    const first = buildAgentCommand("claude", stage("implementer", "fable-5"));
    const second = buildAgentCommand("claude", stage("implementer", "fable-5"));
    expect(first).toEqual(["claude", "--model", "claude-fable-5-1", "--effort", "high", CLAUDE_BYPASS]);
    expect(second).toEqual(first);
    const calls = harness!.callsFor("model-resolve");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 9)).toEqual(["model-resolve", "--client", "claude", "--model", "fable-5", "--effort", "high", "--role", "executor"]);
    buildInlineCommand("claude", stage("reviewer", "fable-5"), "task", true);
    expect(harness!.callsFor("model-resolve")).toHaveLength(2);
    expect(harness!.callsFor("model-resolve")[1]).toContain("reviewer");
  });

  it("uses the harness effort style per client", () => {
    install();
    expect(buildAgentCommand("claude", stage("implementer", "claude-opus-5-5", "standard"))).toEqual(["claude", "--model", "claude-opus-5-5", "--effort", "medium", CLAUDE_BYPASS]);
    expect(buildAgentCommand("codex", stage("implementer", "gpt-5.6-luna", "xhigh"))).toEqual(["codex", "--model", "gpt-5.6-luna", "-c", 'model_reasoning_effort="xhigh"', CODEX_BYPASS]);
    expect(buildAgentCommand("antigravity", stage("implementer", "gemini-3-8-pro", "standard"))).toEqual(["agy", "--model", "gemini-3.1-pro-low", CLAUDE_BYPASS]);
    expect(buildAgentCommand("antigravity", stage("implementer", "claude-opus-4-6", "xhigh"))).toEqual(["agy", "--model", "claude-opus-4-6-thinking", CLAUDE_BYPASS]);
  });

  it("takes the bypass and read-only arguments from the harness answer", () => {
    install("contract", { FAKE_BYPASS_CLAUDE: "--harness-bypass", FAKE_READONLY_CODEX: "--sandbox read-only --harness-readonly" });
    expect(buildAgentCommand("claude", stage("implementer", "fable-5"))).toEqual(["claude", "--model", "claude-fable-5-1", "--effort", "high", "--harness-bypass"]);
    expect(readonlyReviewerArgs("codex", stage("reviewer", "gpt-5.6-sol"))).toEqual(["--sandbox", "read-only", "--harness-readonly"]);
    expect(reviewerCommand("codex", stage("reviewer", "gpt-5.6-sol"), "review").slice(-3)).toEqual(["--sandbox", "read-only", "--harness-readonly"]);
  });

  it("falls back to the built-in mapping for a model the harness does not know", () => {
    install();
    expect(harnessModelResolve({ client: "claude", model: "sonnet-5.5", effort: "high", role: "executor" })?.known).toBe(false);
    expect(buildAgentCommand("claude", stage("implementer", "sonnet-5.5"))).toEqual(["claude", "--model", "claude-sonnet-5-5", "--effort", "high", CLAUDE_BYPASS]);
    expect(buildAgentCommand("antigravity", stage("implementer", "gemini-3-8-pro-lite", "high")).slice(0, 3)).toEqual(["agy", "--model", "gemini-3.1-pro-lite-high"]);
  });

  for (const mode of ["unknown", "legacy"] as const) {
    it(`answers exactly like today when the harness reports unknown_command (${mode})`, () => {
      install(mode);
      for (const [client, argv] of expectedFallbackArgv()) {
        expect(buildAgentCommand(client as ClientKind, stage("implementer", MODELS[client]!))).toEqual(argv);
      }
      expect(reviewerCommand("codex", stage("reviewer", "gpt-5.6-sol"), "review").slice(-2)).toEqual(["--sandbox", "read-only"]);
      const probe = harnessModelCatalog();
      expect(probe.ok).toBe(false);
      expect(probe.unsupported).toBe(true);
    });
  }

  it("prints what the harness returned for the catalog", () => {
    install();
    const probe = harnessModelCatalog("codex");
    expect(probe.ok).toBe(true);
    expect(Object.keys(probe.value.clients)).toEqual(["codex"]);
    expect(probe.value.clients.codex.bypass_args).toEqual([CODEX_BYPASS]);
    expect(harness!.callsFor("model-catalog")[0]!.slice(0, 3)).toEqual(["model-catalog", "--client", "codex"]);
  });
});
