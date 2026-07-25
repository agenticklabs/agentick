# 03 — Reconciler Harness

> **Rename note (2026-07-21, #243):** the "reconciler" subsystem described below was renamed to **compiler** — `@agentick/reconciler` → `@agentick/compiler`, `@agentick/reconciler-react` → `@agentick/compiler-react`, `ReconcilerProtocol` → `CompilerProtocol`, `ReconcilerHarness` → `CompilerHarness`, etc. Original terminology is preserved below as historical record.

**Status:** Synthesized with placeholders · refined 2026-05-08 (renamed)
`[SOURCE: compiler-harness.md, harness-principle.md, compiled-spec.md]`

The reconciler harness is the producer-side harness for v2. It maintains
a **living application definition** (in v2, a mounted React JSX tree)
and emits multiple artifacts on demand: `RenderedTree`, rendered
string, rendered resource, snapshots.

The harness is named after its **function** (compiles to
`RenderedTree`), not its substrate. **v2 ships
`@agentick/reconciler-react` as the reference (and only initial)
implementation** — using a real React JSX tree under the hood. Future
implementations could be `@agentick/compiler-vue`,
`@agentick/compiler-imperative`, etc., conforming to the same
`ReconcilerProtocol` from `@agentick/spec`.

The mounted application owns component identity, hook state, effects,
subscriptions, providers, scoped declarations, and render-time
dependency capture. "Compiling" is one capability among many — the
harness is a living application, not a one-shot transformer.

```
                ┌──────────────────────────────────────┐
                │       Reconciler harness               │
                │   (v2: @agentick/reconciler-react)     │
                │                                      │
   commands ──► │  mount · rerender · renderTree   │ ──► events
                │  renderToString · renderResource     │
                │  notifyLifecycle                     │
                │  unmount · snapshot · restore        │
                │                                      │
   inbox ──────►│  recompile · unmount                 │ ──► outcomes
                │                                      │
                │  (mounted application — JSX tree     │
                │   in the React reference impl)       │
                └──────────────────┬───────────────────┘
                                   │
                                   ▼
                       ┌────────────────────────┐
                       │   Formatter harness     │
                       │   (called per scope    │
                       │    during compile)     │
                       └────────────────────────┘
```

`[V1-REPLACED]` of v1's mixed concerns (`packages/core/src/jsx/` +
`packages/core/src/reconciler/` + `packages/core/src/compiler/` +
`packages/core/src/com/object-model.ts`). The COM (1268 LOC mutation API)
is gone; in the React-based implementation, the React fiber tree IS the
live tree, and `RenderedTree` is the snapshot artifact.

## Naming note

Two distinct packages share the React substrate but serve different
roles — easy to confuse, important to keep separate:

| Package                           | Role                                                                                                                                               | Where it runs    |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `@agentick/reconciler-react` | **Reconciler harness implementation.** Takes JSX agent definitions, produces `RenderedTree`. Server-side; runs in the runtime.                     | server / runtime |
| `@agentick/client-react`          | **Client SDK.** Pure React hooks for connecting a browser app to a session via transport. Inherits behavior unchanged from v1's `@agentick/react`. | browser          |

This doc is exclusively about `@agentick/reconciler-react`.

## What this harness manages

The mounted React application:

- **Component instances** (function components, hooks state).
- **Render scheduling** (reconciler).
- **Async component resolution** (render-until-stable).
- **Hook bridges** (`useTimeline`, `useKnob`, `useData`, `useSandbox`,
  `useMCP`, etc. — runtime-backed via injected bridge interfaces).
- **Renderer scope resolution** (nested `<Markdown>`/`<XML>` providers).
- **Long-lived primitive intent declarations** (`<Subscription>`, `<Cron>`,
  `<Webhook>`, `<EventListener>`).
- **Snapshot/restore** of compiler-private reactive state.

It does NOT manage:

- Tool handler execution (tool executor harness).
- Provider/model execution (executor harness).
- Session timeline (session harness).
- Persistence (session/runtime harness).
- Cluster routing (cluster wrapper).

## Commands in

