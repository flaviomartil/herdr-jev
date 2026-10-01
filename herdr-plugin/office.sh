#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
exec node "$PLUGIN_ROOT/herdr-plugin/office/office.mjs" "$@"
