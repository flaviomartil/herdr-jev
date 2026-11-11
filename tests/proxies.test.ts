import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { decide } from "../src/proxies/decide.ts";
import { main } from "../src/proxies/cli.ts";
import { check } from "../src/proxies/monitor.ts";
import type { Deps, History } from "../src/proxies/monitor.ts";
import { fileLock } from "../src/proxies/monitor.ts";
import { parseRegistry } from "../src/proxies/registry.ts";

const REG = `proxies:
  - id: alpha
    port: 9001
    health: /health
    unit: alpha.service
    usedBy: [codex]
  - id: beta
    port: 9002
    unit: beta.service
    dependsOn: [alpha]
  - id: sys
    port: 9003
    unit: sys.service
    scope: system
`;

type Fake = { alive: Set<string>; units: Record<string, { state: string; n: number }>; calls: string[][]; history: History; t: number; healOnRestart: boolean; locked?: boolean };

function fake(over: Partial<Fake> = {}): { deps: Deps; f: Fake } {
  const f: Fake = { alive: new Set(), units: {}, calls: [], history: {}, t: 1_000_000, healOnRestart: true, ...over };
  const deps: Deps = {
    exec: async (argv) => {
      f.calls.push(argv);
      const unit = argv[argv.includes("show") ? argv.indexOf("show") + 1 : argv.length - 1]!;
      if (argv.includes("restart")) {
        if (f.healOnRestart) f.alive.add(unit.replace(".service", ""));
        return { code: 0, stdout: "" };
      }
      const u = f.units[unit] ?? { state: "active", n: 0 };
      return { code: 0, stdout: `ActiveState=${u.state}\nNRestarts=${u.n}\n` };
    },
    probe: async (p) => f.alive.has(p.id),
    sleep: async (ms) => {
      f.t += ms;
    },
    now: () => f.t,
    lock: () => (f.locked ? null : () => {}),
    store: { load: () => f.history, save: (h) => void (f.history = h) },
    recheckMs: 10_000,
    recoverMs: 20_000,
  };
  return { deps, f };
}

const restarts = (f: Fake) => f.calls.filter((c) => c.includes("restart"));
const proxies = parseRegistry(REG);

test("registry parses entries and rejects unknown dependency", () => {
  expect(proxies.map((p) => p.id)).toEqual(["alpha", "beta", "sys"]);
  expect(proxies[1]!.dependsOn).toEqual(["alpha"]);
  expect(proxies[2]!.scope).toBe("system");
  expect(() => parseRegistry("proxies:\n  - id: a\n    port: 1\n    dependsOn: [x]\n")).toThrow();
});

test("stuck but active: restarted once and recovered", async () => {
  const { deps, f } = fake({ alive: new Set(["beta", "sys"]) });
  const res = await check(proxies, deps, true);
  expect(restarts(f)).toEqual([["systemctl", "--user", "restart", "alpha.service"]]);
  expect(res[0]).toMatchObject({ action: "restart", restarted: true, recovered: true });
});

test("without --repair nothing is restarted and the command is shown", async () => {
  const { deps, f } = fake({ alive: new Set(["beta", "sys"]) });
  const res = await check(proxies, deps, false);
  expect(restarts(f)).toHaveLength(0);
  expect(res[0]!.command).toBe("systemctl --user restart alpha.service");
});

test("dead process (inactive) is left to systemd", async () => {
  const { deps, f } = fake({ alive: new Set(["beta", "sys"]), units: { "alpha.service": { state: "inactive", n: 0 } } });
  const res = await check(proxies, deps, true);
  expect(restarts(f)).toHaveLength(0);
  expect(res[0]!.action).toBe("none");
});

test("activating is a no-op", async () => {
  const { deps, f } = fake({ alive: new Set(["beta", "sys"]), units: { "alpha.service": { state: "activating", n: 1 } } });
  const res = await check(proxies, deps, true);
  expect(restarts(f)).toHaveLength(0);
  expect(res[0]!.action).toBe("wait");
});

test("second restart within 10 minutes is denied", async () => {
  const { deps, f } = fake({ alive: new Set(["beta", "sys"]), healOnRestart: false });
  await check(proxies, deps, true);
  expect(restarts(f)).toHaveLength(1);
  f.t += 60_000;
  const res = await check(proxies, deps, true);
  expect(restarts(f)).toHaveLength(1);
  expect(res[0]).toMatchObject({ action: "warn", restarted: false });
  f.t += 11 * 60_000;
  await check(proxies, deps, true);
  expect(restarts(f)).toHaveLength(2);
});

