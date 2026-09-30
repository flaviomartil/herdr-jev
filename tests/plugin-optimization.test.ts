import { test, expect, spyOn } from "bun:test";
import { ResilientJevClient } from "../src/triage/jev-client.js";
import { calibrateJevLatency } from "../src/triage/calibrator.js";
import { hasExhaustedUsageQuota } from "../src/harness/bridge.js";

test("calibration clears cached answers before every network sample", async () => {
  let cached = false;
  let requests = 0;
  const warm = spyOn(ResilientJevClient.prototype, "prewarm").mockResolvedValue(true);
  const clear = spyOn(ResilientJevClient.prototype, "clearCache").mockImplementation(() => { cached = false; });
  const ask = spyOn(ResilientJevClient.prototype, "ask").mockImplementation(async () => {
    if (!cached) requests++;
    cached = true;
    return { jevMs: requests * 10 } as any;
  });
  try {
    const result = await calibrateJevLatency({ samples: 3, spacingMs: 0 });
    expect(requests).toBe(3);
    expect(result.latencies).toEqual([10, 20, 30]);
  } finally { warm.mockRestore(); clear.mockRestore(); ask.mockRestore(); }
});

test("only fresh applicable account exhaustion excludes a provider", () => {
  const exhausted = { provider: "codex", scope: "account", freshness: "fresh", status: "exhausted" };
  expect(hasExhaustedUsageQuota("codex", [exhausted])).toBe(true);
  for (const patch of [{ freshness: "stale" }, { scope: "unknown" }, { scope: "model" }, { status: "unknown" }, { provider: "claude" }]) {
    expect(hasExhaustedUsageQuota("codex", [{ ...exhausted, ...patch }])).toBe(false);
  }
  expect(hasExhaustedUsageQuota("codex", [])).toBe(false);
});
