import { availableDelegationClients, type CrossHarnessConfig } from "../delegation/cross-harness.js";
import { resolveDefaultBranch } from "../harness/review.js";
import { formatCouncilSummary } from "./format.js";
import { MEMBER_NAMES } from "./members.js";
import { CLIENT_ALIASES, MAX_MEMBER_TIMEOUT_MS, runCouncil } from "./run.js";
import type { SpawnFn } from "./spawn.js";
import { synthesize } from "./synth.js";
import type { CouncilSummary, JevLike } from "./synth-types.js";
import type { CouncilMemberName, CouncilRun } from "./types.js";

export const MIN_COUNCIL_TIMEOUT_MS = 1000;

export interface ConsultOptions {
  cwd: string;
  client: string;
  base?: string;
  question?: string;
  timeoutMs?: number;
  members?: CouncilMemberName[];
  exclude?: CouncilMemberName[];
  signal?: AbortSignal;
}

export interface ConsultDeps {
  spawn?: SpawnFn;
  jev?: JevLike;
  stateDir?: string;
  timeoutCommand?: string | null;
  crossHarness?: CrossHarnessConfig;
}

export interface CouncilReport {
  run: CouncilRun;
  summary: CouncilSummary;
  notes: string[];
  text: string;
}

const EMPTY_SUMMARY: CouncilSummary = { agreements: [], disagreements: [], unique: [], notes: [], messages: [], scoredBy: "none" };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseCouncilMembers(list: string | undefined): CouncilMemberName[] | undefined {
  if (list === undefined) return undefined;
  const names: CouncilMemberName[] = [];
  for (const raw of list.split(",")) {
    const token = raw.trim().toLowerCase();
    if (!token) continue;
    const member = Object.hasOwn(CLIENT_ALIASES, token) ? CLIENT_ALIASES[token] : undefined;
    if (!member) throw new Error(`unknown council member "${token.slice(0, 40)}"; use ${MEMBER_NAMES.join(", ")}`);
    if (!names.includes(member)) names.push(member);
  }
  if (names.length === 0) throw new Error(`no council member named; use ${MEMBER_NAMES.join(", ")}`);
  return names;
}

export function parseCouncilTimeout(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isSafeInteger(ms) || ms < MIN_COUNCIL_TIMEOUT_MS || ms > MAX_MEMBER_TIMEOUT_MS) {
    throw new Error(`invalid council timeout; use an integer between ${MIN_COUNCIL_TIMEOUT_MS} and ${MAX_MEMBER_TIMEOUT_MS} milliseconds`);
  }
  return ms;
}

export function reviewBaseFor(cwd: string, base: string | undefined): string | undefined {
  if (base !== undefined) return base;
  try {
    return resolveDefaultBranch(cwd) ?? undefined;
  } catch {
    return undefined;
  }
}

export async function consultCouncil(options: ConsultOptions, deps: ConsultDeps = {}): Promise<CouncilReport> {
  const notes: string[] = [];
  let run: CouncilRun;
  try {
    const available = availableDelegationClients(options.client, deps.crossHarness);
    const allowed = new Set(available.map((client) => CLIENT_ALIASES[client.trim().toLowerCase()]).filter((member): member is CouncilMemberName => member !== undefined));
    if (available.length === 0) {
      notes.push(`no council member is available for client ${options.client}: cross-harness delegation is disabled or no peer is configured for it`);
    }
    for (const member of options.members ?? []) {
      if (!allowed.has(member)) notes.push(`requested member ${member} was dropped: client ${options.client} cannot use it under the cross-harness configuration`);
    }
    run = await runCouncil({
      cwd: options.cwd,
      base: options.base,
      members: options.members,
      timeoutMs: options.timeoutMs,
      question: options.question,
      availableClients: available,
      exclude: options.exclude,
      spawn: deps.spawn,
      signal: options.signal,
      stateDir: deps.stateDir,
      timeoutCommand: deps.timeoutCommand,
    });
  } catch (error) {
    run = { members: [], diffHash: "", ran: false, note: `council failed: ${message(error)}`.slice(0, 400) };
  }
  let summary: CouncilSummary;
  try {
    summary = await synthesize(run.members.flatMap((member) => member.findings), { jev: deps.jev });
  } catch (error) {
    summary = { ...EMPTY_SUMMARY, messages: [`synthesis failed: ${message(error)}`.slice(0, 300)] };
  }
  let text = formatCouncilSummary(summary, run);
  if (notes.length > 0) text += `\n\nCouncil member selection\n${notes.map((note) => `- ${note}`).join("\n")}`;
  return { run, summary, notes, text };
}

