import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { assignScopes, buildJudgePrompt, deriveScopes, formatReviewReport, listChangedFiles, parseScopes, runReview } from "../src/harness/review.js";
import { createFakeHarness, fakeHarnessCommands, type FakeHarness, type FakeHarnessMode } from "./fake-harness.js";
import { assertNoRealHomeStateLeaks, createTestStateDir } from "./helpers.js";

let testEnv: { stateDir: string; cleanup: () => void };
let harness: FakeHarness | undefined;
let repo: string;

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, encoding: "utf8" });
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

function write(path: string, content: string) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function seedRepository() {
  git(repo, "init", "-q", "-b", "main");
  write("package.json", JSON.stringify({ scripts: { test: "bun test" } }));
  write("src/a.ts", "export const a = 1;\n");
  write("tests/a.test.ts", "// test\n");
  write("docs/x.md", "doc\n");
  write("README.md", "readme\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "checkout", "-q", "-b", "feature");
  write("src/a.ts", "export const a = 2;\n");
  write("src/b.ts", "export const b = 1;\n");
  write("tests/a.test.ts", "// changed test\n");
  write("docs/x.md", "changed doc\n");
  write("README.md", "changed readme\n");
  write("herdr-plugin/p.mjs", "export default 1;\n");
}

function install(mode: FakeHarnessMode = "contract", env: Record<string, string> = {}) {
  harness = createFakeHarness(mode, env);
}

beforeEach(() => {
  testEnv = createTestStateDir();
  repo = realpathSync(mkdtempSync(join(tmpdir(), "review-repo-")));
  seedRepository();
});

afterEach(() => {
  harness?.restore();
  harness = undefined;
  rmSync(repo, { recursive: true, force: true });
  testEnv.cleanup();
  assertNoRealHomeStateLeaks();
});

describe("scope handling", () => {
  it("parses declared scopes and rejects malformed ones", () => {
    expect(parseScopes("core=src,lib/util;qa=tests/")).toEqual([{ name: "core", paths: ["src", "lib/util"] }, { name: "qa", paths: ["tests"] }]);
    for (const bad of ["", "noequals", "a=", "bad name=src", "a=src;a=docs", "a=../etc", "a=/abs", `${"x".repeat(41)}=src`]) {
      expect(() => parseScopes(bad)).toThrow("invalid_scopes");
    }
  });

  it("groups changed files by top-level directory into at most four scopes", () => {
    const files = ["src/a.ts", "src/b.ts", "tests/a.test.ts", "docs/x.md", "README.md", "herdr-plugin/p.mjs"];
    const scopes = deriveScopes(files);
    expect(scopes.map((scope) => scope.name)).toEqual(["src", "docs", "herdr-plugin", "other"]);
    expect(scopes[3]!.files).toEqual(["README.md", "tests/a.test.ts"]);
    expect(deriveScopes(["src/a.ts", "docs/x.md"]).map((scope) => scope.name)).toEqual(["docs", "src"]);
    expect(deriveScopes(["a.ts"]).map((scope) => scope.name)).toEqual(["root"]);
    expect(deriveScopes([])).toEqual([]);
  });

  it("assigns changed files to declared paths and keeps declared paths for untouched scopes", () => {
    const scopes = assignScopes(parseScopes("core=src;docs=docs/x.md;none=lib"), ["src/a.ts", "src/b.ts", "docs/x.md", "tests/a.test.ts"]);
    expect(scopes).toEqual([{ name: "core", files: ["src/a.ts", "src/b.ts"] }, { name: "docs", files: ["docs/x.md"] }, { name: "none", files: ["lib"] }]);
  });

  it("lists the files changed against the default branch, including untracked ones", () => {
    const changed = listChangedFiles(repo);
    expect(changed.base).toBe("main");
    expect(changed.files).toEqual(["README.md", "docs/x.md", "herdr-plugin/p.mjs", "src/a.ts", "src/b.ts", "tests/a.test.ts"]);
  });

  it("builds a judge prompt that lists only the scope files and ends with the verdict rule", () => {
    const prompt = buildJudgePrompt({ name: "src", files: ["src/a.ts", "src/b.ts"] }, "main");
    expect(prompt).toContain("- src/a.ts\n- src/b.ts");
    expect(prompt).not.toContain("docs/x.md");
    expect(prompt.split("\n").at(-1)).toBe("End with exactly one final line: REVIEW_GATE_VERDICT: APPROVE or REVIEW_GATE_VERDICT: CHANGES_REQUIRED");
    expect(buildJudgePrompt({ name: "big", files: Array.from({ length: 250 }, (_, i) => `f${i}.ts`) }, null)).toContain("- ... and 50 more files in this scope");
  });
});

describe("review through the harness", () => {
  it("verifies with the repository test command, judges every derived scope in parallel with the read-only profile reviewer and prints the harness status", async () => {
    install("contract", { FAKE_PROFILE: "1" });
    const report = await runReview({ cwd: repo, client: "codex", session: "s-1" });
    expect(report.error).toBeUndefined();
    expect(report.status).toBe("ready");
    expect(report.reviewer).toEqual({ source: "profile", client: "codex", model: "gpt-5.6-sol", effort: "xhigh" });
    expect(report.scopes.map((scope) => scope.name)).toEqual(["src", "docs", "herdr-plugin", "other"]);

    const verify = harness!.callsFor("review-verify");
    expect(verify).toHaveLength(1);
    expect(verify[0]!.slice(0, 11)).toEqual(["review-verify", "--client", "codex", "--session", "s-1", "--cwd", repo, "--command-json", expect.any(String), "--scopes", "src,docs,herdr-plugin,other"]);
    const commands = fakeHarnessCommands(harness!);
    expect(commands[0]).toMatchObject({ command: "review-verify", argv: ["bun", "test"] });

    const judges = harness!.callsFor("review-judge");
    expect(judges.map((argv) => argv[argv.indexOf("--scope") + 1]).sort()).toEqual(["docs", "herdr-plugin", "other", "src"]);
    for (const judge of judges) expect(judge[judge.indexOf("--timeout-ms") + 1]).toBe("600000");
    const judged = commands.filter((entry) => entry.command === "review-judge");
    expect(judged).toHaveLength(4);
    for (const entry of judged) {
      expect(entry.argv.slice(0, 2)).toEqual(["codex", "exec"]);
      expect(entry.argv).toContain("gpt-5.6-sol");
      expect(entry.argv.slice(-2)).toEqual(["--sandbox", "read-only"]);
      expect(entry.argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
      const prompt = entry.argv[2]!;
      expect(prompt.split("\n").at(-1)).toContain("REVIEW_GATE_VERDICT: APPROVE or REVIEW_GATE_VERDICT: CHANGES_REQUIRED");
    }
    const src = judged.find((entry) => entry.scope === "src")!.argv[2]!;
    expect(src).toContain("- src/a.ts");
    expect(src).toContain("- src/b.ts");
    for (const other of ["docs/x.md", "README.md", "tests/a.test.ts", "herdr-plugin/p.mjs"]) expect(src).not.toContain(other);
    expect(harness!.callsFor("review-findings")).toHaveLength(1);
    expect(formatReviewReport(report)).toContain("Status: ready");
  });

  it("prints changes_required exactly as the harness reports it and carries the stored findings", async () => {
    install("contract", { FAKE_PROFILE: "1", FAKE_VERDICTS: "docs=CHANGES_REQUIRED" });
    const report = await runReview({ cwd: repo, client: "codex", session: "s-2", scopes: "core=src;docs=docs" });
    expect(report.status).toBe("changes_required");
    expect(report.judges).toHaveLength(2);
    expect(report.judges.find((judge) => judge.scope === "docs")!.status).toBe("changes_required");
    const verdicts = (report.findings as any).scopes.map((scope: any) => [scope.name, scope.verdict]);
    expect(verdicts).toEqual([["core", "APPROVE"], ["docs", "CHANGES_REQUIRED"]]);
    expect(formatReviewReport(report)).toContain("findings for docs: CHANGES_REQUIRED");
    expect(formatReviewReport(report)).toContain("Status: changes_required");
  });

  it("does not run any judge when the deterministic verification fails", async () => {
    install("contract", { FAKE_PROFILE: "1", FAKE_VERIFY_FAIL: "1" });
    const report = await runReview({ cwd: repo, client: "codex", session: "s-3" });
    expect(report.verify?.status).toBe("changes_required");
    expect(report.judges).toEqual([]);
    expect(report.status).toBe("changes_required");
    expect(harness!.callsFor("review-judge")).toHaveLength(0);
  });

  it("uses an explicit verification command file and the matrix reviewer when there is no delegation profile", async () => {
    install();
    const verifyFile = join(repo, "..", `verify-${process.pid}.json`);
    writeFileSync(verifyFile, JSON.stringify(["bash", "-c", "true"]));
    try {
      const report = await runReview({ cwd: repo, client: "codex", session: "s-4", scopes: "all=src", verifyCommandJson: verifyFile, timeoutMs: 30_000 });
      expect(report.reviewer?.source).toBe("matrix");
      expect(fakeHarnessCommands(harness!)[0]!.argv).toEqual(["bash", "-c", "true"]);
      const judge = harness!.callsFor("review-judge")[0]!;
      expect(judge[judge.indexOf("--timeout-ms") + 1]).toBe("30000");
      expect(fakeHarnessCommands(harness!).find((entry) => entry.command === "review-judge")!.argv.slice(-2)).toEqual(["--sandbox", "read-only"]);
      expect(report.status).toBe("ready");
    } finally { rmSync(verifyFile, { force: true }); }
  });

  it("requires a verification command when the repository has no test script", async () => {
    install("contract", { FAKE_PROFILE: "1" });
    write("package.json", JSON.stringify({ name: "no-tests" }));
    const report = await runReview({ cwd: repo, client: "codex", session: "s-5" });
    expect(report.error).toBe("verify_command_required");
    expect(harness!.callsFor("review-verify")).toHaveLength(0);
  });

  it("reports when nothing changed", async () => {
    install("contract", { FAKE_PROFILE: "1" });
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "all in");
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "-q", "--ff-only", "feature");
    const report = await runReview({ cwd: repo, client: "codex", session: "s-6" });
    expect(report.error).toBe("no_changed_files");
    expect(report.status).toBeNull();
  });

  it("refuses clients without a read-only reviewer adapter and invalid input", async () => {
    install("contract", { FAKE_PROFILE: "1" });
    await expect(runReview({ cwd: repo, client: "antigravity", session: "s-7" })).rejects.toThrow("readonly_reviewer_adapter_unavailable");
    await expect(runReview({ cwd: repo, client: "codex", timeoutMs: 10 })).rejects.toThrow("invalid_timeout");
    await expect(runReview({ cwd: repo, client: "codex", timeoutMs: 2_000_000 })).rejects.toThrow("invalid_timeout");
    await expect(runReview({ cwd: repo, client: "codex", scopes: "oops" })).rejects.toThrow("invalid_scopes");
    await expect(runReview({ cwd: repo, client: "codex", session: "bad session" })).rejects.toThrow("invalid_session");
  });

  it("falls back to a single scope on a harness without scope support", async () => {
    install("legacy", { FAKE_PROFILE: "1" });
    const report = await runReview({ cwd: repo, client: "codex", session: "s-8" });
    expect(report.degraded).toBe("scopes_unsupported");
    expect(report.scopes).toEqual([{ name: "default", fileCount: 6 }]);
    expect(report.status).toBe("ready");
    const judge = harness!.callsFor("review-judge")[0]!;
    expect(judge).not.toContain("--scope");
    expect(judge).not.toContain("--timeout-ms");
    expect(harness!.callsFor("review-findings")[0]![0]).toBe("review-findings");
    const prompt = fakeHarnessCommands(harness!).find((entry) => entry.command === "review-judge")!.argv[2]!;
    for (const file of ["src/a.ts", "docs/x.md", "herdr-plugin/p.mjs"]) expect(prompt).toContain(`- ${file}`);
  });

  it("never invents a status when the harness is unavailable", async () => {
    const report = await runReview({ cwd: repo, client: "codex", session: "s-9" });
    expect(report.status).toBeNull();
    expect(report.error).toBe("harness_unavailable");
    expect(report.judges).toEqual([]);
    expect(formatReviewReport(report)).toContain("Status: unavailable (harness_unavailable)");
  });

  it("never invents a status when the harness answers unknown_command for the review gate", async () => {
    install("unknown", { FAKE_PROFILE: "1" });
    const report = await runReview({ cwd: repo, client: "codex", session: "s-10" });
    expect(report.status).toBeNull();
    expect(report.error).toBeDefined();
    expect(report.judges).toEqual([]);
  });
});

