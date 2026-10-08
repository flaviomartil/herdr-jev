import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { formatProveReport, isTestPath, MAX_PROVE_TIMEOUT_MS, readCommandJson, readProcessStat, runProve } from "../src/harness/prove.js";
import { createTempHome } from "./helpers.js";

let repo: string;
let extra: string[];
let savedEnv: Record<string, string | undefined>;
const ISOLATED_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const INHERITED_GIT_VARIABLES = ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE", "GIT_PREFIX", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY"];

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of INHERITED_GIT_VARIABLES) delete env[name];
  return env;
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, encoding: "utf8", env: gitEnv() });
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

function workspaces(): string[] {
  return leftovers().filter((name) => !name.endsWith(".meta.json"));
}

function expectClean(report: { workspaceRemoved: boolean }) {
  expect(report.workspaceRemoved).toBe(true);
  expect(leftovers()).toEqual([]);
  expect(git(repo, "branch", "--list")).not.toContain("herdr-jev-prove");
  expect(git(repo, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree "))).toHaveLength(1);
  expect(existsSync(join(repo, ".git", "worktrees"))).toBe(false);
}

async function expectDead(pid: number): Promise<void> {
  const deadline = Date.now() + 3000;
  let alive = true;
  while (alive && Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 50));
    } catch {
      alive = false;
    }
  }
  expect(alive).toBe(false);
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
  for (const name of INHERITED_GIT_VARIABLES) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
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
    await expectDead(pid);
    expectClean(report);
  });

  it("kills background processes left behind after a normal exit and after the exit grace period", async () => {
    const pidFile = join(repo, "..", `prove-bg-${process.pid}-${Date.now()}`);
    extra.push(pidFile);
    write("src/value.txt", "2");
    write("tests/check.sh", `sleep 30 >/dev/null 2>&1 &\necho $! >> "${pidFile}"\n${check("2")}`);
    const closed = await runProve({ cwd: repo, testCommand: TEST_COMMAND });
    expect(closed.verdict).toBe("proven");
    for (const line of readFileSync(pidFile, "utf8").trim().split("\n")) await expectDead(Number(line));
    expectClean(closed);

    rmSync(pidFile, { force: true });
    write("tests/check.sh", `sleep 30 &\necho $! >> "${pidFile}"\n${check("2")}`);
    const started = Date.now();
    const held = await runProve({ cwd: repo, testCommand: TEST_COMMAND });
    expect(Date.now() - started).toBeLessThan(20000);
    expect(held.verdict).toBe("proven");
    for (const line of readFileSync(pidFile, "utf8").trim().split("\n")) await expectDead(Number(line));
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
    expect(report.workspaceRemoved).toBe(true);
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
    expect(report.workspaceRemoved).toBe(true);
    expect(readdirSync(join(real, "prove"))).toEqual([]);
    expect(git(repo, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree "))).toHaveLength(1);
    expect(existsSync(join(repo, ".git", "worktrees"))).toBe(false);
  });
});

