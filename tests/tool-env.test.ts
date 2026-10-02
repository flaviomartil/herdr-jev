import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { harnessGeneratedDir, isTestGuardActive, legacyConfigDir, readToolEnv, resolveConfigDir, resolveConfigDirs, resolveStateDir } from "../src/herdr/state-dir.js";

let generated: string;
let home: string;

function writeToolEnv(body: unknown) {
  writeFileSync(join(generated, "tool-env.json"), typeof body === "string" ? body : JSON.stringify(body));
}

beforeEach(() => {
  generated = mkdtempSync(join(tmpdir(), "tool-env-"));
  home = mkdtempSync(join(tmpdir(), "tool-env-home-"));
});

afterEach(() => {
  rmSync(generated, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const entry = { tools: { "herdr-jev": { configDir: "/cfg/herdr-jev", stateDir: "/state/herdr-jev" }, other: { stateDir: "/state/other" } } };

describe("tool-env.json", () => {
  it("resolves the generated directory from AI_HARNESS_GENERATED_DIR or the default location", () => {
    expect(harnessGeneratedDir({ AI_HARNESS_GENERATED_DIR: generated })).toBe(generated);
    expect(harnessGeneratedDir({})).toBe(join(homedir(), ".local", "share", "ai-harness", "generated"));
  });

  it("supplies the state directory when nothing more specific is set", () => {
    writeToolEnv(entry);
    expect(resolveStateDir({ AI_HARNESS_GENERATED_DIR: generated, HOME: home })).toBe("/state/herdr-jev");
    expect(readToolEnv({ AI_HARNESS_GENERATED_DIR: generated })).toEqual({ configDir: "/cfg/herdr-jev", stateDir: "/state/herdr-jev" });
  });

  it("lets the explicit state directory and the plugin state directory win", () => {
    writeToolEnv(entry);
    expect(resolveStateDir({ AI_HARNESS_GENERATED_DIR: generated, HERDR_JEV_STATE_DIR: "/explicit" })).toBe("/explicit");
    expect(resolveStateDir({ AI_HARNESS_GENERATED_DIR: generated, HERDR_PLUGIN_ID: "herdr-jev", HERDR_PLUGIN_STATE_DIR: "/plugin" })).toBe("/plugin");
    expect(resolveStateDir({ AI_HARNESS_GENERATED_DIR: generated, HERDR_PLUGIN_ID: "other", HERDR_PLUGIN_STATE_DIR: "/foreign", HOME: home })).toBe("/state/herdr-jev");
  });

  it("falls back to the current rules when the file is absent, malformed or unusable", () => {
    const fallback = join(homedir(), ".local", "state", "herdr-jev");
    expect(resolveStateDir({ AI_HARNESS_GENERATED_DIR: generated })).toBe(fallback);
    writeToolEnv("{not json");
    expect(resolveStateDir({ AI_HARNESS_GENERATED_DIR: generated })).toBe(fallback);
    writeToolEnv({ tools: { "herdr-jev": { stateDir: "relative/path", configDir: 7 } } });
    expect(resolveStateDir({ AI_HARNESS_GENERATED_DIR: generated })).toBe(fallback);
    writeToolEnv({ tools: {} });
    expect(readToolEnv({ AI_HARNESS_GENERATED_DIR: generated })).toEqual({});
  });

  it("expands a leading tilde", () => {
    writeToolEnv({ tools: { "herdr-jev": { stateDir: "~/.local/state/custom-jev", configDir: "~/cfg" } } });
    expect(resolveStateDir({ AI_HARNESS_GENERATED_DIR: generated, HOME: home })).toBe(join(homedir(), ".local/state/custom-jev"));
    expect(resolveConfigDir({ AI_HARNESS_GENERATED_DIR: generated })).toBe(join(homedir(), "cfg"));
  });

  it("keeps requiring an explicit state directory under either test guard and ignores the file", () => {
    writeToolEnv(entry);
    expect(() => resolveStateDir({ AI_HARNESS_GENERATED_DIR: generated, HERDR_JEV_TEST_GUARD: "1" })).toThrow("state_dir_required_in_tests");
    expect(() => resolveStateDir({ AI_HARNESS_GENERATED_DIR: generated, AI_HARNESS_TEST_GUARD: "1" })).toThrow("state_dir_required_in_tests");
    expect(resolveStateDir({ AI_HARNESS_GENERATED_DIR: generated, AI_HARNESS_TEST_GUARD: "1", HERDR_JEV_STATE_DIR: "/explicit" })).toBe("/explicit");
    expect(isTestGuardActive({ AI_HARNESS_TEST_GUARD: "1" })).toBe(true);
    expect(isTestGuardActive({ HERDR_JEV_TEST_GUARD: "1" })).toBe(true);
    expect(isTestGuardActive({ AI_HARNESS_TEST_GUARD: "0" })).toBe(false);
    expect(readToolEnv({ AI_HARNESS_GENERATED_DIR: generated, AI_HARNESS_TEST_GUARD: "1" })).toEqual({});
  });

  it("resolves the configuration directory with the explicit override first and the legacy location last", () => {
    expect(resolveConfigDirs({ AI_HARNESS_GENERATED_DIR: generated })).toEqual([legacyConfigDir()]);
    writeToolEnv(entry);
    expect(resolveConfigDir({ AI_HARNESS_GENERATED_DIR: generated })).toBe("/cfg/herdr-jev");
    expect(resolveConfigDirs({ AI_HARNESS_GENERATED_DIR: generated })).toEqual(["/cfg/herdr-jev", legacyConfigDir()]);
    expect(resolveConfigDirs({ AI_HARNESS_GENERATED_DIR: generated, HERDR_JEV_CONFIG_DIR: "/override" })).toEqual(["/override"]);
  });

  it("runs the suite under both guards so no test can write to the real harness state", () => {
    expect(process.env.HERDR_JEV_TEST_GUARD).toBe("1");
    expect(process.env.AI_HARNESS_TEST_GUARD).toBe("1");
  });
});
