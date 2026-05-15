# 21 — Reconciler Harness: Implementation Shape

**Status:** Draft 2026-05-15 · low-level shape for `@agentick/reconciler-react`

This doc complements `03-reconciler-harness.md` (which is the spec-level
surface — commands, events, lifecycle, inbox) with the
**implementation-level** shape. It uses the lowest-level vocabulary
that's still precise. Where v1 has working ideas we keep them. Where
v1 conflates concerns we name the conflation explicitly and split.

> Read `03-reconciler-harness.md` first. This doc presumes the
> `ReconcilerProtocol`, `RenderedTree`, and `FormatterRef` shapes from
> the spec.

## The job, in one sentence

**Turn a React element tree into a `RenderedTree` (JSON IR), without
crossing the spec firewall.**

Everything else is plumbing.

## Vocabulary (lowest-level terms)

| Term                | Meaning                                                                                                  | React-reconciler equivalent      |
| ------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **Element**         | A `React.ReactElement` produced by JSX. Pure value. No side effects.                                     | `React$Element`                  |
| **Component**       | A function that returns Elements (or class). Has identity, hooks, effects, props.                        | `React.Component` / fn component |
| **Fiber**           | React's internal scheduler node. We never touch fibers directly.                                         | `Fiber`                          |
| **Host config**     | The object the harness gives to `react-reconciler` describing how to build/mutate the host tree.         | `HostConfig`                     |
| **Host instance**   | One node in the host tree — what `react-reconciler` calls into our `createInstance`/`commitUpdate` for.  | `Instance`                       |
| **Host tree**       | The mutable in-memory tree of host instances, assembled during reconciliation. Transient.                | (no first-class name)            |
| **Container**       | The root of the host tree. Carries `FormatterScope` and root children.                                   | `Container`                      |
| **Host context**    | Value passed down through `getChildHostContext`. Carries `FormatterScope` inheritance.                   | `HostContext`                    |
| **Reconcile**       | The act of running React against the host config to mutate the host tree.                                | "reconciliation"                 |
| **Render** (React)  | The component-function execution phase. Components run; hooks fire; effects schedule.                    | "render"                         |
| **Commit**          | The synchronous mutation phase where host config callbacks (`appendChild`, `commitUpdate`) fire.         | "commit"                         |
| **Collect**         | Our second phase: walk the host tree, dispatch by component identity, produce `RenderedTree`. New verb.  | (no equivalent — this is ours)   |
| **Contributor**     | A per-element-type collector strategy. Maps `(HostInstance, Context) → IR fragments`. Pluggable.         | (no equivalent — this is ours)   |
| **FormatterScope**  | Immutable record of which formatter is bound at a tree node, by `audience` / `purpose`. Lexically scoped.| (we carry this in `HostContext`) |
| **HookBridge**      | Runtime-provided implementation behind a React hook (e.g., the timeline reader behind `useTimeline()`).  | (n/a — agentick-specific)        |
| **Snapshot**        | `ReconcilerSnapshot` — JSON form of harness-private state needed to rehydrate after hibernate/restart.   | (n/a)                            |

What we deliberately do NOT use:

- "Renderer" for a content formatter — v1's name. v2 calls these
  **Formatters** (a separate harness). "Renderer" is reserved for
  *React renderers*, of which our reconciler IS one.
- "Compiler" for the harness — v1's name. v2 calls this the
  **Reconciler harness** because *reconciliation* is what
  react-reconciler does, and the React vocabulary is the lowest-level
  available term.
- "COM" / "Context Object Model" — v1's mutable intermediate
  representation. Gone in v2; `RenderedTree` is the IR.

## v1 anatomy (what's there)

```
packages/core/src/
  reconciler/                      ~470 LOC
    reconciler.ts        react-reconciler init + container API
    host-config.ts       the HostConfig implementation
    types.ts             AgentickNode, AgentickContainer, AgentickTextNode
    devtools-bridge.ts   react-devtools standalone connection
    README.md
  compiler/                        ~2,243 LOC
    fiber-compiler.ts    orchestrator: reconcile + collect + lifecycle (738)
    collector.ts         AgentickNode tree → CompiledStructure  (1084)
    structure-renderer.ts CompiledStructure → COM + formatting   (212)
    scheduler.ts         reconcile-on-signal scheduling          (200)
    merge-structural-input.ts                                    (101)
    types.ts             CompiledStructure shape                 (108)
  jsx/                             ~1,800+ LOC
    jsx-runtime.ts       JSX factory + IntrinsicElements (480)
    components/          22 component .tsx files
```

