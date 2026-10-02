import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, type Stats, readFileSync, writeFileSync, readdirSync, rmSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import type { ClientKind, RoleKind, StageSpec, TriageDecision, ReasoningEffort } from "../types/index.js";
import { classifyHerdrCommandFailure, classifyPaneBlock, createHerdrClient, isTestSafeBinary, looksLikeSelectionMenu, normalizePaneText, readHerdrObservedState, readHerdrStructuredState, type HerdrClient, type HerdrObservedState, type PaneBlockKind } from "./client.js";
import { ANSI_PATTERN } from "./pane-text.js";
import { isTestGuardActive, resolveStateDir } from "./state-dir.js";
import { reserveHerdrHandle, claimHerdrSpawn, releaseHerdrSpawn } from "./reservation.js";
import { takeOverStale } from "./notify.js";
import { autoTrustEnabled, confirmWorkspaceTrust, type TrustOutcome } from "./trust.js";
import { createWorkerRun, harnessModelResolve, settleWorkerRun } from "../harness/bridge.js";

export interface LaunchResult {
  ok: boolean;
  ackStatus?: "acknowledged" | "rejected" | "unknown" | "not_attempted" | "blocked";
  completionState?: HerdrObservedState | "not_requested";
  completionObserved?: boolean;
  workEvidence?: "not_checked";
  error?: string;
  paneCreated?: boolean;
  promptPending?: boolean;
  trustRequired?: boolean;
  trustConfirmed?: boolean;
  trustPolicyReason?: string;
  trackingError?: string;
  selectionRequired?: boolean;
  promptDelivered?: boolean;
  hint?: string;
  agentName?: string;
  paneId?: string;
  commandText?: string;
  direction?: "right" | "down";
}

export interface InlineRunResult {
  ok: boolean;
  exitCode?: number | null;
  error?: string;
  commandText: string;
}

export type SplitDirectionOption = "right" | "down" | "grid" | "auto";

export type SplitLayoutMode = "right" | "down" | "grid";

type PaneLayoutInput = {
  result?: { layout?: PaneLayout };
  layout?: PaneLayout;
  panes?: PaneLayoutPane[];
};

type GridSplitPlan = { targetPaneId: string; direction: "right" | "down"; ratio: number };
type PaneRect = { x: number; y: number; width: number; height: number };
type PaneLayoutPane = {
  pane_id?: string;
  id?: string;
  rect?: Partial<PaneRect>;
  owner?: unknown;
  owned_by?: unknown;
  plugin?: unknown;
  plugin_id?: unknown;
  metadata?: { owner?: unknown; owned_by?: unknown; plugin?: unknown; plugin_id?: unknown };
};
type PaneLayout = { area?: Partial<PaneRect>; panes?: PaneLayoutPane[] };

function layoutPanes(input: PaneLayoutInput): Array<{ id: string; rect: PaneRect; owner?: string }> {
  const layout = input.result?.layout ?? input.layout ?? input;
  return (layout.panes ?? []).flatMap((pane) => {
    const id = pane.pane_id ?? pane.id;
    const rect = pane.rect;
    return id && rect && typeof rect.x === "number" && typeof rect.y === "number" && typeof rect.width === "number" && typeof rect.height === "number"
      ? [{ id, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, owner: paneOwner(pane) }] : [];
  });
}

function layoutPaneIds(input: PaneLayoutInput): Set<string> {
  const layout = input.result?.layout ?? input.layout ?? input;
  const ids = new Set<string>();
  const panes: unknown = layout.panes;
  if (!Array.isArray(panes)) return ids;
  for (const pane of panes as PaneLayoutPane[]) {
    const id = pane?.pane_id ?? pane?.id;
    if (typeof id === "string" && id) ids.add(id);
  }
  return ids;
}

function paneOwner(pane: PaneLayoutPane): string | undefined {
  const values = [pane.owner, pane.owned_by, pane.plugin, pane.plugin_id,
    pane.metadata?.owner, pane.metadata?.owned_by, pane.metadata?.plugin, pane.metadata?.plugin_id];
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function layoutArea(input: PaneLayoutInput): Partial<PaneRect> | undefined {
  const layout = input.result?.layout ?? input.layout ?? { panes: input.panes };
  return layout.area;
}

function isLateralPane(
  pane: { id: string; rect: PaneRect; owner?: string },
  area: Partial<PaneRect> | undefined,
  callerPaneId: string,
  workerPaneIds: Set<string>,
): boolean {
  if (pane.id === callerPaneId) return false;
  if (typeof area?.x === "number" && typeof area.width === "number" && area.width > 0 && pane.rect.width < area.width * 0.35
    && (pane.rect.x <= area.x || pane.rect.x + pane.rect.width >= area.x + area.width)) return true;
  const ownedByHerdrJev = pane.owner ? /herdr[-_]jev/i.test(pane.owner) : workerPaneIds.has(pane.id);
  return !ownedByHerdrJev && typeof area?.width === "number" && typeof area.height === "number"
    && (pane.rect.width < area.width * 0.25 || pane.rect.height < area.height * 0.25);
}

export function planGridSplit(layout: PaneLayoutInput, callerPaneId: string, workerPaneIds: string[]): GridSplitPlan {
  const panes = layoutPanes(layout);
  const area = layoutArea(layout);
  const live = new Set(panes.map((pane) => pane.id));
  const workers = [...new Set(workerPaneIds)].filter((paneId) => live.has(paneId));
  if (workers.length === 0) return { targetPaneId: callerPaneId, direction: "right", ratio: 0.5 };
  const workerSet = new Set(workers);
  const candidates = [callerPaneId, ...workers].flatMap((paneId) => {
    const pane = panes.find((item) => item.id === paneId);
    return pane && !isLateralPane(pane, area, callerPaneId, workerSet)
      ? [{ paneId, area: pane.rect.width * pane.rect.height, width: pane.rect.width, height: pane.rect.height }] : [];
  });
  if (workers.length === 1) {
    const worker = candidates.find((candidate) => candidate.paneId === workers[0]);
    if (worker) return { targetPaneId: worker.paneId, direction: "down", ratio: 0.5 };
  }
  const caller = panes.find((pane) => pane.id === callerPaneId);
  const callerNarrow = caller && typeof area?.width === "number" && caller.rect.width < area.width * 0.35;
  const eligible = callerNarrow ? candidates.filter((candidate) => candidate.paneId !== callerPaneId) : candidates;
  const largest = (eligible.length > 0 ? eligible : candidates).reduce((current, candidate) => candidate.area > current.area ? candidate : current, candidates[0]);
  if (!largest) return { targetPaneId: callerPaneId, direction: "right", ratio: 0.5 };
  const direction = workers.length === 1 && largest.paneId !== callerPaneId || workers.length === 2 && largest.paneId === callerPaneId
    ? "down" : largest.width >= largest.height ? "right" : "down";
  return { targetPaneId: largest.paneId, direction, ratio: 0.5 };
}

export type TrackedWorkerRecord = {
  callerPaneId: string;
  workerPaneId: string;
};

export type ClosePlanItem = {
  callerPaneId: string;
  paneId: string;
  status: string;
};

export function gridStateDir(stateDir = resolveStateDir()): string {
  return join(stateDir, "grid");
}

export function gridStatePath(callerPaneId: string, stateDir?: string): string {
  const safePaneId = callerPaneId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(gridStateDir(stateDir), `${safePaneId}.json`);
}

export interface GridWorkerRecord {
  paneId: string;
  callerPaneId?: string;
  handle?: string | null;
  cwd?: string | null;
  branch?: string | null;
  forkSha?: string | null;
  runId?: string | null;
  layout?: WorkerLayoutKind;
  gitDir?: string | null;
  settleAttempts?: number;
}

export type WorkerLayoutKind = "grid" | "split" | "tab";

function workerLayoutKind(value: unknown): WorkerLayoutKind | undefined {
  return value === "grid" || value === "split" || value === "tab" ? value : undefined;
}

interface ParsedGridFile {
  records: GridWorkerRecord[];
  callerPaneId?: string;
  corrupt: boolean;
}

function parseGridFile(filePath: string): ParsedGridFile {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return { records: [], corrupt: false };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { records: [], corrupt: true };
  }
  let rawList: unknown[] = [];
  let callerPaneId: string | undefined;
  if (Array.isArray(value)) {
    rawList = value;
  } else if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.callerPaneId === "string") callerPaneId = obj.callerPaneId;
    if (Array.isArray(obj.workers)) {
      rawList = obj.workers;
    } else if (Array.isArray(obj.workerPaneIds)) {
      rawList = obj.workerPaneIds;
    }
  }
  const records: GridWorkerRecord[] = [];
  const seen = new Set<string>();
  for (const item of rawList) {
    if (typeof item === "string") {
      if (!seen.has(item)) {
        seen.add(item);
        records.push({ paneId: item });
      }
    } else if (item && typeof item === "object") {
      const rec = item as Record<string, unknown>;
      const paneId = typeof rec.paneId === "string" ? rec.paneId : typeof rec.id === "string" ? rec.id : undefined;
      if (paneId && !seen.has(paneId)) {
        seen.add(paneId);
        records.push({
          paneId,
          ...(typeof rec.callerPaneId === "string" ? { callerPaneId: rec.callerPaneId } : {}),
          handle: typeof rec.handle === "string" ? rec.handle : null,
          cwd: typeof rec.cwd === "string" ? rec.cwd : null,
          branch: typeof rec.branch === "string" ? rec.branch : null,
          forkSha: typeof rec.forkSha === "string" ? rec.forkSha : typeof rec.fork_sha === "string" ? rec.fork_sha : null,
          ...(typeof rec.runId === "string" && rec.runId ? { runId: rec.runId } : {}),
          ...(workerLayoutKind(rec.layout) ? { layout: workerLayoutKind(rec.layout) } : {}),
          ...(typeof rec.gitDir === "string" && rec.gitDir ? { gitDir: rec.gitDir } : {}),
          ...(Number.isInteger(rec.settleAttempts) && (rec.settleAttempts as number) > 0 ? { settleAttempts: rec.settleAttempts as number } : {}),
        });
      }
    }
  }
  return { records, callerPaneId, corrupt: false };
}

