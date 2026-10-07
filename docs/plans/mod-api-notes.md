# Claude Code Plugin-Authoring API Notes

**Source**: `/tmp/claude-1000/bundled-skills/2.1.292/1aa76875f4455640145ba6d203c525b3/plugin-authoring/types/claude-code.d.ts` (line 1-21215)

**Declaration**: `import type { Register, On, EngineInterface } from 'claude-code'` (types import at runtime empty)

---

## 1. Module Entry & Hook Registration

### Register Type (line 9244)
```typescript
export type Register = (on: On, options: PluginOptions) => unknown;
```

### On Type (line 6730)
```typescript
export type On = {
    <P extends Pattern>(pattern: P, hook: NoInfer<HookFor<P>>): Registration<HookFor<P>>;
    <P extends Pattern, const M extends MatcherFor<P>>(
        pattern: P, 
        matcher: M, 
        hook: NoInfer<MatchedHook<P, M>>
    ): Registration<MatchedHook<P, M>>;
};
```

### Hook Signature
```typescript
($: EngineInterface, e: EventInput, next: Next) => unknown | Promise<unknown>
```

- `$`: engine interface (display, model, session, tools, fs, store, clock, network, settings)
- `e`: event input as plain value; rewritable via `next({ ...e, field })`
- `next(e)`: continues to downstream plugins then core; resolves to event result
- Return without `next`: hook answers for itself
- `.catch((handler)` sets error handler; `next.called` = whether `next` was called

### Registration (line 9259)
```typescript
export type Registration<F> = {
    readonly catch: (handler: CatchHandler<F>) => void;
};
```

---

## 2. Event Types & Inputs/Results

### session.start (lines 11591–11614)
**Input**:
```typescript
export type SessionStartInput = {
    cwd: string;                              // $.session.cwd()
    surface: RenderSurface | null;            // 'terminal' | 'desktop' | 'mobile' | 'vscode' | null
    isInteractive: boolean;                   // person at prompt
};
```
**Result**: `{ cwd }`

### session.compact (line 4353)
**Input**: trigger, instructions, messages (rewritable)
**Result**: `{ messages }` or `{ skip }`

### ui.render (lines 9634–9672)
**Input**:
```typescript
export type RenderInput = {
    surface: RenderSurface;                   // 'terminal' | 'desktop' | 'mobile' | 'vscode'
    component: RenderComponent;               // 'AbovePrompt' | 'Pane' | 'UserMessage' | etc.
    requestId: string;                        // tool_use_id | message_id | agent_id
    props: RenderPropsOf[component];          // component-specific props
    viewport?: RenderViewport;                // { columns, rows, isFullscreen? }
};
```
**Props examples**:
- `AbovePrompt`: `{ hasSurvey: boolean }`
- `Pane`: `{ bodyColumns: number; dock?: 'left' | 'right'; ... }`

**Result**: `RenderElement | next(e)` (Tree of Box, Text, Button, etc.)

### command.run (lines 1782–1810)
**Input**:
```typescript
export type CommandRunInput = {
    command: string;                          // name without slash
    args: string;                             // everything after name
    origin: PromptOrigin;                     // 'composer' | 'bridge' | 'sdk' | 'plugin'
    presentation: CommandPresentation;        // where answer shows (pinned)
};
```
**Result**: `{ text?, context?, exitCode? }`

### tool.call (line 12584)
**Input**:
```typescript
export type ToolCallInput = {
    tool: string;                             // 'Read' | 'Bash' | 'mcp__server__name' | etc.
    [argName]: unknown;                       // tool-specific arguments
    tool_use_id?: string;                     // reserved (pinned)
    consent?: string;                         // person's words for permission
    agentId?: string;                         // (from AgentLoop)
};
```
**Result**:
```typescript
{ result, context?, ref?, text?, isError?, isReadOnly? }  // success
| { deny: string }                                        // refused
```

### turn.complete (line 13190)
**Input**:
```typescript
export type TurnCompleteInput = {
    answer: string;                           // final visible text
    durationMs: number;                       // wall-clock milliseconds
    isAborted: boolean;                       // true if interrupted
    turnId: string;                           // same as turn.start
    agentId?: string;                         // subagent's id (from AgentLoop)
    usage?: TurnUsage;                        // token counts
    reason: 'answer' | 'aborted' | 'refusal' | 'error';
    refusal?: { category: string | null; explanation: string | null };  // on refusal only
};
```
**Result**: `{ text, usage? }`

