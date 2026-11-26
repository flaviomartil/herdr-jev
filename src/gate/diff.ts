import { spawnSync } from "node:child_process";
import type { Fetch } from "@typesafe-ai/sdk";
import { isSensitivePath } from "../council/sensitive.js";
import { clean, clip, pathText, redact, redactShapes } from "../council/text.js";
import { resolveTypeSafeApiKey } from "../triage/client.js";
import {
  choice,
  evaluateQuestions,
  noul,
  score,
  type EvaluateResult,
  type JevQuestion,
  type QuestionType,
} from "../triage/evaluator.js";
import { JevError, ResilientJevClient } from "../triage/jev-client.js";
import { scoreQuantile } from "../triage/quantile.js";

export type DiffVerdict = "ship" | "revise" | "block";

export type DiffFileCategory = "source" | "test" | "config" | "docs" | "ci" | "lockfile" | "other";

export interface SecretFinding {
  file: string;
  line: number;
  rule: string;
}

export interface DiffFileSummary {
  path: string;
  extension: string;
  category: DiffFileCategory;
  additions: number;
  deletions: number;
  hunks: number;
  signals: string[];
}

export interface DiffStructuredSummary {
  message: string;
  filesChanged: number;
  additions: number;
  deletions: number;
  totalBytes: number;
  signals: string[];
  files: DiffFileSummary[];
}

export interface DiffGateOptions {
  cwd?: string;
  base?: string;
  staged?: boolean;
  stdin?: boolean;
  diffText?: string;
  message?: string;
  assertVerdict?: DiffVerdict;
  minP?: number;
  maxBytes?: number;
  timeoutMs?: number;
  includeRedactedDiff?: boolean;
  json?: boolean;
}

export interface DiffGateDeps {
  apiKey?: string | null;
  fetch?: Fetch;
  evaluate?: (state: string, questions: Record<string, JevQuestion>) => Promise<EvaluateResult>;
  readStdin?: () => Promise<string>;
}

export interface DiffGateDimensionResult {
  type: QuestionType;
  value: boolean | string | number;
  confidence: number;
  probability?: number;
}

export interface DiffGateResult {
  status: "passed" | "failed_assertion" | "blocked_secrets" | "error";
  exitCode: 0 | 1 | 2;
  valid: boolean;
  fallback: boolean;
  truncated: boolean;
  reason: string;
  assert: DiffVerdict;
  minP: number;
  verdict: DiffVerdict | null;
  verdictProbability: number | null;
  gate: DiffVerdict | null;
  dimensions: Record<string, DiffGateDimensionResult>;
  secrets: SecretFinding[];
  summary: DiffStructuredSummary | null;
  latencyMs: number;
  jevMs: number | null;
}

interface ParsedDiffFile {
  path: string;
  hunks: number;
  additions: Array<{ line: number; text: string }>;
  deletions: string[];
}

const VALID_VERDICTS: readonly DiffVerdict[] = ["ship", "revise", "block"];
const DEFAULT_MAX_BYTES = 64_000;
const MAX_REDACTED_DIFF_CHARS = 8_000;
const DEFAULT_MIN_P = 0.7;
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const KNOWN_SAFE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "java", "cs",
  "sh", "bash", "zsh", "sql", "json", "yaml", "yml", "toml", "ini", "cfg",
  "md", "mdx", "txt", "html", "css", "scss", "lock",
]);

export type CommitKind = "feat" | "fix" | "refactor" | "docs" | "test" | "chore" | "other" | "none";

export const DIFF_GATE_QUESTIONS: Record<string, JevQuestion> = {
  verdict: choice(
    "Classify the readiness verdict from this structural change metadata (no secrets were found locally). Clean scoped source/test fixes without risk signals should be ship; risky patterns without security danger should be revise; dangerous execution, eval, or auth bypass should be block.",
    {
      ship: "Routine, bounded source, SQL, CI, or test change with no risk signals or integrity issues.",
      revise: "Non-fatal quality or hygiene concern such as missing validation, silent fallback, outbound network addition, comment-only churn, or large untested deletion.",
      block: "Dangerous runtime pattern such as shell execution, dynamic eval, or auth/permission bypass.",
    },
  ),
  security_risk: noul(
    "Do the structural signals indicate concrete security danger (adds_shell_exec, adds_dynamic_eval, or modifies_auth_or_permissions)? Note: local secret scan already passed with 0 findings.",
  ),
  severity: score(
    "Rate the worst potential defect severity indicated by this change metadata (select None when risk signals are absent).",
    ["None", "Nit", "Should fix", "Block merge"],
  ),
  quality: score(
    "Rate overall structural engineering quality reflected by scope, bounded size, categories, and risk signals.",
    ["Broken", "Sloppy", "Acceptable", "Solid", "Exemplary"],
  ),
  slop: noul(
    "Does the structural metadata show low-substance churn such as only_whitespace_or_comments or empty value?",
  ),
  honest_message: noul(
    "Do the declared change kind and structural file categories/signals align plausibly (not e.g. declared docs while adding shell execution in source)?",
  ),
  kind: choice(
    "Identify the primary category of this software change.",
    {
      feature: "Adds new user-facing or runtime capability.",
      fix: "Repairs a defect or handles a failure mode.",
      refactor: "Reorganizes internal structure while keeping external behavior equivalent.",
      docs: "Documentation updates without behavioral code edits.",
      test: "Adds or adjusts automated tests only.",
      chore: "Build, dependencies, tooling, CI, or repository housekeeping.",
      initial: "Initial project bootstrap or foundational setup.",
    },
  ),
};

