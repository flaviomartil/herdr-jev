import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestStateDir } from "../helpers";
import { appendEvent, readEvents, summarize } from "../../src/panes/events";
import { createHost, detectHost, processCmd } from "../../src/panes/host";
import * as manager from "../../src/panes/manager";
import { main } from "../../src/panes/cli";
import { makeFakes, mkTmp, waitFor } from "./fakes";

const fakes = makeFakes();
const base = createTestStateDir();
const state = { stateDir: base.stateDir };
const work = mkTmp("mgr");
const env = (extra: Record<string, string> = {}) => ({ ...fakes.env({ HERDR_JEV_STATE_DIR: state.stateDir, HERDR_JEV_BIN: "/opt/fake/herdr-jev", ...extra }) });
const log = () => readFileSync(fakes.log, "utf8").split("\n").filter(Boolean);
let counter = 0;
const id = () => `jevtest-run${++counter}`;
const ctxFor = (e: NodeJS.ProcessEnv): manager.Ctx => ({ env: e, cmd: (argv, o) => processCmd(argv, o) });

beforeEach(() => {
  writeFileSync(fakes.log, "");
  state.stateDir = mkTmp("state");
  process.env.HERDR_JEV_STATE_DIR = state.stateDir;
  process.env.PATH = fakes.env().PATH!;
  process.env.FAKE_LOG = fakes.log;
  process.env.FAKE_DIR = fakes.dir;
});
afterAll(() => base.cleanup());

const finish = (runId: string, e: NodeJS.ProcessEnv) => appendEvent(runId, { type: "exit", code: 0, outcome: "done", tail: "ok" }, e);

test("detection order: herdr env, TMUX, ghostty on darwin, background", () => {
  const has = { hasBin: () => true };
  expect(detectHost({ HERDR_PANE_ID: "p", TMUX: "x", TERM_PROGRAM: "ghostty" }, { platform: "darwin", ...has })).toBe("herdr");
  expect(detectHost({ TMUX: "x", TERM_PROGRAM: "ghostty" }, { platform: "darwin", ...has })).toBe("tmux");
  expect(detectHost({ TERM_PROGRAM: "ghostty" }, { platform: "darwin", ...has })).toBe("ghostty");
  expect(detectHost({ TERM_PROGRAM: "ghostty" }, { platform: "linux", ...has })).toBe("background");
  expect(detectHost({ TERM_PROGRAM: "ghostty" }, { platform: "darwin", hasBin: () => false })).toBe("background");
  expect(detectHost({}, { platform: "linux", ...has })).toBe("background");
});

test("herdr adapter splits in the same tab, titles the pane and runs the worker line under sh", async () => {
  const e = env({ HERDR_PANE_ID: "p-origin" });
  const result = await manager.start(ctxFor(e), { runId: id(), name: "ana", cli: "codex", model: "luna", effort: "low", prompt: "task one", cwd: work });
  expect(result).toMatchObject({ status: "started", host: "herdr", paneId: "p-1", title: "ana · codex" });
  const lines = log();
  expect(lines.some((l) => l.startsWith("herdr pane split --pane p-origin --direction right --cwd") && l.endsWith("--no-focus"))).toBe(true);
  expect(lines).toContain("herdr pane rename p-1 ana · codex");
  const run = lines.find((l) => l.startsWith("herdr pane run p-1 sh -c"))!;
  expect(run).toMatch(/worker-run --cli codex --model .{0,6}luna.{0,6} --effort .{0,6}low/);
  expect(run).toContain("panes pump");
});

