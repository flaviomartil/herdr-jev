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

test("three consecutive --once --demo frames at different fake clock values differ", () => {
  const officeScript = resolve(import.meta.dir, "../herdr-plugin/office/office.mjs");
  const t0 = 1700000000000;
  const frames = [0, 320, 640].map((dt) => {
    const result = spawnSync("node", [officeScript, "--once", "--demo", `--clock=${t0 + dt}`], {
      encoding: "utf8",
      env: { ...process.env, COLUMNS: "136", LINES: "52", HERDR_OFFICE_CLOCK: String(t0 + dt) },
    });
    expect(result.status).toBe(0);
    return result.stdout;
  });

  expect(frames[0]).not.toBe(frames[1]);
  expect(frames[1]).not.toBe(frames[2]);
  expect(frames[0]).not.toBe(frames[2]);
});
