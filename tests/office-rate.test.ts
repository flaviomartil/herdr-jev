import { expect, test } from "bun:test";
import { readFileSync, writeFileSync, chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterAll } from "bun:test";
import { join, resolve } from "node:path";


const tempDir = mkdtempSync(join(tmpdir(), 'herdr-jev-rate-'));
afterAll(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
  delete process.env.HERDR_OFFICE_TEST_UNIT;
  delete process.env.HERDR_JEV_CLASSIFY;
  delete process.env.HERDR_JEV_BIN;
  delete process.env.HERDR_JEV_ESCALATE_BLOCKED;
});

test("rate policy a to d", async () => {
  process.env.HERDR_OFFICE_TEST_UNIT = "1";
  process.env.HERDR_JEV_CLASSIFY = "1";
  const office = await import("../herdr-plugin/office/office.mjs");
  const { 
    pollJevClassify, classifyCache, classifyCountMinute, classifyMinuteStart, 
    paneRevisions, classifyTimestamps, roster 
  } = office._testHooks;

  office._testHooks.roster.people = [];
  
  let readCount = 0;
  office._testHooks.api = {
    request: async (cmd: string, args: any) => {
      readCount++;
      return { read: { text: "mock output " + args.target } };
    }
  };

  const fakeBin = join(tempDir, "fake-jev-classify.sh");
  writeFileSync(fakeBin, `#!/bin/sh
echo '{"state":"blocked","stateConfidence":0.92,"attention":"now","attentionScore":1.87,"attentionConfidence":0.81,"blockedReason":"approval","blockedReasonConfidence":0.48,"activity":"unknown","activityConfidence":0,"jevMs":942,"model":"jev-1.13.0"}'
`);
  chmodSync(fakeBin, "755");
  process.env.HERDR_JEV_BIN = fakeBin;

  office._testHooks.roster.people = [
    { id: "p1", revision: 1, status: "blocked", cwd: "/test" },
    { id: "p2", revision: 1, status: "idle", cwd: "/test" },
    { id: "p3", revision: 1, status: "working", cwd: "/test" }
  ];

  office._testHooks.classifyCountMinute = 0;
  office._testHooks.classifyMinuteStart = Date.now();

  await pollJevClassify();
  expect(readCount).toBe(1); 
  expect(office._testHooks.classifyCountMinute).toBe(1);
  
  await pollJevClassify();
  expect(readCount).toBe(1);

  await pollJevClassify();
  expect(readCount).toBe(3); 
  expect(office._testHooks.classifyCountMinute).toBe(3);

  await pollJevClassify();
  expect(readCount).toBe(3); 
  expect(office._testHooks.classifyCountMinute).toBe(3);

  office._testHooks.classifyCountMinute = 20;
  office._testHooks.roster.people.push({ id: "p4", revision: 1, status: "working", cwd: "/test" });
  await pollJevClassify();
  expect(office._testHooks.classifyCountMinute).toBe(20);

  office._testHooks.classifyMinuteStart = Date.now() - 61000;
  await pollJevClassify();
  expect(office._testHooks.classifyCountMinute).toBe(1); 
});

