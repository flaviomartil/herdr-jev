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
  const roots = repoRoots.map((root) => root.replace(/\/+$/u, "")).filter((root) => root !== "");
  for (const [key, value] of Object.entries(copy)) {
    if (key === "PWD" || key === "OLDPWD" || typeof value !== "string") continue;
    if (roots.some((root) => value.split(":").some((part) => under(part, root)))) {
      delete copy[key];
      scrubbed.push(key);
    }
  }
  if (env.OLDPWD !== undefined) scrubbed.push("OLDPWD");
  delete copy.OLDPWD;
  if (env.PWD !== undefined && env.PWD !== cwd) scrubbed.push("PWD");
  copy.PWD = cwd;
  return { env: copy, scrubbed };
}
