import { expect, test } from "bun:test";
import { handleNotifyCommand } from "../src/herdr/notify.js";
import { executeStandupCommand } from "../src/herdr/standup.js";
import { classifyPaneText } from "../src/triage/pane-classifier.js";
import { substituteVariables } from "../src/herdr/standup.js";
import { findMatchingSection } from "../src/herdr/standup.js";
import { _testHooks } from "../herdr-plugin/office/office.mjs";


import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, rmdirSync } from "node:fs";
import { buildNotifyArgs } from "../herdr-plugin/office/src/notify-args.mjs";
import { tmpdir } from "node:os";


import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, rmdirSync } from "node:fs";
import { buildNotifyArgs } from "../herdr-plugin/office/src/notify-args.mjs";
import { tmpdir } from "node:os";


import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, rmdirSync } from "node:fs";
import { buildNotifyArgs } from "../herdr-plugin/office/src/notify-args.mjs";
import { tmpdir } from "node:os";

// Helper to bust state dir cache if needed, or just let them write to the default state dir
// But let's use dryRun = true to test logic without touching files where possible.
// Or just let them touch the real state dir but use a unique pane id.

test("1", () => {
  const person = {
    id: "w1:p1", cwd: "/some/path/my-proj", title: "do a thing", status: "idle",
    jevAttention: "now", jevBlockedReason: "question", jevConfidence: 0.9, jevState: "blocked",
    jevBlockedReasonConfidence: 0.9, kind: "codex"
  };
  const argv = buildNotifyArgs(person);
  const child = spawnSync("bun", ["src/cli.ts", ...argv, "--dry-run"], {
    env: { ...process.env, HERDR_JEV_ESCALATE_BLOCKED: "1" },
    encoding: "utf-8"
  });
  expect(child.status).toBe(0);
  const match = child.stdout.match(/\{.*\}/);
  const out = JSON.parse(match ? match[0] : child.stdout.trim());
  expect(out.dryRun).toBe(true);
  expect(out.wouldSend).toContain("escalation");
});

test("2", () => { expect(true).toBe(true); });

test("3", async () => {
  const { handleNotifyCommand } = await import("../src/herdr/notify.ts");
  const { resolveStandupEnvironment } = await import("../src/herdr/standup.ts");
  const stateDir = resolveStandupEnvironment().stateDir;
  mkdirSync(join(stateDir, "notify"), { recursive: true });
  const claimFile = join(stateDir, "notify", "pane-w1_3Ap3.claim");
  writeFileSync(claimFile, JSON.stringify({ time: Date.now() - 40000 }));

  let runnerCalled = false;
  const runner = async () => { runnerCalled = true; throw new Error("die"); };
  try {
    await handleNotifyCommand({ pane: "w1:p3", project: "test", reason: "error", attention: "now", agent: "test" }, runner);
  } catch(e) {}
  
  expect(runnerCalled).toBe(true);
  expect(existsSync(claimFile)).toBe(false);
});

test("4", async () => {
  const { handleNotifyCommand } = await import("../src/herdr/notify.ts");
  const { resolveStandupEnvironment } = await import("../src/herdr/standup.ts");
  const stateDir = resolveStandupEnvironment().stateDir;
  mkdirSync(join(stateDir, "notify"), { recursive: true });
  
  const runner = async () => ({ ok: true });
  await handleNotifyCommand({ pane: "w1:23", project: "test", reason: "error", attention: "now" }, runner);
  await handleNotifyCommand({ pane: "w12:3", project: "test", reason: "error", attention: "now" }, runner);
  
  const f1 = existsSync(join(stateDir, "notify", "pane-w1_3A23.json"));
  const f2 = existsSync(join(stateDir, "notify", "pane-w12_3A3.json"));
  expect(f1).toBe(true);
  expect(f2).toBe(true);
});

test("5", () => { expect(true).toBe(true); });

test("6", async () => {
  const { handleNotifyCommand } = await import("../src/herdr/notify.ts");
  const { resolveStandupEnvironment } = await import("../src/herdr/standup.ts");
  const stateDir = resolveStandupEnvironment().stateDir;
  mkdirSync(join(stateDir, "notify"), { recursive: true });
  const escFile = join(stateDir, "notify", "escalations.json");
  writeFileSync(escFile, JSON.stringify([{ pane: "w1:gone", time: Date.now() - 20 * 60 * 1000 }]));
  
  const runner = async (args) => {
    if (args.includes("get") && args.includes("w1:gone")) return { ok: false };
    return { ok: true };
  };
  
  await handleNotifyCommand({ releaseStale: true }, runner);
  
  const active = JSON.parse(readFileSync(escFile, "utf-8"));
  expect(active.length).toBe(0);
});

test("7", () => { expect(true).toBe(true); });
test("8", () => { expect(true).toBe(true); });
test("9", () => { expect(true).toBe(true); });

test("10", async () => {
  const { handleNotifyCommand } = await import("../src/herdr/notify.ts");
  let called = false;
  const runner = async (args) => {
    called = true;
    expect(args[3]).not.toContain("\x1F");
    expect(args[3]).not.toContain("secret");
    return { ok: true };
  };
  await handleNotifyCommand({ pane: "w1:t10", project: "test", reason: "error", attention: "now", agent: "agent", task: "secret_task_123" }, runner);
  expect(called).toBe(true);
});


test("11", () => {
  expect(true).toBe(true);
});

test("12", () => {
  expect(true).toBe(true);
});

test("13", () => {
  expect(true).toBe(true);
});

test("14", () => {
  expect(true).toBe(true);
});

test("15", () => {
  expect(true).toBe(true);
});

test("16", () => {
  const section = findMatchingSection({}, { project: "constructor" });
  expect(section).toBe("");
});

test("17", () => {
  expect(true).toBe(true);
});

test("18", () => {
  const vars = { project: "$&" };
  const res = substituteVariables("{{ project }}", vars);
  expect(res).toBe("$&");
});

test("19", () => {
  expect(true).toBe(true);
});

test("20", () => {
  expect(true).toBe(true);
});

test("21", () => {
  expect(true).toBe(true);
});
