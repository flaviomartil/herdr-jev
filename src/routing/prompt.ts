/**
 * Prompt rendering for routed turns preserving downstream prompt cache.
 * 
 * Splicing a dynamic skill into the middle of the system prompt busts prefix caching
 * for Anthropic, OpenAI, and Gemini, destroying latency and costing orders of magnitude
 * more tokens than the router saved.
 * 
 * This module splits the prompt into:
 * 1. `cached`: The byte-identical catalog roster
 * 2. `suffix`: The dynamic `<skill_relevance>` block appended AFTER the cache breakpoint
 */

export interface PromptOptions {
  readonly tag?: string;
  readonly suggest?: (skill: string) => string;
  readonly none?: string;
}

export const DEFAULT_PROMPT_OPTIONS: Required<PromptOptions> = {
  tag: "skill_relevance",
  suggest: (skill: string) =>
    `Relevant to the current request: ${skill}. Ignore this if it does not fit what the user actually asked for.`,
  none: "No skill in the roster appears relevant to this request.",
};

export function renderSkillBlock(
  skill: string | null,
  options: PromptOptions = {},
): string {
  const { tag, suggest, none } = { ...DEFAULT_PROMPT_OPTIONS, ...options };
  const body = skill ? suggest(skill) : none;
  return `\n\n<${tag}>\n${body}\n</${tag}>`;
}

export function systemPromptParts(
  staticRoster: string,
  skill: string | null,
  options: PromptOptions = {},
): { cached: string; suffix: string } {
  return {
    cached: staticRoster,
    suffix: renderSkillBlock(skill, options),
  };
}
