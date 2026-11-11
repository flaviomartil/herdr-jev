export type OutcomeKind = "Success" | "Quota" | "Auth" | "Transient" | "Failed" | "Timeout";

export interface Outcome {
  kind: OutcomeKind;
  resetAt?: number;
  retryAfterMs?: number;
  request?: boolean;
  why: string;
}

export interface AttemptResult {
  code: number;
  timedOut?: boolean;
  output: string;
  now: number;
}

export type Classifier = (result: AttemptResult) => Outcome;
