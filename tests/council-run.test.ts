import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { runCouncil } from "../src/council/run.js";
import { councilScope } from "../src/council/scope.js";
import { defaultSpawn } from "../src/council/spawn.js";
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

describe("runCouncil limits", () => {
  it("clamps the member timeout to thirty minutes and bounds each member by a lifetime", async () => {
    const fake = fakeSpawn({ codex: () => ok("NO_FINDINGS"), kimi: () => ok("NO_FINDINGS") });
    await runCouncil({ cwd: repo, spawn: fake.spawn, stateDir: state.stateDir, members: ["codex", "kimi"], timeoutMs: 10 * 60 * 60 * 1000, timeoutCommand: "/usr/bin/timeout" });
    for (const call of fake.reviewCalls) {
      expect(call.lifetimeMs).toBe(30 * 60 * 1000 + 5000);
      expect(call.timeoutCommand).toBe("/usr/bin/timeout");
    }
    for (const call of fake.probeCalls) expect(call.lifetimeMs).toBe(15000);
  });

  it("says in the run note when the timeout command is missing", async () => {
    const fake = fakeSpawn({ codex: () => ok("NO_FINDINGS"), kimi: () => ok("NO_FINDINGS") });
    const run = await runCouncil({ cwd: repo, spawn: fake.spawn, stateDir: state.stateDir, members: ["codex", "kimi"], timeoutCommand: null });
    expect(run.ran).toBe(true);
    expect(run.note).toContain("timeout command was not found");
    const bounded = await runCouncil({ cwd: repo, spawn: fake.spawn, stateDir: state.stateDir, members: ["codex", "kimi"], timeoutCommand: "/usr/bin/timeout" });
    expect(bounded.note ?? "").not.toContain("timeout command");
  });

  it("never runs a program named by the global git config inside the review directory", async () => {
    const seen = join(state.stateDir, "fsmonitor-cwd");
    const script = join(state.stateDir, "fsmonitor.sh");
    require("node:fs").writeFileSync(script, `#!/bin/sh\npwd >> ${seen}\nexit 0\n`, { mode: 0o755 });
    const config = join(state.stateDir, "global-gitconfig-2");
    require("node:fs").writeFileSync(config, `[core]\n\tfsmonitor = ${script}\n`);
    const saved = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = config;
    try {
      const fake = fakeSpawn({ codex: () => ok("NO_FINDINGS"), kimi: () => ok("NO_FINDINGS") });
      await runCouncil({ cwd: repo, spawn: fake.spawn, stateDir: state.stateDir, members: ["codex", "kimi"] });
      const dirs = existsSync(seen) ? readFileSync(seen, "utf8").split("\n").filter(Boolean) : [];
      expect(dirs.some((entry) => entry.startsWith(join(state.stateDir, "council")))).toBe(false);
    } finally {
      process.env.GIT_CONFIG_GLOBAL = saved;
    }
  });

  it("works from a global git config that sets hooks, gpg signing and a template", async () => {
    const config = join(state.stateDir, "global-gitconfig");
    require("node:fs").writeFileSync(config, "[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /bin/false\n[core]\n\thooksPath = /nonexistent\n[clone]\n\tdefaultRemoteName = upstream\n");
    const saved = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = config;
    try {
      const fake = fakeSpawn({ codex: () => ok("NO_FINDINGS"), kimi: () => ok("NO_FINDINGS") });
      const run = await runCouncil({ cwd: repo, spawn: fake.spawn, stateDir: state.stateDir, members: ["codex", "kimi"] });
      expect(run.ran).toBe(true);
      expect(run.members.map((entry) => entry.status)).toEqual(["done", "done"]);
    } finally {
      process.env.GIT_CONFIG_GLOBAL = saved;
    }
  });
});

describe("runCouncil interrupts and timers", () => {
  it("reports a signal interrupt as cancelled", async () => {
    const noop = () => undefined;
    const others = process.listeners("SIGTERM");
    process.removeAllListeners("SIGTERM");
    process.on("SIGTERM", noop);
    try {
      const fake = fakeSpawn({ codex: () => "hang", kimi: () => "hang" });
      let started = 0;
      const spawn: typeof fake.spawn = (argv, options) => {
        if (argv[1] === "--version") return fake.spawn(argv, options);
        started += 1;
        return defaultSpawn(["sleep", "30"], options);
      };
      const pending = runCouncil({ cwd: repo, spawn, stateDir: state.stateDir, members: ["codex", "kimi"] });
      await until(() => started === 2);
      await new Promise((resolve) => setTimeout(resolve, 200));
      process.kill(process.pid, "SIGTERM");
      const run = await pending;
      expect(run.ran).toBe(false);
      expect(run.note).toBe("cancelled");
      expect(run.members.map((entry) => [entry.status, entry.reason])).toEqual([["skipped", "cancelled"], ["skipped", "cancelled"]]);
      await until(() => !councilScope.stopped);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off("SIGTERM", noop);
      for (const listener of others) process.on("SIGTERM", listener as NodeJS.SignalsListener);
    }
  });

  it("clears the settle timer after a timeout", async () => {
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const settleTimers = new Set<unknown>();
    const cleared = new Set<unknown>();
    globalThis.setTimeout = ((handler: unknown, delay?: number, ...rest: unknown[]) => {
      const timer = (realSet as any)(handler, delay, ...rest);
      if (delay === 4000) settleTimers.add(timer);
      return timer;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((timer: unknown) => {
      cleared.add(timer);
      return (realClear as any)(timer);
    }) as unknown as typeof clearTimeout;
    try {
      const fake = fakeSpawn({ codex: () => "hang", kimi: () => ok("NO_FINDINGS") });
      await runCouncil({ cwd: repo, spawn: fake.spawn, stateDir: state.stateDir, members: ["codex", "kimi"], timeoutMs: 300 });
    } finally {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    }
    expect(settleTimers.size).toBeGreaterThan(0);
    for (const timer of settleTimers) expect(cleared.has(timer)).toBe(true);
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
    expect(run.ran).toBe(false);
    expect(run.note).toBe("cancelled");
    expect(run.members.map((entry) => [entry.status, entry.reason])).toEqual([["skipped", "cancelled"], ["skipped", "cancelled"]]);
    expect(fake.reviewCalls.every((call) => call.killed)).toBe(true);
    expect(worktreesLeft()).toEqual([]);
  });

  it("does not spawn a member when the abort lands before its spawn", async () => {
    const controller = new AbortController();
    const fake = fakeSpawn({ codex: () => ok("NO_FINDINGS"), kimi: () => ok("NO_FINDINGS") }, { onProbe: () => setTimeout(() => controller.abort(), 0) });
    const run = await runCouncil({ cwd: repo, spawn: fake.spawn, stateDir: state.stateDir, members: ["codex", "kimi"], signal: controller.signal });
    expect(fake.probeCalls).toHaveLength(2);
    expect(fake.reviewCalls).toEqual([]);
    expect(run.ran).toBe(false);
    expect(run.members.map((entry) => [entry.status, entry.reason])).toEqual([["skipped", "cancelled"], ["skipped", "cancelled"]]);
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
    expect(run.note).toBe("cancelled");
    expect(run.members.map((entry) => [entry.status, entry.reason])).toEqual([["skipped", "cancelled"], ["skipped", "cancelled"]]);
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
