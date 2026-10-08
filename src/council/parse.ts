import { NO_FINDINGS } from "./members.js";
import type { CouncilFinding, CouncilMemberName } from "./types.js";

export interface MemberOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ParseResult = { findings: CouncilFinding[]; note?: string } | { error: string };

const MAX_TITLE = 160;
const MAX_DETAIL = 4000;
const CODEX_HEAD = /^- (?:\[[ x]\] )?(.+) — (.+):(\d+)(?:-\d+)?$/u;
const PRIORITY = /^\[P(\d)\]\s*/u;
const ENVELOPE_TEXT_KEYS = ["result", "response", "text", "output", "content", "message"] as const;

type Severity = CouncilFinding["severity"];

function severityOf(value: unknown): Severity {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (["high", "critical", "blocker", "error", "major", "p0", "p1"].includes(text)) return "high";
  if (["low", "minor", "nit", "info", "p3", "p4"].includes(text)) return "low";
  return "medium";
}

function severityOfPriority(digit: string | undefined): Severity {
  if (digit === "0" || digit === "1") return "high";
  if (digit === "3" || digit === "4") return "low";
  return "medium";
}

export function relativePath(path: string, roots: readonly string[]): string {
  let value = path.trim().replace(/\\/gu, "/");
  for (const root of roots) {
    const normalized = root.replace(/\\/gu, "/").replace(/\/+$/u, "");
    if (normalized && value.startsWith(`${normalized}/`)) {
      value = value.slice(normalized.length + 1);
      break;
    }
  }
  return value.replace(/^\.\//u, "");
}

function textField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.trim() !== "" ? field.trim() : undefined;
}

function lineField(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = (value as Record<string, unknown>).line;
  const line = typeof raw === "string" ? Number(raw) : raw;
  return typeof line === "number" && Number.isSafeInteger(line) && line > 0 ? line : undefined;
}

function tryJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function findingOf(member: CouncilMemberName, value: unknown, roots: readonly string[]): CouncilFinding | undefined {
  const title = textField(value, "title");
  if (!title) return undefined;
  const finding: CouncilFinding = {
    member,
    path: relativePath(textField(value, "path") ?? textField(value, "file") ?? "", roots),
    severity: severityOf((value as Record<string, unknown>).severity),
    title: title.slice(0, MAX_TITLE),
    detail: (textField(value, "detail") ?? "").slice(0, MAX_DETAIL),
  };
  const line = lineField(value);
  if (line !== undefined) finding.line = line;
  return finding;
}

function proseFinding(member: CouncilMemberName, text: string): CouncilFinding {
  return { member, path: "", severity: "medium", title: `${member}: unstructured review`, detail: text.slice(0, MAX_DETAIL) };
}

function codexFindings(stdout: string, roots: readonly string[]): CouncilFinding[] {
  const found: CouncilFinding[] = [];
  for (const block of stdout.split(/\n(?=- )/u)) {
    const [first = "", ...body] = block.split("\n");
    const head = CODEX_HEAD.exec(first.trimEnd());
    if (!head) continue;
    const [, rawTitle = "", path = "", line = "0"] = head;
    const title = rawTitle.replace(PRIORITY, "");
    const finding: CouncilFinding = {
      member: "codex",
      path: relativePath(path, roots),
      severity: severityOfPriority(PRIORITY.exec(rawTitle)?.[1]),
      title: title.slice(0, MAX_TITLE),
      detail: body
        .filter((text) => text.startsWith("  "))
        .map((text) => text.slice(2))
        .join("\n")
        .trim()
        .slice(0, MAX_DETAIL),
    };
    const parsedLine = Number(line);
    if (Number.isSafeInteger(parsedLine) && parsedLine > 0) finding.line = parsedLine;
    found.push(finding);
  }
  return found;
}

function textFindings(member: CouncilMemberName, text: string, roots: readonly string[]): ParseResult {
  const trimmed = text.trim();
  if (trimmed === "") return { error: `${member}: empty output` };
  const lines = trimmed.split("\n").map((line) => line.trim());
  const candidates = lines.filter((line) => line.startsWith("{"));
  if (candidates.length === 0) {
    if (lines.every((line) => line === "" || line === NO_FINDINGS)) return { findings: [] };
    return { findings: [proseFinding(member, trimmed)] };
  }
  const findings: CouncilFinding[] = [];
  let rejected = 0;
  for (const line of candidates) {
    const parsed = tryJson(line);
    const finding = parsed.ok ? findingOf(member, parsed.value, roots) : undefined;
    if (finding) findings.push(finding);
    else rejected += 1;
  }
  if (findings.length === 0) return { error: `${member}: malformed output, ${rejected} unreadable JSON line${rejected === 1 ? "" : "s"}` };
  return rejected > 0 ? { findings, note: `${rejected} unreadable line${rejected === 1 ? "" : "s"} skipped` } : { findings };
}

function envelopeResult(member: CouncilMemberName, stdout: string, roots: readonly string[]): ParseResult {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return textFindings(member, stdout, roots);
  const parsed = tryJson(trimmed);
  if (!parsed.ok) return { error: `${member}: malformed JSON output` };
  const value = parsed.value;
  const list = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).findings) ? ((value as Record<string, unknown>).findings as unknown[]) : undefined;
  if (list) {
    const findings = list.flatMap((entry) => {
      const finding = findingOf(member, entry, roots);
      return finding ? [finding] : [];
    });
    if (findings.length === 0 && list.length > 0) return { error: `${member}: malformed output, findings without title` };
    return { findings };
  }
  if (value && typeof value === "object") {
    if (findingOf(member, value, roots)) return textFindings(member, trimmed, roots);
    for (const key of ENVELOPE_TEXT_KEYS) {
      const inner = textField(value, key);
      if (inner !== undefined) return textFindings(member, inner, roots);
    }
  }
  return { error: `${member}: JSON output has no readable result` };
}

function lastLineOf(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .at(-1) ?? ""
  );
}

export function parseMemberOutput(member: CouncilMemberName, run: MemberOutput, roots: readonly string[]): ParseResult {
  if (run.exitCode !== 0) return { error: `${member}: exit ${run.exitCode}: ${lastLineOf(run.stderr) || lastLineOf(run.stdout) || "no output"}`.slice(0, 400) };
  if (member === "codex") {
    const structured = codexFindings(run.stdout, roots);
    return structured.length > 0 ? { findings: structured } : textFindings(member, run.stdout, roots);
  }
  if (member === "antigravity") return envelopeResult(member, run.stdout, roots);
  return textFindings(member, run.stdout, roots);
}
