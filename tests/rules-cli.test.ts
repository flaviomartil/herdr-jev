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

function run(args: string[], payload: unknown, config: string = join(dir, "cfg"), cwd?: string) {
  const proc = Bun.spawnSync(["bun", join(root, "bin/herdr-jev.js"), "rules", ...args], {
    stdin: new Blob([typeof payload === "string" ? payload : JSON.stringify(payload)]),
    env: { ...process.env, HOME: dir, JEV_CONFIG_DIR: config },
    cwd,
  });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

const writeCall = (file_path: string, content = "x", tool = "Write") => ({ hook_event_name: "PreToolUse", cwd: dir, tool_name: tool, tool_input: { file_path, content } });

test("F1 an invalid rules.local.yml blocks writes and commits and lets other calls through", () => {
  const bad = join(dir, "badcfg");
  Bun.spawnSync(["mkdir", "-p", bad]);
  writeFileSync(join(bad, "rules.local.yml"), "workRepo:\n  roots\n   - : [\n");
  expect(run(["check"], writeCall(join(dir, "a.ts")), bad).code).toBe(2);
  expect(run(["check"], writeCall(join(dir, "a.ipynb"), "x", "NotebookEdit"), bad).code).toBe(2);
  expect(run(["check"], bashCall("git commit -m \"feat: x\""), bad).code).toBe(2);
  expect(run(["check"], bashCall("ls -la"), bad).code).toBe(0);
});

test("F1 a truncated payload that names a write tool is blocked", () => {
  expect(run(["check"], "{\"tool_name\":\"Write\",\"tool_input\":{").code).toBe(2);
  expect(run(["check"], "garbage").code).toBe(0);
});

test("F2 an unreadable -F file blocks the commit", () => {
  expect(run(["check"], bashCall("git commit -F does-not-exist.txt")).code).toBe(2);
});

test("F2 wrapped commits and F3 wrapped deletes", () => {
  expect(run(["check"], bashCall("env -i git commit -m \"x\" -m \"Co-Authored-By: A <a@b.c>\"")).code).toBe(2);
  expect(JSON.parse(run(["check"], bashCall("bash -c \"rm -rf build\"")).stdout).hookSpecificOutput.permissionDecision).toBe("ask");
  expect(JSON.parse(run(["check"], bashCall("/bin/rm -rf build")).stdout).hookSpecificOutput.permissionDecision).toBe("ask");
});

test("F6 a symlink into a work repo is judged by its target", () => {
  const work = join(dir, "projects", "acme", "app");
  Bun.spawnSync(["mkdir", "-p", work, join(dir, "elsewhere")]);
  Bun.spawnSync(["ln", "-sf", join(work, "plan.md"), join(dir, "elsewhere", "link.md")]);
  expect(run(["check"], writeCall(join(dir, "elsewhere", "link.md"))).code).toBe(2);
  expect(run(["check"], writeCall(join(work, "README.md"))).code).toBe(0);
});

test("F7 a bare git push asks on main and not on a feature branch", () => {
  const repo = join(dir, "repo");
  Bun.spawnSync(["mkdir", "-p", repo]);
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: repo });
  const payload = { hook_event_name: "PreToolUse", cwd: repo, tool_name: "Bash", tool_input: { command: "git push" } };
  expect(JSON.parse(run(["check"], payload).stdout).hookSpecificOutput.permissionDecision).toBe("ask");
  Bun.spawnSync(["git", "checkout", "-q", "-b", "feature/x"], { cwd: repo });
  expect(run(["check"], payload).stdout).toBe("");
});

test("F10 the codex client turns ask into exit 2 with a reason", () => {
  const r = run(["check", "--client", "codex"], bashCall("rm -rf build"));
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("confirme e rode de novo");
});

test("a stdin that never closes does not hang the command", async () => {
  const started = performance.now();
  const proc = Bun.spawn(["bun", join(root, "bin/herdr-jev.js"), "rules", "check"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: dir, JEV_CONFIG_DIR: join(dir, "cfg") },
  });
  proc.stdin.write("{\"tool_name\":\"Write\",");
  proc.stdin.flush();
  const code = await proc.exited;
  proc.stdin.end();
  expect(code).toBe(2);
  expect(performance.now() - started).toBeLessThan(8000);
}, 12000);
