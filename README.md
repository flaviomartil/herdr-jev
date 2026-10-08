# Herdr-Jev

Jev-driven multi-model triage, calibrated turn routing, and Triad orchestration plugin for Herdr and AI-Harness.

Session search, origin-linked pending work, native Codex effort and the Bercail-inspired Studio layout are documented in [companion features](docs/companions.md). They reuse Harness history, existing file/review panes and Telegram integration.

Latency calibration clears cached answers before every sample while retaining the warmed connection. Peer routing reuses the installed usage collector through AI Harness: fresh Codex account exhaustion excludes Codex from automatic selection and explicit peer startup. Stale, unknown and model-scoped observations do not prove provider availability; native account/model preflight remains necessary. Other providers retain their existing quota checks.

Kiro peers use native Herdr kind `kiro` and executable `kiro-cli chat --trust-all-tools`. Authenticate with `kiro-cli login`, discover native model IDs, then supply `subagent --target kiro --model <verified-id> --tab` under an allowed peer mapping. Kiro remains unconfigured for automatic model selection until a verified role catalog exists; it never inherits a Claude model or scalar effort flag. The shared AI Harness installs the `ai-harness` Kiro agent and its MCP/skill context.

Inside Herdr, `plan` and `route` read the source pane's exact model and fresh Codex worker availability. Delegation still requires a matching AI Harness profile. Explicit `--model` overrides advisor discovery; `--available-models` overrides worker availability and may omit the observed advisor. A route without an executable profile exits unsuccessfully instead of reporting an agent launch.

`herdr-jev route "task" --tab` creates a tab; the default tiles delegated workers as a balanced grid in the caller's central region without changing focus. Use `--direction right|down` for the existing explicit split behavior, or `HERDR_JEV_LAYOUT=role` to restore role-based auto layout. `--source-pane <id>` preserves the advisor pane when routing from an overlay, and `--cwd <repository>` selects the worker repository. Stage effort is passed to both interactive and captured Codex/Claude commands.

For implementation followed by independent review, use `--wait --verify-command-json <checks.json>`, where the file contains a JSON command array such as `["bun", "test"]`. `run-resume <id> --cwd <repository> --verify-command-json <checks.json>` reconciles the existing attempt without launching uncertain work again. Resume renews observation of the same bound agent; a task withheld by a trust dialog is submitted once after the dialog is resolved. A prompt with uncertain acknowledgement is never submitted again automatically.

## Canonical execution through AI Harness

`plan` and MCP `herdr_plan` expose both advisory `stages` and canonical `executionStages`. Only the latter can be launched automatically by `route`. Supply the actual advisor model and verified available model IDs; an unknown model, unavailable Harness, or missing exact profile means direct execution in the current session. `--triad` and local quota cascades do not override this decision.

Execution stages follow the profile's route for the triage complexity, so a stage can run on another client than the session. The peers offered to the Harness come from the cross-harness setting (none when it is disabled or not recognised), minus the session client, `HERDR_JEV_EXCLUDE_CLIENTS`, clients with exhausted quota and peers whose routed model is exhausted. Each stage is launched with its own client, shown as `role:client/model` by `plan`. `route` stops with `peer_unavailable` and leaves a queued stage untouched when its client is no longer an allowed peer on resume.

```sh
herdr-jev plan "Implement the change" --client codex --model gpt-6-astra --available-models gpt-5.6-luna,gpt-5.6-sol --triad --json
herdr-jev route "Implement the change" --client codex --model gpt-6-astra --available-models gpt-5.6-luna,gpt-5.6-sol --triad --wait --verify-command-json /absolute/path/checks.json
herdr-jev run-status <run-id>
herdr-jev run-resume <run-id> --verify-command-json /absolute/path/checks.json
```

The check file contains a JSON argv array, for example `["bun","test"]`. Run from the target repository. The current advisor keeps coordination; only the implementer is launched in a new Herdr pane. The independent reviewer runs through Harness `review-judge`, using the exact profile and read-only Codex or Claude adapter. No real model is launched outside Herdr.

The Harness records an attempt before dispatch, with a stable agent name, a bounded deadline and an immutable receipt. The implementer writes a handoff of at most 16 KiB. Pane `done` means reported, not verified. Deterministic checks must pass before review; review must cover the same Git snapshot before verified completion. Without `--wait`, return after launch; without a check command, stop at reported. Resume observes the existing agent and never repeats an uncertain launch. Expired or uncertain attempts stay unresolved; automatic retries are deliberately absent.

State belongs to the existing Harness task database. Private objective/handoff artifacts and the atomic, sanitized Dagr projection live under `~/.local/state/herdr-jev/<run-id>/`; `run-status` refreshes `run.json`. The projection contains roles, model IDs, attempt state and live locators, excluding task text, transcripts, repository paths and receipt tokens. Validate it with `dagr check <run.json> --strict`.

`quota status` consumes the installed Herdr Agent Usage Codex snapshot through the Harness normalizer. Scope, age and reset are explicit; data older than two minutes is stale. Missing observations are unknown. These observations do not authorize model substitution. Usage telemetry goes through `ai-harness usage-record`; task text and learning prose are no longer appended to `auto-improvements.jsonl`. Existing historical files are not migrated or deleted.

## Model catalog, bypass mode and trust policy

Herdr-Jev consumes these `ai-harness` commands through `src/harness/bridge.ts`. When the installed Harness does not know a command (it answers `unknown_command` or `invalid_external_action`), is absent, or answers with something unusable, every feature below falls back to the built-in behavior and nothing fails.

| Harness command | Used for | Fallback |
| :--- | :--- | :--- |
| `model-resolve --client --model [--effort] [--role]` | CLI model id, effort arguments, bypass arguments and read-only reviewer arguments. Answers are cached in memory per process; a failed answer is cached for 30 seconds only. | `resolveClaudeModel`, `resolveAntigravityModel`, the built-in effort flags and the built-in argument tables. A model the Harness reports with `known: false` also uses the built-in mapping. |
| `model-catalog [--client]` | `herdr-jev models catalog [client]` prints the answer unchanged. | Prints `{available: false, reason, fallback}` with the built-in bypass and read-only arguments and exits with code 1. |
| `external-run --action worker-create`, `worker-settle`, `list` | Worker runs, `workers close`, `runs list` and the Office swarm data. | No run is recorded; `runs list` shows local projections only. |
| `review-verify --scopes`, `review-judge --scope`, `review-findings` | `herdr-jev review`. | One `default` scope, with `review-status` for the status. |
| `policy-check --kind trust --path` | Automatic confirmation of the trust dialog. | The dialog is left for you, as before. |
| `tool-env.json` in the generated directory | State and configuration directories. | The rules described in the variable tables. |

**Bypass mode.** Every agent Herdr-Jev starts as an advisor, implementer or researcher starts in the no-prompt mode of its CLI, so the worker never stops to ask for permission. The arguments come from the Harness catalog (`bypassArgs`); the built-in values are the fallback:

| Client | Bypass argument |
| :--- | :--- |
| Claude Code | `--dangerously-skip-permissions` |
| Codex | `--dangerously-bypass-approvals-and-sandbox` |
| AntiGravity | `--dangerously-skip-permissions` |
| Kiro | `--trust-all-tools` (already part of `kiro-cli chat`, never repeated) |
| Kimi | `--yolo` |

The bypass argument goes after the model and effort arguments and before the prompt text. A flag the stage already carries is never added twice. `model-resolve` is asked with the role as launched (`implementer`, `advisor`, `researcher` or `reviewer`), Kimi included. When the delegation plan carries a `cliModel` for the executor or reviewer, it is used as the CLI model id before any other mapping. The reviewer role never receives bypass arguments on any launch path (`subagent`, `herdr_spawn_subagent`, `herdr_consensus`, inline and captured runs, and the pipeline), and the command builders drop any bypass, sandbox or approval flag the stage carries in `extraFlags`. Read-only arguments exist built in only for Codex (`--sandbox read-only`) and Claude (`--tools Read,Glob,Grep`). For AntiGravity and Kimi a reviewer is read-only only when the Harness catalog answers `readonlyArgs` for it; without them it starts with no read-only flag, only without bypass arguments. Kiro, Cursor and OpenCode never get read-only arguments (the catalog is not asked for them), so a reviewer on those clients is not restricted by Herdr-Jev. A Kiro reviewer never gets `--trust-all-tools`. Where read-only arguments apply they are appended after the prompt. A harness answer with an empty `bypassArgs` list means no bypass flags; the built-in values apply only when the harness is unavailable, old, or leaves the field out. A prompt starting with `-` is passed with a leading space so it is never read as an option. Set `HERDR_JEV_BYPASS=0` to start workers without the bypass arguments (Kimi loses `--yolo`; the `--trust-all-tools` of Kiro is part of its fixed command line). Cursor and OpenCode have no bypass argument.

**Trust dialog.** When a new worker shows a repository trust dialog, the launcher asks `ai-harness policy-check --kind trust --path <worker cwd>`. The path sent is the absolute, symlink-resolved working directory of the worker; a directory that cannot be resolved is never sent and is reported as `trustPolicyReason: cwd_unresolved`. Automatic confirmation is refused (`trustPolicyReason: directory_flags_present`) when the command carries a directory option (`--cd`, `--cwd`, `--chdir`, `--add-dir`, `--workdir`, `--work-dir`, `--working-dir`, `--directory`, `--dir`, `--workspace`, or `-C` and `-w` in any form, attached or separate), because the dialog could then ask about a different folder than the one the policy approved. A directory printed in the dialog is compared with the checked one (a `~` is expanded, symlinks are resolved, a truncated path is matched by its visible part); on a difference nothing is sent and the reason is `trust_path_mismatch`. A dialog that shows no directory, for example because the top scrolled off a narrow pane, cannot be compared and is not refused for that. If the answer is `trusted: true`, it moves the selection until the pane shows the cursor on the `Yes, I trust` option (checked by reading the pane again after every key), presses Enter only then, waits for the agent prompt and delivers the task. The result carries `trustConfirmed: true` and `trustPolicyReason`. If the answer is `trusted: false`, the Harness cannot answer, the cursor cannot be verified, or `HERDR_JEV_AUTO_TRUST=0`, the result is the usual `trustRequired: true` and no key is sent, with the reason in `trustPolicyReason`. A key is sent only after two identical consecutive reads of the pane. `trustConfirmed` reports the acceptance, separately from readiness: it is set once Enter was sent and the dialog is no longer on the pane, even when the agent prompt did not appear within about 5 seconds; the launch then continues with the normal readiness wait and re-classifies the pane on every read, and a slow or failed start is reported by `ok` and `error`, not by `trustConfirmed`. When the dialog is already gone before any key is sent (`not_trust_dialog`) nothing was accepted and `trustConfirmed` is absent. After Enter was sent the result is never `trustRequired`: a dialog still on the pane, or no readable pane (`trust_dialog_persisted`), or a dialog that comes back (`trust_dialog_reappeared`), is reported as a failed launch with that `trustPolicyReason`, without `trustConfirmed`, and no second Enter is sent. Selection menus that are not trust dialogs, including command approval prompts, are never answered.

Next requested investigation: [Jev video ideas](docs/next-jev-video-analysis.md).

## Overview

**Herdr-Jev** serves as the semantic triage engine and multi-model orchestrator for Herdr. Instead of blindly delegating every task to a single model or suffering from rigid execution locks, Herdr-Jev provides:

