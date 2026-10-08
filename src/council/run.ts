import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveStateDir } from "../herdr/state-dir.js";
import { commandOf, DIFF_CAP, MEMBER_BINARIES, MEMBER_NAMES, PROMPT_FILE_NAME, VERSION_SIGNATURES } from "./members.js";
import { parseMemberOutput } from "./parse.js";
import { acquireRepoLock, STALE_AGE_MS, sweepStale } from "./scope.js";
import { defaultSpawn, type ProcessOutput, type SpawnedProcess, type SpawnFn } from "./spawn.js";
import type { CouncilMemberName, CouncilMemberResult, CouncilRun } from "./types.js";
import { buildReviewPatch, createReviewWorktree, resolveRepoRoot, type ReviewPatch } from "./worktree.js";

export const DEFAULT_MEMBER_TIMEOUT_MS = 8 * 60 * 1000;
const VERSION_TIMEOUT_MS = 10_000;
const KILL_SETTLE_MS = 4_000;

export interface RunCouncilOptions {
  cwd: string;
  base?: string;
  members?: CouncilMemberName[];
  timeoutMs?: number;
  question?: string;
  availableClients?: string[];
  exclude?: CouncilMemberName[];
  spawn?: SpawnFn;
  signal?: AbortSignal;
  stateDir?: string;
}

