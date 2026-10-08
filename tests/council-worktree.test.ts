import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { buildReviewPatch, createReviewWorktree, isSecretLikePath } from "../src/council/worktree.js";
import { git, gitRaw, makeRepo, writeIn } from "./council-helpers.js";
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
    expect(patch.promptDiff).toContain("b/src/new.ts");
    expect(patch.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps secret looking changed files out of the patch and the prompt diff", async () => {
    writeIn(repo, "src/a.ts", "export const a = 2;\n");
    writeIn(repo, ".env", "TOKEN=hunter2\n");
    writeIn(repo, ".env.local", "TOKEN=hunter3\n");
    writeIn(repo, "certs/server.pem", "PEMDATA\n");
    writeIn(repo, "certs/server.p12", "P12DATA\n");
    writeIn(repo, "keys/id_rsa", "RSADATA\n");
    writeIn(repo, ".npmrc", "//registry:_authToken=NPMDATA\n");
    writeIn(repo, ".netrc", "password NETRCDATA\n");
    writeIn(repo, "infra/terraform.tfvars", "pw=TFDATA\n");
    writeIn(repo, "config/credentials.json", "{\"s\":\"CREDDATA\"}\n");
    writeIn(repo, "src/ok.ts", "export const ok = 1;\n");
    const patch = await buildReviewPatch(repo);
    for (const text of [patch.patch, patch.promptDiff]) {
      for (const leak of ["hunter2", "hunter3", "PEMDATA", "P12DATA", "RSADATA", "NPMDATA", "NETRCDATA", "TFDATA", "CREDDATA"]) expect(text).not.toContain(leak);
      expect(text).toContain("b/src/ok.ts");
    }
    expect(patch.skippedPaths).toEqual([".env", ".env.local", ".netrc", ".npmrc", "certs/server.p12", "certs/server.pem", "config/credentials.json", "infra/terraform.tfvars", "keys/id_rsa"]);
  });

  it("keeps staged and committed secret files out as well", async () => {
    writeIn(repo, ".env", "TOKEN=committed1\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "oops");
    writeIn(repo, ".env", "TOKEN=changed2\n");
    writeIn(repo, "deploy.key", "STAGEDKEY\n");
    writeIn(repo, "src/a.ts", "export const a = 3;\n");
    git(repo, "add", "deploy.key");
    const patch = await buildReviewPatch(repo);
    for (const text of [patch.patch, patch.promptDiff]) {
      for (const leak of ["committed1", "changed2", "STAGEDKEY"]) expect(text).not.toContain(leak);
      expect(text).toContain("+export const a = 3;");
    }
    expect(patch.skippedPaths).toEqual([".env", "deploy.key"]);
  });

  it("keeps source files whose names merely contain secret or credential", async () => {
    writeIn(repo, "src/auth/credentials.ts", "export const c = 1;\n");
    writeIn(repo, "tests/secret.test.ts", "export const s = 1;\n");
    const patch = await buildReviewPatch(repo);
    expect(patch.patch).toContain("b/src/auth/credentials.ts");
    expect(patch.patch).toContain("b/tests/secret.test.ts");
    expect(patch.skippedPaths).toEqual([]);
  });

  it("classifies secret names", () => {
    expect(isSecretLikePath(".env")).toBe(true);
    expect(isSecretLikePath("apps/web/.env.production")).toBe(true);
    expect(isSecretLikePath("a/b/id.pem")).toBe(true);
    expect(isSecretLikePath(".env.example")).toBe(false);
    expect(isSecretLikePath("src/environment.ts")).toBe(false);
    expect(isSecretLikePath("src/a.ts")).toBe(false);
  });

  it("leaves oversized untracked files out and lists them", async () => {
    writeIn(repo, "big.txt", "x".repeat(2000));
    writeIn(repo, "small.txt", "tiny\n");
    const patch = await buildReviewPatch(repo, undefined, 1000);
    expect(patch.oversizedPaths).toEqual(["big.txt"]);
    expect(patch.patch).not.toContain("big.txt");
    expect(patch.patch).toContain("small.txt");
  });

  it("applies the default five megabyte cap to untracked files", async () => {
    writeIn(repo, "huge.bin", "y".repeat(5 * 1024 * 1024 + 10));
    writeIn(repo, "src/a.ts", "export const a = 2;\n");
    const patch = await buildReviewPatch(repo);
    expect(patch.oversizedPaths).toEqual(["huge.bin"]);
    expect(patch.patch).not.toContain("huge.bin");
  });

  it("keeps a binary change in the patch but out of the prompt diff", async () => {
    writeFileSync(join(repo, "blob.bin"), Buffer.from(Array.from({ length: 4000 }, (_, i) => (i * 7) % 256)));
    writeIn(repo, "src/a.ts", "export const a = 2;\n");
    const patch = await buildReviewPatch(repo);
    expect(patch.patch).toContain("GIT binary patch");
    expect(patch.promptDiff).not.toContain("GIT binary patch");
    expect(patch.promptDiff).toContain("+export const a = 2;");
    expect(patch.promptDiff.length).toBeLessThan(2000);
  });

  it("diffs against the merge base with a base ref and rejects a dashed base", async () => {
    git(repo, "checkout", "-q", "-b", "feature");
    writeIn(repo, "src/b.ts", "export const b = 1;\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "feature");
    expect((await buildReviewPatch(repo)).patch).toBe("");
    const patch = await buildReviewPatch(repo, "main");
    expect(patch.patch).toContain("b/src/b.ts");
    expect(patch.baseCommit).toBe(git(repo, "rev-parse", "main"));
    await expect(buildReviewPatch(repo, "--output=/tmp/x")).rejects.toThrow("invalid_base");
    await expect(buildReviewPatch(repo, "-x")).rejects.toThrow("invalid_base");
  });

  it("reports the last stderr line of a failing git command", async () => {
    await expect(buildReviewPatch(repo, "no-such-ref")).rejects.toThrow(/git_failed/);
  });
});

