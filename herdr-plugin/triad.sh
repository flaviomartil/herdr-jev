#!/usr/bin/env bash
# Prompt for a task and launch full Triad pipeline (Advisor -> Implementer -> Reviewer).

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

echo "=== Herdr-Jev: Full Triad Pipeline ==="
echo "Forces complete 3-stage execution: Advisor -> Implementer -> Reviewer."
echo
read -r -p "task> " task || task=""

if [ -z "${task// /}" ]; then
  echo "Cancelled."
  exit 0
fi

echo
read -r -p "client (empty = source agent): " client || client=""
args=()
if [ -n "$client" ]; then args+=(--client "$client"); fi
read -r -p "exact advisor model (empty = detected): " model || model=""
if [ -n "$model" ]; then args+=(--model "$model"); fi
read -r -p "layout (split/tab) [split]: " layout || layout=""
if [ "${layout:-split}" = "tab" ]; then args+=(--tab); fi
read -r -p "checks JSON argv file (required for independent review): " checks || checks=""
if [ -z "$checks" ]; then
  echo "A checks JSON argv file is required to finish implementation and review."
  hold
  exit 1
fi

echo
if jev_cli route "$task" "${args[@]}" --triad --wait --verify-command-json "$checks"; then
  notify "Herdr-Jev" "Launched Triad pipeline for: ${task:0:60}" done
else
  notify "Herdr-Jev" "Triad launch failed" request
  hold
  exit 1
fi

hold
