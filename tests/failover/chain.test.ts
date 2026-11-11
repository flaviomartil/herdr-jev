import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChain, parseChain } from "../../src/failover/failover";
import type { AttemptReport, Target } from "../../src/failover/failover";
import { Health } from "../../src/failover/health";

const ok = (): AttemptReport => ({ code: 0, outcome: "done", output: "fine" });
const bad = (output: string, code = 1): AttemptReport => ({ code, outcome: "failed", output });

function setup(script: AttemptReport[] | ((t: Target, n: number) => AttemptReport), extra: { maxWaitMs?: number } = {}) {
  const clock = { t: 1_794_000_000_000 };
  const env = { HERDR_JEV_HEALTH_DIR: mkdtempSync(join(tmpdir(), "jev-chain-")) };
  const health = new Health({ env, now: () => clock.t });
  const sleeps: number[] = [];
  const ran: string[] = [];
  const events: Record<string, unknown>[] = [];
  const lines: string[] = [];
  const controller = new AbortController();
  const deps = {
    health,
    now: () => clock.t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock.t += ms;
    },
    random: () => 0.5,
    signal: controller.signal,
    emit: (e: Record<string, unknown>) => events.push(e),
    echo: (l: string) => lines.push(l),
    runAttempt: async (t: Target, n: number) => {
      ran.push(`${t.cli}/${t.model}`);
      return typeof script === "function" ? script(t, n) : (script[n - 1] ?? ok());
    },
    ...extra,
  };
  return { deps, sleeps, ran, events, lines, health, clock, controller };
}

const A: Target = { cli: "codex", model: "m1" };
const B: Target = { cli: "agy", model: "m2" };
const C: Target = { cli: "claude", model: "m3" };

test("parseChain reads cli/model pairs and drops invalid ones", () => {
  expect(parseChain("codex/gpt-5, agy/gemini,bogus/x,noslash")).toEqual([
    { cli: "codex", model: "gpt-5" },
    { cli: "agy", model: "gemini" },
  ]);
});

test("503 is retried on the same target with 2s and 8s backoff then succeeds", async () => {
  const s = setup([bad("HTTP 503 Service Unavailable"), bad("503"), ok()]);
  expect(await runChain([A, B], s.deps)).toBe(0);
  expect(s.ran).toEqual(["codex/m1", "codex/m1", "codex/m1"]);
  expect(s.sleeps).toEqual([2000, 8000]);
});

test("Retry-After of 30s is honored exactly", async () => {
  const s = setup([bad("429 Too Many Requests retry-after: 30"), ok()]);
  expect(await runChain([A], s.deps)).toBe(0);
  expect(s.sleeps).toEqual([30_000]);
});

test("exhausted transient retries move to the next target and count in the breaker", async () => {
  const s = setup((t) => (t.cli === "codex" ? bad("503") : ok()));
  expect(await runChain([A, B], s.deps)).toBe(0);
  expect(s.ran).toEqual(["codex/m1", "codex/m1", "codex/m1", "agy/m2"]);
  expect(s.health.read().breakers.codex?.fails).toBe(1);
});

test("quota locks the target until the parsed reset and falls to the next target", async () => {
  const resetAt = 1_794_000_000_000 + 3_600_000;
  const epoch = Math.floor(resetAt / 1000);
  const s = setup((t) => (t.cli === "claude" ? bad(`Claude AI usage limit reached|${epoch}`) : ok()));
  expect(await runChain([C, B], s.deps)).toBe(0);
  expect(s.ran).toEqual(["claude/m3", "agy/m2"]);
  expect(s.health.lockoutFor("claude", "m3")).toMatchObject({ reason: "quota", until: epoch * 1000 });
});

test("auth locks the whole cli", async () => {
  const s = setup((t) => (t.cli === "codex" ? bad("Not logged in. Please log in") : ok()));
  await runChain([A, B], s.deps);
  expect(s.health.lockoutFor("codex", "anything")?.reason).toBe("auth");
});

