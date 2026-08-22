# @agentick/subscriptions

`SubscriptionBridge` — the **long-lived external-trigger primitive**. A
registry of subscription _intents_ (cron schedules, webhook routes, event-bus
listeners) declared from the JSX tree, plus the seam an external driver calls
to wake the session when the trigger fires.

This is the foundation for anything that should wake up an agent from the
outside: a nightly cron, an inbound webhook, a bus event, and eventually
connectors (Slack, Telegram, …). The component declares _what_ to listen for;
a driver decides _when_ it fires; the bridge routes the fire to the declared
handler with an `AbortSignal` that re-declarations cancel.

> **Direction of flow.** Subscriptions are _inbound_ — external world → your
> session. They are not the client-facing event/subscription surface a UI uses
> to observe a session; that projection lives at the gateway/wire layer.

Private workspace package. Bundled into the `agentick` metapackage; not
published independently.

## What it is

An **app-level** extension (`withSubscriptions()`) living for the app's
lifetime and shared across every session. The `HookBridges.subscriptions` slot
is optional; the React components throw a clear error if the extension isn't
installed.

Four moving parts:

1. **The bridge** (`bridge.ts`) — the intent registry. `declare` registers one
   (re-declaration aborts the prior controller);
   `dispatch(id, event)` fires it; `invoker(id)` resolves the bound invocation
   without the operation envelope; `list()` is what drivers read;
   `subscribe(fn)` notifies drivers of intent changes. An intent lives exactly
   as long as its declaration: a handler is a live function that no store can
   hold, so a resumed session re-renders and re-declares, handler and all.
2. **The harness** (`harness.ts`) — `SubscriptionsHarness`, a `BaseHarness`
   declaring one verb, `subscriptions:dispatch`. `withSubscriptions` injects
   its `runDispatch` into the bridge so **every fire is an operation** —
   guardable, hookable, journaled. See
   [The dispatch operation](#the-dispatch-operation).
3. **The default scheduler driver** (`scheduler.ts`) —
   `attachInProcessScheduler(bridge)` watches `list()` and fires every
   `kind: "cron"` intent via `setTimeout` chains, re-evaluating live as
   `<Cron>` JSX mounts/unmounts.
4. **The React components** (`/react`) — `<Cron>`, `<Webhook>`,
   `<EventListener>`: thin declarative wrappers that `declare` an intent on
   mount and unsubscribe on unmount, reading the latest handler via a ref so
   re-renders don't thrash the declaration.

A `SubscriptionCtx` handed to the handler carries `id`, `sessionId` (`"app"`
when declared at the app level), the `signal` (aborted on re-declaration), and
free-form `metadata` the driver propagates (tenant id, source protocol, …).

## Quick start

### Install the bridge (app level)

```ts
import { createApp } from "@agentick/app";
import { withSubscriptions } from "@agentick/subscriptions";

const app = await createApp(<Agent />, {
  modelExecutor,
  extensions: [withSubscriptions()], // default in-process cron scheduler ON
});
```

`WithSubscriptionsOptions`:

- `scheduler?: boolean` — attach the default in-process cron scheduler.
  Default `true`. Set `false` when you drive cron from an external scheduler
  (k8s CronJob, BullMQ, …) and call `bridge.dispatch(id, …)` yourself.
- `initialize?: (bridge, installer) => void | Promise<void>` — runs at install
  time with the bridge already registered; use it to pre-declare intents
  (e.g. from a persisted intent list).

### Declare intents from JSX

```tsx
import { Cron, Webhook, EventListener } from "@agentick/subscriptions/react";

function Agent() {
  return (
    <>
      <Cron id="nightly-report" expr="@daily" onTick={(e, ctx) => runReport(ctx)} />

      <Webhook
        id="gh-push"
        path="/hooks/github"
        method="POST"
        onRequest={(req, ctx) => handlePush(req, ctx)}
      />

      <EventListener
        id="orders"
        channel="orders.created"
        onEvent={(evt, ctx) => process(evt, ctx)}
      />
    </>
  );
}
```

### Drive non-cron triggers

Cron fires itself via the default scheduler. Webhooks and event listeners need
an adopter-supplied driver — wire your HTTP framework or bus subscriber to the
bridge:

```ts
// Grab the bridge server-side via withSubscriptions({ initialize }) or, from
// inside a component, useSubscriptionBridge(). Then wire your HTTP route / bus
// subscriber to dispatch:
app.post("/hooks/github", async (req) => {
  await bridge.dispatch("gh-push", req.body, { metadata: { tenant } });
});
```

## The dispatch operation

A cron tick, a webhook POST, a bus event: each is _ingress_. Before ADR 92 a
driver reached into `bridge.dispatch(...)` and the declared handler simply ran
— no seam could deny it, and the journal kept no record that the system had
been woken from outside. Time-triggered ingress was the one entry point with no
operation grammar around it.

`withSubscriptions()` now installs a `SubscriptionsHarness` and injects its
`runDispatch` into the bridge, so every fire runs the full phase contract.

|                    |                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------ |
| **Verb**           | `subscriptions:dispatch`                                                                   |
| **Op name**        | `subscriptions:command:dispatch`                                                           |
| **Surface**        | `subscriptions`                                                                            |
| **Input**          | `{ id, sessionId, event, metadata }` — serializable only                                   |
| **Scope**          | `{ sessionId, subscriptionId }`                                                            |
| **Journal policy** | **PERSISTED** — `requested` + `terminal` hit the journal (the default policy; no override) |
| **Hooks**          | `onBeforeSubscriptionsDispatch` / `onAfterSubscriptionsDispatch`                           |
| **`ctx.op`**       | `"SubscriptionsDispatch"`                                                                  |

`subscriptionId` is a module augmentation of `EventScopeExtensions` (in
`augment.ts`), so it filters like any other scope dimension:

```ts
app.events({ scope: { subscriptionId: "nightly-report" } });
```

### Guarding a fire

The harness is reachable as `bridge.harness` — so anywhere you hold the bridge
(`useBridges().subscriptions`, `withSubscriptions({ initialize })`) you hold
the registration point:

```ts
withSubscriptions({
  initialize: (bridge) => {
    bridge.harness?.guard<{ id: string }>((input) =>
      quietHours() && input.id === "nightly-report"
        ? { kind: "veto", reason: "quiet-hours" }
        : undefined,
    );
  },
});
```

A veto means the handler never runs, the terminal outcome is `vetoed`, and the
driver's `bridge.dispatch(...)` promise rejects (the in-process scheduler
swallows that rejection by design — a bad fire must not tear down the
scheduler). The same handle registers middleware (`.use(...)`) and the boundary
hooks (`.hooks.onBeforeSubscriptionsDispatch(...)`) on that one seam.