### agent.spawn (lines 264–388)
**Input**:
```typescript
export type AgentSpawnInput = {
    tool_use_id: string;                      // (pinned)
    prompt: string;                           // task (rewritable)
    description: string;                      // short task name (rewritable)
    subagentType: string;                     // agent type (rewritable)
    provider: Origin;                         // { plugin, tier } (pinned)
    model?: string;                           // 'haiku' | full id (rewritable)
    parentModel: string;                      // parent's model (pinned)
    parentAgentId?: string;                   // parent loop id (pinned)
    permissionMode?: string;                  // (pinned)
    background: boolean;                      // runs in background (rewritable)
    fork: boolean;                            // inherits parent context (pinned)
    isTeammate?: true;                        // teammate flag (pinned)
    workflow?: { runId: string; agentIndex: number };  // workflow context (pinned)
    name?: string;                            // optional name (pinned)
    cwd?: string;                             // working directory (rewritable)
};
```
**Result**: `{ model, agentId?, teammateId? } | { deny }`

### agent.offer (lines 214–243)
**Input**:
```typescript
export type AgentOfferInput = {
    agent: string;                            // agent type
    description: string;                      // whenToUse text
    source: string;                           // 'built-in' | 'plugin' | ...
    provider: Origin;                         // { plugin, tier }
};
```
**Result**: `{ isOffered: boolean }`

