import { describe, expect, test } from "bun:test";
import { formatCouncilSummary } from "../src/council/format.js";
import { synthesize } from "../src/council/synth.js";
import type { CouncilRun } from "../src/council/types.js";
import { fakeJev, finding } from "./council-synth-support.js";

const run: CouncilRun = {
  diffHash: "abc123",
  ran: true,
  members: [
    { member: "codex", status: "done", findings: [], durationMs: 12_300 },
    { member: "kimi", status: "failed", reason: "timeout after 480s", findings: [], durationMs: 480_000 },
    { member: "antigravity", status: "skipped", reason: "binary not found", findings: [], durationMs: 0 },
  ],
};

describe("formatCouncilSummary", () => {
  test("opens with the evidence rule", async () => {
    const out = formatCouncilSummary(await synthesize([], { jev: fakeJev() }), run);
    const first = out.split("\n")[0]!;
    expect(first).toContain("candidate, not a fact");
    expect(first).toContain("failing test or command");
    expect(first).toContain("file:line");
    expect(first).toContain("Reproduce");
    expect(first).toContain("Approved with no findings");
    expect(out).toContain("No findings reported by the council.");
  });

  test("renders sections, notes and member status lines", async () => {
    const jev = fakeJev({
      real: (t) => (t === "N" ? 0.05 : 0.8),
      same: (t) => (t === "B" ? "#0" : "new"),
    });
    const summary = await synthesize(
      [
        finding("A", "codex", { path: "src/x.ts", line: 10 }),
        finding("B", "kimi", { path: "src/x.ts", line: 11 }),
        finding("U", "codex", { path: "src/u.ts" }),
        finding("N", "kimi", { path: "src/n.ts" }),
      ],
      { jev },
    );
    const out = formatCouncilSummary(summary, run);
    expect(out).toContain("Agreements (1)");
    expect(out).toContain("- [codex, kimi] src/x.ts:10 - A (real 0.80)");
    expect(out).toContain("Unique findings (1)");
    expect(out).toContain("Notes, below the real-defect threshold (1)");
    expect(out).toContain("- codex: done, 0 finding(s), 12.3s");
    expect(out).toContain("- kimi: failed: timeout after 480s");
    expect(out).toContain("- antigravity: skipped: binary not found");
    expect(out.indexOf("Agreements")).toBeLessThan(out.indexOf("Unique findings"));
    expect(out.indexOf("Unique findings")).toBeLessThan(out.indexOf("Members"));
  });

  test("shows the Jev fallback message", async () => {
    const summary = await synthesize([finding("A")], {
      jev: fakeJev({ fail: () => new Error("offline") }),
    });
    const out = formatCouncilSummary(summary, run);
    expect(out).toContain("Findings were not scored or grouped.");
    expect(out).toContain("Jev unavailable");
  });

  test("states when the council did not run", async () => {
    const summary = await synthesize([], { jev: fakeJev() });
    const out = formatCouncilSummary(summary, { diffHash: "x", ran: false, note: "task is routine", members: [] });
    expect(out).toContain("Council did not run: task is routine");
  });
});
