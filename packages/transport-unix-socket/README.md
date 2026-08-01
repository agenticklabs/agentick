# @agentick/transport-unix-socket

**One line of JSON per frame, over a socket file.** Newline-delimited JSON-RPC 2.0 across a Node `net.Server` / `net.Socket` — no headers, no upgrade handshake, no TLS, no port. Both ends ship here. Node only.

The bet is that a CLI or TUI talking to a long-lived same-host daemon is the same split as a browser talking to a server, minus the network — so it should cost what the network costs, and no more. Trust is host-local, which changes the security posture rather than removing it: the crossing carries no credential by default, admission is still a hook you can veto, and a refused connection still leaves an audit trace. The framing is plain enough to read with `socat`.

## Install

```bash
npm install @agentick/transport-unix-socket
```

Subpaths: `/server` (the `net.Server` side), `/client` (the `ClientTransport`). The root re-exports both.

**`/client` here is not a browser client.** It is the connecting end of a same-host IPC pair — a CLI or TUI dialing a daemon — and it opens a Unix domain socket with `node:net`, which no browser can do. Every subpath therefore denies the `browser` export condition, so a web bundler that lands on this package fails with "not exported under browser condition" instead of an unresolvable `node:net` scheme deep in the build. Browser clients want [@agentick/transport-websocket](../transport-websocket) or [@agentick/transport-http](../transport-http). The workspace sweep that forbids `node:` builtins behind browser entry points reads that declaration rather than carrying an exception for this package.

## Quick start

**The daemon.** Hand the socket path to the gateway and let it own the bind:

```ts
import { createGateway } from "@agentick/gateway";
import { unixSocketServerTransport } from "@agentick/transport-unix-socket/server";

const gateway = await createGateway({
  transports: [unixSocketServerTransport({ path: "/tmp/myagent.sock" })],
});

await gateway.listen(); // resolves once the socket is accepting

process.on("SIGTERM", () => {
  void gateway.close(); // closes the socket; Node unlinks the path
});
```

**The client.** Same surface as every other transport:

```ts
import { createClient } from "@agentick/client-core";
import { unixSocket } from "@agentick/transport-unix-socket/client";

const client = await createClient({ transport: unixSocket({ path: "/tmp/myagent.sock" }) });
await client.connect();

const { apps } = await client.gateway().listApps();

const { output } = await client.session(sessionId).send({
  messages: [{ role: "user", content: "status?" }],
}).result;
```

Concurrent calls multiplex on the one socket, and a server-thrown error arrives as the same class it was thrown as:

```ts
const [a, b, list] = await Promise.all([
  client.gateway().getApp("app-1"),
  client.gateway().getApp("app-2"),
  client.gateway().listApps(),
]);

await client.gateway().getApp("missing"); // rejects with AppNotFoundError { appId: "missing" }
```

## Owning the bind yourself

`unixSocketServerTransport` defers the dispatch host to `gateway.listen(host)`. When you'd rather drive the socket directly — a daemon that isn't structured around a gateway's transport list — `unixSocketServer` takes the host up front and hands back the raw `net.Server`:

```ts
import { unixSocketServer } from "@agentick/transport-unix-socket/server";

const server = unixSocketServer({ path: "/tmp/myagent.sock", gateway });
await server.listening(); // resolves when accepting; rejects with the bind error

// ...later
await server.close(); // unsubscribes live connections, then closes the net.Server
```

The factory binds for you and claims the outcome before it does, so a bind failure is never an uncaught exception — `listening()` is how you read it. `unixSocketServerTransport` awaits the same promise, so a stale socket file (`EADDRINUSE`) surfaces as a rejected `gateway.listen()` rather than a dead process.

> [!IMPORTANT]
> Nothing unlinks a stale path: `fs.unlink` it yourself before rebinding after an unclean shutdown.

## Wire format

Each frame is `JSON.stringify(frame) + "\n"`. Receivers split on `\n`, then parse and validate each line against the JSON-RPC shape. That makes the traffic directly inspectable:

```sh
socat - UNIX-CONNECT:/tmp/myagent.sock
{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}
```

Framing is "read until newline", so both ends cap the bytes they will hold for a single line — `maxLineBytes`, 16 MiB by default. Past the cap the line is refused with a JSON-RPC error and the connection closes: the framing is already lost, and there is no offset at which reading could safely resume. A peer that withholds a newline forever therefore costs a bounded amount of memory, not an unbounded one.

Multiplexing N in-flight RPCs plus M subscriptions on one socket works as it does everywhere else in agentick: `BaseClientTransport` correlates responses by JSON-RPC `id`, subscription events by `subscriptionId`, progress by `progressToken`. Passing a request an `AbortSignal` emits `notifications/cancelled` on the socket when it fires.

## Ingress authentication

