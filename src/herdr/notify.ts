import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { RunCommand } from "./client.js";

export interface NotifyOptions {
  pane?: string;
  name?: string;
  project?: string;
  attention?: string;
  reason?: string;
  confidence?: number;
  nativeStatus?: string;
  agent?: string;
  release?: boolean;
  releaseStale?: boolean;
  dryRun?: boolean;
  now?: number; // for testing
}

function getStateDir() {
  return process.env.HERDR_JEV_STATE_DIR || join(process.env.HOME || "", ".local/state/herdr-jev");
}

function sanitizePaneId(pane: string) {
  return pane.replace(/[^a-zA-Z0-9_-]/g, "");
}

function getReasonText(reason: string) {
  switch (reason) {
    case "approval": return "aguardando aprovação";
    case "question": return "aguardando resposta";
    case "error": return "parado com erro";
    default: return "precisa de atenção";
  }
}

export async function handleNotifyCommand(opts: NotifyOptions, runner: RunCommand): Promise<{ sent: boolean; skippedReason?: string; channels: string[] }> {
  if (opts.releaseStale) {
    return handleReleaseStale(runner, opts.now || Date.now());
  }
  
  if (opts.release) {
    if (!opts.pane) return { sent: false, skippedReason: "no pane specified for release", channels: [] };
    return handleRelease(opts.pane, opts.agent || "unknown", runner);
  }

  const enabled = process.env.HERDR_JEV_NOTIFY;
  if (enabled === "0" || enabled === "false" || enabled === "off") {
    return { sent: false, skippedReason: "disabled by env", channels: [] };
  }

  if (opts.attention !== "now") {
    return { sent: false, skippedReason: "attention not now", channels: [] };
  }

  if (!opts.pane || !opts.name || !opts.project || !opts.reason) {
    return { sent: false, skippedReason: "missing required arguments", channels: [] };
  }

  const stateDir = getStateDir();
  const notifyDir = join(stateDir, "notify");
  if (!opts.dryRun) {
    mkdirSync(notifyDir, { recursive: true });
  }

  const sanitizedPane = sanitizePaneId(opts.pane);
  const stateFile = join(notifyDir, `${sanitizedPane}.json`);
  const now = opts.now || Date.now();
  const cooldownS = parseInt(process.env.HERDR_JEV_NOTIFY_COOLDOWN_S || "600", 10);

  if (!opts.dryRun && existsSync(stateFile)) {
    try {
      const data = JSON.parse(readFileSync(stateFile, "utf-8"));
      if (now - data.time < cooldownS * 1000) {
        return { sent: false, skippedReason: "cooldown", channels: [] };
      }
    } catch (e) {}
  }

  const reasonText = getReasonText(opts.reason);
  const title = `${opts.name} precisa de você`;
  const body = `${opts.project}: ${reasonText}`;
  const channels: string[] = [];

  const herdrBin = process.env.HERDR_BIN_PATH || "herdr";

  if (!opts.dryRun) {
    // Channel 1: herdr notification
    await runner([herdrBin, "notification", "show", title, "--body", body, "--sound", "request"]);
    channels.push("herdr");

    // Channel 2: hook
    const hook = process.env.HERDR_JEV_NOTIFY_HOOK;
    if (hook && existsSync(hook)) {
      const child = spawn(hook, [title, body, opts.pane, opts.reason], { stdio: "ignore", detached: true });
      const timer = setTimeout(() => {
        try { child.kill(); } catch (e) {}
      }, 5000);
      timer.unref?.();
      child.on("close", () => clearTimeout(timer));
      child.unref();
      channels.push("hook");
    }

    // Persist cooldown
    writeFileSync(stateFile, JSON.stringify({ time: now }));
  }

  // Escalation
  if (process.env.HERDR_JEV_ESCALATE_BLOCKED === "1") {
    if (
      (opts.reason === "approval" || opts.reason === "question" || opts.reason === "error") &&
      (opts.confidence !== undefined && opts.confidence >= 0.85) &&
      (opts.nativeStatus === "idle" || opts.nativeStatus === "done" || opts.nativeStatus === "unknown")
    ) {
      if (!opts.dryRun) {
        await runner([herdrBin, "pane", "report-agent", "--source", "herdr-jev", "--agent", opts.agent || "unknown", "--state", "blocked", "--message", reasonText, opts.pane]);
        const escalationsFile = join(notifyDir, "escalations.json");
        let escalations: any[] = [];
        if (existsSync(escalationsFile)) {
          try { escalations = JSON.parse(readFileSync(escalationsFile, "utf-8")); } catch (e) {}
        }
        // Remove old entries for same pane
        escalations = escalations.filter((e: any) => e.pane !== opts.pane);
        escalations.push({ pane: opts.pane, agent: opts.agent || "unknown", time: now });
        writeFileSync(escalationsFile, JSON.stringify(escalations));
      }
      channels.push("escalation");
    }
  }

  return { sent: true, channels };
}

async function handleRelease(pane: string, agent: string, runner: RunCommand): Promise<{ sent: boolean; channels: string[] }> {
  const herdrBin = process.env.HERDR_BIN_PATH || "herdr";
  await runner([herdrBin, "pane", "release-agent", "--source", "herdr-jev", "--agent", agent, pane]);
  
  const notifyDir = join(getStateDir(), "notify");
  const escalationsFile = join(notifyDir, "escalations.json");
  if (existsSync(escalationsFile)) {
    try {
      let escalations = JSON.parse(readFileSync(escalationsFile, "utf-8"));
      escalations = escalations.filter((e: any) => e.pane !== pane);
      writeFileSync(escalationsFile, JSON.stringify(escalations));
    } catch (e) {}
  }
  return { sent: true, channels: ["release"] };
}

async function handleReleaseStale(runner: RunCommand, now: number): Promise<{ sent: boolean; channels: string[] }> {
  const herdrBin = process.env.HERDR_BIN_PATH || "herdr";
  const notifyDir = join(getStateDir(), "notify");
  const escalationsFile = join(notifyDir, "escalations.json");
  if (!existsSync(escalationsFile)) return { sent: false, channels: [] };

  try {
    const escalations = JSON.parse(readFileSync(escalationsFile, "utf-8"));
    const active = [];
    let released = 0;
    for (const esc of escalations) {
      const age = now - esc.time;
      let shouldRelease = age > 15 * 60 * 1000;
      
      if (!shouldRelease) {
        const res = await runner([herdrBin, "pane", "layout", esc.pane]);
        if (!res.ok) {
          shouldRelease = true;
        }
      }

      if (shouldRelease) {
        await runner([herdrBin, "pane", "release-agent", "--source", "herdr-jev", "--agent", esc.agent, esc.pane]);
        released++;
      } else {
        active.push(esc);
      }
    }
    writeFileSync(escalationsFile, JSON.stringify(active));
    return { sent: released > 0, channels: ["release-stale"] };
  } catch (e) {
    return { sent: false, channels: [] };
  }
}
