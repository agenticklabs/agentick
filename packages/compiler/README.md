# @agentick/compiler

**A compiler turns an agent definition into the one thing a provider can consume: a `RenderedTree`.** This package owns every part of that pipeline that isn't tied to a JSX runtime — the host-tree shapes, the contributor protocol, the `collect` walker, the built-in vocabulary, the surfacing projections, and the reference bridges.

The split matters because the vocabulary is not React's. `<Section>`, `<Tool>`, `<Message>`, every content block — those are contributors living here, so an Angular binding, a custom DSL, or a plain-object test harness all produce the same IR through the same code. Nothing in this package imports React.

## Install

```bash
npm install @agentick/compiler
```

Subpaths: `.` (the pipeline) and `/testing` (a pass-through compiler and protocol doubles). Most adopters get this transitively through [@agentick/compiler-react](../compiler-react) and never import it directly — you reach for it when you're writing a compiler, a contributor, or a test that needs a compiler to exist without rendering anything.

## Quick start

A host tree in, a `RenderedTree` out. No JSX, no session, no model:

```ts
import {
  collect,
  createBuiltInRegistry,
  createElementInstance,
  createTextInstance,
  rootScope,
} from "@agentick/compiler";

const section = createElementInstance("section", { title: "Guidance" }, rootScope);
const text = createTextInstance("Answer concisely.");
text.parent = section;
section.children.push(text);

const { tree, diagnostics } = collect({
  roots: [section],
  registry: createBuiltInRegistry(),
  rootScope,
});

tree.context.entries; // [{ kind: "section", id, title: "Guidance", content: [{ type: "text", ... }] }]
```

That is the whole contract a concrete compiler has to meet: build host instances however your framework does it, then hand the roots to `collect`. `createBuiltInRegistry()` supplies the entire vocabulary.

## Two layers

**Layer A is the host tree** — a mutable, transient structure that never crosses the protocol boundary. `ElementInstance` carries a component identity (`type`), a props bag, ordered `children`, a parent pointer, a stable `hostId`, and the `HostScope` captured when it was created. `TextInstance` is a string leaf.

`HostScope` is how formatter selection stays lexical instead of living in a module-level registry — a multi-tenant server can't isolate a global map per mount, so scope is immutable and replaced at boundaries:

```ts
import { createHostScope, resolveFormatter, withFormatter } from "@agentick/compiler";

const scope = createHostScope({ formatter: { id: "markdown" }, path: ["root"] });
const nested = withFormatter(scope, { formatter: { id: "xml" }, purpose: "section" });

resolveFormatter(nested, "section"); // { id: "xml" }  — purpose-specific binding
resolveFormatter(nested); // { id: "markdown" } — falls back to the default
```

A `<format formatter={ref} purpose?={p}>` node is the canonical scope provider: `collect` recognizes it, derives a new scope for the subtree, and contributes nothing itself. A malformed one passes through with the parent scope rather than failing the walk.

**Layer B is the contributor protocol.** `collect` walks the tree, dispatches each element to a `Contributor` by component identity, and folds the resulting `IRFragment`s into one `RenderedTree`. An element with no registered contributor is a **passthrough** — its children are walked and their contributions pooled, which is what makes fragments and arbitrary wrapper components compose for free.

## Writing a contributor

One contributor per host type. Return `IRFragment`s; use `ctx` to recurse, fold content, derive ids, and read the in-scope formatter:

```ts
import { NO_FRAGMENTS, createBuiltInRegistry } from "@agentick/compiler";
import type { CollectContext, Contributor, ElementInstance, IRFragment } from "@agentick/compiler";
import type { SectionEntry } from "@agentick/spec";

const bannerContributor: Contributor = {
  type: "banner",
  contribute(instance: ElementInstance, ctx: CollectContext): readonly IRFragment[] {
    const text = ctx.collectText(instance);
    if (text.length === 0) return NO_FRAGMENTS;
    const entry: SectionEntry = {
      kind: "section",
      id: ctx.stableId("banner", instance),
      content: [{ type: "text", text }],
      renderedWith: ctx.formatter("section"),
    };
    return [{ kind: "context-entry", entry }];
  },
};

const registry = createBuiltInRegistry();
registry.register(bannerContributor); // throws on a duplicate type
```

`register` refuses to shadow an existing type; `override` replaces deliberately. That's the escape hatch for a harness that needs private element semantics the base vocabulary can't express — it registers its own contributor rather than the compiler growing a dependency on the harness:

```ts
registry.override({ type: "section", contribute: () => NO_FRAGMENTS }); // drop every <section>
```

Use `override` sparingly. The vocabulary belongs here, and a harness-owned contributor is the exception.

