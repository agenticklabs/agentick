# @agentick/pubsub-next

Local observer / pub-sub primitives for Agentick v2.

Consolidates ~16 hand-rolled `Set<() => void>` / `Map<K, Set<listener>>` fan-out implementations across harnesses, bridges, transports, and reconciler test doubles into one canonical set. Three layered factories cover every fan-out shape the v2 framework needs:

| Primitive                            | Shape                                           | Replaces                                                                                                          |
| ------------------------------------ | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `createNotifier<T = void>()`         | Single-channel observer                         | Bare `Set<() => void>` (timeline, sandbox, subscriptions, session-state, transport state, client state)           |
| `createKeyedNotifier<K, T = void>()` | Keyed observer + optional wildcard channel      | `Map<K, Set<listener>> + Set<wildcard>` (knobs, state, skills, reconciler test fakes, lifecycle store, MCP tasks) |
| `createLocalPubSub<T>()`             | Effect.Stream-based fan-out with drain-on-close | Hand-rolled `Set<Queue<T>>` async-iterable fan-out (tasks fan-out is the current consumer)                        |

The package depends only on `effect`. No coupling to harness, spec, or reconciler — pubsub-next sits at the same layer as `@agentick/utils-next` in the dep graph.

## Quick start

### `createNotifier` — sync single-channel

```ts
import { createNotifier } from "@agentick/pubsub-next";

const n = createNotifier();
const off = n.subscribe(() => render());
n.notify();
off();

// Typed payload variant:
const t = createNotifier<MyState>();
t.subscribe((s) => apply(s));
t.notify(currentState);
```

Listener errors are caught per-listener — a buggy consumer cannot corrupt sibling listeners or the producer's state.

### `createKeyedNotifier` — keyed + wildcards

```ts
import { createKeyedNotifier } from "@agentick/pubsub-next";

const n = createKeyedNotifier();
n.subscribe("counter", () => render());
n.subscribeAll(() => bumpVersion());
n.notify("counter"); // fires counter-keyed + wildcards
n.notifyAll(); // wildcards only — "everything changed"

// Async dispatch:
const t = createKeyedNotifier<string, MyEvent>();
t.subscribe("foo", async (ev) => await persist(ev));
await t.notifyAsync("foo", event); // serial; errors propagate
```

Buckets auto-collect on the last unsubscribe — long-lived harnesses don't leak `Map` slots.

### `createLocalPubSub` — Stream-based

```ts
import { createLocalPubSub } from "@agentick/pubsub-next";
import { Stream } from "effect";

const bus = createLocalPubSub<TaskEvent>();
const stream = bus.subscribe();
bus.publish({ kind: "started", taskId: "t1" });

// Stream is plain Stream<T, never, never> — no Scope to wire.
Stream.runForEach(stream, (ev) => Effect.sync(() => render(ev))).pipe(Effect.runFork);

// Filter on subscribe:
const onlyProgress = bus.subscribe((e) => e.kind === "progress");

// Drain + shutdown:
await bus.close();
```

`close()` waits for every active subscriber to consume the events that were published BEFORE close was called. No published event is silently dropped from an active subscriber's queue.

## API

### `createNotifier<T = void>(): Notifier<T>`

| Method                | Description                                                            |
| --------------------- | ---------------------------------------------------------------------- |
| `subscribe(listener)` | Add a listener. Returns the unsubscribe.                               |
| `notify(value?)`      | Fire every listener. `T = void` → `notify()`; typed → `notify(value)`. |
| `size`                | Diagnostic listener count.                                             |
| `clear()`             | Drop every subscriber (long-lived owner teardown).                     |

### `createKeyedNotifier<K = string, T = void>(): KeyedNotifier<K, T>`

| Method                     | Description                                            |
| -------------------------- | ------------------------------------------------------ |
| `subscribe(key, listener)` | Subscribe to one key.                                  |
| `subscribeAll(listener)`   | Subscribe to every published key.                      |
| `notify(key, value?)`      | Fire keyed bucket + wildcards (sync; errors isolated). |
| `notifyAll(value?)`        | Wildcards only — "everything changed".                 |
| `notifyAsync(key, value?)` | Await each listener serially; errors propagate.        |
| `count(key)`               | Listener count for one key (excludes wildcards).       |
| `wildcardCount`            | Wildcard subscriber count.                             |
| `size`                     | Total listeners (all keys + wildcards).                |
| `clear()`                  | Drop every subscriber.                                 |

### `createLocalPubSub<T>(): LocalPubSub<T>`

| Method               | Description                                                        |
| -------------------- | ------------------------------------------------------------------ |
| `publish(event)`     | Publish an event. Sync from caller's POV (unbounded queue).        |
| `subscribe(filter?)` | Returns `Stream<T, never, never>`. Filter is `(event) => boolean`. |
| `close()`            | Drain in-flight to active subscribers, then shut down. Idempotent. |
| `subscriberCount`    | Diagnostic (best-effort).                                          |

`close()` polls subscribers until each has consumed every event that was published before close started. A 5-second backstop avoids hangs from wedged consumers (defensive — shouldn't trip in practice).

## Status

- Layer 1 / Layer 2 / Layer 3 — landed
- 16 sweep sites migrated across knobs, state, skills, timeline, sandbox, subscriptions, session-state, client, transport-next, mcp, reconciler (in-memory data bridge, lifecycle store, three test bridges)

## Roadmap & known gaps

- The `LocalPubSub.close()` drain uses a poll-and-yield loop. An Effect-native primitive (e.g. `Queue.awaitDrain`) doesn't exist in Effect's public surface today; if it lands, swap.
- No back-pressure controls on `publish` — the underlying queue is unbounded. Adopters with bursty publishers and slow consumers should consider `createKeyedNotifier` for their backpressure needs (sync notify with `void` listeners) or wait for a future `createBoundedLocalPubSub` variant.
- No replay-on-subscribe semantics — late subscribers don't see events published before they subscribed. If that's needed, an adopter wraps a `Ref<LastValue>` around the pubsub.

## Verified by

- `createNotifier` — subscribe/notify/unsubscribe semantics, listener-error isolation, mid-iteration unsubscribe, typed-payload variant — `src/__tests__/notifier.spec.ts`
- `createKeyedNotifier` — keyed dispatch, wildcards, `notifyAll`, `notifyAsync` error propagation, auto-collection of empty buckets, diagnostic `count`/`wildcardCount`/`size` — `src/__tests__/keyed-notifier.spec.ts`
- `createLocalPubSub` — multi-subscriber fan-out, subscribe-time filter, `close()` drain semantics (slow subscriber receives every event), idempotent close — `src/__tests__/local-pubsub.spec.ts`
