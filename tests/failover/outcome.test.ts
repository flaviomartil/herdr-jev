import { expect, test } from "bun:test";
import { classify } from "../../src/failover/outcome/index";

const NOW = Date.parse("2026-11-11T12:00:00Z");
const run = (cli: string, code: number, output: string, timedOut = false) => classify(cli, { code, output, timedOut, now: NOW });

test("exit 0 is Success and timeout is Timeout for every cli", () => {
  for (const cli of ["codex", "agy", "claude"]) {
    expect(run(cli, 0, "done").kind).toBe("Success");
    expect(run(cli, 124, "", true).kind).toBe("Timeout");
  }
});

test("codex: usage limit with relative reset, absolute reset, 429 transient, auth, request", () => {
  const rel = run("codex", 1, "ERROR: You've hit your usage limit. Upgrade to Pro or try again in 2 hours 5 minutes.");
  expect(rel).toMatchObject({ kind: "Quota", resetAt: NOW + 2 * 3_600_000 + 5 * 60_000 });
  const abs = run("codex", 1, "You've hit your usage limit. Try again at Nov 12th, 2026 3:04 PM.");
  expect(abs.kind).toBe("Quota");
  expect(abs.resetAt).toBe(new Date("Nov 12, 2026 3:04 PM").getTime());
  expect(run("codex", 1, "stream error: 429 Too Many Requests retry-after: 30")).toMatchObject({ kind: "Transient", retryAfterMs: 30_000 });
  expect(run("codex", 1, "unexpected status 503 Service Unavailable").kind).toBe("Transient");
  expect(run("codex", 1, "Not logged in. Please log in").kind).toBe("Auth");
  expect(run("codex", 1, "invalid_request_error: bad field")).toMatchObject({ kind: "Failed", request: true });
});

test("agy: quota with reset duration, resource exhausted transient, unauthenticated", () => {
  expect(run("agy", 1, "Error: quota exceeded for this model. Your quota will reset after 3h20m5s.")).toMatchObject({
    kind: "Quota",
    resetAt: NOW + 3 * 3_600_000 + 20 * 60_000 + 5000,
  });
  expect(run("agy", 1, "429 RESOURCE_EXHAUSTED: rate limit, retry after 12 seconds")).toMatchObject({ kind: "Transient", retryAfterMs: 12_000 });
  expect(run("agy", 1, "503 UNAVAILABLE").kind).toBe("Transient");
  expect(run("agy", 1, "UNAUTHENTICATED: login required").kind).toBe("Auth");
});

test("claude: usage limit epoch, overloaded, connection refused, login", () => {
  const epoch = Math.floor((NOW + 90 * 60_000) / 1000);
  expect(run("claude", 1, `Claude AI usage limit reached|${epoch}`)).toMatchObject({ kind: "Quota", resetAt: epoch * 1000 });
  expect(run("claude", 1, "API Error: 529 overloaded_error").kind).toBe("Transient");
  expect(run("claude", 1, "API Error: Connection refused (ECONNREFUSED)").kind).toBe("Transient");
  expect(run("claude", 1, "Invalid API key. Please run /login").kind).toBe("Auth");
});

test("unrecognized failing output is Failed, never Success", () => {
  for (const cli of ["codex", "agy", "claude"]) expect(run(cli, 3, "segfault somewhere").kind).toBe("Failed");
  expect(run("mystery", 1, "x").kind).toBe("Failed");
});
