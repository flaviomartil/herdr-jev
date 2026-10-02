import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, accessSync, constants, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { spawn } from "node:child_process";
import { readHerdrObservedState, type RunCommand } from "./client.js";
import { redactSecrets } from "./pane-text.js";
import { resolveStateDir } from "./state-dir.js";

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
}

interface EscalationRecord {
  pane: string;
  agent: string;
  time: number;
  attempts?: number;
  owner?: string;
}

const PANE_PATTERN = /^[A-Za-z0-9_]+:[A-Za-z0-9_]+$/;
const AGENT_PATTERN = /^[A-Za-z0-9._-]{1,40}$/;
const OWNER_PATTERN = /^[0-9]+-[A-Za-z0-9]{1,48}$/;
const CLAIM_STALE_MS = 30_000;
const LOCK_STALE_MS = 2_000;
const LOCK_WAIT_MS = 3_000;
const RELEASE_STALE_AGE_MS = 15 * 60 * 1000;
const MAX_RELEASE_ATTEMPTS = 3;

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

function readEscalations(file: string): EscalationRecord[] {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    if (!Array.isArray(parsed)) return [];
    const records: EscalationRecord[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      if (typeof entry.pane !== "string" || !PANE_PATTERN.test(entry.pane)) continue;
      if (typeof entry.agent !== "string" || !AGENT_PATTERN.test(entry.agent)) continue;
      const record: EscalationRecord = { ...entry };
      if (typeof record.owner !== "string" || !OWNER_PATTERN.test(record.owner)) delete record.owner;
      records.push(record);
    }
    return records;
  } catch (e) {}
  return [];
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

async function updateEscalations(file: string, mutate: (records: EscalationRecord[]) => EscalationRecord[]): Promise<void> {
  mkdirSync(dirname(file), { recursive: true });
  const lockFile = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      writeFileSync(lockFile, String(process.pid), { flag: "wx" });
      break;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      let stale = Date.now() > deadline;
      try {
        stale = stale || Date.now() - statSync(lockFile).mtimeMs > LOCK_STALE_MS;
      } catch (err) {
        continue;
      }
      if (stale) {
        try { unlinkSync(lockFile); } catch (err) {}
        continue;
      }
      await sleep(15);
    }
  }
  try {
    writeEscalations(file, mutate(readEscalations(file)));
  } finally {
    try { unlinkSync(lockFile); } catch (e) {}
  }
}

function recordKey(record: EscalationRecord): string {
  return `${record.pane}|${record.owner ?? ""}|${record.time}`;
}

