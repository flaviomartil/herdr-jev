#!/usr/bin/env bash
# Open one of the plugin's overlay panes by ID.

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

PANE_ID="${1:-route}"
if [[ "$PANE_ID" == "overview" || "$PANE_ID" == "assistant" ]]; then
  context="$(bun -e 'const c=JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}"); console.log(JSON.stringify({sourcePaneId:c.focused_pane_id || process.env.HERDR_PANE_ID,cwd:c.focused_pane_cwd || process.cwd()}))')"
else
  context="$(jev_cli context --json)"
fi
source_pane="$(bun -e 'console.log(JSON.parse(process.argv[1]).sourcePaneId || "")' "$context")"
repository="$(bun -e 'console.log(JSON.parse(process.argv[1]).cwd)' "$context")"

"$HERDR" plugin pane open \
  --plugin "$PLUGIN_ID" \
  --entrypoint "$PANE_ID" \
  --placement "${HERDR_JEV_PLACEMENT:-overlay}" \
  --cwd "$repository" \
  --env "HERDR_JEV_SOURCE_PANE_ID=$source_pane"
