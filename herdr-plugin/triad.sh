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
read -r -p "client (claude/codex/antigravity) [claude]: " client || client=""
client="${client:-claude}"

echo
if jev_cli route "$task" --client "$client" --triad; then
  notify "Herdr-Jev" "Launched Triad pipeline for: ${task:0:60}" done
else
  notify "Herdr-Jev" "Triad launch failed" request
  hold
  exit 1
fi

hold