test("failed unit shows the command and does not run it", async () => {
  const { deps, f } = fake({ alive: new Set(["beta", "sys"]), units: { "alpha.service": { state: "failed", n: 5 } } });
  const res = await check(proxies, deps, true);
  expect(restarts(f)).toHaveLength(0);
  expect(res[0]!.action).toBe("warn");
  expect(res[0]!.command).toContain("reset-failed alpha.service");
});

test("NRestarts rising between checks means systemd is handling it", () => {
  const d = decide({ scope: "user", unit: "a.service", failures: 2, activeState: "active", restartsBefore: 1, restartsNow: 2, history: [], now: 0 });
  expect(d.action).toBe("wait");
});

test("system unit only warns, dependents wait on a down dependency", async () => {
  const { deps, f } = fake();
  const res = await check(proxies, deps, true);
  expect(res.find((r) => r.id === "sys")).toMatchObject({ action: "warn" });
  expect(res.find((r) => r.id === "beta")).toMatchObject({ action: "wait" });
  expect(restarts(f).map((c) => c[3])).toEqual(["alpha.service"]);
});

test("recheck that passes does not restart", async () => {
  const { deps, f } = fake();
  let n = 0;
  deps.probe = async (p) => (p.id === "alpha" ? ++n > 1 : true);
  const res = await check(proxies, deps, true);
  expect(restarts(f)).toHaveLength(0);
  expect(res[0]!.healthy).toBe(true);
});

test("cli check --json prints results and exit code reflects health", async () => {
  const { deps } = fake({ alive: new Set(["alpha", "beta", "sys"]) });
  const lines: string[] = [];
  const code = await main(["proxies", "check", "--json"], { out: (s) => lines.push(s), err: () => {}, deps, load: () => proxies });
  expect(code).toBe(0);
  expect(JSON.parse(lines[0]!).results).toHaveLength(3);
});

test("cli rejects unknown subcommand", async () => {
  const errs: string[] = [];
  expect(await main(["proxies", "x"], { out: () => {}, err: (s) => errs.push(s) })).toBe(2);
});

test("held lock blocks restart", async () => {
  const { deps, f } = fake({ alive: new Set(["beta", "sys"]), locked: true });
  const res = await check(proxies, deps, true);
  expect(restarts(f)).toHaveLength(0);
  expect(res[0]!.reason).toContain("another session");
});

test("history reloaded under lock denies a restart another session just did", async () => {
  const { deps, f } = fake({ alive: new Set(["beta", "sys"]) });
  const load = deps.store.load;
  let calls = 0;
  deps.store.load = () => (++calls === 1 ? {} : { alpha: [f.t - 1000] });
  const res = await check(proxies, deps, true);
  expect(restarts(f)).toHaveLength(0);
  expect(res[0]!.action).toBe("warn");
  void load;
});

test("history is persisted before the restart exec", async () => {
  const { deps, f } = fake({ alive: new Set(["beta", "sys"]) });
  let saved = false;
  const save = deps.store.save;
  deps.store.save = (h) => {
    saved = true;
    save(h);
  };
  const exec = deps.exec;
  deps.exec = async (a) => {
    if (a.includes("restart")) expect(saved).toBe(true);
    return exec(a);
  };
  await check(proxies, deps, true);
  expect(restarts(f)).toHaveLength(1);
});

test("file lock is exclusive, reclaims dead pid and stale files", () => {
  const dir = mkdtempSync(join(tmpdir(), "lk-"));
  const path = join(dir, "l.lock");
  const lock = fileLock(path, 120_000, () => true);
  const rel = lock();
  expect(rel).not.toBeNull();
  expect(lock()).toBeNull();
  rel!();
  writeFileSync(path, "99999999");
  expect(fileLock(path, 120_000, () => false)()).not.toBeNull();
  writeFileSync(path, String(process.pid));
  expect(fileLock(path, -1, () => true)()).not.toBeNull();
});

test("registry requires port and valid unit names", () => {
  expect(() => parseRegistry("proxies:\n  - id: a\n    health: /h\n")).toThrow();
  expect(() => parseRegistry("proxies:\n  - id: a\n    port: 1\n    unit: x;rm.service\n")).toThrow();
});