### The drift gate

A contributor hand-assembles a spec value, so a **new optional field on the spec type compiles everywhere and is silently dropped**. That bug class already cost two passes of missing `ToolDeclaration.aliases` and `providerOptions`.

The guard is type-level. Each contributor partitions its spec type's keys into what it forwards from props and what it supplies itself, then asserts the partition is total:

```ts
import type { Exhausted, UnhandledSpecKeys } from "@agentick/compiler";

type BannerSpec = { readonly kind: "section"; readonly id: string; readonly title?: string };
type Forwarded = "title";
type Supplied = "kind" | "id";
type _conformance = Exhausted<UnhandledSpecKeys<BannerSpec, Forwarded, Supplied>>;
```

A spec key in neither partition makes `UnhandledSpecKeys` non-`never`, `Exhausted` refuses to resolve, and `tsc` fails at that contributor until you triage the field. Because both partitions are bounded by `keyof Spec`, a key the spec _removed_ fails at the same site — the partition can't rot in either direction. Block contributors compose the shared frozen `BaseBlockKey` roster, so one new `BaseContentBlock` field trips every block at once.

Three contributors carry a documented exception with no partition: `content-passthrough` (its prop _is_ `ContentBlock[]`), `project` (emits a compiler-internal fragment with no spec type), and the semantic-HTML contributors (raw attributes flow into an open `SemanticNode.props`, so the assertion guards the output shape instead).

## Content and projections

`collect` folds two different kinds of contribution, and the distinction is the reason context doesn't get double-counted.

**Content** is `<Message>` / `<Section>` / text written directly in the tree. It appends to the entry stream in tree order.

**Projections** are one-per-surfacing-key. A harness with something to surface — the timeline, the tool set — gets exactly one projection into the IR: either its framework **default**, or a component that **overrides** it. Accumulation lives in the harness; a projection only surfaces what the harness already holds.

Defaults run **lazily** — only when the tree did not override their key:

```ts
import { builtInDefaultProjections, collect, createBuiltInRegistry } from "@agentick/compiler";
import type { DefaultProjection, ProjectionResult, ProjectionSources } from "@agentick/compiler";

const namesProjection: DefaultProjection = {
  key: "tool-names",
  project: (sources: ProjectionSources): ProjectionResult =>
    sources.tools.length === 0
      ? {}
      : {
          entries: [
            {
              kind: "section",
              id: "tool-names",
              content: [{ type: "text", text: sources.tools.map((t) => t.name).join(", ") }],
              renderedWith: { id: "default" },
            },
          ],
        },
};

const { tree } = collect({
  roots,
  registry: createBuiltInRegistry(),
  rootScope,
  defaults: [...builtInDefaultProjections, namesProjection],
});
```

Omit `defaults` and `collect` applies `builtInDefaultProjections` — currently just `builtInToolsProjection`, so tools surface with zero configuration. The `timeline` default needs a live timeline and is contributed by the compiler binding, not here.

A `<project projectionKey="…">` node is the override. Its children are the projected content; the contributor collects their entries and emits one `projection-override` fragment, which suppresses that key's default:

```ts
const project = createElementInstance("project", { projectionKey: "timeline" }, rootScope);
// ... append the <message> children a <Timeline> folded ...
const { tree } = collect({ roots: [project], registry: createBuiltInRegistry(), rootScope });
```

> [!IMPORTANT]
> Overriding changes _surfacing_, not registration. Tool declarations and diagnostics produced inside a `<project>` subtree are re-emitted unchanged — only the projection is replaced. A `<project>` with no `projectionKey` contributes a `MISSING_PROJECTION_KEY` warning instead of silently overriding nothing.

Every contribution is provenance-tagged on `tree.provenance` — `authored:content`, `authored:<key>`, or `default:<key>` — so you can tell what the tree wrote from what a default folded in. Default contributions append _after_ the tree-order stream, because they have no tree position.

## `defineCompiler`

A callback bundle that satisfies the compiler protocol. Reach for it when React isn't the right fit — another framework, a custom DSL, or a stub:

```ts
import { defineCompiler } from "@agentick/compiler";
import { SPEC_VERSION } from "@agentick/spec";

export const myCompiler = defineCompiler({
  mount: async () => ({ mountId: "m_1", restoredFromSnapshot: false }),
  unmount: async () => {},
  renderTree: async () => ({
    tree: { specVersion: SPEC_VERSION, context: { entries: [] } },
    diagnostics: [],
    iterations: 1,
  }),
});
```

It returns a **factory**, not a live instance — construction is deferred so the parent can pass its shared substrate. That's normally `createApp`'s job via its `compiler` option; driving it yourself means supplying the substrate:

