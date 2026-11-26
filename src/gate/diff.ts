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
const DEFAULT_MIN_P = 0.7;
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export const DIFF_GATE_QUESTIONS: Record<string, JevQuestion> = {
  verdict: choice(
    "Classify the readiness verdict for this code change summary before human or frontier review.",
    {
      ship: "Focused, consistent, safe, and free of obvious defects or unaddressed risks.",
      revise: "Intent is valid, but issues such as missing validation, risky fallback, weak tests, or message mismatch need fixes.",
      block: "Dangerous, introduces security exposure, breaks integrity invariants, or leaves critical behavior unsound.",
    },
  ),
  security_risk: noul(
    "Does this summary indicate potential security exposure such as command execution, dynamic evaluation, weakened auth/permissions, or credential handling risk?",
  ),
  severity: score(
    "Rate the worst potential defect severity indicated by this change summary (select None if clean).",
    ["None", "Nit", "Should fix", "Block merge"],
  ),
  quality: score(
    "Rate overall structural engineering quality reflected by scope, modularity, checks, and test coverage.",
    ["Broken", "Sloppy", "Acceptable", "Solid", "Exemplary"],
  ),
  slop: noul(
    "Does this change appear to be low-substance churn, superficial edits, or noisy boilerplate without meaningful engineering value?",
  ),
  honest_message: noul(
    "Do the commit/change message and the structural file/signal summary align accurately?",
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

export function parseUnifiedDiff(rawDiff: string): ParsedDiffFile[] {
  const files: ParsedDiffFile[] = [];
  let current: ParsedDiffFile | null = null;
  let newLine = 0;

  const lines = rawDiff.replace(/\r\n?/g, "\n").split("\n");
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git (?:"([^"]+)"|(\S+)) (?:"([^"]+)"|(\S+))$/.exec(line);
      const bPath = match ? (match[3] ?? match[4] ?? "") : "";
      const normalized = bPath.startsWith("b/") ? bPath.slice(2) : bPath;
      current = {
        path: normalized || "unknown",
        hunks: 0,
        additions: [],
        deletions: [],
      };
      files.push(current);
      newLine = 0;
      continue;
    }

    if (line.startsWith("+++ ")) {
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

    if (line.startsWith("--- ") || line.startsWith("index ") || line.startsWith("new file ") || line.startsWith("deleted file ")) {
      continue;
    }

    if (line.startsWith("@@ ")) {
      if (!current) {
        current = { path: "unknown", hunks: 0, additions: [], deletions: [] };
        files.push(current);
      }
      current.hunks += 1;
      const hunkMatch = /\+(\d+)(?:,\d+)?\s+@@/.exec(line);
      newLine = hunkMatch ? Number(hunkMatch[1]) : 1;
      continue;
    }

    if (!current) continue;

    if (line.startsWith("+") && !line.startsWith("+++")) {
      const content = line.slice(1);
      const lineNo = newLine > 0 ? newLine : current.additions.length + 1;
      current.additions.push({ line: lineNo, text: content });
      newLine += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      current.deletions.push(line.slice(1));
    } else if (line.startsWith(" ")) {
      newLine += 1;
    }
  }

  return files;
}

export function scanDiffAdditions(rawDiff: string): SecretFinding[] {
  const parsed = parseUnifiedDiff(rawDiff);
  const findings: SecretFinding[] = [];
  const seen = new Set<string>();

  const pushFinding = (file: string, line: number, rule: string) => {
    const safeFile = pathText(file, 200);
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
      let matchedSpecific = false;
      for (const { rule, pattern } of SECRET_RULES) {
        if (pattern.test(added.text)) {
          pushFinding(file.path, added.line, rule);
          matchedSpecific = true;
        }
      }
      if (!matchedSpecific) {
        if (redactShapes(added.text) !== added.text) {
          pushFinding(file.path, added.line, "secret_shape");
        } else if (KEYED_SECRET_NAME.test(added.text) && redact(added.text) !== added.text) {
          pushFinding(file.path, added.line, "generic_secret");
        }
      }
    }
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

export function buildJevState(summary: DiffStructuredSummary, rawDiff: string, includeRedactedDiff = false): string {
  const payload: Record<string, unknown> = {
    summary,
  };
  if (includeRedactedDiff) {
    payload.redactedDiff = clip(redact(rawDiff), 8_000);
  }
  return redact(JSON.stringify(payload));
}

function readGitCommitMessage(cwd: string, base?: string): string {
  const args = base
    ? ["log", "--format=%s", "-n", "5", `${base}..HEAD`]
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
    : spawnSync("git", ["rev-parse", "--verify", base], { cwd, encoding: "utf-8" });
  if (verify.status !== 0) {
    return { ok: false, truncated: false, reason: "invalid_base_ref" };
  }

  let res = base === EMPTY_TREE_SHA
    ? spawnSync("git", ["diff", "--no-color", "--unified=3", EMPTY_TREE_SHA, "HEAD"], {
        cwd,
        encoding: "utf-8",
        maxBuffer,
      })
    : spawnSync("git", ["diff", "--no-color", "--unified=3", `${base}...HEAD`], {
        cwd,
        encoding: "utf-8",
        maxBuffer,
      });

  if (res.status !== 0 && base !== EMPTY_TREE_SHA && (res.error as NodeJS.ErrnoException | undefined)?.code !== "ENOBUFS") {
    res = spawnSync("git", ["diff", "--no-color", "--unified=3", base], {
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

function parseClientOutcome(
  questions: Record<string, JevQuestion>,
  answersData: Record<string, any> | undefined,
  jevMs: number,
): EvaluateResult | null {
  if (!answersData) return null;
  const parsed: EvaluateResult["answers"] = {};
  for (const [key, q] of Object.entries(questions)) {
    const rawAns = answersData[key];
    if (!rawAns) continue;
    if (q.type === "noul") {
      const prob = typeof rawAns.noul === "number" ? rawAns.noul : 0.5;
      parsed[key] = {
        type: "noul",
        value: prob >= 0.5,
        confidence: Math.abs(prob - 0.5) * 2,
        raw: rawAns,
      };
    } else if (q.type === "choice") {
      parsed[key] = {
        type: "choice",
        value: rawAns.choice ?? Object.keys(q.criteria)[0] ?? "",
        confidence: rawAns.confidence ?? 0.75,
        raw: rawAns,
      };
    } else if (q.type === "score") {
      let scoreVal = typeof rawAns.score === "number" ? rawAns.score : 0.5;
      if (rawAns.probabilities) {
        scoreVal = scoreQuantile(rawAns.probabilities, 0.6);
      }
      parsed[key] = {
        type: "score",
        value: scoreVal,
        confidence: rawAns.confidence ?? 0.75,
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

function extractDimensions(evalResult: EvaluateResult): Record<string, DiffGateDimensionResult> {
  const dimensions: Record<string, DiffGateDimensionResult> = {};
  for (const [key, ans] of Object.entries(evalResult.answers)) {
    const raw = ans.raw as { noul?: unknown; probabilities?: Record<string, unknown> } | undefined;
    let probability: number | undefined;
    if (ans.type === "noul" && typeof raw?.noul === "number" && Number.isFinite(raw.noul)) {
      probability = raw.noul;
    } else if (ans.type === "choice" && raw?.probabilities && typeof ans.value === "string") {
      const p = raw.probabilities[ans.value];
      if (typeof p === "number" && Number.isFinite(p)) {
        probability = p;
      }
    }
    dimensions[key] = {
      type: ans.type,
      value: typeof ans.value === "string" ? redact(ans.value) : ans.value,
      confidence: Number.isFinite(ans.confidence) ? ans.confidence : 0,
      ...(probability !== undefined ? { probability } : {}),
    };
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

  const secrets = scanDiffAdditions(rawDiff);
  if (secrets.length > 0) {
    return errorResult(assertVerdict, minP, "secrets_detected", startedAt, {
      status: "blocked_secrets",
      gate: "block",
      secrets,
    });
  }

  const summary = buildDiffSummary(rawDiff, message);
  const state = buildJevState(summary, rawDiff, Boolean(options.includeRedactedDiff));

  let evalResult: EvaluateResult;
  if (deps.evaluate) {
    try {
      evalResult = await deps.evaluate(state, DIFF_GATE_QUESTIONS);
    } catch {
      return errorResult(assertVerdict, minP, "jev_unavailable", startedAt, { fallback: true, summary });
    }
  } else if (deps.fetch !== undefined || options.timeoutMs !== undefined) {
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
        return errorResult(assertVerdict, minP, "invalid_jev_response", startedAt, { fallback: true, summary });
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
  } else {
    evalResult = await evaluateQuestions(state, DIFF_GATE_QUESTIONS, deps.apiKey);
  }

  if (evalResult.fallback) {
    return errorResult(assertVerdict, minP, "fallback_disallowed", startedAt, {
      fallback: true,
      summary,
      jevMs: Number.isFinite(evalResult.latencyMs) ? evalResult.latencyMs : null,
      dimensions: extractDimensions(evalResult),
    });
  }

  const verdictAns = evalResult.answers.verdict;
  if (!verdictAns || !isDiffVerdict(verdictAns.value)) {
    return errorResult(assertVerdict, minP, "invalid_verdict", startedAt, {
      summary,
      jevMs: Number.isFinite(evalResult.latencyMs) ? evalResult.latencyMs : null,
      dimensions: extractDimensions(evalResult),
    });
  }

  const verdict = verdictAns.value;
  const rawVerdict = verdictAns.raw as { probabilities?: Record<string, unknown> } | undefined;
  const rawProb = rawVerdict?.probabilities?.[verdict];
  const verdictProbability = typeof rawProb === "number" && Number.isFinite(rawProb)
    ? rawProb
    : verdictAns.confidence;

  if (!Number.isFinite(verdictProbability) || verdictProbability < 0 || verdictProbability > 1) {
    return errorResult(assertVerdict, minP, "invalid_verdict_probability", startedAt, {
      summary,
      jevMs: Number.isFinite(evalResult.latencyMs) ? evalResult.latencyMs : null,
      dimensions: extractDimensions(evalResult),
    });
  }

  const dimensions = extractDimensions(evalResult);
  const securityRiskProb = dimensions.security_risk?.probability
    ?? (dimensions.security_risk?.value === true ? dimensions.security_risk.confidence : 0);
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
    const locations = result.secrets.map((s) => `${pathText(s.file, 120)}:${s.line}[${s.rule}]`).join(", ");
    lines.push(`secrets: ${locations}`);
  }
  if (result.summary) {
    const sigs = result.summary.signals.length > 0 ? result.summary.signals.join(",") : "none";
    lines.push(
      `summary: files=${result.summary.filesChanged} +${result.summary.additions}/-${result.summary.deletions} bytes=${result.summary.totalBytes} signals=${sigs}`,
    );
  }
  lines.push(`latency_ms=${result.latencyMs} jev_ms=${result.jevMs ?? "n/a"} valid=${result.valid} fallback=${result.fallback} truncated=${result.truncated}`);
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
