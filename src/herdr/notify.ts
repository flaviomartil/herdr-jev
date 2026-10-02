import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, accessSync, constants, statSync, linkSync, realpathSync, copyFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { DEFAULT_COMMAND_TIMEOUT_MS, readHerdrObservedState, resolveFakeBinDir, type RunCommand } from "./client.js";
import type { HerdrCommandResult } from "../types/index.js";
import { ANSI_PATTERN, redactSecrets } from "./pane-text.js";
import { isTestGuardActive, resolveStateDir } from "./state-dir.js";

export interface NotifyOptions {
  pane?: string;
  name?: string;
  project?: string;
  attention?: string;
  reason?: string;
  confidence?: number;
  jevState?: string;
  reasonConfidence?: number;
  nativeStatus?: string;
  agent?: string;
  task?: string;
  release?: boolean;
  releaseStale?: boolean;
  releaseAll?: boolean;
  owner?: string;
  dryRun?: boolean;
  now?: number;
}

export interface NotifyHooks {
  afterCooldownCheck?: () => void | Promise<void>;
  afterStaleClaimSeen?: () => void | Promise<void>;
  hookTimeoutMs?: number;
  hookKillGraceMs?: number;
}

export interface EscalationLockHooks {
  afterStaleLockSeen?: () => void | Promise<void>;
  lockWaitMs?: number;
}

interface EscalationRecord {
  pane: string;
  agent: string;
  time: number;
  attempts?: number;
  owner?: string;
}

const PANE_PATTERN = /^[A-Za-z0-9_]+:[A-Za-z0-9_]+$/;
const AGENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const OWNER_PATTERN = /^[0-9]+-[A-Za-z0-9]{1,48}$/;
const REASONS: ReadonlySet<string> = new Set(["approval", "question", "error", "none"]);
const CLAIM_STALE_MS = DEFAULT_COMMAND_TIMEOUT_MS + 30_000;
const CLOCK_SKEW_MS = 5_000;
const LOCK_STALE_MS = 2_000;
const LOCK_WAIT_MS = 3_000;
const RELEASE_STALE_AGE_MS = 15 * 60 * 1000;
const MAX_RELEASE_ATTEMPTS = 3;
const LOCK_OVERTIME_TAKEOVERS = 3;
const HOOK_TIMEOUT_MS = 5_000;
const HOOK_KILL_GRACE_MS = 1_000;
const OUTBOUND_TITLE_LIMIT = 2_048;
const OUTBOUND_TASK_LIMIT = 1_024;
const TRANSIENT_GRACE_MS = 6 * 60 * 60 * 1000;
const TRANSIENT_FAILURE = /(?:connection (?:refused|reset|closed)|econn|socket|transport|timed[ -]?out|timeout|not running|unavailable|temporar|broken pipe|\beof\b|enoent|spawn)/i;

export function resolveNotifyHook(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.HERDR_JEV_NOTIFY_HOOK !== undefined) {
    if (env.HERDR_JEV_NOTIFY_HOOK === "" || env.HERDR_JEV_NOTIFY_HOOK === "off") {
      return undefined;
    }
    return env.HERDR_JEV_NOTIFY_HOOK;
  }
  const configDir = (env.HERDR_PLUGIN_ID === "herdr-jev" && env.HERDR_PLUGIN_CONFIG_DIR)
    ? env.HERDR_PLUGIN_CONFIG_DIR
    : join(homedir(), ".config", "herdr", "plugins", "config", "herdr-jev");
  const defaultHook = join(configDir, "notify-hook");
  try {
    if (existsSync(defaultHook) && statSync(defaultHook).isFile()) {
      accessSync(defaultHook, constants.X_OK);
      return defaultHook;
    }
  } catch {}
  return undefined;
}

