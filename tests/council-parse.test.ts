import { describe, expect, it } from "bun:test";
import { parseMemberOutput, relativePath } from "../src/council/parse.js";

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

  it("turns kimi prose into one finding", () => {
    const parsed = parseMemberOutput("kimi", run("Looks risky around the retry loop.\nConsider a cap."), roots);
    expect("findings" in parsed && parsed.findings).toHaveLength(1);
    if ("findings" in parsed) expect(parsed.findings[0].detail).toContain("retry loop");
  });

  it("accepts NO_FINDINGS as the last line, with or without a period", () => {
    expect(parseMemberOutput("kimi", run("NO_FINDINGS\n"), roots)).toEqual({ findings: [] });
    expect(parseMemberOutput("kimi", run("I checked the diff.\nNO_FINDINGS.\n"), roots)).toEqual({ findings: [] });
    const notLast = parseMemberOutput("kimi", run("NO_FINDINGS\nbut there is a bug in a.ts"), roots);
    expect("findings" in notLast && notLast.findings).toHaveLength(1);
  });

  it("fails on malformed JSON lines without inventing findings", () => {
    expect("error" in parseMemberOutput("kimi", run('{"path": "a.ts", "title": \n{oops'), roots)).toBe(true);
  });

  it("keeps readable lines and notes unreadable ones", () => {
    const stdout = ['{"path":"a.ts","title":"Real","severity":"medium","detail":"d"}', "{broken"].join("\n");
    const parsed = parseMemberOutput("kimi", run(stdout), roots);
    expect("findings" in parsed && parsed.findings).toHaveLength(1);
    expect("note" in parsed && parsed.note).toContain("1 unreadable");
  });

  it("fails on a non zero exit with the last stderr line", () => {
    expect(parseMemberOutput("codex", run("", 2, "boot\nauth required"), roots)).toEqual({ error: "codex: exit 2: auth required" });
  });

  it("fails on empty output", () => {
    expect("error" in parseMemberOutput("kimi", run("  \n"), roots)).toBe(true);
  });

  it("reads the codex review block format and relativises paths", () => {
    const stdout = ["- [P1] Missing await \u2014 /work/wt/src/a.ts:12-14", "  The promise is dropped.", "  Await it.", "- [P3] Naming \u2014 /work/wt/src/b.ts:2-2", "  Rename."].join("\n");
    const parsed = parseMemberOutput("codex", run(stdout), roots);
    expect("findings" in parsed && parsed.findings).toEqual([
      { member: "codex", path: "src/a.ts", line: 12, severity: "high", title: "Missing await", detail: "The promise is dropped.\nAwait it." },
      { member: "codex", path: "src/b.ts", line: 2, severity: "low", title: "Naming", detail: "Rename." },
    ]);
  });

  it("keeps codex prose in a note, not in a finding", () => {
    const parsed = parseMemberOutput("codex", run("The patch looks fine to me.\n"), roots);
    expect(parsed).toEqual({ findings: [], note: "The patch looks fine to me." });
  });

  it("treats codex prose as an answer when a question was asked", () => {
    const parsed = parseMemberOutput("codex", run("Yes, it is safe because of the guard."), roots, { question: true });
    expect("findings" in parsed && parsed.findings).toHaveLength(1);
  });

  it("unwraps the agy json envelope", () => {
    const inner = '{"path":"src/a.ts","line":1,"severity":"medium","title":"T","detail":"D"}';
    const parsed = parseMemberOutput("antigravity", run(JSON.stringify({ result: inner })), roots);
    expect("findings" in parsed && parsed.findings).toEqual([{ member: "antigravity", path: "src/a.ts", line: 1, severity: "medium", title: "T", detail: "D" }]);
  });

  it("reads an agy findings object, inside or outside the envelope", () => {
    const body = { findings: [{ path: "x.ts", title: "A", severity: "high", detail: "" }] };
    const direct = parseMemberOutput("antigravity", run(JSON.stringify(body)), roots);
    expect("findings" in direct && direct.findings).toHaveLength(1);
    const wrapped = parseMemberOutput("antigravity", run(JSON.stringify({ result: JSON.stringify(body) })), roots);
    expect("findings" in wrapped && wrapped.findings).toHaveLength(1);
    expect(parseMemberOutput("antigravity", run(JSON.stringify({ result: '{"findings":[]}' })), roots)).toEqual({ findings: [] });
    expect(parseMemberOutput("antigravity", run(JSON.stringify({ response: "NO_FINDINGS" })), roots)).toEqual({ findings: [] });
  });

  it("fails on an agy error envelope", () => {
    const flagged = parseMemberOutput("antigravity", run(JSON.stringify({ is_error: true, result: "quota exceeded" })), roots);
    expect(flagged).toEqual({ error: "antigravity: quota exceeded" });
    const withField = parseMemberOutput("antigravity", run(JSON.stringify({ error: "not signed in" })), roots);
    expect(withField).toEqual({ error: "antigravity: not signed in" });
  });

  it("accepts an object with findings under result and fails on any other object", () => {
    const body = { findings: [{ path: "x.ts", title: "A", severity: "high", detail: "d" }] };
    const nested = parseMemberOutput("antigravity", run(JSON.stringify({ result: body })), roots);
    expect("findings" in nested && nested.findings).toHaveLength(1);
    expect(parseMemberOutput("antigravity", run(JSON.stringify({ result: { findings: [] } })), roots)).toEqual({ findings: [] });
    expect("error" in parseMemberOutput("antigravity", run(JSON.stringify({ result: { plan: "step 1" } })), roots)).toBe(true);
    expect("error" in parseMemberOutput("antigravity", run(JSON.stringify({ result: { findings: [{ nope: 1 }] } })), roots)).toBe(true);
  });

  it("fails on agy inner text that is neither findings nor NO_FINDINGS", () => {
    const parsed = parseMemberOutput("antigravity", run(JSON.stringify({ result: "I looked at the diff and it seems fine." })), roots);
    expect("error" in parsed).toBe(true);
  });

  it("does not read an envelope as a finding", () => {
    const parsed = parseMemberOutput("antigravity", run(JSON.stringify({ path: "a.ts", title: "T", severity: "high", detail: "d" })), roots);
    expect("error" in parsed).toBe(true);
  });

  it("fails on a truncated agy envelope and on an envelope without text", () => {
    expect("error" in parseMemberOutput("antigravity", run('{"result": "abc'), roots)).toBe(true);
    expect("error" in parseMemberOutput("antigravity", run('{"status":"ok"}'), roots)).toBe(true);
  });
});

describe("council relativePath", () => {
  it("strips the root and normalises", () => {
    expect(relativePath("/work/wt/src/./a.ts", roots)).toBe("src/a.ts");
    expect(relativePath("src//b.ts", roots)).toBe("src/b.ts");
  });

  it("blanks absolute and escaping paths", () => {
    expect(relativePath("/etc/passwd", roots)).toBe("");
    expect(relativePath("../outside.ts", roots)).toBe("");
    expect(relativePath("src/../../outside.ts", roots)).toBe("");
    expect(relativePath("C:\\Windows\\x", roots)).toBe("");
  });
});