function bumpAttempts(records: EscalationRecord[], failed: ReadonlySet<string>): EscalationRecord[] {
  const next: EscalationRecord[] = [];
  for (const record of records) {
    if (!failed.has(recordKey(record))) {
      next.push(record);
      continue;
    }
    const attempts = (record.attempts || 0) + 1;
    if (attempts < MAX_RELEASE_ATTEMPTS) next.push({ ...record, attempts });
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

function sanitizePaneId(pane: string) {
  return pane.replace(":", "-");
}

function cooldownActive(stateFile: string, now: number, cooldownS: number): boolean {
  if (!existsSync(stateFile)) return false;
  try {
    const data = JSON.parse(readFileSync(stateFile, "utf-8"));
    return typeof data?.time === "number" && now - data.time < cooldownS * 1000;
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
        writeFileSync(claimFile, JSON.stringify({ time: now }), { flag: "wx" });
        claimed = true;
      } catch (e: any) {
        if (e?.code !== "EEXIST") return { sent: false, skippedReason: "cooldown", channels: [] };
        let age: number;
        try {
          age = now - claimTime(claimFile);
        } catch (err) {
          continue;
        }
        if (age <= CLAIM_STALE_MS) return { sent: false, skippedReason: "cooldown", channels: [] };
        try { unlinkSync(claimFile); } catch (err) {}
      }
    }
    if (!claimed) return { sent: false, skippedReason: "cooldown", channels: [] };
    if (cooldownActive(stateFile, now, cooldownS)) {
      try { unlinkSync(claimFile); } catch (e) {}
      return { sent: false, skippedReason: "cooldown", channels: [] };
    }
  }

  const reasonText = getReasonText(opts.reason);
  let title = `${opts.agent || 'agent'} em ${opts.project} precisa de você`;
  title = title.replace(/[\x00-\x1F\x7F-\x9F]/g, "");
  title = redactSecrets(title);
  let safeTask = opts.task;
  if (safeTask) {
    safeTask = safeTask.replace(/[\x00-\x1F\x7F-\x9F]/g, "");
    safeTask = redactSecrets(safeTask);
  }
  let body = safeTask ? `${safeTask.slice(0, 80)}: ${reasonText}` : reasonText;
  let safeTitle = title.startsWith("-") ? "· " + title : title;
  if (body.startsWith("-")) body = "· " + body;
  const channels: string[] = [];

  const herdrBin = process.env.HERDR_BIN_PATH || "herdr";

  if (!opts.dryRun) {
    try {
      const res = await runner([herdrBin, "notification", "show", safeTitle, "--body", body, "--sound", "request"]);
      if (!res.ok) {
        return { sent: false, skippedReason: "notification failed", channels: [] };
      }
      renameSync(claimFile, stateFile);
    } finally {
      try { if (existsSync(claimFile)) unlinkSync(claimFile); } catch (e) {}
    }
    channels.push("herdr");

    const hook = resolveNotifyHook();
    if (hook) {
      if (process.env.HERDR_JEV_TEST_GUARD === '1' && !hook.startsWith(tmpdir())) {
        channels.push("hook");
      } else {
        await new Promise<void>((resolve) => {
          const child = spawn(hook, [safeTitle, body, opts.pane!, opts.reason!], { stdio: "ignore" });
        let done = false;
        const complete = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          try { child.kill(); } catch (e) {}
          complete();
        }, 5000);
        child.on("error", complete);
        child.on("close", complete);
        });
        channels.push("hook");
      }
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
        const repRes = await runner([herdrBin, "pane", "report-agent", opts.pane!, "--source", "herdr-jev", "--agent", opts.agent, "--state", "blocked", "--message", reasonText]);
        if (repRes.ok) {
          const getRes = await runner([herdrBin, "agent", "get", opts.pane!]);
          let isBlocked = false;
          if (getRes.ok) {
            try {
              const data = JSON.parse(getRes.stdout);
              const status = data.result?.agent?.agent_status ?? data.agent?.agent_status ?? data.agent_status ?? data.result?.status ?? data.status;
              if (status === "blocked") isBlocked = true;
            } catch {}
            if (!isBlocked && readHerdrObservedState(getRes) === "blocked") {
              isBlocked = true;
            }
          }
          if (isBlocked) {
            const escalationsFile = join(notifyDir, "escalations.json");
            const record: EscalationRecord = { pane: opts.pane!, agent: opts.agent!, time: now, attempts: 0 };
            if (opts.owner) record.owner = opts.owner;
            await updateEscalations(escalationsFile, (records) => [...records.filter((e) => e.pane !== opts.pane), record]);
            channels.push("escalation");
            escalationResult = "applied";
          } else {
            escalationResult = "ineffective";
          }
        } else {
          escalationResult = "ineffective";
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

  const herdrBin = process.env.HERDR_BIN_PATH || "herdr";
  const paneRes = await runner([herdrBin, "pane", "get", pane]);
  if (!paneRes.ok) {
    await updateEscalations(escalationsFile, (records) => records.filter((e) => e.pane !== pane));
    return { sent: true, channels: ["release"] };
  }

  const res = await runner([herdrBin, "pane", "release-agent", pane, "--source", "herdr-jev", "--agent", record.agent]);
  if (!res.ok) {
    const key = recordKey(record);
    await updateEscalations(escalationsFile, (records) => bumpAttempts(records, new Set([key])));
    return { sent: false, skippedReason: "release failed", channels: [] };
  }

  await updateEscalations(escalationsFile, (records) => records.filter((e) => e.pane !== pane));
  return { sent: true, channels: ["release"] };
}

async function releaseRecords(
  records: EscalationRecord[],
  escalationsFile: string,
  runner: RunCommand,
  shouldRelease: (record: EscalationRecord) => boolean,
): Promise<number> {
  const herdrBin = process.env.HERDR_BIN_PATH || "herdr";
  const done = new Set<string>();
  const failed = new Set<string>();
  let exhausted = 0;
  for (const record of records) {
    const paneRes = await runner([herdrBin, "pane", "get", record.pane]);
    if (!paneRes.ok) {
      done.add(recordKey(record));
      continue;
    }
    if (!shouldRelease(record)) continue;
    const res = await runner([herdrBin, "pane", "release-agent", record.pane, "--source", "herdr-jev", "--agent", record.agent]);
    if (res.ok) {
      done.add(recordKey(record));
    } else {
      failed.add(recordKey(record));
      if ((record.attempts || 0) + 1 >= MAX_RELEASE_ATTEMPTS) exhausted++;
    }
  }
  await updateEscalations(escalationsFile, (current) =>
    bumpAttempts(current.filter((e) => !done.has(recordKey(e))), failed),
  );
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

    const released = await releaseRecords(eligible, escalationsFile, runner, () => true);
    return { sent: released > 0, channels: ["release-all"] };
  } catch (e) {
    return { sent: false, channels: [] };
  }
}
