import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCouncilText, consultCouncil, parseCouncilMembers, parseCouncilTimeout, renderReview, REVIEW_COUNCIL_HEADING, runCouncilCommand, startCouncilAlongside } from "../src/council/command.js";
import { parseCrossHarnessConfig } from "../src/delegation/cross-harness.js";
import { fakeSpawn, makeRepo, ok, writeIn } from "./council-helpers.js";
import { fakeJev } from "./council-synth-support.js";
import { createTestStateDir } from "./helpers.js";

let repo: string;
let state: { stateDir: string; cleanup: () => void };

beforeEach(() => {
  repo = makeRepo();
  state = createTestStateDir();
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
    codex: () => ok("- [P1] Codex issue — /x/src/a.ts:1-1\n  detail"),
    kimi: () => ok(finding("Kimi issue")),
    agy: () => ok(JSON.stringify({ result: "NO_FINDINGS" })),
  });
}

describe("council command parsing", () => {
  it("accepts the three members and the agy alias, once each", () => {
    expect(parseCouncilMembers("codex, Kimi,agy,antigravity,codex")).toEqual(["codex", "kimi", "antigravity"]);
    expect(parseCouncilMembers(undefined)).toBeUndefined();
  });

  it("rejects unknown and empty member lists", () => {
    expect(() => parseCouncilMembers("codex,gemini")).toThrow("unknown council member");
    expect(() => parseCouncilMembers(" , ")).toThrow("no council member");
  });

  it("bounds the timeout", () => {
    expect(parseCouncilTimeout("5000")).toBe(5000);
    expect(parseCouncilTimeout(undefined)).toBeUndefined();
    for (const bad of ["abc", "999", "-5", "1.5", String(31 * 60 * 1000)]) expect(() => parseCouncilTimeout(bad)).toThrow("invalid council timeout");
  });
});

