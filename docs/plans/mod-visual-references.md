# Claude Code Mod Visual Rendering Patterns

Six repos analyzed for UIKit layouts, progress bars, spinners, glyphs, and color schemes: task-line, plan-progress, whats-agent-doing, work-visualized, human-in-loop, harness-scope.

## 1. Band/AbovePrompt Layout

### task-line (MIT) – Progress bars with auto-hide
**Band JSX tree (register.tsx:116-163):**
```jsx
<Box flexDirection="column" paddingX={1}>
  {visible.map(r => (
    <Box key={`row:${r.name}`} flexDirection="row" gap={1}>
      <Text color={r.color}>{r.glyph}</Text>
      <Box key="label" width={labelWidth} flexShrink={0}>
        <Text wrap="truncate">{r.label}</Text>
      </Box>
      {barOf(r, filled)} {/* progress bar */}
      <Text>{`${r.done}/${r.total}`}</Text>
      <Text dimColor>{`${percent}%`.padStart(PERCENT_WIDTH)}</Text>
      {r.note && <Text color={r.color} bold>{r.note}</Text>}
      {canClick && <Button label="×" plain dimColor onPress={dismiss(r.name)} />}
    </Box>
  ))}
</Box>
```
**Progress bar (register.tsx:98-110):**
```jsx
barOf = (r: Row, filled: number) => !isDesktop ? (
  <Box>
    <Text color={r.color}>{'━'.repeat(filled)}</Text>
    <Text dimColor>{'─'.repeat(barWidth - filled)}</Text>
  </Box>
) : (
  <Box width={barWidth} flexShrink={0}>
    <Box width={filled} backgroundColor={r.color}>
      <Text>{NBSP.repeat(filled)}</Text>
    </Box>
    <Box width={barWidth - filled} backgroundColor="userMessageBackground">
      <Text>{NBSP.repeat(barWidth - filled)}</Text>
    </Box>
  </Box>
)
```
**Key patterns:**
- Terminal: ━ (filled) + ─ (empty) glyphs
- Desktop: colored Box fills from left, empty track is `userMessageBackground` color
- Row layout: glyph | label (truncated) | bar | done/total counts | percent | optional note | dismiss button
- Auto-hide after `timing.lingerMs` via `hideLater()` clock timer
- gap={1} between columns, paddingX={1} for breathing room

### plan-progress (MIT) – Multi-stage bars with fold toggles
**Terminal bar render (register.tsx:1720-1740):**
```jsx
<Box flexDirection="row" gap={1}>
  <Text color={STATE_COLOR[p.state]}>{STATE_GLYPH[p.state]}</Text>
  <Box width={titleW} flexShrink={0}>
    <Text wrap="truncate">{p.title}</Text>
  </Box>
  <Raster key={`track-${p.id}`} columns={trackW} rows={1} cells={trackCells(p, trackW, now)} />
  <Text dimColor>{`${String(pct).padStart(3, FIGURE_SPACE)}%`}</Text>
  {hasFold ? <Box width={1}><Button plain dimColor label={p.isFolded ? '▸' : '▾'} /></Box> : null}
  {hasClicks ? <Button plain dimColor label="✕" onPress={() => dropPlan($, p.id)} /> : null}
</Box>
```
**State glyphs & colors (register.tsx:12-14):**
```typescript
STATE_COLOR: { running: '#7858CA', needs_input: '#AD6400', error: '#C5353E', done: '#18883A' }
STATE_GLYPH: { running: '●', needs_input: '?', error: '!', done: '✓' }
```
**Key patterns:**
- State-driven colors: purple (running) → orange (needs input) → red (error) → green (done)
- Glyphs: ● ● ● (running pulsing) | ? (waiting) | ! (error) | ✓ (done)
- Fold chevron: ▸ (collapsed) ▾ (expanded), toggles agent strips below
- Title width auto-fitted to content, bar width fills remaining space
- Raster for rendered progress cells, desktop uses SVG with hover overlays

