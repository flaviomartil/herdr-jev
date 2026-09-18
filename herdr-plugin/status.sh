#!/usr/bin/env bash
# Show status of TypeSafe Jev API, Herdr environment and AI-Harness connection.

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

jev_cli status
hold
