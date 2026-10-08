import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRepoLock, reviewRoot, sweepStale } from "../src/council/scope.js";

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
    const path = join(lockDir, `${require("node:crypto").createHash("sha1").update("/repo/x").digest("hex").slice(0, 20)}.lock`);
    require("node:fs").writeFileSync(path, JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
    const taken = acquireRepoLock(state, "/repo/x");
    expect(taken).toBeDefined();
    taken?.release();
  });
});
