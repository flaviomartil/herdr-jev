import { triageTaskWithJev } from "../triage/client.js";
import { resolveStageSpec } from "../pipelines/matrix.js";
import { resolveDelegatedClient, parseCrossHarnessConfig } from "../delegation/cross-harness.js";
import { resolveBaseClientKind, BASE_CLIENTS, loadClientAliases } from "../config/aliases.js";
import { classifyPaneBlock, createHerdrClient, readHerdrObservedState, type HerdrClient } from "./client.js";
import type { ClientKind, RoleKind, ReasoningEffort } from "../types/index.js";
import { reserveHerdrHandle } from "./reservation.js";
import { hasExhaustedUsageQuota } from "../harness/bridge.js";
import { readGridWorkers } from "./launcher.js";
import { resolveHerdrContext } from "./context.js";

export async function resolvePeerStage(input: { prompt: string; source: ClientKind; target?: ClientKind; role?: RoleKind; model?: string; effort?: string; crossHarness?: string }) {
  if (!input.prompt?.trim()) throw new Error("A nonempty peer prompt is required");
  const role = input.role ?? "researcher";
  if (!["researcher", "implementer", "reviewer", "advisor"].includes(role)) throw new Error("Invalid peer role");
  if (input.effort && !["standard", "high", "xhigh"].includes(input.effort)) throw new Error("Invalid effort: standard, high or xhigh required");
  const config = parseCrossHarnessConfig(input.crossHarness ?? process.env.HERDR_JEV_CROSS_HARNESS ?? "auto");
  const allowed = config.allowedPeers[input.source] ?? config.allowedPeers[resolveBaseClientKind(input.source)] ?? [input.source];
  if (input.target && input.target !== input.source &&
    (config.mode === "disabled" || (config.mode === "mapped" && !allowed.includes(input.target)))) {
    throw new Error(`Peer target ${input.target} is disallowed by cross-harness configuration for ${input.source}`);
  }
  const triage = await triageTaskWithJev(input.prompt);
  const client = input.target ?? resolveDelegatedClient(input.source, role, { triage,
    config }).client;
  if (!BASE_CLIENTS.includes(client as any) && !loadClientAliases()[client]) throw new Error(`Unknown peer harness: ${client}`);
  if (resolveBaseClientKind(client) === "codex" && hasExhaustedUsageQuota("codex")) throw new Error("Codex account quota is exhausted in a fresh usage observation; select another permitted peer");
  if (client === "kiro" && !input.model?.trim()) throw new Error("Kiro peer requires a verified model from kiro-cli chat --list-models --format json");
  const isDifferentClient = resolveBaseClientKind(client) !== resolveBaseClientKind(input.source);
  const stageEffort = input.effort ?? (isDifferentClient ? undefined : triage.effort);
  const stage = client === "kiro"
    ? { role, client, model: input.model!.trim(), effort: (input.effort ?? triage.effort) as ReasoningEffort, extraFlags: [] as string[], description: "Kiro peer with explicit model; native scalar effort unavailable" }
    : resolveStageSpec(client, role, stageEffort as ReasoningEffort | undefined);
  if (input.model) stage.model = input.model;
  stage.client = client;
  if (input.effort && !["codex", "claude", "antigravity"].includes(resolveBaseClientKind(client))) throw new Error(`Explicit effort is unsupported by ${client}`);
  return { client, stage, triage };
}

export interface BroadcastPeerMessageInput {
  text: string;
  wait?: boolean;
  timeoutMs?: number;
  lines?: number;
  exclude?: string | string[];
  callerPaneId?: string;
}

export interface PeerBroadcastResult {
  agent: string;
  paneId: string;
  acknowledged: boolean;
  state: string;
}

