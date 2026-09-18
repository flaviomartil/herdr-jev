import { describe, expect, it, beforeEach, afterAll } from "bun:test";
import { planExecution } from "../src/pipelines/planner.js";
import {
  buildAgentCommand,
  parseHerdrPaneId,
  formatHerdrAgentName,
  mapClientToHerdrKind,
  shouldSplitSubagents,
  buildInlineCommand,
  resolveSplitDirection,
} from "../src/herdr/launcher.js";
import {
  parseCrossHarnessConfig,
  resolveDelegatedClient,
  getJevRecommendedClientForRole,
} from "../src/delegation/cross-harness.js";
import { CLIENT_MODEL_MATRIX } from "../src/pipelines/matrix.js";
import { checkHarnessStatus } from "../src/harness/bridge.js";
import { resolveActiveModel, markModelExhausted, resetQuotas, isClientExhausted } from "../src/config/catalog.js";
import { processNewModel, getKnownModels } from "../src/discovery/model-detector.js";
import type { TriageDecision } from "../src/types/index.js";
import { resolveBaseClientKind, resolveClientExecutable, areAliasesEnabled } from "../src/config/aliases.js";
import {
  detectInstalledHarnesses,
  recommendConfiguration,
  formatHarnessTable,
  writeAutoConfigEnv,
  type DetectedHarness,
} from "../src/discovery/harness-detector.js";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";


describe("Model Matrix", () => {
  it("defines Claude models: Fable 5 advisor, Sonnet 5 implementer with 1M tokens, Opus 5 reviewer", () => {
    expect(CLIENT_MODEL_MATRIX.claude.advisor.model).toBe("fable-5");
    expect(CLIENT_MODEL_MATRIX.claude.implementer.model).toBe("sonnet-5");
    expect(CLIENT_MODEL_MATRIX.claude.reviewer.model).toBe("opus-5");
  });

  it("defines Codex models: Astra advisor, Luna implementer with XHIGH, Sol reviewer with XHIGH", () => {
    expect(CLIENT_MODEL_MATRIX.codex.advisor.model).toBe("astra");
    expect(CLIENT_MODEL_MATRIX.codex.implementer.model).toBe("gpt-5.6-luna");
    expect(CLIENT_MODEL_MATRIX.codex.implementer.extraFlags).toContain("-c");
    expect(CLIENT_MODEL_MATRIX.codex.reviewer.model).toBe("gpt-5.6-sol");
  });

  it("defines AntiGravity models: Opus 4.6 advisor, Gemini 3.8 Flash High implementer", () => {
    expect(CLIENT_MODEL_MATRIX.antigravity.advisor.model).toBe("claude-opus-4-6");
    expect(CLIENT_MODEL_MATRIX.antigravity.implementer.model).toBe("gemini-3-8-flash");
    expect(CLIENT_MODEL_MATRIX.antigravity.reviewer.model).toBe("claude-opus-4-6");
  });
});

describe("Pipeline Planner", () => {
  const trivialTriage: TriageDecision = {
    complexity: "trivial",
    confidence: 0.95,
    needsResearch: false,
    effort: "standard",
    recommendedPipeline: "direct",
    latencyMs: 250,
    rawAnswers: {},
  };

  const architecturalTriage: TriageDecision = {
    complexity: "architectural",
    confidence: 0.99,
    needsResearch: true,
    effort: "xhigh",
    recommendedPipeline: "triad",
    latencyMs: 310,
    rawAnswers: {},
  };

  it("plans single-stage direct execution for trivial tasks", () => {
    const plan = planExecution("Fix typo in doc", "claude", trivialTriage);
    expect(plan.stages.length).toBe(1);
    expect(plan.stages[0].role).toBe("implementer");
    expect(plan.stages[0].model).toBe("sonnet-5");
    expect(plan.spawnResearchSubagent).toBe(false);
  });

  it("plans 3-stage triad execution for architectural tasks", () => {
    const plan = planExecution("Design multi-tenant router", "claude", architecturalTriage);
    expect(plan.stages.length).toBe(3);
    expect(plan.stages[0].role).toBe("advisor");
    expect(plan.stages[0].model).toBe("fable-5");
    expect(plan.stages[1].role).toBe("implementer");
    expect(plan.stages[1].model).toBe("sonnet-5");
    expect(plan.stages[2].role).toBe("reviewer");
    expect(plan.stages[2].model).toBe("opus-5");
    expect(plan.spawnResearchSubagent).toBe(true);
  });

  it("forces triad execution when requested even for trivial tasks", () => {
    const plan = planExecution("Fix typo in doc", "codex", trivialTriage, { forceTriad: true });
    expect(plan.stages.length).toBe(3);
    expect(plan.stages[0].role).toBe("advisor");
    expect(plan.stages[0].model).toBe("astra");
    expect(plan.stages[1].role).toBe("implementer");
    expect(plan.stages[1].model).toBe("gpt-5.6-luna");
    expect(plan.stages[2].role).toBe("reviewer");
    expect(plan.stages[2].model).toBe("gpt-5.6-sol");
  });
});

