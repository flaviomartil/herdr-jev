import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_COUNCIL_COOLDOWN_MS, decideAutoCouncil, parseCouncilCooldown, readLastCouncilRun, readRunObjective, type TriageFn } from "../src/council/auto.js";
import { consultCouncil, parsePipelineCouncilMode, parseReviewCouncilMode, renderReview, runCouncilCommand, startAutoCouncilAlongside, startCouncilAlongside } from "../src/council/command.js";
import { parseCrossHarnessConfig } from "../src/delegation/cross-harness.js";
import { fakeSpawn, makeRepo, ok, writeIn } from "./council-helpers.js";
import { fakeJev } from "./council-synth-support.js";
import { createTestStateDir } from "./helpers.js";

let repo: string;
let state: { stateDir: string; cleanup: () => void };
let clock: number;

beforeEach(() => {
  repo = makeRepo();
  state = createTestStateDir();
  clock = 1_000_000_000_000;
  writeIn(repo, "src/a.ts", "export const a = 2;\n");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  state.cleanup();
});

const all = () => parseCrossHarnessConfig("1");
const finding = (title: string) => JSON.stringify({ path: "src/a.ts", line: 1, severity: "high", title, detail: "why" });

function members() {
  return fakeSpawn({
    codex: () => ok("- [P1] Codex issue - /x/src/a.ts:1-1\n  detail"),
    kimi: () => ok(finding("Kimi issue")),
    agy: () => ok(JSON.stringify({ result: "NO_FINDINGS" })),
  });
}

function triageOf(complexity: string, extra: Record<string, unknown> = {}): TriageFn & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (task: string) => {
    calls.push(task);
    return { complexity, rawAnswers: extra };
  }) as TriageFn & { calls: string[] };
  fn.calls = calls;
  return fn;
}

function deps(triage: TriageFn, spawn = members().spawn) {
  return { spawn, jev: fakeJev(), stateDir: state.stateDir, crossHarness: all(), triage, now: () => clock };
}

const context = () => ({ cwd: repo, client: "claude" });

describe("parsing", () => {
  it("defaults the cooldown to 10 minutes and accepts 0", () => {
    expect(parseCouncilCooldown(undefined)).toBe(DEFAULT_COUNCIL_COOLDOWN_MS);
    expect(DEFAULT_COUNCIL_COOLDOWN_MS).toBe(600_000);
    expect(parseCouncilCooldown("0")).toBe(0);
    expect(parseCouncilCooldown("1500")).toBe(1500);
    for (const bad of ["soon", "-1", "1.5", String(25 * 60 * 60 * 1000)]) expect(() => parseCouncilCooldown(bad)).toThrow("invalid council cooldown");
  });

  it("reads the review --council value", () => {
    expect(parseReviewCouncilMode(undefined, undefined)).toBe("off");
    expect(parseReviewCouncilMode(undefined, "kimi,agy")).toBe("always");
    expect(parseReviewCouncilMode(true, undefined)).toBe("always");
    expect(parseReviewCouncilMode("auto", "kimi,agy")).toBe("auto");
    expect(() => parseReviewCouncilMode("sometimes", undefined)).toThrow("invalid --council value");
  });

  it("reads the pipeline --council value", () => {
    expect(parsePipelineCouncilMode(undefined)).toBe("off");
    expect(parsePipelineCouncilMode("off")).toBe("off");
    expect(parsePipelineCouncilMode("auto")).toBe("auto");
    expect(() => parsePipelineCouncilMode("always")).toThrow("invalid --council value");
  });
});

