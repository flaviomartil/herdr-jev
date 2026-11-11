#!/usr/bin/env bash
set -eu
root=$(git rev-parse --show-toplevel)
hook="$(git rev-parse --git-path hooks)/pre-commit"
line='"$(git rev-parse --show-toplevel)/scripts/privacy-scan.sh" || exit $?'
mkdir -p "$(dirname "$hook")"
if [ -f "$hook" ] && grep -qF 'scripts/privacy-scan.sh' "$hook"; then
  echo "pre-commit already wired"
  exit 0
fi
if [ -f "$hook" ]; then
  if grep -q '^exit 0$' "$hook"; then
    sed -i "/^exit 0\$/i $line" "$hook"
  else
    echo "$line" >> "$hook"
  fi
else
  printf '#!/bin/sh\n%s\nexit 0\n' "$line" > "$hook"
fi
chmod +x "$hook"
echo "pre-commit wired"
