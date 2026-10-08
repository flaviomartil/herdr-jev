import { appendFileSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCouncil } from "../src/council/run.js";
import { defaultSpawn, type SpawnFn } from "../src/council/spawn.js";
import { MEMBER_BINARIES, PROMPT_FILE_NAME } from "../src/council/members.js";
import type { CouncilMemberName } from "../src/council/types.js";

const env = process.env;
const repo = env.LIVE_REPO ?? "";
const stateDir = env.LIVE_STATE ?? "";
const capDir = env.LIVE_CAP ?? "";
const tag = env.LIVE_TAG ?? "run";
const members = (env.LIVE_MEMBERS ?? "codex,kimi,antigravity").split(",").filter(Boolean) as CouncilMemberName[];
const target = (env.LIVE_TARGET || undefined) as CouncilMemberName | undefined;
const timeoutMs = env.LIVE_TIMEOUT_MS ? Number(env.LIVE_TIMEOUT_MS) : undefined;
const question = env.LIVE_QUESTION || undefined;
const base = env.LIVE_BASE || undefined;
const procLog = join(capDir, `${tag}.procs`);
const startupLog = join(capDir, `${tag}.startup`);
const signalAt = env.LIVE_SELF_CRASH_MS ? Number(env.LIVE_SELF_CRASH_MS) : undefined;

mkdirSync(capDir, { recursive: true });

function listMemberProcs(): Array<{ pid: number; pgid: number; cmd: string }> {
  const out: Array<{ pid: number; pgid: number; cmd: string }> = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry) || Number(entry) === process.pid) continue;
    try {
      const cmd = readFileSync(`/proc/${entry}/cmdline`, "utf8").replace(/\0/gu, " ").trim();
      let cwd = "";
      try {
        cwd = readlinkSync(`/proc/${entry}/cwd`);
      } catch {
        cwd = "";
      }
      if (!(cmd.includes(`${stateDir}/council`) || cwd.startsWith(`${stateDir}/council`))) continue;
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      out.push({ pid: Number(entry), pgid: Number(rest[2]), cmd: cmd.slice(0, 120) });
    } catch {
      continue;
    }
  }
  return out;
}

const seen = new Set<string>();
const sampler = setInterval(() => {
  for (const proc of listMemberProcs()) {
    const key = `${proc.pid}:${proc.pgid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    appendFileSync(procLog, `${proc.pid} ${proc.pgid} ${proc.cmd}\n`);
  }
}, 300);

const fakeVersion: Record<string, string> = { codex: "codex-cli 0.0.0", kimi: "9.9.9", agy: "9.9.9" };

const onlyOne = target !== undefined;
const targetBinary = target ? MEMBER_BINARIES[target] : "";

const spawn: SpawnFn = (argv, options) => {
  const binary = argv[0] ?? "";
  const isReal = !onlyOne || binary === targetBinary;
  if (!isReal) {
    const stdout = argv.includes("--version") ? `${fakeVersion[binary] ?? "1.0.0"}\n` : binary === "agy" ? '{"result":"{\\"findings\\":[]}"}' : "NO_FINDINGS\n";
    return { result: Promise.resolve({ exitCode: 0, stdout, stderr: "" }), kill() {} };
  }
  const isRun = !argv.includes("--version");
  if (isRun) {
    appendFileSync(startupLog, `argv0=${argv[0]} cwd=${options.cwd}\n`);
    try {
      writeFileSync(join(capDir, `${tag}.${binary}.prompt`), readFileSync(join(options.cwd, PROMPT_FILE_NAME)));
    } catch {
      appendFileSync(startupLog, "no prompt file\n");
    }
    if (env.LIVE_PREFLIGHT) {
      const run = Bun.spawnSync(["bash", env.LIVE_PREFLIGHT, options.cwd, join(capDir, `${tag}.${binary}.preflight`)]);
      appendFileSync(startupLog, `preflight exit ${run.exitCode}\n`);
    }
  }
  const proc = defaultSpawn(argv, options);
  if (!isRun) return proc;
  return {
    kill: () => proc.kill(),
    result: proc.result.then((output) => {
      writeFileSync(join(capDir, `${tag}.${binary}.stdout`), output.stdout);
      writeFileSync(join(capDir, `${tag}.${binary}.stderr`), output.stderr);
      writeFileSync(join(capDir, `${tag}.${binary}.exit`), String(output.exitCode));
      return output;
    }),
  };
};

if (signalAt !== undefined) {
  setTimeout(() => {
    throw new Error("injected crash");
  }, signalAt);
}

(async () => {
  const started = Date.now();
  const run = await runCouncil({ cwd: repo, base, members, availableClients: members, timeoutMs, question, stateDir, spawn });
  clearInterval(sampler);
  writeFileSync(join(capDir, `${tag}.run.json`), JSON.stringify({ ...run, wallMs: Date.now() - started }, null, 2));
  console.log(JSON.stringify(run, null, 2));
})();
