# @agentick/client-extensions-next

First-party extensions (middleware) for `@agentick/client-core-next`. Each
behavior is opt-in via a **subpath import** — adopters install one
package and pick exactly the behaviors they need; unused subpaths are
tree-shaken away. The package is dependency-free at the root (no
peer-deps dragged in unless a subpath is imported).

## Naming convention

This package establishes the layer-extension naming convention for the
v2 ecosystem:

| Pattern                              | Use                                                                                |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| `@agentick/{layer}-next`             | The layer impl (e.g., `client-next`, `gateway-next`)                               |
| `@agentick/{layer}-extensions-next`  | First-party extensions for that layer                                              |
| `@agentick/{layer}-{framework}-next` | Framework binding for that layer (`client-react-next`, `client-angular-next`, ...) |

Third-party extensions name themselves freely (`@some-org/my-cool-extension`).
The first-party naming is a convention, not a requirement on adopters.

## Subpaths

| Subpath                                 | Purpose                                                                                                 | Prior art                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| [`/retry`](src/retry/README.md)         | Exponential backoff with full jitter, idempotency-key propagation, per-method overrides                 | AWS SDK retry, axios-retry, undici-retry-fetch, Polly             |
| [`/telemetry`](src/telemetry/README.md) | OpenTelemetry-shaped span per logical RPC, W3C Trace Context propagation, OTel RPC semantic conventions | `@opentelemetry/api`, Datadog dd-trace, Sentry, Honeycomb Beeline |
| [`/cache`](src/cache/README.md)         | Method-allowlist read-through cache with per-method TTL + LRU eviction                                  | React Query / TanStack Query, SWR, Apollo Client                  |
| [`/offline`](src/offline/README.md)     | Outbound queue + FIFO replay on reconnect; pluggable durable store                                      | Workbox BackgroundSync, Apollo Link Queue, Redux Offline          |

## Quick start

```ts
import { createClient } from "@agentick/client-core-next";
import { retry } from "@agentick/client-extensions-next/retry";
import { telemetry, noopAdapter } from "@agentick/client-extensions-next/telemetry";
import { cache } from "@agentick/client-extensions-next/cache";
import { offline } from "@agentick/client-extensions-next/offline";

const client = await createClient({
  transport: ...,
  // Order matters: outermost (telemetry) wraps inner; innermost runs
  // closest to the wire. Recommended: telemetry → retry → offline → cache → transport.
  extensions: [
    telemetry({ adapter: noopAdapter }),
    retry(),
    offline({ methods: { "session/send": "queue" } }),
    cache({ methods: { "gateway/list_apps": { ttlMs: 60_000 } } }),
  ],
});
```

If you prefer one-line imports for ergonomics, the root barrel
re-exports every behavior:

```ts
import { retry, telemetry, cache, offline } from "@agentick/client-extensions-next";
```

The subpath form remains the recommended pattern — it lets bundlers
tree-shake unused behaviors and keeps `@opentelemetry/api`-style
peer-deps out of bundles that don't use them.

## Status

Phase 33.F of the v2 implementation plan — see
[`docs/proposals/v2/STATUS.md`](../../docs/proposals/v2/STATUS.md). All
four subpath behaviors are shipped with conformance tests and prior-art
citations.

## Roadmap

- **`/circuit-breaker`** — per-method failure-rate breaker (Polly /
  resilience4j family). Ships when retry-amplification becomes a real
  workload issue.
- **`/dedupe`** — coalesce in-flight identical requests (React Query
  request-dedup pattern). Lightweight; ships when a real adopter needs it.
- **Adopter-supplied durable stores** for `/offline` (IndexedDB, SQLite,
  Redis) — pattern in place via `OfflineStore` interface; first-party
  impls land per-demand.

## Verified by

Each subpath has its own conformance suite cited in its README:

- `/retry` — 16 tests in `src/retry/__tests__/retry.spec.ts`
- `/telemetry` — 9 tests in `src/telemetry/__tests__/telemetry.spec.ts`
- `/cache` — 7 tests in `src/cache/__tests__/cache.spec.ts`
- `/offline` — 7 tests in `src/offline/__tests__/offline.spec.ts`
