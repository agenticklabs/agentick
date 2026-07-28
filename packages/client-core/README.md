# @agentick/client-core

> [!IMPORTANT]
> **Most apps want [@agentick/client](../client) instead** — the same API with
> every built-in capability's client surface already registered (`session.timeline`,
> `session.tools`, …). This is the LEAN core: you get `createClient` and the wire,
> and you register each capability you use with one `import "@agentick/<x>/client"`.
> Choose it when you are trimming a bundle.

**The client is a proxy, not a second copy of the truth.** Every method on it is
either a typed wire call or a fold over the server's event stream — nothing in
between, and no framework-owned cache underneath.

That is the bet the whole package makes. A read surface is a fold, so it can never
drift from the server. A write is a derived wire command, so one middleware covers
every verb — including verbs that don't exist yet. And because a read surface is
just `subscribe(cb)` + `list()`, it drops into `useSyncExternalStore` with no
adapter, in any framework or none.

`ClientProtocol` — the interface this package implements — lives in
[@agentick/spec](../spec). Applications depend on that interface; this is the
canonical implementation of it. The JSON-RPC wire underneath is language-agnostic,
so a Python or Rust client speaks it without touching this package.

## Install

```bash
npm install @agentick/client-core
```

Subpaths: `.` (the client) and `/testing` (handle conformance suite + spy
transport).

A transport ships separately — pick one:
[@agentick/transport-websocket](../transport-websocket),
[@agentick/transport-http](../transport-http),
[@agentick/transport-unix-socket](../transport-unix-socket), or
[@agentick/transport-in-process](../transport-in-process) for same-process calls.

## Quick start

```ts
import { createClient } from "@agentick/client-core";
import { websocket } from "@agentick/transport-websocket/client";

const client = await createClient({
  transport: websocket({ url: "wss://example.com/agentick" }),
});

await client.connect(); // opens the wire, runs the handshake

// `send` returns the run handle SYNCHRONOUSLY — you await `.result`, not `send`.
const run = client.send("sess-123", {
  messages: [{ role: "user", content: "summarize the last build failure" }],
});

for await (const ev of run.events()) {
  if (ev.type === "content-delta") process.stdout.write(ev.delta);
  if (ev.type === "tool-dispatch") console.log(`\n[${ev.name}] ${ev.durationMs}ms`);
}

const { response, usage, stopReason } = await run.result;
console.log(stopReason, usage.totalTokens);

await client.close();
```

`run.abort(reason?)` issues `session/abort` and closes the progress stream.

## One client, one surface

There are no context objects, no emitter strings, and no hand-rolled queries.
Everything is reachable from the instance you already hold.

```ts
// Resource handles mirror the server's own gateway / app / session shapes:
await client.gateway().listApps();
await client.app("support-bot").createSession();
await client.session("sess-123").dispatch("search", { q: "flaky test" });

// Observers, all returning an Unsubscribe:
client.onStateChange((s) => setBadge(s));
client.onCapabilitiesChange((caps) => refreshFeatureGates(caps));

// Subscriptions are PRE-SCOPED on a handle — no repeating `{ kind, id }`:
client.session("sess-123").onLog((e) => log(e.level, e.data));
client.session("sess-123").onProgress((e) => bar(e.progress, e.total));

// One middleware seam wraps every outbound wire call:
client.use(async (params, next, ctx) => {
  console.time(ctx.method);
  try {
    return await next(params);
  } finally {
    console.timeEnd(ctx.method);
  }
});
```

### Handles nest

```ts
const app = client.gateway().app("support-bot"); // GatewayHandle → AppHandle
const session = app.session("sess-123"); // AppHandle → SessionHandle
```

`client.app(id)` and `client.session(id)` are the direct forms — nesting is for
when you're walking down from a listing.

| Handle               | Verbs                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `client.gateway()`   | `listApps` · `getApp` · `app(id)` · `events`                                                     |
| `client.app(id)`     | `createSession` · `getSession` · `listSessions` · `runOnce` · `close` · `session(id)` · `events` |
| `client.session(id)` | `send` · `dispatch` · `abort` · `snapshot` · `rebind` · `close` · `events`                       |

Every handle also carries `onLog`, `onProgress`, and `channelView` pre-bound to
its own scope. The generic `client.onLog(scope, cb)` stays available for a scope
you don't hold a handle for.

## Sub-handles install to appear

