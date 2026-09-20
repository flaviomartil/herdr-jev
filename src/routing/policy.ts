import { scoreQuantile, probabilityMargin } from "../triage/quantile.js";
import {
  DEFAULT_MODELS,
  DEFAULT_TOOLS,
  type ModelTierCard,
  type SkillCard,
  type ToolDef,
} from "./catalog.js";
import { GATE_IDS, INVERTED_GATES, NO_SKILL, type GateId } from "./questions.js";

export interface PolicyThresholds {
  readonly gate: number;
  readonly skillConfidence: number;
  readonly toolTail: number;
  readonly difficultyQuantile: number;
  readonly scopeQuantile: number;
  readonly scopeFloorTier: number;
}

export const DEFAULT_POLICY_THRESHOLDS: PolicyThresholds = {
  gate: 0.2,
  skillConfidence: 0.6,
  toolTail: 0.25,
  difficultyQuantile: 0.6,
  scopeQuantile: 0.6,
  scopeFloorTier: 1, // 'balanced' index in [fast, balanced, deep]
};

export interface RouteTurnDecision {
  readonly tier: "fast" | "balanced" | "deep";
  readonly model: string;
  readonly effort: "low" | "medium" | "high" | "xhigh";
  readonly tools: string[];
  readonly skill: string | null;
  readonly why: string[];
  readonly gateScore: number;
}

export function computeGateScore(answers: Record<string, any>): {
  score: number;
  values: Record<string, number>;
} {
  const values: Record<string, number> = {};
  let sum = 0;
  for (const id of GATE_IDS) {
    const raw = answers[`gate::${id}`]?.noul ?? 0.5;
    values[id] = raw;
    sum += INVERTED_GATES.has(id) ? 1 - raw : raw;
  }
  return { score: sum / GATE_IDS.length, values };
}

export function decideRoute(
  answers: Record<string, any>,
  toolsCatalog: Record<string, ToolDef> = DEFAULT_TOOLS,
  modelsCatalog: readonly ModelTierCard[] = DEFAULT_MODELS,
  thresholds: PolicyThresholds = DEFAULT_POLICY_THRESHOLDS,
): RouteTurnDecision {
  const why: string[] = [];

  const diffAns = answers["turn::difficulty"] ?? {};
  const scopeAns = answers["turn::scope"] ?? {};

  // 1. Model Tier & Effort via Quantile (never expectation)
  const diffLevel = scoreQuantile(diffAns.probabilities, thresholds.difficultyQuantile);
  const scopeLevel = scoreQuantile(scopeAns.probabilities, thresholds.scopeQuantile);

  const tiers: ("fast" | "balanced" | "deep")[] = ["fast", "balanced", "deep"];
  const efforts: ("low" | "medium" | "high" | "xhigh")[] = ["low", "medium", "high", "xhigh"];

  let tierIdx = Math.min(diffLevel, tiers.length - 1);
  let effortIdx = Math.min(diffLevel, efforts.length - 1);

  why.push(`difficulty level ${diffLevel} (via quantile ${thresholds.difficultyQuantile}) -> tier:${tiers[tierIdx]}/effort:${efforts[effortIdx]}`);

  // Broad scope floors the model tier
  if (scopeLevel >= 2) {
    const floorIdx = thresholds.scopeFloorTier;
    if (floorIdx > tierIdx) {
      why.push(`broad scope level ${scopeLevel} floors tier at ${tiers[floorIdx]}`);
      tierIdx = floorIdx;
    }
  }

  const tier = tiers[tierIdx];
  const modelCard = modelsCatalog.find((m) => m.tier === tier) ?? modelsCatalog[tierIdx] ?? modelsCatalog[0];
  const model = modelCard.id;
  const effort = efforts[effortIdx];

  // 2. Tools Selection: Absolute Nouls + Read-only Choice Tail
  const selectedTools: string[] = [];
  for (const [toolName, def] of Object.entries(toolsCatalog)) {
    const p = answers[`tool::${toolName}`]?.noul ?? 0;
    const bar = def.threshold ?? 0.6;
    if (p >= bar) {
      selectedTools.push(toolName);
    }
  }

  const toolWhich = answers["tool::which"] ?? {};
  if (toolWhich.probabilities) {
    for (const [toolName, p] of Object.entries(toolWhich.probabilities as Record<string, number>)) {
      if (toolName === NO_SKILL || !toolsCatalog[toolName]) continue;
      if (selectedTools.includes(toolName)) continue;
      if (p >= thresholds.toolTail) {
        if (toolsCatalog[toolName].risk === "read") {
          selectedTools.push(toolName);
          why.push(`${toolName} added from ranking tail (p=${p.toFixed(2)})`);
        } else {
          why.push(`${toolName} ranked high (p=${p.toFixed(2)}) but risk is ${toolsCatalog[toolName].risk}; held back`);
        }
      }
    }
  }

  // 3. Skill Selection with 4 Gates
  const gate = computeGateScore(answers);
  const skillAns = answers["skill::which"];
  let skill: string | null = null;

  if (skillAns && skillAns.choice && skillAns.choice !== NO_SKILL) {
    const confidence = skillAns.confidence ?? 0;
    if (gate.score < thresholds.gate) {
      why.push(`gate score ${gate.score.toFixed(2)} below ${thresholds.gate}; skill "${skillAns.choice}" suppressed`);
    } else if (confidence < thresholds.skillConfidence) {
      why.push(`skill "${skillAns.choice}" confidence ${confidence.toFixed(2)} below ${thresholds.skillConfidence}`);
    } else {
      skill = skillAns.choice;
      why.push(`skill "${skill}" selected (confidence ${confidence.toFixed(2)}, gate ${gate.score.toFixed(2)})`);
    }
  }

  return {
    tier,
    model,
    effort,
    tools: selectedTools,
    skill,
    why,
    gateScore: gate.score,
  };
}
