const ANSI_COLORS = [
  [0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0], [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
  [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0], [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255]
];

function xtermRgb(index) {
  if (index <= 15) return ANSI_COLORS[index];
  if (index <= 231) {
    const cube = index - 16;
    const level = (c) => c === 0 ? 0 : 55 + c * 40;
    return [level(Math.floor(cube / 36)), level(Math.floor((cube % 36) / 6)), level(cube % 6)];
  }
  const level = 8 + (index - 232) * 10;
  return [level, level, level];
}

const XTERM_PALETTE = Array.from({ length: 256 }, (_, i) => xtermRgb(i));

function rgbToXterm256(hex) {
  if (!hex || hex.length !== 7 || hex[0] !== '#') return 0;
  const r = parseInt(hex.substring(1, 3), 16);
  const g = parseInt(hex.substring(3, 5), 16);
  const b = parseInt(hex.substring(5, 7), 16);
  let nearest = 0;
  let minDist = Infinity;
  for (let i = 0; i < 256; i++) {
    const [pr, pg, pb] = XTERM_PALETTE[i];
    const dr = r - pr, dg = g - pg, db = b - pb;
    const dist = dr * dr + dg * dg + db * db;
    if (dist < minDist) {
      nearest = i;
      minDist = dist;
    }
  }
  return nearest;
}

function hexToRgbString(hex, colorsOption) {
  if (colorsOption === 256) {
    return rgbToXterm256(hex);
  }
  return hex;
}

export function composeSprite(rows, palette, options = {}) {
  if (options.colors === 'none') return null;
  const bgOpt = options.background || 'transparent';
  
  const mappedPalette = {};
  for (const [key, val] of Object.entries(palette)) {
    mappedPalette[key] = hexToRgbString(val, options.colors);
  }
  const mappedBg = bgOpt !== 'transparent' ? hexToRgbString(bgOpt, options.colors) : 'transparent';
  
  const h = rows.length;
  const w = rows[0]?.length || 0;
  const termRows = [];
  
  for (let r = 0; r < h; r += 2) {
    const topRow = rows[r];
    const botRow = r + 1 < h ? rows[r + 1] : '.'.repeat(w);
    let text = '';
    const spans = [];
    
    let currentSpan = null;
    let n = 0;
    
    for (let c = 0; c < w; c++) {
      const topKey = topRow[c] || '.';
      const botKey = botRow[c] || '.';
      
      const topColor = topKey === '.' ? mappedBg : mappedPalette[topKey];
      const botColor = botKey === '.' ? mappedBg : mappedPalette[botKey];
      
      let char = ' ';
      let fg, bg;
      if (topColor !== 'transparent' && botColor !== 'transparent') {
        char = '▀';
        fg = topColor;
        bg = botColor;
      } else if (topColor !== 'transparent') {
        char = '▀';
        fg = topColor;
      } else if (botColor !== 'transparent') {
        char = '▄';
        fg = botColor;
      }
      
      text += char;
      const charWidth = 1;
      
      if (fg !== undefined || bg !== undefined) {
        if (currentSpan && currentSpan.fg === fg && currentSpan.bg === bg) {
          currentSpan.to = n + charWidth;
        } else {
          if (currentSpan) spans.push(currentSpan);
          currentSpan = { from: n, to: n + charWidth };
          if (fg !== undefined) currentSpan.fg = fg;
          if (bg !== undefined) currentSpan.bg = bg;
        }
      } else {
        if (currentSpan) {
          spans.push(currentSpan);
          currentSpan = null;
        }
      }
      n += charWidth;
    }
    if (currentSpan) spans.push(currentSpan);
    termRows.push({ text, spans });
  }
  return termRows;
}