export function readGridWorkerRecords(callerPaneId: string, stateDir?: string): GridWorkerRecord[] {
  return parseGridFile(gridStatePath(callerPaneId, stateDir)).records;
}

export function readAllGridWorkerRecords(stateDir?: string): GridWorkerRecord[] {
  const dir = gridStateDir(stateDir);
  const seen = new Set<string>();
  const records: GridWorkerRecord[] = [];
  for (const file of gridFiles(dir)) {
    const parsed = parseGridFile(join(dir, file));
    const fileCaller = parsed.callerPaneId ?? file.slice(0, -5);
    for (const record of parsed.records) {
      if (seen.has(record.paneId)) continue;
      seen.add(record.paneId);
      records.push({ ...record, callerPaneId: record.callerPaneId ?? fileCaller });
    }
  }
  return records;
}

export function readGridWorkers(callerPaneId: string, stateDir?: string): string[] {
  return readGridWorkerRecords(callerPaneId, stateDir).map((r) => r.paneId);
}

const GRID_LOCK_WAIT_MS = 15_000;
const GRID_LOCK_STALE_MS = 10_000;

export interface GridLockHooks {
  waitMs?: number;
  staleMs?: number;
  afterStaleSeen?: () => void;
  onWait?: () => void;
}

function releaseGridLock(lock: string, token: string): void {
  try {
    if (readFileSync(lock, "utf8") === token) unlinkSync(lock);
  } catch {
  }
}

export function withGridLock<T>(filePath: string, action: () => T, hooks: GridLockHooks = {}): T {
  const lock = `${filePath}.lock`;
  const staleMs = hooks.staleMs ?? GRID_LOCK_STALE_MS;
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const deadline = Date.now() + (hooks.waitMs ?? GRID_LOCK_WAIT_MS);
  for (;;) {
    try {
      writeFileSync(lock, token, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let held: Stats | undefined;
      try {
        held = statSync(lock);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") {
          if (Date.now() > deadline) throw new Error("grid_state_lock_timeout");
          continue;
        }
      }
      if (held && Date.now() - held.mtimeMs > staleMs) {
        hooks.afterStaleSeen?.();
        if (held.isDirectory()) {
          rmSync(lock, { recursive: true, force: true });
          continue;
        }
        const outcome = takeOverStale(lock, (snapshot) => Date.now() - statSync(snapshot).mtimeMs > staleMs);
        if (outcome === "taken" || outcome === "missing") continue;
      }
      if (Date.now() > deadline) throw new Error("grid_state_lock_timeout");
      hooks.onWait?.();
      Bun.sleepSync(5);
    }
  }
  try {
    return action();
  } finally {
    releaseGridLock(lock, token);
  }
}

function toGridRecords(workers: ReadonlyArray<string | GridWorkerRecord>): GridWorkerRecord[] {
  const records: GridWorkerRecord[] = [];
  const seen = new Set<string>();
  for (const item of workers) {
    const paneId = typeof item === "string" ? item : item.paneId;
    if (typeof paneId !== "string" || !paneId) continue;
    if (!seen.has(paneId)) {
      seen.add(paneId);
      records.push(
        typeof item === "string"
          ? { paneId }
          : {
              paneId,
              handle: item.handle ?? null,
              cwd: item.cwd ?? null,
              branch: item.branch ?? null,
              forkSha: item.forkSha ?? (item as any).fork_sha ?? null,
              ...(item.runId ? { runId: item.runId } : {}),
              ...(workerLayoutKind(item.layout) ? { layout: workerLayoutKind(item.layout) } : {}),
              ...(item.gitDir ? { gitDir: item.gitDir } : {}),
              ...(item.settleAttempts && item.settleAttempts > 0 ? { settleAttempts: item.settleAttempts } : {}),
            },
      );
    }
  }
  return records;
}

function writeGridFile(filePath: string, callerPaneId: string, records: readonly GridWorkerRecord[]): void {
  const temporary = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(
      temporary,
      JSON.stringify({ callerPaneId, workerPaneIds: records.map((r) => r.paneId), workers: records }),
      { mode: 0o600 },
    );
    renameSync(temporary, filePath);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function updateGridWorkers(
  callerPaneId: string,
  mutate: (records: GridWorkerRecord[]) => Array<string | GridWorkerRecord> | null,
  stateDir?: string,
): { before: GridWorkerRecord[]; after: GridWorkerRecord[] } {
  const path = gridStatePath(callerPaneId, stateDir);
  return withGridLock(path, () => {
    const current = parseGridFile(path);
    if (current.corrupt) {
      try {
        renameSync(path, `${path}.corrupt`);
      } catch {
      }
    }
    const next = mutate([...current.records]);
    if (next === null) return { before: current.records, after: current.records };
    const after = toGridRecords(next);
    writeGridFile(path, callerPaneId, after);
    return { before: current.records, after };
  });
}

export function writeGridWorkers(callerPaneId: string, workers: Array<string | GridWorkerRecord>, stateDir?: string): void {
  updateGridWorkers(callerPaneId, () => workers, stateDir);
}

export function listAllGridWorkers(stateDir?: string): TrackedWorkerRecord[] {
  const dir = gridStateDir(stateDir);
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const result: TrackedWorkerRecord[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const content = JSON.parse(readFileSync(join(dir, file), "utf8"));
      const callerPaneId = typeof content?.callerPaneId === "string" ? content.callerPaneId : file.slice(0, -5);
      const workers = Array.isArray(content) ? content : (content?.workers ?? content?.workerPaneIds);
      if (Array.isArray(workers)) {
        for (const item of workers) {
          const workerPaneId = typeof item === "string" ? item : item?.paneId;
          if (typeof workerPaneId === "string") {
            result.push({ callerPaneId, workerPaneId });
          }
        }
      }
    } catch {
    }
  }
  return result;
}

