export type ArtKind = "claude" | "codex" | "agy" | "haiku" | "other";
export type RoleMark = "explore" | "implement" | "review" | "mechanical";
export type ArtState = "running" | "waiting" | "failed" | "done" | "idle" | "gone";
export type Pixel = number | null;
export type PixelGrid = Pixel[][];

export const CANVAS_WIDTH = 14;
export const CANVAS_HEIGHT = 10;
export const SPRITE_X = 2;
export const DEFAULT_COLOR = 0x01000000;
export const SPARKLE_MS = 1500;

const SHAPES: Record<ArtKind, readonly string[]> = {
  claude: [
    "..b....b..",
    "..bb..bb..",
    ".bbbbbbbb.",
    ".bbebbebb.",
    ".bbbbbbbb.",
    ".bbbddbbb.",
    "..bbbbbb..",
    "..bb..bb..",
    ".dd....dd.",
    "..........",
  ],
  codex: [
    "....hh....",
    "....bb....",
    ".bbbbbbbb.",
    ".bebbbbeb.",
    ".bbbbbbbb.",
    ".bbdddddb.",
    ".bbbbbbbb.",
    "..bb..bb..",
    "..dd..dd..",
    "..........",
  ],
  agy: [
    "...bbbb...",
    "..bbbbbb..",
    ".bbbbbbbb.",
    ".bebbbbeb.",
    ".bbbbbbbb.",
    ".bbbddbbb.",
    ".bbbbbbbb.",
    ".bbbbbbbb.",
    ".b.bb.bb.b",
    "..........",
  ],
  haiku: [
    "..........",
    "....bb....",
    "...bbbb...",
    "..bbbbbb..",
    "..bebbeb..",
    "..bbbbbb..",
    ".hbbbbbbh.",
    "..bbbbbb..",
    "...d..d...",
    "..........",
  ],
  other: [
    "..........",
    "..bbbbbb..",
    ".bbbbbbbb.",
    ".bebbbbeb.",
    ".bbbbbbbb.",
    ".bbbbbbbb.",
    "..bbbbbb..",
    "..b....b..",
    "..d....d..",
    "..........",
  ],
};

const EYE = 0x1b1b24;

const HUES: Record<ArtKind, { b: number; d: number; h: number }> = {
  claude: { b: 0x8f6bff, d: 0x5a3fc0, h: 0xc3adff },
  codex: { b: 0xf0b429, d: 0xa87310, h: 0xffe08a },
  agy: { b: 0x1fbfa4, d: 0x0f7f6c, h: 0x8ff0dc },
  haiku: { b: 0xf06292, d: 0xa83560, h: 0xffb3cf },
  other: { b: 0x9aa0a6, d: 0x5f6368, h: 0xdadce0 },
};

export function paletteFor(kind: ArtKind): Record<string, number> {
  return { ...HUES[kind], e: EYE };
}

const ACCESSORY_PALETTE: Record<string, number> = {
  g: 0x8fd3ff,
  k: 0xb08850,
  s: 0xc9d1d9,
  p: 0xf1f3f5,
  t: 0x37b24d,
  n: 0x6c757d,
  c: 0xffe066,
  z: 0x9db4ff,
};

const ACCESSORIES: Record<RoleMark, readonly string[]> = {
  explore: ["gg.", "gg.", "..k"],
  implement: ["s.s", "sss", ".s."],
  review: ["ptt", "ppp", "ptt"],
  mechanical: ["n.n", "nsn", "n.n"],
};

const LEAD_MARK: readonly string[] = ["c.c", "ccc", "ccc"];
const SLEEP_MARK: readonly string[] = ["zzz", ".z.", "zzz"];
const ACCESSORY_AT = { x: 11, y: 3 };
const LEAD_AT = { x: 11, y: 7 };
const SLEEP_AT = { x: 11, y: 0 };
const WARNING = 0xffd43b;
const DANGER = 0xe03131;
const SPARKLE = 0xffffff;
const GREY_SHARE = 0.7;

