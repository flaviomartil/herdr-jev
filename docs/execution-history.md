# Execution history and block reasons

The existing AI Harness external-run ledger remains authoritative. Herdr-Jev projects it into `run.json`; it does not introduce another orchestrator or state store.

Settled handoffs are archived by run, stage and receipt token in the Harness state directory. The reviewer uses the archived path and existing digest check, so overwriting a worker's original handoff cannot replace accepted evidence.

Explicit reconciliation retains the previous observation, block reason and report path before rotating the receipt token. Projection attempts distinguish reconciliation from initial launch. Reconciliation observes the existing worker; it does not launch another worker or submit follow-up work. Old runs without history remain readable.

Block reasons are bounded codes, not transcripts: `repository_trust`, `worker_unavailable`, `worker_reported_blocked`, and `missing_report`. Run summaries show the reason when present. Declared completion remains `reported` until the existing independent verification succeeds.

Report archival uses exclusive creation and validates matching artifacts after an interrupted settlement. Receipt replay is idempotent, stale tokens remain fenced, and arbitrary block descriptions or sensitive handoffs are rejected.

New follow-up execution, Office rendering of report history, and worker worktree integration are separate extensions. Existing worker cleanup and task isolation remain the mechanisms to reuse.

Concepts evaluated against [herdr-orchestrate](https://github.com/darjss/herdr-orchestrate/tree/281a462231ed5c9d69fdba503e08e05f6daf193d). Model routes and Pi integration were not ported.