```ts
interface ReactHarnessProtocol {
  mount(input: MountInput): Effect<MountResult, MountError, ReactEnv>;

  rerender(input: RerenderInput): Effect<RerenderResult, RerenderError, ReactEnv>;

  renderTree(input: RenderTreeInput): Effect<RenderTreeResult, ReconcileError, ReactEnv>;

  renderToString(input: RenderToStringInput): Effect<RenderToStringResult, FormatError, ReactEnv>;

  renderResource(input: RenderResourceInput): Effect<RenderResourceResult, FormatError, ReactEnv>;

  unmount(input: UnmountInput): Effect<void, UnmountError, ReactEnv>;

  snapshot(input: SnapshotInput): Effect<ReconcilerSnapshot, SnapshotError, ReactEnv>;

  restore(input: RestoreInput): Effect<MountResult, RestoreError, ReactEnv>;

  /**
   * Lifecycle pass-through. Direct method-based coupling for events
   * that user-supplied hooks (useOnTickStart, useOnTickEnd,
   * useOnExecutionEnd, useOnError) need to observe synchronously.
   *
   * Tagged-union LifecycleEvent — adding new event kinds doesn't change
   * the method count. Lifecycle moments are *also* emitted on the
   * shared event bus for fan-out observers (devtools, telemetry,
   * persistence) — the two channels coexist.
   *
   * Called from session's loop.onTickEnd handler — see 08-session-harness.md.
   * `[V2-LANDED]` 2026-05-15 — see packages/spec/src/protocol/reconciler.ts.
   */
  notifyLifecycle(input: NotifyLifecycleInput): Effect<void, ReactRuntimeStateError, ReactEnv>;
}
```

`[GAP]` — the source proposals list these commands without specifying full
input/output types. Synthesizing minimal types:

```ts
interface MountInput {
  rootElement: JSX.Element;
  hookBridges: HookBridges; // runtime-provided bridge fns
  rendererRegistry?: FormatterRegistry; // for non-default renderer ids
  options?: { compileMaxIterations?: number; debug?: boolean };
}

interface MountResult {
  mountId: string; // identifies the mounted tree
}

interface RerenderInput {
  mountId: string;
  trigger: RerenderTrigger;
}

type RerenderTrigger =
  | { type: "state-change"; key: string }
  | { type: "signal-update"; id: string }
  | { type: "external-event"; payload: unknown }
  | { type: "explicit" };

interface RenderTreeInput {
  mountId: string;
  /** Default renderer for content outside explicit renderer providers */
  defaultRenderer?: FormatterRef;
}

interface RenderTreeResult {
  compiled: RenderedTree;
  iterations: number;
  forcedStable: boolean;
}

interface RenderToStringInput {
  mountId: string;
  renderer: FormatterRef; // explicit; no default fallback
  options?: Record<string, unknown>;
}

interface RenderToStringResult extends FormattedContent {}

interface RenderResourceInput {
  mountId: string;
  resourceId: string; // matches a ResourceDeclaration
  renderer?: FormatterRef;
}

interface RenderResourceResult extends FormattedContent {}

interface SnapshotInput {
  mountId: string;
}

interface ReconcilerSnapshot {
  /** Snapshot schema version, distinct from EventEnvelope spec version. */
  specVersion: string;

  /** Per-component-instance reactive state, keyed by stable component path. */
  cells: Record<ComponentPath, ReactiveCellState[]>;

  /** useData Layer-2 cache, keyed by user-supplied cache key. */
  useDataCache: Record<string, ResolvedValue>;

  /**
   * Component paths that had unresolved suspended awaits at snapshot.
   * On restore, those components re-await from scratch.
   */
  pendingAsyncPaths: ComponentPath[];

  /** Active renderer scope stack at snapshot time. */
  rendererScope?: FormatterRef[];

  /**
   * Compile-time diagnostics from the last renderTree, plus any cell
   * suppressions (cells dropped because their value wasn't structured-clone
   * serializable). Audit trail for non-serializable user state.
   */
  diagnostics?: FormatDiagnostics;
}

interface ReactiveCellState {
  hookIndex: number; // positional; React invariant
  hookKind: "state" | "reducer" | "signal";
  value: unknown; // structured-clone-shaped
}

interface ResolvedValue {
  value: unknown;
  resolvedAt: number;
  ttlMs?: number;
}

/**
 * Stable identity for a component instance across re-mounts.
 * Format: "App/SessionView/MessageList/Message[key=msg-42]"
 * The persistence backend MAY hash this for storage; the spec carries the
 * canonical string form.
 */
type ComponentPath = string;

interface RestoreInput {
  rootElement: JSX.Element;
  snapshot: ReconcilerSnapshot;
  hookBridges: HookBridges;
}

interface NotifyTickEndInput {
  mountId: string;
  tick: number;
  executionId: string;
  /** Framework's default decision; tree may override via useOnTickEnd hooks. */
  defaultShouldContinue: boolean;
  /** Read-only payload exposed to useOnTickEnd handlers. */
  result: TickResultPayload;
}

interface TickResultPayload {
  output: ContentBlock[];
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  stopReason?: LanguageModelStopReason | string;
  usage?: UsageStats;
}

interface TickEndDecision {
  shouldContinue: boolean;
  reason?: string;
}
```