export function filterWorkerClosePlan(
  tracked: readonly TrackedWorkerRecord[],
  statuses: Record<string, string | null | undefined> | ((paneId: string) => string | null | undefined),
  options: { pane?: string; allIdle?: boolean },
): ClosePlanItem[] {
  if (!options.pane && !options.allIdle) return [];
  const callerPaneIds = new Set(tracked.map((t) => t.callerPaneId));
  const getStatus = typeof statuses === "function" ? statuses : (id: string) => statuses[id];

  const plan: ClosePlanItem[] = [];
  const seen = new Set<string>();

  if (options.pane) {
    if (callerPaneIds.has(options.pane)) return [];
    const entries = tracked.filter((t) => t.workerPaneId === options.pane);
    if (entries.length === 0) return [];
    for (const entry of entries) {
      if (seen.has(entry.workerPaneId)) continue;
      const status = getStatus(entry.workerPaneId) ?? "unknown";
      if (status === "idle" || status === "done") {
        seen.add(entry.workerPaneId);
        plan.push({ callerPaneId: entry.callerPaneId, paneId: entry.workerPaneId, status });
      }
    }
    return plan;
  }

  if (options.allIdle) {
    for (const entry of tracked) {
      if (callerPaneIds.has(entry.workerPaneId)) continue;
      if (seen.has(entry.workerPaneId)) continue;
      const status = getStatus(entry.workerPaneId) ?? "unknown";
      if (status === "idle" || status === "done") {
        seen.add(entry.workerPaneId);
        plan.push({ callerPaneId: entry.callerPaneId, paneId: entry.workerPaneId, status });
      }
    }
  }

  return plan;
}

export interface PruneFailure {
  file: string;
  error: string;
}

const MAX_SETTLE_ATTEMPTS = 3;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function gridFiles(dir: string, failures?: PruneFailure[]): string[] {
  try {
    return readdirSync(dir).filter((file) => file.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") failures?.push({ file: dir, error: errorText(error) });
    return [];
  }
}

export function trackedRecordsForPanes(paneIds: readonly string[], stateDir?: string): GridWorkerRecord[] {
  const wanted = new Set(paneIds);
  const dir = gridStateDir(stateDir);
  return gridFiles(dir).flatMap((file) => parseGridFile(join(dir, file)).records.filter((record) => wanted.has(record.paneId)));
}

export function pruneGridWorkers(
  closedPaneIds: readonly string[],
  stateDir?: string,
  options: { failures?: PruneFailure[]; kept?: ReadonlyMap<string, GridWorkerRecord> } = {},
): GridWorkerRecord[] {
  const closedSet = new Set(closedPaneIds);
  const dir = gridStateDir(stateDir);
  const removed: GridWorkerRecord[] = [];
  for (const file of gridFiles(dir, options.failures)) {
    const filePath = join(dir, file);
    try {
      withGridLock(filePath, () => {
        const current = parseGridFile(filePath);
        if (current.corrupt) return;
        const closing = current.records.filter((r) => closedSet.has(r.paneId));
        if (closing.length === 0) return;
        const remaining = current.records.flatMap((r) => !closedSet.has(r.paneId) ? [r] : options.kept?.has(r.paneId) ? [options.kept.get(r.paneId)!] : []);
        removed.push(...closing.filter((r) => !options.kept?.has(r.paneId)));
        if (remaining.length === 0) rmSync(filePath, { force: true });
        else writeGridFile(filePath, current.callerPaneId ?? file.slice(0, -5), remaining);
      });
    } catch (error) {
      options.failures?.push({ file: filePath, error: errorText(error) });
    }
  }
  return removed;
}

export interface WorkerSettlement {
  paneId: string;
  runId: string;
  settled: boolean;
}

function gitRun(cwd: string, args: string[]): string | null {
  try {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    const text = result.status === 0 ? result.stdout.trim() : "";
    return /^[0-9a-f]{7,64}$/.test(text) ? text : null;
  } catch {
    return null;
  }
}

function gitHead(cwd: string | null | undefined, branch?: string | null, gitDir?: string | null): string | null {
  if (cwd) {
    const head = gitRun(cwd, ["rev-parse", "--verify", "HEAD"]);
    if (head) return head;
  }
  if (!branch) return null;
  const root = gitDir && existsSync(gitDir) ? gitDir : null;
  if (root) return gitRun(root, ["--git-dir", root, "rev-parse", "--verify", `refs/heads/${branch}`]);
  return cwd ? gitRun(cwd, ["rev-parse", "--verify", `refs/heads/${branch}`]) : null;
}

export function recordGridWorkerRun(callerPaneId: string, paneId: string, runId: string, stateDir?: string): boolean {
  const { after } = updateGridWorkers(callerPaneId, (records) => records.some((record) => record.paneId === paneId)
    ? records.map((record) => record.paneId === paneId ? { ...record, runId } : record) : null, stateDir);
  return after.some((record) => record.paneId === paneId && record.runId === runId);
}

export function registerWorkerRun(input: {
  client: ClientKind;
  model: string;
  role: string;
  cwd: string;
  pane: string;
  handle: string;
  prompt: string;
  callerPaneId?: string;
  stateDir?: string;
}): string | null {
  if (!input.callerPaneId) return null;
  const record = readGridWorkerRecords(input.callerPaneId, input.stateDir).find((item) => item.paneId === input.pane);
  if (!record) return null;
  const git = record.branch && record.forkSha ? {} : resolveGitBranchAndForkSha(input.cwd);
  const run = createWorkerRun({
    client: resolveBaseClientKind(input.client), model: input.model, role: input.role, cwd: input.cwd,
    branch: record.branch ?? git.branch ?? null, forkSha: record.forkSha ?? git.forkSha ?? null,
    pane: input.pane, handle: input.handle, objectiveDigest: createHash("sha256").update(input.prompt).digest("hex"),
  });
  if (!run) return null;
  let recorded = false;
  try {
    recorded = recordGridWorkerRun(input.callerPaneId, input.pane, run.id, input.stateDir);
  } catch {
  }
  if (!recorded) {
    settleWorkerRun({ id: run.id, state: "closed", head: null });
    return null;
  }
  return run.id;
}

export interface WorkerCloseOutcome {
  closed: string[];
  failed: Array<{ paneId: string; error: string }>;
  settlements: WorkerSettlement[];
  pruneFailures: PruneFailure[];
}

const PANE_ALREADY_GONE = /\bpane_not_found\b|\bpane\b[^\n]*\bnot[_ ]found\b/i;

export function settleClosedWorkerRuns(records: readonly GridWorkerRecord[]): WorkerSettlement[] {
  return settleDeadRecords(records).settlements;
}

export function settleDeadRecords(records: readonly GridWorkerRecord[]): { settlements: WorkerSettlement[]; kept: Map<string, GridWorkerRecord> } {
  const seen = new Map<string, boolean>();
  const settlements: WorkerSettlement[] = [];
  const kept = new Map<string, GridWorkerRecord>();
  for (const record of records) {
    if (!record.runId) continue;
    let settled = seen.get(record.runId);
    if (settled === undefined) {
      settled = settleWorkerRun({ id: record.runId, state: "closed", head: gitHead(record.cwd, record.branch, record.gitDir) }) !== null;
      seen.set(record.runId, settled);
      settlements.push({ paneId: record.paneId, runId: record.runId, settled });
    }
    const attempts = (record.settleAttempts ?? 0) + 1;
    if (!settled && attempts < MAX_SETTLE_ATTEMPTS) kept.set(record.paneId, { ...record, settleAttempts: attempts });
  }
  return { settlements, kept };
}

export async function closeWorkerPanes(
  client: HerdrClient,
  plan: readonly ClosePlanItem[],
  stateDir?: string,
): Promise<WorkerCloseOutcome> {
  const closed: string[] = [];
  const failed: Array<{ paneId: string; error: string }> = [];
  for (const item of plan) {
    const result = await client.closePane(item.paneId);
    if (result.ok || PANE_ALREADY_GONE.test(`${result.stdout}\n${result.stderr}`)) closed.push(item.paneId);
    else failed.push({ paneId: item.paneId, error: (result.stderr || result.stdout).trim().slice(0, 200) || "close_failed" });
  }
  const { settlements, kept } = settleDeadRecords(trackedRecordsForPanes(closed, stateDir));
  const pruneFailures: PruneFailure[] = [];
  pruneGridWorkers(closed, stateDir, { failures: pruneFailures, kept });
  return { closed, failed, settlements, pruneFailures };
}

export async function executeWorkerClose(
  client: HerdrClient,
  plan: readonly ClosePlanItem[],
  stateDir?: string,
): Promise<WorkerSettlement[]> {
  return (await closeWorkerPanes(client, plan, stateDir)).settlements;
}

/**
 * Resolves split pane direction based on CLI option, env var, or Jev role heuristic:
 * researcher: "right" (side-by-side with code for parallel investigation)
 * implementer: "right" (side-by-side editing / pair programming)
 * reviewer: "down" (bottom pane for inspecting test logs, diffs, and review notes)
 * advisor: "right" (side-by-side architectural guidance)
 */
export function resolveSplitDirection(
  role: RoleKind,
  triage?: TriageDecision,
  cliOption?: string,
): "right" | "down" {
  if (cliOption === "right" || cliOption === "down") {
    return cliOption;
  }
  const envDir = (process.env.HERDR_JEV_SPLIT_DIRECTION ?? "").trim().toLowerCase();
  if (envDir === "right" || envDir === "down") {
    return envDir;
  }
  // Auto: Jev role-based layout heuristic
  if (role === "reviewer") {
    return "down";
  }
  return "right";
}

export function resolveSplitLayout(
  role: RoleKind,
  triage?: TriageDecision,
  cliOption?: string,
): SplitLayoutMode {
  if (cliOption === "right" || cliOption === "down" || cliOption === "grid") return cliOption;
  const layout = (process.env.HERDR_JEV_LAYOUT ?? "").trim().toLowerCase();
  if (layout === "grid") return "grid";
  if (layout === "role") return resolveSplitDirection(role, triage);
  const legacy = (process.env.HERDR_JEV_SPLIT_DIRECTION ?? "").trim().toLowerCase();
  if (legacy === "right" || legacy === "down") return legacy;
  return "grid";
}

export function isClientPromptReady(baseClient: string, rawText: string): boolean {
  const clean = normalizePaneText(rawText);
  if (looksLikeSelectionMenu(clean)) return false;
  if (baseClient === "antigravity") return /(^|\n)>\s*(?=\n|$)/.test(clean);
  if (baseClient === "codex") return /(^|\n)› /.test(clean);
  if (baseClient === "claude") return /(^|\n)(?:[│┃|][ \t]*)?[❯>](?: |\n|$)/.test(clean);
  return true;
}

function hasReadyPattern(baseClient: string): boolean {
  return baseClient === "antigravity" || baseClient === "codex" || baseClient === "claude";
}

const UNKNOWN_STATE_STABLE_MS = 1000;
const UNKNOWN_STATE_GRACE_MS = 3000;

function trustUnverifiedResult(
  context: { agentName: string; paneId: string; commandText: string; direction: "right" | "down"; trustPolicyReason: string },
): LaunchResult {
  return {
    ok: false,
    ackStatus: "unknown",
    completionState: "not_requested",
    completionObserved: false,
    workEvidence: "not_checked",
    promptPending: true,
    paneCreated: true,
    hint: "inspect the pane, then send the task with peer-message",
    error: "Trust confirmation was already sent; the pane still or again shows a dialog. Inspect it before dispatching work.",
    ...context,
  };
}

function paneBlockedResult(
  kind: PaneBlockKind,
  context: { agentName: string; paneId: string; commandText: string; direction: "right" | "down"; trustPolicyReason?: string },
): LaunchResult {
  const base: LaunchResult = {
    ok: false,
    ackStatus: "blocked",
    completionState: "blocked",
    completionObserved: false,
    workEvidence: "not_checked",
    promptPending: true,
    paneCreated: true,
    ...context,
  };
  if (kind === "trust") {
    return {
      ...base,
      trustRequired: true,
      hint: "confirm trust in the pane, then send the task with peer-message",
      error: "Agent requires repository trust confirmation; resolve it in the pane before dispatching work.",
    };
  }
  return {
    ...base,
    selectionRequired: true,
    hint: "choose an option in the pane, then send the task with peer-message",
    error: "Agent is waiting on a selection menu; resolve it in the pane before dispatching work.",
  };
}

export function parseHerdrPaneId(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    const data = JSON.parse(trimmed) as {
      result?: { pane?: { pane_id?: unknown }; root_pane?: { pane_id?: unknown } };
      pane?: { pane_id?: unknown };
    };
    const id = data.result?.pane?.pane_id ?? data.result?.root_pane?.pane_id ?? data.pane?.pane_id;
    if (typeof id === "string" && id.length > 0) return id;
    return undefined;
  } catch {
    // Non-JSON plain text fallback
  }
  return /^[a-zA-Z0-9:_-]+$/.test(trimmed) ? trimmed : undefined;
}