### whats-agent-doing (MIT) – Collapsible activity box with state colors
**AbovePrompt render (register.tsx:600-680):**
```jsx
<Box
  flexDirection="column"
  borderStyle="round"
  borderColor={isWorking ? color : 'gray'}
  paddingX={1}
  alignSelf="flex-start"
>
  <Box key="activity" flexDirection="row">
    <Button plain label={isOpen ? '▾' : '▸'} onPress={() => update($, isExpanded, open => !open)} />
    <Box flexShrink={0}>
      <Text color={color}>{isWorking ? ' ● ' : ' ○ '}</Text>
      <Text bold>Claude: </Text>
    </Box>
    <Text wrap="truncate-end">{printable(headline.label, MAX_LABEL_CHARS)}</Text>
    <Box flexShrink={0}>
      <Text dimColor>{elapsed}</Text>
    </Box>
  </Box>
  {teamBox}
  {body}
</Box>
```
**Phase colors & glyphs (register.tsx:49-63):**
```typescript
PHASE_COLORS: { idle: 'gray', requesting: 'cyan', thinking: 'magenta', 
  writing: 'green', composing: 'blue', tool: 'cyan', agent: 'cyan', 
  approval: 'yellow', question: 'yellow', compacting: 'blue' }
OUTCOME_MARKS: { ok: { mark: '✓', color: 'green' }, error: { mark: '✗', color: 'red' }, 
  denied: { mark: '⊘', color: 'yellow' }, interrupted: { mark: '■', color: 'gray' } }
KIND_MARKS: { turn: { mark: '›', color: 'white' }, thought: { mark: '∴', color: 'magenta' },
  reply: { mark: '✎', color: 'green' }, compact: { mark: '⇣', color: 'blue' } }
```
**Key patterns:**
- borderStyle="round" box with state-driven border color
- Collapse triangle: ▾ (open) ▸ (closed)
- State indicator: ● (working) ○ (idle), text color matches PHASE_COLORS
- Agent rows with ◆ glyph, elapsed time dimColor right-aligned
- History rows with kind marks (›, ∴, ✎, ⇣) and outcome marks (✓, ✗, ⊘, ■)
- Markdown-safe glyphs, unicode safe

### human-in-loop (MIT) – Task list with yellow checkbox
**Task button in AbovePrompt (register.tsx:472-487):**
```jsx
<Box flexDirection="row">
  <Text color="yellow">{'☐ '}</Text>
  <Text bold>{'Assigned you a task: '}</Text>
  <Text wrap="truncate-end">{printable(title, MAX_TITLE)}</Text>
</Box>
```
**My Tasks pane (register.tsx:491-550+):**
```jsx
// Task rows with action buttons
<Box flexDirection="row" gap={1}>
  {/* task row */}
</Box>
// Input field for answers
<Input
  label="Answer › "
  placeholder="Enter sends it to Claude"
  value={live.drafts.get(task.id) ?? ''}
  submitLabel={working ? 'save' : 'send'}
/>
```
**Key patterns:**
- Yellow ☐ checkbox glyph for "needs your action"
- Input field inside pane for inline editing
- Hotkey buttons (d=Done, r=Answer, x=Reject) plaintext
- Secret detection warning in yellow
- Calls use mcp__human-in-the-loop__assign_task

## 2. Pane Layout – Terminal & Desktop

### plan-progress – Multi-panel with folds
**Structure (register.tsx:1722-1780):**
```
┌─────────────────────────────────────┐
│ ● Plan Title    [████████░░] 75% ▾ ✕│
│   ▾ Agent: Starting                 │
│   ▾ Agent: Working                  │
└─────────────────────────────────────┘
```
- Title + glyph + progress raster cells + percent + fold chevron + close button
- Folded agent strips show below title row (marginLeft applied)
- Notes appear in own row when state != 'running'
- Agent rows with model/effort metadata
- Desktop uses SVG for smooth renders, raster for terminal