describe("council review directory", () => {
  it("is a standalone clone: applies the patch, shows M and ?? and has no remote", async () => {
    writeIn(repo, "src/a.ts", "export const a = 2;\n");
    writeIn(repo, "src/new.ts", "export const n = 1;\n");
    writeIn(repo, ".env", "TOKEN=hunter2\n");
    const patch = await buildReviewPatch(repo);
    const worktree = await createReviewWorktree(patch, "codex", state.stateDir);
    expect(readFileSync(join(worktree.path, "src/a.ts"), "utf8")).toBe("export const a = 2;\n");
    expect(existsSync(join(worktree.path, ".env"))).toBe(false);
    expect(gitRaw(worktree.path, "status", "--porcelain").trimEnd().split("\n").sort()).toEqual([" M src/a.ts", "?? src/new.ts"]);
    expect(git(worktree.path, "remote")).toBe("");
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
    expect(readFileSync(join(repo, "src/a.ts"), "utf8")).toBe("export const a = 2;\n");
    expect(await worktree.remove()).toBeUndefined();
    expect(existsSync(worktree.path)).toBe(false);
  });

  it("uses mode 0700 for the directories", async () => {
    writeIn(repo, "src/a.ts", "export const a = 2;\n");
    const worktree = await createReviewWorktree(await buildReviewPatch(repo), "kimi", state.stateDir);
    expect(statSync(worktree.path).mode & 0o777).toBe(0o700);
    expect(statSync(join(state.stateDir, "council")).mode & 0o777).toBe(0o700);
    await worktree.remove();
  });

  it("removes committed sensitive files from the clone without showing them as deleted", async () => {
    writeIn(repo, ".env", "TOKEN=committed1\n");
    writeIn(repo, "src/a.ts", "export const a = 1;\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "oops");
    writeIn(repo, "src/a.ts", "export const a = 2;\n");
    const worktree = await createReviewWorktree(await buildReviewPatch(repo), "codex", state.stateDir);
    expect(existsSync(join(worktree.path, ".env"))).toBe(false);
    expect(gitRaw(worktree.path, "status", "--porcelain")).toBe(" M src/a.ts\n");
    await worktree.remove();
  });

  it("does not run the user's git hooks", async () => {
    const marker = join(repo, "hook-ran");
    const hook = join(repo, ".git/hooks/post-checkout");
    writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(hook, 0o755);
    writeIn(repo, "src/a.ts", "export const a = 2;\n");
    const worktree = await createReviewWorktree(await buildReviewPatch(repo), "codex", state.stateDir);
    expect(existsSync(marker)).toBe(false);
    await worktree.remove();
  });

  it("cannot change the user's stash, config or refs from inside", async () => {
    git(repo, "branch", "other");
    writeIn(repo, "src/a.ts", "export const a = 2;\n");
    const snapshot = () => ({ stash: git(repo, "stash", "list"), config: git(repo, "config", "-l"), refs: git(repo, "for-each-ref"), head: git(repo, "rev-parse", "HEAD") });
    const before = snapshot();
    const worktree = await createReviewWorktree(await buildReviewPatch(repo), "kimi", state.stateDir);
    git(worktree.path, "stash", "push", "-u");
    git(worktree.path, "config", "core.hooksPath", "/tmp/evil-hooks");
    git(worktree.path, "update-ref", "-d", "refs/heads/other");
    git(worktree.path, "branch", "-f", "main", "HEAD");
    expect(git(worktree.path, "stash", "list")).not.toBe("");
    expect(snapshot()).toEqual(before);
    expect(git(repo, "branch", "--list", "other")).toContain("other");
    await worktree.remove();
    expect(snapshot()).toEqual(before);
  });

  it("removes the directory when applying the patch fails", async () => {
    const patch = await buildReviewPatch(repo);
    const broken = { ...patch, patch: "diff --git a/nope b/nope\n--- a/nope\n+++ b/nope\n@@ -1 +1 @@\n-x\n+y\n" };
    await expect(createReviewWorktree(broken, "kimi", state.stateDir)).rejects.toThrow();
    const left = existsSync(join(state.stateDir, "council")) ? readdirSync(join(state.stateDir, "council")) : [];
    expect(left).toEqual([]);
  });

  it("gives each directory a unique path", async () => {
    writeIn(repo, "src/a.ts", "export const a = 2;\n");
    const patch = await buildReviewPatch(repo);
    const first = await createReviewWorktree(patch, "codex", state.stateDir);
    const second = await createReviewWorktree(patch, "codex", state.stateDir);
    expect(first.path).not.toBe(second.path);
    await first.remove();
    await second.remove();
  });
});