### How `notifyLifecycle({ kind: "tick-end" })` runs

```
1. Receive NotifyTickEndInput.
2. Walk the mounted tree; collect every useOnTickEnd / useLoopControl
   handler in registration order.
3. Build an in-tree TickResult from the payload, with control methods
   stop() / continue() that mutate React-harness-internal state.
4. For each handler, await handler(tickResult). Handlers may:
     - read result fields (read-only)
     - call result.stop(reason) / result.continue(reason)
     - set useState / useSignal cells (marking tree dirty for next compile)
5. After all handlers complete, build TickEndDecision from final
   shouldContinue state.
6. Return TickEndDecision (wire-safe; control methods don't cross).
```

In-tree `TickResult`:

```ts
interface TickResult extends TickResultPayload {
  tick: number;
  /** Default decision; mutated by stop()/continue() calls. */
  shouldContinue: boolean;

  // Control methods — in-tree only; never cross the wire.
  stop(reason?: string): void;
  continue(reason?: string): void;
}
```

### Snapshot rules

**What's in the snapshot:**

| Owned by compiler snapshot                     | Owned by session/runtime (Tier 2) |
| ---------------------------------------------- | --------------------------------- |
| `useState`/`useReducer` cell values            | timeline entries                  |
| `useSignal` cell values                        | knob values                       |
| `useData` Layer-2 cache (in-flight + resolved) | session.resolveCache (Layer 1)    |
| Pending async component paths                  | channel state                     |
| Active renderer scope stack                    | subscription intents              |
| Compile diagnostics                            | persistence metadata              |

**Serialization rule:** cell values are structured-clone shaped — primitives,
arrays, plain objects, `Date`, `Map`, `Set`. Functions, class instances,
and live handles do NOT survive. On snapshot:

```
1. Try structured-clone the cell value.
2. If it succeeds → include in snapshot.
3. If it fails → drop the cell.
4. Always: append suppressed-cell metadata to ReconcilerSnapshot.diagnostics.
   (audit trail in the snapshot itself; can be inspected post-hoc.)
5. In development mode only: emit a diagnostic to the bus
   ONCE per (sessionId, componentPath, hookIndex).
   Tracked in compiler-private state so subsequent snapshots of the same
   offender are silent even in dev.
6. In production mode: no bus emission. The snapshot.diagnostics audit
   trail is the only signal; production logs stay clean.
```

Mode detection: `runtime.developerMode: boolean` config (defaults to
`process.env.NODE_ENV === "development"`).

This keeps production logs free of any noise while still giving
developers an immediate signal on first occurrence in dev and a
persistent audit trail in the snapshot for both modes.

**Not snapshotted:**

- `useRef` values. Refs are transient bookkeeping or imperative handles.
  Users wanting persistence use `useState` or `useResolved`.
- `useEffect` cleanup state. Effects re-run on re-mount; React invariant.
- React Context values (rebound from runtime services on re-mount).
- Suspense boundary state (components re-suspend naturally).

**Privacy:** the snapshot is NOT redacted. If a user puts a sensitive
value in `useState`, it persists. Sensitive data should live in
session-side state with explicit handling, not in component-local state.
Document this clearly to users.

