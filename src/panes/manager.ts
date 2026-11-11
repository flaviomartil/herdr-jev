import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { appendEvent, isFinished, readEvents, runDir, safeRunId, stateRoot, summarize } from "./events.js";
import type { RunSummary } from "./events.js";
import { createHost, detectHost, processCmd, shq } from "./host.js";
import type { Cmd, HostKind, PaneHost } from "./host.js";
import { killGroup } from "./worker-run.js";
import type { WorkerCli } from "./worker-run.js";

export const MAX_VISIBLE = 3;
const DEFAULT_LINGER_SEC = 30;

export interface Entry {
  runId: string;
  name: string;
  cli: WorkerCli;
  model: string;
  effort: string | null;
  cwd: string;
  promptFile: string;
  host: HostKind;
  paneId: string | null;
  tab: string | null;
  status: "queued" | "active" | "closed";
  session: string | null;
  createdAt: number;
  lingerSec: number;
  timeoutSec: number | null;
  inactivitySec: number | null;
  failover?: boolean;
  chain?: string;
  generation: number;
}

interface Registry {
  max?: number;
  entries: Record<string, Entry>;
  tabs: Record<string, { host: HostKind; tabId: string; paneId: string }>;
}

export interface Ctx {
  env: NodeJS.ProcessEnv;
  cmd: Cmd;
  bin?: string;
  max?: number;
}

const registryFile = (ctx: Ctx) => join(stateRoot(ctx.env), "panes", "registry.json");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readRegistry(ctx: Ctx): Registry {
  try {
    const parsed = JSON.parse(readFileSync(registryFile(ctx), "utf8"));
    return { max: typeof parsed.max === "number" ? parsed.max : undefined, entries: parsed.entries ?? {}, tabs: parsed.tabs ?? {} };
  } catch {
    return { entries: {}, tabs: {} };
  }
}

function writeRegistry(ctx: Ctx, reg: Registry): void {
  const file = registryFile(ctx);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(reg), { mode: 0o600 });
  renameSync(tmp, file);
}

async function withLock<T>(ctx: Ctx, fn: () => Promise<T>): Promise<T> {
  const lock = `${registryFile(ctx)}.lock`;
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 20_000) rmdirSync(lock);
      } catch {
        void 0;
      }
      if (Date.now() > deadline) throw new Error("registry lock timeout");
      await sleep(25);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      void 0;
    }
  }
}

const summaryOf = (ctx: Ctx, entry: Entry): RunSummary => summarize(entry.runId, readEvents(entry.runId, ctx.env));
const isLive = (ctx: Ctx, entry: Entry): boolean => entry.status === "active" && !isFinished(summaryOf(ctx, entry).state);
const hostOf = (ctx: Ctx, entry: Entry): PaneHost => createHost(entry.host, ctx.env, ctx.cmd);

export function workerBin(ctx: Ctx): string {
  return ctx.bin ?? ctx.env.HERDR_JEV_BIN ?? join(dirname(new URL(import.meta.url).pathname), "..", "..", "bin", "herdr-jev.js");
}

export function buildLine(ctx: Ctx, entry: Entry, interactive: boolean): string {
  const bin = shq(workerBin(ctx));
  const worker = [bin, "worker-run", "--cli", entry.cli, "--model", shq(entry.model),
    ...(entry.effort ? ["--effort", shq(entry.effort)] : []),
    "--prompt-file", shq(entry.promptFile), "--run-id", shq(entry.runId), "--cwd", shq(entry.cwd),
    ...(entry.timeoutSec ? ["--timeout", String(entry.timeoutSec)] : []),
    ...(entry.inactivitySec ? ["--inactivity", String(entry.inactivitySec)] : []),
    ...(entry.failover ? ["--failover"] : []), ...(entry.chain ? ["--chain", shq(entry.chain)] : [])].join(" ");
  const pump = `${bin} panes pump >/dev/null 2>&1`;
  if (!interactive) return `${worker}; ${pump}`;
  return `${worker}; rc=$?; ${pump}; if [ "$rc" -eq 0 ]; then sleep ${entry.lingerSec}; exit 0; else echo "worker exited with $rc"; exec "\${SHELL:-sh}"; fi`;
}

