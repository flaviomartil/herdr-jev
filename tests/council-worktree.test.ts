import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildReviewPatch, createReviewWorktree, isSecretLikePath } from "../src/council/worktree.js";
import { git, makeRepo, writeIn } from "./council-helpers.js";
import { createTestStateDir } from "./helpers.js";

let repo: string;
let state: { stateDir: string; cleanup: () => void };

beforeEach(() => {
  repo = makeRepo();
  state = createTestStateDir();
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  state.cleanup();
});

describe("council review patch", () => {
  it("captures tracked changes and non secret untracked files", async () => {
    writeIn(repo, "src/a.ts", "export const a = 2;\n");
    writeIn(repo, "src/new.ts", "export const n = 1;\n");
    const patch = await buildReviewPatch(repo);
    expect(patch.patch).toContain("+export const a = 2;");
    expect(patch.patch).toContain("b/src/new.ts");
    expect(patch.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps secret looking untracked files out of the patch", async () => {
    writeIn(repo, "src/a.ts", "export const a = 2;\n");
    writeIn(repo, ".env", "TOKEN=hunter2\n");
    writeIn(repo, ".env.local", "TOKEN=hunter3\n");
    writeIn(repo, "certs/server.pem", "PEMDATA\n");
    writeIn(repo, "certs/server.key", "KEYDATA\n");
    writeIn(repo, "config/my-secret.json", "{\"s\":\"SECRETDATA\"}\n");
    writeIn(repo, "config/Credentials.txt", "CREDDATA\n");
    writeIn(repo, "src/ok.ts", "export const ok = 1;\n");
    const patch = await buildReviewPatch(repo);
    for (const leak of ["hunter2", "hunter3", "PEMDATA", "KEYDATA", "SECRETDATA", "CREDDATA", ".env", "server.pem", "my-secret"]) {
      expect(patch.patch).not.toContain(leak);
    }
    expect(patch.patch).toContain("b/src/ok.ts");
    expect(patch.skippedUntracked).toBe(6);
  });

  it("classifies secret names", () => {
    expect(isSecretLikePath(".env")).toBe(true);
    expect(isSecretLikePath("apps/web/.env.production")).toBe(true);
    expect(isSecretLikePath("a/b/id.pem")).toBe(true);
    expect(isSecretLikePath("src/environment.ts")).toBe(false);
    expect(isSecretLikePath("src/a.ts")).toBe(false);
  });

  it("diffs against the merge base with a base ref", async () => {
    git(repo, "checkout", "-q", "-b", "feature");
    writeIn(repo, "src/b.ts", "export const b = 1;\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "feature");
    expect((await buildReviewPatch(repo)).patch).toBe("");
    const patch = await buildReviewPatch(repo, "main");
    expect(patch.patch).toContain("b/src/b.ts");
    expect(patch.baseCommit).toBe(git(repo, "rev-parse", "main"));
  });
});

describe("council review worktree", () => {
  it("applies the patch and is removed afterwards", async () => {
    writeIn(repo, "src/a.ts", "export const a = 2;\n");
    writeIn(repo, "src/new.ts", "export const n = 1;\n");
    writeIn(repo, ".env", "TOKEN=hunter2\n");
    const patch = await buildReviewPatch(repo);
    const worktree = await createReviewWorktree(patch, "codex", state.stateDir);
    expect(readFileSync(join(worktree.path, "src/a.ts"), "utf8")).toBe("export const a = 2;\n");
    expect(readFileSync(join(worktree.path, "src/new.ts"), "utf8")).toBe("export const n = 1;\n");
    expect(existsSync(join(worktree.path, ".env"))).toBe(false);
    expect(git(repo, "worktree", "list")).toContain(worktree.path);
    expect(readFileSync(join(repo, "src/a.ts"), "utf8")).toBe("export const a = 2;\n");
    await worktree.remove();
    expect(existsSync(worktree.path)).toBe(false);
    expect(git(repo, "worktree", "list")).not.toContain(worktree.path);
  });

  it("removes the worktree when applying the patch fails", async () => {
    const patch = await buildReviewPatch(repo);
    const broken = { ...patch, patch: "diff --git a/nope b/nope\n--- a/nope\n+++ b/nope\n@@ -1 +1 @@\n-x\n+y\n" };
    await expect(createReviewWorktree(broken, "kimi", state.stateDir)).rejects.toThrow();
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
    const left = existsSync(join(state.stateDir, "council")) ? readdirSync(join(state.stateDir, "council")) : [];
    expect(left).toEqual([]);
  });

  it("gives each worktree a unique path", async () => {
    writeIn(repo, "src/a.ts", "export const a = 2;\n");
    const patch = await buildReviewPatch(repo);
    const first = await createReviewWorktree(patch, "codex", state.stateDir);
    const second = await createReviewWorktree(patch, "codex", state.stateDir);
    expect(first.path).not.toBe(second.path);
    await first.remove();
    await second.remove();
  });
});
