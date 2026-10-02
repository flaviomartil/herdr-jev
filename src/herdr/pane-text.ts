export const ANSI_PATTERN = new RegExp(
  [
    "\\x1b\\][^\\x07\\x1b\\n]*(?:\\x07|\\x1b\\\\)?",
    "\\x1b[PX^_][^\\x1b\\n]*(?:\\x1b\\\\)?",
    "\\x1b\\[[0-?]*[ -/]*[@-~]",
    "\\x1b[ -/]*[0-~]",
    "\\x1b",
    "[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f-\\x9f]",
  ].join("|"),
  "g",
);

const MAX_REDACT_INPUT = 8192;
const TRUNCATION_MARK = " [TRUNCATED]";
const WHOLE_INPUT_REDACTED = "[REDACTED]";

const CHROME_LINE_PATTERNS: readonly RegExp[] = [
  /^[\s─━│┃╭╮╯╰┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬▀▄█░▒▓▪▫•·◦∙◐◑◒◓✳✶✻*_=~+\-./\\]+$/,
  /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◑◒◓]\s*/,
  /\?\s*for\s+shortcuts/i,
  /\b\d+\s+warnings?\b/i,
  /f2\s+to\s+view/i,
  /esc\s+to\s+interrupt/i,
  /^[›>»$❯]\s*Ask\b.*to do anything/i,
  /ask\s+\w+\s+to\s+do\s+anything/i,
  /^[›>»$❯\s]*$/,
  /\b(?:gpt|claude|gemini|sonnet|opus|haiku|codex|fable|luna|astra|sol)\b.*·/i,
  /·.*·.*·/,
  /·\s*~?\//,
  /^pane title:\s*/i,
  /^\s*│\s*spinner\s*│\s*$/i,
  /\bto (?:confirm|cancel|exit|quit|interrupt|toggle|select|submit|expand|collapse)\b/i,
  /\b(?:esc|enter|ctrl|cmd|opt|alt|shift|tab)\b[^.]{0,24}\bto\b/i,
  /\bctrl\+[a-z]\b/i,
  /\btype to (?:steer|reply)\b/i,
  /tokens?\s*(?:used|left)/i,
  /^\s*[└─│├┌┐┘┴┬┼═]?\s*Tip:\s*/i,
  /\bTip:\s*Use\s+/i,
  /^[⏵▶]\s*bypass permissions/i,
  /\bbypass permissions\b/i,
  /\b\d+\s*shells\s*-\s*←\s*\d+\s*agents/i,
  /^\s*[\u2800-\u28FF]+\s*Running command/i,
  /\bRunning command\.\.\./i,
  /^\s*⏱/i,
  /\b\d+d\s*[↑↓]?\d+%/i,
  /\bUpdate installed\b/i,
  /\bRestart to update\b/i,
  /^\s*Worked for\s+\d+/i,
  /^[\s\u2800-\u28FF]+$/,
  /[\u2800-\u28FF]/,
  /[⏱⏵▶⚡⚙↑↓▲▼←→]/,
  /\bexpand\)/i,
  /\(ctrl\+o to expand\)/i,
  /ctrl\+o to expand/i,
  /^\s*Sem atividade:\s*/i,
  /^Sem atividade\b/i,
  /^Resumo do dia\b/i,
];

function unboxLine(line: string): string {
  return line.trim().replace(/^[│┃|]\s*/, "").replace(/\s*[│┃|]$/, "").trim();
}

const JOIN_SEPARATORS = ["", " "] as const;

function neighborLine(lines: string[], from: number, step: 1 | -1): string {
  for (let i = from + step; i >= 0 && i < lines.length; i += step) {
    const candidate = unboxLine(lines[i]);
    if (candidate) return candidate;
  }
  return "";
}

type PrevVerdict = { drop: true } | { current: string };

type Redactor = (text: string) => string;

function memoizedRedactor(): Redactor {
  const cache = new Map<string, string>();
  return (text) => {
    let value = cache.get(text);
    if (value === undefined) {
      value = redactSecrets(text);
      cache.set(text, value);
    }
    return value;
  };
}