export interface StartInput {
  runId: string;
  name?: string;
  cli: WorkerCli;
  model: string;
  effort?: string;
  prompt?: string;
  promptFile?: string;
  cwd?: string;
  host?: HostKind;
  tab?: string;
  session?: string;
  lingerSec?: number;
  timeoutSec?: number;
  inactivitySec?: number;
  failover?: boolean;
  chain?: string;
}

export interface StartResult {
  runId: string;
  status: "started" | "queued" | "failed";
  host: HostKind;
  paneId: string | null;
  title: string;
  reason?: string;
}

const titleOf = (e: Entry) => `${e.name} · ${e.cli}`;

async function launch(ctx: Ctx, reg: Registry, entry: Entry): Promise<boolean> {
  const host = hostOf(ctx, entry);
  const tabPane = entry.tab ? reg.tabs[entry.tab]?.paneId ?? null : null;
  const siblings = Object.values(reg.entries).filter((e) => e.status === "active" && e.host === entry.host && e.paneId && e.tab === entry.tab);
  const last = siblings.length > 0 ? siblings[siblings.length - 1]!.paneId : null;
  const anchor = last ?? tabPane;
  const direction = anchor ? "down" : "right";
  const placed = await host.split(buildLine(ctx, entry, entry.host !== "background"), entry.cwd, titleOf(entry), { anchor, direction: last ? "down" : tabPane ? "right" : direction });
  if (!placed) return false;
  entry.paneId = placed.id;
  entry.status = "active";
  return true;
}

async function pumpLocked(ctx: Ctx, reg: Registry): Promise<string[]> {
  const started: string[] = [];
  const max = ctx.max ?? reg.max ?? MAX_VISIBLE;
  for (const entry of Object.values(reg.entries)) {
    if (entry.status !== "active" || !entry.paneId || summaryOf(ctx, entry).state !== "queued") continue;
    if ((await hostOf(ctx, entry).state(entry.paneId)) === "gone") {
      entry.status = "closed";
      appendEvent(entry.runId, { type: "exit", code: 1, outcome: "failed", tail: "pane closed before the worker started" }, ctx.env);
    }
  }
  const queued = Object.values(reg.entries).filter((e) => e.status === "queued").sort((a, b) => a.createdAt - b.createdAt);
  for (const entry of queued) {
    const live = Object.values(reg.entries).filter((e) => isLive(ctx, e)).length;
    if (live >= max) break;
    if (await launch(ctx, reg, entry)) started.push(entry.runId);
    else {
      entry.status = "closed";
      appendEvent(entry.runId, { type: "exit", code: 1, outcome: "failed", tail: `pane host ${entry.host} could not start the worker` }, ctx.env);
    }
  }
  return started;
}

export async function start(ctx: Ctx, input: StartInput): Promise<StartResult> {
  const runId = safeRunId(input.runId);
  let promptFile = input.promptFile;
  if (!promptFile) {
    if (input.prompt === undefined) throw new Error("prompt or promptFile required");
    mkdirSync(runDir(runId, ctx.env), { recursive: true, mode: 0o700 });
    promptFile = join(runDir(runId, ctx.env), "prompt.txt");
    writeFileSync(promptFile, input.prompt, { mode: 0o600 });
  }
  const entry: Entry = {
    runId, name: input.name || runId, cli: input.cli, model: input.model, effort: input.effort ?? null,
    cwd: input.cwd || process.cwd(), promptFile, host: input.host ?? detectHost(ctx.env), paneId: null,
    tab: input.tab ?? null, status: "queued", session: input.session ?? null, createdAt: Date.now(),
    lingerSec: input.lingerSec ?? DEFAULT_LINGER_SEC, timeoutSec: input.timeoutSec ?? null, inactivitySec: input.inactivitySec ?? null, generation: 1,
    ...(input.failover ? { failover: true } : {}), ...(input.chain ? { chain: input.chain } : {}),
  };
  return withLock(ctx, async () => {
    const reg = readRegistry(ctx);
    if (ctx.max) reg.max = ctx.max;
    reg.entries[runId] = entry;
    appendEvent(runId, { type: "queued", cli: entry.cli, model: entry.model, host: entry.host, name: entry.name }, ctx.env);
    await pumpLocked(ctx, reg);
    writeRegistry(ctx, reg);
    const status = entry.status === "active" ? "started" : entry.status === "queued" ? "queued" : "failed";
    return { runId, status, host: entry.host, paneId: entry.paneId, title: titleOf(entry), ...(status === "failed" ? { reason: "pane host could not start the worker" } : {}) };
  });
}