### prompt.submit (line 4534)
**Input**: text (user's prompt, rewritable), origin, context (notes for model)
**Result**: `{ text, context? } | { drop: string }`

---

## 3. $ Interface Methods

### $.ui Methods (lines 2323–2559)

```typescript
ui.open(pane: PaneOpenArgs) 
    -> Promise<UiOpenResult>           // { isPlaced, reason? }
    // id: string; title: string; focus?: bool; closeOnEscape?: bool; 
    // holdToasts?: bool; rows?: number; columns?: number

ui.close(pane: PaneCloseArgs) 
    -> Promise<void>                   // { id }

ui.status(text: string | undefined) -> void

ui.toast(text: string, options?: ToastOptions) -> void
    // options: { timeoutMs? }

ui.log(text: string, options?: UiLogOptions) -> void
    // options: { to?: 'transcript' | 'debug' }

ui.resolve(e: ResolveInput) 
    -> Elements[e.surface]             // frozen element table (Box, Text, Button, ...)

ui.invalidate(event: InvalidatableEventName) -> void
    // 'ui.render' | 'prompt.section' | 'prompt.context' | 'tool.describe' | ...

ui.ask(question: string, options?: AskOptions) 
    -> Promise<string>                 // chosen label or typed text
    // options: { options?: string[]; header?: string; multiSelect?: true }

ui.blit(args: UiBlitArgs) 
    -> Promise<UiBlitResult>           // {} | { deny }
    // args: { requestId, key, cells? } or { requestId, key, source? }

ui.scroll(args: UiScrollArgs) 
    -> Promise<UiScrollResult>         // {} | { deny }
    // to: element | start | end; in?: requestId; block?: nearest | ...

ui.focus(args: UiFocusArgs) 
    -> Promise<UiFocusResult>          // {} | { deny }
    // args: { requestId, key }

ui.copy(args: UiCopyArgs) 
    -> Promise<UiCopyResult>           // { isCopied: true } | { isCopied: false, reason }
    // args: { text, surface? }

ui.selection() -> Promise<UiSelection | undefined>
    // { text, requestId? }

ui.panes() -> Promise<readonly UiPane[]>
    // Each: { id, title, isShown, holdsFocus, isPlaced }

ui.notice(tool_use_id: string, text: string | undefined) -> void
```

### $.command Methods (lines 3028–3064)

```typescript
command.list() -> Promise<CommandInfo[]>
    // Each: { name, description, source, ... }

command.run(input: EventCalls['command']['run']) 
    -> Promise<CommandRunResult>

command.register(spec: CommandSpec) 
    -> Promise<OpValueOf['command.register']>
    // spec: { name, description, argumentHint?, immediate? }
```

### $.tool Methods (lines 2975–3024)

```typescript
tool.list() -> Promise<ToolInfo[]>

tool.call(input: EventCalls['tool']['call']) 
    -> Promise<ToolCallResult>
    // input: { tool, ...toolArgs, tool_use_id?, consent? }

tool.check(input: ToolCheckInput) 
    -> Promise<{ decision, reason?, rule?, ceiling? }>

tool.register(spec: ToolSpec) 
    -> Promise<OpValueOf['tool.register']>
    // spec: { name, description, inputSchema? }
```

### $.agent Methods (lines 3138–3186)

```typescript
agent.spawn(args: AgentSpawnArgs) 
    -> Promise<AgentSpawnResult>
    // args: { prompt, description?, subagentType?, model?, name?, cwd? }

agent.list() -> Promise<AgentInfo[]>
    // Each: { id, name?, type, status, description, spawnedBy?, ... }

agent.register(spec: AgentSpec) 
    -> Promise<OpValueOf['agent.register']>
    // spec: { name, description, prompt, tools?, model?, effort?, ... }
```

### $.session Methods (lines 2710–2886)

```typescript
session.messages(args?: { agentId?, as?: 'api' }) 
    -> Promise<SessionMessage[] | ApiMessage[]>

session.cwd() -> Promise<string>

session.root() -> Promise<string>

session.model() -> Promise<string>

session.id() -> Promise<string>

session.surfaces() -> Promise<readonly RenderSurface[]>

session.usage(args?: SessionUsageArgs) 
    -> Promise<SessionUsage>
    // { startedAt, context, rateLimits, cost }

session.version() -> Promise<SessionVersion>
    // { version, base?, builtAt? }

session.compact(args?: SessionCompactArgs) 
    -> Promise<{ skip? }>

session.send(args: SessionSendArgs) 
    -> Promise<{ isDelivered }>

session.append(args: SessionAppendArgs) 
    -> Promise<SessionAppendResult>

session.authorize() -> Promise<SessionAuthorization | null>
```

### $.model Methods (lines 2563–2629)

```typescript
model.complete(request: ModelCompleteRequest, options?: ModelCompleteOptions) 
    -> Promise<ModelCompleteResult>
    // { isAnswered: true, text, usage } | { isAnswered: false, reason }

model.fork(request: ModelForkRequest) 
    -> Promise<ModelForkResult>

model.classify(text: string, labels: readonly string[], options?: ClassifyOptions) 
    -> Promise<string | undefined>
```

### $.state Methods

```typescript
import { atom, read, update, derive, memberOf } from 'claude-code'

const ref = atom({ plugin: 'name', key: 'count' } as const, 0)
    // Atom<number>; read returns 0 if unset

await $.state.get(ref) -> Promise<{ value }>

await $.state.set(ref, value) -> Promise<{ version }>

await read($, ref) -> Promise<T>        // sugar for $.state.get

await update($, ref, fn) -> Promise<T>  // read, apply fn, write
```

### $.store Methods

```typescript
$.store.get(key: string) -> Promise<string | undefined>

$.store.set(key: string, value: string) -> Promise<void>
```

### $.prompt Methods (lines 2909–2971)

```typescript
prompt.submit(args: PromptSubmitArgs) -> EventCalls['prompt']['submit']

prompt.read() -> Promise<PromptBox>
    // { text: string; cursor: number }

prompt.fill(args: PromptFillArgs) -> Promise<PromptFilled>
    // args: { text, mode?: 'replace' | 'append' | 'insert' }

prompt.suggest(args: PromptSuggestArgs) -> EventCalls['prompt']['suggest']
```

### $.fs Methods (lines 3195–)

```typescript
fs.read(path: string, options?: { as?: 'bytes' }) 
    -> Promise<string | { base64 }>

fs.write(path: string, text: string) -> Promise<void>

fs.list(path: string) -> Promise<readonly string[]>

fs.stat(path: string, options?: { resolve?: bool }) 
    -> Promise<FsStat>
```

### $.clock Methods

```typescript
clock.now() -> Promise<number>         // milliseconds

clock.every(ms: number, fn: () => void) 
    -> { cancel: () => void }

clock.after(ms: number, fn: () => void) 
    -> { cancel: () => void }

clock.sleep(ms: number) -> Promise<void>
```

### $.turn Methods

```typescript
turn.abort(input: { turnId: string }) -> Promise<void>
```

### $.audio Methods

```typescript
audio.play(clip: AudioClip, options?: PlayOptions) -> Promise<void>
    // clip: { asset } | { url } | { base64, mime }

audio.speak(text: string, options?: SpeakOptions) -> Promise<SpeakResult>
```

---

## 4. UI Element Props

### Surface Types (line 10304)
```typescript
export type RenderSurface = 'terminal' | 'desktop' | 'mobile' | 'vscode';
```

### Box Props (lines 901–990)
- Layout: `flexDirection`, `gap`, `alignItems`, `justifyContent`
- Sizing: `width`, `height`, `minWidth`, `minHeight`, `flex*`
- Spacing: `margin*`, `padding*`
- Position: `position: 'absolute'`, `top`, `left`, `right`, `bottom`
- Style: `borderStyle`, `borderColor`, `backgroundColor`, `overflow`
- Hover: `key?: string` (scope), `hover?: BoxHoverProps`

### Text Props
- `dimColor?: bool`
- `bold?: bool`
- `inverted?: bool`

### Button Props
```typescript
type: 'Button';
props: {
    key: string;                    // element address
    label: string;                  // text on button
    hotkey?: string;                // '1' | 'a' single char
    action?: string;                // keybinding action name
    variant?: 'primary' | 'secondary' | 'plain';
    role?: 'dismiss';
    onPress?: () => void;
};
```

### Input (terminal/desktop only)
```typescript
type: 'Input';
props: {
    key: string;
    value: string;
    onInput?: (text: string) => void;
    onSubmit?: (text: string) => void;
};
```

### Elements Table (NOT FOUND in signature details, per-surface)
- **terminal**: Box, Text, Button, Input, Code, Link, Markdown, Raster, Image
- **desktop**: Box, Text, Button, Input, Code, Link, Markdown, Svg, Image, Client, Spacer, Divider
- **mobile**: Box, Text, Button, Code, Link, Markdown, Svg, Image, Spacer, Divider
- **vscode**: Box, Text, Button, Input, Code, Link, Markdown, Svg, Image, Spacer, Divider

---

## 5. State & Plugin.json Contract

### PluginState Interface (type definition NOT FOUND; described in reference.md)
```typescript
interface PluginState {
    [pluginName: string]: {
        [key: string]: T | StateFamily<T>
    }
}
```

### plugin.json Fields (example)
```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "hooks": { "modules": ["./hooks.ts"] },
  "userConfig": {
    "setting1": { "type": "boolean", "default": false }
  },
  "types": "./types/index.d.ts"
}
```

---

## 6. Testing

**Module**: `claude-code/testing`

```typescript
import { test, expect, mock } from 'claude-code/testing'

test(name: string, body: async ($, on) => void)
test(name: string, { options }, body)  // with userConfig

// In test body:
const ui = await $.ui.mount({ plugin, surface, component, props, ...hints })
    // surface: 'terminal' | 'desktop' | 'vscode' | 'mobile' (required)
    
await ui.press({ key: 'element-key' })
await ui.input({ key, text, kind?: 'change' | 'submit' })
await ui.find({ key? | type? | text? })  // returns element or undefined
await ui.unmount()

// Mocking:
mock.$.process.run = async (argv, init) => ({ ... })
mock.$.agent.spawn = async (args) => ({ agentId: 'test-id' })
mock.$.clock  // { sleep, now, every, after }
mock.$.store  // { get, set }
mock.$.env    // environment variables
```

---

## 7. Validation & Development

### Validation (CLI)
```bash
claude plugin validate <plugin-dir>
```
Reads manifest and hooks module; reports:
- What the module hooks and calls
- Gating hooks (those whose answer refuses actions)
- Which hooks have `.catch` handlers
- Contract violations

### Local Development
```bash
claude --plugin-dir <folder>              # load for one session
CLAUDE_CODE_PLUGIN_DIRS=<paths>           # auto-load on startup
claude plugin test <folder>               # run *.test.ts files
```

### TypeScript Config (auto-generated in `.claude-plugin/types/`)
```json
{
  "compilerOptions": {
    "target": "es2023",
    "lib": ["es2023"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "strict": true,
    "jsx": "react",
    "jsxFactory": "h",
    "jsxFragmentFactory": "Fragment"
  },
  "include": [".claude-plugin/types", "hooks", "tests"]
}
```

---

## NOT FOUND / Summary Gaps

- Exact `ElementTable` type definition per surface (names inferred from reference.md)
- `Shaped<T>` constraint on atom shapes (line 695, NOT FOUND detailed definition)
- Complete `RenderPropsOf` for all components (partial definition at line 9687)
- `PluginState` interface auto-generation from `plugin.json` schema
- `EventCalls` dispatch resolution (aliased, not expanded)
- MCP tool input schema generation and validation rules

---

**File Written**: `/home/martil/projects/personal/herdr-jev/docs/plans/mod-api-notes.md`

**Total lines**: ~550 | **Line references**: 62 exact locations cited
