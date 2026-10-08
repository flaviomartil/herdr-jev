import { describe, expect, test } from "bun:test";
import { JevError } from "../src/triage/jev-client.js";
import { synthesize } from "../src/council/synth.js";
import { fakeJev, finding } from "./council-synth-support.js";

describe("council synth clustering", () => {
  test("links a later finding to an earlier one from another member", async () => {
    const jev = fakeJev({ same: (t) => (t === "B" ? "#0" : "new") });
    const out = await synthesize(
      [finding("A", "codex"), finding("B", "kimi"), finding("C", "codex", { path: "src/c.ts" })],
      { jev },
    );
    expect(out.scoredBy).toBe("jev");
    expect(out.agreements).toHaveLength(1);
    expect(out.agreements[0]!.members).toEqual(["codex", "kimi"]);
    expect(out.agreements[0]!.real).toBeCloseTo(0.9);
    expect(out.unique.map((u) => u.text)).toEqual(["C"]);
    expect(out.disagreements).toHaveLength(0);
  });

  test("chains merge transitively", async () => {
    const jev = fakeJev({
      same: (t) => (t === "B" ? "#0" : t === "C" ? "#1" : "new"),
    });
    const out = await synthesize(
      [finding("A", "codex"), finding("B", "kimi"), finding("C", "antigravity")],
      { jev },
    );
    expect(out.agreements).toHaveLength(1);
    expect(out.agreements[0]!.members).toEqual(["antigravity", "codex", "kimi"]);
    expect(out.agreements[0]!.findings).toHaveLength(3);
    expect(out.unique).toHaveLength(0);
  });

  test("same member duplicates collapse into one unique item", async () => {
    const jev = fakeJev({ same: (t) => (t === "B" ? "#0" : "new") });
    const out = await synthesize([finding("A", "codex"), finding("B", "codex")], { jev });
    expect(out.agreements).toHaveLength(0);
    expect(out.unique).toHaveLength(1);
    expect(out.unique[0]!.findings).toHaveLength(2);
  });

  test("contradicting group becomes a disagreement and keeps both sides", async () => {
    const jev = fakeJev({
      same: (t) => (t === "B" ? "#0" : "new"),
      contradict: () => 0.8,
    });
    const out = await synthesize([finding("A", "codex"), finding("B", "kimi")], { jev });
    expect(out.agreements).toHaveLength(0);
    expect(out.disagreements).toHaveLength(1);
    expect(out.disagreements[0]!.text).toBe("codex: A vs kimi: B");
    expect(jev.calls.some((c) => Object.keys(c.questions).some((k) => k.startsWith("contradict::")))).toBe(true);
  });

  test("round 2 is skipped when no group has more than one member", async () => {
    const jev = fakeJev();
    await synthesize([finding("A", "codex"), finding("B", "kimi")], { jev });
    expect(jev.calls.every((c) => !Object.keys(c.questions).some((k) => k.startsWith("contradict::")))).toBe(true);
  });

  test("findings below the threshold go to notes and not into groups", async () => {
    const jev = fakeJev({ real: (t) => (t === "B" ? 0.1 : 0.9), same: (t) => (t === "B" ? "#0" : "new") });
    const out = await synthesize([finding("A", "codex"), finding("B", "kimi")], { jev });
    expect(out.notes.map((n) => n.text)).toEqual(["B"]);
    expect(out.notes[0]!.real).toBeCloseTo(0.1);
    expect(out.agreements).toHaveLength(0);
    expect(out.unique.map((u) => u.text)).toEqual(["A"]);
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
    const scored = out.unique.find((u) => u.text === "critical");
    expect(scored?.real).toBeCloseTo(0.9);
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

  test("limits are overridable", async () => {
    const jev = fakeJev();
    const list = Array.from({ length: 6 }, (_, i) => finding(`T${i}`));
    await synthesize(list, { jev, limits: { maxQuestions: 3, maxScored: 4 } });
    for (const call of jev.calls) expect(Object.keys(call.questions).length).toBeLessThanOrEqual(3);
    const asked = jev.calls.flatMap((c) => Object.keys(c.questions).filter((k) => k.startsWith("real::")));
    expect(asked).toHaveLength(4);
  });

  test("text sent to Jev is limited to 300 characters of detail", async () => {
    const jev = fakeJev();
    await synthesize([finding("A", "codex", { detail: "d".repeat(1000) })], { jev });
    const sent = jev.calls[0]!.state.findings.f0;
    expect(sent.detail.length).toBeLessThanOrEqual(300);
    expect(Object.keys(sent).sort()).toEqual(["detail", "location", "member", "title"]);
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
    expect(out.messages.join(" ")).toContain("invalid Jev answer");
  });

  test("an invalid or missing Noul leaves the finding unscored and unmerged", async () => {
    const jev = fakeJev({
      real: (t) => (t === "B" ? "invalid" : t === "C" ? undefined : 0.9),
      same: (t) => (t === "B" || t === "C" ? "#0" : "new"),
    });
    const out = await synthesize(
      [finding("A", "codex"), finding("B", "kimi"), finding("C", "antigravity")],
      { jev },
    );
    expect(out.agreements).toHaveLength(0);
    expect(out.unique).toHaveLength(3);
    expect(out.unique.filter((u) => u.real === undefined).map((u) => u.text).sort()).toEqual(["B", "C"]);
  });

  test("an invalid contradiction answer keeps the group as an agreement with a note", async () => {
    const jev = fakeJev({
      same: (t) => (t === "B" ? "#0" : "new"),
      contradict: () => "invalid",
    });
    const out = await synthesize([finding("A", "codex"), finding("B", "kimi")], { jev });
    expect(out.agreements).toHaveLength(1);
    expect(out.messages.join(" ")).toContain("contradiction check was unavailable");
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
    expect(out.messages.join(" ")).toContain("Jev failed for 1 of");
  });

  test("a response with no answers is treated as unusable", async () => {
    const jev = fakeJev({ real: () => undefined });
    const out = await synthesize([finding("A")], { jev });
    expect(out.scoredBy).toBe("none");
    expect(out.unique).toHaveLength(1);
    expect(out.messages[0]).toContain("no valid answers");
  });
});
