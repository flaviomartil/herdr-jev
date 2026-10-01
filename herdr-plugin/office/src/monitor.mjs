import { composeSprite } from './pixel.mjs';

const BEZEL = '#343a40';
const STAND = '#495057';
const SCREEN_OFF = '#212529';

const ROWS = [
  "TTTTTTTTTTTTTT",
  "TGGGGGGGGGGGGT",
  "T............T",
  "T............T",
  "TGGGGGGGGGGGGT",
  "TTTTTTTTTTTTTT",
  "......SS......",
  ".....SSSS.....",
];

export function monitorSprite({ accent, on, colors = 'true' }) {
  const glow = on && accent ? accent : SCREEN_OFF;
  const palette = {
    T: BEZEL,
    S: STAND,
    G: glow,
  };
  return composeSprite(ROWS, palette, { colors, background: 'transparent' });
}