export async function broadcastPeerMessage(
  input: BroadcastPeerMessageInput,
  herdr: HerdrClient = createHerdrClient(),
): Promise<PeerBroadcastResult[]> {
  if (!input.text?.trim()) throw new Error("A nonempty message is required");
  const timeoutMs = input.timeoutMs ?? 900000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) throw new Error("Timeout must be from 1 to 3600000 ms");
  const lines = input.lines ?? 2000;
  if (!Number.isInteger(lines) || lines < 1 || lines > 100000) throw new Error("Line limit must be an integer from 1 to 100000");

  let callerPaneId = input.callerPaneId;
  if (!callerPaneId) {
    try {
      const context = await resolveHerdrContext({});
      callerPaneId = context.sourcePaneId;
    } catch {}
  }
  if (!callerPaneId) {
    callerPaneId = process.env.HERDR_PANE_ID ?? process.env.HERDR_JEV_SOURCE_PANE_ID;
  }
  if (!callerPaneId) throw new Error("Caller pane unavailable");

  let workers = readGridWorkers(callerPaneId);
  if (herdr.paneLayout) {
    const layoutResult = await herdr.paneLayout(callerPaneId);
    if (layoutResult.ok) {
      try {
        const parsed = JSON.parse(layoutResult.stdout);
        const layout = parsed.result?.layout ?? parsed.layout ?? parsed;
        const panes = Array.isArray(layout.panes) ? layout.panes : [];
        const liveIds = new Set(panes.map((p: any) => p.pane_id ?? p.id).filter(Boolean));
        workers = workers.filter((id) => liveIds.has(id));
      } catch {}
    }
  }
  workers = workers.filter((id) => id !== callerPaneId);

  const excluded = new Set<string>();
  if (input.exclude) {
    const rawList = typeof input.exclude === "string" ? input.exclude.split(",") : input.exclude;
    for (const item of rawList) {
      const trimmed = item.trim();
      if (trimmed) excluded.add(trimmed);
    }
  }

  const results: PeerBroadcastResult[] = [];
  const deadline = Date.now() + timeoutMs;

  for (const workerPaneId of workers) {
    let agentName = workerPaneId;
    let paneId = workerPaneId;
    const identity = await herdr.getAgent?.(workerPaneId);
    if (identity?.ok) {
      try {
        const data = JSON.parse(identity.stdout);
        const agentObj = data.result?.agent ?? data.agent;
        if (agentObj) {
          if (typeof agentObj.name === "string" && agentObj.name) agentName = agentObj.name;
          else if (typeof agentObj.tokens?.jev_handle === "string" && agentObj.tokens.jev_handle) agentName = agentObj.tokens.jev_handle;
          if (typeof agentObj.pane_id === "string" && agentObj.pane_id) paneId = agentObj.pane_id;
        }
      } catch {}
    }

    if (paneId === callerPaneId || agentName === callerPaneId) continue;
    if (excluded.has(agentName) || excluded.has(paneId) || excluded.has(workerPaneId)) continue;

    const remainingTimeout = deadline - Date.now();
    if (remainingTimeout <= 0) {
      results.push({ agent: agentName, paneId, acknowledged: false, state: "timeout" });
      continue;
    }

    let sendTarget = workerPaneId;
    if (agentName !== workerPaneId) {
      const check = await herdr.getAgent?.(agentName);
      if (check?.ok) sendTarget = agentName;
    }

    try {
      const resStr = await converseWithPeer(
        { target: sendTarget, text: input.text, wait: input.wait, timeoutMs: remainingTimeout, lines },
        herdr,
      );
      const parsed = JSON.parse(resStr);
      const state = parsed.state ?? (input.wait ? "done" : "working");
      results.push({ agent: agentName, paneId, acknowledged: true, state });
    } catch (error: any) {
      let state = "unknown";
      const message = error?.message ?? "";
      const match = message.match(/Peer (?:is|response is) ([a-zA-Z0-9_-]+)/);
      if (match) {
        state = match[1];
      } else if (/timeout/i.test(message)) {
        state = "timeout";
      } else if (/blocked|trust/i.test(message)) {
        state = "blocked";
      } else {
        try {
          const status = await herdr.getAgent?.(sendTarget);
          if (status?.ok) state = readHerdrObservedState(status) ?? "unknown";
        } catch {}
      }
      results.push({ agent: agentName, paneId, acknowledged: false, state });
    }
  }

  return results;
}

