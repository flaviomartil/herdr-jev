# Herdr-Jev Role Plumbing Inventory

## 1. RoleKind Definition & Usage Sites

**Definition:** `src/types/index.ts:8`
```typescript
export type RoleKind = "advisor" | "implementer" | "reviewer" | "researcher";
```

### Files that Switch on or Reference Roles (by role usage pattern):

| File | Lines | Purpose |
|------|-------|---------|
| `src/types/index.ts` | 8, 21 | Type definition; `TriageDecision.role: RoleKind` |
| `src/config/catalog.ts` | 18, 151–210 | `CatalogSchema` type; `resolveActiveModel(client, role)` returns entry for role |
| `src/pipelines/matrix.ts` | 1–27 | `resolveStageSpec(client, role, overrideEffort)` maps role→model via catalog |
| `src/pipelines/planner.ts` | 26–45 | Calls `resolveStage("advisor" \| "implementer" \| "reviewer")` for triad; calls `resolveStageSpec(target.client, role)` |
| `src/harness/bridge.ts` | 124, 130–131, 151, 434 | Profile shape has `executor` and `reviewer` stage; `harnessCommand(["delegation-plan", "--role", input.role ?? "advisor"])` |
| `src/herdr/launcher.ts` | 675–694, 925 | `resolveLaunchProfile(client, stage: role)` checks `role === "reviewer"` to apply readonly args |
| `src/herdr/peer.ts` | 12–15 | `resolvePeerStage({ role?: RoleKind })` validates roles `["researcher", "implementer", "reviewer", "advisor"]` |
| `src/orchestration/execution-guard.ts` | 44, 75, 85, 102 | `suggestedRole: RoleKind` for execution path; returns "advisor" if complex, else "implementer" |
| `src/orchestration/pipeline.ts` | 39, 52, 90–106 | `reviewStage: { role: "reviewer" }`; delegation `role` option; checks `stage.role === "reviewer"` or `"implementer"` |
| `src/harness/review.ts` | 378–384 | Request `role: "advisor"`; resolves reviewer stage as `role: "reviewer"` |
| `src/cli.ts` | 51, 452, 487, 680 | Subagent `--role <role>` option; `resolveActiveModel(client, role)` in models list |
| `src/mcp/server.ts` | 39, 82, 316, 329 | MCP tool schemas enum roles; resolves stage for "implementer"; validates incoming role |
| `src/triage/model-classifier.ts` | 9, 98, 130–131 | Classification result: `role: RoleKind`; Jev judges "advisor" vs "implementer" |
| `src/delegation/cross-harness.ts` | — | Role passed to `resolveDelegatedClient(client, role, config)` |
| `src/discovery/harness-detector.ts` | — | Profiles detected from harness catalog |

## 2. config/models.json — Claude Entry (Verbatim)

```json
"claude": {
  "advisor": {
    "model": "fable-5",
    "fallbackChain": ["fable-5", "claude-sonnet-5", "opus-5"],
    "defaultEffort": "high",
    "extraFlags": [],
    "description": "Claude Fable 5: Architectural planning and design advisor"
  },
  "implementer": {
    "model": "sonnet-5",
    "fallbackChain": ["sonnet-5", "fable-5"],
    "defaultEffort": "high",
    "extraFlags": [],
    "description": "Claude Sonnet 5: Code implementer with 1M tokens context window"
  },
  "reviewer": {
    "model": "opus-5",
    "fallbackChain": ["opus-5", "sonnet-5"],
    "defaultEffort": "xhigh",
    "extraFlags": [],
    "description": "Claude Opus 5: Deep code reviewer and verification specialist"
  },
  "researcher": {
    "model": "sonnet-5",
    "fallbackChain": ["sonnet-5"],
    "defaultEffort": "standard",
    "extraFlags": [],
    "description": "Claude Sonnet 5: Codebase search and documentation research subagent"
  }
}
```

## 3. delegation.json Generation

**Source:** `/home/martil/projects/personal/ai-harness-core/harness.yml`

**Command:** `ai-harness delegation-plan --client claude --role advisor` (or per role)

**Output location:** `/home/martil/.local/share/ai-harness/generated/claude/delegation.json`

**Profile schema (from harness.yml delegation.profiles):**
```yaml
- id: claude-fable-5
  client: claude
  advisor: fable-5
  executor:
    model: claude-sonnet-5
    effort: high
  reviewer:
    model: opus-5
    effort: xhigh
```

**Parsed by:** `src/harness/bridge.ts:139–145` (`parseDecision()`)
- Accepts extra role keys: profile schema is open-ended; only `advisor`, `executor`, `reviewer` are used
- `HarnessDecision` type: `src/harness/bridge.ts:127–131`

## 4. CLI Contracts (Exact JSON Output Shapes)

### `herdr-jev triage <task> --json`
```json
{
  "complexity": "simple" | "moderate" | "architectural",
  "confidence": 0.0–1.0,
  "needsResearch": boolean,
  "effort": "standard" | "high" | "xhigh",
  "recommendedPipeline": "triad" | "direct",
  "latencyMs": number
}
```
**Handler:** `src/cli.ts:257–276`