import { resolveBaseClientKind, resolveClientExecutable } from "../config/aliases.js";

const CLAUDE_MODEL_ALIASES: Readonly<Record<string, string>> = {
  "fable-5": "claude-fable-5-1",
  "fable-5-1": "claude-fable-5-1",
  "sonnet-5": "claude-sonnet-5-5",
  "sonnet-5-5": "claude-sonnet-5-5",
  "opus-5": "claude-opus-5-5",
  "opus-5-5": "claude-opus-5-5",
  "haiku-4-5": "claude-haiku-4-5-20251001",
  "haiku-4-5-20251001": "claude-haiku-4-5-20251001",
};

export function resolveClaudeModel(modelId: string): string {
  if (!modelId) return modelId;
  const trimmed = modelId.trim();

  const alias = CLAUDE_MODEL_ALIASES[trimmed.replace(/^claude-/, "").replace(/\./g, "-")];
  if (alias) return alias;

  return trimmed;
}

export function resolveAntigravityModel(
  modelId: string,
  effort?: ReasoningEffort | string,
): string {
  if (!modelId) return modelId;
  const trimmed = modelId.trim();

  if (trimmed === "claude-opus-4-6-thinking") return "claude-opus-4-6-thinking";
  if (trimmed === "claude-opus-4-6" || trimmed === "claude-opus-4.6") {
    return effort === "high" || effort === "xhigh"
      ? "claude-opus-4-6-thinking"
      : "claude-opus-4-6";
  }
  if (trimmed === "claude-sonnet-4-6" || trimmed === "claude-sonnet-4.6") {
    return "claude-sonnet-4-6";
  }
  if (trimmed.startsWith("gpt-oss")) {
    return trimmed;
  }

  let normalized = trimmed.replace(/^gemini-3[-.]8-pro/, "gemini-3.1-pro");
  normalized = normalized.replace(/^gemini-(\d+)-(\d+)/, "gemini-$1.$2");
  if (normalized === "gemini-pro") normalized = "gemini-3.1-pro";
  if (normalized === "gemini-flash") normalized = "gemini-3.8-flash";

  if (
    normalized.endsWith("-high") ||
    normalized.endsWith("-medium") ||
    normalized.endsWith("-low")
  ) {
    return normalized;
  }

  if (normalized.includes("-pro")) {
    const suffix = effort === "high" || effort === "xhigh" ? "-high" : "-low";
    return `${normalized}${suffix}`;
  }

  if (normalized.includes("-flash")) {
    const isLite = normalized.endsWith("-lite");
    const base = isLite ? normalized.replace(/-lite$/, "") : normalized;
    const suffix =
      effort === "high" || effort === "xhigh"
        ? "-high"
        : effort === "low" || isLite
          ? "-low"
          : "-medium";
    return `${base}${suffix}`;
  }

  return normalized;
}

export function nativeStageEffort(client: ClientKind, effort: ReasoningEffort): string | undefined {
  const base = resolveBaseClientKind(client);
  if (!["codex", "claude"].includes(base)) return undefined;
  return effort === "standard" ? "medium" : effort;
}

const FALLBACK_BYPASS_ARGS: Readonly<Record<string, readonly string[]>> = {
  claude: ["--dangerously-skip-permissions"],
  codex: ["--dangerously-bypass-approvals-and-sandbox"],
  antigravity: ["--dangerously-skip-permissions"],
  kiro: ["--trust-all-tools"],
  kimi: ["--yolo"],
};

const FALLBACK_READONLY_ARGS: Readonly<Record<string, readonly string[]>> = {
  codex: ["--sandbox", "read-only"],
  claude: ["--tools", "Read,Glob,Grep"],
};

const CATALOG_CLIENTS: ReadonlySet<string> = new Set(["claude", "codex", "antigravity", "kimi"]);

