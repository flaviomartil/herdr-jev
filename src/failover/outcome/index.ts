import { classifyAgy } from "./agy.js";
import { classifyClaude } from "./claude.js";
import { classifyCodex } from "./codex.js";
import type { AttemptResult, Classifier, Outcome } from "./types.js";

export type { AttemptResult, Outcome, OutcomeKind } from "./types.js";

const CLASSIFIERS: Record<string, Classifier> = { codex: classifyCodex, agy: classifyAgy, claude: classifyClaude };

export function classify(cli: string, result: AttemptResult): Outcome {
  const one = CLASSIFIERS[cli];
  if (!one) return result.code === 0 ? { kind: "Success", why: "exit 0" } : { kind: "Failed", why: `unknown cli ${cli}` };
  return one(result);
}