describe("runProve tracked paths and skipped paths", () => {
  function seedFixture(content: string) {
    write("tests/fixtures/node_modules/f.txt", content);
    git(repo, "add", "-A", "-f");
    git(repo, "commit", "-q", "-m", "fixture");
  }

  it("does not report proven when the diff corrupts a tracked node_modules fixture", async () => {
    seedFixture("good");
    write("src/value.txt", "2");
    write("tests/check.sh", `[ "$(cat tests/fixtures/node_modules/f.txt)" = good ] && ${check("2")}`);
    write("tests/fixtures/node_modules/f.txt", "bad");
    const report = await runProve({ cwd: repo, testCommand: TEST_COMMAND });
    expect(report.verdict).toBe("broken");
    expect(report.testFiles).toContain("tests/fixtures/node_modules/f.txt");
    expect(report.skippedCount).toBe(0);
    expectClean(report);
  });

  it("applies a tracked node_modules fixture added by the diff", async () => {
    write("src/value.txt", "2");
    write("tests/fixtures/node_modules/new.txt", "needed");
    git(repo, "add", "-f", "tests/fixtures/node_modules/new.txt");
    write("tests/check.sh", `[ -f tests/fixtures/node_modules/new.txt ] && ${check("2")}`);
    const report = await runProve({ cwd: repo, testCommand: TEST_COMMAND });
    expect(report.verdict).toBe("proven");
    expect(report.testFiles).toContain("tests/fixtures/node_modules/new.txt");
    expectClean(report);
  });

  it("counts a changed tracked node_modules fixture as a test file", async () => {
    write("tests/fx.sh", `[ "$(cat tests/fixtures/node_modules/f.txt)" = "$(cat src/value.txt)" ]\n`);
    seedFixture("1");
    write("tests/fixtures/node_modules/f.txt", "2");
    write("src/value.txt", "2");
    const report = await runProve({ cwd: repo, testCommand: ["sh", "tests/fx.sh"] });
    expect(report.verdict).toBe("proven");
    expect(report.testFiles).toEqual(["tests/fixtures/node_modules/f.txt"]);
    expect(report.sourceFiles).toEqual(["src/value.txt"]);
    expectClean(report);
  });

  it("lists the untracked paths it skipped in the report and the text", async () => {
    write(".gitignore", "");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "stop ignoring node_modules");
    write("src/value.txt", "2");
    write("tests/check.sh", check("2"));
    write("node_modules/pkg/index.js", "x");
    mkdirSync(join(repo, "vendor", "lib"), { recursive: true });
    git(join(repo, "vendor", "lib"), "init", "-q", "-b", "main");
    const report = await runProve({ cwd: repo, testCommand: TEST_COMMAND });
    expect(report.verdict).toBe("proven");
    expect(report.skippedCount).toBe(2);
    expect(report.skippedPaths).toEqual(["node_modules/pkg/index.js", "vendor/lib/"]);
    expect(formatProveReport(report)).toContain("Skipped untracked paths: 2");
    expectClean(report);
  });
});

