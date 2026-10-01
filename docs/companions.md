# Sessions, pending work, live effort and Studio

These features reuse AI Harness history and installed Herdr plugins. References: [Bercail](https://github.com/simoncrypta/bercail), [Trail](https://github.com/catoncat/herdr-trail), [Transcripts](https://github.com/hxreborn/herdr-transcripts), [Hail](https://github.com/natori-hrj/herdr-hail) and [Agent Router](https://github.com/nidhi-singh02/agent-router). No external router, memory store or Bercail installer is installed.

## Studio

Select an existing agent pane and invoke **Jev: Studio layout** in the Command Palette, or:

```sh
herdr-jev studio --pane <source-pane>
herdr-jev studio --pane <source-pane> --review
herdr-jev studio --pane <source-pane> --off
```

Studio retains that agent, creates a neighboring shell, and reuses the installed file sidebar when already present. Reported `done` opens installed reviewr below the shell when Git changes exist, including commits relative to an available main/master base. It leaves focus on the agent and preserves Harness verification. Existing review panes are reused. `--off` stops automatic review and leaves panes open.

Automatic review is scoped to the enrolled source identity and repository. A native session change requires re-enrollment; where Herdr exposes only a terminal identity, enrollment lasts for that terminal. Display metadata expires after one day; invoke Studio again to renew it. Other agents' events do nothing.

A dispatch without a confirmed pane receipt remains `pending` and is never retried automatically. Inspect panes and source metadata before reconciling; repeated layout requests refuse unresolved dispatches. Existing OS-backed locks serialize layout changes per source pane. Studio requires installed `herdr-sidebar`, `persiyanov.reviewr` and `flock`.

## Pending work

```sh
herdr-jev pending add "Validate the migration tomorrow" --session <native-id-or-history-key>
herdr-jev pending list
herdr-jev pending list --all --json
herdr-jev pending done <work-id>
```

Pending items use existing Harness `work_items` and `work_sessions` tables. Creation and origin linking are atomic; titles use existing redaction. The picker opens the origin conversation; Ctrl-D marks the selected item done. Closing an item is administrative state, not verified task completion. Opening a source never automatically submits the memo as work.

Equivalent Harness commands: `sessions work-create --title ... --session ...`, `sessions work-list --project ...`, and `sessions work-state --work ... --status open|done`. The latter can reopen an item. The source session must already be indexed. This is workflow state, not another memory provider.

## Session picker

```sh
herdr-jev sessions pick
herdr-jev sessions pick --all --search "migration"
herdr-jev sessions pick --all --json
herdr-jev sessions preview <history-key>
```

The interactive picker indexes at most 100 discovered source files per invocation, then searches the Harness index. Use `ai-harness sessions index` for the complete backlog. `--json` reads the current index. `fzf` previews bounded recent message text and notes with terminal controls removed.

Enter focuses an exact live native session. Otherwise, a visible Herdr tab uses `ai-harness resume` with its recorded client and cwd. Multiple live panes for one native session, or a live client in the repository without native session identity, require explicit selection and are not resumed again. Destinations use the existing Claude, Codex, Kimi and OpenCode adapters; native compatibility still depends on Harness checks.

## Live effort

```sh
herdr-jev effort <codex-pane> high
```

The first adapter supports an **idle Codex session**, an empty composer and a native footer beginning with `gpt-<model> low|medium|high|xhigh`. It sends native Alt+. / Alt+, verifies the resulting footer and retains the model/session. The level applies to the next turn. An agent can change only its own pane. Blocked/working panes, drafts, plan mode, missing footers and unsupported clients are rejected before dispatch. There is no automatic effort policy or override of explicit user preferences.

Claude's session-only slider and changes during working turns require separate native adapters and validation; they are not implemented. An unconfirmed change is never retried and never launches a replacement pane.

## Remote replies

Command Palette actions **Jev: Remote Telegram status**, **diagnostics** and **setup** reuse installed `permgps.telegram-agents`. That bridge already documents blocked notifications and replies to the agent topic, so a second Hail bridge is unnecessary for Telegram.

This integration leaves bot credentials and recipients unchanged and does not run setup or send messages automatically. Authorization, redaction and daemon availability belong to the bridge. End-to-end messaging requires a configured account; installed actions do not prove delivery. Slack/Discord remain optional future transports.

## Validation on this installation

Herdr-Jev passed its 171-test suite and TypeScript checking; the updated companion checks passed again after the native smoke test. Harness validation, lint and tests passed, including 80 Node tests; its checksums passed. The full Harness `check` stopped at an existing moderate `hono <4.13.7` advisory (`GHSA-hxh3-vqpv-xpqv`); the pre-existing dependency edits were preserved.

The Studio smoke test created and removed its own workspace, kept shell/review panes alive and reused each on a second invocation. No native model was launched. The installed reviewr release initially required unavailable GLIBC_2.39; it was rebuilt locally from its locked source and installed into the existing plugin. The old executable remains at `bin/herdr-reviewr.pre-studio` in the reviewr plugin directory for rollback.

All eight new Command Palette actions are registered. The remote-status wrapper and underlying Telegram status action completed successfully. Message delivery, native session resume and live effort against a real model session were not exercised; their deterministic checks use the existing test harness and preserve unsupported or unknown outcomes.
