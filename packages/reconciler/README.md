# @agentick/reconciler

Reconciler-agnostic base for Agentick v2.

This package owns the callback-style `defineReconciler` factory and any
reconciler-flavored utilities that don't depend on a specific JSX
runtime. Concrete reconcilers — React (`@agentick/reconciler-react`),
Angular, Vue, custom DSLs — depend on this package and ship as separate
implementations.

## Quick start

```ts
import { defineReconciler } from "@agentick/reconciler";

const myReconciler = defineReconciler({
  async mount(input) {
    // wire up your JSX-equivalent runtime
    return { mountId: "m_1" };
  },
  async unmount() {
    // clean up
  },
  async renderTree(input) {
    return {
      mountId: input.mountId,
      tree: { context: { entries: [] }, declarations: {} },
      diagnostics: { warnings: [], errors: [] },
      version: 1,
    };
  },
});

import { createApp } from "@agentick/app";
const app = await createApp(myAgent, {
  executor: openai("gpt-4o"),
  reconciler: myReconciler,
});
```

## What this package is for

- **Custom reconciler authors** — building an Angular, Vue, or
  hand-rolled reconciler? Depend on `@agentick/reconciler`, not
  `@agentick/reconciler-react`.
- **Test stubs** — `defineReconciler` is the lightest path to a
  protocol-conforming stub for tests that don't need a real JSX runtime.

## What lives here

- **Layer A — Generic host tree shapes.** `HostInstance`,
  `ElementInstance`, `TextInstance`, `HostScope`, `ReconcilerContainer`
  — the contract concrete reconcilers (React, Angular, …) build
  against.
- **Layer B — Contributor protocol + collect walker + built-in
  contributors.** Turns a host tree into the spec's `RenderedTree` IR.
  Built-ins cover `<Section>`, `<Message>`, `<Tool>`, `<Resource>`,
  `<Output>`, `<MCP>`, `<Model>`, all content blocks (text, image,
  audio, video, document, code, json, …), event roles, custom blocks,
  and semantic HTML.
- **Bridges.** `InMemoryDataBridge` (reference impl), plus
  protocol-conforming mocks (`stubBridges`, `mockTimelineHarness`,
  `mockKnobsHarness`, `mockStateHarness`) used by tests across the
  workspace.
- **`LifecycleStore`** — generic per-mount lifecycle handler registry.
  Used by `useOnTickStart` / `useOnTickEnd` / `useOnError` / etc. in
  any reconciler.
- **`defineReconciler`** — callback-style `ReconcilerProtocol` factory.
  Required callbacks: `mount`, `unmount`, `renderTree`. Optional:
  `rerender`, `notifyLifecycle`, `renderToString`, `snapshot`,
  `restore`.

## What does NOT live here

- React-specific code — `react-reconciler`'s `HostConfig` binding, JSX
  runtime, React hooks, JSX components. Those live in
  `@agentick/reconciler-react`.
- `ReconcilerHarness` (the React reference impl) — also in
  `@agentick/reconciler-react`.

## See also

- `docs/proposals/v2/blueprint/03-reconciler-harness.md` — protocol design
- `docs/proposals/v2/blueprint/27-modular-built-ins.md` — ADR 27
- `docs/proposals/v2/IMPLEMENTATION-PLAN.md` — FAÇADE.6 (the `define__`
  family)
