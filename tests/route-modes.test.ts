import { expect, test } from "bun:test";
import { TurnRouter, heuristicRoute } from "../src/routing/router.js";

function router(mode: "off" | "shadow" | "active", mutate?: (answers: Record<string, any>) => void) {
  let requests = 0;
  const instance = new TurnRouter({ mode, jevOptions: { apiKey: "test-key", fetch: (async (_url, options) => {
    requests++;
    const { questions } = JSON.parse(String(options?.body));
    const answers: Record<string, any> = {};
    for (const [id, question] of Object.entries(questions) as Array<[string, any]>) {
      answers[id] = question.type === "noul" ? { type: "noul", noul: id === "tool::Read" ? 1 : 0.1 }
        : question.type === "score" ? { type: "score", score: 2, probabilities: { "2": 1 } }
        : { type: "choice", choice: id === "turn::intent" ? "modify" : "none", probabilities: { [id === "turn::intent" ? "modify" : "none"]: 1 }, confidence: 1 };
    }
    mutate?.(answers);
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 100, output_tokens: 4 } }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch } });
  return { instance, requests: () => requests };
}

test("shadow records the Jev candidate while applying the heuristic even on cache hits", async () => {
  const { instance, requests } = router("shadow");
  const input = { message: "change the value", recentContext: "private context sentinel" };
  const first = await instance.route(input);
  expect(first.decision).toEqual(heuristicRoute(input));
  expect(first.observation.judged!.tier).toBe("deep");
  expect(first.observation.reason).toBe("shadow");
  expect(first.observation.source).toBe("jev");
  expect(JSON.stringify(first.observation)).not.toContain(input.message);
  expect(JSON.stringify(first.observation)).not.toContain(input.recentContext!);
  const second = await instance.route(input);
  expect(second.observation.applied).toEqual(first.observation.applied);
  expect(second.observation.judged).toEqual(first.observation.judged);
  expect(second.observation.id).not.toBe(first.observation.id);
  expect(second.observation.inputTokens).toBe(0);
  expect(requests()).toBe(1);
});

test("off and shortcuts do not call or prewarm Jev, active applies a validated candidate", async () => {
  const off = router("off");
  await off.instance.prewarm();
  const input = { message: "change the value" };
  expect((await off.instance.route(input)).decision).toEqual(heuristicRoute(input));
  expect(off.requests()).toBe(0);
  const active = router("active");
  expect((await active.instance.route({ message: "continua" })).observation.reason).toBe("shortcut");
  expect(active.requests()).toBe(0);
  const result = await active.instance.route(input);
  expect(result.decision.tier).toBe("deep");
  expect(result.observation.applied).toEqual(result.observation.judged);
  expect(result.observation.reason).toBe("judged");
});

test("malformed answers and explicit uncertainty preserve the heuristic instead of guessing a route", async () => {
  for (const [reason, mutate] of [
    ["invalid_answer", (a: Record<string, any>) => { a["tool::Read"].noul = 2; }],
    ["invalid_answer", (a: Record<string, any>) => { a["turn::difficulty"].probabilities = { "8": 1 }; }],
    ["invalid_answer", (a: Record<string, any>) => { delete a["gate::acts_on_system"]; }],
    ["abstained", (a: Record<string, any>) => { a["turn::intent"] = { type: "choice", choice: "unclear", probabilities: { unclear: 1 } }; }],
    ["abstained", (a: Record<string, any>) => { delete a["turn::difficulty"].probabilities; }],
  ] as const) {
    const { instance } = router("active", mutate);
    const input = { message: "change the value" };
    const result = await instance.route(input);
    expect(result.decision).toEqual(heuristicRoute(input));
    expect(result.observation.reason).toBe(reason);
    expect(result.observation.judged).toBeNull();
  }
});

test("changes in tool availability invalidate both active and shadow route caches", async () => {
  for (const mode of ["active", "shadow"] as const) {
    const { instance, requests } = router(mode);
    const input = { message: "leia o arquivo" };
    expect((await instance.route(input)).decision.tools).toContain("Read");
    expect((await instance.route({ ...input, unavailableTools: ["Read"] })).decision.tools).not.toContain("Read");
    expect(requests()).toBe(2);
  }
});

test("deadline fallback stays applied in shadow after the late answer arrives", async () => {
  const instance = new TurnRouter({ mode: "shadow", jevOptions: { apiKey: "test-key", deadlineMs: 2, fetch: (async (_url, options) => {
    await Bun.sleep(20);
    const { questions } = JSON.parse(String(options?.body));
    const answers = Object.fromEntries(Object.entries(questions).map(([id, question]: [string, any]) => [id, question.type === "noul" ? { type: "noul", noul: 0.1 } : question.type === "score" ? { type: "score", score: 2, probabilities: { "2": 1 } } : { type: "choice", choice: id === "turn::intent" ? "modify" : "none" }]));
    return new Response(JSON.stringify({ answers }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch } });
  const input = { message: "change the value" };
  const first = await instance.route(input);
  expect(first.observation.reason).toBe("deadline");
  expect(first.observation.judged).toBeNull();
  await Bun.sleep(30);
  const second = await instance.route(input);
  expect(second.observation.reason).toBe("shadow");
  expect(second.observation.judged!.tier).toBe("deep");
  expect(second.observation.applied).toEqual(first.observation.applied);
});
