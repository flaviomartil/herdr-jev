import { choice, score } from "@typesafe-ai/sdk";
import type { Readable } from "node:stream";
import type { ResilientJevClient } from "./jev-client.js";

export interface FlatClassification {
  state: string;
  stateConfidence: number;
  attention: string;
  attentionScore: number;
  attentionConfidence: number;
  blockedReason: string;
  blockedReasonConfidence: number;
  activity: string;
  activityConfidence: number;
  jevMs: number;
  model: string;
}

export function normalizePaneClassification(raw: any): FlatClassification {
  const ans = raw.answers;
  const state = ans.state?.choice || "unknown";
  const stateConfidence = ans.state?.confidence ?? 0;
  
  const attScore = ans.attention?.score ?? 0;
  let attention = "now";
  if (attScore < 0.5) attention = "none";
  else if (attScore < 1.5) attention = "soon";

  return {
    state,
    stateConfidence,
    attention,
    attentionScore: attScore,
    attentionConfidence: ans.attention?.confidence ?? 0,
    blockedReason: ans.blockedReason?.choice || "none",
    blockedReasonConfidence: ans.blockedReason?.confidence ?? 0,
    activity: ans.activity?.choice || "unknown",
    activityConfidence: ans.activity?.confidence ?? 0,
    jevMs: raw.jevMs ?? 0,
    model: raw.model || "unknown"
  };
}

import { redactSecrets } from "../herdr/pane-text.js";

export const MAX_CLASSIFY_INPUT_CHARS = 131072;
export const MAX_CLASSIFY_PANE_TEXT_CHARS = 6000;
const MAX_CLASSIFY_LABEL_CHARS = 40;

export interface ClassifyInput {
  paneText: string;
  agent: string;
  status: string;
}

function label(value: unknown): string {
  return typeof value === "string" && value ? value.slice(0, MAX_CLASSIFY_LABEL_CHARS) : "unknown";
}

function clipTail(text: string): string {
  if (text.length <= MAX_CLASSIFY_PANE_TEXT_CHARS) return text;
  const tail = text.slice(-MAX_CLASSIFY_PANE_TEXT_CHARS);
  const newline = tail.indexOf("\n");
  if (newline !== -1) return tail.slice(newline + 1);
  const gap = tail.search(/\s/);
  return gap === -1 ? "" : tail.slice(gap + 1);
}

export async function readClassifyInput(stream: Readable): Promise<string> {
  stream.setEncoding("utf8");
  let input = "";
  for await (const chunk of stream) {
    input += chunk;
    if (input.length > MAX_CLASSIFY_INPUT_CHARS) break;
  }
  return input;
}

export function validateClassifyInput(data: unknown): ClassifyInput {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new TypeError("invalid classify-pane input: expected a JSON object");
  }
  const { paneText, agent, status } = data as Record<string, unknown>;
  if (typeof paneText !== "string") {
    throw new TypeError("invalid classify-pane input: paneText must be a string");
  }
  return { paneText, agent: label(agent), status: label(status) };
}

export function parseClassifyInput(raw: string): ClassifyInput {
  if (raw.length > MAX_CLASSIFY_INPUT_CHARS) {
    throw new RangeError("invalid classify-pane input: input too large");
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new SyntaxError("invalid classify-pane input: not valid JSON");
  }
  return validateClassifyInput(data);
}

export async function classifyPaneText(input: { paneText: string; agent: string; status: string }, client: ResilientJevClient): Promise<FlatClassification> {
  const { paneText, agent, status } = validateClassifyInput(input);
  const safeText = clipTail(redactSecrets(clipTail(paneText)));
  const result = await client.ask(
    { paneText: safeText, agent, status },
    {
      state: choice("Given paneText, the recent terminal output of a coding agent, which state is the agent in now? blocked means waiting for a human approval, answer or stuck on an error; working means actively running tools or producing output; idle means at an empty prompt with nothing pending; done means it reported completion; unknown otherwise", {
        blocked: "waiting for a human approval, answer or stuck on an error",
        working: "actively running tools or producing output",
        idle: "at an empty prompt with nothing pending",
        done: "reported completion",
        unknown: "otherwise"
      }),
      attention: score("Based on the paneText, what is the level of attention required?", [
        "none: nothing needed",
        "soon: will need input shortly or finished and awaits review",
        "now: blocked on a human right now"
      ]),
      blockedReason: choice("If blocked, what is the reason?", {
        approval: "waiting for human approval to proceed",
        question: "waiting for human answer to a question",
        error: "stuck on an error",
        none: "not blocked"
      }),
      activity: choice("Given paneText, what is the agent currently doing?", {
        testing: "running tests, checks, or assertions",
        editing: "writing, replacing, or formatting code",
        reading: "reading files, viewing code, or searching directories",
        running: "executing generic commands, building, or compiling",
        planning: "reasoning, planning next steps, or writing design documents",
        waiting_approval: "paused and waiting for human approval to proceed",
        waiting_answer: "paused and waiting for human input to a question",
        error: "reporting a failure or crash and not moving forward",
        idle: "empty terminal prompt with no active operation",
        done: "reporting that all work is completed",
        unknown: "none of the above or ambiguous"
      })
    }
  );
  return normalizePaneClassification(result);
}
