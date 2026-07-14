# @agentick/client-next

Canonical TypeScript implementation of the agentick `ClientProtocol`.

Runs in **Node 22+, browsers, Bun, Deno, and edge runtimes** — zero DOM
assumptions, zero platform-specific imports. The client is a thin proxy
over the same harness protocols the server exposes in-process, so
adopters write the same code regardless of whether they're talking to a
gateway in the same process or across the wire.

## What this package is

`ClientProtocol` is **the TypeScript contract** that lives in
`@agentick/spec-next/client`. **Multiple implementations can conform**:

- `@agentick/client-next` (this package) — the canonical impl
- a test mock implementing the same interface
- a future Worker-thread proxy that runs the real client in a Worker
  and surfaces the protocol on the main thread
- adopters who need bespoke shapes for their environment

Applications that consume a `ClientProtocol` (a TUI, a web app, a CLI)
do not depend on this package's internals — they depend on the
interface in spec.

The wire that crosses the network is defined in
`@agentick/spec-next/wire` (JSON-RPC 2.0, MCP-aligned). Non-TypeScript
clients (Python, Go, Rust, Swift) speak that wire directly without
touching this package.

## Architecture

```
                    ┌────────────────────────────────┐
                    │ Application (TUI, web, CLI…)   │
                    └───────────────┬────────────────┘
                                    │ uses
                                    ▼
                    ┌────────────────────────────────┐
                    │ ClientProtocol (in spec/client)│
                    │   ──── implemented by ────     │
                    │ @agentick/client-next          │   ← this package
                    └───────────────┬────────────────┘
                                    │ uses
                                    ▼
                    ┌────────────────────────────────┐
                    │ ClientTransport (in spec/client)│
                    │   ──── implemented by ────     │
                    │ @agentick/transport-*-next     │
                    └───────────────┬────────────────┘
                                    │
                                    ▼
                    ┌────────────────────────────────┐
                    │ JSON-RPC 2.0 wire              │
                    │ (in spec/wire)                 │
                    └────────────────────────────────┘
```

## Quick start

```ts
import { createClient } from "@agentick/client-next";
import { inProcessTransport } from "@agentick/transport-in-process-next";
// or: import { websocket } from "@agentick/transport-websocket-next/client";

const client = await createClient({
  transport: inProcessTransport({ handler: myHandler }),
});

await client.connect();

// Flat shortcut for the 90% case. `send()` returns the handle synchronously
// (events via `.events()` + `.result`) — no await here; you await `.result`.
const handle = client.send("sess-123", {
  messages: [{ role: "user", content: "hello" }],
});

// Observe events one at a time via `.events()`:
for await (const event of handle.events()) {
  console.log(event);
}

const finalResult = await handle.result;

await client.close();
```

## Everything hangs off one `client`

No context objects, no emitter strings, no hand-rolled queries — the whole
surface is discoverable on the client instance, and each streaming call
exposes its event stream via `.events()`:

```ts
// Run + stream, all on the handle:
const handle = client.send(sessionId, { messages });
for await (const event of handle.events()) render(event); // ← the event stream
await handle.result;                              //   ← …and the final result

// Observe, uniformly — all return an Unsubscribe:
client.onStateChange((s) => setBadge(s));         // connection state
client.onCapabilitiesChange((c) => gate(c));      // feature flags, live across reconnect

// Signals + channels are PRE-SCOPED on the handle — no repeating { kind, id }:
client.session(id).onLog((e) => log(e.level, e.data));
client.session(id).onProgress((e) => bar(e.progress, e.total));
client.session(id).channelView("task-status");    // zero-config: latest frame wins
// …the generic client.onLog(scope, cb) stays as the escape hatch for a
// scope you don't hold a handle for.

// Intercept outbound requests by method, typed off the wire. The hook
// mirrors the session op it initiates — `onBeforeSessionSend`, no prefix:
client.hook({
  onBeforeSessionSend: (params) => ({ ...params }), // or throw to abort
  onAfterSessionSend: (result) => result,
});

// Resource handles mirror the server harnesses 1:1:
client.gateway().listApps();
client.app(appId).createSession();
client.session(id).dispatch("tool", input);
```

