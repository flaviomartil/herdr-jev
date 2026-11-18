import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunCommand } from "../src/herdr/client.js";
import { watchPullRequest } from "../src/herdr/pr-watch.js";

const roots: string[] = [];
const url = "https://github.com/owner/repo/pull/42";
const input = { target: "Owner/Repo#42", session: "native-id", once: true };
const check = (conclusion: string, status = "COMPLETED") => ({ __typename: "CheckRun", status, conclusion });
const snapshot = (fields: Record<string, unknown> = {}) => ({
  number: 42, state: "OPEN", reviewDecision: "", reviewRequests: [], statusCheckRollup: [], ...fields,
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const stateRoot = mkdtempSync(join(tmpdir(), "jev-pr-watch-"));
  roots.push(stateRoot);
  const events = new Map<string, { kind: string; title: string }>();
  const attempts: string[] = [];
  let answer: unknown = snapshot();
  let loseReceipt = false;
  let polls = 0;
  const run: RunCommand = async args => {
    expect(args).toEqual(["gh", "pr", "view", "42", "--repo", "github.com/owner/repo", "--json", "number,state,reviewDecision,reviewRequests,statusCheckRollup"]);
    polls++;
    return { ok: true, code: 0, stderr: "", stdout: JSON.stringify(answer) };
  };
  const history = async (args: string[]) => {
    if (args[0] === "show") return { session: { key: "codex:indexed" } };
    expect(args.slice(0, 3)).toEqual(["work-event", "--session", "codex:indexed"]);
    const id = args[4]!;
    attempts.push(id);
    const created = !events.has(id);
    events.set(id, { kind: args[6]!, title: args[8]! });
    if (loseReceipt) {
      loseReceipt = false;
      throw new Error("lost receipt");
    }
    return { work: { id: `item-${events.size}` }, created };
  };
  const deps = { stateRoot, run, history, reserve: async () => async () => {} };
  return { deps, events, attempts,
    polls: () => polls,
    set: (next: unknown) => { answer = next; },
    loseNextReceipt: () => { loseReceipt = true; },
  };
}

test("only observed transitions produce alerts, with the target and indexed session", async () => {
  const f = fixture();
  expect(await watchPullRequest(input, f.deps)).toEqual({ url, session: "codex:indexed", state: "OPEN", delivered: 0 });
  f.set(snapshot({ reviewRequests: [{ login: "reviewer" }], statusCheckRollup: [check("NEUTRAL"), check("FAILURE")] }));
  expect((await watchPullRequest(input, f.deps)).delivered).toBe(2);
  expect((await watchPullRequest({ ...input, target: url }, f.deps)).delivered).toBe(0);
  f.set(snapshot({ reviewDecision: "CHANGES_REQUESTED", statusCheckRollup: [check("FAILURE")] }));
  expect((await watchPullRequest(input, f.deps)).delivered).toBe(1);
  f.set(snapshot({ reviewDecision: "APPROVED", statusCheckRollup: [check("", "IN_PROGRESS")] }));
  expect((await watchPullRequest(input, f.deps)).delivered).toBe(0);
  f.set(snapshot({ statusCheckRollup: [{ __typename: "StatusContext", state: "ERROR" }] }));
  expect((await watchPullRequest(input, f.deps)).delivered).toBe(1);
  f.set(snapshot({ state: "MERGED", reviewDecision: "CHANGES_REQUESTED", statusCheckRollup: [check("FAILURE")] }));
  expect((await watchPullRequest({ ...input, once: false }, f.deps)).state).toBe("MERGED");
  expect((await watchPullRequest(input, f.deps)).delivered).toBe(0);
  expect([...f.events.values()]).toEqual([
    { kind: "error", title: `Checks failed · ${url}` },
    { kind: "review", title: `Review required · ${url}` },
    { kind: "review", title: `Changes requested · ${url}` },
    { kind: "error", title: `Checks failed · ${url}` },
    { kind: "review", title: `Merged · ${url}` },
  ]);
  expect(f.attempts).toHaveLength(5);
});

test("resumes a failed acknowledgement using the same event ID", async () => {
  const f = fixture();
  f.set(snapshot({ reviewDecision: "REVIEW_REQUIRED", statusCheckRollup: [check("TIMED_OUT")], title: "untrusted provider text" }));
  f.loseNextReceipt();
  await expect(watchPullRequest(input, f.deps)).rejects.toThrow("lost receipt");
  const dir = join(f.deps.stateRoot, "github-pr-watch-v1");
  const file = readdirSync(dir)[0]!;
  expect(readFileSync(join(dir, file), "utf8")).not.toContain("untrusted provider text");
  expect((await watchPullRequest(input, f.deps)).delivered).toBe(1);
  expect(f.attempts[0]).toEqual(f.attempts[1]);
  expect(f.events.size).toBe(2);
  expect((await watchPullRequest(input, f.deps)).delivered).toBe(0);
});

test("rejects malformed status and a different PR without resetting a current failure", async () => {
  const f = fixture();
  const failing = snapshot({ statusCheckRollup: [check("FAILURE")] });
  f.set(failing);
  await watchPullRequest(input, f.deps);
  f.set(snapshot({ statusCheckRollup: [{ __typename: "Other" }] }));
  await expect(watchPullRequest(input, f.deps)).rejects.toThrow("invalid check status");
  f.set(snapshot({ number: 43 }));
  await expect(watchPullRequest(input, f.deps)).rejects.toThrow("invalid pull request data");
  f.set(failing);
  expect((await watchPullRequest(input, f.deps)).delivered).toBe(0);
  f.set(snapshot({ state: "CLOSED", reviewDecision: "CHANGES_REQUESTED" }));
  expect(await watchPullRequest({ ...input, once: false }, f.deps)).toMatchObject({ state: "CLOSED", delivered: 0 });
  expect(f.events.size).toBe(1);
});

test("rejects out-of-scope targets before accessing GitHub or the inbox", async () => {
  const f = fixture();
  const history = async () => { throw new Error("unexpected inbox access"); };
  for (const target of ["https://github.example/owner/repo/pull/42", "https://github.com/owner/repo/issues/42", "owner/..#42"]) {
    await expect(watchPullRequest({ ...input, target }, { ...f.deps, history })).rejects.toThrow("GitHub pull request URL");
  }
  expect(f.polls()).toBe(0);
});

test.skipIf(!Bun.which("flock"))("one watcher owns a PR and session across Herdr sockets", async () => {
  const f = fixture();
  const previousState = process.env.HERDR_JEV_STATE_DIR;
  const previousSocket = process.env.HERDR_SOCKET_PATH;
  process.env.HERDR_JEV_STATE_DIR = f.deps.stateRoot;
  process.env.HERDR_SOCKET_PATH = "/tmp/first-herdr";
  const started = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<void>();
  const deps = { ...f.deps, reserve: undefined };
  const first = watchPullRequest(input, { ...deps, run: async args => {
    started.resolve();
    await pending.promise;
    return f.deps.run(args);
  } });
  try {
    await started.promise;
    process.env.HERDR_SOCKET_PATH = "/tmp/second-herdr";
    await expect(watchPullRequest(input, deps)).rejects.toThrow("already reserved");
    expect(f.polls()).toBe(0);
  } finally {
    pending.resolve();
    await first;
    if (previousState === undefined) delete process.env.HERDR_JEV_STATE_DIR;
    else process.env.HERDR_JEV_STATE_DIR = previousState;
    if (previousSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = previousSocket;
  }
  expect((await watchPullRequest(input, f.deps)).delivered).toBe(0);
});
