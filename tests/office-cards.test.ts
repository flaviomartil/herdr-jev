import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";

const OFFICE = resolve(import.meta.dir, "../herdr-plugin/office/office.mjs");
const FIXTURES = join(import.meta.dir, "fixtures", "office");
const CLOCK = 1700000000000;
const TILE_W = 33;
const TILE_H = 13;
const INNER_X = 3;
const INNER_W = 27;
const HALF_BLOCKS = /[▀▄]/;
const ASCII_FACE = /\([^)]{3}\)/;
const ASCII_BEZEL = "┌────────────┐";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function run(args: string[], columns: number, opts: { noColor?: boolean; lines?: number; clock?: number } = {}) {
  const env: Record<string, string | undefined> = { ...process.env, COLUMNS: String(columns), LINES: String(opts.lines ?? 45) };
  if (opts.noColor) env.NO_COLOR = "1";
  else delete env.NO_COLOR;
  const res = spawnSync("node", [OFFICE, "--once", `--clock=${opts.clock ?? CLOCK}`, ...args], { env: env as NodeJS.ProcessEnv, encoding: "utf8" });
  if (res.status !== 0) throw new Error(res.stderr);
  return res.stdout;
}

const DEMO_TILES = [
  { state: "working", col: 0, row: 0 },
  { state: "working", col: 1, row: 0 },
  { state: "blocked", col: 2, row: 0 },
  { state: "idle", col: 3, row: 0 },
  { state: "done", col: 0, row: 1 },
  { state: "unknown", col: 1, row: 1 },
  { state: "working", col: 2, row: 1 },
];

const tileOrigin = (t: { col: number; row: number }) => ({ x: 2 + t.col * (TILE_W + 1), y: 2 + t.row * (TILE_H + 1) });
const sceneStart = (state: string) => (state === "blocked" ? 4 : 3);

function sceneRows(plain: string, t: { state: string; col: number; row: number }) {
  const lines = plain.split("\n");
  const { x, y } = tileOrigin(t);
  const from = y + sceneStart(t.state);
  return lines.slice(from, from + 6).map((l) => [...l].slice(x + INNER_X, x + INNER_X + INNER_W).join(""));
}

test("every rendered line is exactly the terminal width, colour and fallback, in every state", () => {
  const sources = [["--demo"], ["--demo", "--panel", "w1:p1"], ["--roster", join(FIXTURES, "blocked.json")]];
  for (const w of [100, 120, 140]) {
    for (const args of sources) {
      for (const noColor of [false, true]) {
        const out = run(args, w, { noColor });
        const lines = strip(out).split("\n").filter((l) => l.length > 0);
        expect(lines.length).toBeGreaterThan(10);
        for (const line of lines) expect([...line].length).toBe(w);
      }
    }
  }
});

test("floor cards draw the pixel scene: half blocks in the art rows, no ASCII face or bezel", () => {
  const plain = strip(run(["--demo"], 140));
  for (const t of DEMO_TILES) {
    const rows = sceneRows(plain, t);
    expect(rows.length).toBe(6);
    expect(rows.some((r) => HALF_BLOCKS.test(r))).toBe(true);
    const art = rows.join("\n");
    expect(ASCII_FACE.test(art)).toBe(false);
    expect(art).not.toContain(ASCII_BEZEL);
  }
});

test("each state draws its own scene", () => {
  const plain = strip(run(["--demo"], 140));
  const byState = new Map<string, string>();
  for (const t of DEMO_TILES) if (!byState.has(t.state)) byState.set(t.state, sceneRows(plain, t).join("\n"));
  expect(byState.size).toBe(5);
  expect(new Set(byState.values()).size).toBe(5);
});

test("a blocked card keeps the ask, the answer buttons and the banner", () => {
  const plain = strip(run(["--demo"], 140));
  const t = DEMO_TILES[2];
  const rows = sceneRows(plain, t);
  expect(rows.join("\n")).toContain("APPROVE?");
  expect(rows[4]).toContain("[y]    [n]");
  expect(rows[1]).toContain("apply the patc");
  const { x, y } = tileOrigin(t);
  expect(plain.split("\n")[y + 1]).toContain("PRECISA DE VOCE");
  expect(plain.split("\n")[y + 1].slice(x, x + 1)).toBe("║");
});

test("cards outside the art area do not move between the pixel scene and the ASCII fallback", () => {
  const pixel = strip(run(["--demo"], 140)).split("\n");
  const ascii = strip(run(["--demo"], 140, { noColor: true })).split("\n");
  expect(pixel.length).toBe(ascii.length);
  for (const t of DEMO_TILES) {
    const { x, y } = tileOrigin(t);
    const from = sceneStart(t.state);
    for (let k = 0; k < TILE_H; k += 1) {
      if (k >= from && k < from + 6) continue;
      const a = [...pixel[y + k]].slice(x, x + TILE_W).join("");
      const b = [...ascii[y + k]].slice(x, x + TILE_W).join("");
      expect(a).toBe(b);
    }
  }
});

test("NO_COLOR keeps the ASCII art on every card", () => {
  const plain = strip(run(["--demo"], 140, { noColor: true }));
  for (const t of DEMO_TILES) {
    const art = sceneRows(plain, t).join("\n");
    expect(art).toContain("│");
    expect(art).not.toMatch(/[▀]{4}/);
  }
  expect(plain).toContain(ASCII_BEZEL);
});

test("reduced motion freezes the scene, full motion animates it", () => {
  const still = [0, 320, 640].map((dt) => run(["--demo", "--reduced-motion"], 140, { clock: CLOCK + dt }));
  expect(still[1]).toBe(still[0]);
  expect(still[2]).toBe(still[0]);
  const moving = [0, 320, 640].map((dt) => strip(run(["--demo"], 140, { clock: CLOCK + dt })));
  expect(new Set(moving).size).toBeGreaterThan(1);
});

test("monitor label is the activity or the first word of the command, never the agent", async () => {
  const { monitorLabel } = await import("../herdr-plugin/office/src/monitor-label.mjs");
  expect(monitorLabel({ jevActivity: "testing", command: "cargo build", kind: "kiro" })).toBe("testing");
  expect(monitorLabel({ jevActivity: "waiting_approval" })).toBe("approval?");
  expect(monitorLabel({ jevActivity: "waiting_answer" })).toBe("answer?");
  for (const a of ["editing", "reading", "running", "planning", "error", "idle", "done"]) expect(monitorLabel({ jevActivity: a })).toBe(a);
  expect(monitorLabel({ jevActivity: "unknown", command: "bun test" })).toBe("bun");
  expect(monitorLabel({ command: "cargo build", kind: "kiro" })).toBe("cargo");
  expect(monitorLabel({ command: "claude --model x bun test", kind: "claude" })).toBe("bun");
  expect(monitorLabel({ command: "node /home/u/.local/share/codex.js", kind: "codex" })).toBeNull();
  expect(monitorLabel({ command: "/usr/bin/pytest -x" })).toBe("pytest");
  expect(monitorLabel({ command: null })).toBeNull();
});

test("working monitors show a short label without an ellipsis", () => {
  const plain = strip(run(["--demo"], 140));
  const labels = DEMO_TILES.filter((t) => t.state === "working").map((t) => sceneRows(plain, t)[3]);
  expect(labels.length).toBe(3);
  for (const row of labels) expect(row).not.toContain("…");
  expect(plain).not.toContain("claude · bu");
  expect(plain).not.toContain("kiro · carg");
});
