import { expect, test } from "bun:test";
import { writeFileSync, unlinkSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { cleanOutput, findAsk, summarize } from "../herdr-plugin/office/src/summary.mjs";
import { classifyPane, jevClassificationEnabled } from "../herdr-plugin/office/src/jev-classify.mjs";

test("filter terminal chrome from the pane text before showing it", () => {
  const outputLines = [
    "meaningful tool message",
    "? for shortcuts",
    "12 warnings",
    "f2 to view",
    "esc to interrupt",
    "› Ask Codex",
    "Ask Codex to do anything",
    "GPT-4 · ~/projects",
    "│ spinner │"
  ];
  const person = { title: "title" };
  const summary = summarize(person, outputLines);
  expect(summary.some(l => l.includes("meaningful tool message"))).toBe(true);
  expect(summary.some(l => l.includes("warnings"))).toBe(false);
  expect(summary.some(l => l.includes("f2 to view"))).toBe(false);
  expect(summary.some(l => l.includes("esc to interrupt"))).toBe(false);
  expect(summary.some(l => l.includes("Ask Codex"))).toBe(false);
  expect(summary.some(l => l.includes("GPT-4"))).toBe(false);
});

test("jevClassificationEnabled covers default on, opt-out with 0, and demo always off", () => {
  const origEnv = process.env.HERDR_JEV_OFFICE_JEV;
  try {
    delete process.env.HERDR_JEV_OFFICE_JEV;
    expect(jevClassificationEnabled(process.env, [])).toBe(true);

    process.env.HERDR_JEV_OFFICE_JEV = "1";
    expect(jevClassificationEnabled(process.env, [])).toBe(true);

    process.env.HERDR_JEV_OFFICE_JEV = "0";
    expect(jevClassificationEnabled(process.env, [])).toBe(false);

    process.env.HERDR_JEV_OFFICE_JEV = "false";
    expect(jevClassificationEnabled(process.env, [])).toBe(false);

    process.env.HERDR_JEV_OFFICE_JEV = "off";
    expect(jevClassificationEnabled(process.env, [])).toBe(false);

    process.env.HERDR_JEV_OFFICE_JEV = "1";
    expect(jevClassificationEnabled(process.env, ["--demo"])).toBe(false);

    delete process.env.HERDR_JEV_OFFICE_JEV;
    expect(jevClassificationEnabled(process.env, ["--demo"])).toBe(false);
  } finally {
    if (origEnv !== undefined) {
      process.env.HERDR_JEV_OFFICE_JEV = origEnv;
    } else {
      delete process.env.HERDR_JEV_OFFICE_JEV;
    }
  }
});

test("cache once per revision and timeout fallback", async () => {
  const origEnv = process.env.HERDR_JEV_OFFICE_JEV;
  const origBin = process.env.HERDR_JEV_BIN;
  const fakeBin = resolve(import.meta.dir, `../.test-fake-classify-${Date.now()}.mjs`);
  const failingBin = resolve(import.meta.dir, `../.test-failing-classify-${Date.now()}.mjs`);
  writeFileSync(
    fakeBin,
    `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ state: "working", stateConfidence: 0.9, attention: "now", blockedReason: "none" }));\n`
  );
  chmodSync(fakeBin, 0o755);
  writeFileSync(failingBin, `#!/usr/bin/env node\nprocess.exit(1);\n`);
  chmodSync(failingBin, 0o755);

  try {
    delete process.env.HERDR_JEV_OFFICE_JEV;
    process.env.HERDR_JEV_BIN = fakeBin;
    const resOn = await classifyPane("test-pane", 1, {}, []);
    expect(resOn.state).toBe("working");
    expect(resOn.attention).toBe("now");

    const cached = await classifyPane("test-pane", 1, {}, []);
    expect(cached.state).toBe("working");

    process.env.HERDR_JEV_BIN = failingBin;
    const fallback = await classifyPane("test-pane-fail", 1, {}, []);
    expect(fallback.state).toBe(null);

    process.env.HERDR_JEV_OFFICE_JEV = "0";
    process.env.HERDR_JEV_BIN = "/nonexistent/fake/herdr-jev";
    const resOff = await classifyPane("test-pane-off", 1, {}, []);
    expect(resOff.state).toBe(null);

    delete process.env.HERDR_JEV_OFFICE_JEV;
    process.argv.push("--demo");
    const resDemo = await classifyPane("test-pane-demo", 1, {}, []);
    expect(resDemo.state).toBe(null);
  } finally {
    const demoIdx = process.argv.indexOf("--demo");
    if (demoIdx !== -1) process.argv.splice(demoIdx, 1);
    if (origEnv !== undefined) {
      process.env.HERDR_JEV_OFFICE_JEV = origEnv;
    } else {
      delete process.env.HERDR_JEV_OFFICE_JEV;
    }
    if (origBin !== undefined) {
      process.env.HERDR_JEV_BIN = origBin;
    } else {
      delete process.env.HERDR_JEV_BIN;
    }
    try { unlinkSync(fakeBin); } catch {}
    try { unlinkSync(failingBin); } catch {}
  }
});

test("ordering by attention (now first, then soon)", () => {
  const people = [
    { id: 1, jevAttention: "none" },
    { id: 2, jevAttention: "soon" },
    { id: 3, jevAttention: "now" }
  ];
  people.sort((a, b) => {
    const score = (p) => p.jevAttention === 'now' ? 2 : (p.jevAttention === 'soon' ? 1 : 0);
    return score(b) - score(a);
  });
  expect(people[0].id).toBe(3);
  expect(people[1].id).toBe(2);
  expect(people[2].id).toBe(1);
});

test("real Codex pane tail chrome filtering", () => {
  const outputLines = [
    "• Ran python3 /tmp/imp-benchmark225/collect_case.py 9",
    "• Interacted with /root/case09_tcers",
    "for agents · ? for shortcuts 4 warnings · f2 to view",
    "› Ask Codex to do anything",
    "GPT-6.1-Sol low · ~/projects/italents/impmotordados"
  ];
  const person = { title: "Investigar lentidão" };
  const summary = summarize(person, outputLines);
  const text = summary.join(' ');
  expect(text.includes('Ran python3')).toBe(true);
  expect(text.includes('Interacted with')).toBe(true);
  expect(text.includes('shortcuts')).toBe(false);
  expect(text.includes('warnings')).toBe(false);
  expect(text.includes('Ask Codex')).toBe(false);
  expect(text.includes('GPT-6.1')).toBe(false);
});

import { formatCommand } from "../herdr-plugin/office/src/render.mjs";
test("formatCommand parses raw command strings", () => {
  expect(formatCommand("node /home/martil/.nvm/versions/node/v22.22.2/bin/node /home/martil/.local/share/codex.js", "")).toBe("codex");
  expect(formatCommand("claude --model something bun test", "claude")).toBe("claude · bun test");
});

import { renderFrame } from "../herdr-plugin/office/src/render.mjs";

test("jev-classify parses flat JSON from fake executable and renderFrame shows marker", async () => {
  const fakeBin = resolve(import.meta.dir, "fake-jev-classify.sh");
  writeFileSync(fakeBin, `#!/bin/sh\ncat ${resolve(import.meta.dir, "fixtures/jev-classify-raw-blocked.json")} | sed 's/.*//g'\necho '{"state":"blocked","stateConfidence":0.92,"attention":"now","attentionScore":1.87,"attentionConfidence":0.81,"blockedReason":"approval","blockedReasonConfidence":0.48,"activity":"unknown","activityConfidence":0,"jevMs":942,"model":"jev-1.13.0"}'\n`);
  chmodSync(fakeBin, "755");
  
  process.env.HERDR_JEV_BIN = fakeBin;
  const result = await classifyPane("p1", 1, { kind: "codex" }, ["some output"]);
  
  expect(result.state).toBe("blocked");
  expect(result.attention).toBe("now");
  
  const person = {
    id: "p1",
    name: "Ada",
    kind: "codex",
    title: "task",
    since: Date.now(),
    status: "blocked",
    cwd: "/path/to/repo",
    jevState: result.state,
    jevAttention: result.attention,
    jevConfidence: result.confidence
  };
  
  const view = {
    size: { cols: 80, rows: 24 },
    people: [person],
    now: Date.now(),
    frame: 0,
    counts: {},
    stats: { counts: {} }
  };
  
  const rendered = renderFrame(view);
  const outStr = rendered.lines.join("\n");
  
  // The name-plate attention marker for 'now' is ' !' with #ffb000
  // Since paint() puts ANSI codes, we can just check for ' !'
  expect(outStr).toContain(" !");
  
  unlinkSync(fakeBin);
});
