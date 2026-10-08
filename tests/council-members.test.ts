import { describe, expect, it } from "bun:test";
import { AGY_FINDINGS_SCHEMA, commandOf, MEMBER_BINARIES, NO_FINDINGS, promptOf, VERSION_SIGNATURES } from "../src/council/members.js";

describe("council members argv", () => {
  const input = { diff: "diff --git a/x b/x\n+1\n" };

  it("runs codex as a read only exec review over the uncommitted tree", () => {
    expect(commandOf("codex", input, "/p/prompt.md", 480000).argv).toEqual(["codex", "exec", "review", "-c", 'sandbox_mode="read-only"', "--uncommitted", "--ephemeral"]);
  });

  it("sends a codex question through stdin", () => {
    const command = commandOf("codex", { ...input, question: "is it safe?" }, "/p/prompt.md", 480000);
    expect(command.argv).toEqual(["codex", "exec", "review", "-c", 'sandbox_mode="read-only"', "--ephemeral", "-"]);
    expect(command.stdin).toContain("is it safe?");
    expect(command.stdin).toContain("diff --git a/x b/x");
  });

  it("points kimi at the prompt file with text output", () => {
    const command = commandOf("kimi", input, "/p/prompt.md", 480000);
    expect(command.argv[0]).toBe("kimi");
    expect(command.argv[1]).toBe("-p");
    expect(command.argv[2]).toContain("/p/prompt.md");
    expect(command.argv.slice(3)).toEqual(["--output-format", "text"]);
    expect(command.argv).not.toContain("--plan");
    expect(command.promptFile).toContain("diff --git a/x b/x");
  });

  it("runs agy in plan mode, sandboxed, json, with a schema and a print timeout", () => {
    const command = commandOf("antigravity", input, "/p/prompt.md", 480000);
    expect(command.argv[0]).toBe("agy");
    expect(command.argv[1]).toBe("--print");
    expect(command.argv[2]).toContain("/p/prompt.md");
    expect(command.argv.slice(3)).toEqual(["--mode", "plan", "--sandbox", "--output-format", "json", "--json-schema", AGY_FINDINGS_SCHEMA, "--print-timeout", "480s"]);
    expect(JSON.parse(AGY_FINDINGS_SCHEMA).properties.findings.type).toBe("array");
    expect(command.promptFile).toContain('{"findings":[]}');
  });

  it("keeps a large diff out of argv", () => {
    const big = { diff: "+".repeat(250_000) };
    for (const name of ["codex", "kimi", "antigravity"] as const) {
      const command = commandOf(name, big, "/p/prompt.md", 1000);
      expect(command.argv.join(" ").length).toBeLessThan(3000);
    }
  });

  it("cuts a diff past the cap and says so", () => {
    const prompt = promptOf({ diff: "x".repeat(400_000) });
    expect(prompt).toContain("[council: diff cut at 300000 of 400000 characters]");
    expect(prompt.length).toBeLessThan(310_000);
  });

  it("maps antigravity to the agy binary", () => {
    expect(MEMBER_BINARIES.antigravity).toBe("agy");
  });

  it("states the answer format in the prompt", () => {
    expect(promptOf(input)).toContain(NO_FINDINGS);
  });

  it("matches only the expected version signatures", () => {
    expect(VERSION_SIGNATURES.codex.test("codex-cli 0.160.1")).toBe(true);
    expect(VERSION_SIGNATURES.codex.test("1.2.3")).toBe(false);
    expect(VERSION_SIGNATURES.kimi.test("2.1.1")).toBe(true);
    expect(VERSION_SIGNATURES.kimi.test("kimi 2.1.1")).toBe(false);
    expect(VERSION_SIGNATURES.antigravity.test("1.3.1")).toBe(true);
  });
});
