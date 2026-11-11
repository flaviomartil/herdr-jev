import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestStateDir } from "../helpers";
import { readEvents, runDir, summarize } from "../../src/panes/events";
import { boundResult, buildInvocation, cleanAnswer, runWorker, runWorkerDetailed } from "../../src/panes/worker-run";
import { makeFakes, mkTmp, waitFor } from "./fakes";

const fakes = makeFakes();
const state = createTestStateDir();
const work = mkTmp("work");
const promptFile = join(work, "prompt.txt");
writeFileSync(promptFile, "do the thing");

afterAll(() => state.cleanup());

test("codex invocation uses a profile when its config exists, else --model, prompt on stdin", () => {
  const withProfile = buildInvocation({ cli: "codex", model: "luna", effort: "low", prompt: "p" }, { codexProfileExists: (n) => n === "luna" });
  expect(withProfile.argv).toEqual(["codex", "exec", "-p", "luna", "-c", 'model_reasoning_effort="low"', "-"]);
  expect(withProfile.stdin).toBe("p");
  const plain = buildInvocation({ cli: "codex", model: "gpt-5-5", prompt: "p" }, { codexProfileExists: () => false });
  expect(plain.argv).toEqual(["codex", "exec", "--model", "gpt-5-5", "-"]);
});

test("codex alias without a profile fails early, and models.local.yml maps aliases to profiles", () => {
  expect(() => buildInvocation({ cli: "codex", model: "terra", prompt: "p" }, { codexProfileExists: () => false })).toThrow("codex profile terra ausente");
  const mapped = buildInvocation({ cli: "codex", model: "terra", prompt: "p" }, { codexProfileExists: (n) => n === "px", codexMap: { terra: "px" } });
  expect(mapped.argv.slice(0, 4)).toEqual(["codex", "exec", "-p", "px"]);
  const explicit = buildInvocation({ cli: "codex", model: "terra", prompt: "p" }, { codexProfileExists: (n) => n === "eco", codexMap: { terra: "profile:eco" } });
  expect(explicit.argv.slice(2, 4)).toEqual(["-p", "eco"]);
  expect(() => buildInvocation({ cli: "codex", model: "sol", prompt: "p" }, { codexProfileExists: () => false, codexMap: { sol: "profile:nope" } })).toThrow("codex profile nope ausente");
  const plain = buildInvocation({ cli: "codex", model: "sol", prompt: "p" }, { codexProfileExists: () => false, codexMap: { sol: "gpt-5-5" } });
  expect(plain.argv.slice(2, 4)).toEqual(["--model", "gpt-5-5"]);
});

test("worker-run with a missing codex profile records a failed exit and never starts the CLI", async () => {
  const home = mkTmp("home");
  const env = fakes.env({ HERDR_JEV_STATE_DIR: state.stateDir, HOME: home });
  const lines: string[] = [];
  const code = await runWorker({ runId: "r-noprofile", cli: "codex", model: "terra", promptFile, cwd: work, env, echo: (l) => lines.push(l) });
  expect(code).toBe(2);
  expect(lines).toEqual(["codex profile terra ausente"]);
  const sum = summarize("r-noprofile", readEvents("r-noprofile", env));
  expect([sum.state, sum.tail]).toEqual(["failed", "codex profile terra ausente"]);
  expect(readFileSync(fakes.log, "utf8")).not.toContain("codex exec");
});

test("agy attaches the prompt with -p= and skips permissions; claude uses -p with stdin", () => {
  const agy = buildInvocation({ cli: "agy", model: "gemini-flash", effort: "low", prompt: "-dash prompt" });
  expect(agy.argv).toEqual(["agy", "--model", "gemini-flash", "--effort", "low", "--dangerously-skip-permissions", "-p=-dash prompt"]);
  expect(agy.stdin).toBeUndefined();
  const claude = buildInvocation({ cli: "claude", model: "claude-haiku-5-5", effort: "low", prompt: "p" });
  expect(claude.argv).toEqual(["claude", "-p", "--model", "claude-haiku-5-5", "--effort", "low"]);
  expect(claude.stdin).toBe("p");
});

test("invalid model or effort is refused", () => {
  expect(() => buildInvocation({ cli: "agy", model: "x; rm -rf", prompt: "p" })).toThrow();
  expect(() => buildInvocation({ cli: "agy", model: "ok", effort: "bogus", prompt: "p" })).toThrow();
});