Total surface to translate: roughly **4,500 LOC** of v1 code.

## v1 critique — what's wrong, ranked

I'm flagging the breakages in priority order. Some are protocol
violations; some are smells; some are legitimate design choices that
just don't survive the spec firewall. **Confidence: high** on items 1–8,
**moderate** on items 9–12.

### 1. Live function references leak through the IR (**protocol violation**)

`AgentickNode.renderer: Renderer | null` carries a live formatter
**instance** on every node. `CompiledStructure.tools: ExecutableTool[]`
carries live handler closures. `CompiledSection.renderer: Renderer | null`
carries live formatters into the compiled output.

The spec firewall forbids functions across harness boundaries. v2's
`RenderedTree` carries `FormatterRef` (an id) and
`ToolDeclaration.handlerRef` (a string), and the runtime resolves both
behind the boundary.

### 2. `RENDERER_COMPONENTS` is module-level global mutable state (**protocol violation**)

`host-config.ts` line 20: `const RENDERER_COMPONENTS = new Map<unknown, Renderer>()`.
Calling `registerRendererComponent(MarkdownComponent, mdRenderer)` writes
to a process-global Map. This means:
- Multi-tenant servers can't isolate formatter registries per session.
- Hot reload corrupts the Map.
- Two `MemoryJournal`s can't have different formatter sets.

v2 binds the formatter scope to the *Container* (`HostContext`).
Lexical, immutable, per-mount.

### 3. The collector is a 1,084-LOC switch statement

`collector.ts` enumerates ~30 component types as string constants
(`SECTION`, `SECTION_LOWER`, `ENTRY`, …) with hand-written branches per
type. The set is hard-coded. Adding a primitive means editing the
collector. The collector "knows" everything.

v2 introduces a **Contributor protocol** — each known component type
registers a Contributor; the collector dispatches by component
identity. Users can register new contributors without touching the
core collector.

### 4. The orchestrator does five jobs

`FiberCompiler` (738 LOC) is simultaneously:
- the react-reconciler driver (`reconcile()`)
- the collector caller (`collect()`)
- the data-resolution loop (`compileUntilStable` + `useData`)
- the lifecycle dispatcher (`notifyLifecycle({ kind: "tick-start" })`, `({ kind: "tick-end" })`, …)
- the message bus host (`MessageProvider`, `EntryProvider`)

v2 splits:
- **Reconcile + collect** stays in the reconciler harness.
- **Lifecycle dispatch** moves to `BaseHarness` surfaces.
- **Message bus** moves to the inbox / event bus substrate.
- **Data resolution** stays in the harness because it's render-loop
  coupled (see "Compile-until-stable" below), but it's a pure helper,
  not a god method.

### 5. Component-type detection by string comparison

`if (type === "Section" || type === "section") { … }`. The lowercase
forms exist because some intrinsics are `section` (JSX intrinsic) and
some are `Section` (capitalized component). Five-way string fan-outs
appear throughout the collector.

v2: components have a **stable identity** (the function reference or
the intrinsic name). The Contributor registry keys on that identity
directly. No string variants.

### 6. CompiledStructure is a half-IR, half-runtime mongrel

```ts
interface CompiledStructure {
  sections: Map<string, CompiledSection>;     // Map, not array — not JSON
  timelineEntries: CompiledTimelineEntry[];   // OK
  systemEntries: CompiledTimelineEntry[];     // duplicates timeline
  tools: ExecutableTool[];                    // live closures
  ephemeral: CompiledEphemeral[];             // separate from timeline
  metadata: Record<string, unknown>;          // OK
  totalTokens?: number;                       // runtime concern
}
```

It's not the wire IR (carries closures + Maps + token counts), nor a
pure runtime artifact (some fields ARE IR-shaped). It's
neither-here-nor-there.

v2: `RenderedTree` is the wire IR. Period. Runtime concerns
(token counts, dispatch handlers) live in the runtime side of the
boundary, looked up via `handlerRef`.

### 7. `AgentickNode` is mutable graph; not the IR

The host tree's `AgentickNode` has `parent`, mutable `children`, and
`renderer`. v1 *also* passes this around as the compile output.

v2 separation:
- `HostInstance` (mutable, transient, the host tree) — never crosses
  the harness boundary.