describe("Agent Command Builder", () => {
  it("builds claude command with model flag", () => {
    const cmd = buildAgentCommand("claude", {
      role: "implementer",
      model: "sonnet-5",
      effort: "high",
      extraFlags: [],
      description: "implementer",
    });
    expect(cmd).toEqual(["claude", "--model", "sonnet-5"]);
  });

  it("builds codex command with reasoning effort config flag", () => {
    const cmd = buildAgentCommand("codex", {
      role: "implementer",
      model: "gpt-5.6-luna",
      effort: "xhigh",
      extraFlags: ["-c", 'model_reasoning_effort="xhigh"'],
      description: "implementer",
    });
    expect(cmd).toEqual(["codex", "--model", "gpt-5.6-luna", "-c", 'model_reasoning_effort="xhigh"']);
  });

  it("builds antigravity command and maps to agy kind", () => {
    const cmd = buildAgentCommand("antigravity", {
      role: "implementer",
      model: "gemini-3-8-flash",
      effort: "high",
      extraFlags: [],
      description: "implementer",
    });
    expect(cmd).toEqual(["agy"]);
    expect(mapClientToHerdrKind("antigravity")).toBe("agy");
  });
});

describe("Herdr Pane Parser & Agent Naming", () => {
  it("extracts pane id from JSON response", () => {
    const jsonOutput = JSON.stringify({ result: { pane: { pane_id: "pane-42" } } });
    expect(parseHerdrPaneId(jsonOutput)).toBe("pane-42");
  });

  it("extracts pane id from plain text token", () => {
    expect(parseHerdrPaneId("pane-99\n")).toBe("pane-99");
  });

  it("formats readable Herdr agent names within 32 character limit", () => {
    const name1 = formatHerdrAgentName("claude", "advisor", "fable-5", "a1b2");
    expect(name1).toBe("jev-advisor-fable5-a1b2");
    expect(name1.length).toBeLessThanOrEqual(32);

    const name2 = formatHerdrAgentName("codex", "implementer", "gpt-5.6-luna", "c3d4");
    expect(name2).toBe("jev-impl-luna-c3d4");
    expect(name2.length).toBeLessThanOrEqual(32);

    const name3 = formatHerdrAgentName("antigravity", "reviewer", "claude-opus-4-6", "e5f6");
    expect(name3).toBe("jev-reviewer-opus46-e5f6");
    expect(name3.length).toBeLessThanOrEqual(32);
  });
});

describe("AI-Harness Bridge", () => {
  it("detects ai-harness-core repository", () => {
    const status = checkHarnessStatus();
    expect(status.available).toBe(true);
    expect(status.harnessPath).toContain("ai-harness-core");
  });
});

