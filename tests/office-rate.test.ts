import { expect, test } from "bun:test";

test("rate policy a to d", async () => {
  process.env.HERDR_OFFICE_TEST_UNIT = "1";
  process.env.HERDR_JEV_CLASSIFY = "1";
  const office = await import("../herdr-plugin/office/office.mjs");
  const { 
    pollJevClassify, classifyCache, classifyCountMinute, classifyMinuteStart, 
    paneRevisions, classifyTimestamps, roster 
  } = office._testHooks;

  // Fake roster
  office._testHooks.roster.people = [];
  
  // Fake api
  let readCount = 0;
  office._testHooks.api = {
    request: async (cmd, args) => {
      readCount++;
      return { read: { text: "mock output " + args.target } };
    }
  };

  // Ensure mock jev-classify.mjs?
  // Wait, office.mjs imports classifyPane from src/jev-classify.mjs.
  // We can't mock imports easily in ES modules unless we use bun's mock or something.
  // Actually, we can just let it call `herdr-jev classify-pane --json`? 
  // No, the instruction says "fake classifier". 
  // I'll create a fake HERDR_JEV_BIN script!
  const fs = require("node:fs");
  const path = require("node:path");
  const fakeBin = path.join(import.meta.dir, "fake-jev-classify.sh");
  fs.writeFileSync(fakeBin, `#!/bin/sh\ncat ${path.resolve(import.meta.dir, "fixtures/jev-classify-raw-blocked.json")} | sed 's/.*//g'\necho '{"state":"blocked","stateConfidence":0.92,"attention":"now","attentionScore":1.87,"attentionConfidence":0.81,"blockedReason":"approval","blockedReasonConfidence":0.48,"activity":"unknown","activityConfidence":0,"jevMs":942,"model":"jev-1.13.0"}'\n`);
  fs.chmodSync(fakeBin, "755");
  process.env.HERDR_JEV_BIN = fakeBin;

  // (a) Key cache by hash of cleaned last 30 lines + native status, LRU 200
  office._testHooks.roster.people = [
    { id: "p1", revision: 1, status: "blocked", cwd: "/test" },
    { id: "p2", revision: 1, status: "idle", cwd: "/test" },
    { id: "p3", revision: 1, status: "working", cwd: "/test" }
  ];

  office._testHooks.classifyCountMinute = 0;
  office._testHooks.classifyMinuteStart = Date.now();

  // Tick 1
  await pollJevClassify();
  
  // They are not working (p1, p2), so they need 2 stable ticks.
  // p3 is working, so it will be classified immediately.
  expect(readCount).toBe(1); // Only p3 was read!
  expect(office._testHooks.classifyCountMinute).toBe(1);
  
  // Tick 2
  await pollJevClassify();
  expect(readCount).toBe(1);

  // Tick 3
  await pollJevClassify();
  expect(readCount).toBe(3); // p1 and p2 read now (stable for 2 ticks).
  expect(office._testHooks.classifyCountMinute).toBe(3);

  // If we run it again, p3 is working and < 60s, so skipped.
  // p1 and p2 have stable text and haven't changed rev, so stableTicks increases, but their text is the SAME. 
  // They will be skipped because of cache!
  await pollJevClassify();
  expect(readCount).toBe(5); // read to check hash!
  expect(office._testHooks.classifyCountMinute).toBe(3);

  // Now, global cap of 20 per minute.
  office._testHooks.classifyCountMinute = 20;
  // Make a new person
  office._testHooks.roster.people.push({ id: "p4", revision: 1, status: "working", cwd: "/test" });
  await pollJevClassify();
  // It shouldn't classify because cap reached
  expect(office._testHooks.classifyCountMinute).toBe(20);

  // If time passes > 60s
  office._testHooks.classifyMinuteStart = Date.now() - 61000;
  await pollJevClassify();
  // Minute start resets, count drops to 0, p4 gets classified
  expect(office._testHooks.classifyCountMinute).toBe(1); 
});

test("office transition calls notify exactly once per revision", () => {
  const office = require("../herdr-plugin/office/office.mjs");
  const { notifyPending, roster } = office._testHooks;
  notifyPending.length = 0;
  
  // Set up a person
  roster.people = [{
    id: "p_notify", name: "Ada", cwd: "/test", status: "idle", revision: 1, 
    focused: false, kind: "codex"
  }];
  
  // (Mock DEMO=false logic for testing)
  // Actually, DEMO is a top-level const in office.mjs based on args. 
  // Wait, if it runs with --demo it sets DEMO=true. We run without args, so DEMO=false.
  
  // Set classifyHashes to mock the classification
  office._testHooks.classifyHashes.set("p_notify", "hash1");
  office._testHooks.classifyCache.set("hash1", { attention: "now", state: "blocked", confidence: 0.9 });
  
  office._testHooks.applyJevData();
  
  expect(notifyPending.length).toBe(1);
  expect(notifyPending[0]).toEqual(['notify', '--pane', 'p_notify', '--name', 'Ada', '--project', 'test', '--attention', 'now', '--reason', 'none', '--confidence', '0.9', '--native-status', 'idle', '--agent', 'codex']);
  
  // Clear it
  notifyPending.length = 0;
  
  // Run again, should not notify because revision hasn't changed
  office._testHooks.applyJevData();
  expect(notifyPending.length).toBe(0);
  
  // Change revision, run again. Attention is still 'now', so attentionChanged is false, BUT since it's already 'now', wait!
  // It only triggers if `(attentionChanged || blockedChanged)`. If it's already 'now', it won't re-trigger unless it changed?
  // The requirement: "when a primary desk's attention label transitions to 'now' ... call 'herdr-jev notify ...' once per pane and revision"
  // So if it's already 'now', it doesn't trigger on revision change unless attention dropped and came back.
  roster.people[0].revision = 2;
  office._testHooks.applyJevData();
  expect(notifyPending.length).toBe(1); 
  expect(notifyPending[0][1]).toBe('--release');
  notifyPending.length = 0;

  // Now drop it to 'none'
  office._testHooks.classifyCache.set("hash1", { attention: "none", state: "idle", confidence: 0.9 });
  office._testHooks.applyJevData();
  expect(notifyPending.length).toBe(0); // attention dropping does not trigger notify, and escalatedRev was already cleared

  // Now back to 'now'
  roster.people[0].revision = 3;
  office._testHooks.classifyCache.set("hash1", { attention: "now", state: "blocked", confidence: 0.9 });
  office._testHooks.applyJevData();
  expect(notifyPending.length).toBe(1);
  expect(notifyPending[0][1]).toBe('--pane');
});
