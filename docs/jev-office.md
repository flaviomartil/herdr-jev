# Herdr Jev Office

## Classification Contract
The `herdr-jev classify-pane --json` command returns a flat JSON object:
```json
{
  "state": "blocked|working|idle|done|unknown",
  "stateConfidence": 0.95,
  "attention": "none|soon|now",
  "attentionScore": 1.8,
  "attentionConfidence": 0.88,
  "blockedReason": "approval|question|error|none",
  "blockedReasonConfidence": 0.92,
  "activity": "testing|editing|reading|running|planning|waiting_approval|waiting_answer|error|idle|done|unknown",
  "activityConfidence": 0.8,
  "jevMs": 1200,
  "model": "jev-1.13.0"
}
```

## Activity Labels
The Jev classification derives an explicit `activity` string from the pane context. When `activityConfidence` is at least `0.45`, the Office shows it on the monitor of a working desk and in the detail card instead of the native heuristic label. The Jev `state` replaces the native state only when `stateConfidence` is at least `0.7` and the state is not `unknown`.

## Notification Channels
The `herdr-jev notify` command deduplicates notifications (default 600s cooldown via `HERDR_JEV_NOTIFY_COOLDOWN_S`) and supports two channels:
1. **Herdr native**: Spawns `herdr notification show` natively with a sound.
2. **Hook**: If configured or present at default location, spawns the executable with `[title, body, paneId, reason]`.

Hook resolution:
- When `HERDR_JEV_NOTIFY_HOOK` is unset, `herdr-jev` checks for `<herdr-jev config dir>/notify-hook`. If the file exists and is executable, it runs as the default hook. The config dir is `HERDR_PLUGIN_CONFIG_DIR` only when `HERDR_PLUGIN_ID` is `herdr-jev`, otherwise `~/.config/herdr/plugins/config/herdr-jev`.
- When `HERDR_JEV_NOTIFY_HOOK` is set to an explicit path, that path is used.
- When `HERDR_JEV_NOTIFY_HOOK` is set to `""` or `off`, the hook is completely disabled.

Environment:
- `HERDR_JEV_NOTIFY`: Enabled unless set to `0`, `false` or `off`.
- `HERDR_JEV_NOTIFY_HOOK`: Path to executable, or empty / `off` to disable.
- `HERDR_JEV_NOTIFY_COOLDOWN_S`: Cooldown in seconds (default 600).
- `HERDR_JEV_STATE_DIR`: State directory for cooldowns and escalations (`<stateDir>/notify/`). `HERDR_PLUGIN_STATE_DIR` is used when it is unset, with `~/.local/state/herdr-jev` as the fallback.

## Escalation
With Herdr 0.9.0, escalation has no effect on natively detected agents (`claude`, `codex`, `agy`, and the like) because Herdr's native detection retains authority over their status. The feature stays off by default (`HERDR_JEV_ESCALATE_BLOCKED=0`).

When enabled (`HERDR_JEV_ESCALATE_BLOCKED=1`), `herdr-jev` attempts to escalate high-confidence blocked alerts (`>= 0.85`) by calling `herdr pane report-agent <pane>`. It then verifies `herdr agent get <pane>`: if `agent_status` is not `blocked`, the escalation is treated as ineffective (`escalation: "ineffective"`), no escalation record is written, and `escalation` is not listed in active channels. If it applied, stale escalations can be cleaned up via `--release`, `--release-stale`, or `--release-all`. Records whose pane no longer exists or whose release keeps failing are dropped after 3 attempts.

The supported way to be alerted outside the machine is `HERDR_JEV_NOTIFY_HOOK`. When configured, `herdr-jev` executes the hook script with four arguments: `title`, `body`, `pane`, and `reason`.

Example hook script:
```bash
#!/usr/bin/env bash
TITLE="$1"
BODY="$2"
PANE="$3"
REASON="$4"

notify-send "$TITLE" "$BODY (pane $PANE, reason $REASON)"
```

## Rate Policy & Cost Control
Classification calls are heavily optimized to prevent unnecessary costs:
1. Caches are keyed by a hash of the cleaned last 30 lines + native status, as an LRU of 200 entries.
2. Working desks are classified at most once every 60 seconds.
3. Non-working desks are classified only after their text is stable for 2 ticks.
4. There is a global cap of 20 calls per minute (non-working prioritized).

**Worst-case cost:**
With a hard cap of 20 calls per minute, the absolute worst-case scenario will yield at most **1,200 classify calls per hour**, completely bounding the cost regardless of the number of agents.

## Launcher Model Mapping
The launcher maps `gemini-3.8-pro` to `gemini-3.1-pro` on purpose, because the Antigravity CLI has no 3.8 pro model.
