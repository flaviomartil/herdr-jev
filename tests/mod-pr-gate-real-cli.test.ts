import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";

const present = spawnSync("ai-harness", ["review-status", "--client", "claude", "--session", "probe", "--cwd", tmpdir()], { encoding: "utf8", timeout: 15_000 }).status === 0;
const real = present ? test : test.skip;

function status(args: string[]): { code: number | null; out: string; err: string } {
  const ran = spawnSync("ai-harness", ["review-status", ...args], { encoding: "utf8", timeout: 15_000 });
  return { code: ran.status, out: ran.stdout.trim(), err: ran.stderr.trim() };
}

real("review-status reads null for an identity no review wrote and fails with empty stdout when the session is missing", () => {
  const unknown = status(["--client", "claude", "--session", `jev-review-${randomBytes(6).toString("hex")}`, "--cwd", tmpdir()]);
  expect(unknown.code).toBe(0);
  expect(JSON.parse(unknown.out)).toBeNull();

  const missing = status(["--client", "claude", "--cwd", tmpdir()]);
  expect(missing.code).toBe(1);
  expect(missing.out).toBe("");
  const parsed = JSON.parse(missing.err) as Record<string, unknown>;
  expect(parsed.status).toBeUndefined();
  expect(typeof parsed.error).toBe("string");
});

real("a present review-status row only ever carries one of the four statuses the gate accepts", () => {
  const sessionId = process.env.CLAUDE_SESSION_ID;
  if (!sessionId) return;
  const own = status(["--client", "claude", "--session", sessionId, "--cwd", process.cwd()]);
  const parsed = JSON.parse(own.out) as { status?: string } | null;
  if (parsed === null) return;
  expect(["pending_verification", "pending_review", "changes_required", "ready"]).toContain(parsed.status as string);
});