A Unix socket is host-local trust, so the default crossing carries `credential.kind: "none"` and no principal — the local pole. That default is a decision, not an omission, and it is overridable: pass an `AuthSource` and the shared ingress path runs it once per connection, exactly as the network transports do.

```ts
import { IngressAuthRequired, type AuthSource } from "@agentick/spec";
import { createGateway } from "@agentick/gateway";
import { unixSocketServerTransport } from "@agentick/transport-unix-socket/server";

// A socket in a world-readable directory: refuse anonymous crossings outright.
const denyAnonymous: AuthSource = {
  backend: "deny-anonymous",
  authenticate: () => Promise.reject(new IngressAuthRequired({ backend: "deny-anonymous" })),
};

const gateway = await createGateway({
  transports: [
    unixSocketServerTransport({ path: "/run/agentick.sock", authSource: denyAnonymous }),
  ],
});
```

A rejected crossing **fails closed**: the socket is destroyed before a single frame is read, and the refusal publishes a `gateway:admission:failed` record carrying the transport kind and a `failureClass` of `"authenticate"` — never the credential material. One refusal never disturbs the listener.

## Per-connection admission

Authentication answers "who is this"; admission answers "should this connection exist at all". The `onBeforeGatewayAccept` hook fires once per socket, after authentication and before any byte is read, and a throw drops the connection:

```ts
gateway.hook({
  onBeforeGatewayAccept: (info) => {
    // info.transportId is `unix-socket:${path}` — which edge admitted this
    if (!allowed(info.transportId)) throw new Error("rejected by policy");
    return info;
  },
});
```

Incoming bytes buffer on the paused socket until the connection is wired up, so a rejected connection is dropped without ever being read and an admitted one still sees its first frame.

## API

### `@agentick/transport-unix-socket/client`

| Export                              | Purpose                                       |
| ----------------------------------- | --------------------------------------------- |
| `unixSocket(options)`               | The `ClientTransport`                         |
| `UnixSocketTransportOptions` (type) | `{ path, reconnect?, id?, maxLineBytes? }`    |
| `ReconnectPolicy` (type)            | Re-exported from the shared transport package |

| Option         | Purpose                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------- |
| `path`         | Absolute path to the socket file                                                          |
| `reconnect`    | `{ enabled, initialDelayMs, maxDelayMs, maxAttempts }` — exponential backoff, full jitter |
| `id`           | Transport id; defaults to a `unix-N` counter                                              |
| `maxLineBytes` | Cap on one inbound NDJSON line; defaults to 16 MiB                                        |

Capabilities: `bidirectional: true` · `streamingRequest: true` · `reconnectable: true` · `binaryFrames: false` · `media: false`.

### `@agentick/transport-unix-socket/server`

| Export                                   | Purpose                                                      |
| ---------------------------------------- | ------------------------------------------------------------ |
| `unixSocketServerTransport(config)`      | `ServerTransport` — the gateway injects the host at `listen` |
| `unixSocketServer(options)`              | Raw factory — you supply the host, you get the `net.Server`  |
| `UnixSocketServerTransportConfig` (type) | `UnixSocketServerOptions` minus `gateway`                    |
| `UnixSocketServerOptions` (type)         | `{ path, gateway, transportId?, authSource?, … }`            |
| `UnixSocketServerHandle` (type)          | `{ server, listening(), close() }`                           |
| `UnixSocketFailure` (type)               | `{ at, error }` — what `onFailure` receives                  |
| `UnixSocketFailureSite` (type)           | Where a reported failure happened                            |
| `DispatchHost` (type)                    | Re-exported: what `gateway` must satisfy                     |

| Option           | Purpose                                                                           |
| ---------------- | --------------------------------------------------------------------------------- |
| `path`           | Socket path to bind                                                               |
| `gateway`        | The dispatch host (raw factory only — `ServerTransport` receives it at `listen`)  |
| `transportId`    | Id threaded into each connection's admission info; defaults to `"unix"`           |
| `authSource`     | Ingress authentication; omit for host-local trust                                 |
| `authnTimeoutMs` | Wall-clock ceiling on the `authSource` call; defaults to 10s, `Infinity` opts out |
| `maxLineBytes`   | Cap on one inbound NDJSON line; defaults to 16 MiB                                |
| `onFailure`      | Where otherwise-swallowed failures are reported; quiet by default                 |

## Patterns

**Shared plumbing.** [@agentick/transport](../transport) owns `BaseClientTransport` (state machine, RPC correlation, subscription and progress registries, reconnect with backoff, cursor-aware resubscribe) and `dispatchRequest` (the transport-agnostic JSON-RPC dispatcher, plus the ingress-authentication path). This package is only the socket-specific remainder.

