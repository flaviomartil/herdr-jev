---
name: herdr-jev
description: Jev-driven multi-model triage and triad orchestration for Herdr, Claude, Codex, and AntiGravity. Use when asked to triage tasks, route tasks to optimal models, plan triad pipelines (Advisor -> Implementer -> Reviewer), manage model quotas, or auto-classify new models.
---

# Herdr-Jev Skill

Semantic triage engine and multi-model orchestrator plugin for Herdr, Claude Code, Codex, and AntiGravity.

## Capabilities

1. **Semantic Task Triage**: Evaluates architectural complexity (`trivial`, `routine`, `moderate`, `architectural`), research necessity, and reasoning effort (`standard`, `high`, `xhigh`) via TypeSafe Jev System One or local heuristic fallback.
2. **Deterministic Delegation Matrix**:
   - **Claude Code**: Advisor (`fable-5`) -> Implementer (`sonnet-5`) -> Reviewer (`opus-5`).
   - **Codex CLI**: Advisor (`astra`) -> Implementer (`gpt-5.6-luna` XHIGH) -> Reviewer (`gpt-5.6-sol` XHIGH).
   - **AntiGravity**: Advisor (`claude-opus-4-6`) -> Implementer (`gemini-3-8-flash` High) -> Autonomous Research Subagents.
3. **Quota Cascade & Circuit Breakers**: Automatically cascades to next healthy model family when a model exhausts its quota or encounters rate limits.
4. **Herdr Pane Orchestration**: Automatically splits panes, starts native agent CLIs, and delivers handoff prompts inside Herdr.

## CLI Commands

### 1. Triage a Task
Evaluates task complexity, research needs, and reasoning effort:
```bash
herdr-jev triage "Refactor user authentication service to support OAuth2 PKCE"
herdr-jev triage "Fix typo in documentation" --json
```

### 2. Plan Execution for a Client
Generates the planned execution steps and CLI invocations:
```bash
# Preview plan for Claude
herdr-jev plan "Implement retry logic for payment webhook" --client claude

# Preview plan for Codex
herdr-jev plan "Migrate PostgreSQL schema to support multi-region tenancy" --client codex

# Force full Triad pipeline (Advisor -> Implementer -> Reviewer)
herdr-jev plan "Review code security" --client claude --triad
```

### 3. Route and Launch Stages
Inside Herdr, splits panes and launches each stage automatically:
```bash
herdr-jev route "Investigate transaction timeout in payment service" --client claude
```
Outside Herdr, prints the exact CLI commands to run in any terminal.

### 4. Spawn a Subagent (Split Pane vs Native Harness Mode)
Subagents can run either in a split pane inside Herdr, or inline in the native harness mode:
```bash
# Split-pane mode (opens a side-by-side pane in Herdr and starts the subagent)
herdr-jev subagent "Research OAuth2 refresh token expiration semantics in RFC 6749" --client claude --split

# Specify split direction (auto: Jev decides based on role, right: side-by-side, down: bottom)
herdr-jev subagent "Review pull request diff" --client codex --role reviewer --split --direction down

# Native harness mode (runs live in current terminal without opening panes, showing real-time tool calls)
herdr-jev subagent "Draft database migration for audit log table" --client codex --role implementer --no-split

# Cross-harness delegation (delegate subagent to optimal peer client)
herdr-jev subagent "Scan codebase for API secrets" --client claude --role researcher --cross-harness auto
```
Tip: Configure default behavior via `HERDR_JEV_SPLIT_SUBAGENTS=1` (split) or `0` (native inline), `HERDR_JEV_SPLIT_DIRECTION=auto`, and `HERDR_JEV_CROSS_HARNESS=auto` or peer mappings.

### 5. Dynamic Model Overrides and Classification
Inspect or update models dynamically:
```bash
# Auto-classify any newly released model using Jev
herdr-jev models classify codex lamodelonueva

# Scan all configured models and fallback chains
herdr-jev models scan

# Set a role override
herdr-jev models set claude.advisor fable-6
```

### 6. Harness & Quota Auto-Detection
Detect installed AI harnesses in PATH, probe binary health, and auto-configure peer matrix:
```bash
# Detect installed harnesses, probe binary availability, and inspect quota status
herdr-jev detect

# Probe harnesses in structured JSON format
herdr-jev detect --json

# Auto-configure .env based on healthy detected harnesses
herdr-jev detect --auto-config
```

### 7. Quota Circuit Breakers
Manage quota circuit breakers when rate limits occur:
```bash
# Mark a model as quota exhausted for 120 minutes
herdr-jev quota exhaust antigravity claude-opus-4-6 --minutes 120

# View active circuit breakers
herdr-jev quota status

# Reset circuit breakers
herdr-jev quota reset antigravity
```

### 8. Health and Environment Status
Check TypeSafe Jev connectivity, Herdr runtime, and AI-Harness bridge:
```bash
herdr-jev status
```

## Agent Guidelines

* When receiving an ambiguous or complex coding task, run `herdr-jev plan "<task>" --client <client>` to inspect recommended models and pipeline depth.
* If a task involves core architecture or cross-cutting migrations, recommend or engage the full Triad pipeline (Advisor -> Implementer -> Reviewer).
* When asked to check installed harnesses, inspect model quotas, or configure peering, run `herdr-jev detect` or `herdr-jev detect --auto-config`.
* If encountering rate limits on AntiGravity or any client, activate the quota circuit breaker using `herdr-jev quota exhaust` to enable automatic fallbacks.

