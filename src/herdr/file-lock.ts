import { randomBytes } from "node:crypto";
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { dirname } from "node:path";

export type PidLiveness = "alive" | "esrch" | "eperm";

export interface FileLockPayload {
  pid: number;
  hostname: string;
  nonce: string;
  createdAt: number;
}

export interface FileLockDeps {
  pid?: number;
  hostname?: string;
  isPidAlive?: (pid: number) => PidLiveness;
  now?: () => number;
  corruptGraceMs?: number;
}

export interface AcquireFileLockOptions extends FileLockDeps {
  timeoutMs?: number;
  pollMs?: number;
}

export interface FileLockHandle {
  lockPath: string;
  nonce: string;
  pid: number;
  hostname: string;
  createdAt: number;
  ino: number;
  release: () => void;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_MS = 25;
const DEFAULT_CORRUPT_GRACE_MS = 2_000;

export function defaultIsPidAlive(pid: number): PidLiveness {
  if (!Number.isInteger(pid) || pid <= 0) return "esrch";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "esrch";
    return "eperm";
  }
}

function parseLockPayload(raw: string): FileLockPayload | null {
  try {
    const parsed = JSON.parse(raw) as Partial<FileLockPayload>;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.pid !== "number" ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.hostname !== "string" ||
      !parsed.hostname ||
      typeof parsed.nonce !== "string" ||
      !parsed.nonce ||
      typeof parsed.createdAt !== "number" ||
      !Number.isFinite(parsed.createdAt)
    ) {
      return null;
    }
    return parsed as FileLockPayload;
  } catch {
    return null;
  }
}

function tryCreateExclusiveLock(lockPath: string, payload: FileLockPayload): { ok: true; ino: number } | { ok: false } {
  let fd: number;
  try {
    fd = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return { ok: false };
    throw error;
  }
  try {
    writeSync(fd, JSON.stringify(payload), 0, "utf8");
    const ino = fstatSync(fd).ino;
    return { ok: true, ino };
  } catch (error) {
    try {
      unlinkSync(lockPath);
    } catch {
    }
    throw error;
  } finally {
    try {
      closeSync(fd);
    } catch {
    }
  }
}

type LockStatus = "missing" | "stale" | "live";

