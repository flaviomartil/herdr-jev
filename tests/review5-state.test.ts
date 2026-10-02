import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacyState } from "../src/herdr/state-dir.js";

let sandbox: string;

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "r5-state-")));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function seed(root: string): void {
  mkdirSync(join(root, "grid"), { recursive: true });
  mkdirSync(join(root, "peer-locks"), { recursive: true });
  writeFileSync(join(root, "grid", "caller.json"), JSON.stringify({ callerPaneId: "wE5:pF", workers: [{ paneId: "wE5:pG" }] }));
  writeFileSync(join(root, "peer-locks", "a.lock"), "held");
  writeFileSync(join(root, "fence.dispatch"), "1");
}

function expectIntact(root: string): void {
  expect(JSON.parse(readFileSync(join(root, "grid", "caller.json"), "utf8")).callerPaneId).toBe("wE5:pF");
  expect(readFileSync(join(root, "peer-locks", "a.lock"), "utf8")).toBe("held");
  expect(readFileSync(join(root, "fence.dispatch"), "utf8")).toBe("1");
}

describe("legacy state migration when both roots are the same directory", () => {
  it("keeps every entry when the legacy path is a symlink to the configured directory", () => {
    const configured = join(sandbox, "configured");
    const legacy = join(sandbox, "legacy");
    seed(configured);
    symlinkSync(configured, legacy);
    expect(migrateLegacyState(legacy, configured)).toEqual([]);
    expectIntact(configured);
    expectIntact(legacy);
  });

  it("keeps every entry when the configured path is a symlink to the legacy directory", () => {
    const configured = join(sandbox, "configured");
    const legacy = join(sandbox, "legacy");
    seed(legacy);
    symlinkSync(legacy, configured);
    expect(migrateLegacyState(legacy, configured)).toEqual([]);
    expectIntact(configured);
    expectIntact(legacy);
    expect(readdirSync(legacy).sort()).toEqual(["fence.dispatch", "grid", "peer-locks"]);
  });

  it("keeps every entry when a parent directory alias reaches the same root", () => {
    const real = join(sandbox, "real");
    seed(join(real, "state"));
    symlinkSync(real, join(sandbox, "alias"));
    expect(migrateLegacyState(join(sandbox, "alias", "state"), join(real, "state"))).toEqual([]);
    expectIntact(join(real, "state"));
  });

  it("still migrates a hard-linked copy held in a distinct directory", () => {
    const configured = join(sandbox, "configured");
    const legacy = join(sandbox, "legacy");
    mkdirSync(configured);
    mkdirSync(legacy);
    writeFileSync(join(configured, "fence.dispatch"), "1");
    linkSync(join(configured, "fence.dispatch"), join(legacy, "fence.dispatch"));
    expect(statSync(join(legacy, "fence.dispatch")).ino).toBe(statSync(join(configured, "fence.dispatch")).ino);
    expect(migrateLegacyState(legacy, configured)).toEqual([]);
    expect(readFileSync(join(configured, "fence.dispatch"), "utf8")).toBe("1");
    expect(existsSync(join(legacy, "fence.dispatch"))).toBe(false);
  });

  it("never unlinks a source whose destination resolves to the same directory entry", () => {
    const configured = join(sandbox, "configured");
    const legacy = join(sandbox, "legacy");
    seed(legacy);
    mkdirSync(configured);
    const hooks = {
      beforeMove: () => {
        rmSync(configured, { recursive: true });
        symlinkSync(legacy, configured);
      },
    };
    expect(migrateLegacyState(legacy, configured, hooks)).toEqual([]);
    expectIntact(legacy);
    expectIntact(configured);
  });
});

describe("legacy state migration without hard links", () => {
  it("claims the destination atomically instead of trusting an earlier existence check", () => {
    const configured = join(sandbox, "configured");
    const legacy = join(sandbox, "legacy");
    mkdirSync(configured);
    mkdirSync(legacy);
    writeFileSync(join(legacy, "fence.dispatch"), "legacy");
    const target = join(configured, "fence.dispatch");
    const permission = () => Object.assign(new Error("EPERM"), { code: "EPERM" });
    let raced = false;
    const link = spyOn(fs, "linkSync").mockImplementation((() => {
      if (!raced) {
        raced = true;
        writeFileSync(target, "configured");
      }
      throw permission();
    }) as any);
    const exists = spyOn(fs, "existsSync").mockImplementation(((path: string) => path === target ? false : fs.statSync(path, { throwIfNoEntry: false }) !== undefined) as any);
    try {
      expect(migrateLegacyState(legacy, configured)).toEqual(["fence.dispatch: conflict"]);
    } finally {
      link.mockRestore();
      exists.mockRestore();
    }
    expect(readFileSync(target, "utf8")).toBe("configured");
    expect(readFileSync(join(legacy, "fence.dispatch"), "utf8")).toBe("legacy");
    expect(readdirSync(configured).filter((name) => name.endsWith(".migrating"))).toEqual([]);
  });

  it("copies an entry under its final name when the destination is free", () => {
    const configured = join(sandbox, "configured");
    const legacy = join(sandbox, "legacy");
    mkdirSync(configured);
    mkdirSync(legacy);
    writeFileSync(join(legacy, "fence.dispatch"), "legacy");
    const link = spyOn(fs, "linkSync").mockImplementation((() => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); }) as any);
    try {
      expect(migrateLegacyState(legacy, configured)).toEqual([]);
    } finally {
      link.mockRestore();
    }
    expect(readFileSync(join(configured, "fence.dispatch"), "utf8")).toBe("legacy");
    expect(existsSync(join(legacy, "fence.dispatch"))).toBe(false);
    expect(readdirSync(configured)).toEqual(["fence.dispatch"]);
  });
});
