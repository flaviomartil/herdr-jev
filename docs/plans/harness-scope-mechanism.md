# harness-scope Mechanism: Hook Events and Dynamic Allowlist Conversion

**Source:** Read-only analysis of https://github.com/claudeai-mods/harness-scope (MIT), plugin version 0.1.3. This document specifies which hook events hide skills, agents, rules, and tools from the model, and what a dynamic allowlist implementation would require.

---

## 1. Hook Events and Filtering Pipeline

### Event Cascade Overview

| **Component** | **Hook Event** | **Input Type** | **Output Control** | **Source Tracking** |
|---|---|---|---|---|
| **Skills (display)** | `prompt.attachment` (type `skill_listing`) | Text listing from engine | Filter via regex; null → pass-through | `session.usage().context.breakdown.skills.skillFrontmatter[].source === 'projectSettings'` |
| **Skills (invocation)** | `tool.call` (tool `Skill`) | Skill name from e.skill | `{ deny: reason }` | Receipt of names already removed from listing |
| **Agents** | `agent.offer` | Agent name in e.agent | `{ isOffered: false }` | `e.source === 'projectSettings'` (exemption) |
| **Instructions/CLAUDE.md** | `prompt.context` | `e.instructionFiles[]` post-next | Filter by kind; remove user/imported files | `f.kind !== 'user'` exemption; tracks parent chain |
| **Tools (discovery)** | `tool.describe` | Tool name in e.tool | `{ isDeferred: true }` | Receipt tracking in `receipt.seenTools` |
| **Tools (listing)** | `prompt.attachment` (type `deferred_tools_delta`) | One-per-line tool names | Filter via regex; headers preserved | Receipt of removed names |
| **Tools (invocation)** | `tool.call` | Tool name in e.tool | `{ deny: reason }` | Profile check + receipt name match |
| **Confirmation** | `command.run` (command `harness-scope`) | – | `$.ui.log(text)` to screen, not model | Receipt accumulated over session |
| **Lifecycle** | `classic.SessionStart` (source: clear/resume) | – | Reset `loading`, `projectSkills`, `receipt` | Separate from `session.start` |

---

### 1.1 Skills: `prompt.attachment` (type `skill_listing`)

**File:** `plugin/hooks/register.ts:262`, `plugin/hooks/listing.ts:19–39`

**Input format:**
```
The following skills are available for use with the Skill tool:

- adr-writer: Record a design decision.
- claude-api: Reference for the Claude API.
TRIGGER — read BEFORE opening the target file.
- hookify:configure: Enable or disable hookify rules
- writing-ecosystem: Draft and review articles.
```

**Parsing logic (`filterSkillListing`):**
- Line must start with `SKILL_HEADER = 'The following skills are available for use with the Skill tool:'`
- Split on `/\n(?=- )/` (lookahead for "- " at line start)
- Item name: first line after "- ", up to first ": " (or line end)
- Multi-line descriptions (bullets without ": ") are grouped with previous item
- Whitespace in name (/\s/) signals a stray bullet → merge with prior item (e.g., "- Use when drafting" stays with "writing-ecosystem")
- **Returns `null`** if header is missing → entire text passes through unfiltered

**Filtering:**
```typescript
const removed: string[] = []
const kept = items.filter((item) => {
  const name = itemName(item)
  if (keep(name)) return true
  removed.push(name)
  return false
})
return { text: [head, ...kept].join('\n'), removed }
```

**How it tells repo skills from global:**
```typescript
const own = await ownSkills($)  // register.ts:189
if (own === null) {
  // Cannot read; pass through and note it
  receipt.notes.push('could not tell repo skills apart, so listing passed through')
  return text
}
// Project skills stay; filter globals
return filterSkillListing(text, (n) => {
  receipt.seenSkills.add(n)
  return own.has(n) || loaded.keepSkill(n)  // both project and allow-listed
})
```

**ownSkills retrieval:**
```typescript
$.session.usage({ breakdown: 'summary' })
  .then((u) => {
    const list = u.context.breakdown?.skills?.skillFrontmatter
    if (!list) return null
    return new Set(list.filter((s) => s.source === 'projectSettings').map((s) => s.name))
  })
```