function inspectLockStatus(
  targetPath: string,
  localHostname: string,
  isPidAlive: (pid: number) => PidLiveness,
  corruptGraceMs: number,
  now: () => number,
): LockStatus {
  let st: ReturnType<typeof statSync>;
  let raw: string;
  try {
    st = statSync(targetPath);
    raw = readFileSync(targetPath, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "live";
  }
  const payload = parseLockPayload(raw);
  if (!payload) {
    return now() - st.mtimeMs >= corruptGraceMs ? "stale" : "live";
  }
  if (payload.hostname !== localHostname) return "live";
  return isPidAlive(payload.pid) === "esrch" ? "stale" : "live";
}

function unlinkIfCorruptAndStale(
  targetPath: string,
  localHostname: string,
  isPidAlive: (pid: number) => PidLiveness,
  corruptGraceMs: number,
  now: () => number,
): boolean {
  let st: ReturnType<typeof statSync>;
  let raw: string;
  try {
    st = statSync(targetPath);
    raw = readFileSync(targetPath, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  const payload = parseLockPayload(raw);
  if (!payload) {
    if (now() - st.mtimeMs < corruptGraceMs) return false;
    try {
      const currentStat = statSync(targetPath);
      if (currentStat.ino !== st.ino) return false;
      unlinkSync(targetPath);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }
  if (payload.hostname !== localHostname || isPidAlive(payload.pid) !== "esrch") return false;
  try {
    const currentStat = statSync(targetPath);
    const currentPayload = parseLockPayload(readFileSync(targetPath, "utf8"));
    if (currentStat.ino !== st.ino || !currentPayload || currentPayload.nonce !== payload.nonce) return false;
    unlinkSync(targetPath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function tryReclaimStaleLock(
  lockPath: string,
  localPid: number,
  localHostname: string,
  isPidAlive: (pid: number) => PidLiveness,
  corruptGraceMs: number,
  now: () => number,
): boolean {
  const preCheck = inspectLockStatus(lockPath, localHostname, isPidAlive, corruptGraceMs, now);
  if (preCheck === "missing") return true;
  if (preCheck === "live") return false;

  const reclaimPath = `${lockPath}.reclaim`;
  const guardPayload: FileLockPayload = {
    pid: localPid,
    hostname: localHostname,
    nonce: randomBytes(16).toString("hex"),
    createdAt: now(),
  };

  let guard = tryCreateExclusiveLock(reclaimPath, guardPayload);
  if (!guard.ok) {
    if (!unlinkIfCorruptAndStale(reclaimPath, localHostname, isPidAlive, corruptGraceMs, now)) {
      return false;
    }
    guard = tryCreateExclusiveLock(reclaimPath, guardPayload);
    if (!guard.ok) return false;
  }

  try {
    const status = inspectLockStatus(lockPath, localHostname, isPidAlive, corruptGraceMs, now);
    if (status === "missing") return true;
    if (status === "live") return false;
    try {
      unlinkSync(lockPath);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  } finally {
    releaseFence(reclaimPath, guardPayload.nonce, guard.ino);
  }
}

export function releaseFence(lockPath: string, nonce: string, expectedIno?: number): boolean {
  try {
    if (expectedIno !== undefined) {
      const st = statSync(lockPath);
      if (st.ino !== expectedIno) return false;
    }
    const raw = readFileSync(lockPath, "utf8");
    const parsed = parseLockPayload(raw);
    if (!parsed || parsed.nonce !== nonce) return false;
    if (expectedIno !== undefined) {
      const stAfter = statSync(lockPath);
      if (stAfter.ino !== expectedIno) return false;
    }
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function makeHandle(
  lockPath: string,
  payload: FileLockPayload,
  ino: number,
): FileLockHandle {
  return {
    lockPath,
    nonce: payload.nonce,
    pid: payload.pid,
    hostname: payload.hostname,
    createdAt: payload.createdAt,
    ino,
    release: () => {
      releaseFence(lockPath, payload.nonce, ino);
    },
  };
}

export function claimFence(fencePath: string, deps: FileLockDeps = {}): FileLockHandle {
  mkdirSync(dirname(fencePath), { recursive: true, mode: 0o700 });
  const pid = deps.pid ?? process.pid;
  const hostname = deps.hostname ?? osHostname();
  const isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;
  const now = deps.now ?? Date.now;
  const corruptGraceMs = deps.corruptGraceMs ?? DEFAULT_CORRUPT_GRACE_MS;
  const nonce = randomBytes(16).toString("hex");

  const payload1: FileLockPayload = { pid, hostname, nonce, createdAt: now() };
  const first = tryCreateExclusiveLock(fencePath, payload1);
  if (first.ok) return makeHandle(fencePath, payload1, first.ino);

  if (tryReclaimStaleLock(fencePath, pid, hostname, isPidAlive, corruptGraceMs, now)) {
    const payload2: FileLockPayload = { pid, hostname, nonce, createdAt: now() };
    const second = tryCreateExclusiveLock(fencePath, payload2);
    if (second.ok) return makeHandle(fencePath, payload2, second.ino);
  }

  const err = new Error(`fence already held at ${fencePath}`) as NodeJS.ErrnoException;
  err.code = "EEXIST";
  throw err;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function acquireFileLock(
  lockPath: string,
  options: AcquireFileLockOptions = {},
): Promise<FileLockHandle> {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const pid = options.pid ?? process.pid;
  const hostname = options.hostname ?? osHostname();
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const now = options.now ?? Date.now;
  const corruptGraceMs = options.corruptGraceMs ?? DEFAULT_CORRUPT_GRACE_MS;
  const nonce = randomBytes(16).toString("hex");
  const deadline = now() + timeoutMs;

  for (;;) {
    const payload: FileLockPayload = { pid, hostname, nonce, createdAt: now() };
    const created = tryCreateExclusiveLock(lockPath, payload);
    if (created.ok) return makeHandle(lockPath, payload, created.ino);

    if (tryReclaimStaleLock(lockPath, pid, hostname, isPidAlive, corruptGraceMs, now)) {
      const retryPayload: FileLockPayload = { pid, hostname, nonce, createdAt: now() };
      const retried = tryCreateExclusiveLock(lockPath, retryPayload);
      if (retried.ok) return makeHandle(lockPath, retryPayload, retried.ino);
    }

    if (now() >= deadline) {
      const err = new Error(`file lock timeout: ${lockPath}`) as NodeJS.ErrnoException;
      err.code = "ETIMEDOUT";
      throw err;
    }
    await sleep(pollMs);
  }
}

export async function withFileLock<T>(
  lockPath: string,
  fn: () => T | Promise<T>,
  options?: AcquireFileLockOptions,
): Promise<T> {
  const handle = await acquireFileLock(lockPath, options);
  try {
    return await fn();
  } finally {
    handle.release();
  }
}
