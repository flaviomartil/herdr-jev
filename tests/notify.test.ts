import { expect, test } from "bun:test";
import { handleNotifyCommand } from "../src/herdr/notify.ts";
import { join } from "node:path";
import { writeFileSync, existsSync, rmSync, mkdirSync, readFileSync } from "node:fs";

test("notify skips when attention is not now", async () => {
  const runner = async () => ({ ok: true, stdout: "" });
  process.env.HERDR_JEV_NOTIFY = "1";
  
  const res = await handleNotifyCommand({ attention: "soon", dryRun: true }, runner);
  expect(res.sent).toBe(false);
  expect(res.skippedReason).toBe("attention not now");
});

test("notify skips when HERDR_JEV_NOTIFY is 0", async () => {
  const runner = async () => ({ ok: true, stdout: "" });
  process.env.HERDR_JEV_NOTIFY = "0";
  
  const res = await handleNotifyCommand({ attention: "now", dryRun: true }, runner);
  expect(res.sent).toBe(false);
  expect(res.skippedReason).toBe("disabled by env");
});

test("notify uses cooldowns per pane", async () => {
  process.env.HERDR_JEV_NOTIFY = "1";
  const runner = async () => ({ ok: true, stdout: "" });
  
  const stateDir = join(import.meta.dir, "temp-notify");
  mkdirSync(join(stateDir, "notify"), { recursive: true });
  process.env.HERDR_JEV_STATE_DIR = stateDir;
  
  const now = Date.now();
  writeFileSync(join(stateDir, "notify", "test-pane-1.json"), JSON.stringify({ time: now - 5000 }));
  
  const res = await handleNotifyCommand({ 
    pane: "test-pane-1", name: "Ada", project: "StixLab", 
    attention: "now", reason: "approval", dryRun: false, now 
  }, runner);
  
  expect(res.sent).toBe(false);
  expect(res.skippedReason).toBe("cooldown");
  
  const res2 = await handleNotifyCommand({ 
    pane: "test-pane-1", name: "Ada", project: "StixLab", 
    attention: "now", reason: "approval", dryRun: false, now: now + 700000 
  }, runner);
  
  expect(res2.sent).toBe(true);
  expect(res2.channels).toContain("herdr");
});

test("notify escalation blocked requires valid agent", async () => {
  process.env.HERDR_JEV_NOTIFY = "1";
  process.env.HERDR_JEV_ESCALATE_BLOCKED = "1";
  try { rmSync(process.env.HERDR_JEV_STATE_DIR!, { recursive: true }); } catch (e) {}
  
  let runnerArgs: string[] = [];
  const runner = async (args: readonly string[]) => {
    runnerArgs.push(...args);
    return { ok: true, stdout: "" };
  };
  
  const resUnknown = await handleNotifyCommand({ 
    pane: "escalate-pane", name: "Ada", project: "StixLab", 
    attention: "now", reason: "approval", confidence: 0.9, nativeStatus: "idle", agent: "unknown", dryRun: false, now: Date.now() 
  }, runner);
  
  expect(resUnknown.sent).toBe(true);
  expect(resUnknown.channels).not.toContain("escalation");

  const resValid = await handleNotifyCommand({ 
    pane: "escalate-pane-2", name: "Ada", project: "StixLab", 
    attention: "now", reason: "approval", confidence: 0.9, nativeStatus: "idle", agent: "kiro", dryRun: false, now: Date.now() 
  }, runner);
  
  expect(resValid.sent).toBe(true);
  expect(resValid.channels).toContain("escalation");
});

test("notify release missing makes no herdr call", async () => {
  let calls = 0;
  const runner = async () => { calls++; return { ok: true, stdout: "" }; };
  
  const stateDir = process.env.HERDR_JEV_STATE_DIR!;
  const notifyDir = join(stateDir, "notify");
  mkdirSync(notifyDir, { recursive: true });
  writeFileSync(join(notifyDir, "escalations.json"), JSON.stringify([]));

  const res = await handleNotifyCommand({ release: true, pane: "missing-pane" }, runner);
  expect(res.sent).toBe(false);
  expect(res.skippedReason).toBe("no escalation");
  expect(calls).toBe(0);
});

test("notify release stale uses pane get", async () => {
  let runnerArgs: string[] = [];
  const runner = async (args: readonly string[]) => {
    runnerArgs.push(...args);
    if (args.includes("get")) {
      return { ok: false, stdout: "error" };
    }
    return { ok: true, stdout: "" };
  };
  
  const stateDir = process.env.HERDR_JEV_STATE_DIR!;
  const notifyDir = join(stateDir, "notify");
  const escFile = join(notifyDir, "escalations.json");
  writeFileSync(escFile, JSON.stringify([
    { pane: "stale-pane", agent: "kiro", time: Date.now() - 60000 }
  ]));
  
  const res = await handleNotifyCommand({ releaseStale: true }, runner);
  expect(res.sent).toBe(true);
  expect(res.channels).toContain("release-stale");
  expect(runnerArgs).toContain("get");
  
  const remain = JSON.parse(readFileSync(escFile, "utf-8"));
  expect(remain.length).toBe(0);
});

test("notify dry run shape", async () => {
  const runner = async () => ({ ok: true, stdout: "" });
  process.env.HERDR_JEV_NOTIFY = "1";
  
  const res = await handleNotifyCommand({ 
    pane: "test-pane-1", name: "Ada", project: "StixLab", 
    attention: "now", reason: "approval", dryRun: true 
  }, runner);
  
  expect(res.sent).toBe(false);
  expect(res.dryRun).toBe(true);
  expect(res.wouldSend).toContain("herdr");
  expect(res.channels).toEqual([]);
});
