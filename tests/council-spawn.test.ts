import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSpawn } from "../src/council/spawn.js";

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

  it("kills the whole process group", async () => {
    const proc = defaultSpawn(["sh", "-c", "sleep 30 & echo $!; wait"], { cwd: dir });
    await new Promise((resolve) => setTimeout(resolve, 300));
    proc.kill();
    const out = await proc.result;
    const grandchild = Number(out.stdout.trim());
    expect(Number.isInteger(grandchild)).toBe(true);
    expect(await until(() => !alive(grandchild))).toBe(true);
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

describe("council process scope", () => {
  it("kills members and removes review directories when the parent is signalled", async () => {
    const child = spawn(process.execPath, ["run", join(import.meta.dir, "fixtures/council-signal-child.ts"), dir], { stdio: "ignore", env: { ...process.env } });
    const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
    expect(await until(() => existsSync(join(dir, "ready")))).toBe(true);
    expect(existsSync(join(dir, "review-dir"))).toBe(true);
    expect(await until(() => existsSync(join(dir, "pid")))).toBe(true);
    const grandchild = Number(readFileSync(join(dir, "pid"), "utf8").trim());
    expect(alive(grandchild)).toBe(true);
    child.kill("SIGTERM");
    await exited;
    expect(await until(() => !existsSync(join(dir, "review-dir")))).toBe(true);
    expect(await until(() => !alive(grandchild))).toBe(true);
  }, 30000);
});
