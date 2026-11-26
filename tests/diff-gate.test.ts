import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDiffSummary,
  buildJevState,
  diffGateCli,
  formatDiffGateHuman,
  runDiffGate,
  scanDiffAdditions,
  type DiffVerdict,
} from "../src/gate/diff.js";
import type { EvaluateResult, JevQuestion } from "../src/triage/evaluator.js";

function makeEvaluateMock(
  verdict: DiffVerdict,
  probability: number,
  options: { securityRisk?: number; fallback?: boolean } = {},
) {
  let calls = 0;
  let lastState = "";
  let lastQuestions: Record<string, JevQuestion> = {};

  const evaluate = async (state: string, questions: Record<string, JevQuestion>): Promise<EvaluateResult> => {
    calls += 1;
    lastState = state;
    lastQuestions = questions;
    const secProb = options.securityRisk ?? 0.05;
    return {
      fallback: Boolean(options.fallback),
      latencyMs: 42,
      answers: {
        verdict: {
          type: "choice",
          value: verdict,
          confidence: probability,
          raw: {
            choice: verdict,
            confidence: probability,
            probabilities: {
              ship: verdict === "ship" ? probability : (1 - probability) / 2,
              revise: verdict === "revise" ? probability : (1 - probability) / 2,
              block: verdict === "block" ? probability : (1 - probability) / 2,
            },
          },
        },
        security_risk: {
          type: "noul",
          value: secProb >= 0.5,
          confidence: Math.abs(secProb - 0.5) * 2,
          raw: { noul: secProb },
        },
        severity: {
          type: "score",
          value: verdict === "ship" ? 0 : verdict === "revise" ? 2 : 3,
          confidence: 0.9,
          raw: { score: verdict === "ship" ? 0 : 2 },
        },
        quality: {
          type: "score",
          value: verdict === "ship" ? 3 : 1,
          confidence: 0.85,
          raw: { score: verdict === "ship" ? 3 : 1 },
        },
        slop: {
          type: "noul",
          value: false,
          confidence: 0.8,
          raw: { noul: 0.1 },
        },
        honest_message: {
          type: "noul",
          value: true,
          confidence: 0.9,
          raw: { noul: 0.95 },
        },
        kind: {
          type: "choice",
          value: "fix",
          confidence: 0.88,
          raw: { choice: "fix", confidence: 0.88 },
        },
      },
    };
  };

  return {
    evaluate,
    getCalls: () => calls,
    getLastState: () => lastState,
    getLastQuestions: () => lastQuestions,
  };
}

const CLEAN_FIX_DIFF = [
  "diff --git a/src/math.ts b/src/math.ts",
  "--- a/src/math.ts",
  "+++ b/src/math.ts",
  "@@ -1,3 +1,4 @@",
  " export function add(a: number, b: number): number {",
  "+  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new TypeError('invalid');",
  "   return a + b;",
  " }",
].join("\n");

