import { expect, test } from "bun:test";
import { deskScene } from "../herdr-plugin/office/src/desk-scene.mjs";

test("scene row count and exact width for every state", () => {
  const INNER = 27;
  const states = ['working', 'idle', 'blocked', 'done', 'unknown', 'vacant'];
  for (const state of states) {
    const scene = deskScene({
      person: { id: "1", status: state, kind: "codex", ask: "needs your OK" },
      frame: 0,
      width: INNER,
      accent: '#4c6ef5',
      label: 'test',
      sparkline: '...',
      reducedMotion: false,
      colors: 'true'
    });
    
    expect(scene).not.toBeNull();
    expect(scene.length).toBe(6);
    
    for (const row of scene) {
      expect([...row.text].length).toBe(INNER);
    }
  }
});

test("reduced motion returns identical output for different frames", () => {
  const INNER = 27;
  const s1 = deskScene({
    person: { id: "1", status: "working", kind: "codex" },
    frame: 0,
    width: INNER,
    accent: '#4c6ef5',
    reducedMotion: true
  });
  
  const s2 = deskScene({
    person: { id: "1", status: "working", kind: "codex" },
    frame: 3,
    width: INNER,
    accent: '#4c6ef5',
    reducedMotion: true
  });
  
  expect(s1).toEqual(s2);
});

test("'none' colors returns null", () => {
  const scene = deskScene({
    person: { id: "1", status: "working", kind: "codex" },
    frame: 0,
    width: 27,
    colors: 'none'
  });
  
  expect(scene).toBeNull();
});
