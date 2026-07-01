# @agentick/transport-unix-socket-next

Unix-socket transport for agentick — newline-delimited JSON-RPC 2.0
over a Node `net.Server` / `net.Socket`. Ships both ends. **Node-only**
(no browser); the canonical local-IPC wire for same-host adopters.

## What this package is

Required for **tentickle-class deployments** — a CLI / TUI talking to
a same-host daemon process where HTTP framing overhead is wasted and
no network hop exists. Lowest-latency wire we ship: no headers, no
upgrade handshake, no encoding overhead beyond a `\n` per frame.

Subclasses `BaseClientTransport` from `@agentick/transport-next` — the
fourth transport built on the same base, weighing in at ~170 LOC of
socket-specific code.

## Quick start

### Server (daemon)

```ts
import { createGateway } from "@agentick/gateway-next";
import { unixSocketServer } from "@agentick/transport-unix-socket-next/server";

const gateway = await createGateway();
const server = unixSocketServer({
  path: "/tmp/agentick.sock",
  gateway,
});
```

### Client (TUI / CLI)

```ts
import { createClient } from "@agentick/client-next";
import { unixSocket } from "@agentick/transport-unix-socket-next/client";

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
  gateway: GatewayHarnessProtocol;
}
```

Caller owns the socket file's lifecycle. To rebind cleanly after a
daemon restart, `fs.unlink(path)` before `unixSocketServer({ path })`
when an existing file is found.

**Server-initiated notifications (#311).** Every accepted UDS
connection is automatically registered with `gateway.acceptConnection`
using metadata `{ transport: "unix-socket", connectionId: "uds:<ulid>" }`.
`gateway.notify(...)` fans out to every connected client. Zero
adopter opt-in — passing a `gateway` to `unixSocketServer` is enough.

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
  await gateway.closeGateway();
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

| Concern                                                                                                                                                | Test file                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| End-to-end ping, listApps, RPC error → TransportError, multiplexed RPCs, close transition                                                              | `src/__tests__/smoke.spec.ts`                                                                                        |
| State machine, RPC correlation, multiplexed concurrent RPCs, `notifications/cancelled` emit, subscription routing + close + eviction, progress streams | `src/__tests__/transport-conformance.spec.ts` (via `runTransportConformance` from `@agentick/spec-conformance-next`) |

## Roadmap & known gaps

**Done:**

- ✓ NDJSON framing (newline-delimited JSON)
- ✓ State machine via `BaseClientTransport`
- ✓ RPC correlation + subscription multiplexing
- ✓ Reconnect with exponential backoff + full jitter (shared base)
- ✓ Cursor-aware resubscribe on reconnect (shared base)
- ✓ `notifications/cancelled` client emit + server handle

**Claimed but not yet under test (✗):**

- ✗ **Reconnect over daemon restart** — reconnect machinery is inherited from `BaseClientTransport`; not exercised by a server-bounce test (parallel to WS's `reconnect.spec.ts`).
- ✗ **`SO_PEERCRED` peer-credential auth** — the `AuthSourceFor<"unix-socket">` type includes `unixPeerCred` for this; not implemented end-to-end. Lands with ADR 34 (auth subsystem).
- ✗ **Socket file lifecycle helpers** — adopters currently handle `fs.unlink` of stale socket files themselves. A `unixSocketServer({ unlinkBeforeBind: true })` knob would be useful.
- ✗ **Per-message framing limits** — no max-frame-size; a malicious peer could send an unbounded NDJSON line. Defense-in-depth deferred.

## Development plan

| Step                               | Lands when                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------- |
| Phase 33.E MVP                     | This commit                                                                 |
| 33.C hardening pass                | After all transports settle so backpressure design covers them consistently |
| `unixPeerCred` auth                | ADR 34 auth subsystem                                                       |
| Reconnect-over-daemon-restart test | Optional; the base-class machinery is the same path WS exercises            |
