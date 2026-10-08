import type { CouncilMemberName } from "./types.js";

export const MEMBER_NAMES: readonly CouncilMemberName[] = ["codex", "kimi", "antigravity"];

export const MEMBER_BINARIES: Readonly<Record<CouncilMemberName, string>> = {
  codex: "codex",
  kimi: "kimi",
  antigravity: "agy",
};

export const NO_FINDINGS = "NO_FINDINGS";

export const PROMPT_FILE_NAME = ".council-prompt.md";

const DIFF_CAP = 300_000;

export interface ReviewInput {
  diff: string;
  question?: string;
}

export interface MemberCommand {
  argv: string[];
  stdin?: string;
  promptFile?: string;
}

const FORMAT = [
  "You are one reviewer on a code review council. Review the diff below for",
  "real defects: bugs, security holes, data loss, broken contracts, missing",
  "tests for changed behaviour. Do not edit any file.",
  "Answer with one JSON object per line and nothing else:",
  '{"path":"<file>","line":<number>,"severity":"high|medium|low","title":"<one line>","detail":"<why, and the fix>"}',
  `If you find nothing, answer exactly: ${NO_FINDINGS}`,
].join("\n");

export function capDiff(diff: string, cap = DIFF_CAP): string {
  return diff.length > cap ? `${diff.slice(0, cap)}\n[council: diff cut at ${cap} of ${diff.length} characters]\n` : diff;
}

export function promptOf(input: ReviewInput): string {
  return [FORMAT, input.question === undefined ? "" : `\nThe owner asks: ${input.question}`, `\n<diff>\n${capDiff(input.diff)}\n</diff>\n`].join("\n");
}

function instructionOf(promptPath: string): string {
  return `Read the file ${promptPath} and review the diff it contains. Its first lines say how to answer. Do not edit any file.`;
}

export function printTimeoutOf(timeoutMs: number): string {
  return `${Math.max(1, Math.floor(timeoutMs / 1000))}s`;
}

export function commandOf(name: CouncilMemberName, input: ReviewInput, promptPath: string, timeoutMs: number): MemberCommand {
  switch (name) {
    case "codex":
      return input.question === undefined
        ? { argv: ["codex", "exec", "review", "--uncommitted", "--ephemeral"] }
        : { argv: ["codex", "exec", "review", "--ephemeral", "-"], stdin: promptOf(input) };
    case "kimi":
      return { argv: ["kimi", "-p", instructionOf(promptPath), "--output-format", "text"], promptFile: promptOf(input) };
    case "antigravity":
      return {
        argv: ["agy", "--print", instructionOf(promptPath), "--mode", "plan", "--sandbox", "--output-format", "json", "--print-timeout", printTimeoutOf(timeoutMs)],
        promptFile: promptOf(input),
      };
  }
}
