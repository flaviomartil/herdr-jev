---
name: herdr-jev-models-sync
description: Keep the Herdr-Jev role matrix and the AI Harness model catalog aligned with the models each installed CLI really offers (Codex, Antigravity, Kimi, OpenCode, Claude, Cursor, Kiro). Use when asked to update herdr-jev models, when a launch fails with an unknown or rejected model id, when a new model family is released, or before delegating to a harness whose catalog may be stale.
---

# Herdr-Jev models sync

Two files decide which model a delegated agent gets:

- `ai-harness-core/harness.yml`, section `models:`. The catalog of ids, aliases and efforts each client accepts. `ai-harness model-resolve` reads it.
- `herdr-jev/config/models.json`. The role matrix: for each client, the model and fallback chain of advisor, implementer, reviewer, researcher and reader.

A model that is live in the CLI but missing from `harness.yml` cannot be selected. A role that points to an id the CLI no longer accepts fails at launch.

## Routine

```bash
cd ~/projects/personal/herdr-jev
herdr-jev models sync
herdr-jev models sync --apply
herdr-jev models sync
```

The first run only reports drift. `--apply` writes both files, regenerates `SHA256SUMS` in ai-harness-core and runs `ai-harness validate`; if validation fails it restores `harness.yml`. The last run must print `catalogs in sync`.

Add `--probe-claude` to send a one-word request to every cataloged Claude id. Add `--json` for a machine-readable report.

## Where each client's list comes from

- codex: `~/.codex/models_cache.json`, entries with `visibility: list` and a `gpt-` slug.
- antigravity: `agy models`. Ids carry the effort as suffix (`-low`, `-medium`, `-high`); the catalog entry gets `effort_cli_ids`.
- kimi: `~/.kimi-code/config.toml`, the `"kimi-code/<model>"` tables.
- opencode: `opencode models`. Hundreds of ids across providers; they validate the matrix but are not copied into `harness.yml`.
- claude: no list command. Use `--probe-claude`, or check an id by hand with `claude -p --model <id> "Reply with the single word ok"`.
- cursor: `cursor-agent models`. Skipped while it answers "No Cursor IDE installation found".
- kiro: no list command and needs login. Skipped.

## Reading the report

- `missing in harness.yml [client]: ...`: live ids absent from the catalog. `--apply` adds them.
- `cataloged but not live [client]: ...`: catalog ids the CLI no longer lists. Not removed automatically; remove by hand only after confirming the id is retired.
- `would repair client.role: old -> new`: the role's model is not live and the first live entry of its fallback chain replaces it.
- `needs manual choice client.role`: neither the model nor any fallback is live. Edit `config/models.json` by hand, then rerun.
- `user override not live: key = model`: fix or delete the entry in `~/.config/herdr/herdr-jev-models.json`.

## What the sync does not do

It adds ids and repairs dead assignments. It does not decide that a newer model should take over a role. To promote one:

1. Check the id is live (report or probe).
2. For Claude, add the id and its alias to `harness.yml` and to `CLAUDE_MODEL_ALIASES` in `src/herdr/launcher.ts`.
3. Set `model` and `fallbackChain` for the role in `config/models.json`. Use an id or alias the catalog knows; a bare family name such as `astra` is rejected by Codex unless the catalog maps it.
4. Run `python3 ../ai-harness-core/scripts/update-checksums.py --write` when `harness.yml` was edited by hand.

## Verify

```bash
ai-harness model-resolve --root ~/projects/personal/ai-harness-core --client claude --model fable-5
herdr-jev models list --json
cd ~/projects/personal/herdr-jev && bunx tsc --noEmit && bun test
```

`model-resolve` must answer `known: true` with the expected `cliModel`. Tests pin model ids in `tests/claude-models.test.ts`, `tests/herdr-jev.test.ts`, `tests/reader-role.test.ts`, `tests/review-fixes.test.ts`, `tests/role-matrix.test.ts`, `tests/harness-models.test.ts` and `tests/fake-harness.ts`; update the expectations when a role changes model. The full suite takes about 8 minutes.

## Launch notes

- `herdr-jev subagent --tab` and `--split` only work inside Herdr (`HERDR_ENV=1`). Outside it, use `--no-split --print`.
- Neither repository is committed by the sync. Review the diff and commit each one separately.