---

### 1.2 Skills: `tool.call` (tool `Skill`)

**File:** `plugin/hooks/register.ts:292–296`

```typescript
if (e.tool === 'Skill') {
  const name = String(e.skill ?? '').replace(/^\//, '')
  // Only names removed from the listing in THIS conversation
  if (receipt.skills.has(name)) 
    return { deny: skillDeny(name, loaded.name) }
}
return next(e)
```

**Deny message template:**
```typescript
function skillDeny(name: string, profile: string): string {
  return `The skill "${name}" is turned off in this repo by the harness-scope profile "${profile}". If it is needed, ask the user to run /${name} themselves.`
}
```

**Source tracking:** Receipt (`receipt.skills.add(n)`) is built during `skillListing()` and only contains names actually removed from the listing in this conversation. User's `/name` command and agent `skills:` preload bypass this check.

---

### 1.3 Agents: `agent.offer`

**File:** `plugin/hooks/register.ts:267–274`

```typescript
on('agent.offer', async ($, e, next) => {
  const loaded = await current($)
  if (loaded.status !== 'on' || 
      loaded.profile.agents === undefined || 
      e.source === 'projectSettings')  // ← repo's own agents always offered
    return next(e)
  receipt.seenAgents.add(e.agent)
  if (loaded.keepAgent(e.agent)) return next(e)
  receipt.agents.add(e.agent)
  return { isOffered: false }  // ← denies both listing display and dispatch
})
```

**Source exemption:** `e.source === 'projectSettings'` agents are never hidden, matching how repo skills stay.

---

### 1.4 Instructions/CLAUDE.md: `prompt.context`

**File:** `plugin/hooks/register.ts:242–255`, `plugin/hooks/instructions.ts:6–18`

```typescript
on('prompt.context', async ($, e, next) => {
  const r = await next(e)  // get downstream result
  const loaded = await current($)
  if (loaded.status !== 'on' || loaded.profile.instructions === undefined) return r
  if (r.instructionFiles === undefined) {
    receipt.notes.push('instruction files were rewritten upstream')
    return r
  }
  for (const f of r.instructionFiles) 
    if (f.kind === 'user') receipt.seenFiles.add(f.path)
  const out = filterInstructionFiles(r.instructionFiles, loaded.keepFile)
  for (const p of out.removed) receipt.files.add(p)
  return { ...r, instructionFiles: out.files }
})
```

**filterInstructionFiles logic:**
```typescript
function filterInstructionFiles<F extends InstructionFileLike>(
  files: readonly F[],
  keepPath: (path: string) => boolean
): { readonly files: readonly F[]; readonly removed: readonly string[] } {
  const dropped = new Set<string>()
  // One pass: drops cascade through `@` imports via parent chain
  for (const f of files) {
    if (f.kind !== 'user') continue  // ← project/local/managed/memory stay
    if (!keepPath(f.path) || 
        (f.parent !== undefined && dropped.has(f.parent))) 
      dropped.add(f.path)
  }
  if (dropped.size === 0) return { files, removed: [] }
  return { files: files.filter((f) => !dropped.has(f.path)), removed: [...dropped] }
}
```

**Exemptions:**
- `f.kind !== 'user'` → project / local / managed / memory files are never filtered
- Import chains are followed: if parent is dropped, child is too (even if name matches allow list)

---

### 1.5 Tools: `tool.describe` + `tool.call` + `prompt.attachment`

**File:** `plugin/hooks/register.ts:276–284` (describe), `286–298` (call), `206–211` (listing)

```typescript
on('tool.describe', async ($, e, next) => {
  const r = await next(e)
  const loaded = await current($)
  if (loaded.status !== 'on' || loaded.profile.tools === undefined) return r
  receipt.seenTools.add(e.tool)
  if (loaded.keepTool(e.tool)) return r
  receipt.tools.add(e.tool)
  return { ...r, isDeferred: true }  // ← marks for ToolSearch deferral
})

on('tool.call', async ($, e, next) => {
  const loaded = await current($)
  if (loaded.status !== 'on') return next(e)
  if (loaded.profile.tools !== undefined && !loaded.keepTool(e.tool)) {
    return { deny: `The tool ${e.tool} is turned off in this repo by the harness-scope profile "${loaded.name}".` }
  }
  // ... handle Skill tool ...
  return next(e)
})
```

