import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CANVAS_HEIGHT, artCacheSize, cachedArt, CANVAS_WIDTH, composeGrid, frameFor, greyOut, packCells, paletteFor, quadrantCell, rasterOf, rasterRows, roleMarkOf, svgOf } from "../src/identity/art";
import type { ArtKind, ArtState } from "../src/identity/art";

const rows = (kind: ArtKind, state: ArtState, extra: { frame?: number; role?: "explore" | "implement" | "review" | "mechanical"; lead?: boolean; ageMs?: number } = {}) => {
  const r = rasterOf(composeGrid({ kind, state, ...extra }));
  return rasterRows(r.cells, r.columns);
};

test("art: base silhouettes per CLI as quadrant raster rows", () => {
  expect(rows("claude", "running", { frame: 0 })).toEqual(["  ▙ ▟  ", " ▐▛█▜▌ ", " ▐█▀█▌ ", "  █▀█  ", " ▝▘ ▝▘ "]);
  expect(rows("codex", "running", { frame: 0 })).toEqual(["   ▀   ", " ▐▜█▛▌ ", " ▐▛▀▀▌ ", " ▝█▀█▘ ", "  ▀ ▀  "]);
  expect(rows("agy", "running", { frame: 0 })).toEqual(["  ▟█▙  ", " ▐▜█▛▌ ", " ▐█▀█▌ ", " ▐███▌ ", " ▝▝▘▀▝ "]);
  expect(rows("haiku", "running", { frame: 0 })).toEqual(["   ▄   ", "  ▟█▙  ", "  ▙█▟  ", " ▝███▘ ", "  ▝ ▘  "]);
});

test("art: unpainted cells use the terminal default and the packed raster has 35 triplets", () => {
  const { cells, columns, rows: height } = rasterOf(composeGrid({ kind: "claude", state: "running", frame: 0 }));
  expect(columns * height).toBe(35);
  expect(cells[0]).toEqual({ codePoint: 0x20, fg: 0x01000000, bg: 0x01000000 });
  expect(packCells(cells)).toHaveLength(Math.ceil((35 * 12) / 3) * 4);
  expect(packCells([{ codePoint: 0x2588, fg: 0xff8800, bg: 0x01000000 }])).toBe(Buffer.from(Uint32Array.of(0x2588, 0xff8800, 0x01000000).buffer).toString("base64"));
});

test("art: each CLI keeps its own hue", () => {
  const bodies = (["claude", "codex", "agy", "haiku"] as const).map((k) => paletteFor(k).b);
  expect(new Set(bodies).size).toBe(4);
  const source = readFileSync("src/identity/art.ts", "utf8").toLowerCase();
  for (const banned of ["d97757", "10a37f"]) expect(source).not.toContain(banned);
});

test("art: role accessories and the lead marker add distinct pixels", () => {
  const base = composeGrid({ kind: "codex", state: "running", frame: 0 });
  const seen = new Set<string>();
  for (const role of ["explore", "implement", "review", "mechanical"] as const) {
    const grid = composeGrid({ kind: "codex", state: "running", frame: 0, role });
    expect(grid).not.toEqual(base);
    seen.add(JSON.stringify(grid));
  }
  expect(seen.size).toBe(4);
  expect(composeGrid({ kind: "codex", state: "running", frame: 0, lead: true })[8]?.[12]).not.toBeNull();
  expect(roleMarkOf("search")).toBe("explore");
  expect(roleMarkOf("fix")).toBe("implement");
  expect(roleMarkOf("review")).toBe("review");
  expect(roleMarkOf("mechanical")).toBe("mechanical");
  expect(roleMarkOf("architecture")).toBeNull();
});

