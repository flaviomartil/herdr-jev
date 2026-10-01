import { expect, test } from "bun:test";
import { normalizePaneClassification, classifyPaneText } from "../src/triage/pane-classifier.ts";
import blockedRaw from "./fixtures/jev-classify-raw-blocked.json";
import workingRaw from "./fixtures/jev-classify-raw-working.json";
import type { ResilientJevClient } from "../src/triage/jev-client.ts";

test("normalizePaneClassification correctly flattens Jev raw answers", () => {
  const blocked = normalizePaneClassification(blockedRaw);
  expect(blocked.state).toBe("blocked");
  expect(blocked.attention).toBe("now");
  expect(blocked.blockedReason).toBe("approval");

  const working = normalizePaneClassification(workingRaw);
  expect(working.state).toBe("working");
  expect(working.attention).toBe("none");
});

test("classifyPaneText asks Jev client and returns exactly the flat contract", async () => {
  const fakeClient = {
    ask: async () => blockedRaw
  } as unknown as ResilientJevClient;

  const result = await classifyPaneText({ paneText: "foo", agent: "codex", status: "working" }, fakeClient);
  
  expect(result).toEqual({
    state: "blocked",
    stateConfidence: 0.92,
    attention: "now",
    attentionScore: 1.87,
    attentionConfidence: 0.81,
    blockedReason: "approval",
    blockedReasonConfidence: 0.48,
    activity: "unknown",
    activityConfidence: 0,
    jevMs: 942.7938869999999,
    model: "jev-1.13.0"
  });
});
