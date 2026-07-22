# @agentick/compiler-next

Compiler-agnostic base for Agentick v2.

A **compiler** turns an agent definition (JSX, or any host tree) into the
spec's canonical `RenderedTree` IR — the model-input context, tool
declarations, and diagnostics a provider consumes. This package owns
everything about that pipeline that is **not** tied to a specific JSX runtime:
the generic host-tree shapes, the contributor protocol and `collect` walker,
the built-in contributors + surfacing projections (ADR 63), the reference
data/model bridges, and the callback-style `defineCompiler` factory.

Concrete compilers depend on this package and ship separately —
`@agentick/compiler-react-next` (the bundled React reference impl), or a
hand-rolled Angular / Vue / DSL compiler. This base has **no** dependency on
React or `react-reconciler`.

## Quick start

Most adopters never touch this package directly — they use the bundled React
compiler via `createApp`. Reach for `defineCompiler` when React isn't the
right fit (an Angular impl, a custom DSL, a test harness with no JSX):

```ts
import { defineCompiler } from "@agentick/compiler-next";
import { createApp } from "@agentick/app-next";
import { openai } from "@agentick/model-openai-next";
import { SPEC_VERSION } from "@agentick/spec-next";

// defineCompiler returns a CompilerFactory (deferred construction with
// the app's shared substrate) — not a live instance. createApp constructs it.
const myCompiler = defineCompiler({
  mount: async (input) => ({ mountId: "m_1", restoredFromSnapshot: false }),
  unmount: async () => {
    /* clean up */
  },
  renderTree: async (input) => ({
    tree: { specVersion: SPEC_VERSION, context: { entries: [] } },
    diagnostics: [],
    iterations: 1,
  }),
});

const app = await createApp(<Agent />, {
  model: openai("gpt-4o"),
  compiler: myCompiler,
});
```

`RenderTreeResult` is `{ tree, diagnostics, iterations }` — `tree` is a
`RenderedTree` (requires `specVersion` + `context`), `diagnostics` is a
`ReconcileDiagnostic[]`, and `iterations` reports how many render passes ran
before the tree stabilized.

## `defineCompiler`

A callback bundle that satisfies the spec's `CompilerProtocol`. Three
callbacks are **required**; the rest are optional and fall back to defined
behavior when omitted:

| Callback         | Required | Omitted behavior               |
| ---------------- | -------- | ------------------------------ |
| `mount`          | ✅       | —                              |
| `unmount`        | ✅       | —                              |
| `renderTree`     | ✅       | —                              |
| `rerender`       | —        | no-op (resolves)               |
| `restore`        | —        | no-op (resolves)               |
| `renderToString` | —        | **rejects** — "not configured" |
| `snapshot`       | —        | **rejects** — "not configured" |

Every command (`mount` / `renderTree` / `unmount` / `rerender`) runs through
the shared harness protocol, so it emits `compiler:command:*` envelopes on
the substrate bus and journals its operation — the callbacks are pure business
logic, the envelope/journal wiring is inherited from `BaseHarness`.

## What lives here

- **Layer A — generic host tree.** `HostInstance` / `ElementInstance` /
  `TextInstance`, `HostScope` (formatter + path scoping), and
  `CompilerContainer` — the contract a concrete compiler builds against,
  plus constructors (`createElementInstance`, `createTextInstance`,
  `createContainer`, `createHostScope`) and guards (`isElementInstance`,
  `isTextInstance`).
- **Layer B — contributor protocol + `collect` walker + built-in
  contributors.** `collect(input): CollectResult` walks a host tree and turns
  it into the spec's `RenderedTree` IR via the `Contributor` protocol and a
  `ContributorRegistry`. Built-ins (`createBuiltInRegistry`) cover `<Section>`,
  `<Message>`, `<Tool>`, `<Resource>`, `<Output>`, `<MCP>`, `<Model>`,
  `<project>`, every content block (text, image, audio, video, document, code,
  json, xml, csv, html, reasoning), event roles (user-action, system-event,
  state-change), custom blocks, and content passthrough.
- **Surfacing projections (ADR 63).** `collect` splits contributions into
  **content** (append stream) and **projections** — one per surfacing-capable
  harness key, either its `DefaultProjection` or a `<project projectionKey>`
  override. Ships the compiler-agnostic `builtInToolsProjection` (and the
  `builtInDefaultProjections` list); the `timeline` default needs a live
  timeline and is supplied by the compiler binding, not here. Every
  contribution is provenance-tagged on `RenderedTree.provenance`. The seam is
  compiler-general — a functional compiler drives the same default/override
  split.
- **Bridges.** `InMemoryDataBridge` (reference `useData` cache) and
  `InMemoryModelBridge` (reference model bridge).
