# Agent observability

`herdr-jev overview --watch` refreshes project, pane, branch, observed state, model and available weekly quota every two seconds without model calls. `--json` exposes the same records; `--attention` filters agents waiting for input.

New agents launched through Jev report their parent pane, role, model and handle through Herdr metadata. Historical panes and subagents running internally inside Codex or Claude do not expose this lineage. Observed completion is not verification of the work. Metadata expires after 24 hours.

`alt+o` opens Jev Radar. `alt+l` opens the native Lantern assistant using the existing Claude settings and approval policy. The assistant uses the overview for status and Jev for routing work.
