import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dir = mkdtempSync(join(tmpdir(), "jev-rules-"));

async function check(payload: unknown) {
  const proc = Bun.spawn(["bun", join(root, "bin/herdr-jev.js"), "rules", "check"], {
    stdin: new Blob([typeof payload === "string" ? payload : JSON.stringify(payload)]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: dir, JEV_CONFIG_DIR: join(dir, "cfg") },
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout, stderr };
}

const bashCall = (command: string) => ({ hook_event_name: "PreToolUse", session_id: "s", cwd: dir, tool_name: "Bash", tool_input: { command } });

test("exits 2 with the reason on a co-author commit", async () => {
  const r = await check(bashCall("git commit -m \"x\" -m \"Co-Authored-By: A <a@b.c>\""));
  expect(r.code).toBe(2);
  expect(r.stderr.length).toBeGreaterThan(0);
});

test("exits 2 when the message comes from -F", async () => {
  writeFileSync(join(dir, "msg.txt"), "fix: x\n\nGenerated with a tool\n");
  expect((await check(bashCall("git commit -F msg.txt"))).code).toBe(2);
});

test("exits 0 on a clean commit", async () => {
  const r = await check(bashCall("git commit -m \"feat: x\""));
  expect(r.code).toBe(0);
});

test("ask is exit 0 with a permission decision on stdout", async () => {
  const r = await check(bashCall("rm -rf build"));
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
});

test("unreadable input is allowed", async () => {
  expect((await check("not json")).code).toBe(0);
});

test("prompt hook returns the reminder as context", async () => {
  const r = await check({ hook_event_name: "UserPromptSubmit", session_id: "s" });
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext.length).toBeGreaterThan(0);
});

test("local config adds an excluded root", async () => {
  const cfg = join(dir, "cfg");
  Bun.spawnSync(["mkdir", "-p", cfg]);
  writeFileSync(join(cfg, "rules.local.yml"), `workRepo:\n  roots:\n    - ${dir}/work\n`);
  const r = await check({ hook_event_name: "PreToolUse", cwd: dir, tool_name: "Write", tool_input: { file_path: join(dir, "work/app/doc.md"), content: "x" } });
  expect(r.code).toBe(2);
});
