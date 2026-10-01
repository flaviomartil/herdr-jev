import { expect, test } from "bun:test";
import { composeSprite } from "../herdr-plugin/office/src/pixel.mjs";
import { poseFrames, personSprite } from "../herdr-plugin/office/src/people.mjs";
import { $ } from "bun";

test("composition - stacked pixels, colors, transparency, padding", () => {
  const rows = [
    "A.",
    ".B",
    "C"
  ];
  const palette = { A: "#ff0000", B: "#0000ff", C: "#00ff00" };
  const res = composeSprite(rows, palette);
  expect(res).not.toBeNull();
  expect(res.length).toBe(2);
  
  // A is solid, . is transparent. bot is transparent, solid
  expect(res[0].text).toBe("▀▄");
  expect(res[0].spans).toEqual([
    { from: 0, to: 1, fg: "#ff0000" },
    { from: 1, to: 2, fg: "#0000ff" }
  ]);
  
  // Odd height padding: C. padded with .. -> C., ..
  expect(res[1].text).toBe("▀ ");
  expect(res[1].spans).toEqual([
    { from: 0, to: 1, fg: "#00ff00" }
  ]);
});

test("composition - 256 mapping", () => {
  const rows = ["RGBA", "...."];
  const res = composeSprite(rows, { R: "#ff0000", G: "#00ff00", B: "#0000ff", A: "#808080" }, { colors: 256 });
  expect(res[0].spans).toEqual([
    { from: 0, to: 1, fg: 9 },
    { from: 1, to: 2, fg: 10 },
    { from: 2, to: 3, fg: 12 },
    { from: 3, to: 4, fg: 8 }
  ]);
});

test("composition - none option", () => {
  expect(composeSprite(["A"], { A: "#ff0000" }, { colors: "none" })).toBeNull();
});

test("poses and frames count", () => {
  const states = ["working", "idle", "blocked", "done", "unknown", "vacant"];
  for (const s of states) {
    const f = poseFrames(s);
    if (s === "vacant") {
      expect(f).toBeGreaterThanOrEqual(1);
    } else {
      expect(f).toBeGreaterThanOrEqual(2);
      expect(f).toBeLessThanOrEqual(4);
    }
  }
});

test("frames are 11x12", () => {
  const states = ["working", "idle", "blocked", "done", "unknown", "vacant"];
  for (const s of states) {
    const n = poseFrames(s);
    for (let i = 0; i < n; i++) {
      const sprite = personSprite({ state: s, frame: i, id: "1" });
      expect(sprite.length).toBe(6);
      for (const row of sprite) {
        expect(row.text.length).toBe(11);
      }
    }
  }
});

test("different frame 0 for 5 states", () => {
  const states = ["working", "idle", "blocked", "done", "unknown"];
  const sprites = states.map(s => JSON.stringify(personSprite({ state: s, frame: 0, id: "1" })));
  const unique = new Set(sprites);
  expect(unique.size).toBe(5);
});

test("identity stability", () => {
  const s1 = JSON.stringify(personSprite({ state: "idle", frame: 0, id: "abc" }));
  const s2 = JSON.stringify(personSprite({ state: "idle", frame: 0, id: "abc" }));
  expect(s1).toBe(s2);
  
  const ids = ["1", "2", "3", "4", "5", "6", "7", "8"];
  const unique = new Set(ids.map(id => JSON.stringify(personSprite({ state: "idle", frame: 0, id }))));
  expect(unique.size).toBeGreaterThanOrEqual(6);
});

test("kind band colors", () => {
  const kinds = ["claude", "codex", "agy", "kiro", "other"];
  const unique = new Set(kinds.map(k => JSON.stringify(personSprite({ state: "working", frame: 0, id: "1", kind: k }))));
  expect(unique.size).toBeGreaterThanOrEqual(2);
});

test("reducedMotion", () => {
  const f0 = JSON.stringify(personSprite({ state: "working", frame: 0, id: "1" }));
  const f1_reduced = JSON.stringify(personSprite({ state: "working", frame: 1, id: "1", reducedMotion: true }));
  expect(f1_reduced).toBe(f0);
});

test("preview tool output", async () => {
  const proc = Bun.spawn(["node", "herdr-plugin/office/pixel-preview.mjs", "--plain"]);
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  expect(proc.exitCode).toBe(0);
  expect(text).toContain("working");
  expect(text).toContain("idle");
  expect(text).toContain("blocked");
  expect(text).toContain("done");
  expect(text).toContain("unknown");
});
