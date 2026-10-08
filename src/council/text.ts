import { redactSecrets } from "../herdr/pane-text.js";

function isControl(code: number): boolean {
  return code < 32 || code === 127 || code === 0x85 || code === 0x2028 || code === 0x2029;
}

function stripControl(text: string): string {
  let out = "";
  for (const char of text) out += isControl(char.codePointAt(0) ?? 0) ? " " : char;
  return out;
}

export function flat(text: string, max: number): string {
  const clean = stripControl(redactSecrets(String(text ?? ""))).replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, Math.max(0, max - 1))}…` : clean;
}