export async function openWatch(ctx: Ctx, runId: string, name: string, cwd: string, kind?: HostKind): Promise<Outcome> {
  const host = createHost(kind ?? detectHost(ctx.env), ctx.env, ctx.cmd);
  if (host.kind === "background") return { ok: false, message: "no terminal to watch in" };
  const line = `${shq(workerBin(ctx))} panes watch ${shq(safeRunId(runId))}; sleep 10`;
  const placed = await host.split(line, cwd, `${name} · claude`, { direction: "down" });
  return { ok: placed !== null, message: placed ? `watching ${name}` : "could not open a watch pane" };
}

export function recordEvent(ctx: Ctx, runId: string, type: string, extra: Record<string, unknown>): void {
  if (!["start", "out", "exit", "queued"].includes(type)) throw new Error(`invalid event type: ${type}`);
  appendEvent(runId, { type: type as "start", ...extra }, ctx.env);
}

export async function pump(ctx: Ctx): Promise<string[]> {
  return withLock(ctx, async () => {
    const reg = readRegistry(ctx);
    const started = await pumpLocked(ctx, reg);
    writeRegistry(ctx, reg);
    return started;
  });
}

export function resolveEntry(ctx: Ctx, name: string): Entry | null {
  const all = Object.values(readRegistry(ctx).entries);
  const hits = all.filter((e) => e.runId === name || e.name === name).sort((a, b) => b.createdAt - a.createdAt);
  return hits[0] ?? null;
}

export function list(ctx: Ctx): (Entry & { state: string; exitCode: number | null })[] {
  return Object.values(readRegistry(ctx).entries)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((e) => {
      const s = summaryOf(ctx, e);
      return { ...e, state: s.state, exitCode: s.exitCode };
    });
}

export function status(ctx: Ctx, runIds: string[]): RunSummary[] {
  return runIds.map((id) => summarize(id, readEvents(id, ctx.env)));
}

function stopRun(ctx: Ctx, entry: Entry): void {
  const s = summaryOf(ctx, entry);
  if (isFinished(s.state)) return;
  appendEvent(entry.runId, { type: "interrupted", by: "panes" }, ctx.env);
  if (s.pgid && s.pgid > 1) killGroup(s.pgid, "SIGTERM");
}

export async function abort(ctx: Ctx, opts: { session?: string; backgroundOnly?: boolean } = {}): Promise<string[]> {
  return withLock(ctx, async () => {
    const reg = readRegistry(ctx);
    const hit: string[] = [];
    for (const entry of Object.values(reg.entries)) {
      if (entry.status === "closed") continue;
      if (opts.session && entry.session !== opts.session) continue;
      if (opts.backgroundOnly && entry.host !== "background") continue;
      if (entry.status === "queued") {
        entry.status = "closed";
        appendEvent(entry.runId, { type: "interrupted", by: "panes" }, ctx.env);
        hit.push(entry.runId);
      } else if (isLive(ctx, entry)) {
        stopRun(ctx, entry);
        hit.push(entry.runId);
      }
    }
    writeRegistry(ctx, reg);
    return hit;
  });
}

export async function detach(ctx: Ctx, session?: string): Promise<string[]> {
  return withLock(ctx, async () => {
    const hit: string[] = [];
    for (const entry of Object.values(readRegistry(ctx).entries)) {
      if (entry.host === "background" || !isLive(ctx, entry)) continue;
      if (session && entry.session !== session) continue;
      appendEvent(entry.runId, { type: "detached" }, ctx.env);
      hit.push(entry.runId);
    }
    return hit;
  });
}

export type Outcome = { ok: boolean; message: string; needsConfirm?: boolean; runId?: string };

