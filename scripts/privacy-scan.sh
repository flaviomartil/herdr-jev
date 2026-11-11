#!/usr/bin/env bash
set -u
root=$(git rev-parse --show-toplevel)
cd "$root" || exit 2
terms="${JEV_PRIVATE_TERMS:-$HOME/.config/jev/private-terms.txt}"
status=0
if [ -f "$terms" ]; then
  git diff --cached --no-ext-diff -U0 --diff-filter=ACMR | python3 -c '
import re,sys
rx=[re.compile(l.strip()) for l in open(sys.argv[1], encoding="utf-8") if l.strip()]
cur=""; bad=0
for line in sys.stdin:
    if line.startswith("+++ "): cur=line[6:].strip(); continue
    if line.startswith("+") and any(r.search(line) for r in rx):
        print("  %s: private term in added line" % cur, file=sys.stderr); bad=1
sys.exit(bad)
' "$terms" || { echo "privacy-scan: private term found in staged changes" >&2; status=1; }
else
  echo "privacy-scan: $terms not found, private-terms check skipped" >&2
fi
if command -v gitleaks >/dev/null 2>&1; then
  gitleaks protect --staged --redact --no-banner -c "$root/.gitleaks.toml" >&2 || status=1
else
  echo "privacy-scan: gitleaks not installed, secret check skipped" >&2
fi
exit $status
