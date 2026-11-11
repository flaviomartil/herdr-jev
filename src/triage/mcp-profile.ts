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
  memory: /\b(memoria (de |do |da )?(sessao|sessoes|projeto|projetos)|session memory|project memory|lembr\w* (a |o |da |do )?(decisao|decisoes|sessao|sessoes|preferencia|preferencias)|recall)\b/,
  context: /\b(codebase|arquitetur\w*|architect\w*|grafo (de |do )?(codigo|dependencias)|code graph|knowledge graph|pesquis\w* (no|na|em) (o |a )?(codigo|codebase|projeto)|explor\w* (o |a )?(codebase|projeto|project))\b/,
  docs: /\b(docs?|documentac\w*|documentation|manual|bibliotec\w*|library|sdk)\b/,
  design: /\b(design system|design visual|design de (tela|telas|interface)|mockups?|prototip\w*|wireframes?|layout|css|ux|telas?|screens?)\b/,
  browser: /\b(browser|navegador\w*|playwright|cypress|e2e|scrap\w*|crawl\w*|screenshots?|pagina web|web ?page)\b/,
  bi: /\b(bi|dashboards?|dax|kpis?|metricas? de negocio|business metrics)\b/,
  windows: /\b(windows|powershell|wsl)\b/,
  messaging: /\b((enviar|envie|enviando|send|sending|reply|responder)\s+(\w+\s+){0,3}(mensagem|mensagens|messages?|e-?mails?|sms|chats?)|slack|telegram|sms)\b/,
  media: /\b(imagem|imagens|images?|videos?|audios?|midia|gif|ffmpeg)\b/,
  "cloud-gpu": /\b(gpus?|cuda|vram|fine-?tun\w*|lora|treino\w*|training|inferenc\w*)\b/,
  reasoning: /\b(passo a passo|step by step|sequential thinking|pensamento sequencial|raciocin\w*|think through)\b/,
  orchestration: /\b(herdr|orquestr\w*|orchestrat\w*|subagent\w*|subagente\w*|triad\w*|delegat\w* (a|to|para) (um |uma |an? )?(sub)?agent\w*)\b/,
  evaluation: /\b(avaliac\w* do modelo|avalia\w* (o |a )?(modelo|modelos|model|respostas?)|model evaluation|model benchmarks?)\b/,
  social: /\b(vagas?|recrut\w*|rede profissional|networking|job (search|board|posting)s?)\b/,
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
