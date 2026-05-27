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

- `defineReconciler` — callback-style `ReconcilerProtocol` factory.
  Required callbacks: `mount`, `unmount`, `renderTree`. Optional:
  `rerender`, `notifyLifecycle`, `renderToString`, `snapshot`, `restore`.

## What does NOT live here

- The React reconciler — `@agentick/reconciler-react` owns that.
- JSX intrinsic types, JSX runtime — those are tied to specific JSX
  runtimes and live in the concrete reconciler packages.
- Contributors, `<Tool>` / `<Section>` / `<Message>` components — those
  are React-specific in v2 today (they depend on React hooks). They
  live in `@agentick/reconciler-react`.

## See also

- `docs/proposals/v2/blueprint/03-reconciler-harness.md` — protocol design
- `docs/proposals/v2/blueprint/27-modular-built-ins.md` — ADR 27
- `docs/proposals/v2/IMPLEMENTATION-PLAN.md` — FAÇADE.6 (the `define__`
  family)
