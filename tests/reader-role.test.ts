import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { loadBaseCatalog, validateCatalog } from "../src/config/catalog.js";
import { resetHarnessCaches } from "../src/harness/bridge.js";
import { buildAgentCommand, buildInlineCommand, readonlyReviewerArgs } from "../src/herdr/launcher.js";
import { resolvePeerStage } from "../src/herdr/peer.js";
import { resolveStageSpec } from "../src/pipelines/matrix.js";
import { ROLE_KINDS, type StageSpec } from "../src/types/index.js";
import { createFakeHarness, type FakeHarness } from "./fake-harness.js";

const CLAUDE_BYPASS = "--dangerously-skip-permissions";
const HAIKU = "claude-haiku-4-5-20251001";

function readerStage(model: string): StageSpec {
  return { role: "reader", model, effort: "standard", extraFlags: [], description: "synthetic" };
}

let harness: FakeHarness | undefined;

beforeEach(() => {
  resetHarnessCaches();
});

afterEach(() => {
  harness?.restore();
  harness = undefined;
  resetHarnessCaches();
});

describe("reader role", () => {
  it("resolves for claude with Haiku 4.5 at standard effort", () => {
    const spec = resolveStageSpec("claude", "reader");
    expect(spec.role).toBe("reader");
    expect(spec.model).toBe(HAIKU);
    expect(spec.effort).toBe("standard");
    expect(loadBaseCatalog().clients.claude!.reader.fallbackChain).toEqual([HAIKU, "sonnet-5"]);
  });

  it("resolves for every catalog client", () => {
    for (const client of Object.keys(loadBaseCatalog().clients)) {
      expect(resolveStageSpec(client, "reader").role).toBe("reader");
    }
  });

  it("applies the reviewer read-only args and never bypass args", () => {
    harness = createFakeHarness("contract");
    const readonly = readonlyReviewerArgs("claude", readerStage(HAIKU));
    expect(readonly.length).toBeGreaterThan(0);
    const agent = buildAgentCommand("claude", readerStage(HAIKU));
    const inline = buildInlineCommand("claude", readerStage(HAIKU), "read", true);
    for (const argv of [agent, inline]) {
      expect(argv).not.toContain(CLAUDE_BYPASS);
      expect(argv.slice(-readonly.length)).toEqual(readonly);
    }
  });

  it("asks the harness for the researcher role and applies read-only args with strict MCP", () => {
    harness = createFakeHarness("contract", { FAKE_READONLY_CLAUDE: "--tools Read,Glob,Grep --strict-mcp-config" });
    const agent = buildAgentCommand("claude", readerStage(HAIKU));
    const inline = buildInlineCommand("claude", readerStage(HAIKU), "read", true);
    const calls = harness.callsFor("model-resolve");
    expect(calls.length).toBeGreaterThan(0);
    for (const argv of calls) {
      expect(argv[argv.indexOf("--role") + 1]).toBe("researcher");
      expect(argv).not.toContain("reader");
    }
    for (const argv of [agent, inline]) {
      expect(argv).toContain("--strict-mcp-config");
      expect(argv).not.toContain(CLAUDE_BYPASS);
    }
  });
});

describe("reader peer", () => {
  it("keeps the catalog effort for a same-client reader instead of the triage effort", async () => {
    const prompt = "Ler a arquitetura do modulo";
    const researcher = await resolvePeerStage({ source: "claude", target: "claude", role: "researcher", prompt });
    expect(researcher.stage.effort).toBe(researcher.triage.effort);
    const reader = await resolvePeerStage({ source: "claude", target: "claude", role: "reader", prompt });
    expect(reader.stage.role).toBe("reader");
    expect(reader.stage.effort).toBe("standard");
    const explicit = await resolvePeerStage({ source: "claude", target: "claude", role: "reader", prompt, effort: "high" });
    expect(explicit.stage.effort).toBe("high");
  });
});

describe("catalog validation", () => {
  it("accepts the shipped catalog", () => {
    expect(() => validateCatalog(loadBaseCatalog())).not.toThrow();
  });

  it("throws naming client and role when a role is missing", () => {
    for (const role of ROLE_KINDS) {
      const catalog = structuredClone(loadBaseCatalog());
      delete (catalog.clients.codex as Partial<Record<string, unknown>>)[role];
      expect(() => validateCatalog(catalog)).toThrow(`codex/${role}`);
    }
  });

  it("throws naming client and role when a field is invalid", () => {
    const noModel = structuredClone(loadBaseCatalog());
    (noModel.clients.claude!.reader as { model?: string }).model = "";
    expect(() => validateCatalog(noModel)).toThrow("claude/reader requires a model");
    const noChain = structuredClone(loadBaseCatalog());
    (noChain.clients.kimi!.reviewer as { fallbackChain?: unknown }).fallbackChain = undefined;
    expect(() => validateCatalog(noChain)).toThrow("kimi/reviewer requires a nonempty fallbackChain");
    const badEffort = structuredClone(loadBaseCatalog());
    (badEffort.clients.cursor!.advisor as { defaultEffort?: string }).defaultEffort = "max";
    expect(() => validateCatalog(badEffort)).toThrow("cursor/advisor requires defaultEffort");
  });

  it("throws naming client and role when extraFlags is not an array of strings", () => {
    const missing = structuredClone(loadBaseCatalog());
    delete (missing.clients.claude!.reader as { extraFlags?: unknown }).extraFlags;
    expect(() => validateCatalog(missing)).toThrow("claude/reader requires extraFlags");
    const mixed = structuredClone(loadBaseCatalog());
    (mixed.clients.codex!.advisor as { extraFlags?: unknown }).extraFlags = ["--ok", 3];
    expect(() => validateCatalog(mixed)).toThrow("codex/advisor requires extraFlags");
  });
});
