const ANSI_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\].*?(?:\x07|\x1b\\)/g;

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

export function lastMeaningfulLine(text: string): string {
  if (!text) return "";
  const cleaned = text.replace(ANSI_PATTERN, "");
  const lines = cleaned.split(/\r?\n/);

  let lastActionLine: string | null = null;
  let lastFallbackLine: string | null = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    let line = lines[i].trim();
    if (!line) continue;
    if (CHROME_LINE_PATTERNS.some((pattern) => pattern.test(line))) continue;

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
  return chosen.length > 100 ? chosen.slice(0, 100) : chosen;
}

export function redactSecrets(text: string): string {
  if (!text) return "";
  let result = text;
  result = result.replace(
    /(\b[a-zA-Z0-9_.-]*(?:password|token|secret|api[_-]?key)[a-zA-Z0-9_.-]*\s*=\s*)(["']?)[^"'\s;&]+(["']?)/gi,
    "$1$2[REDACTED]$3",
  );
  result = result.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/g, "Bearer [REDACTED]");
  result = result.replace(/\b(?:sk-[a-zA-Z0-9_-]+|ghp_[a-zA-Z0-9]+|xoxb-[a-zA-Z0-9_-]+)\b/g, "[REDACTED]");
  result = result.replace(/\b[0-9a-fA-F]{32,}\b/g, "[REDACTED]");
  result = result.replace(
    /\b(?=[A-Za-z0-9_+=~-]*[0-9])(?=[A-Za-z0-9_+=~-]*[a-zA-Z])[A-Za-z0-9_+=~-]{32,}={0,2}\b/g,
    "[REDACTED]",
  );
  return result;
}
