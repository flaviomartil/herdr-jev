const REDACTED = "[REDACTED]";
const NAME = "(?:token|password|passwd|pwd|secret|credential|api[_-]?key|apikey|bearer|authorization)";
const KEYWORD = /^(?:undefined|null|true|false|nil|none|void|nan)$/i;
const SHA_CONTEXT = /(?:commit|sha|sha1|rev|revision|hash|ref)\W{0,4}$/i;

const SHAPES: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

const BEARER = /\b(Bearer\s+)(?=[A-Za-z0-9._~+/-]*\d)[A-Za-z0-9._~+/-]{16,}=*/gi;
const HEX_RUN = /(?<![A-Za-z0-9])[0-9a-fA-F]{32,}(?![A-Za-z0-9])/g;
const ALNUM_RUN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g;
const ASSIGNMENT = new RegExp(
  `\\b([A-Za-z0-9_.-]*${NAME}[A-Za-z0-9_.-]*)(\\s*[:=]\\s*)(?!=)("[^"]{4,}"|'[^']{4,}'|[^\\s"'\`,;)\\]}]{16,})`,
  "gi",
);

function removable(code: number): boolean {
  return (
    (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0xad ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2064) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  );
}

export function clean(text: unknown): string {
  let out = "";
  for (const char of String(text ?? "")) {
    const code = char.codePointAt(0) ?? 0;
    if (removable(code)) continue;
    out += code === 0x2028 || code === 0x2029 ? " " : char;
  }
  return out.replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

export function redact(text: string): string {
  let out = text;
  for (const shape of SHAPES) out = out.replace(shape, REDACTED);
  out = out.replace(BEARER, `$1${REDACTED}`);
  out = out.replace(HEX_RUN, (match, offset: number, whole: string) => {
    if (match.length === 40 && SHA_CONTEXT.test(whole.slice(Math.max(0, offset - 24), offset))) return match;
    return REDACTED;
  });
  out = out.replace(ALNUM_RUN, (match) => {
    const digits = match.replace(/\D/g, "").length;
    return /[A-Z]/.test(match) && /[a-z]/.test(match) && digits >= 3 ? REDACTED : match;
  });
  out = out.replace(ASSIGNMENT, (match, name: string, separator: string, value: string) => {
    const quoted = value.startsWith('"') || value.startsWith("'");
    const inner = quoted ? value.slice(1, -1).trim() : value;
    if (KEYWORD.test(inner)) return match;
    if (!quoted && /^[A-Za-z_$.]+$/.test(inner)) return match;
    return `${name}${separator}${REDACTED}`;
  });
  return out;
}

export function plain(text: unknown, max: number): string {
  return clip(clean(text), max);
}

export function safe(text: unknown, max: number): string {
  return clip(redact(clean(text)), max);
}

export function place(path: unknown, line: number | undefined, max: number): string {
  const suffix = typeof line === "number" && Number.isFinite(line) ? `:${line}` : "";
  return plain(path, Math.max(1, max - suffix.length)) + suffix;
}