test("worker-run records start with pid and pgid, output and exit, and passes args to the CLI", async () => {
  const env = fakes.env({ HERDR_JEV_STATE_DIR: state.stateDir });
  const lines: string[] = [];
  const code = await runWorker({ runId: "r-ok", cli: "agy", model: "gemini-flash", effort: "low", promptFile, cwd: work, env, echo: (l) => lines.push(l) });
  expect(code).toBe(0);
  const events = readEvents("r-ok", env);
  expect(events[0]!.type).toBe("start");
  expect(typeof events[0]!.pid).toBe("number");
  expect(events[0]!.pgid).toBe(events[0]!.pid);
  expect(JSON.stringify(events[0]!.argv)).not.toContain("do the thing");
  expect(lines).toContain("out from agy");
  const sum = summarize("r-ok", events);
  expect([sum.state, sum.exitCode, sum.tail]).toEqual(["done", 0, "out from agy"]);
  expect(readFileSync(fakes.log, "utf8")).toContain("agy --model gemini-flash --effort low --dangerously-skip-permissions -p=do the thing");
});

test("a failing worker ends failed with its exit code", async () => {
  const env = fakes.env({ HERDR_JEV_STATE_DIR: state.stateDir, FAKE_EXIT: "3" });
  const code = await runWorker({ runId: "r-fail", cli: "claude", model: "claude-haiku-5-5", promptFile, cwd: work, env, echo: () => undefined });
  expect(code).toBe(3);
  expect(summarize("r-fail", readEvents("r-fail", env)).state).toBe("failed");
});

test("absolute timeout kills the whole process group, children included", async () => {
  const pidFile = join(work, "child.pid");
  const env = fakes.env({ HERDR_JEV_STATE_DIR: state.stateDir, FAKE_CHILD_PID_FILE: pidFile });
  const code = await runWorker({ runId: "r-abs", cli: "codex", model: "gpt-5-5", promptFile, cwd: work, env, echo: () => undefined, timeoutMs: 700, graceMs: 200 });
  expect(code).toBe(124);
  const sum = summarize("r-abs", readEvents("r-abs", env));
  expect(sum.state).toBe("timeout");
  const child = Number(readFileSync(pidFile, "utf8").trim());
  const dead = await waitFor(() => {
    try {
      process.kill(child, 0);
      return false;
    } catch {
      return true;
    }
  }, 3000);
  expect(dead).toBe(true);
});

test("inactivity timeout kills a silent worker", async () => {
  const env = fakes.env({ HERDR_JEV_STATE_DIR: state.stateDir, FAKE_SLEEP: "30" });
  const code = await runWorker({ runId: "r-idle", cli: "agy", model: "gemini-flash", promptFile, cwd: work, env, echo: () => undefined, inactivityMs: 500, graceMs: 200 });
  expect(code).toBe(124);
  const kinds = readEvents("r-idle", env).filter((e) => e.type === "timeout").map((e) => e.kind);
  expect(kinds).toEqual(["inactivity"]);
});

test("grandchildren that ignore SIGTERM are SIGKILLed before the wrapper returns", async () => {
  const pidFile = join(work, "stubborn.pid");
  const env = fakes.env({ HERDR_JEV_STATE_DIR: state.stateDir, FAKE_STUBBORN_PID_FILE: pidFile });
  const code = await runWorker({ runId: "r-stubborn", cli: "codex", model: "gpt-5-5", promptFile, cwd: work, env, echo: () => undefined, timeoutMs: 600, graceMs: 100 });
  expect(code).toBe(124);
  const child = Number(readFileSync(pidFile, "utf8").trim());
  expect(await waitFor(() => { try { process.kill(child, 0); return false; } catch { return true; } }, 3000)).toBe(true);
});

test("codex gets --output-last-message when a result file is given", () => {
  const inv = buildInvocation({ cli: "codex", model: "gpt-5-5", prompt: "p", resultFile: "/r/result.txt" }, { codexProfileExists: () => false });
  expect(inv.argv).toEqual(["codex", "exec", "--model", "gpt-5-5", "--output-last-message", "/r/result.txt", "-"]);
});

test("cleanAnswer drops hook lines and the token footer", () => {
  expect(cleanAnswer(["hook: Stop", "the answer", "line 2", "", "hook: Stop Completed", "tokens used", "20,404"])).toBe("the answer\nline 2");
  expect(cleanAnswer(["only", "Tokens: 12"])).toBe("only");
  expect(cleanAnswer(["hook: x"])).toBe("");
  expect(boundResult("x".repeat(9000)).length).toBe(8000);
});

test("a successful worker carries its answer in the exit event and result.txt", async () => {
  const env = fakes.env({ HERDR_JEV_STATE_DIR: state.stateDir });
  const report = await runWorkerDetailed({ runId: "r-result", cli: "claude", model: "claude-haiku-5-5", promptFile, cwd: work, env, echo: () => undefined });
  expect(report.result).toBe("out from claude");
  const sum = summarize("r-result", readEvents("r-result", env));
  expect(sum.result).toBe("out from claude");
  expect(readFileSync(join(runDir("r-result", env), "result.txt"), "utf8").trim()).toBe("out from claude");
});
