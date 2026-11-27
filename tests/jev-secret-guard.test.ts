import { describe, expect, test } from "bun:test";
import { JevError, ResilientJevClient, assertSafeState } from "../src/triage/jev-client.js";

// Dynamic assembly so no literal realistic secrets appear in test fixtures.
const sampleSkToken = ["sk", "test", "AbCdEf1234567890AbCdEf123456"].join("-");
const sampleGhToken = ["ghp", "AbCdEf1234567890AbCdEf1234567890abcd"].join("_");
const sampleGhoToken = ["gho", "AbCdEf1234567890AbCdEf1234567890abcd"].join("_");
const sampleGoogleKey = ["AIza", "SyAbCdEfGhIjKlMnOpQrStUvWxYz123456789"].join("");
const sampleHfToken = ["hf", "AbCdEf1234567890AbCdEf1234567890"].join("_");
const sampleJwt = [
  ["eyJ", "hbGciOiJIUzI1NiJ9"].join(""),
  ["eyJ", "zdWIiOiIxMjM0NTY3ODkwIn0"].join(""),
  "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
].join(".");
const sampleAwsKey = ["AKI", "A", "1234567890ABCDEF"].join("");
const samplePrivateKeyHeader = ["-----BEGIN", "RSA", "PRIVATE", "KEY-----"].join(" ");
const sampleBearer = ["Bear" + "er", "tok_test_998877665544332211"].join(" ");
const sampleUrlCreds = ["https://", "deploy", ":", "pass_word_998877", "@example.com/repo"].join("");

describe("assertSafeState pre-Jev secret guard", () => {
  test("rejects API tokens, private keys, arrays, toJSON leaks, and keyed secrets", () => {
    const sneak = {
      safe: "ok",
      toJSON() {
        return { api_key: sampleSkToken };
      },
    };
    for (const unsafe of [
      `Sending token ${sampleSkToken}`,
      `GH=${sampleGhToken}`,
      `GHO=${sampleGhoToken}`,
      `GAPI=${sampleGoogleKey}`,
      `HF=${sampleHfToken}`,
      `jwt=${sampleJwt}`,
      `aws=${sampleAwsKey}`,
      `url=${sampleUrlCreds}`,
      `${samplePrivateKeyHeader}\nMIIEpAIBAAKCAQEA`,
      { nested: { api_key: ["sec", "ret", "998877"].join("_") } },
      { secret: ["val12345"] },
      { token: ["mysecret12345"] },
      { headers: { Authorization: sampleBearer } },
      sneak,
      `${"safe line\n".repeat(900)}token=${["my", "secret", "value"].join("_")}`,
    ]) {
      expect(() => assertSafeState(unsafe)).toThrow(JevError);
      try {
        assertSafeState(unsafe);
      } catch (err) {
        expect(err).toBeInstanceOf(JevError);
        expect((err as JevError).failure).toBe("unsafe_state");
      }
    }
  });

  test("allows SHAs, UUIDs, token counters, clean triage states, and [REDACTED] placeholders", () => {
    const commitSha = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
    const sha256 = "0123456789abcdef".repeat(4);
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    for (const safe of [
      "Evaluate this coding task: Fix README spelling",
      `git diff ${commitSha} (${sha256}) id=${uuid}`,
      { commit: commitSha, sha256, uuid, max_tokens: 1000, tokenCount: 5, input_tokens: 200, output_tokens: 50 },
      { paneText: 'token="[REDACTED]"\nAuthorization: Bearer [REDACTED]', agent: "codex", status: "idle" },
      { api_key: "[REDACTED]", token: true, password: "", count: 42 },
      "http://localhost:3000/api/health",
      "safe ".repeat(2000),
    ]) {
      expect(() => assertSafeState(safe)).not.toThrow();
    }
  });

  test("ResilientJevClient.ask rejects unsafe_state (including toJSON) before touching cache, key resolution, or fetch", async () => {
    let fetchCalls = 0;
    const fetch = async () => {
      fetchCalls++;
      return new Response("{}", { status: 200 });
    };

    const client = new ResilientJevClient({ apiKey: null, fetch });
    const questions = { warm: { type: "noul" as const, instructions: "Test?" } };

    for (const payload of [
      { leak: sampleSkToken },
      {
        safe: "value",
        toJSON() {
          return { secret: sampleHfToken };
        },
      },
    ]) {
      let caught: unknown;
      try {
        await client.ask(payload, questions);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(JevError);
      expect((caught as JevError).failure).toBe("unsafe_state");
      expect((caught as JevError).message).toContain("Refusing to send unredacted secret material");
    }
    expect(fetchCalls).toBe(0);
  });
});
