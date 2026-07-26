# @agentick/transport-unix-socket

Unix-socket transport for agentick — newline-delimited JSON-RPC 2.0
over a Node `net.Server` / `net.Socket`. Ships both ends. **Node-only**
(no browser); the canonical local-IPC wire for same-host adopters.

## What this package is

Required for **tentickle-class deployments** — a CLI / TUI talking to
a same-host daemon process where HTTP framing overhead is wasted and
no network hop exists. Lowest-latency wire we ship: no headers, no
upgrade handshake, no encoding overhead beyond a `\n` per frame.

Subclasses `BaseClientTransport` from `@agentick/transport` — the
fourth transport built on the same base, weighing in at ~170 LOC of
socket-specific code.

## Quick start

### Server (daemon)

```ts
import { createGateway } from "@agentick/gateway";
import { unixSocketServer } from "@agentick/transport-unix-socket/server";

const gateway = await createGateway();
const server = unixSocketServer({
  path: "/tmp/agentick.sock",
  gateway,
});
```

### Server, gateway-owned (ADR 84 `ServerTransport`)

`unixSocketServerTransport(config)` binds the socket `path` at
construction and takes the dispatch host at `listen()`. It is the
simplest wrapper — the underlying `net.Server` binds itself — so
`gateway.listen()` just defers the host and awaits the `listening`
event; `gateway.close()` closes the socket (Node unlinks the path).

```ts
import { createGateway } from "@agentick/gateway";
import { unixSocketServerTransport } from "@agentick/transport-unix-socket/server";

const gateway = await createGateway({
  transports: [unixSocketServerTransport({ path: "/run/agentick.sock" })],
});

await gateway.listen(); // binds the net.Server on the socket path
// ...
await gateway.close(); // closes the socket; Node unlinks the path
```

### Client (TUI / CLI)

```ts
import { createClient } from "@agentick/client";
import { unixSocket } from "@agentick/transport-unix-socket/client";

const client = await createClient({
  transport: unixSocket({ path: "/tmp/agentick.sock" }),
});

await client.connect();
const apps = await client.gateway().listApps();
```

## API surface

### `unixSocket(options): ClientTransport`

```ts
interface UnixSocketTransportOptions {
  path: string; // absolute path to the Unix socket
  reconnect?: ReconnectPolicy;
  id?: string;
}
```

### `unixSocketServer(options): UnixSocketServerHandle`

```ts
interface UnixSocketServerOptions {
  path: string;
  gateway: GatewayHarnessProtocol; // DispatchHost
  /** Optional ingress auth (ADR 61). A unix socket is host-local
   *  trust: the default crossing is `credential.kind: "none"` (local
   *  pole, no principal). Supplying an AuthSource runs the shared
   *  `authenticateIngress` helper for parity with the network
   *  transports; a rejection destroys the socket (fail closed). */
  authSource?: AuthSource;
}
```

`unixSocketServer` returns a `UnixSocketServerHandle` (`{ server, close }`) —
`server` is the underlying `net.Server`. Caller owns the socket file's
lifecycle. To rebind cleanly after a daemon restart, `fs.unlink(path)`
before `unixSocketServer({ path })` when an existing file is found.

### `unixSocketServerTransport(config): ServerTransport`

```ts
type UnixSocketServerTransportConfig = Omit<UnixSocketServerOptions, "gateway">; // { path, authSource? }
```

The gateway injects the dispatch host at `listen()`. The wrapper awaits
the `net.Server` `listening` event so a resolved `gateway.listen()`
means a client can connect immediately.

## Wire format

Each frame is `JSON.stringify(frame) + '\n'`. Receivers split on `\n`
and JSON-parse each line. Trivial to inspect with `socat`:

```sh
socat - UNIX-CONNECT:/tmp/agentick.sock
{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}
```

Multiplexing N concurrent RPCs + M subscriptions on the same socket
works the same way as every other agentick transport — `BaseClientTransport`
handles RPC correlation by JSON-RPC `id`, subscriptions by
`subscriptionId`, progress streams by `progressToken`.

## Patterns

### tentickle-class TUI ↔ same-host daemon

