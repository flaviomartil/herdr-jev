import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const preload = join(import.meta.dir, "preload.ts");

test("the preload clears ambient Herdr pane variables and keeps its own isolation", () => {
  const env = {
    PATH: process.env.PATH ?? "",
    HERDR_PANE_ID: "w9:pHost",
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: "/nonexistent/herdr.sock",
    HERDR_PLUGIN_ID: "other-plugin",
    HERDR_PLUGIN_STATE_DIR: "/nonexistent/state",
    HERDR_PLUGIN_CONFIG_DIR: "/nonexistent/config",
    HERDR_PLUGIN_EVENT_JSON: "{}",
    HERDR_JEV_NOTIFY: "1",
    HERDR_BIN_PATH: "/nonexistent/herdr",
  };
  const run = spawnSync(process.execPath, ["--preload", preload, "-e", "console.log(JSON.stringify(Object.keys(process.env).filter((key) => key.startsWith('HERDR_')).sort()))"], { encoding: "utf8", env, cwd: import.meta.dir, timeout: 60_000 });
  expect(run.status).toBe(0);
  const keys: string[] = JSON.parse(run.stdout);
  expect(keys).toEqual(["HERDR_BIN_PATH", "HERDR_JEV_CONFIG_DIR", "HERDR_JEV_STATE_DIR", "HERDR_JEV_TEST_GUARD"]);
});

test("the suite itself runs without ambient Herdr pane variables", () => {
  for (const key of Object.keys(process.env)) {
    expect(key.startsWith("HERDR_PLUGIN_")).toBe(false);
  }
  expect(process.env.HERDR_PANE_ID).toBeUndefined();
  expect(process.env.HERDR_ENV).toBeUndefined();
  expect(process.env.HERDR_SOCKET_PATH).toBeUndefined();
});
