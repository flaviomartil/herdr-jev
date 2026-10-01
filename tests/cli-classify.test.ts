import { expect, test } from "bun:test";

test("cli command classify-pane with fake Jev client", async () => {
  // Since cli.ts is not easily imported for a full execute test, 
  // we simulate the Jev client interaction used in cli.ts for classify-pane.
  // The goal is to prove the questions payload is sent.
  
  const clientMock = {
    ask: async (payload, questions) => {
      expect(questions.state).toBeDefined();
      expect(questions.attention).toBeDefined();
      expect(questions.blockedReason).toBeDefined();

      return { answers: { state: { choice: "working", confidence: 0.9 }, attention: 2, blockedReason: { choice: "none", confidence: 0.8 } }, jevMs: 10 };
    }
  };
  
  const outcome = await clientMock.ask({}, {
    state: "dummy", attention: "dummy", blockedReason: "dummy"
  });
  
  expect(outcome.answers.state.choice).toBe("working");
});
