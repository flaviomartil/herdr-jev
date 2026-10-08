import type { CouncilMemberName } from "./types.js";

export const MEMBER_NAMES: readonly CouncilMemberName[] = ["codex", "kimi", "antigravity"];

export const MEMBER_BINARIES: Readonly<Record<CouncilMemberName, string>> = {
  codex: "codex",
  kimi: "kimi",
  antigravity: "agy",
};

export const VERSION_SIGNATURES: Readonly<Record<CouncilMemberName, RegExp>> = {
  codex: /^codex-cli \d/u,
  kimi: /^\d+\.\d+\.\d+\S*$/u,
  antigravity: /^\d+\.\d+\.\d+\S*$/u,
};

export const NO_FINDINGS = "NO_FINDINGS";

export const PROMPT_FILE_NAME = ".council-prompt.md";

export const DIFF_CAP = 300_000;

export const AGY_FINDINGS_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          line: { type: "integer" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          title: { type: "string" },
          detail: { type: "string" },
        },
        required: ["path", "severity", "title", "detail"],
      },
    },
  },
  required: ["findings"],
});

export interface ReviewInput {
  diff: string;
  question?: string;
}

export interface MemberCommand {
  argv: string[];
  stdin?: string;
  promptFile?: string;
}

const INTRO = [
  "You are one reviewer on a code review council. Review the diff below for",
  "real defects: bugs, security holes, data loss, broken contracts, missing",
  "tests for changed behaviour. Do not edit any file.",
];

const LINE_FORMAT = [
  "Answer with one JSON object per line and nothing else:",
  '{"path":"<file>","line":<number>,"severity":"high|medium|low","title":"<one line>","detail":"<why, and the fix>"}',
  `If you find nothing, answer exactly: ${NO_FINDINGS}`,
];

const SCHEMA_FORMAT = [
  "Answer with one JSON object and nothing else:",
  '{"findings":[{"path":"<file>","line":<number>,"severity":"high|medium|low","title":"<one line>","detail":"<why, and the fix>"}]}',
  'If you find nothing, answer exactly: {"findings":[]}',
];

export function capDiff(diff: string, cap = DIFF_CAP): string {
  return diff.length > cap ? `${diff.slice(0, cap)}\n[council: diff cut at ${cap} of ${diff.length} characters]\n` : diff;
}

export function promptOf(input: ReviewInput, format: "lines" | "schema" = "lines"): string {
  const answer = format === "schema" ? SCHEMA_FORMAT : LINE_FORMAT;
  return [...INTRO, ...answer, input.question === undefined ? "" : `\nThe owner asks: ${input.question}`, `\n<diff>\n${capDiff(input.diff)}\n</diff>\n`].join("\n");
}

function instructionOf(promptPath: string): string {
  return `Read the file ${promptPath} and review the diff it contains. Its first lines say how to answer. Do not edit any file.`;
}

export function printTimeoutOf(timeoutMs: number): string {
  return `${Math.max(1, Math.floor(timeoutMs / 1000))}s`;
}

const CODEX_READ_ONLY = ["-c", 'sandbox_mode="read-only"'];

export function commandOf(name: CouncilMemberName, input: ReviewInput, promptPath: string, timeoutMs: number): MemberCommand {
  switch (name) {
    case "codex":
      return input.question === undefined
        ? { argv: ["codex", "exec", "review", ...CODEX_READ_ONLY, "--uncommitted", "--ephemeral"] }
        : { argv: ["codex", "exec", "review", ...CODEX_READ_ONLY, "--ephemeral", "-"], stdin: promptOf(input) };
    case "kimi":
      return { argv: ["kimi", "-p", instructionOf(promptPath), "--output-format", "text"], promptFile: promptOf(input) };
    case "antigravity":
      return {
        argv: ["agy", "--print", instructionOf(promptPath), "--mode", "plan", "--sandbox", "--output-format", "json", "--json-schema", AGY_FINDINGS_SCHEMA, "--print-timeout", printTimeoutOf(timeoutMs)],
        promptFile: promptOf(input, "schema"),
      };
  }
}
