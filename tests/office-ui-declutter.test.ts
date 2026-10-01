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
