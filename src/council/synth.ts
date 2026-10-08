import { choice, noul } from "@typesafe-ai/sdk";
import { routingAnswersStatus } from "../routing/questions.js";
import { JevError, ResilientJevClient } from "../triage/jev-client.js";
import type { CouncilFinding, CouncilMemberName } from "./types.js";
import type {
  CouncilItem,
  CouncilSummary,
  JevLike,
  JevQuestion,
  SynthLimits,
  SynthOptions,
} from "./synth-types.js";

export const SYNTH_MAX_QUESTIONS_PER_REQUEST = 9;
export const SYNTH_MAX_CHARS_PER_REQUEST = 14_000;
export const SYNTH_MAX_SCORED_FINDINGS = 20;
export const SYNTH_MAX_DETAIL_CHARS = 300;
export const SYNTH_DEFAULT_THRESHOLD = 0.3;
export const SYNTH_CONTRADICTION_THRESHOLD = 0.5;
export const SYNTH_DEADLINE_MS = 20_000;

const MAX_TITLE_CHARS = 200;
const MAX_LOCATION_CHARS = 200;
const NEW_ISSUE = "new";
const SEVERITY_RANK: Record<CouncilFinding["severity"], number> = { high: 0, medium: 1, low: 2 };

type Questions = Record<string, JevQuestion>;

interface Packed {
  state: unknown;
  questions: Questions;
}

interface RenderedFinding {
  member: CouncilMemberName;
  location: string;
  title: string;
  detail?: string;
}

