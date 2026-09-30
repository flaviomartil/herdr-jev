# Herdr-Jev

Latency calibration clears cached answers before every sample while retaining the warmed connection. Peer routing reuses the installed usage collector through AI Harness: fresh Codex account exhaustion excludes Codex from automatic selection and explicit peer startup. Stale, unknown and model-scoped observations do not prove provider availability; native account/model preflight remains necessary. Other providers retain their existing quota checks.

Kiro peers use native Herdr kind `kiro` and executable `kiro-cli chat --trust-all-tools`. Authenticate with `kiro-cli login`, discover native model IDs, then supply `subagent --target kiro --model <verified-id> --tab` under an allowed peer mapping. Kiro remains unconfigured for automatic model selection until a verified role catalog exists; it never inherits a Claude model or scalar effort flag. The shared AI Harness installs the `ai-harness` Kiro agent and its MCP/skill context.

Inside Herdr, `plan` and `route` read the source pane's exact model and fresh Codex worker availability. Delegation still requires a matching AI Harness profile. Explicit `--model` overrides advisor discovery; `--available-models` overrides worker availability and may omit the observed advisor. A route without an executable profile exits unsuccessfully instead of reporting an agent launch.

`herdr-jev route "task" --tab` creates a tab; the default tiles delegated workers as a balanced grid in the caller's central region without changing focus. Use `--direction right|down` for the existing explicit split behavior, or `HERDR_JEV_LAYOUT=role` to restore role-based auto layout. `--source-pane <id>` preserves the advisor pane when routing from an overlay, and `--cwd <repository>` selects the worker repository. Stage effort is passed to both interactive and captured Codex/Claude commands.

For implementation followed by independent review, use `--wait --verify-command-json <checks.json>`, where the file contains a JSON command array such as `["bun", "test"]`. `run-resume <id> --cwd <repository> --verify-command-json <checks.json>` reconciles the existing attempt without launching uncertain work again. Resume renews observation of the same bound agent; a task withheld by a trust dialog is submitted once after the dialog is resolved. A prompt with uncertain acknowledgement is never submitted again automatically.

Jev-driven multi-model triage, calibrated turn routing, and Triad orchestration plugin for Herdr and AI-Harness.

## Canonical execution through AI Harness

`plan` and MCP `herdr_plan` expose both advisory `stages` and canonical `executionStages`. Only the latter can be launched automatically by `route`. Supply the actual advisor model and verified available model IDs; an unknown model, unavailable Harness, or missing exact profile means direct execution in the current session. `--triad` and local quota cascades do not override this decision.

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

Keybindings registered in Herdr:
- `prefix+j`: `herdr-jev.route` (Jev: Route Task)
- `prefix+J`: `herdr-jev.triad` (Jev: Full Triad Pipeline)
- `prefix+m`: `herdr-jev.models` (Jev: Models and Cascades)
- `prefix+s`: `herdr-jev.status` (Jev: Status)

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
* **No AI-Harness Required**: If `ai-harness-core` is not present, Herdr-Jev operates in standalone mode. Auto-improvement reflections are written to `./auto-improvements.jsonl` in the active project directory.
* **No Herdr Required**: When executed in regular terminal sessions, `herdr-jev plan` prints the exact CLI command strings ready to run.
* **Zero-Cost Fallback**: If `TYPESAFE_API_KEY` is omitted, tasks are triaged through a local heuristic analyzer with 0ms latency.

---

## Environment Configuration Matrix

Herdr-Jev supports fine-grained configuration via environment variables (or a `.env` file based on [`.env.example`](.env.example)):

