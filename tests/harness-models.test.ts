import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { harnessModelCatalog, harnessModelResolve, resetHarnessCaches } from "../src/harness/bridge.js";
import { builtinLaunchArgs, buildAgentCommand, buildInlineCommand, bypassEnabled, readonlyReviewerArgs } from "../src/herdr/launcher.js";
import { reviewerCommand } from "../src/orchestration/pipeline.js";
import { planExecution } from "../src/pipelines/planner.js";
import { availableDelegationClients, parseCrossHarnessConfig } from "../src/delegation/cross-harness.js";
import type { ClientKind, RoleKind, StageSpec, TriageDecision } from "../src/types/index.js";
import { markModelExhausted, resetQuotas } from "../src/config/catalog.js";
import { createTestStateDir } from "./helpers.js";
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
    expect(calls[0]!.slice(0, 9)).toEqual(["model-resolve", "--client", "claude", "--model", "fable-5", "--effort", "high", "--role", "implementer"]);
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

  it("asks for kimi through the catalog and keeps --yolo from its bypassArgs", () => {
    install("contract", { FAKE_BYPASS_KIMI: "--yolo --harness-kimi" });
    expect(buildAgentCommand("kimi", stage("implementer", "kimi-model"))).toEqual(["kimi", "-m", "kimi-model", "--yolo", "--harness-kimi"]);
    expect(harness!.callsFor("model-resolve")[0]!.slice(0, 5)).toEqual(["model-resolve", "--client", "kimi", "--model", "kimi-model"]);
  });

  it("treats antigravity ids that already carry the effort suffix as known and unchanged", () => {
    install();
    expect(harnessModelResolve({ client: "antigravity", model: "gemini-3.1-pro-high", effort: "high", role: "implementer" })).toMatchObject({ known: true, cliModel: "gemini-3.1-pro-high" });
    expect(buildAgentCommand("antigravity", stage("implementer", "gemini-3.1-pro-high"))).toEqual(["agy", "--model", "gemini-3.1-pro-high", CLAUDE_BYPASS]);
  });

  it("prefers the cliModel of the delegation plan over every mapping", () => {
    install();
    const planned = { ...stage("implementer", "gpt-5.6-luna"), cliModel: "gpt-5.6-luna-cli" };
    expect(buildAgentCommand("codex", planned)).toEqual(["codex", "--model", "gpt-5.6-luna-cli", "-c", 'model_reasoning_effort="high"', CODEX_BYPASS]);
    expect(buildInlineCommand("claude", { ...stage("implementer", "sonnet-5"), cliModel: "claude-custom" }, "task", true).slice(0, 5)).toEqual(["claude", "-p", "task", "--model", "claude-custom"]);
  });

  it("carries the cliModel of delegation-plan into the execution stages", () => {
    install("contract", { FAKE_PROFILE: "1" });
    const triage: TriageDecision = { complexity: "architectural", confidence: 1, needsResearch: false, effort: "high", recommendedPipeline: "triad", latencyMs: 0, rawAnswers: {} };
    const plan = planExecution("task", "codex", triage, { forceTriad: true, delegation: { model: "advisor-model", availableModels: ["gpt-5.6-luna", "gpt-5.6-sol"] } });
    expect(plan.executionStages?.map((item) => [item.role, item.model, item.cliModel])).toEqual([["implementer", "gpt-5.6-luna", "gpt-5.6-luna-cli"], ["reviewer", "gpt-5.6-sol", "gpt-5.6-sol-cli"]]);
    expect(buildAgentCommand("codex", plan.executionStages![0]!)[2]).toBe("gpt-5.6-luna-cli");
  });

  describe("routed delegation", () => {
    const moderate: TriageDecision = { complexity: "moderate", confidence: 1, needsResearch: false, effort: "xhigh", recommendedPipeline: "triad", latencyMs: 0, rawAnswers: {} };
    const saved = { cross: process.env.HERDR_JEV_CROSS_HARNESS, exclude: process.env.HERDR_JEV_EXCLUDE_CLIENTS };
    const plan = (cross?: string) => planExecution("task", "claude", moderate, { forceTriad: true, requestDelegation: true,
      ...(cross === undefined ? {} : { crossHarness: parseCrossHarnessConfig(cross) }), delegation: { model: "opus-5", availableModels: ["claude-sonnet-5", "opus-5"] } });
    const forwarded = () => harness!.callsFor("delegation-plan").at(-1)!;
    const option = (name: string) => forwarded()[forwarded().indexOf(name) + 1];

    let state: ReturnType<typeof createTestStateDir>;
    beforeEach(() => { state = createTestStateDir(); resetQuotas(); });

    afterEach(() => {
      resetQuotas();
      state.cleanup();
      for (const [key, value] of [["HERDR_JEV_CROSS_HARNESS", saved.cross], ["HERDR_JEV_EXCLUDE_CLIENTS", saved.exclude]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    });

    it("takes each execution stage client from the target and builds flags for that client", () => {
      install("contract", { FAKE_PROFILE: "routed" });
      const result = plan("claude:codex");
      expect(option("--complexity")).toBe("moderate");
      expect(option("--effort")).toBe("xhigh");
      expect(option("--available-clients")).toBe("codex");
      expect(result.delegation).toMatchObject({ mode: "delegate", profile: { route: "moderate" } });
      expect(result.executionStages?.map((item) => [item.role, item.client, item.model, item.extraFlags])).toEqual([
        ["implementer", "codex", "gpt-5.6-luna", ["-c", 'model_reasoning_effort="xhigh"']],
        ["reviewer", "claude", "opus-5", []],
      ]);
      expect(result.routing).toEqual({ complexity: "moderate", effort: "xhigh", availableClients: ["codex"] });
    });

    it("falls back to the profile client when a stage carries none", () => {
      install("contract", { FAKE_PROFILE: "1" });
      const result = plan();
      expect(result.executionStages?.map((item) => item.client)).toEqual(["claude", "claude"]);
    });

    it("offers no peers when cross-harness is disabled", () => {
      install("contract", { FAKE_PROFILE: "routed" });
      const result = plan();
      expect(forwarded()).not.toContain("--available-clients");
      expect(result.executionStages?.[0]?.client).toBe("claude");
      expect(result.routing?.availableClients).toEqual([]);
    });

    it("drops a peer whose routed model is exhausted and resolves again", () => {
      install("contract", { FAKE_PROFILE: "routed" });
      markModelExhausted("codex", "gpt-5.6-luna");
      const result = plan("claude:codex,antigravity");
      expect(harness!.callsFor("delegation-plan").map((call) => call[call.indexOf("--available-clients") + 1])).toEqual(["codex,antigravity", "antigravity"]);
      expect(result.routing?.availableClients).toEqual(["antigravity"]);
      expect(result.executionStages?.map((item) => item.client)).toEqual(["claude", "claude"]);
    });

    it("keeps a healthy peer without a second resolution", () => {
      install("contract", { FAKE_PROFILE: "routed" });
      const result = plan("claude:codex,antigravity");
      expect(harness!.callsFor("delegation-plan")).toHaveLength(1);
      expect(result.executionStages?.[0]?.client).toBe("codex");
    });

    it("authorises no peers for an unrecognised cross-harness value", () => {
      for (const value of ["no", "codexx", "enabled"]) {
        expect(parseCrossHarnessConfig(value).mode).toBe("auto");
        expect(availableDelegationClients("claude", parseCrossHarnessConfig(value))).toEqual([]);
      }
      for (const value of ["1", "true", "ON", " auto "]) expect(availableDelegationClients("claude", parseCrossHarnessConfig(value))).toContain("codex");
    });

    it("drops the session client and excluded clients from the peers", () => {
      install("contract", { FAKE_PROFILE: "routed" });
      process.env.HERDR_JEV_EXCLUDE_CLIENTS = "codex";
      expect(availableDelegationClients("claude", parseCrossHarnessConfig("claude:claude,codex,antigravity"))).toEqual(["antigravity"]);
      delete process.env.HERDR_JEV_EXCLUDE_CLIENTS;
      expect(availableDelegationClients("claude", parseCrossHarnessConfig("claude:claude,codex,antigravity"))).toEqual(["codex", "antigravity"]);
      expect(availableDelegationClients("claude", parseCrossHarnessConfig("claude:codex"))).toEqual(["codex"]);
      expect(availableDelegationClients("claude", parseCrossHarnessConfig("off"))).toEqual([]);
    });
  });

  it("falls back to the built-in mapping for a model the harness does not know", () => {
    install();
    expect(harnessModelResolve({ client: "claude", model: "sonnet-5.5", effort: "high", role: "implementer" })?.known).toBe(false);
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