- `RenderedTree` (immutable, JSON, the IR) — crosses the boundary.

`HostInstance` becomes a private implementation detail of the harness.

### 8. Two distinct concepts share the name "Renderer"

In v1, "Renderer" simultaneously means:
- A `react-reconciler` host (the React vocabulary).
- A `Formatter` that turns semantic blocks into text (agentick's own
  concept).

v2 fixes the vocabulary: **Formatter** = content transformation,
**Reconciler** = the React host. These are different harnesses; their
files don't share a word.

### 9. Lifecycle hooks baked into the reconciler

`useOnTickStart`, `useOnTickEnd`, `useAfterCompile`, `useContinuation`
live in the compiler package and fire from `FiberCompiler.notifyX()`.
These are *session* concerns leaking into the reconciler.

v2: the reconciler is a `BaseHarness` and gets lifecycle handlers (③)
and middleware (④) from the substrate. The "session sends tickEnd to
the reconciler" relationship becomes an event subscription, not a
private callback registry.

### 10. JSX intrinsic catalog is enormous

The `IntrinsicElements` interface declares ~30 first-class lowercase
intrinsics (`section`, `message`, `tool`, `ephemeral`, plus media,
plus semantic HTML). Each maps to a custom handler. Some shadow real
HTML (`p`, `ul`, `li`, `a`, `kbd`) for inline formatting.

v2: keep the structural intrinsics (`section`, `message`, `tool`,
…) — they're the agentick grammar. Push semantic HTML inlining into
the **Formatter harness**, not the reconciler. The reconciler doesn't
need to know what `<strong>` means; the formatter does.

### 11. Sync render via `flushSyncWork`

v1 uses `updateContainerSync` + `flushSyncWork` to render to
completion synchronously. This is correct for our deterministic model
(we want a stable tree before we collect). It's also slightly
adversarial to React's async/concurrent features (which we don't
need).

v2: keep this — it's the right call. But state it explicitly as a
design constraint, not an accident.

### 12. Async component support is bolted on

v1 supports `async function Component()` returning `Promise<Element>`
by throwing the promise from inside `useData` and catching it in
`FiberCompiler.reconcile()`'s loop (Suspense-style). The retry loop
caps at 10 attempts.

v2: this pattern is correct and we keep it, but make it first-class
("render-until-stable" semantics with explicit termination conditions).
Spec the contract.

## What v1 got right (worth keeping)

1. **react-reconciler 0.33 / React 19 integration.** The host config
   skeleton in `host-config.ts` is largely correct (modulo the global
   `RENDERER_COMPONENTS` Map). The React 19 fields (`maySuspendCommit`,
   `preloadInstance`, `setCurrentUpdatePriority`, `getCurrentUpdatePriority`,
   `resolveUpdatePriority`, `HostTransitionContext`, `NotPendingTransition`,
   `resetFormInstance`) are wired correctly.
2. **Mutation mode (`supportsMutation: true`).** Right choice. We want
   in-place tree mutation, not persistence mode, not hydration.
3. **`getChildHostContext` for scoped formatter inheritance.** Right
   shape — host context naturally flows down with React composition.
4. **Two-phase pipeline (reconcile → collect).** Right separation.
   v2 keeps the boundary; renames "compile" → "collect" to free the
   word "compile" from confusion with the v1 god method.
5. **Sync flush model.** Required for deterministic compile.
6. **react-devtools bridge.** Useful; keep it.
7. **Async-component retry loop.** Correct shape; just needs to be
   first-class and spec'd.
8. **JSX intrinsics for structural primitives.** `section`, `message`,
   `tool`, `ephemeral` — the right grammar.

## v2 implementation shape

### Three layers, sharply separated

```
┌─────────────────────────────────────────────────────────────────┐
│ Layer A — Reconciliation                                        │
│ Drives react-reconciler against the host config. Mutates the    │
│ host tree. NEVER touches the IR.                                │
│                                                                 │
│   react-reconciler  ──host config──►  HostInstance tree         │
└────────────────────────────────────┬────────────────────────────┘
                                     │
                                     │ (a stable host tree)
                                     ▼
┌─────────────────────────────────────────────────────────────────┐
│ Layer B — Collection                                            │
│ Walks the host tree. For each HostInstance, dispatches to a     │
│ Contributor by component identity. Contributors produce IR      │
│ fragments. Collector composes them into a RenderedTree.         │
│                                                                 │
│   HostInstance tree  ──contributors──►  RenderedTree            │
└────────────────────────────────────┬────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────┐
│ Layer C — Harness wrapping                                      │
│ BaseHarness wraps the renderTree command. Phase contract +      │
│ lifecycle handlers + middleware + inbox + events. Same as       │
│ every other harness.                                            │
└─────────────────────────────────────────────────────────────────┘
```

