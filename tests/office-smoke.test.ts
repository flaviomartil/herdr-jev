import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

test("office smoke runs once with demo data and exits cleanly", () => {
  const officeScript = resolve(import.meta.dir, "../herdr-plugin/office/office.mjs");
  const result = spawnSync("node", [officeScript, "--once", "--demo"], {
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  expect(result.stdout.trim().length).toBeGreaterThan(0);
  expect(result.stdout).toContain("JEV OFFICE");
});
