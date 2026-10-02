import { homedir } from "node:os";
import { join } from "node:path";

export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const isForeignPlugin = Boolean(env.HERDR_PLUGIN_ID && env.HERDR_PLUGIN_ID !== "herdr-jev");
  const defaultStateDir = join(homedir(), ".local", "state", "herdr-jev");
  return (
    env.HERDR_JEV_STATE_DIR ||
    (!isForeignPlugin && env.HERDR_PLUGIN_STATE_DIR ? env.HERDR_PLUGIN_STATE_DIR : defaultStateDir)
  );
}