export async function converseWithPeer(
  input: {
    target?: string;
    all?: boolean;
    exclude?: string | string[];
    callerPaneId?: string;
    text?: string;
    wait?: boolean;
    timeoutMs?: number;
    lines?: number;
  },
  herdr: HerdrClient = createHerdrClient(),
) {
  if (input.all) {
    if (input.target) throw new Error("--all is mutually exclusive with target");
    const results = await broadcastPeerMessage(
      {
        text: input.text ?? "",
        callerPaneId: input.callerPaneId,
        exclude: input.exclude,
        wait: input.wait,
        timeoutMs: input.timeoutMs,
        lines: input.lines,
      },
      herdr,
    );
    return JSON.stringify(results);
  }
  const target = input.target;
  if (!target?.trim()) throw new Error("Peer agent handle is required");
  const timeoutMs = input.timeoutMs ?? 900000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) throw new Error("Timeout must be from 1 to 3600000 ms");
  const lines = input.lines ?? 2000;
  if (!Number.isInteger(lines) || lines < 1 || lines > 100000) throw new Error("Line limit must be an integer from 1 to 100000");
  const identity = await herdr.getAgent?.(target);
  if (!identity?.ok) throw new Error("Cannot resolve the existing peer");
  let pane: string | undefined;
  try { pane = JSON.parse(identity.stdout).result?.agent?.pane_id; } catch {}
  if (!pane) throw new Error("Peer pane identity unavailable");
  const snapshot = async (state: ReturnType<typeof readHerdrObservedState>) => {
    const screen = await herdr.readAgent!(target, lines, state === "idle" || state === "done" ? "recent" : "visible");
    if (!screen.ok) throw new Error(screen.stderr || screen.stdout);
    return JSON.stringify({ target, paneId: pane, state, observedStateOnly: true,
      output: screen.stdout, lineLimit: lines, source: "bounded terminal snapshot; increase lines to inspect a longer response" });
  };
  if (input.text === undefined) {
    let state = readHerdrObservedState(identity);
    if (input.wait) {
      const waited = await herdr.waitFor({ target, timeoutMs, waitForReply: true });
      if (!waited.ok) throw new Error(waited.stderr || waited.stdout);
      state = readHerdrObservedState(waited);
      if (state !== "idle" && state !== "done") throw new Error(`Peer response is ${state ?? "unknown"}; inspect the existing peer`);
    }
    return snapshot(state);
  }
  const release = await reserveHerdrHandle(`pane:${pane}`);
  try {
    if (!input.text.trim()) throw new Error("A nonempty message is required");
    const status = await herdr.getAgent?.(target);
    const state = status?.ok ? readHerdrObservedState(status) : null;
    if (state !== "idle" && state !== "done") throw new Error(`Peer is ${state ?? "unknown"}; read or wait before sending another turn`);
    const before = await herdr.readAgent?.(target);
    if (!before?.ok) throw new Error(before?.stderr || "Peer read unavailable");
    const block = classifyPaneBlock(before);
    if (block === "trust") throw new Error("Resolve repository trust in the peer pane before messaging");
    if (block === "selection") throw new Error("Resolve the selection menu in the peer pane before messaging");
    const sent = await herdr.prompt({ target, text: input.text, wait: true, waitForStart: !input.wait, waitForReply: input.wait, timeoutMs });
    if (!sent.ok) throw new Error(`Message acknowledgement uncertain; inspect the existing peer before retrying: ${sent.stderr || sent.stdout}`);
    if (!input.wait) return JSON.stringify({ target, paneId: pane, acknowledged: true, state: "working" });
    const completed = readHerdrObservedState(sent);
    if (completed !== "idle" && completed !== "done") throw new Error(`Peer response is ${completed ?? "unknown"}; inspect the existing peer`);
    return await snapshot(completed);
  } finally { await release(); }
}
