# `@agentick/client-extensions-next/retry`

Retry extension for `@agentick/client-core-next`. Exponential backoff with
full jitter, configurable retryable predicate, idempotency-key
propagation, per-method overrides.

Subpath of [`@agentick/client-extensions-next`](../../README.md) — the
first-party client-extension bundle. Adopters import individual
behaviors via their subpath for tree-shaking + dependency isolation.

## Prior art

| Library                                         | What it does                                                    | Where we match it                                                                                                                         |
| ----------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| AWS SDK retry strategies                        | Exponential backoff with full jitter; configurable max attempts | Same backoff formula (`random_uniform(0, min(maxDelay, initial * 2^attempt))`), same default cap (20s)                                    |
| Google Cloud SDK                                | Deadline-budget retries                                         | We expose `deadlineMs` total budget                                                                                                       |
| axios-retry / got-retry / undici-retry-fetch    | Configurable retryable predicate                                | `isRetryable: (err) => boolean` overridable                                                                                               |
| Stripe / GCP / RFC 7231 §4.2.2 idempotency keys | Non-idempotent requests carry a key so the server can dedup     | `params._meta.idempotencyKey` injected on `session/send`, `session/dispatch`, `session/queue`, `app/runOnce`; key survives across retries |
| Polly / resilience4j                            | Per-policy DSL                                                  | `perMethod` per-method override map                                                                                                       |

## Quick start

```ts
import { createClient } from "@agentick/client-core-next";
import { retry } from "@agentick/client-extensions-next/retry";

const client = await createClient({
  transport: ...,
  extensions: [retry()],
});
```

That's the canonical config: 3 attempts, 100ms initial, 20s cap,
default retryable predicate (transport drops + rate-limit/backpressure
codes), idempotency keys on non-idempotent methods.

## Configuration

```ts
retry({
  maxAttempts: 3,            // total attempts including first
  initialDelayMs: 100,       // first backoff
  maxDelayMs: 20_000,        // cap (AWS SDK convention)
  deadlineMs: 60_000,        // total budget across all attempts; default Infinity
  isRetryable: (err) => ...,  // predicate; default: see `defaultIsRetryable`
  idempotencyKey: (method) => ..., // default: keys for non-idempotent methods only
  perMethod: {                 // per-method override
    "session/send": { maxAttempts: 5, deadlineMs: 30_000 },
    "ping": { maxAttempts: 1 },
  },
});
```

## Default predicate — what we retry

**Yes** (transient — replaying makes sense):

- `kind: "connection"` — network unreachable, DNS, TLS, refused
- `kind: "closed"` — wire dropped mid-request
- `kind: "timeout"` — client-side deadline
- `kind: "rpc"` with code in {`InternalError` (-32603), `RateLimited` (-32040), `Backpressure` (-32050)}

**No** (caller error or hard failure):

- `kind: "cancelled"` — caller-initiated abort
- `kind: "rpc"` with auth / authz / not-found / invalid-params codes
- `kind: "protocol"` — wire shape violation

Override via `isRetryable: (err) => boolean`.

## Default idempotency-key emission

Methods that mutate server state get a fresh UUID per logical call,
preserved across retries:

- `session/send`, `session/dispatch`, `session/queue`, `app/runOnce`

Read-shaped methods get nothing — replaying them is naturally
idempotent.

Adopters override via `idempotencyKey: (method) => string | undefined`.

The key is attached at `params._meta.idempotencyKey` (MCP `_meta`
slot) so a server with dedup support can collapse duplicates.

## Status

Phase 33.F of the v2 implementation plan — see
`docs/proposals/v2/STATUS.md`.

## Verified by

| Concern                                                                   | Test                          |
| ------------------------------------------------------------------------- | ----------------------------- |
| Retry on transport-layer errors → ultimately succeeds                     | `src/__tests__/retry.spec.ts` |
| Stops at maxAttempts and re-throws                                        | `src/__tests__/retry.spec.ts` |
| Does NOT retry non-retryable errors (auth)                                | `src/__tests__/retry.spec.ts` |
| Retries on transient RPC codes (RateLimited, Backpressure, InternalError) | `src/__tests__/retry.spec.ts` |
| Idempotency-key emitted on non-idempotent methods                         | `src/__tests__/retry.spec.ts` |
| Idempotency-key NOT emitted on read-shaped methods                        | `src/__tests__/retry.spec.ts` |
| Idempotency-key PRESERVED across retries of one logical call              | `src/__tests__/retry.spec.ts` |
| Per-method overrides                                                      | `src/__tests__/retry.spec.ts` |
| AbortSignal during backoff                                                | `src/__tests__/retry.spec.ts` |
| Default predicate exact behavior                                          | `src/__tests__/retry.spec.ts` |
| Default idempotency-key emission per method                               | `src/__tests__/retry.spec.ts` |

## Roadmap & known gaps

- **Retry budget (token bucket across the whole client)** — limits total
  retry traffic when many requests fail simultaneously (Google's
  "retry amplification" prevention). Not implemented; deferred until a
  real workload exhibits the problem.
- **Hedging (Google "tail-tolerant" pattern)** — fire backup requests
  after a fixed delay for latency-sensitive RPCs. Deferred — not the
  same risk profile as retry.
- **Circuit breaker** — stop retrying entire methods when failure rate
  exceeds a threshold. Adjacent to retry but a separate concern; would
  ship as a sibling subpath (`@agentick/client-extensions-next/circuit-breaker`) if demand surfaces.
- **Backoff distribution property test** — verifies the `random_uniform(0, exp)`
  shape holds. Worth a property-based test in the 33.F hardening pass.
