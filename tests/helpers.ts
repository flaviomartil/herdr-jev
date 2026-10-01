import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { expect } from "bun:test";

export function createTestStateDir(): { stateDir: string; cleanup: () => void } {
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-jev-test-state-"));
  const prev = process.env.HERDR_JEV_STATE_DIR;
  process.env.HERDR_JEV_STATE_DIR = stateDir;
  return {
    stateDir,
    cleanup: () => {
      if (prev === undefined) delete process.env.HERDR_JEV_STATE_DIR;
      else process.env.HERDR_JEV_STATE_DIR = prev;
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

export function assertNoRealHomeStateLeaks(): void {
  const realHome = homedir();
  const realGridDir = join(realHome, ".local/state/herdr-jev/grid");
  const leakedFiles = ["parent-1.json", "pane-42.json", "agy-pane-1.json", "caller-pane.json", "caller-1.json"];
  for (const file of leakedFiles) {
    expect(existsSync(join(realGridDir, file))).toBe(false);
  }
}
