import { performance } from "node:perf_hooks";
import { Lru, hashKey } from "../cache/lru.js";
import {
  ResilientJevClient,
  getGlobalJevClient,
  type ResilientJevOptions,
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
import { buildRoutingQuestions } from "./questions.js";

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
}

export interface FullRouteResult {
  decision: RouteTurnDecision;
  telemetry: RouterTelemetry;
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
  private readonly cache = new Lru<RouteTurnDecision>(256);
  private readonly tools: Record<string, ToolDef>;
  private readonly models: readonly ModelTierCard[];
  private readonly skills: Record<string, SkillCard>;
  private readonly thresholds: PolicyThresholds;

  constructor(options: {
    jevOptions?: ResilientJevOptions;
    tools?: Record<string, ToolDef>;
    models?: readonly ModelTierCard[];
    skills?: Record<string, SkillCard>;
    thresholds?: PolicyThresholds;
  } = {}) {
    this.jevClient = options.jevOptions
      ? new ResilientJevClient(options.jevOptions)
      : getGlobalJevClient();
    this.tools = options.tools ?? DEFAULT_TOOLS;
    this.models = options.models ?? DEFAULT_MODELS;
    this.skills = options.skills ?? {};
    this.thresholds = options.thresholds ?? DEFAULT_POLICY_THRESHOLDS;
  }

  prewarm(): Promise<boolean> {
    return this.jevClient.prewarm();
  }

  async route(input: TurnInput, signal?: AbortSignal): Promise<FullRouteResult> {
    const started = performance.now();
    const elapsed = () => performance.now() - started;

    // Lane 1: Shortcut (0ms)
    if (isShortcut(input)) {
      return {
        decision: shortcutRoute(input),
        telemetry: {
          totalMs: elapsed(),
          jevMs: 0,
          source: "shortcut",
          model: "none",
        },
      };
    }

    // Lane 2: Cache
    const key = hashKey("turn_route", {
      message: input.message.trim(),
      context: input.recentContext?.trim() ?? "",
      tools: Object.keys(this.tools),
      skills: Object.keys(this.skills),
    });

    const cached = this.cache.get(key);
    if (cached) {
      return {
        decision: cached,
        telemetry: {
          totalMs: elapsed(),
          jevMs: 0,
          source: "cache",
          model: "cache",
        },
      };
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
          const lateDecision = decideRoute(late.answers, availableToolsList, this.models, this.thresholds);
          this.cache.set(key, lateDecision);
        },
      );

      const decision = decideRoute(outcome.answers, availableToolsList, this.models, this.thresholds);
      this.cache.set(key, decision);

      return {
        decision,
        telemetry: {
          totalMs: elapsed(),
          jevMs: outcome.jevMs,
          source: outcome.fromCache ? "cache" : "jev",
          model: outcome.model,
          requestId: outcome.requestId,
        },
      };
    } catch (err) {
      // Lane 4: Fallback
      const fallbackDecision = heuristicRoute(input, availableToolsList, this.models, this.skills);
      fallbackDecision.why.unshift(`fallback triggered: ${String(err)}`);
      return {
        decision: fallbackDecision,
        telemetry: {
          totalMs: elapsed(),
          jevMs: Math.min(elapsed(), this.jevClient.deadline),
          source: "fallback",
          model: "heuristic",
        },
      };
    }
  }
}