1. **Semantic Triage with TypeSafe Jev System One**: Evaluates architectural complexity, research needs, and reasoning effort in approximately 260–340ms.
2. **Pre-flight Turn Routing (`route-turn`)**: In ~330ms, decides model tier (`fast`, `balanced`, `deep`), reasoning effort budget, allowed tools by risk level, and gated skill relevance.
3. **Resilient Transport & Socket Pool Preservation**: Raced deadline timer prevents TCP/TLS socket teardown on timeouts, eliminating alternating fallback loops; incorporates double-handshake connection prewarming (`herdr-jev prewarm`).
4. **Bimodal Quantile Scoring (Anti-Underprovisioning)**: Reads the 0.60 quantile of probability distributions instead of expected value (mean), dropping model under-provisioning on complex architectural tasks from 31.5% to 1.9%.
5. **4 Request-Shape Gates**: Incorporates `produces_artifact` alongside `acts_on_system`, `follows_procedure`, and `prose_suffices` to unlock advisory, architectural, and review skills without requiring command execution.
6. **Downstream Prefix-Cache Preservation**: Renders `<skill_relevance>` blocks appended strictly after system prompt cache breakpoints to prevent provider cache misses.
7. **Local Latency Auto-Calibration (`calibrate`)**: Measures local network round-trips to `api.typesafe.ai` and records machine-calibrated deadlines in `.env`.
8. **Advisory Multi-Model Matrix** (automatic execution uses the canonical profile above):
   - **Claude Code**: Advisor (Fable 5) -> Implementer (Sonnet 5 with 1M tokens window) -> Reviewer (Opus 5).
   - **Codex CLI**: Advisor (Astra) -> Implementer (GPT-5.6-Luna at XHIGH effort) -> Reviewer (GPT-5.6-Sol at XHIGH effort).
   - **AntiGravity**: Advisor/Primary (Claude Opus 4.6) -> Implementer/Fallback (Gemini 3.8 Flash High) -> Autonomous Research Subagents.
