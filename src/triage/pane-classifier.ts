import { choice, score } from "@typesafe-ai/sdk";
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

export async function classifyPaneText(input: { paneText: string; agent: string; status: string }, client: ResilientJevClient): Promise<FlatClassification> {
  const safeText = redactSecrets(input.paneText);
  const result = await client.ask(
    { paneText: safeText, agent: input.agent, status: input.status },
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
