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

import { writeFileSync, chmodSync } from "node:fs";
export function createFakeHerdr(dir: string): string {
  const fakeHerdr = join(dir, "herdr");
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
let afterDashDash = false;
for (const arg of args) {
  if (arg === "--") {
    afterDashDash = true;
    continue;
  }
  if (afterDashDash && !arg.startsWith("--")) {
    console.error("usage error: unexpected -- before positional");
    process.exit(2);
  }
  if (!afterDashDash && arg.startsWith("-") && args[0] === "agent" && args[1] === "prompt" && arg === args[args.length - 1]) {
    console.error("usage error: text looks like a flag");
    process.exit(2);
  }
}
if (args[0] === "pane" && args[1] === "get") {
  const paneId = args[args.length - 1];
  if (paneId === "missing:pane" || paneId === "unknown:pane" || paneId === "w1:missing" || paneId === "wZZ:missing" || paneId === "w1:stale") {
    console.log(JSON.stringify({ error: "pane_not_found" }));
    process.exit(1);
  }
}
process.exit(0);
`;
  writeFileSync(fakeHerdr, script, "utf8");
  chmodSync(fakeHerdr, 0o755);
  return fakeHerdr;
}