**Listing filter (deferred_tools_delta):**
```typescript
function filterDeferredTools(text: string, keep: (name: string) => boolean): Filtered {
  const removed: string[] = []
  const lines = text.split('\n').filter((line) => {
    const isName = line.length > 0 && !/\s/.test(line)  // one-per-line, no spaces
    if (!isName || keep(line)) return true
    removed.push(line)
    return false
  })
  return { text: lines.join('\n'), removed }
}
```

**Note on Deferred Tools:**
- Set `isDeferred: true` moves tool to ToolSearch section instead of immediate availability
- Tool is NOT completely hidden; user must explicitly load it with `ToolSearch` query
- Name is removed from the `deferred_tools_delta` listing to avoid accidental mention

---

## 2. Profile and Selector Resolution

**File:** `plugin/hooks/register.ts:88–122`

### 2.1 Selector File Location

```typescript
const SELECTOR = '.claude/harness-scope.json'

async function readSelector($: EngineInterface): Promise<{ path: string; text: string } | null> {
  const root = await $.session.root()          // Session root (where user is)
  const repo = await $.session.repo()          // Git repo root
  const dirs = repo !== null && repo.root !== root 
    ? [root, repo.root]                        // Check both
    : [root]
  for (const dir of dirs) {
    const path = `${dir}/${SELECTOR}`
    if (await $.fs.exists(path)) {
      const text = await $.fs.read(path)
      return typeof text === 'string' ? { path, text } : null
    }
  }
  return null
}
```

**Precedence:** Session root first, then git repo root (allows nested repos).

### 2.2 Selector and Profile Parsing

```typescript
const sel = parseSelector(selector.text)
// sel must be { ok: true, profile: 'name' }
// where 'name' matches /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
```

**Profile lookup:**
```typescript
const own = configDir === '' ? '' : `${configDir}/harness-scope/profiles/${sel.profile}.json`
if (own !== '' && (await $.fs.exists(own))) {
  const text = await $.fs.read(own)
  return activate(sel.profile, own, selector.path, parsed.profile)
}
const bundled = Object.hasOwn(BUNDLED, sel.profile) ? BUNDLED[sel.profile] : undefined
if (bundled !== undefined) 
  return activate(sel.profile, `bundled profile "${sel.profile}"`, selector.path, bundled)
```

**Precedence:** User profile (`~/.claude/harness-scope/profiles/<name>.json`) > bundled profiles (e.g., `writing`).

### 2.3 Config Directory Resolution

```typescript
export function configDirFromPluginRoot(root: string): string | null {
  const INSTALL_ANCHORS = ['/plugins/cache/', '/plugins/marketplaces/']
  for (const anchor of INSTALL_ANCHORS) {
    const at = root.lastIndexOf(anchor)
    if (at > 0) return root.slice(0, at)  // Infer ~/.claude from installed plugin path
  }
  return null
}
```

**User override:** `claude plugin configure harness-scope --configDir <path>` sets userConfig field → used in `register()` as `const configuredDir = options.configDir`.

### 2.4 Tilde Expansion for File Paths

```typescript
export function expandTilde(pattern: string, configDir: string): string {
  if (!pattern.startsWith('~/')) return pattern
  if (pattern.startsWith('~/.claude/')) 
    return `${configDir}/${pattern.slice('~/.claude/'.length)}`
  if (configDir.endsWith('/.claude')) 
    return `${configDir.slice(0, -'/.claude'.length)}${pattern.slice(1)}`
  return pattern
}
```

**Usage:** Called once on `profile.instructions` rule patterns (file paths) to resolve `~/` before glob matching.

---

## 3. Profile Structure and Glob Matching

**File:** `plugin/hooks/profile.ts:4–85`

```typescript
type Rule = { readonly mode: 'allow' | 'deny'; readonly patterns: readonly string[] }
type Profile = {
  readonly skills?: Rule
  readonly agents?: Rule
  readonly instructions?: Rule
  readonly tools?: Rule
}
```

