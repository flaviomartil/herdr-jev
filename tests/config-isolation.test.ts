import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveConfigDir, resolveConfigDirs } from "../src/herdr/state-dir.js";
import { createTempHome } from "./helpers.js";

const repo = join(import.meta.dir, "..");

function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const info = statSync(full);
      const key = relative(root, full);
      if (info.isDirectory()) {
        out[key] = `dir:${info.mtimeMs}`;
        walk(full);
      } else {
        out[key] = `file:${info.size}:${info.mtimeMs}:${readFileSync(full, "utf8")}`;
      }
    }
  };
  walk(root);
  return out;
}

function seedRealLookingConfig(home: string): string {
  const dir = join(home, ".config", "herdr");
  mkdirSync(dir, { recursive: true });
  const future = new Date(Date.now() + 3_600_000).toISOString();
  writeFileSync(join(dir, "herdr-jev-quotas.json"), JSON.stringify([{ client: "codex", model: "*", exhaustedAt: new Date().toISOString(), expiresAt: future }]));
  writeFileSync(join(dir, "herdr-jev-models.json"), JSON.stringify({ "codex:implementer": "gpt-5.6-luna" }));
  const past = new Date(Date.now() - 86_400_000);
  for (const name of ["herdr-jev-quotas.json", "herdr-jev-models.json"]) utimesSync(join(dir, name), past, past);
  utimesSync(dir, past, past);
  return dir;
}

describe("test suite never touches the real configuration directory", () => {
  test("the config directory resolution refuses the default location under the test guard", () => {
    expect(() => resolveConfigDirs({ HERDR_JEV_TEST_GUARD: "1" })).toThrow("config_dir_required_in_tests");
    expect(() => resolveConfigDir({ AI_HARNESS_TEST_GUARD: "1", HERDR_JEV_CONFIG_DIR: "  " })).toThrow("config_dir_required_in_tests");
    expect(resolveConfigDirs({ HERDR_JEV_TEST_GUARD: "1", HERDR_JEV_CONFIG_DIR: "/abs/config" })).toEqual(["/abs/config"]);
  });

  test("preload points the configuration directory at a fresh temp directory", () => {
    const dir = process.env.HERDR_JEV_CONFIG_DIR ?? "";
    expect(dir.startsWith(tmpdir())).toBe(true);
    expect(resolveConfigDir()).toBe(dir);
  });

  test("the snapshot detects a write, a new file and a touched mtime", () => {
    const home = createTempHome();
    const dir = seedRealLookingConfig(home);
    const before = snapshot(dir);
    expect(snapshot(dir)).toEqual(before);
    writeFileSync(join(dir, "herdr-jev-quotas.json"), "[]");
    expect(snapshot(dir)).not.toEqual(before);
  });

  test("a spawned run of the config-writing suites leaves a temporary HOME config untouched", () => {
    const home = createTempHome();
    const realConfig = seedRealLookingConfig(home);
    const before = snapshot(realConfig);
    const env: Record<string, string | undefined> = { ...process.env, HOME: home, XDG_CONFIG_HOME: undefined };
    for (const key of Object.keys(env)) {
      if (key.startsWith("HERDR_JEV_") || key === "AI_HARNESS_TEST_GUARD") delete env[key];
    }
    const result = spawnSync(
      process.execPath,
      ["test", "tests/herdr-jev.test.ts", "tests/harness-models.test.ts", "tests/resilient-router.test.ts", "tests/tool-env.test.ts"],
      { cwd: repo, env: env as NodeJS.ProcessEnv, encoding: "utf8", timeout: 240_000 },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(snapshot(realConfig)).toEqual(before);
  }, 300_000);
});
