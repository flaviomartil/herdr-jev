import { personSprite, poseFrames, POSES } from './src/people.mjs';

const args = process.argv.slice(2);
const plain = args.includes('--plain');
const colors256 = args.includes('--colors') && args[args.indexOf('--colors') + 1] === '256';
const colorsOpt = colors256 ? 256 : 'true';

const frameArgIndex = args.indexOf('--frame');
const frameOpt = frameArgIndex >= 0 ? parseInt(args[frameArgIndex + 1], 10) : null;

const states = ['working', 'idle', 'blocked', 'done', 'unknown', 'vacant'];

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
    const framesCount = frameOpt !== null ? 1 : poseFrames(state);
    const startFrame = frameOpt !== null ? frameOpt : 0;
    
    // Print side by side
    const frames = [];
    for (let i = 0; i < framesCount; i++) {
      const f = startFrame + i;
      frames.push(POSES[state][f % POSES[state].length]);
    }
    
    // 12 pixel rows
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
  for (const state of states) {
    console.log(`\x1b[1m${state}\x1b[0m`);
    const framesCount = frameOpt !== null ? 1 : poseFrames(state);
    const startFrame = frameOpt !== null ? frameOpt : 0;
    
    const spritesRows = [];
    for (let i = 0; i < framesCount; i++) {
      const sprite = personSprite({ state, frame: startFrame + i, id: "preview", kind: "codex", colors: colorsOpt });
      spritesRows.push(sprite);
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
}
