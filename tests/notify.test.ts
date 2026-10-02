let runnerImpl: any;
import { expect, test } from "bun:test";
import { handleNotifyCommand, resolveNotifyHook } from "../src/herdr/notify.ts";
import { resolveStateDir } from "../src/herdr/state-dir.ts";
import { join } from "node:path";
import { writeFileSync, existsSync, rmSync, mkdirSync, readFileSync, mkdtempSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { beforeAll, afterAll } from "bun:test";
import { createFakeHerdr } from "./helpers.ts";
import { createProcessCommandAdapter } from "../src/herdr/client.ts";


let stateDir: string;
beforeAll(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'herdr-jev-notify-'));
  process.env.HERDR_JEV_STATE_DIR = stateDir;
  process.env.HERDR_BIN_PATH = createFakeHerdr(stateDir);
  runnerImpl = createProcessCommandAdapter();
});
afterAll(() => {
  try { rmSync(join(stateDir, "notify"), { recursive: true, force: true }); } catch (e) {}
});

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
  let runnerArgs: string[] = [];
  const runner = async (args: readonly string[]) => {
    runnerArgs.push(...args);
    return runnerImpl(args);
  };
  
  mkdirSync(join(stateDir, "notify"), { recursive: true });
  
  const now = Date.now();
  writeFileSync(join(stateDir, "notify", "pane-w1_3Ap1.json"), JSON.stringify({ time: now - 5000 }));
  
  const res = await handleNotifyCommand({ 
    pane: "w1:p1", name: "Ada", project: "StixLab", 
    attention: "now", reason: "approval", dryRun: false, now 
  }, runner);
  
  expect(res.sent).toBe(false);
  expect(res.skippedReason).toBe("cooldown");
  
  const res2 = await handleNotifyCommand({ 
    pane: "w1:p1", name: "Ada", project: "StixLab", 
    attention: "now", reason: "approval", dryRun: false, now: now + 700000 
  }, runner);
  
  expect(res2.sent).toBe(true);
  expect(res2.channels).toContain("herdr");
});

test("notify escalation blocked requires valid agent", async () => {
  process.env.HERDR_JEV_NOTIFY = "1";
  process.env.HERDR_JEV_ESCALATE_BLOCKED = "1";
  delete process.env.FAKE_HERDR_AGENT_STATUS;
  try { rmSync(join(stateDir, "notify"), { recursive: true, force: true }); } catch (e) {}
  
  let runnerArgs: string[] = [];
  const runner = async (args: readonly string[]) => {
    runnerArgs.push(...args);
    return runnerImpl(args);
  };
  
  const resUnknown = await handleNotifyCommand({ 
    pane: "w1:p2", name: "Ada", project: "StixLab", 
    attention: "now", reason: "approval", confidence: 0.9, nativeStatus: "idle", agent: "unknown", dryRun: false, now: Date.now() 
  }, runner);
  
  expect(resUnknown.sent).toBe(true);
  expect(resUnknown.channels).not.toContain("escalation");
  expect(resUnknown.escalation).toBeUndefined();

  process.env.FAKE_HERDR_AGENT_STATUS = "blocked";
  const resValid = await handleNotifyCommand({ 
    pane: "w1:p3", name: "Ada", project: "StixLab", 
    attention: "now", reason: "approval", jevState: "blocked", reasonConfidence: 0.9, confidence: 0.9, nativeStatus: "idle", agent: "kiro", dryRun: false, now: Date.now() 
  }, runner);
  
  expect(resValid.sent).toBe(true);
  expect(resValid.channels).toContain("escalation");
  expect(resValid.escalation).toBe("applied");
  delete process.env.FAKE_HERDR_AGENT_STATUS;
});

test("notify release missing makes no herdr call", async () => {
  let calls = 0;
  const runner = async () => { calls++; return { ok: true, stdout: "" }; };
  
  
  const notifyDir = join(stateDir, "notify");
  mkdirSync(notifyDir, { recursive: true });
  writeFileSync(join(notifyDir, "escalations.json"), JSON.stringify([]));

  const res = await handleNotifyCommand({ release: true, pane: "w1:missing" }, runner);
  expect(res.sent).toBe(false);
  expect(res.skippedReason).toBe("no escalation");
  expect(calls).toBe(0);
});

