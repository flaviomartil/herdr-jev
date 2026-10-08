import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCouncil } from "../../src/council/run.js";
import { councilScope } from "../../src/council/scope.js";
import { defaultSpawn, type SpawnFn } from "../../src/council/spawn.js";

const repo = process.argv[2]!;
const stateDir = process.argv[3]!;
const out = process.argv[4]!;

const VERSIONS: Record<string, string> = { codex: "codex-cli 0.160.1\n", kimi: "2.1.1\n" };

process.on("SIGTERM", () => undefined);

let started = 0;
const spawn: SpawnFn = (argv, options) => {
  if (argv[1] === "--version") {
    return { result: Promise.resolve({ exitCode: 0, stdout: VERSIONS[argv[0]!] ?? "1.0.0\n", stderr: "" }), kill: () => undefined };
  }
  started += 1;
  if (started === 2) writeFileSync(join(out, "started"), "1");
  return defaultSpawn(["sleep", "5"], options);
};

runCouncil({ cwd: repo, spawn, stateDir, members: ["codex", "kimi"] }).then(async (run) => {
  const end = Date.now() + 8000;
  while (Date.now() < end && councilScope.stopped) await new Promise((resolve) => setTimeout(resolve, 10));
  writeFileSync(join(out, "result.json"), JSON.stringify({ ran: run.ran, note: run.note, members: run.members.map((entry) => [entry.status, entry.reason]) }));
  process.exit(0);
});
