import { harnessPolicyCheck, type TrustPolicy } from "../harness/bridge.js";
import { classifyPaneBlock, normalizePaneText, type HerdrClient } from "./client.js";

export interface TrustOutcome {
  confirmed: boolean;
  reason: string;
}

export interface TrustMenuOption {
  text: string;
  cursor: boolean;
}

export interface TrustMenu {
  options: TrustMenuOption[];
  cursorIndex: number;
  trustIndex: number;
}

const CURSOR_LINE = /^([ \t│┃|]*)([❯›>])([ \t]+)(\S.*)$/;
const FOOTER_LINE = /\b(?:enter|return)\b.*\b(?:confirm|select|choose|continue)\b|\besc\b.*\bcancel\b|[↑↓]/i;
const TRUST_OPTION = /^(?:Yes,\s*I\s+trust\b|Trust\s+and\s+continue\b)/i;
const NUMBER_MARKER = /^\d+[.)]\s+/;
const MAX_MOVES = 6;
const DISMISS_POLLS = 20;

export function autoTrustEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !["0", "false", "off", "no"].includes((env.HERDR_JEV_AUTO_TRUST ?? "").trim().toLowerCase());
}

export function parseTrustMenu(rawText: string): TrustMenu | null {
  const lines = normalizePaneText(rawText).split("\n").map((line) => line.replace(/\s+$/, ""));
  let cursorLine = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (CURSOR_LINE.test(lines[i]!)) { cursorLine = i; break; }
  }
  if (cursorLine === -1) return null;
  const match = CURSOR_LINE.exec(lines[cursorLine]!)!;
  const column = match[1]!.length + 1 + match[3]!.length;
  let first = cursorLine;
  while (first > 0 && lines[first - 1]!.trim() !== "") first--;
  let last = cursorLine;
  while (last < lines.length - 1 && lines[last + 1]!.trim() !== "") last++;
  const options: TrustMenuOption[] = [];
  for (let i = first; i <= last; i++) {
    const line = lines[i]!;
    const isCursor = i === cursorLine;
    if (!isCursor) {
      if (line.length <= column || !/^[ \t│┃|]*$/.test(line.slice(0, column)) || !/\S/.test(line[column]!)) continue;
      if (FOOTER_LINE.test(line)) continue;
    }
    const text = (isCursor ? match[4]! : line.slice(column)).trim().replace(NUMBER_MARKER, "");
    options.push({ text, cursor: isCursor });
  }
  const cursorIndex = options.findIndex((option) => option.cursor);
  if (cursorIndex === -1) return null;
  return { options, cursorIndex, trustIndex: options.findIndex((option) => TRUST_OPTION.test(option.text)) };
}

export interface TrustConfirmation {
  herdr: HerdrClient;
  target: string;
  cwd: string;
  clock: { now: () => number; sleep: (ms: number) => Promise<void> };
  env?: NodeJS.ProcessEnv;
  lookup?: (path: string) => TrustPolicy | null;
}

export async function confirmWorkspaceTrust(input: TrustConfirmation): Promise<TrustOutcome> {
  if (!autoTrustEnabled(input.env)) return { confirmed: false, reason: "auto_trust_disabled" };
  const { herdr, target } = input;
  if (!herdr.readAgent || !herdr.sendKeys) return { confirmed: false, reason: "pane_keys_unavailable" };
  const policy = (input.lookup ?? ((path) => harnessPolicyCheck("trust", path)))(input.cwd);
  if (!policy) return { confirmed: false, reason: "policy_unavailable" };
  if (!policy.trusted) return { confirmed: false, reason: policy.reason };

  const read = async () => {
    const screen = await herdr.readAgent!(target);
    return screen.ok ? screen : null;
  };
  let aligned = false;
  for (let move = 0; move <= MAX_MOVES; move++) {
    const screen = await read();
    if (!screen) return { confirmed: false, reason: "pane_unreadable" };
    if (classifyPaneBlock(screen) !== "trust") return { confirmed: false, reason: "not_trust_dialog" };
    const menu = parseTrustMenu(screen.stdout);
    if (!menu || menu.trustIndex < 0) return { confirmed: false, reason: "trust_option_not_found" };
    if (menu.cursorIndex === menu.trustIndex) { aligned = true; break; }
    if (move === MAX_MOVES) break;
    const sent = await herdr.sendKeys(target, [menu.trustIndex > menu.cursorIndex ? "down" : "up"]);
    if (!sent.ok) return { confirmed: false, reason: "send_keys_failed" };
    await input.clock.sleep(150);
  }
  if (!aligned) return { confirmed: false, reason: "trust_cursor_unverified" };

  const entered = await herdr.sendKeys(target, ["enter"]);
  if (!entered.ok) return { confirmed: false, reason: "send_keys_failed" };
  for (let poll = 0; poll < DISMISS_POLLS; poll++) {
    const screen = await read();
    if (screen && classifyPaneBlock(screen) !== "trust") return { confirmed: true, reason: policy.reason };
    await input.clock.sleep(250);
  }
  return { confirmed: false, reason: "trust_dialog_persisted" };
}
