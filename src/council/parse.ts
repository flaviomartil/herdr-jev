import { posix } from "node:path";
import { NO_FINDINGS } from "./members.js";
import type { CouncilFinding, CouncilMemberName } from "./types.js";

export interface MemberOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ParseResult = { findings: CouncilFinding[]; note?: string } | { error: string };

export interface ParseOptions {
  question?: boolean;
}

const MAX_TITLE = 160;
const MAX_DETAIL = 4000;
const MAX_NOTE = 600;
const CODEX_HEAD = /^- (?:\[[ x]\] )?(.+) — (.+):(\d+)(?:-\d+)?$/u;
const PRIORITY = /^\[P(\d)\]\s*/u;
const NO_FINDINGS_LINE = new RegExp(`^${NO_FINDINGS}\\.?$`, "u");
const BULLET = /^[•*-]\s+(?=\S)/u;
const ERROR_LINE = /^error\b/iu;
const ENVELOPE_TEXT_KEYS = ["result", "response", "text", "output", "content", "message"] as const;
const ENVELOPE_ERROR_KEYS = ["error", "error_message", "errorMessage"] as const;

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
  if (value === "") return "";
  for (const root of roots) {
    const normalized = root.replace(/\\/gu, "/").replace(/\/+$/u, "");
    if (normalized && value.startsWith(`${normalized}/`)) {
      value = value.slice(normalized.length + 1);
      break;
    }
  }
  const clean = posix.normalize(value);
  if (clean === "." || clean.startsWith("/") || /^[A-Za-z]:\//u.test(clean) || clean === ".." || clean.startsWith("../")) return "";
  return clean;
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

function lastLineOf(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .at(-1) ?? ""
  );
}

function failureLine(stderr: string, stdout: string): string {
  const errors = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => ERROR_LINE.test(line));
  return errors.at(-1) ?? (lastLineOf(stderr) || lastLineOf(stdout) || "no output");
}

function codexFindings(stdout: string, roots: readonly string[]): CouncilFinding[] {
  const found: CouncilFinding[] = [];
  for (const block of stdout.split(/\n(?=- )/u)) {
    const [first = "", ...body] = block.split("\n");
    const head = CODEX_HEAD.exec(first.trimEnd());
    if (!head) continue;
    const [, rawTitle = "", path = "", line = "0"] = head;
    const finding: CouncilFinding = {
      member: "codex",
      path: relativePath(path, roots),
      severity: severityOfPriority(PRIORITY.exec(rawTitle)?.[1]),
      title: rawTitle.replace(PRIORITY, "").slice(0, MAX_TITLE),
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

function listFindings(member: CouncilMemberName, list: unknown[], roots: readonly string[]): ParseResult {
  const findings = list.flatMap((entry) => {
    const finding = findingOf(member, entry, roots);
    return finding ? [finding] : [];
  });
  if (findings.length === 0 && list.length > 0) return { error: `${member}: malformed output, findings without title` };
  return { findings };
}

function findingsArray(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).findings)) return (value as Record<string, unknown>).findings as unknown[];
  return undefined;
}

function structuredText(member: CouncilMemberName, text: string, roots: readonly string[], strict: boolean): ParseResult {
  const trimmed = text.trim();
  if (trimmed === "") return { error: `${member}: empty output` };
  const whole = tryJson(trimmed);
  if (whole.ok) {
    const list = findingsArray(whole.value);
    if (list) return listFindings(member, list, roots);
  }
  const lines = trimmed.split("\n").map((line) => line.trim().replace(BULLET, ""));
  const candidates = lines.filter((line) => line.startsWith("{"));
  if (candidates.length === 0) {
    if (NO_FINDINGS_LINE.test(lastLineOf(lines.join("\n")))) return { findings: [] };
    if (strict) return { error: `${member}: output is neither findings nor ${NO_FINDINGS}` };
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
  if (findings.length === 0) {
    if (NO_FINDINGS_LINE.test(lastLineOf(lines.join("\n")))) return { findings: [] };
    return { error: `${member}: malformed output, ${rejected} unreadable JSON line${rejected === 1 ? "" : "s"}` };
  }
  return rejected > 0 ? { findings, note: `${rejected} unreadable line${rejected === 1 ? "" : "s"} skipped` } : { findings };
}

function envelopeError(value: Record<string, unknown>): string | undefined {
  if (value.is_error === true || value.isError === true || (typeof value.status === "string" && value.status.toLowerCase() === "error")) {
    for (const key of [...ENVELOPE_TEXT_KEYS, ...ENVELOPE_ERROR_KEYS]) {
      const text = textField(value, key);
      if (text) return text;
    }
    return "reported an error";
  }
  for (const key of ENVELOPE_ERROR_KEYS) {
    const field = value[key];
    if (typeof field === "string" && field.trim() !== "") return field.trim();
    if (field && typeof field === "object") return textField(field, "message") ?? "reported an error";
  }
  return undefined;
}

function envelopeResult(member: CouncilMemberName, stdout: string, roots: readonly string[]): ParseResult {
  const trimmed = stdout.trim();
  if (trimmed === "") return { error: `${member}: empty output` };
  const parsed = tryJson(trimmed);
  if (!parsed.ok) return { error: `${member}: malformed JSON output` };
  const value = parsed.value;
  const direct = findingsArray(value);
  if (direct) return listFindings(member, direct, roots);
  if (value && typeof value === "object") {
    const failure = envelopeError(value as Record<string, unknown>);
    if (failure) return { error: `${member}: ${failure}`.slice(0, 400) };
    const structured = findingsArray((value as Record<string, unknown>).structured_output);
    if (structured) return listFindings(member, structured, roots);
    for (const key of ENVELOPE_TEXT_KEYS) {
      const raw = (value as Record<string, unknown>)[key];
      if (raw && typeof raw === "object") {
        const nested = findingsArray(raw);
        if (nested) return listFindings(member, nested, roots);
        continue;
      }
      const inner = textField(value, key);
      if (inner !== undefined) return structuredText(member, inner, roots, true);
    }
  }
  return { error: `${member}: JSON output has no readable result` };
}

export function parseMemberOutput(member: CouncilMemberName, run: MemberOutput, roots: readonly string[], options: ParseOptions = {}): ParseResult {
  if (run.exitCode !== 0) return { error: `${member}: exit ${run.exitCode}: ${failureLine(run.stderr, run.stdout)}`.slice(0, 400) };
  if (member === "codex") {
    const structured = codexFindings(run.stdout, roots);
    if (structured.length > 0) return { findings: structured };
    if (options.question) return structuredText(member, run.stdout, roots, false);
    const prose = run.stdout.trim();
    return prose === "" ? { findings: [] } : { findings: [], note: prose.slice(0, MAX_NOTE) };
  }
  if (member === "antigravity") return envelopeResult(member, run.stdout, roots);
  return structuredText(member, run.stdout, roots, false);
}
