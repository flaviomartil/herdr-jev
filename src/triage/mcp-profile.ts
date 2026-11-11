import { readdirSync } from "node:fs";
import type { ReasoningEffort, TriageDecision } from "../types/index.js";

export const CAPABILITY_TAGS = [
  "memory",
  "context",
  "docs",
  "design",
  "browser",
  "bi",
  "windows",
  "messaging",
  "media",
  "cloud-gpu",
  "reasoning",
  "orchestration",
  "evaluation",
  "social",
] as const;

export type CapabilityTag = (typeof CAPABILITY_TAGS)[number];

export interface CapabilityDecision {
  needsResearch: boolean;
  effort: ReasoningEffort;
}

const TASK_PATTERNS: Record<CapabilityTag, RegExp> = {
  memory: /\b(memor(ia|ias|y|ies)|lembr\w*|remind\w*|recall|remember)\b/,
  context: /\b(contexto|context|codebase|repos?|reposit\w*|arquitetur\w*|architect\w*|grafo|graph|explor\w*|pesquis\w*|research\w*|investig\w*)\b/,
  docs: /\b(docs?|documentac\w*|documentation|manual|bibliotec\w*|library|sdk)\b/,
  design: /\b(design|mockups?|prototip\w*|layout|interface|tela|telas|screens?|css|visual|ui|ux)\b/,
  browser: /\b(browser|navegador\w*|playwright|cypress|e2e|scrap\w*|crawl\w*|screenshots?|pagina\w*|web ?page)\b/,
  bi: /\b(bi|dashboards?|dax|kpi\w*|metric\w*|metrica\w*|relatorios?)\b/,
  windows: /\b(windows|powershell|wsl|desktop)\b/,
  messaging: /\b(mensagens?|message\w*|messaging|chats?|e-?mails?|sms|slack|telegram|inbox)\b/,
  media: /\b(imagens?|images?|videos?|audios?|midia|media|gif|ffmpeg)\b/,
  "cloud-gpu": /\b(gpus?|cuda|vram|fine-?tun\w*|lora|treino\w*|training|inferenc\w*)\b/,
  reasoning: /\b(passo a passo|step by step|sequential|raciocin\w*|think through)\b/,
  orchestration: /\b(herdr|orquestr\w*|orchestrat\w*|subagent\w*|subagente\w*|delegat\w*|triad\w*)\b/,
  evaluation: /\b(evaluat\w*|avalia\w*|avaliac\w*|benchmarks?|judge)\b/,
  social: /\b(vagas?|candidat\w*|recrut\w*|jobs?|networking|rede profissional|social)\b/,
};

const CWD_PATTERNS: Array<[CapabilityTag, RegExp]> = [
  ["browser", /^(playwright|cypress)\.config\.[cm]?[jt]s$/],
  ["bi", /\.pbi[tx]$/],
  ["design", /^(components\.json|\.storybook)$/],
];

export function keywordCapabilityTags(task: string): CapabilityTag[] {
  const text = task.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  return CAPABILITY_TAGS.filter((tag) => TASK_PATTERNS[tag].test(text));
}

export function triageCapabilityTags(decision: CapabilityDecision): CapabilityTag[] {
  const tags: CapabilityTag[] = [];
  if (decision.needsResearch) tags.push("context");
  if (decision.effort !== "standard") tags.push("reasoning");
  return tags;
}

export function detectCwdCapabilityTags(dir: string): CapabilityTag[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const tags = new Set<CapabilityTag>();
  for (const name of names) {
    for (const [tag, pattern] of CWD_PATTERNS) if (pattern.test(name)) tags.add(tag);
  }
  return CAPABILITY_TAGS.filter((tag) => tags.has(tag));
}

export function resolveCapabilityTags(input: {
  task?: string;
  decision?: CapabilityDecision | TriageDecision;
  cwdTags?: readonly CapabilityTag[];
}): CapabilityTag[] {
  const tags = new Set<CapabilityTag>([
    ...(input.task ? keywordCapabilityTags(input.task) : []),
    ...(input.decision ? triageCapabilityTags(input.decision) : []),
    ...(input.cwdTags ?? []),
  ]);
  return CAPABILITY_TAGS.filter((tag) => tags.has(tag));
}
