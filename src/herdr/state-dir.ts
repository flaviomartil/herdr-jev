import { homedir } from "node:os";
import { join } from "node:path";

export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HERDR_JEV_STATE_DIR) {
    return env.HERDR_JEV_STATE_DIR;
  }
  const isForeignPlugin = Boolean(env.HERDR_PLUGIN_ID && env.HERDR_PLUGIN_ID !== "herdr-jev");
  if (!isForeignPlugin && env.HERDR_PLUGIN_STATE_DIR) {
    return env.HERDR_PLUGIN_STATE_DIR;
  }
  if (env.HERDR_JEV_TEST_GUARD === "1") {
    throw new Error("state_dir_required_in_tests");
  }
  return join(homedir(), ".local", "state", "herdr-jev");
}
