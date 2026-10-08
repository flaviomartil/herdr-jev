import { describe, expect, test } from "bun:test";
import { JevError } from "../src/triage/jev-client.js";
import { synthesize } from "../src/council/synth.js";
import { fakeJev, finding } from "./council-synth-support.js";

const titles = (item: { findings: { title: string }[] }) => item.findings.map((f) => f.title).sort();

describe("council synth clustering", () => {
  test("links a later finding to an earlier one from another member", async () => {
    const jev = fakeJev({ same: (t) => (t === "B" ? "A" : "new") });
    const out = await synthesize(
      [finding("A", "codex"), finding("B", "kimi"), finding("C", "codex", { path: "src/c.ts" })],
      { jev },
    );
    expect(out.scoredBy).toBe("jev");
    expect(out.agreements).toHaveLength(1);
    expect(out.agreements[0]!.members).toEqual(["codex", "kimi"]);
    expect(out.agreements[0]!.real).toBeCloseTo(0.9);
    expect(out.agreements[0]!.contradictionChecked).toBe(true);
    expect(out.unique.map((u) => u.text)).toEqual(["C"]);
    expect(out.disagreements).toHaveLength(0);
  });

  test("chains merge transitively", async () => {
    const jev = fakeJev({ same: (t) => (t === "B" ? "A" : t === "C" ? "B" : "new") });
    const out = await synthesize(
      [finding("A", "codex"), finding("B", "kimi"), finding("C", "antigravity")],
      { jev },
    );
    expect(out.agreements).toHaveLength(1);
    expect(out.agreements[0]!.members).toEqual(["antigravity", "codex", "kimi"]);
    expect(titles(out.agreements[0]!)).toEqual(["A", "B", "C"]);
    expect(out.unique).toHaveLength(0);
  });

  test("a link to a finding other than the first merges only with that one", async () => {
    const jev = fakeJev({ same: (t) => (t === "C" ? "B" : "new") });
    const out = await synthesize(
      [finding("A", "codex"), finding("B", "kimi"), finding("C", "antigravity")],
      { jev },
    );
    expect(out.agreements).toHaveLength(1);
    expect(titles(out.agreements[0]!)).toEqual(["B", "C"]);
    expect(out.unique.map((u) => u.text)).toEqual(["A"]);
  });

  test("a later request still sees the earlier findings it can link to", async () => {
    const list = [
      ...Array.from({ length: 8 }, (_, i) => finding(`T${i}`, "codex", { path: `src/f${i}.ts` })),
      finding("K", "kimi", { path: "src/k.ts" }),
    ];
    const jev = fakeJev({ same: (t) => (t === "T7" ? "K" : "new") });
    const out = await synthesize(list, { jev });
    expect(jev.calls.length).toBeGreaterThan(1);
    expect(out.agreements).toHaveLength(1);
    expect(titles(out.agreements[0]!)).toEqual(["K", "T7"]);
  });

  test("groups are built from the scoring order, not the input order", async () => {
    const input = [
      finding("L1", "codex", { severity: "low", path: "src/l.ts" }),
      finding("H1", "kimi", { severity: "high", path: "src/h.ts" }),
      finding("H2", "codex", { severity: "high", path: "src/h2.ts" }),
    ];
    const jev = fakeJev({ same: (t) => (t === "H2" ? "H1" : "new") });
    const out = await synthesize(input, { jev });
    expect(out.agreements).toHaveLength(1);
    expect(titles(out.agreements[0]!)).toEqual(["H1", "H2"]);
    expect(out.agreements[0]!.members).toEqual(["codex", "kimi"]);
    expect(out.unique.map((u) => u.text)).toEqual(["L1"]);
  });

  test("same member duplicates collapse into one unique item", async () => {
    const jev = fakeJev({ same: (t) => (t === "B" ? "A" : "new") });
    const out = await synthesize([finding("A", "codex"), finding("B", "codex")], { jev });
    expect(out.agreements).toHaveLength(0);
    expect(out.unique).toHaveLength(1);
    expect(out.unique[0]!.findings).toHaveLength(2);
  });

  test("contradicting group becomes a disagreement and keeps both sides", async () => {
    const jev = fakeJev({ same: (t) => (t === "B" ? "A" : "new"), contradict: () => 0.8 });
    const out = await synthesize([finding("A", "codex"), finding("B", "kimi")], { jev });
    expect(out.agreements).toHaveLength(0);
    expect(out.disagreements).toHaveLength(1);
    expect(out.disagreements[0]!.text).toBe("codex: A vs kimi: B");
    expect(out.disagreements[0]!.contradictionChecked).toBe(true);
  });

  test("round 2 is skipped when no group has more than one member", async () => {
    const jev = fakeJev();
    await synthesize([finding("A", "codex"), finding("B", "kimi")], { jev });
    expect(jev.calls.every((c) => !Object.keys(c.questions).some((k) => k.startsWith("contradict::")))).toBe(
      true,
    );
  });

  test("round 2 asks with the full backticked path of the group", async () => {
    const jev = fakeJev({ same: (t) => (t === "B" ? "A" : "new") });
    await synthesize([finding("A", "codex"), finding("B", "kimi")], { jev });
    const round2 = jev.calls.find((c) => Object.keys(c.questions).some((k) => k.startsWith("contradict::")))!;
    const q = Object.values(round2.questions)[0] as any;
    expect(q.instructions ?? q.question ?? JSON.stringify(q)).toContain("`groups.g0`");
  });

  test("a low-rated member stays in its group: one two-member item", async () => {
    const jev = fakeJev({
      real: (t) => (t === "B" ? 0.1 : 0.9),
      same: (t) => (t === "B" ? "A" : "new"),
    });
    const out = await synthesize([finding("A", "codex"), finding("B", "kimi")], { jev });
    expect(out.notes).toHaveLength(0);
    expect(out.agreements).toHaveLength(1);
    expect(out.agreements[0]!.members).toEqual(["codex", "kimi"]);
    expect(out.agreements[0]!.real).toBeCloseTo(0.5);
  });

  test("a dissenting low-rated finding reaches round 2 and yields a disagreement", async () => {
    const jev = fakeJev({
      real: (t) => (t === "B" ? 0.05 : 0.9),
      same: (t) => (t === "B" ? "A" : "new"),
      contradict: (ts) => (ts.includes("A") && ts.includes("B") ? 0.9 : 0.1),
    });
    const out = await synthesize([finding("A", "codex"), finding("B", "kimi")], { jev });
    expect(out.disagreements).toHaveLength(1);
    expect(titles(out.disagreements[0]!)).toEqual(["A", "B"]);
    expect(out.notes).toHaveLength(0);
  });

  test("a group goes to notes only when every finding in it is below the threshold", async () => {
    const jev = fakeJev({
      real: (t) => (t === "A" || t === "B" ? 0.1 : 0.9),
      same: (t) => (t === "B" ? "A" : "new"),
    });
    const out = await synthesize(
      [finding("A", "codex"), finding("B", "kimi"), finding("C", "codex", { path: "src/c.ts" })],
      { jev },
    );
    expect(out.notes).toHaveLength(1);
    expect(titles(out.notes[0]!)).toEqual(["A", "B"]);
    expect(out.unique.map((u) => u.text)).toEqual(["C"]);
  });

  test("threshold is overridable", async () => {
    const jev = fakeJev({ real: () => 0.5 });
    const out = await synthesize([finding("A")], { jev, threshold: 0.6 });
    expect(out.notes).toHaveLength(1);
    expect(out.unique).toHaveLength(0);
  });

  test("empty input needs no Jev call", async () => {
    const jev = fakeJev();
    const out = await synthesize([], { jev });
    expect(jev.calls).toHaveLength(0);
    expect(out.unique).toHaveLength(0);
  });

  test("requests carry an abort signal that is aborted when synthesis returns", async () => {
    const jev = fakeJev();
    await synthesize([finding("A")], { jev });
    expect(jev.calls[0]!.signal).toBeDefined();
    expect(jev.calls[0]!.signal!.aborted).toBe(true);
  });
});