function resolveLimits(partial: SynthOptions["limits"]): SynthLimits {
  return {
    maxQuestions: partial?.maxQuestions ?? SYNTH_MAX_QUESTIONS_PER_REQUEST,
    maxChars: partial?.maxChars ?? SYNTH_MAX_CHARS_PER_REQUEST,
    maxScored: partial?.maxScored ?? SYNTH_MAX_SCORED_FINDINGS,
    maxDetailChars: partial?.maxDetailChars ?? SYNTH_MAX_DETAIL_CHARS,
  };
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

function locationOf(finding: CouncilFinding): string {
  return finding.line === undefined ? finding.path : `${finding.path}:${finding.line}`;
}

function render(finding: CouncilFinding, limits: SynthLimits, withDetail: boolean): RenderedFinding {
  const out: RenderedFinding = {
    member: finding.member,
    location: clip(locationOf(finding), MAX_LOCATION_CHARS),
    title: clip(finding.title, MAX_TITLE_CHARS),
  };
  if (withDetail) out.detail = clip(finding.detail, limits.maxDetailChars);
  return out;
}

function size(packed: Packed): number {
  return JSON.stringify(packed).length;
}

function questionCount(packed: Packed): number {
  return Object.keys(packed.questions).length;
}

function realKey(i: number): string {
  return `real::f${i}`;
}

function sameKey(i: number): string {
  return `same::f${i}`;
}

function sameCriteria(i: number): Record<string, string> {
  const criteria: Record<string, string> = {
    [NEW_ISSUE]: "A different underlying issue from every earlier finding.",
  };
  for (let k = 0; k < i; k++) {
    criteria[`#${k}`] = `The same underlying issue as \`findings.f${k}\`.`;
  }
  return criteria;
}

function packRound1(
  scored: CouncilFinding[],
  start: number,
  end: number,
  contextDetail: boolean,
  limits: SynthLimits,
): Packed {
  const findings: Record<string, RenderedFinding> = {};
  for (let k = 0; k <= end; k++) {
    findings[`f${k}`] = render(scored[k]!, limits, k >= start || contextDetail);
  }
  const questions: Questions = {};
  for (let i = start; i <= end; i++) {
    questions[realKey(i)] = noul(
      `Is \`findings.f${i}\` a real defect in the reviewed code, rather than noise, a style preference, or a false alarm? Judge only from what the finding states.`,
    );
    if (i > 0) {
      questions[sameKey(i)] = choice(
        `Does \`findings.f${i}\` describe the same underlying issue as one of the earlier findings, or a new issue?`,
        sameCriteria(i),
      );
    }
  }
  return { state: { findings }, questions };
}

interface Batch {
  start: number;
  end: number;
  packed: Packed;
}

function planRound1(scored: CouncilFinding[], limits: SynthLimits): Batch[] {
  const batches: Batch[] = [];
  let start = 0;
  while (start < scored.length) {
    let end = start;
    let best = packRound1(scored, start, end, true, limits);
    if (size(best) > limits.maxChars || questionCount(best) > limits.maxQuestions) {
      best = packRound1(scored, start, end, false, limits);
    }
    while (end + 1 < scored.length) {
      const next = packRound1(scored, start, end + 1, true, limits);
      if (questionCount(next) > limits.maxQuestions || size(next) > limits.maxChars) break;
      best = next;
      end += 1;
    }
    batches.push({ start, end, packed: best });
    start = end + 1;
  }
  return batches;
}

function contradictKey(g: number): string {
  return `contradict::g${g}`;
}

function packRound2(
  groups: number[][],
  from: number,
  to: number,
  scored: CouncilFinding[],
  limits: SynthLimits,
): Packed {
  const state: Record<string, RenderedFinding[]> = {};
  const questions: Questions = {};
  for (let g = from; g <= to; g++) {
    state[`g${g}`] = groups[g]!.map((i) => render(scored[i]!, limits, true));
    questions[contradictKey(g)] = noul(
      `Do the findings in \`${`g${g}`}\` contradict each other, so that they cannot all be true of the same code?`,
    );
  }
  return { state: { groups: state }, questions };
}

function planRound2(groups: number[][], scored: CouncilFinding[], limits: SynthLimits) {
  const batches: { from: number; to: number; packed: Packed }[] = [];
  let from = 0;
  while (from < groups.length) {
    let to = from;
    let best = packRound2(groups, from, to, scored, limits);
    while (to + 1 < groups.length) {
      const next = packRound2(groups, from, to + 1, scored, limits);
      if (questionCount(next) > limits.maxQuestions || size(next) > limits.maxChars) break;
      best = next;
      to += 1;
    }
    batches.push({ from, to, packed: best });
    from = to + 1;
  }
  return batches;
}

type Outcome = { answers: Record<string, unknown> } | { error: string };

async function safeAsk(jev: JevLike, packed: Packed): Promise<Outcome> {
  try {
    const result = await jev.ask(packed.state, packed.questions);
    return { answers: (result?.answers ?? {}) as Record<string, unknown> };
  } catch (error) {
    if (error instanceof JevError) return { error: `${error.failure}: ${error.message}` };
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function valid(answers: Record<string, unknown>, questions: Questions, key: string): boolean {
  const question = questions[key];
  if (!question) return false;
  return routingAnswersStatus(answers, { [key]: question }) === "valid";
}

function standalone(findings: CouncilFinding[], indices: number[]): CouncilItem {
  return buildItem(findings, indices, undefined);
}

function buildItem(
  findings: CouncilFinding[],
  indices: number[],
  reals: Map<number, number> | undefined,
  texts?: "contrast",
): CouncilItem {
  const ordered = [...indices].sort((a, b) => {
    const fa = findings[a]!;
    const fb = findings[b]!;
    return (
      SEVERITY_RANK[fa.severity] - SEVERITY_RANK[fb.severity] ||
      (reals?.get(b) ?? -1) - (reals?.get(a) ?? -1) ||
      a - b
    );
  });
  const lead = findings[ordered[0]!]!;
  const members = [...new Set(ordered.map((i) => findings[i]!.member))].sort();
  const values = ordered.map((i) => reals?.get(i)).filter((v): v is number => v !== undefined);
  const real = values.length ? values.reduce((s, v) => s + v, 0) / values.length : undefined;
  let text = clip(lead.title, MAX_TITLE_CHARS);
  if (texts === "contrast") {
    const seen = new Set<CouncilMemberName>();
    const parts: string[] = [];
    for (const i of ordered) {
      const f = findings[i]!;
      if (seen.has(f.member)) continue;
      seen.add(f.member);
      parts.push(`${f.member}: ${clip(f.title, MAX_TITLE_CHARS)}`);
    }
    text = parts.join(" vs ");
  }
  const item: CouncilItem = {
    members,
    location: locationOf(lead),
    text,
    severity: lead.severity,
    findings: ordered.map((i) => findings[i]!),
  };
  if (real !== undefined) item.real = real;
  return item;
}

function rawSummary(findings: CouncilFinding[], messages: string[]): CouncilSummary {
  return {
    agreements: [],
    disagreements: [],
    unique: findings.map((_, i) => standalone(findings, [i])),
    notes: [],
    messages,
    scoredBy: "none",
  };
}

function describeFailure(errors: string[]): string {
  return `Jev unavailable (${errors[0]}); findings are listed as reported, without scoring or grouping.`;
}

export async function synthesize(
  findings: CouncilFinding[],
  opts: SynthOptions = {},
): Promise<CouncilSummary> {
  const limits = resolveLimits(opts.limits);
  const threshold = opts.threshold ?? SYNTH_DEFAULT_THRESHOLD;
  const contradictionThreshold = opts.contradictionThreshold ?? SYNTH_CONTRADICTION_THRESHOLD;

  if (findings.length === 0) {
    return { agreements: [], disagreements: [], unique: [], notes: [], messages: [], scoredBy: "none" };
  }

  const order = findings
    .map((_, i) => i)
    .sort((a, b) => SEVERITY_RANK[findings[a]!.severity] - SEVERITY_RANK[findings[b]!.severity] || a - b);
  const scoredCount = Math.min(limits.maxScored, findings.length);
  const scored = order.slice(0, scoredCount).map((i) => findings[i]!);
  const overflow = order.slice(scoredCount).map((i) => findings[i]!);

  const jev: JevLike =
    opts.jev ?? (new ResilientJevClient({ deadlineMs: opts.deadlineMs ?? SYNTH_DEADLINE_MS }) as JevLike);

  const batches = planRound1(scored, limits);
  const outcomes = await Promise.all(batches.map((b) => safeAsk(jev, b.packed)));

  const errors: string[] = [];
  const reals = new Map<number, number>();
  const links = new Map<number, number>();
  const failedBatch = new Set<number>();
  let invalid = 0;

  batches.forEach((batch, n) => {
    const outcome = outcomes[n]!;
    if ("error" in outcome) {
      errors.push(outcome.error);
      failedBatch.add(n);
      return;
    }
    const { answers } = outcome;
    for (let i = batch.start; i <= batch.end; i++) {
      const realOk = valid(answers, batch.packed.questions, realKey(i));
      const sameOk = i === 0 || valid(answers, batch.packed.questions, sameKey(i));
      if (!realOk || !sameOk) invalid += 1;
      if (!realOk) continue;
      const realAnswer = answers[realKey(i)] as { noul: number };
      reals.set(i, realAnswer.noul);
      if (i === 0 || !sameOk) continue;
      const picked = (answers[sameKey(i)] as { choice: string }).choice;
      if (picked !== NEW_ISSUE) {
        const k = Number(picked.slice(1));
        if (Number.isInteger(k) && k >= 0 && k < i) links.set(i, k);
      }
    }
  });

  if (reals.size === 0) {
    const reason = errors.length
      ? describeFailure(errors)
      : "Jev returned no valid answers; findings are listed as reported, without scoring or grouping.";
    return rawSummary(findings, [reason]);
  }

  const messages: string[] = [];
  if (errors.length) {
    messages.push(
      `Jev failed for ${failedBatch.size} of ${batches.length} requests (${errors[0]}); the affected findings are listed alone and unscored.`,
    );
  }
  const invalidCount = invalid;
  if (invalidCount > 0) {
    messages.push(`${invalidCount} finding(s) had an invalid Jev answer and are listed alone and unscored.`);
  }
  if (overflow.length) {
    messages.push(`${overflow.length} finding(s) beyond the first ${scoredCount} were not scored and are listed alone.`);
  }

  const parent = scored.map((_, i) => i);
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root]!;
    let cur = x;
    while (parent[cur] !== root) {
      const next = parent[cur]!;
      parent[cur] = root;
      cur = next;
    }
    return root;
  };
  for (const [i, k] of links) {
    const a = find(i);
    const b = find(k);
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
  }

  const components = new Map<number, number[]>();
  scored.forEach((_, i) => {
    const root = find(i);
    const list = components.get(root);
    if (list) list.push(i);
    else components.set(root, [i]);
  });

  const notes: CouncilItem[] = [];
  const unique: CouncilItem[] = [];
  const multi: number[][] = [];
  const keptComponents: number[][] = [];

  for (const indices of components.values()) {
    const kept: number[] = [];
    for (const i of indices) {
      const r = reals.get(i);
      if (r !== undefined && r < threshold) notes.push(buildItem(scored, [i], reals));
      else kept.push(i);
    }
    if (kept.length) keptComponents.push(kept);
  }

  for (const kept of keptComponents) {
    const distinct = new Set(kept.map((i) => scored[i]!.member));
    if (distinct.size > 1) multi.push(kept);
    else unique.push(buildItem(scored, kept, reals));
  }

  const agreements: CouncilItem[] = [];
  const disagreements: CouncilItem[] = [];

  const round2 = planRound2(multi, scored, limits);
  const round2Outcomes = await Promise.all(round2.map((b) => safeAsk(jev, b.packed)));
  const contradictory = new Set<number>();
  const unchecked: number[] = [];
  round2.forEach((batch, n) => {
    const outcome = round2Outcomes[n]!;
    for (let g = batch.from; g <= batch.to; g++) {
      if ("error" in outcome) {
        unchecked.push(g);
        continue;
      }
      if (!valid(outcome.answers, batch.packed.questions, contradictKey(g))) {
        unchecked.push(g);
        continue;
      }
      const p = (outcome.answers[contradictKey(g)] as { noul: number }).noul;
      if (p >= contradictionThreshold) contradictory.add(g);
    }
  });
  multi.forEach((indices, g) => {
    if (contradictory.has(g)) disagreements.push(buildItem(scored, indices, reals, "contrast"));
    else agreements.push(buildItem(scored, indices, reals));
  });
  if (unchecked.length) {
    messages.push(
      `The contradiction check was unavailable for ${unchecked.length} group(s); they are listed as agreements without it.`,
    );
  }

  for (const f of overflow) unique.push(standalone([f], [0]));

  const byRealThenSeverity = (a: CouncilItem, b: CouncilItem) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (b.real ?? -1) - (a.real ?? -1);
  agreements.sort(byRealThenSeverity);
  disagreements.sort(byRealThenSeverity);
  unique.sort(byRealThenSeverity);
  notes.sort(byRealThenSeverity);

  return { agreements, disagreements, unique, notes, messages, scoredBy: "jev" };
}