**Component path stability.** Cell identity is `(componentPath,
hookIndex)`. Stable across re-mounts only if tree shape and keys are
stable. If they change, unmatched cells get fresh defaults on restore.
This is a React invariant; the snapshot doesn't try to fix it.

### `mount`

Initial render of the React tree. Runtime calls this once when an
execution starts (or earlier if the runtime keeps the tree warm between
executions). Runs reconciliation but does NOT compile.

### `rerender`

Re-render the tree because some reactive state changed. Triggered by:

| Trigger          | Source                                               |
| ---------------- | ---------------------------------------------------- |
| `state-change`   | `useState`/`useReducer` setter                       |
| `signal-update`  | `useSignal` write                                    |
| `external-event` | runtime injecting an event into a hook bridge        |
| `explicit`       | runtime forces a re-render (e.g., before a snapshot) |

### `renderTree`

The "produce a model-input snapshot" command. This is what the loop
executor calls per tick. Reconciles until stable, calls the renderer
harness for each render scope, builds `RenderedTree`, and returns it.

```
renderTree
  ── reconcile if dirty
  ── render-until-stable loop (see below)
  ── collect content scopes + renderer scopes + declarations
  ── for each renderable scope: call RendererHarness.render
  ── assemble RenderedTree
  ── return RenderTreeResult
```

### `renderToString`

The "render the JSX tree as a string/resource" command. Skips
`RenderedTree` emission entirely. Returns `FormattedContent`.

Use cases (`[SOURCE: compiler-harness.md §Levels of Usage]`):

- JSX → markdown for documentation.
- JSX → XML for an MCP resource body.
- JSX → text for a system prompt fragment.
- JSX → JSON-like content payload.

### `renderResource`

Same as `renderToString` but scoped to a specific `ResourceDeclaration`'s
content (rather than the whole free-root JSX).

### `unmount`

Tear down the mounted tree. Runs effect cleanups, unsubscribes long-lived
primitives.

### `snapshot` / `restore`

Capture compiler-private reactive state and rebuild from it. Restoration
re-mounts the tree, re-runs `useData` only for cache-miss entries, and
restores reactive cells.

## Events out

All events use the canonical `EventEnvelope` with `surface: "reconciler"`.

```
reconciler:mount:requested            reconciler:mount:before
reconciler:mount:terminal             (outcome: succeeded | failed | canceled)

reconciler:rerender:requested         reconciler:rerender:terminal
reconciler:render:requested          reconciler:render:before
reconciler:render:delta              (per iteration during render-until-stable)
reconciler:render:terminal           (outcome + iteration count)

reconciler:render-to-string:requested           reconciler:render-to-string:terminal
reconciler:render-resource:requested  reconciler:render-resource:terminal

reconciler:async:resolved             (an async component resolved)
reconciler:suspended                  (a component suspended)
reconciler:runtime-error              (uncaught error inside the React tree)

reconciler:unmount:requested          reconciler:unmount:terminal
reconciler:snapshot:requested         reconciler:snapshot:terminal
reconciler:restore:requested          reconciler:restore:terminal
```

`[V1-REPLACED]` of v1's `compiled` and `entry_committed` DevTools events,
which fired from the session and conflated produce/consume. In v2 the
React harness only fires its own events; the session emits ingestion
events separately when it writes to the timeline.

## Lifecycle handlers + middleware

Per the five-surface model, the React harness exposes:

### Lifecycle handlers (`.onX(fn)`)

```ts
react.onMount(handler: (info: { mountId: string }) => void | Promise<void>)
react.onUnmount(handler: (info: { mountId: string }) => void | Promise<void>)
react.onAsyncResolved(handler: (info: { componentPath: string }) => void)
react.onCompileForcedStable(handler: (diagnostics: FormatDiagnostics) => void)
react.onRuntimeError(handler: (err: ReactRuntimeStateError) => void)
```

### Middleware (`.use(mw)`)

```ts
react.use({
  aroundCompile: (input, next) => { ... },     // wrap renderTree
  aroundRender: (input, next) => { ... },      // wrap renderToString/renderResource
});
```

