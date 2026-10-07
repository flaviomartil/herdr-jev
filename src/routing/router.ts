import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { Lru, hashKey } from "../cache/lru.js";
import {
  ResilientJevClient,
  getGlobalJevClient,
  type ResilientJevOptions,
  JevError,
} from "../triage/jev-client.js";
import {
  COMMAND_PREFIX,
  CONTINUATIONS,
  DEFAULT_MODELS,
  DEFAULT_TOOLS,
  type ModelTierCard,
  type SkillCard,
  type ToolDef,
} from "./catalog.js";
import { decideRoute, DEFAULT_POLICY_THRESHOLDS, type PolicyThresholds, type RouteTurnDecision } from "./policy.js";
import { buildRoutingQuestions, routingAnswersStatus } from "./questions.js";

export type RouteMode = "off" | "shadow" | "active";
export type RouteReason = "judged" | "shortcut" | "off" | "shadow" | "invalid_answer" | "abstained" | "deadline" | "aborted" | "api" | "network" | "missing_key";

export interface RouteSummary {
  tier: RouteTurnDecision["tier"];
  effort: RouteTurnDecision["effort"];
  toolCount: number;
  hasSkill: boolean;
}

export interface RouteObservation {
  id: string;
  specId: "turn.route";
  specVersion: 1;
  mode: RouteMode;
  source: RouterTelemetry["source"];
  reason: RouteReason;
  applied: RouteSummary;
  judged: RouteSummary | null;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

function summarizeRoute(decision: RouteTurnDecision): RouteSummary {
  return { tier: decision.tier, effort: decision.effort, toolCount: decision.tools.length, hasSkill: decision.skill !== null };
}

export interface TurnInput {
  message: string;
  recentContext?: string;
  unavailableTools?: string[];
}

export interface RouterTelemetry {
  totalMs: number;
  jevMs: number;
  source: "shortcut" | "cache" | "jev" | "fallback";
  model: string;
  requestId?: string;
  recorded?: boolean;
}

export interface FullRouteResult {
  decision: RouteTurnDecision;
  telemetry: RouterTelemetry;
  observation: RouteObservation;
}

export function normalizeDiacritics(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function isShortcut(input: TurnInput): boolean {
  const text = input.message.trim();
  if (text.length === 0) return true;
  if (COMMAND_PREFIX.test(text)) return true;
  const bare = normalizeDiacritics(text.toLowerCase().replace(/[.!¡]+$/, ""));
  return CONTINUATIONS.has(bare);
}

export function shortcutRoute(input: TurnInput): RouteTurnDecision {
  const text = input.message.trim();
  const why = COMMAND_PREFIX.test(text)
    ? ["slash command: harness already has explicit intent"]
    : text.length === 0
      ? ["empty turn"]
      : ["bare continuation acknowledgment"];
  return {
    tier: "fast",
    model: DEFAULT_MODELS[0].id,
    effort: "low",
    tools: [],
    skill: null,
    why,
    gateScore: 0,
  };
}

export function heuristicRoute(
  input: TurnInput,
  toolsCatalog: Record<string, ToolDef> = DEFAULT_TOOLS,
  modelsCatalog: readonly ModelTierCard[] = DEFAULT_MODELS,
  skillsCatalog: Record<string, SkillCard> = {},
): RouteTurnDecision {
  if (isShortcut(input)) return shortcutRoute(input);

  const text = normalizeDiacritics(`${input.message}\n${input.recentContext ?? ""}`);

  // Tier heuristic: highest matching card
  let modelIdx = 0;
  modelsCatalog.forEach((m, idx) => {
    if (m.hints?.some((h) => h.test(text))) {
      modelIdx = Math.max(modelIdx, idx);
    }
  });
  if (input.message.trim().length > 250) {
    modelIdx = Math.max(modelIdx, 1); // at least balanced for long prompts
  }

  const modelCard = modelsCatalog[modelIdx] ?? modelsCatalog[0];
  const tier = modelCard.tier;
  const effort = modelIdx >= 2 ? "xhigh" : modelIdx === 1 ? "high" : "low";

  // Tools heuristic
  const tools: string[] = [];
  const blocked = new Set(input.unavailableTools ?? []);
  for (const [toolName, def] of Object.entries(toolsCatalog)) {
    if (blocked.has(toolName)) continue;
    if (def.hints?.some((h) => h.test(text))) {
      tools.push(toolName);
    }
  }

  // Skills heuristic
  let skill: string | null = null;
  for (const [skillId, card] of Object.entries(skillsCatalog)) {
    if (card.hints?.some((h) => h.test(text))) {
      skill = skillId;
      break;
    }
  }

  return {
    tier,
    model: modelCard.id,
    effort,
    tools,
    skill,
    why: ["deterministic regex heuristic fallback"],
    gateScore: skill ? 0.75 : 0.25,
  };
}

export class TurnRouter {
  private readonly jevClient: ResilientJevClient;
  private readonly cache = new Lru<{ decision: RouteTurnDecision; judged: RouteSummary | null; reason: RouteReason }>(256);
  private readonly tools: Record<string, ToolDef>;
  private readonly models: readonly ModelTierCard[];
  private readonly skills: Record<string, SkillCard>;
  private readonly thresholds: PolicyThresholds;
  private readonly mode: RouteMode;

  constructor(options: {
    jevOptions?: ResilientJevOptions;
    tools?: Record<string, ToolDef>;
    models?: readonly ModelTierCard[];
    skills?: Record<string, SkillCard>;
    thresholds?: PolicyThresholds;
    mode?: RouteMode;
  } = {}) {
    this.jevClient = options.jevOptions
      ? new ResilientJevClient(options.jevOptions)
      : getGlobalJevClient();
    this.tools = options.tools ?? DEFAULT_TOOLS;
    this.models = options.models ?? DEFAULT_MODELS;
    this.skills = options.skills ?? {};
    this.thresholds = options.thresholds ?? DEFAULT_POLICY_THRESHOLDS;
    this.mode = options.mode ?? "active";
    if (!["off", "shadow", "active"].includes(this.mode)) throw new Error("invalid_route_mode");
  }

  prewarm(): Promise<boolean> {
    return this.mode === "off" ? Promise.resolve(true) : this.jevClient.prewarm();
  }

  async route(input: TurnInput, signal?: AbortSignal): Promise<FullRouteResult> {
    const started = performance.now();
    const elapsed = () => performance.now() - started;
    const finish = (decision: RouteTurnDecision, telemetry: RouterTelemetry, reason: RouteReason, judged: RouteSummary | null = null, inputTokens = 0, outputTokens = 0): FullRouteResult => ({
      decision,
      telemetry,
      observation: { id: randomUUID(), specId: "turn.route", specVersion: 1, mode: this.mode, source: telemetry.source, reason, applied: summarizeRoute(decision), judged, latencyMs: telemetry.totalMs, inputTokens, outputTokens },
    });

    // Lane 1: Shortcut (0ms)
    if (isShortcut(input)) {
      return finish(shortcutRoute(input), {
          totalMs: elapsed(),
          jevMs: 0,
          source: "shortcut",
          model: "none",
        }, "shortcut");
    }

    if (this.mode === "off") return finish(heuristicRoute(input, this.tools, this.models, this.skills), { totalMs: elapsed(), jevMs: 0, source: "fallback", model: "heuristic" }, "off");

    // Lane 2: Cache
    const key = hashKey("turn_route", {
      message: input.message.trim(),
      context: input.recentContext?.trim() ?? "",
      tools: Object.keys(this.tools),
      skills: Object.keys(this.skills),
      unavailableTools: [...new Set(input.unavailableTools ?? [])].sort(),
    });

    const cached = this.cache.get(key);
    if (cached) {
      return finish(cached.decision, {
          totalMs: elapsed(),
          jevMs: 0,
          source: "cache",
          model: "cache",
        }, cached.reason, cached.judged);
    }

    // Lane 3: Jev Call with strict deadline and fallback
    const availableToolsList: Record<string, ToolDef> = {};
    const blocked = new Set(input.unavailableTools ?? []);
    for (const [toolName, def] of Object.entries(this.tools)) {
      if (!blocked.has(toolName)) {
        availableToolsList[toolName] = def;
      }
    }

    const questions = buildRoutingQuestions(availableToolsList, this.skills);
    const statePayload = {
      latest_user_message: input.message.slice(0, 1500),
      recent_context: (input.recentContext ?? "").slice(0, 800),
    };

    try {
      const outcome = await this.jevClient.ask(
        statePayload,
        questions,
        signal,
        (late) => {
          if (this.mode !== "active" || routingAnswersStatus(late.answers, questions) !== "valid") return;
          const lateDecision = decideRoute(late.answers, availableToolsList, this.models, this.thresholds);
          this.cache.set(key, { decision: lateDecision, judged: summarizeRoute(lateDecision), reason: "judged" });
        },
      );

      const status = routingAnswersStatus(outcome.answers, questions);
      const judged = status === "valid" ? decideRoute(outcome.answers, availableToolsList, this.models, this.thresholds) : null;
      const decision = judged && this.mode === "active" ? judged : heuristicRoute(input, availableToolsList, this.models, this.skills);
      const reason = status !== "valid" ? status : this.mode === "shadow" ? "shadow" : "judged";
      if (judged) this.cache.set(key, { decision, judged: summarizeRoute(judged), reason });

      return finish(decision, {
          totalMs: elapsed(),
          jevMs: outcome.jevMs,
          source: outcome.fromCache ? "cache" : judged ? "jev" : "fallback",
          model: outcome.model,
          requestId: outcome.requestId,
        }, reason, judged ? summarizeRoute(judged) : null, outcome.fromCache ? 0 : outcome.inputTokens, outcome.fromCache ? 0 : outcome.outputTokens);
    } catch (err) {
      // Lane 4: Fallback
      const fallbackDecision = heuristicRoute(input, availableToolsList, this.models, this.skills);
      const reason: RouteReason = err instanceof JevError ? err.failure : "network";
      fallbackDecision.why.unshift(`fallback triggered: ${reason}`);
      return finish(fallbackDecision, {
          totalMs: elapsed(),
          jevMs: Math.min(elapsed(), this.jevClient.deadline),
          source: "fallback",
          model: "heuristic",
        }, reason);
    }
  }
}
