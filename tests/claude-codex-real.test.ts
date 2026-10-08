import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FILTER,
  RUNNER,
  SCRIPTS,
  codexArgv,
  createExternal,
  externalStep,
  filterDrivers,
  type AgentState,
  type Ports,
  type RunInit,
  type RunResult,
} from "../claude-plugin/hooks/external.js";

let root = "";
let bin = "";
let repo = "";
let state = "";
const spawned: string[] = [];

function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("GIT_")) continue;
    env[key] = value;
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  return { ...env, ...extra };
}

function git(cwd: string, ...args: string[]): string {
  const out = spawnSync("git", args, { cwd, env: cleanEnv(), encoding: "utf8" });
  if (out.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${out.stderr}`);
  return out.stdout;
}

function stub(name: string, body: string): void {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

function alive(pgid: string): boolean {
  const out = spawnSync("sh", ["-c", "ps -e -o pgid=,stat= | awk -v g=\"$1\" '$1 == g && $2 !~ /^Z/ { f = 1 } END { exit !f }'", "sh", pgid]);
  return out.status === 0;
}

async function waitGone(pgid: string, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(pgid)) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return !alive(pgid);
}

function run(argv: readonly string[], init: RunInit = {}, extraEnv: Record<string, string> = {}): Promise<RunResult> {
  return new Promise(resolve => {
    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd: init.cwd ?? repo,
      env: cleanEnv({ PATH: `${bin}:${process.env.PATH ?? ""}`, CODEX_HOME: join(root, "codexhome"), ...extraEnv, ...(init.env ?? {}) }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => (stdout += String(chunk)));
    child.stderr.on("data", chunk => (stderr += String(chunk)));
    const timer = init.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), init.timeoutMs) : undefined;
    child.on("close", code => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
    child.stdin.end(init.stdin ?? "");
  });
}

function makeRepo(): void {
  repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "one\n");
  mkdirSync(join(repo, "sub"));
  writeFileSync(join(repo, "sub", "b.txt"), "two\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
}

function ports(store: Map<string, AgentState>, notes: string[], extraEnv: Record<string, string> = {}): Ports {
  return {
    run: (argv, init) => run(argv, init, extraEnv),
    now: async () => Date.now(),
    sleep: (ms, signal) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        });
      }),
    cwd: async () => repo,
    env: async () => ({ stateDir: state, home: root }),
    readText: async path => readFileSync(path, "utf8"),
    exists: async path => existsSync(path),
    userTexts: async () => ["task"],
    agentType: async () => "harness:codex",
    loadState: async id => {
      const found = store.get(id);
      return found === undefined ? null : (JSON.parse(JSON.stringify(found)) as AgentState);
    },
    saveState: async (id, value) => {
      if (value === null) store.delete(id);
      else store.set(id, JSON.parse(JSON.stringify(value)) as AgentState);
    },
    sessionAgents: async () => [...store.keys()],
    notify: text => {
      notes.push(text);
    },
  };
}

async function drain(p: Ports, ext: ReturnType<typeof createExternal>, agentId: string, signal = new AbortController().signal): Promise<string> {
  let last = "";
  for (let index = 0; index < 40; index += 1) {
    const stream = externalStep(p, ext, { turnId: "t", index }, agentId, signal, () => Number.POSITIVE_INFINITY);
    const text: string[] = [];
    for (;;) {
      const next = await stream.next();
      if (next.done) {
        last = text.join("");
        if (next.value.stopReason === "end_turn") return last;
        break;
      }
      if (next.value.kind === "text") text.push(next.value.text);
    }
  }
  throw new Error(`run did not finish: ${last}`);
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

function stamp(text: string): string {
  return text.trim().split("\n")[1] ?? "";
}

function start(runDir: string, max: string, argv: string[], extraEnv: Record<string, string> = {}): Promise<RunResult> {
  mkdirSync(join(runDir, "work"), { recursive: true });
  mkdirSync(join(runDir, "tmp"), { recursive: true });
  writeFileSync(join(runDir, "runner.sh"), RUNNER);
  writeFileSync(join(runDir, "prompt"), "prompt");
  writeFileSync(join(runDir, "lease"), "");
  return run(
    ["sh", "-c", SCRIPTS.start, "sh", join(runDir, "runner.sh"), runDir, join(runDir, "work"), repo, max, join(runDir, "lease"), FILTER, ...argv],
    {},
    extraEnv,
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codex-real-"));
  bin = join(root, "bin");
  mkdirSync(bin);
  state = join(root, "state");
  mkdirSync(state);
  mkdirSync(join(root, "codexhome"));
  spawned.length = 0;
  makeRepo();
});

afterEach(() => {
  for (const pgid of spawned) spawnSync("sh", ["-c", 'kill -s KILL -- "-$1" 2>/dev/null', "sh", pgid]);
  rmSync(root, { recursive: true, force: true });
});

const HANG = `cat >/dev/null
echo '{"type":"thread.started","thread_id":"t"}'
sleep 600 &
sleep 601 &
echo $$ > "$STUB_PIDS"
wait`;

test("SCRIPTS.kill stops every process of the launched group under the system sh", async () => {
  stub("codex", HANG);
  const runDir = join(root, "run1");
  const started = await start(runDir, "600", ["codex"], { STUB_PIDS: join(root, "pids") });
  const pgid = firstLine(started.stdout);
  expect(pgid).toMatch(/^\d+$/);
  spawned.push(pgid);
  await new Promise(resolve => setTimeout(resolve, 800));
  expect(alive(pgid)).toBe(true);
  const sid = spawnSync("ps", ["-o", "sid=,pgid=", "-p", pgid], { encoding: "utf8" }).stdout.trim().split(/\s+/);
  expect(sid[0]).toBe(pgid);
  expect(sid[1]).toBe(pgid);
  const members = spawnSync("sh", ["-c", "ps -e -o pgid=,args= | awk -v g=\"$1\" '$1 == g'", "sh", pgid], { encoding: "utf8" }).stdout;
  expect(members).toContain("sleep 600");
  const killed = await run(["sh", "-c", SCRIPTS.kill, "sh", pgid, "20", stamp(started.stdout)]);
  expect(killed.stdout.trim()).toBe("gone");
  expect(await waitGone(pgid, 3000)).toBe(true);
  const left = spawnSync("sh", ["-c", "ps -e -o args= | grep -c '^sleep 60[01]$'"], { encoding: "utf8" }).stdout.trim();
  expect(left).toBe("0");
}, 30000);

test("SCRIPTS.kill escalates to KILL when the group ignores TERM", async () => {
  stub("codex", `trap '' TERM
cat >/dev/null
while :; do sleep 1; done`);
  const runDir = join(root, "run2");
  const started = await start(runDir, "600", ["codex"]);
  const pgid = firstLine(started.stdout);
  spawned.push(pgid);
  await new Promise(resolve => setTimeout(resolve, 800));
  const killed = await run(["sh", "-c", SCRIPTS.kill, "sh", pgid, "4", stamp(started.stdout)]);
  expect(killed.stdout.trim()).toBe("gone");
  expect(await waitGone(pgid, 3000)).toBe(true);
}, 30000);

test("SCRIPTS.kill refuses pids that are not a real group", async () => {
  for (const bad of ["", "0", "1", "-1", "abc", "1 2"]) {
    const out = await run(["sh", "-c", SCRIPTS.kill, "sh", bad, "1", "12345"]);
    expect(out.stdout.trim()).toBe("gone");
    expect(out.exitCode).toBe(0);
  }
});

test("SCRIPTS.kill with pid 0 or 1 signals nothing and leaves a live bystander alone", async () => {
  const bystander = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
  bystander.unref();
  const pid = String(bystander.pid);
  try {
    for (const bad of ["0", "1"]) {
      const out = await run(["sh", "-c", SCRIPTS.kill, "sh", bad, "1", "1"]);
      expect(out.stdout.trim()).toBe("gone");
    }
    expect(alive(pid)).toBe(true);
    expect(spawnSync("sh", ["-c", 'kill -s 0 "$1"', "sh", String(process.pid)]).status).toBe(0);
  } finally {
    spawnSync("sh", ["-c", 'kill -s KILL -- "-$1" 2>/dev/null', "sh", pid]);
  }
});

test("SCRIPTS.kill skips a live group whose leader start time differs and kills it when it matches", async () => {
  stub("codex", HANG);
  const runDir = join(root, "run-stamp");
  const started = await start(runDir, "600", ["codex"], { STUB_PIDS: join(root, "pids") });
  const pgid = firstLine(started.stdout);
  spawned.push(pgid);
  await new Promise(resolve => setTimeout(resolve, 800));
  expect(alive(pgid)).toBe(true);
  const real = stamp(started.stdout);
  expect(real).toMatch(/^\d+$/);
  for (const wrong of ["", String(Number(real) + 1)]) {
    const skipped = await run(["sh", "-c", SCRIPTS.kill, "sh", pgid, "4", wrong]);
    expect(skipped.stdout.trim()).toBe("gone");
    expect(alive(pgid)).toBe(true);
  }
  const killed = await run(["sh", "-c", SCRIPTS.kill, "sh", pgid, "20", real]);
  expect(killed.stdout.trim()).toBe("gone");
  expect(await waitGone(pgid, 3000)).toBe(true);
}, 30000);

async function orphanGroup(cwd: string): Promise<string> {
  const leader = spawn("sh", ["-c", "sleep 300 & sleep 301 & exit 0"], { cwd, detached: true, stdio: "ignore" });
  leader.unref();
  const pgid = String(leader.pid);
  spawned.push(pgid);
  const until = Date.now() + 3000;
  while (Date.now() < until && (existsSync(`/proc/${pgid}`) || !alive(pgid))) await new Promise(resolve => setTimeout(resolve, 50));
  return pgid;
}

test("SCRIPTS.kill with the leader gone signals nothing when no member runs inside the work directory", async () => {
  const work = join(root, "run-work");
  const elsewhere = join(root, "elsewhere");
  mkdirSync(work);
  mkdirSync(elsewhere);
  const pgid = await orphanGroup(elsewhere);
  expect(existsSync(`/proc/${pgid}`)).toBe(false);
  expect(alive(pgid)).toBe(true);
  for (const dir of [work, "", join(root, "missing")]) {
    const out = await run(["sh", "-c", SCRIPTS.kill, "sh", pgid, "4", "1", dir]);
    expect(out.stdout.trim()).toBe("gone");
    expect(alive(pgid)).toBe(true);
  }
  const old = await run(["sh", "-c", SCRIPTS.kill, "sh", pgid, "4", "1"]);
  expect(old.stdout.trim()).toBe("gone");
  expect(alive(pgid)).toBe(true);
}, 30000);

test("SCRIPTS.kill with the leader gone stops a group whose member runs inside the work directory", async () => {
  const work = join(root, "run-work2");
  mkdirSync(join(work, "sub"), { recursive: true });
  const pgid = await orphanGroup(join(work, "sub"));
  expect(existsSync(`/proc/${pgid}`)).toBe(false);
  expect(alive(pgid)).toBe(true);
  const out = await run(["sh", "-c", SCRIPTS.kill, "sh", pgid, "20", "1", work]);
  expect(out.stdout.trim()).toBe("gone");
  expect(await waitGone(pgid, 3000)).toBe(true);
}, 30000);

test("SCRIPTS.start reports the launcher start time, which matches /proc", async () => {
  stub("codex", HANG);
  const runDir = join(root, "run-proc");
  const started = await start(runDir, "600", ["codex"], { STUB_PIDS: join(root, "pids") });
  const pgid = firstLine(started.stdout);
  spawned.push(pgid);
  const fromProc = spawnSync("sh", ["-c", "sed 's/.*) //' /proc/$1/stat | cut -d' ' -f20", "sh", pgid], { encoding: "utf8" }).stdout.trim();
  expect(stamp(started.stdout)).toBe(fromProc);
});

test("the launcher passes argv literally and never evaluates it", async () => {
  stub("codex", `cat >/dev/null
printf '%s\\n' "$@" > "$STUB_ARGS"`);
  const runDir = join(root, "run3");
  const marker = join(root, "pwned");
  const argument = `$(touch ${marker}); touch ${marker}; \`touch ${marker}\``;
  const started = await start(runDir, "30", ["codex", argument, "two words"], { STUB_ARGS: join(root, "args") });
  spawned.push(firstLine(started.stdout));
  await new Promise(resolve => setTimeout(resolve, 1500));
  expect(existsSync(marker)).toBe(false);
  const args = readFileSync(join(root, "args"), "utf8").split("\n");
  expect(args[0]).toBe(argument);
  expect(args[1]).toBe("two words");
}, 30000);

