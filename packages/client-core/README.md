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

`run.abort(reason?)` issues `session/abort` and closes the progress stream. `client.session(id).abort(reason?, { cascade: true })` sends the same verb with the wider scope — the session's live spawn subtree stops too, and nothing is disposed or deleted. See the [cancellation ladder](../app#the-cancellation-ladder).

The run handle carries the same `readable()` / `pipeTo()` web-streams surface as the server-side `SessionExecutionHandle` — `run.readable()` is a WHATWG `ReadableStream<StreamEvent>` for `pipeThrough`/`tee`, and `run.pipeTo(sink, { throttleMs? })` drains the live turn into any `WritableStream` with backpressure. Both use only Web Streams globals, so they run unchanged in the browser. A UI streaming a reply into a rate-limited widget pipes to a sink whose `write()` paces itself; nothing else buffers.

### One token, two producers

The gateway multiplexes two producers onto a turn's progress token: the execution's own events, and the `ctx.progress(...)` **signals** its tools emit. Both arrive on `run.events()`, and both are members of the `StreamEvent` union — a signal under `type: "progress"`. One `switch`, no shape guards:

```ts
for await (const ev of run.events()) {
  switch (ev.type) {
    case "content-delta":
      process.stdout.write(ev.delta);
      break;
    case "tool-dispatch":
      console.log(`[${ev.name}] ${ev.durationMs}ms`); // `name` is the TOOL, as always
      break;
    case "progress":
      // `token` is the tool call id; `sessionId` is who emitted — a sub-agent's
      // own id when the frame came from one.
      bar(ev.sessionId, ev.progress, ev.total);
      break;
  }
}
```

The frame kind rides `type` rather than the envelope's `name` because six variants of the union already carry a `name` and it is the **tool** name; stamping the envelope over it would replace "which tool" with "which frame kind" on the most-consumed frames of the stream.

A `progress` frame carries no `sequence`, `tick` or `timestamp` — it is a bus signal, not a sequenced session event, and the variant does not pretend otherwise. It classifies alone: `total` present means determinate, absent means a spinner, so a consumer joining mid-turn renders correctly from the first frame it sees.

