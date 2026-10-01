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
  "model": "gpt-6.1-sol"
}
```

## Activity Labels
The Jev classification derives an explicit `activity` string from the pane context. When confident (`>= 0.6`), this activity replaces the native heuristic label on the office desk. The desk will render as `<agent kind> · <activity>`.

## Notification Channels
The `herdr-jev notify` command deduplicates notifications (default 600s cooldown via `HERDR_JEV_NOTIFY_COOLDOWN_S`) and supports two channels:
1. **Herdr native**: Spawns `herdr notification show` natively with a sound.
2. **Hook**: If `HERDR_JEV_NOTIFY_HOOK` points to an executable, it spawns it with `[title, body, paneId, reason]`.

Environment:
- `HERDR_JEV_NOTIFY`: Set to 1, true, or on to enable.
- `HERDR_JEV_NOTIFY_HOOK`: Path to executable.
- `HERDR_JEV_NOTIFY_COOLDOWN_S`: Cooldown in seconds (default 600).
- `HERDR_JEV_STATE_DIR`: State directory for cooldowns and escalations.

## Escalation
If `HERDR_JEV_ESCALATE_BLOCKED=1`, notifications with high confidence (`>= 0.85`) and a natively non-working status (`idle`, `done`, `unknown`) will escalate into Herdr's native agent status, forcing the pane to `blocked`. 
**Note:** This overrides Herdr's native status until released via `--release` or `--release-stale`. Stale escalations are cleaned up at office startup and quit.

## Rate Policy & Cost Control
Classification calls are heavily optimized to prevent unnecessary costs:
1. Caches are keyed by a hash of the cleaned last 30 lines + native status, as an LRU of 200 entries.
2. Working desks are classified at most once every 60 seconds.
3. Non-working desks are classified only after their text is stable for 2 ticks.
4. There is a global cap of 20 calls per minute (non-working prioritized).

**Worst-case cost:**
With a hard cap of 20 calls per minute, the absolute worst-case scenario will yield at most **1,200 classify calls per hour**, completely bounding the cost regardless of the number of agents.
