#!/usr/bin/env bash
# Open one of the plugin's overlay panes by ID.

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

PANE_ID="${1:-route}"

"$HERDR" pane open-overlay \
  --plugin "$PLUGIN_ID" \
  --pane "$PANE_ID" \
  --width "80%" \
  --height "80%" \
  >/dev/null 2>&1 || "$HERDR" pane open --plugin "$PLUGIN_ID" --pane "$PANE_ID"
