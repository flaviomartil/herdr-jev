import { choice, noul } from "@typesafe-ai/sdk";
import { routingAnswersStatus } from "../routing/questions.js";
import { resolveTypeSafeApiKey } from "../triage/client.js";
import { JevError, ResilientJevClient } from "../triage/jev-client.js";
import { flat } from "./text.js";
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
export const SYNTH_LINK_MIN_PROBABILITY = 0.5;
export const SYNTH_DEADLINE_MS = 20_000;

const MAX_TITLE_CHARS = 200;
const MAX_LOCATION_CHARS = 200;
const MAX_MESSAGE_CHARS = 300;
const NEW_ISSUE = "new";
const SEVERITIES: CouncilFinding["severity"][] = ["high", "medium", "low"];
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

interface Cfg {
  ownDetail: boolean;
  ctxDetail: boolean;
  title: number;
  location: number;
  onePerMember?: boolean;
}

const TIERS: Cfg[] = [
  { ownDetail: true, ctxDetail: true, title: MAX_TITLE_CHARS, location: MAX_LOCATION_CHARS },
  { ownDetail: true, ctxDetail: false, title: MAX_TITLE_CHARS, location: MAX_LOCATION_CHARS },
  { ownDetail: false, ctxDetail: false, title: 80, location: 80 },
  { ownDetail: false, ctxDetail: false, title: 30, location: 30 },
  { ownDetail: false, ctxDetail: false, title: 30, location: 30, onePerMember: true },
];

function resolveLimits(partial: SynthOptions["limits"]): SynthLimits {
  return {
    maxQuestions: partial?.maxQuestions ?? SYNTH_MAX_QUESTIONS_PER_REQUEST,
    maxChars: partial?.maxChars ?? SYNTH_MAX_CHARS_PER_REQUEST,
    maxScored: partial?.maxScored ?? SYNTH_MAX_SCORED_FINDINGS,
    maxDetailChars: partial?.maxDetailChars ?? SYNTH_MAX_DETAIL_CHARS,
  };
}

function locationOf(finding: CouncilFinding): string {
  return finding.line === undefined ? finding.path : `${finding.path}:${finding.line}`;
}

function render(
  finding: CouncilFinding,
  limits: SynthLimits,
  cfg: Cfg,
  withDetail: boolean,
): RenderedFinding {
  const out: RenderedFinding = {
    member: finding.member,
    location: flat(locationOf(finding), cfg.location),
    title: flat(finding.title, cfg.title),
  };
  if (withDetail) out.detail = flat(finding.detail, limits.maxDetailChars);
  return out;
}

function size(packed: Packed): number {
  return JSON.stringify(packed).length;
}

function questionCount(packed: Packed): number {
  return Object.keys(packed.questions).length;
}

function fits(packed: Packed, limits: SynthLimits): boolean {
  return questionCount(packed) <= limits.maxQuestions && size(packed) <= limits.maxChars;
}

function realKey(i: number): string {
  return `real::f${i}`;
}

function sameKey(i: number): string {
  return `same::f${i}`;
}