test("the launcher scrubs git variables, OLDPWD and variables holding the repo path, and sets PWD and TMPDIR", async () => {
  stub("codex", `cat >/dev/null
{ env | sort; pwd; } > "$STUB_ENV"`);
  const runDir = join(root, "run4");
  const started = await start(runDir, "30", ["codex"], {
    STUB_ENV: join(root, "env"),
    GIT_INDEX_FILE: "/x/index",
    GIT_DIR: "/x/dir",
    GIT_WORK_TREE: "/x/tree",
    GIT_PREFIX: "p/",
    GIT_COMMON_DIR: "/x/common",
    GIT_OBJECT_DIRECTORY: "/x/objects",
    OLDPWD: "/old",
    LEAK_REPO: repo,
    LEAK_UNDER: `${repo}/sub`,
    KEEP_NEAR: `${repo}-other`,
  });
  spawned.push(firstLine(started.stdout));
  await new Promise(resolve => setTimeout(resolve, 1500));
  const env = readFileSync(join(root, "env"), "utf8");
  for (const name of ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE", "GIT_PREFIX", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "OLDPWD", "LEAK_REPO", "LEAK_UNDER"]) {
    expect(env).not.toMatch(new RegExp(`^${name}=`, "m"));
  }
  expect(env).toContain(`KEEP_NEAR=${repo}-other`);
  expect(env).toContain(`PWD=${join(runDir, "work")}`);
  expect(env).toContain(`TMPDIR=${join(runDir, "tmp")}`);
}, 30000);

