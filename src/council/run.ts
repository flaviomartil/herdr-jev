import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { commandOf, MEMBER_BINARIES, MEMBER_NAMES, PROMPT_FILE_NAME } from "./members.js";
import { parseMemberOutput } from "./parse.js";
import { defaultSpawn, type ProcessOutput, type SpawnFn, type SpawnedProcess } from "./spawn.js";
import type { CouncilMemberName, CouncilMemberResult, CouncilRun } from "./types.js";
import { buildReviewPatch, createReviewWorktree, type ReviewPatch } from "./worktree.js";

export const DEFAULT_MEMBER_TIMEOUT_MS = 8 * 60 * 1000;
const VERSION_TIMEOUT_MS = 10_000;
const KILL_SETTLE_MS = 3_000;

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

async function waitFor(process: SpawnedProcess, timeoutMs: number, signal: AbortSignal | undefined): Promise<Outcome> {
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
    const outcome = await Promise.race([process.result.then((output): Outcome => ({ kind: "output", output })), interrupt]);
    if (outcome.kind !== "output") {
      process.kill();
      await Promise.race([process.result.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, KILL_SETTLE_MS))]);
    }
    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort && signal) signal.removeEventListener("abort", onAbort);
  }
}

async function isInstalled(member: CouncilMemberName, spawn: SpawnFn, cwd: string, signal: AbortSignal | undefined): Promise<boolean> {
  try {
    const outcome = await waitFor(spawn([MEMBER_BINARIES[member], "--version"], { cwd }), VERSION_TIMEOUT_MS, signal);
    return outcome.kind === "output" && outcome.output.exitCode === 0;
  } catch {
    return false;
  }
}

function result(member: CouncilMemberName, status: CouncilMemberResult["status"], startedAt: number, reason?: string, findings: CouncilMemberResult["findings"] = []): CouncilMemberResult {
  const entry: CouncilMemberResult = { member, status, findings, durationMs: Math.max(0, Date.now() - startedAt) };
  if (reason !== undefined) entry.reason = reason;
  return entry;
}

interface MemberContext {
  patch: ReviewPatch;
  spawn: SpawnFn;
  timeoutMs: number;
  question?: string;
  signal?: AbortSignal;
  stateDir?: string;
  serial: <T>(task: () => Promise<T>) => Promise<T>;
}

async function runMember(member: CouncilMemberName, context: MemberContext): Promise<CouncilMemberResult> {
  const startedAt = Date.now();
  let worktree: Awaited<ReturnType<typeof createReviewWorktree>> | undefined;
  try {
    worktree = await context.serial(() => createReviewWorktree(context.patch, member, context.stateDir));
    const promptPath = join(worktree.path, PROMPT_FILE_NAME);
    const command = commandOf(member, { diff: context.patch.patch, question: context.question }, promptPath, context.timeoutMs);
    if (command.promptFile !== undefined) writeFileSync(promptPath, command.promptFile, "utf8");
    if (context.signal?.aborted) return result(member, "failed", startedAt, "cancelled");
    const process = context.spawn(command.argv, { cwd: worktree.path, stdin: command.stdin });
    const outcome = await waitFor(process, context.timeoutMs, context.signal);
    if (outcome.kind === "timeout") return result(member, "failed", startedAt, `timed out after ${describeDuration(context.timeoutMs)}`);
    if (outcome.kind === "aborted") return result(member, "failed", startedAt, "cancelled");
    const parsed = parseMemberOutput(member, outcome.output, worktree.roots);
    if ("error" in parsed) return result(member, "failed", startedAt, parsed.error);
    return result(member, "done", startedAt, parsed.note, parsed.findings);
  } catch (error) {
    return result(member, "failed", startedAt, `cannot run: ${message(error)}`.slice(0, 400));
  } finally {
    if (worktree) await worktree.remove().catch(() => undefined);
  }
}

function serialQueue(): MemberContext["serial"] {
  let tail: Promise<unknown> = Promise.resolve();
  return (task) => {
    const next = tail.then(task, task);
    tail = next.catch(() => undefined);
    return next as Promise<never>;
  };
}

export async function runCouncil(opts: RunCouncilOptions): Promise<CouncilRun> {
  const spawn = opts.spawn ?? defaultSpawn;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_MEMBER_TIMEOUT_MS;
  const excluded = new Set(opts.exclude ?? []);
  const requested = [...new Set(opts.members ?? MEMBER_NAMES)].filter((member) => !excluded.has(member));
  const results: CouncilMemberResult[] = [];

  if (opts.signal?.aborted) return { members: results, diffHash: "", ran: false, note: "council cancelled before start" };

  let candidates = requested;
  if (opts.availableClients) {
    const allowed = new Set(opts.availableClients.map((client) => CLIENT_ALIASES[client.trim().toLowerCase()]).filter((member): member is CouncilMemberName => member !== undefined));
    candidates = [];
    for (const member of requested) {
      if (allowed.has(member)) candidates.push(member);
      else results.push({ member, status: "skipped", reason: "client not available", findings: [], durationMs: 0 });
    }
  }
  if (candidates.length < 2) return { members: results, diffHash: "", ran: false, note: "fewer than two council members available; nothing was run" };

  let patch: ReviewPatch;
  try {
    patch = await buildReviewPatch(opts.cwd, opts.base);
  } catch (error) {
    return { members: results, diffHash: "", ran: false, note: `cannot read the diff: ${message(error)}`.slice(0, 400) };
  }
  if (patch.patch.trim() === "") return { members: results, diffHash: patch.hash, ran: false, note: "empty diff; nothing to review" };

  const probes = await Promise.all(candidates.map(async (member) => ({ member, installed: await isInstalled(member, spawn, patch.repoRoot, opts.signal) })));
  const runnable: CouncilMemberName[] = [];
  for (const { member, installed } of probes) {
    if (installed) runnable.push(member);
    else results.push({ member, status: "skipped", reason: "not installed", findings: [], durationMs: 0 });
  }
  if (runnable.length < 2) return { members: results, diffHash: patch.hash, ran: false, note: "fewer than two council members are installed; nothing was run" };

  const context: MemberContext = { patch, spawn, timeoutMs, question: opts.question, signal: opts.signal, stateDir: opts.stateDir, serial: serialQueue() };
  const ran = await Promise.all(runnable.map((member) => runMember(member, context)));
  results.push(...ran);
  const order = new Map(MEMBER_NAMES.map((member, index) => [member, index] as const));
  results.sort((a, b) => (order.get(a.member) ?? 0) - (order.get(b.member) ?? 0));
  const run: CouncilRun = { members: results, diffHash: patch.hash, ran: true };
  if (patch.skippedUntracked > 0) run.note = `${patch.skippedUntracked} untracked file${patch.skippedUntracked === 1 ? "" : "s"} left out of the review`;
  return run;
}
