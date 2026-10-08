import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { formatProveReport, isTestPath, MAX_PROVE_TIMEOUT_MS, readCommandJson, runProve } from "../src/harness/prove.js";
import { createTempHome } from "./helpers.js";

let repo: string;
let extra: string[];
let savedEnv: Record<string, string | undefined>;
const ISOLATED_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

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

function expectClean(report: { worktreeRemoved: boolean }) {
  expect(report.worktreeRemoved).toBe(true);
  expect(leftovers()).toEqual([]);
  expect(git(repo, "branch", "--list")).not.toContain("herdr-jev-prove");
  expect(git(repo, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree "))).toHaveLength(1);
  expect(existsSync(join(repo, ".git", "worktrees"))).toBe(false);
}

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  extra.push(dir);
  return dir;
}

async function withEnv<T>(values: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return await body();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

beforeEach(() => {
  savedEnv = {};
  for (const [key, value] of Object.entries(ISOLATED_ENV)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
  repo = realpathSync(mkdtempSync(join(tmpdir(), "herdr-jev-prove-repo-")));
  extra = [];
  seed();
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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
    const outside = tempDir("herdr-jev-prove-outside-");
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
    const forkPoint = git(repo, "rev-parse", "main");
    git(repo, "checkout", "-q", "main");
    write("src/main-only.txt", "advanced");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "main advances");
    git(repo, "checkout", "-q", "feature");
    const head = await runProve({ cwd: repo, testCommand: TEST_COMMAND });
    expect(head.verdict).toBe("no_tests");
    const report = await runProve({ cwd: repo, base: "main", testCommand: TEST_COMMAND });
    expect(report.verdict).toBe("proven");
    expect(report.baseRef).toBe("main");
    expect(report.base).toBe(forkPoint);
    expect(report.base).not.toBe(git(repo, "rev-parse", "main"));
    expect(report.sourceFiles).toEqual(["src/value.txt"]);
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

  it("runs the setup command once before the first test run and creates no node_modules link", async () => {
    mkdirSync(join(repo, "node_modules"));
    writeFileSync(join(repo, "node_modules", "marker"), "m");
    write("src/value.txt", "2");
    write("tests/check.sh", `test -f setup-ran && test ! -e node_modules && ${check("2")}`);
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

  it("kills background processes left behind after a normal exit and after the exit grace period", async () => {
    const pidFile = join(repo, "..", `prove-bg-${process.pid}-${Date.now()}`);
    extra.push(pidFile);
    write("src/value.txt", "2");
    write("tests/check.sh", `sleep 30 >/dev/null 2>&1 &\necho $! >> "${pidFile}"\n${check("2")}`);
    const closed = await runProve({ cwd: repo, testCommand: TEST_COMMAND });
    expect(closed.verdict).toBe("proven");
    for (const line of readFileSync(pidFile, "utf8").trim().split("\n")) expect(() => process.kill(Number(line), 0)).toThrow();
    expectClean(closed);

    rmSync(pidFile, { force: true });
    write("tests/check.sh", `sleep 30 &\necho $! >> "${pidFile}"\n${check("2")}`);
    const started = Date.now();
    const held = await runProve({ cwd: repo, testCommand: TEST_COMMAND });
    expect(Date.now() - started).toBeLessThan(20000);
    expect(held.verdict).toBe("proven");
    for (const line of readFileSync(pidFile, "utf8").trim().split("\n")) expect(() => process.kill(Number(line), 0)).toThrow();
    expectClean(held);
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

describe("runProve safety", () => {
  it("never writes or deletes through a node_modules that is not ignored", async () => {
    write(".gitignore", "");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "stop ignoring node_modules");
    write("node_modules/pkg/lib/index.js", "module.exports = 1");
    write("node_modules/pkg/test/a.js", "real test asset a");
    write("node_modules/pkg/test/b.js", "real test asset b");
    write("src/value.txt", "2");
    write("tests/check.sh", check("2"));
    const before = hashTree(join(repo, "node_modules"));
    const report = await runProve({ cwd: repo, testCommand: TEST_COMMAND });
    expect(report.verdict).toBe("proven");
    expect(report.testFiles).toEqual(["tests/check.sh"]);
    expect(report.sourceFiles).toEqual(["src/value.txt"]);
    expect(report.dependencies).toBe("node_modules_symlink");
    expect(hashTree(join(repo, "node_modules"))).toEqual(before);
    expect(Object.keys(before)).toHaveLength(3);
    expectClean(report);
  });

  it("never touches the external target of a tracked symlink replaced by a real directory", async () => {
    const external = tempDir("herdr-jev-prove-external-");
    mkdirSync(join(external, "keep"));
    writeFileSync(join(external, "data.txt"), "external original");
    writeFileSync(join(external, "keep", "only-here.txt"), "external only");
    mkdirSync(join(external, "gone.txt"));
    writeFileSync(join(external, "gone.txt", "payload"), "inside a directory that shares a name");
    symlinkSync(external, join(repo, "shared"));
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "link");
    rmSync(join(repo, "shared"));
    write("shared/data.txt", "working tree copy");
    write("shared/gone.txt", "new file");
    write("src/value.txt", "2");
    write("tests/check.sh", check("2"));
    const before = hashTree(external);
    const report = await runProve({ cwd: repo, testCommand: TEST_COMMAND });
    expect(report.verdict).toBe("proven");
    expect(hashTree(external)).toEqual(before);
    expect(readdirSync(external).sort()).toEqual(["data.txt", "gone.txt", "keep"]);
    expectClean(report);
  });

  it("replaces a symlinked directory created by setup instead of writing through it", async () => {
    const external = tempDir("herdr-jev-prove-escape-");
    writeFileSync(join(external, "victim.txt"), "victim");
    write("src/value.txt", "2");
    write("tests/check.sh", check("2"));
    const before = hashTree(external);
    const report = await runProve({
      cwd: repo,
      testCommand: TEST_COMMAND,
      setupCommand: ["sh", "-c", `rm -rf tests && ln -s "${external}" tests`],
    });
    expect(report.verdict).toBe("proven");
    expect(hashTree(external)).toEqual(before);
    expect(readdirSync(external)).toEqual(["victim.txt"]);
    expectClean(report);
  });

  it("does not let inherited git variables reach git or the commands", async () => {
    write("src/value.txt", "2");
    write("tests/check.sh", `[ -z "\${GIT_INDEX_FILE:-}\${GIT_DIR:-}\${GIT_WORK_TREE:-}\${GIT_OBJECT_DIRECTORY:-}\${GIT_COMMON_DIR:-}\${GIT_PREFIX:-}" ] && ${check("2")}`);
    git(repo, "add", "src/value.txt");
    const indexBefore = createHash("sha256").update(readFileSync(join(repo, ".git", "index"))).digest("hex");
    const stagedBefore = git(repo, "diff", "--cached", "--name-only");
    const report = await withEnv(
      {
        GIT_INDEX_FILE: join(repo, ".git", "index.lock"),
        GIT_OBJECT_DIRECTORY: join(repo, "no-such-objects"),
        GIT_COMMON_DIR: join(repo, "no-such-common"),
        GIT_PREFIX: "bogus/",
      },
      () => runProve({ cwd: repo, testCommand: TEST_COMMAND }),
    );
    expect(report.verdict).toBe("proven");
    expect(existsSync(join(repo, ".git", "index.lock"))).toBe(false);
    expect(createHash("sha256").update(readFileSync(join(repo, ".git", "index"))).digest("hex")).toBe(indexBefore);
    expect(git(repo, "diff", "--cached", "--name-only")).toBe(stagedBefore);
    expectClean(report);
  });

  it("does not prune the administrative entry of another worktree whose directory is missing", async () => {
    const mount = tempDir("herdr-jev-prove-mount-");
    const other = join(mount, "other");
    git(repo, "worktree", "add", "-q", "--detach", other);
    writeFileSync(join(other, "wip.txt"), "staged elsewhere");
    git(other, "add", "wip.txt");
    const moved = `${other}-away`;
    renameSync(other, moved);
    write("src/value.txt", "2");
    write("tests/check.sh", check("2"));
    const report = await runProve({ cwd: repo, testCommand: TEST_COMMAND });
    expect(report.verdict).toBe("proven");
    expect(report.worktreeRemoved).toBe(true);
    expect(leftovers()).toEqual([]);
    expect(readdirSync(join(repo, ".git", "worktrees"))).toHaveLength(1);
    renameSync(moved, other);
    expect(git(other, "status", "--porcelain")).toContain("wip.txt");
  });

  it("does not run git hooks while creating or removing the worktree", async () => {
    const log = join(tempDir("herdr-jev-prove-hooks-"), "hooks.log");
    for (const hook of ["post-checkout", "reference-transaction", "post-index-change"]) {
      const file = join(repo, ".git", "hooks", hook);
      writeFileSync(file, `#!/bin/sh\necho ${hook} >> "${log}"\n`);
      chmodSync(file, 0o755);
    }
    write("src/value.txt", "2");
    write("tests/check.sh", check("2"));
    const report = await runProve({ cwd: repo, testCommand: TEST_COMMAND });
    expect(report.verdict).toBe("proven");
    expect(existsSync(log)).toBe(false);
    expectClean(report);
  });

  it("works when the state directory is reached through a symlink", async () => {
    const real = tempDir("herdr-jev-prove-realstate-");
    const link = join(tempDir("herdr-jev-prove-linkparent-"), "state");
    symlinkSync(real, link);
    write("src/value.txt", "2");
    write("tests/check.sh", check("2"));
    const report = await withEnv({ HERDR_JEV_STATE_DIR: link }, () => runProve({ cwd: repo, testCommand: TEST_COMMAND }));
    expect(report.verdict).toBe("proven");
    expect(report.worktreeRemoved).toBe(true);
    expect(readdirSync(join(real, "prove"))).toEqual([]);
    expect(git(repo, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree "))).toHaveLength(1);
    expect(existsSync(join(repo, ".git", "worktrees"))).toBe(false);
  });
});

describe("runProve verdict integrity", () => {
  it("reports error instead of proven when the first run is killed by a signal", async () => {
    write("src/value.txt", "2");
    write("tests/check.sh", `if [ "$(cat src/value.txt)" = "1" ]; then kill -KILL $$; fi\n${check("2")}`);
    const report = await runProve({ cwd: repo, testCommand: TEST_COMMAND });
    expect(report.verdict).toBe("error");
    expect(report.reason).toContain("test_killed");
    expect(report.reason).toContain("SIGKILL");
    expect(report.withoutSource?.signal).toBe("SIGKILL");
    expect(report.withSource).toBeUndefined();
    expectClean(report);
  });

  it("rejects timeouts outside the allowed range and accepts the maximum", async () => {
    write("src/value.txt", "2");
    write("tests/check.sh", check("2"));
    for (const timeoutMs of [0, -5, Number.NaN, MAX_PROVE_TIMEOUT_MS + 1]) {
      const report = await runProve({ cwd: repo, testCommand: TEST_COMMAND, timeoutMs });
      expect(report.verdict).toBe("error");
      expect(report.reason).toContain("invalid_timeout");
    }
    const accepted = await runProve({ cwd: repo, testCommand: TEST_COMMAND, timeoutMs: MAX_PROVE_TIMEOUT_MS });
    expect(accepted.verdict).toBe("proven");
    expectClean(accepted);
  });

  it("rejects a base that starts with a dash", async () => {
    write("tests/check.sh", check("2"));
    const report = await runProve({ cwd: repo, base: "--output=/dev/null", testCommand: TEST_COMMAND });
    expect(report.verdict).toBe("error");
    expect(report.reason).toContain("invalid_base");
    expectClean(report);
  });
});

describe("runProve change set edge cases", () => {
  it("ignores an untracked nested git repository", async () => {
    mkdirSync(join(repo, "vendor", "lib"), { recursive: true });
    git(join(repo, "vendor", "lib"), "init", "-q", "-b", "main");
    writeFileSync(join(repo, "vendor", "lib", "f"), "x");
    git(join(repo, "vendor", "lib"), "add", "-A");
    git(join(repo, "vendor", "lib"), "commit", "-q", "-m", "nested");
    write("src/value.txt", "2");
    write("tests/check.sh", check("2"));
    const report = await runProve({ cwd: repo, testCommand: TEST_COMMAND });
    expect(report.verdict).toBe("proven");
    expect(report.sourceFiles).toEqual(["src/value.txt"]);
    expectClean(report);
  });

  it("handles a file replaced by a directory and a directory replaced by a file", async () => {
    write("src/thing", "data");
    mkdirSync(join(repo, "src", "folder"));
    write("src/folder/inner.txt", "inner");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "shapes");
    rmSync(join(repo, "src", "thing"));
    write("src/thing/inner.txt", "inner");
    rmSync(join(repo, "src", "folder"), { recursive: true });
    write("src/folder", "now a file");
    write("tests/check.sh", "[ -f src/thing/inner.txt ] && [ -f src/folder ] && [ ! -e src/folder/inner.txt ]\n");
    const report = await runProve({ cwd: repo, testCommand: TEST_COMMAND });
    expect(report.verdict).toBe("proven");
    expectClean(report);
  });

  it("keeps backslashes in file names", async () => {
    write("src/a\\b.txt", "new");
    write("tests/check.sh", "[ -f 'src/a\\b.txt' ] && [ ! -e src/a/b.txt ]\n");
    const report = await runProve({ cwd: repo, testCommand: TEST_COMMAND });
    expect(report.sourceFiles).toEqual(["src/a\\b.txt"]);
    expect(report.verdict).toBe("proven");
    expectClean(report);
  });

  it("explains a setup directory that does not exist at the base", async () => {
    mkdirSync(join(repo, "pkg", "tests"), { recursive: true });
    write("pkg/tests/check.sh", "exit 1\n");
    const report = await runProve({ cwd: join(repo, "pkg"), testCommand: TEST_COMMAND, setupCommand: ["true"] });
    expect(report.verdict).toBe("error");
    expect(report.reason).toContain("setup_cwd_missing");
    expectClean(report);
  });

  it("recognises go, python and spec layouts as tests", () => {
    for (const path of ["pkg/foo_test.go", "test_foo.py", "pkg/foo_test.py", "spec/foo.rb", "a/spec/b/c.rb", "src/x.test.ts", "tests/a.sh", "__tests__/a.js"]) expect(isTestPath(path)).toBe(true);
    for (const path of ["src/foo.go", "src/protest.py", "specs.md", "src/latest.ts"]) expect(isTestPath(path)).toBe(false);
    expect(isTestPath("checks/a.sh", new Set(["checks/a.sh"]))).toBe(true);
  });
});

describe("herdr-jev prove command", () => {
  const cli = resolve(import.meta.dir, "../src/cli.ts");
  let home: string;

  function cliEnv(): NodeJS.ProcessEnv {
    return { ...process.env, HOME: home, ...ISOLATED_ENV };
  }

  function runCli(args: string[], cwd = repo) {
    return spawnSync(process.execPath, [cli, "prove", ...args], { cwd, encoding: "utf8", env: cliEnv() });
  }

  beforeEach(() => {
    home = createTempHome();
  });

  it("exits 0 only for proven and prints the JSON report", () => {
    write("src/value.txt", "2");
    write("tests/check.sh", check("2"));
    const commandFile = join(tempDir("herdr-jev-prove-cmd-"), "cmd.json");
    writeFileSync(commandFile, JSON.stringify(TEST_COMMAND));
    const proven = runCli(["--test-command-json", commandFile, "--json"]);
    expect(proven.status).toBe(0);
    expect(JSON.parse(proven.stdout).verdict).toBe("proven");
    write("tests/check.sh", "exit 0\n");
    const notProven = runCli(["--test-command-json", commandFile]);
    expect(notProven.status).toBe(1);
    expect(notProven.stdout).toContain("Prove: not_proven");
    const missing = runCli(["--test-command-json", join(tmpdir(), "no-such-command-file.json"), "--json"]);
    expect(missing.status).toBe(1);
    expect(JSON.parse(missing.stdout).error).toContain("invalid_test_command");
    expectClean({ worktreeRemoved: true });
  });

  it("uses the repository test script by default and honors --test-file", () => {
    write("package.json", JSON.stringify({ scripts: { test: "bun test" } }));
    write("src/value.ts", "export const value = 1;\n");
    write("tests/value.test.ts", 'import { expect, test } from "bun:test";\nimport { value } from "../src/value.ts";\ntest("v", () => expect(value).toBe(1));\n');
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "bun project");
    write("src/value.ts", "export const value = 2;\n");
    write("tests/value.test.ts", 'import { expect, test } from "bun:test";\nimport { value } from "../src/value.ts";\ntest("v", () => expect(value).toBe(2));\n');
    const result = runCli(["--json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).verdict).toBe("proven");

    git(repo, "checkout", "-q", "--", ".");
    write("src/value.ts", "export const value = 3;\n");
    write("checks/value.sh", "[ 1 = 2 ]\n");
    const commandFile = join(tempDir("herdr-jev-prove-cmd-"), "cmd.json");
    writeFileSync(commandFile, JSON.stringify(["sh", "checks/value.sh"]));
    const none = runCli(["--test-command-json", commandFile, "--json"]);
    expect(JSON.parse(none.stdout).verdict).toBe("no_tests");
    const explicit = runCli(["--test-command-json", commandFile, "--test-file", "checks/value.sh", "--json"]);
    expect(JSON.parse(explicit.stdout).testFiles).toEqual(["checks/value.sh"]);
    expect(JSON.parse(explicit.stdout).verdict).toBe("broken");
  });

  it("cleans up after repeated interrupts", async () => {
    write("src/value.txt", "2");
    write("tests/check.sh", `sleep 30\n${check("2")}`);
    const commandFile = join(tempDir("herdr-jev-prove-cmd-"), "cmd.json");
    writeFileSync(commandFile, JSON.stringify(TEST_COMMAND));
    const child = spawn(process.execPath, [cli, "prove", "--test-command-json", commandFile, "--json"], { cwd: repo, env: cliEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    const exited = new Promise<number | null>((resolveExit) => child.on("close", (code) => resolveExit(code)));
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const dir = join(process.env.HERDR_JEV_STATE_DIR!, "prove");
      const entries = existsSync(dir) ? readdirSync(dir) : [];
      if (entries.length > 0 && existsSync(join(dir, entries[0]!, "tests", "check.sh"))) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 300));
    child.kill("SIGINT");
    await new Promise((r) => setTimeout(r, 30));
    child.kill("SIGINT");
    const code = await exited;
    expect(code).toBe(1);
    expect(JSON.parse(stdout).reason).toBe("aborted");
    expect(JSON.parse(stdout).worktreeRemoved).toBe(true);
    expectClean({ worktreeRemoved: true });
  });
});

describe("readCommandJson", () => {
  it("accepts an argv array and rejects anything else", () => {
    const dir = tempDir("herdr-jev-prove-json-");
    const ok = join(dir, "ok.json");
    writeFileSync(ok, JSON.stringify(["bun", "test"]));
    expect(readCommandJson(ok, "test_command")).toEqual(["bun", "test"]);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify("bun test"));
    expect(() => readCommandJson(bad, "test_command")).toThrow("invalid_test_command");
    expect(() => readCommandJson(join(dir, "missing.json"), "setup_command")).toThrow("invalid_setup_command");
  });
});