export function bypassEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !["0", "false", "off", "no"].includes((env.HERDR_JEV_BYPASS ?? "").trim().toLowerCase());
}

interface LaunchProfile {
  model: string;
  effortArgs: string[];
  bypassArgs: string[];
  readonlyArgs: string[];
}

function localEffortArgs(client: ClientKind, stage: StageSpec): string[] {
  const base = resolveBaseClientKind(client);
  const effort = nativeStageEffort(client, stage.effort)!;
  if (base !== "codex" && base !== "claude") return [];
  return base === "codex" ? ["-c", `model_reasoning_effort="${effort}"`] : ["--effort", effort];
}

function resolveLaunchProfile(client: ClientKind, stage: StageSpec): LaunchProfile {
  const base = resolveBaseClientKind(client);
  const resolution = CATALOG_CLIENTS.has(base)
    ? harnessModelResolve({ client: base, model: stage.model, effort: stage.effort, role: stage.role }) : null;
  const known = resolution?.known === true;
  const fallbackModel = base === "claude" ? resolveClaudeModel(stage.model)
    : base === "antigravity" ? resolveAntigravityModel(stage.model, stage.effort) : stage.model;
  const native = base === "codex" || base === "claude";
  return {
    model: stage.cliModel?.trim() || (known ? resolution!.cliModel : fallbackModel),
    effortArgs: known && native ? resolution!.effortArgs : localEffortArgs(client, stage),
    bypassArgs: resolution && resolution.bypassArgs !== null ? resolution.bypassArgs : [...(FALLBACK_BYPASS_ARGS[base] ?? [])],
    readonlyArgs: resolution?.readonlyArgs.length ? resolution.readonlyArgs : [...(FALLBACK_READONLY_ARGS[base] ?? [])],
  };
}

export function builtinLaunchArgs(): { bypass_args: Record<string, string[]>; readonly_args: Record<string, string[]> } {
  const copy = (source: Readonly<Record<string, readonly string[]>>) =>
    Object.fromEntries(Object.entries(source).map(([client, args]) => [client, [...args]]));
  return { bypass_args: copy(FALLBACK_BYPASS_ARGS), readonly_args: copy(FALLBACK_READONLY_ARGS) };
}

export function readonlyReviewerArgs(client: ClientKind, stage: StageSpec): string[] {
  return resolveLaunchProfile(client, { ...stage, role: "reviewer" }).readonlyArgs;
}

const REVIEWER_FORBIDDEN_FLAGS: ReadonlySet<string> = new Set([
  ...Object.values(FALLBACK_BYPASS_ARGS).flat(),
  "--yolo", "-y", "--full-auto", "--allow-dangerously-skip-permissions", "--trust-all-tools",
]);

const REVIEWER_FORBIDDEN_VALUED: ReadonlySet<string> = new Set([
  "--permission-mode", "--allowedTools", "--allowed-tools", "--tools", "--sandbox", "-s", "--ask-for-approval", "-a",
]);

const REVIEWER_FORBIDDEN_CONFIG = /^(?:sandbox_mode|approval_policy)\s*=/;

function stripReviewerFlags(flags: readonly string[], profile: LaunchProfile): string[] {
  const forbidden = new Set([...REVIEWER_FORBIDDEN_FLAGS, ...profile.bypassArgs]);
  const valued = new Set([...REVIEWER_FORBIDDEN_VALUED,
    ...profile.readonlyArgs.filter((arg) => arg.startsWith("-")).map((arg) => arg.split("=", 1)[0]!)]);
  const kept: string[] = [];
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]!;
    const name = flag.split("=", 1)[0]!;
    if (name === "-c" || name === "--config") {
      const inline = flag.includes("=") ? flag.slice(name.length + 1) : flags[i + 1] ?? "";
      if (REVIEWER_FORBIDDEN_CONFIG.test(inline)) { if (!flag.includes("=")) i++; continue; }
    }
    if (forbidden.has(flag) || forbidden.has(name)) continue;
    if (valued.has(name)) {
      if (!flag.includes("=") && flags[i + 1] !== undefined && !flags[i + 1]!.startsWith("-")) i++;
      continue;
    }
    kept.push(flag);
  }
  return kept;
}

function stageFlags(client: ClientKind, stage: StageSpec, profile: LaunchProfile): string[] {
  const base = resolveBaseClientKind(client);
  const requested = stage.role === "reviewer" ? stripReviewerFlags(stage.extraFlags, profile) : stage.extraFlags;
  if (base !== "codex" && base !== "claude" && base !== "antigravity") return requested;
  const flags: string[] = [];
  for (let i = 0; i < requested.length; i++) {
    if (base === "codex" && requested[i] === "-c" && requested[i + 1]?.startsWith("model_reasoning_effort=")) { i++; continue; }
    if ((base === "claude" || base === "antigravity") && requested[i] === "--effort") { i++; continue; }
    flags.push(requested[i]!);
  }
  if (base === "antigravity") return flags;
  return [...flags, ...profile.effortArgs];
}

function bypassFlags(client: ClientKind, stage: StageSpec, profile: LaunchProfile, present: readonly string[]): string[] {
  const base = resolveBaseClientKind(client);
  if (stage.role === "reviewer" || !bypassEnabled() || !(base in FALLBACK_BYPASS_ARGS)) return [];
  return profile.bypassArgs.filter((arg) => !present.includes(arg));
}

interface PreparedLaunch {
  model: string;
  flags: string[];
  bypass: string[];
  readonly: string[];
}

function prepareLaunch(client: ClientKind, stage: StageSpec, structural: readonly string[] = []): PreparedLaunch {
  const profile = resolveLaunchProfile(client, stage);
  const flags = stageFlags(client, stage, profile);
  return {
    model: profile.model,
    flags,
    bypass: bypassFlags(client, stage, profile, [...structural, ...flags]),
    readonly: stage.role === "reviewer" ? profile.readonlyArgs : [],
  };
}

function kiroTrustFlags(stage: StageSpec): string[] {
  return stage.role === "reviewer" ? [] : ["--trust-all-tools"];
}

function optionSafe(text: string): string {
  return text.startsWith("-") ? ` ${text}` : text;
}

export function buildAgentCommand(client: ClientKind, stage: StageSpec): string[] {
  const base = resolveBaseClientKind(client);
  const bin = resolveClientExecutable(client);
  const launch = prepareLaunch(client, stage, base === "kiro" ? kiroTrustFlags(stage) : []);
  switch (base) {
    case "claude":
    case "codex":
    case "antigravity": {
      return [bin, "--model", launch.model, ...launch.flags, ...launch.bypass, ...launch.readonly];
    }
    case "cursor": {
      return [bin, "--model", stage.model];
    }
    case "opencode": {
      return [bin, "--model", stage.model];
    }
    case "kimi": {
      return [bin, "-m", launch.model, ...launch.bypass, ...launch.flags, ...launch.readonly];
    }
    case "kiro": {
      return [bin, "chat", ...kiroTrustFlags(stage), "--agent", "ai-harness", "--model", stage.model, ...launch.flags, ...launch.readonly];
    }
  }
}

export function mapClientToHerdrKind(client: ClientKind): "claude" | "codex" | "cursor" | "opencode" | "agy" | "kimi" | "kiro" {
  const base = resolveBaseClientKind(client);
  if (base === "claude") return "claude";
  if (base === "codex") return "codex";
  if (base === "cursor") return "cursor";
  if (base === "antigravity") return "agy";
  if (base === "kimi") return "kimi";
  if (base === "kiro") return "kiro";
  return "opencode";
}

export function formatHerdrAgentName(
  client: ClientKind,
  role: string,
  model: string,
  suffix?: string,
): string {
  const cleanModel = model
    .toLowerCase()
    .replace(/^gpt-[0-9.]+-/, "")
    .replace(/^claude-/, "")
    .replace(/[^a-z0-9]/g, "");

  const roleTag = role === "implementer" ? "impl" : role;
  const token = (suffix ?? randomBytes(4).toString("hex")).toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(-12);

  const candidate = `jev-${roleTag}-${cleanModel}`.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return `${candidate.slice(0, 31 - token.length)}-${token}`;
}

