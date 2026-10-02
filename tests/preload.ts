import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.HERDR_JEV_STATE_DIR) {
  process.env.HERDR_JEV_STATE_DIR = mkdtempSync(join(tmpdir(), "herdr-jev-test-state-"));
}
process.env.HERDR_JEV_TEST_GUARD = '1';
process.env.AI_HARNESS_TEST_GUARD = '1';
