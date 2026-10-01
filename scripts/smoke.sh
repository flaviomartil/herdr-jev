#!/usr/bin/env bash
set -u

FAILED=0
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$REPO_DIR/src/cli.ts"
CLI_BIN="${HERDR_JEV_CLI:-}"
run_cli() {
  if [ -n "$CLI_BIN" ]; then
    $CLI_BIN "$@"
  else
    bun "$CLI" "$@"
  fi
}

TMP_STATE_DIR="$(mktemp -d -t herdr-jev-smoke-state-XXXXXX)"
export HERDR_JEV_STATE_DIR="$TMP_STATE_DIR"
cleanup() {
  rm -rf "$TMP_STATE_DIR"
}
trap cleanup EXIT

HERDR_BIN="${HERDR_BIN_PATH:-herdr}"
HERDR_REACHABLE=0

if command -v "$HERDR_BIN" >/dev/null 2>&1; then
  AGENT_LIST_OUT=$("$HERDR_BIN" agent list 2>/dev/null || true)
  AGENT_LIST_EXIT=$?
  if [ $AGENT_LIST_EXIT -eq 0 ] && node -e '
    try {
      const raw = process.argv[1];
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start === -1 || end === -1) process.exit(1);
      JSON.parse(raw.slice(start, end + 1));
      process.exit(0);
    } catch {
      process.exit(1);
    }
  ' "$AGENT_LIST_OUT" 2>/dev/null; then
    HERDR_REACHABLE=1
    echo "ok herdr reachable"
  else
    echo "skip herdr reachable"
  fi
else
  echo "skip herdr reachable"
fi


if grep -q '"--", ' src/herdr/notify.ts; then
  echo "FAIL: no double dash before herdr positionals"
  FAILED=1
else
  echo "ok no double dash before herdr positionals"
fi


if [ "${SMOKE_LIVE_NOTIFY:-0}" = "1" ]; then
  TMP_NOTIFY_DIR=$(mktemp -d)
  OUT=$(HERDR_JEV_STATE_DIR="$TMP_NOTIFY_DIR" HERDR_JEV_NOTIFY=1 bun "$CLI" notify --pane "wZZ:pZZ" --attention now --reason approval --project test --json 2>/dev/null || true)
  if node -e '
    try {
      const parsed = JSON.parse(process.argv[1]);
      if (parsed.sent === true && parsed.channels && parsed.channels.includes("herdr")) process.exit(0);
      process.exit(1);
    } catch {
      process.exit(1);
    }
  ' "$OUT"; then
    echo "ok SMOKE_LIVE_NOTIFY"
  else
    echo "FAIL SMOKE_LIVE_NOTIFY"
    FAILED=1
  fi
  rm -rf "$TMP_NOTIFY_DIR"
fi

if [ $HERDR_REACHABLE -eq 1 ]; then
  PANE_LIST_OUT=$("$HERDR_BIN" pane list 2>/dev/null || true)
  FIRST_PANE_ID=$(node -e '
    try {
      const raw = process.argv[1];
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start === -1 || end === -1) process.exit(0);
      const d = JSON.parse(raw.slice(start, end + 1));
      const panes = d.result?.panes || d.panes || d.result?.agents || d.agents || [];
      const first = panes[0]?.pane_id || panes[0]?.id;
      if (first) process.stdout.write(String(first));
    } catch {}
  ' "$PANE_LIST_OUT")

  if [ -n "$FIRST_PANE_ID" ]; then
    "$HERDR_BIN" pane get "$FIRST_PANE_ID" >/dev/null 2>&1
    REAL_PANE_EXIT=$?
    "$HERDR_BIN" pane get "nonexistent-id-smoke-999999" >/dev/null 2>&1
    FAKE_PANE_EXIT=$?

    if [ $REAL_PANE_EXIT -eq 0 ] && [ $FAKE_PANE_EXIT -ne 0 ]; then
      echo "ok contract of herdr pane get"
    else
      echo "FAIL contract of herdr pane get: real pane exit $REAL_PANE_EXIT, fake pane exit $FAKE_PANE_EXIT"
      FAILED=1
    fi
  else
    echo "FAIL contract of herdr pane get: no existing pane found in pane list"
    FAILED=1
  fi
else
  echo "skip contract of herdr pane get"
fi

if [ $HERDR_REACHABLE -eq 1 ]; then
  OVERVIEW_OUT=$(run_cli overview --json 2>/dev/null || true)
  if node -e '
    try {
      const raw = process.argv[1];
      const start = raw.indexOf("[");
      const end = raw.lastIndexOf("]");
      if (start === -1 || end === -1) process.exit(1);
      const arr = JSON.parse(raw.slice(start, end + 1));
      if (!Array.isArray(arr)) process.exit(1);
      for (const row of arr) {
        if (!("pane" in row) || !("agent" in row) || !("state" in row) || !("cwd" in row)) {
          process.exit(1);
        }
      }
      process.exit(0);
    } catch {
      process.exit(1);
    }
  ' "$OVERVIEW_OUT" 2>/dev/null; then
    echo "ok overview --json"
  else
    echo "FAIL overview --json: invalid JSON array or missing row keys"
    FAILED=1
  fi