Prefer free functions (tree-shaking, or code typed against bare `ClientProtocol`)?
`onLog` / `onProgress` also ship as `onLog(client, scope, cb)` — the instance
methods just delegate. Same types, your call.

## API surface

### `createClient(options): Promise<Client>`

```ts
interface CreateClientOptions {
  transport: ClientTransport;
  extensions?: readonly ClientExtension[];
  id?: string;
  // Client-LOCAL lifetime observers, registered at construction:
  onStateChange?: (state: ClientState) => void;
  onCapabilitiesChange?: (caps: ClientCapabilities) => void;
}
```

Returns a `Client` (= `ClientProtocol` widened with any extension-registered namespaces via `ClientNamespaces` declaration merging).

`onStateChange` / `onCapabilitiesChange` are convenience shorthands for
`client.onStateChange(fn)` / `client.onCapabilitiesChange(fn)` — wire a status
badge or feature-gate at construction without threading the instance. They live
for the client's lifetime. (Signal receivers `onLog` / `onProgress` are NOT
client-config options: they are scoped, so they belong on the resource handles —
`client.session(id).onLog(cb)`.)

### Resource handles

- `client.gateway()` → `GatewayHandle` (`listApps`, `getApp`, `events`)
- `client.app(id)` → `AppHandle` (`createSession`, `listSessions`, `runOnce`, `events`)
- `client.session(id)` → `SessionHandle` (`send`, `dispatch`, `abort`, `queue`, `snapshot`, `events`)

Shapes mirror the in-process `GatewayHarnessProtocol` / `AppHarnessProtocol` / `SessionHarnessProtocol`.

Every handle also carries the subscription surface **pre-scoped to its scope** —
`onLog(handler, opts?)`, `onProgress(handler, opts?)`, `channelView(channel, config?)`
— so `client.session(id).onLog(cb)` scopes to `{ kind: "session", id }` for you.
This is the 90% form. The generic `client.onLog(scope, cb)` / `client.channelView(scope, …)`
are the escape hatch for a scope you don't hold a handle for.

### Runtime signals — `onLog` / `onProgress` (ADR 64)

Tools and harnesses emit `log` / `progress` signals as bus events; the
gateway projects matching events to subscribed clients over the
existing `subscribe` channel. `onLog` / `onProgress` build the
cross-surface wildcard query and map each envelope to its decoded
payload plus origin scope, so app code doesn't hand-roll it.

**Three surfaces, same types — the pre-scoped handle form is the 90%:**

```ts
// (a) PRE-SCOPED on the handle — the 90%: no repeating { kind, id }:
const off = client.session(sessionId).onLog((e) => {
  // e: { level, data, logger?, scope }
  console.log(e.level, e.data);
});
client.session(sessionId).onProgress((e) => {
  // e: { token, progress, total?, message?, scope }
});
off(); // closes the underlying subscription
// …also client.app(id).onLog(cb) and client.gateway().onProgress(cb).

// (b) generic instance method — the escape hatch for a scope you don't
//     hold a handle for; you pass the scope explicitly:
client.onLog({ kind: "session", id: sessionId }, (e) => console.log(e.level, e.data));

// (c) free function — same call, tree-shakeable, works against any
//     ClientProtocol impl (the instance methods just delegate to this):
import { onLog, onProgress } from "@agentick/client-next";
onLog(client, { kind: "session", id: sessionId }, (e) => console.log(e.level, e.data));
```

The handle method is `client.session(id).onLog(handler, opts?)`; it bakes the
scope in and delegates to `onLog(client, scope, handler, opts?)`. Use whichever
fits; all three share the exact same types.