test("a stale lease makes the detached launcher kill its own group", async () => {
  stub("codex", HANG);
  const runDir = join(root, "run5");
  const started = await start(runDir, "600", ["codex"], { STUB_PIDS: join(root, "pids") });
  const pgid = firstLine(started.stdout);
  spawned.push(pgid);
  await new Promise(resolve => setTimeout(resolve, 800));
  expect(alive(pgid)).toBe(true);
  const old = new Date(Date.now() - 5 * 60_000);
  utimesSync(join(runDir, "lease"), old, old);
  expect(await waitGone(pgid, 15000)).toBe(true);
}, 40000);

test("the max runtime ends a run whose children outlive the codex process", async () => {
  stub("codex", HANG);
  const runDir = join(root, "run6");
  const started = await start(runDir, "1", ["codex"], { STUB_PIDS: join(root, "pids") });
  const pgid = firstLine(started.stdout);
  spawned.push(pgid);
  await new Promise(resolve => setTimeout(resolve, 600));
  expect(alive(pgid)).toBe(true);
  expect(await waitGone(pgid, 32000)).toBe(true);
}, 50000);

test("FILTER caps command output, change lists and oversized lines", async () => {
  const big = "x".repeat(5000);
  const lines = [
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", aggregated_output: big } }),
    JSON.stringify({ type: "item.started", item: { type: "file_change", changes: Array.from({ length: 50 }, (_, i) => ({ path: `f${i}`, kind: "add" })) } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "y".repeat(150_000) } }),
    "not json",
  ];
  const out = spawnSync("node", ["-e", FILTER], { input: lines.join("\n") + "\n", encoding: "utf8", maxBuffer: 10_000_000 });
  const parsed = out.stdout.trim().split("\n").map(line => JSON.parse(line));
  expect(parsed).toHaveLength(3);
  expect(parsed[0].item.aggregated_output).toHaveLength(200);
  expect(parsed[1].item.changes).toHaveLength(20);
  expect(parsed[2]).toEqual({ type: "harness.dropped" });
});