Layer A is React. Layer B is ours. Layer C is the substrate.

### Layer A — host config (concrete shape)

```ts
// packages/reconciler-react/src/host/host-instance.ts

/**
 * One node in the host tree. Mutable. Transient. Never crosses the
 * harness boundary; collected into RenderedTree at the end.
 *
 * Two variants by `kind`.
 */
export type HostInstance = ElementInstance | TextInstance;

export interface ElementInstance {
  readonly kind: "element";
  /** Component identity — function reference, intrinsic string, or Fragment symbol. */
  type: HostType;
  props: Props;
  children: HostInstance[];
  /** Set by the host config during append. Mutable for tree assembly. */
  parent: HostInstance | null;
  /** Stable identity assigned at create-time. Survives across rerenders. */
  hostId: string;
  /** Scope captured at create-time from getChildHostContext. */
  scope: HostScope;
}

export interface TextInstance {
  readonly kind: "text";
  text: string;
  parent: HostInstance | null;
  hostId: string;
}

export type HostType =
  | string                                   // intrinsic ("section", "message", …)
  | ((...args: never[]) => unknown)          // function component
  | symbol;                                  // Fragment
```

```ts
// packages/reconciler-react/src/host/host-context.ts

/**
 * Lexically-inherited scope flowing through `getChildHostContext`.
 * Immutable; replaced (not mutated) at scope boundaries.
 */
export interface HostScope {
  /** Formatter binding by purpose. Lookups fall back to `default`. */
  readonly formatters: FormatterScope;
  /** Section ancestry for stable id derivation, etc. */
  readonly path: ReadonlyArray<string>;
}

export interface FormatterScope {
  readonly default: FormatterRef;
  readonly byPurpose?: Readonly<Record<FormatPurpose, FormatterRef>>;
}
```

```ts
// packages/reconciler-react/src/host/host-config.ts

export function createHostConfig(deps: HostConfigDeps): ReactReconciler.HostConfig<...> {
  return {
    supportsMutation: true,
    supportsPersistence: false,
    supportsHydration: false,
    isPrimaryRenderer: true,
    noTimeout: -1,
    // …all React-19 required methods…
    createInstance,
    createTextInstance,
    appendChild, appendInitialChild, appendChildToContainer,
    insertBefore, insertInContainerBefore,
    removeChild, removeChildFromContainer, clearContainer,
    getRootHostContext, getChildHostContext,
    commitUpdate, commitTextUpdate,
    finalizeInitialChildren,
    prepareForCommit, resetAfterCommit,
    getPublicInstance,
    preparePortalMount,
    shouldSetTextContent,
    scheduleTimeout, cancelTimeout,
    // priority methods
    // suspense methods
    // transition stubs
  };
}
```

`HostConfigDeps` is what makes the host **pluggable** at the
infrastructure level: a Container, a FormatterScope resolver, a
host-id generator. No module-level state. Two simultaneous harnesses
do not collide.

### Layer B — Contributor protocol

```ts
// packages/reconciler-react/src/collect/contributor.ts

/**
 * A Contributor maps a HostInstance (of a specific component type) plus
 * a CollectContext into a list of IR fragments that the collector
 * merges into the RenderedTree under construction.
 *
 * Every primitive (Section, Message, Tool, Ephemeral, Document,
 * Image, Code, …) has exactly one Contributor. New primitives are
 * added by registering a Contributor — the collector never grows.
 */
export interface Contributor<T extends HostType = HostType> {
  /** The component identity this contributor handles. */
  readonly type: T;
  /**
   * Produce IR fragments for one HostInstance. Recursion into children
   * is the contributor's responsibility — typical pattern is to
   * dispatch children back through the collector.
   */
  contribute(
    instance: ElementInstance,
    ctx: CollectContext,
  ): readonly IRFragment[];
}

export type IRFragment =
  | { kind: "context-entry"; entry: ContextEntry }
  | { kind: "tool-declaration"; tool: ToolDeclaration }
  | { kind: "resource-declaration"; resource: ResourceDeclaration }
  | { kind: "output-declaration"; output: OutputDeclaration }
  | { kind: "mcp-declaration"; mcp: MCPDeclaration }
  | { kind: "free-root-content"; blocks: readonly ContentBlock[] }
  | { kind: "spec-config"; partial: Partial<SpecConfig> }
  | { kind: "provider-options"; partial: ProviderOptions }
  | { kind: "diagnostic"; diagnostic: FormatDiagnostic }
  | { kind: "metadata"; key: string; value: unknown };

export interface CollectContext {
  readonly formatters: FormatterScope;
  /** Recurse into a child host instance. */
  collect(child: HostInstance): readonly IRFragment[];
  /** Format semantic content using the in-scope formatter. */
  format(input: FormatInput): Promise<FormatResult>;
  /** Stable id generator (deterministic — same tree position → same id). */
  stableId(prefix: string, instance: HostInstance): string;
}
```

