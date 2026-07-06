# @agentick/reconciler-react-next

Reference implementation of the `ReconcilerProtocol` from `@agentick/spec-next`.
Drives JSX agent definitions through `react-reconciler` (React 19) and
produces a `RenderedTree` IR ready for the executor harness.

## Purpose

This package is the React binding of the reconciler-agnostic core in
`@agentick/reconciler-next`. It owns three things adopters touch:

1. **The JSX → IR pipeline.** A `react-reconciler` HostConfig commits a
   host-instance tree; the `collect` walker folds it into a JSON-shaped
   `RenderedTree`. The host tree never crosses the harness boundary.
2. **The author-facing hook + component surface.** `useData`,
   `useSession`, `useLoopControl`, the ADR 54/55/56 lifecycle-observer,
   render-context, and per-tick-model hooks, plus the `<Section>` /
   `<Message>` / role components and the React-flavored `createTool`.
3. **The `ReconcilerHarness`** (Layer C) and the `reactReconciler()`
   factory that wires it into `createApp`.

Per ADR 27 it depends on **no** harness package. Any harness
(`knobs-next`, `timeline-next`, `state-next`, …) adds a `/react`
subpath that depends on *this* package without creating a cycle;
snapshot/restore iterates `HookBridges` generically via feature
detection — no hardcoded slot names.

## Quick Start

```tsx
import { createApp } from "@agentick/app-next/react"; // defaults reconciler to reactReconciler()
import { System, User, Section, useOnToolEnd } from "@agentick/reconciler-react-next";
import { openai } from "@agentick/model-openai-next";

function Agent() {
  useOnToolEnd((e) => {
    if (e.outcome === "failed") console.warn(`tool ${e.name} failed in ${e.durationMs}ms`);
  });
  return (
    <>
      <System>You are a terse, precise assistant.</System>
      <Section title="Task">Answer the user's question in one paragraph.</Section>
    </>
  );
}

const app = await createApp(<Agent />, { model: openai("gpt-4o") });
```

Wiring the reconciler explicitly (equivalent to the subpath default):

```tsx
import { createApp } from "@agentick/app-next";
import { reactReconciler } from "@agentick/reconciler-react-next";

const app = await createApp(<Agent />, {
  model: openai("gpt-4o"),
  reconciler: reactReconciler(),
});
```

## Architecture

Three sharply separated layers:

```
Layer A — Reconciliation
  react-reconciler ──host config──► HostInstance tree (mutable, transient)

Layer B — Collection
  HostInstance tree ──contributors──► RenderedTree (JSON, immutable)

Layer C — Harness
  BaseHarness subclass wraps renderTree as a typed command with the
  full phase contract, lifecycle handlers, middleware, inbox, events.
```

The host tree never crosses the harness boundary; only `RenderedTree`,
`ReconcilerSnapshot`, and `RenderToStringPayload` do — all JSON-shaped.

See `docs/proposals/v2/blueprint/21-reconciler-implementation.md` for
the full design.

### React feature semantics

| Feature                                   | Behavior                                                    |
| ----------------------------------------- | ----------------------------------------------------------- |
| Reconciler, hooks, refs, effects, context | full support (real React)                                   |
| `useData` (custom)                        | blocks render via thrown Promise; loop awaits & re-renders  |
| `<Suspense>` fallbacks                    | warning diagnostic; opt-in hard-fail via `strictNoSuspense` |
| `<ErrorBoundary>`                         | supported (per-section resilience)                          |
| `useTransition` / `useDeferredValue`      | allowed, no effect (sync render mode)                       |
| React Server Components                   | not supported                                               |

## API

### Components

Typed PascalCase wrappers over the host intrinsics — the canonical
author API (no `JSX.IntrinsicElements` augmentation needed).

| Component                       | Purpose                                                    |
| ------------------------------- | ---------------------------------------------------------- |
| `<Section>`                     | Structured context entry (`id`, `title`, `priority`, …)    |
| `<Message role>`                | Role-bearing entry; spread a persisted record: `{...entry.message}` |
| `<System>` `<User>` `<Assistant>` | Sugar for `<Message role="…">`                           |
| `<Paragraph>` `<H1>` `<H2>` `<H3>` | Block-level semantic wrappers                            |
| `<FormatScope>` `<Markdown>` `<XML>` `<PlainText>` | Per-subtree formatter framing            |

### Hooks

**Data · session · loop** (thin readers over `HookBridges`):