A `useLog` React hook is deferred until a `client-react` surface exists
(see `TODO(#19-react)` in `src/signals.ts`); `onLog` is the framework-
agnostic primitive it will wrap.

### Channel consumer — `channelView` (ADR 33)

`channelView` is the generic primitive for reading a `session:channel:<x>`
on the client: a pure **fold** over one channel subscription (the K8s
watch-list / `sendInitialEvents` model).

Three surfaces, same types — the pre-scoped handle form is the 90%:

```ts
import { channelView, type ChannelView } from "@agentick/client-next";

// (a) PRE-SCOPED + ZERO-CONFIG — the 90%. No scope, no config: the default
//     fold is last-frame-payload-wins, so the view holds the latest frame
//     payload (undefined before the first frame):
const status = client.session(sessionId).channelView("task-status");
status.get(); // the whole latest task-status object, or undefined

// (b) pre-scoped WITH an explicit reducer — for snapshot+delta channels:
const view: ChannelView<Store> = client.session(sessionId).channelView("knobs-state", {
  initial: {}, // value get() returns until the first frame folds in
  reduce: (state, frame) => (frame.kind === "snapshot" ? seed(frame) : fold(state, frame)),
});

// (c) generic instance method / free function — the escape hatch, scope explicit:
const view2 = client.channelView(scope, "knobs-state", { initial: {}, reduce });
const view3 = channelView<Store, Frame>(client, scope, "knobs-state", { initial: {}, reduce });

const off = view.subscribe(() => render(view.get())); // useSyncExternalStore contract
view.get(); // current folded state
view.close(); // tears down the subscription
```

**`config` is OPTIONAL everywhere.** Omitted, the default fold is
**last-frame-payload-wins** (`initial = undefined`, `reduce = (_prev, frame) => frame`).
That suits **full-object-per-frame** channels like `task-status`, where every
frame carries the whole object. **Snapshot+delta** channels like `knobs-state`
still need an explicit `reduce` — which is exactly why the typed façades
(`knobsStateView`) supply one.

The handle method `client.session(id).channelView(channel, config?)` bakes the
scope in and delegates to `channelView(client, scope, channel, config?)`. All
three share the same `ChannelView` / `ChannelViewConfig` types (defined in
`@agentick/spec-next`, re-exported here).

The subscription **opens with a snapshot frame**, then streams deltas on the
**same** ordered stream — so there is **no baseline pull and no cursor**. The
snapshot is simply frame one, which makes snapshot↔stream ordering correct by
construction (no race to reconcile). `channelView` folds every frame onto held
state via `reduce` and exposes it through the `useSyncExternalStore` contract
(`get()` + `subscribe()`), so a future `client-react` `useChannel(view)` hook
is a one-liner. `close()` tears down; a malformed frame is skipped rather than
tearing down the stream.

The primitive stays **dumb** — it does not know what a snapshot is.
`reduce(state, frame)` handles whatever the producer sends: a snapshot-kind
frame seeds, a delta-kind frame folds. That is the producer's + reducer's
concern, which is why the same `channelView` covers both snapshot+delta
channels (`knobs-state`) and full-object-per-item channels (`task-status`).

It is knobs/tasks-**agnostic**: typed façades (`knobsStateView`,
`taskStatusView`, `collectionView`) live in their own **harness** packages
(e.g. `@agentick/knobs-next/client`) and supply `reduce` — they do not live
here. Config: `ChannelViewConfig<T, F>` = `{ initial: T; reduce: (state, frame) => T }`.

**Layering:** the typed façades (`knobsStateView` / `taskStatusView`) are the
**sugar on top** — they hide the channel name, frame kinds, and reducer.
`channelView` is the **generic escape hatch** beneath them, shipped as **both**
`client.channelView(…)` (instance method) and `channelView(client, …)` (free
function). Reach for the façade for a known resource; drop to `channelView` for
a bespoke channel.

