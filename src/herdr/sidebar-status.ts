import { createProcessCommandAdapter, type RunCommand } from "./client.js";
import { ANSI_PATTERN } from "./pane-text.js";
import { HerdrSocketClient, isAllowedTestSocketPath, resolveHerdrSocketPath } from "./socket.js";
import { isTestGuardActive } from "./state-dir.js";

export const MAX_SIDEBAR_BADGE_CHARS = 20;
export const DEFAULT_DONE_HOLD_TTL_MS = 120_000;
export const DEFAULT_BLOCKED_HOLD_TTL_MS = 300_000;

export interface HerdrSidebarCapabilities {
  displayAgentFlag: boolean;
  agentViewSetRpc: boolean;
  protocol?: number;
  schemaVersion?: number;
}

export interface DetectSidebarCapabilitiesOptions {
  socketPath?: string | null;
  env?: NodeJS.ProcessEnv;
  client?: Pick<HerdrSocketClient, "apiSchema" | "socketPath">;
  run?: RunCommand;
  forceRefresh?: boolean;
}

export type StickyBadgeKind = "none" | "done_hold" | "blocked_hold";

export interface StickyBadgeState {
  kind: StickyBadgeKind;
  reason: string | null;
  sinceMs: number;
  expiresAtMs: number | null;
  heldStatus: "done" | "blocked" | null;
}

export interface ComputeStickyBadgeInput {
  agent: {
    agent_status?: string | null;
    screen_detection_skipped?: boolean;
  };
  previous?: StickyBadgeState | null;
  reason?: string | null;
  now?: number;
  doneHoldTtlMs?: number;
  blockedHoldTtlMs?: number;
}

export interface SidebarBadgeInput {
  state?: string | null;
  agent_status?: string | null;
  reason?: string | null;
  attentionReason?: string | null;
  percent?: number | null;
  quietMinutes?: number | null;
  stalledMinutes?: number | null;
  stickyState?: StickyBadgeState | null;
  screenDetectionSkipped?: boolean;
  screen_detection_skipped?: boolean;
}

export interface AgentRepoMetadata {
  project: string | null;
  branch: string | null;
  worktreePath: string | null;
  workspaceId: string | null;
}

const capabilityCache = new Map<string, HerdrSidebarCapabilities>();

/** Clear cached Herdr sidebar capabilities for one socket path or all entries. */
export function clearHerdrSidebarCapabilitiesCache(socketPath?: string): void {
  if (socketPath === undefined) capabilityCache.clear();
  else capabilityCache.delete(socketPath);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function unwrapSchemaRoot(raw: unknown): Record<string, any> | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, any>;
  if (obj.schemas && typeof obj.schemas === "object") return obj;
  if (obj.result && typeof obj.result === "object") return unwrapSchemaRoot(obj.result);
  if (obj.schema && typeof obj.schema === "object") return unwrapSchemaRoot(obj.schema);
  return obj;
}

/** Parse Herdr API schema JSON to detect `--display-agent` and `agent.view.set` support. */
export function parseHerdrSidebarCapabilities(raw: unknown): HerdrSidebarCapabilities {
  const root = unwrapSchemaRoot(raw);
  if (!root) return { displayAgentFlag: false, agentViewSetRpc: false };

  const schemas = (root.schemas ?? {}) as Record<string, any>;
  const reqOneOf = Array.isArray(schemas.request?.oneOf) ? schemas.request.oneOf : [];
  const reqDefs = (schemas.request?.$defs ?? {}) as Record<string, any>;
  const respDefs = (schemas.success_response?.$defs ?? {}) as Record<string, any>;

  const agentViewSetRpc =
    reqOneOf.some((entry: any) => entry?.properties?.method?.const === "agent.view.set") ||
    Boolean(reqDefs.AgentViewSetParams);

  const displayAgentFlag =
    Boolean(reqDefs.PaneReportMetadataParams?.properties?.display_agent) ||
    Boolean(respDefs.AgentInfo?.properties?.display_agent);

  const protocol = typeof root.protocol === "number" ? root.protocol : undefined;
  const schemaVersion = typeof root.schema_version === "number" ? root.schema_version : undefined;

  return {
    displayAgentFlag,
    agentViewSetRpc,
    ...(protocol !== undefined ? { protocol } : {}),
    ...(schemaVersion !== undefined ? { schemaVersion } : {}),
  };
}

