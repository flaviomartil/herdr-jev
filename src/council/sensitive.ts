import { SENSITIVE_FILES } from "../harness/review.js";

const COUNCIL_SENSITIVE: readonly RegExp[] = [
  ...SENSITIVE_FILES,
  /(^|\/)\.(npmrc|netrc|pypirc|envrc|git-credentials)$/i,
  /(^|\/)\.env$/i,
  /(^|\/)\.env[-_.](?!(example|sample|template|dist)$)[^/]*$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /\.tfvars(\.json)?$/i,
];

export function isSensitivePath(path: string): boolean {
  return COUNCIL_SENSITIVE.some((pattern) => pattern.test(path));
}
