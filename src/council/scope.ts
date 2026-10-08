import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { createHarnessProcessScope, terminateHarnessProcesses } from "../harness/bridge.js";

export const councilScope = createHarnessProcessScope();

const trackedPaths = new Set<string>();
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const SIGNAL_GRACE_MS = 1500;
export const STALE_AGE_MS = 2 * 60 * 60 * 1000;

let releaseGuard: (() => void) | undefined;

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

function killGroups(signal: NodeJS.Signals): void {
  for (const child of councilScope.groups.values()) {
    try {
      if (child.pid === undefined) throw new Error("no_pid");
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        continue;
      }
    }
  }
}

function install(): void {
  if (releaseGuard) return;
  const onExit = () => {
    killGroups("SIGKILL");
    removeTracked();
  };
  let stopping = false;
  const handlers = SIGNALS.map((signal) => {
    const handler = () => {
      const others = process.listenerCount(signal) > 1;
      if (stopping) return;
      stopping = true;
      terminateHarnessProcesses(councilScope, SIGNAL_GRACE_MS)
        .catch(() => undefined)
        .finally(() => {
          removeTracked();
          stopping = false;
          if (others) return;
          uninstall();
          process.kill(process.pid, signal);
        });
    };
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  process.on("exit", onExit);
  releaseGuard = () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    process.off("exit", onExit);
  };
}

function uninstall(): void {
  releaseGuard?.();
  releaseGuard = undefined;
}

function settle(): void {
  if (councilScope.groups.size === 0 && trackedPaths.size === 0) uninstall();
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

export function acquireRepoLock(stateDir: string, repoRoot: string, maxAgeMs: number = STALE_AGE_MS): RepoLock | undefined {
  const dir = lockRoot(stateDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${createHash("sha1").update(repoRoot).digest("hex").slice(0, 20)}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      closeSync(fd);
      const untrack = trackPath(path);
      return {
        release() {
          untrack();
          rmSync(path, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let holder: { pid?: number; at?: number } = {};
      try {
        holder = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        holder = {};
      }
      const fresh = typeof holder.at === "number" && Date.now() - holder.at < maxAgeMs;
      if (fresh && typeof holder.pid === "number" && alive(holder.pid)) return undefined;
      rmSync(path, { force: true });
    }
  }
  return undefined;
}
