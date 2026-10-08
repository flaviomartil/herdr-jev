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