### Capabilities + server info

`client.connect()` runs a two-step handshake — `initialize` (protocol version + framework flags + server info) then `_extensions/list` (wire-extension enumeration for feature-gating). Both populate `client.capabilities` and `client.serverInfo`.

```ts
await client.connect();

// Framework flags advertised by the server:
if (client.capabilities.framework.progress) {
  // server supports notifications/progress
}

// Feature-gate on wire-extension methods:
if (client.capabilities.hasMethod("mcpClients/reauthenticate")) {
  showConnectButton();
}
if (client.capabilities.hasNamespace("crm")) {
  mountCrmAdminPanel();
}

// Full enumeration for admin UIs:
for (const ext of client.capabilities.extensions) {
  console.log(`${ext.name} v${ext.version} — ${ext.methods.join(", ")}`);
}

// Server identity:
console.log(client.serverInfo?.name, client.serverInfo?.version);
```

**Timing.** Before `connect()` returns: capabilities empty, `serverInfo` undefined. After successful connect: populated. On disconnect / reconnect: cleared, then repopulated on the next successful connect. Extension sets are per-connection.

**Graceful degradation.** If the server returns `MethodNotFound` for either `initialize` or `_extensions/list` (older-server transitional compat), that RPC's result is skipped and connect proceeds — leaving that portion of `capabilities` empty. Every other error surfaces as a rejected `connect()`.

**Type-augmentable slots.** `capabilities.framework` (aka `ServerCapabilities`) is declaration-merge extensible for adopters that want typed boolean flags. `capabilities.ext` (aka `ClientCapabilityExtensions`) is an empty-seed slot reserved for future richer per-extension typed metadata — declaration-merge into it to add typed slots as adopters/extensions add per-extension metadata blobs to `_extensions/list` responses.