test("tmux adapter uses split-window in the current pane and titles it", async () => {
  const e = env({ TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%0" });
  const result = await manager.start(ctxFor(e), { runId: id(), name: "bea", cli: "agy", model: "gemini-flash", prompt: "t", cwd: work });
  expect(result).toMatchObject({ status: "started", host: "tmux", title: "bea · agy" });
  const lines = log();
  expect(lines.some((l) => l.startsWith("tmux split-window -d -P -F #{pane_id} -h -c") && l.includes("-t %0 sh -c"))).toBe(true);
  expect(lines.some((l) => l.startsWith("tmux select-pane -t %") && l.endsWith("-T bea · agy"))).toBe(true);
});

test("the 4th delegation waits in the queue and gets a pane when one finishes", async () => {
  const e = env({ HERDR_PANE_ID: "p-origin" });
  const ctx = ctxFor(e);
  const before = log().filter((l) => l.startsWith("herdr pane split")).length;
  const ids = [id(), id(), id(), id()];
  const results = [];
  for (const runId of ids) results.push(await manager.start(ctx, { runId, cli: "codex", model: "luna", prompt: "t", cwd: work }));
  expect(results.map((r) => r.status)).toEqual(["started", "started", "started", "queued"]);
  expect(log().filter((l) => l.startsWith("herdr pane split")).length - before).toBe(3);
  expect(summarize(ids[3]!, readEvents(ids[3]!, e)).state).toBe("queued");
  finish(ids[0]!, e);
  expect(await manager.pump(ctx)).toEqual([ids[3]]);
  expect(log().filter((l) => l.startsWith("herdr pane split")).length - before).toBe(4);
});

test("background fallback runs the real worker through the wrapper without any multiplexer", async () => {
  const e = env({ HERDR_JEV_BIN: join(process.cwd(), "bin", "herdr-jev.js"), FAKE_EXIT: "0" });
  const runId = id();
  const result = await manager.start(ctxFor(e), { runId, name: "bg", cli: "agy", model: "gemini-flash", effort: "low", prompt: "background task", cwd: work });
  expect(result).toMatchObject({ status: "started", host: "background" });
  expect(await waitFor(() => summarize(runId, readEvents(runId, e)).state === "done")).toBe(true);
  expect(log().some((l) => l.startsWith("agy --model gemini-flash") && l.endsWith("-p=background task"))).toBe(true);
  expect(log().some((l) => l.startsWith("herdr ") || l.startsWith("tmux "))).toBe(false);
});

test("abort sends SIGTERM to the recorded pgid and marks the run interrupted", async () => {
  const e = env({ HERDR_JEV_BIN: join(process.cwd(), "bin", "herdr-jev.js"), FAKE_CHILD_PID_FILE: join(work, "abort-child.pid") });
  const runId = id();
  const ctx = ctxFor(e);
  await manager.start(ctx, { runId, cli: "codex", model: "gpt-5-5", prompt: "long", cwd: work, host: "background", session: "S1" });
  expect(await waitFor(() => summarize(runId, readEvents(runId, e)).pgid !== null && existsSync(join(work, "abort-child.pid")))).toBe(true);
  const child = Number(readFileSync(join(work, "abort-child.pid"), "utf8").trim());
  expect(await manager.abort(ctx, { session: "S1" })).toEqual([runId]);
  expect(await waitFor(() => {
    try {
      process.kill(child, 0);
      return false;
    } catch {
      return true;
    }
  }, 4000)).toBe(true);
  expect(summarize(runId, readEvents(runId, e)).state).toBe("interrupted");
});

test("close and restart of a running worker need confirmation; restart reuses the prompt under a new run id", async () => {
  const e = env({ HERDR_PANE_ID: "p-origin" });
  const ctx = ctxFor(e);
  const runId = id();
  await manager.start(ctx, { runId, name: "carl", cli: "codex", model: "luna", prompt: "same task", cwd: work });
  appendEvent(runId, { type: "start", pid: 99999991, pgid: 99999991 }, e);
  const refused = await manager.close(ctx, "carl", false);
  expect(refused).toMatchObject({ ok: false, needsConfirm: true });
  const restarted = await manager.restart(ctx, "carl", true);
  expect(restarted.ok).toBe(true);
  expect(restarted.runId).toBe(`${runId}-r2`);
  expect(log().some((l) => l.startsWith("herdr pane close p-"))).toBe(true);
  const entry = manager.resolveEntry(ctx, `${runId}-r2`)!;
  expect(readFileSync(entry.promptFile, "utf8")).toBe("same task");
});

test("focus and send go to the pane host", async () => {
  const e = env({ HERDR_PANE_ID: "p-origin" });
  const ctx = ctxFor(e);
  const runId = id();
  await manager.start(ctx, { runId, name: "dora", cli: "claude", model: "claude-haiku-5-5", prompt: "t", cwd: work });
  expect((await manager.focus(ctx, "dora")).ok).toBe(true);
  expect((await manager.send(ctx, "dora", "hello there")).ok).toBe(true);
  expect(log().some((l) => l.startsWith("herdr pane send-text p-") && l.endsWith("hello there"))).toBe(true);
  expect(log().some((l) => l.startsWith("herdr pane focus p-"))).toBe(true);
});

test("tab command creates a tab and later runs split inside it", async () => {
  const e = env({ HERDR_PANE_ID: "p-origin" });
  const ctx = ctxFor(e);
  expect((await manager.newTab(ctx, "feature-x", work)).ok).toBe(true);
  expect(log().some((l) => l.startsWith("herdr tab create --label feature-x"))).toBe(true);
  await manager.start(ctx, { runId: id(), cli: "codex", model: "luna", prompt: "t", cwd: work, tab: "feature-x" });
  expect(log().some((l) => l.startsWith("herdr pane split --pane p-root"))).toBe(true);
  const bg = await manager.newTab(ctxFor(env()), "nope", work, "background");
  expect(bg.ok).toBe(false);
});

test("layout restore reopens finished runs with watch and never reruns interrupted ones", async () => {
  const e = env({ HERDR_PANE_ID: "p-origin" });
  const ctx = ctxFor(e);
  const repo = mkTmp("repo");
  const doneId = id();
  const intId = id();
  await manager.start(ctx, { runId: doneId, name: "fin", cli: "codex", model: "luna", prompt: "a", cwd: repo });
  await manager.start(ctx, { runId: intId, name: "cut", cli: "codex", model: "luna", prompt: "b", cwd: repo });
  finish(doneId, e);
  appendEvent(intId, { type: "interrupted" }, e);
  expect((await manager.layoutSave(ctx, repo)).ok).toBe(true);
  const mark = log().length;
  const restored = await manager.layoutRestore(ctx, repo);
  expect(restored.reopened).toEqual([doneId]);
  expect(restored.restartOffered).toEqual([intId]);
  expect(restored.message).toContain("not rerun");
  const added = log().slice(mark).join("\n");
  expect(added).toContain("panes watch");
  expect(added).not.toContain("worker-run");
});

test("cli: panes list and start report JSON, worker-run validates its flags", async () => {
  process.env.HERDR_JEV_STATE_DIR = state.stateDir;
  expect(await main(["worker-run", "--cli", "bogus"])).toBe(2);
  expect(await main(["panes", "nonsense"])).toBe(2);
  expect(createHost("background").kind).toBe("background");
});

test("a pane that dies before the worker starts frees its queue slot", async () => {
  const e = env({ HERDR_PANE_ID: "p-origin" });
  const ctx = ctxFor(e);
  const first = [id(), id(), id()];
  for (const runId of first) await manager.start(ctx, { runId, cli: "codex", model: "luna", prompt: "t", cwd: work });
  const waiting = id();
  process.env.FAKE_PANE_GONE = "1";
  try {
    const result = await manager.start(ctx, { runId: waiting, cli: "codex", model: "luna", prompt: "t", cwd: work });
    expect(result.status).toBe("started");
  } finally {
    delete process.env.FAKE_PANE_GONE;
  }
  for (const runId of first) {
    const sum = summarize(runId, readEvents(runId, e));
    expect([sum.state, sum.tail]).toEqual(["failed", "pane closed before the worker started"]);
  }
});

test("session end detaches visible runs and restore reopens them with watch next to interrupted offers", async () => {
  const e = env({ HERDR_PANE_ID: "p-origin" });
  const ctx = ctxFor(e);
  const repo = mkTmp("repo2");
  const visible = id();
  const bg = id();
  await manager.start(ctx, { runId: visible, name: "vis", cli: "codex", model: "luna", prompt: "a", cwd: repo, session: "S9" });
  await manager.start(ctx, { runId: bg, name: "back", cli: "codex", model: "luna", prompt: "b", cwd: repo, session: "S9", host: "background" });
  appendEvent(visible, { type: "start", pid: 99999990, pgid: 99999990 }, e);
  appendEvent(bg, { type: "start", pid: 99999991, pgid: 99999991 }, e);
  expect(await manager.detach(ctx, "S9")).toEqual([visible]);
  expect(await manager.abort(ctx, { session: "S9", backgroundOnly: true })).toEqual([bg]);
  expect(summarize(visible, readEvents(visible, e))).toMatchObject({ state: "running", detached: true });
  expect(summarize(bg, readEvents(bg, e)).state).toBe("interrupted");
  await manager.layoutSave(ctx, repo);
  const restored = await manager.layoutRestore(ctx, repo);
  expect(restored.detached).toEqual([visible]);
  expect(restored.reopened).toEqual([visible]);
  expect(restored.restartOffered).toEqual([bg]);
});

test("ghostty wraps the worker line in sh -c so fish-like shells accept it", async () => {
  const seen: string[][] = [];
  const host = createHost("ghostty", {}, async (argv) => {
    seen.push(argv);
    return { ok: true, stdout: "term-1\n", stderr: "" };
  });
  const placed = await host.split("a; rc=$?; if [ \"$rc\" -eq 0 ]; then exit; fi", work, "t", {});
  expect(placed).toEqual({ id: "term-1" });
  expect(seen[0]![0]).toBe("osascript");
  expect(seen[0]![2]).toContain("input text \"sh -c ");
});