else
  echo "skip overview --json"
fi

if [ $HERDR_REACHABLE -eq 1 ]; then
  AGENTS_OUT=$(run_cli agents --json 2>/dev/null || true)
  if node -e '
    try {
      const raw = process.argv[1];
      const start = raw.indexOf("[");
      const end = raw.lastIndexOf("]");
      if (start === -1 || end === -1) process.exit(1);
      const arr = JSON.parse(raw.slice(start, end + 1));
      if (!Array.isArray(arr)) process.exit(1);
      process.exit(0);
    } catch {
      process.exit(1);
    }
  ' "$AGENTS_OUT" 2>/dev/null; then
    echo "ok agents --json"
  else
    echo "FAIL agents --json: not a JSON array"
    FAILED=1
  fi
else
  echo "skip agents --json"
fi

RUNS_OUT=$(run_cli runs list --json --limit 1 2>/dev/null || true)
if node -e '
  try {
    const raw = process.argv[1];
    const start = Math.min(
      raw.indexOf("[") === -1 ? Infinity : raw.indexOf("["),
      raw.indexOf("{") === -1 ? Infinity : raw.indexOf("{")
    );
    const end = Math.max(raw.lastIndexOf("]"), raw.lastIndexOf("}"));
    if (start === Infinity || end === -1) process.exit(1);
    JSON.parse(raw.slice(start, end + 1));
    process.exit(0);
  } catch {
    process.exit(1);
  }
' "$RUNS_OUT" 2>/dev/null; then
  echo "ok runs list --json --limit 1"
else
  echo "FAIL runs list --json --limit 1: not valid JSON"
  FAILED=1
fi

if [ $HERDR_REACHABLE -eq 1 ]; then
  DAILY_JSON_OUT=$(run_cli daily --json 2>/dev/null || true)
  DAILY_MD_OUT=$(run_cli daily --md 2>/dev/null || true)
  if node -e '
    try {
      const jsonRaw = process.argv[1];
      const mdRaw = process.argv[2];
      const jStart = jsonRaw.indexOf("{");
      const jEnd = jsonRaw.lastIndexOf("}");
      if (jStart === -1 || jEnd === -1) process.exit(1);
      JSON.parse(jsonRaw.slice(jStart, jEnd + 1));

      const mdLines = mdRaw.split("\n").filter(l => !l.startsWith("AI Harness active"));
      const firstLine = mdLines[0] || "";
      if (!firstLine.startsWith("Resumo do dia")) process.exit(2);

      const enDashRegex = /\u2013/;
      const emDashRegex = /\u2014/;
      const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}\u{1F100}-\u{1F64F}\u{1F680}-\u{1F6FF}]/u;
      const cleanMd = mdLines.join("\n");
      if (enDashRegex.test(cleanMd)) process.exit(3);
      if (emDashRegex.test(cleanMd)) process.exit(4);
      if (emojiRegex.test(cleanMd)) process.exit(5);
      process.exit(0);
    } catch {
      process.exit(1);
    }
  ' "$DAILY_JSON_OUT" "$DAILY_MD_OUT" 2>/dev/null; then
    echo "ok daily --json and daily --md"
  else
    echo "FAIL daily --json and daily --md: invalid JSON or markdown format"
    FAILED=1
  fi
else
  echo "skip daily --json and daily --md"
fi

if [ $HERDR_REACHABLE -eq 1 ]; then
  TMP_STANDUP_FILE="$(mktemp -t standup-smoke-XXXXXX.md)"
  echo "Smoke standup prompt" > "$TMP_STANDUP_FILE"
  STANDUP_BEFORE_FILES=$(ls -A "$TMP_STATE_DIR" 2>/dev/null || true)
  STANDUP_OUT=$(run_cli standup --file "$TMP_STANDUP_FILE" --dry-run --json 2>/dev/null || true)
  STANDUP_AFTER_FILES=$(ls -A "$TMP_STATE_DIR" 2>/dev/null || true)
  rm -f "$TMP_STANDUP_FILE"

  if [ "$STANDUP_BEFORE_FILES" = "$STANDUP_AFTER_FILES" ] && node -e '
    try {
      const raw = process.argv[1];
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start === -1 || end === -1) process.exit(1);
      const parsed = JSON.parse(raw.slice(start, end + 1));
      if (!Array.isArray(parsed.targets) || !Array.isArray(parsed.skipped)) process.exit(1);
      const panePattern = /^[a-zA-Z0-9]+:[a-zA-Z0-9]+$/;
      for (const t of parsed.targets) {
        if (!t.pane || !panePattern.test(t.pane)) process.exit(1);
      }
      process.exit(0);
    } catch {
      process.exit(1);
    }
  ' "$STANDUP_OUT" 2>/dev/null; then
    echo "ok standup --dry-run --json"
  else
    echo "FAIL standup --dry-run --json: invalid shape, pane pattern mismatch, or state written"
    FAILED=1
  fi
else
  echo "skip standup --dry-run --json"
fi

