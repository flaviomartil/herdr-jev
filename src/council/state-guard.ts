import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join, sep } from "node:path";

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function stateDirInsideRepo(stateDir: string, repoRoot: string): boolean {
  const state = real(stateDir);
  const root = real(repoRoot);
  if (state !== root && !state.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) return false;
  const probe = join(state, "council", "probe");
  const result = spawnSync("git", ["check-ignore", "-q", "--no-index", "--", probe], { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  return result.status !== 0;
}