```ts
import { fakeBridges } from "@agentick/compiler/testing";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";

const compiler = myCompiler({
  scopeId: "compiler:demo",
  journal: new MemoryJournal(),
  bus: new LocalEventBus(),
  inbox: new LocalInbox(),
});

const { mountId } = await compiler.mount({
  mountId: "m_1",
  sessionId: "s_1",
  element: null,
  bridges: fakeBridges(),
});
const { tree, iterations } = await compiler.renderTree({ mountId, sessionId: "s_1" });
await compiler.unmount({ mountId });
```

Three callbacks are required. The rest have defined fallbacks, and the two that reject rather than no-op do so because a silent empty answer would be worse than a failure:

| Callback         | Required | When omitted            |
| ---------------- | -------- | ----------------------- |
| `mount`          | yes      | —                       |
| `unmount`        | yes      | —                       |
| `renderTree`     | yes      | —                       |
| `rerender`       | no       | resolves, no-op         |
| `restore`        | no       | resolves, no-op         |
| `renderToString` | no       | rejects as unconfigured |
| `snapshot`       | no       | rejects as unconfigured |

`mount`, `renderTree`, `unmount`, and `rerender` each run as an operation on the shared harness protocol, so they emit `compiler:command:*` envelopes on the bus and journal themselves. Your callbacks stay pure business logic. `renderToString` and `snapshot` delegate directly, without an operation.

`iterations` on the result is how many render passes ran before the tree stabilized. Your `renderTree` reports it; the protocol also carries a maximum-iteration ceiling that raises a diagnostic when a tree never settles.

## Bridges

`InMemoryDataBridge` is the reference `useData` cache, split into primitives a compiler composes into its own async idiom: `peek` reads synchronously, `fetch` starts or joins, `subscribe` observes mutations.

```ts
import { InMemoryDataBridge, InMemoryModelBridge } from "@agentick/compiler";

const data = new InMemoryDataBridge({ onSettled: (key) => scheduleRerender(key) });

if (!data.peek<string>("user:1")) {
  await data.fetch("user:1", async () => loadUser("1"));
}
data.invalidate("user:1");
```

React's `useData` peeks, throws the pending promise when there's nothing cached, and starts the fetch. The render-until-stable loop uses three methods beyond the protocol — `hasPending()` and `pending()` to decide whether to await and retry, and `fetchCount()` to detect a Suspense boundary swallowing the throw. A synchronous fetcher settles in a microtask, so by the time the loop checks `pending()` the count is already zero; the cumulative `fetchCount()` delta is the only reliable signal.

`InMemoryModelBridge` is the live side of tree-declared per-tick model selection — a map from a serializable `modelRef` to a run-ready model, structurally the same move as the tool handler resolver. `register` returns an unsubscribe that only deletes if that exact registration is still live, so a re-register on the same ref isn't clobbered by a stale cleanup.

## Lifecycle and interception

Two projections into a mount, pointing in opposite directions.

`LifecycleDispatch` is the **push** half: the session forwards command-hook events in, and this fans them out to handlers registered by `useOnTickStart` and friends. Its non-obvious job is catch-up — a component that mounts _during_ a tick registers after tick-start already fired, and would otherwise wait a full tick:

```ts
import { LifecycleDispatch } from "@agentick/compiler";

const dispatch = new LifecycleDispatch();
const off = dispatch.register("tick-start", (event) => console.log("tick", event.tickId));

await dispatch.dispatch({ kind: "tick-start", tickId: "t_1", executionId: "e_1" });

// Registered after the dispatch — still receives the active tick-start.
const offLate = dispatch.register("tick-start", (event) => console.log("catch-up", event.tickId));
```

The active event is remembered until tick-end and replayed once per new handler. `execution-start` works the same way. Custom kinds via `registerCustom` get **no** catch-up — replay semantics there are the application's call.

A handler that throws is caught, logged with its kind, and skipped. It has to be: the tick-start and tick-end forwarders are awaited inside the tick cascade, so a propagated throw would abort the tick, and the rest are fire-and-forget, so one would float as an unhandled rejection.

`CommandInterceptorRegistry` is the **pull** half, and it's storage only. Components register real `Middleware` keyed by op tag (`"ToolDispatch"`); the session queries `collect(command)` at every operation and composes the result around the op body. Because it's a pull issued per operation, a mid-execution mount or unmount is reflected on the next operation with no stale registration. Ordering and composition live in the session — this class holds values and hands back registration-order snapshots.

## Prompt-cache stability