describe("runProve isolated copy", () => {
  it("leaves the real repository untouched by git commands the test command runs", async () => {
    write("README.md", "stashed change\n");
    git(repo, "stash", "push", "-q");
    const snapshot = () => [git(repo, "stash", "list"), git(repo, "config", "-l", "--local"), git(repo, "for-each-ref"), git(repo, "tag", "--list"), git(repo, "rev-parse", "HEAD")].join("\n---\n");
    write("src/value.txt", "2");
    write("tests/iso.sh", [
      "echo dirty > dirty.txt",
      "git add dirty.txt",
      "git -c user.name=x -c user.email=x@example.invalid stash push -q -- dirty.txt",
      "git config prove.leak yes",
      "git config core.hooksPath .husky/_",
      "git update-ref -d refs/heads/main",
      "git tag -f prove-leak",
      check("2"),
    ].join("\n"));
    const before = snapshot();
    const report = await runProve({ cwd: repo, testCommand: ["sh", "tests/iso.sh"] });
    expect(report.verdict).toBe("proven");
    expect(snapshot()).toBe(before);
    expect(spawnSync("git", ["config", "--get", "core.hooksPath"], { cwd: repo, encoding: "utf8", env: gitEnv() }).stdout.trim()).toBe("");
    expectClean(report);
  });

  it("does not let a setup command change the real hooks path", async () => {
    write("src/value.txt", "2");
    write("tests/check.sh", check("2"));
    const report = await runProve({ cwd: repo, testCommand: TEST_COMMAND, setupCommand: ["git", "config", "core.hooksPath", ".husky/_"] });
    expect(report.verdict).toBe("proven");
    expect(spawnSync("git", ["config", "--get", "core.hooksPath"], { cwd: repo, encoding: "utf8", env: gitEnv() }).stdout.trim()).toBe("");
    expectClean(report);
  });

  it("gives the copy local branches and no origin remote", async () => {
    git(repo, "branch", "other");
    write("src/value.txt", "2");
    write("tests/check.sh", `[ "$(git remote | wc -l)" = 0 ] && git rev-parse --verify -q refs/heads/other >/dev/null && git rev-parse --verify -q refs/heads/main >/dev/null && ${check("2")}`);
    const report = await runProve({ cwd: repo, testCommand: TEST_COMMAND });
    expect(report.verdict).toBe("proven");
    expectClean(report);
  });

  it("ignores a hostile global git configuration", async () => {
    const dir = tempDir("herdr-jev-prove-hostile-");
    const hooks = join(dir, "hooks");
    const template = join(dir, "template", "hooks");
    mkdirSync(hooks, { recursive: true });
    mkdirSync(template, { recursive: true });
    const log = join(dir, "hooks.log");
    for (const folder of [hooks, template]) {
      for (const hook of ["post-checkout", "reference-transaction", "post-index-change", "post-merge", "pre-auto-gc"]) {
        const file = join(folder, hook);
        writeFileSync(file, `#!/bin/sh\necho ${hook} >> "${log}"\n`);
        chmodSync(file, 0o755);
      }
    }
    const config = join(dir, "gitconfig");
    writeFileSync(config, `[commit]\n\tgpgsign = true\n[tag]\n\tgpgsign = true\n[clone]\n\tdefaultRemoteName = upstream\n[fetch]\n\tprune = true\n[core]\n\thooksPath = ${hooks}\n\tfsmonitor = true\n[init]\n\ttemplateDir = ${join(dir, "template")}\n[transfer]\n\tfsckObjects = true\n[checkout]\n\tdefaultRemote = upstream\n`);
    write("src/value.txt", "2");
    write("tests/check.sh", check("2"));
    const report = await withEnv({ GIT_CONFIG_GLOBAL: config }, () => runProve({ cwd: repo, testCommand: TEST_COMMAND }));
    expect(report.verdict).toBe("proven");
    expect(existsSync(log)).toBe(false);
    expectClean(report);
  });

  it("does not inherit hooks from a global template directory into the copy", async () => {
    const dir = tempDir("herdr-jev-prove-template-");
    mkdirSync(join(dir, "template", "hooks"), { recursive: true });
    const log = join(dir, "hooks.log");
    for (const hook of ["pre-commit", "commit-msg", "post-commit"]) {
      const file = join(dir, "template", "hooks", hook);
      writeFileSync(file, `#!/bin/sh\necho ${hook} >> "${log}"\n`);
      chmodSync(file, 0o755);
    }
    const config = join(dir, "gitconfig");
    writeFileSync(config, `[init]\n\ttemplateDir = ${join(dir, "template")}\n`);
    write("src/value.txt", "2");
    write("tests/check.sh", `git -c user.name=x -c user.email=x@example.invalid commit -q --allow-empty -m t\n${check("2")}`);
    const report = await withEnv({ GIT_CONFIG_GLOBAL: config }, () => runProve({ cwd: repo, testCommand: TEST_COMMAND }));
    expect(report.verdict).toBe("proven");
    expect(existsSync(log)).toBe(false);
    expectClean(report);
  });

  it("does not run a configured fsmonitor hook", async () => {
    const dir = tempDir("herdr-jev-prove-fsmonitor-");
    const log = join(dir, "fsmonitor.log");
    const hook = join(dir, "hook.sh");
    writeFileSync(hook, `#!/bin/sh\necho called >> "${log}"\nprintf '\\0'\n`);
    chmodSync(hook, 0o755);
    const config = join(dir, "gitconfig");
    writeFileSync(config, `[core]\n\tfsmonitor = ${hook}\n`);
    write("src/value.txt", "2");
    write("tests/check.sh", check("2"));
    const report = await withEnv({ GIT_CONFIG_GLOBAL: config }, () => runProve({ cwd: repo, testCommand: TEST_COMMAND }));
    expect(report.verdict).toBe("proven");
    expect(existsSync(log)).toBe(false);
    expectClean(report);
  });

  it("refuses a tracked file changed under the linked root node_modules", async () => {
    mkdirSync(join(repo, "node_modules"));
    writeFileSync(join(repo, "node_modules", "marker"), "m");
    write("node_modules/fx/data.txt", "tracked");
    git(repo, "add", "-f", "node_modules/fx/data.txt");
    write("src/value.txt", "2");
    write("tests/check.sh", check("2"));
    const before = hashTree(join(repo, "node_modules"));
    const report = await runProve({ cwd: repo, testCommand: TEST_COMMAND });
    expect(report.verdict).toBe("error");
    expect(report.reason).toContain("tracked_file_under_linked_node_modules");
    expect(report.reason).toContain("node_modules/fx/data.txt");
    expect(hashTree(join(repo, "node_modules"))).toEqual(before);
    expectClean(report);
    const withSetup = await runProve({ cwd: repo, testCommand: TEST_COMMAND, setupCommand: ["true"] });
    expect(withSetup.verdict).toBe("proven");
    expectClean(withSetup);
  });

  it("rejects explicit test files that are not in the change set and resolves them against the run directory", async () => {
    mkdirSync(join(repo, "pkg", "checks"), { recursive: true });
    write("pkg/checks/value.sh", "exit 0\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "pkg");
    write("pkg/checks/value.sh", "exit 0\n# changed\n");
    write("tests/other.sh", "exit 0\n");
    const typo = await runProve({ cwd: repo, testCommand: ["true"], testFiles: ["pkg/checks/valeu.sh"] });
    expect(typo.verdict).toBe("error");
    expect(typo.reason).toContain("test_file_not_in_change_set");
    expectClean(typo);
    const fromSub = await runProve({ cwd: join(repo, "pkg"), testCommand: ["true"], testFiles: ["checks/value.sh"] });
    expect(fromSub.testFiles).toContain("pkg/checks/value.sh");
    const viaRoot = await runProve({ cwd: join(repo, "pkg"), testCommand: ["true"], testFiles: ["pkg/checks/value.sh"] });
    expect(viaRoot.testFiles).toContain("pkg/checks/value.sh");
    const outside = await runProve({ cwd: repo, testCommand: ["true"], testFiles: ["../escape.sh"] });
    expect(outside.reason).toContain("test_file_not_in_change_set");
  });

  it("runs two proofs on the same repository in parallel", async () => {
    const before = git(repo, "worktree", "list", "--porcelain");
    write("src/value.txt", "2");
    write("tests/check.sh", check("2"));
    const reports = await Promise.all([runProve({ cwd: repo, testCommand: TEST_COMMAND }), runProve({ cwd: repo, testCommand: TEST_COMMAND }), runProve({ cwd: repo, testCommand: TEST_COMMAND })]);
    for (const report of reports) {
      expect(report.verdict).toBe("proven");
      expectClean(report);
    }
    expect(git(repo, "worktree", "list", "--porcelain")).toBe(before);
  });

  it("reports an unsupported partial clone clearly", async () => {
    git(repo, "config", "extensions.partialclone", "origin");
    write("src/value.txt", "2");
    write("tests/check.sh", check("2"));
    const report = await runProve({ cwd: repo, testCommand: TEST_COMMAND });
    expect(report.verdict).toBe("error");
    expect(report.reason).toContain("partial_clone_unsupported");
    expectClean(report);
  });

  it("reports a changed submodule pointer instead of a false broken", async () => {
    const source = tempDir("herdr-jev-prove-submodule-");
    git(source, "init", "-q", "-b", "main");
    writeFileSync(join(source, "lib.txt"), "v1");
    git(source, "add", "-A");
    git(source, "commit", "-q", "-m", "v1");
    git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "vendor/sub");
    git(repo, "commit", "-q", "-m", "submodule");
    writeFileSync(join(repo, "vendor", "sub", "lib.txt"), "v2");
    git(join(repo, "vendor", "sub"), "commit", "-q", "-a", "-m", "v2");
    write("tests/check.sh", check("1") + "[ \"$(cat vendor/sub/lib.txt)\" = v2 ]\n");
    const report = await runProve({ cwd: repo, testCommand: TEST_COMMAND });
    expect(report.verdict).toBe("error");
    expect(report.reason).toContain("submodule_change_unsupported");
    expect(report.reason).toContain("vendor/sub");
    expectClean(report);
  });

  it("reports a dirty submodule that kept its pointer as a normal change set", async () => {
    const source = tempDir("herdr-jev-prove-submodule-");
    git(source, "init", "-q", "-b", "main");
    writeFileSync(join(source, "lib.txt"), "v1");
    git(source, "add", "-A");
    git(source, "commit", "-q", "-m", "v1");
    git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "vendor/sub");
    git(repo, "commit", "-q", "-m", "submodule");
    writeFileSync(join(repo, "vendor", "sub", "lib.txt"), "dirty");
    write("src/value.txt", "2");
    write("tests/check.sh", check("2"));
    const report = await runProve({ cwd: repo, testCommand: TEST_COMMAND });
    expect(report.verdict).toBe("proven");
    expect(report.sourceFiles).toEqual(["src/value.txt"]);
    expectClean(report);
  });
});

