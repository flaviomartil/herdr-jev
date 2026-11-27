export type PromptBoxState = "empty" | "placeholder_only" | "human_draft" | "unseen";

export interface PromptBoxInspection {
  state: PromptBoxState;
  shouldHold: boolean;
  draftPreview?: string;
  marker?: "❯" | "›";
}

interface AnsiCell {
  ch: string;
  isDim: boolean;
}

interface SgrStyle {
  dim: boolean;
  grayFg: boolean;
}

const MAX_BOTTOM_NON_EMPTY_LINES = 15;
const PASTE_PLACEHOLDER_PATTERN = /\[Pasted text #\d+/i;

function applySgrParamString(rawParams: string, style: SgrStyle): void {
  if (rawParams === "") {
    style.dim = false;
    style.grayFg = false;
    return;
  }
  const tokens = rawParams.split(";");
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.includes(":")) {
      const parts = token.split(":").map((part) => (part === "" ? undefined : Number.parseInt(part, 10)));
      const attr = parts[0];
      const mode = parts[1];
      if (attr === 38) {
        if (mode === 5 && parts[2] !== undefined && !Number.isNaN(parts[2])) {
          const color = parts[2];
          style.grayFg = color === 8 || (color >= 232 && color <= 249);
        } else if (mode === 2) {
          const [r, g, b] = parts.length >= 6 ? [parts[3], parts[4], parts[5]] : [parts[2], parts[3], parts[4]];
          if (
            r !== undefined && g !== undefined && b !== undefined &&
            !Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)
          ) {
            style.grayFg = r === g && g === b && r < 170;
          }
        }
      }
      continue;
    }

    const code = token === "" ? 0 : Number.parseInt(token, 10);
    if (Number.isNaN(code)) continue;
    if (code === 0) {
      style.dim = false;
      style.grayFg = false;
    } else if (code === 1) {
      style.dim = false;
    } else if (code === 2) {
      style.dim = true;
    } else if (code === 22) {
      style.dim = false;
    } else if (code === 39 || (code >= 30 && code <= 37) || (code >= 91 && code <= 97)) {
      style.grayFg = false;
    } else if (code === 90) {
      style.grayFg = true;
    } else if (code === 38 || code === 48 || code === 58) {
      const mode = tokens[i + 1] === undefined ? Number.NaN : Number.parseInt(tokens[i + 1], 10);
      if (mode === 5 && i + 2 < tokens.length) {
        if (code === 38) {
          const color = Number.parseInt(tokens[i + 2], 10);
          if (!Number.isNaN(color)) style.grayFg = color === 8 || (color >= 232 && color <= 249);
        }
        i += 2;
      } else if (mode === 2 && i + 4 < tokens.length) {
        if (code === 38) {
          const r = Number.parseInt(tokens[i + 2], 10);
          const g = Number.parseInt(tokens[i + 3], 10);
          const b = Number.parseInt(tokens[i + 4], 10);
          if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) {
            style.grayFg = r === g && g === b && r < 170;
          }
        }
        i += 4;
      }
    }
  }
}

function parseAnsiLineCells(line: string, style: SgrStyle): AnsiCell[] {
  const cells: AnsiCell[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === "\x1b") {
      const next = line[i + 1];
      if (next === "[") {
        const paramStart = i + 2;
        let j = paramStart;
        while (j < line.length && line.charCodeAt(j) >= 0x30 && line.charCodeAt(j) <= 0x3f) j++;
        const intermediateStart = j;
        while (j < line.length && line.charCodeAt(j) >= 0x20 && line.charCodeAt(j) <= 0x2f) j++;
        if (j < line.length && line.charCodeAt(j) >= 0x40 && line.charCodeAt(j) <= 0x7e) {
          const rawParams = line.slice(paramStart, intermediateStart);
          if (line[j] === "m" && intermediateStart === j && !/[?>=<]/.test(rawParams)) {
            applySgrParamString(rawParams, style);
          }
          i = j + 1;
          continue;
        }
      } else if (next === "]") {
        let j = i + 2;
        while (j < line.length) {
          if (line[j] === "\x07") {
            j += 1;
            break;
          }
          if (line[j] === "\x1b" && line[j + 1] === "\\") {
            j += 2;
            break;
          }
          j++;
        }
        i = j;
        continue;
      }
      i++;
      continue;
    }

    const code = line.charCodeAt(i);
    if ((code >= 0x00 && code < 0x20 && line[i] !== "\t") || (code >= 0x7f && code <= 0x9f)) {
      i++;
      continue;
    }

    const ch = line[i] === "\t" || line[i] === "\u00a0" ? " " : line[i];
    cells.push({ ch, isDim: style.dim || style.grayFg });
    i++;
  }
  return cells;
}