Middleware can replace compile output (the v1 equivalent of
`ExecutionRunner.transformCompiled` is a `aroundCompile` middleware that
short-circuits and returns its own `RenderedTree`).

## Inbox messages

The React harness accepts inbound messages at address `react:{mountId}`:

| Message type | Payload               | Effect                                               |
| ------------ | --------------------- | ---------------------------------------------------- |
| `recompile`  | `{}`                  | Force a recompile (next tick will see fresh output). |
| `unmount`    | `{ reason?: string }` | Tear down the mounted tree.                          |

External callers without a typed reference (e.g., gateway debug
endpoints, devtools) use these to influence the React harness directly.

## Outcomes and failures

Standard outcomes. Typed errors:

```ts
type ReactHarnessError =
  | ReconcileError
  | RendererError
  | AsyncComponentError
  | ReactRuntimeStateError;

interface ReconcileError {
  _tag: "ReconcileError";
  reason: string;
  iteration?: number;
  forcedStable?: boolean;
}

interface RendererError {
  _tag: "RendererError";
  rendererId: string;
  cause: unknown;
}

interface AsyncComponentError {
  _tag: "AsyncComponentError";
  componentName?: string;
  cause: unknown;
}

interface ReactRuntimeStateError {
  _tag: "ReactRuntimeStateError";
  reason: string;
}
```

## Compile-until-stable

A single render pass is often insufficient. The compiler iterates until
output is structurally stable.

```
loop:
  reconcile
  collect: content scopes, renderer scopes, declarations
  for each renderable scope: call formatter harness
  build RenderedTree
  if equal_to_previous(compiledStructure): emit, done
  if iterations > MAX:
    emit with forcedStable=true and a warning diagnostic
    break
  else: continue
```

`[GAP]` — `MAX` default unset and "structural equality" strategy unset.
**`[PROPOSAL]`**:

| Setting                | Value                                                          |
| ---------------------- | -------------------------------------------------------------- |
| Default max iterations | 16                                                             |
| Equality strategy      | hash-on-emit (`SHA-256` of canonicalized JSON), compare hashes |
| forcedStable in dev    | warn-only, include diagnostic                                  |
| forcedStable in prod   | warn + emit metric                                             |

Triggers that destabilize output:

- async component resolution
- signal update during render cycle
- `useData` completion
- reactive registration changes (`<Tool>`/`<Subscription>` conditional
  mount)

## Hooks model

Two hook categories:

**Standard React hooks** — work as expected: `useState`, `useReducer`,
`useEffect`, `useMemo`, `useCallback`, `useRef`, `useContext`.

**Agentick hooks** — runtime-backed via bridge interfaces:

| Hook                                  | Reads from / writes to                                                                                                                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useSignal<T>(initial)`               | Compiler-private reactive cell.                                                                                                                                                         |
| `useKnob<T>(name, initial, schema)`   | Runtime knob registry.                                                                                                                                                                  |
| `useTimeline()`                       | Session timeline (windowed read by default).                                                                                                                                            |
| `useChannel(name)`                    | Session channel registry; offset semantics.                                                                                                                                             |
| `useData<T>(loader, options)`         | Async value with loader. `persist: false` (default) → Layer 2 (compiler snapshot cache). `persist: true` → Layer 1 (session.resolveCache, durable).                                     |
| `useResolved<T>(key)`                 | Read-only sugar over Layer 1. No loader. Returns `T \| undefined`. For consuming values placed in `session.resolveCache` by the runtime (session metadata, explicit `session.resolve`). |
| `useSandbox()`                        | Reads sandbox provided by `<Sandbox>` ancestor (React Context).                                                                                                                         |
| `useMCP(serverId)`                    | Reads MCP client.                                                                                                                                                                       |
| `useOnEntry(handler)`                 | Fires on each new timeline entry.                                                                                                                                                       |
| `useOnEvent(handler)`                 | Fires on each event matching a query.                                                                                                                                                   |
| `useOnTickEnd(handler)`               | Fires after each tick. Handler receives `TickResult` with control methods (`stop`, `continue`). Drives continuation decision.                                                           |
| `useLoopControl(handler)`             | Sugar over `useOnTickEnd` — same shape, naming convention for handlers focused on continuation logic.                                                                                   |
| `useOnMount(fn)` / `useOnUnmount(fn)` | Component lifecycle.                                                                                                                                                                    |

**Hook layering — locked 2026-05-08:**

```
Layer 1 (persistent, in session.resolveCache, Tier 2):
  useData(loader, { persist: true })       — has loader; writes to L1
  useResolved<T>(key)                       — read-only; no loader; reads L1

