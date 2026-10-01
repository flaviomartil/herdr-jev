import { composeSprite } from './pixel.mjs';

const IDENTITIES = [
  { hair: '#2a2a2a', skin: '#ffc19b', shirt: '#4c6ef5', cap: '#343a40' },
  { hair: '#502a18', skin: '#f1c27d', shirt: '#40c057', cap: '#15aabf' },
  { hair: '#1a1a1a', skin: '#8d5524', shirt: '#fcc419', cap: '#e03131' },
  { hair: '#f0e6d2', skin: '#ffdbac', shirt: '#fa5252', cap: '#4c6ef5' },
  { hair: '#6e6e6e', skin: '#e0ac69', shirt: '#15aabf', cap: '#fcc419' },
  { hair: '#8b4513', skin: '#c68642', shirt: '#be4bdb', cap: '#40c057' },
  { hair: '#ff8c00', skin: '#ffc19b', shirt: '#82c91e', cap: '#343a40' },
  { hair: '#2b2b2b', skin: '#3d2b1f', shirt: '#fab005', cap: '#e03131' },
];

function getIdentity(id) {
  let hash = 0;
  for (let i = 0; i < (id || '').length; i++) {
    hash = ((hash << 5) - hash) + id.charCodeAt(i);
    hash |= 0;
  }
  const idx = Math.abs(hash) % IDENTITIES.length;
  const hairStyle = Math.abs(hash) % 3;
  return { ...IDENTITIES[idx], hairStyle };
}

const KINDS = {
  claude: '#d97757',
  codex: '#4c6ef5',
  agy: '#15aabf',
  kiro: '#40c057',
  other: '#868e96',
};

