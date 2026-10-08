import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { formatProveReport, readCommandJson, runProve } from "../src/harness/prove.js";

let repo: string;
let extra: string[];

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, encoding: "utf8" });
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

function write(path: string, content: string) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function check(expected: string): string {
  return `[ "$(cat src/value.txt)" = "${expected}" ]\n`;
}

const TEST_COMMAND = ["sh", "tests/check.sh"];

function seed() {
  git(repo, "init", "-q", "-b", "main");
  write(".gitignore", "node_modules/\n");
  write("src/value.txt", "1");
  write("tests/check.sh", check("1"));
  write("README.md", "readme\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
}

function hashTree(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = join(dir, entry.name);
      const rel = full.slice(root.length + 1);
      if (entry.isDirectory()) walk(full);
      else if (entry.isSymbolicLink()) result[rel] = `link:${readlinkSync(full)}`;
      else result[rel] = createHash("sha256").update(readFileSync(full)).digest("hex");
    }
  };
  walk(root);
  return result;
}

function gitState(): string {
  return [git(repo, "branch", "--list"), git(repo, "worktree", "list", "--porcelain"), git(repo, "status", "--porcelain")].join("\n---\n");
}

function leftovers(): string[] {
  const dir = join(process.env.HERDR_JEV_STATE_DIR!, "prove");
  return existsSync(dir) ? readdirSync(dir) : [];
}

function expectClean(report: { worktreeRemoved: boolean; branchRemoved: boolean }) {
  expect(report.worktreeRemoved).toBe(true);
  expect(report.branchRemoved).toBe(true);
  expect(leftovers()).toEqual([]);
  expect(git(repo, "branch", "--list", "herdr-jev-prove-*")).toBe("");
  expect(git(repo, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree "))).toHaveLength(1);
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "herdr-jev-prove-repo-")));
  extra = [];
  seed();
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  for (const dir of extra) rmSync(dir, { recursive: true, force: true });
});

