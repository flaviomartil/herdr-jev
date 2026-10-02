import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dir;
const files = readdirSync(here).filter((name) => name.endsWith(".test.ts") && name !== "hermetic-tests.test.ts");

test("every test that spawns src/cli.ts sets a temporary HOME", () => {
  const offenders = files.filter((name) => {
    const text = readFileSync(join(here, name), "utf8");
    return text.includes("src/cli.ts") && !/HOME:\s|createTempHome/.test(text);
  });
  expect(offenders).toEqual([]);
});

test("no wall-clock assertion is tighter than five seconds", () => {
  const offenders: string[] = [];
  for (const name of files) {
    readFileSync(join(here, name), "utf8").split("\n").forEach((line, index) => {
      if (!/(elapsed|started|performance\.now)/.test(line)) return;
      const match = /(?:toBeLessThan\(|elapsed\s*<\s*)(\d[\d_]*)/.exec(line);
      if (match && Number(match[1]!.replaceAll("_", "")) < 5000) offenders.push(`${name}:${index + 1}`);
    });
  }
  expect(offenders).toEqual([]);
});