describe("runProve stale workspace sweep", () => {
  const hours = 3_600_000;
  let parent: string;
  let children: Array<ReturnType<typeof spawn>>;

  beforeEach(() => {
    parent = join(process.env.HERDR_JEV_STATE_DIR!, "prove");
    mkdirSync(parent, { recursive: true });
    children = [];
  });

  afterEach(() => {
    for (const child of children) {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
      }
      try {
        child.kill("SIGKILL");
      } catch {
      }
    }
    for (const name of readdirSync(parent)) rmSync(join(parent, name), { recursive: true, force: true });
  });

  function orphan(seconds: string, cwd: string, detached = true) {
    const child = spawn("sleep", [seconds], { cwd, detached, stdio: "ignore" });
    child.unref();
    children.push(child);
    return child;
  }

  function entry(name: string, meta: Record<string, unknown>): string {
    const dir = join(parent, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "file"), "x");
    writeFileSync(join(parent, `${name}.meta.json`), JSON.stringify(meta), { mode: 0o600 });
    return dir;
  }

  function writeMetaFile(name: string, meta: Record<string, unknown>) {
    writeFileSync(join(parent, `${name}.meta.json`), JSON.stringify(meta), { mode: 0o600 });
  }

  async function sweepRun() {
    write("src/value.txt", "2");
    write("tests/check.sh", check("2"));
    const report = await runProve({ cwd: repo, testCommand: TEST_COMMAND });
    expect(report.verdict).toBe("proven");
    return report;
  }

  it("removes an old copy and kills the orphan that runs inside it", async () => {
    const dir = entry("old-stale", { startedAt: Date.now() - 10 * hours, timeoutMs: 600000 });
    const child = orphan("31", dir);
    writeMetaFile("old-stale", { startedAt: Date.now() - 10 * hours, timeoutMs: 600000, pid: child.pid, argv: ["sh", "tests/run.sh"] });
    const report = await sweepRun();
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(parent, "old-stale.meta.json"))).toBe(false);
    await expectDead(child.pid!);
    expectClean(report);
  });

  it("spares an unrelated process that has the recorded pid and command line but runs elsewhere", async () => {
    const dir = entry("old-reused-pid", { startedAt: Date.now() - 10 * hours, timeoutMs: 600000 });
    const child = orphan("32", tmpdir());
    writeMetaFile("old-reused-pid", { startedAt: Date.now() - 10 * hours, timeoutMs: 600000, pid: child.pid, argv: ["sleep", "32"] });
    const report = await sweepRun();
    expect(existsSync(dir)).toBe(false);
    expect(() => process.kill(child.pid!, 0)).not.toThrow();
    expectClean(report);
  });

  it("spares a process inside the copy that is not a process group leader", async () => {
    const dir = entry("old-member", { startedAt: Date.now() - 10 * hours, timeoutMs: 600000 });
    const child = orphan("33", dir, false);
    writeMetaFile("old-member", { startedAt: Date.now() - 10 * hours, timeoutMs: 600000, pid: child.pid });
    const report = await sweepRun();
    expect(existsSync(dir)).toBe(false);
    expect(() => process.kill(child.pid!, 0)).not.toThrow();
    expectClean(report);
  });

  it("refuses to kill pid 1 or a missing pid and still removes the copy", async () => {
    const one = entry("old-init", { startedAt: Date.now() - 10 * hours, timeoutMs: 600000, pid: 1 });
    const gone = entry("old-gone", { startedAt: Date.now() - 10 * hours, timeoutMs: 600000, pid: 2147483000 });
    const report = await sweepRun();
    expect(existsSync(one)).toBe(false);
    expect(existsSync(gone)).toBe(false);
    expectClean(report);
  });

  it("spares a copy whose owner run is still alive, however old the record is", async () => {
    const owner = orphan("34", tmpdir());
    const start = readProcessStat(owner.pid!)?.start;
    const dir = entry("old-live", { startedAt: Date.now() - 10 * hours, timeoutMs: 600000, owner: owner.pid, ownerStart: start });
    const running = orphan("35", dir);
    writeMetaFile("old-live", { startedAt: Date.now() - 10 * hours, timeoutMs: 600000, owner: owner.pid, ownerStart: start, pid: running.pid });
    try {
      await sweepRun();
      expect(existsSync(join(dir, "file"))).toBe(true);
      expect(() => process.kill(running.pid!, 0)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(join(parent, "old-live.meta.json"), { force: true });
    }
  });

  it("sweeps a copy whose owner pid now belongs to a different process", async () => {
    const owner = orphan("36", tmpdir());
    const dir = entry("old-reused-owner", { startedAt: Date.now() - 10 * hours, timeoutMs: 600000, owner: owner.pid, ownerStart: "1" });
    const report = await sweepRun();
    expect(existsSync(dir)).toBe(false);
    expect(() => process.kill(owner.pid!, 0)).not.toThrow();
    expectClean(report);
  });

  it("keeps a fresh copy and uses the longer of 2 hours and three timeouts", async () => {
    const fresh = entry("fresh", { startedAt: Date.now() - hours, timeoutMs: 600000 });
    const longTimeout = entry("long-timeout", { startedAt: Date.now() - 3 * hours, timeoutMs: 2 * hours });
    try {
      const report = await sweepRun();
      expect(existsSync(join(fresh, "file"))).toBe(true);
      expect(existsSync(join(longTimeout, "file"))).toBe(true);
      expect(report.workspaceRemoved).toBe(true);
    } finally {
      for (const name of ["fresh", "long-timeout"]) {
        rmSync(join(parent, name), { recursive: true, force: true });
        rmSync(join(parent, `${name}.meta.json`), { force: true });
      }
    }
    expect(leftovers()).toEqual([]);
  });

  it("ignores a metadata file that other users can write", async () => {
    const dir = entry("old-writable", { startedAt: Date.now() - 10 * hours, timeoutMs: 600000 });
    const child = orphan("37", dir);
    const metaFile = join(parent, "old-writable.meta.json");
    writeFileSync(metaFile, JSON.stringify({ startedAt: Date.now() - 10 * hours, timeoutMs: 600000, pid: child.pid }));
    chmodSync(metaFile, 0o666);
    const old = new Date(Date.now() - 10 * hours);
    utimesSync(dir, old, old);
    const report = await sweepRun();
    expect(existsSync(dir)).toBe(false);
    expect(() => process.kill(child.pid!, 0)).not.toThrow();
    expectClean(report);
  });

  it("creates the state directory private to the user", async () => {
    rmSync(parent, { recursive: true, force: true });
    mkdirSync(parent, { mode: 0o777 });
    chmodSync(parent, 0o777);
    const report = await sweepRun();
    expect(lstatSync(parent).mode & 0o077).toBe(0);
    expectClean(report);
  });

  it("records the owner and the running command in the metadata next to the workspace", async () => {
    write("src/value.txt", "2");
    write("tests/check.sh", `grep -q "\\"pid\\":$$" ../*.meta.json && grep -q "\\"owner\\":${process.pid}" ../*.meta.json && ${check("2")}`);
    const report = await runProve({ cwd: repo, testCommand: TEST_COMMAND });
    expect(report.verdict).toBe("proven");
    expectClean(report);
  });
});