describe("herdr-jev council", () => {
  it("exits 0 and prints the summary when the council ran, whatever it found", async () => {
    const fake = members();
    const result = await runCouncilCommand({}, { cwd: repo, client: "claude" }, { spawn: fake.spawn, jev: fakeJev(), stateDir: state.stateDir, crossHarness: all() });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Evidence rule");
    expect(result.output).toContain("Kimi issue");
    expect(result.output).toContain("Members");
    expect(fake.reviewCalls.map((call) => call.argv[0]).sort()).toEqual(["agy", "codex", "kimi"]);
  });

  it("prints a JSON object with run and summary", async () => {
    const result = await runCouncilCommand({ json: true }, { cwd: repo, client: "claude" }, { spawn: members().spawn, jev: fakeJev(), stateDir: state.stateDir, crossHarness: all() });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output);
    expect(Object.keys(parsed).sort()).toEqual(["notes", "run", "summary"]);
    expect(parsed.run.ran).toBe(true);
    expect(parsed.run.members.map((entry: { member: string }) => entry.member)).toEqual(["codex", "kimi", "antigravity"]);
    expect(Object.keys(parsed.summary).sort()).toEqual(["agreements", "disagreements", "messages", "notes", "scoredBy", "unique"]);
    expect(parsed.summary.scoredBy).toBe("jev");
    expect(parsed.summary.unique.length + parsed.summary.agreements.length).toBeGreaterThan(0);
    expect(parsed.notes).toEqual([]);
  });

  it("exits 2 when cross-harness delegation leaves fewer than two members", async () => {
    const fake = members();
    const result = await runCouncilCommand({}, { cwd: repo, client: "claude" }, { spawn: fake.spawn, jev: fakeJev(), stateDir: state.stateDir, crossHarness: parseCrossHarnessConfig("0") });
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("Council did not run");
    expect(result.output).toContain("cross-harness delegation is disabled");
    expect(fake.reviewCalls).toEqual([]);
  });

  it("exits 2 on an empty diff", async () => {
    rmSync(repo, { recursive: true, force: true });
    repo = makeRepo();
    const result = await runCouncilCommand({ json: true }, { cwd: repo, client: "claude" }, { spawn: members().spawn, jev: fakeJev(), stateDir: state.stateDir, crossHarness: all() });
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.output).run.ran).toBe(false);
  });

  it("exits 2 when the run is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runCouncilCommand({ json: true }, { cwd: repo, client: "claude" }, { spawn: members().spawn, jev: fakeJev(), stateDir: state.stateDir, crossHarness: all() }, controller.signal);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.output).run.note).toBe("cancelled");
  });

  it("exits 2 on an invalid member or timeout without running anything", async () => {
    const fake = members();
    const deps = { spawn: fake.spawn, jev: fakeJev(), stateDir: state.stateDir, crossHarness: all() };
    const member = await runCouncilCommand({ members: "codex,gemini" }, { cwd: repo, client: "claude" }, deps);
    expect(member.exitCode).toBe(2);
    expect(member.output).toContain("unknown council member");
    const timeout = await runCouncilCommand({ timeout: "nope", json: true }, { cwd: repo, client: "claude" }, deps);
    expect(timeout.exitCode).toBe(2);
    expect(JSON.parse(timeout.output).error).toContain("invalid council timeout");
    expect(fake.calls).toEqual([]);
  });

  it("drops a requested member that the cross-harness configuration excludes and says so", async () => {
    const fake = members();
    const crossHarness = parseCrossHarnessConfig('{"claude":["codex","kimi"]}');
    const result = await runCouncilCommand({ members: "codex,kimi,antigravity", json: true }, { cwd: repo, client: "claude" }, { spawn: fake.spawn, jev: fakeJev(), stateDir: state.stateDir, crossHarness });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output);
    expect(parsed.notes).toEqual(["requested member antigravity was dropped: client claude cannot use it under the cross-harness configuration"]);
    expect(parsed.run.members.find((entry: { member: string }) => entry.member === "antigravity")).toMatchObject({ status: "skipped", reason: "client not available" });
    expect(fake.reviewCalls.map((call) => call.argv[0]).sort()).toEqual(["codex", "kimi"]);
    const text = await runCouncilCommand({ members: "codex,kimi,antigravity" }, { cwd: repo, client: "claude" }, { spawn: members().spawn, jev: fakeJev(), stateDir: state.stateDir, crossHarness });
    expect(text.output).toContain("requested member antigravity was dropped");
  });

  it("narrows to the requested members without adding any", async () => {
    const fake = members();
    const result = await runCouncilCommand({ members: "codex,agy" }, { cwd: repo, client: "claude" }, { spawn: fake.spawn, jev: fakeJev(), stateDir: state.stateDir, crossHarness: all() });
    expect(result.exitCode).toBe(0);
    expect(fake.reviewCalls.map((call) => call.argv[0]).sort()).toEqual(["agy", "codex"]);
  });

  it("never uses the source client as a member", async () => {
    const fake = members();
    const result = await runCouncilCommand({ json: true }, { cwd: repo, client: "codex" }, { spawn: fake.spawn, jev: fakeJev(), stateDir: state.stateDir, crossHarness: all() });
    expect(result.exitCode).toBe(0);
    expect(fake.reviewCalls.map((call) => call.argv[0]).sort()).toEqual(["agy", "kimi"]);
  });

  it("falls back to unscored findings when Jev is unavailable and still exits 0", async () => {
    const jev = fakeJev({ fail: () => new Error("jev down") });
    const result = await runCouncilCommand({ json: true }, { cwd: repo, client: "claude" }, { spawn: members().spawn, jev, stateDir: state.stateDir, crossHarness: all() });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output).summary.scoredBy).toBe("none");
  });
});