| Variable | Allowed Values | Default | Description & Behavioral Mode |
| :--- | :--- | :--- | :--- |
| `TYPESAFE_API_KEY` | String | Vault / Local heuristic | TypeSafe Jev System One semantic triage key (~260ms response). |
| `TYPESAFE_DEFAULT_MODEL` | String | `jev-1.13.0` | Pinned TypeSafe Jev model version (avoids moving `jev-latest` alias). |
| `HERDR_JEV_DEADLINE_MS` | Number (ms) | `1000` (or calibrated) | Strict deadline for Jev queries (calibrated via `herdr-jev calibrate -w`). Deadline fallbacks use `deadline-exception`; network failures use `network-exception`. |
| `HERDR_JEV_ALLOW_ALIASES` | `0`, `1`, `false`, `true` | `0` (Strict Base) | Security gate: allows custom alias binaries (`claude-px`, `fcc-claude`). |
| `HERDR_JEV_CROSS_HARNESS` | `0`, `auto`, peer list, JSON | `0` (Self-Only) | Delegation scope: `0` (self), `auto` (Jev assigns), or priority array. |
| `HERDR_JEV_SPLIT_SUBAGENTS` | `1` (split), `0` (inline) | `1` in Herdr, `0` outside | Subagent UX: side-by-side split pane vs native inline CLI progress. |
| `HERDR_JEV_SPLIT_DIRECTION` | `auto`, `right`, `down` | `auto` | Split layout: Jev role heuristics (`right` for research, `down` for review). |
| `HERDR_JEV_LAYOUT` | `grid`, `role` | `grid` | Auto layout mode for delegated workers; `grid` balances panes, `role` restores role-based directions. |
| `AI_HARNESS_ROOT` | Filesystem path | Auto-discover | Path to `ai-harness-core` repository for auto-improvements. |
| `HERDR_BIN_PATH` | Binary name / path | `herdr` | Path to Herdr multiplexer executable in system PATH. |
| `HERDR_PLUGIN_ID` | String | `herdr-jev` | Registered plugin ID inside Herdr runtime. |
| `HERDR_JEV_<CLIENT>_<ROLE>` | Model name string | `config/models.json` | Dynamic model override (e.g. `HERDR_JEV_CLAUDE_ADVISOR=fable-6`). |

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
  Spawns the subagent in a dedicated Herdr pane. By default, Jev automatically decides the split orientation (`auto`):
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
| **Layout Orientation** | Inline current window buffer | Automatic: `right` for research, `down` for review |
| **Resource Footprint** | Zero additional terminal allocation | Lightweight multiplexer pane allocation |
| **Recommended Scope** | Quick searches, direct tasks, standalone CLIs | Deep research, long refactors, multi-pane Triad |

### 2. Cross-Harness Delegation & Quota Cascade
Herdr-Jev allows one client or harness to delegate work to another peer client, configured via `HERDR_JEV_CROSS_HARNESS`:
* **Inactive / Disabled (`0` / `false` / `disabled`)**:
  Clients only delegate to themselves (e.g. Claude only spawns Claude, Codex only spawns Codex).
* **Auto / Jev Decides (`1` / `true` / `auto` / `""`)**:
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
# Persistent agent-to-agent conversations

`herdr-jev subagent "Review this design" --target claude --model sonnet --effort high --tab` opens another harness in a new tab and returns its `agentName`. Continue with `herdr-jev peer-message <agentName> "Compare the alternatives" --wait`, then `herdr-jev peer-read <agentName>`. Both turns use the same native agent session. Use `--split` for a sibling pane. Effort defaults to Jev task triage; explicit target/model/effort are preserved.

MCP agents use `herdr_spawn_subagent` with `target`, `model`, `effort`, and `layout` (`tab` by default), then `herdr_peer_message` and `herdr_peer_read` with the returned handle. Source harness and repository come from the caller pane. `layout: "captured"` explicitly requests a one-shot result. Resolve startup repository trust in the peer pane before sending work; uncertain submission must be inspected rather than automatically retried. A busy peer rejects another turn to avoid confusing responses.

Peer output is a bounded terminal snapshot with a reported `lineLimit` (default 2000), rather than a complete session transcript. Increase CLI `--lines` or MCP `lines` to inspect longer responses. Spawn and nonblocking messages acknowledge an observed working turn before returning; synchronous messages use `--wait`.

Explicit peer operations default to Jev harness selection unless `HERDR_JEV_CROSS_HARNESS` constrains it. `--target` preserves a selected harness. Peer waits default to 15 minutes; configure `--timeout-ms` or MCP `timeoutMs` up to one hour. The process adapter honors that native deadline. Jev `standard` maps to native `medium`; AntiGravity maps `xhigh` to its native `max` effort.

An explicit target that is forbidden by the selected cross-harness configuration fails before launch rather than substituting another client. CLI `--cross-harness` selects the configuration for that invocation.

Use `subagent --name <stable-handle>` or MCP `agentName` when a spawn may be retried. A retry retains an existing native handle and asks for inspection; it never resends a task or creates another tab for that handle. Unnamed spawn requests intentionally create independent peers. After an uncertain result, inspect its returned handle rather than issuing another unnamed spawn.

Named handles are single-dispatch keys. A zero-byte atomic dispatch marker is claimed before pane creation, so an uncertain create without a registered agent also prevents redispatch. Inspect the earlier tabs/panes before choosing a fresh handle; closing an agent does not automatically replay its named request. Runtime fences live beside the native OS reservation files.

Message reservations serialize Herdr-Jev callers. The native Herdr prompt API has no revision condition and accepts messages to working agents; direct native callers or manual terminal input can race the observed status check. Use Herdr-Jev for cooperating agent messages. Output is a terminal snapshot and observed peer status, rather than a turn receipt or verified work result.

Spawn metadata separates `recommendedEffort` from applied native `effort` and `effortApplied`. Codex, Claude, and AntiGravity support scalar effort flags; the recommendation remains advisory for Kimi, Cursor, and OpenCode. An explicit unsupported effort fails rather than pretending to apply it.
