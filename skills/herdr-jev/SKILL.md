---
name: herdr-jev
description: Jev-driven multi-model triage and triad orchestration for Herdr, Claude, Codex, and AntiGravity. Use when asked to triage tasks, route tasks to optimal models, plan triad pipelines (Advisor -> Implementer -> Reviewer), manage model quotas, or auto-classify new models.
---

# Herdr-Jev Skill

Kiro CLI is a supported peer (`kiro`, executable `kiro-cli`). Use the installed shared `ai-harness` agent, native `chat --trust-all-tools` and an explicitly verified `--model`. Authenticate and discover models before launch; unconfigured Kiro is excluded from automatic selection. Native scalar effort is advisory, so do not pass an invented `--effort` or `--yolo`. Keep existing cross-harness restrictions and native session handles.

## Autonomous peer decisions and quota preflight

Before investigating or implementing each new action task, the coordinating agent must run `herdr-jev triage "<minimal nonsensitive task summary>" --json` and inspect its actual result, even for routine work such as registering a CLI. Decide direct versus delegated execution only after this evaluation; apparent simplicity, an unknown current model or a missing profile does not waive triage. Run once per task, repeating only for a material scope change. Conversational answers, status requests and delegated workers/reviewers do not recursively triage. If the CLI is unavailable or fails, assess locally and continue directly, without claiming Jev ran. The tool result is evidence of evaluation; no tab is required for a direct decision and task text must not enter structural telemetry.

The user supplies the task; the harness chooses whether collaboration is useful, the peer, model, supported effort and layout. Use this workflow for every new tab or split, including replacements. Keep simple work direct. Prefer tabs for independent work and splits for closely related work. Follow explicit user choices and the caller's configured peer restrictions.

1. Run `herdr-jev triage "<bounded task>" --json` for Jev's role/effort recommendation. If Jev reports a heuristic fallback, retain that distinction; do not claim a Jev inference occurred.
2. Run `herdr-jev detect --json` and `herdr-jev quota status` immediately before launch. Detection tests installed binaries and local circuit breakers; a detector's `healthy` label or an absent breaker does not prove provider quota or authentication.
3. Inspect native model discovery and fresh quota observations for the intended provider, account and model scope. Detector model lists may come from a configured catalog rather than live discovery; verify IDs with the native client. Account-level remaining quota is not proof that every model is available. Reconcile contradictory detector and quota results using timestamps, scope and a supported native probe before choosing. Exclude exhausted, unavailable and unauthenticated candidates. Unknown or stale quota remains unknown. If an existing registered native CLI supports a bounded headless model request, use a harmless response probe before opening the tab; otherwise choose a candidate with positive applicable evidence or continue directly. Never invent probe flags, clear breakers to force success, change peer permissions or use `detect --auto-config` as a routine preflight.
4. Select an available permitted peer using Jev's recommendation and the observations. Verify native effort support; recommendations for clients without scalar effort support are advisory. Canonical executor/reviewer profiles remain exact and cannot be silently replaced by peer routing.
5. Create a unique stable handle before submission and run `herdr-jev subagent "<bounded task>" --target <peer> --model <verified-model> --tab --name <handle>`, adding `--effort` only when supported. Use `--split --direction right` instead of `--tab` for a sibling pane. The source harness and cwd come from the caller, not a hardcoded client.
6. Retain the returned `agentName`. Observe with `herdr-jev peer-read <agentName> --wait`; continue with `herdr-jev peer-message <agentName> "<follow-up>" --wait`. Reuse this native session for the conversation. Terminal snapshots and idle states are observations, not verified completion.

### Behavioral monitoring and automatic switching

Inspect peer responses before each follow-up for actual provider quota exhaustion, rate limits, authentication expiry, blocked trust dialogs and transport uncertainty. Quoted errors inside a task, silence, an idle pane or a timeout alone are not evidence of exhausted quota.

On confirmed quota exhaustion, mark that exact client/model with `herdr-jev quota exhaust <client> <model> --minutes <duration>`. Use the provider's observed reset time when available; otherwise the command's default cooldown is a local policy, not a provider reset guarantee. Respect a retry-after for transient limits. Authentication expiry requires a different authenticated peer or user reauthentication, not a quota reset.

Automatically choose another permitted, verified candidate and repeat the entire preflight before opening its tab. Switching is performed by the skill's supervising agent through the existing tools; this skill does not install a background watcher or promise native in-place model switching. Preserve the old peer for inspection and pass a compact handoff with the objective, owned paths, confirmed changes, checks and remaining work. Never include credentials or the full transcript.

Before replacing a peer that may have executed work, reconcile its pane and repository effects. Do not replay an accepted or uncertain submission, overlap writers, or resend the original task blindly. A new native session does not inherit conversational memory automatically. Independent review stays independent. Bound recovery to one attempt per eligible candidate per incident; if all candidates are exhausted, unknown or blocked, continue directly when possible and report the concrete limitation. A breaker expiry requires fresh checking, not automatic proof of recovered quota.


Semantic triage engine and multi-model orchestrator plugin for Herdr, Claude Code, Codex, and AntiGravity.

## Capabilities

1. **Semantic Task Triage**: Evaluates architectural complexity (`trivial`, `routine`, `moderate`, `architectural`), research necessity, and reasoning effort (`standard`, `high`, `xhigh`) via TypeSafe Jev System One or local heuristic fallback.
2. **Canonical Delegation Profiles**: Resolve the actual client/model against the installed AI Harness profile. Advisory peer recommendations do not replace exact executor or reviewer profiles. Discover model IDs and effort support from the installed native clients rather than this document.
3. **Quota Cascade & Circuit Breakers**: The supervising agent checks scoped quota evidence and performs bounded peer recovery through existing tools. Local breakers exclude exhausted candidates; they do not prove provider availability or migrate a running session.
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

### 8. Pre-flight Turn Routing (~330ms)
Evaluate a turn before running, picking model tier, effort, safe tools, and gated skill while preserving prompt cache:
```bash
herdr-jev route-turn "escreva o ADR de migracao para Kafka" --prompt
herdr-jev route-turn "fix typo on line 42" --json
```

### 9. Latency Calibration and Prewarm
Calibrate network deadline or prewarm TLS connection pool:
```bash
# Prewarm TLS socket pool to api.typesafe.ai (double-handshake)
herdr-jev prewarm

# Measure local round-trips and update HERDR_JEV_DEADLINE_MS in .env
herdr-jev calibrate -s 15 -w
```

### 10. Health and Environment Status
Check TypeSafe Jev connectivity, Herdr runtime, and AI-Harness bridge:
```bash
herdr-jev status
```

## Agent Guidelines

* When receiving an ambiguous or complex coding task, run `herdr-jev plan "<task>" --client <client>` to inspect recommended models and pipeline depth.
* If a task involves core architecture or cross-cutting migrations, recommend or engage the full Triad pipeline (Advisor -> Implementer -> Reviewer).
* When asked to check installed harnesses, inspect model quotas, or configure peering, run `herdr-jev detect` or `herdr-jev detect --auto-config`.
* If encountering rate limits on AntiGravity or any client, activate the quota circuit breaker using `herdr-jev quota exhaust` to enable automatic fallbacks.
