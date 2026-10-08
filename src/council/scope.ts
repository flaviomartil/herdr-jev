import { createHash, randomBytes } from "node:crypto";
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { createHarnessProcessScope, registerProcessGuard, terminateHarnessProcesses } from "../harness/bridge.js";

export const councilScope = createHarnessProcessScope();

const trackedPaths = new Set<string>();
const SIGNAL_GRACE_MS = 1500;
export const STALE_AGE_MS = 2 * 60 * 60 * 1000;
const GUARD_STALE_MS = 10_000;

let unregisterGuard: (() => void) | undefined;
let lastInterruptAt = 0;

function removeTracked(): void {
  for (const path of trackedPaths) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      continue;
    }
  }
  trackedPaths.clear();
}

function install(): void {
  if (unregisterGuard) return;
  unregisterGuard = registerProcessGuard(councilScope, {
    graceMs: SIGNAL_GRACE_MS,
    cleanup: (willExit) => {
      lastInterruptAt = Date.now();
      removeTracked();
      if (!willExit) councilScope.stopped = false;
    },
  });
}

function uninstall(): void {
  unregisterGuard?.();
  unregisterGuard = undefined;
}

function settle(): void {
  if (councilScope.groups.size === 0 && trackedPaths.size === 0) uninstall();
}

export function councilInterruptedSince(startedAt: number): boolean {
  return councilScope.stopped || lastInterruptAt >= startedAt;
}

export function trackChild(child: ChildProcess): () => void {
  const pid = child.pid;
  if (pid === undefined) return () => undefined;
  councilScope.groups.set(pid, child);
  install();
  return () => {
    if (councilScope.groups.get(pid) === child) councilScope.groups.delete(pid);
    settle();
  };
}

export function trackPath(path: string): () => void {
  trackedPaths.add(path);
  install();
  return () => {
    trackedPaths.delete(path);
    settle();
  };
}

export async function terminateCouncilProcesses(graceMs = SIGNAL_GRACE_MS): Promise<void> {
  await terminateHarnessProcesses(councilScope, graceMs);
  councilScope.stopped = false;
}

export function reviewRoot(stateDir: string): string {
  return join(stateDir, "council");
}

function lockRoot(stateDir: string): string {
  return join(stateDir, "council-locks");
}

export function sweepStale(stateDir: string, maxAgeMs: number = STALE_AGE_MS): string[] {
  const swept: string[] = [];
  for (const root of [reviewRoot(stateDir), lockRoot(stateDir)]) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(root, entry);
      try {
        if (Date.now() - statSync(path).mtimeMs <= maxAgeMs) continue;
        rmSync(path, { recursive: true, force: true });
        swept.push(path);
      } catch {
        continue;
      }
    }
  }
  return swept;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface RepoLock {
  release(): void;
}

interface Holder {
  pid?: number;
  at?: number;
  token?: string;
}

function readHolder(path: string): { raw: string; holder: Holder } | undefined {
  try {
    const raw = readFileSync(path, "utf8");
    try {
      return { raw, holder: JSON.parse(raw) as Holder };
    } catch {
      return { raw, holder: {} };
    }
  } catch {
    return undefined;
  }
}

function busy(holder: Holder, maxAgeMs: number): boolean {
  const fresh = typeof holder.at === "number" && Date.now() - holder.at < maxAgeMs;
  return fresh && typeof holder.pid === "number" && alive(holder.pid);
}

function linkInto(tmp: string, path: string): boolean {
  try {
    linkSync(tmp, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

function takeGuard(guard: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      closeSync(openSync(guard, "wx", 0o600));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(guard).mtimeMs < GUARD_STALE_MS) return false;
        rmSync(guard, { force: true });
      } catch {
        return false;
      }
    }
  }
  return false;
}

export interface LockHooks {
  afterStaleRead?: () => void;
}

export function acquireRepoLock(stateDir: string, repoRoot: string, maxAgeMs: number = STALE_AGE_MS, hooks: LockHooks = {}): RepoLock | undefined {
  const dir = lockRoot(stateDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = createHash("sha1").update(repoRoot).digest("hex").slice(0, 20);
  const path = join(dir, `${name}.lock`);
  const guard = join(dir, `${name}.guard`);
  const tmp = join(dir, `${name}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const token = randomBytes(8).toString("hex");
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, at: Date.now(), token }), { mode: 0o600 });
  const won = (): RepoLock => {
    const untrack = trackPath(path);
    return {
      release() {
        untrack();
        const current = readHolder(path);
        if (current && current.holder.pid === process.pid && current.holder.token === token) rmSync(path, { force: true });
      },
    };
  };
  try {
    if (linkInto(tmp, path)) return won();
    const first = readHolder(path);
    if (first && busy(first.holder, maxAgeMs)) return undefined;
    hooks.afterStaleRead?.();
    if (!takeGuard(guard)) return undefined;
    try {
      const current = readHolder(path);
      if (current && busy(current.holder, maxAgeMs)) return undefined;
      rmSync(path, { force: true });
      return linkInto(tmp, path) ? won() : undefined;
    } finally {
      rmSync(guard, { force: true });
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}