function trimCells(cells: AnsiCell[]): AnsiCell[] {
  let start = 0;
  let end = cells.length;
  while (start < end && cells[start].ch === " ") start++;
  while (end > start && cells[end - 1].ch === " ") end--;
  return cells.slice(start, end);
}

function unboxCells(cells: AnsiCell[]): AnsiCell[] {
  let out = trimCells(cells);
  if (out.length > 0 && (out[0].ch === "│" || out[0].ch === "┃")) {
    out = trimCells(out.slice(1));
  }
  if (out.length > 0 && (out[out.length - 1].ch === "│" || out[out.length - 1].ch === "┃")) {
    out = trimCells(out.slice(0, -1));
  }
  return out;
}

function allowedMarkers(clientKind?: string): ReadonlySet<string> {
  if (clientKind === "claude") return new Set(["❯"]);
  if (clientKind === "codex") return new Set(["›"]);
  return new Set(["❯", "›"]);
}

/**
 * Inspect bottom-most Claude/Codex prompt box lines using ANSI SGR dim/faint
 * intensity to distinguish ghost suggestions from human-typed drafts.
 */
export function inspectPromptBoxAnsi(
  rawAnsi: string,
  options?: { clientKind?: string; agentStatus?: string | null },
): PromptBoxInspection {
  if (!rawAnsi) return { state: "unseen", shouldHold: false };

  const rawLines = rawAnsi.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const style: SgrStyle = { dim: false, grayFg: false };
  const parsedLines = rawLines.map((line) => parseAnsiLineCells(line, style));

  const nonEmptyIndices: number[] = [];
  for (let i = 0; i < parsedLines.length; i++) {
    const text = parsedLines[i].map((c) => c.ch).join("").trim();
    if (text.length > 0) nonEmptyIndices.push(i);
  }
  if (nonEmptyIndices.length === 0) return { state: "unseen", shouldHold: false };

  const windowStart = Math.max(0, nonEmptyIndices.length - MAX_BOTTOM_NON_EMPTY_LINES);
  const candidateIndices = nonEmptyIndices.slice(windowStart);
  const markers = allowedMarkers(options?.clientKind);

  for (let idx = candidateIndices.length - 1; idx >= 0; idx--) {
    const lineIdx = candidateIndices[idx];
    const unboxed = unboxCells(parsedLines[lineIdx]);
    if (unboxed.length === 0) continue;

    const first = unboxed[0].ch;
    if (!markers.has(first)) continue;

    const afterMarker = unboxed.slice(1);
    if (afterMarker.length > 0 && afterMarker[0].ch !== " " && afterMarker[0].ch !== "!" && afterMarker[0].ch !== "[") {
      continue;
    }

    const contentCells = trimCells(afterMarker);
    const marker = first as "❯" | "›";

    if (contentCells.length === 0) {
      return { state: "empty", shouldHold: false, marker };
    }

    const slicePreview = (text: string): string => Array.from(text).slice(0, 80).join("");
    const restText = contentCells.map((c) => c.ch).join("");
    if (restText.startsWith("!") || PASTE_PLACEHOLDER_PATTERN.test(restText)) {
      return {
        state: "human_draft",
        shouldHold: true,
        draftPreview: slicePreview(restText),
        marker,
      };
    }

    const normalCells = contentCells.filter((c) => c.ch !== " " && !c.isDim);
    if (normalCells.length === 0) {
      return { state: "placeholder_only", shouldHold: false, marker };
    }

    // Preserve typed spaces between normal-intensity characters while dropping dim ghost suffix.
    const normalOnly = contentCells
      .filter((c) => !c.isDim)
      .map((c) => c.ch)
      .join("")
      .trim();

    return {
      state: "human_draft",
      shouldHold: true,
      draftPreview: slicePreview(normalOnly || restText),
      marker,
    };
  }

  return { state: "unseen", shouldHold: false };
}