test("notify release stale uses pane get", async () => {
  let runnerArgs: string[] = [];
  const runner = async (args: readonly string[]) => {
    runnerArgs.push(...args);
    return runnerImpl(args);
  };
  
  
  const notifyDir = join(stateDir, "notify");
  const escFile = join(notifyDir, "escalations.json");
  writeFileSync(escFile, JSON.stringify([
    { pane: "w1:stale", agent: "kiro", time: Date.now() - 60000 }
  ]));
  
  const res = await handleNotifyCommand({ releaseStale: true }, runner);
  if (!res.sent) console.log(res); if (!res.sent) console.log("ARGS", runnerArgs); expect(res.sent).toBe(true);
  expect(res.channels).toContain("release-stale");
  expect(runnerArgs).toContain("get");
  
  const remain = JSON.parse(readFileSync(escFile, "utf-8"));
  expect(remain.length).toBe(0);
});

test("notify release all with records", async () => {
  let calls = 0;
  const runner = async (args: readonly string[]) => {
    if (args.includes("release-agent")) calls++;
    return runnerImpl(args);
  };
  
  
  const notifyDir = join(stateDir, "notify");
  const escFile = join(notifyDir, "escalations.json");
  writeFileSync(escFile, JSON.stringify([
    { pane: "w1:p1", agent: "kiro", time: Date.now() },
    { pane: "w1:p2", agent: "ada", time: Date.now() - 1000 }
  ]));
  
  const res = await handleNotifyCommand({ releaseAll: true }, runner);
  expect(res.sent).toBe(true);
  expect(res.channels).toContain("release-all");
  expect(calls).toBe(2);
  
  const remain = JSON.parse(readFileSync(escFile, "utf-8"));
  expect(remain.length).toBe(0);
});

test("notify release all without records", async () => {
  let calls = 0;
  const runner = async () => { calls++; return { ok: true, stdout: "" }; };
  
  
  const notifyDir = join(stateDir, "notify");
  const escFile = join(notifyDir, "escalations.json");
  writeFileSync(escFile, JSON.stringify([]));
  
  const res = await handleNotifyCommand({ releaseAll: true }, runner);
  expect(res.sent).toBe(false);
  expect(res.channels).toEqual([]);
  expect(calls).toBe(0);
});

test("notify dry run shape", async () => {
  const runner = async () => ({ ok: true, stdout: "" });
  process.env.HERDR_JEV_NOTIFY = "1";
  
  const res = await handleNotifyCommand({ 
    pane: "w1:p1", name: "Ada", project: "StixLab", 
    attention: "now", reason: "approval", dryRun: true 
  }, runner);
  
  expect(res.sent).toBe(false);
  expect(res.dryRun).toBe(true);
  expect(res.wouldSend).toContain("herdr");
  expect(res.channels).toEqual([]);
});

test("fake herdr rejects options as first positional for report-agent and release-agent", async () => {
  const badReport = await runnerImpl([process.env.HERDR_BIN_PATH, "pane", "report-agent", "--source", "herdr-jev", "--agent", "kiro", "w1:p1"]);
  expect(badReport.ok).toBe(false);
  expect(badReport.stderr).toContain("unknown option");

  const badRelease = await runnerImpl([process.env.HERDR_BIN_PATH, "pane", "release-agent", "--source", "herdr-jev", "--agent", "kiro", "w1:p1"]);
  expect(badRelease.ok).toBe(false);
  expect(badRelease.stderr).toContain("unknown option");

  const goodReport = await runnerImpl([process.env.HERDR_BIN_PATH, "pane", "report-agent", "w1:p1", "--source", "herdr-jev", "--agent", "kiro", "--state", "blocked"]);
  expect(goodReport.ok).toBe(true);

  const goodRelease = await runnerImpl([process.env.HERDR_BIN_PATH, "pane", "release-agent", "w1:p1", "--source", "herdr-jev", "--agent", "kiro"]);
  expect(goodRelease.ok).toBe(true);
});