### `herdr-jev plan <task> --client <id> --json`
```json
{
  "task": string,
  "client": "claude" | "codex" | …,
  "triage": { complexity, confidence, needsResearch, effort, recommendedPipeline, latencyMs },
  "stages": [
    { "role": "advisor" | "implementer" | "reviewer", "client": string, "model": string, "effort": string, "extraFlags": string[], "description": string }
  ],
  "spawnResearchSubagent": boolean,
  "autoImprovement": boolean,
  "delegation": { "mode": "direct" | "delegate", "reason": string, profile?: {...} },
  "executionStages": [ ...stages ]
}
```
**Handler:** `src/cli.ts:277–306` (`planExecution()` in `src/pipelines/planner.ts`)

### `herdr-jev review --json`
```json
{
  "status": "ready" | "pending_verification" | "pending_review",
  "verdict": "APPROVE" | "CHANGES_REQUIRED",
  "scopes": [{ "name": string, "files": string[], "results": [...] }],
  "session": string,
  "timestamp": string
}
```
**Handler:** `src/cli.ts:563–596` (`runReview()` in `src/harness/review.ts`)

### `herdr-jev subagent <prompt> --role <role> --json`
```json
{
  "paneId": string,
  "agentName": string,
  "client": "claude" | "codex" | …,
  "model": string,
  "effort": "standard" | "high" | "xhigh",
  "recommendedEffort": string,
  "effortApplied": boolean,
  "runId": string (optional)
}
```
**Handler:** `src/cli.ts:448–562` (`launchStageInHerdr()` or `runAgentInline()`)

### `herdr-jev models list`
```
Client: [CLAUDE]
  advisor       : Active=fable-5 (Override: optional)
    Cascade   : fable-5 -> claude-sonnet-5 -> opus-5
    Default   : fable-5 (effort: high)
  implementer   : Active=sonnet-5
    Cascade   : sonnet-5 -> fable-5
    Default   : sonnet-5 (effort: high)
  reviewer      : Active=opus-5 [FALLBACK ACTIVE -> opus-5]
    Cascade   : opus-5 -> sonnet-5
    Default   : opus-5 (effort: xhigh)
  researcher    : Active=sonnet-5
    Cascade   : sonnet-5
    Default   : sonnet-5 (effort: standard)
```
**Handler:** `src/cli.ts:666–695`

### `herdr-jev quota status`
```json
{
  "client": "claude",
  "model": string,
  "exhaustedAt": ISO8601,
  "expiresAt": ISO8601
}[]
```
**Handler:** `src/cli.ts:759–795` (`loadQuotaRecords()`)

### `herdr-jev route <message> --mode <mode> --json`
**Handler:** `src/cli.ts:877–905` (WIP changes: adds `--mode off|shadow|active` and `--record` flag; calls `harnessCommand(["route-observation", ...])`)

---

## 5. Test Layout

**Test runner:** `bun test` (Bun native)  
**Preload:** `bunfig.toml:preload = ["./tests/preload.ts"]`  
**Package script:** `"test": "bun test"`  
**Test file pattern:** `tests/*.test.ts`

**Example imports (tests/harness-models.test.ts:1–7):**
```typescript
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { harnessModelCatalog, harnessModelResolve, resetHarnessCaches } from "../src/harness/bridge.js";
import type { ClientKind, RoleKind, StageSpec, TriageDecision } from "../src/types/index.js";
import { createFakeHarness, type FakeHarness } from "./fake-harness.js";
```
- All imports have `.js` suffix (ESM)
- `bun:test` module for test runner
- Fake harness in `tests/fake-harness.ts` for mocking

## 6. Git WIP Summary

**Uncommitted changes (status --short):**
- `src/cli.ts` — Route command gains `--mode <off|shadow|active>` and `--record` flag; calls `harnessCommand()` for telemetry observation
- `src/routing/questions.ts` — Modified (content not diffed)
- `src/routing/router.ts` — Modified; likely adds `mode` option to `TurnRouter` constructor
- `src/triage/jev-client.ts` — Modified (content not diffed)
- `tests/route-modes.test.ts` — New test file (untracked); tests `--mode` flag behavior

**Impact:** Route command mode switch + optional AI Harness telemetry recording; no role definition changes expected.

---

## 7. Adding a `reader` Role — Blockers

To add a `reader` role (Haiku, bulk reading, read-only tools):

**Required changes:**
1. **src/types/index.ts:8** — Add `"reader"` to `RoleKind` union
2. **config/models.json** — Add per-client `reader` entry (model, fallbackChain, defaultEffort, description)
3. **src/config/catalog.ts** — No code change; reads from JSON
4. **src/pipelines/planner.ts:37** — Update triad pipeline to include reader stage if triage flags it
5. **src/herdr/launcher.ts:687** — Add `if (role === "reader") { /* apply read-only args */ }`
6. **src/mcp/server.ts:82** — Add `"reader"` to schema enum
7. **ai-harness-core/harness.yml** — Add delegation profile with reader stage for each client
8. **Tests** — Update type assertions and CLI option tests

**Single most important blocker:** `src/config/catalog.ts` does NOT validate CatalogSchema strictly; typos in config/models.json will silently return undefined → calling code must handle or crash. **Add schema validation at load time** (`loadBaseCatalog()`) to prevent silent failures.