describe("Dynamic Model Matrix & Quota Cascade", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.HERDR_JEV_ANTIGRAVITY_ADVISOR;
    delete process.env.HERDR_JEV_ANTIGRAVITY_IMPLEMENTER;
    delete process.env.HERDR_JEV_ANTIGRAVITY_REVIEWER;
    delete process.env.HERDR_JEV_ANTIGRAVITY_RESEARCHER;
  });

  afterAll(() => {
    process.env = { ...savedEnv };
  });

  it("resolves primary model when quota is healthy", () => {
    const active = resolveActiveModel("antigravity", "advisor");
    expect(active.model).toBe("claude-opus-4-6");
    expect(active.usedFallback).toBe(false);
  });

  it("cascades to next fallback model when primary is quota exhausted", () => {
    markModelExhausted("antigravity", "claude-opus-4-6", 60);
    const active = resolveActiveModel("antigravity", "advisor");
    expect(active.model).toBe("gemini-3-8-pro");
    expect(active.usedFallback).toBe(true);
    expect(active.originalRequested).toBe("claude-opus-4-6");
    resetQuotas("antigravity");
  });

  it("restores primary model after quota reset", () => {
    resetQuotas("antigravity");
    const active = resolveActiveModel("antigravity", "advisor");
    expect(active.model).toBe("claude-opus-4-6");
    expect(active.usedFallback).toBe(false);
  });
});

describe("Model Discovery & Auto-Classification", () => {
  it("detects known registered models for clients", () => {
    const knownClaude = getKnownModels("claude");
    expect(knownClaude.has("fable-5")).toBe(true);
    expect(knownClaude.has("sonnet-5")).toBe(true);
    expect(knownClaude.has("opus-5")).toBe(true);
  });

  it("classifies newly discovered model and reports integration details", async () => {
    const res = await processNewModel("codex", "gpt-5.6-luna");
    expect(res.client).toBe("codex");
    expect(res.assignedRole).toBeDefined();
    expect(res.classification.tier).toBeDefined();
  });
});

describe("Subagent Execution Mode: Split vs Inline", () => {
  const origEnv = process.env.HERDR_ENV;
  const origSplitEnv = process.env.HERDR_JEV_SPLIT_SUBAGENTS;

  it("prioritizes explicit CLI flag over environment variables", () => {
    process.env.HERDR_JEV_SPLIT_SUBAGENTS = "1";
    expect(shouldSplitSubagents(false)).toBe(false);

    process.env.HERDR_JEV_SPLIT_SUBAGENTS = "0";
    expect(shouldSplitSubagents(true)).toBe(true);
  });

  it("respects HERDR_JEV_SPLIT_SUBAGENTS env var values", () => {
    process.env.HERDR_JEV_SPLIT_SUBAGENTS = "0";
    expect(shouldSplitSubagents()).toBe(false);

    process.env.HERDR_JEV_SPLIT_SUBAGENTS = "false";
    expect(shouldSplitSubagents()).toBe(false);

    process.env.HERDR_JEV_SPLIT_SUBAGENTS = "1";
    expect(shouldSplitSubagents()).toBe(true);

    process.env.HERDR_JEV_SPLIT_SUBAGENTS = "true";
    expect(shouldSplitSubagents()).toBe(true);
  });

  it("falls back to HERDR_ENV when no override is set", () => {
    delete process.env.HERDR_JEV_SPLIT_SUBAGENTS;

    process.env.HERDR_ENV = "1";
    expect(shouldSplitSubagents()).toBe(true);

    process.env.HERDR_ENV = "0";
    expect(shouldSplitSubagents()).toBe(false);

    delete process.env.HERDR_ENV;
    expect(shouldSplitSubagents()).toBe(false);

    if (origEnv !== undefined) process.env.HERDR_ENV = origEnv;
    else delete process.env.HERDR_ENV;
    if (origSplitEnv !== undefined) process.env.HERDR_JEV_SPLIT_SUBAGENTS = origSplitEnv;
    else delete process.env.HERDR_JEV_SPLIT_SUBAGENTS;
  });

  it("builds inline commands for claude in interactive and non-interactive modes", () => {
    const stage = {
      role: "researcher" as const,
      model: "sonnet-5",
      effort: "standard" as const,
      extraFlags: [],
      description: "researcher",
    };

    const interactiveCmd = buildInlineCommand("claude", stage, "Analyze authentication flow");
    expect(interactiveCmd).toEqual(["claude", "--model", "sonnet-5", "Analyze authentication flow"]);

    const nonInteractiveCmd = buildInlineCommand("claude", stage, "Analyze authentication flow", true);
    expect(nonInteractiveCmd).toEqual(["claude", "-p", "Analyze authentication flow", "--model", "sonnet-5"]);
  });

  it("builds inline commands for codex with extra flags in both modes", () => {
    const stage = {
      role: "implementer" as const,
      model: "gpt-5.6-luna",
      effort: "xhigh" as const,
      extraFlags: ["-c", 'model_reasoning_effort="xhigh"'],
      description: "implementer",
    };

    const interactiveCmd = buildInlineCommand("codex", stage, "Implement API endpoint");
    expect(interactiveCmd).toEqual([
      "codex",
      "--model",
      "gpt-5.6-luna",
      "-c",
      'model_reasoning_effort="xhigh"',
      "Implement API endpoint",
    ]);

    const nonInteractiveCmd = buildInlineCommand("codex", stage, "Implement API endpoint", true);
    expect(nonInteractiveCmd).toEqual([
      "codex",
      "exec",
      "Implement API endpoint",
      "--model",
      "gpt-5.6-luna",
      "-c",
      'model_reasoning_effort="xhigh"',
    ]);
  });

  it("builds inline commands for antigravity in both modes", () => {
    const stage = {
      role: "researcher" as const,
      model: "gemini-3-8-flash",
      effort: "high" as const,
      extraFlags: [],
      description: "researcher",
    };

    const interactiveCmd = buildInlineCommand("antigravity", stage, "Scan repository structure");
    expect(interactiveCmd).toEqual(["agy", "-i", "Scan repository structure"]);

    const nonInteractiveCmd = buildInlineCommand("antigravity", stage, "Scan repository structure", true);
    expect(nonInteractiveCmd).toEqual(["agy", "-p", "Scan repository structure"]);
  });
});