describe("herdr-jev review and models catalog commands", () => {
  const cli = resolve(import.meta.dir, "../src/cli.ts");
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd: repo, timeout: 120_000,
    env: { ...process.env, HERDR_ENV: "0", TYPESAFE_API_KEY: "", HERDR_JEV_CONFIG_DIR: join(repo, "..", `cfg-${process.pid}`) } });

  it("prints the full report as JSON and exits 0 only when the harness status is ready", () => {
    install("contract", { FAKE_PROFILE: "1" });
    const approved = run(["review", "--client", "codex", "--json", "--scopes", "core=src;docs=docs", "--session", "cli-1"]);
    expect(approved.status).toBe(0);
    const report = JSON.parse(approved.stdout);
    expect(report.status).toBe("ready");
    expect(report.session).toBe("cli-1");
    expect(report.scopes.map((scope: any) => scope.name)).toEqual(["core", "docs"]);

    process.env.FAKE_VERDICTS = "core=CHANGES_REQUIRED";
    try {
      const rejected = run(["review", "--client", "codex", "--json", "--scopes", "core=src;docs=docs", "--session", "cli-2"]);
      expect(rejected.status).toBe(1);
      expect(JSON.parse(rejected.stdout).status).toBe("changes_required");
    } finally { delete process.env.FAKE_VERDICTS; }
  });

  it("reports invalid input as an error and exits 1", () => {
    install("contract", { FAKE_PROFILE: "1" });
    const result = run(["review", "--client", "codex", "--json", "--scopes", "bad"]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error).toContain("invalid_scopes");
  });

  it("prints what the harness returned for the catalog and the built-in values when it cannot answer", () => {
    install();
    const answered = run(["models", "catalog", "claude"]);
    expect(answered.status).toBe(0);
    expect(Object.keys(JSON.parse(answered.stdout).clients)).toEqual(["claude"]);
    harness!.restore();
    install("unknown");
    const fallback = run(["models", "catalog"]);
    expect(fallback.status).toBe(1);
    const parsed = JSON.parse(fallback.stdout);
    expect(parsed.available).toBe(false);
    expect(parsed.reason).toBe("unknown_command");
    expect(parsed.fallback.bypass_args.codex).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
  });
});