### Signal form

The command input is data only — the handler **function** is not an input
(ADR 51 §1.2). The harness holds a construction-bound lookup into the bridge's
registry (`bridge.invoker(id)`) and reconstructs the invocation from the
signal. That is what makes the verb genuinely inbox-addressable: a message of
type `subscriptions:dispatch` fires the subscription with no closure in play,
through the identical body an in-process driver drives.

A fire for an `id` with nothing live declared under it throws **pre-op** — that
is admission, not work, so no operation is opened and no terminal is journaled
(ADR 92's rule). If the intent is withdrawn _between_ admission and execution,
the body fails and the terminal records it.

## API

### `@agentick/subscriptions`

- **`createSubscriptionBridge(options?)`** → `SubscriptionBridge`.
  `CreateSubscriptionBridgeOptions`: `sessionId` stamps the ctx (default
  `"app"`); `runDispatch` injects the operation wrapper; `harness` surfaces the
  harness as `bridge.harness`. Both are supplied by `withSubscriptions`;
  omitted (the bare bridge) `dispatch` invokes the handler directly, exactly as
  before. Surface: `declare(intent, handler): Unsubscribe` · `list()` ·
  `dispatch(id, event, { metadata? })` · `invoker(id)` ·
  `subscribe(fn): Unsubscribe` · `harness?`.
- **`SubscriptionsHarness`** — the `BaseHarness` declaring
  `subscriptions:dispatch`. Constructed by `withSubscriptions` against the
  installer substrate with `{ resolveInvoker }` (the construction-bound
  registry lookup). Public surface: `dispatch(input)` (the declared verb),
  `runDispatch` (the bridge-injected runner), plus the inherited `guard` /
  `use` / `hook` / `hooks` / `events` seams.
- **`attachInProcessScheduler(bridge)`** → `Unsubscribe` — the default cron
  driver. Supports 5-field cron (`min hour dom month dow` with `*`, `*/N`,
  single numbers, comma lists) and the `@hourly` / `@daily` / `@weekly` /
  `@monthly` / `@yearly` macros.
- **`withSubscriptions(options?)`** → `AppExtension`. Constructs the harness
  against the installer substrate, constructs + registers the bridge wired to
  it, and (unless `scheduler: false`) attaches the in-process scheduler.
  Closing the app detaches the scheduler and closes the harness.
- Types: `SubscriptionBridge`, `SubscriptionCtx`, `SubscriptionHandler`,
  `SubscriptionDispatchInput`, `SubscriptionDispatchRunner`,
  `SubscriptionInvoker`, `SubscriptionsHarnessOptions`,
  `CreateSubscriptionBridgeOptions`, `WithSubscriptionsOptions`.

### `@agentick/subscriptions/react`

- **`<Cron id expr onTick metadata? />`** — `expr` is 5-field cron or a macro;
  `onTick` receives `{ firedAt: number }`.
- **`<Webhook id path method? onRequest metadata? />`** — declares an HTTP
  intent; an external HTTP driver dispatches matching requests.
- **`<EventListener id channel onEvent metadata? />`** — declares a bus /
  queue listener intent.
- **`useSubscriptionBridge()`** → `SubscriptionBridge | undefined` — escape
  hatch for custom subscription shapes the standard components don't cover.
- Re-exports `withSubscriptions`, `createSubscriptionBridge`, and the bridge
  types for single-import adoption.

The `SubscriptionIntent` shape (`{ id, kind, config, metadata? }`) is defined
in `@agentick/spec`.

## Patterns

**Bring-your-own scheduler.** For multi-instance deployments, disable the
in-process scheduler (`withSubscriptions({ scheduler: false })`) so two app
instances don't each fire the same cron. Run one external scheduler and have it
call `bridge.dispatch(id, …)`.

**Cross-protocol routing.** The `metadata` on `dispatch` (and on each intent)
is free-form: stamp a tenant id or source protocol on the fire and read it off
`ctx.metadata` in the handler to route a single intent across tenants.

**Intents an adopter owns.** `withSubscriptions({ initialize })` runs against
the bridge at install, so an adopter that keeps its own durable intent list can
re-`declare` each one with a freshly-bound handler before the first render.

## Status & roadmap

Scaffolded per ADR 22 (state/formatters/compiler shape). The bridge, the
dispatch operation (ADR 92 Family 1 §2), the default in-process cron scheduler,
and the three React components are green.

- **Default scheduler is single-process, best-effort.** Two app instances each
  get their own scheduler and will fire the same intent twice — use an external
  scheduler for multi-instance. Drift is whatever `setTimeout` gives (fine for
  hourly/daily, bad for sub-second). No catch-up after a missed window: if the
  process is suspended past a fire time, that occurrence is dropped.
- **Cron parser is deliberately small.** 5-field + macros, with `*`, `*/N`,
  single numbers, and comma lists. No ranges, no day-of-week names. Adopters
  needing a richer parser supply their own driver.
- **Webhook / event-listener drivers are adopter-supplied.** This package ships
  only the cron driver; HTTP routes and bus subscribers are wired by the
  adopter to `bridge.dispatch`.
- **Connectors (Slack / Telegram / …)** are the motivating future consumer of
  this primitive; not yet built.
- No conformance suite or `/testing` double ships today. The bridge is a plain
  in-memory registry, and `SubscriptionsHarness` has no protocol interface in
  `@agentick/spec` yet (its one verb is reached through the bridge), so there
  is nothing for a stub to be typed against.
- **The dispatch op does not project to the wire.** The verb is
  inbox-addressable (default `exposure`), but no `WireMethods` row is declared
  — firing a subscription from a client is a capability decision that has not
  been made.
- **`origin` on a fire is the default `"host"`.** A driver cannot yet stamp the
  gate it came through (`"wire"` for a webhook, `"system"` for the scheduler);
  `bridge.dispatch` takes no `origin`. Add it when a driver needs the audit
  distinction.
- **App-scope interceptors do not reach the dispatch op yet.** The harness
  accepts `inheritedInterceptors` / `interceptorParent`, but `AppInstaller`
  exposes no handle to the host `AppHarness`, so `withSubscriptions` cannot
  thread them (no `AppExtension` in the tree does). Until it can, an
  `app.guard(...)` does **not** wrap subscription fires — register on
  `bridge.harness` instead. Tracked at the `TODO(adr-92)` in `extension.ts`.

## Verified by

- `src/__tests__/dispatch-operation.spec.ts` (10 tests) — a driver fire emits
  `subscriptions:command:dispatch` with the `{ sessionId, subscriptionId }`
  scope; `requested` + `terminal` are JOURNALED, not bus-only; the in-process
  scheduler's tick takes the same op path; the op input is the data-only signal
  form; a guard veto blocks a scheduled fire (handler never runs, terminal
  `vetoed`, driver promise rejects) and can veto one subscription while a
  sibling proceeds; `bridge.harness` is a working guard-registration handle;
  the bare bridge (no `runDispatch`) still dispatches directly and exposes
  `invoker()`.
- `src/__tests__/bridge.spec.ts` (7 tests) — declare / list / dispatch,
  re-declaration aborting the prior controller, unknown-id dispatch error,
  metadata propagation onto the ctx, subscriber notification, and the
  unsubscribe a declare hands back.
- `src/__tests__/scheduler.spec.ts` (4 tests) — cron expression evaluation,
  macro handling, live re-evaluation as intents change, and clean detach.
- `src/react/__tests__/components.spec.tsx` (4 tests) — `<Cron>` / `<Webhook>`
  / `<EventListener>` declare on mount, unsubscribe on unmount, and the
  missing-extension error.

@see [`docs/proposals/v2/blueprint/22-state-formatters-reconciler-shape.md`](../../docs/proposals/v2/blueprint/22-state-formatters-reconciler-shape.md)
@see [`docs/proposals/v2/blueprint/27-modular-built-ins.md`](../../docs/proposals/v2/blueprint/27-modular-built-ins.md)
