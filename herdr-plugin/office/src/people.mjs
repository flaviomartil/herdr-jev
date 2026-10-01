import { composeSprite } from './pixel.mjs';

const WORKING = [
  [
    "....HHH....",
    "...HHHHH...",
    "...HSSSH...",
    "...SSeSS...",
    "...CCCCC...",
    "..BCCCCCB..",
    ".SCCCCCCS..",
    ".SCCCCCCS..",
    ".S.......S.",
    "...........",
    "...........",
    "..........."
  ],
  [
    "...........",
    "....HHH....",
    "...HHHHH...",
    "...HSSSH...",
    "...SSeSS...",
    "...CCCCC...",
    "..BCCCCCB..",
    ".SCCCCCCS..",
    "S........S.",
    "...........",
    "...........",
    "..........."
  ],
  [
    "....HHH....",
    "...HHHHH...",
    "...HSSSH...",
    "...SSeSS...",
    "...CCCCC...",
    "..BCCCCCB..",
    "..SCCCCCS..",
    "..SCCCCCS..",
    ".S.......S.",
    "...........",
    "...........",
    "..........."
  ],
  [
    "....HHH....",
    "...HHHHH...",
    "...HSSSH...",
    "...SSeSS...",
    "...CCCCC...",
    "..BCCCCCB..",
    "..SCCCCCS..",
    "..SCCCCCS..",
    "S.......S..",
    "...........",
    "...........",
    "..........."
  ],
];

const IDLE = [
  [
    "....HHH....",
    "...HHHHH...",
    "...HSSSH...",
    "...SS-SS...",
    "...CCCCC...",
    "..BCCCCCB..",
    "..SCCCCCS..",
    "..SCCCCCS..",
    "..S.....S..",
    "...........",
    "...........",
    "..........."
  ],
  [
    "....HHH....",
    "...HHHHH...",
    "...HSSSH...",
    "...SS-SS...",
    "...CCCCC...",
    "..BCCCCCB..",
    ".SCCCCCCCS.",
    ".SCCCCCCCS.",
    "..S.....S..",
    "...........",
    "...........",
    "..........."
  ],
  [
    "....HHH...z",
    "...HHHHH...",
    "...HSSSH...",
    "...SS-SS...",
    "...CCCCC...",
    "..BCCCCCB..",
    ".SCCCCCCCS.",
    ".SCCCCCCCS.",
    "..S.....S..",
    "...........",
    "...........",
    "..........."
  ],
  [
    "....HHH..Z.",
    "...HHHHH...",
    "...HSSSH...",
    "...SS-SS...",
    "...CCCCC...",
    "..BCCCCCB..",
    "..SCCCCCS..",
    "..SCCCCCS..",
    "..S.....S..",
    "...........",
    "...........",
    "..........."
  ],
];

const BLOCKED = [
  [
    "S.RRR.HHH..",
    "S.RRRHHHH..",
    "S..HSSSH...",
    "S..SSoSS...",
    "S..CCCCC...",
    "S.BCCCCCB..",
    ".SCCCCCC...",
    "...CCCCCS..",
    "........S..",
    "...........",
    "...........",
    "..........."
  ],
  [
    "S.ppp.HHH..",
    "S.pppHHHH..",
    "S..HSSSH...",
    "S..SSoSS...",
    "S..CCCCC...",
    "S.BCCCCCB..",
    ".SCCCCCC...",
    "...CCCCCS..",
    "........S..",
    "...........",
    "...........",
    "..........."
  ],
];

const DONE = [
  [
    "S..HHH..S..",
    "S.HHHHH.S.G",
    "S.HSSSH.S.G",
    "S.SSeSS.SG.",
    "S.CCCCC.S..",
    ".BCCCCCB...",
    ".SCCCCCS...",
    "..S...S....",
    "...........",
    "...........",
    "...........",
    "..........."
  ],
  [
    "...HHH.....",
    "S.HHHHH.S.G",
    "S.HSSSH.S.G",
    "S.SSeSS.SG.",
    "S.CCCCC.S..",
    ".BCCCCCB...",
    ".SCCCCCS...",
    "..S...S....",
    "...........",
    "...........",
    "...........",
    "..........."
  ],
];

const UNKNOWN = [
  [
    "....HHH...Q",
    "...HHHHH..Q",
    "...HSSSH..Q",
    "...SSeSS...",
    "...CCCCC...",
    ".SBCCCCCBS.",
    ".S.CCCCC.S.",
    "S..CCCCC..S",
    "S.........S",
    "...........",
    "...........",
    "..........."
  ],
  [
    "....HHH...q",
    "...HHHHH..q",
    "...HSSSH..q",
    "...SSeSS...",
    "...CCCCC...",
    ".SBCCCCCBS.",
    ".S.CCCCC.S.",
    "S..CCCCC..S",
    "S.........S",
    "...........",
    "...........",
    "..........."
  ],
];

const VACANT = [
  [
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
  ]
];

const IDENTITIES = [
  { hair: '#2a2a2a', skin: '#ffc19b', shirt: '#4c6ef5' },
  { hair: '#502a18', skin: '#f1c27d', shirt: '#40c057' },
  { hair: '#1a1a1a', skin: '#8d5524', shirt: '#fcc419' },
  { hair: '#f0e6d2', skin: '#ffdbac', shirt: '#fa5252' },
  { hair: '#6e6e6e', skin: '#e0ac69', shirt: '#15aabf' },
  { hair: '#8b4513', skin: '#c68642', shirt: '#be4bdb' },
  { hair: '#ff8c00', skin: '#ffc19b', shirt: '#82c91e' },
  { hair: '#2b2b2b', skin: '#3d2b1f', shirt: '#fab005' },
];

function getIdentity(id) {
  let hash = 0;
  for (let i = 0; i < (id || '').length; i++) {
    hash = ((hash << 5) - hash) + id.charCodeAt(i);
    hash |= 0;
  }
  return IDENTITIES[Math.abs(hash) % IDENTITIES.length];
}

const KINDS = {
  claude: '#d97757',
  codex: '#4c6ef5',
  agy: '#15aabf',
  kiro: '#40c057',
  other: '#868e96',
};

export const POSES = {
  working: WORKING,
  idle: IDLE,
  blocked: BLOCKED,
  done: DONE,
  unknown: UNKNOWN,
  vacant: VACANT,
};

export function poseFrames(state) {
  return POSES[state] ? POSES[state].length : 0;
}

export function personSprite({ state, frame, id, kind, reducedMotion, colors = 'true' }) {
  const frames = POSES[state] || POSES.vacant;
  const f = reducedMotion ? 0 : frame % frames.length;
  const rows = frames[f];
  
  const ident = getIdentity(id);
  const band = KINDS[kind] || KINDS.other;
  
  const palette = {
    H: ident.hair,
    S: ident.skin,
    C: ident.shirt,
    B: band,
    e: '#ffffff',
    o: '#000000',
    '-': '#2a2a2a',
    z: '#a8a8a8',
    Z: '#ffffff',
    R: '#e03131',
    p: '#ff8787',
    G: '#40c057',
    Q: '#fcc419',
    q: '#ffd43b',
    X: '#495057',
  };
  
  return composeSprite(rows, palette, { colors, background: 'transparent' });
}
