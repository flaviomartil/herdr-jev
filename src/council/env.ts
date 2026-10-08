import { realpathSync } from "node:fs";

const REPO_LOCAL_GIT = [
  "GIT_INDEX_FILE",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_PREFIX",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
];

export function cleanEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  for (const key of REPO_LOCAL_GIT) delete copy[key];
  return copy;
}

function under(value: string, root: string): boolean {
  return value === root || value.startsWith(`${root}/`);
}

function resolved(value: string): string | undefined {
  try {
    return realpathSync(value);
  } catch {
    return undefined;
  }
}

function withReal(values: readonly string[]): string[] {
  const out = new Set<string>();
  for (const value of values) {
    out.add(value);
    const real = value.startsWith("/") ? resolved(value) : undefined;
    if (real !== undefined) out.add(real.replace(/\/+$/u, ""));
  }
  return [...out];
}

export function scrubbedEnv(cwd: string, repoRoots: readonly string[] = [], env: NodeJS.ProcessEnv = process.env): { env: NodeJS.ProcessEnv; scrubbed: string[] } {
  const copy = cleanEnv(env);
  const scrubbed: string[] = [];
  const home = (env.HOME ?? "").replace(/\/+$/u, "");
  const homes = withReal(home === "" ? [] : [home]);
  const roots = withReal(repoRoots.map((root) => root.replace(/\/+$/u, "")).filter((root) => root !== "")).filter((root) => root !== "" && !homes.some((candidate) => under(candidate, root)));
  const inside = (part: string): boolean => {
    if (roots.length === 0) return false;
    if (roots.some((root) => under(part, root))) return true;
    if (!part.startsWith("/")) return false;
    const real = resolved(part);
    return real !== undefined && roots.some((root) => under(real, root));
  };
  for (const [key, value] of Object.entries(copy)) {
    if (key === "PWD" || key === "OLDPWD" || typeof value !== "string") continue;
    const parts = value.split(":");
    const kept = parts.filter((part) => !inside(part));
    if (kept.length === parts.length) continue;
    if (kept.length === 0) delete copy[key];
    else copy[key] = kept.join(":");
    scrubbed.push(key);
  }
  delete copy.OLDPWD;
  copy.PWD = cwd;
  return { env: copy, scrubbed };
}