9. **Herdr Pane Orchestration**: Splits panes, spawns native agent CLI sessions, and injects handoff prompts via Herdr CLI without stalling the terminal.
10. **Structural Usage**: Sends only routing metadata to [`ai-harness-core`](https://github.com/flaviomartil/ai-harness-core); semantic learning remains in the shared learning workflow.


---

## Quick Start (Automated Setup)

Run the automated installer to install dependencies, build the global CLI binary, link the plugin into Herdr, and register keybindings in `~/.config/herdr/config.toml`:

```bash
./scripts/install.sh
```

The installer appends keybindings to `~/.config/herdr/config.toml` only when the file exists and does not yet mention `herdr-jev`:
- `prefix+j`: `herdr-jev.route` (Jev: Route Task)
- `prefix+J`: `herdr-jev.triad` (Jev: Full Triad Pipeline)
- `prefix+m`: `herdr-jev.models` (Jev: Models and Cascades)
- `prefix+s`: `herdr-jev.status` (Jev: Status)

The other plugin actions (Lantern assistant, Radar overview, Office view, Studio layout, Routines) are available from the Herdr Command Palette. They are declared in [`herdr-plugin.toml`](herdr-plugin.toml).

The Jev classification layer in Jev Office is enabled by default (`HERDR_JEV_OFFICE_JEV=0` disables). See [Jev Office](#jev-office) for hotkeys and panels.

---

## Interactive Architecture Diagram (Archify Showcase)

An interactive, explorable HTML architecture diagram generated with **Archify** is available at:
* [`docs/architecture.html`](docs/architecture.html): open in any browser to inspect the full orchestration flow, triage plane, and quota circuit breaker.

---

## Manual Installation in Herdr

To manually link the plugin into Herdr:

```bash
herdr plugin link .
```

To list registered actions:

```bash
herdr plugin action list --plugin herdr-jev
```

---

## Packaged Agent Skill (Claude Code, Codex, AntiGravity)

Herdr-Jev includes a native agent skill located at [`skills/herdr-jev/SKILL.md`](skills/herdr-jev/SKILL.md).

Running `./scripts/install.sh` automatically creates symlinks in standard agent skill directories:
* `~/.agents/skills/herdr-jev` (discovered by Claude Code, Codex CLI, Cursor, and OpenCode)
* `~/.gemini/config/skills/herdr-jev` (discovered by AntiGravity)

Once linked, any AI coding assistant can autonomously invoke `herdr-jev` to triage tasks, plan multi-agent pipelines, or cascade fallback models.

---

## Standalone Operation (Without AI-Harness)

Herdr-Jev is completely self-contained and operates seamlessly without external harnesses:
* **No AI-Harness Required**: If `ai-harness-core` is not present, Herdr-Jev operates in standalone mode. Structural usage metadata is sent through `ai-harness usage-record` only when the Harness is found; otherwise nothing is recorded and no learning file is written.
* **No Herdr Required**: Outside Herdr, `plan` still prints the execution plan, and `subagent` runs the target harness inline in the current terminal. Pane features (`route`, `subagent --tab`, `peer-message`, `workers`) need Herdr.
* **Zero-Cost Fallback**: If `TYPESAFE_API_KEY` is omitted, tasks are triaged through a local heuristic analyzer with 0ms latency.

---

## Environment Configuration Matrix

Herdr-Jev reads configuration from the process environment. At startup the CLI also loads `~/.config/herdr/.env` and the repository `.env` (see [`.env.example`](.env.example)); a variable that is already set in the environment is never overwritten by these files. `herdr-jev review` runs the verification and the judges without the `HERDR_JEV_*` variables that came from those files; every other variable, such as proxy or provider settings, is passed on unchanged. While `HERDR_JEV_TEST_GUARD=1` the repository `.env` is not read, so tests that spawn the CLI do not inherit a developer's settings. The test suite is hermetic in the same way: `tests/preload.ts` removes every `HERDR_JEV_*` variable before the tests run and sets only its own guard and private state and configuration directories under the OS temp dir. Under the guard the configuration directory has no default: without `HERDR_JEV_CONFIG_DIR` it fails with `config_dir_required_in_tests`, like the state directory with `state_dir_required_in_tests`, so no test run can touch `~/.config/herdr`.

### HERDR_JEV_* variables

Every `HERDR_JEV_*` variable read by the CLI, the Herdr plugin scripts, the Jev Office or `scripts/smoke.sh`. Placeholders such as `<CLIENT>` are upper-cased client names; non-alphanumeric characters become `_`.

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `HERDR_JEV_DEADLINE_MS` | `1000` | Strict deadline in ms for Jev queries. Falls back to `HARNESS_ROUTER_DEADLINE_MS` when unset. `herdr-jev calibrate -w` writes a calibrated value. Deadline fallbacks use `deadline-exception`; network failures use `network-exception`. |
| `HERDR_JEV_ALLOW_ALIASES` | off | Enables custom client aliases and binary overrides. Truthy values: `1`, `true`, `yes`, `on`. |
| `HERDR_JEV_ENABLE_ALIASES` | off | Same gate; read only when `HERDR_JEV_ALLOW_ALIASES` is unset. |
| `HERDR_JEV_ALIASES` | unset | JSON object mapping alias to base client, for example `{"claude-px":"claude"}`. Honored only when aliases are enabled. |
| `HERDR_JEV_ALIAS_<NAME>` | unset | Maps one alias to a base client. `<NAME>` is lower-cased and `_` becomes `-` (`HERDR_JEV_ALIAS_CLAUDE_PX=claude` maps `claude-px`). Honored only when aliases are enabled. |
| `HERDR_JEV_BIN_<CLIENT>` / `HERDR_JEV_<CLIENT>_BIN` | harness default binary | Executable used for that client or alias. Honored only when aliases are enabled. |
| `HERDR_JEV_<CLIENT>_<ROLE>` | `config/models.json` | Model override for a role (`ADVISOR`, `IMPLEMENTER`, `REVIEWER`, `RESEARCHER`), for example `HERDR_JEV_CLAUDE_ADVISOR=fable-6`. An alias key wins over its base client key. |
| `HERDR_JEV_<CLIENT>_EXHAUSTED` | unset | `1` marks a non-Codex client as quota exhausted during `detect`. |
| `HERDR_JEV_CROSS_HARNESS` | unset | Delegation scope: `0`/`false`/`off`/`none`/`disabled` (self only), `1`/`true`/`on`/`auto` (Jev decides), a peer list, a pair mapping or JSON. Unset or empty means self only for `plan` and `route`; `subagent` treats an unset variable as `auto`. |
| `HERDR_JEV_RECOMMENDED_<ROLE>` | unset | Forces the client Jev recommends for a role in cross-harness delegation. |
| `HERDR_JEV_SPLIT_SUBAGENTS` | `1` inside Herdr, `0` outside | `1`/`true`/`on`/`yes` split pane, `0`/`false`/`off`/`no` inline native harness. The CLI flags `--split` and `--no-split` win. |
| `HERDR_JEV_SPLIT_DIRECTION` | `auto` | `right` or `down` forces that direction unless `HERDR_JEV_LAYOUT=grid`. Any other value keeps `auto`. |
| `HERDR_JEV_LAYOUT` | `grid` | `grid` tiles workers as a balanced grid in the caller's central region; `role` uses role-based directions (`down` for reviewers, `right` otherwise). |
| `HERDR_JEV_READY_TIMEOUT_MS` | `45000` | How long `subagent` and `route` wait for the new agent to show its prompt before the task is sent. |
| `HERDR_JEV_SOURCE_PANE_ID` | unset | Source pane override, set by the plugin pane launcher. Used by `studio`, `context`, `standup`, peer messaging and the Office. |
| `HERDR_JEV_STATE_DIR` | `~/.local/state/herdr-jev` | State root for runs, grid workers, `review/`, `daily/`, `standup/` and `notify/`. Every module resolves it in this order: `HERDR_JEV_STATE_DIR`, then `HERDR_PLUGIN_STATE_DIR` (ignored when `HERDR_PLUGIN_ID` names another plugin), then the `stateDir` below. When neither variable is set, the `stateDir` of `herdr-jev` in the Harness `tool-env.json` is used before the default. The first time the configured directory is used in a process and the default directory exists, its contents are moved into the configured one (one rename when the configured directory is missing, otherwise entry by entry without overwriting anything that already exists there), so grid records, spawn fences, peer locks and run history are not orphaned; the move is safe to repeat and to run from several processes at once. Entries that conflict stay in the default directory. The resolved root is remembered for the life of the process. Every module resolves the root through the same function, and a relative value is anchored to the starting directory. |
| `HERDR_JEV_CONFIG_DIR` | Harness `configDir`, else `~/.config/herdr` | Directory of `herdr-jev-models.json` and `herdr-jev-quotas.json`. A leading `~` is expanded and a relative value is anchored to the starting directory. The `configDir` of `herdr-jev` in the Harness `tool-env.json` is used when the variable is unset; a file missing there is still read from `~/.config/herdr`. Writes, including `quota reset`, create the directory when it is missing. |
| `HERDR_JEV_BYPASS` | on | `0`, `false`, `off` or `no` stops advisors, implementers and researchers from starting in the no-prompt mode of their CLI. See [Bypass mode](#model-catalog-bypass-mode-and-trust-policy). |
| `HERDR_JEV_AUTO_TRUST` | on | Unset, empty, `1`, `true`, `on` or `yes` keep it on; any other value (`0`, `false`, `off`, `no` and anything unrecognised) stops the launcher from confirming the repository trust dialog of a new worker, even when the Harness says the path is trusted. |
| `HERDR_JEV_NOTIFY` | enabled | `0`, `false` or `off` disables `notify`. Any other value, or unset, leaves it enabled. |
| `HERDR_JEV_NOTIFY_COOLDOWN_S` | `600` | Per-pane cooldown in seconds between notifications. |
| `HERDR_JEV_NOTIFY_HOOK` | unset | Executable called with `title`, `body`, `pane`, `reason` after the native notification. No hook runs when it is unset. |
| `HERDR_JEV_ESCALATE_BLOCKED` | off | `1` lets `notify` and the Office try to report high-confidence blocked agents to Herdr. See the limitation under `notify`. |
| `HERDR_JEV_OFFICE_JEV` | enabled | `0`, `false` or `off` turns the Jev classification layer in the Office off. It is always off with `--demo`. |
| `HERDR_JEV_TIMEOUT_MS` | `5000` | Timeout of the `overview --json` poll the Office runs. |
| `HERDR_JEV_BIN` | `herdr-jev` | Executable used by the plugin scripts and the Office to call the CLI. |
| `HERDR_JEV_PLACEMENT` | `overlay` | Placement used by `herdr-plugin/open-pane.sh`; the manifest actions set `tab`. |
| `HERDR_JEV_RESUME_CLIENT`, `HERDR_JEV_RESUME_SESSION` | unset | Set by the session picker for the resume pane. `HERDR_JEV_RESUME_CLIENT` must be `claude`, `codex`, `kimi` or `opencode`. |
| `HERDR_JEV_ENABLE_OPENCODE` | off | `1` lets `detect` treat OpenCode as configured. |
| `HERDR_JEV_EXCLUDE_CLIENTS` | unset | Comma-separated clients that `detect` leaves out of its recommendation and that `plan` and `route` never offer as peers for routed execution stages. |
| `HERDR_JEV_TEST_GUARD` | unset | `1` blocks anything that would change Herdr state or launch a real agent. Set by `tests/preload.ts`. `AI_HARNESS_TEST_GUARD=1` is treated the same way. Under the guard only an `ai-harness` executable under the OS temp dir is used, and the Harness `tool-env.json` is ignored. |
| `HERDR_JEV_CLI` | `bun src/cli.ts` | Command `scripts/smoke.sh` runs instead of the checkout CLI. |

### Related variables

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `TYPESAFE_API_KEY` | Vault / local heuristic | TypeSafe Jev System One key (~260ms response). When unset the CLI tries `vault get AI-Providers/TypeSafe`, then falls back to the deterministic local heuristic. |
| `TYPESAFE_DEFAULT_MODEL` | `jev-1.13.0` | Pinned TypeSafe Jev model version (avoids the moving `jev-latest` alias). |
| `AI_HARNESS_ROOT`, `AI_HARNESS_CORE_PATH` | auto-discover | Path to the `ai-harness-core` repository. |
| `AI_HARNESS_GENERATED_DIR` | `~/.local/share/ai-harness/generated` | Directory holding the `tool-env.json` written by `harness apply`. |
| `AI_HARNESS_TEST_GUARD` | unset | `1` is honored like `HERDR_JEV_TEST_GUARD`. |
| `HERDR_BIN_PATH` | `herdr` | Herdr executable. |
| `HERDR_PLUGIN_ID` | `herdr-jev` | Plugin ID. A different ID makes `standup`, `daily` and `notify` ignore `HERDR_PLUGIN_CONFIG_DIR`, `HERDR_PLUGIN_STATE_DIR` and `HERDR_PANE_ID`. |
| `HERDR_PLUGIN_CONFIG_DIR` | `~/.config/herdr/plugins/config/herdr-jev` | Directory holding `standup.md`. |
| `HERDR_PLUGIN_STATE_DIR` | unset | State directory supplied by Herdr to plugin processes. |

---

## Harness & Quota Auto-Discovery

Herdr-Jev can inspect your system PATH, probe installed AI coding assistants, check their versions and active model quotas, and auto-configure your environment:

```bash
# Detect installed harnesses and print status table
herdr-jev detect

# Output structured JSON for automation or agent consumption
herdr-jev detect --json

# Automatically generate or update .env with healthy detected harnesses
herdr-jev detect --auto-config
```

### Probed Harness Status Table

| Client | Default Binary | PATH Resolution | Quota Status | Primary & Fallback Models |
| :--- | :--- | :--- | :--- | :--- |
| **Claude Code** | `claude` | `~/.local/bin/claude` | Healthy | `fable-5`, `sonnet-5` (1M tokens), `opus-5` |
| **Codex CLI** | `codex` | `~/.local/bin/codex` | Healthy | `astra`, `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra` |
| **AntiGravity** | `agy` | `~/.local/bin/agy` | Healthy | `claude-opus-4-6`, `gemini-3-8-flash`, `gemini-3-8-pro` |
| **Cursor** | `agent` | System PATH | Healthy | `cursor-smart`, `cursor-fast` |
| **OpenCode** | `opencode` | System PATH | Healthy | `opencode-primary` |

---

## CLI Usage

The global `herdr-jev` command is available directly in your PATH:

```bash
# Check status of TypeSafe Jev, Herdr runtime, AI-Harness connection, Subagent Mode, and Peering
herdr-jev status

# List, inspect, or retry recorded runs
herdr-jev runs list --limit 20
herdr-jev runs get <run-id>
herdr-jev runs retry <run-id> --from-failed --verify-command-json /absolute/path/checks.json

# Probe installed harnesses, model quotas, and recommended cross-harness peering
herdr-jev detect

# Auto-configure .env based on detected healthy harnesses
herdr-jev detect --auto-config

# Triage a task (evaluates complexity, research requirement, and effort)
herdr-jev triage "Refactor multi-tenant database persistence"

# Preview execution plan with cross-harness delegation (Jev assigns optimal client per role)
herdr-jev plan "Add database log migration" --client claude --cross-harness auto

# Force a complete Triad pipeline (Advisor -> Implementer -> Reviewer)
herdr-jev plan "Fix schema documentation" --client claude --triad

# Route and launch agent stages in Herdr panes (spawns research subagent if needed)
herdr-jev route "Investigate transaction timeout in payment service" --client claude

# Wait for protocol terminal states (done/blocked/unknown); this does not verify work evidence
herdr-jev route "Investigate transaction timeout in payment service" --client claude --wait

# Spawn subagent in a split pane (Jev decides direction automatically)
herdr-jev subagent "Research OAuth2 PKCE flow in authentication service" --client claude --role researcher --split

# Spawn subagent with explicit split direction (e.g. down for reviewer or test logs)
herdr-jev subagent "Verify test coverage and PR diff" --client codex --role reviewer --split --direction down

# Spawn subagent in live native harness mode (subagent work appears live without -p)
herdr-jev subagent "Draft database migration for audit log table" --client codex --role implementer --no-split

# Delegate subagent across harnesses (e.g. Claude delegates research to AntiGravity)
herdr-jev subagent "Scan codebase for API secrets" --client claude --role researcher --cross-harness auto

# --- New Resilient Turn Routing & Network Calibration ---

# Route a turn in ~330ms (decides tier, effort, tools, and gated skill)
herdr-jev route-turn "escreva o ADR de migracao para Kafka" --prompt

# Prewarm connection pool (2 warmup queries amortizing handshake lag)
herdr-jev prewarm

# Measure network latency from local machine to api.typesafe.ai and write calibrated deadline to .env
herdr-jev calibrate -s 15 -w
```

---

## Command Reference

`herdr-jev --help` lists every command and `herdr-jev <command> --help` lists its options. Commands that classify with Jev (`triage`, `plan`, `route`, `subagent`, `route-turn`, `classify-pane`, `models classify`, `prewarm`, `calibrate` and the MCP tools) use the TypeSafe API when a key is available and the deterministic local heuristic otherwise.

### Triage and planning

| Command | Purpose |
| :--- | :--- |
| `triage <task> [-j, --json]` | Classifies complexity (`trivial`, `routine`, `moderate`, `architectural`), research need, effort (`standard`, `high`, `xhigh`) and recommended pipeline (`direct` or `triad`). `--json` prints the raw decision. |
| `plan <task>` | Prints the execution plan: advisory `stages` and the canonical `executionStages` that `route` may launch. Options: `-c, --client`, `--source-pane`, `-t, --triad`, `--model`, `--available-models`, `--cross-harness`, `-j, --json`. |
| `route <task>` | Triages, plans and launches the canonical stages in Herdr panes, then prints the result as JSON. Exits with code 1 when the plan resolves to direct execution, on error, or when a stage ends `failed`, `unknown` or `blocked`. Options: `-c, --client`, `--source-pane`, `--tab`, `--split`, `--cwd`, `-t, --triad`, `--model`, `--available-models`, `--timeout-ms` (default `900000`), `--verify-command-json`, `--wait`, `-d, --direction`, `--cross-harness`. `--no-split` is rejected; use `--tab` or `--split`, not both. |
| `context [--json]` | Resolves the source pane, workspace and repository and prints them as JSON without launching anything. |
| `route-turn <turn>` | Pre-flight turn routing, described in [its own section](#pre-flight-turn-routing--resilient-engine-route-turn). Options: `-j, --json`, `--prompt`, `--cold`, `--deadline <ms>`. |
| `prewarm` | Opens the TypeSafe connection pool ahead of real turns. |
| `calibrate` | Measures latency to `api.typesafe.ai`. Options: `-s, --samples` (25), `--spacing` (150 ms), `--margin` (1.25 on p98), `--ceiling` (1500 ms), `-w, --write-env [path]`. |
| `status` | Shows the TypeSafe key source, Herdr environment, Harness connection, subagent mode, split direction, cross-harness mode and recorded quota breakers. |
| `detect` | Detects installed harnesses and quotas. Options: `-j, --json`, `-w, --write-env [path]`, `-a, --auto-config` (writes `./.env` by default). |

### Runs

Runs live in the existing Harness ledger; Herdr-Jev projects them to `~/.local/state/herdr-jev/<run-id>/run.json`.

| Command | Purpose |
| :--- | :--- |
| `run-status <id>` and `runs get <id>` | Reconcile deadlines, refresh the sanitized projection and print `{run, projection}` as JSON. Nothing is redispatched. |
| `run-resume <id>` | Observes the existing attempt and continues verified dependencies. Options: `--timeout-ms`, `--verify-command-json`, `--cwd`, `--cross-harness`. |
| `runs list` | Lists recorded runs, newest first, merging the local projections with `ai-harness external-run --action list`. Each entry shows its kind (`pipeline` or `worker`) after the id; `--json` adds `kind` and `source` (`local`, `harness` or `both`). Options: `--limit <n>` (a non-negative integer, default 20; anything else prints `{"error":"invalid_limit"}` on stderr and exits 1), `--json`. Fields the Harness supplies are printed without terminal control sequences and line breaks, and malformed harness entries are skipped or shown without stages instead of aborting the list. |
| `runs retry <id> --from-failed` | Retries only `failed`, `unknown` and `blocked` stages. `--from-failed` is required. Options: `--timeout-ms`, `--verify-command-json`, `--cwd`, `--cross-harness`. |

`run-resume` and `runs retry` exit with code 1 when a stage is still `failed`, `unknown` or `blocked`. Pass the same `--cross-harness` value the run was created with; a queued or prompt-pending stage on a peer client that is no longer allowed stops with `peer_unavailable`.

### subagent

```sh
herdr-jev subagent "<prompt>" [-c <source>] [-t <target>] [-r <role>] [--tab | --split | --no-split]
  [--name <handle>] [--model <id>] [--effort standard|high|xhigh] [--source-pane <id>]
  [--cwd <path>] [-d auto|grid|right|down] [--cross-harness <mode>] [-p] [--worktree [name]]
```

- Roles are `researcher` (default), `implementer`, `reviewer` and `advisor`.
- `--tab` opens a persistent peer in a new tab and requires Herdr; it cannot be combined with `--split` or `--no-split`. `--name` requires a tab or split inside Herdr and makes retries reuse the existing peer.
- Without `--tab`, the mode follows `--split`, `--no-split`, then `HERDR_JEV_SPLIT_SUBAGENTS`, then whether the command runs inside Herdr. Outside Herdr a split request falls back to the native harness running inline; `-p, --print` makes that inline run non-interactive.
- `--effort` defaults to the Jev triage of the prompt. `--model` and `--target` are preserved as given.
- Output on success is a JSON object with `ok`, `paneId`, `agentName`, `client`, `model`, `effort` (native value or `null`), `recommendedEffort` and `effortApplied`, plus `runId` when the Harness recorded the worker and `trustConfirmed` with `trustPolicyReason` when the trust dialog was accepted.
- Inside Herdr the worker is recorded with `ai-harness external-run --action worker-create`. The request carries the client, model, role, working directory, branch, fork point, pane, handle and the SHA-256 of the prompt; the prompt text is never sent. The returned run id is stored in the tracking record of the worker. Every worker started inside Herdr from a known caller pane is tracked, whatever the layout (grid, `-d right` or `-d down`, or `--tab`); the record carries its `layout` kind (`grid`, `split` or `tab`). A run is created only for a worker that has such a record, so every run can be settled by `workers close`. When the tracking record cannot be written (for example a full disk or a lock timeout) the worker still starts and the result carries `trackingError`; no run is created for it. A failure of the bookkeeping that follows a successful start (worktree record, run) is reported on stderr and never hides the result JSON.
- The worker starts in the no-prompt mode of its CLI (see [Bypass mode](#model-catalog-bypass-mode-and-trust-policy)); the reviewer role never gets bypass arguments and is read-only where read-only arguments exist (see the table above).

**Worktree (`--worktree [name]`).** Creates an isolated sibling worktree and starts the peer there.

- The slug is `name`, else `--name`, else a random six-character string. It must match `^[A-Za-z0-9][A-Za-z0-9._-]*$` (no `/`), must not contain `..`, end with `.` or `.lock`, or start with `codex/`.
- The branch is `wt/<slug>` created from `HEAD`; the directory is `<repository>-wt-<slug>` next to the repository.
- An existing worktree of the same repository already on `wt/<slug>` is reused. A directory that is not such a worktree, an existing `wt/<slug>` branch, or a directory outside a Git repository stops the command with an error on stderr and exit code 1, before any pane is created.
- The worktree path and branch are stored in the worker's tracking record. Herdr-Jev never removes the worktree.

**Readiness wait.** After the agent starts and its spawn metadata is reported, a non-empty prompt is not sent immediately. Herdr-Jev polls every 500 ms, for up to `HERDR_JEV_READY_TIMEOUT_MS` (default 45000), until the agent is `idle` and its pane shows the harness prompt: `›` for Codex, `❯` or `>` for Claude, a lone `>` for AntiGravity; other clients only need `idle`. On timeout the command exits with code 1 and prints a result with `ok: false`, `ackStatus: "unknown"`, `promptPending: true`, `error: "Agent prompt readiness timed out"` and `hint: "prompt not observed; use peer-message"`. The pane stays open and the task was not sent.

**Trust dialog.** The pane is inspected right after start and on every readiness poll for a repository trust prompt (for example `Trust and continue`, `Do you trust this folder?`, `Yes, proceed`, or a numbered choice menu). When the Harness `policy-check` says the working directory is trusted, the dialog is confirmed as described under [trust policy](#model-catalog-bypass-mode-and-trust-policy) and the task is delivered. In every other case the task is not sent: the command exits with code 1 and prints a result with `ok: false`, `ackStatus: "blocked"`, `completionState: "blocked"`, `trustRequired: true`, `promptPending: true` and `hint: "confirm trust in the pane, then send the task with peer-message"`. Confirm the dialog in the pane, then deliver the task with `peer-message`. When Herdr answers `agent_not_ready` for a pane that shows a trust dialog, the launcher treats it as a trust dialog (unless `HERDR_JEV_AUTO_TRUST=0`).

### peer-message and peer-read

A failed `peer-message` (a working peer, missing arguments, an unknown target) prints one line of JSON, `{"error": "<message>"}`, on stderr and exits with code 1.

```sh
herdr-jev peer-message <agent> "<text>" [--wait] [--lines <n>] [--timeout-ms <ms>]
herdr-jev peer-message --all "<text>" [--exclude <handle,handle>] [--wait] [--lines <n>] [--timeout-ms <ms>]
herdr-jev peer-read <agent> [--wait] [--lines <n>] [--timeout-ms <ms>]
```

- `--lines` is the terminal snapshot limit (default 2000, from 1 to 100000). `--timeout-ms` is the wait deadline (default 900000, from 1 to 3600000).
- A peer accepts a message only while `idle` or `done`; a `working` or `blocked` peer is rejected, and a pending repository trust dialog must be resolved first.
- Without `--wait`, `peer-message` returns `{target, paneId, acknowledged, state}` once the working turn is observed. With `--wait`, and for `peer-read`, the result is `{target, paneId, state, observedStateOnly, output, lineLimit, source}`: a bounded terminal snapshot, not a transcript or a verified result.
- `--all` takes the message as the only positional argument (adding `<agent>` is an error) and sends it to every tracked grid worker of the caller pane that is still in the pane layout, skipping the caller. `--exclude` matches the worker's handle or pane ID. The output is a JSON array of `{agent, paneId, acknowledged, state}`; the exit code is 1 if any worker did not acknowledge. `--timeout-ms` bounds the whole broadcast, and workers reached after it expires report `state: "timeout"`.

### Workers

| Command | Purpose |
| :--- | :--- |
| `workers list [-j, --json]` | Lists tracked grid workers per caller pane with their live agent status (`[{callerPaneId, workerPaneId, status}]` with `--json`). |
| `workers close [--pane <id>] [--all-idle] [--yes]` | Plans the closing of tracked worker panes whose status is `idle` or `done`. Without `--yes` it only prints the plan; nothing is closed. A caller pane is never closed. One of `--pane` or `--all-idle` is required to select anything. Closing a worker that has a Harness run settles it with `worker-settle` (state `closed`, head = the HEAD of the worker's checkout) and prints whether it was settled, but only once the pane really closed (or was already gone). A pane that stays open is reported on stderr, makes the command exit with code 1 and keeps its tracking and its run open. Records dropped because their pane left the layout settle their run as `closed` too. A pane is reported as already gone only for `pane_not_found` (or a message that names the pane as not found), never for a generic `not_found`. A record whose settlement failed stays tracked and is retried the next time the pane is found closed (at most 3 attempts); a tracking file that cannot be updated is reported on stderr and makes the command exit with code 1. When the checkout of a worker was removed, the head of its recorded branch is read from the repository it came from. Tab workers are tracked and closed like split workers. |

### Overview, agents and daily

| Command | Purpose |
| :--- | :--- |
| `overview [--json] [--attention] [--watch]` | Project, pane, branch, observed state, model, weekly quota and run summary, grouped by project, with no model calls. `--attention` keeps only blocked agents, `--watch` refreshes every two seconds, and `--watch` cannot be combined with `--json`. State marks: `●` working, `?` blocked, `✓` done, `○` idle, `·` unknown. |
| `agents [--caller <pane>] [--all] [--json]` | Tracked swarm agents grouped by project: slot, state, commits ahead and uncommitted files (`C/U`), handle, client, model, branch and run. Defaults to the caller pane (`HERDR_PANE_ID`); `--all` shows every caller. |
| `daily` | Deterministic end-of-day summary per agent, with zero model calls. Formats: default aligned text, `--json`, `--md` (Markdown in Brazilian Portuguese) and `--plain` (Markdown without the title line). `--project <name>` filters by repository or workspace label and is repeatable. `--since <ISO date-time>` replaces the default of local midnight. `--write` saves the Markdown to `<stateDir>/daily/YYYY-MM-DD.md` (mode 0600) and prints that path; with `--write` alone the report itself is not printed. Details in [docs/daily.md](docs/daily.md). |

### standup

`herdr-jev standup` sends the instruction of the day from a Markdown file to eligible agents through the safe peer path.

```markdown
---
states: idle,done
max: 12
---
Good morning. Today is {{date}}. Keep the harness clean.

## herdr-jev
Review the open work on {{branch}}.
```

- **File**: `--file <path>`, otherwise `standup.md` in `HERDR_PLUGIN_CONFIG_DIR`, falling back to `~/.config/herdr/plugins/config/herdr-jev/standup.md`.
- **Front matter** (optional): `states` (default `idle,done`; `working` and `blocked` agents are never targeted) and `max` (default 12, capped at 100).
- **Text**: the part before the first `## ` heading goes to every eligible agent; a `## <project>` section is added for agents whose project or workspace label matches, case-insensitively. Variables: `{{date}}` (DD/MM/YYYY), `{{project}}`, `{{branch}}`, `{{agent}}`. Each message is capped at 8192 bytes.
- **`--dry-run`**: prints the plan (`targets` and `skipped`, each skipped pane with a reason: `filtered`, `caller`, `no_agent`, `plugin_pane`, `no_text`, `beyond_max`) and sends nothing. Running without `--yes` and without `--auto` behaves the same way.
- **`--yes`**: sends the messages and records `<stateDir>/standup/YYYY-MM-DD.manual-<timestamp>.json`.
- **`--auto`**: unattended mode for schedulers. A missing or blank file prints `{"skipped":"no_file"}` and exits 0. A previous automatic run today prints `{"skipped":"already_ran_today"}` and exits 0 unless `--force` is given. Otherwise it sends and records `<stateDir>/standup/YYYY-MM-DD.auto.json`. It needs no caller pane.
- **`--pane <id>`** (repeatable) restricts targets to those panes. **`--json`** prints structured results. **`--force`** ignores the daily guard.

The state directory is `HERDR_JEV_STATE_DIR` (or `HERDR_PLUGIN_STATE_DIR`), defaulting to `~/.local/state/herdr-jev`. See [docs/standup.md](docs/standup.md) for the full reference.

### notify

`herdr-jev notify` raises one deduplicated notification for an agent that needs a human. It is normally called by the Jev Office.

```sh
herdr-jev notify --pane w1:p2 --project herdr-jev --attention now --reason approval --agent codex --task "Run the tests" --dry-run --json
```

- **Required to send**: `--attention now`, `--pane` (`<workspace>:<pane>` identifier), `--project` and `--reason` (`approval`, `question`, `error` or `none`). Anything else returns `sent: false` with a `skippedReason` (`attention not now`, `missing required arguments`, `invalid pane id`, `invalid agent`, `disabled by env`).
- **Channels**: `herdr` is the native `herdr notification show` with a sound; `hook` runs the executable in `HERDR_JEV_NOTIFY_HOOK` with the arguments `title`, `body`, `pane`, `reason` (5 second limit, then SIGTERM and SIGKILL, output discarded). Without `HERDR_JEV_NOTIFY_HOOK`, an executable `notify-hook` in the plugin config directory (`~/.config/herdr/plugins/config/herdr-jev` by default) is used when present; `off` or an empty value disables the hook. `hook` appears in `channels` only when the hook ran and exited with status 0. The title and body are redacted for secrets and written in Brazilian Portuguese.
- **Cooldown**: one notification per pane every `HERDR_JEV_NOTIFY_COOLDOWN_S` seconds (default 600), recorded in `<stateDir>/notify/`. `HERDR_JEV_NOTIFY=0`, `false` or `off` disables the command.
- **`--dry-run`**: returns `{sent: false, dryRun: true, wouldSend: [...]}` without notifying, running the hook or writing state.
- **`--json`** prints the result object: `sent`, `channels`, plus `skippedReason`, `dryRun`, `wouldSend` or `escalation` when applicable.
- **Escalation flag**: with `HERDR_JEV_ESCALATE_BLOCKED=1`, a call with `--jev-state blocked`, `--reason-confidence` of at least 0.85, `--native-status` of `idle`, `done` or `unknown` and a known `--agent` runs `herdr pane report-agent` and then checks `herdr agent get`. Only a pane that really reads `blocked` is recorded and reported as `escalation: "applied"`; otherwise the result says `escalation: "ineffective"` and nothing is recorded. **Limitation**: with Herdr 0.9.0, escalation has no effect on natively detected agents such as `claude`, `codex` and `agy`, because Herdr's own detection keeps authority over their status. The supported way to be alerted outside the machine is `HERDR_JEV_NOTIFY_HOOK`.
- **Releasing**: `--release --pane <id>` releases one recorded escalation (`skippedReason: "no escalation"` when none exists), `--release-stale` releases those older than 15 minutes and `--release-all` releases all of them. A release that fails three times drops the record.

### classify-pane

`herdr-jev classify-pane --json` reads one JSON object from stdin and classifies the terminal text with Jev. The pane text is redacted before it is sent. Without `--json` nothing is printed.

```sh
echo '{"paneText":"Allow this command? (y/n)","agent":"codex","status":"working"}' | herdr-jev classify-pane --json
```

The output is one flat JSON object, with no nesting:

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

`attention` is derived from `attentionScore`: below 0.5 is `none`, below 1.5 is `soon`, otherwise `now`. See [docs/jev-office.md](docs/jev-office.md) for how the Office uses it.

### review

```sh
herdr-jev review [--scopes "name=path1,path2;name2=path3"] [--timeout-ms <ms>] [--verify-command-json <path>] [--base <ref>]
  [--client <client>] [--cwd <path>] [--session <id>] [--model <id>] [--available-models <ids>]
  [--council] [--council-members <list>] [--council-timeout <ms>] [--council-wait <ms>] [--json]
```

`--council`, `--council-members`, `--council-timeout` and `--council-wait` add the advisory review council described under [Review council](#review-council). The council never changes the printed status or the exit code. Using it sends the diff to the provider of each selected CLI and the finding text to TypeSafe.

Runs the Harness review gate on the current repository:

1. `ai-harness review-verify` with the repository test command (the `test` script of `package.json` through the package manager of the lock file, `bun test` for a plain `bun test` script; `--verify-command-json` overrides it with a JSON argv file), declaring the scopes.
2. One `ai-harness review-judge --scope <name>` per scope, at most four at a time. The judge is the read-only reviewer command of the delegation profile for the client (model and read-only arguments from the model catalog; without a profile, the reviewer model of the local matrix). The reviewer is always taken from the profile that the Harness returns for the advisor role of the current client and model (`delegation-plan --role reviewer` answers `child_role`, which has no profile), and the report shows the CLI model that is launched. The prompt names the review focus (correctness, error handling, security, races and fallbacks), lists only the files of that scope, states which of them changed since the base with their changed line ranges (hunk headers of `git diff -U0`, at most 20 per file), and ends with the `REVIEW_GATE_VERDICT: APPROVE` or `REVIEW_GATE_VERDICT: CHANGES_REQUIRED` rule. `--timeout-ms` (default 600000, from 1000 to 1800000) bounds each judge.
3. `ai-harness review-findings`, whose status is the status printed.

Without `--scopes`, up to four scopes are derived from the files changed against the default branch (`origin/HEAD`, `main` or `master`) plus untracked files, grouped by top-level directory; when there are more than four directories the smallest are merged into `other`. A declared scope covers the changed files under its paths, or the declared paths themselves when nothing changed there; the prompt then asks the reviewer to read those files in full as they are. Changed files that no declared scope covers go to an automatic `uncovered` scope (`uncovered-2` and so on when the name is taken) that is judged like the others, so the command never reports `ready` while a changed file was left unjudged. A scope of more than 200 files, or whose prompt would pass about 100 KB, is split into `<name>-p1`, `<name>-p2` and so on, so that no prompt comes near the 128 KiB limit of one command line argument (at most 32 scopes in all; a Harness without scope support refuses what does not fit in one prompt with `too_many_files_without_scopes`, after merging overlapping scopes without repeating a file; a prompt that still exceeds 120 KB fails with `prompt_too_large` before any Harness call). File names are written in the prompt as JSON strings and a name with control characters is refused (`unsafe_file_name`). Deleted files are listed apart as no longer present. The prompt names the base branch together with its merge base commit. Files that look like secrets (`.env`, private keys, `credentials` or `secrets` data files) are refused when they are untracked, staged or modified (`sensitive_uncommitted_files`, until they are ignored or removed) and when they were committed since the base and still exist (`sensitive_committed_files`, until they are removed from the commits under review or a later `--base` is chosen); committing an uncommitted secret is not a remedy. Source files such as `secrets.ts` are not affected. A declared path that matches no changed file and does not exist fails with `invalid_scopes`, and `.` stands for the whole repository. Paths are always relative to the repository root, also with `--cwd` on a subdirectory.

`--base <ref>` replaces the default branch: the changed files are those of `git diff --name-only <ref>...HEAD`, the working tree against `HEAD` and untracked files, and the line ranges come from the diff of the merge base with the working tree (a diff above 16 MB drops the line ranges and keeps the file list). Use it for work that is already merged, where the default branch shows no difference. An unknown ref fails with `invalid_base`, a ref that shares no history with `HEAD` with `no_merge_base`, a directory outside a repository with `not_a_git_repository` and any failed git call with `git_failed`, all before any Harness call. Interrupting the command (Ctrl-C, `SIGTERM`, `SIGHUP`) stops the verification and judge process groups and removes their command files. A failure inside the command while judges run stops the judges that are still running and surfaces the original error; a failure to remove the command files never replaces the report or that error.

When `review-verify` answers anything but `pending_review`, no judge runs and the report prints why: the `verification` status and output stored by `review-findings` (redacted and capped by the Harness, and capped again at 4000 characters here), or, when the Harness returns none, that the check command failed with the command to rerun by hand. The text report also prints every scope verdict with its reason and stored findings; `--json` keeps the full object.

A scope the Harness reports as `pending` with reason `timeout` is judged once more on the same snapshot, without a new `review-verify`; the report lists it under `retried` and a scope that stays pending is printed with its reason (`timeout` or `no_verdict`). The command never fabricates a verdict. The printed status is the Harness status (`ready`, `changes_required`, `pending_review`); it is `unavailable` when the Harness cannot answer. The exit code is 0 only for `ready`. A Harness without scope support gets a single `default` scope. Command files are written with mode 0600 under `<stateDir>/review/<session>/`, one `judge-<index>.json` per scope in report order, never in the repository, and removed when the command ends. A `review-findings` answer whose shape is not valid (a non-array `scopes`, a null item, a non-string name, verdict or status) is treated as unavailable: the report keeps the judges and takes the status from `review-status`. A scope option error (`unknown_option:--scopes`) is the only thing taken as a Harness without scope support; other scope errors are reported as they are. Text the Harness returns is printed without terminal control sequences. A Harness call that times out is killed with the processes it started.

### prove

```sh
herdr-jev prove [--base <ref>] [--test-command-json <path>] [--setup-command-json <path>] [--test-file <path>]... [--timeout <ms>] [--json]
```

Shows that the tests changed by a diff fail without the source change and pass with it. The change set is the working tree and untracked files against `HEAD`, or against the merge base of `--base <ref>` and `HEAD`. Changed files under `tests/`, `test/`, `__tests__/` or `spec/`, or named `*.test.*`, `*.spec.*`, `*_test.*` or `test_*.py`, are the tests; `--test-file` (repeatable) adds more; the path is taken relative to the directory you run from, then relative to the repository root, and must be a file that changed, otherwise the run ends with `test_file_not_in_change_set`. Every other changed file is source. Every tracked path of the diff is kept, including tracked files under a `node_modules/` directory. Untracked paths under any `node_modules/`, untracked nested repositories and `.git` entries are left out and listed as `skippedPaths` (with `skippedCount`) in the report.

The command does not revert anything in your working tree. It makes a throwaway standalone copy under `<stateDir>/prove/`: `git clone --shared --no-checkout --template=` of the repository, a forced detached checkout of the base commit, removal of the `origin` remote, then a fetch of the local branches and remote-tracking branches into the copy. Git commands run in the copy act on the copy's own git directory, so `git config`, `git stash`, `git tag`, `git update-ref`, `core.hooksPath` changes and similar commands change only the copy; objects are read from the original through `.git/objects/info/alternates`. The copy is not a sandbox: the commands keep your file rights and can reach the original repository by path (for example `git -C <path>`), so run only commands you trust. There is no temporary branch and no registered worktree. Git hooks are disabled for every Git call of the command, and inherited `GIT_INDEX_FILE`, `GIT_DIR`, `GIT_WORK_TREE`, `GIT_PREFIX`, `GIT_COMMON_DIR` and `GIT_OBJECT_DIRECTORY` are removed from every Git call and from the commands. The command applies only the test files and runs the test command, which must fail, then applies the source files and runs it again, which must pass. Files are written only inside the copy, never through a symlink that leaves it. The copy is deleted on every outcome, including timeout, error and interruption (the process group of each command is killed on timeout and when the command ends). Each run that creates a copy first sweeps the copies left by killed runs (a run that ends as `no_tests` or before the copy does not sweep). A copy is swept when it is older than the longer of 2 hours and 3 times the timeout recorded for it and the run that created it is no longer alive (its recorded process id and start time). The recorded command is killed only when its process id is above 1, belongs to your user, leads its own process group and has its current directory inside that copy; on a platform without `/proc` the copy is deleted and nothing is killed. Metadata files that are not yours or that others can write are ignored, and the state directory is created with mode 0700.

What differs from your checkout for a test that shells out to Git: the copy has no `origin` remote (so no remote URL), repository-local configuration such as `user.name`, `user.email`, `core.autocrlf` and filters is not inherited, and nothing is known about LFS, sparse checkout or git-crypt (untested). A partial clone as the source is refused with `partial_clone_unsupported`. A diff that changes a submodule commit pointer is refused with `submodule_change_unsupported`. Submodule working trees are empty in the copy. Ignored files, such as build output and `.env`, do not exist in the copy.

The test command is a JSON argv array from `--test-command-json`, or the repository test command that `review` detects, which then runs at the repository root of the copy even when you start in a subdirectory. Without `--setup-command-json`, the `node_modules` of the repository root is symlinked into the copy when it exists, so a test command that writes under `node_modules/` changes the real directory, and a tracked file changed under that root `node_modules/` ends the run with `tracked_file_under_linked_node_modules` (use `--setup-command-json` to get a `node_modules` of its own). With it, the command runs once in the copy, at the base commit, before the first test run, and no link is made. `--timeout` (default 600000) bounds each command and the creation of the copy. Verdicts: `proven`, `not_proven` (the tests pass without the source change), `broken` (they fail with the full change), `no_tests` (no changed test file, nothing is run) and `error` (setup problem, timeout, a command killed by a signal, or interruption, with a reason). The report has both exit codes, the signal if any, durations and a bounded tail of each output, and the exit code is 0 only for `proven`.

Limits of the proof:

- Any non-zero exit counts as red, including a compile error or a missing import of a module that only the source change adds.
- The verdict is about the command, not about whether the changed test files ran. With a whole-suite command, an unrelated test that the diff happens to fix also yields `proven`, and a vacuous test that only imports a new module is `proven`. Pass a command that runs just the changed tests when that matters.
- The setup command runs once, at the base commit, and is not repeated after the source files are applied, so dependencies added by the diff are not installed for the second run.
- Only the root `node_modules` is linked. Workspace packages with their own `node_modules`, such as a pnpm monorepo, need `--setup-command-json`.
- The directory you run from must exist at the base commit when a setup command is used.
- Untracked files under `node_modules/` are not copied even when they are not ignored; tracked ones are.

### Models, quota and companions

| Command | Purpose |
| :--- | :--- |
| `models list` | Configured models, active overrides and fallback cascades per client. |
| `models set <client>.<role> <model>` | Saves an override in `~/.config/herdr/herdr-jev-models.json`. |
| `models classify <client> <model>` | Classifies a new model with Jev: role, tier, effort and whether it becomes primary or a fallback. |
| `models scan [client]` | Lists the registered models per client. |
| `models catalog [client]` | Prints the model catalog answered by `ai-harness model-catalog`: CLI ids, aliases, efforts, `bypass_args` and `readonly_args`. When the Harness cannot answer it prints `{available: false, reason, fallback}` and exits with code 1. A client name that is neither a base client nor a configured alias prints `{error: "unknown_client", client, known}` on stderr and exits with code 1. |
| `quota status` | Prints the Herdr Agent Usage snapshot as JSON, then the manual circuit breakers with their time remaining. |
| `quota exhaust <client> <model> [-m, --minutes <n>]` | Marks a model as exhausted (default 120 minutes) so work cascades to the next model. |
| `quota reset [client]` | Clears the breakers of one client, or of all clients. |
| `studio`, `effort`, `sessions`, `pending` | Studio layout, live Codex effort, session picker and pending work. See [docs/companions.md](docs/companions.md). |
| `mcp` | Starts the MCP stdio server. Tools: `herdr_triage`, `herdr_plan`, `herdr_spawn_subagent`, `herdr_peer_message`, `herdr_peer_read`, `herdr_clink`, `herdr_consensus`, `herdr_decide`, `herdr_gate`, `herdr_execution_guard`, `herdr_verify_contract` and `herdr_fit_check`. |

---

## Pre-flight Turn Routing & Resilient Engine (`route-turn`)

Herdr-Jev incorporates an ultra-fast turn router inspired by empirical benchmarks from `jev-harness-router`. In **~330ms**, a single call evaluates 4 decisions before the agent turn begins:

| Decision | How It Is Evaluated |
| :--- | :--- |
| **Model Tier** | Derived in code via `scoreQuantile(probabilities, 0.60)` over difficulty situations, with floor on broad scope. |
| **Effort Budget** | Derived from the same difficulty quantile (`low`, `medium`, `high`, `xhigh`). |
| **Tools Offered** | Absolute Noul bar for `write`/`execute` tools (`Bash`, `Edit`, `Write`); `read` tools admitted from ranking tail ($p \ge 0.25$). |
| **Skill Suggested** | Ranked choice over catalog, gated by the 4 request-shape Nouls (including `produces_artifact`). |

### Key Architectural Safeguards

1. **Socket-Preserving Deadline (No TLS Teardown)**:
   A strict local deadline timer (`Promise.race`) returns fallback in 0ms if the deadline passes, **without aborting** the background fetch. This keeps HTTP keep-alive / TLS connections alive in the pool and avoids alternating fallback loops. Late responses are stored in the LRU cache.
2. **Quantile Leaning (Anti-Underprovisioning)**:
   Instead of taking the mean/expectation of difficulty scores (which misclassifies bimodal tasks like architectural ADRs as trivial), Herdr-Jev reads the **0.60 quantile**, dropping model under-provisioning from 31.5% to 1.9%.
3. **The 4th Gate (`produces_artifact`)**:
   Standard action gates (`acts_on_system`, `follows_procedure`, `prose_suffices`) accidentally suppress advisory tasks like architecture specs or code review. The addition of `produces_artifact` opens the gate for structured outputs, achieving 94.4% skill routing accuracy.
4. **Prefix Cache Preservation**:
   Dynamic skill hints are appended via `<skill_relevance>` strictly **after** the system prompt cache breakpoint (`systemPromptParts`), ensuring downstream LLM providers (Anthropic, OpenAI, Gemini) never bust prefix cache.
5. **Double Handshake Prewarming**:
   Run `herdr-jev prewarm` or let the router warm up on startup to eliminate the ~1,150ms cold process handshake down to ~275-340ms.

---

## Client Model Matrix & Fallback Cascades

| Client | Advisor Role | Implementer Role | Reviewer Role | Quota Fallback Cascade (Level 1) |
| :--- | :--- | :--- | :--- | :--- |
| **Claude Code** | `fable-5` | `sonnet-5` (1M tokens) | `opus-5` | `fable-5` -> `claude-sonnet-5` -> `opus-5` |
| **Codex CLI** | `astra` | `gpt-5.6-luna` (XHIGH) | `gpt-5.6-sol` (XHIGH) | `gpt-5.6-luna` -> `gpt-5.6-terra` |
| **AntiGravity** | `claude-opus-4-6` | `gemini-3-8-flash` (High) | `claude-opus-4-6` | `gemini-3-8-flash` -> `gemini-3-8-pro` -> `claude-sonnet-4-6` |
| **Cursor** | `cursor-smart` | `cursor-fast` | `cursor-smart` | `cursor-fast` -> `cursor-smart` |
| **OpenCode** | `opencode-primary` | `opencode-primary` | `opencode-primary` | `opencode-primary` |

---

## Subagent Execution & Cross-Harness Delegation

Herdr-Jev provides complete flexibility for delegating tasks and running subagents:

### 1. Split Pane vs Native Harness Mode
* **Split Pane Mode (`--split`, `HERDR_JEV_SPLIT_SUBAGENTS=1`)**:
  Spawns the subagent in a dedicated Herdr pane. The default `--direction auto` tiles workers as a balanced grid in the caller's central region. With `HERDR_JEV_LAYOUT=role` the orientation follows the role:
  * `researcher` and `implementer`: Vertical split to the `right` for side-by-side editing and parallel research.
  * `reviewer`: Horizontal split `down` for reviewing diffs, test logs, and linting output.
  * Manual override is supported via `--direction right` or `--direction down`.
* **Native Harness Mode (`--no-split`, `HERDR_JEV_SPLIT_SUBAGENTS=0`)**:
  Executes the subagent directly in the current terminal session using native harness mechanics. The subagent's tool calls, thoughts, and progress appear live on screen in real time without needing `-p`.

#### Mode Comparison Matrix

| Capability / Attribute | Native Harness Inline Mode (`--no-split`) | Herdr Split Pane Mode (`--split`) |
| :--- | :--- | :--- |
| **Execution Context** | Current active terminal session | Dedicated Herdr multiplexer split pane |
| **Live Progress Visibility** | Live tool calls and outputs in terminal | Full dedicated terminal UI with isolated scrollback |
| **Session Control** | Foreground CLI execution | Independent pane with background lifecycle |
| **Layout Orientation** | Inline current window buffer | Balanced grid by default; `right` or `down` on request or with `HERDR_JEV_LAYOUT=role` |
| **Resource Footprint** | Zero additional terminal allocation | Lightweight multiplexer pane allocation |
| **Recommended Scope** | Quick searches, direct tasks, standalone CLIs | Deep research, long refactors, multi-pane Triad |

### 2. Cross-Harness Delegation & Quota Cascade
Herdr-Jev allows one client or harness to delegate work to another peer client, configured via `HERDR_JEV_CROSS_HARNESS`:
* **Inactive / Disabled (unset, empty, `0` / `false` / `off` / `none` / `disabled`)**:
  Clients only delegate to themselves (e.g. Claude only spawns Claude, Codex only spawns Codex). `subagent` is the exception: with the variable unset it behaves as `auto`.
* **Auto / Jev Decides (`1` / `true` / `on` / `auto`)**:
  Jev System One evaluates each role's cognitive requirements and delegates across harnesses dynamically:
  * `advisor`: Claude (`fable-5` or `opus-5`)
  * `implementer`: Codex (`gpt-5.6-luna` XHIGH)
  * `reviewer`: AntiGravity (`claude-opus-4-6`) or Codex (`gpt-5.6-sol` XHIGH)
  * `researcher`: AntiGravity (`gemini-3-8-flash`)
* **Universal Peer Array (Ordered Priority)**:
  Configure an ordered list of peers that any active harness can delegate to:
  ```bash
  export HERDR_JEV_CROSS_HARNESS="codex,antigravity"
  # or as JSON array:
  export HERDR_JEV_CROSS_HARNESS='["codex","antigravity"]'
  ```
* **Directional Peer Mapping**:
  Configure specific delegation allowances per source harness:
  ```bash
  # Claude can delegate to Codex and AntiGravity; Codex can delegate to Claude
  export HERDR_JEV_CROSS_HARNESS="claude:codex,antigravity;codex:claude"
  ```

#### Quota-Safe Cascade Guarantee
When delegating work across harnesses (e.g. attempting to offload tasks to cheaper or faster models), if the target peer runs out of quota (circuit breaker tripped or all models in its chain exhausted):
1. **Cascade to Next Peer**: Herdr-Jev checks the remaining peers in the configured array in order of priority and delegates to the first healthy peer.
2. **Safe Fallback to Source**: If all peer quotas are exhausted, Herdr-Jev automatically returns to the current host harness (`sourceClient`).
This guarantees that delegating across harnesses never fails or disrupts the main execution due to quota limits.

### 3. Custom Client Aliases & Wrappers (claude-px, fcc-claude)
Herdr-Jev allows you to use any custom alias or executable wrapper for your clients (such as proxy wrappers or custom CLI distributions):
* **Automatic Base Detection**: Names containing `claude` (e.g. `claude-px`, `fcc-claude`) automatically inherit Claude model configurations and flag conventions. Names containing `codex` inherit Codex conventions, etc.
* **Explicit Alias Mapping**:
  ```bash
  # Map custom aliases via JSON
  export HERDR_JEV_ALIASES='{"claude-px":"claude","fcc-claude":"claude"}'
  # Or via individual environment variables
  export HERDR_JEV_ALIAS_CLAUDE_PX=claude
  export HERDR_JEV_ALIAS_FCC_CLAUDE=claude
  ```
* **Custom Binary Executable**: By default, an alias like `claude-px` or `fcc-claude` invokes that command directly on your PATH. You can also explicitly override any client binary via `HERDR_JEV_CLAUDE_BIN="fcc-claude"` or `HERDR_JEV_BIN_CLAUDE_PX="claude-px"`.
* **Full Peering Support**: Custom aliases can be passed directly to `--client`, `--target`, or inside `HERDR_JEV_CROSS_HARNESS="fcc-claude,antigravity"`.

### 4. Cross-Harness Workflow: Claude Fable 5 -> AntiGravity Gemini 3.8 Flash High
A powerful cost-optimization pattern is running Claude Fable 5 for architectural planning and auto-orchestrating implementation to Gemini 3.8 Flash High:
```bash
# Configure Claude to delegate implementation to AntiGravity
export HERDR_JEV_CROSS_HARNESS="antigravity"

# Route or plan a task
herdr-jev plan "Implement payment webhook listener" --client claude
```
Execution flow with 2-level quota resilience:
1. **Advisor Stage**: Claude runs `fable-5` for system design.
2. **Implementer Stage**: Auto-orchestrated to AntiGravity running `gemini-3-8-flash` at High reasoning effort.
3. **Level 1 Fallback (Intra-Client)**: If Gemini Flash exhausts its quota, Herdr-Jev automatically cascades to `gemini-3-8-pro`. If that exhausts, it cascades to `claude-sonnet-4-6`.
4. **Level 2 Fallback (Cross-Harness)**: If all AntiGravity models are exhausted, Herdr-Jev safely returns to the host harness (`claude` with `sonnet-5`).

---

## Dynamic Models & Quota Cascade

### 1. Handling Newly Released Models

When AI providers release newer model versions, no code edits or recompilations are needed:

* **Via CLI Override**:
  ```bash
  # Update Claude Advisor to a newer release
  herdr-jev models set claude.advisor fable-6

  # Update Codex Advisor to a newly launched model
  herdr-jev models set codex.advisor lamodelonueva
  ```
* **Via Environment Variables (Highest Precedence)**:
  ```bash
  export HERDR_JEV_CLAUDE_ADVISOR="fable-6"
  export HERDR_JEV_CODEX_ADVISOR="lamodelonueva"
  ```
* **Via Configuration Files**:
  Edit `~/.config/herdr/herdr-jev-models.json` or the default [`config/models.json`](config/models.json).

### 2. AntiGravity Quota Exhaustion (Fallback Cascades)

In **AntiGravity**, rate limits and quotas are tracked per model family. Herdr-Jev features an **automated fallback cascade**:

* **Advisor Cascade**: `claude-opus-4-6` -> `gemini-3-8-pro` -> `gemini-3-8-flash`
* **Implementer Cascade**: `gemini-3-8-flash` -> `gemini-3-8-pro` -> `claude-sonnet-4-6`

When a model exhausts its quota or hits HTTP 429:
```bash
# Mark a model as exhausted for 120 minutes
herdr-jev quota exhaust antigravity claude-opus-4-6 --minutes 120

# Check active quota circuit breakers and time remaining
herdr-jev quota status

# Reset circuit breakers once quotas replenish
herdr-jev quota reset antigravity
```
Subsequent tasks automatically cascade to the next healthy model in the chain without interrupting operations.

### 3. Intelligent Model Auto-Classification via `/models`

Instead of manually assigning roles to new models, TypeSafe Jev evaluates them automatically:

* **Inside Herdr**:
  Trigger the global action `/models` (or `Jev: Models (/models)`) to open the interactive overlay pane. It lists active chains and prompts for newly released model names.
* **Via CLI**:
  ```bash
  # Auto-classify any new model name with TypeSafe Jev
  herdr-jev models classify codex lamodelonueva

  # Scan known vs registered models across all clients
  herdr-jev models scan
  ```

Jev analyzes naming patterns and provider conventions to determine:
* Optimal Role: `advisor`, `implementer`, `reviewer`, or `researcher`.
* Capability Tier: `frontier`, `workhorse`, or `lightweight`.
* Default Reasoning Effort: `standard`, `high`, or `xhigh`.
* Placement Decision: whether to promote to **new primary default** or add as a **fallback option**.

---

## Jev Office

The Jev Office draws every agent as a person at a desk, grouped by workspace and tab, with state, branch, uncommitted changes, model, weekly quota and run summary. Open it from the Command Palette (**Jev: Office view**) or run it standalone:

```sh
node herdr-plugin/office/office.mjs
node herdr-plugin/office/office.mjs --demo
node herdr-plugin/office/office.mjs --once --demo
```

| Flag | Effect |
| :--- | :--- |
| `--demo` | Fake roster and fake swarm data; no Herdr server and no Jev calls. |
| `--once` | Renders one frame and exits. |
| `--quiet` | No toast when an agent starts waiting for you. |
| `--no-title` | Leaves the window title alone. |
| `--no-graphics` | Text only, no pixel charts. |
| `--no-git` | Never runs `git` in the agents' checkouts. |
| `--no-context` | Does not read how full each agent's context window is. |
| `--follow` | Starts in follow mode (see `F` below). |
| `--zoom=cubicle\|auto\|list` | Opens at that zoom level; an unknown value falls back to `auto`. |

### Hotkeys

| Key | Action |
| :--- | :--- |
| `arrows`, `hjkl`, `tab` | Move between desks. |
| `enter`, `space` | Inspect the selected agent's task. On the empty desk it hires; on a desk with subagents it opens the swarm panel. |
| `y`, `n` | Approve or deny the request of a blocked agent. |
| `Y` | Arm a standing "always allow" grant when the screen offers one. `enter` confirms and `esc` cancels. |
| `s` | Answer a blocked agent in words. |
| `a` | Give the selected agent a job. |
| `A` | Standup: send one job to every agent that is free, after a review of who gets it. |
| `+` | Open the hire menu. There `hjkl` picks an agent, `enter` hires, `w` hires into a new worktree, `e` names the branch, `t` drops the worktree and `esc` cancels. |
| `w` | Open the swarm panel when the desk has subagents; otherwise cycle the scope between tab, workspace and all workspaces. |
| `W` | Cycle the scope even when the desk has subagents. |
| `b` | Jump to the next raised hand (blocked agent). |
| `F` | Follow raised hands, or stop following. |
| `z` | Cycle zoom: floor plan, list view, one desk. |
| `/` | Filter the floor; `esc` shows everyone again. |
| `f` | Jump to the selected agent's pane. |
| `r` | Refresh. |
| `q` | Leave. |
| `esc` | Close the open panel, field or filter. |

The mouse selects desks, and dragging a desk onto another swaps their panes.

### Swarm panel

Subagents launched by Herdr-Jev are tracked per caller pane. The swarm view drops a tracked worker as dead (and settles its run as `closed`) only when the live pane list or the layout of the caller tab is non-empty and contains the caller pane; an empty, unrecognised or caller-less answer means unknown and changes nothing, and a tab worker is never judged from the layout of the caller tab. A desk with subagents shows a badge next to its name: `<n>s` for the count, followed by `<k>!` when `k` of them are blocked. The swarm panel lists each subagent with its slot, state, handle, `client/model`, branch, `+commits ~uncommitted` and run summary.

| Key | Action |
| :--- | :--- |
| `1` to `9` | Focus the subagent in that slot. |
| `c` | Ask for the plan to close idle and done subagents (the same plan as `herdr-jev workers close --all-idle`), then `y` confirms and `n` or `esc` cancels. |
| `esc`, `w` | Close the panel. |

### Jev classification markers

With Jev classification on (the default; `HERDR_JEV_OFFICE_JEV=0` turns it off, and `--demo` never uses it), the Office sends the recent pane text of each desk to `herdr-jev classify-pane --json` and overlays the answer on the desk:

- The Jev state replaces the native state color and label when its confidence is at least 0.7 and it is not `unknown`.
- A bold amber `!` after the name means attention `now`. A dim `·` means attention `soon` on an idle or done agent.
- The monitor of a working desk shows the classified activity (`testing`, `editing`, `reading`, `running`, `planning`, `error`, `approval?` for `waiting_approval`, `answer?` for `waiting_answer`) when its confidence is at least 0.45. The detail card spells it out.
- Model, weekly quota, role and run summary come from `herdr-jev overview --json`, polled every three seconds with a `HERDR_JEV_TIMEOUT_MS` timeout.

A classification that fails or takes longer than three seconds falls back to the native heuristics. Cost is bounded: answers are cached by the last 30 cleaned lines plus the native status (200 entries), a working desk is classified at most once a minute, a non-working desk only after its text is stable for two ticks, and the whole Office makes at most 20 calls a minute, which is at most 1,200 an hour.

### Empty and disconnected states

- **Disconnected**: if the Herdr socket cannot be reached when the Office starts, it prints `herdr-office: cannot reach the Herdr socket at <path>` with the error and the hint `Is the server running? Try: herdr status`, then exits with code 1. `--demo` needs no socket.
- **No agents**: the floor shows an empty desk labeled `nobody here yet`; pressing `enter` or `+` there hires. A pane too small for a desk shows `An empty office. Eerie.` and `Press + to hire, or start an agent in a Herdr pane.`
- **Filter with no match**: `Nobody here matches "<filter>".` and `esc shows everyone again.`

---

## Council synthesis

`src/council/synth.ts` merges the findings of several review CLIs into agreements, disagreements, unique findings and notes, scored with TypeSafe Jev in two rounds. `src/council/format.ts` renders the result as plain text that opens with the evidence rule: each finding is a candidate, not a fact.

Finding text is redacted by `src/council/text.ts` before it reaches Jev or the formatted text. The redactor replaces credential values only: known token prefixes, JWTs, PEM blocks, URL userinfo, `Basic` and `Bearer` credentials, values assigned to secret-named keys or flags, and long hex or mixed-case alphanumeric runs. Paths only get the token-prefix shapes, so names like `src/auth/token.ts:42` are untouched.

Accepted residuals, which the redactor does not remove:

- short lowercase values such as `password: hunter2`
- a bare AWS secret access key in prose
- a Slack webhook path
- bare alphanumeric runs that look like words, including all-lowercase runs and UUIDs
- a token split by a space or a newline
- letters-only unquoted values of any length, such as `DB_PASSWORD=SuperSecretPassword`
- `mysql -p<password>` with the password attached to the flag
- a Bearer token under 16 characters or without a digit
- a URL password that contains `@`
- keys longer than 80 characters
- letters-and-dots values such as `token=abc.def.ghi`
- quoted literals passed as call arguments, such as `client.login("admin", "<pw>")`, `os.getenv("X", "<pw>")` and `define('X', '<pw>')`
- "the password is <pw>" in prose
- `curl -u user:<pw>` and `sshpass -p <pw>`
- `Authorization: Token <t>`
- an Azure SAS `sig=` value
- values that start with `./` or `~/`

A quoted literal after `||` or `??` is redacted when the assignment target is secret-named, as in `const password = process.env.DB_PASSWORD || "<pw>"`. The literal survives after a call (`getenv("X") || "<pw>"`), in a chained fallback (`a || b || "<pw>"`) and after a parenthesised expression (`(a) || "<pw>"`). Title, detail and path are cut to 2,000, 4,000 and 500 characters before redaction.

## Testing

```sh
bun test
bun run typecheck
bun run smoke
```

- **`bun test`** runs `tests/*.test.ts`. The Harness integration is tested against a fake `ai-harness` written to the OS temp dir by `tests/fake-harness.ts` (modes `contract`, `unknown` and `legacy`), so both the integrated path and every fallback run without the real Harness. `bunfig.toml` preloads `tests/preload.ts`, which sets `HERDR_JEV_TEST_GUARD=1` and `AI_HARNESS_TEST_GUARD=1` (so the Harness itself refuses to write to its default state) and points `HERDR_JEV_STATE_DIR` and `HERDR_JEV_CONFIG_DIR` at fresh directories in the OS temp dir (replacing any value from the environment) so no test writes to the real state or configuration. `tests/config-isolation.test.ts` runs the configuration-writing suites in a child process with a temporary `HOME` and fails if the listing or modification times of its `~/.config/herdr` change.
- **The test guard** keeps the suite from touching a real Herdr or launching a real agent:
  - `herdr` commands are refused with `blocked_by_test_guard` (exit code 126) unless they are read-only (`agent` or `pane` with `get`, `list`, `read`, `layout` or `current`) or the executable lives under the OS temp dir, which is where tests place their fake `herdr`.
  - Inline and captured agent runs are refused the same way unless the binary is under the temp dir.
  - `runStandup` throws `standup_requires_injected_deps_in_tests` unless the test injects its own sender, and `notify` does not run a hook that lives outside the temp dir.
  - Tests use fakes from `tests/helpers.ts` and the files in `tests/fixtures/`. They never call the TypeSafe API or start a real model.
- **`bun run typecheck`** runs `tsc --noEmit`.
- **`bun run smoke`** runs `scripts/smoke.sh`: a read-only suite against the checkout CLI and the running Herdr, with a temporary `HERDR_JEV_STATE_DIR`. Each check prints `ok`, `skip` or `FAIL`; the script exits with code 1 if any check fails. Checks that need Herdr are skipped when it is unreachable. `SMOKE_LIVE_JEV=1` adds a live `classify-pane` check and `SMOKE_LIVE_NOTIFY=1` adds a live notification, which sends a real one. See [docs/smoke.md](docs/smoke.md). Run it before merging anything that touches CLI contracts.

---

## Review council

`src/council` reviews one diff with several external CLIs (codex, kimi, agy) in parallel. Each member runs in its own review directory under `<state dir>/council`, never in your working tree.

**Commands**
- `herdr-jev council [--client <client>] [--council-members codex,kimi,antigravity] [--base <ref>] [--question <text>] [--timeout <ms>] [--json]` runs the council on the current repository, groups the findings and prints the summary (or `{ run, summary, notes }` with `--json`). Without `--base` it reviews the working tree against `HEAD`. It exits 0 when the council ran, whatever it found, and 2 when it did not run (fewer than two members, empty diff, cancelled, invalid option).
- `herdr-jev review --council [--council-members ...] [--council-timeout <ms>] [--council-wait <ms>]` runs the review exactly as before and also runs the council on the same base, in parallel. The council text is appended under its own heading and the JSON report gains a `council` field. It is advisory: it never changes the review `status`, the exit code (an interrupt still exits 128 plus the signal number) or anything recorded in the Harness, and a council failure appears as a note. `--council-timeout` bounds each member (default 8 minutes). `--council-wait` (default 60000) is how long to wait for the council after the review has settled; when it elapses the council is cancelled, the note reads `cancelled (review finished first)` and the review is printed at once.
- Data leaves your machine: the diff is sent to the provider of each selected CLI (codex, kimi, agy) and the finding text is sent to TypeSafe for grouping. `--json` prints findings, reasons and notes after the same redaction as the text report, so the `run` object holds redacted copies.
- `--client` names the session client, which is never a member of its own council; outside a Herdr pane it defaults to `claude`.
- The council refuses to run (`state_dir_inside_repo`) when the state directory is inside the reviewed repository and not ignored by it, because its review directories would show up as untracked files.
- Members come from the cross-harness configuration (`HERDR_JEV_CROSS_HARNESS`) for the session client, which is never a member of its own council. `--council-members` narrows that set; a requested member the configuration excludes is dropped and the output says so. With cross-harness delegation off, no council runs.
- The council runs only on the flag or the command; no triage rule starts it.

**What the review directory guarantees**
- It is built from an exported tree, not a clone and not a `git worktree`: the base commit is written out with a temporary index, sensitive files are deleted, and a fresh repository is initialised there with a single commit and the task diff applied on top. `git status` shows ` M` for tracked changes and `??` for untracked files, which is what `codex exec review --uncommitted` reads.
- Files behind a git filter (LFS, git-crypt and the like) appear in it as stored in the repository, not as checked out: the filter drivers are disabled for the export.
- It shares nothing with your repository: no alternates, no remote, no copy of your object store, no config, no hooks (`--template=` and `core.hooksPath=/dev/null`), and no path to your repository stored under `.git`. A member that runs `git stash`, `git config`, `git update-ref` or `git log -p --all` inside it changes or reads only the throwaway repository, which holds one commit without your history.
- Sensitive paths never reach it. Every changed path, tracked or not, is checked against the `SENSITIVE_FILES` patterns in `src/harness/review.ts` plus `.npmrc`, `.netrc`, `.pypirc`, `.envrc`, `.git-credentials`, `.env-*` and `*.tfvars` (case-insensitive). A match is left out of the patch and the prompt, and tracked matches are deleted from the exported tree, so they are also unreadable through git. The skipped paths come back in `CouncilRun.skippedPaths` and are counted in `CouncilRun.note`. Names such as `src/auth/credentials.ts` or `tests/secret.test.ts` are not matched. Untracked files over 5 MB are left out and reported too.
- Members start with a scrubbed environment: every variable entry that points into the repository, including through a symlink, is dropped or filtered (`PATH` keeps its other entries), and `PWD` is the review directory. Nothing is scrubbed when the repository root contains `HOME`, so a repository rooted at `HOME` leaves `HOME` and `PATH` intact. Scrubbed variable names, never values, appear in the member note.
- The directory is mode 0700 and the prompt file 0600. It is removed after every member, stale ones are swept at the start of a run, and a signal or exit handler removes the rest. Members are bounded by a timeout, by the parent's signal handlers and, when `timeout` is on PATH, by `timeout -k 1`. If the parent is killed outright, members live until the timeout plus 5 seconds, and the review directories and the lock stay behind until the next run sweeps them (after 2 hours). Without `timeout`, the run note says members are unbounded.

**What it does not guarantee**
- It is not a sandbox. A member runs with your user's file and network rights: it can read any file you can read, write outside the directory, use your credentials and reach the network, and a hostile diff can steer it to do so. Tell a member where your repository is and it can use it.
- It does not hide what the diff contains. Secrets with ordinary names, or inside a source file, are sent.

Live behaviour of kimi and agy is unvalidated until the checklist in [docs/plans/council-live-validation.md](docs/plans/council-live-validation.md) is run.

---

## Scheduling

`standup --auto` and `daily --write` are meant to run unattended. The `herdr-routines` plugin entry and the idempotency rules for the standup are in [docs/standup.md](docs/standup.md); the report formats and the `daily/` output path are in [docs/daily.md](docs/daily.md).

---

## Contingency & Reversal Plan (If TypeSafe Jev Becomes Paid or Costly)

If the TypeSafe Jev API becomes expensive or unavailable:

1. **Automatic Deterministic Local Fallback**:
   If the API key is removed or requests fail (HTTP 402, 429, or 5xx), [`src/triage/client.ts`](src/triage/client.ts) immediately engages a zero-cost local heuristic fallback with 0ms latency.
2. **Local Model Alternative (Ollama / Llama-3.3-70B / Open-Weights)**:
   The endpoint in `src/triage/client.ts` can be redirected to a local Ollama instance or any OpenAI-compatible API endpoint.
3. **Clean Deactivation**:
   To disable the plugin in Herdr at any time:
   ```bash
   herdr plugin unlink herdr-jev
   ```
---

## Persistent agent-to-agent conversations

`herdr-jev subagent "Review this design" --target claude --model sonnet --effort high --tab` opens another harness in a new tab and returns its `agentName`. Continue with `herdr-jev peer-message <agentName> "Compare the alternatives" --wait`, then `herdr-jev peer-read <agentName>`. Both turns use the same native agent session. Use `--split` for a sibling pane. Effort defaults to Jev task triage; explicit target/model/effort are preserved.

MCP agents use `herdr_spawn_subagent` with `target`, `model`, `effort`, and `layout` (`tab` by default), then `herdr_peer_message` and `herdr_peer_read` with the returned handle. Source harness and repository come from the caller pane. `layout: "captured"` explicitly requests a one-shot result. Resolve startup repository trust in the peer pane before sending work; uncertain submission must be inspected rather than automatically retried. A busy peer rejects another turn to avoid confusing responses.

Peer output is a bounded terminal snapshot with a reported `lineLimit` (default 2000), rather than a complete session transcript. Increase CLI `--lines` or MCP `lines` to inspect longer responses. Spawn and nonblocking messages acknowledge an observed working turn before returning; synchronous messages use `--wait`.

Explicit peer operations default to Jev harness selection unless `HERDR_JEV_CROSS_HARNESS` constrains it. `--target` preserves a selected harness. Peer waits default to 15 minutes; configure `--timeout-ms` or MCP `timeoutMs` up to one hour. The process adapter honors that native deadline. Jev `standard` maps to native `medium`; AntiGravity maps `xhigh` to its native `max` effort.

An explicit target that is forbidden by the selected cross-harness configuration fails before launch rather than substituting another client. CLI `--cross-harness` selects the configuration for that invocation.

Use `subagent --name <stable-handle>` or MCP `agentName` when a spawn may be retried. A retry retains an existing native handle and asks for inspection; it never resends a task or creates another tab for that handle. Unnamed spawn requests intentionally create independent peers. After an uncertain result, inspect its returned handle rather than issuing another unnamed spawn.

Named handles are single-dispatch keys. A zero-byte atomic dispatch marker is claimed before pane creation, so an uncertain create without a registered agent also prevents redispatch. Inspect the earlier tabs/panes before choosing a fresh handle; closing an agent does not automatically replay its named request. Runtime fences live beside the native OS reservation files.

Message reservations serialize Herdr-Jev callers. The native Herdr prompt API has no revision condition and accepts messages to working agents; direct native callers or manual terminal input can race the observed status check. Use Herdr-Jev for cooperating agent messages. Output is a terminal snapshot and observed peer status, rather than a turn receipt or verified work result.

Spawn metadata separates `recommendedEffort` from applied native `effort` and `effortApplied`. Codex, Claude, and AntiGravity support scalar effort flags; the recommendation remains advisory for Kimi, Cursor, and OpenCode. An explicit unsupported effort fails rather than pretending to apply it.