describe("herdr-jev review --council", () => {
  const report = { session: "s", client: "claude", cwd: "/r", base: "main", scopes: [], judges: [], status: "needs_changes" };

  it("leaves the review report and status untouched in the JSON output", async () => {
    const council = await consultCouncil({ cwd: repo, client: "claude" }, { spawn: members().spawn, jev: fakeJev(), stateDir: state.stateDir, crossHarness: all() });
    const without = JSON.parse(renderReview(report, "text", undefined, true));
    const withCouncil = JSON.parse(renderReview(report, "text", council, true));
    const { council: added, ...rest } = withCouncil;
    expect(rest).toEqual(without);
    expect(without).toEqual(report);
    expect(withCouncil.status).toBe("needs_changes");
    expect(Object.keys(added).sort()).toEqual(["notes", "ran", "run", "summary"]);
    expect(added.ran).toBe(true);
  });

  it("appends the council text under a separate heading and leaves the review text as it was", async () => {
    const council = await consultCouncil({ cwd: repo, client: "claude" }, { spawn: members().spawn, jev: fakeJev(), stateDir: state.stateDir, crossHarness: all() });
    expect(renderReview(report, "REVIEW TEXT", undefined, false)).toBe("REVIEW TEXT");
    const text = renderReview(report, "REVIEW TEXT", council, false);
    expect(text.startsWith("REVIEW TEXT\n\n")).toBe(true);
    expect(text).toBe(appendCouncilText("REVIEW TEXT", council));
    expect(text.indexOf(REVIEW_COUNCIL_HEADING)).toBeGreaterThan("REVIEW TEXT".length);
    expect(text).toContain("Kimi issue");
  });

  it("shows a council failure as a note and keeps the review output", async () => {
    const alongside = startCouncilAlongside({}, { cwd: repo, client: "claude" }, { spawn: () => { throw new Error("spawn exploded"); }, jev: fakeJev(), stateDir: state.stateDir, crossHarness: all() });
    const council = await alongside.promise;
    expect(council.run.ran).toBe(false);
    const json = JSON.parse(renderReview(report, "REVIEW TEXT", council, true));
    expect(json.status).toBe("needs_changes");
    expect(json.council.ran).toBe(false);
    const text = renderReview(report, "REVIEW TEXT", council, false);
    expect(text.startsWith("REVIEW TEXT")).toBe(true);
    expect(text).toContain("Council did not run");
  });

  it("never rejects, even for a directory that is not a repository", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "council-nogit-"));
    try {
      const council = await startCouncilAlongside({}, { cwd: elsewhere, client: "claude" }, { spawn: members().spawn, jev: fakeJev(), stateDir: state.stateDir, crossHarness: all() }).promise;
      expect(council.run.ran).toBe(false);
      expect(council.text).toContain("Council did not run");
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("turns an invalid member list into a note instead of failing", async () => {
    const council = await startCouncilAlongside({ members: "gemini" }, { cwd: repo, client: "claude" }, { spawn: members().spawn, stateDir: state.stateDir, crossHarness: all() }).promise;
    expect(council.run.ran).toBe(false);
    expect(council.run.note).toContain("unknown council member");
  });

  it("stops the council when aborted", async () => {
    const fake = fakeSpawn({ codex: () => "hang", kimi: () => "hang" });
    const alongside = startCouncilAlongside({}, { cwd: repo, client: "claude" }, { spawn: fake.spawn, jev: fakeJev(), stateDir: state.stateDir, crossHarness: all() });
    await new Promise((resolve) => setTimeout(resolve, 300));
    alongside.abort();
    const council = await alongside.promise;
    expect(council.run.ran).toBe(false);
    expect(council.run.note).toBe("cancelled");
  });
});

describe("herdr-jev council process", () => {
  function cli(args: string[], cwd: string, extra: Record<string, string> = {}) {
    const home = mkdtempSync(join(tmpdir(), "council-cli-home-"));
    try {
      const started = Date.now();
      const run = spawnSync(process.execPath, [join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
        cwd,
        encoding: "utf8",
        timeout: 60_000,
        env: { PATH: process.env.PATH ?? "", HOME: home, HERDR_JEV_TEST_GUARD: "1", AI_HARNESS_TEST_GUARD: "1", HERDR_JEV_STATE_DIR: state.stateDir, HERDR_JEV_CONFIG_DIR: join(home, "config"), AI_HARNESS_GENERATED_DIR: join(home, "generated"), ...extra },
      });
      return { status: run.status, stdout: run.stdout, stderr: run.stderr, ms: Date.now() - started };
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  it("exits 2 promptly with a readable message when no council can run", () => {
    const run = cli(["council"], repo);
    expect(run.status).toBe(2);
    expect(run.stdout).toContain("Council did not run");
    expect(run.ms).toBeLessThan(30_000);
  });

  it("exits 2 with JSON on an invalid member", () => {
    const run = cli(["council", "--council-members", "gemini", "--json"], repo);
    expect(run.status).toBe(2);
    expect(JSON.parse(run.stdout).error).toContain("unknown council member");
  });
});