describe("Split Pane Direction: Jev Decision vs Explicit", () => {
  const origDir = process.env.HERDR_JEV_SPLIT_DIRECTION;

  it("prioritizes explicit CLI direction over heuristics and env", () => {
    process.env.HERDR_JEV_SPLIT_DIRECTION = "down";
    expect(resolveSplitDirection("reviewer", undefined, "right")).toBe("right");
    expect(resolveSplitDirection("researcher", undefined, "down")).toBe("down");
  });

  it("respects HERDR_JEV_SPLIT_DIRECTION environment variable", () => {
    process.env.HERDR_JEV_SPLIT_DIRECTION = "down";
    expect(resolveSplitDirection("researcher")).toBe("down");

    process.env.HERDR_JEV_SPLIT_DIRECTION = "right";
    expect(resolveSplitDirection("reviewer")).toBe("right");
  });

  it("uses Jev role heuristics when set to auto or unset", () => {
    delete process.env.HERDR_JEV_SPLIT_DIRECTION;

    expect(resolveSplitDirection("reviewer")).toBe("down");
    expect(resolveSplitDirection("researcher")).toBe("right");
    expect(resolveSplitDirection("implementer")).toBe("right");
    expect(resolveSplitDirection("advisor")).toBe("right");

    if (origDir !== undefined) process.env.HERDR_JEV_SPLIT_DIRECTION = origDir;
    else delete process.env.HERDR_JEV_SPLIT_DIRECTION;
  });
});