| Hook                                | Returns / signature                                  |
| ----------------------------------- | ---------------------------------------------------- |
| `useData<T>(key, fetcher, opts?)`   | `T` — blocking async resolve (throws Promise while pending; NOT Suspense) |
| `useSession()`                      | `SessionBridge` — `{ id, status, currentTick?, executionId? }` (read-only) |
| `useLoopControl()`                  | `LoopBridge` — `{ continueAfterTick(reason?), stopAfterTick(reason?) }` |
| `useToolBridge()`                   | `ToolBridge \| undefined` — handler registration bridge |
| `useModelBridge()`                  | `ModelBridge \| undefined` — per-tick model registration (ADR 56) |

**Lifecycle observers** (ADR 54/55) — register a callback fired when
the loop/executor bridges the matching event. All accept
`(event) => void | Promise<void>` and unregister on unmount:

| Hook                              | Event                    | Catch-up? |
| --------------------------------- | ------------------------ | --------- |
| `useOnTickStart(cb)`              | `LifecycleTickStart`     | **yes** — mid-tick mounts fire immediately |
| `useOnTickEnd(cb)`                | `LifecycleTickEnd`       | no        |
| `useOnExecutionStart(cb)`         | `LifecycleExecutionStart`| **yes**   |
| `useOnExecutionEnd(cb)`           | `LifecycleExecutionEnd`  | no        |
| `useOnToolStart(cb)`              | `LifecycleToolStart`     | no        |
| `useOnToolEnd(cb)`                | `LifecycleToolEnd`       | no        |
| `useOnError(cb)`                  | `LifecycleError`         | no        |
| `useOnLifecycleCustom(kind, cb)`  | `LifecycleCustom` (namespaced `kind`) | no |
| `useOnMount(cb)` / `useOnUnmount(cb)` | React commit boundaries | n/a    |

Event shapes (from `@agentick/spec-next`): `LifecycleToolEnd` carries
`{ name, outcome: "succeeded" | "failed", durationMs, callId, tickId }`;
`LifecycleError` carries `{ phase, error: { name, message, data? } }`.

**Render-context readers** (ADR 55) — synchronous per-render facts the
tree reads *while producing the IR* (not async observations):

| Hook                | Returns                                                          |
| ------------------- | --------------------------------------------------------------- |
| `useRenderContext()`| `RenderContext` — the full augmentable envelope (`{}` outside a run) |
| `useContextInfo()`  | `ContextInfo` — `{ contextWindow?, usedTokens, utilization? }`  |
| `useActiveModel()`  | `ActiveModel \| undefined` — `{ provider?, modelId?, capabilities? }` |

`useContextInfo` merges two channels by tense: the **window** rides the
synchronous `RenderContext` envelope (live during this render);
**`usedTokens`** is a past fact arriving via the async tick-end /
execution-end bridge (one-tick-behind is correct). `utilization` is the
clamped `usedTokens / contextWindow` ratio.

**Per-tick model** (ADR 56):

| Hook                                     | Returns                                       |
| ---------------------------------------- | --------------------------------------------- |
| `useModelRegistration(modelRef, resolved)` | `ReactElement` — **the caller renders it** |

