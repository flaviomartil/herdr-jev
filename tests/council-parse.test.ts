import { describe, expect, it } from "bun:test";
import { parseMemberOutput } from "../src/council/parse.js";

const roots = ["/work/wt"];
const run = (stdout: string, exitCode = 0, stderr = "") => ({ stdout, stderr, exitCode });

describe("council parse", () => {
  it("reads one JSON object per line", () => {
    const stdout = [
      '{"path":"src/a.ts","line":3,"severity":"high","title":"Null deref","detail":"guard it"}',
      '{"path":"/work/wt/src/b.ts","severity":"low","title":"Nit","detail":""}',
    ].join("\n");
    const parsed = parseMemberOutput("kimi", run(stdout), roots);
    expect("findings" in parsed && parsed.findings).toEqual([
      { member: "kimi", path: "src/a.ts", line: 3, severity: "high", title: "Null deref", detail: "guard it" },
      { member: "kimi", path: "src/b.ts", severity: "low", title: "Nit", detail: "" },
    ]);
  });

  it("turns prose into one finding", () => {
    const parsed = parseMemberOutput("kimi", run("Looks risky around the retry loop.\nConsider a cap."), roots);
    expect("findings" in parsed && parsed.findings).toHaveLength(1);
    if ("findings" in parsed) {
      expect(parsed.findings[0].detail).toContain("retry loop");
      expect(parsed.findings[0].member).toBe("kimi");
    }
  });

  it("treats NO_FINDINGS as none", () => {
    expect(parseMemberOutput("kimi", run("NO_FINDINGS\n"), roots)).toEqual({ findings: [] });
  });

  it("fails on malformed JSON lines without inventing findings", () => {
    const parsed = parseMemberOutput("kimi", run('{"path": "a.ts", "title": \n{oops'), roots);
    expect("error" in parsed).toBe(true);
  });

  it("keeps readable lines and notes unreadable ones", () => {
    const stdout = ['{"path":"a.ts","title":"Real","severity":"medium","detail":"d"}', "{broken"].join("\n");
    const parsed = parseMemberOutput("kimi", run(stdout), roots);
    expect("findings" in parsed && parsed.findings).toHaveLength(1);
    expect("note" in parsed && parsed.note).toContain("1 unreadable");
  });

  it("fails on a non zero exit with the last stderr line", () => {
    const parsed = parseMemberOutput("codex", run("", 2, "boot\nauth required"), roots);
    expect(parsed).toEqual({ error: "codex: exit 2: auth required" });
  });

  it("fails on empty output", () => {
    expect("error" in parseMemberOutput("kimi", run("  \n"), roots)).toBe(true);
  });

  it("reads the codex review block format and relativises paths", () => {
    const stdout = ["- [P1] Missing await — /work/wt/src/a.ts:12-14", "  The promise is dropped.", "  Await it.", "- [P3] Naming — /work/wt/src/b.ts:2-2", "  Rename."].join("\n");
    const parsed = parseMemberOutput("codex", run(stdout), roots);
    expect("findings" in parsed && parsed.findings).toEqual([
      { member: "codex", path: "src/a.ts", line: 12, severity: "high", title: "Missing await", detail: "The promise is dropped.\nAwait it." },
      { member: "codex", path: "src/b.ts", line: 2, severity: "low", title: "Naming", detail: "Rename." },
    ]);
  });

  it("unwraps the agy json envelope", () => {
    const inner = '{"path":"src/a.ts","line":1,"severity":"medium","title":"T","detail":"D"}';
    const parsed = parseMemberOutput("antigravity", run(JSON.stringify({ result: inner })), roots);
    expect("findings" in parsed && parsed.findings).toEqual([{ member: "antigravity", path: "src/a.ts", line: 1, severity: "medium", title: "T", detail: "D" }]);
  });

  it("reads an agy findings array and a NO_FINDINGS envelope", () => {
    const array = JSON.stringify({ findings: [{ path: "x.ts", title: "A", severity: "high", detail: "" }] });
    const parsed = parseMemberOutput("antigravity", run(array), roots);
    expect("findings" in parsed && parsed.findings).toHaveLength(1);
    expect(parseMemberOutput("antigravity", run(JSON.stringify({ response: "NO_FINDINGS" })), roots)).toEqual({ findings: [] });
  });

  it("fails on a truncated agy envelope and on an envelope without text", () => {
    expect("error" in parseMemberOutput("antigravity", run('{"result": "abc'), roots)).toBe(true);
    expect("error" in parseMemberOutput("antigravity", run('{"status":"ok"}'), roots)).toBe(true);
  });
});