const EDIT = `cat >/dev/null
OUT="$STUB_OUT"
REAL=\${STUB_REAL#X}
echo '{"type":"thread.started","thread_id":"019aaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}'
{
  echo "repo_env=\${STUB_REPO-unset}"
  echo "alternates=$(ls .git/objects/info/alternates 2>/dev/null | wc -l)"
  echo "path_in_git=$(grep -rF -- "$REAL" .git 2>/dev/null | wc -l)"
  echo "remotes=$(git remote | wc -l)"
  echo "status_before=$(git status --porcelain | wc -l)"
  echo "commits=$(git log --oneline | wc -l)"
} > "$OUT"
git stash >/dev/null 2>&1
git config user.name evil
git config core.hooksPath /tmp
git tag evil-tag >/dev/null 2>&1
git update-ref -d HEAD >/dev/null 2>&1
git stash -u >/dev/null 2>&1
echo changed >> a.txt
echo fresh > fresh.txt
printf '{"type":"item.started","item":{"type":"command_execution","command":"sh -lc echo hi"}}\\n'
printf '{"type":"item.completed","item":{"type":"agent_message","text":"done editing"}}\\n'
printf '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":2,"output_tokens":3}}\\n'`;

function snapshot(): Record<string, string> {
  return {
    index: spawnSync("sha1sum", [join(repo, ".git", "index")], { encoding: "utf8" }).stdout,
    refs: git(repo, "for-each-ref"),
    head: git(repo, "rev-parse", "HEAD"),
    stash: git(repo, "stash", "list"),
    config: git(repo, "config", "-l"),
    hooks: readdirSync(join(repo, ".git", "hooks")).sort().join(","),
    status: git(repo, "status", "--porcelain"),
    tags: git(repo, "tag"),
    reflog: readFileSync(join(repo, ".git", "logs", "HEAD"), "utf8"),
  };
}