test("notify escalation ineffective when herdr agent status remains idle", async () => {
  process.env.HERDR_JEV_NOTIFY = "1";
  process.env.HERDR_JEV_ESCALATE_BLOCKED = "1";
  process.env.FAKE_HERDR_AGENT_STATUS = "idle";
  try { rmSync(join(stateDir, "notify"), { recursive: true, force: true }); } catch (e) {}

  const runner = async (args: readonly string[]) => runnerImpl(args);

  const res = await handleNotifyCommand({
    pane: "w1:p4", name: "Ada", project: "StixLab",
    attention: "now", reason: "approval", jevState: "blocked", reasonConfidence: 0.9, confidence: 0.9, nativeStatus: "idle", agent: "kiro", dryRun: false, now: Date.now()
  }, runner);

  expect(res.sent).toBe(true);
  expect(res.channels).not.toContain("escalation");
  expect(res.escalation).toBe("ineffective");

  const escFile = join(stateDir, "notify", "escalations.json");
  if (existsSync(escFile)) {
    const escalations = JSON.parse(readFileSync(escFile, "utf-8"));
    expect(escalations.find((e: any) => e.pane === "w1:p4")).toBeUndefined();
  }
  delete process.env.FAKE_HERDR_AGENT_STATUS;
});

test("notify escalation applied stores record with attempts counter 0", async () => {
  process.env.HERDR_JEV_NOTIFY = "1";
  process.env.HERDR_JEV_ESCALATE_BLOCKED = "1";
  process.env.FAKE_HERDR_AGENT_STATUS = "blocked";
  try { rmSync(join(stateDir, "notify"), { recursive: true, force: true }); } catch (e) {}

  let reportArgs: string[] = [];
  const runner = async (args: readonly string[]) => {
    if (args.includes("report-agent")) reportArgs = [...args];
    return runnerImpl(args);
  };

  const res = await handleNotifyCommand({
    pane: "w1:p5", name: "Ada", project: "StixLab",
    attention: "now", reason: "approval", jevState: "blocked", reasonConfidence: 0.9, confidence: 0.9, nativeStatus: "idle", agent: "kiro", dryRun: false, now: Date.now()
  }, runner);

  expect(res.sent).toBe(true);
  expect(res.channels).toContain("escalation");
  expect(res.escalation).toBe("applied");
  expect(reportArgs[3]).toBe("w1:p5");

  const escFile = join(stateDir, "notify", "escalations.json");
  expect(existsSync(escFile)).toBe(true);
  const escalations = JSON.parse(readFileSync(escFile, "utf-8"));
  const record = escalations.find((e: any) => e.pane === "w1:p5");
  expect(record).toBeDefined();
  expect(record.attempts).toBe(0);
  delete process.env.FAKE_HERDR_AGENT_STATUS;
});

test("release drops record immediately when pane no longer exists", async () => {
  const notifyDir = join(stateDir, "notify");
  mkdirSync(notifyDir, { recursive: true });
  const escFile = join(notifyDir, "escalations.json");
  writeFileSync(escFile, JSON.stringify([
    { pane: "w1:missing", agent: "kiro", time: Date.now(), attempts: 0 }
  ]));

  const runner = async (args: readonly string[]) => runnerImpl(args);
  const res = await handleNotifyCommand({ release: true, pane: "w1:missing" }, runner);

  expect(res.sent).toBe(true);
  expect(res.channels).toContain("release");
  const remain = JSON.parse(readFileSync(escFile, "utf-8"));
  expect(remain.length).toBe(0);
});

test("release drops record after 3 failed attempts", async () => {
  const notifyDir = join(stateDir, "notify");
  mkdirSync(notifyDir, { recursive: true });
  const escFile = join(notifyDir, "escalations.json");
  writeFileSync(escFile, JSON.stringify([
    { pane: "w1:p1", agent: "kiro", time: Date.now(), attempts: 0 }
  ]));

  const failingRunner = async (args: readonly string[]) => {
    if (args.includes("release-agent")) return { ok: false, code: 1, stdout: "", stderr: "release failed" };
    return runnerImpl(args);
  };

  const res1 = await handleNotifyCommand({ release: true, pane: "w1:p1" }, failingRunner);
  expect(res1.sent).toBe(false);
  expect(res1.skippedReason).toBe("release failed");
  let records = JSON.parse(readFileSync(escFile, "utf-8"));
  expect(records.length).toBe(1);
  expect(records[0].attempts).toBe(1);

  const res2 = await handleNotifyCommand({ release: true, pane: "w1:p1" }, failingRunner);
  expect(res2.sent).toBe(false);
  records = JSON.parse(readFileSync(escFile, "utf-8"));
  expect(records.length).toBe(1);
  expect(records[0].attempts).toBe(2);

  const res3 = await handleNotifyCommand({ release: true, pane: "w1:p1" }, failingRunner);
  expect(res3.sent).toBe(false);
  records = JSON.parse(readFileSync(escFile, "utf-8"));
  expect(records.length).toBe(0);

  const res4 = await handleNotifyCommand({ release: true, pane: "w1:p1" }, failingRunner);
  expect(res4.sent).toBe(false);
  expect(res4.skippedReason).toBe("no escalation");
});