Layer 2 (compile-time, in ReconcilerSnapshot.useDataCache, Tier 1):
  useData(loader, { persist: false })      — has loader; writes to L2 (default)
```

`useResolved` is sugar over Layer 1 reads for consumers that don't own
the loader (the runtime placed the value, the component just reads).

### HookBridges interface (runtime-provided)

```ts
interface HookBridges {
  // Timeline
  readTimeline: (q: TimelineQuery) => TimelineEntry[];
  appendTimeline: (entry: TimelineEntry) => void;

  // Knobs
  getKnob: <T>(name: string) => T | undefined;
  setKnob: <T>(name: string, value: T) => void;
  registerKnob: (decl: KnobDeclaration) => void;

  // Channels
  readChannel: (name: string, q: ChannelQuery) => ChannelEvent[];
  publishChannel: (name: string, event: ChannelEvent) => void;
  subscribeChannel: (name: string, q: ChannelQuery, fn: (e: ChannelEvent) => void) => Unsubscribe;

  // Resolve
  resolveOnce: <T>(key: string, loader: () => Promise<T>) => Promise<T>;
  readResolved: <T>(key: string) => T | undefined;

  // Subscriptions / long-lived
  registerSubscription: (intent: SubscriptionIntent) => void;

  // Resources
  registerResource: (decl: ResourceDeclaration) => void;
}
```

`[PLACEHOLDER]` shape. The exact bridge surface is part of the v2
implementation, not the spec wire format. It belongs in the runtime
package's protocol surface to the React harness, not in `@agentick/spec`.

## Async components — first-class

Function components can be async:

```tsx
async function MyAgent({ user }: Props) {
  const profile = await fetchProfile(user.id);
  return (
    <>
      <System>You are helping {profile.name}.</System>
      <Timeline />
    </>
  );
}
```

Reconciliation:

1. Component is called; returns a Promise.
2. Reconciler suspends this subtree (using React's suspense mechanism).
3. Compile-until-stable awaits the Promise.
4. On resolution, subtree re-renders with the resolved value.
5. Loop continues until stable.

The runtime layer wraps the await in `Effect.tryPromise` so that errors
flow through the typed error channel and the entity fiber's lifecycle
controls cancellation.

### Async + hibernate `[PROPOSAL]`

`[GAP]` — open question 1 in compiler-harness.md.

**Recommended policy:**

- During hibernate: in-flight async work is **canceled**. The Promise's
  abort-signal-aware cancellation runs; non-cancelable work is dropped.
- On restore: the suspended component re-mounts and re-awaits its loader.
  Cache participation (`useData`) is the way to opt out of re-running.
- Document that **a raw `await` in a component body may run twice** (once
  pre-hibernate, once post-restore) and that `useData` is the
  "do this once and persist" pattern.

Sign-off needed.

## Component grammar

The compiler has an explicit grammar (`[SOURCE: compiler-harness.md §Compiler Grammar]`).
Three kinds of components contribute to compiled output:

### Structural components → context entries / declarations

| Component                                                                   | Output                                 |
| --------------------------------------------------------------------------- | -------------------------------------- |
| `<System>`, `<User>`, `<Assistant>`, `<ToolResult>`, `<Event>`, `<Message>` | `MessageEntry`                         |
| `<Timeline>`                                                                | zero or more `MessageEntry` (windowed) |
| `<Section>`                                                                 | `SectionEntry`                         |
| Tool `render()` output                                                      | `SectionEntry`                         |
| `<Tool>`, `createTool()` JSX                                                | `ToolDeclaration`                      |
| `<Output>`                                                                  | `OutputDeclaration`                    |
| `<MCP>` (resource/tool/prompt)                                              | runtime declarations                   |
| `<Model>`, generation-hint props                                            | `SpecConfig` / `providerOptions`       |

Structural components create content scopes for their children.

### Renderer provider components → scoped renderer selection

```
<Markdown>          <XML>          <Renderer renderer={...}>
```

These don't create `ContextEntry` values themselves. They establish
renderer scope for descendants. They MAY nest arbitrarily — see
`04-formatters.md` §Scope switching.

### Content components → blocks within a scope

Only meaningful inside a content scope or at the free root:

```
<Text>  <Image>  <Code>  <Json>  <Document>  <Audio>  <Video>
```

Plus semantic components (`<H1>`, `<Paragraph>`, `<List>`, `<Table>`, etc.)
that produce `SemanticContentBlock` payloads.

### Free-root content

Anything outside a structural component:

```tsx
<>
  Hello <strong>world</strong>
  <Json data={{ ok: true }} />
