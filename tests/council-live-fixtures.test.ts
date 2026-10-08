import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseMemberOutput, type ParseResult } from "../src/council/parse.js";
import type { CouncilMemberName } from "../src/council/types.js";

const DIR = join(import.meta.dir, "fixtures", "council");
const roots = ["/tmp/review"];

function capture(name: string): { exitCode: number; stdout: string; stderr: string } {
  const raw = readFileSync(join(DIR, `${name}.txt`), "utf8");
  const [head = "", rest = ""] = raw.split("\n--- stdout ---\n");
  const [stdout = "", stderr = ""] = rest.split("\n--- stderr ---\n");
  return { exitCode: Number(head.replace("exit: ", "").trim()), stdout, stderr };
}

function parse(member: CouncilMemberName, name: string, question = false): ParseResult {
  return parseMemberOutput(member, capture(name), roots, { question });
}

function findingsOf(result: ParseResult) {
  if (!("findings" in result)) throw new Error(`expected findings, got ${result.error}`);
  return result.findings;
}

function errorOf(result: ParseResult): string {
  if (!("error" in result)) throw new Error("expected an error");
  return result.error;
}

describe("council live captures: codex", () => {
  it("maps the planted null dereference to src/user.ts:18", () => {
    const [finding, ...others] = findingsOf(parse("codex", "codex-planted"));
    expect(others).toHaveLength(0);
    expect(finding).toMatchObject({ member: "codex", path: "src/user.ts", line: 18, severity: "medium" });
    expect(finding?.title).toContain("missing user");
  });

  it("maps the same review when a question sent the prompt on stdin", () => {
    const [finding, ...others] = findingsOf(parse("codex", "codex-question", true));
    expect(others).toHaveLength(0);
    expect(finding).toMatchObject({ path: "src/user.ts", line: 18 });
  });

  it("keeps a no-findings review as a note without a finding", () => {
    const parsed = parse("codex", "codex-clean");
    expect(findingsOf(parsed)).toEqual([]);
    expect("note" in parsed && parsed.note).toContain("nenhum defeito");
  });

  it("reports the 401 line when the login is missing", () => {
    expect(errorOf(parse("codex", "codex-auth"))).toContain("401 Unauthorized");
  });
});

describe("council live captures: kimi", () => {
  it("keeps both findings when the first line carries a bullet marker", () => {
    const findings = findingsOf(parse("kimi", "kimi-planted"));
    expect(findings.map((finding) => [finding.path, finding.severity])).toEqual([
      ["src/user.ts", "high"],
      ["src/user.ts", "medium"],
    ]);
    expect(findings[0]?.title).toContain("Null deref");
  });

  it("reads four findings after the hook banner", () => {
    expect(findingsOf(parse("kimi", "kimi-question", true))).toHaveLength(4);
  });

  it("maps a bulleted NO_FINDINGS to zero findings", () => {
    expect(findingsOf(parse("kimi", "kimi-clean"))).toEqual([]);
  });

  it("reports the error line instead of the trailing log hint", () => {
    expect(errorOf(parse("kimi", "kimi-auth"))).toContain("No model configured");
  });
});

describe("council live captures: antigravity", () => {
  it("reads structured_output when the response text holds two JSON lines", () => {
    const findings = findingsOf(parse("antigravity", "agy-planted"));
    expect(findings.map((finding) => [finding.path, finding.line, finding.severity])).toEqual([
      ["src/user.ts", 18, "high"],
      ["src/user.ts", 13, "medium"],
    ]);
  });

  it("reads a single-line response with a trailing tool summary", () => {
    expect(findingsOf(parse("antigravity", "agy-question"))).toHaveLength(2);
  });

  it("maps an empty findings envelope to zero findings", () => {
    expect(findingsOf(parse("antigravity", "agy-clean"))).toEqual([]);
  });

  it("fails on the authentication error envelope", () => {
    expect(errorOf(parse("antigravity", "agy-auth"))).toContain("authentication failed");
  });

  it("fails on an ERROR status envelope even with exit 0", () => {
    const captured = capture("agy-timeout");
    const result = parseMemberOutput("antigravity", { ...captured, exitCode: 0 }, roots);
    expect(errorOf(result)).toContain("interrupted");
  });

  it("fails on the interrupted envelope with a nonzero exit", () => {
    expect(errorOf(parse("antigravity", "agy-timeout"))).toContain("interrupted");
  });
});
