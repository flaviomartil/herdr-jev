import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireFileLock, claimFence, releaseFence, withFileLock } from "../src/herdr/file-lock.js";
import { claimHerdrSpawn, releaseHerdrSpawn } from "../src/herdr/reservation.js";
import { createTestStateDir } from "./helpers.js";

let sandbox = "";
let testState: { stateDir: string; cleanup: () => void };

beforeEach(() => {
  testState = createTestStateDir();
  sandbox = mkdtempSync(join(tmpdir(), "herdr-file-lock-"));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
  testState.cleanup();
});

describe("file-lock", () => {
  it("serializes wx contention and releases via nonce guard", async () => {
    const lockPath = join(sandbox, "registry.json.lock");
    const order: string[] = [];

    const first = withFileLock(lockPath, async () => {
      order.push("first-enter");
      await new Promise((r) => setTimeout(r, 60));
      order.push("first-exit");
    });

    await new Promise((r) => setTimeout(r, 15));
    const second = withFileLock(lockPath, async () => {
      order.push("second-enter");
      order.push("second-exit");
    }, { pollMs: 10, timeoutMs: 2000 });

    await Promise.all([first, second]);
    expect(order).toEqual(["first-enter", "first-exit", "second-enter", "second-exit"]);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("times out when held past timeoutMs", async () => {
    const lockPath = join(sandbox, "held.lock");
    const handle = await acquireFileLock(lockPath, { pid: 12345, hostname: "local-a", isPidAlive: () => "alive" });
    try {
      await expect(
        acquireFileLock(lockPath, {
          pid: 12346,
          hostname: "local-a",
          isPidAlive: () => "alive",
          timeoutMs: 60,
          pollMs: 15,
        }),
      ).rejects.toThrow("file lock timeout");
    } finally {
      handle.release();
    }
  });

  it("never unlinks a lock whose nonce was replaced by another owner", async () => {
    const lockPath = join(sandbox, "nonce.lock");
    await withFileLock(lockPath, () => {
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: 999999, hostname: "host-a", nonce: "foreign-nonce", createdAt: Date.now() }),
      );
    });
    expect(existsSync(lockPath)).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, "utf8")).nonce).toBe("foreign-nonce");
  });

  it("reclaims stale lock ONLY on same hostname and ESRCH", async () => {
    const lockPath = join(sandbox, "esrch.lock");
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 44444, hostname: "host-a", nonce: "dead-nonce", createdAt: 1 }),
    );
    const handle = await acquireFileLock(lockPath, {
      pid: 55555,
      hostname: "host-a",
      isPidAlive: (pid) => (pid === 44444 ? "esrch" : "alive"),
      timeoutMs: 200,
    });
    try {
      expect(handle.pid).toBe(55555);
      const parsed = JSON.parse(readFileSync(lockPath, "utf8"));
      expect(parsed.pid).toBe(55555);
      expect(parsed.nonce).toBe(handle.nonce);
    } finally {
      handle.release();
    }
    expect(existsSync(lockPath)).toBe(false);
  });

  it("refuses reclaim on EPERM or remote hostname even if lock is old", async () => {
    const epermLock = join(sandbox, "eperm.lock");
    writeFileSync(
      epermLock,
      JSON.stringify({ pid: 1111, hostname: "host-a", nonce: "root-owned", createdAt: 1 }),
    );
    await expect(
      acquireFileLock(epermLock, {
        pid: 2222,
        hostname: "host-a",
        isPidAlive: () => "eperm",
        timeoutMs: 60,
        pollMs: 15,
      }),
    ).rejects.toThrow("file lock timeout");
    expect(JSON.parse(readFileSync(epermLock, "utf8")).nonce).toBe("root-owned");

    const remoteLock = join(sandbox, "remote.lock");
    writeFileSync(
      remoteLock,
      JSON.stringify({ pid: 1111, hostname: "remote-box", nonce: "remote-nonce", createdAt: 1 }),
    );
    await expect(
      acquireFileLock(remoteLock, {
        pid: 2222,
        hostname: "host-a",
        isPidAlive: () => "esrch",
        timeoutMs: 60,
        pollMs: 15,
      }),
    ).rejects.toThrow("file lock timeout");
    expect(JSON.parse(readFileSync(remoteLock, "utf8")).nonce).toBe("remote-nonce");
  });

  it("supports single-shot claimFence / releaseFence and claimHerdrSpawn / releaseHerdrSpawn", () => {
    const fencePath = join(sandbox, "spawn.fence");
    const first = claimFence(fencePath, { pid: 100, hostname: "h1", isPidAlive: () => "alive" });
    expect(() => claimFence(fencePath, { pid: 101, hostname: "h1", isPidAlive: () => "alive" })).toThrow();
    expect(releaseFence(fencePath, "wrong-nonce")).toBe(false);
    expect(existsSync(fencePath)).toBe(true);
    expect(releaseFence(fencePath, first.nonce)).toBe(true);
    expect(existsSync(fencePath)).toBe(false);

    claimHerdrSpawn("spawn:peer-a");
    expect(() => claimHerdrSpawn("spawn:peer-a")).toThrow();
    releaseHerdrSpawn("spawn:peer-a");
    claimHerdrSpawn("spawn:peer-a");
    releaseHerdrSpawn("spawn:peer-a");
  });

  it("serializes concurrent stale-lock reclaim so second waiter never unlinks first waiter's live lock", async () => {
    const lockPath = join(sandbox, "race.lock");
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 90001, hostname: "host-a", nonce: "dead-race", createdAt: 1 }),
    );
    const alivePids = new Set<number>([1001, 1002]);
    let insideFirst = false;
    let overlapObserved = false;

    const first = withFileLock(
      lockPath,
      async () => {
        insideFirst = true;
        await new Promise((r) => setTimeout(r, 80));
        expect(existsSync(lockPath)).toBe(true);
        expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(1001);
        insideFirst = false;
      },
      { pid: 1001, hostname: "host-a", isPidAlive: (p) => (alivePids.has(p) ? "alive" : "esrch"), pollMs: 10 },
    );

    const second = withFileLock(
      lockPath,
      async () => {
        if (insideFirst) overlapObserved = true;
      },
      { pid: 1002, hostname: "host-a", isPidAlive: (p) => (alivePids.has(p) ? "alive" : "esrch"), pollMs: 10 },
    );

    await Promise.all([first, second]);
    expect(overlapObserved).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(`${lockPath}.reclaim`)).toBe(false);
  });

  it("recovers 0-byte and corrupt lock files after corruptGraceMs", async () => {
    const emptyLock = join(sandbox, "empty.lock");
    writeFileSync(emptyLock, "");
    await expect(
      acquireFileLock(emptyLock, {
        pid: 7001,
        hostname: "host-a",
        corruptGraceMs: 5000,
        timeoutMs: 60,
        pollMs: 15,
      }),
    ).rejects.toThrow("file lock timeout");

    const old = new Date(Date.now() - 200);
    utimesSync(emptyLock, old, old);
    const recoveredEmpty = await acquireFileLock(emptyLock, {
      pid: 7002,
      hostname: "host-a",
      corruptGraceMs: 50,
      timeoutMs: 200,
    });
    recoveredEmpty.release();
    expect(existsSync(emptyLock)).toBe(false);

    const corruptLock = join(sandbox, "corrupt.lock");
    writeFileSync(corruptLock, "{truncated");
    utimesSync(corruptLock, old, old);
    const recoveredCorrupt = await acquireFileLock(corruptLock, {
      pid: 7003,
      hostname: "host-a",
      corruptGraceMs: 50,
      timeoutMs: 200,
    });
    recoveredCorrupt.release();
    expect(existsSync(corruptLock)).toBe(false);
  });
});
