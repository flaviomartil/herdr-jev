#!/usr/bin/env bash
# Open one of the plugin's overlay panes by ID.

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

PANE_ID="${1:-route}"
context="$(jev_cli context --json)"
source_pane="$(bun -e 'console.log(JSON.parse(process.argv[1]).sourcePaneId || "")' "$context")"
repository="$(bun -e 'console.log(JSON.parse(process.argv[1]).cwd)' "$context")"

"$HERDR" plugin pane open \
  --plugin "$PLUGIN_ID" \
  --entrypoint "$PANE_ID" \
  --placement overlay \
  --cwd "$repository" \
  --env "HERDR_JEV_SOURCE_PANE_ID=$source_pane"