function resolveGitBranchAndForkSha(cwd: string): { branch?: string; forkSha?: string; gitDir?: string } {
  try {
    const rev = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
    const forkSha = rev.status === 0 && rev.stdout ? rev.stdout.trim() : undefined;
    const branchRes = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8" });
    const branch = branchRes.status === 0 && branchRes.stdout ? branchRes.stdout.trim() : undefined;
    const common = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, encoding: "utf8" });
    const gitDir = common.status === 0 && common.stdout.trim().startsWith("/") ? common.stdout.trim() : undefined;
    return {
      branch: branch || undefined,
      forkSha: forkSha || undefined,
      gitDir,
    };
  } catch {
    return {};
  }
}

interface TrustState {
  outcome?: TrustOutcome;
  failure?: string;
  attempted: boolean;
  entered?: boolean;
  trackingError?: string;
}

const PANE_DECORATION = /[\s\u2500-\u257f|]+/g;

function compactPaneText(value: string): string {
  return value.replace(ANSI_PATTERN, "").replace(PANE_DECORATION, "");
}

const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type LaunchInput = {
  client: ClientKind;
  stage: StageSpec;
  handoffPrompt: string;
  herdr?: HerdrClient;
  direction?: SplitDirectionOption;
  triage?: TriageDecision;
  waitForCompletion?: boolean;
  completionTimeoutMs?: number;
  deliveryTimeoutMs?: number;
  agentName?: string;
  layout?: "split" | "tab";
  reuseExisting?: boolean;
  sourcePaneId?: string;
  workspaceId?: string;
  cwd?: string;
  clock?: { now: () => number; sleep: (ms: number) => Promise<void> };
};

async function launchStageInHerdrAttempt(input: LaunchInput): Promise<LaunchResult> {
  const trust: TrustState = { attempted: false };
  const result = await launchStageCore(input, trust);
  const tracked = trust.trackingError ? { ...result, trackingError: trust.trackingError } : result;
  return trust.outcome?.confirmed && !result.trustRequired ? { ...tracked, trustConfirmed: true, trustPolicyReason: trust.outcome.reason } : tracked;
}