The collector becomes ~50 LOC of dispatch:

```ts
function collect(root: HostInstance, ctx: CollectContext): RenderedTree {
  const fragments = walk(root);
  return foldFragments(fragments);
}

function walk(node: HostInstance, ctx: CollectContext): IRFragment[] {
  if (node.kind === "text") return ctx.fromTextNode(node);
  const contributor = registry.lookup(node.type);
  if (!contributor) return node.children.flatMap((c) => walk(c, ctx));
  return contributor.contribute(node, ctx);
}
```

The 1,084-LOC v1 collector collapses to a registry + small contributors.

### Layer B — built-in contributors

| Component / intrinsic   | Contributor produces                              |
| ----------------------- | ------------------------------------------------- |
| `<section>` / `<Section>` | `{ kind: "context-entry", entry: SectionEntry }` |
| `<message>` / `<Message>` | `{ kind: "context-entry", entry: MessageEntry }` |
| `<tool>` / `<Tool>`       | `{ kind: "tool-declaration", tool }`             |
| `<resource>`              | `{ kind: "resource-declaration", resource }`     |
| `<output>`                | `{ kind: "output-declaration", output }`         |
| `<mcp>`                   | `{ kind: "mcp-declaration", mcp }`               |
| `<model>` / `<openai>` / `<google>` | `{ kind: "spec-config", partial }` and/or `{ kind: "provider-options", partial }` |
| `<ephemeral>`             | `{ kind: "context-entry", entry: SectionEntry with role hint }` (no longer a separate kind) |
| Content blocks (`<text>`, `<image>`, `<code>`, …) | Folded into parent's `content: ContentBlock[]` |
| Semantic HTML (`<strong>`, `<em>`, `<ul>`, …) | Folded into parent's `semanticNode` tree via formatter |
| `Fragment` / unknown      | Pass-through; recurse children                   |

Built-in contributors live in `packages/reconciler-react/src/contributors/`.
User-defined primitives register through the harness API:

```ts
reconciler.registerContributor({ type: MyCustomNode, contribute: (...) => [...] });
```

### Layer C — BaseHarness wrapping

```ts
// packages/reconciler-react/src/harness/reconciler-harness.ts

export class ReconcilerHarness extends BaseHarness<"reconciler"> {
  // …construction with journal/bus/inbox/policy from substrate…

  async renderTree(input: RenderTreeInput): Promise<RenderTreeResult> {
    const op: Operation<RenderTreeInput, RenderTreeResult> = {
      opId: input.opId ?? ulid(),
      surface: "reconciler",
      name: "reconciler:command:render-tree",
      scope: { sessionId: input.sessionId, executionId: input.executionId },
      input,
    };
    return this.runOperation(op, (input) => this.renderTreeBody(input));
  }

  private async renderTreeBody(input: RenderTreeInput): Promise<RenderTreeResult> {
    await this.ensureMounted(input);
    await this.reconcileUntilStable(input);    // Layer A
    const tree = await this.collect(input);    // Layer B
    return { tree, snapshot: this.snapshotPrivate() };
  }

  protected async handleMessage(msg: MessageEnvelope): Promise<unknown> {
    switch (msg.type) {
      case "recompile":   return this.handleRecompile(msg);
      case "unmount":     return this.handleUnmount(msg);
      case "invalidate":  return this.handleInvalidate(msg);
      default:            throw new Error(`unknown: ${msg.type}`);
    }
  }
}
```