describe("runProve", () => {
  it("proves tests that fail without the source change and pass with it", async () => {
    write("src/value.txt", "2");
    write("tests/check.sh", check("2"));
    const report = await runProve({ cwd: repo, testCommand: TEST_COMMAND });
    expect(report.verdict).toBe("proven");
    expect(report.withoutSource?.exitCode).not.toBe(0);
    expect(report.withSource?.exitCode).toBe(0);
    expect(report.testFiles).toEqual(["tests/check.sh"]);
    expect(report.sourceFiles).toEqual(["src/value.txt"]);
    expect(typeof report.withoutSource?.durationMs).toBe("number");
    expect(report.dependencies).toBe("none");
    expectClean(report);
    expect(formatProveReport(report)).toContain("Prove: proven");
  });

  it("reports not_proven when the changed tests pass without the source change", async () => {
    write("src/value.txt", "2");
    write("tests/check.sh", "exit 0\n");
    const report = await runProve({ cwd: repo, testCommand: TEST_COMMAND });
    expect(report.verdict).toBe("not_proven");
    expect(report.withoutSource?.exitCode).toBe(0);
    expect(report.withSource).toBeUndefined();
    expectClean(report);
  });

  it("reports broken when the tests fail with the full change", async () => {
    write("src/value.txt", "2");
    write("tests/check.sh", check("3"));
    const report = await runProve({ cwd: repo, testCommand: TEST_COMMAND });
    expect(report.verdict).toBe("broken");
    expect(report.withoutSource?.exitCode).not.toBe(0);
    expect(report.withSource?.exitCode).not.toBe(0);
    expectClean(report);
  });

  it("reports broken when only test files changed and they fail", async () => {
    write("tests/check.sh", check("9"));
    const report = await runProve({ cwd: repo, testCommand: TEST_COMMAND });
    expect(report.verdict).toBe("broken");
    expect(report.withSource).toBeUndefined();
    expectClean(report);
  });

  it("reports no_tests without running anything when no test file changed", async () => {
    write("src/value.txt", "2");
    let calls = 0;
    const report = await runProve({
      cwd: repo,
      testCommand: TEST_COMMAND,
      run: async () => {
        calls++;
        return { exitCode: 0, timedOut: false, aborted: false, output: "", durationMs: 0 };
      },
    });
    expect(report.verdict).toBe("no_tests");
    expect(calls).toBe(0);
    expectClean(report);
  });

  it("reports error for an invalid base and a missing repository", async () => {
    write("tests/check.sh", check("2"));
    const bad = await runProve({ cwd: repo, base: "no-such-ref", testCommand: TEST_COMMAND });
    expect(bad.verdict).toBe("error");
    expect(bad.reason).toContain("invalid_base");
    const outside = mkdtempSync(join(tmpdir(), "herdr-jev-prove-outside-"));
    extra.push(outside);
    const missing = await runProve({ cwd: outside, testCommand: TEST_COMMAND });
    expect(missing.verdict).toBe("error");
    expect(missing.reason).toContain("not_a_git_repository");
    const empty = await runProve({ cwd: repo, testCommand: [] });
    expect(empty.verdict).toBe("error");
    expectClean(bad);
  });

  it("compares against the merge base with --base for committed work", async () => {
    git(repo, "checkout", "-q", "-b", "feature");
    write("src/value.txt", "2");
    write("tests/check.sh", check("2"));
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "feature");
    const head = await runProve({ cwd: repo, testCommand: TEST_COMMAND });
    expect(head.verdict).toBe("no_tests");
    const report = await runProve({ cwd: repo, base: "main", testCommand: TEST_COMMAND });
    expect(report.verdict).toBe("proven");
    expect(report.baseRef).toBe("main");
    expect(report.base).toBe(git(repo, "rev-parse", "main"));
    expectClean(report);
  });

  it("handles untracked source and test files", async () => {
    write("src/new.txt", "x");
    write("tests/new-check.sh", "[ -f src/new.txt ]\n");
    const report = await runProve({ cwd: repo, testCommand: ["sh", "tests/new-check.sh"] });
    expect(report.verdict).toBe("proven");
    expect(report.testFiles).toEqual(["tests/new-check.sh"]);
    expect(report.sourceFiles).toEqual(["src/new.txt"]);
    expectClean(report);
  });

  it("applies deleted source files", async () => {
    git(repo, "rm", "-q", "-f", "src/value.txt");
    write("tests/check.sh", "[ ! -e src/value.txt ]\n");
    const report = await runProve({ cwd: repo, testCommand: TEST_COMMAND });
    expect(report.verdict).toBe("proven");
    expectClean(report);
  });

  it("honors explicit test files", async () => {
    write("src/value.txt", "2");
    write("checks/value.sh", check("2"));
    const report = await runProve({ cwd: repo, testCommand: ["sh", "checks/value.sh"], testFiles: ["checks/value.sh"] });
    expect(report.verdict).toBe("proven");
    expect(report.testFiles).toEqual(["checks/value.sh"]);
    expectClean(report);
  });

  it("leaves the working tree and git state untouched", async () => {
    write("src/value.txt", "2");
    write("tests/check.sh", check("2"));
    write("src/untracked.txt", "u");
    write("tests/untracked-check.sh", "exit 0\n");
    write("ignored.log", "ignored");
    mkdirSync(join(repo, "node_modules"));
    writeFileSync(join(repo, "node_modules", "marker"), "m");
    git(repo, "add", "src/value.txt");
    const before = hashTree(repo);
    const stateBefore = gitState();
    const report = await runProve({ cwd: repo, testCommand: TEST_COMMAND });
    expect(report.verdict).toBe("proven");
    expect(hashTree(repo)).toEqual(before);
    expect(gitState()).toBe(stateBefore);
    expectClean(report);
  });

  it("symlinks node_modules when no setup command is given and removes the link without touching the target", async () => {
    mkdirSync(join(repo, "node_modules"));
    writeFileSync(join(repo, "node_modules", "marker"), "m");
    write("src/value.txt", "2");
    write("tests/check.sh", `test -f node_modules/marker && ${check("2")}`);
    const report = await runProve({ cwd: repo, testCommand: TEST_COMMAND });
    expect(report.verdict).toBe("proven");
    expect(report.dependencies).toBe("node_modules_symlink");
    expect(readFileSync(join(repo, "node_modules", "marker"), "utf8")).toBe("m");
    expect(lstatSync(join(repo, "node_modules")).isDirectory()).toBe(true);
    expectClean(report);
  });

  it("runs the setup command once before the first test run", async () => {
    mkdirSync(join(repo, "node_modules"));
    write("src/value.txt", "2");
    write("tests/check.sh", `test -f setup-ran && test ! -e node_modules/marker && ${check("2")}`);
    const report = await runProve({ cwd: repo, testCommand: TEST_COMMAND, setupCommand: ["sh", "-c", "echo x >> setup-ran; test \"$(wc -l < setup-ran)\" = 1"] });
    expect(report.verdict).toBe("proven");
    expect(report.dependencies).toBe("setup_command");
    expectClean(report);
  });

  it("reports error and cleans up when the setup command fails", async () => {
    write("tests/check.sh", check("2"));
    const report = await runProve({ cwd: repo, testCommand: TEST_COMMAND, setupCommand: ["sh", "-c", "exit 4"] });
    expect(report.verdict).toBe("error");
    expect(report.reason).toContain("setup_failed");
    expectClean(report);
  });

  it("reports error for an unrunnable test command instead of a false proof", async () => {
    write("src/value.txt", "2");
    write("tests/check.sh", check("2"));
    const report = await runProve({ cwd: repo, testCommand: ["definitely-not-a-real-binary-xyz"] });
    expect(report.verdict).toBe("error");
    expect(report.reason).toContain("test_not_runnable");
    expectClean(report);
  });

  it("kills the process group on timeout and removes the worktree and branch", async () => {
    const pidFile = join(repo, "..", `prove-pid-${process.pid}-${Date.now()}`);
    extra.push(pidFile);
    write("src/value.txt", "2");
    write("tests/check.sh", `sleep 30 &\necho $! > "${pidFile}"\nwait\n`);
    const started = Date.now();
    const report = await runProve({ cwd: repo, testCommand: TEST_COMMAND, timeoutMs: 1500 });
    expect(Date.now() - started).toBeLessThan(15000);
    expect(report.verdict).toBe("error");
    expect(report.reason).toBe("test_timeout");
    expect(report.withoutSource?.timedOut).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(() => process.kill(pid, 0)).toThrow();
    expectClean(report);
  });

  it("removes the worktree and branch when aborted mid-run", async () => {
    write("src/value.txt", "2");
    write("tests/check.sh", "sleep 30\n");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 700);
    const report = await runProve({ cwd: repo, testCommand: TEST_COMMAND, signal: controller.signal });
    expect(report.verdict).toBe("error");
    expect(report.reason).toBe("aborted");
    expectClean(report);
  });

  it("removes the worktree and branch when the runner throws", async () => {
    write("src/value.txt", "2");
    write("tests/check.sh", check("2"));
    const report = await runProve({
      cwd: repo,
      testCommand: TEST_COMMAND,
      run: async () => {
        throw new Error("boom");
      },
    });
    expect(report.verdict).toBe("error");
    expect(report.reason).toBe("boom");
    expectClean(report);
  });

  it("runs from the matching subdirectory when cwd is inside the repository", async () => {
    write("pkg/src/value.txt", "1");
    write("pkg/tests/check.sh", `[ "$(cat src/value.txt)" = "1" ]\n`);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "pkg");
    write("pkg/src/value.txt", "2");
    write("pkg/tests/check.sh", `[ "$(cat src/value.txt)" = "2" ]\n`);
    const report = await runProve({ cwd: join(repo, "pkg"), testCommand: TEST_COMMAND });
    expect(report.verdict).toBe("proven");
    expectClean(report);
  });
});

describe("readCommandJson", () => {
  it("accepts an argv array and rejects anything else", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-jev-prove-json-"));
    extra.push(dir);
    const ok = join(dir, "ok.json");
    writeFileSync(ok, JSON.stringify(["bun", "test"]));
    expect(readCommandJson(ok, "test_command")).toEqual(["bun", "test"]);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify("bun test"));
    expect(() => readCommandJson(bad, "test_command")).toThrow("invalid_test_command");
    expect(() => readCommandJson(join(dir, "missing.json"), "setup_command")).toThrow("invalid_setup_command");
  });
});