export async function focus(ctx: Ctx, name: string): Promise<Outcome> {
  const entry = resolveEntry(ctx, name);
  if (!entry || !entry.paneId) return { ok: false, message: `no pane for ${name}` };
  const ok = await hostOf(ctx, entry).focus(entry.paneId);
  return { ok, message: ok ? `focused ${titleOf(entry)}` : `host ${entry.host} cannot focus ${name}` };
}

export async function send(ctx: Ctx, name: string, text: string): Promise<Outcome> {
  const entry = resolveEntry(ctx, name);
  if (!entry || !entry.paneId) return { ok: false, message: `no pane for ${name}` };
  const ok = await hostOf(ctx, entry).send(entry.paneId, text);
  return { ok, message: ok ? `sent to ${titleOf(entry)}` : `host ${entry.host} has no terminal to send to` };
}

export async function close(ctx: Ctx, name: string, yes: boolean): Promise<Outcome> {
  const entry = resolveEntry(ctx, name);
  if (!entry) return { ok: false, message: `unknown run ${name}` };
  if (isLive(ctx, entry) && !yes) return { ok: false, needsConfirm: true, message: `${name} is still running; confirm with --yes to kill it` };
  await withLock(ctx, async () => {
    const reg = readRegistry(ctx);
    const stored = reg.entries[entry.runId];
    if (stored) {
      stopRun(ctx, stored);
      if (stored.paneId) await hostOf(ctx, stored).close(stored.paneId);
      stored.status = "closed";
      writeRegistry(ctx, reg);
    }
  });
  await pump(ctx);
  return { ok: true, message: `closed ${name}` };
}

export async function restart(ctx: Ctx, name: string, yes: boolean): Promise<Outcome> {
  const entry = resolveEntry(ctx, name);
  if (!entry) return { ok: false, message: `unknown run ${name}` };
  if (isLive(ctx, entry) && !yes) return { ok: false, needsConfirm: true, message: `${name} is still running; confirm with --yes to restart it` };
  const closed = await close(ctx, entry.runId, true);
  if (!closed.ok) return closed;
  const base = entry.runId.replace(/-r\d+$/, "");
  const generation = entry.generation + 1;
  const runId = `${base}-r${generation}`.slice(0, 64);
  const result = await start(ctx, {
    runId, name: entry.name, cli: entry.cli, model: entry.model, effort: entry.effort ?? undefined,
    promptFile: entry.promptFile, cwd: entry.cwd, host: entry.host, tab: entry.tab ?? undefined,
    session: entry.session ?? undefined, lingerSec: entry.lingerSec, timeoutSec: entry.timeoutSec ?? undefined, inactivitySec: entry.inactivitySec ?? undefined,
  });
  await withLock(ctx, async () => {
    const reg = readRegistry(ctx);
    if (reg.entries[runId]) reg.entries[runId]!.generation = generation;
    writeRegistry(ctx, reg);
  });
  return { ok: result.status !== "failed", runId, message: `restarted ${entry.name} as ${runId} (${result.status})` };
}

export async function newTab(ctx: Ctx, feature: string, cwd: string, kind?: HostKind): Promise<Outcome> {
  const hostKind = kind ?? detectHost(ctx.env);
  if (hostKind !== "herdr" && hostKind !== "tmux") return { ok: false, message: `tabs need herdr or tmux, found ${hostKind}` };
  const made = await createHost(hostKind, ctx.env, ctx.cmd).newTab(feature, cwd);
  if (!made) return { ok: false, message: `could not create tab ${feature}` };
  await withLock(ctx, async () => {
    const reg = readRegistry(ctx);
    reg.tabs[feature] = { host: hostKind, tabId: made.tabId, paneId: made.paneId };
    writeRegistry(ctx, reg);
  });
  return { ok: true, message: `tab ${feature} created (${made.tabId})` };
}

