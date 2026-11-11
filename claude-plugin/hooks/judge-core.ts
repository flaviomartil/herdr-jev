export type JudgeClass = "explore" | "search" | "summary" | "mechanical" | "feature" | "fix" | "review" | "architecture";
export type Worker = "claude-subagent" | "codex" | "agy";
export type Level = "cheap" | "mid" | "high" | "top";
export type Size = "small" | "large";
export type Effort = "low" | "medium" | "high";
export type Models = {
  claude: { haiku: string; sonnet: string; opus: string; fable: string };
  codex: { luna: string; terra: string; sol: string; astra: string };
  agy: { flash: string; pro: string };
};
export type Hints = {
  class?: JudgeClass;
  size?: Size;
  architecture?: boolean;
  prefer?: Worker;
  available?: Partial<Record<Worker, boolean>>;
};
export type Decision = {
  class: JudgeClass;
  worker: Worker;
  model: string;
  effort: Effort;
  reason: string;
  tier: string;
  level: Level;
  freshContext: boolean;
  agentType?: string;
};
export type SpawnLike = { subagentType?: string; model?: string; prompt: string; description?: string };
export type SpawnFix = { subagentType?: string; model?: string; prompt: string; changed: boolean; notes: string[] };

export const PASSO_0 = "Passo 0: localizar e seguir as skills que cobrem a tarefa; reportar quais usou.";
export const AGENT_PREFIX = "harness:";
export const DEFAULT_MODELS: Models = {
  claude: { haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5", fable: "claude-fable-5-2" },
  codex: { luna: "luna", terra: "terra", sol: "sol", astra: "astra" },
  agy: { flash: "gemini-flash", pro: "gemini-pro" },
};
export const REGISTERED_PAIRS: readonly { tier: ClaudeTier; effort: Effort }[] = [
  { tier: "haiku", effort: "low" },
  { tier: "haiku", effort: "high" },
  { tier: "sonnet", effort: "medium" },
  { tier: "opus", effort: "high" },
  { tier: "fable", effort: "high" },
];
export type ClaudeTier = keyof Models["claude"];

const LEVEL_OF: Record<JudgeClass, Level> = {
  explore: "cheap",
  search: "cheap",
  summary: "cheap",
  mechanical: "cheap",
  feature: "mid",
  fix: "mid",
  review: "high",
  architecture: "top",
};
const TIERS: Record<Level, { claude: ClaudeTier; codex: keyof Models["codex"]; agy: keyof Models["agy"] }> = {
  cheap: { claude: "haiku", codex: "luna", agy: "flash" },
  mid: { claude: "sonnet", codex: "terra", agy: "pro" },
  high: { claude: "opus", codex: "sol", agy: "pro" },
  top: { claude: "fable", codex: "astra", agy: "pro" },
};
const RULES: { cls: JudgeClass; re: RegExp }[] = [
  { cls: "review", re: /\b(?:review|revis|audit|code review)/i },
  { cls: "review", re: /\b(?:check|verif|valid|confirm|ensure|garant)\w*\b[^.\n]*\b(?:safe|safety|secur|seguro|seguran|quebr|broke|break|correct|corret|vulnerab|regress)/i },
  { cls: "summary", re: /\b(?:summari[sz]|summary|tl;?dr|resum|sumariz|sintetiz|digest)/i },
  { cls: "fix", re: /\b(?:fix|corrig|conserta|resolv|regression|broken|hotfix)/i },
  { cls: "feature", re: /\b(?:implement|refactor|refator|migrate\b|migrar\b|feature|funcionalidade|desenvolv|develop)/i },
  { cls: "mechanical", re: /\b(?:rename|renomea|bulk|convert|format|reformat|scaffold|replace all|mechanical|boilerplate|substitu)/i },
  { cls: "feature", re: /\b(?:add|create|write|cria|adicion|escrev|escrit|insert|inclu)/i },
  { cls: "explore", re: /^\W*(?:check|verif|valid|confirm)/i },
  { cls: "search", re: /\b(?:search|grep|find|locate|list|where|procur|busc|encontr|onde|lista|liste)/i },
  { cls: "explore", re: /\b(?:explor|investig|inspect|read\b|understand|entend|explain|expli|analy|an[aá]lis|analis|verif|valid|check|confirm|crash|le[ia]\b|descobr|mapeie|map\b)/i },
];
const EXPLICIT_TOP = /\b(use|usa|usar|com|with)\s+(fable|astra)\b|\bT0\b|\bdecis[aã]o (de )?arquitetura\b|\barchitecture (decision|review from scratch)\b/i;
const LARGE = /\b(entire|whole|across the (repo|codebase)|todo o (repo|c[oó]digo)|codebase inteir[ao])\b/i;

const NEGATED = /\b(?:n[aã]o|do not|don't|dont|sem|without|no need to)\b[^,.;\n]*?(?=,|\.|;|\n|$|\bbut\b|\bmas\b|\bjust\b|\bs[oó]\b|\bapenas\b)/gi;

export function stripNegated(text: string): string {
  return text.replace(NEGATED, " ");
}

function earlierAction(text: string, before: number): JudgeClass | null {
  let best: { cls: JudgeClass; at: number } | null = null;
  for (const rule of RULES) {
    if (rule.cls !== "fix" && rule.cls !== "feature") continue;
    const at = rule.re.exec(text)?.index;
    if (at !== undefined && at < before && (best === null || at < best.at)) best = { cls: rule.cls, at };
  }
  return best?.cls ?? null;
}

export function classify(text: string, hints: Hints = {}): { cls: JudgeClass; matched: boolean } {
  if (hints.class !== undefined) return { cls: hints.class, matched: true };
  if (hints.architecture === true || EXPLICIT_TOP.test(text)) return { cls: "architecture", matched: true };
  const clean = stripNegated(text);
  for (const rule of RULES) {
    const hit = rule.re.exec(clean);
    if (hit === null) continue;
    if (rule.cls === "review") {
      const earlier = earlierAction(clean, hit.index);
      if (earlier !== null) return { cls: earlier, matched: true };
    }
    return { cls: rule.cls, matched: true };
  }
  return { cls: "feature", matched: false };
}

export function sizeOf(text: string, hints: Hints = {}): Size {
  if (hints.size !== undefined) return hints.size;
  return text.length > 800 || LARGE.test(text) ? "large" : "small";
}

export function effortOf(level: Level, size: Size): Effort {
  if (level === "cheap") return size === "large" ? "high" : "low";
  return level === "mid" ? "medium" : "high";
}

export function agentTypeFor(tier: ClaudeTier, effort: Effort): string {
  return `${AGENT_PREFIX}${tier}-${effort}`;
}

function candidates(hints: Hints): Worker[] {
  const base: Worker[] = ["claude-subagent", "codex", "agy"];
  const order = hints.prefer === undefined ? base : [hints.prefer, ...base.filter(w => w !== hints.prefer)];
  return order.filter(w => hints.available?.[w] !== false);
}

export function judge(text: string, hints: Hints = {}, models: Models = DEFAULT_MODELS): Decision {
  const { cls, matched } = classify(text, hints);
  const level = LEVEL_OF[cls];
  const size = sizeOf(text, hints);
  const effort = effortOf(level, size);
  const worker = candidates(hints)[0] ?? "claude-subagent";
  const tiers = TIERS[level];
  const tier = worker === "claude-subagent" ? tiers.claude : worker === "codex" ? tiers.codex : tiers.agy;
  const model = worker === "claude-subagent" ? models.claude[tiers.claude] : worker === "codex" ? models.codex[tiers.codex] : models.agy[tiers.agy];
  const why = `${cls}${matched ? "" : " (default)"}, ${level} tier, ${size}`;
  return {
    class: cls,
    worker,
    model,
    effort,
    tier,
    level,
    freshContext: cls === "review",
    reason: hints.prefer !== undefined && worker !== hints.prefer ? `${why}, ${hints.prefer} unavailable` : why,
    ...(worker === "claude-subagent" ? { agentType: agentTypeFor(tiers.claude, effort) } : {}),
  };
}

export function parseModelOverrides(text: string): Partial<{ [K in keyof Models]: Partial<Models[K]> }> {
  const out: Record<string, Record<string, string>> = {};
  let group: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").replace(/\s+$/, "");
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const m = /^(\s*)([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (m === null) continue;
    const value = (m[3] ?? "").replace(/^["']|["']$/g, "");
    if ((m[1] ?? "").length === 0) {
      group = value === "" ? (m[2] ?? null) : null;
      if (group !== null) out[group] ??= {};
    } else if (group !== null && value !== "") {
      (out[group] as Record<string, string>)[m[2] as string] = value;
    }
  }
  return out as never;
}

export function mergeModels(base: Models, over: ReturnType<typeof parseModelOverrides>): Models {
  const pick = <T extends Record<string, string>>(b: T, o: Partial<T> | undefined): T => {
    const next: Record<string, string> = { ...b };
    for (const key of Object.keys(b)) {
      const v = o?.[key];
      if (typeof v === "string" && /^[A-Za-z0-9._:/-]+$/.test(v)) next[key] = v;
    }
    return next as T;
  };
  return { claude: pick(base.claude, over.claude), codex: pick(base.codex, over.codex), agy: pick(base.agy, over.agy) };
}

export function isRegisteredType(name: string | undefined): boolean {
  return REGISTERED_PAIRS.some(pair => agentTypeFor(pair.tier, pair.effort) === name);
}

const TYPE_RE = /^harness:(haiku|sonnet|opus|fable)-(low|medium|high)$/;

function currentOf(s: SpawnLike): { tier: ClaudeTier; effort?: Effort; harness: boolean } | null {
  const hit = TYPE_RE.exec(s.subagentType ?? "");
  if (hit !== null) return { tier: hit[1] as ClaudeTier, effort: hit[2] as Effort, harness: true };
  if (s.subagentType?.startsWith(AGENT_PREFIX)) return null;
  const m = /haiku|sonnet|opus|fable/.exec((s.model ?? "").toLowerCase());
  return m === null ? null : { tier: m[0] as ClaudeTier, harness: false };
}

export function withPasso0(prompt: string): string {
  return prompt.includes("Passo 0:") ? prompt : `${PASSO_0}\n\n${prompt}`;
}

export function enforceSpawn(s: SpawnLike, models: Models = DEFAULT_MODELS): SpawnFix {
  const prompt = withPasso0(s.prompt);
  const notes: string[] = [];
  let subagentType = s.subagentType;
  let model = s.model;
  const cur = currentOf(s);
  if (cur !== null) {
    const byDescription = s.description === undefined ? null : classify(s.description);
    const picked = byDescription !== null && byDescription.matched ? byDescription : classify(s.prompt);
    const want = judge(`${s.description ?? ""}\n${s.prompt}`, { class: picked.cls, available: { codex: false, agy: false } }, models);
    const wantTier = want.tier as ClaudeTier;
    let target: { tier: ClaudeTier; effort: Effort } | null = null;
    if (want.class === "feature" || want.class === "fix") {
      if (cur.tier === "opus" || cur.tier === "fable") target = { tier: "sonnet", effort: "medium" };
    } else if (want.class === "review") {
      if (cur.tier !== "opus") target = { tier: "opus", effort: "high" };
      else if (cur.effort !== undefined && cur.effort !== "high") target = { tier: "opus", effort: "high" };
    } else if (want.level === "cheap") {
      if (cur.tier !== "haiku") target = { tier: "haiku", effort: want.effort };
    }
    if (target === null && cur.harness && cur.tier === wantTier && cur.effort !== want.effort && want.class !== "architecture") {
      target = { tier: wantTier, effort: want.effort };
    }
    if (target !== null) {
      subagentType = agentTypeFor(target.tier, target.effort);
      model = target.tier;
      notes.push(`${want.class}: ${cur.tier}${cur.effort ? `-${cur.effort}` : ""} -> ${target.tier}-${target.effort}`);
    }
  }
  return { subagentType, model, prompt, changed: prompt !== s.prompt || subagentType !== s.subagentType || model !== s.model, notes };
}