`send({ ..., fanIn: true })` widens the signal half of that stream to the turn's whole spawn tree, so a sub-agent's progress reaches the caller that started the turn. It is off by default and changes nothing else — see [@agentick/gateway](../gateway#progress-on-a-running-turn) for the membership rule and what it deliberately excludes. The raw envelopes are still there when you want them (`client.transport.progress(token)`), unchanged.

### Watching a session's living subtree

A turn's stream ends with the turn. For work that outlives one — a detached task, a sub-agent that keeps going after the turn that spawned it settles — subscribe to the session **tree**:

```ts
const stream = client.session("sess-123").treeEvents({
  name: { exact: "session:channel:task-status" },
});

for await (const frame of stream) {
  board(frame.envelope.scope.sessionId, frame.envelope.payload);
}
await stream.close();
```

`events()` is the same subscription scoped to that session alone, which sees nothing a sub-agent emits (a channel event is scoped to its emitter). `treeEvents()` opens with every live member's current channel snapshot — root first — then relays the live tail; a member spawned later simply appears on it.

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

A session handle is **one per id per client**, whichever door you reach it
through: `client.session(id)`, `app.session(id)` and a second lookup all return
the same object. It owns subscriptions — the status view, the tool-call fold,
every sub-handle — so handing out a second one would open a second copy of each
and leave whichever half of the app held the other one deaf. `close()` releases
it, and a lookup after that builds a fresh handle.

| Handle               | Verbs                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `client.gateway()`   | `listApps` · `getApp` · `listSessions` · `destroySession` · `app(id)` · `events`                                    |
| `client.app(id)`     | `createSession` · `getSession` · `listSessions` · `destroySession` · `runOnce` · `close` · `session(id)` · `events` |
| `client.session(id)` | `send` · `dispatch` · `abort` · `reply` · `fork` · `branch` · `status` · `snapshot` · `rebind` · `close` · `events` |

Every handle also carries `onLog`, `onProgress`, and `channelView` pre-bound to
its own scope. The generic `client.onLog(scope, cb)` stays available for a scope
you don't hold a handle for.

`createSession` is create-OR-RESUME and its reply says which state it resumed into
(`{ sessionId, status }`) — so a client reconnecting to a live conversation knows a turn
is already in flight before it subscribes to anything.

Both `listSessions` return the **page**, not a bare array — `{ sessions, nextCursor }`.
A reply that handed back only rows would leave you with no way to ask for the rest.
Walk until `nextCursor` is absent; a full page is not the signal, since a page can be
exactly `limit` long and still be the last one. The gateway form unions every app and
stamps each row with its `appId`, which is what `client.app(row.appId)` then takes.

```ts
let cursor: string | undefined;
do {
  const page = await client.gateway().listSessions({ status: "active" }, { cursor, limit: 50 });
  render(page.sessions);
  cursor = page.nextCursor;
} while (cursor !== undefined);
```

### Branching a conversation

Three verbs on a session handle, mirroring the ones the server-side session
carries:

```ts
const thread = session.reply("entry-42"); // a side thread under that entry
const alt = session.fork("entry-42"); // a new direction from it
const here = session.fork(); // …from wherever the conversation is now
```

Each returns the new session's handle **synchronously** — same lazy-create
posture as `client.session(id)`, so you can send to it on the next line. The
create is fired underneath; if it fails, the failure surfaces on the next verb
you send to that handle rather than as a rejection from the call itself.

A branched session carries a `from` bag: the session it came from, the entry it
branched at, and two birth-declared adjectives. `inherited` says it took the
source's state — timeline, knobs and state — up to that entry. `anchored` says
it stays there, rendered under the entry as a side thread rather than beside the
conversation it came from. `reply` is the anchored one; `fork` is not.

`branch()` is the explicit form the two sugars lower to, for when you want a
combination they don't spell — an uninherited side thread, a chosen id, your own
metadata:

```ts
session.branch({ entryId: "entry-42", anchored: true, inherited: false });
```

None of the three is an operation of its own. They all lower to the one create
door, which is where the hooks, the journal entry and the security guard live
exactly once — so a host can reach the same thing directly:

```ts
await client.app("support-bot").createSession({
  from: { sessionId: "sess-123", entryId: "entry-42", inherited: true, anchored: false },
});
```

Three things you never pass. There is no `seq` — the server resolves the entry's
position at genesis. There is no `entryId` when you mean "from here" — absent
means the source's tip, resolved the same way. And there is no `appId` on a
branch: a branch lives in its source's app, so the gateway reads it off the
source record. The bag is admitted only when your principal owns
`from.sessionId` — `inherited` reads the source's state, so an unowned source is
a cross-tenant read, not a bad parameter.

The conversation list is a composed predicate, not a roots-only flag, because a
fork of a conversation is still a conversation:

```ts
const page = await client.gateway().listSessions({ internal: false, anchored: false });
for (const row of page.sessions) render(row, relation(row)); // "conversation" | "fork" | …
```

`relation()` folds `internal` + `from` into the word for a row —
`"conversation"`, `"fork"`, `"reply"`, `"worker"`, `"forked-worker"`. Derived on
read; nothing stores it.

### Is it running right now?

`session.status` is a live view of one session's `SessionStatus`. It matters on
RELOAD: a panel that refreshes mid-turn holds a brand-new handle and would
otherwise render a busy conversation as idle until the turn happened to end.

```ts
const session = client.session("sess-123");
session.status.get(); // "running" | "idle" | "input_required" | … (undefined until frame one)
session.status.subscribe(() => render(session.status.get()));
session.status.onChange((frame) => {
  frame.executionId; // the turn in flight, for correlation
  if (frame.outcome === "failed") toast("That turn failed.");
});
```

`outcome` (`"succeeded" | "failed" | "aborted"`) rides only the frame that ENDS a run, so
a toast is a frame and a badge is the status. A turn that failed leaves an `idle`,
perfectly usable session — which is exactly why the ending is not folded into the state.
`input_required` means the session is running but blocked on a pending ask — an
elicitation, or a client-handled tool call nobody has answered yet:
"action required" is a frame, not something a UI has to open the session to discover.
(Not `paused` — that is reserved for an operator stopping a session, which a UI must be
able to tell apart from waiting on an answer.)

The harness's `status` is the value; the handle's is the view over it — same fact, one
no-await door per side.

The subscription **opens with the current status**, so there is no window between
reading a seed and starting to listen in which a transition could be missed. It is
built on first access and closed by `session.close()`.

For a thread LIST, don't open one per row. Every `listSessions` row already carries
`status`; subscribe once at gateway (or app) scope and fold the frames, which arrive
for every session the caller owns — including ones no handle is open for.

```ts
// Subscribe FIRST, then seed: the other order has a window to lose a transition.
const stream = client.gateway().events(sessionStatusEventQuery());
void (async () => {
  for await (const { envelope } of stream) {
    const frame = envelope.payload as SessionStatusFrame;
    rows.update(frame.sessionId, { status: frame.status });
  }
})();
for (const row of (await client.gateway().listSessions()).sessions) rows.upsert(row);
```

The cursor is opaque, and it is opaque because it is not the framework's. The client and
the wire define the envelope — `{ cursor?, limit }` in, `{ sessions, nextCursor? }` out —
while the token itself is minted by whatever answered: the app's session store, a
gateway-mounted cross-app index, or the framework's own fallback when neither pages. Pass
it back verbatim; never parse it, and never mint one. A cursor the server cannot decode
yields page one rather than an error, since a client holding a stale token has no other
recovery.

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
  await client.session("nope").abort();
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
with the fresh view. `whenReady()` resolves when a handshake has succeeded — see
[An open wire is not a usable client](#an-open-wire-is-not-a-usable-client).

> [!NOTE]
> If the server answers `MethodNotFound` for `_extensions/list`, that half is
> skipped and `connect()` still resolves with the framework flags. Any other
> error, and a failing `initialize`, rejects `connect()`.

`capabilities.framework` is declaration-merge extensible if you want typed flags
of your own.

### An open wire is not a usable client

Two things can be wrong, and only one of them is the wire's. A gateway can accept
a socket before it can serve `initialize` — mid-boot, mid-restart, mid-deploy —
and then `state` reads `open`, `capabilities` is empty, and every namespaced call
fails as "capability missing" with nothing saying why. That is a **handshake**
failure on a **healthy** wire, and the transport's reconnect loop will never fire
for it, because nothing dropped.

So the client reports both dimensions, and retries the one it owns:

```ts
const client = await createClient({
  transport,
  onReadinessChange: (r) => {
    if (r === "ready") hideBanner();
    else if (isHandshakeFailed(r)) showBanner(`server not answering (attempt ${r.attempts})`);
  },
});

await client.connect(); // rejects if the FIRST handshake fails — an answer, not a verdict
await client.whenReady(); // resolves when one has SUCCEEDED
```

| `state`        | `readiness`        | What it means                                                      |
| -------------- | ------------------ | ------------------------------------------------------------------ |
| `open`         | `ready`            | Usable.                                                            |
| `open`         | `handshaking`      | Wire up, handshake in flight.                                      |
| `open`         | `handshake-failed` | Wire up, server not answering the handshake — retrying underneath. |
| `reconnecting` | `idle`             | Wire down; a handshake is owed on the way back.                    |

`whenReady()` **resolves on success only**. It used to resolve once an attempt
finished, which is how an adopter could `await` their way into an open wire with
empty capabilities and no reason — the failure was swallowed on the grounds that
nobody had awaited it, which is precisely what `whenReady()` is. It now stays
pending while the retry loop works, and rejects for exactly one reason: nothing
further can ever resolve it, because the client was closed or the transport went
terminal. Race it against your own deadline if you need one.

The retry follows the same curve as the transports (full jitter, 100ms → 30s) and
the same default budget: `Infinity`. A wire that drops supersedes it rather than
competing with it — the transport owns recovery from there, and the `open`
transition on the way back arms a fresh handshake. A deliberate `close()` stops
it; "never stops trying" is a promise about failures, not about instructions.

```ts
createClient({ transport, handshakeRetry: { maxAttempts: 5 } });
```

A spent budget is reported, not silent: `readiness` settles on
`{ kind: "handshake-failed", retrying: false }`. Verified by
[`src/__tests__/handshake-retry.spec.ts`](src/__tests__/handshake-retry.spec.ts).

### `reconnect()` — the click that says "try now"

Both loops back off up to 30s. That is right for an unattended client and wrong
for a person looking at a disconnected dot: they know the VPN came back, and the
loop does not. `reconnect()` is how they say so — it is what makes the indicator
a button.

```tsx
<button className={dotClass(client.state, client.readiness)} onClick={() => client.reconnect()} />
```

Whichever loop is waiting gets collapsed: a wire that is down is dialled
immediately, and a wire that is UP with a failed handshake re-arms the handshake
from attempt zero. That includes the spent-budget terminal above, which nothing
else recovers — a finite `maxAttempts` bounds what the client does **on its own**,
and a person asking is not that, so the manual attempt runs on a fresh budget.

It resolves when the attempt has **settled**, not when it succeeded, and it does
not reject on a failed attempt — a click handler has nowhere to put that, and the
failure is already on `state` and `readiness`, which is where the dot is looking
anyway. Re-read them after it resolves. It is a no-op while `ready` or
`handshaking` on a live wire, so a double-click costs one handshake, and it throws
on a client you have `close()`d: closed is terminal, and the way back is a fresh
`connect()`. Verified by [`src/__tests__/reconnect.spec.ts`](src/__tests__/reconnect.spec.ts).

> **Stale tokens.** Reconnecting is the only thing that re-runs the handshake, so
> today it is also the only thing that picks up refreshed credentials — the
> connection carries whatever the transport was built with. If a reconnect keeps
> failing on auth, the token is the suspect, and re-authenticating means standing
> up a new client rather than kicking this one. ADR 34 owns the real fix.

### The gateway you come back to may not be the one you left

A reconnect restores the **wire**. It does not restore anything the peer was
holding in memory, and a restarted gateway comes back with an empty session
registry — every session id you hold names something that does not exist there
yet. The client cannot rebuild those for you: only you know which of them still
matter, and only your store knows what they contained.

So treat every `ready` after the first as "re-establish what I need", and make
that path idempotent — which create-or-resume already is:

```ts
let established = false;
client.onReadinessChange(async (r) => {
  if (r !== "ready") return;
  if (established) return ((established = false), void resume()); // came back — rebuild
  established = true;
  await resume();
});
```

Live subscriptions do not need this. The transport re-issues each one on the way
back, and keeps re-asking while the peer answers `SessionNotFound` — a session
being rebuilt and a session that is gone say the same thing at the instant of the
answer, so it re-asks for `reconnect.resubscribeGraceMs` (30s) before ending the
stream with the error. Rebuild the session inside that window and the stream
heals with no work from you; miss it and the stream ends, which is your signal
that it will not heal on its own. See
[@agentick/transport](../transport#a-subscription-that-does-not-come-back-says-so).

The three predicates read one source: the extensions the server registered. They
answer whether a capability is **deployed**, not what a given session mounts —
`hasMethod` is silent about verbs a harness declares for the dynamic command
lane, because those are never wire-extension rows. For the per-session question,
ask the namespace itself:

```ts
if (client.capabilities.hasNamespace("prompts")) mountPromptsPanel();

// What this session's prompts harness actually declares, with each verb's exposure.
const { commands } = await client.session(sessionId).prompts.commands();
```

`commands` is one of the namespace's own wire rows, synthesized by the same
fallthrough as [any namespace you never wrote](#namespaces-you-never-wrote), so
no handle implements it. See
[@agentick/gateway](../gateway#discovery--two-doors) for how the two doors
divide the question.

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

## Signals the client emits itself

`onLog` above is the client **receiving** the server's signals. This is the other
direction: the client's own `log` / `trace` / `metrics`, the same
[`Observability`](../spec/src/data/observability.ts) contract a server-side tool
handler's `ctx` carries — so an adopter writing both sides reads one shape.

```ts
const client = await createClient({
  transport,
  telemetry: {
    adapter: {
      startSpan: (name, attrs, parent) => wrapOtelSpan(name, attrs, parent),
      currentTraceContext: () => ({ traceparent: currentTraceparent() }),
      log: (level, data) => logger[level]?.(data),
      metrics: myMeter,
    },
  },
});

client.runtime.log.info("composer opened");

await client.runtime.trace("read_selection", async (span) => {
  span.setAttribute("chars", text.length);
  return read();
});
```

**This package reads `adapter` only**, to build the facets above. It does not
install the per-RPC wire-span extension — the lean core does not depend on
[`@agentick/client-extensions`](../client-extensions). On
[`@agentick/client`](../client) the same option ALSO installs that extension,
with `sample` and `serviceName` applying to it, from the one object. Sharing the
instance is what makes a span opened in your code the parent of the RPC it
triggers, rather than two disconnected trees.

Adding it here by hand is one line:

```ts
extensions: [telemetry({ adapter })]; // @agentick/client-extensions
```

`log` and `metrics` are optional on the adapter. Omit them and `ctx.log` is still
callable (it just reaches nothing) and `ctx.metrics` is a no-op. Omit `telemetry`
entirely and `trace` runs on the passthrough path with zero span machinery — so
instrumented code costs nothing until an adapter exists.

### Parenting is explicit, deliberately

The active span is passed to `startSpan(name, attrs, parent)`:

```ts
await client.runtime.trace("outer", async () => {
  await client.runtime.trace("inner", () => …);      // parent = outer
  await client.runtime.trace("also-inner", () => …); // a SIBLING, not a chain
});
```

The server parents through an ambient fiber (`AsyncLocalStorage`), which browsers
do not have. A module-level "current span" stack looks equivalent and silently
misparents as soon as two async handlers interleave — the normal case with
several tabs open. Misparented spans are worse than flat ones, because they read
as truth.

An adapter whose spans cannot report `spanContext()` never becomes a parent:
better than inventing ids for a span nobody holds. Two `clientRuntimeContext`
instances never cross-parent, so concurrent handlers keep their own trees.

### Identity

```ts
client.runtime.clientId; // stable for the client's lifetime
client.runtime.connectionId; // undefined before the first handshake
```

**Read `connectionId`, do not capture it.** A reconnect mints a new one, and a
value copied at construction is stale for the rest of the session.

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

**`progressView` — progress, already classified.** The same fold engine pinned to
the cross-surface progress query, holding the latest state per correlation token.
Where `onProgress` hands you every frame, this hands you render-ready state:

```ts
import { progressView } from "@agentick/client-core";

const bars = progressView(client, scope);
bars.subscribe((states) => {
  const s = states.get(toolCallId);
  if (s === undefined) return;
  s.kind === "determinate" ? setWidth(s.fraction) : showSpinner(s.message);
});
```

`state.kind` is the whole decision — `"determinate"` draws a bar at `fraction`
(clamped to `[0, 1]`), `"indeterminate"` draws a spinner. **A client that connects
mid-flight renders correctly from the first frame it sees**, because every frame
carries its own `total` or deliberately doesn't; no history is needed to classify
one.

It also distrusts its input. First-party emitters are correct by construction
(`createProgressReporter` in [@agentick/spec](../spec)), but frames also arrive
from emitters nobody here controls — a third-party MCP server bridged onto the
bus. So a frame that goes backwards, or that shrinks, drops, or changes a `total`
already established, is **dropped rather than rendered**: a bar that freezes is
honest, a bar that jumps backwards or silently rescales is not. A total appearing
for the first time is the one legal upgrade, and it is honored.

Holding at 99% until the work actually settles is the component's policy, not the
fold's — the frame carries no terminal flag, and `progressView` invents none. Close
the bar on the operation's lifecycle, which you are already watching.

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

**`polledView` — the read core of an RPC-backed handle.** Where `channelView` folds
a channel, `polledView` folds a poll: it fetches once eagerly, notifies when the
seed lands, indexes rows by id, and re-fetches on `refresh()`. Six bundled handles
(`gates`, `state`, `skills`, `prompts`, `resources`, `tools`) are exactly this plus
their own write verbs, because none of them has a delta channel yet.

```ts
import { polledView } from "@agentick/client-core";

const view = polledView<Row>({
  fetch: async () => (await client.transport.request("rows/list", { sessionId }))?.rows,
  key: (r) => r.id,
});

return {
  ...view, // list / get / subscribe / close / refresh
  async archive(id: string) {
    await client.transport.request("rows/archive", { sessionId, id });
    await view.refresh(); // fire-and-refetch — the RPC analog of fire-and-observe
  },
};
```

A failed fetch — including the eager seed — leaves the snapshot empty rather than
half-filled, and a `null` / `undefined` reply reads as empty. `refresh(query)` passes
its argument to `fetch`, which is how `tools` filters by exposure over the wire.

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
| `reconnect()`                           | Try NOW — collapse whichever backoff is waiting    |
| `state` / `onStateChange(fn)`           | Connection state, and transitions                  |
| `capabilities` / `serverInfo`           | What the connected gateway supports, and who it is |
| `onCapabilitiesChange(fn)`              | Fires on every capability-snapshot swap            |
| `whenReady()`                           | Resolve when a handshake has SUCCEEDED             |
| `readiness` / `onReadinessChange(fn)`   | Whether the client is usable, not just wired up    |
| `request(method, params, signal?)`      | Typed JSON-RPC dispatch                            |
| `use(middleware)`                       | The interception seam; returns an `Unsubscribe`    |
| `hook(config)` / `hooks.on…(fn)`        | Method-scoped before/after sugar over `use`        |
| `gateway()` / `app(id)` / `session(id)` | Resource handles                                   |
| `send(sessionId, input)`                | Shortcut for `session(id).send(input)`             |
| `onLog` / `onProgress`                  | Generic scoped signal subscriptions                |
| `channelView(scope, channel, config?)`  | Generic channel fold                               |
| `progressView(scope)`                   | Progress frames folded to bar/spinner state        |
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
| `sessionStatusView`                                                    | The fold behind `session.status`                               |
| `progressView` / `foldProgress`                                        | Per-token progress state, and the fold it is built on          |
| `eventStream` / `eventView`                                            | The generic stream and fold beneath them                       |
| `liveStore` / `filteredView`                                           | Fan-out core; shared-subscription projections                  |
| `polledView`                                                           | Poll-backed read core (eager seed + by-id index + `refresh`)   |
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
- **`onProgress` does not follow a turn into its sub-agents.** The pre-scoped signal
  subscription is keyed to one session, and a sub-agent is a different one. The two
  doors that do cover it are `send({ fanIn: true })` for a turn's progress stream and
  `treeEvents()` for a subscription; `onProgress` itself takes no tree scope.
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
- **`polledView` has no built-in retry or de-dup.** A failed poll is swallowed and
  recovered by the next `refresh()`; concurrent `refresh()` calls each issue their own
  fetch, and the last to resolve wins. Both are fine for the mutation-triggered
  re-fetch the bundled handles do, and neither is asserted for anything else.
- **The fold kit isn't behind its own subpath.** `channelView`, `eventView`,
  `liveStore`, and friends sit on the main barrel next to the application surface,
  which under-signals that they're the extension-author tier.

## Verified by

- `src/__tests__/send-fan-in.spec.ts` — `fanIn` reaching the `session/send` params
  when asked for, and the key being absent (not `undefined`) when not, so an
  existing caller's request body is unchanged. What it MEANS is pinned end-to-end
  in [@agentick/transport-in-process](../transport-in-process)'s
  `progress-fan-in-e2e.spec.ts`.
- `src/__tests__/session-close-teardown.spec.ts` — `session.close()` releasing every
  sub-handle it BUILT (and never materializing one it did not) before the RPC, a
  throwing `close()` neither stopping its siblings nor suppressing the RPC, and the
  one-handle-per-session rule: `close()` and `app`/`gateway` `destroySession` each
  evict, so the next lookup builds a fresh handle rather than one subscribed to a
  session the server has forgotten.
- `src/__tests__/capabilities.spec.ts` — handshake populates capabilities and
  `serverInfo`, `MethodNotFound` degradation on `_extensions/list`, rejection when
  `initialize` fails, clearing on drop, re-handshake on reconnect (and _not_ on the
  initial open), best-effort failure of the post-reconnect handshake.
- `src/__tests__/reconnect.spec.ts` — `reconnect()` collapsing both waits, with the
  retry floor pinned far past the test's own lifetime so a second attempt can only
  be the manual kick: a retrying handshake re-armed, a SPENT budget recovered all
  the way to `ready`, a down wire dialled now, a failed kick resolving rather than
  rejecting, the ready no-op, and the closed-client refusal. The transport half —
  a `connect()` that wins during backoff not being clobbered by the timer it beat —
  is pinned in [@agentick/transport](../transport)'s `never-stops.spec.ts`.
- `src/__tests__/hooks.spec.ts` — `onBeforeSessionSend` param transform and abort,
  `onAfterSessionSend` result transform, method scoping, `hook` batch and `hooks`
  proxy registration plus unsubscribe, empty-registry fast path, and the
  `session/send` → `SessionSend` name derivation.
- `src/__tests__/session-status-view.spec.ts` — the status fold (folded state is the
  bare status, the change feed carries the whole frame including `executionId`), and
  `session.status` opening nothing until read, memoizing, and closing with the
  session. The reload story it exists for is pinned end-to-end in
  [@agentick/transport-in-process](../transport-in-process)'s
  `session-status-e2e.spec.ts`, alongside the thread-list subscription that updates
  sessions no handle is open for.
- `src/__tests__/handle-conformance.spec.ts` — `runClientHandleConformance` proven
  against a fake handle; `isClientHandle` / `isEnumerable` / `isRespondable`
  duck-typing, including a bare store that is a handle but not enumerable.
- The seed-and-notify contract has no runtime here, so it is proven where the
  seeding handles live — the client specs in
  [@agentick/tool-executor](../tool-executor), [@agentick/prompts](../prompts),
  [@agentick/skills](../skills), and [@agentick/resources](../resources): the eager
  poll notifies subscribers when it lands (so no boot-time `refresh()` is needed)
  and a failed poll settles the snapshot empty until `refresh()` recovers it.
- `src/__tests__/progress-view.spec.ts` — classification from a single frame (the late-join guarantee), per-token independence, the honored ratchet upgrade, `fraction` clamping, and each defense: a regressing frame, a shrinking / growing / vanishing `total`, and malformed frames all dropped with prior state untouched.
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
- `src/__tests__/polled-view.spec.ts` — the eager seed notifying a subscriber that
  attached while it was in flight, a failed seed settling empty and `refresh()`
  recovering it, `null` replies reading as empty, referential stability of `list()`,
  the refresh query reaching `fetch` (and the seed passing none), and per-listener
  unsubscribe vs `close()` dropping the whole fan-out.
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
