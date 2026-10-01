import { expect, test } from "bun:test";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";

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

  const fakeBin = join(import.meta.dir, "fake-jev-classify.sh");
  writeFileSync(fakeBin, `#!/bin/sh\necho '{"state":"blocked","stateConfidence":0.92,"attention":"now","attentionScore":1.87,"attentionConfidence":0.81,"blockedReason":"approval","blockedReasonConfidence":0.48,"activity":"unknown","activityConfidence":0,"jevMs":942,"model":"jev-1.13.0"}'\n`);
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

test("office transition calls notify exactly once per revision", () => {
  const office = require("../herdr-plugin/office/office.mjs");
  const { notifyPending, roster } = office._testHooks;
  notifyPending.length = 0;
  
  roster.people = [{
    id: "p_notify", title: "Task", cwd: "/test", status: "idle", revision: 1, 
    focused: false, kind: "codex"
  }];
  
  office._testHooks.classifyHashes.set("p_notify", "hash1");
  office._testHooks.classifyCache.set("hash1", { attention: "now", state: "blocked", confidence: 0.9, blockedReason: "none" });
  
  office._testHooks.applyJevData();
  
  expect(notifyPending.length).toBe(1);
  expect(notifyPending[0].args).toEqual(['notify', '--pane', 'p_notify', '--project', 'test', '--task', 'Task', '--attention', 'now', '--reason', 'none', '--confidence', '0.9', '--native-status', 'idle', '--agent', 'codex', '--json']);
  
  notifyPending.length = 0;
  
  office._testHooks.applyJevData();
  expect(notifyPending.length).toBe(0);
  
  process.env.HERDR_JEV_ESCALATE_BLOCKED = "1";
  office._testHooks.notifyState.get("p_notify").escalatedRev = 1;

  roster.people[0].revision = 2;
  office._testHooks.applyJevData();
  expect(notifyPending.length).toBe(1); 
  expect(notifyPending[0].args[1]).toBe('--release');
  notifyPending.length = 0;

  office._testHooks.classifyCache.set("hash1", { attention: "none", state: "idle", confidence: 0.9 });
  office._testHooks.applyJevData();
  expect(notifyPending.length).toBe(0); 
  
  roster.people[0].revision = 3;
  office._testHooks.classifyCache.set("hash1", { attention: "now", state: "blocked", confidence: 0.9 });
  office._testHooks.applyJevData();
  expect(notifyPending.length).toBe(1);
  expect(notifyPending[0].args[1]).toBe('--pane');
});

test("office.mjs contains no spawnSync or require", () => {
  const content = readFileSync(join(import.meta.dir, "../herdr-plugin/office/office.mjs"), "utf-8");
  expect(content).not.toMatch(/spawnSync/);
  expect(content).not.toMatch(/require\(/);
});
