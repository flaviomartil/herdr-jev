const REDACTED = "[REDACTED]";
const RAW_FACTOR = 4;
const PEM_WINDOW = 12_000;
const NAME =
  /(?:token|password|passwd|pwd|secret|credential|api[_-]?key|access[_-]?key|account[_-]?key|private[_-]?key|bearer|authorization)/i;
const NAME_ONLY =
  /^(?:tokens?|passwords?|passwd|pwd|secrets?|credentials?|api[_-]?keys?|bearer|authorization)$/i;
const KEYWORD = /^(?:undefined|null|true|false|nil|none|void|nan|include|omit|same-origin)$/i;
const SHA_CONTEXT =
  /(?:commit|sha|sha1|rev|revision|hash|ref|(?:introduced|regressed|fixed|broken|added|changed|reverted)\s+(?:in|by|at))\W{0,4}$/i;
const DOTTED_IDENTIFIER = /^[A-Za-z_$][A-Za-z_$]*[0-9]*(?:[!?]?\.[A-Za-z_$][A-Za-z_$]*[0-9]*)+$/;
const FILE_PATH = /^(?:~|\.{1,2})?\/[A-Za-z0-9_.\/-]+$/;

const PREFIX_SHAPES: RegExp[] = [
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

const PEM_HEADER = /-----BEGIN [A-Z0-9 ]{2,40}-----/g;
const URL_USERINFO = /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]{1,20}:\/\/[^\s:@/]{0,128}:)[^\s@/]{1,256}@/g;
const BASIC = /\b(Basic[ \t]+)([A-Za-z0-9+/]{8,}={0,2})(?![A-Za-z0-9+/=])/g;
const AUTH_BEFORE = /authorization\W{0,4}$/i;
const BEARER = /\b(Bearer[ \t]+)(?=[A-Za-z0-9._~+/-]*\d)[A-Za-z0-9._~+/-]{16,}=*/gi;
const HEX_RUN = /(?<![A-Za-z0-9])[0-9a-fA-F]{32,}(?![A-Za-z0-9])/g;
const ALNUM_RUN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g;
const VALUE_CAP = 256;
const VALUE = `("[^"]{4,}"|'[^']{4,}'|[^\\s"'\`,;()\\]}]{6,${VALUE_CAP}})`;
const VALUE_REST = /[^\s"'`,;()\]}]*/y;
const KEYED = new RegExp(
  `(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{1,80})(["'\\]]{0,2}[ \\t]*(?:=>|[!=]==?|:=|[:=])[ \\t]*(?:\\n[ \\t]+)?)${VALUE}`,
  "g",
);
const FALLBACK = new RegExp(
  `(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{1,80})(["'\\]]{0,2}[ \\t]*[:=][ \\t]*[^\\s|?,;(){}"']{1,120}(?:\\[[^\\]\\n]{1,60}\\])?[ \\t]*(?:\\|\\||\\?\\?)[ \\t]*)("[^"]{4,}"|'[^']{4,}')`,
  "g",
);
const SK_RUN = /\bsk-[A-Za-z0-9_-]{20,}/g;
const FLAG = new RegExp(`(?<![A-Za-z0-9_-])(--[A-Za-z0-9_-]{1,60})([ \\t]+)${VALUE}`, "g");

function removable(code: number): boolean {
  return (
    (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0xad ||
    code === 0x34f ||
    code === 0x61c ||
    code === 0x115f ||
    code === 0x1160 ||
    code === 0x180e ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2064) ||
    (code >= 0x2066 && code <= 0x206f) ||
    code === 0x3164 ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    code === 0xfeff ||
    code === 0xffa0 ||
    (code >= 0xe0000 && code <= 0xe0fff)
  );
}

function strip(text: unknown, max?: number): string {
  let raw = String(text ?? "");
  if (max !== undefined && raw.length > max) raw = raw.slice(0, max);
  let out = "";
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0;
    if (removable(code)) continue;
    out += code === 0x2028 || code === 0x2029 || code === 0x85 ? "\n" : char;
  }
  return out.replace(/\r\n?/g, "\n");
}

