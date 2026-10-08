import type { CouncilFinding, CouncilMemberName } from "../src/council/types.js";
import type { JevLike, JevQuestion } from "../src/council/synth-types.js";

export function finding(
  title: string,
  member: CouncilMemberName = "codex",
  extra: Partial<CouncilFinding> = {},
): CouncilFinding {
  return {
    member,
    path: extra.path ?? "src/a.ts",
    line: extra.line ?? 1,
    severity: extra.severity ?? "medium",
    title,
    detail: extra.detail ?? `detail of ${title}`,
  };
}

export type SameAnswer = "new" | "invalid" | undefined | string | { to: string; p: number };

export interface FakeScript {
  real?: (title: string) => number | "invalid" | undefined;
  same?: (title: string, earlier: string[]) => SameAnswer;
  contradict?: (titles: string[]) => number | "invalid" | undefined;
  fail?: (call: number) => Error | undefined;
}

export interface FakeCall {
  state: any;
  questions: Record<string, JevQuestion>;
  chars: number;
  signal?: AbortSignal;
}

export function fakeJev(script: FakeScript = {}): JevLike & { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  return {
    calls,
    async ask(state, questions, signal) {
      const call = calls.length;
      calls.push({ state, questions, chars: JSON.stringify({ state, questions }).length, signal });
      const failure = script.fail?.(call);
      if (failure) throw failure;
      const answers: Record<string, unknown> = {};
      const s = state as any;
      for (const key of Object.keys(questions)) {
        const [kind, ref] = key.split("::") as [string, string];
        if (kind === "real") {
          const title = s.findings[ref].title as string;
          const v = script.real ? script.real(title) : 0.9;
          if (v === undefined) continue;
          answers[key] =
            v === "invalid" ? { type: "noul", noul: 7 } : { type: "noul", noul: v, confidence: 0.7 };
        } else if (kind === "same") {
          const idx = Number(ref.slice(1));
          const title = s.findings[ref].title as string;
          const visible = Object.keys(s.findings)
            .filter((k) => Number(k.slice(1)) < idx)
            .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
          const earlier = visible.map((k) => s.findings[k].title as string);
          const v = script.same ? script.same(title, earlier) : "new";
          if (v === undefined) continue;
          const criteria = Object.keys((questions[key] as any).criteria) as string[];
          let choice = "new";
          let p = 0.8;
          if (v === "invalid") {
            answers[key] = { type: "choice", choice: "#999" };
            continue;
          }
          const target = typeof v === "string" ? v : v.to;
          if (typeof v === "object") p = v.p;
          if (target !== "new") {
            const found = visible.find((k) => s.findings[k].title === target);
            if (found) choice = `#${found.slice(1)}`;
          }
          const others = criteria.filter((c) => c !== choice);
          const rest = others.length ? (1 - p) / others.length : 0;
          const probabilities: Record<string, number> = { [choice]: others.length ? p : 1 };
          for (const o of others) probabilities[o] = rest;
          answers[key] = { type: "choice", choice, confidence: p, probabilities };
        } else if (kind === "contradict") {
          const titles = (s.groups[ref] as { title: string }[]).map((f) => f.title);
          const v = script.contradict ? script.contradict(titles) : 0.1;
          if (v === undefined) continue;
          answers[key] =
            v === "invalid" ? { type: "noul", noul: -2 } : { type: "noul", noul: v, confidence: 0.6 };
        }
      }
      return { answers };
    },
  };
}