export type ArtSpec = {
  kind: ArtKind;
  state: ArtState;
  frame?: number;
  role?: RoleMark | null;
  lead?: boolean;
  ageMs?: number;
};

export function emptyGrid(): PixelGrid {
  return Array.from({ length: CANVAS_HEIGHT }, () => Array.from({ length: CANVAS_WIDTH }, () => null as Pixel));
}

function stamp(grid: PixelGrid, rows: readonly string[], palette: Record<string, number>, x0: number, y0: number): void {
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const color = palette[ch];
      const target = grid[y0 + y];
      if (color !== undefined && target !== undefined && x0 + x >= 0 && x0 + x < CANVAS_WIDTH) target[x0 + x] = color;
    });
  });
}

function dot(grid: PixelGrid, x: number, y: number, color: number): void {
  const row = grid[y];
  if (row !== undefined && x >= 0 && x < CANVAS_WIDTH) row[x] = color;
}

export function greyOut(color: number): number {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  const mix = (c: number) => Math.round(c * (1 - GREY_SHARE) + luma * GREY_SHARE);
  return (mix(r) << 16) | (mix(g) << 8) | mix(b);
}

export function composeGrid(spec: ArtSpec): PixelGrid {
  const grid = emptyGrid();
  const odd = (spec.frame ?? 0) % 2 === 1;
  const palette = paletteFor(spec.kind);
  const walking = spec.state === "running" && odd;
  const shake = spec.state === "failed" && odd ? -2 : 0;
  SHAPES[spec.kind].forEach((row, y) => {
    const legs = walking && y >= 7 ? 1 : 0;
    [...row].forEach((ch, x) => {
      if (ch === ".") return;
      const key = walking && ch === "e" ? "b" : ch;
      const color = palette[key];
      if (color !== undefined) dot(grid, SPRITE_X + x + legs + shake, y, color);
    });
  });
  if (spec.state === "done" || spec.state === "gone") {
    for (const row of grid) for (let x = 0; x < row.length; x += 1) if (row[x] !== null) row[x] = greyOut(row[x] as number);
  }
  if (spec.role) stamp(grid, ACCESSORIES[spec.role], ACCESSORY_PALETTE, ACCESSORY_AT.x, ACCESSORY_AT.y);
  if (spec.lead) stamp(grid, LEAD_MARK, ACCESSORY_PALETTE, LEAD_AT.x, LEAD_AT.y);
  if (spec.state === "idle") stamp(grid, SLEEP_MARK, ACCESSORY_PALETTE, SLEEP_AT.x, SLEEP_AT.y);
  if (spec.state === "waiting") for (const y of [1, 2, 3, 4, 6]) dot(grid, 0, y, WARNING);
  if (spec.state === "failed") for (let x = SPRITE_X; x < SPRITE_X + 10; x += 1) dot(grid, x, CANVAS_HEIGHT - 1, DANGER);
  if (spec.state === "done" && (spec.ageMs ?? Number.POSITIVE_INFINITY) < SPARKLE_MS) {
    const spots: [number, number][] = odd ? [[1, 2], [0, 5]] : [[0, 1], [1, 5]];
    for (const [x, y] of spots) dot(grid, x, y, SPARKLE);
  }
  return grid;
}

export type RasterCell = { codePoint: number; fg: number; bg: number };

const QUADRANTS = [" ", "▘", "▝", "▀", "▖", "▌", "▞", "▛", "▗", "▚", "▐", "▜", "▄", "▙", "▟", "█"];

const channels = (c: Pixel): [number, number, number] => (c === null ? [0, 0, 0] : [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff]);
const distance = (a: Pixel, b: Pixel): number => {
  const [ar, ag, ab] = channels(a);
  const [br, bg, bb] = channels(b);
  return (ar - br) ** 2 + (ag - bg) ** 2 + (ab - bb) ** 2;
};