The session handle is assembled, not hardcoded. Each capability package ships a
`/client` subpath that types a named slot and registers a factory; importing it is
the only thing that makes the slot exist. Client-core knows about none of them by
name and depends on none of them.

```ts
import { createClient } from "@agentick/client-core";
import "@agentick/knobs/client"; // types + registers `session.knobs`
import "@agentick/tasks/client"; // `session.tasks`
import "@agentick/elicitation/client"; // `session.elicitations`

const client = await createClient({ transport });
const session = client.session("sess-123");

// Not optional chaining — the slot exists because the import does.
session.knobs.subscribe(() => render(session.knobs.list()));
await session.knobs.set("temperature", 0.7);

session.elicitations.subscribe(() => {
  for (const ask of session.elicitations.list()) void ask.accept({ ok: true });
});
```

> [!TIP]
> Don't want the manual imports? [@agentick/client](../client) is the bundle —
> it re-exports this package and side-effect-imports every built-in `/client`
> subpath, so every slot lights up from one import. This package stays lean for
> adopters who opt in per capability.

Slots are lazy, cached getters that never shadow a real handle member, so a slot
costs nothing until first touched.

### A missing registration says so

Reading a slot you never registered throws right there, and the message leads with
the fix — install [@agentick/client](../client), or add the one import if you are
on the core deliberately:

```
session.tools is not registered. Install @agentick/client — it carries every
built-in capability's client surface, with nothing to register. If you are on
@agentick/client-core deliberately, add: import "@agentick/tool-executor/client".
```

Without that throw the access fell through to namespace synthesis (below) and
handed back a proxy that failed much later, at `tools.list()`, with a `tools/list`
method-not-found from a server that was fine. Types don't catch it either: a slot's
type arrives from the same module you forgot to import.

Only property reads throw. `"tools" in session`, `Object.keys(session)`, and
debugger inspection report absence instead, so logging a session is always safe;
`registeredSessionHandleExtensions()` is the feature-detection read.

To publish your own slot:

```ts
import { registerSessionHandleExtension } from "@agentick/client-core";

declare module "@agentick/spec" {
  interface SessionHandleExtensions {
    readonly mine: { list(): readonly string[] };
  }
}

registerSessionHandleExtension("mine", (client, sessionId) => makeMine(client, sessionId));
```

### Every sub-handle answers the same three questions

A handle is nouns plus verbs over one server resource. The read core is one
method; the rest are declared capability profiles.

```ts
import { isEnumerable, isRespondable, type ClientHandle } from "@agentick/client-core";

// CORE — every handle. `cb` takes NO arguments; you read via the handle.
declare const handle: ClientHandle;
const off = handle.subscribe(() => rerender());
off();
handle.close?.();

// PROFILES — declared in the type, feature-detectable at runtime:
if (isEnumerable<{ id: string }>(handle)) {
  handle.list(); // current state, INCLUDING what happened before you connected
  handle.get("id-1");
}
if (isRespondable<{ ok: boolean }>(handle)) {
  await handle.respond("correlation-1", { ok: true });
}
```

A handle whose state comes over the wire seeds itself and fires `subscribe` when
the answer lands, so `list()` can be empty for one round-trip after you take the
handle. Bind both and that moment handles itself — render what `list()` has,
re-render on change; there is nothing to await and no fetch to issue at boot.
Where a handle has `refresh()`, that is for invalidating state you already hold.

That zero-argument `subscribe` is why a handle needs no React adapter:
`useSyncExternalStore(handle.subscribe, handle.list, handle.list)` is the whole
binding, which is exactly what [@agentick/client-react](../client-react) ships.

These are plain structural interfaces — no branding, no registration. Satisfying
the shape is conforming, and a handle may carry anything else it likes. Prove
yours with the suite from `/testing`:

```ts
import { runClientHandleConformance, spyClientTransport } from "@agentick/client-core/testing";

runClientHandleConformance({
  label: "myHandle",
  setup: () => {
    const spy = spyClientTransport();
    const handle = myHandle(spy, "s1");
    return { handle, change: () => spy.emit("my-channel", { id: "a" }) };
  },
  writeVerbs: [
    {
      verb: "set",
      method: "mine/set",
      boundAddress: { sessionId: "s1" },
      run: async () => {
        const spy = spyClientTransport();
        await myHandle(spy, "s1").set("x");
        return spy.lastRequest()!;
      },
    },
  ],
});
```