STANDUP_AUTO_OUT=$(run_cli standup --auto --file "/nonexistent/standup-path-smoke-999.md" 2>/dev/null || true)
STANDUP_AUTO_EXIT=$?
if [ $STANDUP_AUTO_EXIT -eq 0 ] && node -e '
  try {
    const raw = process.argv[1];
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1) process.exit(1);
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (parsed.skipped === "no_file") process.exit(0);
    process.exit(1);
  } catch {
    process.exit(1);
  }
' "$STANDUP_AUTO_OUT" 2>/dev/null; then
  echo "ok standup --auto with missing file"
else
  echo "FAIL standup --auto with missing file: did not exit 0 with skipped no_file"
  FAILED=1
fi

NOTIFY_DRY_BEFORE=$(ls -A "$TMP_STATE_DIR" 2>/dev/null || true)
NOTIFY_DRY_OUT=$(run_cli notify --dry-run --json 2>/dev/null || true)
NOTIFY_DRY_AFTER=$(ls -A "$TMP_STATE_DIR" 2>/dev/null || true)

if [ "$NOTIFY_DRY_BEFORE" = "$NOTIFY_DRY_AFTER" ] && node -e '
  try {
    const raw = process.argv[1];
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1) process.exit(1);
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (parsed.dryRun === true && parsed.sent === false) process.exit(0);
    process.exit(1);
  } catch {
    process.exit(1);
  }
' "$NOTIFY_DRY_OUT" 2>/dev/null; then
  echo "ok notify --dry-run --json"
else
  echo "FAIL notify --dry-run --json: did not return dryRun true and sent false, or wrote state"
  FAILED=1
fi

NOTIFY_REL_OUT=$(run_cli notify --release --pane "wZZ:missing" --json 2>/dev/null || true)
if node -e '
  try {
    const raw = process.argv[1];
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1) process.exit(1);
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (parsed.skippedReason === "no escalation") process.exit(0);
    process.exit(1);
  } catch {
    process.exit(1);
  }
' "$NOTIFY_REL_OUT" 2>/dev/null; then
  echo "ok notify --release --pane <fake>"
else
  echo "FAIL notify --release --pane <fake>: did not return skippedReason no escalation"
  FAILED=1
fi

OFFICE_SCRIPT="$REPO_DIR/herdr-plugin/office/office.mjs"
OFFICE_OK=1
for col in 100 120 140; do
  OFFICE_OUT=$(COLUMNS=$col node "$OFFICE_SCRIPT" --once --demo 2>/dev/null)
  if [ $? -ne 0 ]; then
    OFFICE_OK=0
    break
  fi
  if ! node -e '
    const raw = process.argv[1];
    const col = Number(process.argv[2]);
    const strip = (s) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\r/g, "");
    const lines = raw.split("\n").filter(l => !l.startsWith("AI Harness active"));
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    if (lines.length === 0) process.exit(1);
    for (const line of lines) {
      if (strip(line).length !== col) process.exit(1);
    }
    process.exit(0);
  ' "$OFFICE_OUT" "$col" 2>/dev/null; then
    OFFICE_OK=0
    break
  fi
done

if [ $OFFICE_OK -eq 1 ]; then
  echo "ok the Office renders"
else
  echo "FAIL the Office renders: line width mismatch or exit non-zero"
  FAILED=1
fi

if grep -q "blocked_by_test_guard" "$REPO_DIR/src/herdr/client.ts" 2>/dev/null; then
  if grep -q "HERDR_JEV_TEST_GUARD" "$REPO_DIR/tests/preload.ts" 2>/dev/null; then
    echo "ok test guard present"
  else
    echo "FAIL test guard present: tests/preload.ts missing HERDR_JEV_TEST_GUARD"
    FAILED=1
  fi
else
  echo "skip test guard present"
fi

if [ "${SMOKE_LIVE_JEV:-0}" = "1" ]; then
  JEV_SAMPLE='{"paneText":"Waiting for approval to run command: rm -rf /tmp/test","agent":"codex","status":"working"}'
  CLASSIFY_OUT=$(echo "$JEV_SAMPLE" | run_cli classify-pane --json 2>/dev/null || true)
  if node -e '
    try {
      const raw = process.argv[1];
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start === -1 || end === -1) process.exit(1);
      const parsed = JSON.parse(raw.slice(start, end + 1));
      const requiredKeys = [
        "state",
        "stateConfidence",
        "attention",
        "attentionScore",
        "attentionConfidence",
        "blockedReason",
        "blockedReasonConfidence",
        "activity",
        "activityConfidence"
      ];
      for (const k of requiredKeys) {
        if (!(k in parsed)) process.exit(1);
      }
      if (!["none", "soon", "now"].includes(parsed.attention)) process.exit(1);
      process.exit(0);
    } catch {
      process.exit(1);
    }
  ' "$CLASSIFY_OUT" 2>/dev/null; then
    echo "ok classify-pane --json"
  else
    echo "FAIL classify-pane --json: missing required keys or invalid attention"
    FAILED=1
  fi
else
  echo "skip classify-pane --json (SMOKE_LIVE_JEV!=1)"
fi

exit $FAILED
