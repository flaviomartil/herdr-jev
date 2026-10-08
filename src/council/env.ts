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

export function scrubbedEnv(cwd: string, repoRoots: readonly string[] = [], env: NodeJS.ProcessEnv = process.env): { env: NodeJS.ProcessEnv; scrubbed: string[] } {
  const copy = cleanEnv(env);
  const scrubbed: string[] = [];
  const home = (env.HOME ?? "").replace(/\/+$/u, "");
  const roots = repoRoots.map((root) => root.replace(/\/+$/u, "")).filter((root) => root !== "" && !(home !== "" && under(home, root)));
  for (const [key, value] of Object.entries(copy)) {
    if (key === "PWD" || key === "OLDPWD" || typeof value !== "string") continue;
    const parts = value.split(":");
    const kept = parts.filter((part) => !roots.some((root) => under(part, root)));
    if (kept.length === parts.length) continue;
    if (kept.length === 0) delete copy[key];
    else copy[key] = kept.join(":");
    scrubbed.push(key);
  }
  delete copy.OLDPWD;
  copy.PWD = cwd;
  return { env: copy, scrubbed };
}