async function launchStageCore(input: LaunchInput, trust: TrustState): Promise<LaunchResult> {
  const clock = input.clock ?? { now: Date.now, sleep: (ms: number) => new Promise(r => setTimeout(r, ms)) };
  const herdr = input.herdr ?? createHerdrClient();
  const effectiveClient = input.stage.client ?? input.client;
  const command = buildAgentCommand(effectiveClient, input.stage);
  const commandText = command.join(" ");

  if (process.env.HERDR_ENV !== "1") {
    return {
      ok: true,
      ackStatus: "not_attempted",
      completionState: "not_requested",
      completionObserved: false,
      workEvidence: "not_checked",
      paneCreated: false,
      commandText,
      error: "Not in Herdr environment (HERDR_ENV != 1). Run manually or launch from Herdr pane.",
    };
  }

  const agentName = input.agentName ?? formatHerdrAgentName(effectiveClient, input.stage.role, input.stage.model);
  if (!AGENT_NAME.test(agentName)) {
    return { ok: false, ackStatus: "rejected", error: "Invalid agent name: use letters, digits, '.', '_', ':' or '-', starting with a letter or digit", commandText };
  }
  const readyBase = resolveBaseClientKind(effectiveClient);
  const launchCwd = input.cwd ? resolvePath(input.cwd) : undefined;
  const workerCwd = launchCwd ?? process.cwd();
  const resolveBlock = async (kind: PaneBlockKind, context: { paneId: string; direction: "right" | "down" }): Promise<LaunchResult | null> => {
    if (kind === "trust" && !trust.attempted) {
      trust.attempted = true;
      const outcome = await confirmWorkspaceTrust({ herdr, target: agentName, cwd: workerCwd, flags: command.slice(1), clock,
        ready: (text) => isClientPromptReady(readyBase, text) });
      if (outcome.confirmed) {
        trust.outcome = outcome;
        return null;
      }
      if (outcome.reason === "not_trust_dialog") return null;
      trust.failure = outcome.reason;
      if (outcome.entered) trust.entered = true;
    }
    if (kind === "trust" && (trust.entered || trust.outcome?.confirmed)) {
      return trustUnverifiedResult({ agentName, commandText, ...context, trustPolicyReason: trust.failure ?? "trust_dialog_reappeared" });
    }
    return paneBlockedResult(kind, { agentName, commandText, ...context, ...(kind === "trust" ? { trustPolicyReason: trust.failure ?? "trust_dialog_reappeared" } : {}) });
  };
  if (input.reuseExisting) {
    if (!input.agentName || !herdr.getAgent) return { ok: false, ackStatus: "rejected", error: "A stable agent name and native lookup are required for retry recovery", commandText };
    const existing = await herdr.getAgent(agentName);
    if (existing.ok) {
      let existingPane: string | undefined;
      try { existingPane = JSON.parse(existing.stdout).result?.agent?.pane_id; } catch {}
      return { ok: false, ackStatus: "unknown", paneCreated: true, agentName, paneId: existingPane, commandText,
        error: "Existing peer retained. Use peer-read and peer-message on this handle; spawn recovery never resends a prompt or opens another tab." };
    }
    let code: string | undefined;
    try { code = JSON.parse(existing.stdout || existing.stderr).error?.code; } catch {}
    if (code !== "agent_not_found" && code !== "not_found") return { ok: false, ackStatus: "unknown", agentName, commandText,
      error: "Peer existence cannot be determined; inspect the existing attempt before retrying." };
  }
  try { claimHerdrSpawn(`spawn:${agentName}`); }
  catch (error) { return { ok: false, ackStatus: "unknown", agentName, commandText,
    error: `Named spawn already attempted or cannot be fenced. Inspect existing tabs/panes before choosing a fresh handle: ${String(error)}` }; }
  const releaseFence = () => { try { releaseHerdrSpawn(`spawn:${agentName}`); } catch {} };
  const splitLayout = resolveSplitLayout(input.stage.role, input.triage, input.direction);
  let splitDirection: "right" | "down" = splitLayout === "down" ? "down" : "right";
  let splitPaneId = input.sourcePaneId;
  let splitRatio: number | undefined;
  const callerPaneId = input.sourcePaneId ?? process.env.HERDR_PANE_ID;
  const existingRecords = callerPaneId ? readGridWorkerRecords(callerPaneId) : [];
  let deadPaneIds = new Set<string>();
  if (input.layout !== "tab" && splitLayout === "grid" && callerPaneId && herdr.paneLayout) {
    const layoutResult = await herdr.paneLayout(callerPaneId);
    if (!layoutResult.ok) { releaseFence(); return { ok: false, ackStatus: classifyHerdrCommandFailure(layoutResult), error: `Pane layout failed: ${layoutResult.stderr || layoutResult.stdout}`, commandText }; }
    let layout: PaneLayoutInput;
    try { layout = JSON.parse(layoutResult.stdout); } catch { layout = null as unknown as PaneLayoutInput; }
    if (!layout || typeof layout !== "object") { releaseFence(); return { ok: false, ackStatus: "unknown", error: "Could not parse Herdr pane layout", commandText }; }
    const livePaneIds = layoutPaneIds(layout);
    const liveRecords = existingRecords.filter((r) => livePaneIds.has(r.paneId));
    if (livePaneIds.has(callerPaneId)) {
      deadPaneIds = new Set(existingRecords.filter((r) => r.layout !== "tab" && !livePaneIds.has(r.paneId)).map((r) => r.paneId));
    }
    const plan = planGridSplit(layout, callerPaneId, liveRecords.map((r) => r.paneId));
    splitPaneId = plan.targetPaneId;
    splitDirection = plan.direction;
    splitRatio = plan.ratio;
  }

  // 1. Split current pane with resolved direction
  const split = input.layout === "tab"
    ? await herdr.createTab?.({ label: agentName, cwd: workerCwd, workspaceId: input.workspaceId })
    : await herdr.splitCurrent({ direction: splitDirection, paneId: splitPaneId, ratio: splitRatio, cwd: launchCwd });
  if (!split) { releaseFence(); return { ok: false, ackStatus: "rejected", error: "Tab creation unavailable", commandText }; }
  if (!split.ok) {
    const splitAck = classifyHerdrCommandFailure(split);
    if (splitAck === "rejected") releaseFence();
    return { ok: false, ackStatus: splitAck, completionState: "not_requested", completionObserved: false, workEvidence: "not_checked", error: `Pane split failed: ${split.stderr || split.stdout}`, commandText, direction: splitDirection };
  }

  const paneId = parseHerdrPaneId(split.stdout);
  if (!paneId) {
    return { ok: false, ackStatus: "unknown", completionState: "not_requested", completionObserved: false, workEvidence: "not_checked", error: "Could not resolve pane ID from Herdr output", commandText, direction: splitDirection };
  }

  if (callerPaneId) {
    const gitInfo = resolveGitBranchAndForkSha(workerCwd);
    const newRecord: GridWorkerRecord = {
      paneId,
      handle: agentName,
      cwd: workerCwd,
      branch: gitInfo.branch,
      forkSha: gitInfo.forkSha,
      ...(gitInfo.gitDir ? { gitDir: gitInfo.gitDir } : {}),
      layout: input.layout === "tab" ? "tab" : splitLayout === "grid" ? "grid" : "split",
    };
    try {
      const { kept } = settleDeadRecords(existingRecords.filter((r) => deadPaneIds.has(r.paneId)));
      updateGridWorkers(callerPaneId, (records) => [
        ...records.flatMap((r) => deadPaneIds.has(r.paneId) ? (kept.has(r.paneId) ? [kept.get(r.paneId)!] : []) : r.paneId === paneId ? [] : [r]),
        newRecord,
      ]);
    } catch (error) {
      trust.trackingError = errorText(error);
      console.error(`[herdr-jev] Worker tracking unavailable for ${paneId}: ${trust.trackingError}`);
    }
  }

  let releasePane: (() => Promise<void>) | undefined;
  try { releasePane = await reserveHerdrHandle(`pane:${paneId}`); }
  catch (error) { return { ok: false, ackStatus: "unknown", paneCreated: true, agentName, paneId, error: String(error), commandText }; }
  try {

  // 2. Start agent inside pane
  const herdrKind = mapClientToHerdrKind(effectiveClient);
  const started = await herdr.startAgent({
    name: agentName,
    kind: herdrKind,
    paneId,
    agentArgs: command.slice(1),
  });

  let startFailed = !started.ok;
  if (startFailed && autoTrustEnabled() && herdr.readAgent && /agent_not_ready/.test(`${started.stdout}\n${started.stderr}`)) {
    const screen = await herdr.readAgent(agentName);
    if (screen.ok && classifyPaneBlock(screen) === "trust") startFailed = false;
  }
  if (startFailed) {
    const ackStatus = classifyHerdrCommandFailure(started);
    if (ackStatus === "rejected") await herdr.closePane(paneId);
    return { ok: false, ackStatus, paneCreated: ackStatus === "unknown", promptPending: true, agentName, completionState: "not_requested", completionObserved: false, workEvidence: "not_checked", error: `Agent start failed: ${started.stderr || started.stdout}`, paneId, commandText, direction: splitDirection };
  }

  if (herdr.reportSpawn) {
    try {
      const observed = await herdr.reportSpawn(paneId, {
        jev_parent: input.sourcePaneId ?? process.env.HERDR_PANE_ID ?? "unknown",
        jev_role: input.stage.role,
        jev_model: input.stage.model,
        jev_handle: agentName,
      });
      if (!observed.ok) console.error(`Spawn metadata unavailable for ${paneId}: ${observed.stderr}`);
    } catch (error) { console.error(`Spawn metadata unavailable for ${paneId}: ${String(error)}`); }
  }

  // 3. Send initial prompt/handoff immediately into the split pane
  if (herdr.readAgent) {
    const screen = await herdr.readAgent(agentName);
    const initialBlock = screen.ok ? classifyPaneBlock(screen) : null;
    if (initialBlock) {
      const blocked = await resolveBlock(initialBlock, { paneId, direction: splitDirection });
      if (blocked) return blocked;
    }
  }
  let promptDelivered = false;
  if (input.handoffPrompt && input.handoffPrompt.trim().length > 0) {
    const baseClient = resolveBaseClientKind(effectiveClient);
    const parsedTimeout = parseInt(process.env.HERDR_JEV_READY_TIMEOUT_MS || "45000", 10);
    const readyTimeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 45000;
    const readyDeadline = clock.now() + readyTimeoutMs;
    let isReady = false;
    let unknownSince: number | null = null;

    while (clock.now() < readyDeadline) {
      if (herdr.getAgent && herdr.readAgent) {
        const [agentRes, screenRes] = await Promise.all([
          herdr.getAgent(agentName),
          herdr.readAgent(agentName)
        ]);
        if (screenRes && screenRes.ok) {
          const block = classifyPaneBlock(screenRes);
          if (block) {
            const blocked = await resolveBlock(block, { paneId, direction: splitDirection });
            if (blocked) return blocked;
            unknownSince = null;
            await clock.sleep(500);
            continue;
          }
        }
        if (agentRes && agentRes.ok && screenRes && screenRes.ok) {
          const state = readHerdrObservedState(agentRes);
          if (state === "idle" || state === "unknown") {
            const readyMatch = isClientPromptReady(baseClient, `${screenRes.stdout}\n${screenRes.stderr}`);
            if (readyMatch && state === "idle") {
              isReady = true;
              break;
            }
            if (readyMatch) {
              unknownSince ??= clock.now();
              const required = hasReadyPattern(baseClient) ? UNKNOWN_STATE_STABLE_MS : UNKNOWN_STATE_GRACE_MS;
              if (clock.now() - unknownSince >= required) {
                isReady = true;
                break;
              }
            } else {
              unknownSince = null;
            }
          } else {
            unknownSince = null;
          }
        }
      } else {
        isReady = true;
        break;
      }
      await clock.sleep(500);
    }

    if (!isReady) {
      return {
        ok: false,
        ackStatus: "unknown",
        completionState: "not_requested",
        completionObserved: false,
        workEvidence: "not_checked",
        promptPending: true,
        hint: "prompt not observed; use peer-message",
        error: "Agent prompt readiness timed out",
        paneCreated: true,
        agentName,
        paneId,
        commandText,
        direction: splitDirection,
      };
    }

    let prompted = await herdr.prompt({
      target: agentName,
      text: input.handoffPrompt,
      wait: true,
      waitForStart: true,
    });

    if (!prompted.ok && `${prompted.stdout}\n${prompted.stderr}`.includes("agent_prompt_stalled")) {
      if (herdr.getAgent && herdr.readAgent) {
        const [agentRes, screenRes] = await Promise.all([
          herdr.getAgent(agentName),
          herdr.readAgent(agentName)
        ]);
        if (agentRes && agentRes.ok && screenRes && screenRes.ok) {
          const state = readHerdrObservedState(agentRes);
          const visible = compactPaneText(`${screenRes.stdout}\n${screenRes.stderr}`);
          const promptPrefix = compactPaneText(input.handoffPrompt).slice(0, 16);
          if (state === "idle" && !visible.includes(promptPrefix)) {
            await clock.sleep(2000);
            prompted = await herdr.prompt({
              target: agentName,
              text: input.handoffPrompt,
              wait: true,
              waitForStart: true,
            });
          }
        }
      }
    }

    if (!prompted.ok) {
      const stalledWithText = `${prompted.stdout}\n${prompted.stderr}`.includes("agent_prompt_stalled");
      return {
        ok: false,
        ackStatus: classifyHerdrCommandFailure(prompted),
        completionState: "not_requested",
        completionObserved: false,
        workEvidence: "not_checked",
        ...(stalledWithText ? { promptPending: true, hint: "prompt may be typed but unsent in the pane; submit or clear the input before using peer-message" } : {}),
        error: `Prompt dispatch failed: ${prompted.stderr || prompted.stdout || "no acknowledgement"}`,
        paneCreated: true,
        agentName,
        paneId,
        commandText,
        direction: splitDirection,
      };
    }
    const compactText = compactPaneText;
    const promptPrefix = compactText(input.handoffPrompt).slice(0, 32);
    const timeoutMs = input.deliveryTimeoutMs ?? 8000;
    const deadline = clock.now() + timeoutMs;
    while (!promptDelivered) {
      if (herdr.readAgent || herdr.readPane) {
        const readResult = herdr.readAgent
          ? await herdr.readAgent(agentName)
          : await herdr.readPane!(paneId);
        if (readResult && readResult.ok) {
          if (compactText(`${readResult.stdout}\n${readResult.stderr}`).includes(promptPrefix)) {
            promptDelivered = true;
            break;
          }
        }
      }
      if (herdr.getAgent) {
        const agentResult = await herdr.getAgent(agentName);
        if (agentResult && agentResult.ok) {
          const observed = readHerdrStructuredState(agentResult);
          if (observed !== null && observed !== "idle" && observed !== "unknown") {
            promptDelivered = true;
            break;
          }
        }
      }
      if (clock.now() >= deadline) break;
      await clock.sleep(Math.min(100, Math.max(0, deadline - clock.now())));
    }
    if (!promptDelivered) {
      return {
        ok: false,
        ackStatus: "unknown",
        promptPending: true,
        hint: "prompt not observed; use peer-message",
        error: "prompt not observed; use peer-message",
        paneCreated: true,
        agentName,
        paneId,
        commandText,
        direction: splitDirection,
      };
    }
  }

  if (input.waitForCompletion) {
    const waited = await herdr.waitFor({ target: agentName, timeoutMs: input.completionTimeoutMs });
    const completionState = readHerdrObservedState(waited) ?? (waited.ok ? "unknown" : "pending");
    return {
      ok: true,
      ackStatus: "acknowledged",
      completionState,
      completionObserved: completionState === "done" || completionState === "blocked" || completionState === "unknown",
      workEvidence: "not_checked",
      paneCreated: true,
      promptDelivered: promptDelivered || undefined,
      agentName,
      paneId,
      commandText,
      direction: splitDirection,
    };
  }

  return {
    ok: true,
    ackStatus: "acknowledged",
    completionState: "not_requested",
    completionObserved: false,
    workEvidence: "not_checked",
    paneCreated: true,
    promptDelivered: promptDelivered || undefined,
    agentName,
    paneId,
    commandText,
    direction: splitDirection,
  };
  } finally { await releasePane(); }
}