test("release-stale drops record after 3 failed attempts", async () => {
  const notifyDir = join(stateDir, "notify");
  mkdirSync(notifyDir, { recursive: true });
  const escFile = join(notifyDir, "escalations.json");
  writeFileSync(escFile, JSON.stringify([
    { pane: "w1:p1", agent: "kiro", time: Date.now() - 20 * 60 * 1000, attempts: 2 }
  ]));

  const failingRunner = async (args: readonly string[]) => {
    if (args.includes("release-agent")) return { ok: false, code: 1, stdout: "", stderr: "release failed" };
    return runnerImpl(args);
  };

  const res = await handleNotifyCommand({ releaseStale: true }, failingRunner);
  expect(res.sent).toBe(true);
  const records = JSON.parse(readFileSync(escFile, "utf-8"));
  expect(records.length).toBe(0);
});

test("notify dry run lists escalation only as unverified", async () => {
  process.env.HERDR_JEV_NOTIFY = "1";
  process.env.HERDR_JEV_ESCALATE_BLOCKED = "1";
  const runner = async () => ({ ok: true, stdout: "" });

  const res = await handleNotifyCommand({
    pane: "w1:p1", name: "Ada", project: "StixLab",
    attention: "now", reason: "approval", jevState: "blocked", reasonConfidence: 0.9, confidence: 0.9, nativeStatus: "idle", agent: "kiro", dryRun: true
  }, runner);

  expect(res.sent).toBe(false);
  expect(res.dryRun).toBe(true);
  expect(res.wouldSend).toContain("escalation (unverified)");
  expect(res.wouldSend).not.toContain("escalation");
  expect(res.escalation).toBeUndefined();
  expect(res.channels).toEqual([]);
});

test("default notify hook used when present and executable", async () => {
  const tempConfigDir = mkdtempSync(join(tmpdir(), "herdr-jev-cfg-"));
  const hookFile = join(tempConfigDir, "notify-hook");
  writeFileSync(hookFile, "#!/bin/sh\nexit 0\n");
  chmodSync(hookFile, 0o755);

  const env = {
    HERDR_PLUGIN_ID: "herdr-jev",
    HERDR_PLUGIN_CONFIG_DIR: tempConfigDir,
  };
  expect(resolveNotifyHook(env)).toBe(hookFile);

  const savedHook = process.env.HERDR_JEV_NOTIFY_HOOK;
  const savedPluginId = process.env.HERDR_PLUGIN_ID;
  const savedPluginConfig = process.env.HERDR_PLUGIN_CONFIG_DIR;
  try {
    delete process.env.HERDR_JEV_NOTIFY_HOOK;
    process.env.HERDR_PLUGIN_ID = "herdr-jev";
    process.env.HERDR_PLUGIN_CONFIG_DIR = tempConfigDir;
    const runner = async () => ({ ok: true, stdout: "" });
    const res = await handleNotifyCommand({
      pane: "w1:hook1", name: "Ada", project: "StixLab",
      attention: "now", reason: "approval", dryRun: true
    }, runner);
    expect(res.wouldSend).toContain("hook");
  } finally {
    if (savedHook !== undefined) process.env.HERDR_JEV_NOTIFY_HOOK = savedHook;
    else delete process.env.HERDR_JEV_NOTIFY_HOOK;
    if (savedPluginId !== undefined) process.env.HERDR_PLUGIN_ID = savedPluginId;
    else delete process.env.HERDR_PLUGIN_ID;
    if (savedPluginConfig !== undefined) process.env.HERDR_PLUGIN_CONFIG_DIR = savedPluginConfig;
    else delete process.env.HERDR_PLUGIN_CONFIG_DIR;
    rmSync(tempConfigDir, { recursive: true, force: true });
  }
});