test("request errors are never retried or sent to a fallback", async () => {
  const s = setup(() => bad("invalid_request_error: bad field", 1));
  expect(await runChain([A, B], s.deps)).toBe(1);
  expect(s.ran).toEqual(["codex/m1"]);
});

test("a second Failed returns to the hub", async () => {
  const s = setup(() => bad("segfault", 7));
  expect(await runChain([A, B, C], s.deps)).toBe(7);
  expect(s.ran).toEqual(["codex/m1", "agy/m2"]);
});

test("attempts are capped at 6 across retries and fallbacks", async () => {
  const s = setup(() => bad("503"));
  const code = await runChain([A, B, C], s.deps);
  expect(code).toBe(1);
  expect(s.ran.length).toBe(6);
});

test("timeout gets one retry then moves on", async () => {
  const s = setup((t) => (t.cli === "codex" ? { code: 124, outcome: "timeout", output: "" } : ok()));
  await runChain([A, B], s.deps);
  expect(s.ran).toEqual(["codex/m1", "codex/m1", "agy/m2"]);
});

test("an empty chain by lockout waits for the lowest until, then resumes the same target", async () => {
  const s = setup([bad("You've hit your usage limit. try again in 10 minutes"), ok()]);
  expect(await runChain([A], s.deps)).toBe(0);
  expect(s.ran).toEqual(["codex/m1", "codex/m1"]);
  expect(s.sleeps.reduce((a, b) => a + b, 0)).toBe(600_000);
  expect(s.events.some((e) => e.type === "wait")).toBe(true);
  expect(s.lines.some((l) => l.includes("waiting"))).toBe(true);
});

test("a lockout with no known end (auth) does not wait", async () => {
  const s = setup(() => bad("Not logged in"));
  expect(await runChain([A], s.deps)).toBe(1);
  expect(s.sleeps).toEqual([]);
});

test("wait ceiling stops the chain", async () => {
  const s = setup(() => bad("You've hit your usage limit. try again in 10 hours"), { maxWaitMs: 3_600_000 });
  expect(await runChain([A], s.deps)).toBe(1);
  expect(s.ran.length).toBe(1);
});

test("abort during a wait returns 130 without another attempt", async () => {
  const s = setup(() => bad("You've hit your usage limit. try again in 10 minutes"));
  s.deps.sleep = async () => {
    s.controller.abort();
  };
  expect(await runChain([A], s.deps)).toBe(130);
  expect(s.ran.length).toBe(1);
});

test("skips targets already locked or behind an open breaker", async () => {
  const s = setup(ok);
  s.health.lock("codex/m1", "quota", s.clock.t + 1_000_000);
  for (let i = 0; i < 3; i += 1) s.health.failure("agy");
  await runChain([A, B, C], s.deps);
  expect(s.ran).toEqual(["claude/m3"]);
});

test("route log records each decision", async () => {
  const s = setup([bad("503"), ok()]);
  await runChain([A], s.deps);
  const log = (await Bun.file(join(s.health.file, "..", "route-log.jsonl")).text()).trim().split("\n").map((l) => JSON.parse(l));
  expect(log.map((l) => l.outcome)).toEqual(["Transient", "Success"]);
});

test("timeouts count toward the breaker once retries are spent", async () => {
  const s = setup((t) => (t.cli === "codex" ? { code: 124, outcome: "timeout", output: "" } : ok()));
  await runChain([A, B], s.deps);
  expect(s.health.read().breakers.codex?.fails).toBe(1);
});

test("maxAttempts passed by the caller caps the chain", async () => {
  const s = setup(() => bad("503"), { maxWaitMs: 1000 });
  (s.deps as { maxAttempts?: number }).maxAttempts = 2;
  await runChain([A, B, C], s.deps);
  expect(s.ran.length).toBe(2);
});