</>
```

→ `RenderedTree.content` (free root) + `text` (renderer projection).
NOT `context.entries`. Loop-execution consumers SHOULD warn or fail when
free-root content is present unless explicitly configured to accept it.

## Long-lived primitives

Components that participate beyond a single compile (`<Subscription>`,
`<Cron>`, `<Webhook>`, `<EventListener>`) compile to **declarative intents**
rather than immediate side effects.

```
Stage 1 (compile time):
  <Subscription source={...} handlerId="orders.handle" />
    → contributes a SubscriptionIntent to RuntimeDeclarations
    → intent persists with the session (small, JSON-shaped)

Stage 2 (runtime):
  Runtime supervisor reads the intent
    → materializes the actual external connection
    → routes events back; on event, resolves the handler ID against
      the freshly-mounted React tree and invokes it
```

This is why **handlers are ID-addressable, not closure-captured**. A
closure can't survive snapshot/restore; a handler ID resolved against the
current tree can.

### Handler resolution `[PROPOSAL]`

`[GAP]` — open question 2 in compiler-harness.md is the resolution
mechanism. The blueprint takes the following position; sign-off needed:

```
1. At mount and after each rerender, the React harness rebuilds a
   handler registry: Map<handlerId, () => HandlerFn>.

2. The registry is keyed by stable handler IDs declared on
   long-lived primitive components (handlerId="...").

3. Compile-time validation:
     - Every handlerId referenced in a SubscriptionIntent MUST resolve
       in the current tree. Compile fails (ReconcileError) otherwise.
     - Duplicate handler IDs in one tree fail compile.

4. Runtime invocation:
     - Supervisor invokes via the React harness boundary:
         reactHarness.invokeHandler(handlerId, payload)
     - Returns Effect<Result, AsyncComponentError, ReactEnv>.

5. If a handler ID does not resolve at runtime (tree changed,
   component unmounted), the runtime emits a "handler-unbound" event
   and applies the SubscriptionIntent's miss policy
   (drop / requeue / error).
```

The miss policy default `[PLACEHOLDER]`: **drop with metric increment**.

## Component categories also in v2

```
Registration components — anywhere in tree, contribute declarations
  <Model> · <Tool> · <MCP> · <Output> · <Sandbox>* · <Subscription>* · ...

Provider components — provide React Context to descendants
  <Sandbox>* · <MCP>* · <Markdown> · <XML> · custom Context providers

Output components — produce ContextEntry / content blocks
  <System> · <User> · <Assistant> · <Event> · <Section> · semantic blocks
```

`*` = both registration AND provider. `<Sandbox>` registers the sandbox
service AND provides Context for tools to read via `useSandbox()`.

## Compile pipeline

```
React JSX tree
  ──► reconcile (react-reconciler with custom host config)
  ──► collect:
        content scopes  · renderer scopes  ·
        ContextEntry candidates  · declarations
  ──► render content scopes via Formatter harness
  ──► build RenderedTree
  ──► structural equality check (hash compare)
  ──► stable emit
  (or forcedStable + diagnostic if iteration cap reached)
