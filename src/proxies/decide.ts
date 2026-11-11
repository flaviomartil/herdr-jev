import type { ProxyScope } from "./registry.js";

export const RESTART_WINDOW_MS = 10 * 60 * 1000;

export type Action = "restart" | "wait" | "warn" | "none";

export type DecideInput = {
  scope: ProxyScope;
  unit?: string;
  failures: number;
  activeState?: string;
  restartsBefore?: number;
  restartsNow?: number;
  history: number[];
  now: number;
  dependencyDown?: string;
};

export type Decision = { action: Action; reason: string; command?: string };

export function decide(i: DecideInput): Decision {
  if (i.failures === 0) return { action: "none", reason: "healthy" };
  if (i.scope === "system" || !i.unit) return { action: "warn", reason: "unhealthy, not managed by the mod" };
  const unit = i.unit;
  if (i.failures < 2) return { action: "wait", reason: "first check failed, rechecking" };
  if (i.dependencyDown) return { action: "wait", reason: `dependency ${i.dependencyDown} is down` };
  const state = i.activeState ?? "unknown";
  if (state === "failed") {
    return { action: "warn", reason: "unit failed, systemd gave up", command: `systemctl --user reset-failed ${unit} && systemctl --user restart ${unit}` };
  }
  if (state === "activating" || state === "reloading" || state === "deactivating") return { action: "wait", reason: `unit ${state}` };
  if (state !== "active") return { action: "none", reason: `unit ${state}, systemd owns it` };
  if (i.restartsBefore !== undefined && i.restartsNow !== undefined && i.restartsNow > i.restartsBefore) {
    return { action: "wait", reason: "systemd restarted it meanwhile" };
  }
  if (i.history.some((t) => i.now - t < RESTART_WINDOW_MS)) return { action: "warn", reason: "restart denied, one per 10 min" };
  return { action: "restart", reason: "alive but not responding" };
}