test("default notify hook ignored when not executable", () => {
  const tempConfigDir = mkdtempSync(join(tmpdir(), "herdr-jev-cfg-"));
  const hookFile = join(tempConfigDir, "notify-hook");
  writeFileSync(hookFile, "#!/bin/sh\nexit 0\n");
  chmodSync(hookFile, 0o644);

  const env = {
    HERDR_PLUGIN_ID: "herdr-jev",
    HERDR_PLUGIN_CONFIG_DIR: tempConfigDir,
  };
  try {
    expect(resolveNotifyHook(env)).toBeUndefined();
  } finally {
    rmSync(tempConfigDir, { recursive: true, force: true });
  }
});

test("notify hook disabled with off or empty string", () => {
  const tempConfigDir = mkdtempSync(join(tmpdir(), "herdr-jev-cfg-"));
  const hookFile = join(tempConfigDir, "notify-hook");
  writeFileSync(hookFile, "#!/bin/sh\nexit 0\n");
  chmodSync(hookFile, 0o755);

  const envOff = {
    HERDR_JEV_NOTIFY_HOOK: "off",
    HERDR_PLUGIN_ID: "herdr-jev",
    HERDR_PLUGIN_CONFIG_DIR: tempConfigDir,
  };
  const envEmpty = {
    HERDR_JEV_NOTIFY_HOOK: "",
    HERDR_PLUGIN_ID: "herdr-jev",
    HERDR_PLUGIN_CONFIG_DIR: tempConfigDir,
  };
  try {
    expect(resolveNotifyHook(envOff)).toBeUndefined();
    expect(resolveNotifyHook(envEmpty)).toBeUndefined();
  } finally {
    rmSync(tempConfigDir, { recursive: true, force: true });
  }
});

test("explicit notify hook variable wins over default file", () => {
  const tempConfigDir = mkdtempSync(join(tmpdir(), "herdr-jev-cfg-"));
  const defaultHook = join(tempConfigDir, "notify-hook");
  writeFileSync(defaultHook, "#!/bin/sh\nexit 0\n");
  chmodSync(defaultHook, 0o755);

  const explicitHook = join(tmpdir(), "custom-hook");
  const env = {
    HERDR_JEV_NOTIFY_HOOK: explicitHook,
    HERDR_PLUGIN_ID: "herdr-jev",
    HERDR_PLUGIN_CONFIG_DIR: tempConfigDir,
  };
  try {
    expect(resolveNotifyHook(env)).toBe(explicitHook);
  } finally {
    rmSync(tempConfigDir, { recursive: true, force: true });
  }
});

test("state dir resolver throws state_dir_required_in_tests under test guard", () => {
  expect(() => resolveStateDir({ HERDR_JEV_TEST_GUARD: "1" })).toThrow("state_dir_required_in_tests");
  expect(() => resolveStateDir({ HERDR_JEV_TEST_GUARD: "1", HERDR_PLUGIN_ID: "other-plugin", HERDR_PLUGIN_STATE_DIR: "/tmp/other" })).toThrow("state_dir_required_in_tests");
  expect(resolveStateDir({ HERDR_JEV_TEST_GUARD: "1", HERDR_JEV_STATE_DIR: "/tmp/custom-state" })).toBe("/tmp/custom-state");
  expect(resolveStateDir({ HERDR_JEV_TEST_GUARD: "1", HERDR_PLUGIN_ID: "herdr-jev", HERDR_PLUGIN_STATE_DIR: "/tmp/herdr-plugin-state" })).toBe("/tmp/herdr-plugin-state");
});

test("notify command fails when state dir is missing under test guard", async () => {
  const savedStateDir = process.env.HERDR_JEV_STATE_DIR;
  const savedPluginStateDir = process.env.HERDR_PLUGIN_STATE_DIR;
  delete process.env.HERDR_JEV_STATE_DIR;
  delete process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_JEV_NOTIFY = "1";
  const runner = async () => ({ ok: true, stdout: "" });
  try {
    let threw = false;
    try {
      await handleNotifyCommand({
        pane: "w1:p1", name: "Ada", project: "StixLab",
        attention: "now", reason: "approval", dryRun: false
      }, runner);
    } catch (e: any) {
      threw = true;
      expect(e.message).toBe("state_dir_required_in_tests");
    }
    expect(threw).toBe(true);
  } finally {
    if (savedStateDir !== undefined) process.env.HERDR_JEV_STATE_DIR = savedStateDir;
    if (savedPluginStateDir !== undefined) process.env.HERDR_PLUGIN_STATE_DIR = savedPluginStateDir;
  }
});