/**
 * Detect and cache Herdr sidebar capabilities (`--display-agent` and `agent.view.set`)
 * via `HerdrSocketClient.apiSchema()` or `herdr api schema --json`.
 */
export async function detectHerdrSidebarCapabilities(
  options: DetectSidebarCapabilitiesOptions = {},
): Promise<HerdrSidebarCapabilities> {
  const env = options.env ?? process.env;
  const testGuard = isTestGuardActive(env);
  const explicitClient = options.client !== undefined;
  const explicitSocketProvided = options.socketPath !== undefined && options.socketPath !== null;

  if (explicitSocketProvided && testGuard && !isAllowedTestSocketPath(options.socketPath!)) {
    return { displayAgentFlag: false, agentViewSetRpc: false };
  }

  const resolvedSocket = explicitClient
    ? options.client!.socketPath
    : options.socketPath !== undefined
      ? options.socketPath
      : resolveHerdrSocketPath(env);

  if (testGuard && !explicitClient && !explicitSocketProvided && !options.run && resolvedSocket === null) {
    return { displayAgentFlag: false, agentViewSetRpc: false };
  }

  const cacheKey = resolvedSocket ?? "__cli__";

  if (!options.forceRefresh) {
    const cached = capabilityCache.get(cacheKey);
    if (cached) return { ...cached };
  }

  let caps: HerdrSidebarCapabilities | null = null;

  if (options.client) {
    try {
      const schema = await options.client.apiSchema();
      caps = parseHerdrSidebarCapabilities(schema);
    } catch {
      caps = null;
    }
  } else if (resolvedSocket) {
    const client = new HerdrSocketClient({ socketPath: resolvedSocket, env });
    try {
      const schema = await client.apiSchema();
      caps = parseHerdrSidebarCapabilities(schema);
    } catch {
      caps = null;
    } finally {
      client.close();
    }
  } else if (options.run || !testGuard) {
    const run = options.run ?? createProcessCommandAdapter({ env });
    const herdr = env.HERDR_BIN_PATH || process.env.HERDR_BIN_PATH || "herdr";
    try {
      const res = await run([herdr, "api", "schema", "--json"]);
      if (res.ok && res.stdout.trim()) {
        caps = parseHerdrSidebarCapabilities(JSON.parse(res.stdout));
      }
    } catch {
      caps = null;
    }
  }

  if (!caps) {
    return { displayAgentFlag: false, agentViewSetRpc: false };
  }
  capabilityCache.set(cacheKey, caps);
  return { ...caps };
}

