#!/usr/bin/env bash
# Prompt for a task, triage with Jev, and launch chosen agent in a new pane.

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

echo "=== Herdr-Jev: Route a Task ==="
echo "Describe the task to triage and execute. Empty input cancels."
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
if jev_cli route "$task" --client "$client"; then
  notify "Herdr-Jev" "Launched agent for: ${task:0:60}" done
else
  notify "Herdr-Jev" "Routing failed (see pane for details)" request
  hold
  exit 1
fi

hold
