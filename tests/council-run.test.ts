import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runCouncil } from "../src/council/run.js";
import { fakeSpawn, git, makeRepo, ok, writeIn } from "./council-helpers.js";
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

const finding = (title: string) => JSON.stringify({ path: "src/a.ts", line: 1, severity: "high", title, detail: "why" });

function worktreesLeft(): string[] {
  const dir = join(state.stateDir, "council");
  return existsSync(dir) ? readdirSync(dir) : [];
}

describe("runCouncil", () => {
  it("runs the members in parallel and collects findings", async () => {
    const fake = fakeSpawn({
      codex: () => ok(`- [P1] Codex issue — /x:1-1\n  detail`),
      kimi: () => ok(finding("Kimi issue")),
      agy: () => ok(JSON.stringify({ result: "NO_FINDINGS" })),
    });
    const run = await runCouncil({ cwd: repo, spawn: fake.spawn, stateDir: state.stateDir });
    expect(run.ran).toBe(true);
    expect(run.members.map((entry) => [entry.member, entry.status])).toEqual([
      ["codex", "done"],
      ["kimi", "done"],
      ["antigravity", "done"],
    ]);
    expect(run.members[1].findings[0].title).toBe("Kimi issue");
    expect(run.members[2].findings).toEqual([]);
    expect(run.diffHash).toMatch(/^[0-9a-f]{64}$/);
    expect(fake.reviewCalls.map((call) => call.argv[0]).sort()).toEqual(["agy", "codex", "kimi"]);
    for (const call of fake.reviewCalls) expect(call.cwd.startsWith(state.stateDir)).toBe(true);
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
    expect(worktreesLeft()).toEqual([]);
  });

  it("reviews the diff inside a throwaway tree, never the user tree", async () => {
    const fake = fakeSpawn({ codex: () => ok("NO_FINDINGS"), kimi: () => ok("NO_FINDINGS") }, ["codex", "kimi"]);
    await runCouncil({ cwd: repo, spawn: fake.spawn, stateDir: state.stateDir, members: ["codex", "kimi"] });
    for (const call of fake.reviewCalls) expect(call.cwd).not.toBe(repo);
  });

  it("runs fewer than two members as ran false and spawns nothing", async () => {
    const single = fakeSpawn({ codex: () => ok("NO_FINDINGS") });
    const one = await runCouncil({ cwd: repo, spawn: single.spawn, stateDir: state.stateDir, members: ["codex"] });
    expect(one.ran).toBe(false);
    expect(one.note).toContain("fewer than two");
    expect(single.calls).toEqual([]);

    const missing = fakeSpawn({ codex: () => ok("NO_FINDINGS") }, ["codex"]);
    const two = await runCouncil({ cwd: repo, spawn: missing.spawn, stateDir: state.stateDir });
    expect(two.ran).toBe(false);
    expect(two.members.filter((entry) => entry.status === "skipped").map((entry) => entry.reason)).toEqual(["not installed", "not installed"]);
    expect(missing.reviewCalls).toEqual([]);
  });

  it("does not run on an empty diff", async () => {
    git(repo, "checkout", "-q", "--", "src/a.ts");
    const fake = fakeSpawn({ codex: () => ok("x"), kimi: () => ok("x") });
    const run = await runCouncil({ cwd: repo, spawn: fake.spawn, stateDir: state.stateDir });
    expect(run.ran).toBe(false);
    expect(run.note).toContain("empty diff");
    expect(fake.calls).toEqual([]);
  });

  it("marks a timed out member failed while the others finish", async () => {
    const fake = fakeSpawn({
      codex: () => "hang",
      kimi: () => ok(finding("Kimi issue")),
      agy: () => ok(JSON.stringify({ result: "NO_FINDINGS" })),
    });
    const run = await runCouncil({ cwd: repo, spawn: fake.spawn, stateDir: state.stateDir, timeoutMs: 150 });
    const byName = Object.fromEntries(run.members.map((entry) => [entry.member, entry]));
    expect(byName.codex.status).toBe("failed");
    expect(byName.codex.reason).toContain("timed out");
    expect(byName.kimi.status).toBe("done");
    expect(byName.antigravity.status).toBe("done");
    expect(fake.reviewCalls.find((call) => call.argv[0] === "codex")?.killed).toBe(true);
    expect(run.ran).toBe(true);
    expect(worktreesLeft()).toEqual([]);
  });

  it("marks a crashing or malformed member failed without blocking", async () => {
    const fake = fakeSpawn({
      codex: () => ({ exitCode: 1, stdout: "", stderr: "auth required" }),
      kimi: () => ok("{broken"),
      agy: () => ok(JSON.stringify({ result: "NO_FINDINGS" })),
    });
    const run = await runCouncil({ cwd: repo, spawn: fake.spawn, stateDir: state.stateDir });
    expect(run.members.map((entry) => entry.status)).toEqual(["failed", "failed", "done"]);
    expect(run.members[0].reason).toContain("auth required");
    expect(worktreesLeft()).toEqual([]);
  });

  it("removes the worktree when the spawn throws", async () => {
    const fake = fakeSpawn({ kimi: () => ok("NO_FINDINGS"), agy: () => ok("{\"result\":\"NO_FINDINGS\"}"), codex: () => ok("NO_FINDINGS") });
    const spawn: typeof fake.spawn = (argv, options) => {
      if (argv[0] === "kimi" && argv[1] !== "--version") throw new Error("boom");
      return fake.spawn(argv, options);
    };
    const run = await runCouncil({ cwd: repo, spawn, stateDir: state.stateDir });
    const kimi = run.members.find((entry) => entry.member === "kimi");
    expect(kimi?.status).toBe("failed");
    expect(kimi?.reason).toContain("boom");
    expect(worktreesLeft()).toEqual([]);
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("excludes the implementer client", async () => {
    const fake = fakeSpawn({ codex: () => ok("NO_FINDINGS"), kimi: () => ok("NO_FINDINGS"), agy: () => ok("{\"result\":\"NO_FINDINGS\"}") });
    const run = await runCouncil({ cwd: repo, spawn: fake.spawn, stateDir: state.stateDir, exclude: ["kimi"] });
    expect(run.members.map((entry) => entry.member)).toEqual(["codex", "antigravity"]);
    expect(fake.calls.some((call) => call.argv[0] === "kimi")).toBe(false);
  });

  it("does not run when the exclusion leaves a single member", async () => {
    const fake = fakeSpawn({ codex: () => ok("NO_FINDINGS"), kimi: () => ok("NO_FINDINGS") });
    const run = await runCouncil({ cwd: repo, spawn: fake.spawn, stateDir: state.stateDir, members: ["codex", "kimi"], exclude: ["codex"] });
    expect(run.ran).toBe(false);
    expect(fake.calls).toEqual([]);
  });

  it("skips members whose client is not available", async () => {
    const fake = fakeSpawn({ codex: () => ok("NO_FINDINGS"), kimi: () => ok("NO_FINDINGS"), agy: () => ok("{\"result\":\"NO_FINDINGS\"}") });
    const run = await runCouncil({ cwd: repo, spawn: fake.spawn, stateDir: state.stateDir, availableClients: ["codex", "agy"] });
    const kimi = run.members.find((entry) => entry.member === "kimi");
    expect(kimi?.status).toBe("skipped");
    expect(kimi?.reason).toBe("client not available");
    expect(run.members.filter((entry) => entry.status === "done").map((entry) => entry.member).sort()).toEqual(["antigravity", "codex"]);
    expect(fake.calls.some((call) => call.argv[0] === "kimi")).toBe(false);
  });

  it("kills members on abort", async () => {
    const fake = fakeSpawn({ codex: () => "hang", kimi: () => "hang" }, ["codex", "kimi"]);
    const controller = new AbortController();
    const pending = runCouncil({ cwd: repo, spawn: fake.spawn, stateDir: state.stateDir, members: ["codex", "kimi"], signal: controller.signal });
    setTimeout(() => controller.abort(), 300);
    const run = await pending;
    expect(run.members.map((entry) => entry.reason)).toEqual(["cancelled", "cancelled"]);
    expect(fake.reviewCalls.every((call) => call.killed)).toBe(true);
    expect(worktreesLeft()).toEqual([]);
  });

  it("keeps secret untracked files out of the prompt given to members", async () => {
    writeIn(repo, ".env", "TOKEN=hunter2\n");
    const seen: string[] = [];
    const fake = fakeSpawn({
      codex: (call) => {
        seen.push(call.cwd);
        return ok("NO_FINDINGS");
      },
      kimi: () => ok("NO_FINDINGS"),
    });
    const run = await runCouncil({ cwd: repo, spawn: fake.spawn, stateDir: state.stateDir, members: ["codex", "kimi"] });
    expect(run.note).toContain("untracked file");
    expect(seen).toHaveLength(1);
  });
});