describe("Cross-Harness Delegation & Peering Matrix", () => {
  it("defaults to disabled self-only delegation when unset", () => {
    const config = parseCrossHarnessConfig("");
    expect(config.mode).toBe("disabled");
    expect(config.allowedPeers.claude).toEqual(["claude"]);
    expect(config.allowedPeers.codex).toEqual(["codex"]);

    const target = resolveDelegatedClient("claude", "implementer", { config });
    expect(target.client).toBe("claude");
    expect(target.delegated).toBe(false);
  });

  it("parses auto mode and lets Jev select optimal client per role", () => {
    const config = parseCrossHarnessConfig("auto");
    expect(config.mode).toBe("auto");

    const advisorTarget = resolveDelegatedClient("codex", "advisor", { config });
    expect(advisorTarget.client).toBe("claude");
    expect(advisorTarget.delegated).toBe(true);

    const implementerTarget = resolveDelegatedClient("claude", "implementer", { config });
    expect(implementerTarget.client).toBe("codex");
    expect(implementerTarget.delegated).toBe(true);

    const researcherTarget = resolveDelegatedClient("claude", "researcher", { config });
    expect(researcherTarget.client).toBe("antigravity");
    expect(researcherTarget.delegated).toBe(true);
  });

  it("parses peer mapping pairs and enforces delegation boundaries", () => {
    const config = parseCrossHarnessConfig("claude:codex,antigravity;codex:claude");
    expect(config.mode).toBe("mapped");
    expect(config.allowedPeers.claude).toContain("codex");
    expect(config.allowedPeers.claude).toContain("antigravity");
    expect(config.allowedPeers.codex).toContain("claude");
    expect(config.allowedPeers.codex).not.toContain("antigravity");

    const allowed = resolveDelegatedClient("claude", "implementer", {
      explicitTarget: "codex",
      config,
    });
    expect(allowed.client).toBe("codex");
    expect(allowed.delegated).toBe(true);

    const rejected = resolveDelegatedClient("codex", "researcher", {
      explicitTarget: "antigravity",
      config,
    });
    expect(rejected.client).toBe("codex");
    expect(rejected.delegated).toBe(false);
  });

  it("parses JSON peer mappings", () => {
    const jsonStr = JSON.stringify({ claude: ["codex"], codex: ["antigravity"] });
    const config = parseCrossHarnessConfig(jsonStr);
    expect(config.mode).toBe("mapped");
    expect(config.allowedPeers.claude).toContain("codex");
    expect(config.allowedPeers.codex).toContain("antigravity");
  });

  it("plans cross-harness execution stages when enabled", () => {
    const triage = {
      complexity: "architectural" as const,
      confidence: 0.99,
      needsResearch: true,
      effort: "xhigh" as const,
      recommendedPipeline: "triad" as const,
      latencyMs: 250,
      rawAnswers: {},
    };

    const config = parseCrossHarnessConfig("auto");
    const plan = planExecution("Design auth router", "claude", triage, { crossHarness: config });

    expect(plan.stages.length).toBe(3);
    expect(plan.stages[0].role).toBe("advisor");
    expect(plan.stages[0].client).toBe("claude");

    expect(plan.stages[1].role).toBe("implementer");
    expect(plan.stages[1].client).toBe("codex");

    expect(plan.stages[2].role).toBe("reviewer");
    expect(plan.stages[2].client).toBe("codex");
  });

  it("parses JSON array and comma peer lists for universal peering", () => {
    const jsonConfig = parseCrossHarnessConfig('["codex","antigravity"]');
    expect(jsonConfig.mode).toBe("mapped");
    expect(jsonConfig.allowedPeers.claude).toContain("codex");
    expect(jsonConfig.allowedPeers.claude).toContain("antigravity");
    expect(jsonConfig.allowedPeers.codex).toContain("antigravity");

    const commaConfig = parseCrossHarnessConfig("codex,antigravity");
    expect(commaConfig.mode).toBe("mapped");
    expect(commaConfig.allowedPeers.claude).toContain("codex");
    expect(commaConfig.allowedPeers.claude).toContain("antigravity");
  });

  it("cascades to next mapped peer when preferred peer is quota exhausted", () => {
    resetQuotas();
    const config = parseCrossHarnessConfig("claude:codex,antigravity");
    
    // Normal healthy state delegates to codex
    const initial = resolveDelegatedClient("claude", "implementer", { config });
    expect(initial.client).toBe("codex");
    expect(initial.delegated).toBe(true);

    // Exhaust all models in codex implementer chain
    markModelExhausted("codex", "gpt-5.6-luna", 60);
    markModelExhausted("codex", "gpt-5.6-terra", 60);
    expect(isClientExhausted("codex", "implementer")).toBe(true);

    // System must cascade to next healthy peer in mapped array (antigravity)
    const cascaded = resolveDelegatedClient("claude", "implementer", { config });
    expect(cascaded.client).toBe("antigravity");
    expect(cascaded.delegated).toBe(true);
    expect(cascaded.reason).toContain("cascading to next healthy peer antigravity");

    resetQuotas();
  });

  it("safely falls back to source harness when all mapped peers are quota exhausted", () => {
    resetQuotas();
    const config = parseCrossHarnessConfig("claude:codex,antigravity");

    // Exhaust codex and antigravity
    markModelExhausted("codex", "*", 60);
    markModelExhausted("antigravity", "*", 60);
    expect(isClientExhausted("codex", "implementer")).toBe(true);
    expect(isClientExhausted("antigravity", "implementer")).toBe(true);

    // System must safely fall back to source client (claude)
    const fallback = resolveDelegatedClient("claude", "implementer", { config });
    expect(fallback.client).toBe("claude");
    expect(fallback.delegated).toBe(false);
    expect(fallback.reason).toContain("falling back to source harness claude");

    resetQuotas();
  });

  it("cascades to alternative peer or falls back to source when explicit target is quota exhausted", () => {
    resetQuotas();
    const config = parseCrossHarnessConfig("claude:codex,antigravity");

    // Target codex is exhausted
    markModelExhausted("codex", "*", 60);
    const cascaded = resolveDelegatedClient("claude", "implementer", {
      explicitTarget: "codex",
      config,
    });
    expect(cascaded.client).toBe("antigravity");
    expect(cascaded.delegated).toBe(true);
    expect(cascaded.reason).toContain("Explicit target codex quota exhausted: cascading to peer antigravity");

    // All peers exhausted
    markModelExhausted("antigravity", "*", 60);
    const fallback = resolveDelegatedClient("claude", "implementer", {
      explicitTarget: "codex",
      config,
    });
    expect(fallback.client).toBe("claude");
    expect(fallback.delegated).toBe(false);
    expect(fallback.reason).toContain("falling back to source harness claude");

    resetQuotas();
  });
});

