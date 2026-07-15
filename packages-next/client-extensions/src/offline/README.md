# `@agentick/client-extensions-next/offline`

Offline-queue extension for `@agentick/client-core-next`. Buffers outbound
RPCs when the wire is closed; replays FIFO on reconnect.

Subpath of [`@agentick/client-extensions-next`](../../README.md) — the
first-party client-extension bundle. Adopters import individual
behaviors via their subpath for tree-shaking + dependency isolation.

## Prior art

| Library / pattern                                                 | What it does                                                                   | Where we match it                                                                 |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Workbox `BackgroundSync`                                          | Service-worker outbox; queues fetch requests when offline, replays when online | Per-request `queue` / `fail-fast` policy; FIFO replay                             |
| Apollo Link Queue (`@apollo/client/link/queue`)                   | Queues operations during network loss                                          | Same pattern: middleware in the request chain that diverts to queue on disconnect |
| Redux Offline                                                     | Durable outbox + optimistic UI                                                 | Pluggable `OfflineStore` for durable backends                                     |
| Outbox pattern (Hohpe & Woolf, _Enterprise Integration Patterns_) | Reliable async messaging across failure domains                                | Conceptual basis                                                                  |

## Quick start

```ts
import { createClient } from "@agentick/client-core-next";
import { offline } from "@agentick/client-extensions-next/offline";

const client = await createClient({
  transport: ...,
  extensions: [
    offline({
      methods: {
        "session/queue": "queue",   // buffer; replay on reconnect
        "session/send":  "fail-fast", // never queue; fail immediately
      },
    }),
  ],
});

// Inspect / control the queue
const pending = await client.offline.pending();
const size = await client.offline.size();
await client.offline.flush();    // force drain
await client.offline.clear();    // drop everything
```

## Policy options

Three per-method policies (named to match Workbox / Apollo conventions):

| Policy        | Behavior when transport not "open"                                                                                                                                                                 |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"queue"`     | Buffer in the `OfflineStore`; replay FIFO on next `state === "open"`. The original Promise resolves to `{ enqueued: true }` — adopters needing the eventual result subscribe to client-bus events. |
| `"fail-fast"` | Reject immediately with `{ kind: "connection" }`. Safe default — adopters opt-in to queueing per method.                                                                                           |
| `"never"`     | Pass through. Transport rejects on its own. Useful for synthetic methods or transports that have their own queueing.                                                                               |

Default for unlisted methods: `"fail-fast"`.

## Pair with retry middleware for idempotency

**Replay safety is the adopter's responsibility.** Only IDEMPOTENT
methods (or methods carrying a stable idempotency key) are safe to
queue. Pair with the [`retry`](../retry/README.md) extension to get
idempotency-key emission on non-idempotent methods:

```ts
import { retry } from "@agentick/client-extensions-next/retry";
import { offline } from "@agentick/client-extensions-next/offline";

// Order matters: telemetry → retry → offline → transport.
// retry's idempotency-key injection runs before offline buffers the
// request, so the queued frame already has its key.
extensions: [retry(), offline({ methods: { "session/queue": "queue" } })],
```

## Custom store

For browser deploys, wire IndexedDB. For server-side / desktop, SQLite
or Redis. Default in-memory store is for tests and simple desktop apps:

```ts
import type { OfflineStore, QueuedRequest } from "@agentick/client-extensions-next/offline";

class IndexedDbOfflineStore implements OfflineStore {
  async enqueue(method, params): Promise<QueuedRequest> { ... }
  async drain(): Promise<readonly QueuedRequest[]> { ... }
  async peek(): Promise<readonly QueuedRequest[]> { ... }
  async size(): Promise<number> { ... }
  async clear(): Promise<void> { ... }
}

offline({ store: new IndexedDbOfflineStore(), ... });
```

The store contract is **atomic drain** — `drain()` returns and removes
all current entries in one operation. Mid-drain failures re-enqueue
the un-replayed remainder.

## Status

Phase 33.F of the v2 implementation plan.

## Verified by

| Concern                                                 | Test                            |
| ------------------------------------------------------- | ------------------------------- |
| Default policy: fail-fast on closed transport           | `src/__tests__/offline.spec.ts` |
| `queue` policy buffers + drains FIFO on connect         | `src/__tests__/offline.spec.ts` |
| `never` policy passes through                           | `src/__tests__/offline.spec.ts` |
| `client.offline.{pending,size,flush,clear}()` namespace | `src/__tests__/offline.spec.ts` |
| `onReplayError` fires on replay failures                | `src/__tests__/offline.spec.ts` |
| In-memory store: maxSize enforcement                    | `src/__tests__/offline.spec.ts` |
| In-memory store: drain returns + clears                 | `src/__tests__/offline.spec.ts` |

## Roadmap & known gaps

- **Eventual-result delivery for queued requests.** Today `"queue"`
  policy returns `{ enqueued: true }` and the eventual replay result
  is fire-and-forget. Adopters who need the result must subscribe via
  the client-bus or re-issue once `state === "open"`. A future
  `replayResultFanout` option could deliver via a separate Promise
  (similar to Apollo Link Queue's `.then` on the queued operation).
- **IndexedDB store** — adopter-supplied `OfflineStore` impl. We may
  ship a sibling package (e.g., `@agentick/client-offline-indexeddb-next`)
  once a real browser adopter surfaces and the contract proves stable.
- **SQLite store** — same shape; not shipped.
- **TTL on queued entries** — drop entries older than `maxAge`.
  Worth adding once a real workload hits stale-replay issues.
- **Conflict resolution** — when a queued mutation conflicts with
  server state changed during offline, optimistic-update
  reconciliation is the right pattern (Redux Offline does this).
  Highly domain-specific; deferred.
- **Replay rate-limiting** — burst of N queued requests can overload
  a freshly-reconnected server. Worth a "drain at N RPS" knob.
- **`client-bus event` emission for queue lifecycle** — `enqueued`,
  `drained`, `replay-failed` events on the `extension` surface. Today
  only `onReplayError` exposes failures.