export function repoName(cwd: string): string {
  try {
    return basename(execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch {
    return basename(cwd);
  }
}

const layoutFile = (ctx: Ctx, repo: string) => join(stateRoot(ctx.env), "layouts", `${repo.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);

export async function layoutSave(ctx: Ctx, cwd: string): Promise<Outcome> {
  const reg = readRegistry(ctx);
  const repo = repoName(cwd);
  const entries = Object.values(reg.entries).filter((e) => e.status !== "closed" || !isFinished(summaryOf(ctx, e).state))
    .filter((e) => e.cwd === cwd || repoName(e.cwd) === repo)
    .map((e) => ({ runId: e.runId, name: e.name, cli: e.cli, model: e.model, effort: e.effort, cwd: e.cwd, promptFile: e.promptFile, tab: e.tab, host: e.host, state: summaryOf(ctx, e).state }));
  const tabs = Object.entries(reg.tabs).map(([feature, t]) => ({ feature, host: t.host }));
  const file = layoutFile(ctx, repo);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ repo, savedAt: Date.now(), tabs, entries }, null, 2), { mode: 0o600 });
  return { ok: true, message: `layout saved: ${entries.length} panes, ${tabs.length} tabs (${file})` };
}

export interface RestoreResult extends Outcome {
  reopened: string[];
  restartOffered: string[];
  detached: string[];
}

export async function layoutRestore(ctx: Ctx, cwd: string): Promise<RestoreResult> {
  const file = layoutFile(ctx, repoName(cwd));
  if (!existsSync(file)) return { ok: false, message: "no saved layout", reopened: [], restartOffered: [], detached: [] };
  const saved = JSON.parse(readFileSync(file, "utf8")) as { tabs: { feature: string; host: HostKind }[]; entries: any[] };
  const reopened: string[] = [];
  const restartOffered: string[] = [];
  const detached: string[] = [];
  for (const t of saved.tabs) {
    if (!readRegistry(ctx).tabs[t.feature]) await newTab(ctx, t.feature, cwd, t.host);
  }
  const bin = shq(workerBin(ctx));
  for (const e of saved.entries) {
    const sum = summarize(e.runId, readEvents(e.runId, ctx.env));
    const state = sum.state;
    const stillRunning = state === "running" && sum.detached;
    if (state === "done" || state === "failed" || state === "timeout" || stillRunning) {
      const reg = readRegistry(ctx);
      const tabPane = e.tab ? reg.tabs[e.tab]?.paneId ?? null : null;
      const host = createHost(detectHost(ctx.env), ctx.env, ctx.cmd);
      const placed = await host.split(`${bin} panes watch ${shq(e.runId)}; exec "\${SHELL:-sh}"`, e.cwd, `${e.name} · ${e.cli} (watch)`, { anchor: tabPane, direction: "down" });
      if (placed) reopened.push(e.runId);
      if (stillRunning) detached.push(e.runId);
    } else {
      restartOffered.push(e.runId);
    }
  }
  const keep = detached.length > 0 ? ` Still running after the session ended, watching: ${detached.join(", ")}.` : "";
  const offer = restartOffered.length > 0 ? ` Interrupted or unfinished, not rerun: ${restartOffered.join(", ")}. Use /harness restart <run> to rerun one.` : "";
  return { ok: true, message: `layout restored: ${reopened.length} runs reopened with watch.${keep}${offer}`, reopened, restartOffered, detached };
}

export async function watch(runId: string, env: NodeJS.ProcessEnv, write: (s: string) => void = (s) => process.stdout.write(s), pollMs = 500, maxMs = 3_600_000): Promise<number> {
  let seen = 0;
  const end = Date.now() + maxMs;
  for (;;) {
    const events = readEvents(runId, env);
    for (const e of events.slice(seen)) {
      if (e.type === "out") write(`${String(e.line)}\n`);
      else if (e.type === "exit" || e.type === "interrupted" || e.type === "timeout") write(`[${e.type}${e.outcome ? ` ${e.outcome}` : ""}${typeof e.code === "number" ? ` code=${e.code}` : ""}]\n`);
    }
    seen = events.length;
    const s = summarize(runId, events);
    if (isFinished(s.state) && events.some((e) => e.type === "exit")) return s.state === "done" ? 0 : 1;
    if (isFinished(s.state) && s.state === "interrupted") return 1;
    if (Date.now() > end) return 2;
    await sleep(pollMs);
  }
}

export { processCmd };