describe("Client Aliases & Executable Resolution", () => {
  it("resolves base client kinds from naming heuristics and explicit aliases", () => {
    expect(resolveBaseClientKind("claude")).toBe("claude");
    expect(resolveBaseClientKind("claude-px")).toBe("claude");
    expect(resolveBaseClientKind("fcc-claude")).toBe("claude");
    expect(resolveBaseClientKind("my-codex")).toBe("codex");
    expect(resolveBaseClientKind("agy-proxy")).toBe("antigravity");
    expect(resolveBaseClientKind("cursor-dev")).toBe("cursor");
  });

  it("defaults to safe base binary when aliases are not enabled via env", () => {
    delete process.env.HERDR_JEV_ALLOW_ALIASES;
    delete process.env.HERDR_JEV_ENABLE_ALIASES;
    expect(areAliasesEnabled()).toBe(false);
    expect(resolveClientExecutable("claude")).toBe("claude");
    // Without HERDR_JEV_ALLOW_ALIASES=1, alias resolves to base binary
    expect(resolveClientExecutable("claude-px")).toBe("claude");
    expect(resolveClientExecutable("fcc-claude")).toBe("claude");
  });

  it("enables custom alias binaries when HERDR_JEV_ALLOW_ALIASES=1", () => {
    process.env.HERDR_JEV_ALLOW_ALIASES = "1";
    expect(areAliasesEnabled()).toBe(true);
    expect(resolveClientExecutable("claude-px")).toBe("claude-px");
    expect(resolveClientExecutable("fcc-claude")).toBe("fcc-claude");

    const stage = {
      role: "implementer" as const,
      model: "sonnet-5",
      effort: "high" as const,
      extraFlags: [],
      description: "implementer",
    };
    const cmd = buildAgentCommand("claude-px", stage);
    expect(cmd).toEqual(["claude-px", "--model", "sonnet-5"]);

    delete process.env.HERDR_JEV_ALLOW_ALIASES;
  });

  it("executes standard single-client pipeline (Fable 5 -> Sonnet 5 -> Opus 5) when no env is configured", () => {
    delete process.env.HERDR_JEV_CROSS_HARNESS;
    delete process.env.HERDR_JEV_ALLOW_ALIASES;

    const triage = {
      complexity: "architectural" as const,
      confidence: 0.99,
      needsResearch: false,
      effort: "high" as const,
      recommendedPipeline: "triad" as const,
      latencyMs: 180,
      rawAnswers: {},
    };

    // Standard run with Claude as host and zero custom env vars
    const plan = planExecution("Design notification worker", "claude", triage);

    expect(plan.stages.length).toBe(3);
    // Stage 0: Advisor is Claude with Fable 5
    expect(plan.stages[0].role).toBe("advisor");
    expect(plan.stages[0].client).toBe("claude");
    expect(plan.stages[0].model).toBe("fable-5");

    // Stage 1: Implementer is Claude with Sonnet 5 (1M tokens context)
    expect(plan.stages[1].role).toBe("implementer");
    expect(plan.stages[1].client).toBe("claude");
    expect(plan.stages[1].model).toBe("sonnet-5");

    // Stage 2: Reviewer is Claude with Opus 5
    expect(plan.stages[2].role).toBe("reviewer");
    expect(plan.stages[2].client).toBe("claude");
    expect(plan.stages[2].model).toBe("opus-5");
  });

  it("orchestrates Claude (Fable 5) to AntiGravity (Gemini 3.8 Flash High) with fallback cascade", () => {
    resetQuotas();
    const config = parseCrossHarnessConfig("antigravity");
    const triage = {
      complexity: "architectural" as const,
      confidence: 0.99,
      needsResearch: false,
      effort: "high" as const,
      recommendedPipeline: "triad" as const,
      latencyMs: 200,
      rawAnswers: {},
    };

    // Step 1: Plan execution with Claude as host and AntiGravity as delegated peer
    const plan = planExecution("Implement payment gateway", "claude", triage, { crossHarness: config });

    // Advisor is Claude with Fable 5
    expect(plan.stages[0].role).toBe("advisor");
    expect(plan.stages[0].client).toBe("claude");
    expect(plan.stages[0].model).toBe("fable-5");

    // Implementer is auto-orchestrated to AntiGravity with Gemini 3.8 Flash
    expect(plan.stages[1].role).toBe("implementer");
    expect(plan.stages[1].client).toBe("antigravity");
    expect(plan.stages[1].model).toBe("gemini-3-8-flash");

    // Step 2: Test Level 1 Fallback (Gemini Flash exhausted -> cascades to Gemini Pro)
    markModelExhausted("antigravity", "gemini-3-8-flash", 60);
    const planFallback1 = planExecution("Implement payment gateway", "claude", triage, { crossHarness: config });
    expect(planFallback1.stages[1].client).toBe("antigravity");
    expect(planFallback1.stages[1].model).toBe("gemini-3-8-pro");

    // Step 3: Test Level 1 Fallback step 2 (Gemini Pro exhausted -> cascades to Claude Sonnet 4.6)
    markModelExhausted("antigravity", "gemini-3-8-pro", 60);
    const planFallback2 = planExecution("Implement payment gateway", "claude", triage, { crossHarness: config });
    expect(planFallback2.stages[1].client).toBe("antigravity");
    expect(planFallback2.stages[1].model).toBe("claude-sonnet-4-6");

    // Step 4: Test Level 2 Cross-Harness Fallback (All AntiGravity models exhausted -> safely falls back to Claude Sonnet 5)
    markModelExhausted("antigravity", "claude-sonnet-4-6", 60);
    const planFallbackFinal = planExecution("Implement payment gateway", "claude", triage, { crossHarness: config });
    expect(planFallbackFinal.stages[1].client).toBe("claude");
    expect(planFallbackFinal.stages[1].model).toBe("sonnet-5");

    resetQuotas();
  });
});