**Sibling wires.** [@agentick/transport-websocket](../transport-websocket) and [@agentick/transport-http](../transport-http) for the network hop; [@agentick/transport-in-process](../transport-in-process) when the client and the gateway share a process and there is no hop at all. Identical client surface — the transport is the swappable part.

**Server.** [@agentick/gateway](../gateway) is the dispatch host, owns the transport list, and fans `listen()` / `close()` across it.

**Client.** [@agentick/client-core](../client-core) is the lean core; [@agentick/client](../client) is the same surface with every built-in `/client` session sub-handle pre-registered.

**Shapes.** [@agentick/spec](../spec) owns `ClientTransport`, `ServerTransport`, `AuthSource`, the ingress error classes, and the JSON-RPC frame types.

## Roadmap & known gaps

- **No peer-credential enrichment.** Deriving a principal from the connecting uid (`SO_PEERCRED`) is the natural identity source for a host-local socket and isn't built. Today the crossing is `credential.kind: "none"`, so an `AuthSource` sees `none` rather than peer credentials.
- **No socket-file lifecycle helper.** Unlinking a stale path after an unclean shutdown is the adopter's job; there is no `unlinkBeforeBind` option.
- **The reconnect loop wedges after one failed redial, and no test catches it.** The backoff and cursor-aware resubscribe machinery is the shared base's, tested there and by the WebSocket transport, but this transport's dial path does not feed it correctly: the error handler calls `socket.removeAllListeners()`, which takes the `close` listener with it, so a redial that FAILS reports nothing to `handleConnectionDrop` and no further attempt is ever scheduled. The transport is left in `connecting` forever. A drop while connected recovers on the first redial; a daemon that is still down when that redial lands does not. See `TODO(uds-redial)` in `src/client/transport.ts` — the fix is to mirror the WebSocket transport (assign the socket before the dial settles, let `close` drive the loop, keep the staleness guard) and to add a UDS twin of `transport-websocket`'s `reconnect-e2e.spec.ts`.
- **No broadcast fan-out.** The server tracks live connections for teardown only. A server-initiated notification to all connected clients, outside a dispatch, is unbuilt.
- **Four of the six `onFailure` sites are unpinned.** A cleanup or abort that throws during teardown is verified; `write`, `close`, `socket`, and post-bind `server` errors are wired to the same seam but have no test — a Unix domain socket has no portable way to force them (there is no RST, and a write to a departed peer completes silently).
- **Two decode paths ship without a test here.** The server aborts an in-flight dispatch on an inbound `notifications/cancelled`, and both ends decode a batch (a JSON array of frames) and answer a malformed line with a parse error instead of dropping the connection. All three are wired; none is pinned by a test in this package.

## Verified by

- `src/__tests__/smoke.spec.ts` — `ping` over a real socket against a real gateway, `listApps` reflecting `createApp`, a typed `AppNotFoundError` crossing the wire intact, concurrent multiplexed RPCs on one socket, clean `close()` transition.
- `src/__tests__/transport-conformance.spec.ts` — the shared `ClientTransport` suite over a real `net.Server`: state machine, pre-connect rejection, RPC error mapping, concurrent multiplexed RPCs, `notifications/cancelled` emit, subscription id adoption / routing / close / eviction, progress streams.
- `src/__tests__/ingress-authn.spec.ts` — the ingress conformance suite for a host-local edge: local pole by default, fail-closed when a configured `AuthSource` rejects `none`, admitted-with-no-principal under `allowAnonymous`, and the `gateway:admission:failed` record on refusal (correct `failureClass` and transport kind, no credential material, nothing published on an admitted crossing).
- `src/__tests__/listen-errors.spec.ts` — a bind onto an occupied path rejecting `listening()` with a typed `EADDRINUSE` error, never reaching `uncaughtException` even when the adopter ignores the outcome, a clean path still resolving, and `gateway.listen()` propagating the failure through the `ServerTransport`.
- `src/__tests__/ndjson-frame-limit.spec.ts` — the frame cap: a line past it refused fatally, bytes counted across chunks and reset at each newline, multibyte text counted as bytes rather than characters, one refusal per oversized line then resynchronization at the next newline, a line exactly at the cap accepted, and the server reporting then closing the connection while normal frames still round-trip.
- `src/__tests__/socket-failures.spec.ts` — a failed connect rejecting with a value that is both an `Error` (stack, `instanceof`) and a `TransportError` (`kind: "connection"`, `cause` preserved), and teardown failures reaching `onFailure` — a throwing subscription cleanup and a throwing in-flight abort — with teardown completing either way and silence as the default.
- `src/__tests__/server-transport.spec.ts` — `ServerTransport` conformance plus a real gateway-owned bind: `gateway.listen()` accepts a client and `ping` round-trips, `gateway.close()` releases the path, a throwing `onBeforeGatewayAccept` drops the connection, and a permitting one fires exactly once with `transportId` set to `unix-socket:${path}`.