describe("herdr-jev diff-gate", () => {
  test("blocks added secrets locally with exit 2 and never invokes Jev or leaks credential", async () => {
    const awsKey = "AKIA" + "IOSFODNN7EXAMPLE";
    const ghPat = "ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";
    const pemLine = "-----BEGIN " + "PRIVATE KEY-----";
    const diffWithSecrets = [
      "diff --git a/.env.production b/.env.production",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/.env.production",
      "@@ -0,0 +1,4 @@",
      `+AWS_KEY=${awsKey}`,
      `+GITHUB_TOKEN=${ghPat}`,
      `+${pemLine}`,
      "+API_PASSWORD=\"SuperSecretPass99!\"",
    ].join("\n");

    const mock = makeEvaluateMock("ship", 0.99);
    const result = await runDiffGate(
      { diffText: diffWithSecrets, message: "add env" },
      { evaluate: mock.evaluate },
    );

    expect(result.exitCode).toBe(2);
    expect(result.status).toBe("blocked_secrets");
    expect(result.valid).toBe(false);
    expect(result.gate).toBe("block");
    expect(result.reason).toBe("secrets_detected");
    expect(mock.getCalls()).toBe(0);
    expect(result.secrets.some((s) => s.rule === "sensitive_path")).toBe(true);
    expect(result.secrets.some((s) => s.rule === "aws_access_key")).toBe(true);
    expect(result.secrets.some((s) => s.rule === "github_token")).toBe(true);
    expect(result.secrets.some((s) => s.rule === "private_key_pem")).toBe(true);

    const serialized = JSON.stringify(result);
    const human = formatDiffGateHuman(result);
    expect(serialized).not.toContain(awsKey);
    expect(serialized).not.toContain(ghPat);
    expect(serialized).not.toContain("SuperSecretPass99");
    expect(human).not.toContain(awsKey);
    expect(human).not.toContain(ghPat);
  });

  test("ignores secrets only present in deleted lines", async () => {
    const removedSecret = "sk-" + "live1234567890abcdefghij1234";
    const diffRemovingSecret = [
      "diff --git a/src/auth.ts b/src/auth.ts",
      "--- a/src/auth.ts",
      "+++ b/src/auth.ts",
      "@@ -1,1 +1,1 @@",
      `-const key = "${removedSecret}";`,
      "+const key = process.env.SERVICE_KEY ?? '';",
    ].join("\n");

    expect(scanDiffAdditions(diffRemovingSecret)).toEqual([]);
    const mock = makeEvaluateMock("ship", 0.91);
    const result = await runDiffGate(
      { diffText: diffRemovingSecret, message: "remove hardcoded credential" },
      { evaluate: mock.evaluate },
    );
    expect(result.exitCode).toBe(0);
    expect(mock.getCalls()).toBe(1);
  });

  test("returns exit 2 when offline / missing API key", async () => {
    const result = await runDiffGate(
      { diffText: CLEAN_FIX_DIFF, message: "validate inputs" },
      { apiKey: null },
    );
    expect(result.exitCode).toBe(2);
    expect(result.fallback).toBe(true);
    expect(result.valid).toBe(false);
  });

  test("returns exit 2 when TypeSafe API fails with HTTP 500 or network error", async () => {
    const failingFetch = (async () => {
      return new Response(JSON.stringify({ error: "upstream down" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }) as any;

    const result = await runDiffGate(
      { diffText: CLEAN_FIX_DIFF, message: "validate inputs", timeoutMs: 200 },
      { apiKey: "ts-test-key", fetch: failingFetch },
    );
    expect(result.exitCode).toBe(2);
    expect(result.fallback).toBe(true);
    expect(result.reason).toBe("jev_unavailable");
  });

  test("returns exit 2 on Jev request timeout", async () => {
    const slowFetch = (async (_url: unknown, init?: RequestInit) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 250);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        });
      });
      return new Response("{}", { status: 200 });
    }) as any;

    const result = await runDiffGate(
      { diffText: CLEAN_FIX_DIFF, message: "validate inputs", timeoutMs: 30 },
      { apiKey: "ts-test-key", fetch: slowFetch },
    );
    expect(result.exitCode).toBe(2);
    expect(result.fallback).toBe(true);
    expect(result.reason).toBe("timeout");
  });

  test("returns exit 2 when evaluator returns fallback even if verdict says ship", async () => {
    const mock = makeEvaluateMock("ship", 0.99, { fallback: true });
    const result = await runDiffGate(
      { diffText: CLEAN_FIX_DIFF, message: "fix" },
      { evaluate: mock.evaluate },
    );
    expect(result.exitCode).toBe(2);
    expect(result.valid).toBe(false);
    expect(result.fallback).toBe(true);
    expect(result.reason).toBe("fallback_disallowed");
  });

  test("returns exit 2 when diff exceeds maxBytes and does not call Jev", async () => {
    const mock = makeEvaluateMock("ship", 0.95);
    const largeDiff = `${CLEAN_FIX_DIFF}\n@@ -10,0 +11,1 @@\n+// ${"x".repeat(500)}`;
    const result = await runDiffGate(
      { diffText: largeDiff, maxBytes: 128, message: "oversize" },
      { evaluate: mock.evaluate },
    );
    expect(result.exitCode).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("diff_truncated");
    expect(mock.getCalls()).toBe(0);
  });

  test("keeps raw private code lines local by default and emits no pre-written verdict in Jev state", async () => {
    const proprietaryMarker = "ProprietaryCoeff";
    const diff = [
      "diff --git a/src/proprietary.ts b/src/proprietary.ts",
      "--- a/src/proprietary.ts",
      "+++ b/src/proprietary.ts",
      "@@ -1,2 +1,4 @@",
      " export function compute(v: number): number {",
      `+  const ${proprietaryMarker} = v * 3.14159;`,
      `+  return ${proprietaryMarker};`,
      " }",
    ].join("\n");

    const mock = makeEvaluateMock("ship", 0.9);
    const result = await runDiffGate(
      { diffText: diff, message: "feat: secret compute multiplier ticket-9876" },
      { evaluate: mock.evaluate },
    );

    expect(result.exitCode).toBe(0);
    const state = mock.getLastState();
    expect(state).not.toContain(proprietaryMarker);
    expect(state).not.toContain("3.14159");
    expect(state).not.toContain('"verdict"');
    expect(state).not.toContain("src/proprietary.ts");
    expect(state).not.toContain("ticket-9876");
    expect(state).toContain('"declaredKind":"feat"');

    const summary = buildDiffSummary(diff, "feat: secret compute multiplier ticket-9876");
    const withRawState = buildJevState(summary, diff, true);
    expect(withRawState).toContain(proprietaryMarker);
  });

  test("rejects incomplete or invalid Jev responses with exit 2 and zero silent defaults", async () => {
    const missingSecRisk = await runDiffGate(
      { diffText: CLEAN_FIX_DIFF, message: "fix: add finite check" },
      {
        evaluate: async () => ({
          fallback: false,
          latencyMs: 25,
          answers: {
            verdict: {
              type: "choice",
              value: "ship",
              confidence: 0.9,
              raw: { choice: "ship", probabilities: { ship: 0.92, revise: 0.06, block: 0.02 } },
            },
            severity: { type: "score", value: 0, confidence: 0.9, raw: { score: 0 } },
            quality: { type: "score", value: 3, confidence: 0.9, raw: { score: 3 } },
            slop: { type: "noul", value: false, confidence: 0.8, raw: { noul: 0.1 } },
            honest_message: { type: "noul", value: true, confidence: 0.8, raw: { noul: 0.9 } },
            kind: { type: "choice", value: "fix", confidence: 0.9, raw: { choice: "fix", confidence: 0.9 } },
          },
        }),
      },
    );
    expect(missingSecRisk.exitCode).toBe(2);
    expect(missingSecRisk.valid).toBe(false);
    expect(missingSecRisk.reason).toBe("incomplete_or_invalid_jev_response");

    const missingVerdictProb = await runDiffGate(
      { diffText: CLEAN_FIX_DIFF, message: "fix: add finite check" },
      {
        evaluate: async () => ({
          fallback: false,
          latencyMs: 25,
          answers: {
            verdict: {
              type: "choice",
              value: "ship",
              confidence: 0.75,
              raw: { choice: "ship" },
            },
            security_risk: { type: "noul", value: false, confidence: 0.9, raw: { noul: 0.05 } },
            severity: { type: "score", value: 0, confidence: 0.9, raw: { score: 0 } },
            quality: { type: "score", value: 3, confidence: 0.9, raw: { score: 3 } },
            slop: { type: "noul", value: false, confidence: 0.8, raw: { noul: 0.1 } },
            honest_message: { type: "noul", value: true, confidence: 0.8, raw: { noul: 0.9 } },
            kind: { type: "choice", value: "fix", confidence: 0.9, raw: { choice: "fix", confidence: 0.9 } },
          },
        }),
      },
    );
    expect(missingVerdictProb.exitCode).toBe(2);
    expect(missingVerdictProb.valid).toBe(false);

    const partialFetch = (async () =>
      new Response(JSON.stringify({ answers: { verdict: { choice: "ship" } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as any;
    const partialRes = await runDiffGate(
      { diffText: CLEAN_FIX_DIFF, message: "fix: check" },
      { apiKey: "ts-test-key", fetch: partialFetch },
    );
    expect(partialRes.exitCode).toBe(2);
    expect(partialRes.valid).toBe(false);
    expect(partialRes.reason).toBe("incomplete_or_invalid_jev_response");
  });

  test("scans added lines beginning with ++ or +++ inside hunks before any network call", async () => {
    const ghPat = "ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";
    const diffWithPlusLines = [
      "diff --git a/src/banner.ts b/src/banner.ts",
      "--- a/src/banner.ts",
      "+++ b/src/banner.ts",
      "@@ -1,1 +1,3 @@",
      " export const ok = true;",
      `+++ marker token=${ghPat}`,
      "++ another added line",
    ].join("\n");

    const secrets = scanDiffAdditions(diffWithPlusLines);
    expect(secrets.some((s) => s.rule === "github_token")).toBe(true);

    const mock = makeEvaluateMock("ship", 0.95);
    const res = await runDiffGate(
      { diffText: diffWithPlusLines, message: "fix: banner" },
      { evaluate: mock.evaluate },
    );
    expect(res.exitCode).toBe(2);
    expect(res.status).toBe("blocked_secrets");
    expect(mock.getCalls()).toBe(0);
  });

  test("returns exit 2 with truncated=true when includeRedactedDiff exceeds 8000 chars", async () => {
    const mock = makeEvaluateMock("ship", 0.95);
    const body = Array.from({ length: 220 }, (_, i) => `+export const v${i} = ${i} * 1234567890;`).join("\n");
    const diff = [
      "diff --git a/src/big.ts b/src/big.ts",
      "--- a/src/big.ts",
      "+++ b/src/big.ts",
      "@@ -1,0 +1,220 @@",
      body,
    ].join("\n");

    const res = await runDiffGate(
      { diffText: diff, message: "feat: big table", maxBytes: 200_000, includeRedactedDiff: true },
      { evaluate: mock.evaluate },
    );
    expect(res.exitCode).toBe(2);
    expect(res.truncated).toBe(true);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("diff_truncated");
    expect(mock.getCalls()).toBe(0);
  });

  test("rejects unknown score keys, out-of-range scores, and invalid unified diff input with exit 2", async () => {
    const unknownKeyScore = await runDiffGate(
      { diffText: CLEAN_FIX_DIFF, message: "fix: check" },
      {
        evaluate: async () => ({
          fallback: false,
          latencyMs: 12,
          answers: {
            verdict: {
              type: "choice",
              value: "ship",
              confidence: 0.95,
              raw: { choice: "ship", probabilities: { ship: 0.95, revise: 0.04, block: 0.01 } },
            },
            security_risk: { type: "noul", value: false, confidence: 0.9, raw: { noul: 0.05 } },
            severity: { type: "score", value: 0, confidence: 0.9, raw: { probabilities: { bogus: 1.0 } } },
            quality: { type: "score", value: 3, confidence: 0.9, raw: { score: 3 } },
            slop: { type: "noul", value: false, confidence: 0.8, raw: { noul: 0.1 } },
            honest_message: { type: "noul", value: true, confidence: 0.9, raw: { noul: 0.9 } },
            kind: { type: "choice", value: "fix", confidence: 0.9, raw: { choice: "fix", confidence: 0.9 } },
          },
        }),
      },
    );
    expect(unknownKeyScore.exitCode).toBe(2);
    expect(unknownKeyScore.valid).toBe(false);

    const outOfRangeScore = await runDiffGate(
      { diffText: CLEAN_FIX_DIFF, message: "fix: check" },
      {
        evaluate: async () => ({
          fallback: false,
          latencyMs: 12,
          answers: {
            verdict: {
              type: "choice",
              value: "ship",
              confidence: 0.95,
              raw: { choice: "ship", probabilities: { ship: 0.95, revise: 0.04, block: 0.01 } },
            },
            security_risk: { type: "noul", value: false, confidence: 0.9, raw: { noul: 0.05 } },
            severity: { type: "score", value: 0, confidence: 0.9, raw: { score: 0 } },
            quality: { type: "score", value: 999, confidence: 0.9, raw: { score: 999 } },
            slop: { type: "noul", value: false, confidence: 0.8, raw: { noul: 0.1 } },
            honest_message: { type: "noul", value: true, confidence: 0.9, raw: { noul: 0.9 } },
            kind: { type: "choice", value: "fix", confidence: 0.9, raw: { choice: "fix", confidence: 0.9 } },
          },
        }),
      },
    );
    expect(outOfRangeScore.exitCode).toBe(2);
    expect(outOfRangeScore.valid).toBe(false);

    const mock = makeEvaluateMock("ship", 0.95);
    const badText = await runDiffGate(
      { diffText: "hello world this is plain prose, not a unified diff", message: "fix: nope" },
      { evaluate: mock.evaluate },
    );
    expect(badText.exitCode).toBe(2);
    expect(badText.valid).toBe(false);
    expect(badText.reason).toBe("invalid_diff_format");
    expect(mock.getCalls()).toBe(0);

    const hunkWithoutBody = await runDiffGate(
      {
        diffText: "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,2 @@",
        message: "fix: empty hunk",
      },
      { evaluate: mock.evaluate },
    );
    expect(hunkWithoutBody.exitCode).toBe(2);
    expect(hunkWithoutBody.valid).toBe(false);
    expect(hunkWithoutBody.reason).toBe("invalid_diff_format");
    expect(mock.getCalls()).toBe(0);

    const hunkWithoutDeclaredAddition = await runDiffGate(
      {
        diffText: "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,2 @@\n const a = 1;",
        message: "fix: truncated hunk",
      },
      { evaluate: mock.evaluate },
    );
    expect(hunkWithoutDeclaredAddition.exitCode).toBe(2);
    expect(hunkWithoutDeclaredAddition.valid).toBe(false);
    expect(hunkWithoutDeclaredAddition.reason).toBe("invalid_diff_format");
    expect(mock.getCalls()).toBe(0);

    const modeOnlyDiff = [
      "diff --git a/scripts/run.sh b/scripts/run.sh",
      "old mode 100644",
      "new mode 100755",
    ].join("\n");
    const modeRes = await runDiffGate(
      { diffText: modeOnlyDiff, message: "chore: mark script executable" },
      { evaluate: mock.evaluate },
    );
    expect(modeRes.exitCode).toBe(0);
    expect(modeRes.valid).toBe(true);
    expect(mock.getCalls()).toBe(1);

    const callsBeforeSurplus = mock.getCalls();
    const hunkWithExtraAddedLine = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,0 +1,1 @@",
      "+const ok = 1;",
      '+const leaked = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";',
    ].join("\n");
    const extraAddedRes = await runDiffGate(
      { diffText: hunkWithExtraAddedLine, message: "fix: add line" },
      { evaluate: mock.evaluate },
    );
    expect(extraAddedRes.exitCode).toBe(2);
    expect(extraAddedRes.valid).toBe(false);
    expect(extraAddedRes.reason).toBe("invalid_diff_format");

    const hunkWithExtraDeletedLine = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,1 +1,0 @@",
      "-old1",
      "-old2",
    ].join("\n");
    const extraDeletedRes = await runDiffGate(
      { diffText: hunkWithExtraDeletedLine, message: "fix: delete line" },
      { evaluate: mock.evaluate },
    );
    expect(extraDeletedRes.exitCode).toBe(2);
    expect(extraDeletedRes.valid).toBe(false);
    expect(extraDeletedRes.reason).toBe("invalid_diff_format");

    const hunkWithExtraContextLine = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      " extra",
    ].join("\n");
    const extraContextRes = await runDiffGate(
      { diffText: hunkWithExtraContextLine, message: "fix: context overflow" },
      { evaluate: mock.evaluate },
    );
    expect(extraContextRes.exitCode).toBe(2);
    expect(extraContextRes.valid).toBe(false);
    expect(extraContextRes.reason).toBe("invalid_diff_format");
    expect(mock.getCalls()).toBe(callsBeforeSurplus);

    const noNewlineValidDiff = [
      "diff --git a/src/x.ts b/src/x.ts",
      "--- a/src/x.ts",
      "+++ b/src/x.ts",
      "@@ -1,1 +1,1 @@",
      "-a",
      "+b",
      "\\ No newline at end of file",
    ].join("\n");
    const noNewlineRes = await runDiffGate(
      { diffText: noNewlineValidDiff, message: "fix: no newline" },
      { evaluate: mock.evaluate },
    );
    expect(noNewlineRes.exitCode).toBe(0);
    expect(noNewlineRes.valid).toBe(true);
    expect(mock.getCalls()).toBe(callsBeforeSurplus + 1);

    const callsAfterNoNewline = mock.getCalls();
    const headerLikeAddAfterHunk = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,0 +1,1 @@",
      "+const ok = 1;",
      "+++ b/src/hijacked.ts",
    ].join("\n");
    const headerLikeAddRes = await runDiffGate(
      { diffText: headerLikeAddAfterHunk, message: "fix: header-like surplus add" },
      { evaluate: mock.evaluate },
    );
    expect(headerLikeAddRes.exitCode).toBe(2);
    expect(headerLikeAddRes.valid).toBe(false);
    expect(headerLikeAddRes.reason).toBe("invalid_diff_format");

    const headerLikeDelAfterHunk = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,1 +1,0 @@",
      "-const old = 1;",
      "--- a/src/hijacked.ts",
    ].join("\n");
    const headerLikeDelRes = await runDiffGate(
      { diffText: headerLikeDelAfterHunk, message: "fix: header-like surplus del" },
      { evaluate: mock.evaluate },
    );
    expect(headerLikeDelRes.exitCode).toBe(2);
    expect(headerLikeDelRes.valid).toBe(false);
    expect(headerLikeDelRes.reason).toBe("invalid_diff_format");
    expect(mock.getCalls()).toBe(callsAfterNoNewline);

    const extDiff = [
      "diff --git a/src/internal.secret_marker_ext b/src/internal.secret_marker_ext",
      "--- a/src/internal.secret_marker_ext",
      "+++ b/src/internal.secret_marker_ext",
      "@@ -1,0 +1,1 @@",
      "+const ok = 1;",
    ].join("\n");
    const extMock = makeEvaluateMock("ship", 0.9);
    const extRes = await runDiffGate(
      { diffText: extDiff, message: "fix: safe check" },
      { evaluate: extMock.evaluate },
    );
    expect(extRes.exitCode).toBe(0);
    expect(extMock.getLastState()).not.toContain("secret_marker_ext");
    expect(extMock.getLastState()).toContain('"extension":"other"');
  });

  test("enforces assert and min-p contract including security_risk override", async () => {
    const passMock = makeEvaluateMock("ship", 0.85);
    const passRes = await runDiffGate(
      { diffText: CLEAN_FIX_DIFF, message: "add finite check", assertVerdict: "ship", minP: 0.8 },
      { evaluate: passMock.evaluate },
    );
    expect(passRes.exitCode).toBe(0);
    expect(passRes.status).toBe("passed");

    const lowProbMock = makeEvaluateMock("ship", 0.61);
    const lowProbRes = await runDiffGate(
      { diffText: CLEAN_FIX_DIFF, message: "add finite check", assertVerdict: "ship", minP: 0.7 },
      { evaluate: lowProbMock.evaluate },
    );
    expect(lowProbRes.exitCode).toBe(1);
    expect(lowProbRes.status).toBe("failed_assertion");
    expect(lowProbRes.reason).toBe("below_min_p");

    const reviseMock = makeEvaluateMock("revise", 0.9);
    const mismatchRes = await runDiffGate(
      { diffText: CLEAN_FIX_DIFF, message: "fix", assertVerdict: "ship", minP: 0.7 },
      { evaluate: reviseMock.evaluate },
    );
    expect(mismatchRes.exitCode).toBe(1);
    expect(mismatchRes.reason).toBe("gate_mismatch");

    const assertReviseRes = await runDiffGate(
      { diffText: CLEAN_FIX_DIFF, message: "fix", assertVerdict: "revise", minP: 0.7 },
      { evaluate: reviseMock.evaluate },
    );
    expect(assertReviseRes.exitCode).toBe(0);

    const secRiskMock = makeEvaluateMock("ship", 0.95, { securityRisk: 0.88 });
    const secRiskRes = await runDiffGate(
      { diffText: CLEAN_FIX_DIFF, message: "fix", assertVerdict: "ship", minP: 0.7 },
      { evaluate: secRiskMock.evaluate },
    );
    expect(secRiskRes.exitCode).toBe(1);
    expect(secRiskRes.gate).toBe("block");
  });

  test("benchmark fixture suite covers 11 known diff patterns including 6677053c structural regression", async () => {
    const fixtures: Array<{
      name: string;
      message: string;
      diff: string;
      verdict: DiffVerdict;
      probability: number;
      expectedSignals: string[];
      expectedExit: 0 | 1 | 2;
      securityRisk?: number;
    }> = [
      {
        name: "impmotordados-6677053c-schema-drop-and-default-fallback",
        message: "enable bedrock prompt caching on primary reader",
        diff: [
          "diff --git a/app/services/adaptador_openai_v3.py b/app/services/adaptador_openai_v3.py",
          "--- a/app/services/adaptador_openai_v3.py",
          "+++ b/app/services/adaptador_openai_v3.py",
          "@@ -10,1 +10,1 @@",
          "-    kwargs['response_format'] = strict_schema",
          "+    kwargs.pop('response_format', None)",
          "diff --git a/app/services/modelos_primario_v3.py b/app/services/modelos_primario_v3.py",
          "--- a/app/services/modelos_primario_v3.py",
          "+++ b/app/services/modelos_primario_v3.py",
          "@@ -140,1 +140,1 @@",
          "-    modo = payload['modo_bloco']",
          "+    modo = payload.get('modo_bloco', 'basicos')",
        ].join("\n"),
        verdict: "revise",
        probability: 0.86,
        expectedSignals: ["removes_validation_or_checks", "adds_silent_default_fallback"],
        expectedExit: 1,
      },
      {
        name: "small-validated-bugfix",
        message: "guard divide by zero in tax helper",
        diff: CLEAN_FIX_DIFF,
        verdict: "ship",
        probability: 0.92,
        expectedSignals: [],
        expectedExit: 0,
      },
      {
        name: "unit-test-addition",
        message: "add unit tests for quota expiration",
        diff: [
          "diff --git a/tests/quota.test.ts b/tests/quota.test.ts",
          "--- a/tests/quota.test.ts",
          "+++ b/tests/quota.test.ts",
          "@@ -1,0 +1,3 @@",
          "+test('expires quota', () => {",
          "+  expect(1).toBe(1);",
          "+});",
        ].join("\n"),
        verdict: "ship",
        probability: 0.96,
        expectedSignals: ["adds_tests"],
        expectedExit: 0,
      },
      {
        name: "unsafe-shell-exec-in-handler",
        message: "docs: fix typo",
        diff: [
          "diff --git a/src/routes/run.ts b/src/routes/run.ts",
          "--- a/src/routes/run.ts",
          "+++ b/src/routes/run.ts",
          "@@ -1,0 +1,2 @@",
          "+import { execSync } from 'node:child_process';",
          "+export const out = (cmd: string) => execSync(cmd);",
        ].join("\n"),
        verdict: "block",
        probability: 0.94,
        securityRisk: 0.93,
        expectedSignals: ["adds_shell_exec"],
        expectedExit: 1,
      },
      {
        name: "dynamic-eval-added",
        message: "parse expression dynamically",
        diff: [
          "diff --git a/src/eval.ts b/src/eval.ts",
          "--- a/src/eval.ts",
          "+++ b/src/eval.ts",
          "@@ -1,0 +1,1 @@",
          "+export const run = (src: string) => eval(src);",
        ].join("\n"),
        verdict: "block",
        probability: 0.91,
        securityRisk: 0.89,
        expectedSignals: ["adds_dynamic_eval"],
        expectedExit: 1,
      },
      {
        name: "auth-permission-bypass-tweak",
        message: "simplify admin middleware",
        diff: [
          "diff --git a/src/auth/middleware.ts b/src/auth/middleware.ts",
          "--- a/src/auth/middleware.ts",
          "+++ b/src/auth/middleware.ts",
          "@@ -1,1 +1,1 @@",
          "-if (!verifyJwt(req)) throw new Error('unauthorized');",
          "+export const authBypass = req.headers['x-bypass'] === '1';",
        ].join("\n"),
        verdict: "block",
        probability: 0.95,
        securityRisk: 0.95,
        expectedSignals: ["modifies_auth_or_permissions", "removes_validation_or_checks"],
        expectedExit: 1,
      },
      {
        name: "sql-query-modification",
        message: "filter active records in report query",
        diff: [
          "diff --git a/src/db/report.sql b/src/db/report.sql",
          "--- a/src/db/report.sql",
          "+++ b/src/db/report.sql",
          "@@ -1,0 +1,1 @@",
          "+SELECT id, name FROM jobs WHERE active = true;",
        ].join("\n"),
        verdict: "ship",
        probability: 0.84,
        expectedSignals: ["modifies_sql_or_db"],
        expectedExit: 0,
      },
      {
        name: "ci-workflow-touch",
        message: "ci: run bun test on pull requests",
        diff: [
          "diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml",
          "--- a/.github/workflows/ci.yml",
          "+++ b/.github/workflows/ci.yml",
          "@@ -1,0 +1,2 @@",
          "+on: [pull_request]",
          "+jobs: { test: { runs-on: ubuntu-latest } }",
        ].join("\n"),
        verdict: "ship",
        probability: 0.88,
        expectedSignals: ["touches_ci_or_hooks"],
        expectedExit: 0,
      },
      {
        name: "whitespace-slop-churn",
        message: "refactor core architecture",
        diff: [
          "diff --git a/src/index.ts b/src/index.ts",
          "--- a/src/index.ts",
          "+++ b/src/index.ts",
          "@@ -1,1 +1,1 @@",
          "-// old header",
          "+// updated header",
        ].join("\n"),
        verdict: "revise",
        probability: 0.82,
        expectedSignals: ["only_whitespace_or_comments"],
        expectedExit: 1,
      },
      {
        name: "outbound-network-fetch-addition",
        message: "send telemetry payload",
        diff: [
          "diff --git a/src/telemetry.ts b/src/telemetry.ts",
          "--- a/src/telemetry.ts",
          "+++ b/src/telemetry.ts",
          "@@ -1,0 +1,1 @@",
          "+export const ping = (u: string) => fetch(u);",
        ].join("\n"),
        verdict: "revise",
        probability: 0.78,
        expectedSignals: ["adds_network_call"],
        expectedExit: 1,
      },
      {
        name: "large-deletion-without-tests",
        message: "cleanup legacy parser",
        diff: [
          "diff --git a/src/legacy.ts b/src/legacy.ts",
          "--- a/src/legacy.ts",
          "+++ b/src/legacy.ts",
          "@@ -1,105 +1,1 @@",
          ...Array.from({ length: 105 }, (_, i) => `-const line${i} = ${i};`),
          "+export const empty = true;",
        ].join("\n"),
        verdict: "revise",
        probability: 0.81,
        expectedSignals: ["large_deletion"],
        expectedExit: 1,
      },
    ];

    for (const fx of fixtures) {
      const mock = makeEvaluateMock(fx.verdict, fx.probability, { securityRisk: fx.securityRisk });
      const res = await runDiffGate(
        { diffText: fx.diff, message: fx.message, assertVerdict: "ship", minP: 0.7 },
        { evaluate: mock.evaluate },
      );
      expect(res.exitCode, fx.name).toBe(fx.expectedExit);
      for (const sig of fx.expectedSignals) {
        expect(res.summary?.signals ?? [], `${fx.name} missing ${sig}`).toContain(sig);
      }
    }
  });

  test("CLI entrypoint returns real exit 2 on secrets, truncation, invalid assert, and offline fallback", async () => {
    const tempHome = mkdtempSync(join(tmpdir(), "diff-gate-home-"));
    const cliEnv = {
      ...process.env,
      HOME: tempHome,
      TYPESAFE_API_KEY: "",
      PATH: "/usr/bin:/bin",
    };

    const runCli = (args: string[], input: string) =>
      spawnSync(process.execPath, ["run", "src/cli.ts", "diff-gate", ...args], {
        cwd: `${import.meta.dir}/..`,
        input,
        encoding: "utf-8",
        env: cliEnv,
      });

    try {
      const secretRun = runCli(
        ["--stdin", "--json"],
        "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,0 +1,1 @@\n+const k = 'ghp_1234567890abcdefghijklmnop';\n",
      );
      expect(secretRun.status).toBe(2);
      expect(secretRun.stdout).not.toContain("ghp_1234567890");
      expect(JSON.parse(secretRun.stdout).reason).toBe("secrets_detected");

      const truncRun = runCli(["--stdin", "--json", "--max-bytes", "20"], CLEAN_FIX_DIFF);
      expect(truncRun.status).toBe(2);
      expect(JSON.parse(truncRun.stdout).truncated).toBe(true);

      const invalidAssertRun = runCli(["--stdin", "--json", "--assert", "merge"], CLEAN_FIX_DIFF);
      expect(invalidAssertRun.status).toBe(2);
      expect(JSON.parse(invalidAssertRun.stdout).reason).toBe("invalid_assert_verdict");

      const offlineRun = runCli(["--stdin", "--json"], CLEAN_FIX_DIFF);
      expect(offlineRun.status).toBe(2);
      expect(JSON.parse(offlineRun.stdout).fallback).toBe(true);

      const origLog = console.log;
      const captured: string[] = [];
      console.log = (...items: unknown[]) => captured.push(items.map(String).join(" "));
      try {
        const code = await diffGateCli(
          { diffText: CLEAN_FIX_DIFF, message: "valid fix", json: false },
          { evaluate: makeEvaluateMock("ship", 0.93).evaluate },
        );
        expect(code).toBe(0);
        expect(captured[0]).toContain("status=passed");
        expect(captured[0]).toContain("structural metadata hygiene pre-filter only; ship does not replace code review.");
      } finally {
        console.log = origLog;
      }

      const deletedSecretDiff = [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,2 +1,2 @@",
        "-const oldTok = 'ghp_1234567890abcdefghijklmnop';",
        " const unchanged = 1;",
        "+const newSafe = 2;",
      ].join("\n");
      const redactedDelMock = makeEvaluateMock("ship", 0.95);
      const redactedDelRes = await runDiffGate(
        { diffText: deletedSecretDiff, message: "cleanup old token", includeRedactedDiff: true },
        { evaluate: redactedDelMock.evaluate },
      );
      expect(redactedDelRes.exitCode).toBe(2);
      expect(redactedDelRes.status).toBe("blocked_secrets");
      expect(redactedDelRes.reason).toBe("secrets_detected");
      expect(redactedDelMock.getCalls()).toBe(0);

      const contextSecretDiff = [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,2 +1,3 @@",
        " const nearby = 'ghp_1234567890abcdefghijklmnop';",
        " const unchanged = 1;",
        "+const added = 2;",
      ].join("\n");
      const redactedCtxMock = makeEvaluateMock("ship", 0.95);
      const redactedCtxRes = await runDiffGate(
        { diffText: contextSecretDiff, message: "update nearby line", includeRedactedDiff: true },
        { evaluate: redactedCtxMock.evaluate },
      );
      expect(redactedCtxRes.exitCode).toBe(2);
      expect(redactedCtxRes.status).toBe("blocked_secrets");
      expect(redactedCtxRes.reason).toBe("secrets_detected");
      expect(redactedCtxMock.getCalls()).toBe(0);

      const binaryDiff = [
        "diff --git a/assets/logo.png b/assets/logo.png",
        "index 1111111..2222222 100644",
        "Binary files a/assets/logo.png and b/assets/logo.png differ",
      ].join("\n");
      const binaryMock = makeEvaluateMock("ship", 0.92);
      const binaryRes = await runDiffGate(
        { diffText: binaryDiff, message: "assets: update logo" },
        { evaluate: binaryMock.evaluate },
      );
      expect(binaryRes.exitCode).toBe(0);
      expect(binaryRes.valid).toBe(true);
      expect(binaryMock.getCalls()).toBe(1);

      const flagRefRes = await runDiffGate(
        { base: "--help", cwd: `${import.meta.dir}/..` },
        { evaluate: makeEvaluateMock("ship", 0.95).evaluate },
      );
      expect(flagRefRes.exitCode).toBe(2);
      expect(flagRefRes.reason).toBe("invalid_base_ref");

      const headerPathSecretDiff = [
        "diff --git a/src/ghp_1234567890abcdefghijklmnop.ts b/src/ghp_1234567890abcdefghijklmnop.ts",
        "--- a/src/ghp_1234567890abcdefghijklmnop.ts",
        "+++ b/src/ghp_1234567890abcdefghijklmnop.ts",
        "@@ -1,0 +1,1 @@",
        "+const clean = true;",
      ].join("\n");
      const headerPathMock = makeEvaluateMock("ship", 0.95);
      const headerPathRes = await runDiffGate(
        { diffText: headerPathSecretDiff, message: "chore: clean file", includeRedactedDiff: true },
        { evaluate: headerPathMock.evaluate },
      );
      expect(headerPathRes.exitCode).toBe(2);
      expect(headerPathRes.status).toBe("blocked_secrets");
      expect(headerPathRes.reason).toBe("secrets_detected");
      expect(headerPathMock.getCalls()).toBe(0);
      expect(JSON.stringify(headerPathRes)).not.toContain("ghp_1234567890");
      expect(formatDiffGateHuman(headerPathRes)).not.toContain("ghp_1234567890");

      const renameHeaderSecretDiff = [
        "diff --git a/tmp/ghp_1234567890abcdefghijklmnop.ts b/src/clean.ts",
        "rename from tmp/ghp_1234567890abcdefghijklmnop.ts",
        "rename to src/clean.ts",
      ].join("\n");
      const renameMock = makeEvaluateMock("ship", 0.95);
      const renameRes = await runDiffGate(
        { diffText: renameHeaderSecretDiff, message: "chore: rename file", includeRedactedDiff: true },
        { evaluate: renameMock.evaluate },
      );
      expect(renameRes.exitCode).toBe(2);
      expect(renameRes.status).toBe("blocked_secrets");
      expect(renameRes.reason).toBe("secrets_detected");
      expect(renameMock.getCalls()).toBe(0);
      expect(JSON.stringify(renameRes)).not.toContain("ghp_1234567890");
      expect(formatDiffGateHuman(renameRes)).not.toContain("ghp_1234567890");

      const googleApiKeyHeaderDiff = [
        "diff --git a/src/AIzaSyDummyGoogleKey1234567890abcdef123.ts b/src/AIzaSyDummyGoogleKey1234567890abcdef123.ts",
        "--- a/src/AIzaSyDummyGoogleKey1234567890abcdef123.ts",
        "+++ b/src/AIzaSyDummyGoogleKey1234567890abcdef123.ts",
        "@@ -1,0 +1,1 @@",
        "+const clean = true;",
      ].join("\n");
      const googlePathMock = makeEvaluateMock("ship", 0.95);
      const googlePathRes = await runDiffGate(
        { diffText: googleApiKeyHeaderDiff, message: "chore: clean file", includeRedactedDiff: true },
        { evaluate: googlePathMock.evaluate },
      );
      expect(googlePathRes.exitCode).toBe(2);
      expect(googlePathRes.status).toBe("blocked_secrets");
      expect(googlePathRes.reason).toBe("secrets_detected");
      expect(googlePathRes.secrets[0]?.file).toBe("[redacted-path]");
      expect(googlePathMock.getCalls()).toBe(0);
      expect(JSON.stringify(googlePathRes)).not.toContain("AIzaSy");
      expect(formatDiffGateHuman(googlePathRes)).not.toContain("AIzaSy");
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