**Glob-to-regex conversion:**
```typescript
function globToRegExp(glob: string): RegExp {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // Escape all special chars
    .replace(/\*/g, '.*')                   // * → .*
    .replace(/\?/g, '.')                    // ? → .
  return new RegExp(`^${body}$`)            // Anchored match
}
```

**Rule compilation:**
```typescript
export function compileRule(rule: Rule | undefined): (name: string) => boolean {
  if (rule === undefined) return () => true  // No rule = keep all
  const regs = rule.patterns.map(globToRegExp)
  const matches = (name: string) => regs.some((r) => r.test(name))
  return rule.mode === 'allow' 
    ? matches                                 // Keep only matches
    : (name) => !matches(name)                // Keep non-matches
}
```

---

## 4. Receipt Format and Command Output

**File:** `plugin/hooks/register.ts:47–59`, `159–180`

### 4.1 Receipt Structure

```typescript
type Receipt = {
  skills: Set<string>                       // Removed by filter
  agents: Set<string>                       // Removed by filter
  files: Set<string>                        // Removed by filter
  tools: Set<string>                        // Removed by filter
  seenSkills: Set<string>                   // All encountered (by listing)
  seenAgents: Set<string>                   // All encountered (by offer)
  seenFiles: Set<string>                    // All encountered (by context)
  seenTools: Set<string>                    // All encountered (by describe)
  notes: string[]                           // Error/state notes
}
```

### 4.2 Command Output (`/harness-scope`)

```typescript
function receiptText(loaded: Loaded): string {
  if (loaded.status === 'off') 
    return `no ${SELECTOR} in this repo, so nothing is turned off.`
  if (loaded.status === 'error') 
    return `passing everything through — ${loaded.reason}`
  
  const r = receipt
  const p = loaded.profile
  
  // Per-category line
  const line = (label: string, rule: Rule | undefined, removed: Set<string>, seen: Set<string>) => {
    if (rule === undefined) return `${label}: not in the profile`
    if (seen.size === 0 && removed.size === 0) 
      return `${label} (${rule.mode}): not composed yet in this conversation`
    const miss = unmatchedPatterns(rule, seen)
    const names = [...removed].map(shortPath).join(', ')
    return `${label} (${rule.mode}): ${removed.size} off${names ? ` — ${names}` : ''}${miss.length ? `\n  matched nothing: ${miss.join(', ')}` : ''}`
  }
  
  return [
    `profile "${loaded.name}" from ${shortPath(loaded.from)}`,
    line('skills', p.skills, r.skills, r.seenSkills),
    line('agents', p.agents, r.agents, r.seenAgents),
    line('instructions', expandHome(p.instructions), r.files, r.seenFiles),
    line('tools', p.tools, r.tools, r.seenTools),
    ...r.notes,
  ].join('\n')
}
```

### 4.3 Command Invocation

```typescript
on('command.run', async ($, e, next) => {
  if (e.command !== 'harness-scope') return next(e)
  const text = receiptText(await current($))
  // Only show on screen if surfaces exist; else return text to model
  if ((await $.session.surfaces()).length === 0) return { text }
  $.ui.log(text)
  return {}  // Empty → don't send to model
})
```

**Output stays on screen:** `$.ui.log()` renders text in the IDE; empty return `{}` prevents relay to the model prompt.

---

## 5. Lifecycle: Session Resets

**File:** `plugin/hooks/register.ts:61–67`, `216–223`

```typescript
let loading: Promise<Loaded> | undefined
let projectSkills: Promise<Set<string> | null> | undefined
let receipt = newReceipt()
let configuredDir = ''
let configDir = ''

on('classic.SessionStart', async (_$, e, next) => {
  if (e.source === 'clear' || e.source === 'resume') {
    loading = undefined              // Force profile re-read
    projectSkills = undefined        // Force session.usage() re-call
    receipt = newReceipt()           // Reset counts
  }
  return next(e)
})
```

**Note:** `classic.SessionStart` fires on startup, `/clear`, and resume. `session.start` fires only at startup. Receipt is _not_ reset on compact (resume without clear). Profile is cached per conversation.

---

## 6. Test Approach

