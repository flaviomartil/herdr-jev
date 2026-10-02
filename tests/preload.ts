import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AMBIENT = new Set(["HERDR_PANE_ID", "HERDR_ENV", "HERDR_SOCKET_PATH"]);

for (const key of Object.keys(process.env)) {
  if (key.startsWith("HERDR_JEV_") || key.startsWith("HERDR_PLUGIN_") || AMBIENT.has(key)) delete process.env[key];
}
process.env.HERDR_JEV_STATE_DIR = mkdtempSync(join(tmpdir(), "herdr-jev-test-state-"));
process.env.HERDR_JEV_CONFIG_DIR = mkdtempSync(join(tmpdir(), "herdr-jev-test-config-"));
process.env.HERDR_JEV_TEST_GUARD = '1';
process.env.AI_HARNESS_TEST_GUARD = '1';