function buildFrame(pose, frame, hairStyle) {
  if (pose === 'vacant') {
    return [
      "...........",
      "...........",
      "...........",
      "...........",
      "...........",
      "....XXX....",
      "...XXXXX...",
      "...XXXXX...",
      "...XXXXX...",
      "....XXX....",
      "...........",
      "..........."
    ];
  }

  let head = [
    "...HHHHH...",
    "..HHHHHHH..",
    "..HSSSSSH..",
    "..SeSSSeS..",
    "..SSSSSSS..",
    "...SSmSS...",
    "....SSS...."
  ];

  if (hairStyle === 1) { // long
    head[3] = head[3].substring(0, 2) + 'H' + head[3].substring(3, 8) + 'H' + head[3].substring(9);
    head[4] = head[4].substring(0, 2) + 'H' + head[4].substring(3, 8) + 'H' + head[4].substring(9);
    head[5] = head[5].substring(0, 2) + 'H' + head[5].substring(3, 8) + 'H' + head[5].substring(9);
    head[6] = head[6].substring(0, 2) + 'H' + head[6].substring(3, 8) + 'H' + head[6].substring(9);
  } else if (hairStyle === 2) { // cap
    head[0] = "...KKKKK...";
    head[1] = "..KKKKKKKK."; 
    head[2] = "..KSSSSSS.."; 
  }

  let torso = [
    "..CCCCCCC..",
    ".CCBBBBBCC.",
    "SCCCCCCCCCS",
    "S.CCCCCCC.S",
    "..........."
  ];

  if (pose === 'working') {
    if (frame % 2 === 0) {
      torso[2] = ".CCCCCCCCCS"; 
      torso[3] = "S.CCCCCCC.S";
      torso[4] = "S..........";
    } else {
      torso[2] = "SCCCCCCCCC.";
      torso[3] = "S.CCCCCCC.S";
      torso[4] = "..........S";
    }
    if (frame === 3) {
      head[3] = head[3].replace(/e/g, '-');
    }
  } else if (pose === 'idle') {
    head[3] = "...S--SS--S";
    head[5] = head[5].replace(/m/g, 'S');
    head = head.map((r, i) => i === 3 ? r : '.' + r.substring(0, 10));
    torso = torso.map(r => '.' + r.substring(0, 10));
    if (frame % 2 === 0) {
      head[0] = head[0].substring(0, 8) + 'z..';
      head[1] = head[1].substring(0, 9) + 'z.';
    } else {
      head[0] = head[0].substring(0, 9) + 'z.';
      head[1] = head[1].substring(0, 10) + 'z';
    }
  } else if (pose === 'blocked') {
    head[5] = head[5].replace(/m/g, 'o');
    let t = frame % 2 === 0 ? 'R' : 'r';
    head[0] = t+t+t + head[0].substring(3);
    head[1] = t+'W'+t + head[1].substring(3);
    head[2] = t+t+t + head[2].substring(3);
    head[3] = 'S.' + head[3].substring(2);
    head[4] = 'S.' + head[4].substring(2);
    head[5] = 'S.' + head[5].substring(2);
    head[6] = 'S.' + head[6].substring(2);
    torso[0] = 'S.C' + torso[0].substring(3);
    torso[1] = 'C.C' + torso[1].substring(3);
    torso[2] = ".CCCCCCCCCS"; 
    torso[3] = "..CCCCCCC.S";
    torso[4] = "..........S";
  } else if (pose === 'done') {
    head[1] = head[1].substring(0, 8) + '..G';
    head[2] = head[2].substring(0, 8) + 'G.G';
    head[3] = head[3].substring(0, 8) + '.G.';
    head[3] = 'S' + head[3].substring(1);
    head[4] = 'S.' + head[4].substring(2, 9) + '.S';
    head[5] = 'S.' + head[5].substring(2, 9) + '.S';
    head[6] = 'S.' + head[6].substring(2, 9) + '.S';
    head[5] = head[5].substring(0, 4) + 'uuu' + head[5].substring(7);
    torso[0] = 'S.C' + torso[0].substring(3, 8) + 'C.S';
    torso[1] = 'C.C' + torso[1].substring(3, 8) + 'C.C';
    torso[2] = ".CCCCCCCCC.";
    torso[3] = "..CCCCCCC..";
    torso[4] = "...........";
  } else if (pose === 'unknown') {
    head = head.map((r, i) => i < 6 ? '.' + r.substring(0, 10) : r);
    head[0] = head[0].substring(0, 7) + '.QQ.';
    head[1] = head[1].substring(0, 7) + 'Q..Q';
    head[2] = head[2].substring(0, 7) + '...Q';
    head[3] = head[3].substring(0, 7) + '..Q.';
    head[4] = head[4].substring(0, 7) + '..Q.';
    head[4] = head[4].substring(0, 10) + 'S';
    head[5] = head[5].substring(0, 10) + 'S';
    head[6] = head[6].substring(0, 10) + 'S';
    torso[0] = torso[0].substring(0, 10) + 'S';
    torso[1] = torso[1].substring(0, 10) + 'C';
    torso[2] = "SCCCCCCCCC.";
    torso[3] = "S.CCCCCCC..";
    torso[4] = "S..........";
  }

  return [...head, ...torso];
}

const STATES = ['working', 'idle', 'blocked', 'done', 'unknown', 'vacant'];
export const POSES = {};
for (const s of STATES) {
  POSES[s] = [];
  const frames = (s === 'vacant') ? 1 : 4;
  for (let i = 0; i < frames; i++) {
    POSES[s].push(buildFrame(s, i, 0));
  }
}

export function poseFrames(state) {
  return state === 'vacant' ? 1 : 4;
}

export function personSprite({ state, frame, id, kind, reducedMotion, colors = 'true' }) {
  const frames = poseFrames(state);
  const f = reducedMotion ? 0 : frame % frames;
  const ident = getIdentity(id);
  const band = KINDS[kind] || KINDS.other;
  
  const rows = buildFrame(state, f, ident.hairStyle);
  
  const palette = {
    H: ident.hair,
    K: ident.cap,
    S: ident.skin,
    C: ident.shirt,
    B: band,
    e: '#212529',
    o: '#212529',
    '-': '#212529',
    z: '#ffffff',
    W: '#ffffff',
    R: '#e03131',
    r: '#c92a2a',
    G: '#40c057',
    Q: '#fcc419',
    u: '#ffffff',
    m: '#212529',
    X: '#495057',
  };
  
  return composeSprite(rows, palette, { colors, background: 'transparent' });
}
