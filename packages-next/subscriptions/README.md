# @agentick/subscriptions-next

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

Unlike knobs and state, this is **not a `BaseHarness`** — it is a plain
in-memory bridge (`createSubscriptionBridge`) installed as an **app-level**
extension (`withSubscriptions()`), living for the app's lifetime and shared
across every session. The `HookBridges.subscriptions` slot is optional; the
React components throw a clear error if the extension isn't installed.

Three moving parts:

1. **The bridge** (`bridge.ts`) — holds intents. `declare(intent, handler)`
   registers one (re-declaration aborts the prior controller);
   `dispatch(id, event)` invokes the bound handler with a `SubscriptionCtx`;
   `list()` is what drivers read; `subscribe(fn)` notifies drivers of intent
   changes. Intents are JSON-serializable and snapshot via `exportSnapshot()`;
   handlers are not — on restore, intents come back as **pending** (no handler)
   and get promoted to **live** when the JSX re-declares them with a
   freshly-bound handler.
2. **The default scheduler driver** (`scheduler.ts`) —
   `attachInProcessScheduler(bridge)` watches `list()` and fires every
   `kind: "cron"` intent via `setTimeout` chains, re-evaluating live as
   `<Cron>` JSX mounts/unmounts.
3. **The React components** (`/react`) — `<Cron>`, `<Webhook>`,
   `<EventListener>`: thin declarative wrappers that `declare` an intent on
   mount and unsubscribe on unmount, reading the latest handler via a ref so
   re-renders don't thrash the declaration.

A `SubscriptionCtx` handed to the handler carries `id`, `sessionId` (`"app"`
when declared at the app level), the `signal` (aborted on re-declaration), and
free-form `metadata` the driver propagates (tenant id, source protocol, …).

## Quick start

### Install the bridge (app level)

```ts
import { createApp } from "@agentick/app-next";
import { withSubscriptions } from "@agentick/subscriptions-next";

const app = await createApp(<Agent />, {
  executor,
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
import { Cron, Webhook, EventListener } from "@agentick/subscriptions-next/react";

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

## API

### `@agentick/subscriptions-next`

- **`createSubscriptionBridge(options?)`** → `SubscriptionBridge`.
  `CreateSubscriptionBridgeOptions.sessionId` stamps the ctx (default `"app"`).
  Surface: `declare(intent, handler): Unsubscribe` · `list()` ·
  `dispatch(id, event, { metadata? })` · `subscribe(fn): Unsubscribe` ·
  `exportSnapshot()` · `importSnapshot(intents)`.
- **`attachInProcessScheduler(bridge)`** → `Unsubscribe` — the default cron
  driver. Supports 5-field cron (`min hour dom month dow` with `*`, `*/N`,
  single numbers, comma lists) and the `@hourly` / `@daily` / `@weekly` /
  `@monthly` / `@yearly` macros.
- **`withSubscriptions(options?)`** → `AppExtension`. Constructs + registers
  the bridge and (unless `scheduler: false`) attaches the in-process scheduler,
  detaching it on app close.
- Types: `SubscriptionBridge`, `SubscriptionCtx`, `SubscriptionHandler`,
  `CreateSubscriptionBridgeOptions`, `WithSubscriptionsOptions`.

### `@agentick/subscriptions-next/react`

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
in `@agentick/spec-next`.

## Patterns

**Bring-your-own scheduler.** For multi-instance deployments, disable the
in-process scheduler (`withSubscriptions({ scheduler: false })`) so two app
instances don't each fire the same cron. Run one external scheduler and have it
call `bridge.dispatch(id, …)`.

**Cross-protocol routing.** The `metadata` on `dispatch` (and on each intent)
is free-form: stamp a tenant id or source protocol on the fire and read it off
`ctx.metadata` in the handler to route a single intent across tenants.

**Persisted intents.** Feed a previously-persisted intent list through
`withSubscriptions({ initialize })` (or `importSnapshot`); they land as pending
and promote to live when the JSX re-declares them.

## Status & roadmap

Scaffolded per ADR 22 (state/formatters/reconciler shape). The bridge, the
default in-process cron scheduler, and the three React components are green.

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
- No conformance suite or `/testing` double ships today (the bridge is a plain
  in-memory impl, not a `BaseHarness` behind a protocol).

## Verified by

- `src/__tests__/bridge.spec.ts` (10 tests) — declare / list / dispatch,
  re-declaration aborting the prior controller, unknown-id dispatch error,
  metadata propagation onto the ctx, subscriber notification, and
  export/import snapshot with pending → live promotion.
- `src/__tests__/scheduler.spec.ts` (4 tests) — cron expression evaluation,
  macro handling, live re-evaluation as intents change, and clean detach.
- `src/react/__tests__/components.spec.tsx` (4 tests) — `<Cron>` / `<Webhook>`
  / `<EventListener>` declare on mount, unsubscribe on unmount, and the
  missing-extension error.

@see [`docs/proposals/v2/blueprint/22-state-formatters-reconciler-shape.md`](../../docs/proposals/v2/blueprint/22-state-formatters-reconciler-shape.md)
@see [`docs/proposals/v2/blueprint/27-modular-built-ins.md`](../../docs/proposals/v2/blueprint/27-modular-built-ins.md)
