import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { RunCommand } from "./client.js";
import { redactSecrets } from "./pane-text.js";

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
  dryRun?: boolean;
  now?: number;
}

import { resolveStandupEnvironment } from "./standup.js";

function getStateDir() {
  return resolveStandupEnvironment().stateDir;
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

export async function handleNotifyCommand(opts: NotifyOptions, runner: RunCommand): Promise<{ sent: boolean; skippedReason?: string; channels: string[]; dryRun?: boolean; wouldSend?: string[] }> {
  if (opts.releaseAll) {
    return handleReleaseAll(runner);
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
    return { sent: false, skippedReason: "disabled by env", channels: [] };
  }

  if (opts.attention !== "now") {
    return { sent: false, skippedReason: "attention not now", channels: [] };
  }

  if (!opts.pane || !opts.project || !opts.reason) {
    return { sent: false, skippedReason: "missing required arguments", channels: [] };
  }

  const stateDir = getStateDir();
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
    if (existsSync(stateFile)) {
      try {
        const data = JSON.parse(readFileSync(stateFile, "utf-8"));
        if (now - data.time < cooldownS * 1000) {
          return { sent: false, skippedReason: "cooldown", channels: [] };
        }
        unlinkSync(stateFile);
      } catch (e) {}
    }
    try {
      writeFileSync(claimFile, JSON.stringify({ time: now }), { flag: "wx" });
    } catch (e) {
      return { sent: false, skippedReason: "cooldown", channels: [] };
    }
  }

  const reasonText = getReasonText(opts.reason);
  const title = `${opts.agent || 'agent'} em ${opts.project} precisa de você`;
  let safeTask = opts.task;
  if (safeTask) {
    safeTask = safeTask.replace(/[\x00-\x1F\x7F-\x9F]/g, "");
    safeTask = redactSecrets(safeTask);
  }
  const body = safeTask ? `${safeTask.slice(0, 80)}: ${reasonText}` : reasonText;
  const channels: string[] = [];

  const herdrBin = process.env.HERDR_BIN_PATH || "herdr";

  if (!opts.dryRun) {
    const res = await runner([herdrBin, "notification", "show", "--", title, "--body", body, "--sound", "request"]);
    if (!res.ok) {
      try { unlinkSync(claimFile); } catch (e) {}
      return { sent: false, skippedReason: "notification failed", channels: [] };
    }
    renameSync(claimFile, stateFile);
    channels.push("herdr");

    const hook = process.env.HERDR_JEV_NOTIFY_HOOK;
    if (hook) {
      if (process.env.HERDR_JEV_TEST_GUARD === '1' && !hook.startsWith(tmpdir())) {
        channels.push("hook");
      } else {
        await new Promise<void>((resolve) => {
          const child = spawn(hook, [title, body, opts.pane!, opts.reason!], { stdio: "ignore" });
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
    if (process.env.HERDR_JEV_NOTIFY_HOOK) {
      channels.push("hook");
    }
  }

  if (process.env.HERDR_JEV_ESCALATE_BLOCKED === "1") {
    if (
      opts.jevState === "blocked" &&
      (opts.reasonConfidence !== undefined && opts.reasonConfidence >= 0.85) &&
      (opts.nativeStatus === "idle" || opts.nativeStatus === "done" || opts.nativeStatus === "unknown") &&
      opts.agent && opts.agent !== "unknown"
    ) {
      if (!opts.dryRun) {
        const escalationsFile = join(notifyDir, "escalations.json");
        const tempFile = join(notifyDir, "escalations.json.tmp");
        let escalations: any[] = [];
        if (existsSync(escalationsFile)) {
          try { 
            const parsed = JSON.parse(readFileSync(escalationsFile, "utf-8")); 
            if (Array.isArray(parsed)) escalations = parsed;
          } catch (e) {}
        }
        escalations = escalations.filter((e: any) => e.pane !== opts.pane);
        escalations.push({ pane: opts.pane, agent: opts.agent, time: now });
        writeFileSync(tempFile, JSON.stringify(escalations));
        renameSync(tempFile, escalationsFile);

        const repRes = await runner([herdrBin, "pane", "report-agent", "--source", "herdr-jev", "--agent", opts.agent, "--state", "blocked", "--message", reasonText, "--", opts.pane!]);
        if (!repRes.ok) {
          escalations = escalations.filter((e: any) => e.pane !== opts.pane);
          writeFileSync(tempFile, JSON.stringify(escalations));
          renameSync(tempFile, escalationsFile);
        } else {
          channels.push("escalation");
        }
      } else {
        channels.push("escalation");
      }
    }
  }

  if (opts.dryRun) {
    return { sent: false, dryRun: true, wouldSend: channels, channels: [] };
  }
  return { sent: true, channels };
}

async function handleRelease(pane: string, runner: RunCommand): Promise<{ sent: boolean; skippedReason?: string; channels: string[] }> {
  const notifyDir = join(getStateDir(), "notify");
  const escalationsFile = join(notifyDir, "escalations.json");
  if (!existsSync(escalationsFile)) {
    return { sent: false, skippedReason: "no escalation", channels: [] };
  }

  let escalations: any[] = [];
  try {
    escalations = JSON.parse(readFileSync(escalationsFile, "utf-8"));
  } catch (e) {
    return { sent: false, skippedReason: "no escalation", channels: [] };
  }

  const record = escalations.find((e: any) => e.pane === pane);
  if (!record) {
    return { sent: false, skippedReason: "no escalation", channels: [] };
  }

  const herdrBin = process.env.HERDR_BIN_PATH || "herdr";
  const res = await runner([herdrBin, "pane", "release-agent", "--source", "herdr-jev", "--agent", record.agent, "--", pane]);
  if (!res.ok) {
    return { sent: false, skippedReason: "release failed", channels: [] };
  }
  
  escalations = escalations.filter((e: any) => e.pane !== pane);
  writeFileSync(escalationsFile, JSON.stringify(escalations));

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
        const res = await runner([herdrBin, "pane", "get", "--", esc.pane]);
        if (!res.ok) {
          shouldRelease = true;
        }
      }

      if (shouldRelease) {
        const res = await runner([herdrBin, "pane", "release-agent", "--source", "herdr-jev", "--agent", esc.agent, "--", esc.pane]);
        if (res.ok) {
          released++;
        } else {
          active.push(esc);
        }
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

async function handleReleaseAll(runner: RunCommand): Promise<{ sent: boolean; channels: string[] }> {
  const herdrBin = process.env.HERDR_BIN_PATH || "herdr";
  const notifyDir = join(getStateDir(), "notify");
  const escalationsFile = join(notifyDir, "escalations.json");
  if (!existsSync(escalationsFile)) return { sent: false, channels: [] };

  try {
    const escalations = JSON.parse(readFileSync(escalationsFile, "utf-8"));
    if (escalations.length === 0) return { sent: false, channels: [] };

    const active = [];
    for (const esc of escalations) {
      const res = await runner([herdrBin, "pane", "release-agent", "--source", "herdr-jev", "--agent", esc.agent, "--", esc.pane]);
      if (!res.ok) {
        active.push(esc);
      }
    }
    writeFileSync(escalationsFile, JSON.stringify(active));
    return { sent: active.length < escalations.length, channels: ["release-all"] };
  } catch (e) {
    return { sent: false, channels: [] };
  }
}
