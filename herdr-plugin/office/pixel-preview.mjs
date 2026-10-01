import { personSprite, poseFrames, POSES } from './src/people.mjs';
import { deskScene } from './src/desk-scene.mjs';

const args = process.argv.slice(2);
const plain = args.includes('--plain');
const allFrames = args.includes('--all-frames');
const sceneMode = args.includes('--scene');
const colors256 = args.includes('--colors') && args[args.indexOf('--colors') + 1] === '256';
const colorsOpt = colors256 ? 256 : 'true';

const states = ['working', 'idle', 'blocked', 'done', 'unknown', 'vacant'];
const identities = ['1', '2', '3'];

function renderAnsi(text, spans, colors) {
  if (!spans || spans.length === 0) return text;
  
  const styledChars = text.split('').map(c => ({ char: c, fg: undefined, bg: undefined }));
  
  for (const span of spans) {
    for (let i = span.from; i < span.to; i++) {
      if (span.fg !== undefined) styledChars[i].fg = span.fg;
      if (span.bg !== undefined) styledChars[i].bg = span.bg;
      if (span.bold !== undefined) styledChars[i].bold = span.bold;
    }
  }
  
  let out = '';
  let currentFg = undefined;
  let currentBg = undefined;
  let currentBold = undefined;
  
  for (const c of styledChars) {
    if (c.fg !== currentFg || c.bg !== currentBg || c.bold !== currentBold) {
      out += '\x1b[0m';
      if (c.bold) out += '\x1b[1m';
      if (colors === 256) {
        if (c.fg !== undefined) out += `\x1b[38;5;${c.fg}m`;
        if (c.bg !== undefined) out += `\x1b[48;5;${c.bg}m`;
      } else {
        if (c.fg !== undefined) {
          const r = parseInt(c.fg.substring(1,3), 16);
          const g = parseInt(c.fg.substring(3,5), 16);
          const b = parseInt(c.fg.substring(5,7), 16);
          out += `\x1b[38;2;${r};${g};${b}m`;
        }
        if (c.bg !== undefined) {
          const r = parseInt(c.bg.substring(1,3), 16);
          const g = parseInt(c.bg.substring(3,5), 16);
          const b = parseInt(c.bg.substring(5,7), 16);
          out += `\x1b[48;2;${r};${g};${b}m`;
        }
      }
      currentFg = c.fg;
      currentBg = c.bg;
      currentBold = c.bold;
    }
    out += c.char;
  }
  out += '\x1b[0m';
  return out;
}

if (sceneMode) {
  const INNER = 27;
  const mockPersons = {
    working: { id: "1", status: "working", kind: "codex", ask: null },
    idle: { id: "2", status: "idle", kind: "claude", ask: null },
    blocked: { id: "3", status: "blocked", kind: "agy", ask: "needs your OK" },
    done: { id: "4", status: "done", kind: "kiro", ask: null },
    unknown: { id: "5", status: "unknown", kind: "other", ask: null },
    vacant: { id: "6", status: "vacant", kind: "codex", ask: null },
  };

  const scenes = states.map(state => deskScene({
    person: mockPersons[state],
    frame: 0,
    width: INNER,
    accent: '#4c6ef5',
    label: state === 'working' ? 'npm test' : state,
    sparkline: state === 'working' ? '  * ▄▄▄▄▄ + ' : null,
    reducedMotion: false,
    colors: colorsOpt
  }));

  for (let r = 0; r < 6; r++) {
    let rowOut = '';
    for (let i = 0; i < states.length; i++) {
      const scene = scenes[i];
      if (scene && scene[r]) {
        rowOut += renderAnsi(scene[r].text, scene[r].spans, colorsOpt) + '    ';
      } else {
        rowOut += ' '.repeat(INNER + 4);
      }
    }
    console.log(rowOut);
  }
  console.log(states.map(s => s.padEnd(INNER + 4)).join(''));
} else if (plain) {
  for (const state of states) {
    console.log(state);
    const framesCount = allFrames ? poseFrames(state) : 1;
    
    const frames = [];
    for (let i = 0; i < framesCount; i++) {
      frames.push(POSES[state][i % POSES[state].length]);
    }
    
    for (let r = 0; r < 12; r++) {
      let rowOut = '';
      for (let i = 0; i < framesCount; i++) {
        rowOut += frames[i][r] + '    ';
      }
      console.log(rowOut);
    }
    console.log();
  }
} else {
  if (allFrames) {
    for (const state of states) {
      console.log(`\x1b[1m${state}\x1b[0m`);
      const framesCount = poseFrames(state);
      const spritesRows = [];
      for (let i = 0; i < framesCount; i++) {
        spritesRows.push(personSprite({ state, frame: i, id: "preview", kind: "codex", colors: colorsOpt }));
      }
      for (let r = 0; r < 6; r++) {
        let rowOut = '';
        for (let i = 0; i < framesCount; i++) {
          const sprite = spritesRows[i];
          if (sprite && sprite[r]) {
            rowOut += renderAnsi(sprite[r].text, sprite[r].spans, colorsOpt) + '    ';
          }
        }
        console.log(rowOut);
      }
      console.log();
    }
  } else {
    const spritesRows = states.map(state => personSprite({ state, frame: 0, id: "preview", kind: "codex", colors: colorsOpt }));
    for (let r = 0; r < 6; r++) {
      let rowOut = '';
      for (let i = 0; i < states.length; i++) {
        const sprite = spritesRows[i];
        if (sprite && sprite[r]) {
          rowOut += renderAnsi(sprite[r].text, sprite[r].spans, colorsOpt) + '    ';
        }
      }
      console.log(rowOut);
    }
    console.log(states.map(s => s.padEnd(15)).join(''));
    console.log();
    
    const idSprites = identities.map(id => personSprite({ state: 'working', frame: 0, id, kind: "codex", colors: colorsOpt }));
    for (let r = 0; r < 6; r++) {
      let rowOut = '';
      for (let i = 0; i < identities.length; i++) {
        const sprite = idSprites[i];
        if (sprite && sprite[r]) {
          rowOut += renderAnsi(sprite[r].text, sprite[r].spans, colorsOpt) + '    ';
        }
      }
      console.log(rowOut);
    }
    console.log(identities.map(id => `id: ${id}`.padEnd(15)).join(''));
  }
}
