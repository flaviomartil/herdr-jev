# Integration Smoke Script

`scripts/smoke.sh` (runnable via `bun run smoke`) executes a fast, read-only smoke suite directly against the local checkout CLI (`src/cli.ts`) and active Herdr instance.

## Golden Rule

> Run `bun run smoke` before merging anything that touches the CLI contracts.

## Motivation

Unit tests with synthetic fakes can pass even when runtime integration contracts diverge (such as CLI flag changes, mismatched JSON shapes, or incorrect command recipients). The smoke script validates contracts against the actual CLI entrypoint and running Herdr daemon under realistic conditions in under 60 seconds.

## CLI Usage

```bash
bun run smoke
```

Or execute directly:

```bash
bash scripts/smoke.sh
```

To include the live TypeSafe Jev API classification check:

```bash
SMOKE_LIVE_JEV=1 bun run smoke
```

To include a live native notification, which really sends one:

```bash
SMOKE_LIVE_NOTIFY=1 bun run smoke
```

To run another executable instead of `bun src/cli.ts`, set `HERDR_JEV_CLI` to its command. The script must run from the repository root, because one check reads `src/herdr/notify.ts`.

## Checks Performed

0. **`no double dash before herdr positionals`**: Fails when `src/herdr/notify.ts` passes a `--` separator before `herdr` positional arguments.
1. **`herdr reachable`**: Confirms `herdr agent list` exits with 0 and returns valid JSON.
2. **`contract of herdr pane get`**: Verifies that `herdr pane get` exits with 0 for an existing pane ID from `herdr pane list`, and exits with a non-zero status for a non-existent pane ID.
3. **`overview --json`**: Confirms that `herdr-jev overview --json` outputs a JSON array whose items contain `pane`, `agent`, `state`, and `cwd`.
4. **`agents --json`**: Confirms that `herdr-jev agents --json` outputs a valid JSON array.
5. **`runs list --json --limit 1`**: Confirms that `herdr-jev runs list --json --limit 1` outputs valid JSON.
6. **`daily --json and daily --md`**: Confirms that `herdr-jev daily --json` outputs valid JSON, and `herdr-jev daily --md` starts with `Resumo do dia` and contains no en dash (`\u2013`), em dash (`\u2014`), or emojis.
7. **`standup --dry-run --json`**: Verifies with a temporary file that `herdr-jev standup --dry-run --json` returns `targets` and `skipped` arrays, every target pane ID matches the expected pane format, and no state files are written.
8. **`standup --auto with missing file`**: Verifies that running `herdr-jev standup --auto` with a missing file exits 0 with `{"skipped":"no_file"}`.
9. **`notify --dry-run --json`**: Verifies that `herdr-jev notify --dry-run --json` returns `dryRun: true` and `sent: false`, and writes no state.
10. **`notify --release --pane <fake>`**: Verifies that `herdr-jev notify --release --pane <fake>` returns `skippedReason: 'no escalation'`.
11. **`the Office renders`**: Runs `node herdr-plugin/office/office.mjs --once --demo` and validates that stripped output lines have exactly 100, 120, and 140 columns when invoked with those widths.
12. **`test guard present`**: Verifies that `tests/preload.ts` configures `HERDR_JEV_TEST_GUARD`. Marked as `skip` when `src/herdr/client.ts` does not contain `blocked_by_test_guard`.
13. **`classify-pane --json`** *(Optional: requires `SMOKE_LIVE_JEV=1`)*: Executes a live classification against a fixed terminal sample and asserts exact flat keys (`state`, `stateConfidence`, `attention`, `attentionScore`, `attentionConfidence`, `blockedReason`, `blockedReasonConfidence`, `activity`, `activityConfidence`) with attention in `none|soon|now`.

## Safety & Isolation

- **Strictly read-only by default**: The smoke suite never sends real prompts to agents, never triggers notifications, never reports agents as blocked, and never issues agent releases. The only exception is the opt-in `SMOKE_LIVE_NOTIFY=1` check, which sends one real notification.
- **Isolated state directory**: All checks run inside an isolated temporary directory (`HERDR_JEV_STATE_DIR`) created in OS temp and cleaned up on exit.
- **Graceful skip when Herdr is unreachable**: When Herdr is not running or unreachable, Herdr-dependent checks emit `skip <name>` and do not fail the suite.
- **Exit code**: Each check prints `ok`, `skip` or `FAIL`. The script exits with code 1 when any check printed `FAIL`.