export async function launchStageInHerdr(input: Parameters<typeof launchStageInHerdrAttempt>[0]): Promise<LaunchResult> {
  if (!input.reuseExisting || !input.agentName || process.env.HERDR_ENV !== "1") return launchStageInHerdrAttempt(input);
  let release: (() => Promise<void>) | undefined;
  try {
    release = await reserveHerdrHandle(`spawn:${input.agentName}`);
    return await launchStageInHerdrAttempt(input);
  } catch (error) {
    return { ok: false, ackStatus: "unknown", agentName: input.agentName, error: String(error) };
  } finally { await release?.(); }
}

/**
 * Resolves whether subagents should run in a split pane or inline.
 * Precedence:
 * 1. Explicit CLI argument (--split or --no-split)
 * 2. HERDR_JEV_SPLIT_SUBAGENTS env var ("0", "false", "off", "no" => false; "1", "true", "on", "yes" => true)
 * 3. Fallback: HERDR_ENV === "1" => true, otherwise false
 */
export function shouldSplitSubagents(cliOption?: boolean): boolean {
  if (cliOption !== undefined) {
    return cliOption;
  }
  const envVar = process.env.HERDR_JEV_SPLIT_SUBAGENTS;
  if (envVar !== undefined && envVar.trim() !== "") {
    const val = envVar.trim().toLowerCase();
    if (val === "0" || val === "false" || val === "off" || val === "no") {
      return false;
    }
    if (val === "1" || val === "true" || val === "on" || val === "yes") {
      return true;
    }
  }
  return process.env.HERDR_ENV === "1";
}

/**
 * Builds CLI command argument array for executing an agent inline in the current terminal.
 */
export function buildInlineCommand(
  client: ClientKind,
  stage: StageSpec,
  promptText: string,
  nonInteractive = false,
): string[] {
  const base = resolveBaseClientKind(client);
  const bin = resolveClientExecutable(client);
  const launch = prepareLaunch(client, stage, base === "kiro" ? kiroTrustFlags(stage) : []);
  const prompt = optionSafe(promptText);
  switch (base) {
    case "claude": {
      if (nonInteractive) return [bin, "-p", prompt, "--model", launch.model, ...launch.flags, ...launch.bypass, ...launch.readonly];
      return [bin, "--model", launch.model, ...launch.flags, ...launch.bypass, prompt, ...launch.readonly];
    }
    case "codex": {
      if (nonInteractive) return [bin, "exec", prompt, "--model", launch.model, ...launch.flags, ...launch.bypass, ...launch.readonly];
      return [bin, "--model", launch.model, ...launch.flags, ...launch.bypass, prompt, ...launch.readonly];
    }
    case "antigravity": {
      return [bin, nonInteractive ? "-p" : "-i", prompt, "--model", launch.model, ...launch.flags, ...launch.bypass, ...launch.readonly];
    }
    case "cursor": {
      return [bin, "--model", stage.model, prompt];
    }
    case "opencode": {
      return [bin, "--model", stage.model, prompt];
    }
    case "kimi": {
      if (nonInteractive) {
        return [bin, "-m", launch.model, "-p", prompt, ...launch.readonly];
      }
      return [bin, "-m", launch.model, ...launch.bypass, prompt, ...launch.readonly];
    }
    case "kiro": {
      return [bin, "chat", ...kiroTrustFlags(stage), "--agent", "ai-harness", "--model", stage.model, ...launch.flags, ...(nonInteractive ? ["--no-interactive"] : []), prompt, ...launch.readonly];
    }
  }
}

function redactPrompt(args: readonly string[], promptText: string): string {
  const sent = optionSafe(promptText);
  return args.map((arg) => arg === sent ? "<prompt>" : arg).join(" ");
}

/**
 * Executes an agent inline in the current terminal using stdio: "inherit".
 */
export function runAgentInline(input: {
  client: ClientKind;
  stage: StageSpec;
  promptText: string;
  nonInteractive?: boolean;
}): InlineRunResult {
  const effectiveClient = input.stage.client ?? input.client;
  const args = buildInlineCommand(effectiveClient, input.stage, input.promptText, input.nonInteractive);
  const commandText = redactPrompt(args, input.promptText);

  if (isTestGuardActive()) {
    if (!isTestSafeBinary(args[0])) {
      return { ok: false, exitCode: 126, error: "blocked_by_test_guard", commandText };
    }
  }

  try {
    const result = spawnSync(args[0], args.slice(1), {
      stdio: "inherit",
      env: process.env,
    });

    const exitCode = result.status;
    if (result.error) {
      return { ok: false, exitCode, error: result.error.message, commandText };
    }
    return { ok: exitCode === 0, exitCode, commandText };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: errorMsg, commandText };
  }
}

export interface CapturedRunResult {
  ok: boolean;
  output: string;
  exitCode: number | null;
  error?: string;
  commandText: string;
}

/**
 * Executes an agent non-interactively in the background and captures its output (stdout + stderr).
 * Perfect for in-prompt subagent delegation and MCP tool execution.
 */
export function runAgentCaptured(input: {
  client: ClientKind;
  stage: StageSpec;
  promptText: string;
  cwd?: string;
  timeoutMs?: number;
}): CapturedRunResult {
  const effectiveClient = input.stage.client ?? input.client;
  const args = buildInlineCommand(effectiveClient, input.stage, input.promptText, true);
  const commandText = redactPrompt(args, input.promptText);

  if (isTestGuardActive()) {
    if (!isTestSafeBinary(args[0])) {
      return { ok: false, output: "", exitCode: 126, error: "blocked_by_test_guard", commandText };
    }
  }

  try {
    const result = spawnSync(args[0], args.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: input.timeoutMs ?? 120000,
      cwd: input.cwd ?? process.cwd(),
      env: process.env,
    });

    const exitCode = result.status;
    const stdout = (result.stdout || "").trim();
    const stderr = (result.stderr || "").trim();
    const output = stdout || stderr || (exitCode === 0 ? "(no output returned)" : "(command exited with error and no output)");

    if (result.error) {
      return { ok: false, output, exitCode, error: result.error.message, commandText };
    }
    return { ok: exitCode === 0, output, exitCode, commandText };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { ok: false, output: "", exitCode: 1, error: errorMsg, commandText };
  }
}