### whats-agent-doing – Scrollable history
**History pane structure:**
```
┌─ ▾ Claude: Working on X · 2.5s ──┐
│ ◆ Agent Name › label    5.2s      │
│ ◆ Another Agent › work  1.0s      │
│ › Turn: read prompt     3.2s      │
│ ∴ Thought (120 words)   2.1s      │
│ ✎ Wrote reply (45 words) 1.8s     │
│ … 12 earlier                      │
└──────────────────────────────────┘
```
- Collapsible header with phase indicator (● working, ○ idle)
- Agent rows: ◆ + name (bold, truncated) + › + label
- History rows: mark + label (dimColor if quiet) + duration
- "… N earlier" and "No actions yet" footer states
- maxRows driven by parent, history rows = min(MAX_HISTORY_ROWS, maxRows - 4 - teamRows)

### human-in-loop – Task queue with buttons
**My Tasks pane:**
```
┌─ 3 tasks for you · 1 not sent yet ─┐
│ ☐ Task #1: Need API key            │
│   [Option A] [Option B] [Answer…]  │
│ ☐ Task #2: Review file.ts          │
│   [Done] [Answer…] [Reject…]       │
│ ☐ Task #3: Pick a number           │
│   Answer › [input field]           │
│   [Send now]  [Save for later]     │
└────────────────────────────────────┘
```
- Header: plural(active, 'task') + "for you" + saved count note
- Task rows: ☐ glyph + id + title + earlier session marker
- Action buttons per task: choices (for 'choose' kind) or Done/Answer/Reject hotkey buttons
- Active task gets Input field below it (if canType)
- Secret detection swaps field for warning + edit/send-anyway buttons

### work-visualized – File tree with activity
**Pane structure (register.tsx):**
- Uses UI pane system to show file map
- Entries tracked with op (create/edit/view/delete)
- Visual glyphs: ICON[op] + LABEL[op]
- Animation trails for changed files
- Ghost entries (deleted) fade out after T.ghostGone ms
- Scroll/focus tracking for large trees

## 3. Clever Touches

### task-line: Auto-hide + dismiss button
- Tasks with `doneAt` timestamp auto-hide after `timing.lingerMs` (default 3000ms)
- Desktop renders dismiss × button; terminal hides it unless fullscreen
- Separate plain-text rendering for AskUserQuestion (mobile-friendly, no buttons)