describe("runProve workspace creation", () => {
  function fakeGit(): string {
    const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    const dir = tempDir("herdr-jev-prove-fakegit-");
    const file = join(dir, "git");
    writeFileSync(file, `#!/bin/sh\nfor a in "$@"; do if [ "$a" = clone ]; then sleep 30; exit 1; fi; done\nexec "${real}" "$@"\n`);
    chmodSync(file, 0o755);
    return dir;
  }

  it("aborts a slow clone when the signal fires", async () => {
    write("src/value.txt", "2");
    write("tests/check.sh", check("2"));
    const dir = fakeGit();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    const started = Date.now();
    const report = await withEnv({ PATH: `${dir}:${process.env.PATH}` }, () => runProve({ cwd: repo, testCommand: TEST_COMMAND, signal: controller.signal }));
    expect(Date.now() - started).toBeLessThan(15000);
    expect(report.verdict).toBe("error");
    expect(report.reason).toBe("aborted");
    expectClean(report);
  });

  it("times out a slow clone", async () => {
    write("src/value.txt", "2");
    write("tests/check.sh", check("2"));
    const dir = fakeGit();
    const started = Date.now();
    const report = await withEnv({ PATH: `${dir}:${process.env.PATH}` }, () => runProve({ cwd: repo, testCommand: TEST_COMMAND, timeoutMs: 1000 }));
    expect(Date.now() - started).toBeLessThan(15000);
    expect(report.verdict).toBe("error");
    expect(report.reason).toContain("workspace_timeout");
    expectClean(report);
  });
});

