import { choice, noul, score, type ChoiceQuestion, type NoulQuestion, type ScoreQuestion } from "@typesafe-ai/sdk";
import type { SkillCard, ToolDef } from "./catalog.js";

export const GATE_IDS = [
  "acts_on_system",
  "follows_procedure",
  "produces_artifact",
  "prose_suffices",
] as const;

export type GateId = (typeof GATE_IDS)[number];

export const INVERTED_GATES: ReadonlySet<GateId> = new Set<GateId>(["prose_suffices"]);

export const DIFFICULTY_LEVELS = [
  "Answerable in a sentence or two from what is already in front of the assistant: a definition, a yes or no, a restatement, or acknowledging what was just said.",
  "One self-contained step: change a file the user named, look up where something is defined, or run a command the user already spelled out.",
  "Several steps that depend on each other across a handful of files: build a feature, trace a bug from its symptom, or connect two parts of the system.",
  "The shape of the work has to be figured out before any of it can be done: a cross-cutting change, a design decision with real trade-offs, or a problem whose cause nobody has identified yet.",
] as const;

export const SCOPE_LEVELS = [
  "Everything needed to answer is already in the message itself.",
  "One file, or a few specific files that the message names or that are easy to find.",
  "Many files across the project, or parts of it that nobody has named yet and have to be discovered first.",
] as const;

export const INTENT_CRITERIA = {
  explain: "The user wants to understand something. Correct when a good answer is words, and nothing in the project changes.",
  locate: "The user wants to know where something lives, or whether it exists at all. Correct when the answer is a pointer into the codebase.",
  modify: "The user wants code, config or files changed. Correct whenever the turn should end with the project different from how it started.",
  operate: "The user wants a command or an outside service driven: build, test, deploy, git, a ticket board, an API.",
  meta: "The user is steering the session rather than the work: undo that, try the other approach, stop, keep going.",
} as const;

export const NO_SKILL = "none";

export function buildRoutingQuestions(
  tools: Record<string, ToolDef>,
  skills: Record<string, SkillCard> = {},
): Record<string, NoulQuestion | ChoiceQuestion | ScoreQuestion> {
  const q: Record<string, NoulQuestion | ChoiceQuestion | ScoreQuestion> = {
    // 1. Difficulty & Scope
    "turn::difficulty": score(
      "Which situation best matches how much work is required to answer `latest_user_message` correctly?",
      [...DIFFICULTY_LEVELS],
    ),
    "turn::scope": score(
      "How widely across the codebase does answering `latest_user_message` require looking or changing?",
      [...SCOPE_LEVELS],
    ),
    "turn::intent": choice(
      "What is the user trying to accomplish with `latest_user_message`?",
      INTENT_CRITERIA,
    ),

    // 2. The 4 Request-Shape Gates
    "gate::acts_on_system": noul(
      "Does `latest_user_message` ask the assistant to change files, run commands, or interact with external systems?",
    ),
    "gate::follows_procedure": noul(
      "Does `latest_user_message` ask for an established multi-step workflow, playbook, or formal procedure?",
    ),
    "gate::produces_artifact": noul(
      "Does `latest_user_message` ask for a substantial, structured document or work product: an architectural design, ADR, audit report, formal spec, or test suite?",
    ),
    "gate::prose_suffices": noul(
      "Can `latest_user_message` be completely satisfied with conversational prose, advice, or an explanation without touching the system or producing a structured artifact?",
    ),
  };

  // 3. Tool Questions: Individual Nouls for absolute bar
  const toolCriteria: Record<string, string> = { [NO_SKILL]: "No tool is required." };
  for (const [toolName, def] of Object.entries(tools)) {
    q[`tool::${toolName}`] = noul(
      `Will the assistant need to use the \`${toolName}\` tool to satisfy \`latest_user_message\`?\n${def.description}`,
    );
    toolCriteria[toolName] = def.description;
  }

  // Tool Ranking Choice
  q["tool::which"] = choice(
    "If the assistant must use a tool for `latest_user_message`, which tool is most relevant?",
    toolCriteria,
  );

  // 4. Skills Choice (if any skills provided)
  if (Object.keys(skills).length > 0) {
    const skillCriteria: Record<string, string> = {
      [NO_SKILL]: "No specialized playbook or skill applies; general assistance suffices.",
    };
    for (const [skillId, card] of Object.entries(skills)) {
      skillCriteria[skillId] = `${card.description}${card.notFor ? ` Not for: ${card.notFor}` : ""}`;
    }
    q["skill::which"] = choice(
      "Which specialized skill or playbook is best suited to fulfill `latest_user_message`?",
      skillCriteria,
    );
  }

  return q;
}
