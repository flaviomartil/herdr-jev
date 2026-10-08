import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCouncilText, consultCouncil, COUNCIL_CANCELLED_BY_REVIEW, parseCouncilMembers, parseCouncilTimeout, parseCouncilWait, renderReview, REVIEW_COUNCIL_HEADING, runCouncilCommand, sanitizeRun, startCouncilAlongside } from "../src/council/command.js";
import { resolveCouncilApiKey } from "../src/council/key.js";
import { parseCrossHarnessConfig } from "../src/delegation/cross-harness.js";
import { fakeSpawn, git, makeRepo, ok, privatePath, writeIn } from "./council-helpers.js";
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

const j = (...parts: string[]) => parts.join("");
const TOKEN = j("gh", "p_", "Zk3Qp9Lm2Xv7Rt5Yb8Nc1Hd4Gf6Js0WqAaUu");
const FALLBACK_SECRET = "Sup3rSecretPw99";
const FALLBACK_DETAIL = `const password = process.env.DB_PASSWORD || "${FALLBACK_SECRET}"`;

function leaking() {
  return fakeSpawn({
    codex: () => ok(`- [P1] leaks ${TOKEN} in a header — /x/src/a.ts:1-1\n  ${FALLBACK_DETAIL}`),
    kimi: () => ({ exitCode: 3, stdout: "", stderr: `auth failed for ${TOKEN}` }),
    agy: () => ok(JSON.stringify({ result: "NO_FINDINGS" })),
  });
}

