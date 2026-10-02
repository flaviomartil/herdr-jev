# Agent observability

`herdr-jev overview --watch` refreshes project, pane, branch, observed state, model and available weekly quota every two seconds without model calls. `--json` exposes the same records; `--attention` filters agents waiting for input.

New agents launched through Jev report their parent pane, role, model and handle through Herdr metadata. Historical panes and subagents running internally inside Codex or Claude do not expose this lineage. Observed completion is not verification of the work. Metadata expires after 24 hours.

The **Jev: Radar overview** action opens Jev Radar and **Jev: Lantern assistant** opens the native Lantern assistant using the existing Claude settings and approval policy. Both are Command Palette actions declared in `herdr-plugin.toml`; bind them to keys in the Herdr configuration if you want shortcuts. The assistant uses the overview for status and Jev for routing work.
