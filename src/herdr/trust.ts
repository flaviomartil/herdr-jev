import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { harnessPolicyCheck, type TrustPolicy } from "../harness/bridge.js";
import { classifyPaneBlock, normalizePaneText, type HerdrClient } from "./client.js";

export interface TrustOutcome {
  confirmed: boolean;
  reason: string;
  entered?: boolean;
  ready?: boolean;
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
const DIRECTORY_FLAG = /^(?:--(?:cd|cwd|chdir|add-dir|workdir|work-dir|working-dir|directory|dir|workspace)(?:=|$)|-[Cw])/;
const MAX_MOVES = 6;
const MAX_READS = 8;
const DISMISS_POLLS = 20;
const READ_INTERVAL_MS = 150;

export function autoTrustEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["", "1", "true", "on", "yes"].includes((env.HERDR_JEV_AUTO_TRUST ?? "").trim().toLowerCase());
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
  flags?: readonly string[];
  clock: { now: () => number; sleep: (ms: number) => Promise<void> };
  env?: NodeJS.ProcessEnv;
  lookup?: (path: string) => TrustPolicy | null;
  ready?: (screenText: string) => boolean;
}

function trustedPath(cwd: string): string | null {
  if (!cwd.trim()) return null;
  try {
    return realpathSync(resolve(cwd));
  } catch {
    return null;
  }
}

const PATH_START = /^(?:~\/|\/)/;
const PATH_FRAME = /[│┃|]/g;
const TRAILING_PUNCTUATION = /[.,:;)\]]+$/;
const ELLIPSIS = /^(?:…|\.{3})|(?:…|\.{3})$/;

function pathKey(value: string): string {
  const trimmed = value.length > 1 ? value.replace(/\/+$/, "") : value;
  return trimmed || "/";
}

export function dialogPaths(rawText: string): string[] {
  const lines = normalizePaneText(rawText).split("\n").map((line) => line.replace(PATH_FRAME, " ").replace(/\s+$/, "").replace(/^\s+/, ""));
  const width = lines.reduce((max, line) => Math.max(max, line.length), 0);
  const found: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const words = lines[i]!.split(/\s+/).filter(Boolean);
    words.forEach((word, index) => {
      let token = word.replace(TRAILING_PUNCTUATION, "");
      if (!PATH_START.test(token) && !ELLIPSIS.test(token)) return;
      const single = words.length === 1;
      if (!single && !/^(?:~\/|\/|…|\.{3}\/?)[^\s/]+\/[^\s/]/.test(token)) return;
      if (index === words.length - 1 && lines[i]!.length >= width && width > 0) {
        const next = lines[i + 1]?.split(/\s+/)[0];
        if (next && !/^[❯›>]/.test(next)) token = `${token}${next.replace(TRAILING_PUNCTUATION, "")}`;
      }
      found.push(token);
    });
  }
  return found;
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function showsDifferentPath(shown: string, expected: string): boolean {
  const target = pathKey(expected);
  if (ELLIPSIS.test(shown)) {
    const visible = pathKey(shown.replace(/^(?:…|\.{3})/, "").replace(/(?:…|\.{3})$/, ""));
    if (!visible || visible === "/") return false;
    return shown.startsWith("…") || shown.startsWith("...") ? !target.endsWith(visible) : !target.startsWith(visible);
  }
  const home = process.env.HOME?.trim() || homedir();
  const expanded = shown === "~" ? home : shown.startsWith("~/") ? resolve(home, shown.slice(2)) : shown;
  const candidate = pathKey(resolve(expanded));
  if (candidate === target) return false;
  const real = realOrNull(candidate);
  return !(real !== null && pathKey(real) === target);
}

export function dialogMatchesPath(screenText: string, expected: string): boolean {
  return !dialogPaths(screenText).some((shown) => showsDifferentPath(shown, expected));
}

export async function confirmWorkspaceTrust(input: TrustConfirmation): Promise<TrustOutcome> {
  if (!autoTrustEnabled(input.env)) return { confirmed: false, reason: "auto_trust_disabled" };
  const { herdr, target } = input;
  if (!herdr.readAgent || !herdr.sendKeys) return { confirmed: false, reason: "pane_keys_unavailable" };
  if ((input.flags ?? []).some((flag) => DIRECTORY_FLAG.test(flag))) return { confirmed: false, reason: "directory_flags_present" };
  const checkedPath = trustedPath(input.cwd);
  if (!checkedPath) return { confirmed: false, reason: "cwd_unresolved" };
  const policy = (input.lookup ?? ((path) => harnessPolicyCheck("trust", path)))(checkedPath);
  if (!policy) return { confirmed: false, reason: "policy_unavailable" };
  if (!policy.trusted) return { confirmed: false, reason: policy.reason };

  const read = async () => {
    const screen = await herdr.readAgent!(target);
    return screen.ok ? screen : null;
  };
  const settle = () => input.clock.sleep(READ_INTERVAL_MS);

  let previous: string | null = null;
  let pending: string | null = null;
  let stale = 0;
  let moves = 0;
  let aligned = false;
  for (let reads = 0; reads < MAX_READS * (MAX_MOVES + 2); reads++) {
    const screen = await read();
    if (!screen) return { confirmed: false, reason: "pane_unreadable" };
    if (classifyPaneBlock(screen) !== "trust") return { confirmed: false, reason: "not_trust_dialog" };
    const frame = normalizePaneText(screen.stdout);
    if (pending !== null) {
      if (frame === pending) {
        if (++stale >= MAX_READS) break;
      } else {
        pending = null;
        previous = frame;
      }
      await settle();
      continue;
    }
    if (frame !== previous) {
      previous = frame;
      await settle();
      continue;
    }
    if (!dialogMatchesPath(screen.stdout, checkedPath)) return { confirmed: false, reason: "trust_path_mismatch" };
    const menu = parseTrustMenu(screen.stdout);
    if (!menu || menu.trustIndex < 0) return { confirmed: false, reason: "trust_option_not_found" };
    if (menu.cursorIndex === menu.trustIndex) { aligned = true; break; }
    if (moves >= MAX_MOVES) break;
    const sent = await herdr.sendKeys(target, [menu.trustIndex > menu.cursorIndex ? "down" : "up"]);
    if (!sent.ok) return { confirmed: false, reason: "send_keys_failed" };
    moves++;
    pending = frame;
    stale = 0;
    await settle();
  }
  if (!aligned) return { confirmed: false, reason: "trust_cursor_unverified" };

  const entered = await herdr.sendKeys(target, ["enter"]);
  if (!entered.ok) return { confirmed: false, reason: "send_keys_failed" };
  let dismissed = false;
  for (let poll = 0; poll < DISMISS_POLLS; poll++) {
    const screen = await read();
    if (screen && classifyPaneBlock(screen) !== "trust") {
      dismissed = true;
      if (!input.ready || input.ready(`${screen.stdout}\n${screen.stderr}`)) return { confirmed: true, reason: policy.reason };
    }
    await input.clock.sleep(250);
  }
  return dismissed
    ? { confirmed: true, reason: policy.reason, ready: false }
    : { confirmed: false, reason: "trust_dialog_persisted", entered: true };
}