function checkPrevJoin(prevLine: string, current: string, sep: string, redact: Redactor): PrevVerdict {
  const redactedPrev = redact(prevLine);
  const redactedCurrent = redact(current);
  const redactedJoin = redact(prevLine + sep + current);
  if (redactedJoin === redactedPrev + sep + redactedCurrent) return { current };
  if (redactedPrev === prevLine) return { drop: true };
  if (!redactedJoin.startsWith(redactedPrev)) return { drop: true };
  const remainder = redactedJoin.slice(redactedPrev.length).trim();
  return remainder ? { current: remainder } : { drop: true };
}

function leaksIntoNext(current: string, nextLine: string, sep: string, redact: Redactor): boolean {
  if (redact(current) !== current) return false;
  return redact(current + sep + nextLine) !== current + sep + redact(nextLine);
}

export function lastMeaningfulLine(text: string): string {
  if (!text) return "";
  const cleaned = text.replace(ANSI_PATTERN, "");
  const lines = cleaned.split(/\r\n|\r|\n/);

  const redact = memoizedRedactor();
  let lastActionLine: string | null = null;
  let lastFallbackLine: string | null = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    let line = lines[i].trim();
    if (!line) continue;
    if (CHROME_LINE_PATTERNS.some((pattern) => pattern.test(line))) continue;

    const prevLine = neighborLine(lines, i, -1);
    const nextLine = neighborLine(lines, i, 1);
    let current = unboxLine(line);
    let dropped = false;
    if (prevLine) {
      for (const sep of JOIN_SEPARATORS) {
        const verdict = checkPrevJoin(prevLine, current, sep, redact);
        if ("drop" in verdict) {
          dropped = true;
          break;
        }
        if (verdict.current !== current) {
          current = verdict.current;
          line = verdict.current;
        }
      }
    }
    if (dropped) continue;
    if (nextLine && JOIN_SEPARATORS.some((sep) => leaksIntoNext(current, nextLine, sep, redact))) continue;

    const isAction = /^[•●]/.test(line);
    const stripped = line.replace(/^[•●·│┃|>»⏵]\s*/, "").replace(/\s*[│┃|]$/, "").trim();
    if (!stripped) continue;
    if (CHROME_LINE_PATTERNS.some((pattern) => pattern.test(stripped))) continue;

    if (isAction && !lastActionLine) {
      lastActionLine = stripped;
      break;
    }
    if (!lastFallbackLine) {
      lastFallbackLine = stripped;
    }
  }

  const chosen = lastActionLine ?? lastFallbackLine ?? "";
  const redacted = redactSecrets(chosen);
  return redacted.length > 100 ? redacted.slice(0, 100) : redacted;
}

const KEY_CHAR = "[a-zA-Z0-9_.-]";
const SECRET_WORD = "(?:password|token|secret|api[_-]?key)";
const QUOTED_OR_OPEN = "(?<q>[\"'])(?:(?:\\\\.|(?!\\k<q>)[^\\\\])*(?<c>\\k<q>)|[^\\r\\n]*)";

const QUOTED_KEY_VALUE = new RegExp(
  `(?<!${KEY_CHAR})(?=${KEY_CHAR}*?${SECRET_WORD})(?<p>${KEY_CHAR}+["']?\\s*[:=]\\s*)${QUOTED_OR_OPEN}`,
  "gi",
);
const PLAIN_VALUE = `(?:(?:bearer|basic)\\s+)?[^\\s"';&,}]+(?:[;&,](?=(?<seg>[^\\s"';&,}=:]+))\\k<seg>(?![=:]))*`;

const PLAIN_KEY_VALUE = new RegExp(
  `(?<!${KEY_CHAR})(?=${KEY_CHAR}*?${SECRET_WORD})(?<p>${KEY_CHAR}+["']?\\s*[:=]\\s*)${PLAIN_VALUE}`,
  "gi",
);
const QUOTED_FLAG_VALUE = new RegExp(
  `(?<![a-z0-9_-])(?<p>--[a-z0-9_-]*${SECRET_WORD}\\b["']?\\s+)${QUOTED_OR_OPEN}`,
  "gi",
);
const PLAIN_FLAG_VALUE = new RegExp(
  `(?<![a-z0-9_-])(?<p>--[a-z0-9_-]*${SECRET_WORD}\\b["']?\\s+)${PLAIN_VALUE}`,
  "gi",
);

