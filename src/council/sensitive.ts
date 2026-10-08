import { SENSITIVE_FILES } from "../harness/review.js";

const COUNCIL_SENSITIVE: readonly RegExp[] = [
  ...SENSITIVE_FILES,
  /(^|\/)\.(npmrc|netrc|pypirc)$/,
  /\.tfvars(\.json)?$/i,
];

export function isSensitivePath(path: string): boolean {
  return COUNCIL_SENSITIVE.some((pattern) => pattern.test(path));
}
