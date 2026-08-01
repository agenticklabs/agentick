# @agentick/transport-in-process

**The wire, minus the wire.** Client and gateway exchange exactly the JSON-RPC frames they would exchange over a socket — this transport hands them across by direct function call. No encode, no decode, no listener, no port.

That equivalence is the whole bet. Because the frames and the server-side dispatcher are the same ones the network transports use, the loopback is where the entire client/server contract gets proven end to end — sends, elicitation, gates, tasks, resources, client-declared tools, progress, subscriptions — and it is what you ship when the client and the gateway live in one process: a CLI, a daemon, a TUI, a test. Put the gateway behind a socket later and the call sites don't move.

## Install

```bash
npm install @agentick/transport-in-process
```

Single entry point; no subpaths.

## Quick start

Point it at a gateway. The transport assembles the per-request dispatch wiring itself, so there is no server plumbing to hand-roll:

```ts
import { createClient } from "@agentick/client-core";
import { createGateway } from "@agentick/gateway";
import { inProcessTransport } from "@agentick/transport-in-process";

const gateway = await createGateway();
await gateway.listen();

const client = await createClient({ transport: inProcessTransport({ gateway }) });
await client.connect();

const { apps } = await client.gateway().listApps();
```

`connect()` needs no extra setup: `initialize` and `_extensions/list` are bootstrap methods the gateway answers itself.

From there the client drives a session the same way it would across a network — given a session id from `gateway.createApp(...)` → `app.createSession(...)`:

```ts
const handle = client.session(sessionId).send({
  messages: [{ role: "user", content: "summarize the repo" }],
});

for await (const event of handle.events()) {
  console.log(event.type);
}

const { output, stopReason, ticks } = await handle.result;
```

`client.send(sessionId, input)` is the same call in shorthand — it issues an identical `session/send` frame.

## The whole session surface, loopback

Every client-facing surface reaches the gateway through this transport, including the ones that need a live notification channel. Elicitation is the sharpest case: the server suspends on a question, the client answers it, the server's promise resolves — all without a socket.

```ts
import "@agentick/elicitation/client"; // registers session.elicitations
import { createClient } from "@agentick/client-core";
import { inProcessTransport } from "@agentick/transport-in-process";

const client = await createClient({ transport: inProcessTransport({ gateway }) });
await client.connect();

const asks = client.session(sessionId).elicitations;
const stop = asks.subscribe(() => {
  for (const ask of asks.list()) {
    console.log(ask.message, ask.hints?.kind); // "Approve delete_file?", "tool_confirmation"
    void ask.accept({ approved: true });
  }
});

// Server side, meanwhile:
//   const r = await session.elicitation.elicit({ message, schema });
//   r.outcome === "accepted" && r.value === { approved: true }

stop();
asks.close();
```