describe("council synth limits", () => {
  test("only 20 findings are scored, the rest stand alone", async () => {
    const jev = fakeJev();
    const list = Array.from({ length: 25 }, (_, i) => finding(`T${i}`, "codex", { path: `src/f${i}.ts` }));
    const out = await synthesize(list, { jev });
    const scoredTitles = new Set<string>();
    for (const call of jev.calls) {
      for (const f of Object.values<any>(call.state.findings ?? {})) scoredTitles.add(f.title);
    }
    expect(scoredTitles.size).toBe(20);
    expect(out.unique).toHaveLength(25);
    expect(out.unique.filter((u) => u.real === undefined)).toHaveLength(5);
    expect(out.messages.join(" ")).toContain("5 finding(s) beyond the first 20");
  });

  test("high severity findings are scored first", async () => {
    const jev = fakeJev();
    const list = [
      ...Array.from({ length: 20 }, (_, i) => finding(`low${i}`, "codex", { severity: "low" })),
      finding("critical", "kimi", { severity: "high" }),
    ];
    const out = await synthesize(list, { jev });
    expect(out.unique.find((u) => u.text === "critical")?.real).toBeCloseTo(0.9);
  });

  test("within a severity tier the cap rotates across members", async () => {
    const jev = fakeJev();
    const list = [
      ...Array.from({ length: 6 }, (_, i) => finding(`c${i}`, "codex", { path: `src/c${i}.ts` })),
      finding("k0", "kimi", { path: "src/k0.ts" }),
      finding("a0", "antigravity", { path: "src/a0.ts" }),
    ];
    const out = await synthesize(list, { jev, limits: { maxScored: 3 } });
    const scored = out.unique.filter((u) => u.real !== undefined).map((u) => u.text).sort();
    expect(scored).toEqual(["a0", "c0", "k0"]);
  });

  test("requests respect the question and character limits", async () => {
    const jev = fakeJev();
    const list = Array.from({ length: 20 }, (_, i) =>
      finding(`T${i}`, "codex", { detail: "x".repeat(900), path: `src/file${i}.ts` }),
    );
    await synthesize(list, { jev });
    expect(jev.calls.length).toBeGreaterThan(1);
    for (const call of jev.calls) {
      expect(Object.keys(call.questions).length).toBeLessThanOrEqual(9);
      expect(call.chars).toBeLessThanOrEqual(14_000);
    }
    const asked = jev.calls.flatMap((c) => Object.keys(c.questions).filter((k) => k.startsWith("real::")));
    expect(new Set(asked).size).toBe(20);
  });

  test("the character limit binds before the question limit", async () => {
    const jev = fakeJev();
    const list = Array.from({ length: 4 }, (_, i) =>
      finding(`T${i}`, "codex", { detail: "y".repeat(300), path: `src/f${i}.ts` }),
    );
    await synthesize(list, { jev, limits: { maxChars: 2500 } });
    expect(jev.calls.length).toBeGreaterThan(1);
    for (const call of jev.calls) {
      expect(Object.keys(call.questions).length).toBeLessThan(9);
      expect(call.chars).toBeLessThanOrEqual(2500);
    }
    const asked = jev.calls.flatMap((c) => Object.keys(c.questions).filter((k) => k.startsWith("real::")));
    expect(asked).toHaveLength(4);
  });

  test("quote-heavy titles are measured after JSON escaping", async () => {
    const jev = fakeJev();
    const list = Array.from({ length: 20 }, (_, i) =>
      finding('"'.repeat(150), "codex", { detail: '"'.repeat(300), path: `src/f${i}.ts` }),
    );
    await synthesize(list, { jev });
    expect(jev.calls.length).toBeGreaterThan(1);
    for (const call of jev.calls) expect(call.chars).toBeLessThanOrEqual(14_000);
  });

  test("limits are overridable", async () => {
    const jev = fakeJev();
    const list = Array.from({ length: 6 }, (_, i) => finding(`T${i}`));
    await synthesize(list, { jev, limits: { maxQuestions: 3, maxScored: 4 } });
    for (const call of jev.calls) expect(Object.keys(call.questions).length).toBeLessThanOrEqual(3);
    const asked = jev.calls.flatMap((c) => Object.keys(c.questions).filter((k) => k.startsWith("real::")));
    expect(asked).toHaveLength(4);
  });

  test("a finding too large for any request stands alone, unscored", async () => {
    const jev = fakeJev();
    const out = await synthesize([finding("A"), finding("B")], { jev, limits: { maxChars: 50 } });
    expect(jev.calls).toHaveLength(0);
    expect(out.scoredBy).toBe("none");
    expect(out.unique).toHaveLength(2);
  });

  test("text sent to Jev is limited to 300 characters of detail", async () => {
    const jev = fakeJev();
    await synthesize([finding("A", "codex", { detail: "q".repeat(1000) })], { jev });
    const sent = jev.calls[0]!.state.findings.f0;
    expect(sent.detail.length).toBeLessThanOrEqual(300);
    expect(Object.keys(sent).sort()).toEqual(["detail", "location", "member", "title"]);
  });

  test("secrets in title, detail and path are redacted before reaching Jev", async () => {
    const jev = fakeJev();
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    await synthesize(
      [finding(`leaks ${secret}`, "codex", { detail: `token ${secret} here`, path: `src/${secret}.ts` })],
      { jev },
    );
    expect(JSON.stringify(jev.calls)).not.toContain(secret);
  });

  test("the first finding gets a Noul only, later ones also a Choice with new and #k", async () => {
    const jev = fakeJev();
    await synthesize([finding("A"), finding("B"), finding("C")], { jev });
    const q = jev.calls[0]!.questions as Record<string, any>;
    expect(q["same::f0"]).toBeUndefined();
    expect(q["real::f0"].type).toBe("noul");
    expect(Object.keys(q["same::f2"].criteria)).toEqual(["new", "#0", "#1"]);
  });
});