describe("council JSON output is redacted", () => {
  it("herdr-jev council prints sanitized findings, reasons and notes", async () => {
    const result = await runCouncilCommand({ json: true }, { cwd: repo, client: "claude" }, { spawn: leaking().spawn, jev: fakeJev(), stateDir: state.stateDir, crossHarness: all() });
    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain(TOKEN);
    expect(result.output).not.toContain(FALLBACK_SECRET);
    const parsed = JSON.parse(result.output);
    const codex = parsed.run.members.find((entry: { member: string }) => entry.member === "codex");
    expect(codex.findings).toHaveLength(1);
    expect(codex.findings[0].title).toContain("[REDACTED]");
    expect(codex.findings[0].detail).toContain("[REDACTED]");
    expect(parsed.run.members.find((entry: { member: string }) => entry.member === "kimi").reason).toContain("[REDACTED]");
  });

  it("review --council attaches the same sanitized run", async () => {
    const council = await consultCouncil({ cwd: repo, client: "claude" }, { spawn: leaking().spawn, jev: fakeJev(), stateDir: state.stateDir, crossHarness: all() });
    const json = renderReview({ status: "ready" }, "text", council, true);
    expect(json).not.toContain(TOKEN);
    expect(json).not.toContain(FALLBACK_SECRET);
    expect(council.text).not.toContain(TOKEN);
    expect(council.text).not.toContain(FALLBACK_SECRET);
  });

  it("sanitizeRun redacts reason, note, run note and skipped paths", () => {
    const run = sanitizeRun({
      diffHash: "h",
      ran: true,
      note: `token ${TOKEN}`,
      skippedPaths: [`dir/${TOKEN}.txt`],
      members: [{ member: "kimi", status: "failed", reason: `exit 3: ${TOKEN}`, note: `scrubbed ${TOKEN}`, findings: [], durationMs: 1 }],
    });
    expect(JSON.stringify(run)).not.toContain(TOKEN);
    expect(run.members[0]!.reason).toContain("[REDACTED]");
    expect(run.members[0]!.note).toContain("[REDACTED]");
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

  it("reviews against the default branch when no base is given, like the review does", async () => {
    git(repo, "checkout", "-q", "-b", "feature");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "work");
    const plain = await consultCouncil({ cwd: repo, client: "claude" }, { spawn: members().spawn, jev: fakeJev(), stateDir: state.stateDir, crossHarness: all() });
    expect(plain.run.ran).toBe(false);
    const fake = members();
    const council = await startCouncilAlongside({}, { cwd: repo, client: "claude" }, { spawn: fake.spawn, jev: fakeJev(), stateDir: state.stateDir, crossHarness: all() }).promise;
    expect(council.run.ran).toBe(true);
    expect(fake.reviewCalls.length).toBeGreaterThan(0);
    const explicit = await startCouncilAlongside({ base: "main" }, { cwd: repo, client: "claude" }, { spawn: members().spawn, jev: fakeJev(), stateDir: state.stateDir, crossHarness: all() }).promise;
    expect(explicit.run.ran).toBe(true);
  });

  it("stops waiting once the wait elapses, cancels the council and says why", async () => {
    const fake = fakeSpawn({ codex: () => "hang", kimi: () => "hang" });
    const alongside = startCouncilAlongside({ wait: "200", timeout: "30000" }, { cwd: repo, client: "claude" }, { spawn: fake.spawn, jev: fakeJev(), stateDir: state.stateDir, crossHarness: all() });
    const started = performance.now();
    const council = await alongside.settle();
    expect(performance.now() - started).toBeLessThan(5000);
    expect(council.run.ran).toBe(false);
    expect(council.run.note).toBe(COUNCIL_CANCELLED_BY_REVIEW);
    expect(council.text).toContain("Council did not run: cancelled (review finished first)");
    await alongside.promise;
    expect(fake.reviewCalls.every((call) => call.killed)).toBe(true);
  });

  it("returns the finished council at once when it settles before the wait", async () => {
    const alongside = startCouncilAlongside({ wait: "30000" }, { cwd: repo, client: "claude" }, { spawn: members().spawn, jev: fakeJev(), stateDir: state.stateDir, crossHarness: all() });
    expect((await alongside.settle()).run.ran).toBe(true);
  });

  it("passes the per-member timeout to the run", async () => {
    const fake = fakeSpawn({ codex: () => "hang", kimi: () => "hang" });
    const council = await startCouncilAlongside({ timeout: "1000", wait: "30000" }, { cwd: repo, client: "claude" }, { spawn: fake.spawn, jev: fakeJev(), stateDir: state.stateDir, crossHarness: all() }).settle();
    expect(council.run.ran).toBe(true);
    expect(council.run.members.filter((entry) => entry.status === "failed").map((entry) => entry.reason)).toEqual(["timed out after 1s", "timed out after 1s"]);
  });

  it("turns an invalid wait or timeout into a note", async () => {
    for (const options of [{ wait: "abc" }, { wait: String(31 * 60 * 1000) }, { timeout: "5" }]) {
      const council = await startCouncilAlongside(options, { cwd: repo, client: "claude" }, { spawn: members().spawn, stateDir: state.stateDir, crossHarness: all() }).settle();
      expect(council.run.ran).toBe(false);
      expect(council.run.note).toMatch(/invalid council (wait|timeout)/);
    }
    expect(parseCouncilWait(undefined)).toBe(60_000);
    expect(parseCouncilWait("0")).toBe(0);
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

describe("council key lookup", () => {
  it("does not stall the event loop while the vault is slow, and gives up after the timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "council-vault-"));
    const savedPath = process.env.PATH;
    const savedKey = process.env.TYPESAFE_API_KEY;
    writeFileSync(join(dir, "vault"), "#!/bin/sh\nexec sleep 30\n");
    chmodSync(join(dir, "vault"), 0o755);
    process.env.PATH = `${dir}:${savedPath}`;
    delete process.env.TYPESAFE_API_KEY;
    try {
      let ticks = 0;
      const timer = setInterval(() => { ticks += 1; }, 20);
      const started = performance.now();
      const key = await resolveCouncilApiKey(500);
      clearInterval(timer);
      expect(key).toBeNull();
      expect(performance.now() - started).toBeLessThan(5000);
      expect(ticks).toBeGreaterThan(5);
    } finally {
      process.env.PATH = savedPath;
      if (savedKey !== undefined) process.env.TYPESAFE_API_KEY = savedKey;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the key from the environment without asking the vault", async () => {
    const saved = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = " abc ";
    try {
      expect(await resolveCouncilApiKey(10)).toBe("abc");
    } finally {
      if (saved === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = saved;
    }
  });

  it("lists findings unscored with a note when the key is missing", async () => {
    const council = await consultCouncil({ cwd: repo, client: "claude" }, { spawn: members().spawn, stateDir: state.stateDir, crossHarness: all(), resolveKey: async () => null });
    expect(council.run.ran).toBe(true);
    expect(council.summary.scoredBy).toBe("none");
    expect(council.summary.messages.join(" ")).toContain("Jev unavailable");
  });
});

describe("herdr-jev council process", () => {
  function cli(args: string[], cwd: string, extra: Record<string, string> = {}, behaviours: Parameters<typeof privatePath>[1] = {}) {
    const home = mkdtempSync(join(tmpdir(), "council-cli-home-"));
    const priv = privatePath(home, behaviours);
    try {
      const started = performance.now();
      const run = spawnSync(process.execPath, [join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
        cwd,
        encoding: "utf8",
        timeout: 60_000,
        env: { PATH: priv.path, HOME: home, HERDR_ENV: "0", TYPESAFE_API_KEY: "", HERDR_JEV_TEST_GUARD: "1", AI_HARNESS_TEST_GUARD: "1", HERDR_JEV_STATE_DIR: state.stateDir, HERDR_JEV_CONFIG_DIR: join(home, "config"), AI_HARNESS_GENERATED_DIR: join(home, "generated"), ...extra },
      });
      return { status: run.status, stdout: run.stdout, stderr: run.stderr, ms: performance.now() - started, reached: priv.reached() };
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  it("exits 2 promptly with a readable message when no council can run", () => {
    const run = cli(["council"], repo);
    expect(run.status).toBe(2);
    expect(run.stdout).toContain("Council did not run");
    expect(run.ms).toBeLessThan(30_000);
    expect(run.reached).toEqual([]);
  });

  it("takes the session client from --client and never makes it a member", () => {
    const behaviours = { kimi: "echo NO_FINDINGS", agy: `echo '{"result":"NO_FINDINGS"}'` };
    const env = { HERDR_JEV_CROSS_HARNESS: "1" };
    const codex = cli(["council", "--client", "codex", "--json"], repo, env, behaviours);
    expect(codex.status).toBe(0);
    const parsed = JSON.parse(codex.stdout);
    expect(parsed.run.members.map((entry: { member: string; status: string }) => [entry.member, entry.status])).toEqual([["codex", "skipped"], ["kimi", "done"], ["antigravity", "done"]]);
    expect(codex.reached).toEqual([]);
    const kimi = cli(["council", "--client", "kimi", "--json"], repo, env, { codex: "echo NO_FINDINGS", agy: behaviours.agy });
    expect(JSON.parse(kimi.stdout).run.members.map((entry: { member: string; status: string }) => [entry.member, entry.status])).toEqual([["codex", "done"], ["kimi", "skipped"], ["antigravity", "done"]]);
    const agy = cli(["council", "--client", "agy", "--json"], repo, env, { codex: "echo NO_FINDINGS", kimi: "echo NO_FINDINGS" });
    expect(agy.reached).toEqual([]);
    expect(JSON.parse(agy.stdout).run.members.map((entry: { member: string; status: string }) => [entry.member, entry.status])).toEqual([["codex", "done"], ["kimi", "done"], ["antigravity", "skipped"]]);
  });

  it("prints the findings of a real run redacted", () => {
    const finding = JSON.stringify({ path: "src/a.ts", line: 1, severity: "high", title: `leaks ${TOKEN}`, detail: FALLBACK_DETAIL });
    const run = cli(["council", "--client", "codex", "--json"], repo, { HERDR_JEV_CROSS_HARNESS: "1" }, { kimi: `echo '${finding}'`, agy: `echo '{"result":"NO_FINDINGS"}'` });
    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain(TOKEN);
    expect(run.stdout).not.toContain(FALLBACK_SECRET);
    expect(JSON.parse(run.stdout).run.members[1].findings).toHaveLength(1);
  });

  it("refuses to run when the state directory is inside the repository and not ignored", () => {
    const inside = join(repo, ".herdr-state");
    const run = cli(["council", "--client", "codex", "--json"], repo, { HERDR_JEV_CROSS_HARNESS: "1", HERDR_JEV_STATE_DIR: inside }, { kimi: "echo NO_FINDINGS", agy: `echo '{"result":"NO_FINDINGS"}'` });
    expect(run.status).toBe(2);
    expect(JSON.parse(run.stdout).run.note).toContain("state_dir_inside_repo");
  });

  it("exits 2 with JSON on an invalid member", () => {
    const run = cli(["council", "--council-members", "gemini", "--json"], repo);
    expect(run.status).toBe(2);
    expect(JSON.parse(run.stdout).error).toContain("unknown council member");
  });
});
