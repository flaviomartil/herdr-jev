#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
case "${1:-}" in
  studio) jev_cli studio ;;
  review) jev_cli studio --review ;;
  studio-off) jev_cli studio --off ;;
  event) jev_cli studio --event ;;
  sessions) jev_cli sessions pick ;;
  pending) jev_cli pending list ;;
  resume)
    case "${HERDR_JEV_RESUME_CLIENT:-}" in claude|codex|kimi|opencode) ;; *) exit 2 ;; esac
    [[ "${HERDR_JEV_RESUME_SESSION:-}" =~ ^[a-zA-Z0-9:_-]+$ ]] || exit 2
    exec ai-harness resume --to "$HERDR_JEV_RESUME_CLIENT" --session "$HERDR_JEV_RESUME_SESSION" --cwd "$PWD" --no-index
    ;;
  *) exit 2 ;;
esac