This is the only piece that knows about the substrate. Layer A and
Layer B are pure.

## Hook bridges

Hooks like `useTimeline`, `useKnob`, `useData`, `useSandbox`, `useMCP`
need *runtime* state inside React components. They cannot reach across
the spec firewall directly — the runtime is not allowed to hand a
React component a live `Session` object.

**Pattern:**

```ts
// @agentick/spec (or a sibling spec-react package)
export interface HookBridges {
  readonly timeline: TimelineReader;
  readonly knobs: KnobReader;
  readonly data: DataResolver;
  readonly sandbox: SandboxResolver;
  readonly mcp: MCPResolver;
  // …
}

// @agentick/reconciler-react
const BridgeContext = createContext<HookBridges | null>(null);

export function useTimeline(): TimelineSnapshot {
  const bridges = useContext(BridgeContext);
  if (!bridges) throw new Error("useTimeline outside Reconciler harness");
  return bridges.timeline.read();
}
```

The runtime constructs concrete bridges around its own state and
passes them to `renderTree(input)`. The harness wraps the React render
in `<BridgeContext.Provider value={bridges}>`. Components consume.

**Why this matters for pluggability:** anyone can implement
`TimelineReader`, `KnobReader`, etc. — they're protocols. A test
harness can pass in-memory stubs; a cluster impl can pass remote
proxies. The reconciler doesn't care.

## Compile-until-stable, made first-class

Same shape as v1, contract-ed:

```
loop:
  render synchronously (updateContainerSync + flushSyncWork)
  if any useData() threw a pending Promise:
    await all pending promises
    continue
  if any setState fired during render:
    continue
  if iteration count >= maxIterations:
    emit RenderTreeDiagnostic { code: "max-iterations" }
    break
  break

then: collect → RenderedTree
```

Termination conditions are explicit. Diagnostics go in
`RenderedTree.diagnostics`.

## Snapshot / restore

`ReconcilerSnapshot` is the harness-private state needed to recover a
mounted application after hibernation. Concretely:

```ts
interface ReconcilerSnapshot {
  readonly specVersion: string;
  readonly hookStates: Record<string, unknown>;       // per-component hook state
  readonly dataCache: readonly DataCacheEntry[];      // useData results
  readonly knobs: Record<string, unknown>;            // useKnob current values
  readonly subscriptions: readonly SubscriptionIntent[];
  // NOT: HostInstance tree (re-derived from rerender)
  // NOT: live formatter refs (FormatterScope captured from session config)
}
```

Restore = mount the same root element + replay the snapshot before the
first `renderTree`.

## Package shape

```
packages/reconciler-react/
  package.json                  deps: react@19, react-reconciler@0.33,
                                      @agentick/spec, @agentick/runtime
  src/
    index.ts                    public exports
    harness/
      reconciler-harness.ts     Layer C — BaseHarness subclass
      operations.ts             Operation factory helpers
      inbox-messages.ts         message type guards
    host/
      host-instance.ts          HostInstance, TextInstance, factories
      host-context.ts           HostScope, FormatterScope
      host-config.ts            createHostConfig(deps)
      container.ts              ReconcilerContainer
    react/
      reconciler.ts             react-reconciler instance + container API
      bridge-context.ts         BridgeContext + provider
      hooks/
        useTimeline.ts          (and all other hook bridges)
        useResolved.ts
        useLoopControl.ts
        …
      jsx-runtime.ts            (moved from v1 jsx/)
      components/
        section.tsx
        message.tsx
        tool.tsx
        resource.tsx
        output.tsx
        mcp.tsx
        ephemeral.tsx
        content.tsx              <text>/<image>/<code>/<json>/<document>
        semantic.tsx             <strong>/<em>/<ul>/<li>/…
        model.tsx
        markdown.tsx             provider-scope formatter switcher
        xml.tsx                  provider-scope formatter switcher
    collect/
      collect.ts                 walker + foldFragments
      contributor.ts             Contributor protocol
      registry.ts                ContributorRegistry
      fragments.ts               IRFragment types
      contributors/
        section.ts
        message.ts
        tool.ts
        resource.ts
        output.ts
        mcp.ts
        ephemeral.ts
        content.ts
        model.ts
        formatter-scope.ts       <markdown>/<xml> scope contributors
    snapshot/
      snapshot.ts                snapshot() / restore()
      hook-state.ts              hook state extraction
    devtools/
      devtools-bridge.ts         react-devtools standalone connection
  README.md
```