/** Sanitize a display-agent label by stripping ANSI/control sequences and normalizing whitespace. */
export function sanitizeDisplayAgentLabel(label: string): string {
  return label
    .replace(ANSI_PATTERN, "")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Emit `["--display-agent", label]` ONLY when `displayAgentFlag` is enabled and
 * the sanitized label fits strictly within 20 characters.
 */
export function buildDisplayAgentArgs(
  label: string,
  enabled: boolean | Pick<HerdrSidebarCapabilities, "displayAgentFlag">,
): string[] {
  const isEnabled = typeof enabled === "boolean" ? enabled : Boolean(enabled?.displayAgentFlag);
  if (!isEnabled) return [];
  const sanitized = sanitizeDisplayAgentLabel(label);
  if (!sanitized || sanitized.length > MAX_SIDEBAR_BADGE_CHARS) return [];
  return ["--display-agent", sanitized];
}

function capBadge(token: string): string {
  const clean = sanitizeDisplayAgentLabel(token);
  if (clean.length <= MAX_SIDEBAR_BADGE_CHARS) return clean;
  return clean.slice(0, MAX_SIDEBAR_BADGE_CHARS).trimEnd();
}

/**
 * Format a telegraphic sidebar badge capped strictly at 20 characters.
 * Canonical tokens: `"!! approval"`, `"!! question"`, `"blocked"`,
 * `"quiet <N>m"`, `"stalled <N>m"`, `"review"`, `"working"`, `"done"`, `"idle"`.
 */
export function formatSidebarBadge(input: SidebarBadgeInput): string {
  const sticky = input.stickyState;
  const rawState = (input.state ?? input.agent_status ?? "unknown")?.toLowerCase() ?? "unknown";
  const reason = (input.reason ?? input.attentionReason ?? sticky?.reason ?? null)?.toLowerCase() ?? null;

  if (reason === "approval") return "!! approval";
  if (reason === "question") return "!! question";
  if (rawState === "blocked" || reason === "error" || sticky?.kind === "blocked_hold") {
    return "blocked";
  }

  if (typeof input.stalledMinutes === "number" && Number.isFinite(input.stalledMinutes) && input.stalledMinutes > 0) {
    return capBadge(`stalled ${Math.floor(input.stalledMinutes)}m`);
  }
  if (typeof input.quietMinutes === "number" && Number.isFinite(input.quietMinutes) && input.quietMinutes > 0) {
    return capBadge(`quiet ${Math.floor(input.quietMinutes)}m`);
  }

  if (reason === "review" || (input.percent === 100 && rawState !== "working")) {
    return "review";
  }

  if (rawState === "done" || sticky?.kind === "done_hold") {
    return "done";
  }
  if (rawState === "working") {
    return "working";
  }
  return "idle";
}

/**
 * Sticky attention state machine supporting `"done_hold"` and `"blocked_hold"` TTL windows.
 * Never resets a held state back to `"idle"` (`"none"`) while `agent.screen_detection_skipped === true`.
 */
export function computeStickyBadgeState(input: ComputeStickyBadgeInput): StickyBadgeState {
  const now = input.now ?? Date.now();
  const doneHoldTtlMs = Math.max(0, input.doneHoldTtlMs ?? DEFAULT_DONE_HOLD_TTL_MS);
  const blockedHoldTtlMs = Math.max(0, input.blockedHoldTtlMs ?? DEFAULT_BLOCKED_HOLD_TTL_MS);
  const status = (input.agent?.agent_status ?? "unknown")?.toLowerCase() ?? "unknown";
  const skipped = input.agent?.screen_detection_skipped === true;
  const previous = input.previous ?? null;
  const reason = nonEmptyString(input.reason)?.toLowerCase() ?? null;

  const isBlockingReason = reason === "approval" || reason === "question" || reason === "error";
  if (status === "blocked" || isBlockingReason) {
    const heldReason = reason ?? (previous?.kind === "blocked_hold" ? previous.reason : null) ?? "blocked";
    return {
      kind: "blocked_hold",
      reason: heldReason,
      sinceMs: previous?.kind === "blocked_hold" ? previous.sinceMs : now,
      expiresAtMs: now + blockedHoldTtlMs,
      heldStatus: "blocked",
    };
  }

  if (status === "done" || (reason === "review" && status !== "working" && (!previous || previous.kind === "none"))) {
    const heldReason = reason ?? (previous?.kind === "done_hold" ? previous.reason : null);
    return {
      kind: "done_hold",
      reason: heldReason,
      sinceMs: previous?.kind === "done_hold" ? previous.sinceMs : now,
      expiresAtMs: now + doneHoldTtlMs,
      heldStatus: "done",
    };
  }

  if (status === "working") {
    return {
      kind: "none",
      reason: null,
      sinceMs: now,
      expiresAtMs: null,
      heldStatus: null,
    };
  }

  // Status is "idle" or "unknown": hold if screen detection was skipped or within TTL.
  if (previous && previous.kind !== "none") {
    if (skipped || previous.expiresAtMs === null || now < previous.expiresAtMs) {
      return { ...previous };
    }
  }

  return {
    kind: "none",
    reason: null,
    sinceMs: now,
    expiresAtMs: null,
    heldStatus: null,
  };
}

function findMatchingWorktree(
  snapshot: any,
  workspace: any,
  workspaceId: string | null,
  cwd: string | null,
): any | undefined {
  const worktrees = Array.isArray(snapshot?.worktrees) ? snapshot.worktrees : [];
  if (worktrees.length === 0) return undefined;

  if (workspaceId) {
    const byWs = worktrees.find((wt: any) => wt?.open_workspace_id === workspaceId);
    if (byWs) return byWs;
  }

  const checkoutPath = nonEmptyString(workspace?.worktree?.checkout_path) ?? nonEmptyString(workspace?.worktree?.path);
  if (checkoutPath) {
    const byCheckout = worktrees.find((wt: any) => wt?.path === checkoutPath);
    if (byCheckout) return byCheckout;
  }

  if (cwd) {
    const exact = worktrees.find((wt: any) => wt?.path === cwd);
    if (exact) return exact;
    const prefixMatches = worktrees
      .filter((wt: any) => typeof wt?.path === "string" && wt.path.length > 0 && cwd.startsWith(`${wt.path}/`))
      .sort((a: any, b: any) => b.path.length - a.path.length);
    if (prefixMatches[0]) return prefixMatches[0];
  }

  return undefined;
}

/**
 * Extract `{ project, branch, worktreePath, workspaceId }` directly from a Herdr snapshot
 * (`snapshot.workspaces`, `snapshot.worktrees`, and `agent` fields) without spawning `git`.
 */
export function resolveAgentRepoMetadata(agent: any, snapshot?: any): AgentRepoMetadata {
  const workspaceId = nonEmptyString(agent?.workspace_id);
  const workspaces = Array.isArray(snapshot?.workspaces) ? snapshot.workspaces : [];
  const workspace = workspaceId
    ? workspaces.find((w: any) => w?.workspace_id === workspaceId)
    : undefined;
  const cwd = nonEmptyString(agent?.foreground_cwd) ?? nonEmptyString(agent?.cwd);
  const matchedWorktree = findMatchingWorktree(snapshot, workspace, workspaceId, cwd);

  const project =
    nonEmptyString(workspace?.label) ??
    nonEmptyString(workspace?.worktree?.repo_name) ??
    nonEmptyString(matchedWorktree?.label) ??
    nonEmptyString(agent?.project) ??
    workspaceId;

  const branch =
    nonEmptyString(agent?.worktree_branch) ??
    nonEmptyString(agent?.git_branch) ??
    nonEmptyString(agent?.branch) ??
    nonEmptyString(agent?.worktree?.branch) ??
    nonEmptyString(matchedWorktree?.branch) ??
    nonEmptyString(workspace?.worktree_branch) ??
    nonEmptyString(workspace?.git_branch) ??
    nonEmptyString(workspace?.branch) ??
    nonEmptyString(workspace?.worktree?.branch);

  const worktreePath =
    nonEmptyString(agent?.worktree_path) ??
    nonEmptyString(agent?.worktree?.checkout_path) ??
    nonEmptyString(agent?.worktree?.path) ??
    nonEmptyString(matchedWorktree?.path) ??
    nonEmptyString(workspace?.worktree?.checkout_path) ??
    nonEmptyString(workspace?.worktree?.path) ??
    nonEmptyString(workspace?.worktree?.repo_root);

  return {
    project,
    branch,
    worktreePath,
    workspaceId,
  };
}
