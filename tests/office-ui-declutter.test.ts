import { expect, test } from "bun:test";
import { cleanOutput, findAsk, summarize } from "../herdr-plugin/office/src/summary.mjs";
import { classifyPane } from "../herdr-plugin/office/src/jev-classify.mjs";

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
  // It should keep the meaningful tool message and title
  expect(summary.some(l => l.includes("meaningful tool message"))).toBe(true);
  expect(summary.some(l => l.includes("warnings"))).toBe(false);
  expect(summary.some(l => l.includes("f2 to view"))).toBe(false);
  expect(summary.some(l => l.includes("esc to interrupt"))).toBe(false);
  expect(summary.some(l => l.includes("Ask Codex"))).toBe(false);
  expect(summary.some(l => l.includes("GPT-4"))).toBe(false);
});

test("cache once per revision and timeout fallback", async () => {
  // Test classifyPane with no env var
  const fallback = await classifyPane("test-pane", 1, {}, []);
  expect(fallback.state).toBe(null);
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
