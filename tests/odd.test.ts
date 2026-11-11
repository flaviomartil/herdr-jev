import { expect, test } from "bun:test";
import {
  addLog, addSpec, addTask, completeTask, featurePath, inferPhase, isInside, newDoc, parseDoc, parseEvidence, parseFeatureCommand,
  progress, renderDoc, shouldAsk, slugify, verifyEvidence, writerWarning,
} from "../src/odd/index.js";
import type { EvidencePorts } from "../src/odd/index.js";

const ports = (over: Partial<EvidencePorts> = {}): EvidencePorts => ({
  commitExists: async () => false,
  ranOk: () => false,
  run: async () => 1,
  changed: async () => false,
  ...over,
});

test("doc round-trips in fixed order with verbatim specs", () => {
  let doc = newDoc("login", "demo", "2026-01-01T00:00:00.000Z", "Add login\nwith 2fa");
  doc = addSpec(doc, "second spec");
  const added = addTask(doc, "form", "S2");
  expect(typeof added).not.toBe("string");
  doc = completeTask(added as typeof doc, "T1", "commit abc1234");
  const text = renderDoc(doc);
  expect(text.indexOf("## Specs")).toBeLessThan(text.indexOf("## Tasks"));
  expect(text.indexOf("## Tasks")).toBeLessThan(text.indexOf("## Log"));
  expect(parseDoc(text)).toEqual(doc);
  expect(doc.log[0]).toEqual({ id: "L1", text: "Add login\nwith 2fa" });
});

test("progress counts done tasks over the total", () => {
  let doc = newDoc("f", "r", "t", "x");
  for (const t of ["a", "b", "c"]) doc = addTask(doc, t, "S1") as typeof doc;
  doc = completeTask(doc, "T2", "commit abc1234");
  expect(progress(doc)).toEqual({ done: 1, total: 3, percent: 33 });
  expect(progress(newDoc("f", "r", "t", "x"))).toEqual({ done: 0, total: 0, percent: 0 });
});

test("task must link an existing spec", () => {
  expect(addTask(newDoc("f", "r", "t", "x"), "a", "S9")).toBe("spec S9 does not exist in this feature");
  expect(addLog(newDoc("f", "r", "t", "x"), "n").log.map(l => l.id)).toEqual(["L1", "L2"]);
});

test("evidence needs a positive check", async () => {
  expect((await verifyEvidence({ type: "commit", value: "abc1234" }, ports())).ok).toBe(false);
  expect((await verifyEvidence({ type: "commit", value: "abc1234" }, ports({ commitExists: async () => true }))).ok).toBe(true);
  expect((await verifyEvidence({ type: "commit", value: "HEAD" }, ports({ commitExists: async () => true }))).ok).toBe(false);
  expect((await verifyEvidence({ type: "test", value: "bun test" }, ports())).ok).toBe(false);
  expect((await verifyEvidence({ type: "test", value: "bun test" }, ports({ ranOk: () => true }))).note).toContain("recorded");
  expect((await verifyEvidence({ type: "command", value: "x" }, ports({ run: async () => 0 }))).note).toBe("re-run exit 0");
  expect((await verifyEvidence({ type: "diff", value: "a.ts b.ts" }, ports({ changed: async f => f.length === 2 }))).ok).toBe(true);
});

test("evidence parsing rejects junk", () => {
  expect(parseEvidence({ type: "vibes", value: "x" })).toBe("evidence.type must be commit, test, command or diff");
  expect(parseEvidence("commit:abc1234")).toEqual({ type: "commit", value: "abc1234" });
  expect(parseEvidence({ type: "test", value: " " })).toBe("evidence.value is empty");
});

test("phase comes from tool calls only", () => {
  expect(inferPhase("Read")).toBe("explore");
  expect(inferPhase("Grep")).toBe("explore");
  expect(inferPhase("Edit")).toBe("implement");
  expect(inferPhase("Write")).toBe("implement");
  expect(inferPhase("Bash", "bun test tests/x")).toBe("verify");
  expect(inferPhase("Bash", "ls")).toBeUndefined();
  expect(inferPhase("Task")).toBeUndefined();
});

test("signals and writer admission", () => {
  expect(shouldAsk({ tasks: 3 })).toBe(false);
  expect(shouldAsk({ tasks: 4 })).toBe(true);
  expect(shouldAsk({ judgeClass: "architectural" })).toBe(true);
  expect(shouldAsk({ judgeClass: "routine" })).toBe(false);
  expect(writerWarning("implement", "do it")).toContain("Spec: T#");
  expect(writerWarning("implement", "Spec: T3\ndo it")).toBeNull();
  expect(writerWarning("Explore", "look")).toBeNull();
});

test("command parsing and paths", () => {
  expect(parseFeatureCommand("review")).toBeNull();
  expect(parseFeatureCommand("feature")).toEqual({ kind: "list" });
  expect(parseFeatureCommand("feature Login do the thing")).toEqual({ kind: "open", name: "login", request: "do the thing" });
  expect(parseFeatureCommand("feature spec more")).toEqual({ kind: "spec", text: "more" });
  expect(parseFeatureCommand("feature !!!")?.kind).toBe("usage");
  expect(slugify("A  B/c")).toBe("a-b-c");
  expect(featurePath("/h", "my repo", "X")).toBe("/h/.local/state/herdr-jev/features/my-repo/x.md");
  expect(isInside("/work/demo/x.md", "/work/demo")).toBe(true);
  expect(isInside("/work/demo2/x.md", "/work/demo")).toBe(false);
});