```

## React Harness ↔ Runtime boundary

The runtime drives the React harness through the protocol; the React
harness does not pull from the runtime.

```
Runtime (loop executor)                  React harness
─────────────────────                    ──────────────
                  ──── renderTree ──►
                                         (render-until-stable)
                  ◄──── RenderedTree
                  ──── ingest result ──► (via state applicator hook bridge)
                  ──── rerender ──►
                                         (re-renders against new state)
                  ──── renderTree ──►
                                         ...
```

**The React harness does not ingest provider/tool results as a side
effect.** Runtime updates session state, then asks the React harness to
render against that state. This breaks v1's tight coupling between the
COM and the model output stream.

## Effect-free package

The `@agentick/react` package is **Effect-free** — pure React + the spec
package. The runtime imports React harness types from
`@agentick/spec/protocol/react-harness` and bridges to Effect at the
boundary.

```
@agentick/react      depends on  →  react, react-reconciler, @agentick/spec
                     does NOT     →  effect, @effect/cluster, runtime
```

This keeps browser bundles small and lets the same package run in
non-runtime contexts (tests, prompt previews, MCP resource generation).

See `13-package-graph.md`.

## Package shape

```
packages/react/
  src/
    index.ts
    jsx-runtime.ts                // jsx, jsxs, jsxDEV, Fragment
    jsx-types.ts                  // JSX namespace
    reconciler/
      host-config.ts              // react-reconciler 0.31+ host config
      reconciler.ts
    compiler/
      collector.ts                // fiber tree → RenderedTree
      render-until-stable.ts
      handler-registry.ts
    components/
      messages.tsx                // System, User, Assistant, Event
      semantic.tsx                // H1–H3, Paragraph, List, ...
      content.tsx                 // Text, Image, Code, Json, ...
      primitives.ts               // Section, Tool, Timeline, Output
      model.tsx                   // Model, ModelOptions
      sandbox.tsx
      mcp.tsx
      cacheable.tsx
      long-lived/
        subscription.tsx
        cron.tsx
        webhook.tsx
        event-listener.tsx
    hooks/
      reactive.ts                 // useSignal, useKnob
      timeline.ts                 // useTimeline, useChannel
      data.ts                     // useData, useResolved
      lifecycle.ts                // useOnEntry, useOnEvent, useOnMount
      sandbox.ts
      mcp.ts
    renderers/
      markdown.ts                 // built-in renderer impl
      xml.ts                      // built-in renderer impl
```

`[PROPOSAL]` — keep built-in renderer implementations here for now (open
question 1 in `renderer-harness.md` is whether they belong in
`@agentick/react`, `@agentick/spec`, or a separate `@agentick/renderers`).
The formatter harness contract is in `@agentick/spec`; the markdown/XML
implementations ship with `@agentick/react` to keep the dep graph simple.

## Levels of usage

The harness is usable at three levels:

```
Level 1: JSX → rendered string/resource
  No agent loop. MCP resources, prompt previews, documentation.
  React harness alone, no loop executor, no executor.

Level 2: JSX → RenderedTree
  Inspect IR, snapshot for tests, pass to a custom executor.
  React harness + your own consumer of RenderedTree.

Level 3: Session execution loop
  Full agent loop. Loop executor calls renderTree, executor consumes,
  results applied back, re-render, repeat.
  React harness + loop executor + executor + tool executor.
```

Each level builds on the previous. The agent loop is not required to use
the compiler/renderer; the React harness is useful on its own.

## Open questions resolved here

| Question                 | Position                                                            |
| ------------------------ | ------------------------------------------------------------------- |
| Compile-until-stable cap | 16 iterations default `[PROPOSAL]`                                  |
| Equality strategy        | hash-on-emit `[PROPOSAL]`                                           |
| Snapshot opacity         | small structured shape over runtime owns durable state `[PROPOSAL]` |
| Async hibernate          | cancel + re-run policy `[PROPOSAL]`                                 |
| Handler resolution       | registry rebuilt per render `[PROPOSAL]`                            |
| useResolved Layer 1      | reads persisted resolves on restore `[PROPOSAL]`                    |

## Open questions deferred

- Forced-stable policy hard-fail vs warn (open question 1 in compiler-harness.md).
- Hook bridge typing strictness (open question 4).
- Renderer output contract uniformity (open question 5).