const CLIENT_ALIASES: Readonly<Record<string, CouncilMemberName>> = {
  codex: "codex",
  kimi: "kimi",
  antigravity: "antigravity",
  agy: "antigravity",
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeDuration(ms: number): string {
  return ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)}s`;
}

type Outcome = { kind: "output"; output: ProcessOutput } | { kind: "timeout" } | { kind: "aborted" };

async function waitFor(proc: SpawnedProcess, timeoutMs: number, signal: AbortSignal | undefined): Promise<Outcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupt = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    if (signal) {
      if (signal.aborted) resolve({ kind: "aborted" });
      else {
        onAbort = () => resolve({ kind: "aborted" });
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }
  });
  try {
    const outcome = await Promise.race([proc.result.then((output): Outcome => ({ kind: "output", output })), interrupt]);
    if (outcome.kind !== "output") {
      proc.kill();
      await Promise.race([proc.result.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, KILL_SETTLE_MS))]);
    }
    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort && signal) signal.removeEventListener("abort", onAbort);
  }
}

type Probe = "installed" | "missing" | "aborted";

async function probe(member: CouncilMemberName, spawn: SpawnFn, cwd: string, signal: AbortSignal | undefined): Promise<Probe> {
  try {
    const outcome = await waitFor(spawn([MEMBER_BINARIES[member], "--version"], { cwd }), VERSION_TIMEOUT_MS, signal);
    if (outcome.kind === "aborted") return "aborted";
    if (outcome.kind !== "output" || outcome.output.exitCode !== 0) return "missing";
    const first = outcome.output.stdout.trim().split("\n")[0]?.trim() ?? "";
    return VERSION_SIGNATURES[member].test(first) ? "installed" : "missing";
  } catch {
    return "missing";
  }
}

function result(member: CouncilMemberName, status: CouncilMemberResult["status"], startedAt: number, reason?: string, findings: CouncilMemberResult["findings"] = [], note?: string): CouncilMemberResult {
  const entry: CouncilMemberResult = { member, status, findings, durationMs: Math.max(0, Date.now() - startedAt) };
  if (reason !== undefined) entry.reason = reason;
  if (note) entry.note = note;
  return entry;
}

function skipped(member: CouncilMemberName, reason: string): CouncilMemberResult {
  return { member, status: "skipped", reason, findings: [], durationMs: 0 };
}

function join2(parts: Array<string | undefined>): string | undefined {
  const filled = parts.filter((part): part is string => Boolean(part));
  return filled.length > 0 ? filled.join("; ") : undefined;
}

interface MemberContext {
  patch: ReviewPatch;
  spawn: SpawnFn;
  timeoutMs: number;
  question?: string;
  signal?: AbortSignal;
  stateDir: string;
}

async function runMember(member: CouncilMemberName, context: MemberContext): Promise<CouncilMemberResult> {
  const startedAt = Date.now();
  let worktree: Awaited<ReturnType<typeof createReviewWorktree>> | undefined;
  let outcome: CouncilMemberResult;
  try {
    worktree = await createReviewWorktree(context.patch, member, context.stateDir);
    const promptPath = join(worktree.path, PROMPT_FILE_NAME);
    const command = commandOf(member, { diff: context.patch.promptDiff, question: context.question }, promptPath, context.timeoutMs);
    if (command.promptFile !== undefined) {
      writeFileSync(promptPath, command.promptFile, { encoding: "utf8", mode: 0o600 });
      chmodSync(promptPath, 0o600);
    }
    if (context.signal?.aborted) {
      outcome = result(member, "failed", startedAt, "cancelled");
    } else {
      const proc = context.spawn(command.argv, { cwd: worktree.path, stdin: command.stdin });
      const waited = await waitFor(proc, context.timeoutMs, context.signal);
      if (waited.kind === "timeout") outcome = result(member, "failed", startedAt, `timed out after ${describeDuration(context.timeoutMs)}`);
      else if (waited.kind === "aborted") outcome = result(member, "failed", startedAt, "cancelled");
      else {
        const parsed = parseMemberOutput(member, waited.output, worktree.roots, { question: context.question !== undefined });
        const cut = waited.output.truncated ? "output cut at the capture limit" : undefined;
        if ("error" in parsed) outcome = result(member, "failed", startedAt, parsed.error, [], cut);
        else outcome = result(member, "done", startedAt, undefined, parsed.findings, join2([parsed.note, cut]));
      }
    }
  } catch (error) {
    outcome = result(member, "failed", startedAt, `cannot run: ${message(error)}`.slice(0, 400));
  }
  if (worktree) {
    const problem = await worktree.remove();
    if (problem) outcome.note = join2([outcome.note, problem]);
  }
  return outcome;
}

function ordered(results: CouncilMemberResult[]): CouncilMemberResult[] {
  const order = new Map(MEMBER_NAMES.map((member, index) => [member, index] as const));
  return [...results].sort((a, b) => (order.get(a.member) ?? 0) - (order.get(b.member) ?? 0));
}

function stopped(candidates: CouncilMemberName[], results: CouncilMemberResult[], reason: string, extra: Partial<CouncilRun>): CouncilRun {
  return { members: ordered([...results, ...candidates.map((member) => skipped(member, reason))]), diffHash: "", ran: false, ...extra };
}

export async function runCouncil(opts: RunCouncilOptions): Promise<CouncilRun> {
  const spawn = opts.spawn ?? defaultSpawn;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_MEMBER_TIMEOUT_MS;
  const stateDir = opts.stateDir ?? resolveStateDir();
  const excluded = new Set(opts.exclude ?? []);
  const requested = [...new Set(opts.members ?? MEMBER_NAMES)];
  const results: CouncilMemberResult[] = [];

  if (opts.signal?.aborted) return stopped(requested, [], "cancelled", { note: "council cancelled before start" });

  let candidates: CouncilMemberName[] = [];
  const allowed = opts.availableClients ? new Set(opts.availableClients.map((client) => CLIENT_ALIASES[client.trim().toLowerCase()]).filter((member): member is CouncilMemberName => member !== undefined)) : undefined;
  for (const member of requested) {
    if (excluded.has(member)) results.push(skipped(member, "excluded: implementer"));
    else if (allowed && !allowed.has(member)) results.push(skipped(member, "client not available"));
    else candidates.push(member);
  }
  if (candidates.length < 2) return stopped(candidates, results, "fewer than two runnable members", { note: "fewer than two council members available; nothing was run" });

  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  sweepStale(stateDir, Math.max(STALE_AGE_MS, timeoutMs * 3));

  let repoRoot: string;
  try {
    repoRoot = await resolveRepoRoot(opts.cwd);
  } catch (error) {
    return stopped(candidates, results, "no diff", { note: `cannot read the diff: ${message(error)}`.slice(0, 400) });
  }
  const lock = acquireRepoLock(stateDir, repoRoot, Math.max(STALE_AGE_MS, timeoutMs * 3));
  if (!lock) return stopped(candidates, results, "council already running", { note: "a council run is already in progress for this repository" });

  try {
    let patch: ReviewPatch;
    try {
      patch = await buildReviewPatch(opts.cwd, opts.base);
    } catch (error) {
      return stopped(candidates, results, "no diff", { note: `cannot read the diff: ${message(error)}`.slice(0, 400) });
    }
    const leftOut: string[] = [];
    if (patch.skippedPaths.length > 0) leftOut.push(`${patch.skippedPaths.length} sensitive path${patch.skippedPaths.length === 1 ? "" : "s"} left out`);
    if (patch.oversizedPaths.length > 0) leftOut.push(`${patch.oversizedPaths.length} unreadable or oversized untracked file${patch.oversizedPaths.length === 1 ? "" : "s"} left out`);
    const skippedPaths = [...patch.skippedPaths, ...patch.oversizedPaths];
    const withPaths = (run: CouncilRun): CouncilRun => {
      if (skippedPaths.length > 0) run.skippedPaths = skippedPaths;
      return run;
    };
    if (patch.patch.trim() === "") return withPaths(stopped(candidates, results, "empty diff", { note: join2(["empty diff; nothing to review", ...leftOut]), diffHash: patch.hash }));

    const probes = await Promise.all(candidates.map(async (member) => ({ member, state: await probe(member, spawn, stateDir, opts.signal) })));
    if (probes.some((entry) => entry.state === "aborted") || opts.signal?.aborted) return withPaths(stopped(candidates, results, "cancelled", { note: "council cancelled during the install check", diffHash: patch.hash }));
    const runnable: CouncilMemberName[] = [];
    for (const { member, state } of probes) {
      if (state === "installed") runnable.push(member);
      else results.push(skipped(member, "not installed"));
    }
    if (runnable.length < 2) return withPaths(stopped(runnable, results, "fewer than two runnable members", { note: join2(["fewer than two council members are installed; nothing was run", ...leftOut]), diffHash: patch.hash }));

    const context: MemberContext = { patch, spawn, timeoutMs, question: opts.question, signal: opts.signal, stateDir };
    const ran = await Promise.all(runnable.map((member) => runMember(member, context)));
    results.push(...ran);
    const notes = [...leftOut];
    if (patch.promptDiff.length > DIFF_CAP) notes.push(`prompt diff truncated from ${patch.promptDiff.length} to ${DIFF_CAP} characters`);
    return withPaths({ members: ordered(results), diffHash: patch.hash, ran: true, ...(notes.length > 0 ? { note: notes.join("; ") } : {}) });
  } finally {
    lock.release();
  }
}