```ts
// daemon.ts
const gateway = await createGateway();
const server = unixSocketServer({ path: "/tmp/myagent.sock", gateway });

process.on("SIGTERM", async () => {
  await server.close();
  await gateway.close();
  process.exit(0);
});
```

```ts
// tui.ts
const client = await createClient({
  transport: unixSocket({ path: "/tmp/myagent.sock" }),
});
await client.connect();

const session = client.session("my-session");
for await (const event of session.send({ messages: [...] })) {
  render(event);
}
```

## Status

Phase 33.E of the v2 implementation plan — see
`docs/proposals/v2/STATUS.md`.

## Verified by

| Concern                                                                                                                                                                           | Test file                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| End-to-end ping, listApps, RPC error → TransportError, multiplexed RPCs, close transition                                                                                         | `src/__tests__/smoke.spec.ts`                                                                                   |
| State machine, RPC correlation, multiplexed concurrent RPCs, `notifications/cancelled` emit, subscription routing + close + eviction, progress streams                            | `src/__tests__/transport-conformance.spec.ts` (via `runTransportConformance` from `@agentick/spec-conformance`) |
| Ingress authn (ADR 61) — host-local `none` credential → local pole; configured `authSource` rejecting `none` fails closed; `allowAnonymous` admits with no principal              | `src/__tests__/ingress-authn.spec.ts` (`runIngressAuthnConformance`)                                            |
| `unixSocketServerTransport` — `ServerTransport` conformance + real gateway-owned bind (`gateway.listen()` binds the socket, ping round-trips; `gateway.close()` unlinks the path) | `src/__tests__/server-transport.spec.ts` (`runServerTransportConformance`)                                      |

## Roadmap & known gaps

**Done:**

- ✓ NDJSON framing (newline-delimited JSON)
- ✓ State machine via `BaseClientTransport`
- ✓ RPC correlation + subscription multiplexing
- ✓ Reconnect with exponential backoff + full jitter (shared base)
- ✓ Cursor-aware resubscribe on reconnect (shared base)
- ✓ `notifications/cancelled` client emit + server handle
- ✓ Ingress authn (ADR 61) — host-local trust: the crossing carries `credential.kind: "none"` by default (local pole, no principal). An optional `authSource?` runs the shared `authenticateIngress` helper for parity with the network transports; a rejection destroys the socket (fail closed). Verified by `src/__tests__/ingress-authn.spec.ts` (`runIngressAuthnConformance`).

**Claimed but not yet under test (✗):**

- ✗ **Reconnect over daemon restart** — reconnect machinery is inherited from `BaseClientTransport`; not exercised by a server-bounce test (parallel to WS's `reconnect.spec.ts`).
- ✗ **`SO_PEERCRED` peer-credential enrichment** — deriving the connecting uid → principal is a later ingress interceptor (`TODO(#146)` at the server). Today the crossing is `credential.kind: "none"`; an adopter `AuthSource` sees `none`, not peer creds.
- ✗ **Socket file lifecycle helpers** — adopters currently handle `fs.unlink` of stale socket files themselves. A `unixSocketServer({ unlinkBeforeBind: true })` knob would be useful.
- ✗ **Per-message framing limits** — no max-frame-size; a malicious peer could send an unbounded NDJSON line. Defense-in-depth deferred.
- ✗ **Server-initiated notification fan-out (#311)** — the server tracks live connections for teardown but does NOT register them with the gateway (`gateway.acceptConnection`) or fan a `gateway.notify(...)` broadcast to connected clients. Notifications today only flow within a dispatch. Broadcast fan-out is unbuilt.

## Development plan

| Step                               | Lands when                                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Phase 33.E MVP                     | Landed                                                                                                                    |
| Backpressure wiring                | Primitive landed in `@agentick/transport` (`MultiplexedStream`); this transport still uses the default `unbounded` policy |
| `SO_PEERCRED` peer-cred enrichment | ADR 61 later interceptor (`TODO(#146)`)                                                                                   |
| Reconnect-over-daemon-restart test | Optional; the base-class machinery is the same path WS exercises                                                          |
