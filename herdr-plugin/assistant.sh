#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
unset HERDR_JEV_SOURCE_PANE_ID
claude --append-system-prompt "$(cat "$PLUGIN_ROOT/herdr-plugin/assistant.md")" "Show herdr-jev overview --attention. Briefly say which agents need me; do not launch or prompt workers." || hold
