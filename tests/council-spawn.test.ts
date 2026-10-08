import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { defaultSpawn } from "../src/council/spawn.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("council default spawn", () => {
  it("captures output and exit code", async () => {
    const out = await defaultSpawn(["sh", "-c", "echo hi; echo err >&2; exit 3"], { cwd: tmpdir() }).result;
    expect(out).toEqual({ exitCode: 3, stdout: "hi\n", stderr: "err\n" });
  });

  it("feeds stdin", async () => {
    const out = await defaultSpawn(["cat"], { cwd: tmpdir(), stdin: "piped" }).result;
    expect(out.stdout).toBe("piped");
  });

  it("reports a missing binary as exit 127", async () => {
    const out = await defaultSpawn(["definitely-not-a-binary-xyz"], { cwd: tmpdir() }).result;
    expect(out.exitCode).toBe(127);
  });

  it("kills the whole process group", async () => {
    const proc = defaultSpawn(["sh", "-c", "sleep 30 & echo $!; wait"], { cwd: tmpdir() });
    await new Promise((resolve) => setTimeout(resolve, 300));
    proc.kill();
    const out = await proc.result;
    const grandchild = Number(out.stdout.trim());
    expect(Number.isInteger(grandchild)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(alive(grandchild)).toBe(false);
  });
});