describe("council synth invalid answers and failures", () => {
  test("an invalid choice leaves the finding standing alone but scored", async () => {
    const jev = fakeJev({ same: (t) => (t === "B" ? "invalid" : "new") });
    const out = await synthesize([finding("A", "codex"), finding("B", "kimi")], { jev });
    expect(out.agreements).toHaveLength(0);
    expect(out.unique).toHaveLength(2);
    expect(out.unique.find((u) => u.text === "B")!.real).toBeCloseTo(0.9);
    const messages = out.messages.join(" ");
    expect(messages).toContain("invalid, uncertain or unusable Jev grouping");
    expect(messages).not.toContain("unscored");
  });

  test("a link whose probability is below 0.5 does not merge", async () => {
    const jev = fakeJev({ same: (t) => (t === "B" ? { to: "A", p: 0.45 } : "new") });
    const out = await synthesize([finding("A", "codex"), finding("B", "kimi")], { jev });
    expect(out.agreements).toHaveLength(0);
    expect(out.unique).toHaveLength(2);
    expect(out.messages.join(" ")).toContain("uncertain");
  });

  test("a link at 0.51 merges", async () => {
    const jev = fakeJev({ same: (t) => (t === "B" ? { to: "A", p: 0.51 } : "new") });
    const out = await synthesize([finding("A", "codex"), finding("B", "kimi")], { jev });
    expect(out.agreements).toHaveLength(1);
  });

  test("an invalid or missing Noul leaves the finding unscored and unmerged", async () => {
    const jev = fakeJev({
      real: (t) => (t === "B" ? "invalid" : t === "C" ? undefined : 0.9),
      same: (t) => (t === "B" || t === "C" ? "A" : "new"),
    });
    const out = await synthesize(
      [finding("A", "codex"), finding("B", "kimi"), finding("C", "antigravity")],
      { jev },
    );
    expect(out.agreements).toHaveLength(0);
    expect(out.unique).toHaveLength(3);
    expect(out.unique.filter((u) => u.real === undefined).map((u) => u.text).sort()).toEqual(["B", "C"]);
    expect(out.messages.join(" ")).toContain("2 finding(s) had an invalid or missing Jev score");
  });

  test("a valid link into a finding whose own score failed does not merge", async () => {
    const jev = fakeJev({
      real: (t) => (t === "A" ? "invalid" : 0.9),
      same: (t) => (t === "B" ? "A" : "new"),
    });
    const out = await synthesize([finding("A", "codex"), finding("B", "kimi")], { jev });
    expect(out.agreements).toHaveLength(0);
    expect(out.unique).toHaveLength(2);
    expect(out.unique.find((u) => u.text === "B")!.real).toBeCloseTo(0.9);
    const messages = out.messages.join(" ");
    expect(messages).toContain("1 finding(s) had an invalid or missing Jev score");
    expect(messages).toContain("1 finding(s) had an invalid, uncertain or unusable Jev grouping");
  });

  test("an invalid contradiction answer keeps the group as a flagged agreement", async () => {
    const jev = fakeJev({ same: (t) => (t === "B" ? "A" : "new"), contradict: () => "invalid" });
    const out = await synthesize([finding("A", "codex"), finding("B", "kimi")], { jev });
    expect(out.agreements).toHaveLength(1);
    expect(out.agreements[0]!.contradictionChecked).toBe(false);
    expect(out.messages.join(" ")).toContain("contradiction check was unavailable");
  });

  test("a round 2 group too large for one request is shrunk and still checked", async () => {
    const a = finding("A", "codex", { detail: "q".repeat(300), path: `src/${"a".repeat(150)}.ts` });
    const b = finding("B", "kimi", { detail: "q".repeat(300), path: `src/${"b".repeat(150)}.ts` });
    const jev = fakeJev({ same: (t) => (t === "B" ? "A" : "new") });
    const out = await synthesize([a, b], { jev, limits: { maxChars: 1100 } });
    for (const call of jev.calls) expect(call.chars).toBeLessThanOrEqual(1100);
    const round2 = jev.calls.filter((c) => Object.keys(c.questions).some((k) => k.startsWith("contradict::")));
    expect(round2).toHaveLength(1);
    expect(out.agreements).toHaveLength(1);
    expect(out.agreements[0]!.contradictionChecked).toBe(true);
  });

  test("Jev failure returns every finding raw with a note and never groups", async () => {
    const jev = fakeJev({ fail: () => new JevError("api", "quota exceeded", 429) });
    const out = await synthesize([finding("A", "codex"), finding("B", "kimi")], { jev });
    expect(out.scoredBy).toBe("none");
    expect(out.unique).toHaveLength(2);
    expect(out.unique.every((u) => u.real === undefined)).toBe(true);
    expect(out.agreements).toHaveLength(0);
    expect(out.messages[0]).toContain("Jev unavailable");
    expect(out.messages[0]).toContain("quota exceeded");
  });

  test("a missing key is reported as unavailable", async () => {
    const jev = fakeJev({ fail: () => new JevError("missing_key", "TYPESAFE_API_KEY is not set") });
    const out = await synthesize([finding("A")], { jev });
    expect(out.scoredBy).toBe("none");
    expect(out.messages[0]).toContain("missing_key");
  });

  test("partial failure keeps scoring for the requests that worked", async () => {
    const list = Array.from({ length: 8 }, (_, i) => finding(`T${i}`, "codex", { path: `src/f${i}.ts` }));
    const jev = fakeJev({ fail: (call) => (call === 1 ? new Error("boom") : undefined) });
    const out = await synthesize(list, { jev });
    expect(out.scoredBy).toBe("jev");
    expect(out.unique).toHaveLength(8);
    expect(out.unique.some((u) => u.real === undefined)).toBe(true);
    expect(out.unique.some((u) => u.real !== undefined)).toBe(true);
    expect(out.messages.join(" ")).toContain("Jev failed for 3 finding(s)");
  });

  test("a response with no answers is treated as unusable", async () => {
    const jev = fakeJev({ real: () => undefined });
    const out = await synthesize([finding("A")], { jev });
    expect(out.scoredBy).toBe("none");
    expect(out.unique).toHaveLength(1);
    expect(out.messages[0]).toContain("no valid answers");
  });

  test("item location and text are single-line and clipped", async () => {
    const jev = fakeJev();
    const out = await synthesize(
      [finding("title\nwith break", "codex", { path: `src/${"p".repeat(500)}\nAgreements (3)` })],
      { jev },
    );
    const item = out.unique[0]!;
    expect(item.location).not.toContain("\n");
    expect(item.location.length).toBeLessThanOrEqual(200);
    expect(item.text).toBe("title with break");
  });
});
