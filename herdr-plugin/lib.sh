#!/usr/bin/env bash
# Shared helpers for Herdr-Jev plugin.

set -euo pipefail

PLUGIN_ROOT="${HERDR_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PLUGIN_ID="${HERDR_PLUGIN_ID:-herdr-jev}"
HERDR="${HERDR_BIN_PATH:-herdr}"

jev_cli() {
  if [ -n "${HERDR_JEV_BIN:-}" ]; then
    "$HERDR_JEV_BIN" "$@"
  elif [ -f "$PLUGIN_ROOT/src/cli.ts" ]; then
    bun run "$PLUGIN_ROOT/src/cli.ts" "$@"
  elif [ -f "$PLUGIN_ROOT/bin/herdr-jev.js" ]; then
    node "$PLUGIN_ROOT/bin/herdr-jev.js" "$@"
  else
    echo "herdr-jev CLI not found in $PLUGIN_ROOT." >&2
    return 127
  fi
}

notify() {
  "$HERDR" notification show "$1" --body "$2" --sound "${3:-none}" >/dev/null 2>&1 || true
}

hold() {
  echo
  read -r -p "Press Enter to close... " _ || true
}
