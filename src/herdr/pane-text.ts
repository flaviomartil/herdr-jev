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
const PARTIAL_TOKEN_WINDOW = 256;

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

export function lastMeaningfulLine(text: string): string {
  if (!text) return "";
  const cleaned = text.replace(ANSI_PATTERN, "");
  const lines = cleaned.split(/\r\n|\r|\n/);

  let lastActionLine: string | null = null;
  let lastFallbackLine: string | null = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    let line = lines[i].trim();
    if (!line) continue;
    if (CHROME_LINE_PATTERNS.some((pattern) => pattern.test(line))) continue;

    const prevLine = i > 0 ? unboxLine(lines[i - 1]) : "";
    const nextLine = i + 1 < lines.length ? unboxLine(lines[i + 1]) : "";
    let current = unboxLine(line);
    if (prevLine && redactSecrets(prevLine + current) !== prevLine + current) {
      const redactedPrev = redactSecrets(prevLine);
      const redactedJoin = redactSecrets(prevLine + current);
      if (redactedPrev === prevLine) continue;
      if (redactedJoin !== redactedPrev + current) {
        if (!redactedJoin.startsWith(redactedPrev)) continue;
        const remainder = redactedJoin.slice(redactedPrev.length).trim();
        if (!remainder) continue;
        current = remainder;
        line = remainder;
      }
    }
    if (nextLine && redactSecrets(current) === current && redactSecrets(current + nextLine) !== current + nextLine) continue;

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
const PLAIN_KEY_VALUE = new RegExp(
  `(?<!${KEY_CHAR})(?=${KEY_CHAR}*?${SECRET_WORD})(?<p>${KEY_CHAR}+["']?\\s*[:=]\\s*)[^\\s"';&,}]+`,
  "gi",
);
const QUOTED_FLAG_VALUE = new RegExp(
  `(?<![a-z0-9_-])(?<p>--[a-z0-9_-]*${SECRET_WORD}\\b["']?\\s+)${QUOTED_OR_OPEN}`,
  "gi",
);
const PLAIN_FLAG_VALUE = new RegExp(
  `(?<![a-z0-9_-])(?<p>--[a-z0-9_-]*${SECRET_WORD}\\b["']?\\s+)[^\\s"';&,}]+`,
  "gi",
);

function looksLikeBasicCredential(token: string): boolean {
  return /[0-9+=]/.test(token) || /[A-Z]/.test(token.slice(1));
}

function looksLikeHostAndPort(user: string, rest: string): boolean {
  return /^\d{1,5}\//.test(rest) && (user === "localhost" || user.includes("."));
}

function boundRedactionInput(text: string): string {
  if (text.length <= MAX_REDACT_INPUT) return text;
  let end = MAX_REDACT_INPUT;
  if (!/\s/.test(text[end]) && !/\s/.test(text[end - 1])) {
    const floor = end - PARTIAL_TOKEN_WINDOW;
    while (end > floor && !/\s/.test(text[end - 1])) end--;
  }
  return text.slice(0, end);
}

export function redactSecrets(text: string): string {
  if (!text) return "";
  let result = boundRedactionInput(text);
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
  return result;
}
