import type { ChoiceQuestion, NoulQuestion } from "@typesafe-ai/sdk";
import type { CouncilFinding, CouncilMemberName } from "./types.js";

export type JevQuestion = NoulQuestion | ChoiceQuestion;

export interface JevLike {
  ask(
    state: unknown,
    questions: Record<string, JevQuestion>,
  ): Promise<{ answers: Record<string, unknown> }>;
}

export interface SynthLimits {
  maxQuestions: number;
  maxChars: number;
  maxScored: number;
  maxDetailChars: number;
}

export interface SynthOptions {
  jev?: JevLike;
  threshold?: number;
  contradictionThreshold?: number;
  deadlineMs?: number;
  limits?: Partial<SynthLimits>;
}

export interface CouncilItem {
  members: CouncilMemberName[];
  location: string;
  text: string;
  severity: CouncilFinding["severity"];
  real?: number;
  findings: CouncilFinding[];
}

export interface CouncilSummary {
  agreements: CouncilItem[];
  disagreements: CouncilItem[];
  unique: CouncilItem[];
  notes: CouncilItem[];
  messages: string[];
  scoredBy: "jev" | "none";
}
