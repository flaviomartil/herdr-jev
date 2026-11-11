import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAPABILITY_TAGS,
  detectCwdCapabilityTags,
  keywordCapabilityTags,
  resolveCapabilityTags,
  triageCapabilityTags,
} from "../src/triage/mcp-profile.js";
import { createTempHome } from "./helpers.js";

describe("mcp-profile capability tags", () => {
  it("keeps the vocabulary unique and kebab-case", () => {
    expect(new Set(CAPABILITY_TAGS).size).toBe(CAPABILITY_TAGS.length);
    for (const tag of CAPABILITY_TAGS) expect(tag).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it("maps task keywords to tags, ignoring case and accents", () => {
    expect(keywordCapabilityTags("Pesquise a documentação do Playwright e gere screenshot da tela de login"))
      .toEqual(["context", "docs", "design", "browser"]);
    expect(keywordCapabilityTags("DASHBOARD de KPI e métricas")).toEqual(["bi"]);
    expect(keywordCapabilityTags("Treinar LoRA em GPU")).toEqual(["cloud-gpu"]);
    expect(keywordCapabilityTags("Lembrar a decisão de arquitetura da sessão anterior")).toEqual(["memory", "context"]);
    expect(keywordCapabilityTags("Enviar mensagem ao cliente pelo chat")).toEqual(["messaging"]);
  });

  it("returns no tags for a plain edit", () => {
    expect(keywordCapabilityTags("Ajuste o typo no README da pasta")).toEqual([]);
  });

  it("derives tags from triage research and effort", () => {
    expect(triageCapabilityTags({ needsResearch: true, effort: "high" })).toEqual(["context", "reasoning"]);
    expect(triageCapabilityTags({ needsResearch: false, effort: "xhigh" })).toEqual(["reasoning"]);
    expect(triageCapabilityTags({ needsResearch: false, effort: "standard" })).toEqual([]);
  });

  it("detects top-level markers in the working directory only", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-jev-mcp-profile-"));
    try {
      writeFileSync(join(dir, "playwright.config.ts"), "");
      writeFileSync(join(dir, "report.pbix"), "");
      expect(detectCwdCapabilityTags(dir)).toEqual(["browser", "bi"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(detectCwdCapabilityTags(join(dir, "missing"))).toEqual([]);
  });

  it("unions sources into a deduplicated vocabulary-ordered list", () => {
    expect(resolveCapabilityTags({
      task: "Pesquise a documentação e teste no browser",
      decision: { needsResearch: true, effort: "high" },
      cwdTags: ["browser", "context"],
    })).toEqual(["context", "docs", "browser", "reasoning"]);
    expect(resolveCapabilityTags({})).toEqual([]);
  });

  it("prints tags from the CLI in offline mode without network", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-jev-mcp-profile-cli-"));
    try {
      writeFileSync(join(dir, "playwright.config.ts"), "");
      const cli = join(import.meta.dir, "../src/cli.ts");
      const run = Bun.spawnSync([process.execPath, cli, "mcp-profile", "--task", "Pesquise a documentação", "--cwd", dir, "--offline", "--json"], {
        env: { ...process.env, HOME: createTempHome(), TYPESAFE_API_KEY: "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(run.exitCode).toBe(0);
      const parsed = JSON.parse(run.stdout.toString());
      expect(parsed.tags).toEqual(["context", "docs", "browser"]);
      expect(parsed.triage.fallback).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