export function quadrantCell(quad: readonly [Pixel, Pixel, Pixel, Pixel]): RasterCell {
  const counts = new Map<Pixel, number>();
  for (const p of quad) counts.set(p, (counts.get(p) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([color]) => color);
  const first = ranked[0] as Pixel;
  if (ranked.length === 1) {
    return first === null
      ? { codePoint: 0x20, fg: DEFAULT_COLOR, bg: DEFAULT_COLOR }
      : { codePoint: (QUADRANTS[15] as string).codePointAt(0) as number, fg: first, bg: DEFAULT_COLOR };
  }
  let fg = first;
  let bg = ranked[1] as Pixel;
  if (fg === null) [fg, bg] = [bg, fg];
  let mask = 0;
  quad.forEach((p, i) => {
    const toFg = p === fg || (p !== bg && distance(p, fg) <= distance(p, bg));
    if (toFg) mask |= 1 << i;
  });
  return { codePoint: (QUADRANTS[mask] as string).codePointAt(0) as number, fg: fg as number, bg: bg === null ? DEFAULT_COLOR : bg };
}

export function rasterOf(grid: PixelGrid): { columns: number; rows: number; cells: RasterCell[] } {
  const columns = Math.ceil(CANVAS_WIDTH / 2);
  const rows = Math.ceil(CANVAS_HEIGHT / 2);
  const cells: RasterCell[] = [];
  for (let cy = 0; cy < rows; cy += 1) {
    for (let cx = 0; cx < columns; cx += 1) {
      const at = (dx: number, dy: number): Pixel => grid[cy * 2 + dy]?.[cx * 2 + dx] ?? null;
      cells.push(quadrantCell([at(0, 0), at(1, 0), at(0, 1), at(1, 1)]));
    }
  }
  return { columns, rows, cells };
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64Of(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (b === undefined ? "=" : B64[(n >> 6) & 63]) + (c === undefined ? "=" : B64[n & 63]);
  }
  return out;
}

export function packCells(cells: readonly RasterCell[]): string {
  const bytes = new Uint8Array(cells.length * 12);
  const view = new DataView(bytes.buffer);
  cells.forEach((cell, i) => {
    view.setUint32(i * 12, cell.codePoint, true);
    view.setUint32(i * 12 + 4, cell.fg, true);
    view.setUint32(i * 12 + 8, cell.bg, true);
  });
  return base64Of(bytes);
}

export function rasterRows(cells: readonly RasterCell[], columns: number): string[] {
  const rows: string[] = [];
  for (let i = 0; i < cells.length; i += columns) rows.push(cells.slice(i, i + columns).map((c) => String.fromCodePoint(c.codePoint)).join(""));
  return rows;
}

const hex = (c: number): string => `#${c.toString(16).padStart(6, "0")}`;

export function svgOf(grid: PixelGrid, scale = 4): string {
  const rects: string[] = [];
  grid.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const color = row[x];
      if (color === null || color === undefined) {
        x += 1;
        continue;
      }
      let end = x + 1;
      while (end < row.length && row[end] === color) end += 1;
      rects.push(`<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${hex(color)}"/>`);
      x = end;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}" width="${CANVAS_WIDTH * scale}" height="${CANVAS_HEIGHT * scale}" shape-rendering="crispEdges">${rects.join("")}</svg>`;
}

export function roleMarkOf(judgeClass: string | null | undefined): RoleMark | null {
  switch (judgeClass) {
    case "explore":
    case "search":
    case "summary":
      return "explore";
    case "feature":
    case "fix":
    case "implement":
      return "implement";
    case "review":
      return "review";
    case "mechanical":
      return "mechanical";
    default:
      return null;
  }
}

export function frameFor(tick: number, reducedMotion: boolean): number {
  return reducedMotion ? 0 : tick % 2;
}