const SECRET_RULES: ReadonlyArray<{ rule: string; pattern: RegExp }> = [
  { rule: "private_key_pem", pattern: /-----BEGIN [A-Z0-9 ]{2,40}-----/ },
  { rule: "aws_access_key", pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/ },
  { rule: "github_token", pattern: /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{16,})\b/ },
  { rule: "gitlab_token", pattern: /\bglpat-[A-Za-z0-9_-]{16,}\b/ },
  { rule: "slack_token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { rule: "api_sk_token", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { rule: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { rule: "jwt_token", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { rule: "url_credentials", pattern: /[A-Za-z][A-Za-z0-9+.-]{1,20}:\/\/[^\s:@/]{1,128}:[^\s@/]{1,256}@/ },
  { rule: "bearer_token", pattern: /\bBearer[ \t]+(?=[A-Za-z0-9._~+/-]*\d)[A-Za-z0-9._~+/-]{16,}=*/i },
  { rule: "basic_auth", pattern: /\bBasic[ \t]+[A-Za-z0-9+/]{12,}={0,2}/ },
];

const KEYED_SECRET_NAME =
  /(?:token|password|passwd|pwd|secret|credential|api[_-]?key|access[_-]?key|account[_-]?key|private[_-]?key|bearer|authorization)/i;

function isDiffVerdict(value: unknown): value is DiffVerdict {
  return typeof value === "string" && (VALID_VERDICTS as readonly string[]).includes(value);
}

function unquoteGitPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return trimmed;
}

interface InspectedDiff {
  files: ParsedDiffFile[];
  hasIncompleteHunk: boolean;
  hasModeOrMetaChange: boolean;
}

const MODE_OR_META_LINE = /^(?:old mode |new mode |new file mode |deleted file mode |rename (?:from|to) |copy (?:from|to) |similarity index |dissimilarity index |Binary files )/;

export function inspectUnifiedDiff(rawDiff: string): InspectedDiff {
  const files: ParsedDiffFile[] = [];
  let current: ParsedDiffFile | null = null;
  let newLine = 0;
  let inHunk = false;
  let justClosedHunk = false;
  let sawHunkInFile = false;
  let sawOldHeader = false;
  let sawNewHeader = false;
  let remainingOld = 0;
  let remainingNew = 0;
  let hasIncompleteHunk = false;
  let hasModeOrMetaChange = false;

  const normalized = rawDiff.replace(/\r\n?/g, "\n");
  const trimmedTrailing = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  const lines = trimmedTrailing.length === 0 ? [] : trimmedTrailing.split("\n");

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (inHunk && (remainingOld > 0 || remainingNew > 0)) {
        hasIncompleteHunk = true;
      }
      inHunk = false;
      justClosedHunk = false;
      sawHunkInFile = false;
      sawOldHeader = false;
      sawNewHeader = false;
      remainingOld = 0;
      remainingNew = 0;
      const match = /^diff --git (?:"([^"]+)"|(\S+)) (?:"([^"]+)"|(\S+))$/.exec(line);
      const bPath = match ? (match[3] ?? match[4] ?? "") : "";
      const normalizedPath = bPath.startsWith("b/") ? bPath.slice(2) : bPath;
      current = {
        path: normalizedPath || "unknown",
        hunks: 0,
        additions: [],
        deletions: [],
      };
      files.push(current);
      newLine = 0;
      continue;
    }

    if (inHunk && (remainingOld > 0 || remainingNew > 0)) {
      if (line.startsWith("+")) {
        if (remainingNew === 0) {
          hasIncompleteHunk = true;
        } else {
          const lineNo = newLine > 0 ? newLine : (current?.additions.length ?? 0) + 1;
          current?.additions.push({ line: lineNo, text: line.slice(1) });
          newLine += 1;
          remainingNew -= 1;
        }
      } else if (line.startsWith("-")) {
        if (remainingOld === 0) {
          hasIncompleteHunk = true;
        } else {
          current?.deletions.push(line.slice(1));
          remainingOld -= 1;
        }
      } else if (line.startsWith(" ") || line === "") {
        if (remainingOld === 0 || remainingNew === 0) {
          hasIncompleteHunk = true;
        } else {
          newLine += 1;
          remainingOld -= 1;
          remainingNew -= 1;
        }
      } else if (line.startsWith("\\")) {
        continue;
      } else {
        hasIncompleteHunk = true;
        inHunk = false;
      }

      if (inHunk && remainingOld === 0 && remainingNew === 0) {
        inHunk = false;
        justClosedHunk = true;
      }
      if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") || line === "") {
        continue;
      }
    }

    if (justClosedHunk && line.startsWith("\\")) {
      justClosedHunk = false;
      continue;
    }
    justClosedHunk = false;

    if (!sawHunkInFile && line.startsWith("+++ ")) {
      if (sawNewHeader) {
        hasIncompleteHunk = true;
        continue;
      }
      sawNewHeader = true;
      const target = unquoteGitPath(line.slice(4));
      if (target !== "/dev/null") {
        const cleaned = target.startsWith("b/") ? target.slice(2) : target;
        if (!current) {
          current = { path: cleaned, hunks: 0, additions: [], deletions: [] };
          files.push(current);
        } else if (cleaned) {
          current.path = cleaned;
        }
      }
      continue;
    }

    if (!sawHunkInFile && MODE_OR_META_LINE.test(line)) {
      hasModeOrMetaChange = true;
      continue;
    }

    if (!sawHunkInFile && line.startsWith("--- ")) {
      if (sawOldHeader) {
        hasIncompleteHunk = true;
        continue;
      }
      sawOldHeader = true;
      continue;
    }

    if (!sawHunkInFile && line.startsWith("index ")) {
      continue;
    }

    if (line.startsWith("@@ ")) {
      sawHunkInFile = true;
      if (!current) {
        current = { path: "unknown", hunks: 0, additions: [], deletions: [] };
        files.push(current);
      }
      current.hunks += 1;
      const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!hunkMatch) {
        hasIncompleteHunk = true;
        inHunk = false;
        continue;
      }
      remainingOld = Number(hunkMatch[2] ?? "1");
      newLine = Number(hunkMatch[3]);
      remainingNew = Number(hunkMatch[4] ?? "1");
      if (remainingOld === 0 && remainingNew === 0) {
        hasIncompleteHunk = true;
        inHunk = false;
      } else {
        inHunk = true;
      }
      continue;
    }

    hasIncompleteHunk = true;
  }

  if (inHunk && (remainingOld > 0 || remainingNew > 0)) {
    hasIncompleteHunk = true;
  }

  return { files, hasIncompleteHunk, hasModeOrMetaChange };
}

