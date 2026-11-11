import { execFile } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { RESTART_WINDOW_MS, decide } from "./decide.js";
import type { Action } from "./decide.js";
import { probe as defaultProbe } from "./health.js";
import type { Probe } from "./health.js";
import type { Proxy } from "./registry.js";

export type Exec = (argv: string[]) => Promise<{ code: number; stdout: string }>;

export const execSystemctl: Exec = (argv) =>
  new Promise((resolve) => {
    execFile(argv[0]!, argv.slice(1), { timeout: 5000 }, (err, stdout) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? "") });
    });
  });

export type History = Record<string, number[]>;

export type Store = { load: () => History; save: (h: History) => void };

export const statePath = (home = homedir()): string => join(home, ".local", "state", "herdr-jev", "proxies-state.json");

export function fileStore(path = statePath()): Store {
  return {
    load: () => {
      try {
        return JSON.parse(readFileSync(path, "utf8")) as History;
      } catch {
        return {};
      }
    },
    save: (h) => {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(h), { mode: 0o600 });
      renameSync(tmp, path);
    },
  };
}

export const lockPath = (home = homedir()): string => join(home, ".local", "state", "herdr-jev", "proxies.lock");

export const LOCK_STALE_MS = 120_000;

export type Lock = () => (() => void) | null;

export function fileLock(path = lockPath(), staleMs = LOCK_STALE_MS, alive: (pid: number) => boolean = pidAlive): Lock {
  return () => {
    mkdirSync(dirname(path), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(path, "wx", 0o600);
        writeFileSync(fd, String(process.pid));
        closeSync(fd);
        return () => {
          try {
            unlinkSync(path);
          } catch {}
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") return null;
        try {
          const pid = Number(readFileSync(path, "utf8"));
          const old = Date.now() - statSync(path).mtimeMs > staleMs;
          if (!old && Number.isInteger(pid) && pid > 0 && alive(pid)) return null;
          unlinkSync(path);
        } catch {
          return null;
        }
      }
    }
    return null;
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type Deps = {
  exec: Exec;
  probe: Probe;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  store: Store;
  lock: Lock;
  recheckMs: number;
  recoverMs: number;
};

export const defaultDeps = (): Deps => ({
  exec: execSystemctl,
  probe: defaultProbe,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  store: fileStore(),
  lock: fileLock(),
  recheckMs: 10_000,
  recoverMs: 20_000,
});

export type Result = {
  id: string;
  healthy: boolean;
  activeState?: string;
  action: Action;
  reason: string;
  restarted: boolean;
  recovered?: boolean;
  command?: string;
};

const UNIT = /^[\w@.-]+\.service$/;

type UnitInfo = { activeState?: string; restarts?: number };

async function unitInfo(deps: Deps, p: Proxy): Promise<UnitInfo> {
  if (!p.unit) return {};
  if (!UNIT.test(p.unit)) return {};
  const flag = p.scope === "system" ? [] : ["--user"];
  const res = await deps.exec(["systemctl", ...flag, "show", p.unit, "-p", "ActiveState,NRestarts"]);
  const out: UnitInfo = {};
  for (const line of res.stdout.split("\n")) {
    const [k, v] = line.split("=");
    if (k === "ActiveState") out.activeState = v?.trim();
    if (k === "NRestarts" && v !== undefined && v.trim() !== "") out.restarts = Number(v);
  }
  return out;
}

async function waitRecovered(deps: Deps, p: Proxy): Promise<boolean> {
  const start = deps.now();
  while (true) {
    if (await deps.probe(p)) return true;
    if (deps.now() - start >= deps.recoverMs) return false;
    await deps.sleep(1000);
  }
}

export async function status(proxies: Proxy[], deps: Deps): Promise<{ id: string; healthy: boolean; activeState?: string }[]> {
  return Promise.all(
    proxies.map(async (p) => ({ id: p.id, healthy: await deps.probe(p), activeState: (await unitInfo(deps, p)).activeState })),
  );
}

export async function check(proxies: Proxy[], deps: Deps, repair: boolean): Promise<Result[]> {
  const first = new Map(await Promise.all(proxies.map(async (p) => [p.id, await deps.probe(p)] as const)));
  const failing = proxies.filter((p) => !first.get(p.id));
  const before = new Map<string, UnitInfo>();
  for (const p of failing) before.set(p.id, await unitInfo(deps, p));
  if (failing.length > 0) await deps.sleep(deps.recheckMs);
  const history = deps.store.load();
  const down = new Set<string>();
  const results: Result[] = [];
  for (const p of proxies) {
    if (first.get(p.id)) {
      results.push({ id: p.id, healthy: true, action: "none", reason: "healthy", restarted: false });
      continue;
    }
    const again = await deps.probe(p);
    if (again) {
      results.push({ id: p.id, healthy: true, action: "none", reason: "recovered on recheck", restarted: false });
      continue;
    }
    down.add(p.id);
    const now = await unitInfo(deps, p);
    const dependencyDown = p.dependsOn.find((d) => down.has(d));
    const d = decide({
      scope: p.scope,
      unit: p.unit,
      failures: 2,
      activeState: now.activeState,
      restartsBefore: before.get(p.id)?.restarts,
      restartsNow: now.restarts,
      history: history[p.id] ?? [],
      now: deps.now(),
      dependencyDown,
    });
    const r: Result = { id: p.id, healthy: false, activeState: now.activeState, action: d.action, reason: d.reason, restarted: false, command: d.command };
    if (d.action === "restart" && repair && p.unit) {
      const release = deps.lock();
      if (!release) {
        r.action = "wait";
        r.reason = "another session is repairing";
      } else {
        try {
          const fresh = deps.store.load();
          const recent = (fresh[p.id] ?? []).some((t) => deps.now() - t < RESTART_WINDOW_MS);
          if (recent) {
            r.action = "warn";
            r.reason = "restart denied, one per 10 min";
          } else {
            fresh[p.id] = [...(fresh[p.id] ?? []).filter((t) => deps.now() - t < 3_600_000), deps.now()];
            deps.store.save(fresh);
            await deps.exec(["systemctl", "--user", "restart", p.unit]);
            r.restarted = true;
            r.recovered = await waitRecovered(deps, p);
          }
        } finally {
          release();
        }
      }
    } else if (d.action === "restart") {
      r.command = `systemctl --user restart ${p.unit}`;
    }
    results.push(r);
  }
  return results;
}