## Boundary contract

Inputs to the reconciler harness:
- `MountInput` — a React element factory + bridge bundle
- `RenderTreeInput` — the request; carries op metadata + optional override props
- `MessageEnvelope` — inbox messages (`recompile`, `unmount`, `invalidate`)
- Lifecycle handler registrations via `.on*(fn)`
- Middleware via `.use(mw)`

Outputs from the reconciler harness:
- `RenderedTree` (the IR — JSON-shaped, spec-firewall-safe)
- `ReconcilerSnapshot` (for hibernation; JSON-shaped)
- Events on the bus (`reconciler:render:requested|before|delta|terminal`)

**What never crosses:**
- The HostInstance tree
- React fibers
- The HostConfig
- Hook state objects
- Formatter function references
- Tool handler closures

All of these stay inside `@agentick/reconciler-react`.

## Conformance suite (`runReconcilerConformance`)

Land in `@agentick/spec-conformance` once the harness is implemented.
Required invariants:

1. **Idempotence:** same React element + same bridges → identical
   `RenderedTree` (up to free-running ids).
2. **Tree → IR:** for every host-tree position, exactly one or zero
   IR fragments are produced.
3. **Scope inheritance:** a `<Markdown>` provider at depth N causes all
   descendants to render with the markdown formatter unless overridden.
4. **Spec firewall:** `RenderedTree` survives `JSON.parse(JSON.stringify(t))`
   structurally (no functions, no symbols, no Map/Set, no Date).
5. **Snapshot round-trip:** `restore(snapshot(tree))` produces the same
   IR on the next `renderTree`.
6. **Async stability:** `useData()`-suspending components terminate
   within `maxIterations`; pending data is resolved before collection.
7. **Lifecycle:** `before`-phase handlers can `veto`/`replace` the
   `renderTree` operation per `mergeVerdict`.
8. **Inbox:** `recompile` message triggers a render before returning the
   ack.

A second reconciler impl (hypothetical `reconciler-imperative`) passes
the same suite if it produces an equivalent `RenderedTree`.

## What we build first (Phase 3 work breakdown)

```
3.1  spec/reconciler-protocol.ts     ReconcilerProtocol interface lands in spec
3.2  spec/reconciler-snapshot.ts     ReconcilerSnapshot shape + diagnostics
3.3  spec/hook-bridges.ts            HookBridges interfaces (TimelineReader, KnobReader, …)
3.4  reconciler-react scaffold       package.json, tsconfig, README
3.5  host/                           HostInstance, HostScope, host-config
3.6  react/reconciler.ts             react-reconciler init + container
3.7  collect/contributor.ts          Contributor protocol + registry
3.8  collect/contributors/*          built-in contributors (one per primitive)
3.9  collect/collect.ts              walker + foldFragments
3.10 harness/reconciler-harness.ts   BaseHarness subclass — Layer C
3.11 react/bridge-context.ts         BridgeContext + provider
3.12 react/jsx-runtime.ts            ported from v1 with cleanup
3.13 react/components/*              ported from v1 with cleanup
3.14 react/hooks/*                   hook bridges (useTimeline, useKnob, useData, …)
3.15 snapshot/snapshot.ts            snapshot() / restore()
3.16 spec-conformance/reconciler.ts  runReconcilerConformance body
3.17 reconciler-react/__tests__/*    conformance + harness-local tests
```

3.1–3.3 are spec work (lands in `@agentick/spec`).
3.4–3.15 are runtime work (lands in `@agentick/reconciler-react`).
3.16 is the conformance suite.
3.17 wires conformance + adds harness-local invariants.

## Cross-references

- `03-reconciler-harness.md` — spec-level surface (commands / events / lifecycle / inbox)
- `02-data-model.md` — `RenderedTree`, `ContextSpec`, `ContextEntry`,
  `RuntimeDeclarations`
- `04-formatter-harness.md` — what the formatter does after the reconciler
- `13-package-graph.md` — package home + dep arrows
- `15-flows/a-cold-start-and-mount.md` — mount sequence
- `15-flows/b-tick-and-tool-loop.md` — renderTree inside a tick
- `15-flows/e-resource-render-no-loop.md` — renderResource without execution
- `19-foundation.md` — the substrate `ReconcilerHarness` rides on
- `20-pluggability-charter.md` — why contributors are a protocol, not
  a hardcoded switch
