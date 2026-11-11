import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestStateDir } from "../helpers";
import { readEvents, summarize } from "../../src/panes/events";
import { runWorkerFailover } from "../../src/failover/worker";
import { Health } from "../../src/failover/health";
import { makeFakes, mkTmp, waitFor } from "../panes/fakes";

const fakes = makeFakes();
const state = createTestStateDir();
const work = mkTmp("fo-work");
const promptFile = join(work, "prompt.txt");
writeFileSync(promptFile, "task");
afterAll(() => state.cleanup());

const script = (name: string, body: string) => {
  writeFileSync(join(fakes.dir, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(fakes.dir, name), 0o755);
};
const envFor = (extra: Record<string, string> = {}) =>
  fakes.env({ HERDR_JEV_STATE_DIR: state.stateDir, HERDR_JEV_HEALTH_DIR: mkdtempSync(join(tmpdir(), "jev-wh-")), ...extra });

test("a silent worker is killed by inactivity with its whole group, retried once, then fails as Timeout", async () => {
  const pidFile = join(work, "child.pid");
  const env = envFor({ FAKE_CHILD_PID_FILE: pidFile });
  script("codex", `sleep 60 & echo $! > "$FAKE_CHILD_PID_FILE"; wait`);
  const code = await runWorkerFailover({ runId: "fo-silent", cli: "codex", model: "gpt-5", promptFile, cwd: work, env, inactivityMs: 400, graceMs: 200, echo: () => undefined });
  expect(code).toBe(124);
  const attempts = readEvents("fo-silent", env).filter((e) => e.type === "attempt");
  expect(attempts.map((e) => e.outcome)).toEqual(["Timeout", "Timeout"]);
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  expect(await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 3000)).toBe(true);
  expect(summarize("fo-silent", readEvents("fo-silent", env)).state).toBe("timeout");
}, 20_000);

test("a chain falls from a quota-locked codex to agy and records one final exit", async () => {
  const env = envFor();
  script("codex", `cat >/dev/null; echo "You've hit your usage limit. Try again in 2 hours."; exit 1`);
  script("agy", `echo "agy ok"; exit 0`);
  const lines: string[] = [];
  const code = await runWorkerFailover({
    runId: "fo-chain", cli: "codex", model: "gpt-5", promptFile, cwd: work, env, echo: (l) => lines.push(l),
    chain: [{ cli: "agy", model: "flash" }],
  });
  expect(code).toBe(0);
  const events = readEvents("fo-chain", env);
  expect(events.filter((e) => e.type === "exit")).toHaveLength(1);
  expect(events.find((e) => e.type === "failover")).toMatchObject({ from: "codex/gpt-5", to: "agy/flash" });
  expect(summarize("fo-chain", events).state).toBe("done");
  expect(new Health({ env }).lockoutFor("codex", "gpt-5")?.reason).toBe("quota");
  expect(lines.join("\n")).toContain("next agy/flash");
});

test("worker-run CLI runs the same chain without Claude", async () => {
  const env = envFor();
  script("codex", `cat >/dev/null; echo "429 Too Many Requests"; echo "usage limit reached, try again in 3 hours"; exit 1`);
  script("agy", `echo "agy via cli"; exit 0`);
  const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "..", "bin", "herdr-jev.js"), "worker-run", "--cli", "codex", "--model", "gpt-5", "--prompt-file", promptFile, "--run-id", "fo-cli", "--cwd", work, "--failover", "--chain", "agy/flash"], { env: env as Record<string, string>, stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(code).toBe(0);
  expect(out).toContain("agy via cli");
  expect(existsSync(join(env.HERDR_JEV_HEALTH_DIR!, "health.json"))).toBe(true);
  expect(summarize("fo-cli", readEvents("fo-cli", env)).state).toBe("done");
}, 20_000);