describe("runProve symlink replacements", () => {
  it("handles a directory replaced by an absolute symlink without touching the target", async () => {
    const external = tempDir("herdr-jev-prove-linktarget-");
    writeFileSync(join(external, "data.txt"), "external");
    writeFileSync(join(external, "inner.txt"), "external inner");
    write("src/thing/inner.txt", "inner");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "dir");
    rmSync(join(repo, "src", "thing"), { recursive: true });
    symlinkSync(external, join(repo, "src", "thing"));
    write("tests/check.sh", "[ -L src/thing ]\n");
    const before = hashTree(external);
    const report = await runProve({ cwd: repo, testCommand: TEST_COMMAND });
    expect(report.verdict).toBe("proven");
    expect(hashTree(external)).toEqual(before);
    expectClean(report);
  });

  it("handles a directory replaced by a relative symlink", async () => {
    write("shared/inner.txt", "shared inner");
    write("src/thing/inner.txt", "inner");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "dir");
    rmSync(join(repo, "src", "thing"), { recursive: true });
    symlinkSync("../shared", join(repo, "src", "thing"));
    write("tests/check.sh", "[ -L src/thing ]\n");
    const report = await runProve({ cwd: repo, testCommand: TEST_COMMAND });
    expect(report.verdict).toBe("proven");
    expectClean(report);
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
    return { ...gitEnv(), HOME: home, ...ISOLATED_ENV };
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
    expectClean({ workspaceRemoved: true });
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

  async function interrupted(signalTarget: "child" | "group"): Promise<{ code: number | null; stdout: string }> {
    write("src/value.txt", "2");
    write("tests/check.sh", `mkdir big\nseq 1 30000 | sed 's|^|big/f|' | xargs touch\ntouch ready-marker\nsleep 30\n${check("2")}`);
    const commandFile = join(tempDir("herdr-jev-prove-cmd-"), "cmd.json");
    writeFileSync(commandFile, JSON.stringify(TEST_COMMAND));
    const child = spawn(process.execPath, [cli, "prove", "--test-command-json", commandFile, "--json"], { cwd: repo, env: cliEnv(), stdio: ["ignore", "pipe", "pipe"], detached: signalTarget === "group" });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    const exited = new Promise<number | null>((resolveExit) => child.on("close", (code) => resolveExit(code)));
    const send = () => {
      try {
        if (signalTarget === "group") process.kill(-child.pid!, "SIGINT");
        else child.kill("SIGINT");
      } catch {
      }
    };
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const dir = join(process.env.HERDR_JEV_STATE_DIR!, "prove");
      const entries = existsSync(dir) ? readdirSync(dir).filter((name) => !name.endsWith(".meta.json")) : [];
      if (entries.length > 0 && existsSync(join(dir, entries[0]!, "ready-marker"))) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    send();
    await new Promise((r) => setTimeout(r, 15));
    send();
    const code = await exited;
    return { code, stdout };
  }

  it("cleans up after a second interrupt that arrives while cleanup is running", async () => {
    const before = git(repo, "worktree", "list", "--porcelain");
    const { code, stdout } = await interrupted("child");
    expect(code).toBe(1);
    expect(JSON.parse(stdout).reason).toBe("aborted");
    expect(JSON.parse(stdout).workspaceRemoved).toBe(true);
    expect(git(repo, "worktree", "list", "--porcelain")).toBe(before);
    expectClean({ workspaceRemoved: true });
  });

  it("cleans up after an interrupt burst sent to the whole process group", async () => {
    const before = git(repo, "worktree", "list", "--porcelain");
    const { code, stdout } = await interrupted("group");
    expect(code).toBe(1);
    expect(JSON.parse(stdout).reason).toBe("aborted");
    expect(git(repo, "worktree", "list", "--porcelain")).toBe(before);
    expectClean({ workspaceRemoved: true });
  });

  it("runs an auto-detected test command at the repository root even from a subdirectory", () => {
    write("package.json", JSON.stringify({ scripts: { test: "bun test" } }));
    write("pkg/.keep", "");
    write("src/value.ts", "export const value = 1;\n");
    write("tests/value.test.ts", 'import { expect, test } from "bun:test";\nimport { value } from "../src/value.ts";\ntest("v", () => expect(value).toBe(1));\n');
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "root project");
    write("src/value.ts", "export const value = 2;\n");
    write("tests/value.test.ts", 'import { expect, test } from "bun:test";\nimport { value } from "../src/value.ts";\ntest("v", () => expect(value).toBe(2));\n');
    const result = runCli(["--json"], join(repo, "pkg"));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).verdict).toBe("proven");
    expectClean({ workspaceRemoved: true });
  });

  it("resolves --test-file against the current directory and rejects files that did not change", () => {
    write("pkg/checks/value.sh", "[ \"$(cat ../src/value.txt)\" = 2 ]\n");
    write("tests/other.sh", "exit 0\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "pkg");
    write("src/value.txt", "2");
    write("pkg/checks/value.sh", "[ \"$(cat ../src/value.txt)\" = 2 ]\n# changed\n");
    write("tests/other.sh", "exit 0\n# changed\n");
    const commandFile = join(tempDir("herdr-jev-prove-cmd-"), "cmd.json");
    writeFileSync(commandFile, JSON.stringify(["sh", "pkg/checks/value.sh"]));
    const fromSub = runCli(["--test-command-json", commandFile, "--test-file", "checks/value.sh", "--json"], join(repo, "pkg"));
    const sub = JSON.parse(fromSub.stdout);
    expect(sub.testFiles).toContain("pkg/checks/value.sh");
    expect(sub.sourceFiles).toEqual(["src/value.txt"]);
    const fromRoot = runCli(["--test-command-json", commandFile, "--test-file", "pkg/checks/value.sh", "--json"]);
    expect(JSON.parse(fromRoot.stdout).testFiles).toContain("pkg/checks/value.sh");
    const typo = runCli(["--test-command-json", commandFile, "--test-file", "checks/valeu.sh", "--json"], join(repo, "pkg"));
    expect(typo.status).toBe(1);
    expect(JSON.parse(typo.stdout).reason).toContain("test_file_not_in_change_set");
    const typoRoot = runCli(["--test-command-json", commandFile, "--test-file", "pkg/checks/valeu.sh", "--json"]);
    expect(typoRoot.status).toBe(1);
    expect(JSON.parse(typoRoot.stdout).reason).toContain("test_file_not_in_change_set");
    expectClean({ workspaceRemoved: true });
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