describe("auto gate by triage", () => {
  for (const complexity of ["moderate", "architectural"]) {
    it(`runs the council on a ${complexity} task`, async () => {
      const triage = triageOf(complexity);
      const fake = members();
      const result = await runCouncilCommand({ auto: true, task: "migrate the billing tables", json: true }, context(), deps(triage, fake.spawn));
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.output).run.ran).toBe(true);
      expect(triage.calls).toEqual(["migrate the billing tables"]);
      expect(fake.reviewCalls.length).toBe(3);
    });
  }

  for (const complexity of ["trivial", "routine"]) {
    it(`skips a ${complexity} task with the reason and starts no member`, async () => {
      const fake = members();
      const result = await runCouncilCommand({ auto: true, task: "fix a typo" }, context(), deps(triageOf(complexity), fake.spawn));
      expect(result).toEqual({ output: `council skipped: triage ${complexity}`, exitCode: 2 });
      expect(fake.calls).toEqual([]);
      expect(readdirSync(state.stateDir).includes("council")).toBe(false);
    });
  }

  it("prints the skip reason as JSON", async () => {
    const result = await runCouncilCommand({ auto: true, task: "fix a typo", json: true }, context(), deps(triageOf("routine")));
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.output)).toEqual({ skipped: "council skipped: triage routine" });
  });

  it("skips without a task summary and never calls triage", async () => {
    const triage = triageOf("architectural");
    for (const task of [undefined, "", "   "]) {
      const result = await runCouncilCommand({ auto: true, task }, context(), deps(triage));
      expect(result).toEqual({ output: "council skipped: no task summary", exitCode: 2 });
    }
    expect(triage.calls).toEqual([]);
  });

  it("skips with a note when triage throws", async () => {
    const triage: TriageFn = async () => {
      throw new Error("boom");
    };
    const result = await runCouncilCommand({ auto: true, task: "refactor everything" }, context(), deps(triage));
    expect(result).toEqual({ output: "council skipped: triage unavailable", exitCode: 2 });
  });

  it("skips with a note when triage fell back to its heuristic", async () => {
    const result = await runCouncilCommand({ auto: true, task: "integra api" }, context(), deps(triageOf("moderate", { fallback: true, reason: "missing-api-key" })));
    expect(result).toEqual({ output: "council skipped: triage unavailable", exitCode: 2 });
  });

  it("skips when there is no diff", async () => {
    const clean = makeRepo();
    try {
      const result = await runCouncilCommand({ auto: true, task: "x" }, { cwd: clean, client: "claude" }, deps(triageOf("moderate")));
      expect(result).toEqual({ output: "council skipped: no diff", exitCode: 2 });
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
  });

  it("rejects an invalid cooldown", async () => {
    const result = await runCouncilCommand({ auto: true, task: "x", cooldown: "soon" }, context(), deps(triageOf("moderate")));
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("invalid council cooldown");
  });
});