test("art: state overlays", () => {
  const run0 = composeGrid({ kind: "claude", state: "running", frame: 0 });
  const run1 = composeGrid({ kind: "claude", state: "running", frame: 1 });
  expect(run1).not.toEqual(run0);
  expect(composeGrid({ kind: "claude", state: "running", frame: 2 })).toEqual(run0);

  const waiting = composeGrid({ kind: "claude", state: "waiting", frame: 0 });
  expect(waiting[1]?.[0]).toBe(0xffd43b);
  expect(waiting[6]?.[0]).toBe(0xffd43b);

  const failed0 = composeGrid({ kind: "claude", state: "failed", frame: 0 });
  const failed1 = composeGrid({ kind: "claude", state: "failed", frame: 1 });
  expect(failed0[CANVAS_HEIGHT - 1]?.[5]).toBe(0xe03131);
  expect(failed1[CANVAS_HEIGHT - 1]?.[5]).toBe(0xe03131);
  expect(failed1[3]).not.toEqual(failed0[3]);

  const sparkle = composeGrid({ kind: "claude", state: "done", frame: 0, ageMs: 200 });
  const settled = composeGrid({ kind: "claude", state: "done", frame: 0, ageMs: 5000 });
  expect(sparkle[1]?.[0]).toBe(0xffffff);
  expect(settled[1]?.[0]).toBeNull();
  const bodyPixel = settled[3]?.[4] as number;
  expect(bodyPixel).toBe(greyOut(paletteFor("claude").b));
  const spread = (c: number) => Math.max(c >> 16, (c >> 8) & 255, c & 255) - Math.min(c >> 16, (c >> 8) & 255, c & 255);
  expect(spread(bodyPixel)).toBeLessThan(spread(paletteFor("claude").b) * 0.4);

  expect(composeGrid({ kind: "claude", state: "idle", frame: 0 })[0]?.[11]).not.toBeNull();
  expect(composeGrid({ kind: "claude", state: "gone", frame: 0 })).toEqual(settled.map((row, y) => (y === 1 ? row : row)));
});

test("art: reduced motion pins frame 0 and normal motion alternates", () => {
  expect([0, 1, 2, 3].map((t) => frameFor(t, true))).toEqual([0, 0, 0, 0]);
  expect([0, 1, 2, 3].map((t) => frameFor(t, false))).toEqual([0, 1, 0, 1]);
});

test("art: quadrant cells keep two colors and default background", () => {
  expect(quadrantCell([null, null, null, null]).codePoint).toBe(0x20);
  expect(quadrantCell([0xff0000, 0xff0000, 0xff0000, 0xff0000])).toEqual({ codePoint: 0x2588, fg: 0xff0000, bg: 0x01000000 });
  expect(quadrantCell([0xff0000, null, null, null])).toEqual({ codePoint: 0x2598, fg: 0xff0000, bg: 0x01000000 });
  expect(quadrantCell([0xff0000, 0xff0000, 0x00ff00, 0x00ff00])).toEqual({ codePoint: 0x2580, fg: 0xff0000, bg: 0x00ff00 });
  const three = quadrantCell([0xff0000, 0xff0000, 0x00ff00, 0x0000ff]);
  expect([three.fg, three.bg].every((c) => [0xff0000, 0x00ff00, 0x0000ff].includes(c))).toBe(true);
});

test("art: svg is crisp, merges runs and is sized from the grid", () => {
  const svg = svgOf(composeGrid({ kind: "agy", state: "running", frame: 0 }), 4);
  expect(svg).toContain('shape-rendering="crispEdges"');
  expect(svg).toContain(`viewBox="0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}"`);
  expect(svg).toContain('width="56"');
  expect(svg).not.toContain("<script");
  expect((svg.match(/<rect /g) ?? []).length).toBeLessThan(CANVAS_WIDTH * CANVAS_HEIGHT);
});

test("art: the plugin copy is byte-identical to the source", () => {
  expect(readFileSync("claude-plugin/hooks/art-core.ts", "utf8")).toBe(readFileSync("src/identity/art.ts", "utf8"));
});

test("art: cached art is reused per kind, state, role, lead, frame and sparkle", () => {
  const spec = { kind: "haiku", state: "running", frame: 1, role: "explore", lead: true } as const;
  const first = cachedArt(spec);
  const size = artCacheSize();
  expect(cachedArt({ ...spec, frame: 3 })).toBe(first);
  expect(cachedArt({ ...spec, ageMs: 10 })).toBe(first);
  expect(artCacheSize()).toBe(size);
  expect(cachedArt({ ...spec, frame: 0 })).not.toBe(first);
  expect(first.packed).toBe(packCells(rasterOf(composeGrid(spec)).cells));
  expect(cachedArt({ kind: "claude", state: "done", ageMs: 10 })).not.toBe(cachedArt({ kind: "claude", state: "done", ageMs: 9000 }));
});
