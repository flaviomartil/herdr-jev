import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Health } from "../../src/failover/health";

const mk = (now: { t: number }, pidAlive = () => true) => {
  const dir = mkdtempSync(join(tmpdir(), "jev-health-"));
  const env = { HERDR_JEV_HEALTH_DIR: dir };
  return { dir, health: new Health({ env, now: () => now.t, pidAlive }) };
};

test("lockout is active until its time, then expires, and cli wildcard applies to every model", () => {
  const now = { t: 1_000_000 };
  const { health } = mk(now);
  health.lock("codex/gpt-5", "quota", now.t + 60_000);
  health.lock("agy/*", "auth");
  expect(health.lockoutFor("codex", "gpt-5")?.reason).toBe("quota");
  expect(health.lockoutFor("codex", "other")).toBeUndefined();
  expect(health.lockoutFor("agy", "any")?.reason).toBe("auth");
  now.t += 60_001;
  expect(health.lockoutFor("codex", "gpt-5")).toBeUndefined();
});

test("breaker opens at 3 failures with 5s cooldown doubling to a 120s cap and closes on success", () => {
  const now = { t: 5_000_000 };
  const { health } = mk(now);
  health.failure("codex");
  health.failure("codex");
  expect(health.breakerUntil("codex")).toBe(0);
  health.failure("codex");
  expect(health.breakerUntil("codex")).toBe(now.t + 5000);
  health.failure("codex");
  expect(health.read().breakers.codex?.cooldownMs).toBe(10_000);
  for (let i = 0; i < 8; i += 1) health.failure("codex");
  expect(health.read().breakers.codex?.cooldownMs).toBe(120_000);
  health.success("codex");
  expect(health.breakerUntil("codex")).toBe(0);
  expect(health.read().breakers.codex?.fails).toBe(0);
});

test("state persists across instances and writes leave no temp or lock file", () => {
  const now = { t: 1_000 };
  const { dir, health } = mk(now);
  health.lock("claude/opus", "quota", now.t + 5000);
  const again = new Health({ env: { HERDR_JEV_HEALTH_DIR: dir }, now: () => now.t });
  expect(again.read().lockouts["claude/opus"]?.reason).toBe("quota");
  expect(JSON.parse(readFileSync(join(dir, "health.json"), "utf8")).lockouts["claude/opus"].until).toBe(6000);
  expect(existsSync(join(dir, "health.json.lock"))).toBe(false);
});

test("an orphan lock expires by deadline or dead pid and the write proceeds", () => {
  const now = { t: 2_000_000 };
  const byTime = mk(now);
  writeFileSync(join(byTime.dir, "health.json.lock"), JSON.stringify({ pid: process.pid, expires: now.t - 1 }));
  byTime.health.lock("codex/x", "quota", now.t + 1000);
  expect(byTime.health.read().lockouts["codex/x"]).toBeDefined();
  const byPid = mk(now, () => false);
  writeFileSync(join(byPid.dir, "health.json.lock"), JSON.stringify({ pid: 999_999, expires: now.t + 600_000 }));
  byPid.health.lock("codex/y", "quota", now.t + 1000);
  expect(byPid.health.read().lockouts["codex/y"]).toBeDefined();
});

test("gc drops expired lockouts and breakers closed for over 24h", () => {
  const now = { t: 10_000_000 };
  const { health } = mk(now);
  health.lock("a/x", "quota", now.t + 10);
  health.lock("b/x", "quota", now.t + 10_000_000);
  health.failure("a");
  health.success("a");
  now.t += 100_000;
  health.gc();
  expect(Object.keys(health.read().lockouts)).toEqual(["b/x"]);
  expect(health.read().breakers.a).toBeDefined();
  now.t += 86_400_001;
  health.gc();
  expect(health.read().breakers.a).toBeUndefined();
});
