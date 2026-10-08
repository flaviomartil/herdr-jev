import { describe, expect, it } from "bun:test";
import { commandOf, MEMBER_BINARIES, NO_FINDINGS, promptOf } from "../src/council/members.js";

describe("council members argv", () => {
  const input = { diff: "diff --git a/x b/x\n+1\n" };

  it("runs codex as exec review over the uncommitted tree", () => {
    expect(commandOf("codex", input, "/p/prompt.md", 480000).argv).toEqual(["codex", "exec", "review", "--uncommitted", "--ephemeral"]);
  });

  it("sends a codex question through stdin", () => {
    const command = commandOf("codex", { ...input, question: "is it safe?" }, "/p/prompt.md", 480000);
    expect(command.argv).toEqual(["codex", "exec", "review", "--ephemeral", "-"]);
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

  it("runs agy in plan mode, sandboxed, json, with a print timeout", () => {
    const command = commandOf("antigravity", input, "/p/prompt.md", 480000);
    expect(command.argv[0]).toBe("agy");
    expect(command.argv[1]).toBe("--print");
    expect(command.argv[2]).toContain("/p/prompt.md");
    expect(command.argv.slice(3)).toEqual(["--mode", "plan", "--sandbox", "--output-format", "json", "--print-timeout", "480s"]);
  });

  it("keeps a large diff out of argv", () => {
    const big = { diff: "+".repeat(250_000) };
    for (const name of ["codex", "kimi", "antigravity"] as const) {
      const command = commandOf(name, big, "/p/prompt.md", 1000);
      expect(command.argv.join(" ").length).toBeLessThan(2000);
    }
  });

  it("maps antigravity to the agy binary", () => {
    expect(MEMBER_BINARIES.antigravity).toBe("agy");
  });

  it("states the answer format in the prompt", () => {
    expect(promptOf(input)).toContain(NO_FINDINGS);
  });
});