### plan-progress: Agent strips visualization
- Finished agent strips fold into collapsible rows (FOLD_MS = 5000)
- Failed strips stay visible until bar closes
- stripCells() renders cell-by-cell progress; stripsSvg() for desktop overlays
- State colors hexadecimal (#7858CA, #AD6400, #C5353E, #18883A) for precise rendering

### whats-agent-doing: Plain-language headline + history
- Headline formed from live.phase + current action context (reading, thinking, writing, composing, tool, agent, approval, question, compacting)
- Thought block captures latest sentence from stream, word count tracked
- Reply and tool composition tracked separately
- History kept for MAX_HISTORY=100 entries, shown in last MAX_HISTORY_ROWS=12
- Streaming updates throttled to STREAM_THROTTLE_MS=250

### human-in-loop: Hotkey buttons + secret detection
- Button hotkeys: "d" (Done), "r" (Answer), "x" (Reject), "1–9" (Choose option)
- looksSecret() regex detects API keys, passwords, tokens and blocks send with yellow warning
- Drafts cached in live.drafts.Map<id, string>
- Batch resolution at BATCH_MS=800 to group answers together
- Task state: 'pending' → 'active' (user is on it) → 'done' (with optional answer)

### work-visualized: Live project tree with ghosts
- Real-time disk scan every POLL_MS=1500
- Activity map tracks running operations (create/edit/view/delete)
- Ghost entries for deleted files (fade out after timeout)
- Turn summary tracks counts: "4 created, 2 edited, 1 deleted"
- 30 fps animation loop (FRAME_MS=33) while anything moves
- Icon map: ICON[op] for visual Op glyphs

## 4. Code Snippets by Category

### Progress bar percent calculation (task-line:78)
```typescript
const { filled, percent } = progressOf(r.done, r.total, barWidth)
// Terminal: filled chars of barWidth, percent as 0–100
// Desktop: CSS-pixel-width filled box, percent right-aligned
```

### Spinner/phase indicator (whats-agent-doing:613-616)
```typescript
const color = PHASE_COLORS[headline.phase]
const elapsed = isWorking ? ` · ${durationOf(nowMs - headline.sinceMs)}` : ''
// Elapsed time updated every TICK_MS=1000, color changes per phase
```

### Worker row (whats-agent-doing:658-663)
```jsx
<Box key={`agent-${i}`} flexDirection="row">
  <Box flexShrink={0}><Text color={PHASE_COLORS.agent}>{'◆ '}</Text></Box>
  <Text bold wrap="truncate-end">{printable(agent.name, MAX_AGENT_NAME_CHARS)}</Text>
  <Text wrap="truncate-end">{` › ${printable(agent.label, MAX_LABEL_CHARS)}`}</Text>
  <Box flexShrink={0}><Text dimColor>{`  ${durationOf(nowMs - agent.sinceMs)}`}</Text></Box>
</Box>
```

### Task row with hotkeybuttons (human-in-loop:548-562)
```jsx
<Button key={`option-${i+1}`} plain hotkey={String(i+1)} label={printable(option, 60)} />
<Button key="done" plain hotkey="d" label="Done" />
<Button key="answer" plain hotkey="r" label={task.kind === 'choose' ? 'Other…' : 'Answer…'} />
<Button key="reject" plain hotkey="x" label="Reject…" />
```

## 5. Color Schemes & Glyphs

### Universal glyphs
| Glyph | Meaning | Context |
|-------|---------|---------|
| ✓ | Done / success | plan-progress, whats-agent-doing outcomes |
| ✗ | Error | whats-agent-doing outcomes |
| ⊘ | Denied / permission | whats-agent-doing outcomes |
| ■ | Interrupted | whats-agent-doing outcomes |
| ● | Working / running | whats-agent-doing, plan-progress state |
| ○ | Idle | whats-agent-doing state |
| ? | Needs input | plan-progress state |
| ! | Error state | plan-progress state |
| ☐ | Task/checkbox | human-in-loop |
| ◆ | Agent/worker | whats-agent-doing |
| ◀ / ▶ / ▾ / ▸ | Collapse/expand | whats-agent-doing, plan-progress |
| › | Turn delimiter | whats-agent-doing history |
| ∴ | Thought | whats-agent-doing history |
| ✎ | Reply written | whats-agent-doing history |
| ⇣ | Compacted | whats-agent-doing history |
| ━ / ─ | Progress bar | task-line terminal |

### Color names used
**Named colors (claude-code stdlib):**
- gray, cyan, magenta, green, blue, yellow, white, red
- dimColor (context-dependent muted text)
- backgroundColor: userMessageBackground, etc.

**Hex colors (SVG/desktop):**
- #7858CA (purple, running)
- #AD6400 (orange, needs input)
- #C5353E (red, error)
- #18883A (green, done)
- #FFFFFF (white, SVG text)
- #808080 opacity .22 (hairline divider)

---

**License summary:** task-line (MIT), plan-progress (MIT), whats-agent-doing (MIT), work-visualized (unlisted), human-in-loop (MIT), harness-scope (backend, not UI).

**Three patterns worth copying for a compact band + plan pane:**
1. **task-line's progress bar with auto-hide** — ━─ glyphs for terminal, colored Box fills for desktop, dismiss × button, timed auto-hide clock
2. **plan-progress's folding agent strips** — ▾▸ chevron toggles nested rows, STATE_GLYPH + STATE_COLOR map for state-driven rendering, Raster cells for performance
3. **whats-agent-doing's collapsible history box** — borderStyle="round" + borderColor driven by phase, KIND_MARKS + OUTCOME_MARKS for row icons, scrollable trimmed history with "… N earlier" footer
