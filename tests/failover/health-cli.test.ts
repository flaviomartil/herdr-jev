import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../src/failover/cli";

test("health cli locks, checks, clears and rejects bad input", () => {
  const env = { HERDR_JEV_HEALTH_DIR: mkdtempSync(join(tmpdir(), "jev-hc-")) };
  const out: string[] = [];
  const w = (l: string) => out.push(l);
  expect(main(["lock", "--key", "claude/opus", "--reason", "quota", "--until", String(Date.now() + 60_000)], env, w)).toBe(0);
  expect(main(["check", "--key", "claude/opus"], env, w)).toBe(0);
  expect(JSON.parse(out.at(-1)!)).toMatchObject({ locked: true, reason: "quota" });
  expect(main(["clear", "--key", "claude/opus"], env, w)).toBe(0);
  main(["check", "--key", "claude/opus"], env, w);
  expect(JSON.parse(out.at(-1)!)).toEqual({ locked: false });
  expect(main(["lock", "--key", "claude/opus", "--reason", "nope"], env, w)).toBe(2);
  expect(main(["check"], env, w)).toBe(2);
  expect(main(["gc"], env, w)).toBe(0);
});
