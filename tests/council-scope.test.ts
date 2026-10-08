import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRepoLock, reviewRoot, sweepStale } from "../src/council/scope.js";

setDefaultTimeout(30000);

let state: string;

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "council-scope-"));
});

afterEach(() => {
  rmSync(state, { recursive: true, force: true });
});

describe("council stale sweep", () => {
  it("removes only entries older than the age", () => {
    const root = reviewRoot(state);
    mkdirSync(join(root, "old"), { recursive: true });
    mkdirSync(join(root, "fresh"), { recursive: true });
    const old = new Date(Date.now() - 5 * 60 * 60 * 1000);
    utimesSync(join(root, "old"), old, old);
    const swept = sweepStale(state, 2 * 60 * 60 * 1000);
    expect(swept).toEqual([join(root, "old")]);
    expect(existsSync(join(root, "old"))).toBe(false);
    expect(existsSync(join(root, "fresh"))).toBe(true);
  });
});

describe("council repo lock", () => {
  it("allows one holder per repository", () => {
    const first = acquireRepoLock(state, "/repo/a");
    expect(first).toBeDefined();
    expect(acquireRepoLock(state, "/repo/a")).toBeUndefined();
    const other = acquireRepoLock(state, "/repo/b");
    expect(other).toBeDefined();
    first?.release();
    const again = acquireRepoLock(state, "/repo/a");
    expect(again).toBeDefined();
    again?.release();
    other?.release();
  });

  it("takes over a lock whose owner is gone", () => {
    const lockDir = join(state, "council-locks");
    mkdirSync(lockDir, { recursive: true });
    const held = acquireRepoLock(state, "/repo/x");
    held?.release();
    const path = join(lockDir, `${createHash("sha1").update("/repo/x").digest("hex").slice(0, 20)}.lock`);
    writeFileSync(path, JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
    const taken = acquireRepoLock(state, "/repo/x");
    expect(taken).toBeDefined();
    taken?.release();
  });
});

function lockPath(repo: string): string {
  return join(state, "council-locks", `${createHash("sha1").update(repo).digest("hex").slice(0, 20)}.lock`);
}

async function contend(repo: string, contenders: number, holdMs: number): Promise<string[]> {
  const results = join(state, `results-${Math.random().toString(16).slice(2)}`);
  writeFileSync(results, "");
  const startAt = Date.now() + 1200;
  const children = Array.from({ length: contenders }, () => spawn(process.execPath, ["run", join(import.meta.dir, "fixtures/council-lock-child.ts"), state, repo, results, String(startAt), String(holdMs)], { stdio: "ignore", env: { ...process.env } }));
  await Promise.all(children.map((child) => new Promise<void>((resolve) => child.on("exit", () => resolve()))));
  return readFileSync(results, "utf8").split("\n").filter(Boolean);
}

describe("council repo lock contention", () => {
  it("lets exactly one of many concurrent processes win a free lock", async () => {
    for (let round = 0; round < 4; round++) {
      const outcomes = await contend(`/repo/free-${round}`, 6, 600);
      expect(outcomes.filter((entry) => entry === "won")).toHaveLength(1);
      expect(outcomes).toHaveLength(6);
    }
  }, 60000);

  it("lets exactly one of many concurrent processes take over a stale lock", async () => {
    for (let round = 0; round < 8; round++) {
      const repo = `/repo/stale-${round}`;
      mkdirSync(join(state, "council-locks"), { recursive: true });
      writeFileSync(lockPath(repo), JSON.stringify({ pid: 2 ** 22 + 777 + round, at: Date.now() }));
      const outcomes = await contend(repo, 6, 600);
      expect(outcomes.filter((entry) => entry === "won")).toHaveLength(1);
      expect(outcomes).toHaveLength(6);
    }
  }, 120000);

  it("re-reads the lock under the guard so a takeover cannot remove a winner's fresh lock", () => {
    const repo = "/repo/interleave";
    mkdirSync(join(state, "council-locks"), { recursive: true });
    writeFileSync(lockPath(repo), JSON.stringify({ pid: 2 ** 22 + 99, at: Date.now() }));
    let winner: ReturnType<typeof acquireRepoLock>;
    const loser = acquireRepoLock(state, repo, undefined, {
      afterStaleRead: () => {
        winner = acquireRepoLock(state, repo);
      },
    });
    expect(winner).toBeDefined();
    expect(loser).toBeUndefined();
    expect(JSON.parse(readFileSync(lockPath(repo), "utf8")).pid).toBe(process.pid);
    winner?.release();
  });

  it("never exposes an empty or partial lock file", () => {
    const lock = acquireRepoLock(state, "/repo/content");
    const holder = JSON.parse(readFileSync(lockPath("/repo/content"), "utf8"));
    expect(holder.pid).toBe(process.pid);
    expect(typeof holder.at).toBe("number");
    lock?.release();
    expect(existsSync(lockPath("/repo/content"))).toBe(false);
  });

  it("never lets a reader see the lock without its content while locks are created", async () => {
    const repo = "/repo/watch";
    const out = join(state, "watch-out");
    const endAt = Date.now() + 2500;
    const watcher = spawn(process.execPath, ["run", join(import.meta.dir, "fixtures/council-lock-watch.ts"), lockPath(repo), out, String(endAt)], { stdio: "ignore", env: { ...process.env } });
    const exited = new Promise<void>((resolve) => watcher.on("exit", () => resolve()));
    while (!existsSync(out)) await new Promise((resolve) => setTimeout(resolve, 20));
    while (Date.now() < endAt - 100) {
      const lock = acquireRepoLock(state, repo);
      lock?.release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await exited;
    const report = JSON.parse(readFileSync(out, "utf8"));
    expect(report.seen).toBeGreaterThan(0);
    expect(report.bad).toBe(0);
  }, 30000);

  it("releases only its own lock", () => {
    const repo = "/repo/own";
    const first = acquireRepoLock(state, repo);
    expect(first).toBeDefined();
    rmSync(lockPath(repo), { force: true });
    const second = acquireRepoLock(state, repo);
    expect(second).toBeDefined();
    first?.release();
    expect(existsSync(lockPath(repo))).toBe(true);
    second?.release();
    expect(existsSync(lockPath(repo))).toBe(false);
  });

  it("clears a stale guard file left by a dead taker", () => {
    const repo = "/repo/guard";
    mkdirSync(join(state, "council-locks"), { recursive: true });
    const name = createHash("sha1").update(repo).digest("hex").slice(0, 20);
    writeFileSync(lockPath(repo), JSON.stringify({ pid: 2 ** 22 + 5, at: Date.now() }));
    const guard = join(state, "council-locks", `${name}.guard`);
    writeFileSync(guard, "");
    const past = new Date(Date.now() - 60_000);
    utimesSync(guard, past, past);
    const taken = acquireRepoLock(state, repo);
    expect(taken).toBeDefined();
    taken?.release();
  });
});
