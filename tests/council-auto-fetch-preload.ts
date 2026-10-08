import { appendFileSync } from "node:fs";

const complexity = process.env.FAKE_TRIAGE ?? "routine";
const log = process.env.FAKE_TRIAGE_LOG;

globalThis.fetch = (async (_url: unknown, options?: { body?: unknown }) => {
  const body = JSON.parse(String(options?.body));
  if (log) appendFileSync(log, `${JSON.stringify({ state: JSON.stringify(body.state) })}\n`);
  if (complexity === "fail") return new Response("{}", { status: 500 });
  const answers: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(body.questions) as Array<[string, { type: string }]>) {
    if (question.type === "noul") answers[id] = { type: "noul", noul: 0.1 };
    else if (id === "complexity") answers[id] = { type: "choice", choice: complexity, probabilities: { [complexity]: 1 }, confidence: 1 };
    else answers[id] = { type: "choice", choice: "standard", probabilities: { standard: 1 }, confidence: 1 };
  }
  return new Response(JSON.stringify({ answers, usage: { input_tokens: 10, output_tokens: 2 } }), { headers: { "Content-Type": "application/json" } });
}) as typeof fetch;
