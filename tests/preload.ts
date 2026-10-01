import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.HERDR_JEV_STATE_DIR) {
  process.env.HERDR_JEV_STATE_DIR = mkdtempSync(join(tmpdir(), "herdr-jev-test-state-"));
}
