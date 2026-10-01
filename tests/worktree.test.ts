import { describe, expect, it, afterAll } from "bun:test";
import { setupWorktree } from "../src/herdr/agents.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

describe("subagent worktree helper", () => {
  const tmpDirs: string[] = [];
  
  afterAll(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates a worktree when not existing using injected mock git runner", async () => {
    const fakeRepo = "/tmp/fake-repo";
    let gitLog: string[] = [];
    const mockGit = async (args: string[], cwd: string) => {
      gitLog.push(`git ${args.join(" ")} at ${cwd}`);
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        if (cwd === fakeRepo) return { ok: true, stdout: fakeRepo, stderr: "" };
        return { ok: false, stdout: "", stderr: "" };
      }
      if (args[0] === "show-ref") return { ok: false, stdout: "", stderr: "" };
      if (args[0] === "worktree" && args[1] === "add") return { ok: true, stdout: "", stderr: "" };
      return { ok: false, stdout: "", stderr: "unknown" };
    };

    const res = await setupWorktree({ worktree: "myname", gitRunner: mockGit }, fakeRepo);
    expect(res.error).toBeUndefined();
    expect(res.worktreePath).toBe(fakeRepo + "-wt-myname");
    expect(res.worktreeBranch).toBe("wt/myname");
    expect(gitLog).toContain(`git rev-parse --show-toplevel at ${fakeRepo}`);
    expect(gitLog).toContain(`git worktree add -b wt/myname ${fakeRepo}-wt-myname HEAD at ${fakeRepo}`);
  });

  it("reuses worktree if directory already exists with same toplevel using mock runner", async () => {
    const fakeRepo = "/tmp/fake-repo";
    const targetDir = fakeRepo + "-wt-myname";
    
    let gitLog: string[] = [];
    const mockGit = async (args: string[], cwd: string) => {
      gitLog.push(`git ${args.join(" ")} at ${cwd}`);
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        if (cwd === fakeRepo || cwd === targetDir) return { ok: true, stdout: fakeRepo, stderr: "" };
        return { ok: false, stdout: "", stderr: "" };
      }
      return { ok: false, stdout: "", stderr: "unknown" };
    };

    const res = await setupWorktree({ worktree: "myname", gitRunner: mockGit }, fakeRepo);
    expect(res.error).toBeUndefined();
    expect(res.worktreePath).toBe(targetDir);
    expect(res.worktreeBranch).toBe("wt/myname");
  });

  it("fails if not inside a git repository", async () => {
    const fakeRepo = "/tmp/not-a-repo";
    const mockGit = async (args: string[], cwd: string) => {
      return { ok: false, stdout: "", stderr: "fatal: not a git repository" };
    };
    const res = await setupWorktree({ worktree: "myname", gitRunner: mockGit }, fakeRepo);
    expect(res.error).toContain("Error: Directory is not inside a git repository");
    expect(res.worktreePath).toBeNull();
  });

  it("works against a real throwaway repository created with mkdtemp", async () => {
    const rootDir = join(tmpdir(), "wt-test-repo-" + Date.now());
    mkdirSync(rootDir, { recursive: true });
    tmpDirs.push(rootDir);

    const repoDir = join(rootDir, "repo");
    mkdirSync(repoDir);
    
    spawnSync("git", ["init"], { cwd: repoDir });
    spawnSync("git", ["commit", "--allow-empty", "-m", "init", "--author", "Test <test@example.com>"], { cwd: repoDir });
    
    // We import defaultGitRunner from agents.js to test with real git commands
    const { defaultGitRunner } = await import("../src/herdr/agents.js");
    
    const res = await setupWorktree({ worktree: "realname", gitRunner: defaultGitRunner }, repoDir);
    expect(res.error).toBeUndefined();
    expect(res.worktreePath).toBe(repoDir + "-wt-realname");
    expect(res.worktreeBranch).toBe("wt/realname");
    
    // Check that the worktree was actually created
    const wtCheck = spawnSync("git", ["worktree", "list"], { cwd: repoDir, encoding: "utf8" });
    expect(wtCheck.stdout).toContain(repoDir + "-wt-realname");
    expect(wtCheck.stdout).toContain("wt/realname");
  });
});
