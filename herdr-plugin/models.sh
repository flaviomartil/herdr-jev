#!/usr/bin/env bash
# Inspect registered models, fallback chains, or auto-classify a new model.

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

echo "=== Herdr-Jev: Models & Cascades ==="
jev_cli models list

echo "--------------------------------------------------------"
echo "Want to auto-classify a newly released model with Jev?"
echo "Enter client and model (e.g. claude opus-6 or codex lamodelonueva)."
echo "Leave empty to exit."
echo
read -r -p "new model (client model)> " input || input=""

if [ -n "${input// /}" ]; then
  # split client and modelName
  read -r client modelName <<< "$input"
  if [ -n "${client:-}" ] && [ -n "${modelName:-}" ]; then
    echo
    jev_cli models classify "$client" "$modelName"
  else
    echo "Invalid input. Please provide both client and model name."
  fi
fi

hold