test("office transition calls notify exactly once per revision", async () => {
  const office = require("../herdr-plugin/office/office.mjs");
  const { officeOwner } = await import("../herdr-plugin/office/src/notify-args.mjs");
  const { notifyPending, roster } = office._testHooks;
  notifyPending.length = 0;
  
  roster.people = [{
    id: "p_notify", title: "Task", cwd: "/test", status: "idle", revision: 1, 
    focused: false, kind: "codex"
  }];
  
  office._testHooks.classifyHashes.set("p_notify", "hash1");
  office._testHooks.classifyCache.set("hash1", { attention: "now", state: "blocked", confidence: 0.9, blockedReason: "none" });
  
  office._testHooks.applyJevData();
  await new Promise(r => setTimeout(r, 100));
  
  expect(notifyPending.length).toBe(1);
  expect(notifyPending[0].args).toEqual(['notify', '--pane', 'p_notify', '--project', 'test', '--task', 'Task', '--attention', 'now', '--reason', 'none', '--confidence', '0.9', '--native-status', 'idle', '--jev-state', 'blocked', '--reason-confidence', '0', '--agent', 'codex', '--owner', officeOwner, '--json']);
  
  notifyPending.length = 0;
  
  office._testHooks.applyJevData();
  await new Promise(r => setTimeout(r, 100));
  expect(notifyPending.length).toBe(0);
  
  process.env.HERDR_JEV_ESCALATE_BLOCKED = "1";
  office._testHooks.notifyState.get("p_notify").escalatedRev = 1;

  roster.people[0].revision = 2;
  office._testHooks.applyJevData();
  await new Promise(r => setTimeout(r, 100));
  expect(notifyPending.length).toBe(1); 
  expect(notifyPending[0].args[1]).toBe('--release');
  if (notifyPending[0].onResult) notifyPending[0].onResult({ sent: true });
  notifyPending.length = 0;

  office._testHooks.classifyCache.set("hash1", { attention: "none", state: "idle", confidence: 0.9 });
  office._testHooks.applyJevData();
  await new Promise(r => setTimeout(r, 100));
  expect(notifyPending.length).toBe(0); 
  
  roster.people[0].revision = 3;
  office._testHooks.classifyCache.set("hash1", { attention: "now", state: "blocked", confidence: 0.9 });
  office._testHooks.applyJevData();
  await new Promise(r => setTimeout(r, 100));
  expect(notifyPending.length).toBe(1);
  expect(notifyPending[0].args[1]).toBe('--pane');
});

test("office.mjs contains no spawnSync or require", () => {
  const content = readFileSync(join(import.meta.dir, "../herdr-plugin/office/office.mjs"), "utf-8");
  expect(content).not.toMatch(/require\(/);
  const spawnSyncMatches = [...content.matchAll(/spawnSync/g)];
  expect(spawnSyncMatches.length).toBe(0);
});

test("explicit progress skips classification, expires and refuses reused panes", async () => {
  process.env.HERDR_OFFICE_TEST_UNIT = "1";
  process.env.HERDR_JEV_CLASSIFY = "1";
  process.env.HERDR_JEV_BIN = join(tempDir, "fake-jev-classify.sh");
  const office = await import("../herdr-plugin/office/office.mjs");
  const hooks = office._testHooks;
  hooks.notifyPending.length = 0;
  const person: any = { id: "progress-pane", terminalId: "terminal", sessionId: "native", kind: "codex",
    cwd: "/test", status: "working", revision: 1, focused: true };
  hooks.roster.people = [person];
  let reads = 0;
  hooks.api = { request: async () => { reads++; return { read: { text: "progress test output" } }; } };
  const report = { terminalId: "terminal", sessionId: "native", agent: "codex", cwd: "/test", activity: "Testing",
    percent: 40, reason: "none", reportedAt: Date.now(), expiresAt: Date.now() + 300_000 };
  const data = { state: "working", report, attention: "none", attentionReason: null };
  hooks.jevCache.set(person.id, data);
  hooks.applyJevData();
  expect(person.jevActivity).toBe("~40% Testing");
  await hooks.pollJevClassify();
  expect(reads).toBe(0);
  person.terminalId = "replacement";
  hooks.applyJevData();
  expect(person.jevReport).toBeNull();
  expect(person.jevActivity).toBeNull();
  person.terminalId = "terminal";
  hooks.applyJevData();
  expect(person.jevReport).not.toBeNull();
  report.expiresAt = Date.now() - 1;
  hooks.applyJevData();
  expect(person.jevActivity).toBeNull();
  await hooks.pollJevClassify();
  expect(reads).toBe(1);
  hooks.jevCache.delete(person.id);
});
