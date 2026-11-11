import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type LockReason = "quota" | "overload" | "auth" | "model_gone" | "proxy_down";

export interface Lockout {
  until?: number;
  reason: LockReason;
  at: number;
}

export interface Breaker {
  fails: number;
  openUntil: number;
  cooldownMs: number;
  closedAt?: number;
}

export interface HealthData {
  lockouts: Record<string, Lockout>;
  breakers: Record<string, Breaker>;
}

export interface HealthOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  pidAlive?: (pid: number) => boolean;
  lockWaitMs?: number;
}

const LOCK_TTL_MS = 10_000;
const LOCK_WAIT_MS = 3000;
const NO_UNTIL_TTL_MS = 86_400_000;
const BREAKER_THRESHOLD = 3;
const BREAKER_BASE_MS = 5000;
const BREAKER_MAX_MS = 120_000;
const GC_AGE_MS = 86_400_000;

export function healthDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.HERDR_JEV_HEALTH_DIR?.trim();
  if (override) return override;
  const state = env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
  return join(state, "herdr-jev");
}

export const healthFile = (env: NodeJS.ProcessEnv = process.env): string => join(healthDir(env), "health.json");
export const routeLogFile = (env: NodeJS.ProcessEnv = process.env): string => join(healthDir(env), "route-log.jsonl");

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class Health {
  private readonly env: NodeJS.ProcessEnv;
  private readonly clock: () => number;
  private readonly alive: (pid: number) => boolean;
  private readonly lockWaitMs: number;

  constructor(opts: HealthOptions = {}) {
    this.env = opts.env ?? process.env;
    this.clock = opts.now ?? Date.now;
    this.alive = opts.pidAlive ?? defaultPidAlive;
    this.lockWaitMs = opts.lockWaitMs ?? LOCK_WAIT_MS;
  }

  get file(): string {
    return healthFile(this.env);
  }

  private lockFile(): string {
    return `${this.file}.lock`;
  }

  private stale(path: string): boolean {
    try {
      const held = JSON.parse(readFileSync(path, "utf8")) as { pid?: number; expires?: number };
      if (typeof held.expires === "number" && held.expires < this.clock()) return true;
      return typeof held.pid === "number" && !this.alive(held.pid);
    } catch {
      return true;
    }
  }

  private locked<T>(fn: () => T): T {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + this.lockWaitMs;
    for (;;) {
      try {
        const fd = openSync(this.lockFile(), "wx", 0o600);
        writeFileSync(fd, JSON.stringify({ pid: process.pid, expires: this.clock() + LOCK_TTL_MS }));
        closeSync(fd);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const grave = `${this.lockFile()}.${process.pid}.${Math.random().toString(36).slice(2)}.grave`;
        try {
          renameSync(this.lockFile(), grave);
        } catch {
          continue;
        }
        if (this.stale(grave)) {
          try {
            unlinkSync(grave);
          } catch {
            void 0;
          }
          continue;
        }
        try {
          linkSync(grave, this.lockFile());
        } catch {
          void 0;
        }
        try {
          unlinkSync(grave);
        } catch {
          void 0;
        }
        if (Date.now() > deadline) throw new Error("health lock timeout");
        pause(15);
      }
    }
    try {
      return fn();
    } finally {
      try {
        unlinkSync(this.lockFile());
      } catch {
        void 0;
      }
    }
  }

  read(): HealthData {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<HealthData>;
      return { lockouts: parsed.lockouts ?? {}, breakers: parsed.breakers ?? {} };
    } catch {
      return { lockouts: {}, breakers: {} };
    }
  }

  private write(data: HealthData): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  private mutate(fn: (data: HealthData) => void): void {
    this.locked(() => {
      const data = this.read();
      fn(data);
      this.write(data);
    });
  }

  lockoutFor(cli: string, model: string): Lockout | undefined {
    const data = this.read();
    const now = this.clock();
    for (const key of [`${cli}/${model}`, `${cli}/*`]) {
      const found = data.lockouts[key];
      if (!found) continue;
      const end = found.until ?? found.at + NO_UNTIL_TTL_MS;
      if (end > now) return { ...found, until: end };
    }
    return undefined;
  }

  breakerUntil(cli: string): number {
    const open = this.read().breakers[cli]?.openUntil ?? 0;
    return open > this.clock() ? open : 0;
  }

  lock(key: string, reason: LockReason, until?: number): void {
    this.mutate((data) => {
      data.lockouts[key] = { reason, at: this.clock(), ...(until ? { until } : {}) };
    });
  }

  clearLockout(key: string): void {
    this.mutate((data) => {
      delete data.lockouts[key];
    });
  }

  failure(cli: string): Breaker {
    let result!: Breaker;
    this.mutate((data) => {
      const now = this.clock();
      const prior = data.breakers[cli] ?? { fails: 0, openUntil: 0, cooldownMs: 0 };
      const fails = prior.fails + 1;
      let cooldownMs = prior.cooldownMs;
      let openUntil = prior.openUntil;
      if (fails >= BREAKER_THRESHOLD) {
        cooldownMs = prior.cooldownMs === 0 ? BREAKER_BASE_MS : Math.min(prior.cooldownMs * 2, BREAKER_MAX_MS);
        openUntil = now + cooldownMs;
      }
      result = { fails, openUntil, cooldownMs };
      data.breakers[cli] = result;
    });
    return result;
  }

  success(cli: string): void {
    this.mutate((data) => {
      if (data.breakers[cli]) {
        data.breakers[cli] = { fails: 0, openUntil: 0, cooldownMs: 0, closedAt: this.clock() };
      }
    });
  }

  gc(): void {
    this.mutate((data) => {
      const now = this.clock();
      for (const [key, value] of Object.entries(data.lockouts)) {
        if ((value.until ?? value.at + NO_UNTIL_TTL_MS) <= now) delete data.lockouts[key];
      }
      for (const [key, value] of Object.entries(data.breakers)) {
        if (value.fails === 0 && value.closedAt !== undefined && now - value.closedAt > GC_AGE_MS) delete data.breakers[key];
      }
    });
  }

  routeLog(entry: Record<string, unknown>): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      appendFileSync(routeLogFile(this.env), `${JSON.stringify({ t: this.clock(), ...entry })}\n`, { mode: 0o600 });
    } catch {
      void 0;
    }
  }

  exists(): boolean {
    return existsSync(this.file);
  }
}
