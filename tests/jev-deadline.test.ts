import { expect, test, spyOn } from "bun:test";
import { triageTaskWithJev } from "../src/triage/client.js";
import { JevError, ResilientJevClient, getResolvedDeadlineMs } from "../src/triage/jev-client.js";

test("model configured after module import reaches the SDK and explicit models take priority", async () => {
  const saved = process.env.TYPESAFE_DEFAULT_MODEL;
  const models: string[] = [];
  const fetch = async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    models.push(body.model);
    return new Response(JSON.stringify({
      model: body.model,
      answers: { warm: { type: "noul", noul: 1 } },
      usage: { input_tokens: 1, output_tokens: 0 },
    }), { headers: { "content-type": "application/json" } });
  };
  try {
    process.env.TYPESAFE_DEFAULT_MODEL = "multilingual";
    const questions = { warm: { type: "noul" as const, instructions: "Is this a test?" } };
    await new ResilientJevClient({ apiKey: "test-key", fetch }).ask("test", questions);
    await new ResilientJevClient({ apiKey: "test-key", fetch, model: "jev-1.13.0" }).ask("test", questions);
    expect(models).toEqual(["multilingual", "jev-1.13.0"]);
  } finally {
    if (saved === undefined) delete process.env.TYPESAFE_DEFAULT_MODEL;
    else process.env.TYPESAFE_DEFAULT_MODEL = saved;
  }
});

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

test("triage confidence follows the selected label, including hard-tail escalation", async () => {
  const ask = spyOn(ResilientJevClient.prototype, "ask");
  try {
    for (const [choice, probabilities, expectedComplexity, expectedConfidence] of [
      ["routine", { trivial: 0.001, routine: 0.997, moderate: 0.001, architectural: 0.001 }, "routine", 0.997],
      ["routine", { trivial: 0.1, routine: 0.45, moderate: 0.4, architectural: 0.05 }, "moderate", 0.4],
      ["moderate", { trivial: 0.05, routine: 0.15, moderate: 0.44, architectural: 0.36 }, "architectural", 0.36],
    ] as const) {
      ask.mockResolvedValue({ answers: {
        complexity: { type: "choice", choice, probabilities, confidence: 0.2 },
        needs_research: { type: "noul", noul: 0.6 },
        effort: { type: "choice", choice: "high", confidence: 0.8 },
      }, jevMs: 5 } as never);
      const decision = await triageTaskWithJev("Evaluate the task", "test-key");
      expect(decision.complexity).toBe(expectedComplexity);
      expect(decision.confidence).toBeCloseTo(expectedConfidence);
    }
    ask.mockResolvedValue({ answers: {
      complexity: { type: "choice", choice: "routine", confidence: 0.3 },
      needs_research: { type: "noul", noul: 0.1 },
      effort: { type: "choice", choice: "standard", confidence: 0.9 },
    }, jevMs: 5 } as never);
    expect((await triageTaskWithJev("Evaluate the task", "test-key")).confidence).toBe(0.3);
  } finally {
    ask.mockRestore();
  }
});

test("triage preserves independent research and enforces complexity effort minimums", async () => {
  const ask = spyOn(ResilientJevClient.prototype, "ask");
  try {
    for (const [complexity, predictedEffort, expectedEffort] of [
      ["moderate", "standard", "high"],
      ["moderate", "xhigh", "xhigh"],
      ["architectural", "high", "xhigh"],
      ["routine", "high", "high"],
      ["trivial", "standard", "standard"],
    ] as const) {
      ask.mockResolvedValue({ answers: {
        complexity: { type: "choice", choice: complexity, probabilities: { [complexity]: 1 }, confidence: 1 },
        needs_research: { type: "noul", noul: 0.1 },
        effort: { type: "choice", choice: predictedEffort, confidence: 1 },
      }, jevMs: 5 } as never);
      const decision = await triageTaskWithJev("Evaluate the task", "test-key");
      expect(decision.effort).toBe(expectedEffort);
      expect(decision.needsResearch).toBe(false);
      expect(decision.rawAnswers).toMatchObject({ effort: { choice: predictedEffort } });
    }
  } finally {
    ask.mockRestore();
  }
});