export function parseUnifiedDiff(rawDiff: string): ParsedDiffFile[] {
  return inspectUnifiedDiff(rawDiff).files;
}

function lineHasSecret(text: string): boolean {
  for (const { pattern } of SECRET_RULES) {
    if (pattern.test(text)) return true;
  }
  if (redactShapes(text) !== text) return true;
  if (KEYED_SECRET_NAME.test(text) && redact(text) !== text) return true;
  return false;
}

function sanitizeFindingPath(file: string, maxLen = 200): string {
  if (lineHasSecret(file)) return "[redacted-path]";
  const clipped = pathText(file, maxLen);
  if (lineHasSecret(clipped)) return "[redacted-path]";
  return redact(clipped);
}

function scanLineForSecrets(
  file: string,
  line: number,
  text: string,
  pushFinding: (file: string, line: number, rule: string) => void,
): void {
  let matchedSpecific = false;
  for (const { rule, pattern } of SECRET_RULES) {
    if (pattern.test(text)) {
      pushFinding(file, line, rule);
      matchedSpecific = true;
    }
  }
  if (!matchedSpecific) {
    if (redactShapes(text) !== text) {
      pushFinding(file, line, "secret_shape");
    } else if (KEYED_SECRET_NAME.test(text) && redact(text) !== text) {
      pushFinding(file, line, "generic_secret");
    }
  }
}

export function scanDiffAdditions(rawDiff: string): SecretFinding[] {
  const parsed = parseUnifiedDiff(rawDiff);
  const findings: SecretFinding[] = [];
  const seen = new Set<string>();

  const pushFinding = (file: string, line: number, rule: string) => {
    const safeFile = sanitizeFindingPath(file, 200);
    const key = `${safeFile}:${line}:${rule}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ file: safeFile, line, rule });
  };

  for (const file of parsed) {
    if (file.additions.length === 0) continue;

    if (isSensitivePath(file.path)) {
      pushFinding(file.path, file.additions[0]?.line ?? 1, "sensitive_path");
    }

    for (const added of file.additions) {
      scanLineForSecrets(file.path, added.line, added.text, pushFinding);
    }
  }

  return findings;
}

export function scanDiffAllLines(rawDiff: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const seen = new Set<string>();

  const pushFinding = (file: string, line: number, rule: string) => {
    const safeFile = sanitizeFindingPath(file, 200);
    const key = `${safeFile}:${line}:${rule}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ file: safeFile, line, rule });
  };

  const normalized = rawDiff.replace(/\r\n?/g, "\n");
  const trimmedTrailing = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  const lines = trimmedTrailing.length === 0 ? [] : trimmedTrailing.split("\n");

  let currentFile = "unknown";
  let sawHunkInFile = false;
  let inHunk = false;
  let remainingOld = 0;
  let remainingNew = 0;
  let oldLine = 1;
  let newLine = 1;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      sawHunkInFile = false;
      remainingOld = 0;
      remainingNew = 0;
      const match = /^diff --git (?:"([^"]+)"|(\S+)) (?:"([^"]+)"|(\S+))$/.exec(line);
      const bPath = match ? (match[3] ?? match[4] ?? "") : "";
      currentFile = (bPath.startsWith("b/") ? bPath.slice(2) : bPath) || "unknown";
      if (isSensitivePath(currentFile)) {
        pushFinding(currentFile, 1, "sensitive_path");
      }
      scanLineForSecrets(currentFile, 1, line, pushFinding);
      continue;
    }

    if (!inHunk && !sawHunkInFile && line.startsWith("+++ ")) {
      const target = unquoteGitPath(line.slice(4));
      if (target !== "/dev/null") {
        currentFile = (target.startsWith("b/") ? target.slice(2) : target) || currentFile;
        if (isSensitivePath(currentFile)) {
          pushFinding(currentFile, 1, "sensitive_path");
        }
      }
      scanLineForSecrets(currentFile, 1, line, pushFinding);
      continue;
    }

    if (!inHunk && line.startsWith("@@ ")) {
      sawHunkInFile = true;
      const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
      if (hunkMatch) {
        oldLine = Number(hunkMatch[1]);
        remainingOld = Number(hunkMatch[2] ?? "1");
        newLine = Number(hunkMatch[3]);
        remainingNew = Number(hunkMatch[4] ?? "1");
        inHunk = remainingOld > 0 || remainingNew > 0;
        const trailer = hunkMatch[5]?.trim();
        if (trailer) {
          scanLineForSecrets(currentFile, newLine, trailer, pushFinding);
        }
      }
      continue;
    }

    if (inHunk) {
      if (line.startsWith("+")) {
        scanLineForSecrets(currentFile, newLine, line.slice(1), pushFinding);
        newLine += 1;
        if (remainingNew > 0) remainingNew -= 1;
      } else if (line.startsWith("-")) {
        scanLineForSecrets(currentFile, oldLine, line.slice(1), pushFinding);
        oldLine += 1;
        if (remainingOld > 0) remainingOld -= 1;
      } else if (line.startsWith(" ") || line === "") {
        scanLineForSecrets(currentFile, newLine, line.slice(1), pushFinding);
        oldLine += 1;
        newLine += 1;
        if (remainingOld > 0) remainingOld -= 1;
        if (remainingNew > 0) remainingNew -= 1;
      }
      if (remainingOld === 0 && remainingNew === 0) {
        inHunk = false;
      }
      continue;
    }

    scanLineForSecrets(currentFile, 1, line, pushFinding);
  }

  return findings;
}