test("a stub codex that edits files and rewrites git state in its cwd leaves the real repository untouched and yields a patch", async () => {
  stub("codex", EDIT);
  const before = snapshot();
  const store = new Map<string, AgentState>();
  const notes: string[] = [];
  const p = ports(store, notes, { STUB_OUT: join(root, "out"), STUB_REAL: `X${repo}`, STUB_REPO: repo });
  const ext = createExternal(30);
  store.set("agent-real", { prompt: "codex-model: gpt-test\nedit things", cwd: null, runs: 0, deliveries: 0, run: null, delivered: null, lastReport: "", used: false });
  const text = await drain(p, ext, "agent-real");

  expect(snapshot()).toEqual(before);
  const seen = Object.fromEntries(
    readFileSync(join(root, "out"), "utf8")
      .trim()
      .split("\n")
      .map(line => line.split("=") as [string, string]),
  );
  expect(seen.repo_env).toBe("unset");
  expect(seen.alternates).toBe("0");
  expect(seen.path_in_git).toBe("0");
  expect(seen.remotes).toBe("0");
  expect(seen.status_before).toBe("0");
  expect(seen.commits).toBe("1");

  const patchLine = text.split("\n").find(line => line.startsWith("Patch (mode 0600): ")) ?? "";
  const patch = patchLine.slice("Patch (mode 0600): ".length);
  expect(patch.startsWith(join(state, "codex-patches"))).toBe(true);
  expect(statSync(patch).mode & 0o777).toBe(0o600);
  const body = readFileSync(patch, "utf8");
  expect(body).toContain("+changed");
  expect(body).toContain("fresh.txt");
  expect(body).not.toContain("evil");
  expect(text).toContain(`git -C '${repo}' apply --stat --check '${patch}'`);
  expect(text).toContain(`git -C '${repo}' apply '${patch}'`);
  expect(text.indexOf("--stat --check")).toBeLessThan(text.indexOf(`apply '${patch}'`));
  expect(text).toContain("uncommitted work");
  expect(text).toContain("may add files and symlinks");
  expect(text).toContain("a.txt");
  expect(text).toContain("— answered by codex, requested gpt-test, unconfirmed");
  expect(text).toContain("done editing");

  const check = spawnSync("git", ["apply", "--check", patch], { cwd: repo, env: cleanEnv(), encoding: "utf8" });
  expect(check.status).toBe(0);
  expect(existsSync(join(state, "codex-runs")) ? readdirSync(join(state, "codex-runs")) : []).toEqual([]);
  expect(store.get("agent-real")?.run).toBeNull();
}, 60000);

test("the exported directory holds exactly one commit and nothing from the real repository history", async () => {
  git(repo, "rm", "-q", "sub/b.txt");
  git(repo, "commit", "-q", "-m", "drop b");
  writeFileSync(join(repo, "a.txt"), "uncommitted\n");
  stub(
    "codex",
    `cat >/dev/null
{
  echo "commits=$(git log --oneline --all | wc -l)"
  echo "removed_visible=$(git log -p --all -S'two' 2>/dev/null | wc -l)"
  echo "a=$(cat a.txt)"
  echo "b=$(ls sub 2>/dev/null | wc -l)"
} > "$STUB_OUT"
printf '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\\n'
printf '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\\n'`,
  );
  const store = new Map<string, AgentState>();
  const p = ports(store, [], { STUB_OUT: join(root, "out2") });
  store.set("agent-h", { prompt: "look", cwd: null, runs: 0, deliveries: 0, run: null, delivered: null, lastReport: "", used: false });
  const text = await drain(p, createExternal(30), "agent-h");
  const seen = Object.fromEntries(
    readFileSync(join(root, "out2"), "utf8")
      .trim()
      .split("\n")
      .map(line => line.split("=") as [string, string]),
  );
  expect(seen.commits).toBe("1");
  expect(seen.removed_visible).toBe("0");
  expect(seen.a).toBe("one");
  expect(text).toContain("Codex made no changes");
  expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("uncommitted\n");
}, 60000);