describe("hash and cooldown", () => {
  const run = (extra: { cooldown?: string; auto?: boolean } = {}) => runCouncilCommand({ auto: true, task: "migrate", json: true, ...extra }, context(), deps(triageOf("moderate")));

  it("skips a diff equal to the one of the last council run", async () => {
    expect((await run()).exitCode).toBe(0);
    clock += 60 * 60 * 1000;
    const again = await run();
    expect(again.exitCode).toBe(2);
    expect(JSON.parse(again.output).skipped).toBe("council skipped: same diff as the last council run");
  });

  it("skips a changed diff inside the cooldown and says how long ago", async () => {
    expect((await run()).exitCode).toBe(0);
    writeIn(repo, "src/b.ts", "export const b = 1;\n");
    clock += 90_000;
    const again = await run();
    expect(again.exitCode).toBe(2);
    expect(JSON.parse(again.output).skipped).toBe("council skipped: cooldown, last council run 90s ago (window 600s)");
  });

  it("runs a changed diff once the cooldown is over", async () => {
    expect((await run()).exitCode).toBe(0);
    writeIn(repo, "src/b.ts", "export const b = 1;\n");
    clock += 10 * 60 * 1000;
    expect((await run()).exitCode).toBe(0);
  });

  it("disables the cooldown with 0 but keeps the hash rule", async () => {
    expect((await run({ cooldown: "0" })).exitCode).toBe(0);
    expect(JSON.parse((await run({ cooldown: "0" })).output).skipped).toBe("council skipped: same diff as the last council run");
    writeIn(repo, "src/b.ts", "export const b = 1;\n");
    clock += 1000;
    expect((await run({ cooldown: "0" })).exitCode).toBe(0);
  });

  it("honours a custom cooldown", async () => {
    expect((await run({ cooldown: "5000" })).exitCode).toBe(0);
    writeIn(repo, "src/b.ts", "export const b = 1;\n");
    clock += 4000;
    expect(JSON.parse((await run({ cooldown: "5000" })).output).skipped).toContain("cooldown");
    clock += 2000;
    expect((await run({ cooldown: "5000" })).exitCode).toBe(0);
  });

  it("keeps the last run per repository", async () => {
    expect((await run()).exitCode).toBe(0);
    const other = makeRepo();
    try {
      writeIn(other, "src/a.ts", "export const a = 3;\n");
      const result = await runCouncilCommand({ auto: true, task: "migrate", json: true }, { cwd: other, client: "claude" }, deps(triageOf("moderate")));
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("stores the diff hash and time under the state directory", async () => {
    const report = await consultCouncil({ cwd: repo, client: "claude" }, deps(triageOf("moderate")));
    const last = readLastCouncilRun(state.stateDir, repo);
    expect(last).toEqual({ diffHash: report.run.diffHash, at: clock });
  });

  it("does not record a run that did not happen", async () => {
    const report = await consultCouncil({ cwd: repo, client: "claude" }, { ...deps(triageOf("moderate")), crossHarness: parseCrossHarnessConfig("0") });
    expect(report.run.ran).toBe(false);
    expect(readLastCouncilRun(state.stateDir, repo)).toBeUndefined();
  });

  it("treats a recorded time in the future as no cooldown", async () => {
    await consultCouncil({ cwd: repo, client: "claude" }, deps(triageOf("moderate")));
    writeIn(repo, "src/b.ts", "export const b = 1;\n");
    clock -= 60_000;
    expect((await run()).exitCode).toBe(0);
  });

  it("the explicit council ignores the hash and the cooldown", async () => {
    const first = await consultCouncil({ cwd: repo, client: "claude" }, deps(triageOf("trivial")));
    const second = await consultCouncil({ cwd: repo, client: "claude" }, deps(triageOf("trivial")));
    expect(first.run.ran).toBe(true);
    expect(second.run.ran).toBe(true);
    const alongside = startCouncilAlongside({ wait: "60000" }, context(), deps(triageOf("trivial")));
    const third = await alongside.settle();
    expect(third.run.ran).toBe(true);
    expect(third.skipped).toBeUndefined();
  });

  it("an explicit run counts as the last council run for auto", async () => {
    await consultCouncil({ cwd: repo, client: "claude" }, deps(triageOf("trivial")));
    clock += 60 * 60 * 1000;
    expect(JSON.parse((await run()).output).skipped).toBe("council skipped: same diff as the last council run");
  });
});

describe("decideAutoCouncil", () => {
  it("returns the diff hash it checked", async () => {
    const gate = await decideAutoCouncil({ task: "migrate", cwd: repo }, { triage: triageOf("moderate"), stateDir: state.stateDir, now: () => clock });
    expect(gate.run).toBe(true);
    if (gate.run) expect(gate.diffHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("caps the task sent to triage", async () => {
    const triage = triageOf("routine");
    await decideAutoCouncil({ task: "x".repeat(10_000), cwd: repo }, { triage, stateDir: state.stateDir });
    expect(triage.calls[0]!.length).toBe(4000);
  });
});

describe("auto council beside the review", () => {
  const plain = { status: "ready", scopes: [] };

  it("adds one note line and leaves the review untouched when skipped", async () => {
    const alongside = startAutoCouncilAlongside({ task: "fix a typo" }, context(), deps(triageOf("routine")));
    const council = await alongside.settle();
    expect(council.skipped).toBe("council skipped: triage routine");
    expect(renderReview(plain, "review text", council, false)).toBe("review text\n\ncouncil skipped: triage routine");
    expect(JSON.parse(renderReview(plain, "review text", council, true))).toEqual({ ...plain, councilNote: "council skipped: triage routine" });
  });

  it("falls back to the plain review text when triage fails", async () => {
    const triage: TriageFn = async () => {
      throw new Error("down");
    };
    const council = await startAutoCouncilAlongside({ task: "migrate" }, context(), deps(triage)).settle();
    const { councilNote, ...rest } = JSON.parse(renderReview(plain, "review text", council, true));
    expect(rest).toEqual(plain);
    expect(councilNote).toBe("council skipped: triage unavailable");
    expect(renderReview(plain, "review text", council, false).startsWith("review text\n\n")).toBe(true);
  });

  it("appends the council under its heading when it runs", async () => {
    const council = await startAutoCouncilAlongside({ task: "migrate" }, context(), deps(triageOf("moderate"))).settle();
    expect(council.run.ran).toBe(true);
    const text = renderReview(plain, "review text", council, false);
    expect(text).toContain("Council (consultative only");
    expect(JSON.parse(renderReview(plain, "review text", council, true)).council.ran).toBe(true);
  });

  it("reports an invalid cooldown as a note", async () => {
    const council = await startAutoCouncilAlongside({ task: "migrate", cooldown: "soon" }, context(), deps(triageOf("moderate"))).settle();
    expect(council.run.ran).toBe(false);
    expect(council.run.note).toContain("invalid council cooldown");
  });

  it("aborts the council it started", async () => {
    const hung = fakeSpawn({ codex: () => "hang", kimi: () => "hang", agy: () => "hang" });
    const alongside = startAutoCouncilAlongside({ task: "migrate", wait: "0" }, context(), deps(triageOf("moderate"), hung.spawn));
    const council = await alongside.settle();
    expect(council.run.ran).toBe(false);
    await alongside.promise;
    expect(hung.reviewCalls.every((call) => call.killed)).toBe(true);
  });
});

describe("run objective", () => {
  const id = "00000000-0000-4000-8000-0000000000aa";

  it("reads the objective of a pipeline run", () => {
    mkdirSync(join(state.stateDir, id), { recursive: true });
    writeFileSync(join(state.stateDir, id, "objective.md"), "  Move billing to the new ledger\n");
    expect(readRunObjective(id, state.stateDir)).toBe("Move billing to the new ledger");
  });

  it("returns nothing for a missing run, a missing session or an id that is not a run id", () => {
    expect(readRunObjective(id, state.stateDir)).toBeUndefined();
    expect(readRunObjective(undefined, state.stateDir)).toBeUndefined();
    expect(readRunObjective("../../etc", state.stateDir)).toBeUndefined();
    const dir = mkdtempSync(join(tmpdir(), "objective-"));
    try {
      expect(readRunObjective("s-abc123", dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
