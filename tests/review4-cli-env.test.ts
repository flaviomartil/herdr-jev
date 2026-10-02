import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repository = join(import.meta.dir, "..");
const marker = "R4_" + "REPO_ENV_MARKER";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "r4-cli-env-"));
  cpSync(join(repository, "src"), join(root, "src"), { recursive: true });
  cpSync(join(repository, "config"), join(root, "config"), { recursive: true });
  symlinkSync(join(repository, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(root, ".env"), `${marker}=loaded\n`);
  writeFileSync(join(root, "probe.ts"), `process.on("exit", () => { process.stderr.write("probe:" + String(process.env.${marker}) + "\\n"); });\n`);
  mkdirSync(join(root, "home"));
  mkdirSync(join(root, "cwd"));
  mkdirSync(join(root, "generated"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function probe(guards: Record<string, string>): string {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: join(root, "home"),
    AI_HARNESS_GENERATED_DIR: join(root, "generated"),
    ...guards,
  };
  const run = spawnSync(process.execPath, ["--preload", join(root, "probe.ts"), join(root, "src", "cli.ts"), "--version"], { encoding: "utf8", env, cwd: join(root, "cwd"), timeout: 60_000 });
  expect(run.status).toBe(0);
  return run.stderr;
}

test("the repository .env is loaded when no test guard is active", () => {
  expect(probe({})).toContain("probe:loaded");
});

test("the repository .env is skipped under HERDR_JEV_TEST_GUARD alone", () => {
  expect(probe({ HERDR_JEV_TEST_GUARD: "1" })).toContain("probe:undefined");
});

test("the repository .env is skipped under AI_HARNESS_TEST_GUARD alone", () => {
  expect(probe({ AI_HARNESS_TEST_GUARD: "1" })).toContain("probe:undefined");
});