The compiler's output _is_ the model input, so byte-stability across ticks is a billing concern. **A static tree must compile to byte-identical input on every tick.** Provider prompt caches key on an exact prefix match, and any drift in the cached prefix silently busts it and re-bills the full prompt.

Keep time-varying content out of the stable prefix — put timestamps, counters, and live state in late positions. In particular, do not inject a date or clock into the system prompt. The framework injects none by default, and that default is load-bearing. Use `CacheHint` to declare where the boundary sits rather than relying on incidental prefix stability.

One documented non-defect: `hostId`-derived automatic element ids differ across separate mounts, because the counter is per-process. They never enter the model projection, so the model-facing bytes stay mount-independent — which is what keeps a provider cache warm across processes.

## API

### Host tree

| Export                                                                     | Purpose                                                          |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `HostInstance` / `ElementInstance` / `TextInstance` / `HostType` / `Props` | Node shapes and component identity.                              |
| `createElementInstance` / `createTextInstance`                             | Constructors; strip `key` and `children` from props.             |
| `isElementInstance` / `isTextInstance`                                     | Discriminant guards.                                             |
| `HostScope` / `FormatterScope` / `FormatterBinding`                        | Lexically inherited formatter and path scope.                    |
| `createHostScope` / `rootScope`                                            | Fresh scope, and the library default (formatter id `"default"`). |
| `withFormatter` / `withPath` / `resolveFormatter`                          | Derive a scope; resolve a formatter by purpose.                  |
| `CompilerContainer` / `createContainer`                                    | One host tree root per mount.                                    |

### Collect

| Export                                             | Purpose                                                      |
| -------------------------------------------------- | ------------------------------------------------------------ |
| `collect(input)` → `CollectResult`                 | Walk roots, fold fragments, produce `{ tree, diagnostics }`. |
| `CollectInput`                                     | `roots`, `registry`, `rootScope`, optional `defaults`.       |
| `Contributor` / `CollectContext`                   | The protocol and the per-invocation context.                 |
| `IRFragment` / `NO_FRAGMENTS`                      | The fragment union and an empty return.                      |
| `ContributorRegistry`                              | `register` / `override` / `lookup` / `has` / `size`.         |
| `createBuiltInRegistry()`                          | A registry preloaded with the whole vocabulary.              |
| `Exhausted` / `UnhandledSpecKeys` / `BaseBlockKey` | The compile-time drift gate.                                 |

Individual contributors are exported alongside their props types: `sectionContributor`/`SectionProps`, `messageContributor`/`MessageProps`, `toolContributor`/`ToolProps`, `providerToolContributor`, `resourceContributor`, `outputContributor`, `mcpContributor`, `modelContributor`, `modelDeclarationContributor`, `projectContributor`/`ProjectProps`, the media set (`image`/`document`/`audio`/`video`), the textual set (`textBlock`/`code`/`json`/`xmlBlock`/`csv`/`html`/`reasoning`), the event set (`userAction`/`systemEvent`/`stateChange`), `customBlockContributor`, and `contentPassthroughContributor`.

### Projections

| Export                      | Purpose                                               |
| --------------------------- | ----------------------------------------------------- |
| `DefaultProjection`         | `{ key, project(sources) }` — runs lazily, per key.   |
| `ProjectionResult`          | `{ entries?, tools? }`.                               |
| `ProjectionSources`         | What a default reads; currently `tools`.              |
| `builtInToolsProjection`    | The `tools` default.                                  |
| `builtInDefaultProjections` | The set `collect` applies when `defaults` is omitted. |

### Compiler, bridges, dispatch

| Export                                             | Purpose                                                   |
| -------------------------------------------------- | --------------------------------------------------------- |
| `defineCompiler(input)` / `DefineCompilerInput`    | Callback-style factory for a compiler protocol.           |
| `InMemoryDataBridge` / `InMemoryDataBridgeOptions` | Reference `useData` cache.                                |
| `InMemoryModelBridge`                              | Reference per-tick model registry.                        |
| `LifecycleDispatch` / `LifecycleHandlerKind`       | Per-mount lifecycle fan-out with tick/execution catch-up. |
| `CommandInterceptorRegistry`                       | Per-mount interceptor storage, keyed by op tag.           |

### `@agentick/compiler/testing`

| Export                                                          | Purpose                                                   |
| --------------------------------------------------------------- | --------------------------------------------------------- |
| `fakeCompiler()`                                                | Pass-through factory; `renderTree` returns an empty tree. |
| `fakeBridges(options?)` / `FakeBridgesOptions`                  | A protocol-conforming bridge bundle.                      |
| `fakeTimelineHarness` / `fakeKnobsHarness` / `mockStateHarness` | Protocol doubles, no real harness behavior.               |
| `stubLoopBridge` / `stubSessionBridge`                          | Canned loop and session bridges.                          |