function parseEscalations(file: string): { records: EscalationRecord[]; damaged: boolean } {
  if (!existsSync(file)) return { records: [], damaged: false };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    if (!Array.isArray(parsed)) return { records: [], damaged: true };
    const records: EscalationRecord[] = [];
    let damaged = false;
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") { damaged = true; continue; }
      if (typeof entry.pane !== "string" || !PANE_PATTERN.test(entry.pane)) { damaged = true; continue; }
      if (typeof entry.agent !== "string" || !AGENT_PATTERN.test(entry.agent)) { damaged = true; continue; }
      if (typeof entry.time !== "number" || !Number.isFinite(entry.time)) { damaged = true; continue; }
      const attempts = Number(entry.attempts);
      const record: EscalationRecord = {
        pane: entry.pane,
        agent: entry.agent,
        time: entry.time,
        attempts: Number.isFinite(attempts) && attempts > 0 ? Math.trunc(attempts) : 0,
      };
      if (typeof entry.owner === "string" && OWNER_PATTERN.test(entry.owner)) record.owner = entry.owner;
      records.push(record);
    }
    return { records, damaged };
  } catch (e) {
    return { records: [], damaged: existsSync(file) };
  }
}

function readEscalations(file: string): EscalationRecord[] {
  return parseEscalations(file).records;
}

function readEscalationsForUpdate(file: string): EscalationRecord[] {
  const { records, damaged } = parseEscalations(file);
  if (damaged) {
    try { copyFileSync(file, `${file}.corrupt.${Date.now()}.${randomBytes(3).toString("hex")}`); } catch (e) {}
  }
  return records;
}

