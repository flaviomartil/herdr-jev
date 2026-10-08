import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TriageFn } from "../src/council/auto.js";
import { parseCrossHarnessConfig } from "../src/delegation/cross-harness.js";
import { resetHarnessCaches } from "../src/harness/bridge.js";
import { resumePipeline } from "../src/orchestration/pipeline.js";
import { makeRepo, privatePath, writeIn } from "./council-helpers.js";
import { createFakeHarness, type FakeHarness } from "./fake-harness.js";
import { createTestStateDir } from "./helpers.js";

const ID = "00000000-0000-4000-8000-0000000000aa";
const TASK = "Move the billing module to the new ledger";
const PLAIN_HANDOFF = "Independent review recorded by AI Harness.\n";

let state: ReturnType<typeof createTestStateDir>;
let repo: string;
let scratch: string;
let harness: FakeHarness | undefined;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  state = createTestStateDir();
  repo = makeRepo();
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "council-pipeline-")));
  writeIn(repo, "src/a.ts", "export const a = 2;\n");
  savedEnv = { HERDR_ENV: process.env.HERDR_ENV, PATH: process.env.PATH };
  process.env.HERDR_ENV = "1";
});

afterEach(() => {
  harness?.restore();
  harness = undefined;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetHarnessCaches();
  rmSync(repo, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
  state.cleanup();
});

function triageOf(complexity: string): TriageFn & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (task: string) => {
    calls.push(task);
    return { complexity, rawAnswers: {} };
  }) as TriageFn & { calls: string[] };
  fn.calls = calls;
  return fn;
}

interface Setup {
  verdicts?: string;
  council?: "off" | "auto";
  triage?: TriageFn;
}

async function execute(setup: Setup = {}) {
  const dir = join(state.stateDir, ID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "objective.md"), TASK);
  const implementation = "implemented\n";
  writeFileSync(join(dir, "implementer.md"), implementation);
  const stages = [
    { id: "implementer", role: "implementer", client: "claude", model: "claude-sonnet-5", effort: "high", state: "verified", handoffPath: join(dir, "implementer.md"), handoffDigest: createHash("sha256").update(implementation).digest("hex") },
    { id: "reviewer", role: "reviewer", client: "claude", model: "opus-5", effort: "xhigh", state: "queued" },
  ];
  harness = createFakeHarness("contract", {
    FAKE_PIPELINE_STAGES: JSON.stringify(stages), FAKE_PIPELINE_CLIENT: "claude", FAKE_PIPELINE_CWD: repo,
    FAKE_PIPELINE_DIGEST: createHash("sha256").update(TASK).digest("hex"),
    ...(setup.verdicts ? { FAKE_VERDICTS: setup.verdicts } : {}),
  });
  const reviewDir = join(harness.dir, "reviews", `claude_${ID}`);
  mkdirSync(reviewDir, { recursive: true });
  writeFileSync(join(reviewDir, "scopes.json"), JSON.stringify(["default"]));
  writeFileSync(join(reviewDir, "verify.json"), JSON.stringify({ status: "pending_review" }));
  const ran = join(scratch, "members-ran");
  const body = `echo x >> '${ran}'\necho NO_FINDINGS`;
  const priv = privatePath(scratch, { codex: body, kimi: body, agy: `echo x >> '${ran}'\necho '{"result":"NO_FINDINGS"}'` });
  process.env.PATH = priv.path;
  const result: any = await resumePipeline(ID, {
    delegation: {}, wait: true, timeoutMs: 5000, cwd: repo, verifyCommandJson: "checks.json",
    ...(setup.council ? { council: setup.council } : {}),
    councilDeps: { triage: setup.triage, stateDir: state.stateDir, crossHarness: parseCrossHarnessConfig("1") },
  });
  const handoffPath = join(dir, "reviewer.md");
  const actions = harness.calls().map((argv) => argv[0] === "external-run" ? `external-run:${argv[argv.indexOf("--action") + 1]}` : argv[0]).filter((action) => action !== "quota-normalize");
  return {
    result,
    actions,
    handoff: existsSync(handoffPath) ? readFileSync(handoffPath, "utf8") : undefined,
    membersRan: existsSync(ran) ? readFileSync(ran, "utf8").split("\n").filter(Boolean).length : 0,
    states: result.run.stages.map((stage: any) => [stage.role, stage.state]),
    judged: harness.callsFor("review-judge").length,
  };
}

describe("pipeline council", () => {
  it("leaves the pipeline as it was by default", async () => {
    const triage = triageOf("architectural");
    const run = await execute({ triage });
    expect(run.handoff).toBe(PLAIN_HANDOFF);
    expect(run.states).toEqual([["implementer", "verified"], ["reviewer", "verified"]]);
    expect(run.membersRan).toBe(0);
    expect(triage.calls).toEqual([]);
    expect(run.result.error).toBeUndefined();
  });

  it("does nothing extra with council off", async () => {
    const triage = triageOf("architectural");
    const run = await execute({ triage, council: "off" });
    expect(run.handoff).toBe(PLAIN_HANDOFF);
    expect(run.membersRan).toBe(0);
    expect(triage.calls).toEqual([]);
  });

  it("appends the council under its own heading for a moderate objective and changes nothing else", async () => {
    const baseline = await execute();
    harness?.restore();
    rmSync(state.stateDir, { recursive: true, force: true });
    const triage = triageOf("moderate");
    const run = await execute({ triage, council: "auto" });
    expect(triage.calls).toEqual([TASK]);
    expect(run.membersRan).toBe(3);
    expect(run.handoff!.startsWith(PLAIN_HANDOFF)).toBe(true);
    expect(run.handoff).toContain("\n## Council (consultative only)\n");
    expect(run.handoff!.indexOf("## Council (consultative only)")).toBeGreaterThan(PLAIN_HANDOFF.length - 1);
    expect(run.states).toEqual(baseline.states);
    expect(run.actions).toEqual(baseline.actions);
    expect(run.judged).toBe(baseline.judged);
    expect(run.result.run.stages.map((stage: any) => stage.state)).toEqual(baseline.result.run.stages.map((stage: any) => stage.state));
    expect(run.result.error).toBeUndefined();
  });

  it("writes only the skip note into the handoff for a routine objective and runs no member", async () => {
    const run = await execute({ triage: triageOf("routine"), council: "auto" });
    expect(run.handoff).toBe(`${PLAIN_HANDOFF}\n## Council (consultative only)\n\ncouncil skipped: triage routine\n`);
    expect(run.membersRan).toBe(0);
    expect(run.states).toEqual([["implementer", "verified"], ["reviewer", "verified"]]);
  });

  it("notes an unavailable triage and still verifies the reviewer", async () => {
    const triage: TriageFn = async () => {
      throw new Error("down");
    };
    const run = await execute({ triage, council: "auto" });
    expect(run.handoff).toContain("council skipped: triage unavailable");
    expect(run.membersRan).toBe(0);
    expect(run.states).toEqual([["implementer", "verified"], ["reviewer", "verified"]]);
  });

  it("does not touch the stage state when the review needs changes", async () => {
    const off = await execute({ verdicts: "default=CHANGES_REQUIRED" });
    harness?.restore();
    rmSync(state.stateDir, { recursive: true, force: true });
    const auto = await execute({ verdicts: "default=CHANGES_REQUIRED", triage: triageOf("architectural"), council: "auto" });
    expect(off.states).toEqual([["implementer", "verified"], ["reviewer", "failed"]]);
    expect(auto.states).toEqual(off.states);
    expect(auto.actions).toEqual(off.actions);
    expect(auto.handoff).toBeUndefined();
  });
});