function contradictKey(g: number): string {
  return `contradict::g${g}`;
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
  cfg: Cfg,
  limits: SynthLimits,
): Packed {
  const findings: Record<string, RenderedFinding> = {};
  for (let k = 0; k <= end; k++) {
    findings[`f${k}`] = render(scored[k]!, limits, cfg, k >= start ? cfg.ownDetail : cfg.ctxDetail);
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

interface Batch1 {
  start: number;
  end: number;
  packed?: Packed;
}

function planRound1(scored: CouncilFinding[], limits: SynthLimits): Batch1[] {
  const batches: Batch1[] = [];
  let start = 0;
  while (start < scored.length) {
    let best: Packed | undefined;
    for (const cfg of TIERS) {
      const candidate = packRound1(scored, start, start, cfg, limits);
      if (fits(candidate, limits)) {
        best = candidate;
        break;
      }
    }
    if (!best) {
      batches.push({ start, end: start });
      start += 1;
      continue;
    }
    let end = start;
    while (end + 1 < scored.length) {
      const next = packRound1(scored, start, end + 1, TIERS[0]!, limits);
      if (!fits(next, limits)) break;
      best = next;
      end += 1;
    }
    batches.push({ start, end, packed: best });
    start = end + 1;
  }
  return batches;
}

function packRound2(
  groups: number[][],
  from: number,
  to: number,
  scored: CouncilFinding[],
  cfg: Cfg,
  limits: SynthLimits,
): Packed {
  const state: Record<string, RenderedFinding[]> = {};
  const questions: Questions = {};
  for (let g = from; g <= to; g++) {
    let indices = groups[g]!;
    if (cfg.onePerMember) {
      const seen = new Set<CouncilMemberName>();
      indices = indices.filter((i) => {
        const m = scored[i]!.member;
        if (seen.has(m)) return false;
        seen.add(m);
        return true;
      });
    }
    state[`g${g}`] = indices.map((i) => render(scored[i]!, limits, cfg, cfg.ownDetail));
    questions[contradictKey(g)] = noul(
      `Do the findings in \`groups.g${g}\` contradict each other, so that they cannot all be true of the same code?`,
    );
  }
  return { state: { groups: state }, questions };
}

interface Batch2 {
  from: number;
  to: number;
  packed?: Packed;
}

function planRound2(groups: number[][], scored: CouncilFinding[], limits: SynthLimits): Batch2[] {
  const batches: Batch2[] = [];
  let from = 0;
  while (from < groups.length) {
    let best: Packed | undefined;
    for (const cfg of TIERS) {
      const candidate = packRound2(groups, from, from, scored, cfg, limits);
      if (fits(candidate, limits)) {
        best = candidate;
        break;
      }
    }
    if (!best) {
      batches.push({ from, to: from });
      from += 1;
      continue;
    }
    let to = from;
    while (to + 1 < groups.length) {
      const next = packRound2(groups, from, to + 1, scored, TIERS[0]!, limits);
      if (!fits(next, limits)) break;
      best = next;
      to += 1;
    }
    batches.push({ from, to, packed: best });
    from = to + 1;
  }
  return batches;
}

type Outcome = { answers: Record<string, unknown> } | { error: string };

async function safeAsk(jev: JevLike, packed: Packed, signal: AbortSignal): Promise<Outcome> {
  try {
    const result = await jev.ask(packed.state, packed.questions, signal);
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

function scoringOrder(findings: CouncilFinding[]): number[] {
  const out: number[] = [];
  for (const severity of SEVERITIES) {
    const byMember = new Map<CouncilMemberName, number[]>();
    findings.forEach((f, i) => {
      if (f.severity !== severity) return;
      const list = byMember.get(f.member);
      if (list) list.push(i);
      else byMember.set(f.member, [i]);
    });
    const queues = [...byMember.values()];
    while (queues.some((q) => q.length)) {
      for (const q of queues) {
        const next = q.shift();
        if (next !== undefined) out.push(next);
      }
    }
  }
  return out;
}

function buildItem(
  findings: CouncilFinding[],
  indices: number[],
  reals: Map<number, number> | undefined,
  contrast = false,
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
  let text = flat(lead.title, MAX_TITLE_CHARS);
  if (contrast) {
    const seen = new Set<CouncilMemberName>();
    const parts: string[] = [];
    for (const i of ordered) {
      const f = findings[i]!;
      if (seen.has(f.member)) continue;
      seen.add(f.member);
      parts.push(`${f.member}: ${flat(f.title, MAX_TITLE_CHARS)}`);
    }
    text = parts.join(" vs ");
  }
  const item: CouncilItem = {
    members,
    location: flat(locationOf(lead), MAX_LOCATION_CHARS),
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
    unique: findings.map((_, i) => buildItem(findings, [i], undefined)),
    notes: [],
    messages,
    scoredBy: "none",
  };
}

function unavailable(reason: string): string {
  return `Jev unavailable (${flat(reason, MAX_MESSAGE_CHARS)}); findings are listed as reported, without scoring or grouping.`;
}

function pickedProbabilityOk(answer: { choice: string; probabilities?: Record<string, number> }): boolean {
  if (!answer.probabilities) return true;
  const p = answer.probabilities[answer.choice];
  return typeof p === "number" && p >= SYNTH_LINK_MIN_PROBABILITY;
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

  let jev = opts.jev;
  if (!jev) {
    const apiKey = resolveTypeSafeApiKey();
    if (!apiKey) {
      return rawSummary(findings, [unavailable("missing_key: TYPESAFE_API_KEY is not set or resolved from Vault")]);
    }
    jev = new ResilientJevClient({ deadlineMs: opts.deadlineMs ?? SYNTH_DEADLINE_MS, apiKey }) as JevLike;
  }

  const controller = new AbortController();
  try {
    return await run(findings, jev, controller.signal, limits, threshold, contradictionThreshold);
  } finally {
    controller.abort();
  }
}

async function run(
  findings: CouncilFinding[],
  jev: JevLike,
  signal: AbortSignal,
  limits: SynthLimits,
  threshold: number,
  contradictionThreshold: number,
): Promise<CouncilSummary> {
  const order = scoringOrder(findings);
  const scoredCount = Math.min(limits.maxScored, findings.length);
  const scored = order.slice(0, scoredCount).map((i) => findings[i]!);
  const overflow = order.slice(scoredCount).map((i) => findings[i]!);

  const batches = planRound1(scored, limits);
  const outcomes = await Promise.all(
    batches.map((b) => (b.packed ? safeAsk(jev, b.packed, signal) : Promise.resolve(undefined))),
  );

  const errors: string[] = [];
  const reals = new Map<number, number>();
  const picks = new Map<number, number>();
  let oversized = 0;
  let failedFindings = 0;
  let badScore = 0;
  let badGrouping = 0;

  batches.forEach((batch, n) => {
    const outcome = outcomes[n];
    if (!batch.packed) {
      oversized += batch.end - batch.start + 1;
      return;
    }
    if (!outcome || "error" in outcome) {
      if (outcome) errors.push(outcome.error);
      failedFindings += batch.end - batch.start + 1;
      return;
    }
    const { answers } = outcome;
    for (let i = batch.start; i <= batch.end; i++) {
      if (!valid(answers, batch.packed.questions, realKey(i))) {
        badScore += 1;
        continue;
      }
      reals.set(i, (answers[realKey(i)] as { noul: number }).noul);
      if (i === 0) continue;
      if (!valid(answers, batch.packed.questions, sameKey(i))) {
        badGrouping += 1;
        continue;
      }
      const answer = answers[sameKey(i)] as { choice: string; probabilities?: Record<string, number> };
      if (answer.choice === NEW_ISSUE) continue;
      const k = Number(answer.choice.slice(1));
      if (!Number.isInteger(k) || k < 0 || k >= i || !pickedProbabilityOk(answer)) {
        badGrouping += 1;
        continue;
      }
      picks.set(i, k);
    }
  });

  if (reals.size === 0) {
    const reason = errors.length
      ? unavailable(errors[0]!)
      : "Jev returned no valid answers; findings are listed as reported, without scoring or grouping.";
    return rawSummary(findings, [reason]);
  }

  const links = new Map<number, number>();
  for (const [i, k] of picks) {
    if (reals.has(k)) links.set(i, k);
    else badGrouping += 1;
  }

  const messages: string[] = [];
  if (errors.length) {
    messages.push(
      `Jev failed for ${failedFindings} finding(s) (${flat(errors[0]!, MAX_MESSAGE_CHARS)}); they are listed alone, unscored and ungrouped.`,
    );
  }
  if (oversized) {
    messages.push(`${oversized} finding(s) were too large for one Jev request and are listed alone, unscored.`);
  }
  if (badScore) {
    messages.push(`${badScore} finding(s) had an invalid or missing Jev score and are listed alone, unscored.`);
  }
  if (badGrouping) {
    messages.push(
      `${badGrouping} finding(s) had an invalid, uncertain or unusable Jev grouping answer and are listed alone, not grouped.`,
    );
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

  for (const indices of components.values()) {
    const noise = indices.every((i) => {
      const r = reals.get(i);
      return r !== undefined && r < threshold;
    });
    if (noise) {
      notes.push(buildItem(scored, indices, reals));
      continue;
    }
    const distinct = new Set(indices.map((i) => scored[i]!.member));
    if (distinct.size > 1) multi.push(indices);
    else unique.push(buildItem(scored, indices, reals));
  }

  const agreements: CouncilItem[] = [];
  const disagreements: CouncilItem[] = [];

  const round2 = planRound2(multi, scored, limits);
  const round2Outcomes = await Promise.all(
    round2.map((b) => (b.packed ? safeAsk(jev, b.packed, signal) : Promise.resolve(undefined))),
  );
  const contradictory = new Set<number>();
  const unchecked = new Set<number>();
  round2.forEach((batch, n) => {
    const outcome = round2Outcomes[n];
    for (let g = batch.from; g <= batch.to; g++) {
      if (!batch.packed || !outcome || "error" in outcome) {
        unchecked.add(g);
        continue;
      }
      if (!valid(outcome.answers, batch.packed.questions, contradictKey(g))) {
        unchecked.add(g);
        continue;
      }
      const p = (outcome.answers[contradictKey(g)] as { noul: number }).noul;
      if (p >= contradictionThreshold) contradictory.add(g);
    }
  });
  multi.forEach((indices, g) => {
    if (contradictory.has(g)) {
      disagreements.push({ ...buildItem(scored, indices, reals, true), contradictionChecked: true });
    } else {
      agreements.push({ ...buildItem(scored, indices, reals), contradictionChecked: !unchecked.has(g) });
    }
  });
  if (unchecked.size) {
    messages.push(
      `The contradiction check was unavailable for ${unchecked.size} group(s); they are listed as agreements and marked unchecked.`,
    );
  }

  for (const f of overflow) unique.push(buildItem([f], [0], undefined));

  const byRealThenSeverity = (a: CouncilItem, b: CouncilItem) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (b.real ?? -1) - (a.real ?? -1);
  agreements.sort(byRealThenSeverity);
  disagreements.sort(byRealThenSeverity);
  unique.sort(byRealThenSeverity);
  notes.sort(byRealThenSeverity);

  return { agreements, disagreements, unique, notes, messages, scoredBy: "jev" };
}
