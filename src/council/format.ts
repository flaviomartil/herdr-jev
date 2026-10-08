import type { CouncilItem, CouncilSummary } from "./synth-types.js";
import type { CouncilMemberResult, CouncilRun } from "./types.js";

export const COUNCIL_EVIDENCE_RULE = [
  "Evidence rule: each finding below is a candidate, not a fact.",
  "A finding counts only with evidence: a failing test or command, a measurement, or a concrete scenario with file:line.",
  "Reproduce a finding before fixing it.",
  "\"Approved with no findings\" is a valid result.",
].join(" ");

function pct(value: number): string {
  return value.toFixed(2);
}

function formatItem(item: CouncilItem): string {
  const real = item.real === undefined ? "" : ` (real ${pct(item.real)})`;
  return `- [${item.members.join(", ")}] ${item.location} - ${item.text}${real}`;
}

function section(title: string, items: CouncilItem[]): string[] {
  if (!items.length) return [];
  return ["", `${title} (${items.length})`, ...items.map(formatItem)];
}

function memberLine(result: CouncilMemberResult): string {
  const seconds = (result.durationMs / 1000).toFixed(1);
  if (result.status === "done") {
    return `- ${result.member}: done, ${result.findings.length} finding(s), ${seconds}s`;
  }
  const reason = result.reason ? `: ${result.reason}` : "";
  return `- ${result.member}: ${result.status}${reason}`;
}

export function formatCouncilSummary(summary: CouncilSummary, run: CouncilRun): string {
  const lines: string[] = [COUNCIL_EVIDENCE_RULE];

  const total =
    summary.agreements.length + summary.disagreements.length + summary.unique.length + summary.notes.length;
  if (!run.ran) {
    lines.push("", `Council did not run${run.note ? `: ${run.note}` : "."}`);
  } else if (total === 0) {
    lines.push("", "No findings reported by the council.");
  } else {
    lines.push(
      "",
      summary.scoredBy === "jev"
        ? "Findings were scored and grouped with TypeSafe Jev."
        : "Findings were not scored or grouped.",
    );
  }

  lines.push(
    ...section("Agreements", summary.agreements),
    ...section("Disagreements", summary.disagreements),
    ...section("Unique findings", summary.unique),
    ...section("Notes, below the real-defect threshold", summary.notes),
  );

  if (summary.messages.length) {
    lines.push("", "Notes on this summary", ...summary.messages.map((m) => `- ${m}`));
  }

  if (run.ran && run.note) lines.push("", `Run note: ${run.note}`);

  if (run.members.length) {
    lines.push("", "Members", ...run.members.map(memberLine));
  }

  return lines.join("\n");
}