test("filter drivers are disabled on export: the copy holds the stored blob, is clean, and the patch has only Codex changes", async () => {
  git(repo, "config", "filter.fake.smudge", "tr a-z A-Z");
  git(repo, "config", "filter.fake.clean", "tr A-Z a-z");
  git(repo, "config", "filter.fake.required", "true");
  writeFileSync(join(repo, ".gitattributes"), "*.dat filter=fake\n");
  writeFileSync(join(repo, "data.dat"), "HELLO\n");
  git(repo, "add", ".gitattributes", "data.dat");
  git(repo, "commit", "-q", "-m", "filtered");
  expect(git(repo, "show", "HEAD:data.dat")).toBe("hello\n");
  expect(filterDrivers(git(repo, "config", "--name-only", "--get-regexp", "^filter\\..+\\.(smudge|process|required)$"))).toEqual(["fake"]);
  stub(
    "codex",
    `cat >/dev/null
{
  echo "dat=$(cat data.dat)"
  echo "status=$(git status --porcelain | wc -l)"
} > "$STUB_OUT"
echo more >> a.txt
printf '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\\n'
printf '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\\n'`,
  );
  const store = new Map<string, AgentState>();
  const p = ports(store, [], { STUB_OUT: join(root, "out3") });
  store.set("agent-f", { prompt: "go", cwd: null, runs: 0, deliveries: 0, run: null, delivered: null, lastReport: "", used: false });
  const text = await drain(p, createExternal(30), "agent-f");
  const seen = Object.fromEntries(
    readFileSync(join(root, "out3"), "utf8")
      .trim()
      .split("\n")
      .map(line => line.split("=") as [string, string]),
  );
  expect(seen.dat).toBe("hello");
  expect(seen.status).toBe("0");
  const patch = (text.split("\n").find(line => line.startsWith("Patch (mode 0600): ")) ?? "").slice("Patch (mode 0600): ".length);
  const body = readFileSync(patch, "utf8");
  expect(body).toContain("+more");
  expect(body).not.toContain("data.dat");
  expect(git(repo, "status", "--porcelain")).toBe("");
}, 60000);

test("a non git directory refuses without launching anything", async () => {
  stub("codex", `touch "$STUB_OUT"`);
  const plain = join(root, "plain");
  mkdirSync(plain);
  const store = new Map<string, AgentState>();
  const base = ports(store, [], { STUB_OUT: join(root, "ran") });
  const p: Ports = { ...base, cwd: async () => plain };
  store.set("agent-n", { prompt: "go", cwd: null, runs: 0, deliveries: 0, run: null, delivered: null, lastReport: "", used: false });
  const text = await drain(p, createExternal(30), "agent-n");
  expect(text).toContain("harness:codex did not run:");
  expect(text).toContain("not inside a git repository");
  expect(existsSync(join(root, "ran"))).toBe(false);
  expect(existsSync(join(state, "codex-runs"))).toBe(false);
});

test("codexArgv pins the sandbox flags and reads the prompt from stdin", () => {
  const argv = codexArgv("/w", "/t", "m1");
  expect(argv).toEqual([
    "codex", "exec", "--json", "--skip-git-repo-check", "--ignore-user-config", "-C", "/w", "-s", "workspace-write",
    "-c", "sandbox_workspace_write.exclude_slash_tmp=true",
    "-c", "sandbox_workspace_write.exclude_tmpdir_env_var=true",
    "-c", "sandbox_workspace_write.network_access=false",
    "-c", "sandbox_workspace_write.writable_roots=[]",
    "--add-dir", "/t", "-m", "m1", "-",
  ]);
});

test("the rollout lookup honours CODEX_HOME and finds the model of a thread", async () => {
  const uuid = "019aaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const dir = join(root, "codexhome", "sessions", "2026", "10", "08");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-2026-10-08T00-00-00-${uuid}.jsonl`), `${JSON.stringify({ type: "session_meta" })}\n${JSON.stringify({ type: "turn_context", payload: { model: "gpt-lookup" } })}\n`);
  const found = await run(["sh", "-c", SCRIPTS.rollout, "sh", uuid]);
  expect(JSON.parse(found.stdout.trim()).payload.model).toBe("gpt-lookup");
  const other = join(root, "elsewhere");
  mkdirSync(other);
  const missing = await run(["sh", "-c", SCRIPTS.rollout, "sh", uuid], { env: { CODEX_HOME: other } });
  expect(missing.stdout.trim()).toBe("");
  expect(missing.exitCode).not.toBe(0);
});