**Reactive to server changes (#311).** The client subscribes to `notifications/capabilities/changed` at connect time. When the server emits it (currently manual via `gateway.notify(...)`, #308 will wire dynamic install/uninstall to fire it automatically), the client refetches `_extensions/list` and swaps the capability snapshot. Adopters observe via `onCapabilitiesChange`:

```ts
const unsub = client.onCapabilitiesChange((caps) => {
  // Fires on: initial handshake, post-reconnect handshake,
  // notifications/capabilities/changed refetch, and wire drop
  // (empty snapshot). Same payload as reading client.capabilities
  // at the moment it fires.
  refreshFeatureGates(caps);
});
```

**Synchronizing on "capabilities settled."** `client.whenReady()` awaits every currently in-flight capability-syncing operation — post-reconnect handshake AND refetches from `notifications/capabilities/changed`. Adopters wanting to gate on a fresh snapshot use it directly:

```ts
gateway.notify({ method: "notifications/capabilities/changed", params: {} });
await client.whenReady();
// client.capabilities now reflects the fresh server view
```

### Extensions

```ts
import type { ClientExtension } from "@agentick/spec-next";

const retry: ClientExtension = {
  name: "retry",
  async request(req, next) {
    for (let i = 0; i < 3; i++) {
      try {
        return await next(req);
      } catch (e) {
        if (i === 2) throw e;
      }
    }
    throw new Error("unreachable");
  },
};

const client = await createClient({ transport, extensions: [retry] });
```

Three surfaces:

- **`request` / `subscribe` middleware** — chain of responsibility wrapping wire calls. Promise-native; outer→inner composition (first in array = outermost). Use `effectMiddleware()` for an Effect-flavored alternative.
- **Lifecycle handlers** — `connection:lost`, `auth:expired`, `subscription:evicted`, `rpc:error`. Per-event merge rules (`observer` / `first-non-null-wins` / `any-reconnect-wins`).
- **`install(installer)`** — bus subscriber + namespace registration + onClose handlers.

Adopters extending the public surface:

```ts
declare module "@agentick/spec-next" {
  interface ClientNamespaces {
    offline: { pending(): Promise<Request[]>; flush(): Promise<void> };
  }
}
```

### `effectMiddleware(mw)`

Opt-in adapter for adopters who prefer the Effect-native signature
(`(input, next) => Effect.Effect<Result, Error, never>`). The canonical
middleware shape is Promise-based because most adopters write trivial
wrappers.

### Client hooks — `client.hook` / `client.hooks`

Intercept outbound wire requests by method, symmetric with the server's
`harness.hook` / `harness.hooks` (ADR 83). A **before-hook** transforms the
request `params` (or throws to abort the request before it leaves); an
**after-hook** transforms the `result` the caller sees. Hooks are read **live**
per request — register or remove them any time — and when none are registered
the request path is zero-overhead.

The names are typed off `WireMethods`, and the client hook **mirrors the
session op it initiates**: the client is the side that INITIATES the send the
session executes, so `session/send` → `onBeforeSessionSend` — the same name as
the session's op hook, because it IS that send observed from the initiating end.
No `wire:` prefix here. The `Wire*` qualifier lives on the GATEWAY's
wire-dispatch boundary, where the inbound `wire:session/send` op and the folded
`session:send` op collide under live inheritance and must stay distinguishable;
the client has no such collision.

Two surfaces, both returning an `Unsubscribe`:

```ts
import { createClient } from "@agentick/client-next";

const client = await createClient({ transport });

// 1. Batch config — register several at once:
const off = client.hook({
  // before: `throw` to abort, return reshaped params to transform, or
  // return nothing to pass them through unchanged. `params` is typed as
  // WireParams<"session/send">.
  onBeforeSessionSend: (params, ctx) => {
    if (overBudget()) throw new Error("client budget exceeded"); // request never leaves
    return params; // (or a reshaped copy)
  },
  // after: observe or transform the result the caller receives
  onAfterSessionSend: (result, ctx) => {
    metrics.record(ctx.method);
    return result; // (or a reshaped copy)
  },
});
off(); // remove them all

// 2. Per-method proxy — one registrar, live:
const stop = client.hooks.onBeforeAppRunOnce((params, ctx) => {
  audit(ctx.method); // ctx.method === "app/run_once"
  return params;
});
```

The hook context is `{ method, signal }` (`method` is the wire method being
called; `signal` the request's `AbortSignal`). `client.hook(config)` and every
`client.hooks.on…` registrar return an `Unsubscribe`.

## Patterns

### Talk to a remote gateway over WebSocket

```ts
import { createClient } from "@agentick/client-next";
import { websocket } from "@agentick/transport-websocket-next/client";

const client = await createClient({
  transport: websocket({ url: "wss://example.com/agentick" }),
});

await client.connect(); // runs the handshake, populates capabilities

// The transport reconnects with exponential backoff + full jitter on a
// drop; the client re-runs the handshake and swaps the capability
// snapshot, so feature gates stay live across reconnects.
client.onCapabilitiesChange((caps) => refreshFeatureGates(caps));

await client.send("sess-123", {
  messages: [{ role: "user", content: "hello" }],
}).result;
```

On a runtime without a global `WebSocket` (Node 18/20, or when you need
custom upgrade headers) pass the constructor explicitly:

```ts
websocket({ url, WebSocket: (await import("ws")).WebSocket });
```

> **Multi-transport `selector()` and multi-tab multiplexing are declared
> in ADR 33 but not yet shipped** — see [Roadmap & known gaps](#roadmap--known-gaps)
> and the [Development plan](#development-plan) (phases 33.D / 33.G).
> The `createClient({ transport })` seam is the extension point either
> will slot into with no application-code change.

### Scope escalation — the same subscription, wider

The pre-scoped handle methods are the 90%; the tiers below them exist for when
you need a wider net or don't hold the handle:

```ts
client.session(id).onLog(cb);                 // this session
client.app(appId).onLog(cb);                  // every session under an app — one subscription
client.gateway().onLog(cb);                   // deployment-wide

// don't hold a handle? pass the scope. Same call, same types:
client.onLog({ kind: "session", id }, cb);

// resume from a persisted cursor after a reconnect gap:
client.session(id).onProgress(render, { fromCursor: savedCursor });
```

### channelView — three levels of control

```ts
// (1) zero-config: full-object-per-frame channel, latest wins
const status = client.session(id).channelView<TaskStatus>("task-status");
status.get();                                 // TaskStatus | undefined

// (2) custom fold: derive whatever state you want from snapshot + deltas
const online = client.session(id).channelView<Set<string>, PresenceFrame>("presence", {
  initial: new Set(),
  reduce: (set, frame) =>
    frame.kind === "snapshot"
      ? new Set(frame.ids)
      : frame.op === "join"
        ? new Set(set).add(frame.id)
        : (set.delete(frame.id), set),
});

// (3) typed façade — zero config AND the correct fold, from the harness package
import { knobsStateView } from "@agentick/knobs-next/client";
const knobs = knobsStateView(client, id);           // snapshot+delta handled for you
```

All three return the same `useSyncExternalStore` contract (`get()` / `subscribe()`
/ `close()`), so a React binding is one `useSyncExternalStore` call over any of them.

### Cross-cutting request policy with client hooks

Hooks are method-scoped, typed off the wire, mirror the session op they
initiate (`onBeforeSessionSend`, no prefix), and are live — add or remove them
any time; an empty registry is zero-overhead:

```ts
// gate sends on a local budget, observe/reshape results. ctx is { method, signal }:
const off = client.hook({
  onBeforeSessionSend: (params) => {
    if (overBudget()) throw new Error("client budget exceeded"); // never leaves
    return params;                                                // or a reshaped copy
  },
  onAfterSessionSend: (result, ctx) => {
    metrics.timing(ctx.method, result);          // observe, or reshape the result
    return result;
  },
});
client.hooks.onBeforeAppRunOnce((p) => ({ ...p, idempotencyKey: p.idempotencyKey ?? ulid() }));
off();                                           // remove the batch
```

### Consuming the execution stream

`events()` yields typed `StreamEvent`s; `.result` assembles the final answer
independently; `.abort()` cancels in flight:

```ts
const handle = client.send(id, { messages });

for await (const ev of handle.events()) {
  if (ev.type === "content-delta") ui.append(ev.delta);
  if (ev.type === "tool-call") ui.showToolCall(ev);
  if (cancelled) await handle.abort();           // structured cancel
}

const { response, usage, stopReason } = await handle.result;
if (stopReason === "aborted") ui.markCancelled();
```

### One handle, the whole session

The scoped subscriptions, the channel views, and `send` all hang off the one
session handle — reach for it once:

```ts
const s = client.session(id);
s.onLog(logPanel.add);
const status = s.channelView("task-status");   // zero-config view — stays on the handle
const handle = s.send({ messages });
```

## Status

Phase 33.B of the v2 implementation plan — see `docs/proposals/v2/STATUS.md` and `docs/proposals/v2/blueprint/33-client-and-transports.md`.

## Verified by

Every claim in this README has a corresponding test, or appears below
under "Roadmap & known gaps" with an explicit marker.

| Concern                                                                                                                           | Test file                                                     |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `createClient`, `connect`, `close`, request dispatch                                                                              | `../transport-in-process/src/__tests__/smoke.spec.ts`         |
| Extension `request` middleware composition (outer→inner)                                                                          | `../transport-in-process/src/__tests__/smoke.spec.ts`         |
| Extension `install()` namespace registration                                                                                      | `../transport-in-process/src/__tests__/smoke.spec.ts`         |
| `onClose` handler LIFO order                                                                                                      | `../transport-in-process/src/__tests__/smoke.spec.ts`         |
| `ClientHandlerRegistry` per-event merge kinds (`observer` / `first-non-null-wins` / `any-reconnect-wins`)                         | `src/__tests__/handler-registry.spec.ts`                      |
| `effectMiddleware` Effect↔Promise adapter, error propagation, interleave with Promise middleware                                  | `src/__tests__/effect-middleware.spec.ts`                     |
| `client.send(sessionId, input)` shortcut shape equivalence with `client.session(id).send(input)`                                  | `../transport-in-process/src/__tests__/send-shortcut.spec.ts` |
| `onLog` / `onProgress` cross-surface query + envelope→payload mapping + unsubscribe closes stream, AND `client.onLog`/`client.onProgress` instance-method delegation (ADR 64) | `src/__tests__/signals.spec.ts`                               |
| `channelView` snapshot-seed + delta-fold, `useSyncExternalStore` contract, `close()` teardown, malformed-frame isolation, AND `client.channelView` instance-method delegation (ADR 33) | `src/__tests__/channel-view.spec.ts`                          |
| Client hooks — `onBefore<Method>` param transform + abort, `onAfter<Method>` result transform, method-scoping, `client.hook`/`client.hooks` register + unsubscribe, empty-registry fast-path (ADR 83) | `src/__tests__/hooks.spec.ts`                                 |
| Pre-scoped handle `onLog` / `onProgress` bake the session / app / gateway scope (asserted on `transport.subscribe`); pre-scoped zero-config `channelView` yields a last-frame-wins view | `src/__tests__/handle-subscriptions.spec.ts`                  |
| `channelView` zero-config default fold (no config → view = latest frame payload, `undefined` before first frame) | `src/__tests__/handle-subscriptions.spec.ts`                  |
| `createClient({ onStateChange, onCapabilitiesChange })` client-LOCAL observers fire on state / capability changes | `src/__tests__/handle-subscriptions.spec.ts`                  |

## Roadmap & known gaps

- **`client.events()` bus → AsyncIterable adapter** — type surface ships; the iterator emits no events until client event surfaces register on the bus `EventSurface` union. `onStateChange` works end-to-end today.
- **Auth surface seed** — `client.auth` is a stub (returns `null` / no-op). ADR 34 fills the full subsystem (OAuth 2.1, JWT with JWKS rotation, DPoP, RBAC/ABAC/ReBAC).
- **`composeSubscribe` is exported but unused by the client itself** — subscriptions flow through the transport directly today. Wire it in when subscription middleware lands a real use case.
- **`selector()` not yet implemented in this package** — declared in ADR 33 rev-3; lands alongside the second transport (HTTP, Phase 33.D).
- **Multi-impl `ClientProtocol` conformance suite** — `runClientConformance(factory)` shape declared in ADR 33; not yet shipped. Any TS impl claiming to be a client should pass this. Deferred until a second impl exists (test mock or Worker-thread proxy).
- **Cross-runtime verification** — "runs in Node 22+, browsers, Bun, Deno, edge runtimes" — tested only against Node 24 today. Browser smoke via headless / Bun / Deno / edge runtimes deferred to integration-test CI.

## Development plan

| Phase       | What lands                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| 33.B (done) | This package + in-process transport + `ClientProtocol` in spec                                       |
| 33.C (done) | WebSocket transport                                                                                  |
| 33.D        | Streamable HTTP transport                                                                            |
| 33.E        | Unix socket transport                                                                                |
| 33.F        | `@agentick/client-extensions-next` bundle with `/retry`, `/telemetry`, `/cache`, `/offline` subpaths |
| 33.G        | Multiplexer (`@agentick/transport-multiplexer-next`)                                                 |
| 33.H        | Devtools + mock                                                                                      |
| 33.I        | MCP-bilingual (`@agentick/mcp-surface-next`, `@agentick/transport-mcp-client-next`)                  |
| ADR 34      | Auth subsystem fills `client.auth`                                                                   |