> [!WARNING]
> `fakeCompiler()` is for tests orthogonal to rendering — wire paths, session lifecycle, cross-layer integration. Its empty IR satisfies the protocol surface without exercising a renderer, so using it for component output, IR diagnostics, or hook lifecycle produces false-green results. Those need the real compiler from [@agentick/compiler-react](../compiler-react).

The doubles are typed against the protocol interfaces, so a protocol change breaks them at compile time. They are also re-exported from the package root for convenience; prefer the `/testing` subpath in new code.

## Patterns

**The React binding.** [@agentick/compiler-react](../compiler-react) owns the reconciler host config, the JSX runtime, the hooks, the components, and the bridge context (`BridgeProvider` / `useBridges`). It builds host instances and hands them to `collect`.

**Protocol types.** [@agentick/spec](../spec) owns `RenderedTree`, `ContextEntry`, `ToolDeclaration`, every content block, the lifecycle event union, and `CompilerFactory`. Both a contributor and the package producing its props derive from the same spec type, which is what makes spec the single sync point.

**Substrate.** [@agentick/runtime](../runtime) supplies the journal, bus, and inbox a compiler runs its operations on, plus the harness base class behind `defineCompiler`.

**Notifiers.** [@agentick/pubsub](../pubsub) backs the keyed fan-out in the data bridge and the custom-lifecycle dispatch.

## Roadmap & known gaps

- **The `defineCompiler` factory can't be called without a substrate.** The implementation falls back to a local journal, bus, and inbox when `deps` is omitted, but the protocol types the factory parameter as required — so that fallback is unreachable through the public type, and every caller must pass a substrate. Either the type should widen or the fallback should go.
- **Inbox dispatch is not wired.** A message delivered to a `defineCompiler` compiler fails with an explicit "not yet wired" error. The callback factory supports commands and lifecycle, not cluster-routed message dispatch.
- **`builtInToolsProjection` advertises every tool source.** It does not filter to declarations exposed to the model; the executor filters downstream. An authored override component for filtering or suppressing tools isn't shipped.
- **`ProjectionSources` carries only `tools`.** Resources, MCP servers, and other surfacing-capable keys have no default projection at this layer yet.
- **`semanticHtmlContributors` and `CreateContainerInput` are not exported.** The semantic-HTML contributors are registered by `createBuiltInRegistry()` but can't be imported individually, and `createContainer`'s input type has no name at the package boundary.
- **Lifecycle dispatch is serial.** Handlers are awaited one at a time for deterministic ordering. Parallel dispatch with a configurable join policy is unbuilt.
- **`<format>` validates leniently.** A missing or malformed `formatter` prop passes through with the parent scope and produces no diagnostic, so the mistake is silent.

## Verified by

- `src/__tests__/define-compiler.spec.ts` — the factory marker and shape, command delegation across mount → renderTree → unmount, the reject-versus-no-op defaults for every optional callback, and `compiler:command:*` envelope emission on the supplied bus. Its minimum-required input fixtures run through strict `tsc`, so a protocol change that adds a required field fails to compile here.
- `src/__tests__/contributors.spec.ts` — the full `collect` path (walker → contributors → fold) asserting that props reach the spec value: `<tool>` forwarding `aliases`, `providerOptions`, and `annotations.executedBy`; id, description, and exposure defaulting with child text folded into the description; `provider-tool` folding onto `declarations.providerTools`; the model generation knobs; `mcp`, `resource`, and `output` field forwarding; and the drifted-prop regressions on `csv`, `custom`, and the media blocks.
- `src/__tests__/fx-render-tree.spec.ts` — `fx.renderTree` returning a composable Effect rather than a Promise, the plain `renderTree()` as its facade, and both nesting into a single fiber tree.
- `src/__tests__/telemetry-parity.spec.ts` — an interceptor on `compiler:mount` reaching the meter with its operation labels.
- The contributor drift gate is enforced at build time, not by a test: each contributor instantiates `Exhausted<UnhandledSpecKeys<…>>`, so `pnpm typecheck` is the assertion.
- Layer A and B are additionally exercised end-to-end by the React binding's integration suites in [@agentick/compiler-react](../compiler-react), which mount a real host tree and assert the produced IR. Prompt-cache byte-stability is pinned in `packages/app/src/__tests__/prefix-stability.spec.tsx` — a static tree rendering to a byte-identical tree and model input across repeated renders, and a loop run producing an append-only prefix. Cross-package tests live where their dependencies live rather than in this dependency-light base.
