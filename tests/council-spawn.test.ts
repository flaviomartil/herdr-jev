import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { councilScope } from "../src/council/scope.js";
import { defaultSpawn, findTimeoutCommand } from "../src/council/spawn.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

setDefaultTimeout(30000);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "council-spawn-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("council default spawn", () => {
  it("captures output and exit code", async () => {
    const out = await defaultSpawn(["sh", "-c", "echo hi; echo err >&2; exit 3"], { cwd: dir }).result;
    expect(out).toEqual({ exitCode: 3, stdout: "hi\n", stderr: "err\n" });
  });

  it("feeds stdin", async () => {
    const out = await defaultSpawn(["cat"], { cwd: dir, stdin: "piped" }).result;
    expect(out.stdout).toBe("piped");
  });

  it("reports a missing binary as exit 127", async () => {
    const out = await defaultSpawn(["definitely-not-a-binary-xyz"], { cwd: dir }).result;
    expect(out.exitCode).toBe(127);
  });

  it("decodes a multibyte character split across chunks", async () => {
    const out = await defaultSpawn(["sh", "-c", "printf '\\303'; sleep 0.3; printf '\\251'"], { cwd: dir }).result;
    expect(out.stdout).toBe("é");
  });

  it("bounds captured output and reports the cut", async () => {
    const out = await defaultSpawn(["sh", "-c", "head -c 100000 /dev/zero | tr '\\0' a"], { cwd: dir, maxBytes: 1000 }).result;
    expect(out.stdout.length).toBe(1000);
    expect(out.truncated).toBe(true);
    const small = await defaultSpawn(["sh", "-c", "echo ok"], { cwd: dir, maxBytes: 1000 }).result;
    expect(small.truncated).toBeUndefined();
  });

  it("removes repo local git variables from the member environment", async () => {
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE };
    process.env.GIT_DIR = "/nonexistent/.git";
    process.env.GIT_INDEX_FILE = "/nonexistent/index";
    try {
      const out = await defaultSpawn(["sh", "-c", "echo \"[$GIT_DIR][$GIT_INDEX_FILE]\""], { cwd: dir }).result;
      expect(out.stdout.trim()).toBe("[][]");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("gives the member the review directory as PWD, drops OLDPWD and scrubs only the entries pointing into the repository", async () => {
    const saved = { PWD: process.env.PWD, OLDPWD: process.env.OLDPWD, REPO_HINT: process.env.REPO_HINT, PATH_HINT: process.env.PATH_HINT, OTHER: process.env.OTHER };
    process.env.PWD = "/real/repo";
    process.env.OLDPWD = "/real/repo/sub";
    process.env.REPO_HINT = "/real/repo/src";
    process.env.PATH_HINT = "/usr/bin:/real/repo/bin";
    process.env.OTHER = "/real/repository-other";
    try {
      const out = await defaultSpawn(["/usr/bin/env"], { cwd: dir, repoRoots: ["/real/repo"] }).result;
      const lines = out.stdout.split("\n");
      expect(lines).toContain(`PWD=${dir}`);
      expect(lines.some((line) => line.startsWith("OLDPWD="))).toBe(false);
      expect(lines.some((line) => line.startsWith("REPO_HINT="))).toBe(false);
      expect(lines).toContain("PATH_HINT=/usr/bin");
      expect(lines).toContain("OTHER=/real/repository-other");
      expect([...(out.scrubbed ?? [])].sort()).toEqual(["PATH_HINT", "REPO_HINT"]);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("keeps the other PATH entries when the repository's node_modules/.bin is on PATH, and still finds the binary", async () => {
    const repoDir = join(dir, "proj");
    const bin = join(dir, "tools");
    mkdirSync(join(repoDir, "node_modules/.bin"), { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(bin, "membertool"), "#!/bin/sh\necho found\n");
    chmodSync(join(bin, "membertool"), 0o755);
    const saved = process.env.PATH;
    process.env.PATH = `${join(repoDir, "node_modules/.bin")}:${bin}:${saved}`;
    try {
      const out = await defaultSpawn(["membertool"], { cwd: dir, repoRoots: [repoDir] }).result;
      expect(out.exitCode).toBe(0);
      expect(out.stdout.trim()).toBe("found");
      expect(out.scrubbed).toEqual(["PATH"]);
      const env = await defaultSpawn(["/usr/bin/env"], { cwd: dir, repoRoots: [repoDir] }).result;
      const pathLine = env.stdout.split("\n").find((line) => line.startsWith("PATH=")) ?? "";
      expect(pathLine).not.toContain(repoDir);
      expect(pathLine).toContain(bin);
    } finally {
      process.env.PATH = saved;
    }
  });

  it("leaves HOME and PATH intact when the repository is rooted at HOME", async () => {
    const savedHome = process.env.HOME;
    const savedPath = process.env.PATH;
    process.env.HOME = dir;
    process.env.PATH = `${join(dir, "bin")}:${savedPath}`;
    try {
      const out = await defaultSpawn(["/usr/bin/env"], { cwd: dir, repoRoots: [dir] }).result;
      const lines = out.stdout.split("\n");
      expect(lines).toContain(`HOME=${dir}`);
      expect(lines.find((line) => line.startsWith("PATH="))).toBe(`PATH=${process.env.PATH}`);
      expect(out.scrubbed).toBeUndefined();
    } finally {
      process.env.HOME = savedHome;
      process.env.PATH = savedPath;
    }
  });

  it("kills the whole process group", async () => {
    const proc = defaultSpawn(["sh", "-c", "sleep 30 & echo $!; wait"], { cwd: dir });
    await new Promise((resolve) => setTimeout(resolve, 300));
    proc.kill();
    const out = await proc.result;
    const grandchild = Number(out.stdout.trim());
    expect(Number.isInteger(grandchild)).toBe(true);
    expect(await until(() => !alive(grandchild))).toBe(true);
  });

  it("kills a grandchild that ignores SIGTERM and holds no stdio, after the leader closed", async () => {
    const proc = defaultSpawn(["sh", "-c", "sh -c 'trap \"\" TERM; exec sleep 30' >/dev/null 2>&1 </dev/null & echo $!; wait"], { cwd: dir, killGraceMs: 300 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    proc.kill();
    const out = await proc.result;
    const grandchild = Number(out.stdout.trim());
    expect(Number.isInteger(grandchild)).toBe(true);
    expect(await until(() => !alive(grandchild))).toBe(true);
  });

  it("stops tracking a member that never closes once it was force killed", async () => {
    const pidFile = join(dir, "leak-pid");
    const proc = defaultSpawn(["sh", "-c", `setsid sleep 30 </dev/null & echo $! > ${pidFile}; wait`], { cwd: dir, killGraceMs: 200 });
    expect(await until(() => existsSync(pidFile))).toBe(true);
    const leaked = Number(readFileSync(pidFile, "utf8").trim());
    expect(councilScope.groups.size).toBeGreaterThan(0);
    proc.kill();
    const untracked = await until(() => councilScope.groups.size === 0, 5000);
    try {
      process.kill(leaked, "SIGKILL");
    } catch {
      expect(leaked).toBeGreaterThan(0);
    }
    expect(untracked).toBe(true);
  });

  it("escalates to SIGKILL when SIGTERM is ignored", async () => {
    const proc = defaultSpawn(["sh", "-c", "trap '' TERM; sleep 30 & echo $!; wait"], { cwd: dir, killGraceMs: 300 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const started = Date.now();
    proc.kill();
    const out = await proc.result;
    const grandchild = Number(out.stdout.trim());
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(await until(() => !alive(grandchild))).toBe(true);
  }, 30000);
});

function launch(mode: string, signalName: NodeJS.Signals | "SIGKILL") {
  const child = spawn(process.execPath, ["run", join(import.meta.dir, "fixtures/council-signal-child.ts"), dir, mode], { stdio: "ignore", env: { ...process.env } });
  const exited = new Promise<NodeJS.Signals | null>((resolve) => child.on("exit", (_code, signal) => resolve(signal)));
  return { child, exited, signalName };
}

const hasTimeout = findTimeoutCommand() !== undefined;

describe("council process scope", () => {
  for (const signalName of ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"] as const) {
    it(`kills members, removes review directories and exits on ${signalName}`, async () => {
      const { child, exited } = launch("scope", signalName);
      expect(await until(() => existsSync(join(dir, "ready")))).toBe(true);
      expect(existsSync(join(dir, "review-dir"))).toBe(true);
      const grandchild = Number(readFileSync(join(dir, "pid"), "utf8").trim());
      expect(alive(grandchild)).toBe(true);
      child.kill(signalName);
      expect(await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve("hung"), 10000))])).toBe(signalName);
      expect(await until(() => !existsSync(join(dir, "review-dir")))).toBe(true);
      expect(await until(() => !alive(grandchild))).toBe(true);
    }, 30000);
  }

  it("runs the exit handler: removes review directories and kills members on a plain exit", async () => {
    const { exited } = launch("exit", "SIGTERM");
    await exited;
    expect(existsSync(join(dir, "ready"))).toBe(true);
    const grandchild = Number(readFileSync(join(dir, "pid"), "utf8").trim());
    expect(await until(() => !existsSync(join(dir, "review-dir")))).toBe(true);
    expect(await until(() => !alive(grandchild))).toBe(true);
  }, 30000);

  it("lets the process exit after a forced kill even when a grandchild in its own session holds the pipes", async () => {
    const child = spawn(process.execPath, ["run", join(import.meta.dir, "fixtures/council-signal-child.ts"), dir, "leak"], { stdio: "ignore", env: { ...process.env } });
    const closed = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    expect(await until(() => existsSync(join(dir, "pid")))).toBe(true);
    const leaked = Number(readFileSync(join(dir, "pid"), "utf8").trim());
    try {
      expect(await Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve("hung"), 8000))])).toBe(0);
    } finally {
      try {
        process.kill(leaked, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      child.kill("SIGKILL");
    }
  }, 30000);

  it("still exits on SIGTERM when another guard is registered in the same process", async () => {
    const { child, exited } = launch("both", "SIGTERM");
    expect(await until(() => existsSync(join(dir, "ready")))).toBe(true);
    const other = Number(readFileSync(join(dir, "pid2"), "utf8").trim());
    const grandchild = Number(readFileSync(join(dir, "pid"), "utf8").trim());
    child.kill("SIGTERM");
    expect(await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve("hung"), 10000))])).toBe("SIGTERM");
    expect(await until(() => !alive(other))).toBe(true);
    expect(await until(() => !alive(grandchild))).toBe(true);
    expect(await until(() => !existsSync(join(dir, "review-dir")))).toBe(true);
  }, 30000);

  it.skipIf(!hasTimeout)("bounds a member by its lifetime when the parent is killed with SIGKILL", async () => {
    const { child, exited } = launch("lifetime", "SIGKILL");
    expect(await until(() => existsSync(join(dir, "ready")))).toBe(true);
    const grandchild = Number(readFileSync(join(dir, "pid"), "utf8").trim());
    expect(alive(grandchild)).toBe(true);
    child.kill("SIGKILL");
    await exited;
    expect(await until(() => !alive(grandchild), 15000)).toBe(true);
  }, 40000);
});

describe("council timeout command", () => {
  it("finds an executable timeout on the given PATH", () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    expect(findTimeoutCommand({ PATH: bin })).toBeUndefined();
    writeFileSync(join(bin, "timeout"), "#!/bin/sh\n");
    chmodSync(join(bin, "timeout"), 0o755);
    expect(findTimeoutCommand({ PATH: `/nonexistent:${bin}` })).toBe(join(bin, "timeout"));
  });

  it("wraps the command under timeout -k when a lifetime is given", async () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "argv");
    writeFileSync(join(bin, "fake-timeout"), `#!/bin/sh\necho "$@" > ${log}\nshift 3\nexec "$@"\n`);
    chmodSync(join(bin, "fake-timeout"), 0o755);
    const out = await defaultSpawn(["echo", "hi"], { cwd: dir, lifetimeMs: 2500, timeoutCommand: join(bin, "fake-timeout") }).result;
    expect(out.stdout).toBe("hi\n");
    expect(readFileSync(log, "utf8").trim()).toBe("-k 1 3 echo hi");
    const plain = await defaultSpawn(["echo", "hi"], { cwd: dir, lifetimeMs: 2500, timeoutCommand: null }).result;
    expect(plain.stdout).toBe("hi\n");
  });
});
