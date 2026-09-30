import { expect, test, spyOn } from "bun:test";
import { triageTaskWithJev } from "../src/triage/client.js";
import { JevError, ResilientJevClient, getResolvedDeadlineMs } from "../src/triage/jev-client.js";

test("default covers observed 720ms responses and explicit deadlines remain effective", () => {
  const saved = process.env.HERDR_JEV_DEADLINE_MS;
  const harness = process.env.HARNESS_ROUTER_DEADLINE_MS;
  try {
    delete process.env.HERDR_JEV_DEADLINE_MS;
    delete process.env.HARNESS_ROUTER_DEADLINE_MS;
    expect(getResolvedDeadlineMs()).toBe(1000);
    process.env.HERDR_JEV_DEADLINE_MS = "600";
    expect(getResolvedDeadlineMs()).toBe(600);
  } finally {
    if (saved === undefined) delete process.env.HERDR_JEV_DEADLINE_MS;
    else process.env.HERDR_JEV_DEADLINE_MS = saved;
    if (harness === undefined) delete process.env.HARNESS_ROUTER_DEADLINE_MS;
    else process.env.HARNESS_ROUTER_DEADLINE_MS = harness;
  }
});

test("triage identifies deadline fallback separately from network failure", async () => {
  const ask = spyOn(ResilientJevClient.prototype, "ask").mockRejectedValue(new JevError("deadline", "Jev request exceeded deadline of 600ms"));
  try {
    const decision = await triageTaskWithJev("Fix README spelling", "test-key");
    expect(decision.rawAnswers).toMatchObject({ fallback: true, reason: "deadline-exception: JevError: Jev request exceeded deadline of 600ms" });
    ask.mockRejectedValue(new JevError("network", "Connection failed"));
    const network = await triageTaskWithJev("Fix README spelling", "test-key");
    expect(network.rawAnswers).toMatchObject({ fallback: true, reason: "network-exception: JevError: Connection failed" });
  } finally {
    ask.mockRestore();
  }
});