function classifyFile(filePath: string): { extension: string; category: DiffFileCategory } {
  const lower = filePath.toLowerCase();
  const base = lower.split("/").pop() ?? lower;
  const dot = base.lastIndexOf(".");
  const extension = dot > 0 ? base.slice(dot + 1) : "";

  if (
    base === "bun.lock" ||
    base === "package-lock.json" ||
    base === "yarn.lock" ||
    base === "pnpm-lock.yaml" ||
    base === "uv.lock" ||
    base === "poetry.lock" ||
    base === "cargo.lock"
  ) {
    return { extension, category: "lockfile" };
  }
  if (
    lower.includes("/test/") ||
    lower.includes("/tests/") ||
    lower.startsWith("test/") ||
    lower.startsWith("tests/") ||
    /\.(test|spec)\.[^/]+$/.test(base) ||
    /^test_/.test(base) ||
    /_test\.py$/.test(base)
  ) {
    return { extension, category: "test" };
  }
  if (
    lower.startsWith(".github/") ||
    lower.startsWith(".git/hooks/") ||
    base === "dockerfile" ||
    base === "makefile" ||
    extension === "yml" && lower.includes("workflow")
  ) {
    return { extension, category: "ci" };
  }
  if (extension === "md" || extension === "mdx" || extension === "txt" || lower.startsWith("docs/")) {
    return { extension, category: "docs" };
  }
  if (
    extension === "json" ||
    extension === "yaml" ||
    extension === "yml" ||
    extension === "toml" ||
    extension === "ini" ||
    extension === "cfg" ||
    extension === "env"
  ) {
    return { extension, category: "config" };
  }
  if (
    ["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "java", "cs", "sh", "bash", "zsh", "sql"].includes(extension)
  ) {
    return { extension, category: "source" };
  }
  return { extension, category: "other" };
}

function isCommentOrBlank(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  return t.startsWith("//") || t.startsWith("#") || t.startsWith("/*") || t.startsWith("*") || t.startsWith("*/");
}

function extractFileSignals(file: ParsedDiffFile, category: DiffFileCategory): string[] {
  const signals = new Set<string>();
  const addedJoined = file.additions.map((a) => a.text).join("\n");
  const deletedJoined = file.deletions.join("\n");

  if (category === "test" && file.additions.length > 0) {
    signals.add("adds_tests");
  }
  if (category === "ci") {
    signals.add("touches_ci_or_hooks");
  }
  if (/\b(?:execSync|spawnSync|execFileSync|child_process|subprocess|os\.system)\b/.test(addedJoined)) {
    signals.add("adds_shell_exec");
  }
  if (/\beval\s*\(|\bnew Function\b/.test(addedJoined)) {
    signals.add("adds_dynamic_eval");
  }
  if (/\bfetch\s*\(|\baxios\b|\bhttps?\.request\b|\brequests\./.test(addedJoined)) {
    signals.add("adds_network_call");
  }
  if (/(?:auth|permission|rbac|jwt|oauth|bypass)/i.test(`${file.path}\n${addedJoined}`)) {
    signals.add("modifies_auth_or_permissions");
  }
  if (/\b(?:SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|MATCH\s*\(|MERGE\s*\()\b/i.test(addedJoined)) {
    signals.add("modifies_sql_or_db");
  }
  if (
    /(?:response_format|strict|jsonschema|validate|assert|schema|if\s*\(!|throw\s+new|raise\s+)/i.test(deletedJoined) &&
    file.deletions.length > 0
  ) {
    signals.add("removes_validation_or_checks");
  }
  if (
    /\.get\([^)\n]+,\s*["'][^"']*["']\)|catch\s*(?:\([^)\n]*\))?\s*\{\s*\}|except[^:\n]*:\s*pass\b/.test(addedJoined)
  ) {
    signals.add("adds_silent_default_fallback");
  }
  const changedLines = [...file.additions.map((a) => a.text), ...file.deletions];
  if (changedLines.length > 0 && changedLines.every(isCommentOrBlank)) {
    signals.add("only_whitespace_or_comments");
  }
  if (file.deletions.length >= 100 && file.deletions.length > file.additions.length * 2) {
    signals.add("large_deletion");
  }

  return [...signals];
}

export function buildDiffSummary(rawDiff: string, message = ""): DiffStructuredSummary {
  const parsed = parseUnifiedDiff(rawDiff);
  const globalSignals = new Set<string>();
  let totalAdditions = 0;
  let totalDeletions = 0;

  const files: DiffFileSummary[] = parsed.map((file) => {
    const { extension, category } = classifyFile(file.path);
    const signals = extractFileSignals(file, category);
    for (const sig of signals) globalSignals.add(sig);
    totalAdditions += file.additions.length;
    totalDeletions += file.deletions.length;
    return {
      path: pathText(file.path, 200),
      extension,
      category,
      additions: file.additions.length,
      deletions: file.deletions.length,
      hunks: file.hunks,
      signals,
    };
  });

  if (totalDeletions >= 100 && totalDeletions > totalAdditions * 2) {
    globalSignals.add("large_deletion");
  }

  return {
    message: clip(clean(redact(message)), 300),
    filesChanged: files.length,
    additions: totalAdditions,
    deletions: totalDeletions,
    totalBytes: Buffer.byteLength(rawDiff, "utf-8"),
    signals: [...globalSignals],
    files,
  };
}

export function classifyCommitMessageKind(message: string): CommitKind {
  const trimmed = clean(message).toLowerCase();
  if (!trimmed) return "none";
  const prefix = /^(feat|fix|refactor|docs|test|chore)(?:\([^)]*\))?!?:\s*/.exec(trimmed);
  if (prefix) return prefix[1] as CommitKind;
  if (/^(add|implement|create|support|enable)\b/.test(trimmed)) return "feat";
  if (/^(fix|guard|resolve|prevent|handle|repair|hotfix)\b/.test(trimmed)) return "fix";
  if (/^(refactor|extract|simplify|clean ?up|rename|move)\b/.test(trimmed)) return "refactor";
  if (/^(docs?|document|readme)\b/.test(trimmed)) return "docs";
  if (/^(tests?|spec)\b/.test(trimmed)) return "test";
  if (/^(chore|ci|build|deps|bump|lint|format)\b/.test(trimmed)) return "chore";
  return "other";
}

export function sanitizeExtensionForJev(extension: string): string {
  const cleanExt = extension.trim().toLowerCase();
  if (!cleanExt) return "none";
  return KNOWN_SAFE_EXTENSIONS.has(cleanExt) ? cleanExt : "other";
}

export function hasValidUnifiedDiffStructure(rawDiff: string, _parsed?: ParsedDiffFile[]): boolean {
  const inspected = inspectUnifiedDiff(rawDiff);
  if (inspected.files.length === 0 || inspected.hasIncompleteHunk) return false;
  if (inspected.files.some((f) => f.hunks > 0)) return true;
  return /^diff --git /m.test(rawDiff) && inspected.hasModeOrMetaChange;
}

export function buildJevState(
  summary: DiffStructuredSummary,
  rawDiff: string,
  includeRedactedDiff = false,
): string {
  const declaredKind = classifyCommitMessageKind(summary.message);
  const categories = [...new Set(summary.files.map((f) => f.category))];
  const extensions = [...new Set(summary.files.map((f) => sanitizeExtensionForJev(f.extension)).filter((e) => e !== "none"))];
  const totalHunks = summary.files.reduce((acc, f) => acc + f.hunks, 0);
  const fileProfiles = summary.files.map((f) => ({
    category: f.category,
    extension: sanitizeExtensionForJev(f.extension),
    additions: f.additions,
    deletions: f.deletions,
    hunks: f.hunks,
    signals: f.signals,
  }));

  const payload: Record<string, unknown> = {
    declaredKind,
    filesChanged: summary.filesChanged,
    categories,
    extensions,
    additions: summary.additions,
    deletions: summary.deletions,
    hunks: totalHunks,
    totalBytes: summary.totalBytes,
    localSecretScan: "0_findings",
    signals: summary.signals,
    fileProfiles,
  };
  if (includeRedactedDiff) {
    payload.redactedDiff = redact(rawDiff);
  }
  return redact(JSON.stringify(payload));
}

function readGitCommitMessage(cwd: string, base?: string): string {
  const args = base
    ? ["log", "--format=%s", "-n", "5", "--end-of-options", `${base}..HEAD`]
    : ["log", "-1", "--format=%s"];
  const res = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (res.status !== 0 || !res.stdout) return "";
  return clean(res.stdout).slice(0, 300);
}

function resolveDefaultBaseRef(cwd: string): string {
  const hasHead = spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd, encoding: "utf-8" });
  if (hasHead.status !== 0) return EMPTY_TREE_SHA;
  const hasPrev = spawnSync("git", ["rev-parse", "--verify", "HEAD~1"], { cwd, encoding: "utf-8" });
  if (hasPrev.status === 0) return "HEAD~1";
  return EMPTY_TREE_SHA;
}

function loadGitDiff(
  options: DiffGateOptions,
  maxBytes: number,
): { ok: true; diffText: string; message: string } | { ok: false; truncated: boolean; reason: string } {
  const cwd = options.cwd ?? process.cwd();
  const maxBuffer = Math.max(maxBytes * 4, 2_000_000);

  if (options.staged) {
    const res = spawnSync("git", ["diff", "--cached", "--no-color", "--unified=3"], {
      cwd,
      encoding: "utf-8",
      maxBuffer,
    });
    if ((res.error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS") {
      return { ok: false, truncated: true, reason: "diff_truncated" };
    }
    if (res.status !== 0) {
      return { ok: false, truncated: false, reason: "git_diff_failed" };
    }
    const message = options.message ?? readGitCommitMessage(cwd);
    return { ok: true, diffText: res.stdout ?? "", message };
  }

  const base = options.base ?? resolveDefaultBaseRef(cwd);
  const verify = base === EMPTY_TREE_SHA
    ? { status: 0 }
    : spawnSync("git", ["rev-parse", "--verify", "--end-of-options", base], { cwd, encoding: "utf-8" });
  if (verify.status !== 0) {
    return { ok: false, truncated: false, reason: "invalid_base_ref" };
  }

  let res = base === EMPTY_TREE_SHA
    ? spawnSync("git", ["diff", "--no-color", "--unified=3", "--end-of-options", EMPTY_TREE_SHA, "HEAD"], {
        cwd,
        encoding: "utf-8",
        maxBuffer,
      })
    : spawnSync("git", ["diff", "--no-color", "--unified=3", "--end-of-options", `${base}...HEAD`], {
        cwd,
        encoding: "utf-8",
        maxBuffer,
      });

  if (res.status !== 0 && base !== EMPTY_TREE_SHA && (res.error as NodeJS.ErrnoException | undefined)?.code !== "ENOBUFS") {
    res = spawnSync("git", ["diff", "--no-color", "--unified=3", "--end-of-options", base], {
      cwd,
      encoding: "utf-8",
      maxBuffer,
    });
  }

  if ((res.error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS") {
    return { ok: false, truncated: true, reason: "diff_truncated" };
  }
  if (res.status !== 0) {
    return { ok: false, truncated: false, reason: "git_diff_failed" };
  }

  const message = options.message ?? (base === EMPTY_TREE_SHA ? readGitCommitMessage(cwd) : readGitCommitMessage(cwd, base));
  return { ok: true, diffText: res.stdout ?? "", message };
}

async function readStreamStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function buildPayloadQuestions(questions: Record<string, JevQuestion>): Record<string, any> {
  const payload: Record<string, any> = {};
  for (const [key, q] of Object.entries(questions)) {
    if (q.type === "noul") {
      payload[key] = { type: "noul", instructions: q.instructions };
    } else if (q.type === "choice") {
      payload[key] = { type: "choice", instructions: q.instructions, criteria: q.criteria };
    } else if (q.type === "score") {
      payload[key] = {
        type: "score",
        instructions: q.instructions,
        criteria: q.criteria ?? q.levels ?? [],
      };
    }
  }
  return payload;
}

function isFiniteProb(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function getScoreMaxLevel(q: Extract<JevQuestion, { type: "score" }>): number {
  const levels = Array.isArray(q.criteria) ? q.criteria : Object.keys(q.criteria ?? {});
  return Math.max(0, levels.length - 1);
}

function validateScoreAnswer(
  q: Extract<JevQuestion, { type: "score" }>,
  rawAns: { score?: unknown; probabilities?: unknown } | undefined,
): number | null {
  if (!rawAns || typeof rawAns !== "object") return null;
  const maxLevel = getScoreMaxLevel(q);

  if (rawAns.probabilities !== undefined) {
    const probs = rawAns.probabilities;
    if (!probs || typeof probs !== "object" || Array.isArray(probs)) return null;
    const entries = Object.entries(probs as Record<string, unknown>);
    if (entries.length === 0) return null;
    let sum = 0;
    for (const [k, v] of entries) {
      if (!/^(?:0|[1-9]\d*)$/.test(k)) return null;
      const lvl = Number(k);
      if (!Number.isInteger(lvl) || lvl < 0 || lvl > maxLevel) return null;
      if (!isFiniteProb(v)) return null;
      sum += v;
    }
    if (sum < 0.95 || sum > 1.05) return null;
    const scoreVal = scoreQuantile(probs as Record<string, number>, 0.6);
    if (!Number.isFinite(scoreVal) || scoreVal < 0 || scoreVal > maxLevel) return null;
    return scoreVal;
  }

  if (typeof rawAns.score === "number" && Number.isFinite(rawAns.score)) {
    if (rawAns.score < 0 || rawAns.score > maxLevel) return null;
    return rawAns.score;
  }
  return null;
}

function parseClientOutcome(
  questions: Record<string, JevQuestion>,
  answersData: Record<string, any> | undefined,
  jevMs: number,
): EvaluateResult | null {
  if (!answersData || typeof answersData !== "object") return null;
  const parsed: EvaluateResult["answers"] = {};
  for (const [key, q] of Object.entries(questions)) {
    const rawAns = answersData[key];
    if (!rawAns || typeof rawAns !== "object") return null;
    if (q.type === "noul") {
      if (!isFiniteProb(rawAns.noul)) return null;
      const prob = rawAns.noul;
      parsed[key] = {
        type: "noul",
        value: prob >= 0.5,
        confidence: Math.abs(prob - 0.5) * 2,
        raw: rawAns,
      };
    } else if (q.type === "choice") {
      const choiceVal = rawAns.choice;
      const probs = rawAns.probabilities as Record<string, unknown> | undefined;
      if (typeof choiceVal !== "string" || !(choiceVal in q.criteria)) return null;
      const prob = probs?.[choiceVal];
      const conf = isFiniteProb(prob) ? prob : isFiniteProb(rawAns.confidence) ? rawAns.confidence : null;
      if (conf === null) return null;
      if (key === "verdict" && !isFiniteProb(prob)) return null;
      parsed[key] = {
        type: "choice",
        value: choiceVal,
        confidence: conf,
        raw: rawAns,
      };
    } else if (q.type === "score") {
      const scoreVal = validateScoreAnswer(q, rawAns);
      if (scoreVal === null) return null;
      const conf = isFiniteProb(rawAns.confidence) ? rawAns.confidence : scoreVal / Math.max(1, getScoreMaxLevel(q));
      parsed[key] = {
        type: "score",
        value: scoreVal,
        confidence: Number.isFinite(conf) ? conf : 0,
        raw: rawAns,
      };
    }
  }
  return {
    answers: parsed,
    fallback: false,
    latencyMs: Math.round(jevMs),
  };
}

function validateAndExtractDimensions(
  questions: Record<string, JevQuestion>,
  evalResult: EvaluateResult,
): Record<string, DiffGateDimensionResult> | null {
  if (!evalResult || !evalResult.answers || typeof evalResult.answers !== "object") return null;
  const dimensions: Record<string, DiffGateDimensionResult> = {};

  for (const [key, q] of Object.entries(questions)) {
    const ans = evalResult.answers[key];
    if (!ans || ans.type !== q.type) return null;
    const raw = ans.raw as
      | { noul?: unknown; choice?: unknown; score?: unknown; confidence?: unknown; probabilities?: Record<string, unknown> }
      | undefined;

    if (q.type === "noul") {
      if (!isFiniteProb(raw?.noul)) return null;
      dimensions[key] = {
        type: "noul",
        value: ans.value === true,
        confidence: Number.isFinite(ans.confidence) ? ans.confidence : Math.abs(raw.noul - 0.5) * 2,
        probability: raw.noul,
      };
    } else if (q.type === "choice") {
      if (typeof ans.value !== "string" || !(ans.value in q.criteria)) return null;
      const prob = raw?.probabilities?.[ans.value];
      if (key === "verdict" && !isFiniteProb(prob)) return null;
      const resolvedProb = isFiniteProb(prob)
        ? prob
        : isFiniteProb(raw?.confidence)
          ? raw.confidence
          : isFiniteProb(ans.confidence)
            ? ans.confidence
            : null;
      if (resolvedProb === null) return null;
      dimensions[key] = {
        type: "choice",
        value: redact(ans.value),
        confidence: isFiniteProb(ans.confidence) ? ans.confidence : resolvedProb,
        ...(isFiniteProb(prob) ? { probability: prob } : {}),
      };
    } else if (q.type === "score") {
      const maxLevel = getScoreMaxLevel(q);
      if (typeof ans.value !== "number" || !Number.isFinite(ans.value) || ans.value < 0 || ans.value > maxLevel) {
        return null;
      }
      const validated = validateScoreAnswer(q, raw);
      if (validated === null) return null;
      dimensions[key] = {
        type: "score",
        value: validated,
        confidence: Number.isFinite(ans.confidence) ? ans.confidence : 0,
      };
    }
  }

  return dimensions;
}

function errorResult(
  assertVerdict: DiffVerdict,
  minP: number,
  reason: string,
  startedAt: number,
  extra: Partial<DiffGateResult> = {},
): DiffGateResult {
  return {
    status: "error",
    exitCode: 2,
    valid: false,
    fallback: false,
    truncated: false,
    reason,
    assert: assertVerdict,
    minP,
    verdict: null,
    verdictProbability: null,
    gate: null,
    dimensions: {},
    secrets: [],
    summary: null,
    latencyMs: Date.now() - startedAt,
    jevMs: null,
    ...extra,
  };
}

export async function runDiffGate(options: DiffGateOptions = {}, deps: DiffGateDeps = {}): Promise<DiffGateResult> {
  const startedAt = Date.now();
  const assertVerdict = options.assertVerdict ?? "ship";
  const minP = options.minP ?? DEFAULT_MIN_P;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  if (!isDiffVerdict(assertVerdict)) {
    return errorResult("ship", DEFAULT_MIN_P, "invalid_assert_verdict", startedAt);
  }
  if (!Number.isFinite(minP) || minP < 0 || minP > 1) {
    return errorResult(assertVerdict, DEFAULT_MIN_P, "invalid_min_p", startedAt);
  }
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    return errorResult(assertVerdict, minP, "invalid_max_bytes", startedAt);
  }
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    return errorResult(assertVerdict, minP, "invalid_timeout_ms", startedAt);
  }

  let rawDiff = "";
  let message = options.message ?? "";

  if (options.diffText !== undefined) {
    rawDiff = options.diffText;
  } else if (options.stdin) {
    const reader = deps.readStdin ?? readStreamStdin;
    rawDiff = await reader();
  } else {
    const gitLoaded = loadGitDiff(options, maxBytes);
    if (!gitLoaded.ok) {
      return errorResult(assertVerdict, minP, gitLoaded.reason, startedAt, { truncated: gitLoaded.truncated });
    }
    rawDiff = gitLoaded.diffText;
    message = gitLoaded.message;
  }

  if (rawDiff.trim().length === 0) {
    return errorResult(assertVerdict, minP, "empty_diff", startedAt);
  }

  if (Buffer.byteLength(rawDiff, "utf-8") > maxBytes) {
    return errorResult(assertVerdict, minP, "diff_truncated", startedAt, { truncated: true });
  }

  const parsed = parseUnifiedDiff(rawDiff);
  if (!hasValidUnifiedDiffStructure(rawDiff, parsed)) {
    return errorResult(assertVerdict, minP, "invalid_diff_format", startedAt);
  }

  const secrets = options.includeRedactedDiff
    ? scanDiffAllLines(rawDiff)
    : scanDiffAdditions(rawDiff);
  if (secrets.length > 0) {
    return errorResult(assertVerdict, minP, "secrets_detected", startedAt, {
      status: "blocked_secrets",
      gate: "block",
      secrets,
    });
  }

  const summary = buildDiffSummary(rawDiff, message);
  if (options.includeRedactedDiff && redact(rawDiff).length > MAX_REDACTED_DIFF_CHARS) {
    return errorResult(assertVerdict, minP, "diff_truncated", startedAt, {
      truncated: true,
      summary,
    });
  }

  const state = buildJevState(summary, rawDiff, Boolean(options.includeRedactedDiff));

  let evalResult: EvaluateResult;
  if (deps.evaluate) {
    try {
      evalResult = await deps.evaluate(state, DIFF_GATE_QUESTIONS);
    } catch {
      return errorResult(assertVerdict, minP, "jev_unavailable", startedAt, { fallback: true, summary });
    }
  } else {
    const resolvedKey = deps.apiKey === null ? null : (deps.apiKey ?? resolveTypeSafeApiKey());
    if (!resolvedKey && !deps.fetch) {
      return errorResult(assertVerdict, minP, "missing_key", startedAt, { fallback: true, summary });
    }
    try {
      const client = new ResilientJevClient({
        apiKey: resolvedKey,
        deadlineMs: options.timeoutMs,
        fetch: deps.fetch,
      });
      const outcome = await client.ask(state, buildPayloadQuestions(DIFF_GATE_QUESTIONS));
      const parsed = parseClientOutcome(
        DIFF_GATE_QUESTIONS,
        outcome.answers as Record<string, any> | undefined,
        outcome.jevMs,
      );
      if (!parsed) {
        return errorResult(assertVerdict, minP, "incomplete_or_invalid_jev_response", startedAt, {
          fallback: false,
          summary,
          jevMs: Number.isFinite(outcome.jevMs) ? Math.round(outcome.jevMs) : null,
        });
      }
      evalResult = parsed;
    } catch (error) {
      const reason = error instanceof JevError && error.failure === "deadline"
        ? "timeout"
        : error instanceof JevError && error.failure === "missing_key"
          ? "missing_key"
          : "jev_unavailable";
      return errorResult(assertVerdict, minP, reason, startedAt, { fallback: true, summary });
    }
  }

  if (evalResult.fallback) {
    return errorResult(assertVerdict, minP, "fallback_disallowed", startedAt, {
      fallback: true,
      summary,
      jevMs: Number.isFinite(evalResult.latencyMs) ? evalResult.latencyMs : null,
    });
  }

  const dimensions = validateAndExtractDimensions(DIFF_GATE_QUESTIONS, evalResult);
  if (!dimensions) {
    return errorResult(assertVerdict, minP, "incomplete_or_invalid_jev_response", startedAt, {
      summary,
      jevMs: Number.isFinite(evalResult.latencyMs) ? evalResult.latencyMs : null,
    });
  }

  const verdict = dimensions.verdict.value as DiffVerdict;
  const verdictProbability = dimensions.verdict.probability;
  const securityRiskProb = dimensions.security_risk.probability;
  if (verdictProbability === undefined || securityRiskProb === undefined) {
    return errorResult(assertVerdict, minP, "incomplete_or_invalid_jev_response", startedAt, {
      summary,
      jevMs: Number.isFinite(evalResult.latencyMs) ? evalResult.latencyMs : null,
    });
  }

  const gate: DiffVerdict = securityRiskProb >= 0.7 ? "block" : verdict;

  const passed = gate === assertVerdict && verdict === assertVerdict && verdictProbability >= minP;
  return {
    status: passed ? "passed" : "failed_assertion",
    exitCode: passed ? 0 : 1,
    valid: true,
    fallback: false,
    truncated: false,
    reason: passed ? "assertion_satisfied" : gate !== assertVerdict ? "gate_mismatch" : "below_min_p",
    assert: assertVerdict,
    minP,
    verdict,
    verdictProbability,
    gate,
    dimensions,
    secrets: [],
    summary,
    latencyMs: Date.now() - startedAt,
    jevMs: Number.isFinite(evalResult.latencyMs) ? evalResult.latencyMs : null,
  };
}

export function formatDiffGateHuman(result: DiffGateResult): string {
  const lines = [
    `diff-gate status=${result.status} exit=${result.exitCode} gate=${result.gate ?? "none"} verdict=${result.verdict ?? "none"} p=${result.verdictProbability !== null ? result.verdictProbability.toFixed(3) : "n/a"} assert=${result.assert} min_p=${result.minP.toFixed(2)} reason=${redact(result.reason)}`,
  ];
  if (result.secrets.length > 0) {
    const locations = result.secrets.map((s) => `${sanitizeFindingPath(s.file, 120)}:${s.line}[${s.rule}]`).join(", ");
    lines.push(`secrets: ${locations}`);
  }
  if (result.summary) {
    const sigs = result.summary.signals.length > 0 ? result.summary.signals.join(",") : "none";
    lines.push(
      `summary: files=${result.summary.filesChanged} +${result.summary.additions}/-${result.summary.deletions} bytes=${result.summary.totalBytes} signals=${sigs}`,
    );
  }
  lines.push(`latency_ms=${result.latencyMs} jev_ms=${result.jevMs ?? "n/a"} valid=${result.valid} fallback=${result.fallback} truncated=${result.truncated}`);
  lines.push("note: structural metadata hygiene pre-filter only; ship does not replace code review.");
  return lines.join("\n");
}

export async function diffGateCli(options: DiffGateOptions = {}, deps: DiffGateDeps = {}): Promise<number> {
  const result = await runDiffGate(options, deps);
  if (options.json) {
    console.log(redact(JSON.stringify(result)));
  } else {
    console.log(formatDiffGateHuman(result));
  }
  return result.exitCode;
}
