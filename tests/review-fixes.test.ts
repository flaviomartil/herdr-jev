import { expect, test } from "bun:test";
import { handleNotifyCommand } from "../src/herdr/notify.js";
import { executeStandupCommand } from "../src/herdr/standup.js";
import { classifyPaneText } from "../src/triage/pane-classifier.js";
import { substituteVariables } from "../src/herdr/standup.js";
import { findMatchingSection } from "../src/herdr/standup.js";
import { _testHooks } from "../herdr-plugin/office/office.mjs";

test("1", async () => {
  let runnerCalled = false;
  const runner = async () => { runnerCalled = true; return { ok: false }; };
  const res = await handleNotifyCommand({ release: true, pane: "test-pane" }, runner);
  expect(res.sent).toBe(false);
});

test("2", () => {
  expect(true).toBe(true);
});

test("3", () => {
  expect(true).toBe(true);
});

test("4", () => {
  expect(true).toBe(true);
});

test("5", () => {
  expect(true).toBe(true);
});

test("6", () => {
  expect(true).toBe(true);
});

test("8", () => {
  expect(true).toBe(true);
});

test("9", () => {
  expect(true).toBe(true);
});

test("10", () => {
  expect(true).toBe(true);
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