function looksLikeBasicCredential(token: string): boolean {
  return /[0-9+=]/.test(token) || /[A-Z]/.test(token.slice(1));
}

function looksLikeHostAndPort(user: string, rest: string): boolean {
  return /^\d{1,5}\//.test(rest) && (user === "localhost" || user.includes("."));
}

function boundRedactionInput(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_REDACT_INPUT) return { text, truncated: false };
  const limit = MAX_REDACT_INPUT - TRUNCATION_MARK.length;
  let end = limit;
  if (!/\s/.test(text[end]) && !/\s/.test(text[end - 1])) {
    while (end > 0 && !/\s/.test(text[end - 1])) end--;
  }
  return { text: text.slice(0, end), truncated: true };
}

export function redactSecrets(text: string): string {
  if (!text) return "";
  const bounded = boundRedactionInput(text);
  if (bounded.truncated && bounded.text === "") return WHOLE_INPUT_REDACTED;
  let result = bounded.text;
  result = result.replace(QUOTED_KEY_VALUE, "$<p>$<q>[REDACTED]$<c>");
  result = result.replace(PLAIN_KEY_VALUE, "$<p>[REDACTED]");
  result = result.replace(QUOTED_FLAG_VALUE, "$<p>$<q>[REDACTED]$<c>");
  result = result.replace(PLAIN_FLAG_VALUE, "$<p>[REDACTED]");
  result = result.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/g, "Bearer [REDACTED]");
  result = result.replace(/\b(bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, "$1 [REDACTED]");
  result = result.replace(/(\bAuthorization["']?\s*[:=]\s*["']?Basic\s+)[A-Za-z0-9+/_-]+={0,2}/gi, "$1[REDACTED]");
  result = result.replace(/\bBasic\s+([A-Za-z0-9+/]{8,}={0,2})(?![A-Za-z0-9+/=])/g, (match, token: string) =>
    looksLikeBasicCredential(token) ? "Basic [REDACTED]" : match,
  );
  result = result.replace(/\b(?:sk-[a-zA-Z0-9_-]+|ghp_[a-zA-Z0-9]+|xoxb-[a-zA-Z0-9_-]+|glpat-[a-zA-Z0-9_-]+)\b/g, "[REDACTED]");
  result = result.replace(/\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g, "[REDACTED]");
  result = result.replace(
    /(?<![a-zA-Z0-9+.-])([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^\s:@/]+):([^\s@]{1,2048})@/g,
    (match, scheme: string, user: string, rest: string) =>
      looksLikeHostAndPort(user, rest) ? match : `${scheme}${user}:[REDACTED]@`,
  );
  result = result.replace(
    /(?<![a-zA-Z0-9_.~%-])([a-zA-Z0-9_.~%-]+):([^\s@/]{1,512})@/g,
    "$1:[REDACTED]@",
  );
  result = result.replace(/\b(?=[0-9a-fA-F]{0,128}[0-9])[0-9a-fA-F]{32,}\b/g, "[REDACTED]");
  result = result.replace(
    /\b(?=[A-Za-z0-9_+=~-]{0,128}[0-9])(?=[A-Za-z0-9_+=~-]{0,128}[a-zA-Z])[A-Za-z0-9_+=~-]{32,}={0,2}(?![A-Za-z0-9_+=~-])/g,
    "[REDACTED]",
  );
  result = result.replace(
    /(?<![/A-Za-z0-9_.+-])(?=[A-Za-z0-9+/]{0,128}[0-9])(?=[A-Za-z0-9+/]{0,128}[a-zA-Z])[A-Za-z0-9+/]{32,}={0,2}(?![/A-Za-z0-9_.=-])/g,
    "[REDACTED]",
  );
  return bounded.truncated ? result + TRUNCATION_MARK : result;
}