`useModelRegistration` mirrors `createTool`'s `Tool` component exactly:
it registers the run-ready `RegisteredModel` on the `ModelBridge` (live
side) and returns a `<model-declaration>` host intrinsic that
contributes `declarations.model` to the IR (IR side). It returns a
`ReactElement` — not `void` — because declarations enter the IR through
exactly one path (the collector walking the committed host tree); a
`void` hook cannot contribute to the synchronous IR. The adopter
`<Model model={adapter}>` sugar that derives `resolved` from a live
adapter is a deferred slice (#169).

### `createTool` (React-flavored)

Extends `@agentick/tool-next`'s factory with a render-time `use()` slot
so a handler can close over tree-scoped context (a `<Sandbox>` handle,
an MCP server, any React Context). Returns `{ …base, Tool }` — drop the
`Tool` component in the tree; it auto-registers/unregisters the handler
on the `ToolBridge` and renders the `<tool>` intrinsic.

```tsx
import { z } from "zod";
import { createTool } from "@agentick/reconciler-react-next";

const { Tool: Shell } = createTool({
  name: "shell",
  description: "Run a command in the sandbox",
  inputSchema: z.object({ command: z.string() }),
  use: () => ({ sandbox: useSandbox() }),        // render-time hook
  handler: async ({ command }, { use }) => {
    const { stdout } = await use.sandbox.exec(command);
    return [{ type: "text", text: stdout }];
  },
});
// then render <Shell /> inside your agent tree
```

### Template entry points

Two one-shot functions for "I have a JSX tree, give me the IR / string"
without a session, harness, journal, or lifecycle. Same reconciler
infrastructure as `createApp` (same compile-until-stable loop, same
`collect` walker, same `useData` semantics) minus the reactive
scaffolding. See [Static-template rendering](#static-template-rendering)
below.

| Function                            | Returns                                          |
| ----------------------------------- | ------------------------------------------------ |
| `compileTemplate(element, opts?)`   | `{ tree, diagnostics, iterations }` — `RenderedTree` IR |
| `renderTemplate(element, opts?)`    | `{ output, diagnostics, iterations }` — formatted string |

### Harness · factory · bridges

| Export                                          | Purpose                                       |
| ----------------------------------------------- | --------------------------------------------- |
| `ReconcilerHarness` / `ReconcilerHarnessOptions`| Layer C harness (`BaseHarness` subclass)      |
| `reactReconciler(opts?)`                        | `ReconcilerFactory` — wires the harness into `createApp` |
| `createReconciler` / `createHostConfig`         | Low-level `react-reconciler` integration      |
| `BridgeProvider` / `useBridges` / `BridgeContext`| React-context wrappers over `HookBridges`    |
| `LifecycleProvider` / `useLifecycleStore` / `LifecycleContext` | wrappers over the lifecycle store |
| `enableReactDevTools` / `isReactDevToolsConnected` / `disableReactDevTools` | React DevTools bridge |

### `/testing` subpath

```ts
import { flush, waitFor } from "@agentick/reconciler-react-next/testing";
```

`flush()` awaits pending React effects (registration runs in `useEffect`
after commit); `waitFor(assertion)` polls an assertion until it passes.
Use with `fakeBridges()` from `@agentick/reconciler-next` to drive the
harness in tests.

## Patterns

Minimal → advanced. Every example below is written against the real
signatures above.

### 1. Minimal agent with a lifecycle hook

```tsx
import { System, useOnExecutionStart } from "@agentick/reconciler-react-next";

function Agent() {
  useOnExecutionStart((e) => console.log(`execution ${e.executionId} started`));
  return <System>You are a helpful assistant.</System>;
}
```

### 2. Adaptive compaction from `useContextInfo().utilization`

Render less as the window fills — the window is a synchronous render
input, so the component reacts to it *while producing the IR*.

```tsx
import { Section, useContextInfo } from "@agentick/reconciler-react-next";

function History({ entries }: { entries: string[] }) {
  const { utilization = 0 } = useContextInfo();
  // Over 80% full → keep only the last 5 entries; otherwise keep 50.
  const kept = entries.slice(-(utilization > 0.8 ? 5 : 50));
  return (
    <Section title="Conversation">
      {kept.map((text, i) => (
        <Section key={i}>{text}</Section>
      ))}
    </Section>
  );
}
```

### 3. Per-model render via `useActiveModel()`

Render *for the model you'll call* — switch scaffolds by provider, or
gate a section on a capability.

```tsx
import { Section, useActiveModel } from "@agentick/reconciler-react-next";

function Tools() {
  const model = useActiveModel();
  if (!model?.capabilities?.supportsTools) return null; // no tool section for tool-less models
  return (
    <Section title="Tool use">
      {model.provider === "anthropic"
        ? "Think step by step inside <thinking> tags before calling a tool."
        : "Reason briefly, then call a tool."}
    </Section>
  );
}
```

### 4. Tool-progress scratchpad via `useOnToolStart` / `useOnToolEnd`

Drive a "searching…" affordance and record results as tools resolve.
The `useState` here is illustrative React state; swap for
`@agentick/state-next/react`'s `useSessionState` if you need it to
survive hibernate/resume.

```tsx
import { useState } from "react";
import { Section, useOnToolStart, useOnToolEnd } from "@agentick/reconciler-react-next";

function ToolScratchpad() {
  const [inflight, setInflight] = useState<Record<string, string>>({});

  useOnToolStart((e) => setInflight((m) => ({ ...m, [e.callId]: `${e.name} running…` })));
  useOnToolEnd((e) =>
    setInflight((m) => ({
      ...m,
      [e.callId]: `${e.name} ${e.outcome} (${e.durationMs}ms)`,
    })),
  );

  const lines = Object.values(inflight);
  if (lines.length === 0) return null;
  return (
    <Section title="Tool activity">
      {lines.map((line, i) => (
        <Section key={i}>{line}</Section>
      ))}
    </Section>
  );
}
```

### 5. Corrective context after a failure via `useOnError`

```tsx
import { useState } from "react";
import { Section, useOnError } from "@agentick/reconciler-react-next";

function ErrorCorrection() {
  const [lastError, setLastError] = useState<string | null>(null);
  useOnError((e) => setLastError(`${e.phase}: ${e.error.message}`));
  if (!lastError) return null;
  return (
    <Section title="Recover" priority={100}>
      The previous attempt failed with: {lastError}. Try a different approach.
    </Section>
  );
}
```

### 6. Loop control from a lifecycle hook

```tsx
import { useLoopControl, useOnToolEnd } from "@agentick/reconciler-react-next";

function StopOnSuccess() {
  const loop = useLoopControl();
  useOnToolEnd((e) => {
    if (e.name === "submit_answer" && e.outcome === "succeeded") {
      loop.stopAfterTick("answer submitted");
    }
  });
  return null;
}
```

### 7. Blocking data resolution with `useData`

```tsx
import { Section, useData } from "@agentick/reconciler-react-next";

function Weather({ city }: { city: string }) {
  // Suspends render (throws a Promise) until resolved; the loop awaits
  // and re-renders. The component only ever sees a real value or a real
  // error — never a loading sentinel.
  const forecast = useData(`weather:${city}`, () => fetchForecast(city));
  return <Section title={`Weather in ${city}`}>{forecast.summary}</Section>;
}
```

## State hooks: `useKnob` vs `useSessionState`

Two different reactive state bridges, **each now living in its own
harness's `/react` subpath** (ADR 27 — they are no longer exported by
this package):

| Hook                            | Import from                    | Bridge        | Visibility             | Purpose                                                                 |
| ------------------------------- | ------------------------------ | ------------- | ---------------------- | ----------------------------------------------------------------------- |
| `useKnob(id, initial)`          | `@agentick/knobs-next/react`   | `KnobBridge`  | **Model-visible**      | Surface in `knobs.list()`; settable via the executor's `set_knob` tool. Agent config the model can tweak. |
| `useSessionState(key, initial)` | `@agentick/state-next/react`   | `StateBridge` | **Framework-internal** | Component state that survives mounts / hibernate-resume but is NOT visible to the model. |

Both persist through the session's snapshot/restore round-trip.
`reconciler-react`'s snapshot/restore iterates the bridges generically —
it has no hardcoded knowledge of either slot.

### Migration from v1's `useComState`

```diff
- import { useComState } from "agentick";
+ import { useSessionState } from "@agentick/state-next/react";

- const status = useComState("status", "pending");
- status.set("active");
- console.log(status());
+ const [status, setStatus] = useSessionState("status", "pending");
+ setStatus("active");
+ console.log(status);
```

Semantic is identical — same per-session storage, same persistence
through snapshots. The signal-style call API (`status()` / `status.set()`)
is replaced with React's `[value, setter]` tuple. The COM bag is gone;
the session owns a `StateBridge` instead. See
[ADR 22 §D1](../../docs/proposals/v2/blueprint/22-state-formatters-reconciler-shape.md).

## Static-template rendering

`compileTemplate` + `renderTemplate` are one-shot entry points for
static-template use cases (prompts, resources, MCP server prompts,
snapshot tests, docs generators). They skip the reactive harness
scaffolding `createApp` adopters get.

```ts
import { compileTemplate, renderTemplate } from "@agentick/reconciler-react-next";
import { xmlFormatter } from "@agentick/formatters-next";

// RenderedTree IR + diagnostics + iteration count
const { tree } = await compileTemplate(<MyTemplate />);

// Formatted string (markdown by default)
const { output } = await renderTemplate(<MyTemplate />);

// Pick a different formatter for the string pass
const { output: xml } = await renderTemplate(<MyTemplate />, { formatter: xmlFormatter });
```

`compileTemplate` halts at "stable IR": `useData` suspends resolve, the
walker collects, you get a wire-shape `RenderedTree`. `renderTemplate`
adds the formatter pass on top via `formatTree` from
`@agentick/formatters-next` — see that package's README for how
per-formatter framing rules (`frameSection` / `frameMessage` /
`blocksToText`) are owned by the formatter, not hardcoded in the
renderer.

### When to reach for `renderTemplate` vs `createApp`

| Use case                                                                       | Reach for                                                                                |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| **Authoring a prompt**                                                         | `renderTemplate` — render JSX to a string, hand to a model                               |
| **MCP server prompt / resource body**                                          | `renderTemplate` — server returns formatted text                                         |
| **Tool description with rich semantic content**                                | `renderTemplate` — `<Section>` / `<H1>` / `<Code>` etc. in your description, render once |
| **Skill content** (`@agentick/skills-next`)                                    | `renderTemplate` — JSX-authored skill bodies become wire strings                         |
| **Snapshot tests for JSX templates**                                           | `compileTemplate` — assert against a stable `RenderedTree`                               |
| **Docs generator / static site that embeds prompts**                           | `renderTemplate` — JSX in, markdown out                                                  |
| **Agentic loop, tool dispatch, hibernate/resume, channels, reactive `<Tool>`** | `createApp` — full reconciler harness                                                    |

### What the template variants do NOT provide

These functions ship with the minimum bridges needed for the walker to
run — a real `InMemoryDataBridge` for `useData`, plus trivial stubs for
`loop` and `session`. They deliberately omit:

- **Reactive bridges** (knobs, state, timeline, tools, mcp, sandbox).
  Hooks that depend on them throw at render. If your template needs
  `useKnob` / `useSessionState` / `useToolBridge` / etc., it's not a
  static template — use `createApp`.
- **Session lifecycle** (snapshot/restore, hibernation, ticks).
- **Journal / inbox / operation wrap**. Each call is a one-shot.
- **Loop control** (`continueAfterTick` / `stopAfterTick` are no-ops).

`<Tool>` created via `createTool({ use, handler })` won't register its
handler in template mode (no real ToolBridge), but the underlying
`<tool>` declaration intrinsic STILL appears on `tree.declarations.tools`
for inspection. Static templates that declare tools work fine — handler
resolution is the executor's concern at dispatch time, not the
renderer's.

`useData` works the same way: `useData(key, fetcher)` suspends via a
thrown Promise; the walker's compile-until-stable loop awaits pending
fetches and re-renders until everything resolves. Same
`InMemoryDataBridge` semantics — per-call cache (each call is fresh; no
leakage across invocations), same dedup by key, same
rejection-cached-as-failure behavior. `maxIterations` (default 10) caps
the render-until-stable loop; `awaitTimeoutMs` (no default) bounds the
per-iteration wait for suspended fetches. Both surface as `diagnostics`
entries when triggered.

## Status

Phase 3 of the v2 implementation plan — `docs/proposals/v2/STATUS.md`.
The lifecycle-observer family (ADR 54), render-context readers (ADR 55),
and per-tick-model hooks (ADR 56) have landed.

## Roadmap & known gaps

- **`<Model model={adapter}>` sugar (#169).** `useModelRegistration`
  ships today and takes a spec-typed `RegisteredModel`. The adopter-facing
  `<Model>` component that derives `resolved` from a live adapter is
  deferred.
- **Per-tick active model (#169).** `useActiveModel` reads
  `renderContext.activeModel`, which is construction-bound
  (`session.target`) today, so it is stable across ticks. Under #169 it
  becomes IR-derived per tick.
- **`ExecutionTarget.capabilities` is provisional.** The capability set
  in `@agentick/spec-next` is synthesized from v1 and marked
  `[PLACEHOLDER]` pending sign-off — treat `useActiveModel().capabilities`
  shape as not-yet-frozen.
- **`useSession` status is not reactive.** The `SessionBridge` exposes no
  subscribe; subscribe to bus events for status changes.

## Verified by

Claims above are exercised by tests in `src/__tests__/`:

- Lifecycle hooks + catch-up semantics — `lifecycle.spec.tsx`
- `useContextInfo` window/usedTokens/utilization merge — `use-context-info.spec.tsx`
- `useActiveModel` / render-context threading — `render-context.spec.tsx`
- `useModelRegistration` IR + bridge wiring — `model-registration.spec.tsx`
- `createTool` register/unregister + `use()` capture — `create-tool.spec.tsx`
- `compileTemplate` / `renderTemplate` — `template.spec.tsx`
- Bridge-backed hooks (`useData`, `useSession`, `useLoopControl`) — `hooks.spec.tsx`
- Harness phase contract — `reconciler-harness.spec.tsx`, `conformance.spec.tsx`
</content>
</invoke>