describe("Harness & Quota Detection & Auto-Config", () => {
  it("detects installed harnesses and probes available models", async () => {
    const harnesses = await detectInstalledHarnesses();
    expect(Array.isArray(harnesses)).toBe(true);
    expect(harnesses.length).toBe(6);

    const claudeHarness = harnesses.find((h) => h.client === "claude");
    expect(claudeHarness).toBeDefined();
    expect(claudeHarness?.binary).toBe("claude");
    expect(claudeHarness?.installed).toBe(true);
    expect(claudeHarness?.quotaStatus).toBe("healthy");
    expect(claudeHarness?.availableModels.length).toBeGreaterThan(0);

    const kimiHarness = harnesses.find((h) => h.client === "kimi");
    expect(kimiHarness).toBeDefined();
    expect(kimiHarness?.binary).toBe("kimi");
    expect(kimiHarness?.installed).toBe(true);
    expect(kimiHarness?.quotaStatus).toBe("healthy");
    expect(kimiHarness?.availableModels).toContain("kimi-code/k3");
  });

  it("recommends safe zero-config for single or zero healthy harness", () => {
    const single: DetectedHarness[] = [
      {
        client: "claude",
        binary: "claude",
        binaryPath: "/bin/claude",
        installed: true,
        healthy: true,
        quotaStatus: "healthy",
        availableModels: ["fable-5"],
        exhaustedModels: [],
      },
      {
        client: "codex",
        binary: "codex",
        binaryPath: null,
        installed: false,
        healthy: false,
        quotaStatus: "healthy",
        availableModels: [],
        exhaustedModels: [],
      },
    ];

    const rec = recommendConfiguration(single);
    expect(rec.crossHarness).toBe("0");
    expect(rec.healthyClients).toEqual(["claude"]);
    expect(rec.summary).toContain("Single healthy harness detected (claude)");
  });

  it("recommends cross-harness peering when multiple healthy harnesses exist", () => {
    const multiple: DetectedHarness[] = [
      {
        client: "claude",
        binary: "claude",
        binaryPath: "/bin/claude",
        installed: true,
        healthy: true,
        quotaStatus: "healthy",
        availableModels: ["fable-5"],
        exhaustedModels: [],
      },
      {
        client: "antigravity",
        binary: "agy",
        binaryPath: "/bin/agy",
        installed: true,
        healthy: true,
        quotaStatus: "healthy",
        availableModels: ["gemini-3-8-flash"],
        exhaustedModels: [],
      },
    ];

    const rec = recommendConfiguration(multiple);
    expect(rec.crossHarness).toBe("claude,antigravity");
    expect(rec.healthyClients).toEqual(["claude", "antigravity"]);
    expect(rec.summary).toContain("Multiple healthy harnesses detected");
  });

  it("formats harness status into a cleanly aligned text table", () => {
    const dummy: DetectedHarness[] = [
      {
        client: "claude",
        binary: "claude",
        binaryPath: "/bin/claude",
        installed: true,
        healthy: true,
        quotaStatus: "healthy",
        availableModels: ["fable-5", "sonnet-5"],
        exhaustedModels: [],
      },
    ];

    const table = formatHarnessTable(dummy);
    expect(table).toContain("Client");
    expect(table).toContain("Binary");
    expect(table).toContain("Installed");
    expect(table).toContain("Quota Status");
    expect(table).toContain("claude");
    expect(table).toContain("HEALTHY");
  });

  it("writes and updates .env file with recommended configuration", () => {
    const tmp = mkdtempSync(join(tmpdir(), "herdr-jev-autoconfig-"));
    const envFile = join(tmp, ".env");

    const rec = {
      crossHarness: "claude,codex,antigravity",
      splitSubagents: "1",
      splitDirection: "auto",
      allowAliases: "0",
      summary: "Test recommendation",
      healthyClients: ["claude" as const, "codex" as const, "antigravity" as const],
    };

    writeAutoConfigEnv(envFile, rec);

    const content = readFileSync(envFile, "utf-8");
    expect(content).toContain("HERDR_JEV_CROSS_HARNESS=claude,codex,antigravity");
    expect(content).toContain("HERDR_JEV_SPLIT_SUBAGENTS=1");
    expect(content).toContain("HERDR_JEV_SPLIT_DIRECTION=auto");
    expect(content).toContain("HERDR_JEV_ALLOW_ALIASES=0");

    // Clean up
    rmSync(tmp, { recursive: true, force: true });
  });
});






