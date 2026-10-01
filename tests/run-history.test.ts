import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listRunHistory, retryableStages, runStateSummary } from "../src/orchestration/run-history.js";
import { createTestStateDir, assertNoRealHomeStateLeaks } from "./helpers.js";

let testEnv: { stateDir: string; cleanup: () => void };

beforeEach(() => {
  testEnv = createTestStateDir();
});

afterEach(() => {
  testEnv?.cleanup();
  assertNoRealHomeStateLeaks();
});

const ids = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"];

test("lists only uuid run projections newest first and applies the limit", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-jev-runs-"));
  try {
    mkdirSync(join(root, ids[0]!));
    mkdirSync(join(root, ids[1]!));
    mkdirSync(join(root, "peer-locks"));
    writeFileSync(join(root, ids[0]!, "run.json"), JSON.stringify({ generated_at: "2026-09-29T00:00:00.000Z", tasks: [{ id: "implementer", state: "done" }] }));
    writeFileSync(join(root, ids[1]!, "run.json"), JSON.stringify({ generated_at: "2026-09-30T00:01:00.000Z", cwd: "/repo", tasks: [{ id: "implementer", state: "blocked" }] }));
    utimesSync(join(root, ids[0]!, "run.json"), new Date("2026-09-30T00:00:00.000Z"), new Date("2026-09-30T00:00:00.000Z"));
    const runs = listRunHistory(root, 1);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe(ids[1]);
    expect(runStateSummary(runs[0]!.projection)).toBe("implementer:blocked");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("selects only retryable from-failed states", () => {
  const stages = ["queued", "failed", "unknown", "blocked", "reported", "verified"].map((state, index) => ({ id: String(index), state }));
  expect(retryableStages(stages).map((stage) => stage.state))
    .toEqual(["failed", "unknown", "blocked"]);
});