- **`LifecycleDispatch`** — the compiler's half of the lifecycle projection
  (ADR 89 §4): the thin per-mount handler dispatch + the
  tick-start/execution-start catch-up cache backing `useOnTickStart` /
  `useOnTickEnd` / `useOnError` etc. in any compiler. The EVENTS come from
  the session's command-hook forwarders (via the harness's
  `dispatchLifecycle`, the optional `LifecycleProjectionTarget` capability) —
  the retired `CompilerProtocol.notifyLifecycle` feed is gone.
- **`defineCompiler`** — the callback-style `CompilerFactory` factory.

## What does NOT live here

- React-specific code — `react-reconciler`'s `HostConfig` binding, the JSX
  runtime, React hooks, JSX components. Those live in
  `@agentick/compiler-react-next`.
- `CompilerHarness` (the React reference impl) — also in
  `@agentick/compiler-react-next`.
- The `timeline` default projection — needs a live timeline; supplied by the
  compiler binding.

## Patterns

### Protocol-conforming stub for tests

`defineCompiler` is the lightest path to a compiler in tests that need a
session to exist but do **not** exercise rendering. For the common case,
`@agentick/compiler-next/testing` ships `fakeCompiler()` — a
pass-through factory whose `renderTree` always returns an empty tree:

```ts
import { fakeCompiler } from "@agentick/compiler-next/testing";

const app = await createApp(<Agent />, {
  model: openai("gpt-4o"),
  compiler: fakeCompiler(),
});
```

Use `fakeCompiler` for lifecycle / wire-path / cross-layer tests where the
rendered IR is irrelevant. **Do not** use it for rendering tests (component
output, IR diagnostics, hook lifecycle under real mount semantics) — those must
use the real `reactCompiler()` from `@agentick/compiler-react-next`, or the
empty IR produces false-green results.

## API

Full surface — every export, type, and signature — is in the
[TypeDoc reference](https://agentick.dev). Key entry points:

- **`defineCompiler(spec)` → `CompilerFactory`** and `DefineCompilerInput`.
- **`collect(input)` → `CollectResult`**, plus `Contributor`, `CollectContext`,
  `ContributorRegistry`, `createBuiltInRegistry`, and the per-node contributors
  (`sectionContributor`, `messageContributor`, `toolContributor`, …).
- **Projections** — `builtInToolsProjection`, `builtInDefaultProjections`, and
  the `DefaultProjection` / `ProjectionResult` / `ProjectionSources` types.
- **Host tree** — `HostInstance`, `ElementInstance`, `TextInstance`,
  `HostScope`, `CompilerContainer` + their constructors/guards.
- **Bridges** — `InMemoryDataBridge`, `InMemoryModelBridge`.
- **`LifecycleDispatch`** and `LifecycleHandlerKind`.
- **`@agentick/compiler-next/testing`** — `fakeCompiler`, `fakeBridges`,
  `stubLoopBridge`, `stubSessionBridge`, `fakeTimelineHarness`,
  `fakeKnobsHarness`, `mockStateHarness`. Test doubles are typed against the
  spec interfaces, so spec drift breaks them at compile time. Prefer the
  `/testing` subpath in new tests; the doubles are also re-exported from the
  package root for ergonomics.

## Verified by

- `src/__tests__/define-compiler.spec.ts` — the factory's marker/shape,
  command delegation (mount → renderTree → unmount), the reject-vs-no-op
  defaults for optional callbacks, and command-envelope emission on the
  supplied bus. Its minimum-required input fixtures run through strict `tsc`,
  so any spec change that adds a required field fails to compile here.
- Layer A/B, contributors, projections, and bridges are exercised end-to-end by
  the React compiler's integration suite — e.g.
  `packages-next/compiler-react/src/__tests__/collect.spec.tsx`,
  `content-blocks.spec.tsx`, `host-pipeline.spec.tsx`, `conformance.spec.tsx` —
  which mount a real host tree and assert the produced IR. Per the v2
  modularity rule, cross-harness tests live where their dependencies live, not
  in this dependency-light base.

## Status & roadmap

🚧 In active development as part of v2 (`feat/v2`).

- **`defineCompiler` inbox dispatch is deferred.** Inbound messages currently
  fail with an explicit "not yet wired (FAÇADE.6 MVP)" error — the callback
  factory supports commands + lifecycle, not cluster-routed message dispatch.
- **Naming.** A future v2.0-cut rename tracks compiler → compiler (#243).
  This package is documented as named/exported today (`compiler-next`); the
  rename is not yet applied.

## See also

- `docs/proposals/v2/blueprint/03-reconciler-harness.md` — protocol design
- `docs/proposals/v2/blueprint/63-compiler-surfacing.md` — ADR 63 (surfacing)
- `docs/proposals/v2/blueprint/27-modular-built-ins.md` — ADR 27 (modularity)
- `docs/proposals/v2/IMPLEMENTATION-PLAN.md` — FAÇADE.6 (the `define__` family)
  </content>
  </invoke>
