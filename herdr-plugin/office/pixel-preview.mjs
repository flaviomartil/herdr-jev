import { personSprite, poseFrames, POSES } from './src/people.mjs';

const args = process.argv.slice(2);
const plain = args.includes('--plain');
const allFrames = args.includes('--all-frames');
const colors256 = args.includes('--colors') && args[args.indexOf('--colors') + 1] === '256';
const colorsOpt = colors256 ? 256 : 'true';

const states = ['working', 'idle', 'blocked', 'done', 'unknown', 'vacant'];
const identities = ['1', '2', '3']; // Different hairs/colors

function renderAnsi(text, spans, colors) {
  if (!spans || spans.length === 0) return text;
  
  const styledChars = text.split('').map(c => ({ char: c, fg: undefined, bg: undefined }));
  
  for (const span of spans) {
    for (let i = span.from; i < span.to; i++) {
      if (span.fg !== undefined) styledChars[i].fg = span.fg;
      if (span.bg !== undefined) styledChars[i].bg = span.bg;
    }
  }
  
  let out = '';
  let currentFg = undefined;
  let currentBg = undefined;
  
  for (const c of styledChars) {
    if (c.fg !== currentFg || c.bg !== currentBg) {
      out += '\x1b[0m';
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
    }
    out += c.char;
  }
  out += '\x1b[0m';
  return out;
}

if (plain) {
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
  // 1. Poses side by side, frame 0 (unless --all-frames)
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
    // Poses side by side in one row with labels underneath
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
    
    // 2. Second row with three identities side by side
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