The same round trip holds for the rest: `session.gates` (clear / defer / override), `session.tasks` (cancel, with the status view re-folding from the server's transition), `session.resources` (list / read / templates), `session.skills`, `session.prompts`, `session.state`, `session.tools`, and `session.clientToolCalls` for declaring client-handled tools. Verbs that aren't declared stay `MethodNotFound` — the deny-by-default posture is the dispatcher's, not the wire's, so it holds here too.

> [!NOTE]
> Those `session.*` sub-handles come from each surface's own `/client` subpath. `@agentick/client-core` keeps them opt-in — one side-effect import per surface, as above. [@agentick/client](../client) is the same core with every built-in `/client` subpath pre-imported.

## Wire-shape parity — `wireParity`

Passing frames by reference means a payload that JSON could never carry — a `Map`, a `Date`, a class instance, a cycle — sails straight through. `wireParity: true` closes that hole by round-tripping every frame through `JSON.parse(JSON.stringify(...))`:

```ts
const client = await createClient({
  transport: inProcessTransport({ gateway, wireParity: true }),
});
```

Turn it on in tests, leave it off in production. It costs a serialize per frame and buys you the guarantee that the same code survives a real socket.

> [!WARNING]
> `structuredClone` is deliberately **not** used. It preserves `Map`, `Date`, and cycles that JSON flattens or rejects — precisely the false confidence this mode exists to remove.

## Stub handlers

`gateway` is the common case. The escape hatch is `handler`: a function that answers requests directly, for a stub server, request interception, or a host that isn't a gateway. Supply exactly one of the two — both, or neither, throws at construction.

```ts
import type { JsonRpcRequest, JsonRpcResponse } from "@agentick/spec";
import { ErrorCode } from "@agentick/spec";
import { createClient } from "@agentick/client-core";
import { inProcessTransport, withHandshake } from "@agentick/transport-in-process";

const seen: string[] = [];

const stub = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
  seen.push(req.method);
  if (req.method === "session/abort") return { jsonrpc: "2.0", id: req.id, result: null };
  return {
    jsonrpc: "2.0",
    id: req.id,
    error: { code: ErrorCode.MethodNotFound, message: req.method },
  };
};

const client = await createClient({
  transport: inProcessTransport({ handler: withHandshake(stub) }),
});
await client.connect();
await client.session("s1").abort("test");

console.log(seen.includes("session/abort")); // true
```

`withHandshake` answers `initialize` and `_extensions/list` with canned results and falls through to your handler for everything else — a stub that answers neither still connects, but the client sees no `serverInfo` and no capabilities. Override either reply through the second argument; `buildHandshakeInitializeResult()` and `buildHandshakeExtensionsListResult()` are the defaults, exported so you can amend rather than rewrite them. A real gateway needs none of this.

## Notifications ride the request

There is no separate server-push slot. Everything the server sends unprompted — progress, subscription events, subscription close and eviction — travels through the `sendNotification` callback handed to the handler on each request, and lands on the client through the same routing the socket transports use.

Progress is the load-bearing case: a tool calling `ctx.progress(...)` mid-execution reaches the client's progress stream for the token the send declared.

Frames travel the other way too. On the `gateway` path the server side is a real per-connection context — the same one the socket transports use — so an id-less frame the client emits (`notifications/cancelled`, which every aborted request sends) lands in that connection's in-flight registry and aborts the operation it names. Closing the client runs every cleanup the connection registered, so a server-side subscription does not outlive its subscriber. On the raw-`handler` path, pass `onNotification` to receive those frames; without it a stub server simply ignores them.

```ts
import type { EventFrame } from "@agentick/spec";

const token = "job-1";
const stream = client.transport.progress(token);

const frames: EventFrame[] = [];
const drain = (async () => {
  for await (const frame of stream) frames.push(frame);
})();

await client.request("session/send", {
  sessionId,
  messages: [{ role: "user", content: "go" }],
  _meta: { progressToken: token },
});

await stream.close();
await drain;

// frames carry the emitted { token, progress, total, message }
```

Gateway-scope control-plane events work the same way, over a normal subscription:

```ts
import { GATEWAY_CAPABILITIES_CHANGED } from "@agentick/spec";

const sub = client.transport.subscribe({ kind: "gateway" }, { surface: "gateway" });
void (async () => {
  for await (const frame of sub) {
    if (frame.envelope?.name === GATEWAY_CAPABILITIES_CHANGED) refreshUi();
  }
})();

gateway.emitCapabilitiesChanged?.();
```

The client does not react to that event on its own — consuming it is yours to do.

## Server-side symmetry

`inProcessServerTransport()` is a `ServerTransport` whose `listen` and `close` are honest no-ops: there is nothing to bind, because in-process clients reach the gateway by direct call rather than through a listener. It exists so a same-process deployment can list its transport alongside the network ones and keep `gateway.listen()` fan-out uniform.

```ts
import { createGateway } from "@agentick/gateway";
import { inProcessServerTransport } from "@agentick/transport-in-process";

const gateway = await createGateway({
  transports: [
    inProcessServerTransport(),
    // ...plus any network transport, e.g. a WebSocket or Unix-socket server
  ],
});

await gateway.listen(); // binds the network transports; this one is a no-op
await gateway.close();
```

Its `id` is the stable string `"in-process"`.

## Media plane

The control transport knows nothing about audio or video. Pass a `MediaTransport` as `media` and the transport advertises `capabilities.media = true` and delegates `openUplink` / `openDownlink` to it; omit it and opening a media plane throws with a pointer to the fix. [@agentick/live](../live) ships the loopback router — `inProcessTransport({ gateway, media: inProcessLiveMedia(gateway) })` runs a full media plane in one process.

## API

### `@agentick/transport-in-process`

| Export                                 | Purpose                                                       |
| -------------------------------------- | ------------------------------------------------------------- |
| `inProcessTransport(options)`          | The `ClientTransport` — direct-call frames to a gateway       |
| `inProcessServerTransport()`           | `ServerTransport` no-op, for uniform `gateway.listen()`       |
| `withHandshake(inner, overrides?)`     | Wrap a stub handler with canned `initialize` / extension list |
| `buildHandshakeInitializeResult()`     | The default `initialize` reply `withHandshake` uses           |
| `buildHandshakeExtensionsListResult()` | The default `_extensions/list` reply (empty)                  |
| `InProcessTransportOptions` (type)     | Options below                                                 |
| `InProcessGatewayHandler` (type)       | `(request, sendNotification) => Promise<JsonRpcResponse>`     |

### `InProcessTransportOptions`

| Option           | Purpose                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| `gateway`        | The dispatch host to call. The common case; wiring is built for you                                    |
| `handler`        | Raw request handler instead of `gateway` — exactly one of the two, never both                          |
| `onNotification` | Where client-originated notifications go on the `handler` path (the `gateway` path routes them itself) |
| `wireParity`     | Round-trip every frame through JSON to catch non-serializable payloads (default off)                   |
| `id`             | Transport id; defaults to an `in-process-N` counter                                                    |
| `media`          | A `MediaTransport` to delegate uplink / downlink to (default: no media plane)                          |

### Capabilities

`bidirectional: true` · `streamingRequest: true` · `reconnectable: false` (nothing to reconnect to) · `binaryFrames` reflects the mode — `true` by default (frames pass by reference), `false` under `wireParity` (JSON mangles a typed array) · `media` reflects whether you passed one.

## Patterns

**Shared plumbing.** [@agentick/transport](../transport) owns `BaseClientTransport` (state machine, RPC correlation, stream registries, notification routing) and `dispatchRequest` (the transport-agnostic JSON-RPC → gateway dispatcher). This package is the wire-specific remainder.

**Sibling wires.** Swap in [@agentick/transport-websocket](../transport-websocket), [@agentick/transport-http](../transport-http), or [@agentick/transport-unix-socket](../transport-unix-socket) without touching call sites — same client surface, same frames.

**Server.** [@agentick/gateway](../gateway) is the dispatch host, and answers `initialize` / `ping` / `_extensions/list` as bootstrap methods.

**Client.** [@agentick/client-core](../client-core) is the lean core used throughout this page; [@agentick/client](../client) is the same surface with every built-in `/client` subpath pre-registered.

**Shapes.** [@agentick/spec](../spec) owns `ClientTransport`, `ServerTransport`, `MediaTransport`, the JSON-RPC frame types, and `ErrorCode`.

**Media.** [@agentick/live](../live) supplies the in-process `MediaTransport`.

## Roadmap & known gaps

- **`wireParity` is JSON-only.** Parity mode mangles a `Uint8Array` exactly as a JSON wire would, so the two modes are not interchangeable for binary payloads. That divergence is the point — and `capabilities.binaryFrames` now reports it (`true` by default, `false` under parity) rather than claiming binary support in both.
- **No runtime capability re-sync.** `gateway:capabilities:changed` is delivered, but the client does not refresh its own capability view from it — a subscriber has to act on the frame.
- **`withHandshake` reports no extensions.** Its default `_extensions/list` reply is empty, so a stub can't exercise client-side extension discovery without an override.
- **The media plane has no test in this package.** `media` delegation is exercised from [@agentick/live](../live), which owns the only implementation.

## Verified by

- `src/__tests__/smoke.spec.ts` — `gateway` XOR `handler` construction guard, connect / `ping` / close state transitions, typed `gateway().listApps()` + `app().listSessions()` + `session().abort()` params, RPC error surfacing as `TransportError { kind: "rpc" }`, pre-connect rejection, `wireParity: true` round-trip, and the client extension pipeline (request middleware order, namespace install, LIFO `onClose`).
- `src/__tests__/transport-conformance.spec.ts` — the shared `ClientTransport` suite: state machine, RPC correlation, concurrent multiplexed RPCs, `notifications/cancelled` client emit, subscription id adoption / routing / close / eviction, progress streams.
- `src/__tests__/wire-conformance.spec.ts` — envelope round-trips through the validator, heterogeneous batches, empty-batch rejection.
- `src/__tests__/cancellation-e2e.spec.ts` — an aborted request reaching the server: a parked wire method's registered cancel callback firing, the cancellation routed to the one request id it names while a sibling stays parked, and an unmatched cancellation leaving the pair usable.
- `src/__tests__/connection-teardown.spec.ts` — client close releasing the server-side subscription's bus stream (the iterator closed, its producer fiber interrupted), and `sub/unsubscribe` releasing it rather than merely forgetting the registry entry.
- `src/__tests__/wire-parity-capabilities.spec.ts` — `binaryFrames` matching observed behavior in both modes: `true` with a `Uint8Array` arriving intact, `false` with it arriving JSON-mangled, and no other capability differing between the modes.
- `src/__tests__/session-send-e2e.spec.ts` — a real `session/send` across client → gateway → session → executor, `responseFormat` and `onBusy` threading, and a server-thrown `SessionNotFoundError` rehydrating as the same class on the client.
- `src/__tests__/send-shortcut.spec.ts` — `client.send(id, input)` issues the identical frame as `client.session(id).send(input)`, and returns the canonical handle.
- `src/__tests__/progress-signal-e2e.spec.ts` — a tool's `ctx.progress` during an in-flight send arriving on `client.transport.progress(token)`.
- `src/__tests__/elicitation-e2e.spec.ts` + `elicitation.spec.ts` — accept / decline / cancel / schema-violation outcomes, out-of-order responses across concurrent asks, and the by-id and raw-wire respond paths.
- `src/__tests__/gates-e2e.spec.ts` — `gates` list / clear / defer / override over the generic command lane, `commands/list` enumeration, and an undeclared verb staying `MethodNotFound`.
- `src/__tests__/tasks-cancel-e2e.spec.ts` — `tasks/cancel` reaching a hanging server task, and the cancelled transition re-folding the client's task view.
- `src/__tests__/resources-e2e.spec.ts` + `wire-reads-e2e.spec.ts` + `client-handles-e2e.spec.ts` — resources read / list / templates, the skills / prompts / state reads and writes, and the typed `session.*` handles over the same lane.
- `src/__tests__/tools-e2e.spec.ts` + `client-tools-e2e.spec.ts` + `client-tools.spec.ts` — `session/list_tools` with exposure filtering, the whole-slice `set_client_tools` replace that leaves app-declared tools standing, and `respond_to_tool_call` routing.
- `src/__tests__/subscription-first-frame.spec.ts` — the late subscriber, against a real gateway: attaching AFTER the state exists still receives the session channel's snapshot as its literal FIRST frame — knobs values, a pending elicitation ask, a working task — because the client allocates the `subscriptionId` and the server adopts it; plus a duplicate id on one connection refused with `InvalidParams` while a distinct one is admitted.
- `src/__tests__/capabilities-changed-e2e.spec.ts` — `gateway:capabilities:changed` reaching every gateway-scope subscriber over `sub/subscribe`.
- `src/__tests__/server-transport.spec.ts` — `ServerTransport` conformance, no-op `listen` / `close` under a real gateway, stable `"in-process"` id.
- The `media` slot is exercised in [@agentick/live](../live) (`src/__tests__/in-process-media-e2e.spec.ts`).
