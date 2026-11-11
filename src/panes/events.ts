import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveStateDir } from "../herdr/state-dir.js";

export type RunOutcome = "queued" | "running" | "done" | "failed" | "timeout" | "interrupted";

export interface RunEvent {
  t: number;
  type: "queued" | "start" | "out" | "timeout" | "interrupted" | "detached" | "exit" | "wait" | "attempt" | "failover" | "failover-end";
  [key: string]: unknown;
}

export interface RunSummary {
  runId: string;
  state: RunOutcome;
  pid: number | null;
  pgid: number | null;
  exitCode: number | null;
  tail: string;
  detached: boolean;
  startedAt: number | null;
  endedAt: number | null;
}

const RUN_ID = /^[A-Za-z0-9_.-]{1,64}$/;

export function safeRunId(id: string): string {
  if (!RUN_ID.test(id) || id === "." || id === "..") throw new Error(`invalid run id: ${id}`);
  return id;
}

export const stateRoot = (env: NodeJS.ProcessEnv = process.env): string => resolveStateDir(env);
export const runsDir = (env: NodeJS.ProcessEnv = process.env): string => join(stateRoot(env), "runs");
export const runDir = (id: string, env: NodeJS.ProcessEnv = process.env): string => join(runsDir(env), safeRunId(id));
export const eventsFile = (id: string, env: NodeJS.ProcessEnv = process.env): string => join(runDir(id, env), "events.jsonl");

export function appendEvent(id: string, event: Omit<RunEvent, "t"> & { t?: number }, env: NodeJS.ProcessEnv = process.env): void {
  mkdirSync(runDir(id, env), { recursive: true, mode: 0o700 });
  appendFileSync(eventsFile(id, env), `${JSON.stringify({ t: Date.now(), ...event })}\n`, { mode: 0o600 });
}

export function parseEvents(text: string): RunEvent[] {
  const out: RunEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && typeof parsed.type === "string") out.push(parsed);
    } catch {
      continue;
    }
  }
  return out;
}

export function readEvents(id: string, env: NodeJS.ProcessEnv = process.env): RunEvent[] {
  const file = eventsFile(id, env);
  return existsSync(file) ? parseEvents(readFileSync(file, "utf8")) : [];
}

export function summarize(runId: string, events: RunEvent[]): RunSummary {
  const start = [...events].reverse().find((e) => e.type === "start");
  const exit = [...events].reverse().find((e) => e.type === "exit");
  const interrupted = events.find((e) => e.type === "interrupted");
  const timedOut = events.find((e) => e.type === "timeout");
  let state: RunOutcome = events.length === 0 || (!start && !exit) ? "queued" : "running";
  if (exit) state = exit.outcome === "done" ? "done" : exit.outcome === "timeout" ? "timeout" : exit.outcome === "interrupted" ? "interrupted" : "failed";
  if (interrupted) state = "interrupted";
  else if (timedOut && state === "failed") state = "timeout";
  const outs = events.filter((e) => e.type === "out").map((e) => String(e.line ?? ""));
  const tail = typeof exit?.tail === "string" ? exit.tail : outs.slice(-30).join("\n");
  return {
    runId,
    state,
    pid: typeof start?.pid === "number" ? start.pid : null,
    pgid: typeof start?.pgid === "number" ? start.pgid : null,
    exitCode: typeof exit?.code === "number" ? exit.code : null,
    tail,
    detached: events.some((e) => e.type === "detached"),
    startedAt: start?.t ?? null,
    endedAt: exit?.t ?? interrupted?.t ?? null,
  };
}

export const isFinished = (s: RunOutcome): boolean => s === "done" || s === "failed" || s === "timeout" || s === "interrupted";