The core cases always run: `subscribe` fires on change, the callback receives no
arguments, the returned unsubscribe stops it, `close()` tears down, and the read
members survive destructuring (no `this`-dependence). The `enumerable` and
`respondable` probes are optional — supply one and its cases run, including the
one that matters most: `list()` must reflect state that existed **before** you
connected.

## Namespaces you never wrote

A session-scoped wire method needs no client code at all. Declare the row and the
gateway handler; the typed client method falls out.

```ts
declare module "@agentick/spec" {
  interface WireMethods {
    "billing/approve": {
      params: { sessionId: string; invoiceId: string };
      result: { approved: boolean };
    };
  }
}

// No `billing` client code exists anywhere. This is typed and round-trips:
const { approved } = await client.session("sess-123").billing.approve({ invoiceId: "inv-1" });
```

The session handle synthesizes the namespace on first access and issues
`billing/approve` with `sessionId` bound. A typo can't compile — the mapped type
is the guard — and an unknown method is rejected by the server. Registered
sub-handles win over synthesis for their own namespace, so nothing is shadowed,
and a name reserved by a capability slot you never registered throws
[the missing-registration error](#a-missing-registration-says-so) instead of
quietly synthesizing.

## One interception seam

`client.use(middleware)` is the only interception path. It wraps every derived
wire method — the ones you wrote, the ones a sub-handle wrote, and the ones that
don't exist yet.

```ts
const off = client.use(async (params, next, ctx) => {
  // ctx: { method, sessionId?, signal? }
  if (ctx.method.startsWith("session/") && overBudget()) {
    throw new Error("client budget exceeded"); // request never leaves
  }
  const result = await next(params);
  metrics.record(ctx.method);
  return result;
});
off(); // leased — remove it any time
```

An empty registry fast-paths straight to the transport, so the seam costs nothing
until you use it.

Per-namespace scoping is sugar on the same seam — `session.knobs.use(mw)` wraps
your middleware to fire only for `knobs/*`, then registers it here.

### Hooks are the before/after shape of it

When you want to reshape params or a result for one method, `client.hook` is less
ceremony than an around-middleware. Names are derived from the wire method and
mirror the session op the call initiates — `session/send` → `onBeforeSessionSend`.

```ts
const off = client.hook({
  // Return reshaped params, return nothing to pass through, or throw to abort.
  onBeforeSessionSend: (params) => ({ ...params, maxTicks: params.maxTicks ?? 8 }),
  onAfterSessionSend: (result, ctx) => {
    metrics.timing(ctx.method, result.result.usage.totalTokens);
    return result;
  },
});
off(); // removes every hook in the config

// Or one at a time, live:
const stop = client.hooks.onBeforeAppRunOnce((params, ctx) => {
  audit(ctx.method); // "app/run_once"
  return params;
});
```

Hooks are method-scoped and read live — register or remove them at any point.
Both surfaces return an `Unsubscribe`; the hook context is `{ method, signal? }`.

## Typed errors survive the wire

A server-thrown framework error arrives on the client as the same class it was
thrown as — the client rehydrates it above the extension pipeline, before your
`catch` block sees it.

```ts
import { SessionNotFoundError } from "@agentick/spec";

try {
  await client.session("nope").snapshot();
} catch (e) {
  if (e instanceof SessionNotFoundError) {
    console.log(e.sessionId); // fields round-trip, not just the message
  }
}
```

An unrecognized error tag degrades to `UnknownAgentickError` with its payload
intact — never silent data loss. Protocol-level failures (method not found, parse
errors) carry no tag and pass through as the raw JSON-RPC envelope, which is what
extensions like retry classify on.

## Capabilities and server identity

`connect()` runs a two-step handshake — `initialize` for protocol version,
framework flags, and server info, then `_extensions/list` for wire-extension
enumeration. Both land on `client.capabilities` and `client.serverInfo`.

```ts
await client.connect();

if (client.capabilities.framework.progress) enableProgressBars();
if (client.capabilities.hasMethod("mcpClients/reauthenticate")) showConnectButton();
if (client.capabilities.hasNamespace("billing")) mountBillingPanel();

for (const ext of client.capabilities.extensions) {
  console.log(`${ext.name} v${ext.version} — ${ext.methods.join(", ")}`);
}

console.log(client.serverInfo?.name, client.serverInfo?.version);
```

The snapshot is empty before `connect()` and after the wire drops, and is swapped
atomically per handshake — subscribers never observe a half-populated
intermediate. Extension sets are per-connection: a reconnect clears the snapshot,
re-runs the handshake against whoever answered, and fires `onCapabilitiesChange`
with the fresh view. `whenReady()` awaits an in-flight post-reconnect handshake.

> [!NOTE]
> If the server answers `MethodNotFound` for `_extensions/list`, that half is
> skipped and `connect()` still resolves with the framework flags. Any other
> error, and a failing `initialize`, rejects `connect()`.

`capabilities.framework` is declaration-merge extensible if you want typed flags
of your own.

## Runtime signals

Tools and session capabilities emit `log` and `progress` as bus events; the
gateway projects the matching ones to subscribed clients over the same
subscription channel everything else uses. `onLog` / `onProgress` build the
cross-surface query and decode each envelope for you.

```ts
// Pre-scoped on a handle — the common case:
const off = client.session(id).onLog((e) => console.log(e.level, e.data, e.scope));
client.session(id).onProgress((e) => bar(e.progress, e.total));
off(); // closes the underlying subscription

// Scope escalation — the same call, a wider net, still ONE subscription:
client.app(appId).onLog(cb); // every session under an app
client.gateway().onLog(cb); // deployment-wide

// Resume after a reconnect gap:
client.session(id).onProgress(render, { fromCursor: savedCursor });
```

Three spellings, identical types: the pre-scoped handle method, the generic
`client.onLog(scope, cb)` for a scope you don't hold a handle for, and the
tree-shakeable free function `onLog(client, scope, cb)` the other two delegate to.

## The fold kit

Under every read surface is one ground-floor primitive and one fold over it. Reach
for these when you're composing something the bundled handles don't cover.

**`eventStream` / `channelStream` — materialize nothing.** An ordered stream of
frame payloads. Single-consumer, like the transport subscription it wraps.

```ts
import { channelStream } from "@agentick/client-core";

const feed = channelStream<{ id: string }>(client, { kind: "session", id }, "feed");
for await (const item of feed) window.push(item); // your structure, your rules
feed.close();
```

**`eventView` / `channelView` — the opt-in fold.** The watch-list model: the
stream opens with a snapshot frame and continues with deltas on the _same_ ordered
stream, so there is no baseline pull, no cursor, and no snapshot-versus-stream race
to reconcile. `reduce` folds every frame onto held state.

```ts
import { channelView } from "@agentick/client-core";

// Zero-config: the default fold is last-frame-wins. Right for channels where
// every frame carries the whole object.
const status = client.session(id).channelView<TaskStatus>("task-status");
status.get(); // TaskStatus | undefined

// Explicit reduce: for snapshot+delta channels.
const online = channelView<Set<string>, PresenceFrame>(client, scope, "presence", {
  initial: new Set(),
  reduce: (set, frame) =>
    frame.kind === "snapshot" ? new Set(frame.ids) : new Set(set).add(frame.id),
});

online.subscribe((state) => render(state)); // STATE feed — the folded value
online.onChange((frame) => audit(frame)); // CHANGE feed — each frame it folds
online.get(); // sync read
online.status; // "loading" | "live" | "closed"
online.close();
```

The primitive stays dumb — it doesn't know what a snapshot is. `reduce` decides,
which is why one `channelView` covers both full-object channels and snapshot+delta
channels. A malformed frame is skipped rather than tearing the stream down, and a
throwing listener can't starve its siblings.

**`filteredView` — many projections, one subscription.** A handle _is_ its default
view; `filteredView` mints additional ones over the same source. Each re-derives
from the source on every change and closes independently; the shared subscription
survives until the source closes.

```ts
import { filteredView } from "@agentick/client-core";

const errors = filteredView(handle, { filter: (e) => e.level === "error" });
errors.subscribe(() => render(errors.list()));
errors.close(); // detaches only this projection
```

`list()` is memoized between changes — a fresh array per call would render-loop a
`useSyncExternalStore` consumer, so the projection is cached and invalidated on
the next source change.

**`liveStore`** is the fan-out core all of them share: one held state, the two
feeds, the store contract, and an imperative `set` seam for owners that mutate
locally as well as fold.

> [!NOTE]
> These are the extension-author tier. An application reads state through a
> handle's `list()` / `subscribe()` / `view()`, not by wiring a `channelView`
> itself. Typed façades — `session.knobs`, `session.tasks` — supply the channel
> name and the reducer so you never see either.

## Extensions

An extension wraps the wire and installs into the client's lifecycle.

```ts
import type { ClientExtension } from "@agentick/spec";

const retry: ClientExtension = {
  name: "retry",
  async request(req, next) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await next(req);
      } catch (e) {
        if (attempt === 2) throw e;
      }
    }
  },
};

const client = await createClient({ transport, extensions: [retry] });
```

Three surfaces:

- **`request` / `subscribe` middleware** — chain of responsibility around wire
  calls. Promise-native, outer→inner (first in the array is outermost). Prefer
  `client.use` for application policy; extensions are for packaged behavior.
- **Lifecycle handlers** — `connection:lost`, `auth:expired`,
  `subscription:evicted`, `rpc:error`, merged per event by declared rule
  (`observer`, `first-non-null-wins`, `any-reconnect-wins`).
- **`install(installer)`** — register a namespace, subscribe the client bus, add
  `onClose` handlers (which run LIFO at `close()`).

A registered namespace appears on the client, typed by declaration merging:

```ts
declare module "@agentick/spec" {
  interface ClientNamespaces {
    offline: { pending(): Promise<unknown[]>; flush(): Promise<void> };
  }
}
```

`effectMiddleware(mw)` adapts an Effect-native middleware
(`(input, next) => Effect<Result, Error, never>`) into the Promise pipeline; it
interleaves with Promise-native middleware in the same outer→inner order. The
canonical shape is Promise-based because most middleware is a trivial wrapper.

Prebuilt extensions live in [@agentick/client-extensions](../client-extensions).

## Client events

`client.events()` is a live stream of events _about the client itself_ — a
separate emitter from both the wire and the observability bus.

```ts
const stream = client.events({ surface: "connection" });
for await (const ev of stream) {
  if (ev.surface === "connection") console.log(ev.from, "→", ev.to);
}
await stream.close(); // ends every active iterator, releases the subscription
```

Each call yields an independent stream with its own subscription, so concurrent
iterators don't interfere. `filter.surface` and `filter.phase` accept a single
value or an array and are AND-ed. The stream is live-only: `cursor` advances
monotonically as events are yielded, but there is no replay buffer, so
`fromCursor` is accepted and ignored.

## API

### `createClient(options)`

| Option                 | Purpose                                                   |
| ---------------------- | --------------------------------------------------------- |
| `transport`            | Required. Any `ClientTransport`.                          |
| `extensions`           | Extensions in outer→inner order.                          |
| `id`                   | Client identity; defaults to a generated one.             |
| `onStateChange`        | Shorthand for `client.onStateChange(fn)` at construction. |
| `onCapabilitiesChange` | Shorthand for `client.onCapabilitiesChange(fn)`.          |

Resolves to a `Client` — `ClientProtocol` widened with any namespaces registered
through `ClientNamespaces` declaration merging. The client does **not**
auto-connect; call `connect()` when you want the wire open.

### `client`

| Member                                  | Purpose                                            |
| --------------------------------------- | -------------------------------------------------- |
| `connect()` / `close()`                 | Open the wire + handshake; tear everything down    |
| `state` / `onStateChange(fn)`           | Connection state, and transitions                  |
| `capabilities` / `serverInfo`           | What the connected gateway supports, and who it is |
| `onCapabilitiesChange(fn)`              | Fires on every capability-snapshot swap            |
| `whenReady()`                           | Await an in-flight post-reconnect handshake        |
| `request(method, params, signal?)`      | Typed JSON-RPC dispatch                            |
| `use(middleware)`                       | The interception seam; returns an `Unsubscribe`    |
| `hook(config)` / `hooks.on…(fn)`        | Method-scoped before/after sugar over `use`        |
| `gateway()` / `app(id)` / `session(id)` | Resource handles                                   |
| `send(sessionId, input)`                | Shortcut for `session(id).send(input)`             |
| `onLog` / `onProgress`                  | Generic scoped signal subscriptions                |
| `channelView(scope, channel, config?)`  | Generic channel fold                               |
| `events(filter?)`                       | Live stream of client-lifecycle events             |
| `transport` / `id`                      | The wrapped transport; this client's identity      |

### Exports

| Export                                                                 | Purpose                                                        |
| ---------------------------------------------------------------------- | -------------------------------------------------------------- |
| `createClient`                                                         | Build a client                                                 |
| `ClientHandle` / `Enumerable` / `Respondable`                          | The handle contract and its capability profiles                |
| `isClientHandle` / `isEnumerable` / `isRespondable`                    | Runtime feature detection for the above                        |
| `registerSessionHandleExtension` / `registeredSessionHandleExtensions` | Publish + introspect session slots                             |
| `knownSessionHandleExtensionImports` / `SessionSubHandleNotRegistered` | Slot → `/client` specifier map; the missing-registration throw |
| `makeGatewayHandle` / `makeAppHandle` / `makeSessionHandle`            | Handle factories, for building a client of your own            |
| `onLog` / `onProgress`                                                 | Tree-shakeable signal subscriptions                            |
| `channelStream` / `channelView`                                        | Channel-pinned stream and fold                                 |
| `eventStream` / `eventView`                                            | The generic stream and fold beneath them                       |
| `liveStore` / `filteredView`                                           | Fan-out core; shared-subscription projections                  |
| `composeRequest` / `composeSubscribe`                                  | The middleware composers                                       |
| `effectMiddleware`                                                     | Effect ↔ Promise middleware adapter                            |
| `ClientHandlerRegistry`                                                | Lifecycle-handler merge rules                                  |
| `commandForMethod`                                                     | Wire method → hook command name                                |

Protocol types (`Client`, `ClientProtocol`, `ClientTransport`, `ClientExtension`,
`ClientState`, `TransportError`, …) are re-exported for one-import ergonomics;
[@agentick/spec](../spec) is their canonical home.

### `@agentick/client-core/testing`

| Export                       | Purpose                                                        |
| ---------------------------- | -------------------------------------------------------------- |
| `runClientHandleConformance` | The executable handle contract — core + declared profiles      |
| `spyClientTransport`         | Records `request` calls; drives a push-controlled subscription |

## Patterns

**Reconnect without losing your feature gates.** A transport that reconnects on
its own (the [WebSocket one](../transport-websocket) does) drives the client back
through the handshake, which swaps the capability snapshot. Gates stay live if you
subscribe rather than read once.

```ts
client.onCapabilitiesChange((caps) => refreshFeatureGates(caps));
```

On a runtime with no global `WebSocket`, or when you need custom upgrade headers,
pass the constructor: `websocket({ url, WebSocket: (await import("ws")).WebSocket })`.

**One handle, the whole session.** The scoped subscriptions, the sub-handles, and
`send` all hang off the same object — reach for it once.

```ts
const s = client.session(id);
s.onLog(logPanel.add);
s.knobs.subscribe(() => renderKnobs(s.knobs.list()));
const run = s.send({ messages });
```

**Bind a UI with no adapter.** Any handle is already a store:

```ts
const unsub = session.tasks.subscribe(() => render(session.tasks.list()));
```

In React that same pair is [@agentick/client-react](../client-react)'s
`useHandle(session.tasks)`.

**Same code in-process and remote.** The handle shapes mirror the server's own, so
swapping [@agentick/transport-in-process](../transport-in-process) for a network
transport changes the `createClient` call and nothing else.

## Roadmap & known gaps

- **`client.auth` is a seed.** `current()` returns `null`, `onChange` is a no-op,
  `reauthenticate()` resolves without doing anything. Only `signOut()` reaches the
  wire. The full surface (OAuth 2.1, JWT with JWKS rotation, DPoP, RBAC) is not
  built.
- **Capability-change push isn't wired.** Capabilities refresh on connect and on
  reconnect. A `notifications/capabilities/changed` subscription that refetches
  mid-connection is declared in the protocol but not implemented here, so today a
  server-side extension-set change is observed only after a reconnect.
- **`client.events()` has one live source.** Only the `connection` surface emits.
  `request` / `subscription` / `auth` / `wire` / `extension` have no emit sites
  yet, so a filter on them yields nothing.
- **`composeSubscribe` is exported but unused by this client.** Subscriptions go
  straight to the transport; subscribe middleware composes correctly but nothing
  invokes the composed chain.
- **No multi-transport selector.** One transport per client. Failover and
  multi-tab multiplexing would slot into the `createClient({ transport })` seam
  with no application change, but neither exists.
- **No `ClientProtocol` conformance suite.** `runClientHandleConformance` certifies
  a _handle_; there is no equivalent certifying an alternate implementation of the
  whole protocol. Deferred until a second implementation exists.
- **Cross-runtime is claimed, not tested.** The code has no DOM or Node-specific
  imports, but CI exercises Node only. Browser, Bun, Deno, and edge runtimes are
  unverified.
- **The fold kit isn't behind its own subpath.** `channelView`, `eventView`,
  `liveStore`, and friends sit on the main barrel next to the application surface,
  which under-signals that they're the extension-author tier.

## Verified by

- `src/__tests__/capabilities.spec.ts` — handshake populates capabilities and
  `serverInfo`, `MethodNotFound` degradation on `_extensions/list`, rejection when
  `initialize` fails, clearing on drop, re-handshake on reconnect (and _not_ on the
  initial open), best-effort failure of the post-reconnect handshake.
- `src/__tests__/hooks.spec.ts` — `onBeforeSessionSend` param transform and abort,
  `onAfterSessionSend` result transform, method scoping, `hook` batch and `hooks`
  proxy registration plus unsubscribe, empty-registry fast path, and the
  `session/send` → `SessionSend` name derivation.
- `src/__tests__/handle-conformance.spec.ts` — `runClientHandleConformance` proven
  against a fake handle; `isClientHandle` / `isEnumerable` / `isRespondable`
  duck-typing, including a bare store that is a handle but not enumerable.
- The seed-and-notify contract has no runtime here, so it is proven where the
  seeding handles live — the client specs in
  [@agentick/tool-executor](../tool-executor), [@agentick/prompts](../prompts),
  [@agentick/skills](../skills), and [@agentick/resources](../resources): the eager
  poll notifies subscribers when it lands (so no boot-time `refresh()` is needed)
  and a failed poll settles the snapshot empty until `refresh()` recovers it.
- `src/__tests__/signals.spec.ts` — cross-surface log/progress queries,
  envelope→payload+scope mapping, `fromCursor` forwarding, unsubscribe closing the
  stream, and the instance methods delegating to the free functions.
- `src/__tests__/handle-subscriptions.spec.ts` — pre-scoped `onLog` / `onProgress`
  baking the session / app / gateway scope, zero-config `channelView` on a handle,
  and the `createClient` construction-time observers.
- `src/__tests__/channel-view.spec.ts` + `channel-stream.spec.ts` +
  `event-view.spec.ts` — snapshot seed then delta fold, the state and change feeds,
  `status` transitions, `close()` teardown, malformed-frame isolation, listener
  fault isolation, arbitrary query + `fromCursor` pass-through, and payload-only
  iteration.
- `src/__tests__/view-source.spec.ts` — independent per-view filters, independent
  close, referential stability of `list()`, and that a projection opens no second
  upstream subscription.
- `src/__tests__/wire-errors.spec.ts` — typed error rehydration across the wire,
  field round-trip, unknown-tag degradation, and pass-through of protocol-level and
  non-object rejections.
- `src/__tests__/events.spec.ts` — connection events, surface filtering,
  `close()` ending iterators, concurrent independent iterators, monotonic cursor.
- `src/__tests__/handler-registry.spec.ts` + `effect-middleware.spec.ts` +
  `session-handle-extensions.spec.ts` — lifecycle merge rules, the Effect adapter's
  error propagation and interleaving, and lazy cached slots that never shadow a
  real member.
- [@agentick/transport-in-process](../transport-in-process) —
  `smoke.spec.ts` (connect, dispatch, extension middleware order, namespace
  registration, LIFO `onClose`) and `send-shortcut.spec.ts` (`client.send` emits
  the same RPC as `session(id).send`).
- `src/__tests__/sub-handle-import-diagnostics.spec.ts` — a known-but-unregistered
  slot throws `SessionSubHandleNotRegistered` naming both the slot and its exact
  `/client` specifier, a registered slot is still served from the handle, an
  unknown name still synthesizes `billing/<method>` with `{ sessionId }`, and
  `in` / `Object.keys` / `util.inspect` / `await session` never trip the throw.
- [@agentick/client](../client) — `wire-proxy-middleware-e2e.spec.ts` covers the
  synthesized namespace round-trip end-to-end and `client.use` observing both a
  synthesized method and a sub-handle's verb;
  `sub-handle-dictionary-anti-rot.spec.ts` checks the import dictionary against
  the live registry in both directions, so a renamed slot or a new built-in
  missing its entry fails there.