**File:** `tests/pure.test.ts`, `tests/register.test.ts`

### 6.1 Pure Unit Tests

Fixtures test parsing and filtering in isolation:
- `filterSkillListing`: split on regex, preserve byte-for-byte, multi-line descriptions, whitespace in names
- `filterDeferredTools`: one-per-line, preserve headers
- `filterInstructionFiles`: cascade drops via parent chain, exemption of kind `!== 'user'`
- `compileRule`: allow/deny semantics, glob → regex, undefined rule
- `parseSelector` / `parseProfile`: JSON parsing, validation
- `configDirFromPluginRoot`, `expandTilde`: path resolution

### 6.2 Integration Tests (register.test.ts)

Fake engine via `on` hook registration; mocked `$` (session, fs, ui):
- **Pass-through:** no selector → listing unchanged, instruction files unchanged, agents offered
- **Broken profile:** invalid JSON → error logged once, everything passes through
- **Selector injection:** profile body in selector → rejected (repo cannot override rules)
- **Filtering lifecycle:** skill listing filtered, skill call denied, instruction files dropped, agents not offered
- **Receipt accuracy:** removed names match profile, unmatched patterns reported

**Test fixtures:**
- 1,000-item listing (stress test on scaling)
- Multi-line skill descriptions
- `@` import chains in instruction files
- Namespaced skills (`hookify:configure`, `apps/web:deploy`)

---

## 7. Minimal Set for Dynamic Allowlist Implementation

To port this mechanism to a **dynamic allowlist computed at session start** (instead of static profile files), you need:

| **Component** | **Hook Events** | **Helpers** | **Purpose** |
|---|---|---|---|
| **Profile compute** | `session.start` (only once) | `computeProfile(repoContext)` | Replace file read with computed Profile |
| **Skill filtering** | `prompt.attachment` (skill_listing) | `filterSkillListing()` (reuse) | No change; same text parsing |
| **Skill denial** | `tool.call` (Skill) | `receipt.skills` (reuse) | No change; same receipt tracking |
| **Agent filtering** | `agent.offer` | `compileRule(profile.agents)` (reuse) | No change; same allow/deny logic |
| **Instruction filtering** | `prompt.context` | `filterInstructionFiles()` (reuse) | No change; same file kind logic |
| **Tool filtering** | `tool.describe`, `tool.call`, `prompt.attachment` (deferred_tools_delta) | `compileRule(profile.tools)` (reuse) | No change; same glob matching |
| **Receipt & reporting** | `command.run` (harness-scope) | `receiptText()`, `unmatchedPatterns()` (reuse) | No change; same output format |
| **Lifecycle** | `classic.SessionStart` (clear/resume only) | Reset `receipt`, not `loading` or profile | Cache computed profile per conversation |

**Key differences:**
- Remove `load($)` and `current($)` async file reads
- Add `computeProfile()` that takes `repoContext` (git root, session root, etc.) and returns Profile
- Keep all filter functions and Receipt logic unchanged
- Profile is computed once at `session.start`, cached, reset only on `/clear` + resume

---

## Appendix: Hook Events Summary

**Used by harness-scope (6 hook families):**

1. `prompt.attachment` — filters skill_listing and deferred_tools_delta text
2. `prompt.context` — filters instructionFiles array post-next
3. `agent.offer` — denies agents with `{ isOffered: false }`
4. `tool.describe` — defers tools with `{ isDeferred: true }`
5. `tool.call` — denies skills and tools with `{ deny: reason }`
6. `command.run` — outputs receipt to screen via `$.ui.log()`, returns `{}`

**Not used:**
- `skill.offer`, `agent.describe` — no listing/dispatch filtering at source
- `tool.offer` — agents don't get offered; already filtered by agent.offer

---

**Final Summary:** The plugin uses **6 hook events** (`prompt.attachment`, `prompt.context`, `agent.offer`, `tool.describe`, `tool.call`, `command.run`) and **pure filter functions** (`filterSkillListing`, `filterDeferredTools`, `filterInstructionFiles`, `compileRule`). To enable dynamic allowlists, replace the static profile file read (`load()`) with a computed allowlist; all other logic remains unchanged.
