import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReviewPatch, createReviewWorktree, isSecretLikePath } from "../src/council/review-dir.js";
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
    expect(isSecretLikePath(".envrc")).toBe(true);
    expect(isSecretLikePath("app/.ENV")).toBe(true);
    expect(isSecretLikePath(".env-production")).toBe(true);
    expect(isSecretLikePath(".env_local")).toBe(true);
    expect(isSecretLikePath(".git-credentials")).toBe(true);
    expect(isSecretLikePath("home/.NPMRC")).toBe(true);
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

function walkFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

describe("council review patch diff flags", () => {
  it("ignores textconv drivers so the patch applies", async () => {
    writeIn(repo, ".gitattributes", "*.dat diff=upper\n");
    writeIn(repo, "data.dat", "hello world\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "dat");
    git(repo, "config", "diff.upper.textconv", "tr a-z A-Z <");
    writeIn(repo, "data.dat", "hello there\n");
    const patch = await buildReviewPatch(repo);
    expect(patch.patch).toContain("+hello there");
    expect(patch.patch).not.toContain("HELLO");
    expect(patch.promptDiff).not.toContain("HELLO");
    const worktree = await createReviewWorktree(patch, "codex", state.stateDir);
    expect(readFileSync(join(worktree.path, "data.dat"), "utf8")).toBe("hello there\n");
    await worktree.remove();
  });

  it("keeps a modified tracked binary out of the prompt diff", async () => {
    writeFileSync(join(repo, "blob.bin"), Buffer.from(Array.from({ length: 3000 }, (_, i) => i % 256)));
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "bin");
    writeFileSync(join(repo, "blob.bin"), Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 5 + 1) % 256)));
    writeIn(repo, "src/a.ts", "export const a = 2;\n");
    const patch = await buildReviewPatch(repo);
    expect(patch.patch).toContain("GIT binary patch");
    expect(patch.promptDiff).not.toContain("GIT binary patch");
    expect(patch.promptDiff).toContain("+export const a = 2;");
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
    git(worktree.path, "update-ref", "refs/heads/main", "HEAD");
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

  it("leaves no way into the user's repository from inside", async () => {
    writeIn(repo, "config/credentials.json", "{\"s\":\"COMMITTEDSECRET\"}\n");
    writeIn(repo, ".env", "TOKEN=oldsecret\n");
    git(repo, "add", "-A", "-f");
    git(repo, "commit", "-q", "-m", "oops");
    git(repo, "rm", "-q", "--cached", ".env");
    git(repo, "commit", "-q", "-m", "drop env");
    git(repo, "add", "-A", "-f");
    git(repo, "commit", "-q", "-m", "oops again");
    writeIn(repo, "src/a.ts", "export const a = 5;\n");
    const worktree = await createReviewWorktree(await buildReviewPatch(repo), "kimi", state.stateDir);
    const inside = (...args: string[]) => spawnSync("git", args, { cwd: worktree.path, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    expect(inside("show", "HEAD:config/credentials.json").status).not.toBe(0);
    expect(inside("show", "HEAD:.env").status).not.toBe(0);
    const history = inside("log", "-p", "--all", "-S", "COMMITTEDSECRET");
    expect(history.stdout).toBe("");
    expect(inside("log", "-p", "--all", "-S", "oldsecret").stdout).toBe("");
    expect(inside("rev-list", "--all", "--count").stdout.trim()).toBe("1");
    expect(existsSync(join(worktree.path, ".git/objects/info/alternates"))).toBe(false);
    expect(inside("remote").stdout.trim()).toBe("");
    for (const file of walkFiles(join(worktree.path, ".git"))) {
      expect(readFileSync(file).includes(repo)).toBe(false);
    }
    expect(inside("config", "-l").stdout).not.toContain(repo);
    expect(inside("for-each-ref").stdout).not.toContain(repo);
    await worktree.remove();
  });

  it("shows the exported base as a single commit with M and ?? status", async () => {
    writeIn(repo, "src/a.ts", "export const a = 2;\n");
    writeIn(repo, "src/new.ts", "export const n = 1;\n");
    const worktree = await createReviewWorktree(await buildReviewPatch(repo), "codex", state.stateDir);
    expect(git(worktree.path, "rev-list", "--all", "--count")).toBe("1");
    expect(gitRaw(worktree.path, "status", "--porcelain").trimEnd().split("\n").sort()).toEqual([" M src/a.ts", "?? src/new.ts"]);
    await worktree.remove();
  });

  it("does not fire hooks configured through the environment", async () => {
    const hooks = mkdtempSync(join(tmpdir(), "council-hooks-"));
    const marker = join(hooks, "ran");
    for (const name of ["pre-commit", "post-commit", "post-checkout", "reference-transaction"]) {
      writeFileSync(join(hooks, name), `#!/bin/sh\ntouch ${marker}\n`);
      chmodSync(join(hooks, name), 0o755);
    }
    const saved = { c: process.env.GIT_CONFIG_COUNT, k: process.env.GIT_CONFIG_KEY_0, v: process.env.GIT_CONFIG_VALUE_0 };
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "core.hooksPath";
    process.env.GIT_CONFIG_VALUE_0 = hooks;
    try {
      writeIn(repo, "src/a.ts", "export const a = 2;\n");
      const worktree = await createReviewWorktree(await buildReviewPatch(repo), "codex", state.stateDir);
      expect(existsSync(marker)).toBe(false);
      await worktree.remove();
    } finally {
      for (const [key, value] of [["GIT_CONFIG_COUNT", saved.c], ["GIT_CONFIG_KEY_0", saved.k], ["GIT_CONFIG_VALUE_0", saved.v]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(hooks, { recursive: true, force: true });
    }
  });

  it("does not copy a git template into the review directory", async () => {
    const template = mkdtempSync(join(tmpdir(), "council-template-"));
    mkdirSync(join(template, "hooks"));
    writeFileSync(join(template, "hooks", "post-commit"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(template, "from-template"), "x");
    const saved = { c: process.env.GIT_CONFIG_COUNT, k: process.env.GIT_CONFIG_KEY_0, v: process.env.GIT_CONFIG_VALUE_0 };
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "init.templateDir";
    process.env.GIT_CONFIG_VALUE_0 = template;
    try {
      writeIn(repo, "src/a.ts", "export const a = 2;\n");
      const worktree = await createReviewWorktree(await buildReviewPatch(repo), "codex", state.stateDir);
      expect(existsSync(join(worktree.path, ".git/from-template"))).toBe(false);
      expect(existsSync(join(worktree.path, ".git/hooks/post-commit"))).toBe(false);
      await worktree.remove();
    } finally {
      for (const [key, value] of [["GIT_CONFIG_COUNT", saved.c], ["GIT_CONFIG_KEY_0", saved.k], ["GIT_CONFIG_VALUE_0", saved.v]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(template, { recursive: true, force: true });
    }
  });

  it("refuses to remove a directory that resolves outside the review root", async () => {
    writeIn(repo, "src/a.ts", "export const a = 2;\n");
    const worktree = await createReviewWorktree(await buildReviewPatch(repo), "codex", state.stateDir);
    const outside = mkdtempSync(join(tmpdir(), "council-outside-"));
    writeFileSync(join(outside, "keep"), "x");
    rmSync(worktree.path, { recursive: true, force: true });
    symlinkSync(outside, worktree.path);
    const problem = await worktree.remove();
    expect(problem).toContain("outside the review directory");
    expect(existsSync(join(outside, "keep"))).toBe(true);
    rmSync(worktree.path, { force: true });
    rmSync(outside, { recursive: true, force: true });
  });
});
