import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { envFileKeys, loadEnvFile, reviewExcludedEnv, withoutKeys } from "../src/config/env-file.js";
import { buildJudgePrompt, formatReviewReport, listChangedFiles, parseHunkRanges, runReview } from "../src/harness/review.js";
import { createFakeHarness, fakeHarnessCommands, type FakeHarness, type FakeHarnessMode } from "./fake-harness.js";
import { assertNoRealHomeStateLeaks, createTestStateDir } from "./helpers.js";

let testEnv: { stateDir: string; cleanup: () => void };
let harness: FakeHarness | undefined;
let repo: string;
let scratch: string;
const touchedEnv: string[] = [];

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, encoding: "utf8" });
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

function write(path: string, content: string) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function lines(count: number, mark = ""): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}${mark}`).join("\n") + "\n";
}

function seedMergedRepository(): string {
  git(repo, "init", "-q", "-b", "main");
  write("package.json", JSON.stringify({ scripts: { test: "bun test" } }));
  write("src/a.ts", lines(30));
  write("docs/x.md", "doc\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  const first = git(repo, "rev-parse", "HEAD");
  write("src/a.ts", lines(30).replace("line 5\n", "line 5 changed\n").replace("line 20\n", "line 20 changed\nline 20b\nline 20c\n"));
  write("src/b.ts", "export const b = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "work");
  return first;
}

function install(mode: FakeHarnessMode = "contract", env: Record<string, string> = {}) {
  harness = createFakeHarness(mode, env);
}

function setEnv(key: string, value: string) {
  touchedEnv.push(key);
  process.env[key] = value;
}

beforeEach(() => {
  testEnv = createTestStateDir();
  repo = realpathSync(mkdtempSync(join(tmpdir(), "review-fix-repo-")));
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "review-fix-scratch-")));
});

afterEach(() => {
  harness?.restore();
  harness = undefined;
  for (const key of touchedEnv.splice(0)) delete process.env[key];
  rmSync(repo, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
  testEnv.cleanup();
  assertNoRealHomeStateLeaks();
});

describe("item 1: environment leak", () => {
  it("preload removes every HERDR_JEV configuration variable and keeps only the guard and a private state directory", () => {
    const preload = resolve(import.meta.dir, "preload.ts");
    const result = spawnSync(process.execPath, ["--preload", preload, "-e", "console.log(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('HERDR_JEV_') || key === 'AI_HARNESS_ROOT'))))"], {
      encoding: "utf8", env: { PATH: process.env.PATH ?? "", HERDR_JEV_CROSS_HARNESS: "", HERDR_JEV_CODEX_EXHAUSTED: "1", HERDR_JEV_STATE_DIR: "/preset/state", HERDR_JEV_ANTIGRAVITY_REVIEWER: "x", AI_HARNESS_ROOT: "/kept/root" } });
    expect(result.status).toBe(0);
    const seen = JSON.parse(result.stdout);
    expect(Object.keys(seen).sort()).toEqual(["AI_HARNESS_ROOT", "HERDR_JEV_STATE_DIR", "HERDR_JEV_TEST_GUARD"]);
    expect(seen.HERDR_JEV_TEST_GUARD).toBe("1");
    expect(seen.HERDR_JEV_STATE_DIR).not.toBe("/preset/state");
    expect(seen.HERDR_JEV_STATE_DIR.startsWith(tmpdir())).toBe(true);
    expect(seen.AI_HARNESS_ROOT).toBe("/kept/root");
  });

  it("the running suite carries no HERDR_JEV configuration besides the guard and state directory", () => {
    const configuration = Object.keys(process.env).filter((key) => key.startsWith("HERDR_JEV_") && !["HERDR_JEV_STATE_DIR", "HERDR_JEV_TEST_GUARD"].includes(key));
    expect(configuration).toEqual([]);
  });

  it("loadEnvFile reports only the keys it set and never overrides an existing value", () => {
    const file = join(scratch, "env");
    writeFileSync(file, ["# comment", "A=1", 'B="two"', "C=kept", "=bad", "D='x y'", "EMPTY="].join("\n"));
    const env: NodeJS.ProcessEnv = { C: "already" };
    expect(loadEnvFile(file, env)).toEqual(["A", "B", "D", "EMPTY"]);
    expect(env).toEqual({ A: "1", B: "two", C: "already", D: "x y", EMPTY: "" });
    expect(loadEnvFile(join(scratch, "missing"), env)).toEqual([]);
    expect(envFileKeys()).not.toContain("A");
  });

  it("drops the file-only keys from a copy of the environment and keeps AI_HARNESS_ROOT", () => {
    const env: NodeJS.ProcessEnv = { HERDR_JEV_X: "1", AI_HARNESS_ROOT: "/root", PATH: "/bin" };
    expect(reviewExcludedEnv(["HERDR_JEV_X", "AI_HARNESS_ROOT"])).toEqual(["HERDR_JEV_X"]);
    expect(withoutKeys(env, ["HERDR_JEV_X", "AI_HARNESS_ROOT"])).toEqual({ AI_HARNESS_ROOT: "/root", PATH: "/bin" });
    expect(env.HERDR_JEV_X).toBe("1");
  });

  it("runs the verification and every judge without the file-only variables", async () => {
    seedMergedRepository();
    write("src/c.ts", "export const c = 1;\n");
    install("contract", { FAKE_PROFILE: "1", FAKE_ENV_PROBE: "HERDR_JEV_PROBE_FROM_FILE,HERDR_JEV_PROBE_EXPORTED,AI_HARNESS_ROOT" });
    setEnv("HERDR_JEV_PROBE_FROM_FILE", "live-value");
    setEnv("HERDR_JEV_PROBE_EXPORTED", "exported-value");
    const report = await runReview({ cwd: repo, client: "codex", session: "env-1", scopes: "core=src;docs=docs", excludeEnv: ["HERDR_JEV_PROBE_FROM_FILE", "AI_HARNESS_ROOT"] });
    expect(report.status).toBe("ready");
    const entries = fakeHarnessCommands(harness!);
    expect(entries.map((entry) => entry.command).sort()).toEqual(["review-judge", "review-judge", "review-verify"]);
    for (const entry of entries) {
      expect(entry.env.HERDR_JEV_PROBE_FROM_FILE).toBeNull();
      expect(entry.env.HERDR_JEV_PROBE_EXPORTED).toBe("exported-value");
      expect(entry.env.AI_HARNESS_ROOT).toBe(harness!.root);
    }
    expect(process.env.HERDR_JEV_PROBE_FROM_FILE).toBe("live-value");
  });

  it("passes the whole environment when nothing was loaded from the env files", async () => {
    seedMergedRepository();
    write("src/c.ts", "export const c = 1;\n");
    install("contract", { FAKE_PROFILE: "1", FAKE_ENV_PROBE: "HERDR_JEV_PROBE_FROM_FILE" });
    setEnv("HERDR_JEV_PROBE_FROM_FILE", "live-value");
    await runReview({ cwd: repo, client: "codex", session: "env-2", scopes: "core=src" });
    for (const entry of fakeHarnessCommands(harness!)) expect(entry.env.HERDR_JEV_PROBE_FROM_FILE).toBe("live-value");
  });

  it("the CLI loads the env file for itself but hides those variables from the verification and judges", () => {
    seedMergedRepository();
    write("src/c.ts", "export const c = 1;\n");
    install("contract", { FAKE_PROFILE: "1", FAKE_ENV_PROBE: "HERDR_JEV_PROBE_FROM_FILE,AI_HARNESS_ROOT,HERDR_JEV_PROBE_EXPORTED" });
    const home = join(scratch, "home");
    mkdirSync(join(home, ".config/herdr"), { recursive: true });
    writeFileSync(join(home, ".config/herdr/.env"), "HERDR_JEV_PROBE_FROM_FILE=from-file\nHERDR_JEV_SPLIT_DIRECTION=left\n");
    const cli = resolve(import.meta.dir, "../src/cli.ts");
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, HERDR_ENV: "0", TYPESAFE_API_KEY: "", HERDR_JEV_PROBE_EXPORTED: "exported-value" };
    delete env.HERDR_JEV_SPLIT_DIRECTION;
    const status = spawnSync(process.execPath, [cli, "status"], { encoding: "utf8", env, cwd: repo, timeout: 120_000 });
    expect(status.stdout).toContain("Split Direction: LEFT");
    const result = spawnSync(process.execPath, [cli, "review", "--client", "codex", "--json", "--scopes", "core=src", "--session", "env-cli"], { encoding: "utf8", env, cwd: repo, timeout: 120_000 });
    expect(JSON.parse(result.stdout).status).toBe("ready");
    const entries = fakeHarnessCommands(harness!);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    for (const entry of entries) {
      expect(entry.env.HERDR_JEV_PROBE_FROM_FILE).toBeNull();
      expect(entry.env.HERDR_JEV_PROBE_EXPORTED).toBe("exported-value");
      expect(entry.env.AI_HARNESS_ROOT).toBe(harness!.root);
    }
  });
});

describe("item 2: --base", () => {
  it("lists nothing against the default branch once the work is merged", () => {
    seedMergedRepository();
    expect(listChangedFiles(repo)).toEqual({ base: "main", files: [], ranges: {} });
  });

  it("lists the files since the base ref plus the working tree and untracked files, with line ranges", () => {
    const first = seedMergedRepository();
    write("docs/x.md", "doc changed\n");
    write("notes/new.md", "new\n");
    const changed = listChangedFiles(repo, first);
    expect(changed.base).toBe(first);
    expect(changed.files).toEqual(["docs/x.md", "notes/new.md", "src/a.ts", "src/b.ts"]);
    expect(changed.ranges["src/a.ts"]).toEqual(["5", "20-22"]);
    expect(changed.ranges["src/b.ts"]).toEqual(["1"]);
    expect(changed.ranges["docs/x.md"]).toEqual(["1"]);
    expect(changed.ranges["notes/new.md"]).toEqual(["new file"]);
  });

  it("uses the merge base so commits made on the base after the branch point are not counted", () => {
    git(repo, "init", "-q", "-b", "main");
    write("package.json", JSON.stringify({ scripts: { test: "bun test" } }));
    write("src/a.ts", lines(5));
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
    git(repo, "checkout", "-q", "-b", "feature");
    write("src/feature.ts", "f\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "feature");
    git(repo, "checkout", "-q", "main");
    write("src/main-only.ts", "m\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "main only");
    git(repo, "checkout", "-q", "feature");
    expect(listChangedFiles(repo, "main").files).toEqual(["src/feature.ts"]);
  });

  it("rejects a ref that is not a commit and a ref that looks like an option", () => {
    seedMergedRepository();
    expect(() => listChangedFiles(repo, "no-such-ref")).toThrow("invalid_base");
    expect(() => listChangedFiles(repo, "--output=/tmp/x")).toThrow("invalid_base");
    expect(() => listChangedFiles(repo, " ")).toThrow("invalid_base");
  });

  it("parses hunk headers into ranges, marks deletions and caps the ranges per file", () => {
    const diff = ["diff --git a/f.ts b/f.ts", "index 1..2 100644", "--- a/f.ts", "+++ b/f.ts", "@@ -3 +3 @@", "-x", "+y", "@@ -10,2 +10,3 @@", "@@ -20,2 +21,0 @@",
      "+++ not a header", "diff --git a/gone.ts b/gone.ts", "--- a/gone.ts", "+++ /dev/null", "@@ -1,3 +0,0 @@"].join("\n");
    expect(parseHunkRanges(diff)).toEqual({ "f.ts": ["3", "10-12", "deleted after line 21"] });
    const many = ["diff --git a/m.ts b/m.ts", "--- a/m.ts", "+++ b/m.ts", ...Array.from({ length: 25 }, (_, index) => `@@ -${index * 3 + 1} +${index * 3 + 1} @@`)].join("\n");
    const capped = parseHunkRanges(many)["m.ts"]!;
    expect(capped).toHaveLength(21);
    expect(capped.at(-1)).toBe("and 5 more ranges");
  });

  it("states the changed files with their line ranges, the unchanged ones as context and the review focus", () => {
    const prompt = buildJudgePrompt({ name: "core", files: ["src/a.ts", "src/c.ts", "lib/d.ts"], changed: ["src/a.ts", "src/c.ts"] }, "v1",
      { "src/a.ts": ["5", "20-22"], "src/c.ts": ["new file"] });
    expect(prompt).toContain("Review focus: correctness, error handling, security, races and fallbacks.");
    expect(prompt).toContain("changed since v1");
    expect(prompt).toContain("- src/a.ts: lines 5, lines 20-22");
    expect(prompt).toContain("- src/c.ts: new file");
    expect(prompt).toContain("unchanged since v1");
    expect(prompt.indexOf("- lib/d.ts")).toBeGreaterThan(prompt.indexOf("unchanged since v1"));
    expect(prompt).not.toContain("No difference");
  });

  it("tells the reviewer to read the listed files in full when the scope has no difference", () => {
    const prompt = buildJudgePrompt({ name: "core", files: ["src", "lib"], changed: [] }, "main");
    expect(prompt).toContain("No difference against main was found for this scope. Review the listed files in full as they are:");
    expect(prompt).toContain("- src\n- lib");
    expect(prompt).not.toContain("changed since");
    expect(prompt.split("\n").at(-1)).toContain("REVIEW_GATE_VERDICT");
  });

  it("reviews merged work through --base and puts the ranges into every judge prompt", async () => {
    const first = seedMergedRepository();
    install("contract", { FAKE_PROFILE: "1" });
    const report = await runReview({ cwd: repo, client: "codex", session: "base-1", base: first, scopes: "core=src;docs=docs" });
    expect(report.status).toBe("ready");
    expect(report.base).toBe(first);
    const judged = fakeHarnessCommands(harness!).filter((entry) => entry.command === "review-judge");
    const core = judged.find((entry) => entry.scope === "core")!.argv[2]!;
    expect(core).toContain(`changed since ${first}`);
    expect(core).toContain("- src/a.ts: lines 5, lines 20-22");
    expect(core).toContain("- src/b.ts: lines 1");
    const docs = judged.find((entry) => entry.scope === "docs")!.argv[2]!;
    expect(docs).toContain(`No difference against ${first} was found for this scope`);
    expect(docs).toContain("- docs");
    expect(formatReviewReport(report)).toContain(`Changes against ${first}`);
  });

  it("without --base the merged work still has no difference and no scope is invented", async () => {
    seedMergedRepository();
    install("contract", { FAKE_PROFILE: "1" });
    const report = await runReview({ cwd: repo, client: "codex", session: "base-2" });
    expect(report.error).toBe("no_changed_files");
    const declared = await runReview({ cwd: repo, client: "codex", session: "base-3", scopes: "core=src" });
    expect(declared.status).toBe("ready");
    expect(fakeHarnessCommands(harness!).find((entry) => entry.command === "review-judge")!.argv[2]).toContain("No difference against main was found");
  });

  it("keeps the ranges when a harness without scope support collapses the scopes", async () => {
    const first = seedMergedRepository();
    install("legacy", { FAKE_PROFILE: "1" });
    const report = await runReview({ cwd: repo, client: "codex", session: "base-4", base: first });
    expect(report.degraded).toBe("scopes_unsupported");
    const prompt = fakeHarnessCommands(harness!).find((entry) => entry.command === "review-judge")!.argv[2]!;
    expect(prompt).toContain("- src/a.ts: lines 5, lines 20-22");
  });

  it("rejects an unknown --base before any harness call", async () => {
    seedMergedRepository();
    install("contract", { FAKE_PROFILE: "1" });
    await expect(runReview({ cwd: repo, client: "codex", base: "nope" })).rejects.toThrow("invalid_base");
    expect(harness!.callsFor("review-verify")).toHaveLength(0);
  });

  it("the CLI accepts --base and reports it", () => {
    const first = seedMergedRepository();
    install("contract", { FAKE_PROFILE: "1" });
    const cli = resolve(import.meta.dir, "../src/cli.ts");
    const env = { ...process.env, HERDR_ENV: "0", TYPESAFE_API_KEY: "" };
    const ok = spawnSync(process.execPath, [cli, "review", "--client", "codex", "--json", "--base", first, "--scopes", "core=src", "--session", "base-cli"], { encoding: "utf8", env, cwd: repo, timeout: 120_000 });
    expect(JSON.parse(ok.stdout).base).toBe(first);
    expect(ok.status).toBe(0);
    const bad = spawnSync(process.execPath, [cli, "review", "--client", "codex", "--json", "--base", "nope"], { encoding: "utf8", env, cwd: repo, timeout: 120_000 });
    expect(bad.status).toBe(1);
    expect(JSON.parse(bad.stdout).error).toContain("invalid_base");
  });
});

describe("item 3: reviewer source", () => {
  it("asks the harness for the profile with the advisor role and uses the reviewer of the profile", async () => {
    seedMergedRepository();
    write("src/c.ts", "export const c = 1;\n");
    install("contract", { FAKE_PROFILE: "claude-fable" });
    const report = await runReview({ cwd: repo, client: "claude", session: "rev-1", model: "claude-fable-5-1", availableModels: ["claude-sonnet-5-5", "claude-opus-5-5"], scopes: "core=src" });
    expect(report.reviewer).toEqual({ source: "profile", client: "claude", model: "claude-opus-5-5", effort: "xhigh" });
    const plan = harness!.callsFor("delegation-plan")[0]!;
    expect(plan.slice(0, 9)).toEqual(["delegation-plan", "--client", "claude", "--work", "substantive", "--role", "advisor", "--model", "claude-fable-5-1"]);
    expect(plan).toContain("claude-sonnet-5-5,claude-opus-5-5");
    const judge = fakeHarnessCommands(harness!).find((entry) => entry.command === "review-judge")!.argv;
    expect(judge[judge.indexOf("--model") + 1]).toBe("claude-opus-5-5");
    expect(judge.slice(-2)).toEqual(["--tools", "Read,Glob,Grep"]);
    expect(formatReviewReport(report)).toContain("Reviewer claude/claude-opus-5-5 (xhigh, profile)");
  });

  it("reports the model that is actually launched and not the profile label", async () => {
    seedMergedRepository();
    write("src/c.ts", "export const c = 1;\n");
    install("contract", { FAKE_PROFILE: "1" });
    const report = await runReview({ cwd: repo, client: "codex", session: "rev-2", scopes: "core=src" });
    expect(report.reviewer?.model).toBe("gpt-5.6-sol-cli");
    const judge = fakeHarnessCommands(harness!).find((entry) => entry.command === "review-judge")!.argv;
    expect(judge[judge.indexOf("--model") + 1]).toBe(report.reviewer!.model);
  });

  it("falls back to the matrix only when the harness has no profile", async () => {
    seedMergedRepository();
    write("src/c.ts", "export const c = 1;\n");
    install();
    const report = await runReview({ cwd: repo, client: "claude", session: "rev-3", model: "claude-fable-5-1", scopes: "core=src" });
    expect(report.reviewer?.source).toBe("matrix");
    const judge = fakeHarnessCommands(harness!).find((entry) => entry.command === "review-judge")!.argv;
    expect(judge[judge.indexOf("--model") + 1]).toBe(report.reviewer!.model);
  });
});

describe("item 4: failed verification", () => {
  it("prints the verification status and output the harness stored", async () => {
    seedMergedRepository();
    write("src/c.ts", "export const c = 1;\n");
    install("contract", { FAKE_PROFILE: "1", FAKE_VERIFY_FAIL: "1", FAKE_VERIFICATION_OUTPUT: "1 fail\nexplicit peer preserves another harness" });
    const report = await runReview({ cwd: repo, client: "codex", session: "ver-1", scopes: "core=src" });
    expect(report.status).toBe("changes_required");
    expect(report.judges).toEqual([]);
    const text = formatReviewReport(report);
    expect(text).toContain("Verify: changes_required");
    expect(text).toContain("Verification failed:\n1 fail\nexplicit peer preserves another harness");
    expect(text).not.toContain("Rerun it by hand");
    expect((report.findings as any).verification).toEqual({ status: "failed", output: "1 fail\nexplicit peer preserves another harness" });
    expect(report.verify?.command).toEqual(["bun", "test"]);
  });

  it("caps the verification output", async () => {
    seedMergedRepository();
    write("src/c.ts", "export const c = 1;\n");
    install("contract", { FAKE_PROFILE: "1", FAKE_VERIFY_FAIL: "1", FAKE_VERIFICATION_OUTPUT: "x".repeat(9000) });
    const text = formatReviewReport(await runReview({ cwd: repo, client: "codex", session: "ver-2", scopes: "core=src" }));
    expect(text).toContain("[truncated]");
    expect(text.length).toBeLessThan(6000);
  });

  it("says that the check command failed and how to rerun it when the harness returns no output", async () => {
    seedMergedRepository();
    write("src/c.ts", "export const c = 1;\n");
    install("contract", { FAKE_PROFILE: "1", FAKE_VERIFY_FAIL: "1" });
    const report = await runReview({ cwd: repo, client: "codex", session: "ver-3", scopes: "core=src" });
    const text = formatReviewReport(report);
    expect(text).toContain(`The check command failed and the Harness returned no output. Rerun it by hand in ${repo}: bun test`);
    expect(text).toContain("Status: changes_required");
  });

  it("quotes a custom check command in the rerun hint", async () => {
    seedMergedRepository();
    write("src/c.ts", "export const c = 1;\n");
    install("contract", { FAKE_PROFILE: "1", FAKE_VERIFY_FAIL: "1" });
    const verifyFile = join(scratch, "verify.json");
    writeFileSync(verifyFile, JSON.stringify(["bash", "-c", "exit 1 # a b"]));
    const text = formatReviewReport(await runReview({ cwd: repo, client: "codex", session: "ver-4", scopes: "core=src", verifyCommandJson: verifyFile }));
    expect(text).toContain("bash -c 'exit 1 # a b'");
  });

  it("does not print a verification block when the verification passed", async () => {
    seedMergedRepository();
    write("src/c.ts", "export const c = 1;\n");
    install("contract", { FAKE_PROFILE: "1", FAKE_VERIFICATION_OUTPUT: "never shown" });
    const text = formatReviewReport(await runReview({ cwd: repo, client: "codex", session: "ver-5", scopes: "core=src" }));
    expect(text).not.toContain("Verification");
    expect(text).not.toContain("check command failed");
  });

  it("prints every scope verdict with its reason and stored findings and keeps the full object in JSON", async () => {
    seedMergedRepository();
    write("src/c.ts", "export const c = 1;\n");
    install("contract", { FAKE_PROFILE: "1", FAKE_VERDICTS: "docs=CHANGES_REQUIRED", FAKE_TIMEOUT: "core:5" });
    const report = await runReview({ cwd: repo, client: "codex", session: "ver-6", scopes: "core=src;docs=docs" });
    const text = formatReviewReport(report);
    expect(text).toContain("Verdict core: pending (timeout)");
    expect(text).toContain("findings for core: pending");
    expect(text).toContain("Verdict docs: CHANGES_REQUIRED");
    expect(text).toContain("findings for docs: CHANGES_REQUIRED");
    const json = JSON.parse(JSON.stringify(report));
    expect(json.findings.scopes.map((scope: any) => [scope.name, scope.verdict, scope.reason ?? null])).toEqual([["core", "pending", "timeout"], ["docs", "CHANGES_REQUIRED", null]]);
    expect(json.verify).toEqual({ status: "pending_review", command: ["bun", "test"] });
  });
});
