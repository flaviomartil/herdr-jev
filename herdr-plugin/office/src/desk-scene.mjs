import { personSprite } from './people.mjs';
import { monitorSprite } from './monitor.mjs';
import { width, truncate, padEnd } from './text.mjs';

export function deskScene({ person, frame, width: sceneWidth, accent, label, sparkline, reducedMotion, colors = 'true' }) {
  if (colors === 'none') return null;

  const state = (person.jevConfidence >= 0.7 && person.jevState && person.jevState !== 'unknown') ? person.jevState : person.status;
  
  const pSprite = personSprite({ state, frame, id: person.id, kind: person.kind, reducedMotion, colors });
  const mSprite = monitorSprite({ accent, on: state === 'working', colors });
  
  if (!pSprite || !mSprite) return null;

  const POSE_W = 11;
  const MON_W = 14;
  const GAP_W = Math.max(0, sceneWidth - POSE_W - MON_W);
  
  const rows = [];
  for (let r = 0; r < 6; r++) {
    let text = '';
    const spans = [];
    
    // 1. Person
    text += pSprite[r].text;
    spans.push(...pSprite[r].spans);
    
    let n = POSE_W;
    
    // 2. Gap
    text += ' '.repeat(GAP_W);
    n += GAP_W;
    
    // 3. Monitor
    const mRow = r >= 2 ? mSprite[r - 2] : null;
    if (mRow) {
      let mText = mRow.text;
      let mSpans = mRow.spans.map(s => ({ ...s, from: s.from + n, to: s.to + n }));
      
      const screenBg = (state === 'working' && accent) ? accent : '#212529';
      
      if (r === 3 && label) {
        const lText = truncate(label, MON_W - 2);
        const padL = Math.floor((MON_W - 2 - width(lText)) / 2);
        const padR = MON_W - 2 - width(lText) - padL;
        const centered = ' '.repeat(padL) + lText + ' '.repeat(padR);
        mText = mText[0] + centered + mText[MON_W - 1];
        
        mSpans = mSpans.filter(s => s.to <= n + 1 || s.from >= n + MON_W - 1);
        mSpans.push({ from: n + 1, to: n + MON_W - 1, fg: '#ffffff', bg: screenBg, bold: true });
      }
      
      if (r === 4 && sparkline) {
        const sText = padEnd(truncate(sparkline, MON_W - 2), MON_W - 2);
        mText = mText[0] + sText + mText[MON_W - 1];
        
        mSpans = mSpans.filter(s => s.to <= n + 1 || s.from >= n + MON_W - 1);
        mSpans.push({ from: n + 1, to: n + MON_W - 1, fg: '#adb5bd', bg: screenBg });
      }
      
      text += mText;
      spans.push(...mSpans);
    } else {
      text += ' '.repeat(MON_W);
    }
    
    rows.push({ text, spans });
  }
  
  if (state === 'blocked' && person.ask) {
    const askText = truncate(person.ask, sceneWidth - POSE_W - 1);
    const start = POSE_W + 1;
    rows[1].text = rows[1].text.substring(0, start) + askText + rows[1].text.substring(start + width(askText));
    rows[1].spans.push({ from: start, to: start + width(askText), fg: '#f09a9a', bold: true });
  }
  
  const rDesk = 5;
  let deskText = '';
  const newSpans = [];
  for (let c = 0; c < sceneWidth; c++) {
    if (rows[rDesk].text[c] === ' ' || rows[rDesk].text[c] === '.') {
      deskText += '▄';
      newSpans.push({ from: c, to: c + 1, fg: '#495057' });
    } else {
      deskText += rows[rDesk].text[c];
    }
  }
  rows[rDesk].text = deskText;
  rows[rDesk].spans.push(...newSpans);
  
  return rows;
}
