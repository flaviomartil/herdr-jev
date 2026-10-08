import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { runCouncil } from "../src/council/run.js";
import { fakeSpawn, git, gitRaw, makeRepo, ok, writeIn } from "./council-helpers.js";
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
const agyEmpty = () => ok(JSON.stringify({ result: "NO_FINDINGS" }));

function worktreesLeft(): string[] {
  const dir = join(state.stateDir, "council");
  return existsSync(dir) ? readdirSync(dir) : [];
}

async function until(check: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end && !check()) await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("runCouncil", () => {
  it("runs the members in parallel and collects findings", async () => {
    const fake = fakeSpawn({
      codex: () => ok(`- [P1] Codex issue — /x:1-1\n  detail`),
      kimi: () => ok(finding("Kimi issue")),
      agy: agyEmpty,
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

  it("probes versions from the state directory, never from the repository", async () => {
    const fake = fakeSpawn({ codex: () => ok("NO_FINDINGS"), kimi: () => ok("NO_FINDINGS") });
    await runCouncil({ cwd: repo, spawn: fake.spawn, stateDir: state.stateDir, members: ["codex", "kimi"] });
    expect(fake.probeCalls).toHaveLength(2);
    for (const call of fake.probeCalls) expect(call.cwd).toBe(state.stateDir);
    for (const call of fake.reviewCalls) expect(call.cwd).not.toBe(repo);
  });

  it("treats a wrong version signature as not installed", async () => {
    const fake = fakeSpawn({ codex: () => ok("NO_FINDINGS"), kimi: () => ok("NO_FINDINGS"), agy: agyEmpty }, { versions: { codex: "Tesseract 5.0\n", kimi: "kimi 2.1.1\n" } });
    const run = await runCouncil({ cwd: repo, spawn: fake.spawn, stateDir: state.stateDir });
    expect(run.ran).toBe(false);
    expect(run.members.map((entry) => [entry.member, entry.reason])).toEqual([
      ["codex", "not installed"],
      ["kimi", "not installed"],
      ["antigravity", "fewer than two runnable members"],
    ]);
    expect(fake.reviewCalls).toEqual([]);
  });

  it("writes the prompt file with the diff, mode 0600, and keeps secrets out of the prompt and the directory", async () => {
    writeIn(repo, ".env", "TOKEN=hunter2\n");
    writeIn(repo, "keys/id_rsa", "RSADATA\n");
    writeIn(repo, "src/auth/credentials.ts", "export const c = 1;\n");
    let prompt = "";
    let mode = 0;
    let listing = "";
    let status = "";
    const fake = fakeSpawn({
      codex: () => ok("NO_FINDINGS"),
      kimi: (call) => {
        const file = join(call.cwd, ".council-prompt.md");
        prompt = readFileSync(file, "utf8");
        mode = statSync(file).mode & 0o777;
        listing = readdirSync(call.cwd, { recursive: true }).map(String).filter((entry) => !entry.startsWith(".git")).join("\n");
        status = gitRaw(call.cwd, "status", "--porcelain");
        return ok("NO_FINDINGS");
      },
    });
    const run = await runCouncil({ cwd: repo, spawn: fake.spawn, stateDir: state.stateDir, members: ["codex", "kimi"] });
    expect(prompt).toContain("+export const a = 2;");
    expect(prompt).toContain("src/auth/credentials.ts");
    expect(prompt).not.toContain("hunter2");
    expect(prompt).not.toContain("RSADATA");
    expect(mode).toBe(0o600);
    expect(listing).not.toContain(".env");
    expect(listing).not.toContain("id_rsa");
    expect(status).not.toContain(".env");
    expect(run.skippedPaths).toEqual([".env", "keys/id_rsa"]);
    expect(run.note).toContain("2 sensitive paths left out");
  });

  it("runs fewer than two members as ran false and spawns nothing", async () => {
    const single = fakeSpawn({ codex: () => ok("NO_FINDINGS") });
    const one = await runCouncil({ cwd: repo, spawn: single.spawn, stateDir: state.stateDir, members: ["codex"] });
    expect(one.ran).toBe(false);
    expect(one.note).toContain("fewer than two");
    expect(one.members.map((entry) => entry.member)).toEqual(["codex"]);
    expect(single.calls).toEqual([]);

    const missing = fakeSpawn({ codex: () => ok("NO_FINDINGS") });
    const two = await runCouncil({ cwd: repo, spawn: missing.spawn, stateDir: state.stateDir });
    expect(two.ran).toBe(false);
    expect(two.members.map((entry) => [entry.member, entry.status, entry.reason])).toEqual([
      ["codex", "skipped", "fewer than two runnable members"],
      ["kimi", "skipped", "not installed"],
      ["antigravity", "skipped", "not installed"],
    ]);
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

  it("rejects an invalid base without spawning", async () => {
    const fake = fakeSpawn({ codex: () => ok("x"), kimi: () => ok("x") });
    const run = await runCouncil({ cwd: repo, base: "--output=/tmp/x", spawn: fake.spawn, stateDir: state.stateDir });
    expect(run.ran).toBe(false);
    expect(run.note).toContain("invalid_base");
    expect(fake.calls).toEqual([]);
  });

  it("marks a timed out member failed while the others finish", async () => {
    const fake = fakeSpawn({ codex: () => "hang", kimi: () => ok(finding("Kimi issue")), agy: agyEmpty });
    const run = await runCouncil({ cwd: repo, spawn: fake.spawn, stateDir: state.stateDir, timeoutMs: 400 });
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
      agy: agyEmpty,
    });
    const run = await runCouncil({ cwd: repo, spawn: fake.spawn, stateDir: state.stateDir });
    expect(run.members.map((entry) => entry.status)).toEqual(["failed", "failed", "done"]);
    expect(run.members[0].reason).toContain("auth required");
    expect(worktreesLeft()).toEqual([]);
  });

  it("reports the capture cut in the member note", async () => {
    const fake = fakeSpawn({ codex: () => ({ exitCode: 0, stdout: "NO_FINDINGS", stderr: "", truncated: true }), kimi: () => ok("NO_FINDINGS") });
    const run = await runCouncil({ cwd: repo, spawn: fake.spawn, stateDir: state.stateDir, members: ["codex", "kimi"] });
    expect(run.members[0].note).toContain("cut at the capture limit");
    expect(run.members[1].note).toBeUndefined();
  });

  it("removes the directory when the spawn throws", async () => {
    const fake = fakeSpawn({ kimi: () => ok("NO_FINDINGS"), agy: agyEmpty, codex: () => ok("NO_FINDINGS") });
    const spawn: typeof fake.spawn = (argv, options) => {
      if (argv[0] === "kimi" && argv[1] !== "--version") throw new Error("boom");
      return fake.spawn(argv, options);
    };
    const run = await runCouncil({ cwd: repo, spawn, stateDir: state.stateDir });
    const kimi = run.members.find((entry) => entry.member === "kimi");
    expect(kimi?.status).toBe("failed");
    expect(kimi?.reason).toContain("boom");
    expect(worktreesLeft()).toEqual([]);
  });

  it("reports an excluded implementer as skipped and keeps the others", async () => {
    const fake = fakeSpawn({ codex: () => ok("NO_FINDINGS"), kimi: () => ok("NO_FINDINGS"), agy: agyEmpty });
    const run = await runCouncil({ cwd: repo, spawn: fake.spawn, stateDir: state.stateDir, exclude: ["kimi"] });
    expect(run.members.map((entry) => [entry.member, entry.status, entry.reason])).toEqual([
      ["codex", "done", undefined],
      ["kimi", "skipped", "excluded: implementer"],
      ["antigravity", "done", undefined],
    ]);
    expect(fake.calls.some((call) => call.argv[0] === "kimi")).toBe(false);
  });

  it("lists the remaining candidate when the exclusion leaves a single member", async () => {
    const fake = fakeSpawn({ codex: () => ok("NO_FINDINGS"), kimi: () => ok("NO_FINDINGS") });
    const run = await runCouncil({ cwd: repo, spawn: fake.spawn, stateDir: state.stateDir, members: ["codex", "kimi"], exclude: ["codex"] });
    expect(run.ran).toBe(false);
    expect(run.members.map((entry) => [entry.member, entry.status, entry.reason])).toEqual([
      ["codex", "skipped", "excluded: implementer"],
      ["kimi", "skipped", "fewer than two runnable members"],
    ]);
    expect(fake.calls).toEqual([]);
  });

  it("skips members whose client is not available", async () => {
    const fake = fakeSpawn({ codex: () => ok("NO_FINDINGS"), kimi: () => ok("NO_FINDINGS"), agy: agyEmpty });
    const run = await runCouncil({ cwd: repo, spawn: fake.spawn, stateDir: state.stateDir, availableClients: ["codex", "agy"] });
    const kimi = run.members.find((entry) => entry.member === "kimi");
    expect(kimi?.status).toBe("skipped");
    expect(kimi?.reason).toBe("client not available");
    expect(run.members.filter((entry) => entry.status === "done").map((entry) => entry.member).sort()).toEqual(["antigravity", "codex"]);
    expect(fake.calls.some((call) => call.argv[0] === "kimi")).toBe(false);
  });

  it("cuts the prompt diff past the cap and says so in the run note", async () => {
    writeIn(repo, "src/large.ts", `${"const line = 1;\n".repeat(25_000)}`);
    let prompt = "";
    const fake = fakeSpawn({
      codex: () => ok("NO_FINDINGS"),
      kimi: (call) => {
        prompt = readFileSync(join(call.cwd, ".council-prompt.md"), "utf8");
        return ok("NO_FINDINGS");
      },
    });
    const run = await runCouncil({ cwd: repo, spawn: fake.spawn, stateDir: state.stateDir, members: ["codex", "kimi"] });
    expect(prompt).toContain("[council: diff cut at 300000");
    expect(prompt.length).toBeLessThan(310_000);
    expect(run.note).toContain("prompt diff truncated");
  });

  it("leaves a large binary change from pushing source out of the prompt", async () => {
    writeIn(repo, "blob.bin", Array.from({ length: 400_000 }, (_, i) => String.fromCharCode(33 + ((i * 31) % 90))).join(""));
    let prompt = "";
    const fake = fakeSpawn({
      codex: () => ok("NO_FINDINGS"),
      kimi: (call) => {
        prompt = readFileSync(join(call.cwd, ".council-prompt.md"), "utf8");
        return ok("NO_FINDINGS");
      },
    });
    await runCouncil({ cwd: repo, spawn: fake.spawn, stateDir: state.stateDir, members: ["codex", "kimi"] });
    expect(prompt).toContain("+export const a = 2;");
  });

  it("runs once per repository at a time", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = fakeSpawn({
      codex: async () => {
        await gate;
        return ok("NO_FINDINGS");
      },
      kimi: () => ok("NO_FINDINGS"),
    });
    const first = runCouncil({ cwd: repo, spawn: fake.spawn, stateDir: state.stateDir, members: ["codex", "kimi"] });
    await until(() => fake.reviewCalls.some((call) => call.argv[0] === "codex"));
    const second = await runCouncil({ cwd: repo, spawn: fake.spawn, stateDir: state.stateDir, members: ["codex", "kimi"] });
    expect(second.ran).toBe(false);
    expect(second.note).toContain("already in progress");
    release?.();
    const done = await first;
    expect(done.ran).toBe(true);
    const third = await runCouncil({ cwd: repo, spawn: fake.spawn, stateDir: state.stateDir, members: ["codex", "kimi"] });
    expect(third.ran).toBe(true);
  });

  it("sweeps stale review directories at the start of a run", async () => {
    const stale = join(state.stateDir, "council", "old-run");
    writeIn(state.stateDir, "council/old-run/file", "x");
    const past = new Date(Date.now() - 10 * 60 * 60 * 1000);
    require("node:fs").utimesSync(stale, past, past);
    writeIn(state.stateDir, "council/fresh-run/file", "x");
    const fake = fakeSpawn({ codex: () => ok("NO_FINDINGS"), kimi: () => ok("NO_FINDINGS") });
    await runCouncil({ cwd: repo, spawn: fake.spawn, stateDir: state.stateDir, members: ["codex", "kimi"] });
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(state.stateDir, "council", "fresh-run"))).toBe(true);
  });
});

describe("runCouncil cancellation", () => {
  it("kills running members on abort", async () => {
    const fake = fakeSpawn({ codex: () => "hang", kimi: () => "hang" });
    const controller = new AbortController();
    const pending = runCouncil({ cwd: repo, spawn: fake.spawn, stateDir: state.stateDir, members: ["codex", "kimi"], signal: controller.signal });
    await until(() => fake.reviewCalls.length === 2);
    expect(fake.reviewCalls).toHaveLength(2);
    controller.abort();
    const run = await pending;
    expect(run.members.map((entry) => entry.reason)).toEqual(["cancelled", "cancelled"]);
    expect(fake.reviewCalls.every((call) => call.killed)).toBe(true);
    expect(worktreesLeft()).toEqual([]);
  });

  it("does not spawn a member when the abort lands before its spawn", async () => {
    const controller = new AbortController();
    const fake = fakeSpawn({ codex: () => ok("NO_FINDINGS"), kimi: () => ok("NO_FINDINGS") }, { onProbe: () => setTimeout(() => controller.abort(), 0) });
    const run = await runCouncil({ cwd: repo, spawn: fake.spawn, stateDir: state.stateDir, members: ["codex", "kimi"], signal: controller.signal });
    expect(fake.probeCalls).toHaveLength(2);
    expect(fake.reviewCalls).toEqual([]);
    expect(run.members.map((entry) => entry.reason)).toEqual(["cancelled", "cancelled"]);
    expect(worktreesLeft()).toEqual([]);
  });

  it("does not report an abort during the install check as not installed", async () => {
    const controller = new AbortController();
    const fake = fakeSpawn({ codex: () => ok("NO_FINDINGS"), kimi: () => ok("NO_FINDINGS") }, { hangProbe: ["codex", "kimi"] });
    const pending = runCouncil({ cwd: repo, spawn: fake.spawn, stateDir: state.stateDir, members: ["codex", "kimi"], signal: controller.signal });
    await until(() => fake.probeCalls.length === 2);
    controller.abort();
    const run = await pending;
    expect(run.ran).toBe(false);
    expect(run.note).toContain("cancelled");
    expect(run.members.map((entry) => entry.reason)).toEqual(["cancelled", "cancelled"]);
    expect(fake.reviewCalls).toEqual([]);
  });

  it("does not start when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = fakeSpawn({ codex: () => ok("NO_FINDINGS"), kimi: () => ok("NO_FINDINGS") });
    const run = await runCouncil({ cwd: repo, spawn: fake.spawn, stateDir: state.stateDir, signal: controller.signal });
    expect(run.ran).toBe(false);
    expect(fake.calls).toEqual([]);
  });
});