function writeEscalations(file: string, escalations: EscalationRecord[]) {
  const tempFile = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tempFile, JSON.stringify(escalations));
    renameSync(tempFile, file);
  } catch (e) {
    try { unlinkSync(tempFile); } catch (err) {}
    throw e;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type TakeOver = "taken" | "missing" | "fresh" | "failed";

function restoreGrave(file: string, grave: string) {
  try {
    linkSync(grave, file);
  } catch (e: any) {
    if (e?.code !== "EEXIST") {
      try {
        renameSync(grave, file);
        return;
      } catch (err) {}
    }
  }
  try { unlinkSync(grave); } catch (e) {}
}

function takeOverWithoutSnapshot(file: string, grave: string, isStale: (path: string) => boolean): TakeOver {
  try {
    if (!isStale(file)) return "fresh";
  } catch (e: any) {
    return e?.code === "ENOENT" ? "missing" : "fresh";
  }
  try {
    renameSync(file, grave);
  } catch (e: any) {
    return e?.code === "ENOENT" ? "missing" : "failed";
  }
  let stale = false;
  try { stale = isStale(grave); } catch (e) {}
  if (stale) {
    try { unlinkSync(grave); } catch (e) {}
    return "taken";
  }
  restoreGrave(file, grave);
  return "fresh";
}

export function takeOverStale(file: string, isStale: (path: string) => boolean): TakeOver {
  const suffix = `${process.pid}.${randomBytes(4).toString("hex")}`;
  const snapshot = `${file}.${suffix}.stale`;
  const grave = `${file}.${suffix}.grave`;
  try {
    linkSync(file, snapshot);
  } catch (e: any) {
    if (e?.code === "ENOENT") return "missing";
    return takeOverWithoutSnapshot(file, grave, isStale);
  }
  let stale = false;
  try { stale = isStale(snapshot); } catch (e) {}
  if (stale) {
    try {
      if (statSync(file).ino !== statSync(snapshot).ino) stale = false;
    } catch (e: any) {
      try { unlinkSync(snapshot); } catch (err) {}
      return e?.code === "ENOENT" ? "missing" : "failed";
    }
  }
  if (!stale) {
    try { unlinkSync(snapshot); } catch (e) {}
    return "fresh";
  }
  try {
    renameSync(file, grave);
  } catch (e: any) {
    try { unlinkSync(snapshot); } catch (err) {}
    return e?.code === "ENOENT" ? "missing" : "failed";
  }
  let sameFile = false;
  try { sameFile = statSync(grave).ino === statSync(snapshot).ino; } catch (e) {}
  try { unlinkSync(snapshot); } catch (e) {}
  if (sameFile) {
    try { unlinkSync(grave); } catch (e) {}
    return "taken";
  }
  restoreGrave(file, grave);
  return "fresh";
}

function releaseLock(lockFile: string, token: string) {
  try {
    if (readFileSync(lockFile, "utf-8") === token) unlinkSync(lockFile);
  } catch (e) {}
}

export async function updateEscalations(file: string, mutate: (records: EscalationRecord[]) => EscalationRecord[], hooks: EscalationLockHooks = {}): Promise<void> {
  mkdirSync(dirname(file), { recursive: true });
  const lockFile = `${file}.lock`;
  const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const deadline = Date.now() + (hooks.lockWaitMs ?? LOCK_WAIT_MS);
  let overtime = 0;
  for (;;) {
    try {
      writeFileSync(lockFile, token, { flag: "wx" });
      break;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      const expired = Date.now() > deadline;
      let age = 0;
      try {
        age = Date.now() - statSync(lockFile).mtimeMs;
      } catch (err: any) {
        if (err?.code === "ENOENT") continue;
      }
      const stale = age > LOCK_STALE_MS;
      const future = age < -CLOCK_SKEW_MS;
      if (expired && !stale && !future) throw new Error("escalation_lock_timeout");
      if (expired && overtime++ >= LOCK_OVERTIME_TAKEOVERS) throw new Error("escalation_lock_timeout");
      if (stale || (expired && future)) {
        await hooks.afterStaleLockSeen?.();
        const outcome = takeOverStale(lockFile, (snapshot) => {
          const snapshotAge = Date.now() - statSync(snapshot).mtimeMs;
          return snapshotAge > LOCK_STALE_MS || (expired && snapshotAge < -CLOCK_SKEW_MS);
        });
        if (outcome === "taken" || outcome === "missing") continue;
      }
      await sleep(15);
    }
  }
  try {
    writeEscalations(file, mutate(readEscalationsForUpdate(file)));
  } finally {
    releaseLock(lockFile, token);
  }
}

async function tryUpdateEscalations(file: string, mutate: (records: EscalationRecord[]) => EscalationRecord[]): Promise<boolean> {
  try {
    await updateEscalations(file, mutate);
    return true;
  } catch (e) {
    return false;
  }
}

function recordKey(record: EscalationRecord): string {
  return `${record.pane}|${record.owner ?? ""}|${record.time}`;
}

function bumpAttempts(records: EscalationRecord[], failed: ReadonlySet<string>, onExhausted?: () => void): EscalationRecord[] {
  const next: EscalationRecord[] = [];
  for (const record of records) {
    if (!failed.has(recordKey(record))) {
      next.push(record);
      continue;
    }
    const attempts = (record.attempts || 0) + 1;
    if (attempts < MAX_RELEASE_ATTEMPTS) next.push({ ...record, attempts });
    else onExhausted?.();
  }
  return next;
}

function ownerAlive(owner: string | undefined): boolean {
  if (!owner) return false;
  const pid = Number(owner.split("-")[0]);
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

type Verification = "blocked" | "not_blocked" | "unavailable";

function verifyBlocked(res: HerdrCommandResult): Verification {
  if (!res.ok) return "unavailable";
  let status: unknown;
  try {
    const data = JSON.parse(res.stdout);
    status = data.result?.agent?.agent_status ?? data.agent?.agent_status ?? data.agent_status ?? data.result?.status ?? data.status;
  } catch {}
  if (status === "blocked") return "blocked";
  const observed = readHerdrObservedState(res);
  if (observed === "blocked") return "blocked";
  if (typeof status === "string" && status !== "") return "not_blocked";
  if (observed === "idle" || observed === "working" || observed === "done" || observed === "unknown") return "not_blocked";
  return "unavailable";
}

function sanitizePaneId(pane: string) {
  return pane.replace(":", "-");
}

function cooldownActive(stateFile: string, now: number, cooldownS: number): boolean {
  if (!existsSync(stateFile)) return false;
  try {
    const data = JSON.parse(readFileSync(stateFile, "utf-8"));
    if (typeof data?.time !== "number" || !Number.isFinite(data.time)) return false;
    const age = now - data.time;
    return age >= -CLOCK_SKEW_MS && age < cooldownS * 1000;
  } catch (e) {
    return false;
  }
}

function claimTime(claimFile: string): number {
  try {
    const data = JSON.parse(readFileSync(claimFile, "utf-8"));
    if (typeof data?.time === "number" && Number.isFinite(data.time)) return data.time;
  } catch (e) {}
  return statSync(claimFile).mtimeMs;
}

function claimOwner(claimFile: string): string | undefined {
  try {
    const data = JSON.parse(readFileSync(claimFile, "utf-8"));
    return typeof data?.owner === "string" ? data.owner : undefined;
  } catch (e) {
    return undefined;
  }
}

function releaseClaim(claimFile: string, owner: string) {
  if (claimOwner(claimFile) !== owner) return;
  try { unlinkSync(claimFile); } catch (e) {}
}

function writeStateFile(stateFile: string, now: number) {
  const tempFile = `${stateFile}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tempFile, JSON.stringify({ time: now }));
    renameSync(tempFile, stateFile);
  } catch (e) {
    try { unlinkSync(tempFile); } catch (err) {}
    throw e;
  }
}

function claimStale(claimFile: string, now: number): boolean {
  const age = now - claimTime(claimFile);
  return age > CLAIM_STALE_MS || age < -CLOCK_SKEW_MS;
}

function isPaneGone(res: { stdout?: string; stderr?: string }): boolean {
  for (const text of [res.stdout, res.stderr]) {
    try {
      const error = JSON.parse(text as string)?.error;
      const code = typeof error === "string" ? error : error?.code;
      if (code === "pane_not_found" || code === "not_found") return true;
    } catch (e) {}
  }
  return false;
}

function isTransientFailure(res: { stdout?: string; stderr?: string }, record: EscalationRecord, now: number): boolean {
  if (now - record.time > TRANSIENT_GRACE_MS) return false;
  return TRANSIENT_FAILURE.test(`${res.stdout ?? ""}\n${res.stderr ?? ""}`);
}

function hookAllowedUnderGuard(hook: string): boolean {
  if (!hook.includes("/") && !hook.includes(sep)) return false;
  return isInsideDir(hook, resolveFakeBinDir());
}

function realOrResolved(path: string): string {
  try { return realpathSync(path); } catch (e) { return resolve(path); }
}

export function isInsideDir(path: string, root: string): boolean {
  const rel = relative(realOrResolved(root), realOrResolved(path));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function sanitizeOutbound(text: string, limit: number): string {
  const first = redactSecrets(text);
  const cleaned = first.replace(ANSI_PATTERN, "").replace(/[\x00-\x1F\x7F-\x9F]/g, " ");
  return redactSecrets(cleaned).slice(0, limit);
}

function runHook(hook: string, args: string[], timeoutMs: number, killGraceMs: number): Promise<boolean> {
  return new Promise<boolean>((resolveHook) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolveHook(ok);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(hook, args, { stdio: "ignore", detached: process.platform !== "win32" });
    } catch (e) {
      finish(false);
      return;
    }
    child.unref();
    const signal = (name: NodeJS.Signals) => {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, name);
          return;
        } catch (e) {}
      }
      try { child.kill(name); } catch (e) {}
    };
    let timedOut = false;
    timer = setTimeout(() => {
      timedOut = true;
      signal("SIGTERM");
      killTimer = setTimeout(() => {
        signal("SIGKILL");
        finish(false);
      }, killGraceMs);
    }, timeoutMs);
    child.on("error", () => finish(false));
    child.on("close", (code, exitSignal) => {
      if (timedOut) signal("SIGKILL");
      finish(!timedOut && code === 0 && exitSignal === null);
    });
  });
}

function getReasonText(reason: string) {
  switch (reason) {
    case "approval": return "aguardando aprovação";
    case "question": return "aguardando resposta";
    case "error": return "parado com erro";
    default: return "precisa de atenção";
  }
}

export async function handleNotifyCommand(opts: NotifyOptions, runner: RunCommand, hooks: NotifyHooks = {}): Promise<{
  sent: boolean;
  skippedReason?: string;
  channels: string[];
  dryRun?: boolean;
  wouldSend?: string[];
  escalation?: "applied" | "ineffective";
}> {
  if (opts.pane && !PANE_PATTERN.test(opts.pane)) {
    return { sent: false, skippedReason: "invalid pane id", channels: [], ...(opts.dryRun ? { dryRun: true } : {}) };
  }
  if (opts.agent && !AGENT_PATTERN.test(opts.agent)) {
    return { sent: false, skippedReason: "invalid agent", channels: [], ...(opts.dryRun ? { dryRun: true } : {}) };
  }
  if (opts.owner !== undefined && !OWNER_PATTERN.test(opts.owner)) {
    return { sent: false, skippedReason: "invalid owner", channels: [], ...(opts.dryRun ? { dryRun: true } : {}) };
  }
  if (opts.reason && !REASONS.has(opts.reason)) {
    return { sent: false, skippedReason: "invalid reason", channels: [], ...(opts.dryRun ? { dryRun: true } : {}) };
  }
  if (opts.releaseAll) {
    return handleReleaseAll(runner, opts.owner);
  }

  if (opts.releaseStale) {
    return handleReleaseStale(runner, opts.now || Date.now());
  }
  
  if (opts.release) {
    if (!opts.pane) return { sent: false, skippedReason: "no pane specified for release", channels: [] };
    return handleRelease(opts.pane, runner);
  }

  const enabled = process.env.HERDR_JEV_NOTIFY;
  if (enabled === "0" || enabled === "false" || enabled === "off") {
    return { sent: false, skippedReason: "disabled by env", channels: [], ...(opts.dryRun ? { dryRun: true } : {}) };
  }

  if (opts.attention !== "now") {
    return { sent: false, skippedReason: "attention not now", channels: [], ...(opts.dryRun ? { dryRun: true } : {}) };
  }

  if (!opts.pane || !opts.project || !opts.reason) {
    return { sent: false, skippedReason: "missing required arguments", channels: [], ...(opts.dryRun ? { dryRun: true } : {}) };
  }

  const stateDir = resolveStateDir();
  const notifyDir = join(stateDir, "notify");
  if (!opts.dryRun) {
    mkdirSync(notifyDir, { recursive: true });
  }

  const sanitizedPane = sanitizePaneId(opts.pane);
  if (!sanitizedPane) return { sent: false, skippedReason: "invalid pane id", channels: [] };
  const stateFile = join(notifyDir, `pane-${sanitizedPane}.json`);
  const claimFile = join(notifyDir, `pane-${sanitizedPane}.claim`);
  const now = opts.now || Date.now();
  const claimToken = `${process.pid}-${randomBytes(8).toString("hex")}`;
  let cooldownS = parseInt(process.env.HERDR_JEV_NOTIFY_COOLDOWN_S || "600", 10);
  if (!Number.isFinite(cooldownS) || Number.isNaN(cooldownS)) cooldownS = 600;

  if (!opts.dryRun) {
    if (cooldownActive(stateFile, now, cooldownS)) {
      return { sent: false, skippedReason: "cooldown", channels: [] };
    }
    await hooks.afterCooldownCheck?.();
    let claimed = false;
    for (let attempt = 0; attempt < 2 && !claimed; attempt++) {
      try {
        writeFileSync(claimFile, JSON.stringify({ time: now, owner: claimToken }), { flag: "wx" });
        claimed = true;
      } catch (e: any) {
        if (e?.code !== "EEXIST") return { sent: false, skippedReason: "claim failed", channels: [] };
        let stale: boolean;
        try {
          stale = claimStale(claimFile, now);
        } catch (err) {
          continue;
        }
        if (!stale) return { sent: false, skippedReason: "cooldown", channels: [] };
        await hooks.afterStaleClaimSeen?.();
        const outcome = takeOverStale(claimFile, (grave) => claimStale(grave, now));
        if (outcome === "failed") return { sent: false, skippedReason: "claim failed", channels: [] };
        if (outcome === "fresh") return { sent: false, skippedReason: "cooldown", channels: [] };
      }
    }
    if (!claimed) return { sent: false, skippedReason: "cooldown", channels: [] };
    if (cooldownActive(stateFile, now, cooldownS)) {
      releaseClaim(claimFile, claimToken);
      return { sent: false, skippedReason: "cooldown", channels: [] };
    }
  }

  const reasonText = getReasonText(opts.reason);
  const title = sanitizeOutbound(`${opts.agent || 'agent'} em ${opts.project} precisa de você`, OUTBOUND_TITLE_LIMIT);
  const safeTask = opts.task ? sanitizeOutbound(opts.task, OUTBOUND_TASK_LIMIT) : undefined;
  let body = safeTask ? `${safeTask.slice(0, 80)}: ${reasonText}` : reasonText;
  let safeTitle = title.startsWith("-") ? "· " + title : title;
  if (body.startsWith("-")) body = "· " + body;
  const channels: string[] = [];

  const herdrBin = process.env.HERDR_BIN_PATH || "herdr";

  if (!opts.dryRun) {
    let cooldownPersisted = true;
    try {
      const res = await runner([herdrBin, "notification", "show", safeTitle, "--body", body, "--sound", "request"]);
      if (!res.ok) {
        return { sent: false, skippedReason: "notification failed", channels: [] };
      }
      try {
        writeStateFile(stateFile, now);
      } catch (e) {
        cooldownPersisted = false;
      }
    } finally {
      if (cooldownPersisted) releaseClaim(claimFile, claimToken);
    }
    channels.push("herdr");

    const hook = resolveNotifyHook();
    if (hook && !(isTestGuardActive() && !hookAllowedUnderGuard(hook))) {
      const ran = await runHook(
        hook,
        [safeTitle, body, opts.pane!, opts.reason!],
        hooks.hookTimeoutMs ?? HOOK_TIMEOUT_MS,
        hooks.hookKillGraceMs ?? HOOK_KILL_GRACE_MS,
      );
      if (ran) channels.push("hook");
    }
  } else {
    channels.push("herdr");
    if (resolveNotifyHook()) {
      channels.push("hook");
    }
  }

  let escalationResult: "applied" | "ineffective" | undefined;
  if (process.env.HERDR_JEV_ESCALATE_BLOCKED === "1") {
    if (
      opts.jevState === "blocked" &&
      (opts.reasonConfidence !== undefined && opts.reasonConfidence >= 0.85) &&
      (opts.nativeStatus === "idle" || opts.nativeStatus === "done" || opts.nativeStatus === "unknown") &&
      opts.agent && opts.agent !== "unknown"
    ) {
      if (!opts.dryRun) {
        const escalationsFile = join(notifyDir, "escalations.json");
        const record: EscalationRecord = { pane: opts.pane!, agent: opts.agent, time: now, attempts: 0 };
        if (opts.owner) record.owner = opts.owner;
        let displaced: EscalationRecord[] = [];
        let recorded = false;
        try {
          await updateEscalations(escalationsFile, (records) => {
            displaced = records.filter((e) => e.pane === opts.pane);
            return [...records.filter((e) => e.pane !== opts.pane), record];
          });
          recorded = true;
        } catch (e) {}
        if (!recorded) {
          escalationResult = "ineffective";
        } else {
          let verification: Verification | "report_failed" = "report_failed";
          try {
            const repRes = await runner([herdrBin, "pane", "report-agent", opts.pane!, "--source", "herdr-jev", "--agent", opts.agent, "--state", "blocked", "--message", reasonText]);
            if (repRes.ok) {
              verification = "unavailable";
              try {
                verification = verifyBlocked(await runner([herdrBin, "agent", "get", opts.pane!]));
              } catch (e) {}
            }
          } catch (e) {}
          if (verification === "blocked") {
            channels.push("escalation");
            escalationResult = "applied";
          } else {
            escalationResult = "ineffective";
            const key = recordKey(record);
            let dropRecord = verification === "report_failed";
            const restoreDisplaced = verification === "report_failed";
            if (verification === "not_blocked") {
              try {
                const relRes = await runner([herdrBin, "pane", "release-agent", opts.pane!, "--source", "herdr-jev", "--agent", opts.agent]);
                dropRecord = relRes.ok;
              } catch (e) {}
            }
            if (dropRecord) {
              try {
                await updateEscalations(escalationsFile, (records) => {
                  const kept = records.filter((e) => recordKey(e) !== key);
                  const restore = restoreDisplaced && !kept.some((e) => e.pane === opts.pane) ? displaced : [];
                  return [...kept, ...restore];
                });
              } catch (e) {}
            }
          }
        }
      } else {
        channels.push("escalation (unverified)");
      }
    }
  }

  if (opts.dryRun) {
    return { sent: false, dryRun: true, wouldSend: channels, channels: [] };
  }
  const result: {
    sent: boolean;
    skippedReason?: string;
    channels: string[];
    dryRun?: boolean;
    wouldSend?: string[];
    escalation?: "applied" | "ineffective";
  } = { sent: true, channels };
  if (escalationResult) {
    result.escalation = escalationResult;
  }
  return result;
}

async function handleRelease(pane: string, runner: RunCommand): Promise<{ sent: boolean; skippedReason?: string; channels: string[] }> {
  const notifyDir = join(resolveStateDir(), "notify");
  const escalationsFile = join(notifyDir, "escalations.json");
  if (!existsSync(escalationsFile)) {
    return { sent: false, skippedReason: "no escalation", channels: [] };
  }

  const record = readEscalations(escalationsFile).find((e) => e.pane === pane);
  if (!record) {
    return { sent: false, skippedReason: "no escalation", channels: [] };
  }
  const key = recordKey(record);

  const herdrBin = process.env.HERDR_BIN_PATH || "herdr";
  const paneRes = await runner([herdrBin, "pane", "get", pane]);
  if (!paneRes.ok && isPaneGone(paneRes)) {
    if (!(await tryUpdateEscalations(escalationsFile, (records) => records.filter((e) => recordKey(e) !== key)))) {
      return { sent: false, skippedReason: "escalation update failed", channels: [] };
    }
    return { sent: true, channels: ["release"] };
  }

  const res = paneRes.ok
    ? await runner([herdrBin, "pane", "release-agent", pane, "--source", "herdr-jev", "--agent", record.agent])
    : paneRes;
  if (!res.ok) {
    if (!isTransientFailure(res, record, Date.now())) {
      await tryUpdateEscalations(escalationsFile, (records) => bumpAttempts(records, new Set([key])));
    }
    return { sent: false, skippedReason: "release failed", channels: [] };
  }

  await tryUpdateEscalations(escalationsFile, (records) => records.filter((e) => recordKey(e) !== key));
  return { sent: true, channels: ["release"] };
}

async function releaseRecords(
  records: EscalationRecord[],
  escalationsFile: string,
  runner: RunCommand,
  shouldRelease: (record: EscalationRecord) => boolean,
  now: number,
): Promise<number> {
  const herdrBin = process.env.HERDR_BIN_PATH || "herdr";
  const done = new Set<string>();
  const failed = new Set<string>();
  for (const record of records) {
    const paneRes = await runner([herdrBin, "pane", "get", record.pane]);
    if (!paneRes.ok && isPaneGone(paneRes)) {
      done.add(recordKey(record));
      continue;
    }
    if (!shouldRelease(record)) continue;
    const res = paneRes.ok
      ? await runner([herdrBin, "pane", "release-agent", record.pane, "--source", "herdr-jev", "--agent", record.agent])
      : paneRes;
    if (res.ok) {
      done.add(recordKey(record));
    } else if (!isTransientFailure(res, record, now)) {
      failed.add(recordKey(record));
    }
  }
  let exhausted = 0;
  await updateEscalations(escalationsFile, (current) => {
    exhausted = 0;
    return bumpAttempts(current.filter((e) => !done.has(recordKey(e))), failed, () => { exhausted++; });
  });
  return done.size + exhausted;
}

async function handleReleaseStale(runner: RunCommand, now: number): Promise<{ sent: boolean; channels: string[] }> {
  const notifyDir = join(resolveStateDir(), "notify");
  const escalationsFile = join(notifyDir, "escalations.json");
  if (!existsSync(escalationsFile)) return { sent: false, channels: [] };

  try {
    const released = await releaseRecords(
      readEscalations(escalationsFile),
      escalationsFile,
      runner,
      (record) => now - record.time > RELEASE_STALE_AGE_MS,
      now,
    );
    return { sent: released > 0, channels: ["release-stale"] };
  } catch (e) {
    return { sent: false, channels: [] };
  }
}

async function handleReleaseAll(runner: RunCommand, owner?: string): Promise<{ sent: boolean; channels: string[] }> {
  const notifyDir = join(resolveStateDir(), "notify");
  const escalationsFile = join(notifyDir, "escalations.json");
  if (!existsSync(escalationsFile)) return { sent: false, channels: [] };

  try {
    const eligible = readEscalations(escalationsFile).filter((record) =>
      owner !== undefined ? record.owner === owner : !ownerAlive(record.owner),
    );
    if (eligible.length === 0) return { sent: false, channels: [] };

    const released = await releaseRecords(eligible, escalationsFile, runner, () => true, Date.now());
    return { sent: released > 0, channels: ["release-all"] };
  } catch (e) {
    return { sent: false, channels: [] };
  }
}
