# Agent observability

`herdr-jev overview --watch` refreshes project, pane, branch, observed state, model and available weekly quota every two seconds without model calls. `--json` exposes the same records; `--attention` filters agents waiting for input or review.

New agents launched through Jev report their parent pane, role, model and handle through Herdr metadata. Historical panes and subagents running internally inside Codex or Claude do not expose this lineage. Observed completion is not verification of the work. Metadata expires after 24 hours.

The **Jev: Radar overview** action opens Jev Radar and **Jev: Lantern assistant** opens the native Lantern assistant using the existing Claude settings and approval policy. Both are Command Palette actions declared in `herdr-plugin.toml`; bind them to keys in the Herdr configuration if you want shortcuts. The assistant uses the overview for status and Jev for routing work.

Agents can report activity from their own pane:

```sh
herdr-jev report --activity "Testing authentication" --percent 40
herdr-jev report --activity "Which branch should I use?" --reason question --event branch-choice-1
herdr-jev report --activity "Ready for review" --percent 100 --event review-1
herdr-jev overview --attention --json
```

Reports are redacted, tied to the terminal/native session and repository, and expire after five minutes. `overview` orders immediate attention before review and ordinary work, while keeping native execution state intact. Office displays reported activity/progress and skips Jev classification while the matching report is fresh. A reported 100% creates a review event and becomes attention `soon` once the native agent is idle/done; it never verifies a run or bypasses independent review.

Questions, approvals, errors and review reports require a supported native session already indexed by `ai-harness sessions index`. They create an inbox event in the existing Harness history database before sending pane metadata. Inbox failures are reported; metadata failure leaves the persisted event available. Normal activity reports need only a verified terminal identity.

```sh
herdr-jev inbox add "Inspect the failing check" --session <indexed-session> --kind error --event check-failure-1
herdr-jev inbox list --all
herdr-jev inbox seen <work-id>
herdr-jev inbox done <work-id>
herdr-jev inbox list --all --status done
```

`seen` records visibility and leaves the item pending. `done` acknowledges it administratively; neither command submits a prompt, grants permission or verifies work. Replaying the same session/kind/event creates one item, including concurrent producers and after acknowledgement. Use a new event id for a new occurrence. Reports without `--event` derive a stable id from their redacted activity and reason. Events remain visible through `pending list` and its existing session picker after activity expires, a notification is missed or the process restarts.
