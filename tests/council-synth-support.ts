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

export interface FakeScript {
  real?: (title: string) => number | "invalid" | undefined;
  same?: (title: string, earlier: string[]) => string | "invalid" | undefined;
  contradict?: (titles: string[]) => number | "invalid" | undefined;
  fail?: (call: number) => Error | undefined;
}

export interface FakeCall {
  state: any;
  questions: Record<string, JevQuestion>;
  chars: number;
}

export function fakeJev(script: FakeScript = {}): JevLike & { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  return {
    calls,
    async ask(state, questions) {
      const call = calls.length;
      calls.push({ state, questions, chars: JSON.stringify({ state, questions }).length });
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
          answers[key] = v === "invalid" ? { type: "noul", noul: 7 } : { type: "noul", noul: v };
        } else if (kind === "same") {
          const idx = Number(ref.slice(1));
          const title = s.findings[ref].title as string;
          const earlier = Object.keys(s.findings)
            .filter((k) => Number(k.slice(1)) < idx)
            .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
            .map((k) => s.findings[k].title as string);
          const v = script.same ? script.same(title, earlier) : "new";
          if (v === undefined) continue;
          answers[key] = { type: "choice", choice: v === "invalid" ? "#999" : v };
        } else if (kind === "contradict") {
          const titles = (s.groups[ref] as { title: string }[]).map((f) => f.title);
          const v = script.contradict ? script.contradict(titles) : 0.1;
          if (v === undefined) continue;
          answers[key] = v === "invalid" ? { type: "noul", noul: -2 } : { type: "noul", noul: v };
        }
      }
      return { answers };
    },
  };
}
