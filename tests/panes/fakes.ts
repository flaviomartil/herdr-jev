import { chmodSync, mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Fakes {
  dir: string;
  log: string;
  calls(bin?: string): { bin: string; argv: string[]; stdin?: string }[];
  env(extra?: Record<string, string>): NodeJS.ProcessEnv;
}

export function makeFakes(): Fakes {
  const dir = mkdtempSync(join(tmpdir(), "jevtest-fakes-"));
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  const write = (name: string, body: string) => {
    writeFileSync(join(dir, name), body);
    chmodSync(join(dir, name), 0o755);
  };
  write("herdr", `#!/bin/sh
printf '%s\\n' "herdr $*" >> "$FAKE_LOG"
n=$(cat "$FAKE_DIR/herdr.n" 2>/dev/null || echo 0)
case "$1 $2" in
  "pane split") n=$((n+1)); echo $n > "$FAKE_DIR/herdr.n"; echo "{\\"result\\":{\\"pane\\":{\\"pane_id\\":\\"p-$n\\"}}}";;
  "tab create") echo '{"result":{"tab":{"tab_id":"t-1"},"root_pane":{"pane_id":"p-root"}}}';;
  "tab list") echo '{"result":{"tabs":[{"tab_id":"t-1","label":"feat"}]}}';;
  "pane read") if [ -n "$FAKE_PANE_GONE" ]; then echo "pane not found" >&2; exit 1; fi; echo "screen";;
esac
exit 0
`);
  write("tmux", `#!/bin/sh
printf '%s\\n' "tmux $*" >> "$FAKE_LOG"
case "$1" in
  split-window) n=$(cat "$FAKE_DIR/tmux.n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$FAKE_DIR/tmux.n"; echo "%$n";;
  display-message) for a in "$@"; do last="$a"; done; echo "$last" >/dev/null; echo "\${TMUX_FAKE_ID:-%1}";;
  new-window) echo "@2 %9";;
  capture-pane) echo "screen";;
esac
exit 0
`);
  for (const bin of ["codex", "agy", "claude"]) {
    write(bin, `#!/bin/sh
printf '%s\\n' "${bin} $*" >> "$FAKE_LOG"
if [ ! -t 0 ] && [ "${bin}" != "agy" ]; then in=$(cat); printf '%s\\n' "STDIN:$in" >> "$FAKE_LOG"; fi
if [ -n "$FAKE_CHILD_PID_FILE" ]; then sleep 60 & echo $! > "$FAKE_CHILD_PID_FILE"; wait; fi
if [ -n "$FAKE_STUBBORN_PID_FILE" ]; then sh -c 'trap "" TERM; exec sleep 60' & echo $! > "$FAKE_STUBBORN_PID_FILE"; wait; fi
if [ -n "$FAKE_SLEEP" ]; then sleep "$FAKE_SLEEP"; fi
echo "out from ${bin}"
exit "\${FAKE_EXIT:-0}"
`);
  }
  return {
    dir,
    log,
    calls(bin) {
      const lines = readFileSync(log, "utf8").split("\n").filter(Boolean);
      return lines.map((l) => {
        const [b, ...rest] = l.split(" ");
        return { bin: b!, argv: [rest.join(" ")] };
      }).filter((c) => !bin || c.bin === bin);
    },
    env(extra = {}) {
      const base: NodeJS.ProcessEnv = { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_LOG: log, FAKE_DIR: dir };
      delete base.HERDR_PANE_ID;
      delete base.TMUX;
      delete base.TMUX_PANE;
      delete base.TERM_PROGRAM;
      delete base.HERDR_JEV_PANE_HOST;
      return { ...base, ...extra };
    },
  };
}

export const mkTmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), `jevtest-${prefix}-`));
  mkdirSync(d, { recursive: true });
  return d;
};

export const waitFor = async (check: () => boolean, ms = 8000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
};

export const exists = existsSync;