export interface CouncilCommandOptions {
  members?: string;
  base?: string;
  question?: string;
  timeout?: string;
  json?: boolean;
}

export interface CouncilCommandResult {
  output: string;
  exitCode: 0 | 2;
}

export async function runCouncilCommand(options: CouncilCommandOptions, context: { cwd: string; client: string }, deps: ConsultDeps = {}, signal?: AbortSignal): Promise<CouncilCommandResult> {
  let members: CouncilMemberName[] | undefined;
  let timeoutMs: number | undefined;
  try {
    members = parseCouncilMembers(options.members);
    timeoutMs = parseCouncilTimeout(options.timeout);
  } catch (error) {
    const reason = message(error);
    return { output: options.json ? JSON.stringify({ error: reason }) : `Council not run: ${reason}`, exitCode: 2 };
  }
  const report = await consultCouncil({ cwd: context.cwd, client: context.client, base: options.base, question: options.question, timeoutMs, members, signal }, deps);
  const output = options.json ? JSON.stringify({ run: report.run, summary: report.summary, notes: report.notes }, null, 2) : report.text;
  return { output, exitCode: report.run.ran ? 0 : 2 };
}

export interface CouncilAlongside {
  promise: Promise<CouncilReport>;
  abort(): void;
}

export function startCouncilAlongside(options: CouncilCommandOptions, context: { cwd: string; client: string }, deps: ConsultDeps = {}): CouncilAlongside {
  const controller = new AbortController();
  const failed = (reason: string): CouncilReport => {
    const run: CouncilRun = { members: [], diffHash: "", ran: false, note: reason.slice(0, 400) };
    return { run, summary: EMPTY_SUMMARY, notes: [], text: formatCouncilSummary(EMPTY_SUMMARY, run) };
  };
  let promise: Promise<CouncilReport>;
  try {
    const members = parseCouncilMembers(options.members);
    const timeoutMs = parseCouncilTimeout(options.timeout);
    promise = consultCouncil({ cwd: context.cwd, client: context.client, base: reviewBaseFor(context.cwd, options.base), question: options.question, timeoutMs, members, signal: controller.signal }, deps).catch((error) => failed(`council failed: ${message(error)}`));
  } catch (error) {
    promise = Promise.resolve(failed(`council not run: ${message(error)}`));
  }
  return { promise, abort: () => controller.abort() };
}

export const REVIEW_COUNCIL_HEADING = "Council (consultative only: it does not change the review status or the exit code)";

export function appendCouncilText(reviewText: string, council: CouncilReport): string {
  return `${reviewText}\n\n----\n${REVIEW_COUNCIL_HEADING}\n----\n${council.text}`;
}

export function withCouncilJson<T extends object>(report: T, council: CouncilReport): T & { council: { ran: boolean; run: CouncilRun; summary: CouncilSummary; notes: string[] } } {
  return { ...report, council: { ran: council.run.ran, run: council.run, summary: council.summary, notes: council.notes } };
}

export function renderReview<T extends object>(report: T, reviewText: string, council: CouncilReport | undefined, json: boolean | undefined): string {
  if (json) return JSON.stringify(council ? withCouncilJson(report, council) : report, null, 2);
  return council ? appendCouncilText(reviewText, council) : reviewText;
}

export function exitAfterFlush(code: number): void {
  const force = setTimeout(() => process.exit(code), 2000);
  force.unref?.();
  process.stdout.write("", () => process.exit(code));
}