export function clean(text: unknown): string {
  return strip(text).replace(/\s+/g, " ").trim();
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function redactPem(text: string): string {
  let out = "";
  let last = 0;
  PEM_HEADER.lastIndex = 0;
  let header: RegExpExecArray | null;
  while ((header = PEM_HEADER.exec(text)) !== null) {
    const start = header.index;
    if (start < last) continue;
    const bodyStart = start + header[0].length;
    const label = header[0].slice("-----BEGIN ".length, -5);
    const endMark = `-----END ${label}-----`;
    const window = text.slice(bodyStart, bodyStart + PEM_WINDOW);
    const endAt = window.indexOf(endMark);
    let stop = -1;
    if (endAt >= 0) stop = bodyStart + endAt + endMark.length;
    else {
      const body = /^(?:[ \t\n]*[A-Za-z0-9+/=]{16,})+/.exec(window);
      if (body && body[0].replace(/[ \t\n]/g, "").length >= 32) stop = bodyStart + body[0].length;
    }
    if (stop < 0) continue;
    out += text.slice(last, start) + REDACTED;
    last = stop;
    PEM_HEADER.lastIndex = stop;
  }
  return out + text.slice(last);
}

function secretValue(separator: string, value: string): boolean {
  const quoted = value.startsWith('"') || value.startsWith("'");
  const inner = quoted ? value.slice(1, -1).trim() : value;
  if (KEYWORD.test(inner)) return false;
  if (quoted) return !NAME_ONLY.test(inner);
  if (/[!=]=|=>/.test(separator)) return false;
  if (/^[\d:.,-]+$/.test(inner)) return false;
  if (/^[A-Za-z_$.]+$/.test(inner)) return false;
  if (DOTTED_IDENTIFIER.test(inner)) return false;
  if (FILE_PATH.test(inner) && !/[^/]{25,}/.test(inner)) return false;
  if (inner.length >= 16) return true;
  if (!/\d/.test(inner)) return false;
  if (/^[A-Z0-9/_.-]+$/.test(inner)) return false;
  return (/[a-z]/.test(inner) && /[A-Z]/.test(inner)) || /[!@#$%^&*+?~]/.test(inner);
}

function redactKeyed(text: string, pattern: RegExp, fixedSeparator?: string): string {
  let out = "";
  let last = 0;
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const name = match[1] ?? "";
    const separator = match[2] ?? "";
    const value = match[3] ?? "";
    const judged = fixedSeparator ?? separator;
    const capped = value.length === VALUE_CAP && !value.startsWith('"') && !value.startsWith("'");
    const secret = NAME.test(name) && (capped ? !/[!=]=|=>/.test(judged) : secretValue(judged, value));
    if (!secret) {
      pattern.lastIndex = match.index + name.length;
      continue;
    }
    let end = match.index + match[0].length;
    if (capped) {
      VALUE_REST.lastIndex = end;
      end += VALUE_REST.exec(text)?.[0].length ?? 0;
    }
    out += text.slice(last, match.index) + name + separator + REDACTED;
    last = end;
    pattern.lastIndex = end;
  }
  return out + text.slice(last);
}

export function redactShapes(text: string): string {
  let out = redactPem(text);
  for (const shape of PREFIX_SHAPES) out = out.replace(shape, REDACTED);
  out = out.replace(SK_RUN, (match, offset: number, whole: string) =>
    /\d/.test(match) && !/^\.[A-Za-z0-9]/.test(whole.slice(offset + match.length, offset + match.length + 2)) ? REDACTED : match,
  );
  return out;
}

function redactOnce(text: string): string {
  let out = redactShapes(text);
  out = out.replace(URL_USERINFO, `$1${REDACTED}@`);
  out = out.replace(BASIC, (match, head: string, token: string, offset: number, whole: string) => {
    const afterAuth = AUTH_BEFORE.test(whole.slice(Math.max(0, offset - 24), offset));
    if (afterAuth) return /[0-9+/=]/.test(token) || /[A-Z]/.test(token.slice(1)) ? `${head}${REDACTED}` : match;
    return token.length >= 16 && /[0-9=]/.test(token) ? `${head}${REDACTED}` : match;
  });
  out = out.replace(BEARER, `$1${REDACTED}`);
  out = redactKeyed(out, KEYED);
  out = redactKeyed(out, FLAG, ":");
  out = redactKeyed(out, FALLBACK, ":");
  out = out.replace(HEX_RUN, (match, offset: number, whole: string) => {
    if (match.length === 40 && SHA_CONTEXT.test(whole.slice(Math.max(0, offset - 24), offset))) return match;
    return REDACTED;
  });
  out = out.replace(ALNUM_RUN, (match) => {
    const digits = match.replace(/\D/g, "").length;
    return /[A-Z]/.test(match) && /[a-z]/.test(match) && digits >= 3 ? REDACTED : match;
  });
  return out;
}

export function redact(text: string): string {
  let current = text;
  for (let pass = 0; pass < 3; pass++) {
    const next = redactOnce(current);
    if (next === current) break;
    current = next;
  }
  return current;
}

export function plain(text: unknown, max: number): string {
  return clip(clean(String(text ?? "").slice(0, max * RAW_FACTOR)), max);
}

export function safe(text: unknown, max: number): string {
  return clip(clean(redact(clean(String(text ?? "").slice(0, max * RAW_FACTOR)))), max);
}

export function safeBlock(text: unknown, max: number): string {
  const raw = strip(text, max * RAW_FACTOR).trim();
  const redacted = redact(raw);
  return clip(redacted, max);
}

export function pathText(text: unknown, max: number): string {
  return clip(redactShapes(clean(String(text ?? "").slice(0, max * RAW_FACTOR))), max);
}

export function place(path: unknown, line: number | undefined, max: number): string {
  const suffix = typeof line === "number" && Number.isFinite(line) ? `:${line}` : "";
  return pathText(path, Math.max(1, max - suffix.length)) + suffix;
}
