import { expect, test } from "bun:test";
import { NAMES, avatarRuns, nameFor, Roster, avatar, avatarSignature, avatarText, cliKind, nickname, parseRosterFile } from "../src/identity/index.js";
import { readFileSync } from "node:fs";

test("names are assigned by arrival order and stay stable", () => {
  const r = new Roster();
  expect([r.name("a"), r.name("b"), r.name("a"), r.name("c")]).toEqual(["Ada", "Bo", "Ada", "Cass"]);
  expect(nickname(NAMES.length)).toBe("Ada2");
});

test("personal roster overrides the default list and ignores junk", () => {
  expect(parseRosterFile('{"names":["Zoe"," ",3]}')).toEqual(["Zoe"]);
  expect(parseRosterFile("not json")).toEqual([]);
  expect(new Roster(["Zoe"]).name("x")).toBe("Zoe");
});

test("cli kind is detected from client and model", () => {
  expect(cliKind("codex")).toBe("codex");
  expect(cliKind("agy")).toBe("agy");
  expect(cliKind("claude", "claude-haiku-5")).toBe("haiku");
  expect(cliKind("claude", "opus")).toBe("claude");
  expect(cliKind("kimi")).toBe("other");
});

test("avatars differ per CLI, stay stable per id and vary by hash", () => {
  const kinds = ["claude", "codex", "agy", "haiku"] as const;
  const sigs = kinds.map((k) => avatarSignature(avatar(k, "same-id")));
  expect(new Set(sigs).size).toBe(4);
  expect(new Set(kinds.map((k) => avatarText(avatar(k, "x")).join("|"))).size).toBe(4);
  expect(avatarSignature(avatar("codex", "id1"))).toBe(avatarSignature(avatar("codex", "id1")));
  const varied = new Set(Array.from({ length: 20 }, (_, i) => avatarSignature(avatar("claude", `id${i}`))));
  expect(varied.size).toBeGreaterThan(3);
  expect(avatar("agy", "q").rows).toHaveLength(2);
});

test("plugin copy of identity stays in sync with src", () => {
  expect(readFileSync("claude-plugin/hooks/identity-core.ts", "utf8")).toBe(readFileSync("src/identity/index.ts", "utf8"));
});

test("avatar cells always carry a background and runs merge", () => {
  const av = avatar("codex", "z");
  for (const row of av.rows) for (const c of row) expect(c.bg).toBeDefined();
  const runs = avatarRuns(av);
  expect(runs[0].length).toBeLessThan(6);
  expect(runs[0].map((r) => r.text).join("")).toBe(avatarText(av)[0]);
});

test("nameFor follows stored order and falls back after it", () => {
  expect(nameFor({ a: 2 }, "a", 0)).toBe("Cass");
  expect(nameFor({ a: 0 }, "new", 1)).toBe("Cass");
});
